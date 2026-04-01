# User Roles & Project Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add scoped visibility so each user only sees cards from their assigned projects, with admin seeing everything.

**Architecture:** Extract user identity from CF Access JWT on WS connection. New `users` and `project_users` tables. Server filters sync payloads and scopes real-time broadcasts by user's visible projects. Frontend conditionally hides admin-only UI (settings).

**Tech Stack:** TypeORM entities, Zod schemas, MobX stores, SQLite, CF Access JWT (jose)

**Spec:** `docs/superpowers/specs/2026-03-31-user-roles-visibility-design.md`

---

## File Structure

### New files

- `src/server/models/User.ts` — User entity + ProjectUser entity
- `src/server/services/user.ts` — User find-or-create, role sync, project assignment queries

### Modified files

- `src/server/models/index.ts` — Register new entities, add schema creation migration
- `src/server/ws/auth.ts` — Return `UserIdentity` instead of boolean
- `src/server/ws/connections.ts` — Map WebSocket → UserIdentity
- `src/server/ws/handlers.ts` — Thread user identity through subscribe, scope sync + broadcasts
- `src/server/ws/server.ts` — Pass `req` to connection event for identity extraction
- `src/server/init.ts` — Same changes as server.ts for production path
- `src/shared/ws-protocol.ts` — Add user/users fields to sync, userIds to project update
- `src/server/services/project.ts` — Add updateProjectUsers method
- `src/server/ws/handlers/projects.ts` — Handle userIds in project:update
- `app/stores/root-store.ts` — Store currentUser from sync, pass users to project store
- `app/stores/project-store.ts` — Store users list (admin only)
- `app/routes/settings.projects.tsx` — Hide for non-admin
- `app/components/ProjectForm.tsx` — Add user assignment multi-select (admin only)
- `app/routes/board.tsx` — Conditionally show/hide settings button

---

### Task 1: Create User and ProjectUser entities

**Files:**

- Create: `src/server/models/User.ts`
- Modify: `src/server/models/index.ts:14-15` (add entities)

- [ ] **Step 1: Create User.ts with User and ProjectUser entities**

```typescript
// src/server/models/User.ts
import { Entity, PrimaryGeneratedColumn, Column, BaseEntity } from 'typeorm';

@Entity({ name: 'users' })
export class User extends BaseEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'text', unique: true })
  email!: string;

  @Column({ type: 'text', default: 'user' })
  role!: string;

  @Column({ name: 'created_at', type: 'text' })
  createdAt!: string;
}

@Entity({ name: 'project_users' })
export class ProjectUser extends BaseEntity {
  @Column({ name: 'project_id', type: 'integer', primary: true })
  projectId!: number;

  @Column({ name: 'user_id', type: 'integer', primary: true })
  userId!: number;
}
```

- [ ] **Step 2: Register entities in DataSource**

In `src/server/models/index.ts`, add imports and register:

```typescript
// Add to imports (line 5-6):
import { User, ProjectUser } from './User';

// Update entities array (line 14):
entities: [Card, Project, User, ProjectUser],
```

- [ ] **Step 3: Add table creation to initDatabase()**

In `src/server/models/index.ts`, after the color migration block (after line 51), add:

```typescript
// Create users and project_users tables if they don't exist
await runner.query(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL DEFAULT 'user',
    created_at TEXT NOT NULL
  )
`);
await runner.query(`
  CREATE TABLE IF NOT EXISTS project_users (
    project_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    PRIMARY KEY (project_id, user_id),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )
`);
```

Note: move the `await runner.release()` call to after these new queries.

- [ ] **Step 4: Verify the app starts without errors**

Run: `pnpm build` (or restart dev server)
Expected: No TypeORM errors, tables created on first run.

- [ ] **Step 5: Commit**

```bash
git add src/server/models/User.ts src/server/models/index.ts
git commit -m "feat: add User and ProjectUser entities with schema migration"
```

---

### Task 2: Create user service

**Files:**

- Create: `src/server/services/user.ts`

- [ ] **Step 1: Create user service with find-or-create and role sync**

```typescript
// src/server/services/user.ts
import { User } from '../models/User';
import { ProjectUser } from '../models/User';
import { In } from 'typeorm';

const ADMIN_EMAILS = (process.env.ADMIN_EMAILS ?? '')
  .split(',')
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

export interface UserIdentity {
  id: number;
  email: string;
  role: 'admin' | 'user';
}

