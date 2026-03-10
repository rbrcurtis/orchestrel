# Single Conversation Array Refactor

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 3-source message merge (history + pendingPrompt + liveMessages) with a single `conversation[]` array in the MobX SessionStore, eliminating flicker and ~6 useEffects.

**Architecture:** SessionStore owns one `conversation: ConversationRow[]` per card with content-hash dedup via `Set<string>`. Messages arrive from three sources (optimistic sends, live WS stream, history load) and all funnel through `ingest()` / `ingestBatch()` which hash, dedup, and append. SessionView becomes a dumb observer that maps conversation rows to child components.

**Tech Stack:** MobX observable arrays, Web Crypto API (SHA-256 for content hashing), React `observer()` HOC, existing WS transport layer.

---

## File Structure

| File | Responsibility |
|------|---------------|
| `app/stores/session-store.ts` | `SessionState` with `conversation[]` + `conversationIds` Set. `ingest()`, `ingestBatch()`, `clearConversation()` methods. Remove `history`/`liveMessages`. |
| `app/lib/content-hash.ts` | **New.** `contentHash(row)` — deterministic SHA-256 of `{type, message}`. Browser-compatible (Web Crypto). |
| `app/stores/root-store.ts` | Update message routing: `claude:message` → `store.ingest()`, `session:history` → `store.ingestBatch()`. |
| `app/components/SessionView.tsx` | Remove `pendingPrompt` useState, `prevLiveLen` ref, `prevStatus` ref, history-merge useMemo, ~6 useEffects. Read `conversation` directly from store. |
| `app/components/MessageBlock.tsx` | No changes needed — already receives `Record<string, unknown>` and dispatches by type. |

---

## Chunk 1: Content Hash Utility + Store Refactor

### Task 1: Create content-hash utility

**Files:**
- Create: `app/lib/content-hash.ts`

- [ ] **Step 1: Write `contentHash()` function**

```typescript
// app/lib/content-hash.ts

/**
 * Deterministic content hash for conversation row dedup.
 * Uses SHA-256 via Web Crypto (available in all modern browsers + Node 18+).
 * Falls back to simple string hash if crypto.subtle unavailable.
 */
export async function contentHash(type: string, message: Record<string, unknown>): Promise<string> {
  const payload = JSON.stringify({ type, message })
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const buf = new TextEncoder().encode(payload)
    const hash = await crypto.subtle.digest('SHA-256', buf)
    const arr = new Uint8Array(hash)
    return Array.from(arr.slice(0, 8), b => b.toString(16).padStart(2, '0')).join('')
  }
  // Fallback: simple djb2 hash
  let h = 5381
  for (let i = 0; i < payload.length; i++) {
    h = ((h << 5) + h + payload.charCodeAt(i)) >>> 0
  }
  return h.toString(16)
}

/**
 * Synchronous content hash using djb2. Use when async is inconvenient
 * (e.g., inside MobX actions that must be synchronous).
 */
export function contentHashSync(type: string, message: Record<string, unknown>): string {
  const payload = JSON.stringify({ type, message })
  let h = 5381
  for (let i = 0; i < payload.length; i++) {
    h = ((h << 5) + h + payload.charCodeAt(i)) >>> 0
  }
  return h.toString(16)
}
```

- [ ] **Step 2: Verify hash function works**

Open browser console or run:
```bash
cd /home/ryan/Code/dispatcher && node -e "
const {contentHashSync} = require('./app/lib/content-hash.ts');
// Won't work directly (TS), just verify logic:
function contentHashSync(type, message) {
  const payload = JSON.stringify({ type, message });
  let h = 5381;
  for (let i = 0; i < payload.length; i++) { h = ((h << 5) + h + payload.charCodeAt(i)) >>> 0; }
  return h.toString(16);
}
const a = contentHashSync('user', {role:'user',content:'hello'});
const b = contentHashSync('user', {role:'user',content:'hello'});
const c = contentHashSync('user', {role:'user',content:'world'});
console.log('same input same hash:', a === b);
console.log('diff input diff hash:', a !== c);
console.log('hash a:', a, 'hash c:', c);
"
```
Expected: `same input same hash: true`, `diff input diff hash: true`

- [ ] **Step 3: Commit**

```bash
git add app/lib/content-hash.ts
git commit -m "feat: add content-hash utility for conversation row dedup"
```

