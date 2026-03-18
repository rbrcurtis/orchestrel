# Implementation Plan: Event-Driven Architecture

**Date:** 2026-03-14
**Spec:** `docs/superpowers/specs/2026-03-14-event-driven-architecture-design.md`

## Overview

This plan rearchitects the Orchestrel server into three clean layers:
1. **Model Layer** — TypeORM ActiveRecord entities with lifecycle subscribers that publish domain events to a MessageBus
2. **Service Layer** — Orchestrates business logic, owns session lifecycle, no WS knowledge
3. **Transport Layer** — Thin WS handlers that translate client commands into service calls and forward bus events to subscribed clients

The existing SQLite database (`data/orchestrel.db`) is kept intact throughout — TypeORM entities mirror the current Drizzle schema exactly. Drizzle is removed only in the final task after all callers are migrated.

---

## Task 1: Dependencies & Config

Install TypeORM and add `experimentalDecorators` to tsconfig. Do NOT remove Drizzle — things still depend on it.

### Steps

- [ ] Install TypeORM and its SQLite driver:
  ```
  pnpm add typeorm
  ```
  `better-sqlite3` is already installed. TypeORM's `better-sqlite3` driver uses it directly — no extra dep needed.

- [ ] Add `experimentalDecorators: true` to `tsconfig.node.json`. Do NOT add `emitDecoratorMetadata` — it conflicts with `verbatimModuleSyntax`. TypeORM column types will be specified explicitly in each decorator instead.

  Edit `tsconfig.node.json`:
  ```json
  {
    "extends": "./tsconfig.json",
    "include": ["server.js", "vite.config.ts", "src/server/**/*.ts", "src/shared/**/*.ts"],
    "compilerOptions": {
      "composite": true,
      "strict": true,
      "types": ["node"],
      "lib": ["ES2022"],
      "target": "ES2022",
      "module": "ES2022",
      "moduleResolution": "bundler",
      "experimentalDecorators": true
    }
  }
  ```

- [ ] Verify TypeScript still compiles:
  ```
  pnpm typecheck
  ```
  Expected: no errors related to decorators. Existing Drizzle code continues to compile.

- [ ] Commit:
  ```
  git add tsconfig.node.json package.json pnpm-lock.yaml
  git commit -m "chore: install typeorm, enable experimentalDecorators"
  ```

---

## Task 2: MessageBus

Create the in-process pub/sub bus singleton. All subsequent layers depend on this.

### Steps

- [ ] Create `src/server/bus.ts`:
  ```typescript
  import { EventEmitter } from 'events'

  class MessageBus extends EventEmitter {
    publish(topic: string, payload: unknown): void {
      console.log(`[bus] publish ${topic}`)
      this.emit(topic, payload)
    }

    subscribe(topic: string, handler: (payload: unknown) => void): void {
      this.on(topic, handler)
    }

    unsubscribe(topic: string, handler: (payload: unknown) => void): void {
      this.removeListener(topic, handler)
    }
  }

  export const messageBus = new MessageBus()
  // Prevent MaxListenersExceededWarning — many clients subscribe to board:changed
  messageBus.setMaxListeners(200)
  ```

- [ ] Create `src/server/bus.test.ts`:
  ```typescript
  import { describe, it, expect, vi } from 'vitest'
  import { MessageBus } from './bus'

  // Test against a fresh instance so the singleton doesn't bleed between tests
  function makeBus() {
    const { MessageBus: MB } = await import('./bus')
    // We test the class directly by constructing a new one
  }

  describe('MessageBus', () => {
    it('delivers published payload to subscriber', () => {
      const bus = new (class extends (require('./bus').messageBus.constructor as any) {})()
      // Simpler: just use the class pattern
    })
  })
  ```

  Actually, because `bus.ts` only exports a singleton, tests should import the class separately. Refactor `bus.ts` to also export the class:

  Final `src/server/bus.ts`:
  ```typescript
  import { EventEmitter } from 'events'

  export class MessageBus extends EventEmitter {
    publish(topic: string, payload: unknown): void {
      console.log(`[bus] publish ${topic}`)
      this.emit(topic, payload)
    }

    subscribe(topic: string, handler: (payload: unknown) => void): void {
      this.on(topic, handler)
    }

    unsubscribe(topic: string, handler: (payload: unknown) => void): void {
      this.removeListener(topic, handler)
    }
  }

  export const messageBus = new MessageBus()
  messageBus.setMaxListeners(200)
  ```

- [ ] Create `src/server/bus.test.ts`:
  ```typescript
  import { describe, it, expect, vi } from 'vitest'
  import { MessageBus } from './bus'

  describe('MessageBus', () => {
    it('delivers published payload to subscriber', () => {
      const bus = new MessageBus()
      const handler = vi.fn()
      bus.subscribe('test:topic', handler)
      bus.publish('test:topic', { hello: 'world' })
      expect(handler).toHaveBeenCalledOnce()
      expect(handler).toHaveBeenCalledWith({ hello: 'world' })
    })

    it('does not deliver after unsubscribe', () => {
      const bus = new MessageBus()
      const handler = vi.fn()
      bus.subscribe('test:topic', handler)
      bus.unsubscribe('test:topic', handler)
      bus.publish('test:topic', {})
      expect(handler).not.toHaveBeenCalled()
    })

    it('delivers to multiple subscribers on same topic', () => {
      const bus = new MessageBus()
      const h1 = vi.fn()
      const h2 = vi.fn()
      bus.subscribe('test:multi', h1)
      bus.subscribe('test:multi', h2)
      bus.publish('test:multi', 42)
      expect(h1).toHaveBeenCalledWith(42)
      expect(h2).toHaveBeenCalledWith(42)
    })

    it('only removes the specific handler when unsubscribing', () => {
      const bus = new MessageBus()
      const h1 = vi.fn()
      const h2 = vi.fn()
      bus.subscribe('test:partial', h1)
      bus.subscribe('test:partial', h2)
      bus.unsubscribe('test:partial', h1)
      bus.publish('test:partial', {})
      expect(h1).not.toHaveBeenCalled()
      expect(h2).toHaveBeenCalledOnce()
    })
  })
  ```

- [ ] Run tests:
  ```
  pnpm vitest run src/server/bus.test.ts
  ```
  Expected: 4 tests pass.

- [ ] Commit:
  ```
  git add src/server/bus.ts src/server/bus.test.ts
  git commit -m "feat: add MessageBus singleton with publish/subscribe/unsubscribe"
  ```

---

## Task 3: Model Layer — Card Entity

Create the TypeORM Card entity with subscriber. Create the DataSource (pointed at the existing DB). The existing Drizzle code continues to work in parallel.

### Steps

- [ ] Create `src/server/models/Card.ts`:
  ```typescript
  import {
    Entity, PrimaryGeneratedColumn, Column, BaseEntity,
    EventSubscriber, EntitySubscriberInterface,
    type InsertEvent, type UpdateEvent, type RemoveEvent,
  } from 'typeorm'
  import { messageBus } from '../bus'

  @Entity({ name: 'cards' })
  export class Card extends BaseEntity {
    @PrimaryGeneratedColumn()
    id!: number

    @Column({ type: 'text' })
    title!: string

    @Column({ type: 'text', default: '' })
    description!: string

    @Column({ type: 'text', default: 'backlog' })
    column!: string

    @Column({ type: 'real', default: 0 })
    position!: number

    @Column({ name: 'project_id', type: 'integer', nullable: true })
    projectId!: number | null

    @Column({ name: 'pr_url', type: 'text', nullable: true })
    prUrl!: string | null

    @Column({ name: 'session_id', type: 'text', nullable: true })
    sessionId!: string | null

    @Column({ name: 'worktree_path', type: 'text', nullable: true })
    worktreePath!: string | null

    @Column({ name: 'worktree_branch', type: 'text', nullable: true })
    worktreeBranch!: string | null

    @Column({ name: 'use_worktree', type: 'integer', default: 1 })
    useWorktree!: boolean

    @Column({ name: 'source_branch', type: 'text', nullable: true })
    sourceBranch!: string | null

    @Column({ type: 'text', default: 'sonnet' })
    model!: string

    @Column({ name: 'thinking_level', type: 'text', default: 'high' })
    thinkingLevel!: string

    @Column({ name: 'prompts_sent', type: 'integer', default: 0 })
    promptsSent!: number

    @Column({ name: 'turns_completed', type: 'integer', default: 0 })
    turnsCompleted!: number

    @Column({ name: 'created_at', type: 'text' })
    createdAt!: string

    @Column({ name: 'updated_at', type: 'text' })
    updatedAt!: string
  }

  @EventSubscriber()
  export class CardSubscriber implements EntitySubscriberInterface<Card> {
    listenTo() { return Card }

    afterInsert(event: InsertEvent<Card>) {
      messageBus.publish(`card:${event.entity.id}:updated`, event.entity)
      messageBus.publish('board:changed', {
        card: event.entity,
        oldColumn: null,
        newColumn: event.entity.column,
      })
    }

    afterUpdate(event: UpdateEvent<Card>) {
      const card = event.entity as Card
      const prev = event.databaseEntity as Card
      messageBus.publish(`card:${card.id}:updated`, card)

      if (prev?.column !== card.column) {
        messageBus.publish('board:changed', {
          card,
          oldColumn: prev?.column ?? null,
          newColumn: card.column,
        })
      }
      if (
        prev?.promptsSent !== card.promptsSent ||
        prev?.turnsCompleted !== card.turnsCompleted ||
        prev?.sessionId !== card.sessionId
      ) {
        messageBus.publish(`card:${card.id}:status`, card)
      }
    }

    afterRemove(event: RemoveEvent<Card>) {
      messageBus.publish(`card:${event.entityId}:deleted`, { id: event.entityId })
      messageBus.publish('board:changed', {
        card: null,
        oldColumn: null,
        newColumn: null,
        id: event.entityId,
      })
    }
  }
  ```

  **Column name mapping:** TypeORM `name` option maps the property to the existing snake_case column. E.g. `projectId` → `project_id`. This ensures TypeORM reads/writes the same columns as Drizzle.

- [ ] Create `src/server/models/index.ts` with DataSource initialization:
  ```typescript
  import { DataSource } from 'typeorm'
  import { join } from 'path'
  import { mkdirSync } from 'fs'
  import { Card, CardSubscriber } from './Card'

  const DB_DIR = join(process.cwd(), 'data')
  mkdirSync(DB_DIR, { recursive: true })

  export const AppDataSource = new DataSource({
    type: 'better-sqlite3',
    database: join(DB_DIR, 'orchestrel.db'),
    entities: [Card],
    subscribers: [CardSubscriber],
    synchronize: false,
  })

  export async function initDatabase(): Promise<void> {
    if (!AppDataSource.isInitialized) {
      await AppDataSource.initialize()
      // SQLite pragmas for consistency with existing Drizzle setup
      const db = AppDataSource.driver.databaseConnection as import('better-sqlite3').Database
      db.pragma('journal_mode = WAL')
      db.pragma('foreign_keys = ON')
      console.log('[db] TypeORM DataSource initialized')
    }
  }
  ```

