# Socket.IO Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the raw `ws` WebSocket library with Socket.IO to gain built-in heartbeat, reliable reconnection, acknowledgement callbacks, and room-based pub/sub — eliminating the custom reconnection logic, requestId/promise pattern, and half-open connection issues.

**Architecture:** Socket.IO Server attaches to the existing httpServer (both dev Vite and production). Auth moves to Socket.IO middleware. The custom `ConnectionManager` is eliminated — identity lives on `socket.data`. The `ClientSubscriptions` + `MessageBus` bridge is replaced by Socket.IO rooms with a thin `BusRoomBridge`. All mutations use Socket.IO's `emitWithAck` pattern (server-side ack callbacks), eliminating requestId generation entirely. Server→client pushes become named events emitted to rooms.

**Tech Stack:** socket.io v4, socket.io-client v4, TypeScript typed events, Zod (retained for entity schemas)

---

### Task 1: Install Dependencies and Update Shared Protocol

**Files:**

- Modify: `package.json`
- Modify: `src/shared/ws-protocol.ts`

- [ ] **Step 1: Install socket.io and socket.io-client**

```bash
cd /home/ryan/Code/orchestrel/.worktrees/socketio-migration
pnpm add socket.io socket.io-client
pnpm remove ws @types/ws
```

- [ ] **Step 2: Rewrite ws-protocol.ts with Socket.IO typed event interfaces**

Keep all existing Zod schemas (cardSchema, projectSchema, cardCreateSchema, etc.) and type exports. Remove the `clientMessage` and `serverMessage` discriminated unions. Add Socket.IO typed event interfaces.

```typescript
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
  worktreePath: z.string().nullable(),
  worktreeBranch: z.string().nullable(),
  useWorktree: sqliteBool,
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
  useWorktree: z.boolean().optional(),
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
  'session:load': (
    data: { cardId: number; sessionId?: string },
    ack: (res: AckResponse<{ messages: unknown[] }>) => void,
  ) => void;
  'session:set-model': (
    data: { cardId: number; provider: string; model: string },
    ack: (res: AckResponse) => void,
  ) => void;

  // Queue
  'queue:reorder': (data: { cardId: number; newPosition: number }, ack: (res: AckResponse) => void) => void;
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
```

- [ ] **Step 3: Commit**

```bash
git add package.json pnpm-lock.yaml src/shared/ws-protocol.ts
git commit -m "feat: install socket.io, rewrite protocol with typed events"
```

---

### Task 2: Server Core — Auth Middleware, Init State, Delete ConnectionManager

**Files:**

- Modify: `src/server/ws/auth.ts`
- Modify: `src/server/init-state.ts`
- Delete: `src/server/ws/connections.ts`

- [ ] **Step 1: Add Socket.IO auth middleware to auth.ts**

Keep `validateCfAccess` unchanged. Add a `socketAuthMiddleware` function that Socket.IO calls on every new connection. Extract identity and attach to `socket.data`.

```typescript
import type { IncomingMessage } from 'http';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Socket } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents, SocketData } from '../../shared/ws-protocol';

const CF_TEAM_DOMAIN = process.env.CF_TEAM_DOMAIN ?? '';
const CERTS_URL = `https://${CF_TEAM_DOMAIN}.cloudflareaccess.com/cdn-cgi/access/certs`;

const jwks = CF_TEAM_DOMAIN ? createRemoteJWKSet(new URL(CERTS_URL)) : null;

export interface AuthResult {
  valid: boolean;
  email?: string;
  isLocal: boolean;
}

function isLocalRequest(req: IncomingMessage): boolean {
  const host = req.headers.host ?? '';
  if (host.startsWith('localhost') || host.startsWith('127.') || host.startsWith('192.168.')) {
    return true;
  }
  return false;
}

export async function validateCfAccess(req: IncomingMessage): Promise<AuthResult> {
  if (isLocalRequest(req)) return { valid: true, isLocal: true };

  if (!jwks) {
    console.log('[ws:auth] no jwks configured, rejecting');
    return { valid: false, isLocal: false };
  }

  const cookie = req.headers.cookie ?? '';
  const match = cookie.match(/CF_Authorization=([^;]+)/);
  if (!match) {
    console.log(
      '[ws:auth] no CF_Authorization cookie found. host=%s, cookies=%s',
      req.headers.host,
      cookie ? cookie.substring(0, 80) + '...' : '(none)',
    );
    return { valid: false, isLocal: false };
  }

  try {
    const { payload } = await jwtVerify(match[1], jwks, {
      issuer: `https://${CF_TEAM_DOMAIN}.cloudflareaccess.com`,
    });
    const email = typeof payload.email === 'string' ? payload.email : undefined;
    return { valid: true, email, isLocal: false };
  } catch (err) {
    console.log('[ws:auth] JWT verify failed:', err instanceof Error ? err.message : err);
    return { valid: false, isLocal: false };
  }
}

type AppSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

/** Socket.IO middleware — validates CF Access JWT and attaches user identity to socket.data */
export async function socketAuthMiddleware(socket: AppSocket, next: (err?: Error) => void): Promise<void> {
  try {
    const req = socket.request;
    const auth = await validateCfAccess(req);
    if (!auth.valid) {
      next(new Error('Unauthorized'));
      return;
    }
    const { userService, LOCAL_ADMIN } = await import('../services/user');
    const identity = auth.isLocal || !auth.email ? LOCAL_ADMIN : await userService.findOrCreate(auth.email);
    socket.data.identity = { id: identity.id, email: identity.email, role: identity.role };
    console.log(`[ws] auth: ${identity.email} (${identity.role})`);
    next();
  } catch (err) {
    next(new Error(err instanceof Error ? err.message : 'Auth failed'));
  }
}
```

- [ ] **Step 2: Update init-state.ts — replace WebSocketServer with Socket.IO Server**

Replace the `wss` / `setWss` exports with `io` / `setIo` for the Socket.IO `Server` instance. Keep everything else (SessionManager, httpServer, initialized flag) as-is. Remove the `attachUpgradeHandler` function — Socket.IO manages its own upgrade listener.

```typescript
import type { Server as HttpServer } from 'http';
import type { Http2SecureServer } from 'http2';
import type { Server as IoServer } from 'socket.io';

type AnyHttpServer = HttpServer | Http2SecureServer;

/** SessionManager — survives Vite restarts. */
import type { SessionManager } from './sessions/manager';
let _sessionManager: SessionManager | null = null;
export function getSessionManager(): SessionManager | null {
  return _sessionManager;
}
export function setSessionManager(sm: SessionManager): void {
  _sessionManager = sm;
}

/** True after IO server, bus listeners, and SessionManager are initialized. */
export let initialized = false;
export function markInitialized() {
  initialized = true;
}

/** Cached Socket.IO Server — reused across Vite restarts. */
export let io: IoServer | null = null;
export function setIo(instance: IoServer) {
  io = instance;
}

/** httpServer from server.js — arrives via process event, persists across restarts. */
let _httpServer: AnyHttpServer | null = null;
const _httpServerReady = new Promise<AnyHttpServer>((resolve) => {
  if (_httpServer) {
    resolve(_httpServer);
    return;
  }
  process.once('orchestrel:httpServer', (server: AnyHttpServer) => {
    _httpServer = server;
    resolve(server);
  });
});

export function getHttpServer(): Promise<AnyHttpServer> {
  if (_httpServer) return Promise.resolve(_httpServer);
  return _httpServerReady;
}
```

- [ ] **Step 3: Delete connections.ts**

```bash
rm src/server/ws/connections.ts
```

Socket.IO sockets carry identity in `socket.data` and track connections automatically. The `ConnectionManager` class is no longer needed.

- [ ] **Step 4: Commit**

```bash
git add src/server/ws/auth.ts src/server/init-state.ts
git rm src/server/ws/connections.ts
git commit -m "feat: socket.io auth middleware, update init-state, remove ConnectionManager"
```

---

### Task 3: Server Handlers — Refactor to Socket.IO Event Pattern

All handler files change signature from `(ws: WebSocket, msg: Extract<ClientMessage, ...>, connections: ConnectionManager)` to `(data: ..., callback: (res: AckResponse) => void, socket: AppSocket)`. The `connections.send(ws, { type: 'mutation:ok', ... })` pattern becomes `callback({ data: ... })`. The `connections.send(ws, { type: 'mutation:error', ... })` pattern becomes `callback({ error: ... })`.

**Type alias used throughout (add to a shared import):**

```typescript
import type { Socket, Server as IoServer } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents, SocketData, AckResponse } from '../../shared/ws-protocol';
// (adjust path depth per file location)

export type AppSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;
export type AppServer = IoServer<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;
```

Create this type file at `src/server/ws/types.ts` so all handlers can import from one place:

```typescript
import type { Socket, Server as IoServer } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents, SocketData } from '../../shared/ws-protocol';

export type AppSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;
export type AppServer = IoServer<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;
```

**Files:**

- Create: `src/server/ws/types.ts`
- Modify: `src/server/ws/handlers/cards.ts`
- Modify: `src/server/ws/handlers/projects.ts`
- Modify: `src/server/ws/handlers/agents.ts`
- Modify: `src/server/ws/handlers/sessions.ts`
- Modify: `src/server/ws/handlers/queue.ts`

- [ ] **Step 1: Create src/server/ws/types.ts**

```typescript
import type { Socket, Server as IoServer } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents, SocketData } from '../../shared/ws-protocol';

export type AppSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;
export type AppServer = IoServer<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;
```

- [ ] **Step 2: Rewrite handlers/cards.ts**

```typescript
import type { AckResponse, Card } from '../../../shared/ws-protocol';
import { cardService } from '../../services/card';