---

### Task 2: Refactor SessionState and SessionStore

**Files:**
- Modify: `app/stores/session-store.ts` (full rewrite of state shape and methods)

The key change: replace `liveMessages: ClaudeMessage[]` and `history: ClaudeMessage[]` with a single `conversation` array and `conversationIds` Set.

- [ ] **Step 1: Define new ConversationRow type and SessionState**

In `app/stores/session-store.ts`, replace the current `SessionState` interface and `defaultSession()`:

```typescript
import { makeAutoObservable, observable } from 'mobx'
import type { ClaudeMessage, ClaudeStatus, FileRef } from '../../src/shared/ws-protocol'
import type { WsClient } from '../lib/ws-client'
import { uuid } from '../lib/utils'
import { contentHashSync } from '../lib/content-hash'

let _ws: WsClient | null = null

export function setSessionStoreWs(ws: WsClient) {
  _ws = ws
}

function ws(): WsClient {
  if (!_ws) throw new Error('WsClient not set')
  return _ws
}

export interface ConversationRow {
  id: string                              // content hash for dedup
  type: 'user' | 'assistant' | 'result' | 'system'
  message: Record<string, unknown>
  isSidechain?: boolean
  ts?: string
}

export interface SessionState {
  active: boolean
  status: 'starting' | 'running' | 'completed' | 'errored' | 'stopped'
  sessionId: string | null
  promptsSent: number
  turnsCompleted: number
  conversation: ConversationRow[]
  conversationIds: Set<string>            // O(1) dedup lookup
  historyLoaded: boolean                  // true after first history load
  contextTokens: number
  contextWindow: number
}

function defaultSession(): SessionState {
  return {
    active: false,
    status: 'stopped',
    sessionId: null,
    promptsSent: 0,
    turnsCompleted: 0,
    conversation: [],
    conversationIds: new Set(),
    historyLoaded: false,
    contextTokens: 0,
    contextWindow: 200_000,
  }
}
```

- [ ] **Step 2: Implement `ingest()` — single message append with dedup**

Add this method to `SessionStore`:

```typescript
  /**
   * Ingest a single message (live stream or optimistic send).
   * Hashes content for dedup — if already in conversation, skips silently.
   */
  ingest(cardId: number, msg: ClaudeMessage): void {
    const s = this.getOrCreate(cardId)
    const id = contentHashSync(msg.type, msg.message)

    if (s.conversationIds.has(id)) return // dedup

    const row: ConversationRow = {
      id,
      type: msg.type as ConversationRow['type'],
      message: msg.message,
      ...(msg.isSidechain !== undefined && { isSidechain: msg.isSidechain }),
      ...(msg.ts !== undefined && { ts: msg.ts }),
    }

    s.conversation.push(row)
    s.conversationIds.add(id)

    // Extract context token usage from result messages
    if (msg.type === 'result') {
      const m = msg.message
      if (typeof m.usage === 'object' && m.usage !== null) {
        const usage = m.usage as Record<string, unknown>
        if (typeof usage.input_tokens === 'number') {
          s.contextTokens = usage.input_tokens
        }
      }
      if (typeof m.context_window === 'number') {
        s.contextWindow = m.context_window
      }
    }
  }
```

- [ ] **Step 3: Implement `ingestBatch()` — history load with dedup**

```typescript
  /**
   * Ingest a batch of messages (history load from JSONL).
   * Prepends any messages not already in conversation (history comes first).
   * Only runs once per card (guards with historyLoaded flag).
   */
  ingestBatch(cardId: number, messages: ClaudeMessage[]): void {
    const s = this.getOrCreate(cardId)

    // Skip if history was already loaded and session is actively running
    // (live messages are already in conversation, don't re-prepend stale history)
    if (s.historyLoaded && (s.status === 'running' || s.status === 'starting')) return

    const newRows: ConversationRow[] = []

    for (const msg of messages) {
      const id = contentHashSync(msg.type, msg.message)
      if (s.conversationIds.has(id)) continue

      newRows.push({
        id,
        type: msg.type as ConversationRow['type'],
        message: msg.message,
        ...(msg.isSidechain !== undefined && { isSidechain: msg.isSidechain }),
        ...(msg.ts !== undefined && { ts: msg.ts }),
      })
      s.conversationIds.add(id)
    }

    if (newRows.length > 0) {
      // Prepend history before any live messages
      s.conversation.unshift(...newRows)
    }

    s.historyLoaded = true
  }
```

