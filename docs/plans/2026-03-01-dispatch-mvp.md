# Dispatch MVP Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a personal kanban board with Claude Code orchestration — cards flow through columns, repo-linked cards get git worktrees, and Claude Code sessions stream into the card detail panel.

**Architecture:** React Router 7 (SSR, custom Express server) + tRPC (fetch adapter, SSE subscriptions) + SQLite/Drizzle + Tailwind. Claude Code integration via subprocess spawn with stream-json protocol over stdio. LAN-only, no auth.

**Tech Stack:** React 19, React Router 7, tRPC v11, Drizzle ORM, better-sqlite3, @dnd-kit, Tailwind CSS 4, Express 5

---

## Dependency Graph

```
Task 1: Scaffold
  └─> Task 2: Database Schema
  └─> Task 3: tRPC Setup
        └─> Task 4: Cards Router        ─┐
        └─> Task 5: Repos Router         │
              └─> Task 10: Repo Settings  │
                                          │
        Task 4 ──────────────────────────>│
              └─> Task 6: Kanban Board UI
                    └─> Task 7: Card CRUD UI
                    └─> Task 8: Search
                    └─> Task 9: Card Detail Panel
                                          │
        Task 11: Worktree Mgmt (after 4,5)│
        Task 12: Claude Subprocess (after 3)
              └─> Task 13: Claude tRPC Sub│
                                          │
        Task 9 + Task 13 ───────────────>│
              └─> Task 14: Session UI
              └─> Task 15: Historical Sessions
                                          │
        All ─────────────────────────────>│
              └─> Task 16: Polish
```

**Parallelizable groups after scaffold:**
- Group A: Task 4 (Cards Router) + Task 5 (Repos Router)
- Group B: Task 6 (Board UI) + Task 11 (Worktree) + Task 12 (Claude Subprocess)
- Group C: Task 7 + Task 8 + Task 10 (after their deps)
- Group D: Task 9 + Task 13 + Task 14 + Task 15

---

## Task 1: Project Scaffold

**Files:**
- Create: `package.json`, `vite.config.ts`, `tsconfig.json`, `react-router.config.ts`, `server.js`, `server/app.ts`, `app/root.tsx`, `app/routes.ts`, `app/app.css`, `app/routes/home.tsx`, `.gitignore`

**Steps:**

**Step 1: Scaffold React Router 7 project**

```bash
cd /home/ryan/Code/dispatch
npx create-react-router@latest . --template remix-run/react-router-templates/node-custom-server --yes
```

If the template doesn't work with `.` (existing dir), scaffold into a temp dir and move files.

**Step 2: Install all dependencies upfront**

```bash
pnpm add @trpc/server @trpc/client @trpc/tanstack-react-query @tanstack/react-query superjson zod \
  drizzle-orm better-sqlite3 \
  @dnd-kit/core @dnd-kit/sortable @dnd-kit/utilities

pnpm add -D drizzle-kit @types/better-sqlite3
```

**Step 3: Configure server binding**

In `server.js`, update the listen call:
```javascript
const HOST = '192.168.4.200';
app.listen(PORT, HOST, () => {
  console.log(`Server running on http://${HOST}:${PORT}`);
});
```

In `vite.config.ts`, add server config:
```typescript
server: {
  host: '192.168.4.200',
  hmr: { host: '192.168.4.200' },
},
```

**Step 4: Set up project structure directories**

```bash
mkdir -p src/server/db src/server/routers src/server/claude src/shared app/components app/hooks app/lib
```

**Step 5: Verify dev server starts**

```bash
pnpm dev
# Should be accessible at http://192.168.4.200:3000
```

**Step 6: Commit**

```bash
git add -A
git commit -m "feat: scaffold React Router 7 project with dependencies"
```

---

## Task 2: Database Schema

**Depends on:** Task 1

**Files:**
- Create: `src/server/db/schema.ts`, `src/server/db/index.ts`, `drizzle.config.ts`
- Modify: `package.json` (add db scripts)

**Step 1: Define schema**

Create `src/server/db/schema.ts`:

```typescript
import { integer, text, real, sqliteTable } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const repos = sqliteTable('repos', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().unique(),
  displayName: text('display_name').notNull(),
  path: text('path').notNull(),
  host: text('host', { enum: ['github', 'bitbucket'] }).notNull(),
  setupCommands: text('setup_commands').default(''),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});

export const cards = sqliteTable('cards', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  description: text('description').default(''),
  column: text('column', { enum: ['backlog', 'ready', 'in_progress', 'review', 'done'] }).notNull().default('backlog'),
  position: real('position').notNull().default(0),
  priority: text('priority', { enum: ['low', 'medium', 'high', 'urgent'] }).notNull().default('medium'),
  repoId: integer('repo_id').references(() => repos.id, { onDelete: 'set null' }),
  prUrl: text('pr_url'),
  sessionId: text('session_id'),
  worktreePath: text('worktree_path'),
  worktreeBranch: text('worktree_branch'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
});
```

Note: `position` is `real` for fractional indexing — new cards get position between neighbors (e.g., insert between pos 1.0 and 2.0 → 1.5). Avoids reindexing all cards on every move.

**Step 2: Create DB client**

Create `src/server/db/index.ts`:

```typescript
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';
import { join } from 'path';
import { mkdirSync } from 'fs';

