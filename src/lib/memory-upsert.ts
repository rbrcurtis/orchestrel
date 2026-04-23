/**
 * Agent-driven memory upsert.
 *
 * Reads a session JSONL, builds an excerpt of the conversation, and hands
 * it to a Claude agent equipped with search_memory / store_memory /
 * update_memory / delete_memory tools. The agent reviews existing memories
 * on each topic and decides whether to update, store new, merge, or delete
 * — this is the same workflow as the `/m` skill in context-capture mode.
 *
 * The TS layer only:
 *   - reads the JSONL + builds excerpt
 *   - defines the MCP tools (thin wrappers over the memory HTTP API)
 *   - runs the agent and tallies tool invocations
 *
 * No fact extraction, no JSON parsing, no blind-overwrite logic. The agent
 * sees real search results (with scores) and makes the decision.
 */
import { readFile } from 'fs/promises';
import { z } from 'zod';
import { resolveJsonlPath, parseLines, buildExcerpt, queryAgentSdk } from './session-compactor';

const LOG = '[memory-upsert]';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface MemoryUpsertResult {
  sessionId: string;
  messagesProcessed: number;
  toolCalls: {
    search: number;
    store: number;
    update: number;
    delete: number;
  };
  turns: number;
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
  /** Max agent turns. Default 40. Each topic typically uses 2–4 (search + update/store). */
  maxTurns?: number;
}

// ─── Memory HTTP API ────────────────────────────────────────────────────────

interface SearchHit {
  id: string;
  title: string;
  text?: string;
  tags?: string[];
  score: number;
}

async function httpSearch(
  baseUrl: string,
  apiKey: string,
  query: string,
  project: string,
  limit: number,
): Promise<SearchHit[]> {
  const url = new URL(`${baseUrl}/api/v1/memories/search`);
  url.searchParams.set('query', query);
  url.searchParams.set('project', project);
  url.searchParams.set('limit', String(limit));

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '<unreadable>');
    throw new Error(`memory search ${res.status}: ${body}`);
  }
  const json = await res.json() as { data: SearchHit[] };
  return json.data;
}

async function httpStore(
  baseUrl: string,
  apiKey: string,
  title: string,
  text: string,
  tags: string[] | undefined,
  project: string,
): Promise<{ id: string }> {
  const res = await fetch(`${baseUrl}/api/v1/memories`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ title, text, project, tags: tags ?? ['auto-upsert'] }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '<unreadable>');
    throw new Error(`memory store ${res.status}: ${body}`);
  }
  const json = await res.json() as { id: string };
  return { id: json.id };
}