- [ ] **Step 4: Implement `clearConversation()` and update `handleClaudeStatus()`**

```typescript
  /**
   * Clear conversation state (card switch, session reset).
   */
  clearConversation(cardId: number): void {
    const s = this.sessions.get(cardId)
    if (!s) return
    s.conversation = []
    s.conversationIds = new Set()
    s.historyLoaded = false
    s.contextTokens = 0
    s.contextWindow = 200_000
  }

  handleClaudeStatus(data: ClaudeStatus) {
    const s = this.getOrCreate(data.cardId)
    s.active = data.active
    s.status = data.status
    s.sessionId = data.sessionId
    s.promptsSent = data.promptsSent
    s.turnsCompleted = data.turnsCompleted
    // No liveMessages clearing needed — conversation array is append-only
  }
```

- [ ] **Step 5: Remove old methods, update mutations**

Remove the old `handleClaudeMessage()`, `setHistory()` methods entirely. Update the mutation methods to use `ingest()` for optimistic sends:

```typescript
  async sendMessage(cardId: number, message: string, files?: FileRef[]): Promise<void> {
    // Optimistic: add user message to conversation immediately
    // Server will echo the same content → same hash → deduped
    this.ingest(cardId, {
      type: 'user',
      message: { role: 'user', content: message },
    })

    const requestId = uuid()
    await ws().mutate({
      type: 'claude:send',
      requestId,
      data: { cardId, message, files },
    })
  }

  async startSession(cardId: number, prompt: string): Promise<void> {
    const s = this.getOrCreate(cardId)
    s.active = true
    s.status = 'starting'

    // Optimistic: add user message to conversation immediately
    this.ingest(cardId, {
      type: 'user',
      message: { role: 'user', content: prompt },
    })

    const requestId = uuid()
    await ws().mutate({
      type: 'claude:start',
      requestId,
      data: { cardId, prompt },
    })
  }
```

Keep `stopSession()`, `requestStatus()`, `loadHistory()` unchanged.

- [ ] **Step 6: Verify the store compiles**

```bash
cd /home/ryan/Code/dispatcher && npx tsc --noEmit 2>&1 | head -30
```

Expected: No errors in `session-store.ts` (there may be errors in SessionView.tsx — that's expected, we'll fix it next).

- [ ] **Step 7: Commit**

```bash
git add app/stores/session-store.ts
git commit -m "refactor: SessionStore — single conversation array with content-hash dedup

Replace history[] + liveMessages[] with conversation[] + conversationIds Set.
ingest() for single messages, ingestBatch() for history load.
Optimistic sends get same hash as server echo → natural dedup."
```

---

### Task 3: Update message routing in root-store

**Files:**
- Modify: `app/stores/root-store.ts` — change `claude:message` and `session:history` routing

- [ ] **Step 1: Update the `handleMessage` routing**

Find the message routing switch/if-chain and update:

```typescript
// Before (old):
// case 'claude:message': this.sessions.handleClaudeMessage(msg.cardId, msg.data); break
// case 'session:history': this.sessions.setHistory(msg.cardId, msg.messages); break

// After (new):
case 'claude:message':
  this.sessions.ingest(msg.cardId, msg.data)
  break
case 'session:history':
  this.sessions.ingestBatch(msg.cardId, msg.messages)
  break
```

`claude:status` routing stays the same — `this.sessions.handleClaudeStatus(msg.data)`.

- [ ] **Step 2: Verify compilation**

```bash
cd /home/ryan/Code/dispatcher && npx tsc --noEmit 2>&1 | grep -E '(root-store|session-store)' | head -10
```

Expected: No errors in these two files.

- [ ] **Step 3: Commit**

```bash
git add app/stores/root-store.ts
git commit -m "refactor: route WS messages to store.ingest/ingestBatch"
```

---

## Chunk 2: SessionView Simplification

### Task 4: Rewrite SessionView to use conversation array

**Files:**
- Modify: `app/components/SessionView.tsx` — major simplification

This is the biggest change. We're removing ~6 useEffects and the 3-source merge, replacing with a direct read from the store's `conversation` array.

- [ ] **Step 1: Remove old state and refs**