const DB_DIR = join(process.cwd(), 'data');
mkdirSync(DB_DIR, { recursive: true });

const sqlite = new Database(join(DB_DIR, 'dispatch.db'));
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');

export const db = drizzle({ client: sqlite, schema });
```

**Step 3: Drizzle config**

Create `drizzle.config.ts`:

```typescript
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  out: './drizzle',
  schema: './src/server/db/schema.ts',
  dialect: 'sqlite',
  dbCredentials: { url: './data/dispatch.db' },
});
```

**Step 4: Add scripts and push schema**

Add to `package.json` scripts:
```json
"db:push": "drizzle-kit push",
"db:studio": "drizzle-kit studio"
```

```bash
pnpm db:push
```

Add `data/` to `.gitignore`.

**Step 5: Commit**

```bash
git add -A
git commit -m "feat: database schema with cards and repos tables"
```

---

## Task 3: tRPC Setup

**Depends on:** Task 1, Task 2

**Files:**
- Create: `src/server/trpc.ts`, `src/server/routers/index.ts`, `app/routes/api.trpc.$.ts`, `app/lib/trpc.ts`
- Modify: `app/routes.ts`, `app/root.tsx`

**Step 1: tRPC server init**

Create `src/server/trpc.ts`:

```typescript
import { initTRPC } from '@trpc/server';
import superjson from 'superjson';
import { db } from './db';

export function createTRPCContext() {
  return { db };
}

export type TRPCContext = ReturnType<typeof createTRPCContext>;

const t = initTRPC.context<TRPCContext>().create({
  transformer: superjson,
  sse: {
    ping: { enabled: true, intervalMs: 15_000 },
    client: { reconnectAfterInactivityMs: 20_000 },
  },
});

export const router = t.router;
export const publicProcedure = t.procedure;
```

**Step 2: Root router**

Create `src/server/routers/index.ts`:

```typescript
import { router } from '../trpc';

export const appRouter = router({
  // routers added here in subsequent tasks
});

export type AppRouter = typeof appRouter;
```

**Step 3: Resource route handler**

Create `app/routes/api.trpc.$.ts`:

```typescript
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { appRouter } from '~/server/routers/index';
import { createTRPCContext } from '~/server/trpc';
import type { LoaderFunctionArgs, ActionFunctionArgs } from 'react-router';

function handleRequest(args: LoaderFunctionArgs | ActionFunctionArgs) {
  return fetchRequestHandler({
    endpoint: '/api/trpc',
    req: args.request,
    router: appRouter,
    createContext: createTRPCContext,
  });
}

export const loader = (args: LoaderFunctionArgs) => handleRequest(args);
export const action = (args: ActionFunctionArgs) => handleRequest(args);
```

**Step 4: Register route**

In `app/routes.ts`:

```typescript
import { type RouteConfig, route, index } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("api/trpc/*", "routes/api.trpc.$.ts"),
  route("settings/repos", "routes/settings.repos.tsx"),
] satisfies RouteConfig;
```

**Step 5: Client-side tRPC**

Create `app/lib/trpc.ts`:

```typescript
import { createTRPCClient, httpBatchLink, httpSubscriptionLink, splitLink } from '@trpc/client';
import { createTRPCContext } from '@trpc/tanstack-react-query';
import superjson from 'superjson';
import type { AppRouter } from '~/server/routers/index';

function getBaseUrl() {
  if (typeof window !== 'undefined') return window.location.origin;
  return 'http://192.168.4.200:3000';
}

export const { TRPCProvider, useTRPC } = createTRPCContext<AppRouter>();

export function makeTRPCClient() {
  return createTRPCClient<AppRouter>({
    links: [
      splitLink({
        condition: (op) => op.type === 'subscription',
        true: httpSubscriptionLink({
          url: `${getBaseUrl()}/api/trpc`,
          transformer: superjson,
        }),
        false: httpBatchLink({
          url: `${getBaseUrl()}/api/trpc`,
          transformer: superjson,
        }),
      }),
    ],
  });
}
```

**Step 6: Wire providers into root.tsx**

In `app/root.tsx`, wrap `<Outlet />` with:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TRPCProvider, makeTRPCClient } from '~/lib/trpc';
import { useState } from 'react';

// Inside the component:
const [queryClient] = useState(() => new QueryClient());
const [trpcClient] = useState(() => makeTRPCClient());

// Wrap outlet:
<TRPCProvider client={trpcClient} queryClient={queryClient}>
  <QueryClientProvider client={queryClient}>
    <Outlet />
  </QueryClientProvider>
</TRPCProvider>
```

**Step 7: Verify tRPC works**

Temporarily add a test procedure to the root router, hit `/api/trpc/test` in browser, verify JSON response. Remove test procedure.

**Step 8: Commit**

```bash
git add -A
git commit -m "feat: tRPC setup with React Router 7 resource route"
```

---

## Task 4: Cards tRPC Router

