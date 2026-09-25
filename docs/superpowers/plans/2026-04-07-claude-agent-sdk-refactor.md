# Claude Agent SDK Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace OpenCode daemon + `@opencode-ai/sdk` with `@anthropic-ai/claude-agent-sdk` and claude-code-router (CCR), rewriting the session layer with native SDK types throughout.

**Architecture:** SessionManager holds V1 `Query` objects directly (no abstract class). Consumer loops iterate async generators, publishing SDK messages to the event bus. CCR custom router parses model name prefix (`provider:model`) for per-session provider routing with 429 failover.

**Tech Stack:** `@anthropic-ai/claude-agent-sdk`, `@anthropic-ai/claude-code`, claude-code-router (musistudio), TypeScript, MobX, Zod

**Spec:** `docs/superpowers/specs/2026-04-07-claude-agent-sdk-refactor-design.md`

---

## File Structure

### New Files

| File                                     | Responsibility                                               |
| ---------------------------------------- | ------------------------------------------------------------ |
| `src/server/sessions/types.ts`           | ActiveSession interface, SessionStatus type, SessionOpts     |
| `src/server/sessions/manager.ts`         | SessionManager: Query lifecycle, start/stop/follow-up/resume |
| `src/server/sessions/consumer.ts`        | consumeSession loop: iterate Query, filter, publish to bus   |
| `src/server/sessions/worktree.ts`        | ensureWorktree helper (extracted from services/session.ts)   |
| `~/.claude-code-router/custom-router.js` | CCR custom router: prefix parsing + failover                 |
| `app/lib/sdk-types.ts`                   | Frontend SDK message type definitions (mirrors SDK shapes)   |
| `app/lib/message-accumulator.ts`         | Builds renderable state from streaming SDK messages          |

### Modified Files

| File                                 | Changes                                                                                       |
| ------------------------------------ | --------------------------------------------------------------------------------------------- |
| `package.json`                       | Remove `@opencode-ai/sdk`, add `@anthropic-ai/claude-agent-sdk` + `@anthropic-ai/claude-code` |
| `providers.json`                     | Simplified: remove `ocProviderID`, key = CCR prefix                                           |
| `src/shared/ws-protocol.ts`          | Replace `agentMessageSchema` with SDK message passthrough, new WS message types               |
| `src/server/init-state.ts`           | Add SessionManager to persistent state                                                        |
| `src/server/config/providers.ts`     | Remove `getOcProviderID`, simplify types                                                      |
| `src/server/models/Card.ts`          | Add `provider` column                                                                         |
| `src/server/bus.ts`                  | Update topic type comments, add `card:${id}:sdk`                                              |
| `src/server/controllers/oc.ts`       | Replace wireSession with consumer-based event handling, update autoStart/worktreeCleanup      |
| `src/server/services/queue-gate.ts`  | Import new SessionManager, call `manager.start()`                                             |
| `src/server/ws/handlers.ts`          | Add `session:set-model` dispatch                                                              |
| `src/server/ws/handlers/agents.ts`   | Call new SessionManager methods                                                               |
| `src/server/ws/handlers/sessions.ts` | Use Agent SDK `getSessionMessages()` for history                                              |
| `src/server/ws/server.ts`            | Remove OpenCode server init, use new SessionManager                                           |
| `app/stores/session-store.ts`        | Rewrite ingest/ingestBatch for SDK message types                                              |
| `app/stores/root-store.ts`           | Route `session:message`/`session:status`/`session:exit`                                       |
| `app/components/MessageBlock.tsx`    | Render SDK content blocks instead of AgentMessage                                             |
| `app/components/SessionView.tsx`     | Add provider dropdown, update streaming detection                                             |
| `app/components/SubagentFeed.tsx`    | Handle `task_*` SDK messages                                                                  |

### Deleted Files

| File                                | Reason                             |
| ----------------------------------- | ---------------------------------- |
| `src/server/agents/` (entire dir)   | Replaced by `src/server/sessions/` |
| `src/server/opencode/` (entire dir) | No external daemon                 |
| `src/server/services/session.ts`    | Merged into SessionManager         |

---

## Task 1: Install Dependencies + CCR Setup

**Files:**

- Modify: `package.json`
- Create: `~/.claude-code-router/custom-router.js`

- [ ] **Step 1: Install Agent SDK packages**

```bash
cd /home/ryan/Code/orchestrel
pnpm remove @opencode-ai/sdk
pnpm add @anthropic-ai/claude-agent-sdk @anthropic-ai/claude-code
```

- [ ] **Step 2: Verify Agent SDK imports resolve**

```bash
cd /home/ryan/Code/orchestrel
node -e "const { query } = await import('@anthropic-ai/claude-agent-sdk'); console.log('query:', typeof query)"
```

Expected: `query: function`

- [ ] **Step 3: Install CCR globally**

```bash
npm i -g claude-code-router
```

- [ ] **Step 4: Create CCR custom router**

Write `~/.claude-code-router/custom-router.js`:

```javascript
// Orchestrel CCR Custom Router
// Parses provider prefix from model name: "trackable:claude-opus-4-6"
// Routes to the matching CCR provider entry.

const primaryProvider = {
  trackable: 'trackable-1',
  okkanti: 'okkanti',
  anthropic: 'anthropic',
};

module.exports = async function router(req, config) {
  const model = req.body.model;
  if (!model || !model.includes(':')) return null;

  const colonIdx = model.indexOf(':');
  const provider = model.slice(0, colonIdx);
  const actualModel = model.slice(colonIdx + 1);

  // Rewrite model to strip prefix before forwarding
  req.body.model = actualModel;

  const ccrProvider = primaryProvider[provider] ?? provider;
  return `${ccrProvider},${actualModel}`;
};
```

- [ ] **Step 5: Configure CCR**

Ensure `~/.claude-code-router/config.json` has the `CUSTOM_ROUTER_PATH` set and at least the `anthropic` provider entry. The provider entries for `trackable-1`, `trackable-2`, `okkanti` are added as needed — they're account-specific.

```json
{
  "PORT": 3456,
  "CUSTOM_ROUTER_PATH": "~/.claude-code-router/custom-router.js",
  "Providers": [
    {
      "name": "anthropic",
      "api_base_url": "https://api.anthropic.com/v1/messages",
      "api_key": "$ANTHROPIC_API_KEY"
    }
  ]
}
```

- [ ] **Step 6: Verify model prefix passthrough**

Start CCR (`ccr start`), then test that a prefixed model name flows through:

```bash
node -e "
const { query } = await import('@anthropic-ai/claude-agent-sdk');
const q = query({
  prompt: 'Say hello in exactly 3 words.',
  options: {
    model: 'anthropic:claude-sonnet-4-6',
    maxTurns: 1,
    permissionMode: 'bypassPermissions',
    env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:3456' },
  }
});
for await (const msg of q) {
  if (msg.type === 'result') { console.log('SUCCESS:', msg.result); break; }
  if (msg.type === 'system') console.log('init:', msg.session_id);
}
"
```

If this errors on model validation, we fall back to the system prompt approach per the spec's risk section.

