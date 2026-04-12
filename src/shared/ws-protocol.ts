import { z } from 'zod';

// ── Entity schemas (unchanged) ─────────────────────────────────────────────

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
  worktreeBranch: z.string().nullable(),
  sourceBranch: z.enum(['main', 'dev']).nullable(),
  model: z.string(),
  provider: z.string(),
  thinkingLevel: z.enum(['off', 'low', 'medium', 'high']),
  promptsSent: z.number(),
  turnsCompleted: z.number(),
  contextTokens: z.number(),
  contextWindow: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
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
  color: z.string(),
  createdAt: z.string(),
  userIds: z.array(z.number()).optional(),
});

export const userSchema = z.object({
  id: z.number(),
  email: z.string(),
  role: z.string(),
});

export type Card = z.infer<typeof cardSchema>;
export type Project = z.infer<typeof projectSchema>;
export type User = z.infer<typeof userSchema>;

// ── Column enum ────────────────────────────────────────────────────────────

export const columnEnum = z.enum(['backlog', 'ready', 'running', 'review', 'done', 'archive']);
export type Column = z.infer<typeof columnEnum>;

// ── Mutation input schemas (unchanged) ─────────────────────────────────────

export const cardCreateSchema = z.object({
  title: z.string(),
  description: z.string().optional(),
  column: columnEnum.optional(),
  projectId: z.number().nullable().optional(),
  model: z.string().optional(),
  provider: z.string().optional(),
  thinkingLevel: z.enum(['off', 'low', 'medium', 'high']).optional(),
  worktreeBranch: z.string().nullable().optional(),
  sourceBranch: z.enum(['main', 'dev']).nullable().optional(),
  archiveOthers: z.boolean().optional(),
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
  color: z.string().optional(),
});

export const projectUpdateSchema = z
  .object({ id: z.number(), userIds: z.array(z.number()).optional() })
  .merge(projectCreateSchema.partial());

// ── Provider config schema (unchanged) ─────────────────────────────────────

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

// ── File ref schema (unchanged) ────────────────────────────────────────────

export const fileRefSchema = z.object({
  id: z.string(),
  name: z.string(),
  mimeType: z.string(),
  path: z.string(),
  size: z.number(),
});

export type FileRef = z.infer<typeof fileRefSchema>;

// ── Agent schemas (unchanged) ──────────────────────────────────────────────

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

export type AgentStatus = z.infer<typeof agentStatusSchema>;

// ── Socket.IO Typed Events ─────────────────────────────────────────────────

/** Standard ack response — every mutation callback receives this shape */
export interface AckResponse<T = unknown> {
  data?: T;
  error?: string;
}

/** Sync payload pushed after subscribe */
export interface SyncPayload {
  cards: Card[];
  projects: Project[];
  providers: Record<string, ProviderConfig>;
  user?: User;
  users?: User[];
}

/** Page result payload */
export interface PageResult {
  column: Column;
  cards: Card[];
  nextCursor?: number;
  total: number;
}

/** Client → Server events */
export interface ClientToServerEvents {
  // Subscription control (with ack for sync payload)
  subscribe: (columns: Column[], ack: (res: AckResponse<SyncPayload>) => void) => void;
  page: (data: { column: Column; cursor?: number; limit: number }, ack: (res: AckResponse<PageResult>) => void) => void;
  search: (data: { query: string }, ack: (res: AckResponse<{ cards: Card[]; total: number }>) => void) => void;

  // Card mutations
  'card:create': (data: z.infer<typeof cardCreateSchema>, ack: (res: AckResponse<Card>) => void) => void;
  'card:update': (data: z.infer<typeof cardUpdateSchema>, ack: (res: AckResponse<Card>) => void) => void;
  'card:delete': (data: { id: number }, ack: (res: AckResponse) => void) => void;
  'card:generateTitle': (data: { id: number }, ack: (res: AckResponse<Card>) => void) => void;
  'card:suggestTitle': (data: { description: string }, ack: (res: AckResponse<string>) => void) => void;

  // Project mutations
  'project:create': (data: z.infer<typeof projectCreateSchema>, ack: (res: AckResponse<Project>) => void) => void;
  'project:update': (data: z.infer<typeof projectUpdateSchema>, ack: (res: AckResponse<Project>) => void) => void;
  'project:delete': (data: { id: number }, ack: (res: AckResponse) => void) => void;
  'project:browse': (data: { path: string }, ack: (res: AckResponse<unknown>) => void) => void;
  'project:mkdir': (data: { path: string }, ack: (res: AckResponse<{ success: boolean }>) => void) => void;

  // Agent mutations
  'agent:send': (data: z.infer<typeof agentSendSchema>, ack: (res: AckResponse) => void) => void;
  'agent:compact': (data: { cardId: number }, ack: (res: AckResponse) => void) => void;
  'agent:stop': (data: { cardId: number }, ack: (res: AckResponse) => void) => void;
  'agent:status': (data: { cardId: number }, ack: (res: AckResponse) => void) => void;

  // Session
  'session:load': (data: { cardId: number; sessionId?: string }, ack: (res: AckResponse<{ messages: unknown[] }>) => void) => void;
  'session:set-model': (data: { cardId: number; provider: string; model: string }, ack: (res: AckResponse) => void) => void;

}

/** Server → Client push events */
export interface ServerToClientEvents {
  sync: (data: SyncPayload) => void;
  'card:updated': (data: Card) => void;
  'card:deleted': (data: { id: number }) => void;
  'project:updated': (data: Project) => void;
  'project:deleted': (data: { id: number }) => void;
  'session:message': (data: { cardId: number; message: unknown }) => void;
  'agent:status': (data: AgentStatus) => void;
}

/** Server-side socket.data shape */
export interface SocketData {
  identity: { id: number; email: string; role: string };
}