**Depends on:** Task 2, Task 3

**Files:**
- Create: `src/server/routers/cards.ts`
- Modify: `src/server/routers/index.ts`

**Step 1: Cards router with CRUD + move operations**

Create `src/server/routers/cards.ts`:

```typescript
import { z } from 'zod';
import { router, publicProcedure } from '../trpc';
import { cards } from '../db/schema';
import { eq } from 'drizzle-orm';

const columnEnum = z.enum(['backlog', 'ready', 'in_progress', 'review', 'done']);
const priorityEnum = z.enum(['low', 'medium', 'high', 'urgent']);

export const cardsRouter = router({
  list: publicProcedure.query(async ({ ctx }) => {
    return ctx.db.select().from(cards).orderBy(cards.position);
  }),

  create: publicProcedure
    .input(z.object({
      title: z.string().min(1),
      description: z.string().optional(),
      column: columnEnum.optional(),
      priority: priorityEnum.optional(),
      repoId: z.number().nullable().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      // Position: put at end of target column
      const existing = await ctx.db.select({ position: cards.position })
        .from(cards)
        .where(eq(cards.column, input.column ?? 'backlog'))
        .orderBy(cards.position);
      const pos = existing.length > 0
        ? existing[existing.length - 1].position + 1
        : 1;
      const [card] = await ctx.db.insert(cards)
        .values({ ...input, position: pos })
        .returning();
      return card;
    }),

  update: publicProcedure
    .input(z.object({
      id: z.number(),
      title: z.string().min(1).optional(),
      description: z.string().optional(),
      priority: priorityEnum.optional(),
      repoId: z.number().nullable().optional(),
      prUrl: z.string().nullable().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const { id, ...data } = input;
      const [card] = await ctx.db.update(cards)
        .set({ ...data, updatedAt: new Date().toISOString() })
        .where(eq(cards.id, id))
        .returning();
      return card;
    }),

  move: publicProcedure
    .input(z.object({
      id: z.number(),
      column: columnEnum,
      position: z.number(),
    }))
    .mutation(async ({ ctx, input }) => {
      const [card] = await ctx.db.update(cards)
        .set({
          column: input.column,
          position: input.position,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(cards.id, input.id))
        .returning();
      return card;
    }),

  delete: publicProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db.delete(cards).where(eq(cards.id, input.id));
    }),
});
```

**Step 2: Register in root router**

In `src/server/routers/index.ts`:

```typescript
import { router } from '../trpc';
import { cardsRouter } from './cards';

export const appRouter = router({
  cards: cardsRouter,
});
```

**Step 3: Verify**

```bash
pnpm dev
# Test: curl http://192.168.4.200:3000/api/trpc/cards.list
```

**Step 4: Commit**

```bash
git add -A
git commit -m "feat: cards tRPC router with CRUD and move"
```

---

## Task 5: Repos tRPC Router

**Depends on:** Task 2, Task 3
**Can run parallel with:** Task 4

**Files:**
- Create: `src/server/routers/repos.ts`
- Modify: `src/server/routers/index.ts`

**Step 1: Repos router with CRUD + directory browser**

Create `src/server/routers/repos.ts`:

```typescript
import { z } from 'zod';
import { router, publicProcedure } from '../trpc';
import { repos } from '../db/schema';
import { eq } from 'drizzle-orm';
import { readdir } from 'fs/promises';
import { join } from 'path';

export const reposRouter = router({
  list: publicProcedure.query(async ({ ctx }) => {
    return ctx.db.select().from(repos);
  }),

  create: publicProcedure
    .input(z.object({
      name: z.string().min(1),
      displayName: z.string().min(1),
      path: z.string().min(1),
      host: z.enum(['github', 'bitbucket']),
      setupCommands: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const [repo] = await ctx.db.insert(repos).values(input).returning();
      return repo;
    }),

  update: publicProcedure
    .input(z.object({
      id: z.number(),
      name: z.string().min(1).optional(),
      displayName: z.string().min(1).optional(),
      path: z.string().min(1).optional(),
      host: z.enum(['github', 'bitbucket']).optional(),
      setupCommands: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const { id, ...data } = input;
      const [repo] = await ctx.db.update(repos)
        .set(data)
        .where(eq(repos.id, id))
        .returning();
      return repo;
    }),

  delete: publicProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db.delete(repos).where(eq(repos.id, input.id));
    }),

  // Directory browser for selecting repo paths
  browse: publicProcedure
    .input(z.object({ path: z.string() }))
    .query(async ({ input }) => {
      try {
        const entries = await readdir(input.path, { withFileTypes: true });
        const dirs = entries
          .filter(e => e.isDirectory() && !e.name.startsWith('.'))
          .map(e => ({
            name: e.name,
            path: join(input.path, e.name),
          }))
          .sort((a, b) => a.name.localeCompare(b.name));
        const isGitRepo = entries.some(e => e.name === '.git' && e.isDirectory());
        return { dirs, isGitRepo, currentPath: input.path };
      } catch {
        return { dirs: [], isGitRepo: false, currentPath: input.path, error: 'Cannot read directory' };
      }
    }),
});
```