/** Synthetic identity for local/LAN connections (no DB record) */
export const LOCAL_ADMIN: UserIdentity = { id: 0, email: 'local', role: 'admin' };

class UserService {
  /**
   * Find or create a user by email. Syncs role from ADMIN_EMAILS env var
   * on every call so promotions take effect on reconnect.
   */
  async findOrCreate(email: string): Promise<UserIdentity> {
    const normalized = email.toLowerCase();
    const role = ADMIN_EMAILS.includes(normalized) ? 'admin' : 'user';

    let user = await User.findOneBy({ email: normalized });
    if (!user) {
      user = User.create({
        email: normalized,
        role,
        createdAt: new Date().toISOString(),
      }) as User;
      await user.save();
      console.log(`[user] created user: ${normalized} (${role})`);
    } else if (user.role !== role) {
      user.role = role;
      await user.save();
      console.log(`[user] updated role for ${normalized}: ${role}`);
    }

    return { id: user.id, email: user.email, role: role as 'admin' | 'user' };
  }

  /** Get project IDs visible to a user. Admins see all. */
  async visibleProjectIds(identity: UserIdentity): Promise<number[] | 'all'> {
    if (identity.role === 'admin') return 'all';
    const rows = await ProjectUser.findBy({ userId: identity.id });
    return rows.map((r) => r.projectId);
  }

  /** Get all users (for admin UI) */
  async listUsers(): Promise<Array<{ id: number; email: string; role: string }>> {
    const users = await User.find({ order: { email: 'ASC' } });
    return users.map((u) => ({ id: u.id, email: u.email, role: u.role }));
  }

  /** Get user IDs assigned to a project */
  async projectUserIds(projectId: number): Promise<number[]> {
    const rows = await ProjectUser.findBy({ projectId });
    return rows.map((r) => r.userId);
  }

  /** Replace project user assignments (admin only) */
  async setProjectUsers(projectId: number, userIds: number[]): Promise<void> {
    // Delete existing
    await ProjectUser.delete({ projectId });
    // Insert new
    if (userIds.length > 0) {
      const rows = userIds.map((userId) => ({ projectId, userId }));
      await ProjectUser.insert(rows);
    }
  }
}

export const userService = new UserService();
```

- [ ] **Step 2: Commit**

```bash
git add src/server/services/user.ts
git commit -m "feat: add user service with find-or-create, role sync, visibility queries"
```

---

### Task 3: Update auth to return user identity

**Files:**

- Modify: `src/server/ws/auth.ts`

- [ ] **Step 1: Change validateCfAccess to return identity info**

Replace the current `validateCfAccess` function. It should return `{ valid: boolean; email?: string }` instead of just `boolean`. The key change is extracting the email from the JWT payload at line 51 instead of discarding it:

```typescript
// src/server/ws/auth.ts — replace the entire exported function

export interface AuthResult {
  valid: boolean;
  email?: string;
  isLocal: boolean;
}