Delete these from SessionView:
- `const [pendingPrompt, setPendingPrompt] = useState<string | null>(null)`
- `const prevLiveLen = useRef(0)` (or similar ref tracking live message count)
- `const [historyLoading, setHistoryLoading] = useState(false)`
- `const prevStatus = useRef<string>(...)`

Replace with:
```typescript
const [startError, setStartError] = useState<string | null>(null)
const [isStarting, setIsStarting] = useState(false)
const bottomRef = useRef<HTMLDivElement>(null)
const scrollRef = useRef<HTMLDivElement>(null)
const [showScrollBtn, setShowScrollBtn] = useState(false)
const [contextTokens, setContextTokens] = useState(0)
const [contextWindow, setContextWindow] = useState(200_000)
const [compacted, setCompacted] = useState(false)
```

- [ ] **Step 2: Read conversation directly from store**

Replace the old `useMemo` merge with a direct store read:

```typescript
const session = sessionStore.getSession(cardId)
const conversation = session?.conversation ?? []
const sessionStatus = session?.status ?? 'stopped'
const sessionActive = session?.active ?? false
const sessionId = session?.sessionId ?? card?.sessionId ?? null
const isStreaming = sessionActive || isStarting
```

The `messages` array that was previously computed by useMemo is now just `conversation`.

- [ ] **Step 3: Remove eliminated useEffects**

Delete these effects:

1. **Load history on sessionId change** — replace with a single mount-time effect:
```typescript
// Load history once on mount (or when sessionId first becomes available)
useEffect(() => {
  const sid = session?.sessionId ?? card?.sessionId
  if (sid && !session?.historyLoaded) {
    sessionStore.loadHistory(cardId, sid)
  }
}, [cardId, session?.sessionId, card?.sessionId])
```

2. **Reload on completion** — DELETE entirely. Live messages are already in conversation[]. History load on turn-end was only needed because liveMessages were cleared.

3. **Clear pendingPrompt on live arrival** — DELETE entirely. No pendingPrompt state exists anymore.

4. **Clear pendingPrompt on session end** — DELETE entirely.

5. **Extract context from live messages** — Replace with a reaction to conversation changes:
```typescript
// Extract context tokens from the latest result message
useEffect(() => {
  if (conversation.length === 0) return
  // Scan backwards for latest context data
  for (let i = conversation.length - 1; i >= 0; i--) {
    const row = conversation[i]
    if (row.type === 'result') {
      const m = row.message
      if (typeof m.usage === 'object' && m.usage !== null) {
        const usage = m.usage as Record<string, unknown>
        if (typeof usage.input_tokens === 'number') {
          setContextTokens(usage.input_tokens)
        }
      }
      if (typeof m.context_window === 'number') {
        setContextWindow(m.context_window)
      }
      break
    }
    // Check assistant messages for per-message usage
    if (row.type === 'assistant') {
      const m = row.message
      if (typeof m.usage === 'object' && m.usage !== null) {
        const usage = m.usage as Record<string, unknown>
        if (typeof usage.input_tokens === 'number') {
          setContextTokens(usage.input_tokens)
        }
      }
      break
    }
  }
}, [conversation.length])
```

6. **Extract context from history** — DELETE entirely. The effect above covers both live and history messages.

- [ ] **Step 4: Simplify handleStart and handleSend**

```typescript
const handleStart = async (prompt: string) => {
  setIsStarting(true)
  setStartError(null)
  try {
    await sessionStore.startSession(cardId, prompt)
    // Optimistic message is already in conversation via store.ingest()
  } catch (err) {
    setStartError(err instanceof Error ? err.message : String(err))
    setIsStarting(false)
  }
}

const handleSend = async (prompt: string, files?: FileRef[]) => {
  setStartError(null)
  try {
    await sessionStore.sendMessage(cardId, prompt, files)
    // Optimistic message is already in conversation via store.ingest()
  } catch (err) {
    setStartError(err instanceof Error ? err.message : String(err))
  }
}
```

No `setPendingPrompt()` calls. No `addOptimisticUser()` helper.

- [ ] **Step 5: Update the card-switch reset effect**

```typescript
useEffect(() => {
  setStartError(null)
  setIsStarting(false)
  setContextTokens(0)
  setContextWindow(200_000)
  setCompacted(false)
  // Don't clear conversation here — store handles it per card via getOrCreate()
}, [cardId])
```