- [ ] **Step 7: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore: swap @opencode-ai/sdk for @anthropic-ai/claude-agent-sdk"
```

---

## Task 2: Server Session Types

**Files:**

- Create: `src/server/sessions/types.ts`

- [ ] **Step 1: Create the sessions directory**

```bash
mkdir -p src/server/sessions
```

- [ ] **Step 2: Write session types**

Write `src/server/sessions/types.ts`:

```typescript
import type { Query } from '@anthropic-ai/claude-agent-sdk';

export type SessionStatus = 'starting' | 'running' | 'completed' | 'errored' | 'stopped' | 'retry';

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ActiveSession {
  cardId: number;
  query: Query;
  sessionId: string | null;
  provider: string;
  model: string;
  status: SessionStatus;
  promptsSent: number;
  turnsCompleted: number;
  turnCost: number;
  turnUsage: Usage | null;
  cwd: string;
}

export interface SessionStartOpts {
  provider: string;
  model: string;
  cwd: string;
  resume?: string;
}
```

- [ ] **Step 3: Verify types compile**

```bash
cd /home/ryan/Code/orchestrel && npx tsc --noEmit src/server/sessions/types.ts
```

- [ ] **Step 4: Commit**

```bash
git add src/server/sessions/types.ts
git commit -m "feat: add session types for Agent SDK refactor"
```

---

## Task 3: Worktree Helper Extraction

**Files:**

- Create: `src/server/sessions/worktree.ts`
- Reference: `src/server/services/session.ts:23-71` (current `ensureWorktree`)

- [ ] **Step 1: Extract ensureWorktree to its own module**

Read `src/server/services/session.ts` lines 23-71 for the current `ensureWorktree` implementation. Write `src/server/sessions/worktree.ts` with the same logic, importing `createWorktree` from `../worktree` and Card/Project from the models:

```typescript
import { createWorktree, worktreeExists } from '../worktree';
import { Card } from '../models/Card';
import { Project } from '../models/Project';
import { AppDataSource } from '../models/index';
import { spawnSync } from 'child_process';

/**
 * Ensures the card has a valid worktree directory.
 * Reuses existing worktree if path is valid, creates new one otherwise.
 * Runs project setup commands if configured.
 * Returns the working directory path for the session.
 */
export async function ensureWorktree(card: Card): Promise<string> {
  const repo = AppDataSource.getRepository(Card);

  if (!card.projectId) return process.cwd();

  const project = await AppDataSource.getRepository(Project).findOneBy({ id: card.projectId });
  if (!project) return process.cwd();

  // Non-worktree cards work directly in the project directory
  if (!card.useWorktree) return project.path;

  // Reuse existing worktree if the path is still valid
  if (card.worktreePath && worktreeExists(card.worktreePath)) {
    return card.worktreePath;
  }

  // Create a new worktree
  const branchName = `card-${card.id}`;
  const baseBranch = card.sourceBranch ?? project.defaultBranch ?? 'main';
  const wtPath = createWorktree(project.path, branchName, baseBranch);

  card.worktreePath = wtPath;
  card.worktreeBranch = branchName;
  if (!card.sourceBranch) card.sourceBranch = baseBranch as 'main' | 'dev';
  await repo.save(card);

  // Run setup commands if configured
  if (project.setupCommands) {
    for (const cmd of project.setupCommands.split('\n').filter(Boolean)) {
      const parts = cmd.trim().split(/\s+/);
      const bin = parts[0];
      const args = parts.slice(1);
      try {
        spawnSync(bin, args, { cwd: wtPath, stdio: 'pipe', timeout: 60_000 });
      } catch (err) {
        console.warn(`[worktree] setup command failed: ${cmd}`, err);
      }
    }
  }

  return wtPath;
}
```

Note: Read the actual `ensureWorktree` implementation from `services/session.ts` to match its exact behavior — the above is a template. Adjust imports and logic to match.

- [ ] **Step 2: Verify compilation**

```bash
cd /home/ryan/Code/orchestrel && npx tsc --noEmit src/server/sessions/worktree.ts
```

- [ ] **Step 3: Commit**

```bash
git add src/server/sessions/worktree.ts
git commit -m "refactor: extract ensureWorktree to sessions module"
```

---

## Task 4: Consumer Loop

**Files:**

- Create: `src/server/sessions/consumer.ts`

The consumer loop iterates over a `Query` async generator, filters messages, updates session state, and publishes to the event bus. This is the core replacement for the 800-line `OpenCodeSession`.

- [ ] **Step 1: Write the consumer loop**

Write `src/server/sessions/consumer.ts`:

```typescript
import type { ActiveSession } from './types';
import { messageBus } from '../bus';

/** SDK message types to forward to the UI */
const FORWARD_TYPES = new Set([
  'system',
  'stream_event',
  'assistant',
  'result',
  'tool_progress',
  'tool_use_summary',
  'task_started',
  'task_progress',
  'task_notification',
  'rate_limit',
  'status',
]);

/**
 * Consumes the SDK Query async generator for a session.
 * Updates session state, publishes forwarded messages to the bus.
 * Runs as a fire-and-forget async task — one per active session.
 */
export async function consumeSession(session: ActiveSession, onExit: (session: ActiveSession) => void): Promise<void> {
  const { cardId } = session;
  const log = (msg: string) => console.log(`[session:${session.sessionId ?? cardId}] ${msg}`);

  try {
    for await (const msg of session.query) {
      const sdkMsg = msg as Record<string, unknown>;

      switch (sdkMsg.type) {
        case 'system': {
          const sys = sdkMsg as { subtype?: string; session_id?: string };
          if (sys.subtype === 'init' && sys.session_id) {
            session.sessionId = sys.session_id;
            session.status = 'running';
            log(`init sessionId=${sys.session_id}`);
            messageBus.publish(`card:${cardId}:status`, {
              active: true,
              status: session.status,
              sessionId: session.sessionId,
              promptsSent: session.promptsSent,
              turnsCompleted: session.turnsCompleted,
            });
          }
          break;
        }

        case 'assistant':
        case 'stream_event':
          if (session.status !== 'running') {
            session.status = 'running';
            messageBus.publish(`card:${cardId}:status`, {
              active: true,
              status: 'running',
              sessionId: session.sessionId,
              promptsSent: session.promptsSent,
              turnsCompleted: session.turnsCompleted,
            });
          }
          break;

        case 'result': {
          const result = sdkMsg as {
            subtype?: string;
            total_cost_usd?: number;
            usage?: Record<string, unknown>;
            num_turns?: number;
            duration_ms?: number;
          };
          session.turnsCompleted++;
          session.turnCost = result.total_cost_usd ?? 0;
          session.status = 'completed';
          log(`result subtype=${result.subtype} cost=$${session.turnCost} turns=${session.turnsCompleted}`);
          messageBus.publish(`card:${cardId}:status`, {
            active: false,
            status: 'completed',
            sessionId: session.sessionId,
            promptsSent: session.promptsSent,
            turnsCompleted: session.turnsCompleted,
          });
          break;
        }

        case 'rate_limit':
          session.status = 'retry';
          log('rate_limit');
          messageBus.publish(`card:${cardId}:status`, {
            active: true,
            status: 'retry',
            sessionId: session.sessionId,
            promptsSent: session.promptsSent,
            turnsCompleted: session.turnsCompleted,
          });
          break;

        default:
          break;
      }

      // Forward displayable messages to UI subscribers
      if (FORWARD_TYPES.has(sdkMsg.type as string)) {
        messageBus.publish(`card:${cardId}:sdk`, sdkMsg);
      }
    }
  } catch (err) {
    log(`consumer error: ${err}`);
    session.status = 'errored';
    messageBus.publish(`card:${cardId}:sdk`, {
      type: 'error',
      message: String(err),
      timestamp: Date.now(),
    });
  } finally {
    log(`consumer exited (status=${session.status})`);
    messageBus.publish(`card:${cardId}:exit`, {
      sessionId: session.sessionId,
      status: session.status,
    });
    onExit(session);
  }
}
```

- [ ] **Step 2: Verify compilation**

```bash
cd /home/ryan/Code/orchestrel && npx tsc --noEmit src/server/sessions/consumer.ts
```

- [ ] **Step 3: Commit**

```bash
git add src/server/sessions/consumer.ts
git commit -m "feat: add SDK consumer loop for session messages"
```

---

## Task 5: SessionManager

**Files:**

- Create: `src/server/sessions/manager.ts`

- [ ] **Step 1: Write SessionManager**

Write `src/server/sessions/manager.ts`:

```typescript
import { query, type Query } from '@anthropic-ai/claude-agent-sdk';
import type { ActiveSession, SessionStartOpts } from './types';
import { consumeSession } from './consumer';
import { ensureWorktree } from './worktree';
import { Card } from '../models/Card';
import { AppDataSource } from '../models/index';