export async function validateCfAccess(req: IncomingMessage): Promise<AuthResult> {
  if (process.env.NODE_ENV === 'development') return { valid: true, isLocal: true };

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
    const email = (payload as Record<string, unknown>).email as string | undefined;
    return { valid: true, email: email ?? undefined, isLocal: false };
  } catch (err) {
    console.log('[ws:auth] JWT verify failed:', err instanceof Error ? err.message : err);
    return { valid: false, isLocal: false };
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/server/ws/auth.ts
git commit -m "feat: auth returns email from CF JWT instead of bare boolean"
```

---

### Task 4: Update ConnectionManager to track user identity

**Files:**

- Modify: `src/server/ws/connections.ts`

- [ ] **Step 1: Add user identity mapping to ConnectionManager**

Replace the entire file:

```typescript
// src/server/ws/connections.ts
import type { WebSocket } from 'ws';
import type { ServerMessage } from '../../shared/ws-protocol';
import type { UserIdentity } from '../services/user';

export class ConnectionManager {
  private connections = new Set<WebSocket>();
  private identities = new Map<WebSocket, UserIdentity>();

  get size() {
    return this.connections.size;
  }

  add(ws: WebSocket, identity: UserIdentity) {
    this.connections.add(ws);
    this.identities.set(ws, identity);
  }

  remove(ws: WebSocket) {
    this.connections.delete(ws);
    this.identities.delete(ws);
  }

  getIdentity(ws: WebSocket): UserIdentity | undefined {
    return this.identities.get(ws);
  }

  /** Get all connections that can see a given project ID */
  connectionsForProject(projectId: number): WebSocket[] {
    const result: WebSocket[] = [];
    for (const [ws, identity] of this.identities) {
      if (identity.role === 'admin') {
        result.push(ws);
      }
      // For non-admin, caller must check project_users — this method
      // only handles the admin shortcut. Use withVisibility() for full check.
    }
    return result;
  }

  send(ws: WebSocket, msg: ServerMessage) {
    if (ws.readyState === 1) ws.send(JSON.stringify(msg));
  }
}
```

Note: The `connectionsForProject` method above is a partial helper — full visibility checks happen in the handler layer using `userService.visibleProjectIds()`. Remove `connectionsForProject` if it proves unnecessary during implementation.

- [ ] **Step 2: Update all callers of `connections.add(ws)` to pass identity**

In `src/server/ws/server.ts` (line 22), the `wss.on('connection')` handler needs the identity. We need to pass `req` through the connection event. Update `createWsServer`:

```typescript
// src/server/ws/server.ts — update createWsServer function
// The wss.on('connection') callback receives (ws, req) — req is passed via handleUpgrade

wss.on('connection', async (ws, req) => {
  const { validateCfAccess: validate } = await import('./auth');
  const { userService, LOCAL_ADMIN } = await import('../services/user');

  // Identity was already validated in upgrade handler — extract it here
  const auth = await validate(req);
  let identity: import('../services/user').UserIdentity;
  if (auth.isLocal || !auth.email) {
    identity = LOCAL_ADMIN;
  } else {
    identity = await userService.findOrCreate(auth.email);
  }

  connections.add(ws, identity);
  console.log(`[ws] connection opened: ${identity.email} (${identity.role})`);

  ws.on('message', (raw) => {
    try {
      const data = JSON.parse(raw.toString());
      handleMessage(ws, data, connections);
    } catch (err) {
      console.error('WS message parse error:', err);
    }
  });

  ws.on('close', () => {
    clientSubs.unsubscribeAll(ws);
    connections.remove(ws);
  });
});
```

Wait — the current `createWsServer` takes `handleMessage` and `clientSubs` as params but doesn't have access to `req` in the right place. Actually, looking at `server.ts:176-178`, the `wss.emit('connection', ws, req)` already passes `req` as the second arg. So the `wss.on('connection', (ws, req) => ...)` callback already receives it — it's just not used today.

The challenge is that `createWsServer` is a standalone function. We need to restructure it slightly so the connection handler can resolve identity. The simplest approach: instead of resolving identity in the connection handler, resolve it in the upgrade handler and stash it on the request object.

Better approach — resolve identity in the upgrade handler (where we already validate CF Access) and attach it to `req`:

In `src/server/ws/server.ts`, update the upgrade handler (lines 164-179):

```typescript
// In the upgrade handler, after validateCfAccess:
const auth = await validateCfAccess(req);
if (!auth.valid) {
  socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
  socket.destroy();
  return;
}

// Resolve identity and stash on req for the connection handler
const { userService, LOCAL_ADMIN } = await import('../services/user');
const identity = auth.isLocal || !auth.email ? LOCAL_ADMIN : await userService.findOrCreate(auth.email);
(req as Record<string, unknown>).__userIdentity = identity;

wss!.handleUpgrade(req, socket, head, (ws) => {
  wss!.emit('connection', ws, req);
});
```

Then in `createWsServer`, update the connection handler:

```typescript
wss.on('connection', (ws, req) => {
  const identity = (req as Record<string, unknown>).__userIdentity as import('../services/user').UserIdentity;
  connections.add(ws, identity);
  console.log(`[ws] connection: ${identity.email} (${identity.role})`);

  // ... rest unchanged
});
```

Update `createWsServer` signature to accept `req` in the connection callback — actually, `wss.on('connection')` already receives `(ws, req)` by default from the ws library. Just update the callback signature.

- [ ] **Step 3: Apply the same changes to `src/server/init.ts`**

The production path in `init.ts` (lines 102-116 for connection, lines 118-133 for upgrade) needs identical changes:

Upgrade handler (line 119-131): Add identity resolution after `validateCfAccess`, stash on req.
Connection handler (line 102-116): Read identity from req, pass to `connections.add(ws, identity)`.

- [ ] **Step 4: Verify the app starts and connections work**

Restart dev server, open the app. Check console for `[ws] connection: local (admin)` log.

- [ ] **Step 5: Commit**

```bash
git add src/server/ws/connections.ts src/server/ws/server.ts src/server/init.ts
git commit -m "feat: track user identity per WebSocket connection"
```

---

### Task 5: Update WS protocol schemas

**Files:**

- Modify: `src/shared/ws-protocol.ts`

- [ ] **Step 1: Add user schema and update sync message**

Add a user schema near the top of the file (after `projectSchema`, around line 46):

```typescript
export const userSchema = z.object({
  id: z.number(),
  email: z.string(),
  role: z.string(),
});

export type User = z.infer<typeof userSchema>;
```

Update the `sync` server message (lines 242-247) to include user identity:

```typescript
z.object({
  type: z.literal('sync'),
  cards: z.array(cardSchema),
  projects: z.array(projectSchema),
  providers: z.record(z.string(), providerConfigSchema),
  user: userSchema,
  users: z.array(userSchema).optional(),
}),
```

- [ ] **Step 2: Add userIds to project update schema**

Update `projectUpdateSchema` (line 84) to accept optional `userIds`:

```typescript
export const projectUpdateSchema = z
  .object({ id: z.number(), userIds: z.array(z.number()).optional() })
  .merge(projectCreateSchema.partial());
```

- [ ] **Step 3: Add userIds to project schema for sync**

Add optional `userIds` to the project schema so the sync payload can include assignment info (admin only):

```typescript
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
```

- [ ] **Step 4: Commit**

```bash
git add src/shared/ws-protocol.ts
git commit -m "feat: add user schema, user/users to sync, userIds to project"
```

---

### Task 6: Scope the subscribe handler

**Files:**

- Modify: `src/server/ws/handlers.ts:43-113`

This is the critical change — filtering the sync payload and scoping broadcast subscriptions.

- [ ] **Step 1: Update the subscribe case to filter by user visibility**

Replace the subscribe case (lines 43-113) in `handleMessage`:

```typescript
case 'subscribe': {
  const cols = msg.columns;
  const identity = connections.getIdentity(ws);
  if (!identity) break;

  // Resolve visible projects for this user
  const { userService } = await import('../services/user');
  const visible = await userService.visibleProjectIds(identity);

  // Fetch cards and projects, filtered by visibility
  const [allCards, allProjects] = await Promise.all([
    cardService.listCards(cols.length > 0 ? cols : undefined),
    projectService.listProjects(),
  ]);

  const cards = visible === 'all'
    ? allCards
    : allCards.filter((c) => c.projectId != null && visible.includes(c.projectId));

  const projects = visible === 'all'
    ? allProjects
    : allProjects.filter((p) => visible.includes(p.id));

  // For admin, attach userIds to each project and include full user list
  let users: Array<{ id: number; email: string; role: string }> | undefined;
  const projectsWithUsers = projects as unknown as Card[]; // will be cast properly
  if (identity.role === 'admin') {
    users = await userService.listUsers();
    // Attach userIds to each project for the admin UI
    for (const p of projects) {
      (p as Record<string, unknown>).userIds = await userService.projectUserIds(p.id);
    }
  }

  connections.send(ws, {
    type: 'sync',
    cards: cards as unknown as Card[],
    projects: projects as unknown as Project[],
    providers: getProvidersForClient(),
    user: { id: identity.id, email: identity.email, role: identity.role },
    users,
  });

  // Subscribe to board:changed — forward only if card's project is visible
  clientSubs.subscribe(ws, 'board:changed', (payload) => {
    const { card, oldColumn, newColumn, id } = payload as {
      card: CardEntity | null;
      oldColumn: string | null;
      newColumn: string | null;
      id?: number;
    };
    if (!card) {
      if (id) connections.send(ws, { type: 'card:deleted', data: { id } });
      return;
    }

    // Check project visibility
    if (visible !== 'all' && (card.projectId == null || !visible.includes(card.projectId))) {
      return;
    }

    const relevant =
      cols.length === 0 ||
      (oldColumn && cols.includes(oldColumn as never)) ||
      (newColumn && cols.includes(newColumn as never));
    if (relevant) {
      connections.send(ws, { type: 'card:updated', data: card as Card });
    }
  });

  // Subscribe to project updates — only for visible projects
  const projectsToSubscribe = visible === 'all'
    ? allProjects
    : allProjects.filter((p) => visible.includes(p.id));

  for (const p of projectsToSubscribe) {
    clientSubs.subscribe(ws, `project:${p.id}:updated`, (payload) => {
      connections.send(ws, {
        type: 'project:updated',
        data: payload as import('../../shared/ws-protocol').Project,
      });
    });
    clientSubs.subscribe(ws, `project:${p.id}:deleted`, (payload) => {
      connections.send(ws, { type: 'project:deleted', data: payload as { id: number } });
    });
  }

  // Subscribe to system errors
  clientSubs.subscribe(ws, 'system:error', (payload) => {
    const { message } = payload as { message: string };
    connections.send(ws, {
      type: 'agent:message',
      cardId: -1,
      data: {
        type: 'error',
        role: 'system',
        content: message,
        timestamp: Date.now(),
      },
    });
  });

  break;
}
```

Note: The `handleMessage` function needs to become `async` (or the subscribe case needs to be wrapped in a `Promise` block). Since other cases already use `.then()` chains, wrapping the subscribe case in a self-invoking async is cleanest:

```typescript
case 'subscribe': {
  void (async () => {
    // ... all the above code
  })();
  break;
}
```

- [ ] **Step 2: Handle visibility caveat for board:changed**

The `visible` variable captured in the subscribe closure is a snapshot. If a user gets added to a new project, the `board:changed` handler won't know about it until the user reconnects. This is fine because the spec says assignment changes trigger a fresh `sync` — so the user will get re-subscribed.

No code change needed — just documenting the behavior.

- [ ] **Step 3: Verify cards are still synced correctly for local connections**

Restart dev server, verify the board loads with all cards (local = admin).

- [ ] **Step 4: Commit**

```bash
git add src/server/ws/handlers.ts
git commit -m "feat: scope subscribe sync and broadcasts by user visibility"
```

---

### Task 7: Handle userIds in project:update

**Files:**

- Modify: `src/server/ws/handlers/projects.ts`
- Modify: `src/server/services/project.ts` (optional — or handle in handler directly)

- [ ] **Step 1: Update the project update handler to process userIds**

In `src/server/ws/handlers/projects.ts`, find the `handleProjectUpdate` function. After the existing project update logic, add user assignment handling:

```typescript
// In handleProjectUpdate, after the project is saved:
const { userIds, ...projectData } = msg.data;

// Update the project with projectData (without userIds)
const project = await projectService.updateProject(projectData.id, projectData);

// If admin sent userIds, update project user assignments
if (userIds !== undefined) {
  const identity = connections.getIdentity(ws);
  if (identity?.role === 'admin') {
    const { userService } = await import('../../services/user');
    await userService.setProjectUsers(projectData.id, userIds);

    // Trigger re-sync for all connected clients affected by the change
    // (New approach: just re-sync everyone — simple and correct)
    // TODO: This could be optimized to only re-sync affected users
  }
}

connections.send(ws, { type: 'mutation:ok', requestId: msg.requestId, data: project });
```

Read the existing `handleProjectUpdate` first to see the exact structure before modifying.

- [ ] **Step 2: Commit**

```bash
git add src/server/ws/handlers/projects.ts src/server/services/project.ts
git commit -m "feat: handle userIds in project:update for user assignment"
```

---

### Task 8: Frontend — store user identity and users list

**Files:**

- Modify: `app/stores/root-store.ts`
- Modify: `app/stores/project-store.ts`

- [ ] **Step 1: Add currentUser to RootStore**

In `app/stores/root-store.ts`, add a `currentUser` observable:

```typescript
import { makeAutoObservable } from 'mobx';
import type { User } from '../../src/shared/ws-protocol';

// In the RootStore class:
currentUser: User | null = null;

// In the constructor, make it observable:
constructor() {
  // ... existing code
  makeAutoObservable(this, {}, { autoBind: true });
  // Or just add currentUser as an observable field
}
```

Wait — `RootStore` doesn't use `makeAutoObservable`. The stores are separate MobX stores. The simplest approach: add `currentUser` as a plain property on `RootStore` (it doesn't need to be reactive since it's set once on sync and doesn't change).

Actually, for the settings button visibility to react to `currentUser`, it should be observable. Add MobX:

```typescript
import { makeAutoObservable } from 'mobx';

export class RootStore {
  currentUser: { id: number; email: string; role: string } | null = null;
  // ... existing fields

  constructor() {
    makeAutoObservable(this, {
      ws: false,
      cards: false,
      config: false,
      projects: false,
      sessions: false,
    });
    // ... rest of constructor
  }
}
```

Update `handleMessage` for the sync case (lines 39-43):

```typescript
case 'sync':
  this.currentUser = msg.user;
  this.cards.hydrate(msg.cards, true);
  this.projects.hydrate(msg.projects, true, msg.users);
  this.config.hydrate(msg.providers);
  break;
```

- [ ] **Step 2: Add users list to ProjectStore**

In `app/stores/project-store.ts`, add a `users` observable for the admin user list:

```typescript
// Add to the class:
users: Array<{ id: number; email: string; role: string }> = [];

// Update hydrate to accept users:
hydrate(items: unknown[], replace = false, users?: Array<{ id: number; email: string; role: string }>) {
  if (replace) this.projects.clear();
  for (const p of items) {
    const project = p as Project;
    this.projects.set(project.id, project);
  }
  if (users) this.users = users;
}
```

- [ ] **Step 3: Commit**

```bash
git add app/stores/root-store.ts app/stores/project-store.ts
git commit -m "feat: store currentUser and users list from sync"
```

---

### Task 9: Frontend — conditionally hide settings button

**Files:**

- Modify: `app/routes/board.tsx`

- [ ] **Step 1: Hide settings button for non-admin users**

In `board.tsx`, the settings button is around line 316-324. Wrap it in a role check:

```tsx
{
  store.currentUser?.role === 'admin' && (
    <Button onClick={() => setActiveModal('settings')} title="Settings">
      <Settings className="size-5" />
    </Button>
  );
}
```

Make sure the `store` is accessed via `useStore()` and the component is wrapped with MobX `observer`.

- [ ] **Step 2: Commit**

```bash
git add app/routes/board.tsx
git commit -m "feat: hide settings button for non-admin users"
```

---

### Task 10: Frontend — user assignment multi-select in ProjectForm

**Files:**

- Modify: `app/components/ProjectForm.tsx`
- Modify: `app/routes/settings.projects.tsx`

- [ ] **Step 1: Add user assignment UI to ProjectForm**

In `ProjectForm.tsx`, after the existing form fields (around line 219), add a user assignment section. This should only render when the user is admin:

```tsx
// Get users from project store
const projectStore = useProjectStore();
const store = useStore();

// Only show for admin
{
  store.currentUser?.role === 'admin' && (
    <div className="space-y-2">
      <label className="text-xs font-medium text-white/60">Assigned Users</label>
      <div className="space-y-1">
        {projectStore.users.map((u) => (
          <label key={u.id} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={selectedUserIds.includes(u.id)}
              onChange={() => toggleUser(u.id)}
              className="rounded"
            />
            <span>{u.email}</span>
            {u.role === 'admin' && <span className="text-xs text-white/40">(admin)</span>}
          </label>
        ))}
        {projectStore.users.length === 0 && <p className="text-xs text-white/40">No users have connected yet</p>}
      </div>
    </div>
  );
}
```

Add state for `selectedUserIds` initialized from the project's `userIds` field:

```tsx
const [selectedUserIds, setSelectedUserIds] = useState<number[]>(
  ((project as Record<string, unknown>)?.userIds as number[]) ?? [],
);

function toggleUser(id: number) {
  setSelectedUserIds((prev) => (prev.includes(id) ? prev.filter((uid) => uid !== id) : [...prev, id]));
}
```

Include `userIds: selectedUserIds` in the form submission data sent via `project:update`.

- [ ] **Step 2: Update ProjectStore.updateProject to pass userIds**

In `app/stores/project-store.ts`, update the `updateProject` method's data type to accept optional `userIds: number[]` and include it in the WS message.

- [ ] **Step 3: Verify the settings modal works**

Open settings, edit a project, see the user checkboxes (will be empty until users connect via CF Access). Save and verify no errors.

- [ ] **Step 4: Commit**

```bash
git add app/components/ProjectForm.tsx app/stores/project-store.ts app/routes/settings.projects.tsx
git commit -m "feat: add user assignment multi-select in project settings"
```

---

### Task 11: End-to-end verification

- [ ] **Step 1: Verify local admin flow**

1. Start dev server
2. Open app at localhost — should see all projects, all cards
3. Settings button visible
4. Open settings, edit a project — user assignment section visible (may be empty)

- [ ] **Step 2: Verify sync includes user identity**

Open browser devtools, check WS messages. The `sync` message should include `user: { id: 0, email: 'local', role: 'admin' }` and `users: [...]`.

- [ ] **Step 3: Test with ADMIN_EMAILS env var**

Set `ADMIN_EMAILS=test@example.com` and restart. Local access should still be admin. (Remote testing requires CF Access tunnel.)

- [ ] **Step 4: Commit any fixes**

```bash
git add -A
git commit -m "fix: end-to-end verification fixes"
```
