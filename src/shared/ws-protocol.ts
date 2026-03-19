import { z } from 'zod';

// ── Entity schemas (standalone Zod — no Drizzle dependency) ──────────────────

// SQLite stores booleans as 0/1 integers; coerce to real booleans at parse time
const sqliteBool = z.union([z.boolean(), z.number()]).transform((v) => !!v);

export const cardSchema = z.object({
  id: z.number(),
  title: z.string(),
  description: z.string(),
  column: z.enum(['backlog', 'ready', 'running', 'review', 'done', 'archive']),
  position: z.number(),
  projectId: z.number().nullable(),
  prUrl: z.string().nullable(),
  sessionId: z.string().nullable(),
  worktreePath: z.string().nullable(),
  worktreeBranch: z.string().nullable(),
  useWorktree: sqliteBool,
  sourceBranch: z.enum(['main', 'dev']).nullable(),
  model: z.string(),
  thinkingLevel: z.enum(['off', 'low', 'medium', 'high']),
  promptsSent: z.number(),
  turnsCompleted: z.number(),
  contextTokens: z.number(),
  contextWindow: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
  queuePosition: z.number().nullable(),
});

export const projectSchema = z.object({
  id: z.number(),
  name: z.string(),
  path: z.string(),
  setupCommands: z.string(),
  isGitRepo: sqliteBool,
  defaultBranch: z.enum(['main', 'dev']).nullable(),
  defaultWorktree: sqliteBool,
  defaultModel: z.string(),
  defaultThinkingLevel: z.enum(['off', 'low', 'medium', 'high']),
  providerID: z.string(),
  color: z.string().nullable(),
  createdAt: z.string(),
});

export type Card = z.infer<typeof cardSchema>;
export type Project = z.infer<typeof projectSchema>;

// ── Column enum ──────────────────────────────────────────────────────────────

export const columnEnum = z.enum(['backlog', 'ready', 'running', 'review', 'done', 'archive']);
export type Column = z.infer<typeof columnEnum>;

// ── Mutation input schemas ───────────────────────────────────────────────────

export const cardCreateSchema = z.object({
  title: z.string(),
  description: z.string().optional(),
  column: columnEnum.optional(),
  projectId: z.number().nullable().optional(),
  model: z.string().optional(),
  thinkingLevel: z.enum(['off', 'low', 'medium', 'high']).optional(),
  useWorktree: z.boolean().optional(),
  sourceBranch: z.enum(['main', 'dev']).nullable().optional(),
});

export const cardUpdateSchema = z
  .object({ id: z.number(), position: z.number().optional() })
  .merge(cardCreateSchema.partial());

export const projectCreateSchema = z.object({
  name: z.string(),
  path: z.string(),
  setupCommands: z.string().optional(),
  defaultBranch: z.enum(['main', 'dev']).nullable().optional(),
  defaultWorktree: z.boolean().optional(),
  defaultModel: z.string().optional(),
  defaultThinkingLevel: z.enum(['off', 'low', 'medium', 'high']).optional(),
  providerID: z.string().optional(),
  color: z.string().nullable().optional(),
});

export const projectUpdateSchema = z.object({ id: z.number() }).merge(projectCreateSchema.partial());

// ── Provider config schema ───────────────────────────────────────────────────

export const modelConfigSchema = z.object({
  label: z.string(),
  modelID: z.string(),
  contextWindow: z.number(),
});

export const providerConfigSchema = z.object({
  label: z.string(),
  models: z.record(z.string(), modelConfigSchema),
});

export type ModelConfig = z.infer<typeof modelConfigSchema>;
export type ProviderConfig = z.infer<typeof providerConfigSchema>;
export type ProvidersMap = Record<string, ProviderConfig>;

// ── File ref schema ──────────────────────────────────────────────────────────

export const fileRefSchema = z.object({
  id: z.string(),
  name: z.string(),
  mimeType: z.string(),
  path: z.string(),
  size: z.number(),
});

export type FileRef = z.infer<typeof fileRefSchema>;

// ── Agent schemas ───────────────────────────────────────────────────────────

export const agentSendSchema = z.object({
  cardId: z.number(),
  message: z.string(),
  files: z.array(fileRefSchema).optional(),
});

export const agentStatusSchema = z.object({
  cardId: z.number(),
  active: z.boolean(),
  status: z.enum(['starting', 'running', 'completed', 'errored', 'stopped', 'retry']),
  sessionId: z.string().nullable(),
  promptsSent: z.number(),
  turnsCompleted: z.number(),
  contextTokens: z.number(),
  contextWindow: z.number(),
});

