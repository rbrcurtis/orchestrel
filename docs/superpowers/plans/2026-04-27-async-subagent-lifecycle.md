# Async Subagent Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep Orchestrel cards in `running` while Claude Code async Agent subagents launched with `run_in_background: true` are still active, then move cards to `review` only after async task notifications complete.

**Architecture:** orcd remains lifecycle owner. `OrcdSession` parses async Agent launch tool results from SDK events, emits synthetic `task_started` stream events for UI, watches parent Claude JSONL for later `<task-notification>` queue operations, emits synthetic `task_notification` stream events, and delays `session_exit` until tracked async tasks resolve. Orc backend stays event-driven: it still moves cards on `session_exit`; it does not infer subagent lifecycle itself.

**Tech Stack:** TypeScript strict mode, Vitest, Claude Agent SDK event stream, Claude session JSONL, existing orcd socket protocol.

---

## File Structure

- Create: `src/orcd/async-task-tracker.ts`
  - Pure parser + tracker for async Agent launches and task notifications.
  - No filesystem, no timers, no orcd socket code.
- Create: `src/orcd/__tests__/async-task-tracker.test.ts`
  - Unit tests for launch parsing, notification parsing, duplicate handling, pending resolution.
- Modify: `src/orcd/session.ts`
  - Own lifecycle delay after SDK iterator closes.
  - Emit synthetic `task_started` and `task_notification` events through existing `stream_event` protocol.
  - Watch parent JSONL while async tasks are pending.
- Create: `src/orcd/__tests__/session-async-tasks.test.ts`
  - Mock Agent SDK query, mock JSONL file, verify no `session_exit` until notification resolves pending task.
- Modify: `src/orcd/types.ts`
  - Keep `SessionState` unchanged unless test proves a new state is necessary. Preferred: keep state `running` while waiting for async task notifications.
- Modify: `app/lib/sdk-types.ts`
  - Only if parser emits fields not already represented. Preferred: no change; current `task_started` / `task_notification` shapes already match.
- Modify: `app/lib/message-accumulator.ts`
  - Only if `task_notification.status` needs to accept more values. Preferred: no change; current `completed | failed` matches observed notification.

## Known Evidence

- Card 999 session launched Agent tool with `run_in_background: true`.
- Parent turn ended immediately after `Async agent launched successfully`.
- orcd emitted `session_exit`; backend moved card to review.
- Subagent completion arrived later in parent JSONL as top-level `queue-operation` line with content containing `<task-notification>...</task-notification>`.
- Existing frontend already handles `task_started`, `task_progress`, and `task_notification` messages when they arrive as SDK messages.

## Design Rules

- Do not move lifecycle ownership to Orc backend.
- Do not treat SDK `result` as completion.
- Do not block on foreground `Agent` calls; only async launches need tracking.
- Do not parse human assistant prose. Parse structured tool result text from Agent tool output and structured `<task-notification>` block from queue operation content.
- Do not add DB columns for v1. orcd in-memory lifecycle is enough; current sessions are already in-memory.
- Do not add broad XML parser dependency. Use focused string/regex extraction for known Claude notification format.

---

### Task 1: Add async task parser tests

**Files:**
- Create: `src/orcd/__tests__/async-task-tracker.test.ts`
- Create: `src/orcd/async-task-tracker.ts`

- [ ] **Step 1: Create failing parser tests**

Create `src/orcd/__tests__/async-task-tracker.test.ts` with this content:

```ts
import { describe, expect, it } from 'vitest';
import {
  AsyncTaskTracker,
  parseAsyncAgentLaunch,
  parseTaskNotification,
} from '../async-task-tracker';

describe('parseAsyncAgentLaunch', () => {
  it('extracts async Agent launch details from tool result text', () => {
    const text = [
      'Async agent launched successfully.',
      'agentId: agent-123 (internal ID - do not mention to user. Use SendMessage with to: \'agent-123\' to continue this agent.)',
      'The agent is working in the background. You will be notified automatically when it completes.',
      'output_file: /tmp/claude/tasks/agent-123.output',
    ].join('\n');

    expect(parseAsyncAgentLaunch(text, 'call_abc', 'Implement remaining tasks')).toEqual({
      taskId: 'agent-123',
      toolUseId: 'call_abc',
      description: 'Implement remaining tasks',
      outputFile: '/tmp/claude/tasks/agent-123.output',
    });
  });

  it('returns null for foreground Agent tool results', () => {
    expect(parseAsyncAgentLaunch('DONE\nTests passed', 'call_abc', 'Review')).toBeNull();
  });
});

describe('parseTaskNotification', () => {
  it('extracts completed notification from queue-operation content', () => {
    const content = [
      '<task-notification>',
      '<task-id>agent-123</task-id>',
      '<tool-use-id>call_abc</tool-use-id>',
      '<output-file>/tmp/claude/tasks/agent-123.output</output-file>',
      '<status>completed</status>',
      '<summary>Agent "Implement remaining tasks" completed</summary>',
      '<result>DONE_WITH_CONCERNS\nTests passed</result>',
      '</task-notification>',
    ].join('\n');

    expect(parseTaskNotification(content)).toEqual({
      taskId: 'agent-123',
      toolUseId: 'call_abc',
      outputFile: '/tmp/claude/tasks/agent-123.output',
      status: 'completed',
      summary: 'Agent "Implement remaining tasks" completed',
      result: 'DONE_WITH_CONCERNS\nTests passed',
    });
  });

  it('extracts failed notification', () => {
    const content = [
      '<task-notification>',
      '<task-id>agent-123</task-id>',
      '<tool-use-id>call_abc</tool-use-id>',
      '<status>failed</status>',
      '<summary>Agent failed</summary>',
      '</task-notification>',
    ].join('\n');

    expect(parseTaskNotification(content)?.status).toBe('failed');
  });

  it('returns null for unrelated queue content', () => {
    expect(parseTaskNotification('Continue')).toBeNull();
  });
});

describe('AsyncTaskTracker', () => {
  it('tracks pending tasks and resolves them once', () => {
    const tracker = new AsyncTaskTracker();

    const started = tracker.recordLaunch({
      taskId: 'agent-123',
      toolUseId: 'call_abc',
      description: 'Implement remaining tasks',
      outputFile: '/tmp/claude/tasks/agent-123.output',
    });

    expect(started).toEqual({
      type: 'task_started',
      task_id: 'agent-123',
      description: 'Implement remaining tasks',
    });
    expect(tracker.hasPending()).toBe(true);

    const notification = tracker.recordNotification({
      taskId: 'agent-123',
      toolUseId: 'call_abc',
      outputFile: '/tmp/claude/tasks/agent-123.output',
      status: 'completed',
      summary: 'Agent completed',
      result: 'DONE',
    });

    expect(notification).toEqual({
      type: 'task_notification',
      task_id: 'agent-123',
      status: 'completed',
      result: 'DONE',
    });
    expect(tracker.hasPending()).toBe(false);
    expect(tracker.recordNotification({
      taskId: 'agent-123',
      toolUseId: 'call_abc',
      status: 'completed',
      summary: 'Agent completed',
    })).toBeNull();
  });
});
```

- [ ] **Step 2: Add minimal stub so test imports compile but fail behavior**

Create `src/orcd/async-task-tracker.ts` with this temporary content:

```ts
export interface AsyncAgentLaunch {
  taskId: string;
  toolUseId: string;
  description: string;
  outputFile?: string;
}

export interface TaskNotification {
  taskId: string;
  toolUseId?: string;
  outputFile?: string;
  status: 'completed' | 'failed';
  summary?: string;
  result?: string;
}

export interface TaskStartedEvent {
  type: 'task_started';
  task_id: string;
  description: string;
}

export interface TaskNotificationEvent {
  type: 'task_notification';
  task_id: string;
  status: 'completed' | 'failed';
  result?: string;
}

export function parseAsyncAgentLaunch(_text: string, _toolUseId: string, _description: string): AsyncAgentLaunch | null {
  return null;
}

export function parseTaskNotification(_content: string): TaskNotification | null {
  return null;
}

export class AsyncTaskTracker {
  recordLaunch(_launch: AsyncAgentLaunch): TaskStartedEvent | null {
    return null;
  }

  recordNotification(_notification: TaskNotification): TaskNotificationEvent | null {
    return null;
  }

  hasPending(): boolean {
    return false;
  }
}
```