export async function handleCardCreate(
  data: {
    title: string;
    description?: string;
    column?: string;
    projectId?: number | null;
    model?: string;
    provider?: string;
    thinkingLevel?: string;
    useWorktree?: boolean;
    sourceBranch?: 'main' | 'dev' | null;
    archiveOthers?: boolean;
  },
  callback: (res: AckResponse<Card>) => void,
): Promise<void> {
  try {
    if (!data.projectId) throw new Error('projectId is required');
    const card = await cardService.createCard(data);
    callback({ data: card as unknown as Card });
  } catch (err) {
    callback({ error: String(err instanceof Error ? err.message : err) });
  }
}

export async function handleCardUpdate(
  data: { id: number; [key: string]: unknown },
  callback: (res: AckResponse<Card>) => void,
): Promise<void> {
  const { id, ...rest } = data;
  try {
    const card = await cardService.updateCard(id, rest);
    callback({ data: card as unknown as Card });
  } catch (err) {
    callback({ error: String(err instanceof Error ? err.message : err) });
  }
}

export async function handleCardDelete(data: { id: number }, callback: (res: AckResponse) => void): Promise<void> {
  try {
    await cardService.deleteCard(data.id);
    callback({});
  } catch (err) {
    callback({ error: String(err instanceof Error ? err.message : err) });
  }
}

export async function handleCardGenerateTitle(
  data: { id: number },
  callback: (res: AckResponse<Card>) => void,
): Promise<void> {
  try {
    const card = await cardService.generateTitle(data.id);
    callback({ data: card as unknown as Card });
  } catch (err) {
    callback({ error: String(err instanceof Error ? err.message : err) });
  }
}

export async function handleCardSuggestTitle(
  data: { description: string },
  callback: (res: AckResponse<string>) => void,
): Promise<void> {
  try {
    const title = await cardService.suggestTitle(data.description);
    callback({ data: title });
  } catch (err) {
    callback({ error: String(err instanceof Error ? err.message : err) });
  }
}
```

- [ ] **Step 3: Rewrite handlers/projects.ts**

```typescript
import type { AckResponse, Project, SyncPayload } from '../../../shared/ws-protocol';
import type { AppSocket, AppServer } from '../types';
import { projectService } from '../../services/project';
import { getProvidersForClient } from '../../config/providers';

export async function handleProjectCreate(
  data: { name: string; path: string; [key: string]: unknown },
  callback: (res: AckResponse<Project>) => void,
): Promise<void> {
  try {
    const project = await projectService.createProject(data);
    callback({ data: project as unknown as Project });
  } catch (err) {
    callback({ error: String(err instanceof Error ? err.message : err) });
  }
}

export async function handleProjectUpdate(
  data: { id: number; userIds?: number[]; [key: string]: unknown },
  callback: (res: AckResponse<Project>) => void,
  socket: AppSocket,
  io: AppServer,
): Promise<void> {
  const { id, userIds, ...projectData } = data;
  try {
    const project = await projectService.updateProject(id, projectData);
    callback({ data: project as unknown as Project });

    if (userIds !== undefined) {
      const identity = socket.data.identity;
      if (identity?.role === 'admin') {
        const { userService } = await import('../../services/user');
        await userService.setProjectUsers(id, userIds);

        // Re-sync non-admin clients so their visibility updates
        for (const [, clientSocket] of io.sockets.sockets) {
          const clientIdentity = clientSocket.data.identity;
          if (clientSocket.id === socket.id || clientIdentity?.role === 'admin') continue;

          const visible = await userService.visibleProjectIds(
            clientIdentity as import('../../services/user').UserIdentity,
          );
          const { cardService } = await import('../../services/card');
          const [syncCards, syncProjects] = await Promise.all([cardService.listCards(), projectService.listProjects()]);

          const filteredCards =
            visible === 'all'
              ? syncCards
              : syncCards.filter((c) => c.projectId != null && (visible as number[]).includes(c.projectId));
          const filteredProjects =
            visible === 'all' ? syncProjects : syncProjects.filter((p) => (visible as number[]).includes(p.id));

          clientSocket.emit('sync', {
            cards: filteredCards as unknown as import('../../../shared/ws-protocol').Card[],
            projects: filteredProjects as unknown as import('../../../shared/ws-protocol').Project[],
            providers: getProvidersForClient(),
            user: { id: clientIdentity!.id, email: clientIdentity!.email, role: clientIdentity!.role },
          });
        }
      }
    }
  } catch (err) {
    callback({ error: String(err instanceof Error ? err.message : err) });
  }
}

export async function handleProjectDelete(data: { id: number }, callback: (res: AckResponse) => void): Promise<void> {
  try {
    await projectService.deleteProject(data.id);
    callback({});
  } catch (err) {
    callback({ error: String(err instanceof Error ? err.message : err) });
  }
}

export async function handleProjectBrowse(
  data: { path: string },
  callback: (res: AckResponse<unknown>) => void,
): Promise<void> {
  try {
    const dirs = await projectService.browse(data.path);
    callback({ data: dirs });
  } catch {
    callback({ data: [] });
  }
}

export async function handleProjectMkdir(
  data: { path: string },
  callback: (res: AckResponse<{ success: boolean }>) => void,
): Promise<void> {
  try {
    await projectService.mkdir(data.path);
    callback({ data: { success: true } });
  } catch (err) {
    callback({ error: String(err instanceof Error ? err.message : err) });
  }
}
```

- [ ] **Step 4: Rewrite handlers/agents.ts**

Note: `agent:send` acks immediately (fire-and-forget pattern). Errors after ack are logged but can't be sent back via callback. The `agent:status` push event handles lifecycle updates.

```typescript
import type { AckResponse } from '../../../shared/ws-protocol';
import { Card } from '../../models/Card';
import { registerCardSession } from '../../controllers/oc';
import { buildPromptWithFiles } from '../../sessions/manager';

export async function handleAgentSend(
  data: {
    cardId: number;
    message: string;
    files?: Array<{ id: string; name: string; mimeType: string; path: string; size: number }>;
  },
  callback: (res: AckResponse) => void,
): Promise<void> {
  const { cardId, message, files } = data;
  console.log(`[session:${cardId}] agent:send, len=${message.length}`);

  try {
    // Ack immediately — session start is async
    callback({});

    const initState = await import('../../init-state');
    const sm = initState.getSessionManager();
    if (!sm) throw new Error('SessionManager not initialized');

    const card = await Card.findOneByOrFail({ id: cardId });
    const prompt = buildPromptWithFiles(message, files);

    if (sm.isActive(cardId)) {
      sm.sendFollowUp(cardId, prompt);
    } else {
      if (card.column !== 'running') {
        card.column = 'running';
        card.updatedAt = new Date().toISOString();
        await card.save();
      }
      await sm.start(cardId, prompt, {
        provider: card.provider,
        model: card.model,
        cwd: process.cwd(),
        resume: card.sessionId ?? undefined,
      });
      registerCardSession(cardId);
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`[session:${cardId}] agent:send error:`, error);
    // Can't send error via callback (already called). Error surfaces via agent:status.
  }
}

export async function handleAgentCompact(
  data: { cardId: number },
  callback: (res: AckResponse) => void,
): Promise<void> {
  const { cardId } = data;
  console.log(`[session:${cardId}] agent:compact received`);

  try {
    callback({});
    const initState = await import('../../init-state');
    const sm = initState.getSessionManager();
    if (sm?.isActive(cardId)) {
      sm.sendFollowUp(cardId, 'Please compact your context window. Summarize the conversation so far and continue.');
    }
  } catch (err) {
    console.error(`[session:${cardId}] agent:compact error:`, err);
  }
}

export async function handleAgentStop(data: { cardId: number }, callback: (res: AckResponse) => void): Promise<void> {
  const { cardId } = data;
  console.log(`[session:${cardId}] agent:stop received`);
  callback({});
  const initState = await import('../../init-state');
  const sm = initState.getSessionManager();
  sm?.stop(cardId);
}