- [ ] **Step 6: Keep auto-scroll effects (simplify deps)**

```typescript
// Auto-scroll on new messages
useEffect(() => {
  if (conversation.length === 0) return
  const el = scrollRef.current
  if (!el) return
  const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 150
  if (nearBottom) {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }
}, [conversation.length])
```

- [ ] **Step 7: Update render — use conversation array**

Replace the message mapping:

```tsx
{conversation.map((row) => (
  <MessageBlock
    key={row.id}
    message={{ type: row.type, message: row.message, isSidechain: row.isSidechain, ts: row.ts }}
    toolResults={toolResults}
  />
))}
```

Note: `row.id` is the content hash — stable, unique, and doesn't change position. This gives React stable keys and eliminates unnecessary re-renders.

Also update `toolResults` extraction to use `conversation` instead of the old `messages`:

```typescript
const toolResults = useMemo(() => {
  const map = new Map<string, string>()
  for (const row of conversation) {
    if (row.type !== 'user') continue
    const content = row.message.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if ((block as Record<string, unknown>).type === 'tool_result') {
        const tr = block as Record<string, unknown>
        const id = tr.tool_use_id as string
        const innerContent = tr.content
        if (typeof innerContent === 'string') {
          map.set(id, innerContent)
        } else if (Array.isArray(innerContent)) {
          const text = (innerContent as Record<string, unknown>[])
            .filter(b => b.type === 'text')
            .map(b => b.text as string)
            .join('\n')
          if (text) map.set(id, text)
        }
      }
    }
  }
  return map
}, [conversation.length])
```

- [ ] **Step 8: Update the auto-start prompt effect**

```typescript
useEffect(() => {
  if (!autoStartPrompt || isStarting || sessionActive) return
  handleStart(autoStartPrompt)
  onAutoStartConsumed?.()
}, [autoStartPrompt])
```

No `addOptimisticUser()` — the store's `startSession()` already ingests the optimistic message.

- [ ] **Step 9: Verify compilation and test in browser**

```bash
cd /home/ryan/Code/dispatcher && npx tsc --noEmit 2>&1 | head -30
```

Then open the app in a browser and test:
1. Load a card with existing session history — messages should render
2. Send a message — should appear immediately, no flicker
3. Watch assistant response stream in — messages append smoothly
4. When turn completes — no flicker, result divider appears naturally
5. Switch between cards — conversation loads correctly for each

- [ ] **Step 10: Commit**

```bash
git add app/components/SessionView.tsx
git commit -m "refactor: SessionView reads single conversation array from store

Remove pendingPrompt, prevLiveLen, prevStatus, historyLoading.
Delete ~6 useEffects (pending-clear, history-reload-on-complete, etc).
Conversation is now a direct MobX observable read — no merge step."
```

---

## Chunk 3: Edge Cases and Cleanup

### Task 5: Handle compaction detection

**Files:**
- Modify: `app/stores/session-store.ts` — detect compaction in `ingest()`
- Modify: `app/components/SessionView.tsx` — react to compaction

- [ ] **Step 1: Add compaction detection to `ingest()`**

In the `ingest()` method, after the dedup check:

```typescript
  ingest(cardId: number, msg: ClaudeMessage): void {
    // ... existing code ...

    s.conversation.push(row)
    s.conversationIds.add(id)

    // Detect compaction: system message with subtype 'compact_boundary'
    if (msg.type === 'system') {
      const inner = msg.message
      if (inner.subtype === 'compact_boundary' || inner.subtype === 'init') {
        // Compaction happened — context token count will jump on next assistant msg
        // The component can detect this via the system message in conversation
      }
    }

    // ... existing context extraction code ...
  }
```

No additional state needed — the system message itself in `conversation` is the signal. SessionView can detect it the same way it detects any other message type.

- [ ] **Step 2: Update compaction detection in SessionView**

```typescript
// Detect compaction for visual indicator
useEffect(() => {
  if (conversation.length === 0) return
  const last = conversation[conversation.length - 1]
  if (last.type === 'system' && last.message.subtype === 'compact_boundary') {
    setCompacted(true)
    const t = setTimeout(() => setCompacted(false), 3000)
    return () => clearTimeout(t)
  }
}, [conversation.length])
```

