# Kiro Agent Integration Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Kiro as a second agent type with project-level configuration, ACP stdio transport, and session log tailing/replay.

**Architecture:** Three stages — (1) enhance DirectoryBrowser with typeahead/paste/mkdir, add agent type + Kiro HOME fields to ProjectForm; (2) implement KiroSession class with ACP JSON-RPC protocol over stdio, wire into factory; (3) add Kiro session file tailing and history replay.

**Tech Stack:** React, MobX, WebSocket protocol (Zod schemas), Node.js child_process, JSON-RPC 2.0, fs.watch

---

## File Structure

### Stage 1 — UI
- **Modify:** `app/components/DirectoryBrowser.tsx` — add typeahead filter input, paste-to-navigate, New Folder button with inline name prompt
- **Modify:** `app/components/ProjectForm.tsx` — add agent type dropdown, conditional Kiro HOME picker, update validation
- **Modify:** `src/shared/ws-protocol.ts` — add `project:mkdir` client message type
- **Modify:** `src/server/ws/handlers/projects.ts` — add `handleProjectMkdir` handler
- **Modify:** `src/server/ws/handlers.ts` — wire `project:mkdir` case
- **Modify:** `app/stores/project-store.ts` — add `mkdir()` method

### Stage 2 — KiroSession
- **Create:** `src/server/agents/kiro/session.ts` — KiroSession extends AgentSession, ACP stdio transport
- **Create:** `src/server/agents/kiro/messages.ts` — normalizeKiroMessage maps ACP events to AgentMessage
- **Modify:** `src/server/agents/factory.ts` — wire KiroSession for `agentType === 'kiro'`

### Stage 3 — Log Tailing & Replay
- **Create:** `src/server/agents/kiro/session-path.ts` — resolve Kiro session log path
- **Create:** `src/server/agents/kiro/tailer.ts` — KiroSessionTailer with file-creation polling
- **Modify:** `src/server/agents/begin-session.ts` — start Kiro tailer after waitForReady
- **Modify:** `src/server/ws/handlers/sessions.ts` — resolve Kiro session files for history loading

---

## Chunk 1: Stage 1 — Directory Browser Enhancements & ProjectForm

### Task 1: Add `project:mkdir` to WS protocol

**Files:**
- Modify: `src/shared/ws-protocol.ts`
- Modify: `src/server/ws/handlers/projects.ts`
- Modify: `src/server/ws/handlers.ts`
- Modify: `app/stores/project-store.ts`

- [ ] **Step 1: Add mkdir to ws-protocol.ts**

In `src/shared/ws-protocol.ts`, add `project:mkdir` to the `clientMessage` discriminated union (after the `project:browse` entry):

```typescript
z.object({ type: z.literal('project:mkdir'), requestId: z.string(), data: z.object({ path: z.string() }) }),
```

No new server message type needed — the handler will respond with `mutation:ok` (the standard success response that `mutate()` resolves on).

- [ ] **Step 2: Add handleProjectMkdir handler**

In `src/server/ws/handlers/projects.ts`, add `mkdir` to the existing `import { readdir } from 'fs/promises'` line so it becomes `import { readdir, mkdir } from 'fs/promises'`.

Add at the bottom:

```typescript
export async function handleProjectMkdir(
  ws: WebSocket,
  msg: Extract<ClientMessage, { type: 'project:mkdir' }>,
  connections: ConnectionManager,
): Promise<void> {
  const { requestId, data: { path } } = msg
  try {
    await mkdir(path, { recursive: true })
    connections.send(ws, { type: 'mutation:ok', requestId, data: { success: true } })
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    connections.send(ws, { type: 'mutation:error', requestId, error })
  }
}
```

- [ ] **Step 3: Wire mkdir in handlers.ts dispatcher**

In `src/server/ws/handlers.ts`, import `handleProjectMkdir` from the projects handlers. Add a case after `project:browse`:

```typescript
case 'project:mkdir':
  void handleProjectMkdir(ws, msg, connections)
  break
```

- [ ] **Step 4: Add mkdir to project store**

In `app/stores/project-store.ts`, add method to `ProjectStore`:

```typescript
async mkdir(path: string): Promise<unknown> {
  const requestId = uuid()
  return ws().mutate({ type: 'project:mkdir', requestId, data: { path } })
}
```

- [ ] **Step 5: Verify TypeScript compiles**

