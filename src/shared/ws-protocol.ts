import { z } from 'zod'
import { createSelectSchema, createInsertSchema } from 'drizzle-zod'
import { cards, projects } from '../server/db/schema'

// ── Entity schemas derived from Drizzle ──────────────────────────────────────

export const cardSchema = createSelectSchema(cards)
export const projectSchema = createSelectSchema(projects)

export type Card = z.infer<typeof cardSchema>
export type Project = z.infer<typeof projectSchema>

// ── Column enum ──────────────────────────────────────────────────────────────

export const columnEnum = z.enum(['backlog', 'ready', 'in_progress', 'review', 'done', 'archive'])
export type Column = z.infer<typeof columnEnum>

// ── Mutation input schemas ───────────────────────────────────────────────────

const cardInsertSchema = createInsertSchema(cards)

export const cardCreateSchema = cardInsertSchema.pick({
  title: true,
  description: true,
  column: true,
  projectId: true,
  model: true,
  thinkingLevel: true,
  useWorktree: true,
  sourceBranch: true,
})

export const cardUpdateSchema = z.object({ id: z.number() }).merge(cardCreateSchema.partial())

export const cardMoveSchema = z.object({
  id: z.number(),
  column: columnEnum,
  position: z.number().optional(),
})

const projectInsertSchema = createInsertSchema(projects)

export const projectCreateSchema = projectInsertSchema.pick({
  name: true,
  path: true,
  setupCommands: true,
  defaultBranch: true,
  defaultWorktree: true,
  defaultModel: true,
  defaultThinkingLevel: true,
  color: true,
})

export const projectUpdateSchema = z.object({ id: z.number() }).merge(projectCreateSchema.partial())

// ── File ref schema ──────────────────────────────────────────────────────────

export const fileRefSchema = z.object({
  id: z.string(),
  name: z.string(),
  mimeType: z.string(),
  path: z.string(),
  size: z.number(),
})

export type FileRef = z.infer<typeof fileRefSchema>

// ── Claude schemas ───────────────────────────────────────────────────────────

export const claudeStartSchema = z.object({
  cardId: z.number(),
  prompt: z.string().min(1),
})

export const claudeSendSchema = z.object({
  cardId: z.number(),
  message: z.string(),
  files: z.array(fileRefSchema).optional(),
})

export const claudeStatusSchema = z.object({
  cardId: z.number(),
  active: z.boolean(),
  status: z.enum(['starting', 'running', 'completed', 'errored', 'stopped']),
  sessionId: z.string().nullable(),
  promptsSent: z.number(),
  turnsCompleted: z.number(),
})

export const claudeMessageSchema = z.object({
  type: z.string(),
  message: z.record(z.string(), z.unknown()),
  isSidechain: z.boolean().optional(),
  ts: z.string().optional(),
})

export type ClaudeStatus = z.infer<typeof claudeStatusSchema>
export type ClaudeMessage = z.infer<typeof claudeMessageSchema>

// ── Client → Server messages ─────────────────────────────────────────────────

export const clientMessage = z.discriminatedUnion('type', [
  // No requestId — subscription control
  z.object({ type: z.literal('subscribe'), columns: z.array(columnEnum) }),
  z.object({ type: z.literal('page'), column: columnEnum, cursor: z.number().optional(), limit: z.number() }),

  // Has requestId — request/response
  z.object({ type: z.literal('search'), query: z.string(), requestId: z.string() }),

  z.object({ type: z.literal('card:create'), requestId: z.string(), data: cardCreateSchema }),
  z.object({ type: z.literal('card:update'), requestId: z.string(), data: cardUpdateSchema }),
  z.object({ type: z.literal('card:move'), requestId: z.string(), data: cardMoveSchema }),
  z.object({ type: z.literal('card:delete'), requestId: z.string(), data: z.object({ id: z.number() }) }),
  z.object({ type: z.literal('card:generateTitle'), requestId: z.string(), data: z.object({ id: z.number() }) }),
  z.object({ type: z.literal('card:suggestTitle'), requestId: z.string(), data: z.object({ description: z.string() }) }),

  z.object({ type: z.literal('project:create'), requestId: z.string(), data: projectCreateSchema }),
  z.object({ type: z.literal('project:update'), requestId: z.string(), data: projectUpdateSchema }),
  z.object({ type: z.literal('project:delete'), requestId: z.string(), data: z.object({ id: z.number() }) }),
  z.object({ type: z.literal('project:browse'), requestId: z.string(), data: z.object({ path: z.string() }) }),

  z.object({ type: z.literal('claude:start'), requestId: z.string(), data: claudeStartSchema }),
  z.object({ type: z.literal('claude:send'), requestId: z.string(), data: claudeSendSchema }),
  z.object({ type: z.literal('claude:stop'), requestId: z.string(), data: z.object({ cardId: z.number() }) }),
  z.object({ type: z.literal('claude:status'), requestId: z.string(), data: z.object({ cardId: z.number() }) }),

  z.object({ type: z.literal('session:load'), requestId: z.string(), data: z.object({ sessionId: z.string(), cardId: z.number() }) }),
])

export type ClientMessage = z.infer<typeof clientMessage>

// ── Server → Client messages ─────────────────────────────────────────────────

export const serverMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('mutation:ok'), requestId: z.string(), data: z.unknown().optional() }),
  z.object({ type: z.literal('mutation:error'), requestId: z.string(), error: z.string() }),

  z.object({ type: z.literal('sync'), cards: z.array(cardSchema), projects: z.array(projectSchema) }),
  z.object({ type: z.literal('card:updated'), data: cardSchema }),
  z.object({ type: z.literal('card:deleted'), data: z.object({ id: z.number() }) }),
  z.object({ type: z.literal('project:updated'), data: projectSchema }),
  z.object({ type: z.literal('project:deleted'), data: z.object({ id: z.number() }) }),

  z.object({
    type: z.literal('page:result'), column: columnEnum,
    cards: z.array(cardSchema), nextCursor: z.number().optional(), total: z.number(),
  }),
  z.object({ type: z.literal('search:result'), requestId: z.string(), cards: z.array(cardSchema), total: z.number() }),

  z.object({ type: z.literal('session:history'), requestId: z.string(), cardId: z.number(), messages: z.array(claudeMessageSchema) }),

  z.object({ type: z.literal('claude:message'), cardId: z.number(), data: claudeMessageSchema }),
  z.object({ type: z.literal('claude:status'), data: claudeStatusSchema }),

  z.object({ type: z.literal('project:browse:result'), requestId: z.string(), data: z.unknown() }),
])

export type ServerMessage = z.infer<typeof serverMessage>