- [ ] **Step 3: Run failing tests**

Run:

```bash
pnpm test src/orcd/__tests__/async-task-tracker.test.ts
```

Expected: FAIL in `parseAsyncAgentLaunch`, `parseTaskNotification`, and `AsyncTaskTracker` assertions because stubs return `null` / `false`.

---

### Task 2: Implement async task parser and tracker

**Files:**
- Modify: `src/orcd/async-task-tracker.ts`
- Test: `src/orcd/__tests__/async-task-tracker.test.ts`

- [ ] **Step 1: Replace helper with real implementation**

Replace `src/orcd/async-task-tracker.ts` with this content:

```ts
export interface AsyncAgentLaunch {
  taskId: string;
  toolUseId: string;
  description: string;
  outputFile?: string;
}

export interface TaskNotification {
  taskId: string;
  toolUseId?: string;
  outputFile?: string;
  status: 'completed' | 'failed';
  summary?: string;
  result?: string;
}

export interface TaskStartedEvent {
  type: 'task_started';
  task_id: string;
  description: string;
}

export interface TaskNotificationEvent {
  type: 'task_notification';
  task_id: string;
  status: 'completed' | 'failed';
  result?: string;
}

interface TaskState {
  launch: AsyncAgentLaunch;
  status: 'running' | 'completed' | 'failed';
}

function firstMatch(text: string, re: RegExp): string | undefined {
  const match = re.exec(text);
  return match?.[1]?.trim();
}

function tagValue(content: string, tag: string): string | undefined {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`);
  return firstMatch(content, re);
}