Run: `cd /home/ryan/Code/dispatcher && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/shared/ws-protocol.ts src/server/ws/handlers/projects.ts src/server/ws/handlers.ts app/stores/project-store.ts
git commit -m "feat: add project:mkdir WS endpoint for directory creation"
```

---

### Task 2: Enhance DirectoryBrowser with typeahead, paste, and New Folder

**Files:**
- Modify: `app/components/DirectoryBrowser.tsx`

The current component is 120 lines. It uses a `Dialog` with breadcrumb nav, a `ScrollArea` listing dirs, and a footer with Cancel/Select.

- [ ] **Step 1: Add filter state and input**

Add state: `const [filter, setFilter] = useState('')`

Reset filter when `currentPath` changes — add to the existing `useEffect` or add a second one:

```typescript
useEffect(() => { setFilter('') }, [currentPath])
```

Add a text input above the directory listing (after `DialogHeader`, before `ScrollArea`):

```tsx
<div className="px-4 py-2 border-b">
  <Input
    type="text"
    value={filter}
    onChange={(e) => setFilter(e.target.value)}
    onPaste={handlePaste}
    placeholder="Filter or paste a path..."
    className="h-8 text-sm"
  />
</div>
```

Import `Input` from `~/components/ui/input`.

- [ ] **Step 2: Filter the directory listing**

Replace the `dirs.map(...)` render with a filtered version:

```typescript
const filtered = filter
  ? dirs.filter(d => d.name.toLowerCase().includes(filter.toLowerCase()))
  : dirs
```

Use `filtered.map(...)` in the render. Update the "No subdirectories" empty state to also show when `filtered.length === 0` but `dirs.length > 0` with a different message like "No matches".

- [ ] **Step 3: Add paste-to-navigate**

Add a paste handler function:

```typescript
function handlePaste(e: React.ClipboardEvent<HTMLInputElement>) {
  const text = e.clipboardData.getData('text').trim()
  if (text.startsWith('/')) {
    e.preventDefault()
    setFilter('')
    setCurrentPath(text)
  }
}
```

This is already wired to the input's `onPaste` in Step 1.

- [ ] **Step 4: Add New Folder button and inline prompt**

Add state: `const [newFolderName, setNewFolderName] = useState<string | null>(null)`

Add a "New Folder" button at the bottom of the directory listing (inside `ScrollArea`, after the dir entries):

```tsx
{newFolderName === null ? (
  <Button
    variant="ghost"
    className="w-full justify-start rounded-none h-auto px-4 py-2 text-sm font-normal text-muted-foreground"
    onClick={() => setNewFolderName('')}
  >
    <FolderPlus className="size-4 shrink-0" />
    <span>New Folder</span>
  </Button>
) : (
  <div className="flex items-center gap-2 px-4 py-2">
    <FolderPlus className="size-4 text-muted-foreground shrink-0" />
    <Input
      type="text"
      value={newFolderName}
      onChange={(e) => setNewFolderName(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && newFolderName.trim()) handleCreateFolder()
        if (e.key === 'Escape') setNewFolderName(null)
      }}
      placeholder="Folder name..."
      className="h-7 text-sm flex-1"
      autoFocus
    />
    <Button size="sm" variant="ghost" className="h-7 px-2" onClick={handleCreateFolder} disabled={!newFolderName.trim()}>
      <Check className="size-3" />
    </Button>
    <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => setNewFolderName(null)}>
      <X className="size-3" />
    </Button>
  </div>
)}
```

Import `FolderPlus`, `Check`, `X` from `lucide-react`.

Add the create handler:

```typescript
async function handleCreateFolder() {
  if (!newFolderName?.trim()) return
  const fullPath = currentPath === '/' ? `/${newFolderName.trim()}` : `${currentPath}/${newFolderName.trim()}`
  try {
    await projects.mkdir(fullPath)
    setNewFolderName(null)
    // Refresh directory listing
    setLoading(true)
    const data = await projects.browse(currentPath)
    setDirs(data as DirEntry[])
    setLoading(false)
  } catch (err) {
    setError(err instanceof Error ? err.message : 'Failed to create folder')
    setNewFolderName(null)
  }
}
```

- [ ] **Step 5: Update the onSelect signature**

Change the interface to make `isGitRepo` optional:

```typescript
interface DirectoryBrowserProps {
  initialPath?: string;
  onSelect: (path: string, isGitRepo?: boolean) => void;
  onCancel: () => void;
}
```