async function httpUpdate(
  baseUrl: string,
  apiKey: string,
  id: string,
  title: string,
  text: string,
  tags: string[] | undefined,
  project: string,
): Promise<void> {
  const res = await fetch(`${baseUrl}/api/v1/memories/${id}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ title, text, project, tags: tags ?? ['auto-upsert'] }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '<unreadable>');
    throw new Error(`memory update ${res.status}: ${body}`);
  }
}

async function httpDelete(
  baseUrl: string,
  apiKey: string,
  id: string,
): Promise<void> {
  const res = await fetch(`${baseUrl}/api/v1/memories/${id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok && res.status !== 404) {
    const body = await res.text().catch(() => '<unreadable>');
    throw new Error(`memory delete ${res.status}: ${body}`);
  }
}

// ─── Tool construction ──────────────────────────────────────────────────────

interface ToolCallCounters {
  search: number;
  store: number;
  update: number;
  delete: number;
}

function asText(payload: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

async function buildMemoryTools(
  baseUrl: string,
  apiKey: string,
  project: string,
  counters: ToolCallCounters,
): Promise<{ mcpServer: import('@anthropic-ai/claude-agent-sdk').McpSdkServerConfigWithInstance }> {
  const { createSdkMcpServer, tool } = await import('@anthropic-ai/claude-agent-sdk');

  const searchTool = tool(
    'search_memory',
    'Search the project memory store by semantic query. Returns up to `limit` hits with id, title, text preview, tags, and score (0-1, higher = better match). ALWAYS call this before storing new memories on a topic — you must know what already exists so you can update rather than duplicate.',
    {
      query: z.string().describe('Free-text semantic search query. Use concept keywords.'),
      limit: z.number().int().min(1).max(20).optional().describe('Max results, default 10.'),
    },
    async (args) => {
      counters.search++;
      const hits = await httpSearch(baseUrl, apiKey, args.query, project, args.limit ?? 10);
      return asText(hits.map(h => ({
        id: h.id,
        title: h.title,
        score: Number(h.score.toFixed(3)),
        tags: h.tags,
        preview: (h.text ?? '').slice(0, 400),
      })));
    },
  );

  const storeTool = tool(
    'store_memory',
    'Create a NEW memory. Only call this after search_memory confirms no existing memory covers this topic. Title should be a short descriptive label (max ~10 words) optimised for semantic search. Text is the full content.',
    {
      title: z.string().min(1).max(200).describe('Short descriptive title, <= 10 words.'),
      text: z.string().min(1).describe('Full memory content. Be thorough — include context, file paths, commands, rationale.'),
      tags: z.array(z.string()).optional().describe('Optional tags for categorization.'),
    },
    async (args) => {
      counters.store++;
      const { id } = await httpStore(baseUrl, apiKey, args.title, args.text, args.tags, project);
      return asText({ ok: true, id });
    },
  );

  const updateTool = tool(
    'update_memory',
    'Replace the title + text of an EXISTING memory by id. Use this when search_memory surfaced a memory that needs to be brought up to date, consolidated, or expanded. Prefer this over creating duplicates.',
    {
      id: z.string().describe('Memory id returned by search_memory.'),
      title: z.string().min(1).max(200).describe('New title (may be same as old).'),
      text: z.string().min(1).describe('New full text. Replaces the old text entirely — include everything that should remain.'),
      tags: z.array(z.string()).optional().describe('New tags (replaces old tag list).'),
    },
    async (args) => {
      counters.update++;
      await httpUpdate(baseUrl, apiKey, args.id, args.title, args.text, args.tags, project);
      return asText({ ok: true });
    },
  );

  const deleteTool = tool(
    'delete_memory',
    'Delete a memory by id. Use when search_memory reveals near-duplicate memories (same topic, overlapping content) — keep the best one, delete the rest. Also use to remove memories that are clearly stale/incorrect after you update a canonical one.',
    {
      id: z.string().describe('Memory id to delete.'),
    },
    async (args) => {
      counters.delete++;
      await httpDelete(baseUrl, apiKey, args.id);
      return asText({ ok: true });
    },
  );

  const mcpServer = createSdkMcpServer({
    name: 'memory',
    version: '1.0.0',
    tools: [searchTool, storeTool, updateTool, deleteTool],
  });

  return { mcpServer };
}

// ─── Prompt ─────────────────────────────────────────────────────────────────

function buildUpsertPrompt(projectName: string, excerpt: string): string {
  return `You are curating the long-term memory store for project "${projectName}".

You have four tools:
- search_memory(query, limit?) — look up existing memories by semantic query
- store_memory(title, text, tags?) — create a NEW memory
- update_memory(id, title, text, tags?) — replace an existing memory's content
- delete_memory(id) — remove a stale or duplicate memory

Your job: review the conversation excerpt below and reconcile it with the existing memory store.

WORKFLOW:
1. Scan the conversation for durable learnings — workflows, patterns, troubleshooting steps, infrastructure details, user preferences, technical decisions with rationale. Skip one-off chatter, secrets/credentials, and transient state.
2. Group learnings into distinct TOPICS (one concept per memory, always).
3. For each topic:
   a. Call search_memory with 1–3 keyword queries to find existing memories on that topic. Use broad queries — you may need multiple searches to be confident.
   b. Review the hits (note the scores and previews).
   c. Decide ONE of:
      - UPDATE the existing memory if it covers the topic but needs new info, consolidation, or correction. Write the NEW full text — update_memory replaces the old text entirely, so include everything worth keeping plus the new learnings.
      - STORE a new memory if no existing memory covers this topic adequately.
      - DELETE near-duplicate memories if search reveals 2+ on the same topic — keep the best one (update it if needed), delete the others.
      - SKIP if the existing memory is already current and accurate.
4. Continue until you've processed every memorable topic.

RULES:
- One concept per memory. Never bundle multiple topics.
- Titles: short (<= 10 words), descriptive, optimised for semantic search.
- Text: full detail — include file paths, commands, rationale, error messages, version numbers.
- NEVER store secrets, API keys, tokens, passwords, or credentials. Skip any learning that references sensitive values.
- Prefer update over store when score >= 0.7 and the existing memory is on the same topic — but read the preview to confirm it's truly the same concept before updating.
- Prefer delete over leaving duplicates. If two memories cover the same topic, consolidate into one.

When you have processed all memorable topics, STOP (respond with a brief summary of what you did — counts of store/update/delete per topic). Do not loop forever.

CONVERSATION EXCERPT:

${excerpt}
`;
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
    maxTurns = 40,
  } = opts;

  const t0 = Date.now();

  const jsonlPath = await resolveJsonlPath(sessionId, projectPath);
  const raw = await readFile(jsonlPath, 'utf-8');
  const lines = raw.split('\n');
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();

  const { messages } = parseLines(lines);

  if (messages.length < 2) {
    console.error(`${LOG} too few messages (${messages.length}), skipping`);
    return {
      sessionId,
      messagesProcessed: messages.length,
      toolCalls: { search: 0, store: 0, update: 0, delete: 0 },
      turns: 0,
      durationMs: Date.now() - t0,
    };
  }

  const excerpt = buildExcerpt(messages, maxExcerptChars);
  console.error(`${LOG} running agent over ${messages.length} messages (${excerpt.length} chars, project=${projectName})`);

  const counters: ToolCallCounters = { search: 0, store: 0, update: 0, delete: 0 };
  const { mcpServer } = await buildMemoryTools(memoryBaseUrl, memoryApiKey, projectName, counters);

  const prompt = buildUpsertPrompt(projectName, excerpt);

  // Give the model the memory tools only (no built-ins). Raise maxTurns so
  // it can iterate through topics: ~2-4 tool calls per topic plus a final
  // text turn. Thinking stays off — this is a mechanical review task.
  const { text: agentReport, durationMs: agentMs } = await queryAgentSdk(prompt, model, {
    env: opts.env,
    tools: [],
    mcpServers: { memory: mcpServer },
    settingSources: [],
    maxTurns,
    thinking: { type: 'disabled' },
  });

  const durationMs = Date.now() - t0;
  console.error(
    `${LOG} done — search=${counters.search} store=${counters.store} ` +
    `update=${counters.update} delete=${counters.delete} (agent ${agentMs}ms, total ${durationMs}ms)`,
  );
  // Log the agent's closing summary at debug level — useful for auditing
  if (agentReport) {
    console.error(`${LOG} agent report: ${agentReport.slice(0, 800)}${agentReport.length > 800 ? '…' : ''}`);
  }

  return {
    sessionId,
    messagesProcessed: messages.length,
    toolCalls: counters,
    turns: counters.search + counters.store + counters.update + counters.delete,
    durationMs,
  };
}
