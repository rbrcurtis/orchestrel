/**
 * Memory upsert — extracts facts from a Claude Code session JSONL
 * and stores them in the shared-agent-memory API.
 *
 * Designed to run before compaction so that ALL messages since the last
 * compact_boundary are processed before any get summarized away.
 */
import { readFile } from 'fs/promises';
import { resolveJsonlPath, parseLines, buildExcerpt, queryAgentSdk } from './session-compactor';

const LOG = '[memory-upsert]';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface MemoryUpsertResult {
  sessionId: string;
  messagesProcessed: number;
  factsExtracted: number;
  factsStored: number;
  factsUpdated: number;
  durationMs: number;
}

export interface MemoryUpsertOpts {
  sessionId: string;
  projectPath: string;
  projectName: string;
  model: string;
  env?: Record<string, string>;
  memoryBaseUrl: string;
  memoryApiKey: string;
  maxExcerptChars?: number;
}

interface MemoryFact {
  title: string;
  text: string;
}

// ─── Extraction prompt ──────────────────────────────────────────────────────

const EXTRACTION_PROMPT = `You are a memory extraction assistant. Do not use any tools. Do not read any files. Respond with ONLY the JSON lines.

Given a conversation excerpt between a user and an AI coding assistant, extract key facts, decisions, patterns, and learnings that would be useful to recall in future sessions.

Focus on:
- Technical decisions and their rationale
- Architecture patterns discovered or established
- Bug fixes and their root causes
- Infrastructure details (URLs, ports, paths — NOT credentials)
- User preferences and workflows
- Project-specific knowledge

NEVER extract secrets, API keys, tokens, passwords, or any credentials. Skip any fact that contains or references sensitive values.

For each fact, output a JSON object on its own line with:
- "title": max 10 words, descriptive for semantic search
- "text": detailed description with full context

Output ONLY valid JSON lines, no markdown, no commentary, no wrapping.

Here is the conversation to extract facts from:

`;

// ─── LLM fact extraction via Agent SDK ──────────────────────────────────────

async function extractFacts(
  excerpt: string,
  model: string,
  env?: Record<string, string>,
): Promise<MemoryFact[]> {
  const { text } = await queryAgentSdk(EXTRACTION_PROMPT + excerpt, model, env);

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

interface SearchHit {
  id: string;
  title: string;
  score: number;
}

async function searchMemory(
  baseUrl: string,
  apiKey: string,
  query: string,
  project: string,
): Promise<SearchHit | null> {
  const url = new URL(`${baseUrl}/api/v1/memories/search`);
  url.searchParams.set('query', query);
  url.searchParams.set('project', project);
  url.searchParams.set('limit', '1');

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '<unreadable>');
    throw new Error(`Memory search API ${res.status}: ${body}`);
  }
  const json = await res.json() as { data: SearchHit[] };
  return json.data[0] ?? null;
}

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

async function updateMemory(
  baseUrl: string,
  apiKey: string,
  id: string,
  fact: MemoryFact,
  project: string,
): Promise<void> {
  const res = await fetch(`${baseUrl}/api/v1/memories/${id}`, {
    method: 'PUT',
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
    throw new Error(`Memory update API ${res.status}: ${body}`);
  }
}

async function upsertFact(
  baseUrl: string,
  apiKey: string,
  fact: MemoryFact,
  project: string,
): Promise<'stored' | 'updated'> {
  const hit = await searchMemory(baseUrl, apiKey, fact.title, project);
  if (hit && hit.score >= 0.85) {
    await updateMemory(baseUrl, apiKey, hit.id, fact, project);
    return 'updated';
  }
  await storeMemory(baseUrl, apiKey, fact, project);
  return 'stored';
}

// ─── Main export ────────────────────────────────────────────────────────────

export async function upsertMemories(opts: MemoryUpsertOpts): Promise<MemoryUpsertResult> {
  const {
    sessionId,
    projectPath,
    projectName,
    model,
    memoryBaseUrl,
    memoryApiKey,
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
      factsUpdated: 0,
      durationMs: Date.now() - t0,
    };
  }

  // Build excerpt from ALL messages since last compact boundary
  const excerpt = buildExcerpt(messages, maxExcerptChars);

  console.error(`${LOG} extracting facts from ${messages.length} messages (${excerpt.length} chars)`);

  const facts = await extractFacts(excerpt, model, opts.env);
  console.error(`${LOG} extracted ${facts.length} facts`);

  const results = await Promise.allSettled(
    facts.map(f => upsertFact(memoryBaseUrl, memoryApiKey, f, projectName)),
  );

  let stored = 0;
  let updated = 0;
  for (const r of results) {
    if (r.status === 'fulfilled') {
      if (r.value === 'updated') updated++;
      else stored++;
    } else {
      console.error(`${LOG} failed to upsert: ${r.reason}`);
    }
  }

  const durationMs = Date.now() - t0;
  console.error(`${LOG} stored ${stored} new, updated ${updated} existing, skipped ${facts.length - stored - updated} failed — ${durationMs}ms`);

  return {
    sessionId,
    messagesProcessed: messages.length,
    factsExtracted: facts.length,
    factsStored: stored,
    factsUpdated: updated,
    durationMs,
  };
}