The current `onClick={() => onSelect(currentPath, false)}` on the Select button stays as-is (passes `false` explicitly).

- [ ] **Step 6: Verify TypeScript compiles and test visually**

Run: `cd /home/ryan/Code/dispatcher && npx tsc --noEmit`
Expected: No errors

Verify in browser: open project settings, click Browse on path field. Confirm:
- Typing in filter narrows the listing
- Pasting a full path navigates there
- New Folder button shows inline input, creates folder, listing refreshes

- [ ] **Step 7: Commit**

```bash
git add app/components/DirectoryBrowser.tsx
git commit -m "feat: add typeahead filter, paste-to-navigate, and New Folder to DirectoryBrowser"
```

---

### Task 3: Add agent type and Kiro HOME to ProjectForm

**Files:**
- Modify: `app/components/ProjectForm.tsx`
- Modify: `app/stores/project-store.ts`

- [ ] **Step 1: Add agentType and agentProfile to Project interface and form state**

In `app/components/ProjectForm.tsx`, update the `Project` interface:

```typescript
interface Project {
  id: number;
  name: string;
  path: string;
  setupCommands: string | null;
  isGitRepo: boolean;
  defaultBranch: string | null;
  defaultWorktree: boolean;
  color: string | null;
  defaultModel: 'sonnet' | 'opus';
  defaultThinkingLevel: 'off' | 'low' | 'medium' | 'high';
  agentType: 'claude' | 'kiro';
  agentProfile: string | null;
}
```

Add state variables:

```typescript
const [agentType, setAgentType] = useState<'claude' | 'kiro'>(project?.agentType ?? 'claude');
const [agentProfile, setAgentProfile] = useState(project?.agentProfile ?? '');
const [showHomeBrowser, setShowHomeBrowser] = useState(false);
```

- [ ] **Step 2: Update isValid and handleSubmit**

Update validation:

```typescript
const isValid = name.trim() && path.trim() && (!isGitRepo || defaultBranch) && (agentType !== 'kiro' || agentProfile.trim());
```

Update the `data` object in `handleSubmit`:

```typescript
const data = {
  name: name.trim(),
  path: path.trim(),
  setupCommands: setupCommands || undefined,
  defaultBranch: (isGitRepo && defaultBranch ? defaultBranch : undefined) as 'main' | 'dev' | undefined,
  defaultWorktree: isGitRepo ? defaultWorktree : undefined,
  color: color || undefined,
  defaultModel,
  defaultThinkingLevel,
  agentType,
  agentProfile: agentType === 'kiro' ? agentProfile.trim() : undefined,
};
```

- [ ] **Step 3: Add Agent Type dropdown to form UI**

Insert after the Path section (after the `</div>` closing the path field, before the Color section):

```tsx
{/* Agent Type */}
<div>
  <label className="block text-sm font-medium text-muted-foreground mb-1">Agent</label>
  <Select value={agentType} onValueChange={(v) => {
    setAgentType(v as 'claude' | 'kiro')
    if (v === 'claude') setAgentProfile('')
  }}>
    <SelectTrigger className="w-full">
      <SelectValue />
    </SelectTrigger>
    <SelectContent>
      <SelectItem value="claude">Claude Code</SelectItem>
      <SelectItem value="kiro">Kiro</SelectItem>
    </SelectContent>
  </Select>
</div>
```

- [ ] **Step 4: Add conditional Kiro HOME picker**

Insert right after the Agent Type dropdown:

```tsx
{/* Kiro HOME */}
{agentType === 'kiro' && (
  <div>
    <label className="block text-sm font-medium text-muted-foreground mb-1">Kiro HOME</label>
    <p className="text-xs text-muted-foreground mb-1.5">Auth & config directory for this Kiro instance</p>
    <div className="flex items-center gap-2">
      <Input
        type="text"
        value={agentProfile}
        readOnly
        placeholder="No directory selected"
        className="flex-1"
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setShowHomeBrowser(true)}
      >
        Browse
      </Button>
    </div>
  </div>
)}
```

Add the second `DirectoryBrowser` instance at the bottom (alongside the existing one):

```tsx
{showHomeBrowser && (
  <DirectoryBrowser
    initialPath={agentProfile || '/home/ryan'}
    onSelect={(selected) => {
      setAgentProfile(selected);
      setShowHomeBrowser(false);
    }}
    onCancel={() => setShowHomeBrowser(false)}
  />
)}
```