export class SessionManager {
  private sessions = new Map<number, ActiveSession>();

  async start(cardId: number, prompt: string, opts: SessionStartOpts): Promise<ActiveSession> {
    // If session already active, send as follow-up instead
    const existing = this.sessions.get(cardId);
    if (existing && (existing.status === 'running' || existing.status === 'starting' || existing.status === 'retry')) {
      this.sendFollowUp(cardId, prompt);
      return existing;
    }

    // Load card and ensure worktree
    const card = await AppDataSource.getRepository(Card).findOneByOrFail({ id: cardId });
    const cwd = await ensureWorktree(card);

    const modelStr = `${opts.provider}:${opts.model}`;
    const q = query({
      prompt,
      options: {
        model: modelStr,
        cwd,
        permissionMode: 'bypassPermissions',
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        settingSources: ['user', 'project'],
        includePartialMessages: true,
        ...(opts.resume ? { resume: opts.resume } : {}),
        env: {
          ANTHROPIC_BASE_URL: process.env.CCR_URL ?? 'http://127.0.0.1:3456',
          ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? '',
        },
      },
    });

    const session: ActiveSession = {
      cardId,
      query: q,
      sessionId: null,
      provider: opts.provider,
      model: opts.model,
      status: 'starting',
      promptsSent: 1,
      turnsCompleted: 0,
      turnCost: 0,
      turnUsage: null,
      cwd,
    };

    this.sessions.set(cardId, session);

    // Fire-and-forget consumer loop
    consumeSession(session, (s) => this.sessions.delete(s.cardId));

    return session;
  }

  sendFollowUp(cardId: number, message: string): void {
    const session = this.sessions.get(cardId);
    if (!session) throw new Error(`No active session for card ${cardId}`);

    session.promptsSent++;
    session.status = 'starting';

    session.query.streamInput(
      (async function* () {
        yield {
          type: 'user' as const,
          content: [{ type: 'text' as const, text: message }],
        };
      })(),
    );
  }

  stop(cardId: number): void {
    const session = this.sessions.get(cardId);
    if (!session) return;

    console.log(`[session:${session.sessionId ?? cardId}] stop requested`);
    session.status = 'stopped';
    session.query.interrupt();
  }

  setModel(cardId: number, provider: string, model: string): void {
    const session = this.sessions.get(cardId);
    if (!session) return;

    const modelStr = `${provider}:${model}`;
    session.query.setModel(modelStr);
    session.provider = provider;
    session.model = model;
    console.log(`[session:${session.sessionId ?? cardId}] model changed to ${modelStr}`);
  }

  get(cardId: number): ActiveSession | undefined {
    return this.sessions.get(cardId);
  }

  has(cardId: number): boolean {
    return this.sessions.has(cardId);
  }

  isActive(cardId: number): boolean {
    const s = this.sessions.get(cardId);
    if (!s) return false;
    return s.status === 'starting' || s.status === 'running' || s.status === 'retry';
  }
}
```

- [ ] **Step 2: Verify compilation**

```bash
cd /home/ryan/Code/orchestrel && npx tsc --noEmit src/server/sessions/manager.ts
```

- [ ] **Step 3: Commit**

```bash
git add src/server/sessions/manager.ts
git commit -m "feat: add SessionManager with Agent SDK Query lifecycle"
```

---

## Task 6: Provider Config Simplification

**Files:**

- Modify: `providers.json`
- Modify: `src/server/config/providers.ts`
- Modify: `src/shared/ws-protocol.ts` (providerConfigSchema)

- [ ] **Step 1: Update providers.json**

Replace current `providers.json` with simplified format (no `ocProviderID`, key = CCR prefix):

```json
{
  "providers": {
    "anthropic": {
      "label": "Anthropic",
      "models": {
        "sonnet": { "label": "Sonnet 4.6", "modelID": "claude-sonnet-4-6", "contextWindow": 200000 },
        "opus": { "label": "Opus 4.6", "modelID": "claude-opus-4-6", "contextWindow": 200000 }
      }
    },
    "trackable": {
      "label": "Trackable",
      "models": {
        "sonnet": { "label": "Sonnet 4.6", "modelID": "claude-sonnet-4-6", "contextWindow": 200000 },
        "opus": { "label": "Opus 4.6", "modelID": "claude-opus-4-6", "contextWindow": 200000 }
      }
    },
    "okkanti": {
      "label": "Okkanti",
      "models": {
        "sonnet": { "label": "Sonnet 4.6", "modelID": "claude-sonnet-4-6", "contextWindow": 200000 }
      }
    }
  }
}
```

- [ ] **Step 2: Simplify providers.ts**

In `src/server/config/providers.ts`, remove `getOcProviderID()` (lines 65-68). Remove `ocProviderID` from the `ProviderConfig` type. The rest stays.

- [ ] **Step 3: Remove ocProviderID from ws-protocol.ts**

In `src/shared/ws-protocol.ts`, remove `ocProviderID: z.string().optional()` from `providerConfigSchema` (line 107).

- [ ] **Step 4: Verify compilation**

```bash
cd /home/ryan/Code/orchestrel && npx tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add providers.json src/server/config/providers.ts src/shared/ws-protocol.ts
git commit -m "refactor: simplify provider config, remove ocProviderID"
```

---

## Task 7: Card Model — Add Provider Column

**Files:**

- Modify: `src/server/models/Card.ts`
- Modify: `src/shared/ws-protocol.ts` (cardSchema)
- DB migration (ALTER TABLE via sqlite3)

- [ ] **Step 1: Add provider column to DB**

```bash
sqlite3 /home/ryan/Code/orchestrel/data/orchestrel.db "ALTER TABLE card ADD COLUMN provider TEXT NOT NULL DEFAULT 'anthropic';"
```

- [ ] **Step 2: Add provider column to Card entity**

In `src/server/models/Card.ts`, add after the `model` column (line 58):

```typescript
@Column({ type: 'text', default: 'anthropic' })
provider!: string;
```

- [ ] **Step 3: Add provider to cardSchema in ws-protocol.ts**

In `src/shared/ws-protocol.ts`, add to `cardSchema` (after line 21 `model`):

```typescript
provider: z.string(),
```

Also add `provider: z.string().optional()` to `cardCreateSchema` and to `cardUpdateSchema` (via the merge).

- [ ] **Step 4: Verify compilation**

```bash
cd /home/ryan/Code/orchestrel && npx tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add src/server/models/Card.ts src/shared/ws-protocol.ts
git commit -m "feat: add provider column to Card model"
```

---

## Task 8: Init-State Integration

**Files:**

- Modify: `src/server/init-state.ts`

- [ ] **Step 1: Add SessionManager to init-state**

In `src/server/init-state.ts`, add SessionManager to the persistent state that survives Vite rebundles. Add after the WSS exports:

```typescript
import type { SessionManager } from './sessions/manager';