export function parseAsyncAgentLaunch(text: string, toolUseId: string, description: string): AsyncAgentLaunch | null {
  if (!text.includes('Async agent launched successfully.')) return null;

  const taskId = firstMatch(text, /agentId:\s*([^\s(]+)/);
  if (!taskId) return null;

  const outputFile = firstMatch(text, /output_file:\s*(\S+)/);
  return {
    taskId,
    toolUseId,
    description,
    ...(outputFile ? { outputFile } : {}),
  };
}

export function parseTaskNotification(content: string): TaskNotification | null {
  if (!content.includes('<task-notification>')) return null;

  const taskId = tagValue(content, 'task-id');
  const status = tagValue(content, 'status');
  if (!taskId || (status !== 'completed' && status !== 'failed')) return null;

  const toolUseId = tagValue(content, 'tool-use-id');
  const outputFile = tagValue(content, 'output-file');
  const summary = tagValue(content, 'summary');
  const result = tagValue(content, 'result');

  return {
    taskId,
    status,
    ...(toolUseId ? { toolUseId } : {}),
    ...(outputFile ? { outputFile } : {}),
    ...(summary ? { summary } : {}),
    ...(result ? { result } : {}),
  };
}

export class AsyncTaskTracker {
  private tasks = new Map<string, TaskState>();

  recordLaunch(launch: AsyncAgentLaunch): TaskStartedEvent | null {
    if (this.tasks.has(launch.taskId)) return null;
    this.tasks.set(launch.taskId, { launch, status: 'running' });
    return {
      type: 'task_started',
      task_id: launch.taskId,
      description: launch.description,
    };
  }

  recordNotification(notification: TaskNotification): TaskNotificationEvent | null {
    const task = this.tasks.get(notification.taskId);
    if (!task || task.status !== 'running') return null;

    task.status = notification.status;
    return {
      type: 'task_notification',
      task_id: notification.taskId,
      status: notification.status,
      ...(notification.result ? { result: notification.result } : {}),
    };
  }

  hasPending(): boolean {
    for (const task of this.tasks.values()) {
      if (task.status === 'running') return true;
    }
    return false;
  }
}
```

- [ ] **Step 2: Run parser tests**

Run:

```bash
pnpm test src/orcd/__tests__/async-task-tracker.test.ts
```

Expected: PASS.

- [ ] **Step 3: Commit parser and tracker**

Run:

```bash
git add src/orcd/async-task-tracker.ts src/orcd/__tests__/async-task-tracker.test.ts
git commit -m "Add async subagent task tracker"
```

---

### Task 3: Add SDK event extraction tests

**Files:**
- Modify: `src/orcd/__tests__/async-task-tracker.test.ts`
- Modify: `src/orcd/async-task-tracker.ts`

- [ ] **Step 1: Add tests for extracting launches from SDK user tool_result events**

Append this import to the existing import list in `src/orcd/__tests__/async-task-tracker.test.ts`:

```ts
  extractAsyncAgentLaunches,
```

Append this test block:

```ts
describe('extractAsyncAgentLaunches', () => {
  it('extracts async launch from SDK user tool_result event', () => {
    const event = {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_abc',
            content: [
              {
                type: 'text',
                text: [
                  'Async agent launched successfully.',
                  'agentId: agent-123 (internal ID - do not mention to user.)',
                  'output_file: /tmp/claude/tasks/agent-123.output',
                ].join('\n'),
              },
            ],
          },
        ],
      },
    };

    expect(extractAsyncAgentLaunches(event, new Map([['call_abc', 'Implement remaining tasks']]))).toEqual([
      {
        taskId: 'agent-123',
        toolUseId: 'call_abc',
        description: 'Implement remaining tasks',
        outputFile: '/tmp/claude/tasks/agent-123.output',
      },
    ]);
  });
});
```

- [ ] **Step 2: Add stub export**

Add this function to `src/orcd/async-task-tracker.ts`:

```ts
export function extractAsyncAgentLaunches(
  _event: unknown,
  _toolDescriptions: Map<string, string>,
): AsyncAgentLaunch[] {
  return [];
}
```

- [ ] **Step 3: Run failing extraction test**

Run:

```bash
pnpm test src/orcd/__tests__/async-task-tracker.test.ts
```

Expected: FAIL because `extractAsyncAgentLaunches` returns `[]`.

---

### Task 4: Implement SDK event extraction

**Files:**
- Modify: `src/orcd/async-task-tracker.ts`
- Test: `src/orcd/__tests__/async-task-tracker.test.ts`

- [ ] **Step 1: Add narrowing helpers and extractor**

In `src/orcd/async-task-tracker.ts`, add these helpers above `extractAsyncAgentLaunches` and replace the stub:

```ts
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function textFromToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  return content
    .map((block) => {
      if (!isRecord(block)) return '';
      const text = block.text;
      return typeof text === 'string' ? text : '';
    })
    .filter(Boolean)
    .join('\n');
}

export function extractAsyncAgentLaunches(
  event: unknown,
  toolDescriptions: Map<string, string>,
): AsyncAgentLaunch[] {
  if (!isRecord(event) || event.type !== 'user') return [];

  const message = event.message;
  if (!isRecord(message) || !Array.isArray(message.content)) return [];

  const launches: AsyncAgentLaunch[] = [];
  for (const block of message.content) {
    if (!isRecord(block) || block.type !== 'tool_result') continue;

    const toolUseId = block.tool_use_id;
    if (typeof toolUseId !== 'string') continue;

    const description = toolDescriptions.get(toolUseId) ?? 'Async agent';
    const launch = parseAsyncAgentLaunch(textFromToolResultContent(block.content), toolUseId, description);
    if (launch) launches.push(launch);
  }

  return launches;
}
```

- [ ] **Step 2: Run extraction tests**

Run:

```bash
pnpm test src/orcd/__tests__/async-task-tracker.test.ts
```

Expected: PASS.

- [ ] **Step 3: Commit extraction**

Run:

```bash
git add src/orcd/async-task-tracker.ts src/orcd/__tests__/async-task-tracker.test.ts
git commit -m "Parse async Agent launch events"
```

---

### Task 5: Add session lifecycle tests for delayed exit

**Files:**
- Create: `src/orcd/__tests__/session-async-tasks.test.ts`
- Modify: `src/orcd/session.ts`

- [ ] **Step 1: Write failing session test**

Create `src/orcd/__tests__/session-async-tasks.test.ts` with this content:

```ts
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { describe, expect, it, vi } from 'vitest';
import { OrcdSession } from '../session';
import type { SessionEventCallback } from '../session';