**Step 2: Register in root router**

Add to `src/server/routers/index.ts`:

```typescript
import { reposRouter } from './repos';

export const appRouter = router({
  cards: cardsRouter,
  repos: reposRouter,
});
```

**Step 3: Commit**

```bash
git add -A
git commit -m "feat: repos tRPC router with CRUD and directory browser"
```

---

## Task 6: Kanban Board UI

**Depends on:** Task 4

**Files:**
- Create: `app/components/Board.tsx`, `app/components/Column.tsx`, `app/components/Card.tsx`
- Modify: `app/routes/home.tsx`

This is the core UI. Uses @dnd-kit for drag-and-drop with the multi-container pattern.

**Key architecture:**
- `Board` component owns dnd-kit `DndContext` and all drag state
- `Column` wraps `SortableContext` for vertical card sorting
- `Card` uses `useSortable` for individual drag behavior
- State: cards grouped by column from tRPC query, optimistic updates on drag
- Position calculation: fractional indexing — when dropping between two cards, new position = average of neighbors

**Card position calculation helper:**

```typescript
function calcPosition(cards: { position: number }[], targetIndex: number): number {
  if (cards.length === 0) return 1;
  if (targetIndex === 0) return cards[0].position - 1;
  if (targetIndex >= cards.length) return cards[cards.length - 1].position + 1;
  return (cards[targetIndex - 1].position + cards[targetIndex].position) / 2;
}
```

**dnd-kit setup details:**
- Sensors: `PointerSensor` with `activationConstraint: { distance: 5 }` (distinguish click from drag), `KeyboardSensor`
- Collision detection: custom — `pointerWithin` first, fallback to `rectIntersection`, then `closestCenter` within the hovered column
- `MeasuringStrategy.Always` on droppable (re-measure during layout shifts)
- `DragOverlay` via `createPortal` for smooth drag preview
- `onDragOver`: handle cross-column moves (move card to new column array)
- `onDragEnd`: handle within-column reorder + persist via `cards.move` mutation
- `onDragCancel`: restore pre-drag snapshot

**Column component:**
- Fixed columns: `['backlog', 'ready', 'in_progress', 'review', 'done']`
- Display names: `Backlog`, `Ready`, `In Progress`, `Review`, `Done`
- Each column wraps its cards in `SortableContext` with `verticalListSortingStrategy`
- `min-h` on card container so empty columns accept drops
- Column count badge in header

**Card component:**
- Shows: title, repo badge (small colored pill with repo name if linked), priority indicator (colored left border)
- Priority colors: `urgent=red, high=orange, medium=blue, low=gray`
- Click opens detail panel (Task 9)
- `useSortable` for drag behavior
- Faded at 40% opacity when `isDragging` (ghost placeholder)

**Step 1: Build Board, Column, Card components**

Follow the dnd-kit multi-container pattern. Wire `cards.list` query for data, `cards.move` mutation on drag end.

**Step 2: Wire into home route**

`app/routes/home.tsx` renders `<Board />` as the main view.

**Step 3: Verify drag-and-drop works**

Manually create cards via the API, verify they render in columns, drag between columns, verify position persists on page reload.

**Step 4: Commit**

```bash
git add -A
git commit -m "feat: kanban board with drag-and-drop columns"
```

---

## Task 7: Card CRUD UI

**Depends on:** Task 6

**Files:**
- Modify: `app/components/Board.tsx`, `app/components/Column.tsx`
- Create: `app/components/AddCardForm.tsx`

**Add card:**
- Quick-add button at top of Backlog column (or any column)
- Clicking shows inline form: text input for title, enter to submit, escape to cancel
- Creates card in that column via `cards.create` mutation
- After creation, optimistically add to the column

**Delete card:**
- Delete button on card hover (small X icon) or in detail panel
- Confirmation not needed for MVP — it's a personal tool

**Edit card:**
- Handled in the detail panel (Task 9) — click card to open panel, edit title/description there

**Step 1: Build AddCardForm component**

Inline form with text input. Submit calls `cards.create`. Auto-focus on open.

**Step 2: Add to Column header**

Plus button in column header toggles AddCardForm.

**Step 3: Add delete to Card**

Hover reveals X button. Calls `cards.delete` mutation.

**Step 4: Commit**

```bash
git add -A
git commit -m "feat: add and delete cards from board"
```

---

## Task 8: Search

**Depends on:** Task 6

**Files:**
- Create: `app/components/SearchBar.tsx`
- Modify: `app/components/Board.tsx`

**Search bar:**
- Fixed at top of board, above columns
- Filters cards client-side by title and description (case-insensitive substring match)
- When search is active, non-matching cards are hidden (not removed from DOM — just `hidden` class or filter)
- Clear button (X) to reset search
- Keyboard shortcut `/` to focus search (Task 16)

**Step 1: Build SearchBar component**

Text input with search icon. Passes filter string up to Board via callback.

**Step 2: Apply filter in Board**

Board passes filtered card IDs to Column components. Columns only render matching cards.

**Step 3: Commit**