let _sessionManager: SessionManager | null = null;
export function getSessionManager(): SessionManager | null {
  return _sessionManager;
}
export function setSessionManager(sm: SessionManager): void {
  _sessionManager = sm;
}
```

Note: The import must be a `type` import since init-state.ts is dynamically imported and we don't want to pull in the full SessionManager module at the type level.

- [ ] **Step 2: Remove any OpenCode-specific state references**

If `init-state.ts` has any references to OpenCode server or SDK, remove them.

- [ ] **Step 3: Verify compilation**

```bash
cd /home/ryan/Code/orchestrel && npx tsc --noEmit src/server/init-state.ts
```

- [ ] **Step 4: Commit**

```bash
git add src/server/init-state.ts
git commit -m "refactor: add SessionManager to init-state for Vite survival"
```

---

## Task 9: Update Controllers (oc.ts)

**Files:**

- Modify: `src/server/controllers/oc.ts`

This is the heaviest server-side change. `wireSession` (lines 25-157) is deleted entirely — its work is now done by the consumer loop. `registerAutoStart` and `registerWorktreeCleanup` are updated to call the new SessionManager.

- [ ] **Step 1: Remove wireSession**

Delete the `wireSession` function (lines 25-157) and its imports of `AgentSession`/`AgentMessage` from `../agents/types`.

- [ ] **Step 2: Add per-card session event handlers**

Replace `wireSession` with bus-side listeners that react to `card:${cardId}:sdk`, `card:${cardId}:status`, and `card:${cardId}:exit` messages — these are published by the consumer loop. The listeners handle card state updates (move to review on turn end, persist counters, etc.):

```typescript
import { messageBus } from '../bus';
import { Card } from '../models/Card';
import { AppDataSource } from '../models/index';

/**
 * Register per-card session event handlers.
 * Called by SessionManager when a session starts for a card.
 */
export function registerCardSession(cardId: number): void {
  const repo = AppDataSource.getRepository(Card);

  // SDK result message: persist counters, move to review
  const sdkHandler = async (msg: Record<string, unknown>) => {
    if (msg.type === 'result') {
      const card = await repo.findOneBy({ id: cardId });
      if (!card) return;

      const initState = await import('../init-state');
      const sm = initState.getSessionManager();
      const session = sm?.get(cardId);
      if (session) {
        card.promptsSent = session.promptsSent;
        card.turnsCompleted = session.turnsCompleted;
      }

      if (card.column === 'running') {
        card.column = 'review';
      }
      await repo.save(card);
    }

    // Compact boundary: reset context tokens
    if (msg.type === 'system') {
      const sys = msg as { subtype?: string };
      if (sys.subtype === 'compact_boundary') {
        const card = await repo.findOneBy({ id: cardId });
        if (card) {
          card.contextTokens = 0;
          await repo.save(card);
        }
      }
    }
  };

  // Exit: move to review if errored/stopped, unsubscribe
  const exitHandler = async (payload: { sessionId: string | null; status: string }) => {
    if (payload.status === 'errored' || payload.status === 'stopped') {
      const card = await repo.findOneBy({ id: cardId });
      if (card && card.column === 'running') {
        card.column = 'review';
        await repo.save(card);
      }
    }
    messageBus.unsubscribe(`card:${cardId}:sdk`, sdkHandler);
    messageBus.unsubscribe(`card:${cardId}:exit`, exitHandler);
  };

  messageBus.subscribe(`card:${cardId}:sdk`, sdkHandler);
  messageBus.subscribe(`card:${cardId}:exit`, exitHandler);
}
```

- [ ] **Step 3: Update registerAutoStart**

Update `registerAutoStart` to use the new SessionManager from init-state instead of the `SessionStarter` interface:

```typescript
export function registerAutoStart(): void {
  messageBus.subscribe('board:changed', async (payload) => {
    const { card, oldColumn, newColumn } = payload;

    // Card entered running
    if (newColumn === 'running' && oldColumn !== 'running') {
      const initState = await import('../init-state');
      const sm = initState.getSessionManager();
      if (!sm) return;

      const fullCard = await AppDataSource.getRepository(Card).findOneBy({ id: card.id });
      if (!fullCard) return;

      // Non-worktree git repo: queue
      if (!fullCard.useWorktree && fullCard.projectId) {
        const project = await AppDataSource.getRepository(Project).findOneBy({ id: fullCard.projectId });
        if (project?.isGitRepo) {
          const { processQueue } = await import('../services/queue-gate');
          await processQueue(fullCard.projectId);
          return;
        }
      }

      // Direct start (worktree or no project)
      const prompt = fullCard.pendingPrompt ?? fullCard.description ?? '';
      fullCard.pendingPrompt = null;
      fullCard.pendingFiles = null;
      await AppDataSource.getRepository(Card).save(fullCard);

      await sm.start(fullCard.id, prompt, {
        provider: fullCard.provider,
        model: fullCard.model,
        cwd: process.cwd(),
        resume: fullCard.sessionId ?? undefined,
      });
      registerCardSession(fullCard.id);
    }

    // Card left running: stop + process queue
    if (oldColumn === 'running' && newColumn !== 'running') {
      const initState = await import('../init-state');
      const sm = initState.getSessionManager();
      sm?.stop(card.id);

      if (card.projectId) {
        const { processQueue } = await import('../services/queue-gate');
        await processQueue(card.projectId);
      }
    }
  });
}
```

- [ ] **Step 4: Update registerWorktreeCleanup**

Same logic as current, but remove the `WorktreeOps` interface — import `removeWorktree`/`worktreeExists` directly:

```typescript
export function registerWorktreeCleanup(): void {
  messageBus.subscribe('board:changed', async (payload) => {
    const { card, newColumn } = payload;
    if (newColumn !== 'archive') return;

    const fullCard = await AppDataSource.getRepository(Card).findOneBy({ id: card.id });
    if (!fullCard?.useWorktree || !fullCard.worktreePath || !fullCard.projectId) return;

    const project = await AppDataSource.getRepository(Project).findOneBy({ id: fullCard.projectId });
    if (!project) return;

    const { removeWorktree, worktreeExists } = await import('../worktree');
    if (worktreeExists(fullCard.worktreePath)) {
      removeWorktree(project.path, fullCard.worktreePath);
    }
    fullCard.worktreePath = null;
    await AppDataSource.getRepository(Card).save(fullCard);
  });
}
```

- [ ] **Step 5: Remove old imports and SessionStarter/WorktreeOps interfaces**

Remove all imports from `../agents/types`, `../agents/manager`, `../services/session`. Remove the `SessionStarter` and `WorktreeOps` interfaces.

- [ ] **Step 6: Verify compilation**

```bash
cd /home/ryan/Code/orchestrel && npx tsc --noEmit src/server/controllers/oc.ts
```

- [ ] **Step 7: Commit**

```bash
git add src/server/controllers/oc.ts
git commit -m "refactor: replace wireSession with SDK consumer-based event handling"
```

---

## Task 10: Update Queue-Gate

**Files:**

- Modify: `src/server/services/queue-gate.ts`

- [ ] **Step 1: Replace launchSession call**

In `src/server/services/queue-gate.ts`, line 109 currently calls `sessionService.launchSession(toStart.id)`. Replace the launch section with:

```typescript
const initState = await import('../init-state');
const sm = initState.getSessionManager();
if (!sm) throw new Error('SessionManager not initialized');