- [ ] **Step 5: Update project store mutation types**

In `app/stores/project-store.ts`, add `agentType` and `agentProfile` to `createProject` and `updateProject` data types:

```typescript
// In createProject data param:
agentType?: 'claude' | 'kiro'
agentProfile?: string | null

// In updateProject data param:
agentType?: 'claude' | 'kiro'
agentProfile?: string | null
```

- [ ] **Step 6: Verify TypeScript compiles**

Run: `cd /home/ryan/Code/dispatcher && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 7: Test in browser**

Open project settings, create/edit a project. Confirm:
- Agent dropdown defaults to "Claude Code"
- Switching to "Kiro" reveals the Kiro HOME picker
- Kiro HOME picker opens DirectoryBrowser with typeahead/paste/New Folder
- Switching back to Claude Code hides and clears the Kiro HOME field
- Save works with Kiro + HOME path set
- Save blocked when Kiro selected but no HOME path

- [ ] **Step 8: Commit**

```bash
git add app/components/ProjectForm.tsx app/stores/project-store.ts
git commit -m "feat: add agent type selector and Kiro HOME picker to ProjectForm"
```

---

## Chunk 2: Stage 2 — KiroSession Implementation

### Task 4: Create KiroSession class

**Files:**
- Create: `src/server/agents/kiro/session.ts`

Reference: `src/server/agents/claude/session.ts` for the pattern. KiroSession spawns `kiro-cli acp` over stdio with JSON-RPC 2.0.

- [ ] **Step 1: Create the KiroSession skeleton**

Create `src/server/agents/kiro/session.ts`:

```typescript
import { spawn } from 'child_process'
import type { ChildProcess } from 'child_process'
import { AgentSession } from '../types'
import type { SessionStatus, AgentMessage } from '../types'
import { normalizeKiroMessage } from './messages'

let nextRpcId = 1

export class KiroSession extends AgentSession {
  sessionId: string | null = null
  status: SessionStatus = 'starting'
  promptsSent = 0
  turnsCompleted = 0

  /** When true, emit messages from stdio. Set to false when tailer is active (Stage 3). */
  emitFromStdio = true
  private proc: ChildProcess | null = null
  private buffer = ''

  constructor(
    private readonly cwd: string,
    private readonly agentProfile: string,
    private readonly resumeSessionId?: string,
  ) {
    super()
  }

  async start(prompt: string): Promise<void> {
    this.proc = spawn('kiro-cli', ['acp'], {
      cwd: this.cwd,
      env: { ...process.env, HOME: this.agentProfile },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    this.proc.stdout!.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString()
      this.processBuffer()
    })

    this.proc.stderr!.on('data', (chunk: Buffer) => {
      console.error(`[kiro:stderr] ${chunk.toString().trim()}`)
    })

    this.proc.on('exit', (code) => {
      console.log(`[kiro] process exited code=${code}`)
      if (this.status === 'running' || this.status === 'starting') {
        this.status = code === 0 ? 'completed' : 'errored'
      }
      this.emit('exit')
    })

    // Initialize
    const initResult = await this.rpc('initialize', {})
    console.log('[kiro] initialized:', JSON.stringify(initResult))

    // Create or load session
    if (this.resumeSessionId) {
      const loadResult = await this.rpc('session/load', { sessionId: this.resumeSessionId })
      this.sessionId = this.resumeSessionId
      console.log('[kiro] session loaded:', JSON.stringify(loadResult))
    } else {
      const newResult = await this.rpc('session/new', {}) as Record<string, unknown>
      // Extract sessionId — field name TBD, try common variants
      this.sessionId = (newResult.sessionId ?? newResult.session_id ?? newResult.id ?? null) as string | null
      console.log(`[kiro] new session created, id=${this.sessionId}`)
    }

    this.status = 'running'

    // Send first prompt
    await this.rpc('session/prompt', { message: prompt })
  }

  async sendMessage(content: string): Promise<void> {
    if (!this.proc || this.proc.killed) throw new Error('Kiro process not running')
    this.promptsSent++
    await this.rpc('session/prompt', { message: content })
  }

  async kill(): Promise<void> {
    if (!this.proc || this.proc.killed) {
      this.status = 'stopped'
      return
    }
    try {
      this.rpcFire('session/cancel', {})
    } catch { /* ignore EPIPE */ }
    this.status = 'stopped'
    this.proc.kill('SIGTERM')
    this.proc = null
  }