- [ ] Create `src/server/models/Card.test.ts`:
  ```typescript
  import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
  import { DataSource } from 'typeorm'
  import { Card, CardSubscriber } from './Card'
  import { messageBus } from '../bus'

  let ds: DataSource

  beforeAll(async () => {
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Card],
      subscribers: [CardSubscriber],
      synchronize: true,
    })
    await ds.initialize()
  })

  afterAll(async () => {
    await ds.destroy()
  })

  describe('Card entity', () => {
    it('creates a card and publishes card:updated + board:changed', async () => {
      const updatedHandler = vi.fn()
      const boardHandler = vi.fn()
      messageBus.subscribe('board:changed', boardHandler)

      const card = ds.getRepository(Card).create({
        title: 'Test card',
        description: 'Test desc',
        column: 'backlog',
        position: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      await card.save()

      messageBus.subscribe(`card:${card.id}:updated`, updatedHandler)
      // Trigger an update to test updated subscriber
      card.title = 'Updated title'
      await card.save()

      expect(updatedHandler).toHaveBeenCalledOnce()
      expect(boardHandler).toHaveBeenCalled() // called on insert

      messageBus.unsubscribe('board:changed', boardHandler)
      messageBus.unsubscribe(`card:${card.id}:updated`, updatedHandler)
    })

    it('publishes board:changed with oldColumn and newColumn when column changes', async () => {
      const boardHandler = vi.fn()
      messageBus.subscribe('board:changed', boardHandler)

      const card = ds.getRepository(Card).create({
        title: 'Column card',
        description: 'desc',
        column: 'backlog',
        position: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      await card.save()
      boardHandler.mockClear()

      card.column = 'ready'
      await card.save()

      expect(boardHandler).toHaveBeenCalledWith(
        expect.objectContaining({ oldColumn: 'backlog', newColumn: 'ready' })
      )
      messageBus.unsubscribe('board:changed', boardHandler)
    })

    it('publishes card:status when promptsSent changes', async () => {
      const statusHandler = vi.fn()

      const card = ds.getRepository(Card).create({
        title: 'Status card',
        description: 'desc',
        column: 'running',
        position: 0,
        promptsSent: 0,
        turnsCompleted: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      await card.save()

      messageBus.subscribe(`card:${card.id}:status`, statusHandler)
      card.promptsSent = 1
      await card.save()

      expect(statusHandler).toHaveBeenCalledOnce()
      messageBus.unsubscribe(`card:${card.id}:status`, statusHandler)
    })

    it('publishes card:deleted and board:changed on remove', async () => {
      const deletedHandler = vi.fn()
      const boardHandler = vi.fn()

      const card = ds.getRepository(Card).create({
        title: 'Delete me',
        description: 'desc',
        column: 'backlog',
        position: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      await card.save()
      const id = card.id

      messageBus.subscribe(`card:${id}:deleted`, deletedHandler)
      messageBus.subscribe('board:changed', boardHandler)
      boardHandler.mockClear()

      await card.remove()

      expect(deletedHandler).toHaveBeenCalledWith(expect.objectContaining({ id }))
      expect(boardHandler).toHaveBeenCalled()
      messageBus.unsubscribe(`card:${id}:deleted`, deletedHandler)
      messageBus.unsubscribe('board:changed', boardHandler)
    })
  })
  ```

- [ ] Run tests:
  ```
  pnpm vitest run src/server/models/Card.test.ts
  ```
  Expected: 4 tests pass.

- [ ] Commit:
  ```
  git add src/server/models/Card.ts src/server/models/index.ts src/server/models/Card.test.ts
  git commit -m "feat: add TypeORM Card entity + CardSubscriber + DataSource init"
  ```

---

## Task 4: Model Layer — Project Entity

Add the Project entity and subscriber. Register both entities in the DataSource.

### Steps

- [ ] Create `src/server/models/Project.ts`:
  ```typescript
  import {
    Entity, PrimaryGeneratedColumn, Column, BaseEntity,
    EventSubscriber, EntitySubscriberInterface,
    type InsertEvent, type UpdateEvent, type RemoveEvent,
  } from 'typeorm'
  import { messageBus } from '../bus'

  export const NEON_COLORS = [
    'neon-cyan', 'neon-magenta', 'neon-violet', 'neon-amber',
    'neon-lime', 'neon-coral', 'neon-electric', 'neon-plasma',
  ] as const

  export type NeonColor = typeof NEON_COLORS[number]

  @Entity({ name: 'projects' })
  export class Project extends BaseEntity {
    @PrimaryGeneratedColumn()
    id!: number

    @Column({ type: 'text' })
    name!: string

    @Column({ type: 'text' })
    path!: string

    @Column({ name: 'setup_commands', type: 'text', default: '' })
    setupCommands!: string

    @Column({ name: 'is_git_repo', type: 'integer', default: 0 })
    isGitRepo!: boolean

    @Column({ name: 'default_branch', type: 'text', nullable: true })
    defaultBranch!: string | null

    @Column({ name: 'default_worktree', type: 'integer', default: 0 })
    defaultWorktree!: boolean

    @Column({ name: 'default_model', type: 'text', default: 'sonnet' })
    defaultModel!: string

    @Column({ name: 'default_thinking_level', type: 'text', default: 'high' })
    defaultThinkingLevel!: string

    @Column({ name: 'provider_id', type: 'text', default: 'anthropic' })
    providerID!: string

    @Column({ type: 'text', nullable: true })
    color!: string | null

    @Column({ name: 'created_at', type: 'text' })
    createdAt!: string
  }

  @EventSubscriber()
  export class ProjectSubscriber implements EntitySubscriberInterface<Project> {
    listenTo() { return Project }

    afterInsert(event: InsertEvent<Project>) {
      messageBus.publish(`project:${event.entity.id}:updated`, event.entity)
    }

    afterUpdate(event: UpdateEvent<Project>) {
      messageBus.publish(`project:${(event.entity as Project).id}:updated`, event.entity)
    }

    afterRemove(event: RemoveEvent<Project>) {
      messageBus.publish(`project:${event.entityId}:deleted`, { id: event.entityId })
    }
  }
  ```

- [ ] Update `src/server/models/index.ts` to register Project and ProjectSubscriber:
  ```typescript
  import { DataSource } from 'typeorm'
  import { join } from 'path'
  import { mkdirSync } from 'fs'
  import { Card, CardSubscriber } from './Card'
  import { Project, ProjectSubscriber } from './Project'

  const DB_DIR = join(process.cwd(), 'data')
  mkdirSync(DB_DIR, { recursive: true })

  export const AppDataSource = new DataSource({
    type: 'better-sqlite3',
    database: join(DB_DIR, 'orchestrel.db'),
    entities: [Card, Project],
    subscribers: [CardSubscriber, ProjectSubscriber],
    synchronize: false,
  })

  export async function initDatabase(): Promise<void> {
    if (!AppDataSource.isInitialized) {
      await AppDataSource.initialize()
      const db = AppDataSource.driver.databaseConnection as import('better-sqlite3').Database
      db.pragma('journal_mode = WAL')
      db.pragma('foreign_keys = ON')
      console.log('[db] TypeORM DataSource initialized')
    }
  }
  ```

- [ ] Create `src/server/models/Project.test.ts`:
  ```typescript
  import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
  import { DataSource } from 'typeorm'
  import { Project, ProjectSubscriber } from './Project'
  import { messageBus } from '../bus'

  let ds: DataSource

  beforeAll(async () => {
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Project],
      subscribers: [ProjectSubscriber],
      synchronize: true,
    })
    await ds.initialize()
  })

  afterAll(async () => {
    await ds.destroy()
  })

  describe('Project entity', () => {
    it('publishes project:updated on insert', async () => {
      const handler = vi.fn()
      const proj = ds.getRepository(Project).create({
        name: 'Test project',
        path: '/tmp/test',
        createdAt: new Date().toISOString(),
      })
      await proj.save()
      messageBus.subscribe(`project:${proj.id}:updated`, handler)
      proj.name = 'Updated'
      await proj.save()
      expect(handler).toHaveBeenCalledOnce()
      messageBus.unsubscribe(`project:${proj.id}:updated`, handler)
    })

    it('publishes project:deleted on remove', async () => {
      const proj = ds.getRepository(Project).create({
        name: 'Delete me',
        path: '/tmp/delete',
        createdAt: new Date().toISOString(),
      })
      await proj.save()
      const id = proj.id
      const handler = vi.fn()
      messageBus.subscribe(`project:${id}:deleted`, handler)
      await proj.remove()
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ id }))
      messageBus.unsubscribe(`project:${id}:deleted`, handler)
    })
  })
  ```

- [ ] Run tests:
  ```
  pnpm vitest run src/server/models/Project.test.ts
  ```
  Expected: 2 tests pass.

- [ ] Commit:
  ```
  git add src/server/models/Project.ts src/server/models/index.ts src/server/models/Project.test.ts
  git commit -m "feat: add TypeORM Project entity + ProjectSubscriber, register in DataSource"
  ```

---

## Task 5: Update ws-protocol.ts

Replace Drizzle-derived `Card`/`Project` schemas with standalone Zod schemas that define the same shape. Move `NEON_COLORS` out of `db/schema.ts` (it now lives in `models/Project.ts`). The Card and Project types must remain byte-for-byte identical from the client's perspective.

### Steps