const prompt = toStart.pendingPrompt ?? toStart.description ?? '';
toStart.pendingPrompt = null;
toStart.pendingFiles = null;
await AppDataSource.getRepository(Card).save(toStart);

await sm.start(toStart.id, prompt, {
  provider: toStart.provider,
  model: toStart.model,
  cwd: process.cwd(),
  resume: toStart.sessionId ?? undefined,
});

const { registerCardSession } = await import('../controllers/oc');
registerCardSession(toStart.id);
```

- [ ] **Step 2: Remove sessionService import**

Remove the import of `sessionService` from `../services/session`. Add `Card` import from models if not present.

- [ ] **Step 3: Update the active session check**

Lines 39-42 currently check `sessionManager.get()`. Replace with:

```typescript
const initState = await import('../init-state');
const sm = initState.getSessionManager();
const hasActive = sm?.isActive(c.id) ?? false;
```

- [ ] **Step 4: Verify compilation**

```bash
cd /home/ryan/Code/orchestrel && npx tsc --noEmit src/server/services/queue-gate.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/server/services/queue-gate.ts
git commit -m "refactor: queue-gate uses new SessionManager"
```

---

## Task 11: Update WS Handlers

**Files:**

- Modify: `src/server/ws/handlers/agents.ts`
- Modify: `src/server/ws/handlers.ts`
- Modify: `src/server/ws/handlers/sessions.ts`

- [ ] **Step 1: Rewrite agents.ts handlers**

Replace all four handlers to use the new SessionManager via init-state:

**handleAgentSend:** Call `sm.start()` or `sm.sendFollowUp()` + `registerCardSession()`.

**handleAgentCompact:** Call `sm.sendFollowUp(cardId, 'Please compact your context window. Summarize the conversation so far and continue.')`.

**handleAgentStop:** Call `sm.stop(cardId)`.

**handleAgentStatus:** Check `sm.get(cardId)` for live session data, fall back to card DB data.

Remove all imports from `../../services/session` and `../../agents/manager`.

- [ ] **Step 2: Add session:set-model handler to handlers.ts**

In `src/server/ws/handlers.ts`, add a new case to the switch (after `agent:stop`):

```typescript
case 'session:set-model': {
  const { cardId, provider, model } = msg.data;
  const initState = await import('../init-state');
  const sm = initState.getSessionManager();
  sm?.setModel(cardId, provider, model);
  // Persist on card
  const card = await AppDataSource.getRepository(Card).findOneBy({ id: cardId });
  if (card) {
    card.provider = provider;
    card.model = model;
    await AppDataSource.getRepository(Card).save(card);
  }
  connections.send(ws, { type: 'mutation:ok', requestId: msg.requestId });
  break;
}
```

Add the corresponding Zod schema to `clientMessage` in `ws-protocol.ts`:

```typescript
z.object({
  type: z.literal('session:set-model'),
  requestId: z.string(),
  data: z.object({ cardId: z.number(), provider: z.string(), model: z.string() }),
}),
```

- [ ] **Step 3: Update session:load handler**

In `src/server/ws/handlers/sessions.ts`, replace the OpenCode history loading with Agent SDK's `getSessionMessages()`:

```typescript
import { getSessionMessages } from '@anthropic-ai/claude-agent-sdk';

// In the handler:
const messages = await getSessionMessages(sessionId, { dir: card.worktreePath ?? projectPath });
connections.send(ws, {
  type: 'session:history',
  requestId: msg.requestId,
  cardId,
  messages,
});
```

- [ ] **Step 4: Verify compilation**

```bash
cd /home/ryan/Code/orchestrel && npx tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add src/server/ws/handlers/ src/server/ws/handlers.ts src/shared/ws-protocol.ts
git commit -m "refactor: WS handlers use new SessionManager"
```

---

## Task 12: Update WS Protocol + Bus Topics

**Files:**

- Modify: `src/shared/ws-protocol.ts`
- Modify: `src/server/bus.ts`
- Modify: `src/server/ws/handlers.ts` (subscribe handler)

- [ ] **Step 1: Add new server message types to ws-protocol.ts**

Replace `agent:message` and `agent:status` server messages with the new SDK-based types:

```typescript
// Replace:
//   z.object({ type: z.literal('agent:message'), cardId: z.number(), data: agentMessageSchema }),
//   z.object({ type: z.literal('agent:status'), data: agentStatusSchema }),
// With:
z.object({ type: z.literal('session:message'), cardId: z.number(), message: z.unknown() }),
z.object({ type: z.literal('session:status'), cardId: z.number(), data: agentStatusSchema }),
z.object({ type: z.literal('session:exit'), cardId: z.number(), sessionId: z.string().nullable() }),
```

Keep `agentStatusSchema` for now — it carries the same status shape. Keep `session:history` but change `messages` to `z.array(z.unknown())` since SDK messages are passthrough.

- [ ] **Step 2: Update subscribe handler for SDK topics**

In `src/server/ws/handlers.ts`, the subscribe handler wires card-level message subscriptions. Update to subscribe to the new bus topics:

Where it currently subscribes to `card:${cardId}:message` and sends `agent:message`, change to subscribe to `card:${cardId}:sdk` and send `session:message`:

```typescript
// Per-card subscription in the subscribe handler:
clientSubs.subscribe(ws, `card:${c.id}:sdk`, (msg: unknown) => {
  connections.send(ws, { type: 'session:message', cardId: c.id, message: msg });
});
clientSubs.subscribe(ws, `card:${c.id}:status`, (data: unknown) => {
  connections.send(ws, { type: 'session:status', cardId: c.id, data });
});
clientSubs.subscribe(ws, `card:${c.id}:exit`, (data: { sessionId: string | null }) => {
  connections.send(ws, { type: 'session:exit', cardId: c.id, sessionId: data.sessionId });
});
```

Remove subscriptions to old `card:${c.id}:message` and `card:${c.id}:session-status` topics.

- [ ] **Step 3: Verify compilation**

```bash
cd /home/ryan/Code/orchestrel && npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add src/shared/ws-protocol.ts src/server/bus.ts src/server/ws/handlers.ts
git commit -m "refactor: update WS protocol and bus topics for SDK messages"
```

---

## Task 13: Update ws/server.ts Initialization

**Files:**

- Modify: `src/server/ws/server.ts`

- [ ] **Step 1: Remove OpenCode server initialization**

In `src/server/ws/server.ts`:

- Remove the import of `openCodeServer` from `../opencode/server`
- Remove the `openCodeServer.start()` call and the post-restart session reattachment logic (lines ~199-226)
- Replace with SessionManager initialization:

```typescript
// In the one-time initialization block (after initState.initialized check):
const { SessionManager } = await import('../sessions/manager');
const { registerAutoStart, registerWorktreeCleanup } = await import('../controllers/oc');

