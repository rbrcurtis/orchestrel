import { createHash } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import type { TranscriptHistoryPage, TranscriptHistoryRequest } from '../shared/transcript-history';
import { TRANSCRIPT_PAGE_SIZE } from '../shared/transcript-history';
import { collectDisplayPrompts, originalPromptText } from './display-prompt';
import { IMAGE_OMITTED_TEXT, redactInlineMedia } from '../shared/transcript-media';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function getNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function getHistoryContentBlocks(content: unknown): Array<Record<string, unknown>> {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [{ type: 'text', text: JSON.stringify(content) }];

  const blocks: Array<Record<string, unknown>> = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === 'text') {
      blocks.push({ type: 'text', text: getString(block.text) ?? '' });
    } else if (block.type === 'thinking') {
      blocks.push({ type: 'thinking', thinking: getString(block.thinking) ?? '' });
    } else if (block.type === 'toolCall') {
      blocks.push({
        type: 'tool_use',
        id: getString(block.id),
        name: getString(block.name),
        input: isRecord(block.arguments) ? block.arguments : {},
      });
    } else if (block.type === 'image') {
      // Inline base64 image data is never rendered — the transcript shows the user's
      // text — but the fallback below would serialize megabytes of it into the page.
      blocks.push({ type: 'text', text: IMAGE_OMITTED_TEXT });
    } else {
      blocks.push({ type: 'text', text: JSON.stringify(block) });
    }
  }
  return blocks;
}

function makeUuid(sessionId: string, idx: number): string {
  if (idx < 0) return `${sessionId}-pi-history-init`;
  return `${sessionId}-pi-history-${idx}`;
}

// Identity of a window: the record ids that compose it. Session files are
// append-only, so a fixed id run means a fixed window. Hashing ids instead of
// stringify-ing record content keeps this O(n) on tiny strings — the old
// content hash made deep paging on large sessions unreadably slow.
/** Epoch ms of a session entry's timestamp, which Pi stores as an ISO string. */
function entryTimestampMs(entry: unknown): number | undefined {
  if (!isRecord(entry)) return undefined;
  const raw = entry.timestamp;
  if (typeof raw === 'number') return raw < 1e12 ? raw * 1000 : raw;
  if (typeof raw !== 'string') return undefined;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function windowPrefix(records: TranscriptHistoryPage['records'], count: number): string {
  return createHash('sha256')
    .update(records.slice(0, count).map((r) => r.id).join('\n'))
    .digest('hex');
}

async function fileRevision(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve())
      .on('error', reject);
  });
  return hash.digest('hex');
}

// Page-building cache. The reader re-parses and re-maps the WHOLE session on
// every page request; on the 80MB Fanless session (15.9k lines, 113
// compactions) that measured ~2.6 s per page. The mapped records are a pure
// function of the file bytes, so validate by mtime+size and skip the build on
// a hit. A running session appends, which changes mtime and just rebuilds.
// Two entries is the point: scrolling pages one session; a second monster
// session trades it out. Bigger files aren't cached at all — an unbounded
// record list in RAM is worse than a slow page.
interface CachedRecords {
  mtimeMs: number;
  size: number;
  revision: string;
  records: TranscriptHistoryPage['records'];
  sessionStart?: TranscriptHistoryPage['sessionStart'];
}
const recordCache = new Map<string, CachedRecords>();
const MAX_CACHED_RECORD_FILES = 2;
const MAX_CACHED_RECORD_FILE_BYTES = 200 * 1024 * 1024;

// Session id → file path. SessionManager.list(cwd) scans the whole session dir
// (227 files / 240MB in /home/ryan/plans measured 1.6-1.8 s per call) and the
// reader used to pay that on every page request. A session id maps to exactly
// one immutable file, so resolve once and reuse; a vanished file (cleanup) just
// re-lists and yields the empty-page path.
const pathCache = new Map<string, string>();