const events: unknown[] = [];

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => ({
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
    },
    interrupt: vi.fn(),
    setMaxThinkingTokens: vi.fn(),
  }),
}));

function toolUseEvent(id: string, description: string): unknown {
  return {
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          id,
          name: 'Agent',
          input: { description, run_in_background: true },
        },
      ],
    },
  };
}

function asyncLaunchResult(toolUseId: string, taskId: string): unknown {
  return {
    type: 'user',
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: [
            {
              type: 'text',
              text: [
                'Async agent launched successfully.',
                `agentId: ${taskId} (internal ID - do not mention to user.)`,
                `output_file: /tmp/claude/tasks/${taskId}.output`,
              ].join('\n'),
            },
          ],
        },
      ],
    },
  };
}

describe('OrcdSession async Agent lifecycle', () => {
  it('delays session_exit until async task notification appears in JSONL', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orchestrel-session-'));
    const jsonlPath = join(dir, 'session.jsonl');
    await writeFile(jsonlPath, '');

    events.length = 0;
    events.push(
      toolUseEvent('call_abc', 'Implement remaining tasks'),
      asyncLaunchResult('call_abc', 'agent-123'),
      {
        type: 'result',
        subtype: 'success',
        stop_reason: 'end_turn',
        modelUsage: { test: { contextWindow: 200000 } },
      },
    );

    const session = new OrcdSession({
      cwd: dir,
      model: 'test-model',
      provider: 'test-provider',
      sessionId: 'session',
      jsonlPathForTesting: jsonlPath,
      asyncTaskPollMsForTesting: 10,
    });

    const received: string[] = [];
    const payloads: unknown[] = [];
    const cb: SessionEventCallback = (msg) => {
      received.push(msg.type);
      payloads.push(msg);
    };
    session.subscribe(cb);

    const run = session.run({ prompt: 'go' });
    await vi.waitFor(() => expect(received).toContain('result'));
    expect(received).not.toContain('session_exit');
    expect(payloads).toContainEqual(expect.objectContaining({
      type: 'stream_event',
      event: { type: 'task_started', task_id: 'agent-123', description: 'Implement remaining tasks' },
    }));

    await writeFile(jsonlPath, JSON.stringify({
      type: 'queue-operation',
      operation: 'enqueue',
      content: [
        '<task-notification>',
        '<task-id>agent-123</task-id>',
        '<tool-use-id>call_abc</tool-use-id>',
        '<status>completed</status>',
        '<result>DONE</result>',
        '</task-notification>',
      ].join('\n'),
    }) + '\n');

    await run;

    expect(payloads).toContainEqual(expect.objectContaining({
      type: 'stream_event',
      event: { type: 'task_notification', task_id: 'agent-123', status: 'completed', result: 'DONE' },
    }));
    expect(received.at(-1)).toBe('session_exit');

    const finalContent = await readFile(jsonlPath, 'utf8');
    expect(finalContent).toContain('<task-notification>');
    await rm(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Add constructor test-only options to make test compile**

In `src/orcd/session.ts`, extend constructor opts type with:

```ts
    jsonlPathForTesting?: string;
    asyncTaskPollMsForTesting?: number;
```

Add private fields in class:

```ts
  private readonly jsonlPathForTesting: string | undefined;
  private readonly asyncTaskPollMs: number;
```

Set them in constructor:

```ts
    this.jsonlPathForTesting = opts.jsonlPathForTesting;
    this.asyncTaskPollMs = opts.asyncTaskPollMsForTesting ?? 1000;
```

- [ ] **Step 3: Run failing session test**

Run:

```bash
pnpm test src/orcd/__tests__/session-async-tasks.test.ts
```

Expected: FAIL because session currently emits `session_exit` immediately and never emits synthetic task events.

---

### Task 6: Track Agent tool descriptions in session stream

**Files:**
- Modify: `src/orcd/session.ts`
- Test: `src/orcd/__tests__/session-async-tasks.test.ts`

- [ ] **Step 1: Import tracker helpers**

Add imports to `src/orcd/session.ts`:

```ts
import { readFile } from 'fs/promises';
import { resolveJsonlPath } from '../lib/session-compactor';
import {
  AsyncTaskTracker,
  extractAsyncAgentLaunches,
  parseTaskNotification,
  type TaskNotificationEvent,
  type TaskStartedEvent,
} from './async-task-tracker';
```

- [ ] **Step 2: Add fields to `OrcdSession`**

Add fields near existing private fields:

```ts
  private readonly asyncTasks = new AsyncTaskTracker();
  private readonly agentToolDescriptions = new Map<string, string>();
  private jsonlLinesRead = 0;
```

- [ ] **Step 3: Add tool description collection helpers**

Add methods inside `OrcdSession`:

```ts
  private rememberAgentToolDescriptions(event: unknown): void {
    if (!isRecord(event) || event.type !== 'assistant') return;
    const message = event.message;
    if (!isRecord(message) || !Array.isArray(message.content)) return;

    for (const block of message.content) {
      if (!isRecord(block) || block.type !== 'tool_use') continue;
      if (block.name !== 'Agent' && block.name !== 'Task') continue;
      if (typeof block.id !== 'string') continue;
      const input = block.input;
      if (!isRecord(input)) continue;
      const description = input.description;
      if (typeof description === 'string' && description.trim()) {
        this.agentToolDescriptions.set(block.id, description.trim());
      }
    }
  }

  private recordAsyncAgentLaunches(event: unknown): void {
    for (const launch of extractAsyncAgentLaunches(event, this.agentToolDescriptions)) {
      const taskEvent = this.asyncTasks.recordLaunch(launch);
      if (taskEvent) this.emitSyntheticTaskEvent(taskEvent);
    }
  }
```

Add local helper below imports:

```ts
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
```

- [ ] **Step 4: Add synthetic event emitter**

Add method inside `OrcdSession`:

```ts
  private emitSyntheticTaskEvent(event: TaskStartedEvent | TaskNotificationEvent): void {
    const eventIndex = this.buffer.push(event);
    const msg: StreamEventMessage = {
      type: 'stream_event',
      sessionId: this.id,
      eventIndex,
      event,
    };
    for (const cb of this.subscribers) cb(msg);
  }
```

- [ ] **Step 5: Call helpers inside SDK loop**

In `run`, inside the `for await` loop after `log(JSON.stringify(sdkEvent));`, add:

```ts
        this.rememberAgentToolDescriptions(sdkEvent);
        this.recordAsyncAgentLaunches(sdkEvent);
```

- [ ] **Step 6: Run session test and observe partial failure**

Run:

```bash
pnpm test src/orcd/__tests__/session-async-tasks.test.ts
```

Expected: test still FAILS because `session_exit` is immediate, but assertion for synthetic `task_started` should now pass.

---

### Task 7: Delay session_exit until JSONL task notifications resolve

**Files:**
- Modify: `src/orcd/session.ts`
- Test: `src/orcd/__tests__/session-async-tasks.test.ts`

- [ ] **Step 1: Add JSONL path resolver**

Add method inside `OrcdSession`:

```ts
  private async getJsonlPath(): Promise<string> {
    if (this.jsonlPathForTesting) return this.jsonlPathForTesting;
    return resolveJsonlPath(this.id, this.cwd);
  }
```

- [ ] **Step 2: Add JSONL notification scanner**

Add methods inside `OrcdSession`:

```ts
  private async scanJsonlTaskNotifications(): Promise<void> {
    const path = await this.getJsonlPath();
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (err) {
      if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return;
      throw err;
    }

    const lines = text.split('\n');
    for (let i = this.jsonlLinesRead; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;

      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }

      if (obj.type !== 'queue-operation' || typeof obj.content !== 'string') continue;
      const notification = parseTaskNotification(obj.content);
      if (!notification) continue;

      const event = this.asyncTasks.recordNotification(notification);
      if (event) this.emitSyntheticTaskEvent(event);
    }
    this.jsonlLinesRead = lines.length;
  }

  private async waitForAsyncTasks(): Promise<void> {
    while (this.state !== 'stopped' && this.asyncTasks.hasPending()) {
      await this.scanJsonlTaskNotifications();
      if (!this.asyncTasks.hasPending()) return;
      await new Promise((resolve) => setTimeout(resolve, this.asyncTaskPollMs));
    }
  }
```

- [ ] **Step 3: Delay completion in `run`**

In `src/orcd/session.ts`, replace this block:

```ts
      if (this.state !== 'stopped') {
        this.state = 'completed';
      }
      log(`exited (state=${this.state})`);
```

with:

```ts
      if (this.state !== 'stopped' && this.asyncTasks.hasPending()) {
        log('waiting for async task notifications before session_exit');
        await this.waitForAsyncTasks();
      }

      if (this.state !== 'stopped') {
        this.state = 'completed';
      }
      log(`exited (state=${this.state})`);
```

- [ ] **Step 4: Run delayed exit test**

Run:

```bash
pnpm test src/orcd/__tests__/session-async-tasks.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run tracker test**

Run:

```bash
pnpm test src/orcd/__tests__/async-task-tracker.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit delayed lifecycle**

Run:

```bash
git add src/orcd/session.ts src/orcd/__tests__/session-async-tasks.test.ts
git commit -m "Delay session exit for async subagents"
```

---

### Task 8: Add failed-notification session test

**Files:**
- Modify: `src/orcd/__tests__/session-async-tasks.test.ts`

- [ ] **Step 1: Add failed notification test**

Append this test inside `describe('OrcdSession async Agent lifecycle', () => { ... })`:

```ts
  it('emits failed task notification and still exits session', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orchestrel-session-'));
    const jsonlPath = join(dir, 'session.jsonl');
    await writeFile(jsonlPath, '');

    events.length = 0;
    events.push(
      toolUseEvent('call_fail', 'Review implementation'),
      asyncLaunchResult('call_fail', 'agent-fail'),
      {
        type: 'result',
        subtype: 'success',
        stop_reason: 'end_turn',
        modelUsage: { test: { contextWindow: 200000 } },
      },
    );

    const session = new OrcdSession({
      cwd: dir,
      model: 'test-model',
      provider: 'test-provider',
      sessionId: 'session-fail',
      jsonlPathForTesting: jsonlPath,
      asyncTaskPollMsForTesting: 10,
    });

    const payloads: unknown[] = [];
    session.subscribe((msg) => payloads.push(msg));

    const run = session.run({ prompt: 'go' });
    await vi.waitFor(() => expect(payloads).toContainEqual(expect.objectContaining({ type: 'result' })));

    await writeFile(jsonlPath, JSON.stringify({
      type: 'queue-operation',
      operation: 'enqueue',
      content: [
        '<task-notification>',
        '<task-id>agent-fail</task-id>',
        '<tool-use-id>call_fail</tool-use-id>',
        '<status>failed</status>',
        '<result>BLOCKED</result>',
        '</task-notification>',
      ].join('\n'),
    }) + '\n');

    await run;

    expect(payloads).toContainEqual(expect.objectContaining({
      type: 'stream_event',
      event: { type: 'task_notification', task_id: 'agent-fail', status: 'failed', result: 'BLOCKED' },
    }));
    expect(payloads.at(-1)).toEqual(expect.objectContaining({ type: 'session_exit', state: 'completed' }));
    await rm(dir, { recursive: true, force: true });
  });
```

- [ ] **Step 2: Run failed-notification test**

Run:

```bash
pnpm test src/orcd/__tests__/session-async-tasks.test.ts
```

Expected: PASS. `session_exit.state` remains `completed` because parent session ended cleanly; failed subagent is represented by `task_notification.status = failed`.

- [ ] **Step 3: Commit failed notification coverage**

Run:

```bash
git add src/orcd/__tests__/session-async-tasks.test.ts
git commit -m "Test failed async subagent notifications"
```

---

### Task 9: Verify backend router remains event-driven

**Files:**
- Modify: `src/server/controllers/card-sessions.test.ts`
- Do not modify: `src/server/controllers/card-sessions.ts` unless test proves necessary.

- [ ] **Step 1: Add regression test that backend only moves on session_exit**

Append to `src/server/controllers/card-sessions.test.ts`:

```ts
  it('does not treat task notifications as card completion', async () => {
    const { initOrcdRouter, trackSession } = await import('./card-sessions');
    initOrcdRouter(mockClient as never, bus);
    trackSession(42, 'sess-abc');

    const exitSpy = vi.fn();
    const sdkSpy = vi.fn();
    bus.on('card:42:exit', exitSpy);
    bus.on('card:42:sdk', sdkSpy);

    handler!({
      type: 'stream_event',
      sessionId: 'sess-abc',
      eventIndex: 1,
      event: { type: 'task_notification', task_id: 'agent-123', status: 'completed', result: 'DONE' },
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(sdkSpy).toHaveBeenCalledWith({ type: 'task_notification', task_id: 'agent-123', status: 'completed', result: 'DONE' });
    expect(exitSpy).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run backend router test**

Run:

```bash
pnpm test src/server/controllers/card-sessions.test.ts
```

Expected: PASS. If FAIL, only fix router to keep publishing `stream_event` payloads and only publish `card:N:exit` inside `msg.type === 'session_exit'`.

- [ ] **Step 3: Commit backend regression test**

Run:

```bash
git add src/server/controllers/card-sessions.test.ts
git commit -m "Guard card lifecycle against task notifications"
```

---

### Task 10: Run full verification and manual reproduction

**Files:**
- No code changes expected.

- [ ] **Step 1: Run focused tests**

Run:

```bash
pnpm test src/orcd/__tests__/async-task-tracker.test.ts src/orcd/__tests__/session-async-tasks.test.ts src/server/controllers/card-sessions.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run typecheck**

Run:

```bash
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 3: Run full tests**

Run:

```bash
pnpm test
```

Expected: PASS.

- [ ] **Step 4: Run lint**

Run:

```bash
pnpm lint
```

Expected: PASS.

- [ ] **Step 5: Restart services**

Run project-documented commands:

```bash
sudo systemctl restart orchestrel
```

If orcd service is separate on this host, restart it too:

```bash
sudo systemctl restart orcd
```

Expected: app starts; no TypeScript/runtime errors.

- [ ] **Step 6: Manual browser verification**

Use Orchestrel UI at `http://localhost:6194`.

1. Create or choose a test card.
2. Send prompt that launches an async Agent:

```txt
Launch a background Agent that waits briefly then reports DONE. Use run_in_background true. After launching it, end your turn immediately.
```

3. Expected while parent turn ends: card remains in `running`, not `review`.
4. Expected UI: subagent feed shows running task.
5. Expected after task notification: subagent feed marks completed, then card moves to `review`.

- [ ] **Step 7: Commit verification-only fixes if needed**

If verification required code changes, commit them with a focused message:

```bash
git add <changed-files>
git commit -m "Fix async subagent verification issues"
```

If no code changed, do not commit.

---

## Self-Review

**Spec coverage:**
- Async Agent launch detection: Task 1, Task 3, Task 4.
- Delaying card move to review: Task 5, Task 6, Task 7; backend still reacts only to `session_exit` in Task 9.
- Completion after subagent finishes: Task 7 scans JSONL queue-operation notifications and emits `task_notification` before `session_exit`.
- Failure notification handling: Task 8.
- UI task feed compatibility: Existing `task_started` / `task_notification` shapes reused; no UI changes planned unless tests reveal mismatch.
- Correct ownership: orcd owns lifecycle; backend remains event-driven.

**Placeholder scan:**
- No `TBD` / placeholder implementation directives.
- All code steps include exact code snippets or exact replacement instructions.
- All tests include exact commands and expected outcomes.

**Type consistency:**
- Parser types use `taskId` internally and emit SDK-shaped `task_id` externally.
- Notification status uses existing frontend union: `completed | failed`.
- `SessionState` remains existing union; waiting state is represented by keeping `state === 'running'` until pending tasks resolve.
