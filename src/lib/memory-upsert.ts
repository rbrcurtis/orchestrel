/**
 * Memory upsert — extracts facts from a Claude Code session JSONL
 * and stores them in the shared-agent-memory API.
 *
 * Designed to run before compaction so that ALL messages since the last
 * compact_boundary are processed before any get summarized away.
 */
import { readFile } from 'fs/promises';
import { resolveJsonlPath, parseLines, buildExcerpt } from './session-compactor';

const LOG = '[memory-upsert]';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface MemoryUpsertResult {
  sessionId: string;
  messagesProcessed: number;
  factsExtracted: number;
  factsStored: number;
  durationMs: number;
}

export interface MemoryUpsertOpts {
  sessionId: string;
  projectPath: string;
  projectName: string;
  openRouterBaseUrl: string;
  openRouterApiKey: string;
  memoryBaseUrl: string;
  memoryApiKey: string;
  model?: string;
  maxExcerptChars?: number;
}

interface MemoryFact {
  title: string;
  text: string;
}

interface ChatResponse {
  choices: Array<{ message: { content: string } }>;
}

// ─── Extraction prompt ──────────────────────────────────────────────────────

const EXTRACTION_PROMPT = `You are a memory extraction assistant. Given a conversation excerpt between a user and an AI coding assistant, extract key facts, decisions, patterns, and learnings that would be useful to recall in future sessions.

Focus on:
- Technical decisions and their rationale
- Architecture patterns discovered or established
- Bug fixes and their root causes
- Infrastructure details (URLs, ports, credentials, paths)
- User preferences and workflows
- Project-specific knowledge

For each fact, output a JSON object on its own line with:
- "title": max 10 words, descriptive for semantic search
- "text": detailed description with full context

Output ONLY valid JSON lines, no markdown, no commentary, no wrapping.`;

// ─── LLM fact extraction ────────────────────────────────────────────────────

async function extractFacts(
  excerpt: string,
  baseUrl: string,
  apiKey: string,
  model: string,
): Promise<MemoryFact[]> {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: EXTRACTION_PROMPT },
        { role: 'user', content: excerpt },
      ],
      max_tokens: 4096,
      temperature: 0.3,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '<unreadable>');
    throw new Error(`OpenRouter ${res.status}: ${body}`);
  }

  const data = (await res.json()) as ChatResponse;
  const text = data.choices?.[0]?.message?.content ?? '';

  const facts: MemoryFact[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (
        typeof parsed === 'object' && parsed !== null &&
        'title' in parsed && 'text' in parsed &&
        typeof (parsed as Record<string, unknown>).title === 'string' &&
        typeof (parsed as Record<string, unknown>).text === 'string'
      ) {
        facts.push(parsed as MemoryFact);
      }
    } catch {
      // skip non-JSON lines
    }
  }
  return facts;
}

// ─── Memory API ─────────────────────────────────────────────────────────────

async function storeMemory(
  baseUrl: string,
  apiKey: string,
  fact: MemoryFact,
  project: string,
): Promise<void> {
  const res = await fetch(`${baseUrl}/api/v1/memories`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      title: fact.title,
      text: fact.text,
      project,
      tags: ['auto-upsert'],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '<unreadable>');
    throw new Error(`Memory API ${res.status}: ${body}`);
  }
}

// ─── Main export ────────────────────────────────────────────────────────────

export async function upsertMemories(opts: MemoryUpsertOpts): Promise<MemoryUpsertResult> {
  const {
    sessionId,
    projectPath,
    projectName,
    openRouterBaseUrl,
    openRouterApiKey,
    memoryBaseUrl,
    memoryApiKey,
    model = 'google/gemma-4-31b-it',
    maxExcerptChars = 120_000,
  } = opts;

  const t0 = Date.now();

  const jsonlPath = await resolveJsonlPath(sessionId, projectPath);
  const raw = await readFile(jsonlPath, 'utf-8');
  const lines = raw.split('\n');

  while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
    lines.pop();
  }

  const { messages } = parseLines(lines);

  if (messages.length < 2) {
    console.error(`${LOG} too few messages (${messages.length}), skipping`);
    return {
      sessionId,
      messagesProcessed: messages.length,
      factsExtracted: 0,
      factsStored: 0,
      durationMs: Date.now() - t0,
    };
  }

  // Build excerpt from ALL messages since last compact boundary
  const excerpt = buildExcerpt(messages, maxExcerptChars);

  console.error(`${LOG} extracting facts from ${messages.length} messages (${excerpt.length} chars)`);

  const facts = await extractFacts(excerpt, openRouterBaseUrl, openRouterApiKey, model);
  console.error(`${LOG} extracted ${facts.length} facts`);

  const results = await Promise.allSettled(
    facts.map(f => storeMemory(memoryBaseUrl, memoryApiKey, f, projectName)),
  );

  let stored = 0;
  for (const r of results) {
    if (r.status === 'fulfilled') {
      stored++;
    } else {
      console.error(`${LOG} failed to store: ${r.reason}`);
    }
  }

  const durationMs = Date.now() - t0;
  console.error(`${LOG} stored ${stored}/${facts.length} memories in ${durationMs}ms`);

  return {
    sessionId,
    messagesProcessed: messages.length,
    factsExtracted: facts.length,
    factsStored: stored,
    durationMs,
  };
}