async function buildRecords(
  path: string,
  sessionId: string,
  manager: { getBranch(): SessionEntry[] },
  sessionEntryToContextMessages: (entry: SessionEntry) => unknown[],
): Promise<Pick<CachedRecords, 'revision' | 'records' | 'sessionStart'>> {
  // The FULL active branch, not buildContextEntries(): that projection omits
  // everything the latest compaction summarized, which would make pre-compaction
  // history unpaged-able. Archived entries map identically, and each compaction
  // entry renders as its compact marker, so the transcript reads end to end.
  const entries = manager.getBranch();
  const records: TranscriptHistoryPage['records'] = [];
  const revision = await fileRevision(path);
  const modelChange = [...entries].reverse().find((e) => e.type === 'model_change');
  const model = modelChange ? getString(modelChange.modelId) : undefined;
  // The branch opens with the entry that named the model, so its timestamp is when
  // that first turn started — the same instant the live init event carried.
  const startTimestamp = entryTimestampMs(modelChange) ?? entryTimestampMs(entries[0]);
  const sessionStart = model
    ? { model, ...(startTimestamp != null ? { timestamp: startTimestamp } : {}) }
    : undefined;
  if (model)
    records.push({
      id: `${sessionId}:init`,
      message: {
        type: 'system',
        subtype: 'init',
        model,
        session_id: sessionId,
        ...(startTimestamp != null ? { timestamp: startTimestamp } : {}),
      },
    });
  const replacements = collectDisplayPrompts(entries);
  for (const entry of entries) {
    const messages = sessionEntryToContextMessages(entry);
    for (const [part, message] of messages.entries()) {
      const id = `${entry.id}:${part}`;
      const text = messageText(message);
      const displayText = text ? originalPromptText(text, replacements) : undefined;
      const displayed =
        displayText !== undefined && displayText !== text && isRecord(message)
          ? { ...message, content: displayText }
          : message;
      const mapped = toHistoryMessage(
        displayed,
        sessionId,
        part,
        entry.type === 'compaction' && entry.fromHook === true,
      );
      if (isRecord(mapped)) records.push({ id, message: { ...mapped, uuid: id } });
    }
  }
  return { revision, records, sessionStart };
}

function toHistoryMessage(
  message: unknown,
  sessionId: string,
  idx: number,
  backgroundCompaction: boolean,
): unknown | undefined {
  if (!isRecord(message)) return undefined;

  const timestamp = getNumber(message.timestamp);
  const uuidIndex = message.role === 'assistant' ? idx + 1 : idx;
  const base = {
    uuid: makeUuid(sessionId, uuidIndex),
    session_id: sessionId,
    parent_tool_use_id: null,
    timestamp,
  };

  if (message.role === 'user') {
    return {
      ...base,
      type: 'user',
      message: {
        role: 'user',
        content: redactInlineMedia(message.content),
      },
    };
  }

  if (message.role === 'assistant') {
    return {
      ...base,
      type: 'assistant',
      message: {
        role: 'assistant',
        model: getString(message.responseModel) ?? getString(message.model) ?? '',
        content: getHistoryContentBlocks(message.content),
        stop_reason: getString(message.stopReason),
        usage: message.usage,
      },
    };
  }

  if (message.role === 'compactionSummary') {
    // Pi splices compactions into the context as role 'compactionSummary' — map to
    // the same compact_boundary system event the live stream emits.
    return {
      ...base,
      type: 'system',
      subtype: 'compact_boundary',
      ...(backgroundCompaction ? { source: 'orchestrel-bgc' } : {}),
    };
  }

  if (message.role === 'toolResult') {
    return {
      ...base,
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: getString(message.toolCallId) ?? '',
            content: redactInlineMedia(message.content),
            is_error: message.isError === true,
          },
        ],
      },
    };
  }

  return undefined;
}

function getContextModel(ctx: Record<string, unknown>): string | undefined {
  const model = ctx.model;
  if (typeof model === 'string') return model;
  if (!isRecord(model)) return undefined;
  return getString(model.modelId) ?? getString(model.id) ?? getString(model.name);
}

function messageText(message: unknown): string | undefined {
  if (!isRecord(message) || message.role !== 'user') return undefined;
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return undefined;
  const text = message.content
    .map((block) => (isRecord(block) && block.type === 'text' ? (getString(block.text) ?? '') : ''))
    .join('');
  return text || undefined;
}

function getMessagesFromManager(
  manager: {
    buildSessionContext(): unknown;
    getBranch(): SessionEntry[];
  },
  sessionId: string,
): unknown[] {
  const ctx = manager.buildSessionContext();
  if (!isRecord(ctx) || !Array.isArray(ctx.messages)) return [];

  const branch = manager.getBranch();
  let backgroundCompaction = false;
  for (const entry of branch) {
    if (entry.type === 'compaction') backgroundCompaction = entry.fromHook === true;
  }
  const replacements = collectDisplayPrompts(branch);
  const messages: unknown[] = [];
  const model = getContextModel(ctx);
  if (model) {
    messages.push({
      type: 'system',
      subtype: 'init',
      uuid: makeUuid(sessionId, -1),
      session_id: sessionId,
      parent_tool_use_id: null,
      model,
      thinking_level: getString(ctx.thinkingLevel),
    });
  }

  for (const [idx, message] of ctx.messages.entries()) {
    let displayMessage = message;
    const text = messageText(message);
    if (text) {
      const displayText = originalPromptText(text, replacements);
      if (displayText !== text) displayMessage = { ...(message as Record<string, unknown>), content: displayText };
    }
    const historyMessage = toHistoryMessage(displayMessage, sessionId, idx, backgroundCompaction);
    if (historyMessage !== undefined) messages.push(historyMessage);
  }

  return messages;
}

function getSessionPaths(sessions: unknown[], sessionId: string): string[] {
  const paths: string[] = [];
  for (const session of sessions) {
    if (!isRecord(session)) continue;
    if (session.id !== sessionId) continue;
    if (typeof session.path === 'string') paths.push(session.path);
  }
  return paths;
}