```bash
git add -A
git commit -m "feat: search bar to filter cards"
```

---

## Task 9: Card Detail Panel

**Depends on:** Task 6, Task 4

**Files:**
- Create: `app/components/CardDetailPanel.tsx`
- Modify: `app/components/Card.tsx` (click handler), `app/components/Board.tsx` (panel state)

**Panel behavior:**
- Desktop: slide-out panel from right side, ~400px wide, overlays board
- Mobile: full-screen modal
- Same component, responsive sizing via Tailwind (`fixed inset-y-0 right-0 w-full sm:w-[420px]`)
- Backdrop click or Escape closes panel
- URL doesn't change (panel state is local)

**Panel content by column:**

**Backlog / Ready:**
- Editable title (text input, blur or enter to save)
- Editable description (textarea, blur to save)
- Repo selector dropdown (from `repos.list` query, nullable)
- Priority selector (dropdown: low/medium/high/urgent)

**In Progress:**
- Read-only title and description
- If repo linked: Claude session area (placeholder for Task 14)
- If no repo: just description

**Review:**
- Read-only title and description
- PR URL field (text input, saves on blur, opens in new tab icon)
- Session output (read-only, placeholder for Task 15)

**Done:**
- Read-only everything
- PR link (if set)
- Session log (placeholder for Task 15)

**Step 1: Build CardDetailPanel**

Single component with column-aware rendering. Uses `cards.update` mutation for field changes.

**Step 2: Wire into Board**

Board tracks `selectedCardId` state. Card click sets it. Panel renders when set.

**Step 3: Verify responsive behavior**

Test slide-out on desktop, full-screen on mobile viewport.

**Step 4: Commit**

```bash
git add -A
git commit -m "feat: card detail panel with column-aware content"
```

---

## Task 10: Repo Settings Page

**Depends on:** Task 5

**Files:**
- Create: `app/routes/settings.repos.tsx`, `app/components/RepoForm.tsx`, `app/components/DirectoryBrowser.tsx`
- Modify: `app/routes.ts` (already has route registered)

**Settings page layout:**
- `/settings/repos` route
- Navigation: link in board header (gear icon)
- Lists all repos with edit/delete
- "Add repo" button opens form

**Repo form:**
- Name (text input, used as slug)
- Display name (text input, shown in UI)
- Path (selected via directory browser, not typed)
- Host (dropdown: GitHub / Bitbucket)
- Setup commands (textarea — bash commands run in worktree after creation, e.g. `yarn install`, `cp .env.example .env`)

**Directory browser component:**
- Starts at `/home/ryan` (or `/`)
- Shows subdirectories only (no files)
- Hidden dirs (starting with `.`) are excluded
- Click directory to navigate into it
- Breadcrumb path at top for navigation
- "Select" button when current directory is a git repo (indicated by `.git` presence)
- Uses `repos.browse` query

**Step 1: Build DirectoryBrowser component**

Fetches directory listing via `repos.browse`. Renders as a simple list. Breadcrumb navigation. Highlights git repos.

**Step 2: Build RepoForm component**

Form with all fields. Directory browser for path selection. Setup commands as a `<textarea>` with monospace font.

**Step 3: Build settings page**

Lists repos, add/edit/delete actions. Each repo row shows name, path, host badge.

**Step 4: Add navigation link**

Gear icon in board header links to `/settings/repos`. Back link on settings page returns to `/`.

**Step 5: Commit**

```bash
git add -A
git commit -m "feat: repo settings page with directory browser"
```

---

## Task 11: Worktree Management

**Depends on:** Task 4, Task 5

**Files:**
- Create: `src/server/worktree.ts`
- Modify: `src/server/routers/cards.ts` (hook into move mutation)

**Worktree lifecycle:**

**Create (card moves to `in_progress`):**
1. Card must have a `repoId`
2. Derive branch name: `dispatch/card-{id}-{slug}` (slug from title, kebab-case, max 30 chars)
3. Worktree path: `{repo.path}/.worktrees/dispatch-{card.id}`
4. Run: `git worktree add {worktreePath} -b {branchName}` from repo root
5. Run repo's `setupCommands` in worktree (if any) — execute each line as a shell command with cwd = worktree path
6. Update card record with `worktreePath` and `worktreeBranch`

**Cleanup (card moves to `done`):**
1. Run: `git worktree remove {worktreePath}` from repo root
2. Optionally delete branch: `git branch -d {branchName}` (only if merged)
3. Clear `worktreePath` and `worktreeBranch` on card

**Edge cases:**
- Worktree path already exists → reuse it, skip creation
- Repo path doesn't exist → error, don't move card
- Card has no repo → skip worktree, just move card

**Implementation:**

Create `src/server/worktree.ts`:

```typescript
import { execFileSync } from 'child_process';

export function createWorktree(repoPath: string, worktreePath: string, branch: string): void {
  execFileSync('git', ['worktree', 'add', worktreePath, '-b', branch], {
    cwd: repoPath,
    stdio: 'pipe',
  });
}

export function removeWorktree(repoPath: string, worktreePath: string): void {
  execFileSync('git', ['worktree', 'remove', worktreePath, '--force'], {
    cwd: repoPath,
    stdio: 'pipe',
  });
}

export function runSetupCommands(worktreePath: string, commands: string): void {
  if (!commands.trim()) return;
  // Run setup commands as a bash script
  execFileSync('/bin/bash', ['-c', commands], {
    cwd: worktreePath,
    stdio: 'pipe',
    timeout: 120_000,
  });
}

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 30);
}
```

**Modify cards.move mutation** to trigger worktree create/cleanup when column changes to/from `in_progress` or `done`.

**Step 1: Build worktree module**

**Step 2: Integrate with cards.move**

**Step 3: Test manually**

Create a repo, create a card linked to it, move to In Progress, verify worktree created. Move to Done, verify cleanup.

**Step 4: Commit**

```bash
git add -A
git commit -m "feat: git worktree management on card column transitions"
```

---

## Task 12: Claude Code Subprocess Manager

**Depends on:** Task 3

**Files:**
- Create: `src/server/claude/manager.ts`, `src/server/claude/protocol.ts`, `src/server/claude/types.ts`

This is the core subprocess integration. Manages spawning, tracking, and communicating with Claude Code processes.

**`src/server/claude/types.ts`** — TypeScript types for the stream-json protocol:

Define types for:
- `SystemInitMessage` — `{ type: "system", subtype: "init", session_id, model, tools, cwd }`
- `AssistantMessage` — `{ type: "assistant", message: { content: ContentBlock[] }, session_id }`
- `UserMessage` — `{ type: "user", message: { content: ToolResult[] }, session_id }`
- `ResultMessage` — `{ type: "result", subtype: "success"|"error_*", result?, total_cost_usd, usage }`
- `StreamEvent` — `{ type: "stream_event", event: { type, delta? }, session_id }`
- `ControlRequest` — `{ type: "control_request", request_id, request: { subtype: "can_use_tool", tool_name, input } }`
- `ControlResponse` — `{ type: "control_response", response: { subtype: "success", request_id, response } }`
- `ToolProgress` — `{ type: "tool_progress", tool_name, elapsed_time_seconds }`
- Union type `ClaudeMessage` of all the above

**`src/server/claude/protocol.ts`** — Protocol handler:

```typescript
import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { createInterface } from 'readline';

export class ClaudeSession extends EventEmitter {
  process: ChildProcess | null = null;
  sessionId: string | null = null;
  status: 'starting' | 'running' | 'completed' | 'errored' = 'starting';

  constructor(
    private cwd: string,
    private initialPrompt: string,
  ) {
    super();
  }

  async start(): Promise<void> {
    this.process = spawn('claude', [
      '-p',
      '--output-format=stream-json',
      '--input-format=stream-json',
      '--verbose',
      '--permission-mode=bypassPermissions',
    ], {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    const rl = createInterface({ input: this.process.stdout! });

    rl.on('line', (line) => {
      try {
        const msg = JSON.parse(line);
        this.handleMessage(msg);
      } catch {
        // non-JSON line, ignore
      }
    });

    this.process.stderr?.on('data', (data) => {
      this.emit('stderr', data.toString());
    });

    this.process.on('exit', (code) => {
      this.status = code === 0 ? 'completed' : 'errored';
      this.emit('exit', code);
    });

    // Send initialize control request
    this.send({
      type: 'control_request',
      request_id: `req_1_${Date.now().toString(16)}`,
      request: { subtype: 'initialize' },
    });
  }

  private handleMessage(msg: unknown): void {
    const m = msg as Record<string, unknown>;

    // Capture session ID from init message
    if (m.type === 'system' && m.subtype === 'init') {
      this.sessionId = m.session_id as string;
      this.status = 'running';
    }

    // Auto-approve tool use requests
    if (m.type === 'control_request') {
      const req = m as { request_id: string; request: { subtype: string } };
      if (req.request.subtype === 'can_use_tool') {
        this.send({
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: req.request_id,
            response: { behavior: 'allow' },
          },
        });
      }
      return; // Don't emit control messages to client
    }

    // Track completion
    if (m.type === 'result') {
      this.status = 'completed';
    }

    // Emit all other messages to listeners
    this.emit('message', m);
  }

  sendUserMessage(content: string): void {
    this.send({
      type: 'user',
      message: { role: 'user', content },
    });
  }

  private send(data: unknown): void {
    if (this.process?.stdin?.writable) {
      this.process.stdin.write(JSON.stringify(data) + '\n');
    }
  }

  kill(): void {
    this.process?.kill('SIGTERM');
  }
}
```

**`src/server/claude/manager.ts`** — Session manager:

```typescript
import { ClaudeSession } from './protocol';

class SessionManager {
  private sessions = new Map<string, ClaudeSession>();

  create(cardId: number, cwd: string, prompt: string): ClaudeSession {
    const key = `card-${cardId}`;
    const existing = this.sessions.get(key);
    if (existing && existing.status === 'running') {
      throw new Error(`Session already running for card ${cardId}`);
    }
    const session = new ClaudeSession(cwd, prompt);
    this.sessions.set(key, session);
    return session;
  }

  get(cardId: number): ClaudeSession | undefined {
    return this.sessions.get(`card-${cardId}`);
  }

  kill(cardId: number): void {
    const session = this.sessions.get(`card-${cardId}`);
    session?.kill();
    this.sessions.delete(`card-${cardId}`);
  }
}

export const sessionManager = new SessionManager();
```