- [ ] **Step 3: Commit**

```bash
git add app/stores/session-store.ts app/components/SessionView.tsx
git commit -m "feat: compaction detection via conversation array"
```

---

### Task 6: Handle file-augmented prompts in optimistic messages

**Files:**
- Modify: `app/stores/session-store.ts` — `sendMessage()` with files

- [ ] **Step 1: Update optimistic message for file sends**

When files are attached, the server augments the prompt with file paths. The optimistic message should match what the user typed (not the augmented version), since the server will echo the *augmented* prompt. This means the optimistic message will NOT dedup with the server echo — which is actually fine because the user sees their original message, then the server echo (with file paths) arrives as a separate row. But this could show duplicates.

Better approach: don't send optimistic message when files are attached (file upload takes time anyway):

```typescript
  async sendMessage(cardId: number, message: string, files?: FileRef[]): Promise<void> {
    // Only add optimistic message when no files (file prompts get augmented server-side)
    if (!files?.length) {
      this.ingest(cardId, {
        type: 'user',
        message: { role: 'user', content: message },
      })
    }

    const requestId = uuid()
    await ws().mutate({
      type: 'claude:send',
      requestId,
      data: { cardId, message, files },
    })
  }
```

- [ ] **Step 2: Commit**

```bash
git add app/stores/session-store.ts
git commit -m "fix: skip optimistic message for file sends (server augments prompt)"
```

---

### Task 7: Handle model/thinking level selectors

**Files:**
- Modify: `app/components/SessionView.tsx` — model and thinking level selectors still read from cardStore

- [ ] **Step 1: Verify model/thinking selectors still work**

These selectors update the card via `cardStore.updateCard()` — they don't touch session state. Verify they still work by:

1. Open a card with an active session
2. Change the model dropdown
3. Change the thinking level dropdown
4. Send a message — should use the new model/thinking level

No code changes needed if they already read from `cardStore`. Just verify.

- [ ] **Step 2: Commit (only if changes were needed)**

---

### Task 8: Verify the isStarting flag lifecycle

**Files:**
- Modify: `app/components/SessionView.tsx`

- [ ] **Step 1: Ensure isStarting clears on status update**

```typescript
// Clear isStarting when session actually starts running
useEffect(() => {
  if (sessionStatus === 'running' || sessionStatus === 'completed' ||
      sessionStatus === 'errored' || sessionStatus === 'stopped') {
    setIsStarting(false)
  }
}, [sessionStatus])
```

This replaces the old `prevStatus` ref logic.

- [ ] **Step 2: Commit**

```bash
git add app/components/SessionView.tsx
git commit -m "fix: clear isStarting on any non-starting status transition"
```

---

### Task 9: End-to-end manual testing

No code changes — just verification.

- [ ] **Step 1: Fresh page load with existing session**
  - Open a card that has a completed session with history
  - Verify: history loads, messages render, no flicker
  - Verify: result dividers show between turns

- [ ] **Step 2: Send a message to an existing session**
  - Type a message and send
  - Verify: message appears immediately (optimistic)
  - Verify: assistant response streams in live
  - Verify: no duplicate user message after echo
  - Verify: result divider appears when turn completes
  - Verify: no flicker at any point

- [ ] **Step 3: Start a fresh session**
  - Create a new card, move to in_progress
  - Verify: prompt sends, session starts
  - Verify: assistant response streams
  - Verify: card auto-moves to review on completion

- [ ] **Step 4: Send message with file attachment**
  - Attach a file and send
  - Verify: message appears (may not be optimistic — that's OK)
  - Verify: file paths show in the rendered message

- [ ] **Step 5: Switch between cards**
  - Open card A (has conversation), then card B (different conversation)
  - Verify: each card shows its own conversation
  - Verify: switching back to A still shows A's conversation

- [ ] **Step 6: Context gauge**
  - During a session, verify context tokens update
  - Verify context gauge shows correct fill percentage

- [ ] **Step 7: Commit final state**

```bash
git add -A
git commit -m "refactor: complete single-conversation-array migration

Replaces 3-source merge (history + liveMessages + pendingPrompt) with
single conversation[] array in MobX SessionStore. Content-hash dedup
eliminates optimistic message duplication. ~6 useEffects removed from
SessionView. No more flicker on turn completion or session start."
```