let sm = initState.getSessionManager();
if (!sm) {
  sm = new SessionManager();
  initState.setSessionManager(sm);
}

registerAutoStart();
registerWorktreeCleanup();

initState.markInitialized();
```

- [ ] **Step 2: Verify compilation**

```bash
cd /home/ryan/Code/orchestrel && npx tsc --noEmit src/server/ws/server.ts
```

- [ ] **Step 3: Commit**

```bash
git add src/server/ws/server.ts
git commit -m "refactor: initialize SessionManager instead of OpenCode server"
```

---

## Task 14: Frontend SDK Types

**Files:**

- Create: `app/lib/sdk-types.ts`

Define TypeScript types that mirror the SDK message shapes the UI needs to render. These are standalone — no SDK import on the frontend.

- [ ] **Step 1: Write SDK type definitions**

Write `app/lib/sdk-types.ts`:

```typescript
/** Frontend mirror of SDK message types. No SDK dependency — these are the shapes we receive over WS. */

// Content blocks (inside stream_event deltas)

export interface TextDelta {
  type: 'text_delta';
  text: string;
}
export interface ThinkingDelta {
  type: 'thinking_delta';
  thinking: string;
}
export interface InputJsonDelta {
  type: 'input_json_delta';
  partial_json: string;
}

export interface ContentBlockStart {
  type: 'content_block_start';
  index: number;
  content_block: {
    type: 'text' | 'thinking' | 'tool_use';
    id?: string;
    name?: string;
    text?: string;
    thinking?: string;
  };
}
export interface ContentBlockDelta {
  type: 'content_block_delta';
  index: number;
  delta: TextDelta | ThinkingDelta | InputJsonDelta;
}
export interface ContentBlockStop {
  type: 'content_block_stop';
  index: number;
}
export interface MessageStart {
  type: 'message_start';
  message: { id: string; role: string; model: string };
}
export interface MessageDelta {
  type: 'message_delta';
  delta: { stop_reason?: string };
  usage?: { output_tokens: number };
}
export interface MessageStop {
  type: 'message_stop';
}

export type StreamEvent =
  ContentBlockStart | ContentBlockDelta | ContentBlockStop | MessageStart | MessageDelta | MessageStop;

// Top-level SDK message types

export interface SdkSystemMessage {
  type: 'system';
  subtype: 'init' | 'compact_boundary';
  session_id?: string;
}

export interface SdkStreamEvent {
  type: 'stream_event';
  event: StreamEvent;
}

export interface SdkAssistantMessage {
  type: 'assistant';
  content: Array<{ type: string; text?: string; thinking?: string; id?: string; name?: string; input?: unknown }>;
  model?: string;
  stop_reason?: string;
}

export interface SdkResultMessage {
  type: 'result';
  subtype: 'success' | 'error_max_turns' | 'error_during_execution' | 'error_max_budget_usd';
  result?: string;
  total_cost_usd: number;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  num_turns: number;
  duration_ms: number;
  model_usage?: Record<string, { input_tokens: number; output_tokens: number; cost_usd: number }>;
}

export interface SdkToolProgress {
  type: 'tool_progress';
  tool_name: string;
  data: string;
}

export interface SdkToolUseSummary {
  type: 'tool_use_summary';
  tool_name: string;
  tool_input: unknown;
  tool_result: string;
  is_error?: boolean;
}

export interface SdkTaskStarted {
  type: 'task_started';
  task_id: string;
  description: string;
}

export interface SdkTaskProgress {
  type: 'task_progress';
  task_id: string;
  data: string;
}

export interface SdkTaskNotification {
  type: 'task_notification';
  task_id: string;
  status: 'completed' | 'failed';
  result?: string;
}

export interface SdkRateLimit {
  type: 'rate_limit';
  retry_after_ms: number;
}

export interface SdkStatus {
  type: 'status';
  status: string;
}

export interface SdkError {
  type: 'error';
  message: string;
  timestamp?: number;
}

export type SdkMessage =
  | SdkSystemMessage
  | SdkStreamEvent
  | SdkAssistantMessage
  | SdkResultMessage
  | SdkToolProgress
  | SdkToolUseSummary
  | SdkTaskStarted
  | SdkTaskProgress
  | SdkTaskNotification
  | SdkRateLimit
  | SdkStatus
  | SdkError;
```

- [ ] **Step 2: Verify compilation**

```bash
cd /home/ryan/Code/orchestrel && npx tsc --noEmit app/lib/sdk-types.ts
```

- [ ] **Step 3: Commit**

```bash
git add app/lib/sdk-types.ts
git commit -m "feat: add frontend SDK message type definitions"
```

---

## Task 15: MessageAccumulator

**Files:**

- Create: `app/lib/message-accumulator.ts`

Builds renderable state from streaming SDK messages. This is the core frontend change that replaces the delta accumulation logic in SessionStore.

- [ ] **Step 1: Write MessageAccumulator**

Write `app/lib/message-accumulator.ts`:

```typescript
import { makeAutoObservable, observable } from 'mobx';
import type {
  SdkMessage,
  SdkStreamEvent,
  SdkResultMessage,
  SdkToolUseSummary,
  SdkTaskStarted,
  SdkTaskProgress,
  SdkTaskNotification,
  ContentBlockStart,
  ContentBlockDelta,
  ContentBlockStop,
} from './sdk-types';

export interface ContentBlock {
  type: 'text' | 'thinking' | 'tool_use';
  content: string;
  id?: string;
  name?: string;
  input?: string;
  complete: boolean;
}

export interface TurnResult {
  subtype: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  numTurns: number;
  durationMs: number;
  modelUsage?: Record<string, { inputTokens: number; outputTokens: number; costUsd: number }>;
}