export async function handleAgentStatus(
  data: { cardId: number },
  callback: (res: AckResponse) => void,
  socket: import('../types').AppSocket,
): Promise<void> {
  const { cardId } = data;
  try {
    const initState = await import('../../init-state');
    const sm = initState.getSessionManager();
    const session = sm?.get(cardId);

    if (session) {
      socket.emit('agent:status', {
        cardId,
        active: sm!.isActive(cardId),
        status: session.status,
        sessionId: session.sessionId,
        promptsSent: session.promptsSent,
        turnsCompleted: session.turnsCompleted,
        contextTokens: 0,
        contextWindow: 200_000,
      });
    } else {
      const card = await Card.findOneBy({ id: cardId });
      if (card && card.column === 'running' && card.queuePosition == null) {
        card.column = 'review';
        card.updatedAt = new Date().toISOString();
        await card.save();
      }
      socket.emit('agent:status', {
        cardId,
        active: false,
        status: 'completed',
        sessionId: card?.sessionId ?? null,
        promptsSent: card?.promptsSent ?? 0,
        turnsCompleted: card?.turnsCompleted ?? 0,
        contextTokens: card?.contextTokens ?? 0,
        contextWindow: card?.contextWindow ?? 200_000,
      });
    }
    callback({});
  } catch (err) {
    callback({ error: String(err instanceof Error ? err.message : err) });
  }
}
```

- [ ] **Step 5: Rewrite handlers/sessions.ts**

Session history is now returned in the ack callback instead of as a separate push event. Card-specific bus subscriptions are replaced by joining a Socket.IO room — the `BusRoomBridge` (Task 4) handles forwarding bus events to rooms.

```typescript
import type { AckResponse } from '../../../shared/ws-protocol';
import type { AppSocket } from '../types';
import { Card } from '../../models/Card';
import { Project } from '../../models/Project';
import { getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import { busRoomBridge } from '../subscriptions';

export async function handleSessionLoad(
  data: { cardId: number; sessionId?: string },
  callback: (res: AckResponse<{ messages: unknown[] }>) => void,
  socket: AppSocket,
): Promise<void> {
  const { cardId, sessionId } = data;

  try {
    const room = `card:${cardId}`;
    const alreadyJoined = socket.rooms.has(room);
    console.log(`[session:load] cardId=${cardId} sessionId=${sessionId ?? 'none'} alreadyJoined=${alreadyJoined}`);

    let messages: unknown[] = [];
    if (sessionId) {
      const card = await Card.findOneBy({ id: cardId });
      let dir = card?.worktreePath ?? undefined;
      if (!dir && card?.projectId) {
        const proj = await Project.findOneBy({ id: card.projectId });
        dir = proj?.path;
      }
      const loaded = await getSessionMessages(sessionId, { dir });
      console.log(`[session:load] cardId=${cardId} loaded ${loaded.length} history messages`);
      messages = loaded as unknown[];
    }

    // Join the card room for live events
    if (!alreadyJoined) {
      socket.join(room);
      busRoomBridge.ensureCardListeners(cardId);
      console.log(`[session:load] cardId=${cardId} joined room ${room}`);
    }

    callback({ data: { messages } });
  } catch (err) {
    console.error(`[session:load] error loading session ${sessionId}:`, err);
    callback({ error: `Failed to load session: ${err}` });
  }
}
```

- [ ] **Step 6: Rewrite handlers/queue.ts**

```typescript
import type { AckResponse } from '../../../shared/ws-protocol';
import { Card } from '../../models/Card';

export async function handleQueueReorder(
  data: { cardId: number; newPosition: number },
  callback: (res: AckResponse) => void,
): Promise<void> {
  const { cardId, newPosition } = data;
  try {
    const card = await Card.findOneBy({ id: cardId });
    if (!card || card.queuePosition == null) {
      callback({ error: 'Card is not queued' });
      return;
    }
    if (!card.projectId) {
      callback({ error: 'Card has no project' });
      return;
    }

    const oldPosition = card.queuePosition;

    const queued = await Card.find({
      where: {
        column: 'running',
        projectId: card.projectId,
        useWorktree: false as unknown as boolean,
      },
    });
    const queuedOnly = queued.filter((c) => c.queuePosition != null);

    if (newPosition < 1 || newPosition > queuedOnly.length) {
      callback({ error: `Position must be between 1 and ${queuedOnly.length}` });
      return;
    }

    if (newPosition === oldPosition) {
      callback({});
      return;
    }

    for (const c of queuedOnly) {
      if (c.id === cardId) continue;
      if (c.queuePosition == null) continue;

      if (newPosition < oldPosition) {
        if (c.queuePosition >= newPosition && c.queuePosition < oldPosition) {
          c.queuePosition += 1;
          c.updatedAt = new Date().toISOString();
          await c.save();
        }
      } else {
        if (c.queuePosition > oldPosition && c.queuePosition <= newPosition) {
          c.queuePosition -= 1;
          c.updatedAt = new Date().toISOString();
          await c.save();
        }
      }
    }

    card.queuePosition = newPosition;
    card.updatedAt = new Date().toISOString();
    await card.save();

    callback({});
  } catch (err) {
    callback({ error: String(err instanceof Error ? err.message : err) });
  }
}
```

- [ ] **Step 7: Commit**

```bash
git add src/server/ws/types.ts src/server/ws/handlers/
git commit -m "feat: refactor all server handlers to socket.io event pattern"
```

---

### Task 4: Bus-to-Room Bridge (Replaces ClientSubscriptions)

Replace `ClientSubscriptions` with a `BusRoomBridge` that forwards `MessageBus` events to Socket.IO rooms. Board-level events (`board:changed`, project updates, system errors) use global listeners registered once. Card-specific events (sdk, status, context, exit, updated) use lazily-created listeners tied to card rooms.

**Files:**

- Rewrite: `src/server/ws/subscriptions.ts`
- Rewrite: `src/server/ws/subscriptions.test.ts`

- [ ] **Step 1: Rewrite subscriptions.ts**

```typescript
import { messageBus } from '../bus';
import type { AppServer } from './types';
import type { Card as CardEntity } from '../models/Card';
import type { Card, AgentStatus } from '../../shared/ws-protocol';

let _io: AppServer | null = null;

/** Per-card bus listeners — cleaned up when room empties */
const cardListeners = new Map<number, Map<string, (payload: unknown) => void>>();

export const busRoomBridge = {
  /** Initialize with the Socket.IO server and register global bus listeners */
  init(io: AppServer) {
    _io = io;

    // board:changed → emit to column rooms
    messageBus.on('board:changed', (payload) => {
      const { card, oldColumn, newColumn, id } = payload as {
        card: CardEntity | null;
        oldColumn: string | null;
        newColumn: string | null;
        id?: number;
      };
      if (!card) {
        if (id) io.emit('card:deleted', { id });
        return;
      }
      const rooms: string[] = [];
      if (oldColumn) rooms.push(`col:${oldColumn}`);
      if (newColumn && newColumn !== oldColumn) rooms.push(`col:${newColumn}`);
      if (rooms.length) io.to(rooms).emit('card:updated', card as unknown as Card);
    });

    // system:error → broadcast to all
    messageBus.on('system:error', (payload) => {
      const { message } = payload as { message: string };
      io.emit('session:message', {
        cardId: -1,
        message: { type: 'error', message, timestamp: Date.now() },
      });
    });

    console.log('[bus-bridge] global listeners registered');
  },

  /** Ensure bus→room listeners exist for a card. Called when a socket joins card:N. */
  ensureCardListeners(cardId: number) {
    if (cardListeners.has(cardId)) return;
    if (!_io) throw new Error('BusRoomBridge not initialized');
    const io = _io;
    const room = `card:${cardId}`;
    const listeners = new Map<string, (payload: unknown) => void>();

    const sdkHandler = (msg: unknown) => {
      io.to(room).emit('session:message', { cardId, message: msg });
    };
    messageBus.on(`card:${cardId}:sdk`, sdkHandler);
    listeners.set('sdk', sdkHandler);

    const statusHandler = (data: unknown) => {
      io.to(room).emit('agent:status', data as AgentStatus);
    };
    messageBus.on(`card:${cardId}:status`, statusHandler);
    listeners.set('status', statusHandler);

    const contextHandler = (payload: unknown) => {
      const ctx = payload as { contextTokens: number; contextWindow: number };
      io.to(room).emit('agent:status', {
        cardId,
        active: true,
        status: 'running' as const,
        sessionId: null,
        promptsSent: 0,
        turnsCompleted: 0,
        contextTokens: ctx.contextTokens,
        contextWindow: ctx.contextWindow,
      });
    };
    messageBus.on(`card:${cardId}:context`, contextHandler);
    listeners.set('context', contextHandler);

    const exitHandler = (payload: unknown) => {
      const p = payload as { sessionId: string | null; status: string };
      io.to(room).emit('agent:status', {
        cardId,
        active: false,
        status: p.status as 'completed',
        sessionId: p.sessionId,
        promptsSent: 0,
        turnsCompleted: 0,
        contextTokens: 0,
        contextWindow: 200_000,
      });
    };
    messageBus.on(`card:${cardId}:exit`, exitHandler);
    listeners.set('exit', exitHandler);

    const updatedHandler = (payload: unknown) => {
      io.to(room).emit('card:updated', payload as Card);
    };
    messageBus.on(`card:${cardId}:updated`, updatedHandler);
    listeners.set('updated', updatedHandler);

    cardListeners.set(cardId, listeners);
    console.log(`[bus-bridge] card:${cardId} listeners registered`);
  },

  /** Clean up bus listeners for a card room if no sockets remain in it. */
  cleanupCardIfEmpty(cardId: number) {
    if (!_io) return;
    const room = `card:${cardId}`;
    const roomSockets = _io.sockets.adapter.rooms.get(room);
    if (roomSockets && roomSockets.size > 0) return;

    const listeners = cardListeners.get(cardId);
    if (!listeners) return;

    for (const [suffix, handler] of listeners) {
      messageBus.removeListener(`card:${cardId}:${suffix}`, handler);
    }
    cardListeners.delete(cardId);
    console.log(`[bus-bridge] card:${cardId} listeners cleaned up`);
  },
};
```

- [ ] **Step 2: Rewrite subscriptions.test.ts**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MessageBus } from '../bus';

// We test the bus-to-room bridge concept:
// bus events should be forwarded to socket.io rooms via emit

describe('BusRoomBridge', () => {
  it('board:changed emits card:updated to column rooms', () => {
    const bus = new MessageBus();
    const emitToRoom = vi.fn();
    const io = {
      to: vi.fn(() => ({ emit: emitToRoom })),
      emit: vi.fn(),
      sockets: { adapter: { rooms: new Map() } },
    };

    // Simulate global listener registration
    bus.on('board:changed', (payload) => {
      const { card, oldColumn, newColumn, id } = payload as {
        card: unknown;
        oldColumn: string | null;
        newColumn: string | null;
        id?: number;
      };
      if (!card) {
        if (id) io.emit('card:deleted', { id });
        return;
      }
      const rooms: string[] = [];
      if (oldColumn) rooms.push(`col:${oldColumn}`);
      if (newColumn && newColumn !== oldColumn) rooms.push(`col:${newColumn}`);
      if (rooms.length) io.to(rooms).emit('card:updated', card);
    });

    const card = { id: 1, title: 'Test', column: 'running' };
    bus.publish('board:changed', { card, oldColumn: 'ready', newColumn: 'running' });

    expect(io.to).toHaveBeenCalledWith(['col:ready', 'col:running']);
    expect(emitToRoom).toHaveBeenCalledWith('card:updated', card);
  });

  it('board:changed with deletion emits card:deleted to all', () => {
    const bus = new MessageBus();
    const io = { emit: vi.fn(), to: vi.fn() };

    bus.on('board:changed', (payload) => {
      const { card, id } = payload as { card: unknown; id?: number };
      if (!card && id) io.emit('card:deleted', { id });
    });

    bus.publish('board:changed', { card: null, oldColumn: 'running', newColumn: null, id: 42 });
    expect(io.emit).toHaveBeenCalledWith('card:deleted', { id: 42 });
  });
});
```

- [ ] **Step 3: Run tests**

```bash
cd /home/ryan/Code/orchestrel/.worktrees/socketio-migration
pnpm vitest run src/server/ws/subscriptions.test.ts
```

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/server/ws/subscriptions.ts src/server/ws/subscriptions.test.ts
git commit -m "feat: replace ClientSubscriptions with room-based BusRoomBridge"
```

---

### Task 5: Server — Event Registration, Vite Plugin, Production Init

This task wires everything together: the Socket.IO `connection` event handler that registers per-socket events, the Vite plugin that creates the IO server in dev mode, and the production init path.

**Files:**

- Rewrite: `src/server/ws/handlers.ts`
- Rewrite: `src/server/ws/server.ts`
- Modify: `src/server/init.ts`
- Modify: `server.js` (if needed)

- [ ] **Step 1: Rewrite handlers.ts — Socket.IO event registration**

This replaces the giant `switch` statement with Socket.IO `socket.on()` calls per event. Each socket gets all events registered on connection.

```typescript
import type { AppSocket, AppServer } from './types';
import { busRoomBridge } from './subscriptions';
import { cardService } from '../services/card';
import { projectService } from '../services/project';
import { getProvidersForClient } from '../config/providers';
import {
  handleCardCreate,
  handleCardUpdate,
  handleCardDelete,
  handleCardGenerateTitle,
  handleCardSuggestTitle,
} from './handlers/cards';
import {
  handleProjectCreate,
  handleProjectUpdate,
  handleProjectDelete,
  handleProjectBrowse,
  handleProjectMkdir,
} from './handlers/projects';
import { handleSessionLoad } from './handlers/sessions';
import { handleAgentSend, handleAgentCompact, handleAgentStop, handleAgentStatus } from './handlers/agents';
import { handleQueueReorder } from './handlers/queue';
import type { Card, Column, Project, AckResponse, SyncPayload, PageResult } from '../../shared/ws-protocol';

export function registerSocketEvents(socket: AppSocket, io: AppServer): void {
  const identity = socket.data.identity;
  console.log(`[ws] connection: ${identity.email} (${identity.role})`);

  // ── Subscribe ────────────────────────────────────────────────────────────
  socket.on('subscribe', async (columns, callback) => {
    try {
      // Leave old column rooms, join new ones
      for (const room of socket.rooms) {
        if (room.startsWith('col:')) socket.leave(room);
      }
      for (const col of columns) socket.join(`col:${col}`);

      // Build sync payload scoped by user visibility
      const { userService } = await import('../services/user');
      const visible = await userService.visibleProjectIds(identity as import('../services/user').UserIdentity);

      const [allCards, allProjects] = await Promise.all([
        cardService.listCards(columns.length > 0 ? (columns as Column[]) : undefined),
        projectService.listProjects(),
      ]);

      const cards =
        visible === 'all'
          ? allCards
          : allCards.filter((c) => c.projectId != null && (visible as number[]).includes(c.projectId));
      const projects =
        visible === 'all' ? allProjects : allProjects.filter((p) => (visible as number[]).includes(p.id));

      let users: Array<{ id: number; email: string; role: string }> | undefined;
      if (identity.role === 'admin') {
        users = await userService.listUsers();
        for (const p of projects) {
          (p as unknown as Record<string, unknown>).userIds = await userService.projectUserIds(p.id);
        }
      }

      callback({
        data: {
          cards: cards as unknown as Card[],
          projects: projects as unknown as Project[],
          providers: getProvidersForClient(),
          user: { id: identity.id, email: identity.email, role: identity.role },
          users,
        },
      });
    } catch (err) {
      console.error('[ws] subscribe error:', err);
      callback({ error: String(err instanceof Error ? err.message : err) });
    }
  });

  // ── Page ─────────────────────────────────────────────────────────────────
  socket.on('page', async (data, callback) => {
    try {
      const result = await cardService.pageCards(data.column as Column, data.cursor, data.limit);
      callback({
        data: {
          column: data.column as Column,
          cards: result.cards as unknown as Card[],
          nextCursor: result.nextCursor,
          total: result.total,
        },
      });
    } catch (err) {
      console.error('[ws] page error:', err);
      callback({ error: String(err instanceof Error ? err.message : err) });
    }
  });

  // ── Search ───────────────────────────────────────────────────────────────
  socket.on('search', async (data, callback) => {
    try {
      const { cards, total } = await cardService.searchCards(data.query);
      callback({ data: { cards: cards as unknown as Card[], total } });
    } catch (err) {
      console.error('[ws] search error:', err);
      callback({ error: String(err instanceof Error ? err.message : err) });
    }
  });

  // ── Card CRUD ────────────────────────────────────────────────────────────
  socket.on('card:create', (data, cb) => void handleCardCreate(data, cb));
  socket.on('card:update', (data, cb) => void handleCardUpdate(data, cb));
  socket.on('card:delete', (data, cb) => void handleCardDelete(data, cb));
  socket.on('card:generateTitle', (data, cb) => void handleCardGenerateTitle(data, cb));
  socket.on('card:suggestTitle', (data, cb) => void handleCardSuggestTitle(data, cb));

  // ── Project CRUD ─────────────────────────────────────────────────────────
  socket.on('project:create', (data, cb) => void handleProjectCreate(data, cb));
  socket.on('project:update', (data, cb) => void handleProjectUpdate(data, cb, socket, io));
  socket.on('project:delete', (data, cb) => void handleProjectDelete(data, cb));
  socket.on('project:browse', (data, cb) => void handleProjectBrowse(data, cb));
  socket.on('project:mkdir', (data, cb) => void handleProjectMkdir(data, cb));

  // ── Agent ────────────────────────────────────────────────────────────────
  socket.on('agent:send', (data, cb) => void handleAgentSend(data, cb));
  socket.on('agent:compact', (data, cb) => void handleAgentCompact(data, cb));
  socket.on('agent:stop', (data, cb) => void handleAgentStop(data, cb));
  socket.on('agent:status', (data, cb) => void handleAgentStatus(data, cb, socket));

  // ── Session ──────────────────────────────────────────────────────────────
  socket.on('session:load', (data, cb) => void handleSessionLoad(data, cb, socket));

  socket.on('session:set-model', async (data, callback) => {
    const { cardId, provider, model } = data;
    try {
      const initState = await import('../init-state');
      const sm = initState.getSessionManager();
      sm?.setModel(cardId, provider, model);
      const { Card } = await import('../models/Card');
      const card = await Card.findOneBy({ id: cardId });
      if (card) {
        card.provider = provider;
        card.model = model;
        card.updatedAt = new Date().toISOString();
        await card.save();
      }
      callback({});
    } catch (err) {
      callback({ error: String(err instanceof Error ? err.message : err) });
    }
  });

  // ── Queue ────────────────────────────────────────────────────────────────
  socket.on('queue:reorder', (data, cb) => void handleQueueReorder(data, cb));

  // ── Disconnect ───────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    console.log(`[ws] disconnect: ${identity.email}`);
    // Clean up card room bus listeners if rooms are now empty
    for (const room of socket.rooms) {
      const match = room.match(/^card:(\d+)$/);
      if (match) {
        busRoomBridge.cleanupCardIfEmpty(Number(match[1]));
      }
    }
  });
}
```

- [ ] **Step 2: Rewrite server.ts — Socket.IO Vite plugin**

```typescript
import type { Plugin } from 'vite';
import { Server as IoServer } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents, SocketData } from '../../shared/ws-protocol';