- [ ] Rewrite `src/shared/ws-protocol.ts`. The key change is replacing `createSelectSchema(cards)` and `createSelectSchema(projects)` with hand-written Zod schemas. Every field must exactly match the existing inferred types:

  ```typescript
  import { z } from 'zod'

  // ── Entity schemas (standalone — no longer derived from Drizzle) ──────────────

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
    useWorktree: z.boolean(),
    sourceBranch: z.enum(['main', 'dev']).nullable(),
    model: z.enum(['sonnet', 'opus', 'auto']),
    thinkingLevel: z.enum(['off', 'low', 'medium', 'high']),
    promptsSent: z.number(),
    turnsCompleted: z.number(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })

  export const projectSchema = z.object({
    id: z.number(),
    name: z.string(),
    path: z.string(),
    setupCommands: z.string(),
    isGitRepo: z.boolean(),
    defaultBranch: z.enum(['main', 'dev']).nullable(),
    defaultWorktree: z.boolean(),
    defaultModel: z.enum(['sonnet', 'opus', 'auto']),
    defaultThinkingLevel: z.enum(['off', 'low', 'medium', 'high']),
    providerID: z.string(),
    color: z.string().nullable(),
    createdAt: z.string(),
  })

  export type Card = z.infer<typeof cardSchema>
  export type Project = z.infer<typeof projectSchema>

  // ── Column enum ──────────────────────────────────────────────────────────────

  export const columnEnum = z.enum(['backlog', 'ready', 'running', 'review', 'done', 'archive'])
  export type Column = z.infer<typeof columnEnum>

  // ── Mutation input schemas ───────────────────────────────────────────────────

  export const cardCreateSchema = z.object({
    title: z.string(),
    description: z.string().optional(),
    column: columnEnum.optional(),
    projectId: z.number().nullable().optional(),
    model: z.enum(['sonnet', 'opus', 'auto']).optional(),
    thinkingLevel: z.enum(['off', 'low', 'medium', 'high']).optional(),
    useWorktree: z.boolean().optional(),
    sourceBranch: z.enum(['main', 'dev']).nullable().optional(),
  })

  export const cardUpdateSchema = z.object({ id: z.number(), position: z.number().optional() })
    .merge(cardCreateSchema.partial())

  export const projectCreateSchema = z.object({
    name: z.string(),
    path: z.string(),
    setupCommands: z.string().optional(),
    defaultBranch: z.enum(['main', 'dev']).nullable().optional(),
    defaultWorktree: z.boolean().optional(),
    defaultModel: z.enum(['sonnet', 'opus', 'auto']).optional(),
    defaultThinkingLevel: z.enum(['off', 'low', 'medium', 'high']).optional(),
    providerID: z.string().optional(),
    color: z.string().nullable().optional(),
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

  // ── Agent schemas ────────────────────────────────────────────────────────────

  export const agentSendSchema = z.object({
    cardId: z.number(),
    message: z.string(),
    files: z.array(fileRefSchema).optional(),
  })

  export const agentStatusSchema = z.object({
    cardId: z.number(),
    active: z.boolean(),
    status: z.enum(['starting', 'running', 'completed', 'errored', 'stopped']),
    sessionId: z.string().nullable(),
    promptsSent: z.number(),
    turnsCompleted: z.number(),
  })

  export const agentMessageSchema = z.object({
    type: z.enum(['text', 'tool_call', 'tool_result', 'thinking', 'system', 'turn_end', 'error', 'user', 'tool_progress']),
    role: z.enum(['user', 'assistant', 'system']),
    content: z.string(),
    toolCall: z.object({
      id: z.string(),
      name: z.string(),
      params: z.record(z.string(), z.unknown()).optional(),
    }).optional(),
    toolResult: z.object({
      id: z.string(),
      output: z.string(),
      isError: z.boolean().optional(),
    }).optional(),
    usage: z.object({
      inputTokens: z.number(),
      outputTokens: z.number(),
      cacheRead: z.number().optional(),
      cacheWrite: z.number().optional(),
      contextWindow: z.number().optional(),
    }).optional(),
    modelUsage: z.record(z.string(), z.object({
      inputTokens: z.number(),
      outputTokens: z.number(),
      cacheReadInputTokens: z.number(),
      cacheCreationInputTokens: z.number(),
      costUSD: z.number(),
      contextWindow: z.number().optional(),
    })).optional(),
    meta: z.record(z.string(), z.unknown()).optional(),
    timestamp: z.number(),
  })

  export type AgentStatus = z.infer<typeof agentStatusSchema>
  export type AgentMessage = z.infer<typeof agentMessageSchema>

  // ── Client → Server messages ─────────────────────────────────────────────────

  export const clientMessage = z.discriminatedUnion('type', [
    z.object({ type: z.literal('subscribe'), columns: z.array(columnEnum) }),
    z.object({ type: z.literal('page'), column: columnEnum, cursor: z.number().optional(), limit: z.number() }),

    z.object({ type: z.literal('search'), query: z.string(), requestId: z.string() }),

    z.object({ type: z.literal('card:create'), requestId: z.string(), data: cardCreateSchema }),
    z.object({ type: z.literal('card:update'), requestId: z.string(), data: cardUpdateSchema }),
    z.object({ type: z.literal('card:delete'), requestId: z.string(), data: z.object({ id: z.number() }) }),
    z.object({ type: z.literal('card:generateTitle'), requestId: z.string(), data: z.object({ id: z.number() }) }),
    z.object({ type: z.literal('card:suggestTitle'), requestId: z.string(), data: z.object({ description: z.string() }) }),

    z.object({ type: z.literal('project:create'), requestId: z.string(), data: projectCreateSchema }),
    z.object({ type: z.literal('project:update'), requestId: z.string(), data: projectUpdateSchema }),
    z.object({ type: z.literal('project:delete'), requestId: z.string(), data: z.object({ id: z.number() }) }),
    z.object({ type: z.literal('project:browse'), requestId: z.string(), data: z.object({ path: z.string() }) }),
    z.object({ type: z.literal('project:mkdir'), requestId: z.string(), data: z.object({ path: z.string() }) }),

    z.object({ type: z.literal('agent:send'), requestId: z.string(), data: agentSendSchema }),
    z.object({ type: z.literal('agent:stop'), requestId: z.string(), data: z.object({ cardId: z.number() }) }),
    z.object({ type: z.literal('agent:status'), requestId: z.string(), data: z.object({ cardId: z.number() }) }),

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

    z.object({ type: z.literal('session:history'), requestId: z.string(), cardId: z.number(), messages: z.array(agentMessageSchema) }),

    z.object({ type: z.literal('agent:message'), cardId: z.number(), data: agentMessageSchema }),
    z.object({ type: z.literal('agent:status'), data: agentStatusSchema }),

    z.object({ type: z.literal('project:browse:result'), requestId: z.string(), data: z.unknown() }),
  ])

  export type ServerMessage = z.infer<typeof serverMessage>
  ```

  **Note on Drizzle defaulted fields:** The original `createInsertSchema` for `cardCreateSchema` only picked specific fields. The new version replicas that — only the fields a client can set at creation time. The `setupCommands` field for projects (which had `.default('')` in Drizzle) becomes `z.string().optional()` in the create schema so it's not required.

- [ ] Run typecheck to confirm no type errors caused by the schema change:
  ```
  pnpm typecheck
  ```
  Expected: zero errors. The `Card` and `Project` types exported from `ws-protocol.ts` must remain compatible with all consumer files.

- [ ] Commit:
  ```
  git add src/shared/ws-protocol.ts
  git commit -m "feat: replace Drizzle-derived ws-protocol schemas with standalone Zod schemas"
  ```

---

## Task 6: CardService

Create the service that owns all card business logic. All mutations go through the TypeORM model — subscribers handle broadcasting automatically.

### Steps

- [ ] Create `src/server/services/card.ts`:
  ```typescript
  import { ILike, In, IsNull, Not } from 'typeorm'
  import { Card } from '../models/Card'
  import type { Column } from '../../shared/ws-protocol'
  import {
    removeWorktree,
    worktreeExists,
  } from '../worktree'
  import { Project } from '../models/Project'

  export interface PageResult {
    cards: Card[]
    nextCursor: number | undefined
    total: number
  }

  const PAGE_SIZE = 20

  async function ollamaSuggestTitle(description: string): Promise<string> {
    const res = await fetch('http://localhost:11434/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gemma3:4b',
        stream: false,
        prompt: `Generate a kanban card title of 3 words or fewer based on this description. Return only the title text, no quotes, no prefix.\n\nDescription: ${description}`,
      }),
    })
    if (!res.ok) throw new Error(`Ollama request failed: ${res.status} ${res.statusText}`)
    const data = await res.json() as { response: string }
    return data.response.trim()
  }

  class CardService {
    async listCards(columns?: Column[]): Promise<Card[]> {
      if (columns && columns.length > 0) {
        return Card.find({ where: columns.map(col => ({ column: col })), order: { position: 'ASC' } })
      }
      return Card.find({ order: { position: 'ASC' } })
    }

    async createCard(data: Partial<Card>): Promise<Card> {
      const col = (data.column ?? 'backlog') as Column

      // Compute next position in column
      const maxCard = await Card.findOne({
        where: { column: col },
        order: { position: 'DESC' },
      })
      const position = (maxCard?.position ?? -1) + 1

      // Inherit defaults from project if projectId set
      if (data.projectId) {
        const proj = await Project.findOneBy({ id: data.projectId })
        if (proj) {
          data.model = data.model ?? proj.defaultModel
          data.thinkingLevel = data.thinkingLevel ?? proj.defaultThinkingLevel
        }
      }

      const now = new Date().toISOString()
      const card = Card.create({
        ...data,
        column: col,
        position,
        createdAt: now,
        updatedAt: now,
      })
      await card.save()

      // Auto-start session when creating directly into running
      if (col === 'running') {
        // Lazy import to avoid circular dep — SessionService imports CardService
        const { sessionService } = await import('./session')
        await sessionService.startSession(card.id, undefined)
      }

      return card
    }

    async updateCard(id: number, data: Partial<Card>): Promise<Card> {
      const card = await Card.findOneByOrFail({ id })
      const movingToRunning = data.column === 'running' && card.column !== 'running'
      const movingToArchive = data.column === 'archive' && card.column !== 'archive'

      // Validate: running requires non-empty title and description
      if (data.column === 'running') {
        const title = data.title ?? card.title
        const desc = data.description !== undefined ? data.description : card.description
        if (!title?.trim()) throw new Error('Title is required for running')
        if (!desc?.trim()) throw new Error('Description is required for running')
      }

      // Worktree removal when archiving
      if (movingToArchive && card.useWorktree && card.worktreePath && card.projectId) {
        const proj = await Project.findOneBy({ id: card.projectId })
        if (proj && worktreeExists(card.worktreePath)) {
          try {
            removeWorktree(proj.path, card.worktreePath)
          } catch (err) {
            console.error(`[card:${id}] failed to remove worktree:`, err)
          }
        }
      }

      Object.assign(card, data)
      card.updatedAt = new Date().toISOString()
      await card.save()

      // Auto-start session when moving to running
      if (movingToRunning) {
        const { sessionService } = await import('./session')
        await sessionService.startSession(card.id, undefined)
      }

      return card
    }

    async deleteCard(id: number): Promise<void> {
      const card = await Card.findOneByOrFail({ id })
      await card.remove()
    }

    async searchCards(query: string): Promise<{ cards: Card[]; total: number }> {
      const pattern = `%${query}%`
      const [results, total] = await Card.findAndCount({
        where: [
          { title: ILike(pattern) },
          { description: ILike(pattern) },
        ],
        order: { position: 'ASC' },
      })
      return { cards: results, total }
    }

    async pageCards(column: Column, cursor?: number, limit = PAGE_SIZE): Promise<PageResult> {
      const all = await Card.find({
        where: { column },
        order: { position: 'ASC' },
      })
      const startIdx = cursor !== undefined
        ? all.findIndex(c => c.id === cursor) + 1
        : 0
      const slice = all.slice(startIdx, startIdx + limit)
      const nextCursor = startIdx + limit < all.length
        ? slice[slice.length - 1]?.id
        : undefined
      return { cards: slice, nextCursor, total: all.length }
    }

    async generateTitle(cardId: number): Promise<Card> {
      const card = await Card.findOneByOrFail({ id: cardId })
      if (!card.description) throw new Error('Card has no description to generate title from')
      const title = await ollamaSuggestTitle(card.description)
      card.title = title
      card.updatedAt = new Date().toISOString()
      await card.save()
      return card
    }

    async suggestTitle(description: string): Promise<string> {
      return ollamaSuggestTitle(description)
    }
  }

  export const cardService = new CardService()
  ```

  **Note on `ILike`:** SQLite is case-insensitive for ASCII by default so `ILike` behaves the same as `Like` on SQLite, but using `ILike` keeps intent clear.

  **Note on circular import:** `CardService.createCard`/`updateCard` lazily imports `sessionService` via dynamic `import()` to avoid the circular dependency (SessionService → CardService → SessionService). This is safe in Node ESM.