**Step 1: Define types**

**Step 2: Build protocol handler (ClaudeSession)**

**Step 3: Build session manager**

**Step 4: Test manually**

Spawn a session in a test directory, verify messages are received and parsed.

**Step 5: Commit**

```bash
git add -A
git commit -m "feat: Claude Code subprocess manager with stream-json protocol"
```

---

## Task 13: Claude tRPC Subscription

**Depends on:** Task 12, Task 4

**Files:**
- Create: `src/server/routers/claude.ts`
- Modify: `src/server/routers/index.ts`

**tRPC router for Claude sessions:**

```typescript
import { z } from 'zod';
import { router, publicProcedure } from '../trpc';
import { tracked } from '@trpc/server';
import { sessionManager } from '../claude/manager';
import { cards } from '../db/schema';
import { eq } from 'drizzle-orm';

export const claudeRouter = router({
  start: publicProcedure
    .input(z.object({
      cardId: z.number(),
      prompt: z.string().min(1),
    }))
    .mutation(async ({ ctx, input }) => {
      const [card] = await ctx.db.select().from(cards).where(eq(cards.id, input.cardId));
      if (!card?.worktreePath) throw new Error('Card has no worktree');

      const session = sessionManager.create(input.cardId, card.worktreePath, input.prompt);
      await session.start();

      // Update card with session ID once available
      session.on('message', (msg: Record<string, unknown>) => {
        if (msg.type === 'system' && msg.subtype === 'init') {
          ctx.db.update(cards)
            .set({ sessionId: msg.session_id as string })
            .where(eq(cards.id, input.cardId))
            .run();
        }
      });

      session.sendUserMessage(input.prompt);
      return { status: 'started' };
    }),

  sendMessage: publicProcedure
    .input(z.object({
      cardId: z.number(),
      message: z.string().min(1),
    }))
    .mutation(({ input }) => {
      const session = sessionManager.get(input.cardId);
      if (!session) throw new Error('No active session');
      session.sendUserMessage(input.message);
      return { status: 'sent' };
    }),

  // SSE subscription for streaming output
  onMessage: publicProcedure
    .input(z.object({ cardId: z.number() }))
    .subscription(async function* ({ input, signal }) {
      const session = sessionManager.get(input.cardId);
      if (!session) return;

      let counter = 0;
      const queue: unknown[] = [];
      let resolve: (() => void) | null = null;

      const onMessage = (msg: unknown) => {
        queue.push(msg);
        resolve?.();
      };

      session.on('message', onMessage);

      try {
        while (!signal?.aborted && session.status !== 'completed' && session.status !== 'errored') {
          if (queue.length === 0) {
            await new Promise<void>((r) => { resolve = r; });
          }
          while (queue.length > 0) {
            yield tracked(String(counter++), queue.shift());
          }
        }
      } finally {
        session.off('message', onMessage);
      }
    }),

  status: publicProcedure
    .input(z.object({ cardId: z.number() }))
    .query(({ input }) => {
      const session = sessionManager.get(input.cardId);
      return {
        active: !!session,
        status: session?.status ?? 'none',
        sessionId: session?.sessionId,
      };
    }),

  stop: publicProcedure
    .input(z.object({ cardId: z.number() }))
    .mutation(({ input }) => {
      sessionManager.kill(input.cardId);
      return { status: 'stopped' };
    }),
});
```

**Step 1: Build claude router**

**Step 2: Register in root router**

**Step 3: Test end-to-end**

Start a session via mutation, subscribe to output, verify messages stream.

**Step 4: Commit**

```bash
git add -A
git commit -m "feat: tRPC Claude session router with SSE subscription"
```

---

## Task 14: Session UI

**Depends on:** Task 9, Task 13

**Files:**
- Create: `app/components/SessionView.tsx`, `app/components/MessageBlock.tsx`, `app/components/ToolUseBlock.tsx`
- Modify: `app/components/CardDetailPanel.tsx`

**Session view in card detail panel (In Progress state):**

**Layout:**
- Scrollable message area (flex-grow, overflow-y-auto)
- Input box at bottom (fixed, flex-shrink-0)
- Status indicator (running/completed/errored) at top

**Message rendering:**
- `assistant` messages: render `message.content` blocks
  - `text` blocks: render as plain text
  - `tool_use` blocks: render as collapsible `<ToolUseBlock>` — shows tool name as header, input as code block on expand
- `user` messages with `tool_result`: match to their `tool_use` and render as the "output" inside the collapsible block
- `stream_event` messages: accumulate `text_delta` events into current text block for live typing effect
- `result` messages: show final status (success/error, cost, duration)
- `tool_progress` messages: show elapsed time indicator on the active tool