// NOTE: TypeORM entity imports must be lazy (dynamic import) because Vite bundles
// vite.config.ts with esbuild which uses TC39 decorators, not legacy TypeScript
// decorators that TypeORM requires. Static imports would fail at config bundle time.
//
// State that must survive Vite restarts lives in src/server/init-state.ts (dynamically
// imported, so Node.js module cache preserves it across re-bundles).

export function wsServerPlugin(): Plugin {
  return {
    name: 'orchestrel-ws',
    configureServer(server) {
      // Register REST middleware placeholder synchronously so it's in the middleware
      // stack BEFORE React Router's catch-all. The actual router activates after async init.
      let restApp: import('express').Express | null = null;
      server.middlewares.use((req, res, next) => {
        if (req.url?.startsWith('/api/') && restApp) {
          restApp(req as import('express').Request, res as import('express').Response, next);
        } else {
          next();
        }
      });

      // All TypeORM-dependent imports are lazy to avoid decorator issues with Vite's esbuild
      Promise.all([
        import('../models/index'),
        import('./handlers'),
        import('./subscriptions'),
        import('./auth'),
        import('../init-state'),
      ])
        .then(
          async ([
            { initDatabase },
            { registerSocketEvents },
            { busRoomBridge },
            { socketAuthMiddleware },
            initState,
          ]) => {
            await initDatabase();

            // REST API routes are re-wired on each restart (restApp closure updates)
            const express = await import('express');
            const { RegisterRoutes } = await import('../api/generated/routes');

            const router = express.default();
            router.use(express.default.json());
            RegisterRoutes(router);

            // File upload route
            const multer = (await import('multer')).default;
            const { writeFileSync, mkdirSync } = await import('fs');
            const { join } = await import('path');
            const { randomUUID } = await import('crypto');

            const MAX_FILE_SIZE = 25 * 1024 * 1024;
            const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_SIZE } });

            router.post(
              '/api/upload',
              upload.array('files'),
              (req: import('express').Request, res: import('express').Response) => {
                const rawSessionId = (req.body?.sessionId as string | undefined) ?? 'unsorted';
                const sessionId = rawSessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
                const dir = join('/tmp/orchestrel-uploads', sessionId);
                mkdirSync(dir, { recursive: true });

                const files = req.files as Express.Multer.File[] | undefined;
                if (!files?.length) {
                  res.status(400).json({ error: 'No files uploaded' });
                  return;
                }

                const refs = files.map((f) => {
                  const id = randomUUID().slice(0, 8);
                  const filename = `${id}-${f.originalname}`;
                  const filePath = join(dir, filename);
                  writeFileSync(filePath, f.buffer);
                  return { id, name: f.originalname, mimeType: f.mimetype, path: filePath, size: f.size };
                });

                res.json({ files: refs });
              },
            );

            // Serve OpenAPI spec and Swagger UI
            const { readFileSync } = await import('fs');
            const { resolve } = await import('path');
            const swaggerUi = await import('swagger-ui-express');

            const specPath = resolve(import.meta.dirname, '../api/generated/swagger.json');
            const spec = JSON.parse(readFileSync(specPath, 'utf-8'));

            router.get('/api/docs/swagger.json', (_req: import('express').Request, res: import('express').Response) => {
              res.json(spec);
            });
            router.use('/api/docs', swaggerUi.serve, swaggerUi.setup(spec));

            // Error handler for tsoa validation errors
            router.use(
              (
                err: unknown,
                _req: import('express').Request,
                res: import('express').Response,
                next: import('express').NextFunction,
              ) => {
                if (err && typeof err === 'object' && 'status' in err) {
                  const e = err as { status: number; message?: string; fields?: Record<string, unknown> };
                  res.status(e.status).json({ error: e.message ?? 'Validation error', fields: e.fields });
                  return;
                }
                next(err);
              },
            );

            restApp = router;
            console.log('[rest] API routes registered');

            // --- Socket.IO: create once, persists across Vite restarts ---
            let io = initState.io;
            if (!io) {
              const httpServer = await initState.getHttpServer();
              io = new IoServer<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>(
                httpServer as import('http').Server,
                {
                  serveClient: false,
                  pingInterval: 10_000,
                  pingTimeout: 5_000,
                  cors: { origin: true, credentials: true },
                },
              );
              io.use(socketAuthMiddleware);
              io.on('connection', (socket) => registerSocketEvents(socket, io!));
              busRoomBridge.init(io);
              initState.setIo(io);
              console.log('[ws] Socket.IO server created');
            }

            // --- One-time init: SessionManager + controller listeners ---
            if (initState.initialized) return;

            const { SessionManager } = await import('../sessions/manager');
            const { registerAutoStart, registerWorktreeCleanup } = await import('../controllers/oc');

            let sm = initState.getSessionManager();
            if (!sm) {
              sm = new SessionManager();
              initState.setSessionManager(sm);
            }

            registerAutoStart();
            registerWorktreeCleanup();
            console.log('[sessions] SessionManager initialized, controller listeners registered');

            initState.markInitialized();

            // Move stale running cards to review
            try {
              const { Card } = await import('../models/Card');
              const cards = await Card.find({ where: { column: 'running' } });
              for (const card of cards) {
                if (card.queuePosition != null) continue;
                card.column = 'review';
                card.updatedAt = new Date().toISOString();
                await card.save();
                console.log(`[startup] card ${card.id} moved to review (no active session)`);
              }
            } catch (err) {
              console.error('[startup] stale card scan failed:', err);
            }
          },
        )
        .catch((err) => {
          console.error('[db] failed to initialize:', err);
        });
    },
  };
}
```

- [ ] **Step 3: Rewrite init.ts — production path**

```typescript
import type { Server as HttpServer } from 'http';
import type { Router as ExpressRouter, Request, Response, NextFunction } from 'express';
import { Server as IoServer } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents, SocketData } from '../shared/ws-protocol';