export const agentMessageSchema = z.object({
  type: z.enum([
    'text',
    'tool_call',
    'tool_result',
    'thinking',
    'system',
    'turn_end',
    'error',
    'user',
    'tool_progress',
    'subagent',
  ]),
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string(),
  toolCall: z
    .object({
      id: z.string(),
      name: z.string(),
      params: z.record(z.string(), z.unknown()).optional(),
      streamingOutput: z.string().optional(),
    })
    .optional(),
  toolResult: z
    .object({
      id: z.string(),
      output: z.string(),
      isError: z.boolean().optional(),
    })
    .optional(),
  usage: z
    .object({
      inputTokens: z.number(),
      outputTokens: z.number(),
      cacheRead: z.number().optional(),
      cacheWrite: z.number().optional(),
      contextWindow: z.number().optional(),
    })
    .optional(),
  modelUsage: z
    .record(
      z.string(),
      z.object({
        inputTokens: z.number(),
        outputTokens: z.number(),
        cacheReadInputTokens: z.number(),
        cacheCreationInputTokens: z.number(),
        costUSD: z.number(),
        contextWindow: z.number().optional(),
      }),
    )
    .optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
  timestamp: z.number(),
});

export type AgentStatus = z.infer<typeof agentStatusSchema>;
export type AgentMessage = z.infer<typeof agentMessageSchema>;

// ── Client → Server messages ─────────────────────────────────────────────────

export const clientMessage = z.discriminatedUnion('type', [
  // No requestId — subscription control
  z.object({ type: z.literal('subscribe'), columns: z.array(columnEnum) }),
  z.object({ type: z.literal('page'), column: columnEnum, cursor: z.number().optional(), limit: z.number() }),

  // Has requestId — request/response
  z.object({ type: z.literal('search'), query: z.string(), requestId: z.string() }),

  z.object({ type: z.literal('card:create'), requestId: z.string(), data: cardCreateSchema }),
  z.object({ type: z.literal('card:update'), requestId: z.string(), data: cardUpdateSchema }),
  z.object({ type: z.literal('card:delete'), requestId: z.string(), data: z.object({ id: z.number() }) }),
  z.object({ type: z.literal('card:generateTitle'), requestId: z.string(), data: z.object({ id: z.number() }) }),
  z.object({
    type: z.literal('card:suggestTitle'),
    requestId: z.string(),
    data: z.object({ description: z.string() }),
  }),

  z.object({ type: z.literal('project:create'), requestId: z.string(), data: projectCreateSchema }),
  z.object({ type: z.literal('project:update'), requestId: z.string(), data: projectUpdateSchema }),
  z.object({ type: z.literal('project:delete'), requestId: z.string(), data: z.object({ id: z.number() }) }),
  z.object({ type: z.literal('project:browse'), requestId: z.string(), data: z.object({ path: z.string() }) }),
  z.object({ type: z.literal('project:mkdir'), requestId: z.string(), data: z.object({ path: z.string() }) }),

  z.object({ type: z.literal('agent:send'), requestId: z.string(), data: agentSendSchema }),
  z.object({ type: z.literal('agent:stop'), requestId: z.string(), data: z.object({ cardId: z.number() }) }),
  z.object({ type: z.literal('agent:status'), requestId: z.string(), data: z.object({ cardId: z.number() }) }),

  z.object({
    type: z.literal('session:load'),
    requestId: z.string(),
    data: z.object({ sessionId: z.string().optional(), cardId: z.number() }),
  }),

  z.object({ type: z.literal('queue:reorder'), requestId: z.string(), cardId: z.number(), newPosition: z.number() }),
]);

export type ClientMessage = z.infer<typeof clientMessage>;

// ── Server → Client messages ─────────────────────────────────────────────────

export const serverMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('mutation:ok'), requestId: z.string(), data: z.unknown().optional() }),
  z.object({ type: z.literal('mutation:error'), requestId: z.string(), error: z.string() }),

  z.object({
    type: z.literal('sync'),
    cards: z.array(cardSchema),
    projects: z.array(projectSchema),
    providers: z.record(z.string(), providerConfigSchema),
  }),
  z.object({ type: z.literal('card:updated'), data: cardSchema }),
  z.object({ type: z.literal('card:deleted'), data: z.object({ id: z.number() }) }),
  z.object({ type: z.literal('project:updated'), data: projectSchema }),
  z.object({ type: z.literal('project:deleted'), data: z.object({ id: z.number() }) }),

  z.object({
    type: z.literal('page:result'),
    column: columnEnum,
    cards: z.array(cardSchema),
    nextCursor: z.number().optional(),
    total: z.number(),
  }),
  z.object({ type: z.literal('search:result'), requestId: z.string(), cards: z.array(cardSchema), total: z.number() }),

  z.object({
    type: z.literal('session:history'),
    requestId: z.string(),
    cardId: z.number(),
    messages: z.array(agentMessageSchema),
  }),

  z.object({ type: z.literal('agent:message'), cardId: z.number(), data: agentMessageSchema }),
  z.object({ type: z.literal('agent:status'), data: agentStatusSchema }),

  z.object({ type: z.literal('project:browse:result'), requestId: z.string(), data: z.unknown() }),
]);

export type ServerMessage = z.infer<typeof serverMessage>;