  async waitForReady(): Promise<void> {
    // sessionId is set synchronously during start() after the session/new RPC resolves.
    // Since start() is awaited before waitForReady() is called (see begin-session.ts),
    // sessionId is always available by this point.
    if (this.sessionId) return
    throw new Error('Kiro session failed to initialize — no sessionId after start()')
  }

  // ── JSON-RPC transport ────────────────────────────────────────────────────

  private pendingRpc = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

  private rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = nextRpcId++
      this.pendingRpc.set(id, { resolve, reject })
      this.write({ jsonrpc: '2.0', id, method, params })
    })
  }

  /** Fire-and-forget RPC (no response expected) */
  private rpcFire(method: string, params: Record<string, unknown>): void {
    this.write({ jsonrpc: '2.0', method, params })
  }

  private write(msg: Record<string, unknown>): void {
    if (!this.proc?.stdin?.writable) return
    const json = JSON.stringify(msg)
    this.proc.stdin.write(json + '\n')
  }

  private processBuffer(): void {
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() ?? ''

    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const msg = JSON.parse(line) as Record<string, unknown>
        this.handleRpcMessage(msg)
      } catch {
        console.error('[kiro] failed to parse:', line.slice(0, 200))
      }
    }
  }

  private handleRpcMessage(msg: Record<string, unknown>): void {
    // JSON-RPC response (has id)
    if ('id' in msg && typeof msg.id === 'number') {
      const pending = this.pendingRpc.get(msg.id)
      if (pending) {
        this.pendingRpc.delete(msg.id)
        if (msg.error) {
          pending.reject(new Error(JSON.stringify(msg.error)))
        } else {
          pending.resolve(msg.result)
        }
      }
      return
    }

    // JSON-RPC notification (no id) — these are session events
    // In Stage 2 (before tailer), emit messages from stdio.
    // In Stage 3, the tailer becomes the sole event source and
    // this.emitFromStdio is set to false by begin-session.ts.
    if ('method' in msg && msg.method === 'session/notification') {
      const params = msg.params as Record<string, unknown> | undefined
      if (!params) return
      const agentMsg = normalizeKiroMessage(params)
      if (agentMsg) {
        if (agentMsg.type === 'turn_end') {
          this.turnsCompleted++
        }
        if (this.emitFromStdio) {
          this.emit('message', agentMsg)
        }
      }
      return
    }

    // Log unrecognized messages
    console.debug('[kiro] unrecognized message:', JSON.stringify(msg).slice(0, 200))
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd /home/ryan/Code/dispatcher && npx tsc --noEmit`
Expected: Errors about missing `./messages` — that's expected, we create it next.

- [ ] **Step 3: Commit**

```bash
git add src/server/agents/kiro/session.ts
git commit -m "feat: add KiroSession class with ACP JSON-RPC transport"
```

---

### Task 5: Create Kiro message normalization

**Files:**
- Create: `src/server/agents/kiro/messages.ts`

Reference: `src/server/agents/claude/messages.ts` for the pattern.

- [ ] **Step 1: Create normalizeKiroMessage**

Create `src/server/agents/kiro/messages.ts`:

```typescript
import type { AgentMessage } from '../types'

/**
 * Map ACP session/notification params to a unified AgentMessage.
 * Event type names and field structures are based on ACP protocol docs.
 * Log unrecognized events at debug level for discovery during integration.
 */
export function normalizeKiroMessage(params: Record<string, unknown>): AgentMessage | null {
  const eventType = params.type as string | undefined
  const ts = Date.now()

  switch (eventType) {
    case 'AgentMessageChunk': {
      const chunk = params.chunk as Record<string, unknown> | undefined
      const content = (chunk?.content ?? params.content ?? '') as string
      if (!content) return null
      return {
        type: 'text',
        role: 'assistant',
        content,
        timestamp: ts,
      }
    }

    case 'ToolCall': {
      const toolName = (params.toolName ?? params.tool_name ?? '') as string
      const toolCallId = (params.toolCallId ?? params.tool_call_id ?? '') as string
      const input = (params.input ?? params.params ?? {}) as Record<string, unknown>
      return {
        type: 'tool_call',
        role: 'assistant',
        content: '',
        toolCall: {
          id: toolCallId,
          name: toolName,
          params: input,
        },
        timestamp: ts,
      }
    }

    case 'ToolCallUpdate': {
      const toolCallId = (params.toolCallId ?? params.tool_call_id ?? '') as string
      const content = (params.content ?? params.output ?? '') as string
      return {
        type: 'tool_progress',
        role: 'assistant',
        content,
        toolCall: {
          id: toolCallId,
          name: '',
        },
        timestamp: ts,
      }
    }

    case 'ToolResult': {
      const toolCallId = (params.toolCallId ?? params.tool_call_id ?? '') as string
      const output = (params.output ?? params.content ?? '') as string
      const isError = (params.isError ?? params.is_error ?? false) as boolean
      return {
        type: 'tool_result',
        role: 'assistant',
        content: '',
        toolResult: {
          id: toolCallId,
          output,
          isError,
        },
        timestamp: ts,
      }
    }

    case 'TurnEnd': {
      return {
        type: 'turn_end',
        role: 'assistant',
        content: '',
        timestamp: ts,
      }
    }

    default:
      if (eventType) {
        console.debug(`[kiro] unrecognized event type: ${eventType}`)
      }
      return null
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd /home/ryan/Code/dispatcher && npx tsc --noEmit`
Expected: No errors (KiroSession imports this)

- [ ] **Step 3: Commit**

```bash
git add src/server/agents/kiro/messages.ts
git commit -m "feat: add Kiro message normalization (ACP events to AgentMessage)"
```

---

### Task 6: Wire KiroSession into factory

**Files:**
- Modify: `src/server/agents/factory.ts`

- [ ] **Step 1: Add KiroSession to factory**

In `src/server/agents/factory.ts`, add the import:

```typescript
import { KiroSession } from './kiro/session'
```

Replace the `case 'kiro':` block:

```typescript
case 'kiro':
  if (!opts.agentProfile) throw new Error('Kiro agent requires agentProfile (HOME path)')
  return new KiroSession(
    opts.cwd,
    opts.agentProfile,
    opts.resumeSessionId,
  )
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd /home/ryan/Code/dispatcher && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/server/agents/factory.ts
git commit -m "feat: wire KiroSession into agent factory"
```

---

## Chunk 3: Stage 3 — Log Tailing & Replay

### Task 7: Create Kiro session path resolver

**Files:**
- Create: `src/server/agents/kiro/session-path.ts`

Reference: `src/server/agents/claude/session-path.ts`

- [ ] **Step 1: Create session-path.ts**

Create `src/server/agents/kiro/session-path.ts`:

```typescript
import { join } from 'path'
import { readdirSync, existsSync } from 'fs'

/** Get the directory containing a Kiro session's log files */
export function getKiroSessionDir(agentProfile: string, sessionId: string): string {
  return join(agentProfile, '.kiro', 'sessions', 'cli', sessionId)
}

/**
 * Get the path to the Kiro session JSONL event log.
 * Scans the session directory for a .jsonl file.
 * Returns null if not found.
 */
export function getKiroSessionLogPath(agentProfile: string, sessionId: string): string | null {
  const dir = getKiroSessionDir(agentProfile, sessionId)
  if (!existsSync(dir)) return null

  // Look for a JSONL file in the session directory
  try {
    const files = readdirSync(dir)
    const jsonl = files.find(f => f.endsWith('.jsonl'))
    return jsonl ? join(dir, jsonl) : null
  } catch {
    return null
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/server/agents/kiro/session-path.ts
git commit -m "feat: add Kiro session path resolver"
```

---

### Task 8: Create KiroSessionTailer

**Files:**
- Create: `src/server/agents/kiro/tailer.ts`

Reference: `src/server/agents/tailer.ts`

- [ ] **Step 1: Create tailer.ts**

Create `src/server/agents/kiro/tailer.ts`. This extends the base `SessionTailer` pattern but adds file-creation polling (Kiro may create the JSONL file lazily).

```typescript
import { EventEmitter } from 'events'
import { watch, openSync, readSync, closeSync, statSync, existsSync, readFileSync, readdirSync } from 'fs'
import type { FSWatcher } from 'fs'
import { join } from 'path'
import { normalizeKiroMessage } from './messages'
import type { AgentMessage } from '../types'

const STALE_TIMEOUT = 120_000
const FILE_POLL_INTERVAL = 500
const FILE_POLL_TIMEOUT = 30_000

export class KiroSessionTailer extends EventEmitter {
  private watcher: FSWatcher | null = null
  private offset = 0
  private staleTimer: NodeJS.Timeout | null = null
  private partial = ''
  private pollTimer: NodeJS.Timeout | null = null
  private resolvedPath: string | null

  constructor(
    filePath: string | null,
    private readonly sessionDir: string,
    public readonly cardId: number,
  ) {
    super()
    this.resolvedPath = filePath
  }

  get filePath(): string | null {
    return this.resolvedPath
  }

  /** Start tailing — polls for file creation if it doesn't exist yet */
  start(): void {
    if (this.resolvedPath && existsSync(this.resolvedPath)) {
      this.beginTailing()
    } else {
      this.pollForFile()
    }
  }

  private pollForFile(): void {
    const started = Date.now()
    this.pollTimer = setInterval(() => {
      // If we don't have a resolved path yet, scan the session dir for a .jsonl file
      if (!this.resolvedPath && existsSync(this.sessionDir)) {
        try {
          const files = readdirSync(this.sessionDir)
          const jsonl = files.find(f => f.endsWith('.jsonl'))
          if (jsonl) this.resolvedPath = join(this.sessionDir, jsonl)
        } catch { /* dir may not exist yet */ }
      }
      if (this.resolvedPath && existsSync(this.resolvedPath)) {
        if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null }
        this.beginTailing()
      } else if (Date.now() - started > FILE_POLL_TIMEOUT) {
        if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null }
        console.error(`[KiroTailer:${this.cardId}] file not created within ${FILE_POLL_TIMEOUT}ms in ${this.sessionDir}`)
        this.emit('stale')
      }
    }, FILE_POLL_INTERVAL)
  }

  private beginTailing(): void {
    // Start from offset 0 — this tailer is the sole event source for Kiro sessions.
    // All events since session start must be emitted.
    this.offset = 0
    this.readNewLines() // Emit any events already written
    this.resetStaleTimer()
    this.watcher = watch(this.resolvedPath!, () => {
      this.readNewLines()
      this.resetStaleTimer()
    })
  }

  /** Read full file and normalize all events (for history replay) */
  readHistory(): AgentMessage[] {
    if (!this.resolvedPath || !existsSync(this.resolvedPath)) return []
    try {
      const content = readFileSync(this.resolvedPath, 'utf-8')
      const messages: AgentMessage[] = []
      for (const line of content.split('\n')) {
        if (!line.trim()) continue
        try {
          const raw = JSON.parse(line) as Record<string, unknown>
          const msg = normalizeKiroMessage(raw)
          if (msg) messages.push(msg)
        } catch { /* skip bad lines */ }
      }
      return messages
    } catch {
      return []
    }
  }

  private readNewLines(): void {
    if (!this.resolvedPath) return
    try {
      const size = statSync(this.resolvedPath).size
      if (size <= this.offset) return

      const fd = openSync(this.resolvedPath, 'r')
      const len = size - this.offset
      const buf = Buffer.alloc(len)
      readSync(fd, buf, 0, len, this.offset)
      closeSync(fd)
      this.offset = size

      const text = this.partial + buf.toString('utf-8')
      const lines = text.split('\n')
      this.partial = lines.pop() ?? ''

      for (const line of lines) {
        if (!line) continue
        try {
          const raw = JSON.parse(line) as Record<string, unknown>
          const msg = normalizeKiroMessage(raw)
          if (msg) this.emit('message', msg)
        } catch { /* skip bad lines */ }
      }
    } catch (err) {
      console.error('[KiroTailer] Read error:', err)
    }
  }

  private resetStaleTimer(): void {
    if (this.staleTimer) clearTimeout(this.staleTimer)
    this.staleTimer = setTimeout(() => {
      this.emit('stale')
      this.stop()
    }, STALE_TIMEOUT)
  }

  stop(): void {
    if (this.watcher) { this.watcher.close(); this.watcher = null }
    if (this.staleTimer) { clearTimeout(this.staleTimer); this.staleTimer = null }
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null }
    this.partial = ''
    this.removeAllListeners()
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd /home/ryan/Code/dispatcher && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/server/agents/kiro/tailer.ts
git commit -m "feat: add KiroSessionTailer with file-creation polling"
```

---

### Task 9: Wire Kiro tailer into session lifecycle and history loading

**Files:**
- Modify: `src/server/agents/begin-session.ts`
- Modify: `src/server/ws/handlers/sessions.ts`

- [ ] **Step 1: Start Kiro tailer after waitForReady in begin-session.ts**

In `src/server/agents/begin-session.ts`, after the `await session.waitForReady()` line (line 195), add Kiro tailer setup. Import what's needed at the top:

```typescript
import { getKiroSessionDir, getKiroSessionLogPath } from './kiro/session-path'
import { KiroSessionTailer } from './kiro/tailer'
```

After `await session.waitForReady()`:

```typescript
// Start Kiro log tailer as the sole event source (per spec: no dual-streaming)
if (agentType === 'kiro' && session.sessionId && agentProfile) {
  // Disable stdio message emission — tailer is the sole source
  const kiroSession = session as import('./kiro/session').KiroSession
  kiroSession.emitFromStdio = false

  // Use dynamic log path resolver (scans for .jsonl file).
  // If file doesn't exist yet, pass the session dir to the tailer and let it poll.
  const sessionDir = getKiroSessionDir(agentProfile, session.sessionId)
  const logPath = getKiroSessionLogPath(agentProfile, session.sessionId)

  const tailer = new KiroSessionTailer(logPath, sessionDir, cardId)
  // Forward tailer messages through the session's event emitter
  tailer.on('message', (msg: AgentMessage) => session.emit('message', msg))
  tailer.start() // Polls for file creation if logPath is null
  session.on('exit', () => tailer.stop())
}
```

- [ ] **Step 2: Add Kiro session file resolution to session history loading**

In `src/server/ws/handlers/sessions.ts`:

1. Add imports at the top:

```typescript
import { projects } from '../../db/schema'
import { getKiroSessionLogPath } from '../../agents/kiro/session-path'
```

2. Update the card query in `handleSessionLoad` (line 107) to also select `projectId`:

```typescript
const card = db.select({
  worktreePath: cards.worktreePath,
  projectId: cards.projectId,
}).from(cards).where(eq(cards.id, cardId)).get()
```

3. Update `findSessionFile` to accept an optional `agentProfile` parameter and check Kiro paths. Change the signature:

```typescript
function findSessionFile(sessionId: string, worktreePath: string | null, agentProfile?: string | null): string | null {
```

Add Kiro check before the SDK path check:

```typescript
// Try Kiro session path
if (agentProfile) {
  const kiroPath = getKiroSessionLogPath(agentProfile, sessionId)
  if (kiroPath) return kiroPath
}
```

4. At the call site, look up the project to get agentType and agentProfile:

```typescript
let agentProfile: string | null = null
let agentType: string | null = null
if (card?.projectId) {
  const proj = db.select({
    agentType: projects.agentType,
    agentProfile: projects.agentProfile,
  }).from(projects).where(eq(projects.id, card.projectId)).get()
  agentType = proj?.agentType ?? null
  agentProfile = proj?.agentProfile ?? null
}
const filePath = findSessionFile(sessionId, card?.worktreePath ?? null, agentProfile)
```

5. For Kiro sessions, the normalization pipeline is different — Kiro JSONL events use ACP format, not Claude SDK format. Discriminate on `agentType`, not `agentProfile`:

```typescript
if (agentType === 'kiro' && agentProfile && filePath) {
  // Kiro session — use Kiro normalizer
  const { KiroSessionTailer } = await import('../../agents/kiro/tailer')
  const { getKiroSessionDir } = await import('../../agents/kiro/session-path')
  const sessionDir = getKiroSessionDir(agentProfile, sessionId)
  const tailer = new KiroSessionTailer(filePath, sessionDir, cardId)
  messages = tailer.readHistory()
} else if (filePath) {
  // Claude session — existing normalization pipeline
  // ... (existing code stays as-is)
}
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd /home/ryan/Code/dispatcher && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/server/agents/begin-session.ts src/server/ws/handlers/sessions.ts
git commit -m "feat: wire Kiro tailer into session lifecycle and history resolution"
```

---

## Post-Implementation

After all tasks are complete:
1. Verify the full flow end-to-end: create a project with Kiro agent type, set a HOME path, create a card, send a message — confirm KiroSession spawns `kiro-cli acp` with the right HOME
2. Verify session history loads for Kiro sessions after page refresh
3. Run `npx tsc --noEmit` to confirm no type errors