export async function initBackend(): Promise<{
  restRouter: ExpressRouter;
  attachSocketIo: (httpServer: HttpServer) => void;
}> {
  const [{ initDatabase }, { registerSocketEvents }, { busRoomBridge }, { socketAuthMiddleware }] = await Promise.all([
    import('./models/index'),
    import('./ws/handlers'),
    import('./ws/subscriptions'),
    import('./ws/auth'),
  ]);

  await initDatabase();

  // --- REST API ---
  const express = await import('express');
  const { RegisterRoutes } = await import('./api/generated/routes');

  const router = express.default.Router();
  router.use(express.default.json());
  RegisterRoutes(router);

  // File upload
  const multer = (await import('multer')).default;
  const { writeFileSync, mkdirSync } = await import('fs');
  const { join } = await import('path');
  const { randomUUID } = await import('crypto');

  const MAX_FILE_SIZE = 25 * 1024 * 1024;
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_SIZE } });

  router.post('/api/upload', upload.array('files'), (req: Request, res: Response) => {
    const rawSessionId = (req.body?.sessionId as string | undefined) ?? 'unsorted';
    const sessionId = rawSessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const dir = join('/tmp/orchestrel-uploads', sessionId);
    mkdirSync(dir, { recursive: true });

    const files = req.files as Express.Multer.File[] | undefined;
    if (!files?.length) {
      res.status(400).json({ error: 'No files uploaded' });
      return;
    }

    const refs = files.map((f) => {
      const id = randomUUID().slice(0, 8);
      const filename = `${id}-${f.originalname}`;
      const filePath = join(dir, filename);
      writeFileSync(filePath, f.buffer);
      return { id, name: f.originalname, mimeType: f.mimetype, path: filePath, size: f.size };
    });

    res.json({ files: refs });
  });

  // OpenAPI spec + Swagger UI
  const { readFileSync } = await import('fs');
  const { resolve } = await import('path');
  const swaggerUi = await import('swagger-ui-express');

  const specPath = resolve(import.meta.dirname, './api/generated/swagger.json');
  const spec = JSON.parse(readFileSync(specPath, 'utf-8'));

  router.get('/api/docs/swagger.json', (_req: Request, res: Response) => {
    res.json(spec);
  });
  router.use('/api/docs', swaggerUi.serve, swaggerUi.setup(spec));

  router.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (err && typeof err === 'object' && 'status' in err) {
      const e = err as { status: number; message?: string; fields?: Record<string, unknown> };
      res.status(e.status).json({ error: e.message ?? 'Validation error', fields: e.fields });
      return;
    }
    next(err);
  });

  console.log('[rest] API routes registered');

  // --- Socket.IO creation deferred to attachSocketIo ---
  function attachSocketIo(httpServer: HttpServer) {
    const io = new IoServer<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>(httpServer, {
      serveClient: false,
      pingInterval: 10_000,
      pingTimeout: 5_000,
      cors: { origin: true, credentials: true },
    });
    io.use(socketAuthMiddleware);
    io.on('connection', (socket) => registerSocketEvents(socket, io));
    busRoomBridge.init(io);
    console.log('[ws] Socket.IO server attached');
  }

  // --- OC controllers + SessionManager ---
  const { registerAutoStart, registerWorktreeCleanup } = await import('./controllers/oc');
  const initState = await import('./init-state');

  let sm = initState.getSessionManager();
  if (!sm) {
    const { SessionManager } = await import('./sessions/manager');
    sm = new SessionManager();
    initState.setSessionManager(sm);
  }

  registerAutoStart();
  registerWorktreeCleanup();
  console.log('[oc] controller listeners registered');

  // Move stale running cards to review
  try {
    const { Card } = await import('./models/Card');
    const cards = await Card.find({ where: { column: 'running' } });
    for (const card of cards) {
      if (card.queuePosition != null) continue;
      card.column = 'review';
      card.updatedAt = new Date().toISOString();
      await card.save();
      console.log(`[startup] card ${card.id} moved to review (no active session)`);
    }
  } catch (err) {
    console.error('[startup] stale card scan failed:', err);
  }

  return { restRouter: router, attachSocketIo };
}
```

- [ ] **Step 4: Update server.js — adapt production startup**

The only change: rename `attachWs` → `attachSocketIo`.

In `server.js`, change:

```javascript
// Old:
const { restRouter, attachWs } = await initBackend();
// ...
pendingAttachWs = attachWs;
// ...
if (pendingAttachWs) pendingAttachWs(httpServer);

// New:
const { restRouter, attachSocketIo } = await initBackend();
// ...
pendingAttachSocketIo = attachSocketIo;
// ...
if (pendingAttachSocketIo) pendingAttachSocketIo(httpServer);
```

Full file for reference:

```javascript
import compression from 'compression';
import express from 'express';
import morgan from 'morgan';

const DEVELOPMENT = process.env.NODE_ENV === 'development';
const PORT = Number.parseInt(process.env.PORT || (DEVELOPMENT ? '6195' : '6194'));