- [ ] Create `src/server/services/card.test.ts`:
  ```typescript
  import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
  import { DataSource } from 'typeorm'
  import { Card, CardSubscriber } from '../models/Card'
  import { Project, ProjectSubscriber } from '../models/Project'

  // Patch AppDataSource before importing cardService
  vi.mock('../models/index', () => ({ AppDataSource: ds }))

  let ds: DataSource

  beforeAll(async () => {
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Card, Project],
      subscribers: [CardSubscriber, ProjectSubscriber],
      synchronize: true,
    })
    await ds.initialize()
  })

  afterAll(async () => {
    await ds.destroy()
  })

  describe('CardService', () => {
    it('createCard sets position as max+1 in column', async () => {
      const { cardService } = await import('./card')
      const c1 = await cardService.createCard({ title: 'A', description: 'x', column: 'backlog' })
      const c2 = await cardService.createCard({ title: 'B', description: 'y', column: 'backlog' })
      expect(c2.position).toBeGreaterThan(c1.position)
    })

    it('updateCard validates title/description when moving to running', async () => {
      const { cardService } = await import('./card')
      const c = await cardService.createCard({ title: 'Test', description: '', column: 'ready' })
      await expect(cardService.updateCard(c.id, { column: 'running' }))
        .rejects.toThrow('Description is required')
    })

    it('searchCards returns matching cards', async () => {
      const { cardService } = await import('./card')
      await cardService.createCard({ title: 'Find me', description: 'unique-xyz', column: 'backlog' })
      const { cards, total } = await cardService.searchCards('unique-xyz')
      expect(total).toBeGreaterThanOrEqual(1)
      expect(cards.some(c => c.description === 'unique-xyz')).toBe(true)
    })

    it('pageCards returns sliced results with nextCursor', async () => {
      const { cardService } = await import('./card')
      // Create 3 cards in 'done' column for isolation
      await cardService.createCard({ title: 'P1', description: 'd', column: 'done' })
      await cardService.createCard({ title: 'P2', description: 'd', column: 'done' })
      await cardService.createCard({ title: 'P3', description: 'd', column: 'done' })
      const page = await cardService.pageCards('done', undefined, 2)
      expect(page.cards.length).toBe(2)
      expect(page.nextCursor).toBeDefined()
    })

    it('deleteCard removes the card', async () => {
      const { cardService } = await import('./card')
      const c = await cardService.createCard({ title: 'Delete', description: 'd', column: 'backlog' })
      await cardService.deleteCard(c.id)
      const found = await Card.findOneBy({ id: c.id })
      expect(found).toBeNull()
    })
  })
  ```

- [ ] Run tests:
  ```
  pnpm vitest run src/server/services/card.test.ts
  ```
  Expected: 5 tests pass. (The `updateCard` to `running` test will pass because mock prevents sessionService.startSession from running.)

- [ ] Commit:
  ```
  git add src/server/services/card.ts src/server/services/card.test.ts
  git commit -m "feat: add CardService with CRUD, search, pagination, generateTitle"
  ```

---

## Task 7: ProjectService

Create the service that owns project CRUD plus filesystem operations.

### Steps

- [ ] Create `src/server/services/project.ts`:
  ```typescript
  import { existsSync } from 'fs'
  import { readdir, mkdir } from 'fs/promises'
  import { join } from 'path'
  import { Project, NEON_COLORS } from '../models/Project'

  export interface DirEntry {
    name: string
    path: string
    isDir: boolean
  }

  class ProjectService {
    async listProjects(): Promise<Project[]> {
      return Project.find()
    }

    async createProject(data: Partial<Project>): Promise<Project> {
      // Auto-detect isGitRepo from path
      if (data.path) {
        data.isGitRepo = existsSync(join(data.path, '.git'))
      }

      // Auto-assign first unused neon color
      if (!data.color) {
        const used = (await Project.find({ select: { color: true } })).map(p => p.color)
        data.color = NEON_COLORS.find(c => !used.includes(c)) ?? NEON_COLORS[0]
      }

      const proj = Project.create({
        ...data,
        createdAt: new Date().toISOString(),
      })
      await proj.save()
      return proj
    }

    async updateProject(id: number, data: Partial<Project>): Promise<Project> {
      const proj = await Project.findOneByOrFail({ id })

      // Re-detect isGitRepo if path changes
      if (data.path) {
        data.isGitRepo = existsSync(join(data.path, '.git'))
      }

      Object.assign(proj, data)
      await proj.save()
      return proj
    }

    async deleteProject(id: number): Promise<void> {
      const proj = await Project.findOneByOrFail({ id })
      await proj.remove()
    }

    async browse(path: string): Promise<DirEntry[]> {
      const entries = await readdir(path, { withFileTypes: true })
      return entries
        .filter(e => e.isDirectory() && !e.name.startsWith('.'))
        .map(e => ({ name: e.name, path: join(path, e.name), isDir: true }))
        .sort((a, b) => a.name.localeCompare(b.name))
    }

    async mkdir(path: string): Promise<void> {
      await mkdir(path, { recursive: true })
    }
  }

  export const projectService = new ProjectService()
  ```

- [ ] Create `src/server/services/project.test.ts`:
  ```typescript
  import { describe, it, expect, beforeAll, afterAll } from 'vitest'
  import { DataSource } from 'typeorm'
  import { Project, ProjectSubscriber, NEON_COLORS } from '../models/Project'
  import { tmpdir } from 'os'
  import { join } from 'path'

  let ds: DataSource

  beforeAll(async () => {
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Project],
      subscribers: [ProjectSubscriber],
      synchronize: true,
    })
    await ds.initialize()
  })

  afterAll(async () => {
    await ds.destroy()
  })

  describe('ProjectService', () => {
    it('createProject auto-assigns first unused neon color', async () => {
      const { projectService } = await import('./project')
      const p1 = await projectService.createProject({ name: 'P1', path: '/tmp' })
      const p2 = await projectService.createProject({ name: 'P2', path: '/tmp' })
      expect(p1.color).toBe(NEON_COLORS[0])
      expect(p2.color).toBe(NEON_COLORS[1])
    })

    it('createProject detects isGitRepo from path', async () => {
      const { projectService } = await import('./project')
      // /tmp doesn't have .git, so isGitRepo should be false
      const p = await projectService.createProject({ name: 'NoGit', path: tmpdir() })
      expect(p.isGitRepo).toBe(false)
    })

    it('updateProject re-detects isGitRepo when path changes', async () => {
      const { projectService } = await import('./project')
      const p = await projectService.createProject({ name: 'ReGit', path: '/tmp' })
      const updated = await projectService.updateProject(p.id, { path: tmpdir() })
      expect(typeof updated.isGitRepo).toBe('boolean')
    })

    it('browse returns non-hidden directories sorted', async () => {
      const { projectService } = await import('./project')
      const entries = await projectService.browse(tmpdir())
      expect(Array.isArray(entries)).toBe(true)
      entries.forEach(e => {
        expect(e.isDir).toBe(true)
        expect(e.name.startsWith('.')).toBe(false)
      })
    })

    it('mkdir creates directory recursively', async () => {
      const { projectService } = await import('./project')
      const { existsSync } = await import('fs')
      const path = join(tmpdir(), `orchestrel-test-${Date.now()}`, 'sub')
      await projectService.mkdir(path)
      expect(existsSync(path)).toBe(true)
    })

    it('deleteProject removes it', async () => {
      const { projectService } = await import('./project')
      const p = await projectService.createProject({ name: 'Del', path: '/tmp' })
      await projectService.deleteProject(p.id)
      const found = await Project.findOneBy({ id: p.id })
      expect(found).toBeNull()
    })
  })
  ```

- [ ] Run tests:
  ```
  pnpm vitest run src/server/services/project.test.ts
  ```
  Expected: 6 tests pass.

- [ ] Commit:
  ```
  git add src/server/services/project.ts src/server/services/project.test.ts
  git commit -m "feat: add ProjectService with CRUD, browse, mkdir, isGitRepo detection"
  ```

---

## Task 8: SessionService

Create the service that owns the full session lifecycle. This replaces `beginSession()` from `agents/begin-session.ts`. The service has no knowledge of WebSocket — it only uses models and the bus.

### Steps