export async function getPiSessionHistoryPage(
  sessionId: string,
  cwd: string,
  request: TranscriptHistoryRequest,
): Promise<TranscriptHistoryPage> {
  const { SessionManager, sessionEntryToContextMessages } = await import('@earendil-works/pi-coding-agent');
  let paths: string[];
  const pathKey = `${cwd}:${sessionId}`;
  const cachedPath = pathCache.get(pathKey);
  if (cachedPath) {
    try {
      statSync(cachedPath);
      paths = [cachedPath];
    } catch {
      pathCache.delete(pathKey); // file cleaned up — resolve again
      paths = [];
    }
  } else {
    paths = getSessionPaths(await SessionManager.list(cwd), sessionId);
    if (paths.length === 1) pathCache.set(pathKey, paths[0]);
  }
  if (paths.length === 0) {
    // The session file is gone — an old card whose session was cleaned up. That is
    // permanent, so answer with an empty page. An error here makes the client fall
    // back to session:load on every reconnect, for a transcript that no longer exists.
    return {
      sessionId,
      revision: '',
      records: [],
      before: null,
      after: null,
      prefix: '',
      hasOlder: false,
      hasNewer: false,
      reset: false,
    };
  }
  if (paths.length > 1) throw new Error(`Expected one history source for ${sessionId}, found ${paths.length}`);
  const path = paths[0];
  const stat = statSync(path);
  let cached = recordCache.get(path);
  let records: TranscriptHistoryPage['records'];
  let revision: string;
  let sessionStart: TranscriptHistoryPage['sessionStart'];
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    // LRU refresh.
    recordCache.delete(path);
    recordCache.set(path, cached);
    ({ records, revision, sessionStart } = cached);
  } else {
    const manager = SessionManager.open(path, undefined, cwd);
    const built = await buildRecords(path, sessionId, manager, sessionEntryToContextMessages);
    ({ records, revision, sessionStart } = built);
    if (stat.size <= MAX_CACHED_RECORD_FILE_BYTES) {
      if (recordCache.size >= MAX_CACHED_RECORD_FILES) {
        const oldest = recordCache.keys().next().value;
        if (oldest !== undefined) recordCache.delete(oldest);
      }
      recordCache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, ...built });
    }
  }
  // Cursors are stable: the file is append-only, so a page anchored on a record
  // id that still exists is valid no matter how much has been appended since.
  // Only a missing cursor (rewind/branch change) warrants a reset — a revision
  // mismatch here would wedge running sessions: every older-page request resets,
  // the client discards the reset, and the same cursor retries forever.
  let start = 0;
  let end = records.length;
  let reset = false;
  if (request.before) {
    const i = records.findIndex((record) => record.id === request.before);
    if (i < 0) reset = true;
    else end = i;
  }
  if (request.after) {
    const i = records.findIndex((record) => record.id === request.after);
    const prefix = windowPrefix(records, i + 1);
    if (i < 0 || (request.prefix != null && request.prefix !== prefix)) reset = true;
    else start = i + 1;
  }
  if (reset) {
    start = 0;
    end = records.length;
  }
  const page: TranscriptHistoryPage['records'] = [];
  let bytes = 0;
  const forward = !!request.after && !reset;
  if (forward) {
    for (let i = start; i < end && page.length < TRANSCRIPT_PAGE_SIZE; i++) {
      const size = Buffer.byteLength(JSON.stringify(records[i]));
      if (page.length && bytes + size > 1_048_576) break;
      page.push(records[i]);
      bytes += size;
    }
    end = start + page.length;
  } else {
    for (let i = end - 1; i >= start && page.length < TRANSCRIPT_PAGE_SIZE; i--) {
      const size = Buffer.byteLength(JSON.stringify(records[i]));
      if (page.length && bytes + size > 1_048_576) break;
      page.unshift(records[i]);
      bytes += size;
    }
    start = end - page.length;
  }
  return {
    sessionId,
    revision,
    records: page,
    before: page[0]?.id ?? null,
    after: page.at(-1)?.id ?? null,
    prefix: windowPrefix(records, end),
    hasOlder: start > 0,
    hasNewer: end < records.length,
    reset,
    ...(sessionStart ? { sessionStart } : {}),
  };
}

export async function getPiSessionMessages(sessionId: string, cwd: string): Promise<unknown[]> {
  try {
    const { SessionManager } = await import('@earendil-works/pi-coding-agent');

    const sessions = await SessionManager.list(cwd);
    const sessionPaths = getSessionPaths(sessions, sessionId);
    const messages: unknown[] = [];
    for (const sessionPath of sessionPaths.reverse()) {
      const manager = SessionManager.open(sessionPath, undefined, cwd);
      messages.push(...getMessagesFromManager(manager, sessionId));
    }
    return messages;
  } catch {
    return [];
  }
}