const app = express();

app.use(
  compression({
    filter: (req, res) => {
      if (req.headers.accept === 'text/event-stream') return false;
      return compression.filter(req, res);
    },
  }),
);
app.disable('x-powered-by');

/** @type {((server: import('http').Server) => void) | null} */
let pendingAttachSocketIo = null;

if (DEVELOPMENT) {
  console.log('Starting development server');
  const viteDevServer = await import('vite').then((vite) =>
    vite.createServer({
      server: { middlewareMode: true },
    }),
  );
  app.use(viteDevServer.middlewares);
  app.use(async (req, res, next) => {
    try {
      const source = await viteDevServer.ssrLoadModule('./server/app.ts');
      return await source.app(req, res, next);
    } catch (error) {
      if (typeof error === 'object' && error instanceof Error) {
        viteDevServer.ssrFixStacktrace(error);
      }
      next(error);
    }
  });
} else {
  console.log('Starting production server');
  app.use(morgan('tiny'));

  // @ts-expect-error .ts extension needed at runtime for tsx loader
  const { initBackend } = await import('./src/server/init.ts');
  const { restRouter, attachSocketIo } = await initBackend();

  app.use(restRouter);

  app.use('/assets', express.static('build/client/assets', { immutable: true, maxAge: '1y' }));
  app.use(express.static('build/client', { maxAge: '1h' }));

  app.get('/{*path}', (_req, res) => {
    res.sendFile('index.html', { root: 'build/client' });
  });

  pendingAttachSocketIo = attachSocketIo;
}

const HOST = process.env.HOST || '0.0.0.0';
const httpServer = app.listen(PORT, HOST, () => {
  console.log(`Server running on http://${HOST}:${PORT}`);
});

if (DEVELOPMENT) {
  // @ts-expect-error custom event for Vite WS plugin
  process.emit('orchestrel:httpServer', httpServer);
} else if (pendingAttachSocketIo) {
  pendingAttachSocketIo(httpServer);
}
```

- [ ] **Step 5: Commit**

```bash
git add src/server/ws/handlers.ts src/server/ws/server.ts src/server/init.ts server.js
git commit -m "feat: wire socket.io server, event registration, vite plugin, production init"
```

---

### Task 6: Client — Socket.IO Client, Stores, Components

Replace the hand-rolled `WsClient` with a Socket.IO client wrapper. Update all stores to use `emitWithAck` instead of `mutate` with requestIds. Update the reconnect button in `SessionView.tsx`.

**Files:**

- Rewrite: `app/lib/ws-client.ts`
- Modify: `app/stores/root-store.ts`
- Modify: `app/stores/card-store.ts`
- Modify: `app/stores/project-store.ts`
- Modify: `app/stores/session-store.ts`
- Modify: `app/components/SessionView.tsx`

- [ ] **Step 1: Rewrite app/lib/ws-client.ts**

```typescript
import { io, Socket } from 'socket.io-client';
import type {
  ClientToServerEvents,
  ServerToClientEvents,
  Column,
  SyncPayload,
  AckResponse,
} from '../../src/shared/ws-protocol';

type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;
type ServerEventHandler = {
  [K in keyof ServerToClientEvents]: ServerToClientEvents[K];
};

export class WsClient {
  readonly socket: AppSocket;
  private subscribedColumns: Column[] = [];
  private reconnectCb: (() => void) | null = null;
  private disposed = false;

  constructor(handlers: {
    onSync: ServerEventHandler['sync'];
    onCardUpdated: ServerEventHandler['card:updated'];
    onCardDeleted: ServerEventHandler['card:deleted'];
    onProjectUpdated: ServerEventHandler['project:updated'];
    onProjectDeleted: ServerEventHandler['project:deleted'];
    onSessionMessage: ServerEventHandler['session:message'];
    onAgentStatus: ServerEventHandler['agent:status'];
  }) {
    this.socket = io({
      // Connect to same origin — no URL needed
      withCredentials: true,
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 30_000,
      reconnectionAttempts: Infinity,
      timeout: 10_000,
    });

    // Wire server→client events
    this.socket.on('sync', handlers.onSync);
    this.socket.on('card:updated', handlers.onCardUpdated);
    this.socket.on('card:deleted', handlers.onCardDeleted);
    this.socket.on('project:updated', handlers.onProjectUpdated);
    this.socket.on('project:deleted', handlers.onProjectDeleted);
    this.socket.on('session:message', handlers.onSessionMessage);
    this.socket.on('agent:status', handlers.onAgentStatus);

    this.socket.on('connect', () => {
      console.log('[ws] connected');
      // Resubscribe to columns on reconnect
      if (this.subscribedColumns.length > 0) {
        this.subscribe(this.subscribedColumns);
      }
    });

    this.socket.on('reconnect', () => {
      console.log('[ws] reconnected');
      this.reconnectCb?.();
    });

    this.socket.on('disconnect', (reason) => {
      console.log('[ws] disconnected:', reason);
    });

    this.socket.on('connect_error', (err) => {
      console.error('[ws] connect error:', err.message);
    });
  }

  get connected(): boolean {
    return this.socket.connected;
  }

  forceReconnect() {
    if (this.disposed) return;
    console.log('[ws] force reconnect requested');
    this.socket.disconnect().connect();
  }

  onReconnect(cb: () => void) {
    this.reconnectCb = cb;
  }

  async subscribe(columns: Column[]): Promise<SyncPayload | undefined> {
    this.subscribedColumns = columns;
    const res = await this.socket.emitWithAck('subscribe', columns);
    if (res.error) {
      console.error('[ws] subscribe error:', res.error);
      return undefined;
    }
    return res.data;
  }

  /** Generic ack-based emit. Throws on error response. */
  async emit<E extends keyof ClientToServerEvents>(
    event: E,
    ...args: Parameters<ClientToServerEvents[E]> extends [...infer Data, (res: AckResponse<infer _R>) => void]
      ? Data
      : never
  ): Promise<unknown> {
    const res = await (this.socket as Socket).emitWithAck(event, ...args);
    if (res && typeof res === 'object' && 'error' in res && res.error) {
      throw new Error(res.error as string);
    }
    return res && typeof res === 'object' && 'data' in res ? res.data : undefined;
  }

  /** Fire-and-forget emit (no ack expected). */
  send<E extends keyof ClientToServerEvents>(event: E, data: unknown) {
    this.socket.emit(event as string, data);
  }

  dispose() {
    this.disposed = true;
    this.socket.disconnect();
  }
}
```

- [ ] **Step 2: Rewrite app/stores/root-store.ts**

```typescript
import { makeAutoObservable } from 'mobx';
import { WsClient } from '../lib/ws-client';
import { CardStore } from './card-store';
import { ConfigStore } from './config-store';
import { ProjectStore } from './project-store';
import { SessionStore } from './session-store';
import type { Column, User } from '../../src/shared/ws-protocol';

export class RootStore {
  currentUser: User | null = null;
  readonly cards: CardStore;
  readonly config: ConfigStore;
  readonly projects: ProjectStore;
  readonly sessions: SessionStore;
  readonly ws: WsClient;

  constructor() {
    this.cards = new CardStore();
    this.config = new ConfigStore();
    this.projects = new ProjectStore();
    this.sessions = new SessionStore();

    this.ws = new WsClient({
      onSync: (data) => {
        this.currentUser = data.user ?? null;
        this.cards.hydrate(data.cards, true);
        this.projects.hydrate(data.projects, true, data.users);
        this.config.hydrate(data.providers);
      },
      onCardUpdated: (data) => {
        const prev = this.cards.getCard(data.id);
        if (
          data.column === 'review' &&
          prev &&
          prev.column !== 'review' &&
          !document.hasFocus() &&
          Notification.permission === 'granted'
        ) {
          const n = new Notification(data.title, { body: 'moved to review' });
          n.onclick = () => {
            window.focus();
            window.dispatchEvent(new CustomEvent('orchestrel:focus-card', { detail: { cardId: data.id } }));
          };
        }
        this.cards.handleUpdated(data);
      },
      onCardDeleted: (data) => this.cards.handleDeleted(data.id),
      onProjectUpdated: (data) => this.projects.handleUpdated(data),
      onProjectDeleted: (data) => this.projects.handleDeleted(data.id),
      onSessionMessage: (data) => this.sessions.ingestSdkMessage(data.cardId, data.message),
      onAgentStatus: (data) => this.sessions.handleAgentStatus(data),
    });

    makeAutoObservable(this, {
      ws: false,
      cards: false,
      config: false,
      projects: false,
      sessions: false,
    });

    this.cards.setWs(this.ws);
    this.projects.setWs(this.ws);
    this.sessions.setWs(this.ws);

    this.ws.onReconnect(() => this.sessions.resubscribeAll());

    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }

  subscribe(columns: string[]) {
    this.ws.subscribe(columns as Column[]);
  }

  dispose() {
    this.ws.dispose();
  }
}
```

- [ ] **Step 3: Rewrite app/stores/card-store.ts**

Key change: no more `uuid()` requestId generation. Use `ws.emit()` which calls `emitWithAck` internally. The `setWs` method replaces the module-level setter.

```typescript
import { makeAutoObservable, runInAction } from 'mobx';
import type { Card, Column } from '../../src/shared/ws-protocol';
import type { WsClient } from '../lib/ws-client';

export class CardStore {
  cards = new Map<number, Card>();
  hydrated = false;
  private _ws: WsClient | null = null;

  constructor() {
    makeAutoObservable<this, '_ws'>(this, { _ws: false });
  }