export interface ToolActivity {
  name: string;
  input: unknown;
  result: string;
  isError: boolean;
}

export interface SubagentState {
  taskId: string;
  description: string;
  status: 'running' | 'completed' | 'failed';
  lastProgress: string;
}

export type ConversationEntry =
  | { kind: 'blocks'; blocks: ContentBlock[]; model?: string }
  | { kind: 'result'; data: TurnResult }
  | { kind: 'tool_activity'; data: ToolActivity }
  | { kind: 'user'; content: string; optimistic?: boolean }
  | { kind: 'system'; subtype: string }
  | { kind: 'error'; message: string }
  | { kind: 'compact' };

export class MessageAccumulator {
  conversation: ConversationEntry[] = [];
  currentBlocks: ContentBlock[] = [];
  subagents = new Map<string, SubagentState>();
  retryAfterMs: number | null = null;

  constructor() {
    makeAutoObservable(this, {
      conversation: observable.shallow,
      currentBlocks: observable.shallow,
      subagents: observable,
    });
  }

  handleMessage(msg: SdkMessage): void {
    switch (msg.type) {
      case 'stream_event':
        this.handleStreamEvent(msg);
        break;
      case 'assistant':
        this.finalizeBlocks();
        break;
      case 'result':
        this.handleResult(msg);
        break;
      case 'tool_use_summary':
        this.handleToolUseSummary(msg);
        break;
      case 'task_started':
        this.handleTaskStarted(msg);
        break;
      case 'task_progress':
        this.handleTaskProgress(msg);
        break;
      case 'task_notification':
        this.handleTaskNotification(msg);
        break;
      case 'rate_limit':
        this.retryAfterMs = msg.retry_after_ms;
        break;
      case 'system':
        if (msg.subtype === 'compact_boundary') {
          this.finalizeBlocks();
          this.conversation.push({ kind: 'compact' });
        }
        break;
      case 'error':
        this.finalizeBlocks();
        this.conversation.push({ kind: 'error', message: msg.message });
        break;
      case 'status':
        if (this.retryAfterMs !== null) this.retryAfterMs = null;
        break;
    }
  }

  addUserMessage(content: string, optimistic = false): void {
    this.finalizeBlocks();
    this.conversation.push({ kind: 'user', content, optimistic });
  }

  private handleStreamEvent(msg: SdkStreamEvent): void {
    const evt = msg.event;
    switch (evt.type) {
      case 'content_block_start':
        this.onContentBlockStart(evt);
        break;
      case 'content_block_delta':
        this.onContentBlockDelta(evt);
        break;
      case 'content_block_stop':
        this.onContentBlockStop(evt);
        break;
      case 'message_start':
        this.currentBlocks = [];
        break;
      case 'message_stop':
        this.finalizeBlocks();
        break;
    }
  }

  private onContentBlockStart(evt: ContentBlockStart): void {
    const block: ContentBlock = {
      type: evt.content_block.type as 'text' | 'thinking' | 'tool_use',
      content: evt.content_block.text ?? evt.content_block.thinking ?? '',
      id: evt.content_block.id,
      name: evt.content_block.name,
      input: '',
      complete: false,
    };
    this.currentBlocks.push(block);
  }

  private onContentBlockDelta(evt: ContentBlockDelta): void {
    const block = this.currentBlocks[evt.index];
    if (!block) return;
    switch (evt.delta.type) {
      case 'text_delta':
        block.content += evt.delta.text;
        break;
      case 'thinking_delta':
        block.content += evt.delta.thinking;
        break;
      case 'input_json_delta':
        block.input = (block.input ?? '') + evt.delta.partial_json;
        break;
    }
  }

  private onContentBlockStop(evt: ContentBlockStop): void {
    const block = this.currentBlocks[evt.index];
    if (block) block.complete = true;
  }

  private finalizeBlocks(): void {
    if (this.currentBlocks.length > 0) {
      for (const b of this.currentBlocks) b.complete = true;
      this.conversation.push({ kind: 'blocks', blocks: [...this.currentBlocks] });
      this.currentBlocks = [];
    }
  }

  private handleResult(msg: SdkResultMessage): void {
    this.finalizeBlocks();
    this.retryAfterMs = null;
    this.conversation.push({
      kind: 'result',
      data: {
        subtype: msg.subtype,
        costUsd: msg.total_cost_usd,
        inputTokens: msg.usage.input_tokens,
        outputTokens: msg.usage.output_tokens,
        cacheRead: msg.usage.cache_read_input_tokens ?? 0,
        cacheWrite: msg.usage.cache_creation_input_tokens ?? 0,
        numTurns: msg.num_turns,
        durationMs: msg.duration_ms,
        modelUsage: msg.model_usage
          ? Object.fromEntries(
              Object.entries(msg.model_usage).map(([k, v]) => [
                k,
                { inputTokens: v.input_tokens, outputTokens: v.output_tokens, costUsd: v.cost_usd },
              ]),
            )
          : undefined,
      },
    });
  }

  private handleToolUseSummary(msg: SdkToolUseSummary): void {
    this.conversation.push({
      kind: 'tool_activity',
      data: {
        name: msg.tool_name,
        input: msg.tool_input,
        result: msg.tool_result,
        isError: msg.is_error ?? false,
      },
    });
  }

  private handleTaskStarted(msg: SdkTaskStarted): void {
    this.subagents.set(msg.task_id, {
      taskId: msg.task_id,
      description: msg.description,
      status: 'running',
      lastProgress: '',
    });
  }

  private handleTaskProgress(msg: SdkTaskProgress): void {
    const sub = this.subagents.get(msg.task_id);
    if (sub) sub.lastProgress = msg.data;
  }

  private handleTaskNotification(msg: SdkTaskNotification): void {
    const sub = this.subagents.get(msg.task_id);
    if (sub) {
      sub.status = msg.status;
      setTimeout(() => this.subagents.delete(msg.task_id), 2000);
    }
  }

  clear(): void {
    this.conversation = [];
    this.currentBlocks = [];
    this.subagents.clear();
    this.retryAfterMs = null;
  }
}
```

- [ ] **Step 2: Verify compilation**

```bash
cd /home/ryan/Code/orchestrel && npx tsc --noEmit app/lib/message-accumulator.ts
```

- [ ] **Step 3: Commit**

```bash
git add app/lib/message-accumulator.ts
git commit -m "feat: add MessageAccumulator for SDK stream rendering"
```

---

## Task 16: Rewrite SessionStore

**Files:**

- Modify: `app/stores/session-store.ts`
- Modify: `app/stores/root-store.ts`

- [ ] **Step 1: Rewrite SessionStore to use MessageAccumulator**

Replace the `ingest()` / `ingestBatch()` methods and the `ConversationRow` / `SessionState` types to use `MessageAccumulator` and `SdkMessage`:

Key changes:

- `SessionState.conversation` replaced by `MessageAccumulator` instance (`accumulator` field)
- `ingest(cardId, msg: AgentMessage)` replaced by `ingestSdkMessage(cardId, msg: SdkMessage)` which delegates to `accumulator.handleMessage(msg)`
- `ingestBatch(cardId, messages: AgentMessage[])` replaced by `ingestHistory(cardId, messages: unknown[])` which iterates and calls `accumulator.handleMessage()` for each
- Remove `activeTextIdx`, `activeThinkingIdx`, `toolCallIdxMap`, `conversationIds` — accumulator handles all of this
- Keep `status`, `sessionId`, `promptsSent`, `turnsCompleted`, `contextTokens`, `contextWindow`
- Add `handleSessionStatus(cardId, data)` and `handleSessionExit(cardId)` methods
- Keep `sendMessage`, `compactSession`, `stopSession`, `requestStatus`, `loadHistory` mutation methods — they send WS messages

- [ ] **Step 2: Update root-store.ts message routing**

In `app/stores/root-store.ts`, update the switch cases:

```typescript
case 'session:message':
  this.sessions.ingestSdkMessage(msg.cardId, msg.message as SdkMessage);
  break;