- [ ] Create `src/server/services/session.ts`:

  ```typescript
  import { resolve } from 'path'
  import { Card } from '../models/Card'
  import { Project } from '../models/Project'
  import { messageBus } from '../bus'
  import { sessionManager } from '../agents/manager'
  import { OpenCodeSession } from '../agents/opencode/session'
  import type { AgentMessage, SessionStatus } from '../agents/types'
  import type { FileRef } from '../../shared/ws-protocol'
  import {
    copyOpencodeConfig,
    createWorktree,
    runSetupCommands,
    slugify,
    worktreeExists,
  } from '../worktree'

  const DISPLAY_TYPES = new Set([
    'user', 'text', 'tool_call', 'tool_result', 'tool_progress',
    'thinking', 'system', 'turn_end', 'error',
  ])

  export interface SessionStatusData {
    cardId: number
    active: boolean
    status: SessionStatus
    sessionId: string | null
    promptsSent: number
    turnsCompleted: number
  }

  async function ensureWorktree(card: Card): Promise<string> {
    console.log(`[session:${card.id}] ensureWorktree: worktreePath=${card.worktreePath}, useWorktree=${card.useWorktree}, projectId=${card.projectId}`)
    if (card.worktreePath) return card.worktreePath

    if (!card.projectId) throw new Error(`Card ${card.id} has no project`)
    const proj = await Project.findOneByOrFail({ id: card.projectId })

    if (!card.useWorktree) {
      card.worktreePath = proj.path
      card.updatedAt = new Date().toISOString()
      await card.save()
      return proj.path
    }

    const slug = card.worktreeBranch || slugify(card.title)
    const wtPath = `${proj.path}/.worktrees/${slug}`
    const branch = slug
    const source = card.sourceBranch ?? proj.defaultBranch ?? undefined

    if (!worktreeExists(wtPath)) {
      console.log(`[session:${card.id}] worktree setup at ${wtPath}`)
      createWorktree(proj.path, wtPath, branch, source ?? undefined)
      if (proj.setupCommands) {
        console.log(`[session:${card.id}] running setup commands...`)
        runSetupCommands(wtPath, proj.setupCommands)
        console.log(`[session:${card.id}] setup commands done`)
      }
      copyOpencodeConfig(proj.path, wtPath)
    } else {
      console.log(`[session:${card.id}] worktree already exists at ${wtPath}`)
    }

    card.worktreePath = wtPath
    card.worktreeBranch = branch
    card.updatedAt = new Date().toISOString()
    await card.save()
    return wtPath
  }

  class SessionService {
    async startSession(cardId: number, message?: string, files?: FileRef[]): Promise<void> {
      const existing = sessionManager.get(cardId)

      if (existing) {
        // Follow-up message to an existing session
        if (!message) throw new Error(`No message to send to existing session for card ${cardId}`)

        if (existing instanceof OpenCodeSession) {
          const card = await Card.findOneByOrFail({ id: cardId })
          existing.updateModel(card.model, card.thinkingLevel)
        }

        await existing.sendMessage(message)

        const card = await Card.findOneByOrFail({ id: cardId })
        card.promptsSent = existing.promptsSent
        card.updatedAt = new Date().toISOString()
        await card.save()
        return
      }

      // New session
      const card = await Card.findOneByOrFail({ id: cardId })
      if (!card.title?.trim()) throw new Error('Title is required for running')
      if (!card.description?.trim()) throw new Error('Description is required for running')

      // Move to running only if not already there
      if (card.column !== 'running') {
        card.column = 'running'
        card.updatedAt = new Date().toISOString()
        await card.save()
      }

      // Handle file attachments
      let prompt = message ?? card.description
      if (!message) {
        prompt = card.description
      }
      if (files?.length) {
        for (const f of files) {
          if (!resolve(f.path).startsWith('/tmp/orchestrel-uploads/')) {
            throw new Error(`Invalid file path: ${f.path}`)
          }
        }
        const fileList = files
          .map(f => `- ${f.path} (${f.name}, ${f.mimeType})`)
          .join('\n')
        prompt = `I've attached the following files for you to review. Use the Read tool to read them:\n${fileList}\n\n${prompt}`
      }

      console.log(`[session:${cardId}] startSession: calling ensureWorktree`)
      const cwd = await ensureWorktree(card)
      console.log(`[session:${cardId}] startSession: worktree ready at ${cwd}`)

      let providerID = 'anthropic'
      let projectName: string | undefined

      if (card.projectId) {
        const proj = await Project.findOneBy({ id: card.projectId })
        if (proj) {
          projectName = proj.name.toLowerCase()
          providerID = proj.providerID ?? 'anthropic'
        }
      }

      const isResume = !!card.sessionId
      console.log(`[session:${cardId}] startSession: creating session, provider=${providerID}, resume=${isResume}`)

      const session = sessionManager.create(cardId, {
        cwd,
        providerID,
        model: (card.model ?? 'sonnet') as 'sonnet' | 'opus' | 'auto',
        thinkingLevel: (card.thinkingLevel ?? 'high') as 'off' | 'low' | 'medium' | 'high',
        resumeSessionId: card.sessionId ?? undefined,
        projectName,
      })

      if (isResume) {
        session.promptsSent = card.promptsSent ?? 0
        session.turnsCompleted = card.turnsCompleted ?? 0
      }

      // Register one-time session-level listeners (server-owned, no WS reference)
      session.on('message', async (msg: AgentMessage) => {
        if (!DISPLAY_TYPES.has(msg.type)) return
        messageBus.publish(`card:${cardId}:message`, msg)

        if (msg.type === 'turn_end') {
          try {
            await card.reload()
            card.column = 'review'
            card.promptsSent = session.promptsSent
            card.turnsCompleted = session.turnsCompleted
            card.updatedAt = new Date().toISOString()
            await card.save()
            // Subscriber handles card:updated + card:status broadcasts
          } catch (err) {
            console.error(`[session:${cardId}] failed to persist turn_end:`, err)
          }
        }
      })

      session.on('exit', async () => {
        console.log(`[session:${cardId}] exit, status=${session.status}`)
        // Only move to review on error or stop — session.idle keeps session alive
        if (session.status === 'errored' || session.status === 'stopped') {
          try {
            await card.reload()
            card.column = 'review'
            card.promptsSent = session.promptsSent
            card.turnsCompleted = session.turnsCompleted
            card.updatedAt = new Date().toISOString()
            await card.save()
          } catch (err) {
            console.error(`[session:${cardId}] failed to auto-move to review on exit:`, err)
          }
        }
        // Publish exit status to bus so transport can forward agent:status
        messageBus.publish(`card:${cardId}:exit`, {
          cardId,
          active: false,
          status: session.status,
          sessionId: session.sessionId,
          promptsSent: session.promptsSent,
          turnsCompleted: session.turnsCompleted,
        })
      })

      console.log(`[session:${cardId}] startSession: calling session.start()`)
      await session.start(prompt)
      console.log(`[session:${cardId}] startSession: start() done, calling waitForReady()`)
      await session.waitForReady()
      console.log(`[session:${cardId}] startSession: session ready, sessionId=${session.sessionId}`)

      if (!isResume) {
        await card.reload()
        card.sessionId = session.sessionId
        card.promptsSent = 1
        card.turnsCompleted = 0
        card.updatedAt = new Date().toISOString()
        await card.save()
      }
    }

    async sendMessage(cardId: number, message: string): Promise<void> {
      return this.startSession(cardId, message)
    }

    async stopSession(cardId: number): Promise<void> {
      await sessionManager.kill(cardId)
      // exit listener on the session handles card update to review
    }

    getStatus(cardId: number): SessionStatusData | null {
      const session = sessionManager.get(cardId)
      if (!session) return null
      return {
        cardId,
        active: session.status === 'running',
        status: session.status,
        sessionId: session.sessionId,
        promptsSent: session.promptsSent,
        turnsCompleted: session.turnsCompleted,
      }
    }

    async getHistory(sessionId: string, cardId: number): Promise<AgentMessage[]> {
      const { openCodeServer } = await import('../opencode/server')
      if (!openCodeServer.client) return []

      interface SdkClient {
        session: {
          get(opts: { path: { id: string } }): Promise<unknown>
          messages(opts: { path: { id: string } }): Promise<unknown>
        }
      }
      const sdk = openCodeServer.client as unknown as SdkClient

      const session = await sdk.session.get({ path: { id: sessionId } })
      if (!session || (session as { success?: boolean }).success === false) return []

      const rawMessages = await sdk.session.messages({ path: { id: sessionId } })
      const rawMsgs = rawMessages as { success?: boolean; data?: unknown[] } | unknown[]
      const msgData = (rawMsgs as { success?: boolean }).success === false
        ? []
        : (rawMsgs as { data?: unknown[] }).data ?? (Array.isArray(rawMsgs) ? rawMsgs : [])
      const msgList = (Array.isArray(msgData) ? msgData : []) as Record<string, unknown>[]

      const normalized: AgentMessage[] = []
      for (const m of msgList) {
        normalized.push(...normalizeSessionMessage(m))
      }
      return normalized
    }
  }

  function normalizeSessionMessage(msg: Record<string, unknown>): AgentMessage[] {
    const results: AgentMessage[] = []
    const info = msg.info as { role?: string; time?: { created?: number } } | undefined
    const role = info?.role ?? (msg.role as string)
    const parts = (msg.parts ?? []) as Array<Record<string, unknown>>
    const infoTime = info?.time?.created
    const msgTime = typeof msg.time === 'object' && msg.time
      ? (msg.time as { created?: number }).created
      : undefined
    const ts = infoTime ?? msgTime ?? Date.now()

    for (const part of parts) {
      const partType = part.type as string

      if (partType === 'text') {
        results.push({
          type: role === 'user' ? 'user' : 'text',
          role: role === 'user' ? 'user' : 'assistant',
          content: (part.text as string) ?? '',
          timestamp: ts,
        })
      }

      if (partType === 'reasoning') {
        results.push({
          type: 'thinking',
          role: 'assistant',
          content: (part.text as string) ?? '',
          timestamp: ts,
        })
      }

      if (partType === 'tool') {
        const state = part.state as {
          status: string; input?: Record<string, unknown>
          output?: string; error?: string; title?: string
        } | undefined
        if (state) {
          results.push({
            type: 'tool_call',
            role: 'assistant',
            content: state.title ?? '',
            toolCall: {
              id: (part.callID as string) ?? (part.id as string),
              name: (part.tool as string) ?? 'unknown',
              params: state.input,
            },
            timestamp: ts,
          })
          if (state.status === 'completed') {
            results.push({
              type: 'tool_result',
              role: 'assistant',
              content: state.output ?? '',
              toolResult: {
                id: (part.callID as string) ?? (part.id as string),
                output: state.output ?? '',
                isError: false,
              },
              timestamp: ts,
            })
          }
          if (state.status === 'error') {
            results.push({
              type: 'tool_result',
              role: 'assistant',
              content: state.error ?? 'Tool error',
              toolResult: {
                id: (part.callID as string) ?? (part.id as string),
                output: state.error ?? 'Tool error',
                isError: true,
              },
              timestamp: ts,
            })
          }
        }
      }
    }
    return results
  }

  export const sessionService = new SessionService()
  ```

  **Note on `card:${cardId}:exit` topic:** The exit event is an additional bus topic not in the spec. It's needed so WS handlers can forward `agent:status` to the client when a session exits. The transport layer subscribes to this topic in addition to `card:${id}:status`.

- [ ] Create `src/server/services/session.test.ts`:
  ```typescript
  import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
  import { DataSource } from 'typeorm'
  import { Card, CardSubscriber } from '../models/Card'
  import { Project, ProjectSubscriber } from '../models/Project'
  import { messageBus } from '../bus'

  let ds: DataSource

  beforeAll(async () => {
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Card, Project],
      subscribers: [CardSubscriber, ProjectSubscriber],
      synchronize: true,
    })
    await ds.initialize()
  })

  afterAll(async () => {
    await ds.destroy()
  })

  describe('SessionService.getStatus', () => {
    it('returns null when no session is active', async () => {
      const { sessionService } = await import('./session')
      expect(sessionService.getStatus(99999)).toBeNull()
    })
  })

  describe('SessionService.startSession validation', () => {
    it('throws when card not found', async () => {
      const { sessionService } = await import('./session')
      await expect(sessionService.startSession(99999)).rejects.toThrow()
    })

    it('throws when title is empty', async () => {
      const { sessionService } = await import('./session')
      const card = Card.create({
        title: '',
        description: 'Some description',
        column: 'ready',
        position: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      await card.save()
      await expect(sessionService.startSession(card.id)).rejects.toThrow('Title is required')
    })

    it('throws when description is empty', async () => {
      const { sessionService } = await import('./session')
      const card = Card.create({
        title: 'Some title',
        description: '',
        column: 'ready',
        position: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      await card.save()
      await expect(sessionService.startSession(card.id)).rejects.toThrow('Description is required')
    })
  })
  ```

- [ ] Run tests:
  ```
  pnpm vitest run src/server/services/session.test.ts
  ```
  Expected: 3 tests pass. (Full session lifecycle tests require a live OpenCode server; unit tests cover validation paths only.)

- [ ] Commit:
  ```
  git add src/server/services/session.ts src/server/services/session.test.ts
  git commit -m "feat: add SessionService — owns session lifecycle, publishes to bus, no WS coupling"
  ```

---

## Task 9: ClientSubscriptions

Create the per-client bus subscription tracker. This ensures every handler registered on behalf of a WS client is cleaned up on disconnect.

### Steps

- [ ] Create `src/server/ws/subscriptions.ts`:
  ```typescript
  import type { WebSocket } from 'ws'
  import { messageBus } from '../bus'

  class ClientSubscriptions {
    private subs = new Map<WebSocket, Map<string, (payload: unknown) => void>>()

    subscribe(ws: WebSocket, topic: string, handler: (payload: unknown) => void): void {
      if (!this.subs.has(ws)) this.subs.set(ws, new Map())
      // Unsubscribe existing handler for this topic first (idempotent re-subscribe)
      const existing = this.subs.get(ws)!.get(topic)
      if (existing) messageBus.unsubscribe(topic, existing)
      this.subs.get(ws)!.set(topic, handler)
      messageBus.subscribe(topic, handler)
    }

    unsubscribe(ws: WebSocket, topic: string): void {
      const handler = this.subs.get(ws)?.get(topic)
      if (!handler) return
      messageBus.unsubscribe(topic, handler)
      this.subs.get(ws)!.delete(topic)
    }

    unsubscribeAll(ws: WebSocket): void {
      const topics = this.subs.get(ws)
      if (!topics) return
      for (const [topic, handler] of topics) {
        messageBus.unsubscribe(topic, handler)
      }
      this.subs.delete(ws)
    }
  }

  export const clientSubs = new ClientSubscriptions()
  ```

- [ ] Create `src/server/ws/subscriptions.test.ts`:
  ```typescript
  import { describe, it, expect, vi } from 'vitest'
  import { ClientSubscriptions } from './subscriptions'
  import { MessageBus } from '../bus'

  // Test against extracted class — export it from subscriptions.ts
  // Add `export { ClientSubscriptions }` to subscriptions.ts for testing

  describe('ClientSubscriptions', () => {
    it('subscribe registers handler and delivers events', () => {
      const bus = new MessageBus()
      const subs = new ClientSubscriptions(bus)
      const ws = {} as WebSocket
      const handler = vi.fn()
      subs.subscribe(ws, 'test:t', handler)
      bus.publish('test:t', 42)
      expect(handler).toHaveBeenCalledWith(42)
    })

    it('unsubscribeAll removes all handlers for a client', () => {
      const bus = new MessageBus()
      const subs = new ClientSubscriptions(bus)
      const ws = {} as WebSocket
      const h1 = vi.fn()
      const h2 = vi.fn()
      subs.subscribe(ws, 'test:a', h1)
      subs.subscribe(ws, 'test:b', h2)
      subs.unsubscribeAll(ws)
      bus.publish('test:a', {})
      bus.publish('test:b', {})
      expect(h1).not.toHaveBeenCalled()
      expect(h2).not.toHaveBeenCalled()
    })

    it('re-subscribing to same topic replaces old handler', () => {
      const bus = new MessageBus()
      const subs = new ClientSubscriptions(bus)
      const ws = {} as WebSocket
      const h1 = vi.fn()
      const h2 = vi.fn()
      subs.subscribe(ws, 'test:replace', h1)
      subs.subscribe(ws, 'test:replace', h2)
      bus.publish('test:replace', {})
      expect(h1).not.toHaveBeenCalled()
      expect(h2).toHaveBeenCalledOnce()
    })

    it('two clients are isolated — unsubscribeAll only removes one client', () => {
      const bus = new MessageBus()
      const subs = new ClientSubscriptions(bus)
      const ws1 = {} as WebSocket
      const ws2 = {} as WebSocket
      const h1 = vi.fn()
      const h2 = vi.fn()
      subs.subscribe(ws1, 'test:iso', h1)
      subs.subscribe(ws2, 'test:iso', h2)
      subs.unsubscribeAll(ws1)
      bus.publish('test:iso', {})
      expect(h1).not.toHaveBeenCalled()
      expect(h2).toHaveBeenCalledOnce()
    })
  })
  ```

  To make this testable, update `subscriptions.ts` to accept an optional bus parameter (for injection in tests) and export the class:

  Final `src/server/ws/subscriptions.ts`:
  ```typescript
  import type { WebSocket } from 'ws'
  import { messageBus, MessageBus } from '../bus'

  export class ClientSubscriptions {
    private subs = new Map<WebSocket, Map<string, (payload: unknown) => void>>()

    constructor(private bus: MessageBus = messageBus) {}

    subscribe(ws: WebSocket, topic: string, handler: (payload: unknown) => void): void {
      if (!this.subs.has(ws)) this.subs.set(ws, new Map())
      const existing = this.subs.get(ws)!.get(topic)
      if (existing) this.bus.unsubscribe(topic, existing)
      this.subs.get(ws)!.set(topic, handler)
      this.bus.subscribe(topic, handler)
    }

    unsubscribe(ws: WebSocket, topic: string): void {
      const handler = this.subs.get(ws)?.get(topic)
      if (!handler) return
      this.bus.unsubscribe(topic, handler)
      this.subs.get(ws)!.delete(topic)
    }

    unsubscribeAll(ws: WebSocket): void {
      const topics = this.subs.get(ws)
      if (!topics) return
      for (const [topic, handler] of topics) {
        this.bus.unsubscribe(topic, handler)
      }
      this.subs.delete(ws)
    }
  }

  export const clientSubs = new ClientSubscriptions()
  ```

- [ ] Run tests:
  ```
  pnpm vitest run src/server/ws/subscriptions.test.ts
  ```
  Expected: 4 tests pass.

- [ ] Commit:
  ```
  git add src/server/ws/subscriptions.ts src/server/ws/subscriptions.test.ts
  git commit -m "feat: add ClientSubscriptions — per-client bus topic tracking with cleanup"
  ```

---

## Task 10: Simplify ConnectionManager

Remove `broadcast()`, `subscribe()`, `subscribedColumns`, and `getSubscribedColumns()` from `connections.ts`. Keep only: `add`, `remove`, `send`, `size`.

### Steps

- [ ] Rewrite `src/server/ws/connections.ts`:
  ```typescript
  import type { WebSocket } from 'ws'
  import type { ServerMessage } from '../../shared/ws-protocol'

  export class ConnectionManager {
    private connections = new Set<WebSocket>()

    get size() {
      return this.connections.size
    }

    add(ws: WebSocket) {
      this.connections.add(ws)
    }

    remove(ws: WebSocket) {
      this.connections.delete(ws)
    }

    send(ws: WebSocket, msg: ServerMessage) {
      if (ws.readyState === 1) ws.send(JSON.stringify(msg))
    }
  }
  ```

  This is a breaking change — `broadcast()` is called in `server.ts` (for openCodeServer.onCrash) and in `mutator.ts`. Those callers will be updated in Tasks 11 and 12. The old `mutator.ts` still compiles at this point because it won't be imported until after those tasks.

  **Note:** At this point `mutator.ts` will have a TypeScript error because it calls `this.connMgr.broadcast(...)`. This is expected — `mutator.ts` is being deleted in Task 13. Do not fix it now; the typecheck step in Task 13 will validate clean compilation after deletion.

- [ ] Commit:
  ```
  git add src/server/ws/connections.ts
  git commit -m "refactor: simplify ConnectionManager — remove broadcast/subscribe, keep add/remove/send/size"
  ```

---

## Task 11: Rewrite WS Handlers

Rewrite all WS handler files to be thin wrappers around the services. Replace all direct DB access, `DbMutator` calls, and `beginSession()` calls with service method calls. Wire up bus subscriptions for real-time push to clients.

### Steps

- [ ] Rewrite `src/server/ws/handlers/cards.ts`:
  ```typescript
  import type { WebSocket } from 'ws'
  import type { ClientMessage } from '../../../shared/ws-protocol'
  import type { ConnectionManager } from '../connections'
  import { cardService } from '../../services/card'
  import type { Column } from '../../../shared/ws-protocol'

  export async function handleCardCreate(
    ws: WebSocket,
    msg: Extract<ClientMessage, { type: 'card:create' }>,
    connections: ConnectionManager,
  ): Promise<void> {
    const { requestId, data } = msg
    try {
      const card = await cardService.createCard(data)
      connections.send(ws, { type: 'mutation:ok', requestId, data: card })
    } catch (err) {
      connections.send(ws, { type: 'mutation:error', requestId, error: String(err instanceof Error ? err.message : err) })
    }
  }

  export async function handleCardUpdate(
    ws: WebSocket,
    msg: Extract<ClientMessage, { type: 'card:update' }>,
    connections: ConnectionManager,
  ): Promise<void> {
    const { requestId, data } = msg
    const { id, ...rest } = data
    try {
      const card = await cardService.updateCard(id, rest)
      connections.send(ws, { type: 'mutation:ok', requestId, data: card })
    } catch (err) {
      connections.send(ws, { type: 'mutation:error', requestId, error: String(err instanceof Error ? err.message : err) })
    }
  }

  export function handleCardDelete(
    ws: WebSocket,
    msg: Extract<ClientMessage, { type: 'card:delete' }>,
    connections: ConnectionManager,
  ): void {
    const { requestId, data } = msg
    cardService.deleteCard(data.id)
      .then(() => connections.send(ws, { type: 'mutation:ok', requestId }))
      .catch(err => connections.send(ws, { type: 'mutation:error', requestId, error: String(err instanceof Error ? err.message : err) }))
  }

  export async function handleCardGenerateTitle(
    ws: WebSocket,
    msg: Extract<ClientMessage, { type: 'card:generateTitle' }>,
    connections: ConnectionManager,
  ): Promise<void> {
    const { requestId, data } = msg
    try {
      const card = await cardService.generateTitle(data.id)
      connections.send(ws, { type: 'mutation:ok', requestId, data: card })
    } catch (err) {
      connections.send(ws, { type: 'mutation:error', requestId, error: String(err instanceof Error ? err.message : err) })
    }
  }

  export async function handleCardSuggestTitle(
    ws: WebSocket,
    msg: Extract<ClientMessage, { type: 'card:suggestTitle' }>,
    connections: ConnectionManager,
  ): Promise<void> {
    const { requestId, data } = msg
    try {
      const title = await cardService.suggestTitle(data.description)
      connections.send(ws, { type: 'mutation:ok', requestId, data: title })
    } catch (err) {
      connections.send(ws, { type: 'mutation:error', requestId, error: String(err instanceof Error ? err.message : err) })
    }
  }
  ```

- [ ] Rewrite `src/server/ws/handlers/projects.ts`:
  ```typescript
  import type { WebSocket } from 'ws'
  import type { ClientMessage } from '../../../shared/ws-protocol'
  import type { ConnectionManager } from '../connections'
  import { projectService } from '../../services/project'

  export async function handleProjectCreate(
    ws: WebSocket,
    msg: Extract<ClientMessage, { type: 'project:create' }>,
    connections: ConnectionManager,
  ): Promise<void> {
    const { requestId, data } = msg
    try {
      const project = await projectService.createProject(data)
      connections.send(ws, { type: 'mutation:ok', requestId, data: project })
    } catch (err) {
      connections.send(ws, { type: 'mutation:error', requestId, error: String(err instanceof Error ? err.message : err) })
    }
  }

  export async function handleProjectUpdate(
    ws: WebSocket,
    msg: Extract<ClientMessage, { type: 'project:update' }>,
    connections: ConnectionManager,
  ): Promise<void> {
    const { requestId, data } = msg
    const { id, ...rest } = data
    try {
      const project = await projectService.updateProject(id, rest)
      connections.send(ws, { type: 'mutation:ok', requestId, data: project })
    } catch (err) {
      connections.send(ws, { type: 'mutation:error', requestId, error: String(err instanceof Error ? err.message : err) })
    }
  }

  export function handleProjectDelete(
    ws: WebSocket,
    msg: Extract<ClientMessage, { type: 'project:delete' }>,
    connections: ConnectionManager,
  ): void {
    const { requestId, data } = msg
    projectService.deleteProject(data.id)
      .then(() => connections.send(ws, { type: 'mutation:ok', requestId }))
      .catch(err => connections.send(ws, { type: 'mutation:error', requestId, error: String(err instanceof Error ? err.message : err) }))
  }

  export async function handleProjectBrowse(
    ws: WebSocket,
    msg: Extract<ClientMessage, { type: 'project:browse' }>,
    connections: ConnectionManager,
  ): Promise<void> {
    const { requestId, data: { path } } = msg
    try {
      const dirs = await projectService.browse(path)
      connections.send(ws, { type: 'project:browse:result', requestId, data: dirs })
    } catch {
      connections.send(ws, { type: 'project:browse:result', requestId, data: [] })
    }
  }

  export async function handleProjectMkdir(
    ws: WebSocket,
    msg: Extract<ClientMessage, { type: 'project:mkdir' }>,
    connections: ConnectionManager,
  ): Promise<void> {
    const { requestId, data: { path } } = msg
    try {
      await projectService.mkdir(path)
      connections.send(ws, { type: 'mutation:ok', requestId, data: { success: true } })
    } catch (err) {
      connections.send(ws, { type: 'mutation:error', requestId, error: String(err instanceof Error ? err.message : err) })
    }
  }
  ```

- [ ] Rewrite `src/server/ws/handlers/agents.ts`:
  ```typescript
  import type { WebSocket } from 'ws'
  import type { ClientMessage } from '../../../shared/ws-protocol'
  import type { ConnectionManager } from '../connections'
  import { clientSubs } from '../subscriptions'
  import { sessionService } from '../../services/session'
  import { Card } from '../../models/Card'
  import type { SessionStatusData } from '../../services/session'
  import type { AgentMessage } from '../../../shared/ws-protocol'

  export async function handleAgentSend(
    ws: WebSocket,
    msg: Extract<ClientMessage, { type: 'agent:send' }>,
    connections: ConnectionManager,
  ): Promise<void> {
    const { requestId, data: { cardId, message, files } } = msg
    console.log(`[session:${cardId}] agent:send received, message length=${message.length}, files=${files?.length ?? 0}`)

    try {
      // Respond immediately — startSession runs in background
      connections.send(ws, { type: 'mutation:ok', requestId })

      sessionService.startSession(cardId, message, files).catch((err) => {
        const error = err instanceof Error ? err.message : String(err)
        console.error(`[session:${cardId}] startSession error:`, error)
        connections.send(ws, {
          type: 'agent:status',
          data: {
            cardId,
            active: false,
            status: 'errored',
            sessionId: null,
            promptsSent: 0,
            turnsCompleted: 0,
          },
        })
      })
    } catch (err) {
      connections.send(ws, { type: 'mutation:error', requestId, error: String(err instanceof Error ? err.message : err) })
    }
  }

  export async function handleAgentStop(
    ws: WebSocket,
    msg: Extract<ClientMessage, { type: 'agent:stop' }>,
    connections: ConnectionManager,
  ): Promise<void> {
    const { requestId, data: { cardId } } = msg
    console.log(`[session:${cardId}] agent:stop received`)
    try {
      await sessionService.stopSession(cardId)
      connections.send(ws, { type: 'mutation:ok', requestId })
    } catch (err) {
      connections.send(ws, { type: 'mutation:error', requestId, error: String(err instanceof Error ? err.message : err) })
    }
  }

  export async function handleAgentStatus(
    ws: WebSocket,
    msg: Extract<ClientMessage, { type: 'agent:status' }>,
    connections: ConnectionManager,
  ): Promise<void> {
    const { requestId, data: { cardId } } = msg
    try {
      const live = sessionService.getStatus(cardId)
      if (live) {
        connections.send(ws, { type: 'agent:status', data: live })
      } else {
        // No active session — read counters from DB via model
        const card = await Card.findOneBy({ id: cardId })
        connections.send(ws, {
          type: 'agent:status',
          data: {
            cardId,
            active: false,
            status: 'completed',
            sessionId: card?.sessionId ?? null,
            promptsSent: card?.promptsSent ?? 0,
            turnsCompleted: card?.turnsCompleted ?? 0,
          },
        })
      }
      connections.send(ws, { type: 'mutation:ok', requestId })
    } catch (err) {
      connections.send(ws, { type: 'mutation:error', requestId, error: String(err instanceof Error ? err.message : err) })
    }
  }
  ```

- [ ] Rewrite `src/server/ws/handlers/sessions.ts`:
  ```typescript
  import type { WebSocket } from 'ws'
  import type { ClientMessage } from '../../../shared/ws-protocol'
  import type { ConnectionManager } from '../connections'
  import { clientSubs } from '../subscriptions'
  import { sessionService } from '../../services/session'
  import type { AgentMessage } from '../../../shared/ws-protocol'

  export async function handleSessionLoad(
    ws: WebSocket,
    msg: Extract<ClientMessage, { type: 'session:load' }>,
    connections: ConnectionManager,
  ): Promise<void> {
    const { cardId, sessionId } = msg.data
    const { requestId } = msg

    try {
      const messages = await sessionService.getHistory(sessionId, cardId)
      connections.send(ws, { type: 'session:history', requestId, cardId, messages })
      connections.send(ws, { type: 'mutation:ok', requestId })

      // Subscribe to live agent messages for this card
      clientSubs.subscribe(ws, `card:${cardId}:message`, (payload) => {
        connections.send(ws, {
          type: 'agent:message',
          cardId,
          data: payload as AgentMessage,
        })
      })

      // Subscribe to card data updates (e.g., column changes)
      clientSubs.subscribe(ws, `card:${cardId}:updated`, (payload) => {
        connections.send(ws, { type: 'card:updated', data: payload as import('../../../shared/ws-protocol').Card })
      })

      // Subscribe to status updates (prompts/turns counters, sessionId)
      clientSubs.subscribe(ws, `card:${cardId}:status`, (payload) => {
        const card = payload as import('../../models/Card').Card
        connections.send(ws, {
          type: 'agent:status',
          data: {
            cardId,
            active: false,
            status: 'completed',
            sessionId: card.sessionId,
            promptsSent: card.promptsSent,
            turnsCompleted: card.turnsCompleted,
          },
        })
      })

      // Subscribe to session exit events
      clientSubs.subscribe(ws, `card:${cardId}:exit`, (payload) => {
        connections.send(ws, {
          type: 'agent:status',
          data: payload as import('../../../shared/ws-protocol').AgentStatus,
        })
      })
    } catch (err) {
      console.error(`[session:load] error loading session ${sessionId}:`, err)
      connections.send(ws, { type: 'mutation:error', requestId, error: `Failed to load session: ${err}` })
    }
  }
  ```

- [ ] Rewrite `src/server/ws/handlers.ts` — the main message router:
  ```typescript
  import type { WebSocket } from 'ws'
  import type { ConnectionManager } from './connections'
  import { clientSubs } from './subscriptions'
  import { clientMessage } from '../../shared/ws-protocol'
  import { cardService } from '../services/card'
  import { projectService } from '../services/project'
  import { messageBus } from '../bus'
  import {
    handleCardCreate,
    handleCardUpdate,
    handleCardDelete,
    handleCardGenerateTitle,
    handleCardSuggestTitle,
  } from './handlers/cards'
  import {
    handleProjectCreate,
    handleProjectUpdate,
    handleProjectDelete,
    handleProjectBrowse,
    handleProjectMkdir,
  } from './handlers/projects'
  import { handleSessionLoad } from './handlers/sessions'
  import {
    handleAgentSend,
    handleAgentStop,
    handleAgentStatus,
  } from './handlers/agents'
  import type { Card } from '../../shared/ws-protocol'
  import type { Card as CardEntity } from '../models/Card'
  import type { Project as ProjectEntity } from '../models/Project'

  export function handleMessage(
    ws: WebSocket,
    raw: unknown,
    connections: ConnectionManager,
  ) {
    const parsed = clientMessage.safeParse(raw)
    if (!parsed.success) {
      connections.send(ws, {
        type: 'mutation:error',
        requestId: (raw as Record<string, unknown>)?.requestId as string ?? 'unknown',
        error: `Invalid message: ${parsed.error.message}`,
      })
      return
    }

    const msg = parsed.data
    const rid = 'requestId' in msg ? (msg as { requestId?: string }).requestId : undefined
    if (rid) console.log(`[ws] → ${msg.type} requestId=${rid}`)

    switch (msg.type) {
      case 'subscribe': {
        const cols = msg.columns

        // Send initial sync
        Promise.all([
          cardService.listCards(cols.length > 0 ? cols : undefined),
          projectService.listProjects(),
        ]).then(([syncCards, syncProjects]) => {
          connections.send(ws, { type: 'sync', cards: syncCards as Card[], projects: syncProjects as Card[] })
        }).catch(err => console.error('[ws] subscribe sync error:', err))

        // Subscribe to board:changed — forward card:updated for cards in subscribed columns
        clientSubs.subscribe(ws, 'board:changed', (payload) => {
          const { card, oldColumn, newColumn } = payload as { card: CardEntity | null; oldColumn: string | null; newColumn: string | null; id?: number }
          if (!card) return
          const relevant = cols.length === 0 ||
            (oldColumn && cols.includes(oldColumn as never)) ||
            (newColumn && cols.includes(newColumn as never))
          if (relevant) {
            connections.send(ws, { type: 'card:updated', data: card as Card })
          }
        })

        // Subscribe to project updates
        const projectUpdateTopic = 'project:*:updated'
        // Projects don't have wildcards — subscribe dynamically as projects are created
        // Instead, use board:changed for cards and maintain a project subscription via the initial list
        // For projects: subscribe to all project:N:updated via a meta-topic
        // We use a single catch-all approach: messageBus re-emits project events as 'project:any'
        // Simpler: subscribe to all known project IDs after initial list, and resubscribe on project:created
        projectService.listProjects().then(projs => {
          for (const p of projs) {
            clientSubs.subscribe(ws, `project:${p.id}:updated`, (payload) => {
              connections.send(ws, { type: 'project:updated', data: payload as import('../../shared/ws-protocol').Project })
            })
            clientSubs.subscribe(ws, `project:${p.id}:deleted`, (payload) => {
              connections.send(ws, { type: 'project:deleted', data: payload as { id: number } })
            })
          }
        }).catch(err => console.error('[ws] subscribe project listing error:', err))

        break
      }

      case 'page': {
        const { column, cursor, limit } = msg
        cardService.pageCards(column, cursor, limit).then(result => {
          connections.send(ws, {
            type: 'page:result',
            column,
            cards: result.cards as Card[],
            nextCursor: result.nextCursor,
            total: result.total,
          })
        }).catch(err => console.error('[ws] page error:', err))
        break
      }

      case 'search': {
        const { query, requestId } = msg
        cardService.searchCards(query).then(({ cards, total }) => {
          connections.send(ws, { type: 'search:result', requestId, cards: cards as Card[], total })
        }).catch(err => console.error('[ws] search error:', err))
        break
      }

      case 'card:create':
        void handleCardCreate(ws, msg, connections)
        break

      case 'card:update':
        void handleCardUpdate(ws, msg, connections)
        break

      case 'card:delete':
        handleCardDelete(ws, msg, connections)
        break

      case 'card:generateTitle':
        void handleCardGenerateTitle(ws, msg, connections)
        break

      case 'card:suggestTitle':
        void handleCardSuggestTitle(ws, msg, connections)
        break

      case 'project:create':
        void handleProjectCreate(ws, msg, connections)
        break

      case 'project:update':
        void handleProjectUpdate(ws, msg, connections)
        break

      case 'project:delete':
        handleProjectDelete(ws, msg, connections)
        break

      case 'project:browse':
        void handleProjectBrowse(ws, msg, connections)
        break

      case 'project:mkdir':
        void handleProjectMkdir(ws, msg, connections)
        break

      case 'session:load':
        void handleSessionLoad(ws, msg, connections)
        break

      case 'agent:send':
        void handleAgentSend(ws, msg, connections)
        break

      case 'agent:stop':
        void handleAgentStop(ws, msg, connections)
        break

      case 'agent:status':
        void handleAgentStatus(ws, msg, connections)
        break

      default: {
        const exhausted = msg as { type: string; requestId?: string }
        connections.send(ws, {
          type: 'mutation:error',
          requestId: exhausted.requestId ?? 'unknown',
          error: `Handler not implemented: ${exhausted.type}`,
        })
      }
    }
  }
  ```

  **Note on project subscriptions:** The `subscribe` handler subscribes to per-project topics for all currently known projects. Newly created projects will be handled because `handleProjectCreate` creates the project via `projectService.createProject()` which triggers `ProjectSubscriber.afterInsert`, which publishes `project:N:updated`. The `subscribe` handler in `handlers.ts` should additionally subscribe to newly created project topics after each `project:create` response. For simplicity in this task, the project subscription is set up for known projects on connect. Future improvement: publish a `project:any:updated` meta-event and re-subscribe on new project creation within the handler.

- [ ] Run typecheck:
  ```
  pnpm typecheck
  ```
  Expected: errors only in files that still reference `DbMutator` or old handler signatures (i.e., `server.ts` still imports old things). Those are fixed in Task 12.

- [ ] Commit:
  ```
  git add src/server/ws/handlers.ts src/server/ws/handlers/cards.ts src/server/ws/handlers/projects.ts src/server/ws/handlers/agents.ts src/server/ws/handlers/sessions.ts
  git commit -m "refactor: rewrite WS handlers as thin service wrappers with bus subscriptions"
  ```

---

## Task 12: Rewrite WS Server

Update `server.ts` to initialize the TypeORM DataSource, remove `DbMutator`, use `clientSubs.unsubscribeAll` on disconnect, and use the bus for the OpenCode crash handler. Update the REST API.

### Steps

- [ ] Update `src/server/api/rest.ts` to use `cardService`:
  ```typescript
  import { Hono } from 'hono'
  import { zValidator } from '@hono/zod-validator'
  import { cardCreateSchema, cardUpdateSchema } from '../../shared/ws-protocol'
  import { cardService } from '../services/card'

  export function createRestApi() {
    const app = new Hono()

    app.post('/api/cards', zValidator('json', cardCreateSchema), async (c) => {
      const card = await cardService.createCard(c.req.valid('json'))
      return c.json(card, 201)
    })

    app.patch('/api/cards/:id', zValidator('json', cardUpdateSchema.omit({ id: true }).partial()), async (c) => {
      const id = Number(c.req.param('id'))
      const card = await cardService.updateCard(id, c.req.valid('json'))
      return c.json(card)
    })

    app.delete('/api/cards/:id', async (c) => {
      const id = Number(c.req.param('id'))
      await cardService.deleteCard(id)
      return c.json({ ok: true })
    })

    return app
  }
  ```

- [ ] Rewrite `src/server/ws/server.ts`:
  ```typescript
  import { WebSocketServer } from 'ws'
  import type { Server as HttpServer } from 'http'
  import type { Http2SecureServer } from 'http2'
  import type { Plugin } from 'vite'
  import { getRequestListener } from '@hono/node-server'
  import { ConnectionManager } from './connections'
  import { clientSubs } from './subscriptions'
  import { messageBus } from '../bus'
  import { initDatabase } from '../models/index'
  import { validateCfAccess } from './auth'
  import { handleMessage } from './handlers'
  import { createRestApi } from '../api/rest'
  import { openCodeServer } from '../opencode/server'

  export const connections = new ConnectionManager()

  export function createWsServer(httpServer: HttpServer | Http2SecureServer) {
    const wss = new WebSocketServer({ noServer: true })

    httpServer.on('upgrade', async (req, socket, head) => {
      if (req.url !== '/ws') return

      const valid = await validateCfAccess(req)
      if (!valid) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        socket.destroy()
        return
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req)
      })
    })

    wss.on('connection', (ws) => {
      connections.add(ws)

      ws.on('message', (raw) => {
        try {
          const data = JSON.parse(raw.toString())
          handleMessage(ws, data, connections)
        } catch (err) {
          console.error('WS message parse error:', err)
        }
      })

      ws.on('close', () => {
        clientSubs.unsubscribeAll(ws)
        connections.remove(ws)
      })
    })

    return wss
  }

  export function wsServerPlugin(): Plugin {
    return {
      name: 'orchestrel-ws',
      configureServer(server) {
        if (server.httpServer) {
          // Initialize TypeORM DataSource before accepting connections
          initDatabase().then(() => {
            createWsServer(server.httpServer!)
            console.log('[ws] WebSocket server attached to Vite dev server')
          }).catch((err) => {
            console.error('[db] failed to initialize database:', err)
          })

          // Publish OpenCode crash to bus — all connected clients get notified
          openCodeServer.onCrash = () => {
            messageBus.publish('system:error', {
              message: 'OpenCode server crashed, restarting...',
            })
          }

          openCodeServer.start().catch((err) => {
            console.error('[opencode] failed to start:', err)
          })
        }

        const restApp = createRestApi()
        const restHandler = getRequestListener(restApp.fetch)

        server.middlewares.use((req, res, next) => {
          if (req.url?.startsWith('/api/cards')) {
            restHandler(req, res)
          } else {
            next()
          }
        })
      },
    }
  }
  ```

  **Note on `system:error`:** The `subscribe` handler in `handlers.ts` should subscribe each new client to `system:error` and forward it as an `agent:message` with `cardId: -1`. Add this to the `subscribe` case in `handlers.ts`:

  In `handlers.ts`, add inside the `'subscribe'` case after the existing subscriptions:
  ```typescript
  // Subscribe to system errors — forward to all subscribed clients
  clientSubs.subscribe(ws, 'system:error', (payload) => {
    const { message } = payload as { message: string }
    connections.send(ws, {
      type: 'agent:message',
      cardId: -1,
      data: {
        type: 'error',
        role: 'system',
        content: message,
        timestamp: Date.now(),
      },
    })
  })
  ```

  Add this block to `handlers.ts` inside the `'subscribe'` case, after the project subscriptions block.

- [ ] Run typecheck:
  ```
  pnpm typecheck
  ```
  Expected: errors only from `db/mutator.ts` (which still references the removed `broadcast()` on `ConnectionManager`) and from `agents/begin-session.ts` (which still references `db/index.ts` etc). This is expected — those files are deleted in Task 13.

  If there are other errors, fix them now.

- [ ] Commit:
  ```
  git add src/server/ws/server.ts src/server/api/rest.ts src/server/ws/handlers.ts
  git commit -m "refactor: update WS server to use TypeORM DataSource, bus crash handler, clientSubs cleanup"
  ```

---

## Task 13: Delete Old Code

Remove Drizzle ORM, the old schema, the old DB init, the mutator, and `begin-session.ts`. Clean up `package.json`.

### Steps

- [ ] Delete the following files:
  ```
  rm src/server/db/schema.ts
  rm src/server/db/index.ts
  rm src/server/db/mutator.ts
  rm src/server/agents/begin-session.ts
  ```

- [ ] Remove Drizzle dependencies from `package.json`:
  - Remove from `dependencies`: `drizzle-orm`, `drizzle-zod`
  - Remove from `devDependencies`: `drizzle-kit`
  - Remove the `db:push` script

  Final relevant sections of `package.json` (show only changed sections):
  ```json
  "scripts": {
    "build": "react-router build",
    "dev": "cross-env NODE_ENV=development node server.js",
    "start": "node server.js",
    "typecheck": "react-router typegen && tsc -b",
    "lint": "eslint . --fix --max-warnings 0",
    "format": "prettier --write ."
  },
  ```
  And from `dependencies`, remove:
  - `"drizzle-orm": "^0.45.1"`
  - `"drizzle-zod": "^0.8.3"`

  And from `devDependencies`, remove:
  - `"drizzle-kit": "^0.31.9"`

- [ ] Run `pnpm install` to update the lockfile after removing dependencies:
  ```
  pnpm install
  ```

- [ ] Run typecheck — should be clean now:
  ```
  pnpm typecheck
  ```
  Expected: **zero errors**. All consumers of `db/schema.ts`, `db/index.ts`, `db/mutator.ts`, and `agents/begin-session.ts` have been rewritten in previous tasks.

  If there are remaining import errors (e.g., some file still imports from `db/schema.ts`), fix them now by updating the import to the appropriate model/service.

- [ ] Commit:
  ```
  git add -A
  git commit -m "chore: remove Drizzle ORM, db/schema.ts, db/mutator.ts, agents/begin-session.ts"
  ```

---

## Task 14: Verification

Confirm the app starts correctly, TypeScript compiles clean, and the full card lifecycle works end-to-end.

### Steps

- [ ] TypeScript compilation:
  ```
  pnpm typecheck
  ```
  Expected: zero errors.

- [ ] Run all tests:
  ```
  pnpm vitest run
  ```
  Expected: all test files pass:
  - `src/server/bus.test.ts` — 4 tests
  - `src/server/models/Card.test.ts` — 4 tests
  - `src/server/models/Project.test.ts` — 2 tests
  - `src/server/services/card.test.ts` — 5 tests
  - `src/server/services/project.test.ts` — 6 tests
  - `src/server/services/session.test.ts` — 3 tests
  - `src/server/ws/subscriptions.test.ts` — 4 tests

  Total: **28 tests pass**.

- [ ] Start the app:
  ```
  pnpm dev
  ```
  Expected: server starts at port 6194 without errors. Watch for:
  - `[db] TypeORM DataSource initialized` log line
  - `[ws] WebSocket server attached to Vite dev server` log line
  - No `[db]` errors or TypeORM schema mismatch warnings

- [ ] Manual smoke test (follow the plan in `~/.claude/projects/-home-ryan-Code-orchestrel/memory/reference_shortened_test_plan.md`):
  1. Open the board in the browser
  2. Create a card directly in `running` column — verify it starts a session automatically
  3. Observe agent messages stream in the card detail panel
  4. Wait for session to complete (turn_end) — card should auto-move to `review`
  5. Send a follow-up message from `review` — card moves back to `running`, session continues
  6. Click Stop — card moves to `review`
  7. Verify no duplicate events, no stuck cards

- [ ] Verify disconnect/reconnect cleanup:
  1. Open the board in one browser tab
  2. Close the tab
  3. Open a new tab — verify the board loads cleanly with no stale subscriptions

- [ ] Final commit:
  ```
  git add -A
  git commit -m "chore: verification pass — event-driven architecture complete"
  ```

---

## Summary of New Files

| File | Purpose |
|---|---|
| `src/server/bus.ts` | MessageBus singleton — typed pub/sub over EventEmitter |
| `src/server/models/Card.ts` | TypeORM Card entity + CardSubscriber |
| `src/server/models/Project.ts` | TypeORM Project entity + ProjectSubscriber + NEON_COLORS |
| `src/server/models/index.ts` | AppDataSource init — points at existing `data/orchestrel.db` |
| `src/server/services/card.ts` | CardService — card CRUD, search, pagination, title generation |
| `src/server/services/project.ts` | ProjectService — project CRUD, browse, mkdir |
| `src/server/services/session.ts` | SessionService — session lifecycle, bus publishing, no WS |
| `src/server/ws/subscriptions.ts` | ClientSubscriptions — per-client topic tracking with cleanup |

## Summary of Modified Files

| File | Change |
|---|---|
| `tsconfig.node.json` | Add `experimentalDecorators: true` |
| `src/shared/ws-protocol.ts` | Replace Drizzle-derived schemas with standalone Zod |
| `src/server/ws/connections.ts` | Remove broadcast/subscribe/subscribedColumns |
| `src/server/ws/handlers.ts` | Rewrite as thin switch, no DbMutator, bus subscriptions |
| `src/server/ws/handlers/cards.ts` | Thin CardService wrappers |
| `src/server/ws/handlers/projects.ts` | Thin ProjectService wrappers |
| `src/server/ws/handlers/agents.ts` | Thin SessionService wrappers |
| `src/server/ws/handlers/sessions.ts` | Thin SessionService.getHistory + bus subscriptions |
| `src/server/ws/server.ts` | initDatabase, clientSubs.unsubscribeAll, bus crash handler |
| `src/server/api/rest.ts` | Use cardService instead of DbMutator |
| `package.json` | Add typeorm, remove drizzle-orm/drizzle-zod/drizzle-kit |

## Summary of Deleted Files

| File | Replacement |
|---|---|
| `src/server/db/schema.ts` | `src/server/models/Card.ts` + `src/server/models/Project.ts` |
| `src/server/db/index.ts` | `src/server/models/index.ts` |
| `src/server/db/mutator.ts` | Services + entity subscribers |
| `src/server/agents/begin-session.ts` | `src/server/services/session.ts` |