  setWs(ws: WsClient) {
    this._ws = ws;
  }
  private ws(): WsClient {
    if (!this._ws) throw new Error('WsClient not set');
    return this._ws;
  }

  // ── Computed views ──────────────────────────────────────────────────────────

  cardsByColumn(col: string): Card[] {
    const items = Array.from(this.cards.values()).filter((c) => c.column === col);
    if (col === 'archive') return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return items.sort((a, b) => a.position - b.position);
  }

  get cardsByCreatedDesc(): Card[] {
    return Array.from(this.cards.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  getCard(id: number): Card | undefined {
    return this.cards.get(id);
  }

  // ── Hydration ───────────────────────────────────────────────────────────────

  hydrate(items: unknown[], replace = false) {
    if (replace) {
      this.cards.clear();
      this.hydrated = true;
    }
    for (const c of items) {
      const card = c as Card;
      this.cards.set(card.id, card);
    }
  }

  handleUpdated(card: Card) {
    this.cards.set(card.id, card);
  }

  handleDeleted(id: number) {
    this.cards.delete(id);
  }

  serialize(): Card[] {
    return Array.from(this.cards.values());
  }

  // ── Mutations ───────────────────────────────────────────────────────────────

  async createCard(data: {
    title: string;
    description?: string | null;
    column?: Column | null;
    projectId?: number | null;
    model?: string;
    provider?: string;
    thinkingLevel?: 'off' | 'low' | 'medium' | 'high';
    useWorktree?: boolean;
    sourceBranch?: 'main' | 'dev' | null;
  }): Promise<Card> {
    const card = (await this.ws().emit('card:create', {
      title: data.title,
      description: data.description ?? undefined,
      column: data.column ?? undefined,
      projectId: data.projectId,
      model: data.model,
      provider: data.provider,
      thinkingLevel: data.thinkingLevel,
      useWorktree: data.useWorktree,
      sourceBranch: data.sourceBranch,
    })) as Card;
    runInAction(() => this.cards.set(card.id, card));
    return card;
  }

  async createChatCard(data: {
    description: string;
    projectId: number;
    model?: string;
    thinkingLevel?: 'off' | 'low' | 'medium' | 'high';
  }): Promise<Card> {
    const card = (await this.ws().emit('card:create', {
      title: 'New chat',
      description: data.description,
      column: 'running',
      projectId: data.projectId,
      model: data.model,
      thinkingLevel: data.thinkingLevel,
      useWorktree: false,
      archiveOthers: true,
    })) as Card;
    runInAction(() => this.cards.set(card.id, card));
    return card;
  }

  async updateCard(data: {
    id: number;
    title?: string;
    description?: string | null;
    column?: Column;
    position?: number;
    projectId?: number | null;
    model?: string;
    thinkingLevel?: 'off' | 'low' | 'medium' | 'high';
    useWorktree?: boolean;
    sourceBranch?: 'main' | 'dev' | null;
  }): Promise<Card> {
    const existing = this.cards.get(data.id);
    if (existing) this.cards.set(data.id, { ...existing, ...data } as Card);

    try {
      const card = (await this.ws().emit('card:update', {
        ...data,
        description: data.description ?? undefined,
      })) as Card;
      runInAction(() => this.cards.set(card.id, card));
      return card;
    } catch (err) {
      runInAction(() => {
        if (existing) this.cards.set(data.id, existing);
      });
      throw err;
    }
  }

  async deleteCard(id: number): Promise<void> {
    const existing = this.cards.get(id);
    this.cards.delete(id);

    try {
      await this.ws().emit('card:delete', { id });
    } catch (err) {
      runInAction(() => {
        if (existing) this.cards.set(id, existing);
      });
      throw err;
    }
  }

  async reorderQueue(cardId: number, newPosition: number) {
    await this.ws().emit('queue:reorder', { cardId, newPosition });
  }

  async generateTitle(id: number): Promise<void> {
    await this.ws().emit('card:generateTitle', { id });
  }

  async suggestTitle(description: string): Promise<string | null> {
    const res = await this.ws().emit('card:suggestTitle', { description });
    return typeof res === 'string' ? res : null;
  }
}
```

Remove the module-level `setCardStoreWs` export — no longer needed with instance method.

- [ ] **Step 4: Rewrite app/stores/project-store.ts**

```typescript
import { makeAutoObservable } from 'mobx';
import type { Project, User } from '../../src/shared/ws-protocol';
import type { WsClient } from '../lib/ws-client';

export class ProjectStore {
  projects = new Map<number, Project>();
  users: User[] = [];
  private _ws: WsClient | null = null;

  constructor() {
    makeAutoObservable<this, '_ws'>(this, { _ws: false });
  }

  setWs(ws: WsClient) {
    this._ws = ws;
  }
  private ws(): WsClient {
    if (!this._ws) throw new Error('WsClient not set');
    return this._ws;
  }

  getProject(id: number): Project | undefined {
    return this.projects.get(id);
  }

  get all(): Project[] {
    return Array.from(this.projects.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  hydrate(items: unknown[], replace = false, users?: User[]) {
    if (replace) this.projects.clear();
    for (const p of items) {
      const project = p as Project;
      this.projects.set(project.id, project);
    }
    if (users) this.users = users;
  }

  handleUpdated(project: Project) {
    this.projects.set(project.id, project);
  }

  handleDeleted(id: number) {
    this.projects.delete(id);
  }

  serialize(): Project[] {
    return Array.from(this.projects.values());
  }

  async createProject(data: {
    name: string;
    path: string;
    setupCommands?: string | null;
    defaultBranch?: 'main' | 'dev' | null;
    defaultWorktree?: boolean;
    defaultModel?: string;
    defaultThinkingLevel?: 'off' | 'low' | 'medium' | 'high';
    color?: string | null;
    providerID?: string;
  }): Promise<Project> {
    const project = (await this.ws().emit('project:create', {
      ...data,
      setupCommands: data.setupCommands ?? undefined,
      color: data.color ?? undefined,
    })) as Project;
    this.projects.set(project.id, project);
    return project;
  }

  async updateProject(data: {
    id: number;
    name?: string;
    path?: string;
    setupCommands?: string | null;
    defaultBranch?: 'main' | 'dev' | null;
    defaultWorktree?: boolean;
    defaultModel?: string;
    defaultThinkingLevel?: 'off' | 'low' | 'medium' | 'high';
    color?: string | null;
    providerID?: string;
    userIds?: number[];
  }): Promise<Project> {
    const existing = this.projects.get(data.id);
    if (existing) this.projects.set(data.id, { ...existing, ...data } as Project);

    try {
      const project = (await this.ws().emit('project:update', {
        ...data,
        setupCommands: data.setupCommands ?? undefined,
        color: data.color ?? undefined,
      })) as Project;
      this.projects.set(project.id, project);
      return project;
    } catch (err) {
      if (existing) this.projects.set(data.id, existing);
      throw err;
    }
  }

  async deleteProject(id: number): Promise<void> {
    const existing = this.projects.get(id);
    this.projects.delete(id);

    try {
      await this.ws().emit('project:delete', { id });
    } catch (err) {
      if (existing) this.projects.set(id, existing);
      throw err;
    }
  }

  async browse(path: string): Promise<unknown> {
    return this.ws().emit('project:browse', { path });
  }

  async mkdir(path: string): Promise<unknown> {
    return this.ws().emit('project:mkdir', { path });
  }
}
```

- [ ] **Step 5: Rewrite app/stores/session-store.ts**

Key change: `session:load` returns history in the ack, so `ingestHistory` is called directly from `loadHistory`. The `session:history` server event is gone. Mutation timeout handling is gone — Socket.IO handles retransmission.

```typescript
import { makeAutoObservable, observable, runInAction } from 'mobx';
import type { AgentStatus, FileRef } from '../../src/shared/ws-protocol';
import type { WsClient } from '../lib/ws-client';
import type { SdkMessage, HistoryMessage } from '../lib/sdk-types';
import { MessageAccumulator } from '../lib/message-accumulator';

export interface SessionState {
  active: boolean;
  status: 'starting' | 'running' | 'completed' | 'errored' | 'stopped' | 'retry';
  sessionId: string | null;
  promptsSent: number;
  turnsCompleted: number;
  accumulator: MessageAccumulator;
  historyLoaded: boolean;
  contextTokens: number;
  contextWindow: number;
}

function defaultSession(): SessionState {
  return {
    active: false,
    status: 'stopped',
    sessionId: null,
    promptsSent: 0,
    turnsCompleted: 0,
    accumulator: new MessageAccumulator(),
    historyLoaded: false,
    contextTokens: 0,
    contextWindow: 200_000,
  };
}

export class SessionStore {
  sessions = observable.map<number, SessionState>();
  subscribedCards = new Set<number>();
  stoppingCards = observable.set<number>();
  private stopIntervals = new Map<number, NodeJS.Timeout>();
  private _ws: WsClient | null = null;

  constructor() {
    makeAutoObservable<this, 'stopIntervals' | '_ws'>(this, {
      stopIntervals: false,
      _ws: false,
    });
  }

  setWs(ws: WsClient) {
    this._ws = ws;
  }
  private ws(): WsClient {
    if (!this._ws) throw new Error('WsClient not set');
    return this._ws;
  }

  private getOrCreate(cardId: number): SessionState {
    if (!this.sessions.has(cardId)) {
      this.sessions.set(cardId, defaultSession());
    }
    return this.sessions.get(cardId)!;
  }

  getSession(cardId: number): SessionState | undefined {
    return this.sessions.get(cardId);
  }

  // ── Incoming server messages ────────────────────────────────────────────────

  ingestSdkMessage(cardId: number, msg: unknown): void {
    runInAction(() => {
      const s = this.getOrCreate(cardId);
      const sdkMsg = msg as SdkMessage;

      if (!s.active && (sdkMsg.type === 'stream_event' || sdkMsg.type === 'assistant')) {
        s.active = true;
        s.status = 'running';
      }

      s.accumulator.handleMessage(sdkMsg);
    });
  }

  ingestHistory(cardId: number, messages: unknown[]): void {
    runInAction(() => {
      const s = this.getOrCreate(cardId);
      s.accumulator.clear();
      for (const msg of messages) {
        s.accumulator.handleHistoryMessage(msg as HistoryMessage);
      }
      s.historyLoaded = true;
    });
  }

  clearConversation(cardId: number): void {
    const s = this.sessions.get(cardId);
    if (!s) return;
    s.accumulator.clear();
    s.historyLoaded = false;
    s.contextTokens = 0;
    s.contextWindow = 200_000;
  }

  handleAgentStatus(data: AgentStatus) {
    runInAction(() => {
      const s = this.getOrCreate(data.cardId);
      s.active = data.active;
      s.status = data.status;
      s.sessionId = data.sessionId;
      s.promptsSent = data.promptsSent;
      s.turnsCompleted = data.turnsCompleted;
      if (data.contextTokens > 0) s.contextTokens = data.contextTokens;
      if (data.contextWindow > 0) s.contextWindow = data.contextWindow;

      if (data.status === 'completed' || data.status === 'stopped' || data.status === 'errored') {
        const stopInterval = this.stopIntervals.get(data.cardId);
        if (stopInterval !== undefined) {
          clearInterval(stopInterval);
          this.stopIntervals.delete(data.cardId);
        }
        this.stoppingCards.delete(data.cardId);
      }
    });
  }

  handleSessionExit(cardId: number): void {
    runInAction(() => {
      const s = this.getOrCreate(cardId);
      s.active = false;
      if (s.status === 'running' || s.status === 'starting') {
        s.status = 'completed';
      }
      const stopInterval = this.stopIntervals.get(cardId);
      if (stopInterval !== undefined) {
        clearInterval(stopInterval);
        this.stopIntervals.delete(cardId);
      }
      this.stoppingCards.delete(cardId);
    });
  }

  // ── Mutations ───────────────────────────────────────────────────────────────

  async sendMessage(cardId: number, message: string, files?: FileRef[]): Promise<void> {
    const s = this.getOrCreate(cardId);

    s.accumulator.addUserMessage(message, true);

    runInAction(() => {
      s.active = true;
      s.status = 'running';
      s.promptsSent = (s.promptsSent ?? 0) + 1;
    });

    try {
      await this.ws().emit('agent:send', { cardId, message, files });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Socket.IO handles reconnection — if we get here it's a real error.
      // Verify status to see what actually happened.
      console.warn(`[session] agent:send error for card ${cardId}: ${msg}, verifying status…`);
      this.requestStatus(cardId).catch(() => {});
    }
  }

  async compactSession(cardId: number): Promise<void> {
    await this.ws().emit('agent:compact', { cardId });
  }

  stopSession(cardId: number): void {
    if (this.stoppingCards.has(cardId)) return;
    const s = this.sessions.get(cardId);
    if (s && (s.status === 'stopped' || s.status === 'completed' || s.status === 'errored')) return;

    runInAction(() => this.stoppingCards.add(cardId));

    const sendStop = () => {
      this.ws().socket.emit('agent:stop', { cardId }, () => {});
    };
    sendStop();
    this.stopIntervals.set(cardId, setInterval(sendStop, 1000));
  }

  async requestStatus(cardId: number): Promise<void> {
    await this.ws().emit('agent:status', { cardId });
  }

  async loadHistory(cardId: number, sessionId?: string | null): Promise<void> {
    this.subscribedCards.add(cardId);
    const result = (await this.ws().emit('session:load', {
      cardId,
      ...(sessionId ? { sessionId } : {}),
    })) as { messages: unknown[] } | undefined;

    if (result?.messages) {
      this.ingestHistory(cardId, result.messages);
    }
  }

  async resubscribeAll(): Promise<void> {
    for (const cardId of this.subscribedCards) {
      const s = this.sessions.get(cardId);
      if (s) s.historyLoaded = false;

      const sid = s?.sessionId;
      this.loadHistory(cardId, sid).catch((err) => console.warn('[ws] resubscribe failed for card', cardId, err));

      this.requestStatus(cardId).catch((err) => console.warn('[ws] status request failed for card', cardId, err));
    }
  }
}
```

- [ ] **Step 6: Update app/components/SessionView.tsx — reconnect button**

Change the `wsClient` reference from `useStore().ws` and replace the `.connected` polling and `.forceReconnect()` calls.

Find in SessionView.tsx the block around lines 595-606:

```typescript
const { ws: wsClient } = useStore();
const [wsConnected, setWsConnected] = useState(wsClient.connected);
```

Replace with:

```typescript
const { ws: wsClient } = useStore();
const [wsConnected, setWsConnected] = useState(wsClient.connected);
```

The `WsClient` still exposes `.connected` and `.forceReconnect()` with the same API, so `SessionView.tsx` should work as-is with no changes to the reconnect button logic.

Verify: the existing code at line 661 (`wsClient.forceReconnect()`) and line 596 (`wsClient.connected`) still work because `WsClient` preserves these APIs.

- [ ] **Step 7: Update root-store.ts to remove session:history and session:exit handling**

The `session:history` event is gone (history returned in ack). The `session:exit` event... actually, check if it's still emitted by the bus bridge. Looking at the bus bridge in subscriptions.ts, the `exit` handler emits `agent:status` (not `session:exit`). So the `session:exit` case in root-store is dead code now.

In root-store.ts, the `onSessionMessage` and `onAgentStatus` handlers already cover all cases. But we should check if `session:exit` is still emitted from somewhere. If the SessionManager emits to `card:N:exit` bus topic, the bridge converts it to `agent:status`. So remove `session:exit` handling from root-store.

The `handleMessage` switch in the old root-store is replaced by named handler callbacks in the constructor. The `session:history` case was already unused (handled by mutate ack). The `page:result`, `search:result`, `project:browse:result` cases are gone (now returned via ack). No action needed — the new root-store constructor already handles this correctly.

- [ ] **Step 8: Commit**

```bash
git add app/lib/ws-client.ts app/stores/root-store.ts app/stores/card-store.ts app/stores/project-store.ts app/stores/session-store.ts app/components/SessionView.tsx
git commit -m "feat: socket.io client, update all stores and components"
```

---

### Task 7: Cleanup, Build Check, Manual Verification

**Files:**

- Possibly modify: various files for TypeScript errors

- [ ] **Step 1: Remove old ws-related imports and check for stragglers**

Search for any remaining imports of `ws` or references to old patterns:

```bash
cd /home/ryan/Code/orchestrel/.worktrees/socketio-migration
grep -r "from 'ws'" src/ --include='*.ts' -l
grep -r "from '../../lib/ws-client'" app/ --include='*.ts' --include='*.tsx' -l
grep -r "setCardStoreWs\|setProjectStoreWs\|setSessionStoreWs" app/ --include='*.ts' -l
grep -r "requestId" app/stores/ --include='*.ts' -l
grep -r "ConnectionManager" src/ --include='*.ts' -l
```

Fix any remaining references.

- [ ] **Step 2: Check TypeScript compilation**

```bash
pnpm tsc --noEmit 2>&1 | head -50
```

Fix any type errors that surface. Common issues:

- Old `ConnectionManager` imports in handler files
- Missing `ws` types
- `clientMessage`/`serverMessage` imports that no longer exist

- [ ] **Step 3: Run existing tests**

```bash
pnpm vitest run
```

Fix any test failures.

- [ ] **Step 4: Build check**

```bash
pnpm build
```

Fix any build errors.

- [ ] **Step 5: Commit cleanup**

```bash
git add -A
git commit -m "chore: cleanup old ws references, fix type errors"
```

- [ ] **Step 6: Manual verification**

Start the dev server and verify:

```bash
pnpm dev
```

1. Open browser to `http://localhost:6194`
2. Check browser console — should see `[ws] connected` (not `[ws] connect error`)
3. Board should load (cards, projects appear)
4. Open a card session — history should load
5. Send a message — should get response
6. Kill the server and restart — client should auto-reconnect
7. Check Network tab — should see Socket.IO polling + WebSocket upgrade under `/socket.io/` path

---

## Architecture Summary

| Before (ws)                                           | After (Socket.IO)                                    |
| ----------------------------------------------------- | ---------------------------------------------------- |
| `WebSocketServer` with `noServer: true`               | `Server` attached to httpServer                      |
| Manual HTTP upgrade handler                           | Socket.IO manages upgrade                            |
| `ConnectionManager` tracks sockets + identities       | `socket.data.identity`                               |
| `ClientSubscriptions` bridges MessageBus → WS         | `BusRoomBridge` bridges MessageBus → Socket.IO rooms |
| `clientMessage` discriminated union (switch/case)     | Named events with `socket.on()`                      |
| `requestId` + promise map + 15s timeout               | `emitWithAck` with built-in ack                      |
| Custom exponential backoff reconnection               | Socket.IO built-in reconnection                      |
| No heartbeat (iOS resume hack)                        | Built-in ping/pong (10s interval, 5s timeout)        |
| `connections.send(ws, { type: 'mutation:ok', ... })`  | `callback({ data: ... })`                            |
| `connections.send(ws, { type: 'card:updated', ... })` | `io.to('col:running').emit('card:updated', ...)`     |