case 'session:status':
  this.sessions.handleSessionStatus(msg.cardId, msg.data);
  break;

case 'session:exit':
  this.sessions.handleSessionExit(msg.cardId);
  break;
```

Remove the old `agent:message` and `agent:status` cases.

- [ ] **Step 3: Verify compilation**

```bash
cd /home/ryan/Code/orchestrel && npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add app/stores/session-store.ts app/stores/root-store.ts
git commit -m "refactor: SessionStore uses MessageAccumulator for SDK messages"
```

---

## Task 17: Update Message Rendering Components

**Files:**

- Modify: `app/components/MessageBlock.tsx`
- Modify: `app/components/SessionView.tsx`
- Modify: `app/components/SubagentFeed.tsx`

- [ ] **Step 1: Rewrite MessageBlock for ConversationEntry**

Replace the current `MessageBlock` component that renders `AgentMessage` with one that renders `ConversationEntry` from the accumulator.

The dispatch changes from `switch (message.type)` where type is `'text' | 'tool_call' | ...` to `switch (entry.kind)` where kind is `'blocks' | 'result' | 'tool_activity' | 'user' | 'system' | 'error' | 'compact'`.

For `kind: 'blocks'`, render each `ContentBlock` in the blocks array:

- `block.type === 'text'` — `TextBlock` (same markdown rendering)
- `block.type === 'thinking'` — `ThinkingBlock` (same muted rendering)
- `block.type === 'tool_use'` — `ToolUseBlock` (show name, input, progress)

For `kind: 'result'` — `TurnEndBlock` (cost/duration, same visual)
For `kind: 'tool_activity'` — `ToolResultBlock` (show tool name + result)
For `kind: 'user'` — `UserBlock` (same right-aligned bubble)
For `kind: 'error'` — error display (same)
For `kind: 'compact'` — compact boundary marker (same)

- [ ] **Step 2: Update SessionView for new data flow**

In `SessionView.tsx`:

- The message list now comes from `session.accumulator.conversation` instead of `session.conversation`
- Also render `session.accumulator.currentBlocks` at the end (in-progress blocks not yet finalized)
- Streaming detection: check `session.status === 'running' || session.status === 'starting'`
- Auto-scroll logic stays the same

- [ ] **Step 3: Add provider dropdown to SessionView**

Add a provider `<select>` alongside the existing model and thinking-level selects in the status bar (around line 307):

```tsx
<select
  value={provider}
  onChange={(e) => handleProviderChange(e.target.value)}
  className="text-[11px] bg-transparent text-muted-foreground border-none outline-none cursor-pointer hover:text-foreground min-w-0 truncate"
>
  {Object.entries(config.providers).map(([id, p]) => (
    <option key={id} value={id}>
      {p.label}
    </option>
  ))}
</select>
```

When provider changes, also send `session:set-model` if there's an active session:

```typescript
const handleProviderChange = (newProvider: string) => {
  cardStore.updateCard({ id: cardId, provider: newProvider });
  if (session?.status === 'running' || session?.status === 'completed') {
    ws.send({
      type: 'session:set-model',
      requestId: uuid(),
      data: { cardId, provider: newProvider, model },
    });
  }
};
```

- [ ] **Step 4: Update SubagentFeed**

Update to consume `session.accumulator.subagents` (a `Map<string, SubagentState>`) instead of `session.subagents`.

- [ ] **Step 5: Verify compilation**

```bash
cd /home/ryan/Code/orchestrel && npx tsc --noEmit
```

- [ ] **Step 6: Commit**

```bash
git add app/components/MessageBlock.tsx app/components/SessionView.tsx app/components/SubagentFeed.tsx
git commit -m "feat: render SDK messages via MessageAccumulator, add provider switcher"
```

---

## Task 18: Delete Old Code

**Files:**

- Delete: `src/server/agents/` (entire directory)
- Delete: `src/server/opencode/` (entire directory)
- Delete: `src/server/services/session.ts`

- [ ] **Step 1: Delete old agent and OpenCode directories**

```bash
rm -rf src/server/agents/ src/server/opencode/ src/server/services/session.ts
```

- [ ] **Step 2: Remove stale imports**

Search the codebase for any remaining imports from deleted paths and fix them:

```bash
grep -rn "from.*agents/" src/server/ --include='*.ts'
grep -rn "from.*opencode/" src/server/ --include='*.ts'
grep -rn "from.*services/session" src/server/ --include='*.ts'
```

Fix any hits.

- [ ] **Step 3: Remove deprecated agentMessageSchema if no longer used**

Check if `agentMessageSchema` is still imported anywhere in the frontend. If not, remove it and the `AgentMessage` type from `ws-protocol.ts`.

- [ ] **Step 4: Full typecheck**

```bash
cd /home/ryan/Code/orchestrel && pnpm typecheck
```

- [ ] **Step 5: Start dev server and verify**

```bash
sudo systemctl restart orchestrel
```

Open `http://localhost:6194` and verify:

- Board loads correctly
- Can create a card and move to running
- Agent session starts (check terminal logs for `[session:...]` messages)
- Streaming text appears in chat
- Tool calls render
- Turn end shows cost
- Provider dropdown appears and switching works
- Stop button works
- Session resumes after server restart

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: delete old OpenCode agent code"
```

---

## Post-Implementation Notes

**Manual testing checklist:**

- Create card, move to running: verify session starts via CCR
- Send follow-up message: verify streaming response
- Switch model mid-session: verify next turn uses new model
- Switch provider mid-session: verify CCR routes correctly
- Stop session: verify graceful stop
- Archive card: verify worktree cleanup
- Restart server (`sudo systemctl restart orchestrel`): verify sessions can resume
- Queue: run 2 non-worktree cards for same project: verify only 1 runs at a time
- Context gauge: verify it reflects usage from result messages

**Known unknowns to verify during implementation:**

1. Model prefix passthrough — Task 1, Step 6 tests this
2. `streamInput()` behavior between turns — does the generator pause after result?
3. `getSessionMessages()` return format — may need adjustment in session:load handler
4. Exact `SDKMessage` field names — the frontend types in Task 14 are based on docs, may need refinement against actual SDK output
5. Compaction via user message — test that sending a compaction request actually triggers Claude Code's summarization