**ToolUseBlock component:**
- Header: tool name + tool name (e.g., "Bash", "Read", "Edit")
- Collapsed by default unless actively running
- Expand shows: input (formatted), output (formatted)
- Active tool shows spinner + elapsed time

**Input box:**
- Text input + send button
- Calls `claude.sendMessage` mutation
- Disabled when no active session

**Status indicator:**
- Running: green dot + "Claude is working..."
- Completed: checkmark + "Session completed" + cost
- Errored: red dot + "Session errored"

**Step 1: Build MessageBlock component**

**Step 2: Build ToolUseBlock component**

**Step 3: Build SessionView with subscription**

Subscribe to `claude.onMessage`, render messages as they arrive. Auto-scroll to bottom.

**Step 4: Wire into CardDetailPanel**

Show SessionView in panel when card is In Progress and has a repo.

**Step 5: Commit**

```bash
git add -A
git commit -m "feat: session UI with streaming Claude output"
```

---

## Task 15: Historical Session Loading

**Depends on:** Task 9, Task 12

**Files:**
- Create: `src/server/routers/sessions.ts`
- Modify: `src/server/routers/index.ts`, `app/components/CardDetailPanel.tsx`

**Loading session logs from Claude's native log files:**

Session logs stored at: `~/.claude/projects/{encoded-project-path}/{session-id}.jsonl`

Project path encoding: replace `/` with `-`, prepend `-`.
Example: `/home/ryan/Code/myrepo/.worktrees/dispatch-5` → `-home-ryan-Code-myrepo--worktrees-dispatch-5`

**tRPC procedure:**

```typescript
import { z } from 'zod';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { execFileSync } from 'child_process';

// In sessions router:
loadSession: publicProcedure
  .input(z.object({ sessionId: z.string().uuid() }))
  .query(async ({ input }) => {
    const claudeProjectsDir = join(homedir(), '.claude', 'projects');
    const result = execFileSync(
      'find', [claudeProjectsDir, '-maxdepth', '2', '-name', `${input.sessionId}.jsonl`, '-type', 'f'],
      { encoding: 'utf-8' }
    ).trim();

    if (!result) throw new Error('Session log not found');

    const content = await readFile(result, 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    const messages = lines.map(line => {
      try { return JSON.parse(line); }
      catch { return null; }
    }).filter(Boolean);

    // Filter to assistant and user messages only
    return messages.filter((m: Record<string, unknown>) =>
      m.type === 'assistant' || m.type === 'user'
    );
  }),
```

**Wire into CardDetailPanel:**
- Review/Done columns: if card has `sessionId`, load session via `sessions.loadSession` query
- Render with same `MessageBlock` / `ToolUseBlock` components (read-only, no input box)

**Step 1: Build sessions router**

**Step 2: Wire into card detail panel for Review/Done states**

**Step 3: Test with a real session ID**

**Step 4: Commit**

```bash
git add -A
git commit -m "feat: load historical Claude session logs"
```

---

## Task 16: Polish

**Depends on:** All previous tasks

**Files:**
- Modify: various
- Create: `dispatch.service` (systemd)

**Sub-tasks:**

**16a: Keyboard shortcuts**
- `/` → focus search bar
- `n` → open add card form in Backlog
- `Escape` → close detail panel, cancel add form, blur search
- Use `useEffect` with `keydown` listener, guard against input focus

**16b: Loading states**
- Skeleton cards while board loads
- Spinner on card move (optimistic but show if slow)
- Loading indicator on detail panel

**16c: Error boundaries**
- React error boundary around Board
- tRPC error handling with toast notifications

**16d: Empty states**
- "No cards yet" in empty columns
- "No repos configured" on settings page with link to add

**16e: systemd service**

Create `dispatch.service`:

```ini
[Unit]
Description=Dispatch Kanban
After=network.target

[Service]
Type=simple
User=ryan
WorkingDirectory=/home/ryan/Code/dispatch
ExecStart=/usr/bin/node server.js
Environment=NODE_ENV=production
Environment=PORT=3000
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

**16f: Mobile responsive**
- Board: horizontal scroll on mobile (columns in a row, swipeable)
- Detail panel: full-screen modal on mobile

**Step 1-6: Implement each sub-task, commit after each**

---

## Execution Notes for Swarm

**Sequential (must be done in order):**
1. Task 1 (Scaffold) → Task 2 (DB) → Task 3 (tRPC)

**After Task 3, these groups can run in parallel:**

| Agent | Tasks | Notes |
|-------|-------|-------|
| Agent A | Task 4 → Task 6 → Task 7 → Task 8 | Cards API + Board UI + Card CRUD + Search |
| Agent B | Task 5 → Task 10 | Repos API + Settings Page |
| Agent C | Task 11 | Worktree management (needs Tasks 4+5 schema, can start after DB) |
| Agent D | Task 12 → Task 13 | Claude subprocess + tRPC subscription |

**After parallel agents complete:**
- Task 9 (Card Detail Panel) — needs Board UI from Agent A
- Task 14 (Session UI) — needs Detail Panel + Claude subscription
- Task 15 (Historical Sessions) — needs Detail Panel + Claude types
- Task 16 (Polish) — after everything
