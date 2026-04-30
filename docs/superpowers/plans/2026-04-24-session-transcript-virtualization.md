# Session Transcript Virtualization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make switching cards with large session histories responsive by virtualizing the `SessionView` transcript instead of mounting every `MessageBlock` at once.

**Evidence:** Chrome trace `/tmp/Trace-20260424T123434.json.gz` captured a card switch where one `EventDispatch click` blocked the renderer main thread for ~1769.9ms. The click was dominated by React/V8 work under `react-dom_client.js`; DOM counters rose from ~21,603 nodes / 5,682 listeners / 103MB heap to ~30,433 nodes / 8,425 listeners / ~151MB heap. CPU samples point at `SessionView` rendering `conversation.map(...)` into `MessageBlock`, with downstream cost in `react-markdown`, `BashToolBlock`, `ToolUseBlock`, and Radix `ScrollArea`.

**Architecture:** Extract the transcript rendering into a dedicated virtualized component powered by `@tanstack/react-virtual`. `SessionView` keeps owning session state, status controls, prompt input, and send/stop behavior. The virtual transcript renders only visible rows plus overscan inside the existing scroll viewport, preserves bottom-pinned chat behavior, and exposes an imperative `scrollToBottom()` API back to `SessionView`.

**Tech Stack:** React 19, MobX, `@tanstack/react-virtual`, TypeScript, Vite/React Router, Chrome DevTools performance trace.

---

## File Structure

| File | Change |
|------|--------|
| `package.json` | Add `@tanstack/react-virtual` dependency |
| `pnpm-lock.yaml` | Updated by `pnpm add` |
| `app/components/VirtualTranscript.tsx` | New virtualized transcript component |
| `app/components/SessionView.tsx` | Replace full `conversation.map(...)` render with `VirtualTranscript`; keep status/prompt behavior |
| `app/components/MessageBlock.tsx` | Memoize stable message rows after virtualization is in place |

---

## Task 1: Add Virtualization Dependency

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

- [ ] **Step 1: Install `@tanstack/react-virtual`**

```bash
cd /home/ryan/Code/orchestrel
pnpm add @tanstack/react-virtual
```

- [ ] **Step 2: Verify package metadata changed only as expected**

```bash
cd /home/ryan/Code/orchestrel
git diff -- package.json pnpm-lock.yaml
```

Expected: `@tanstack/react-virtual` appears in dependencies and the lockfile has matching entries. Existing unrelated local changes must not be reverted.

- [ ] **Step 3: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore: add transcript virtualization dependency"
```

---

## Task 2: Create `VirtualTranscript`

**Files:**
- Create: `app/components/VirtualTranscript.tsx`

This component owns the virtualizer and DOM structure for the scrollable message list. It must not own session lifecycle, websocket calls, prompt state, or card updates.

- [ ] **Step 1: Create the component skeleton**

Create `app/components/VirtualTranscript.tsx`:

```tsx
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronDown } from 'lucide-react';
import { MessageBlock } from './MessageBlock';
import { ScrollArea } from '~/components/ui/scroll-area';
import type { ContentBlock, ConversationEntry } from '~/lib/message-accumulator';

export type VirtualTranscriptHandle = {
  scrollToBottom: (behavior?: ScrollBehavior) => void;
  isNearBottom: () => boolean;
};

type Props = {
  cardId: number;
  conversation: ConversationEntry[];
  currentBlocks: ContentBlock[];
  accentColor?: string | null;
  historyLoaded: boolean;
  isStreaming: boolean;
  showScrollButton: boolean;
  onNearBottomChange: (nearBottom: boolean) => void;
  onShowScrollButtonChange: (show: boolean) => void;
};

const BOTTOM_GAP_PX = 120;
const SCROLL_BUTTON_GAP_PX = 60;
```

- [ ] **Step 2: Build a stable virtual item list**

Inside the component, derive a single `items` array:

```tsx
const items = useMemo(() => {
  if (currentBlocks.length === 0) return conversation;
  return [
    ...conversation,
    { kind: 'blocks' as const, blocks: currentBlocks, __current: true },
  ];
}, [conversation, currentBlocks]);
```

Do not mutate `conversation` or `currentBlocks`.

- [ ] **Step 3: Use the Radix viewport as the scroll element**

Implement refs and `useVirtualizer`:

```tsx
const scrollRef = useRef<HTMLDivElement>(null);

const rowVirtualizer = useVirtualizer({
  count: items.length,
  getScrollElement: () => scrollRef.current,
  estimateSize: (idx) => {
    const item = items[idx];
    if (!item) return 72;
    if (item.kind === 'blocks') return 180;
    if (item.kind === 'tool_activity') return 220;
    if (item.kind === 'user') return 90;
    if (item.kind === 'result' || item.kind === 'compact' || item.kind === 'system') return 36;
    return 120;
  },
  overscan: 10,
});
```

Use estimated sizes only as first-pass guesses; actual row heights are measured by `rowVirtualizer.measureElement`.

- [ ] **Step 4: Expose bottom-scroll methods**

Expose imperative methods to `SessionView`:

```tsx
useImperativeHandle(ref, () => ({
  scrollToBottom(behavior: ScrollBehavior = 'auto') {
    if (items.length === 0) return;
    rowVirtualizer.scrollToIndex(items.length - 1, { align: 'end', behavior });
  },
  isNearBottom() {
    const el = scrollRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_GAP_PX;
  },
}), [items.length, rowVirtualizer]);
```

- [ ] **Step 5: Track near-bottom state from scroll events**

Add a scroll listener on the viewport:

```tsx
useEffect(() => {
  const el = scrollRef.current;
  if (!el) return;

  function update() {
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    onNearBottomChange(gap < BOTTOM_GAP_PX);
    onShowScrollButtonChange(gap >= SCROLL_BUTTON_GAP_PX);
  }

  update();
  el.addEventListener('scroll', update, { passive: true });
  return () => el.removeEventListener('scroll', update);
}, [cardId, onNearBottomChange, onShowScrollButtonChange]);
```

- [ ] **Step 6: Auto-scroll on card switch, history load, and streaming growth**

Add effects with these rules:

- On `cardId` change, scroll to bottom after the virtualizer has a chance to measure.
- When `historyLoaded` becomes true and `conversation.length > 0`, scroll to bottom.
- When `items.length` grows while streaming and the user is near bottom, scroll to bottom.

Implementation pattern:

```tsx
const nearBottomRef = useRef(true);
const prevItemsLen = useRef(0);

useEffect(() => {
  nearBottomRef.current = true;
  requestAnimationFrame(() => {
    rowVirtualizer.scrollToIndex(Math.max(items.length - 1, 0), { align: 'end' });
  });
}, [cardId, items.length, rowVirtualizer]);

useEffect(() => {
  if (!historyLoaded || conversation.length === 0) return;
  nearBottomRef.current = true;
  requestAnimationFrame(() => {
    rowVirtualizer.scrollToIndex(items.length - 1, { align: 'end' });
  });
}, [historyLoaded, conversation.length, items.length, rowVirtualizer]);

useEffect(() => {
  if (items.length <= prevItemsLen.current) {
    prevItemsLen.current = items.length;
    return;
  }
  prevItemsLen.current = items.length;
  if (!isStreaming || !nearBottomRef.current || items.length === 0) return;
  requestAnimationFrame(() => {
    rowVirtualizer.scrollToIndex(items.length - 1, { align: 'end' });
  });
}, [items.length, isStreaming, rowVirtualizer]);
```

Keep `nearBottomRef` updated inside the scroll listener in Step 5.

- [ ] **Step 7: Render virtual rows**

Render rows with absolute positioning inside a height-preserving container:

```tsx
return (
  <div className="relative flex-1 min-h-0 min-w-0">
    <ScrollArea viewportRef={scrollRef} className="h-full">
      <div className="relative px-3 py-2 min-w-0 max-w-full overflow-x-hidden" style={{ height: rowVirtualizer.getTotalSize() }}>
        {rowVirtualizer.getVirtualItems().map((virtualRow) => {
          const item = items[virtualRow.index];
          if (!item) return null;
          return (
            <div
              key={virtualRow.key}
              data-index={virtualRow.index}
              ref={rowVirtualizer.measureElement}
              className="absolute left-3 right-3"
              style={{ transform: `translateY(${virtualRow.start}px)` }}
            >
              <MessageBlock
                entry={item}
                index={virtualRow.index}
                accentColor={accentColor}
              />
            </div>
          );
        })}
      </div>
    </ScrollArea>

    {!historyLoaded && conversation.length === 0 && (
      <div className="absolute inset-0 flex items-center justify-center">
        <svg className="size-6 animate-spin text-muted-foreground" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" opacity="0.25" />
          <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </div>
    )}

    {showScrollButton && (
      <button
        type="button"
        onClick={() => rowVirtualizer.scrollToIndex(Math.max(items.length - 1, 0), { align: 'end', behavior: 'smooth' })}
        className="absolute bottom-3 right-3 size-8 flex items-center justify-center rounded-full bg-muted/80 border border-border text-muted-foreground shadow-md backdrop-blur-sm hover:bg-muted hover:text-foreground transition-colors"
      >
        <ChevronDown className="size-4" />
      </button>
    )}
  </div>
);
```

If the `px-3` plus `left-3/right-3` positioning creates incorrect width, replace with an inner unpadded virtualizer container and put `px-3 py-2` on each row wrapper. The final layout must match the existing transcript spacing.

- [ ] **Step 8: Verify the new file typechecks in isolation**

```bash
cd /home/ryan/Code/orchestrel
pnpm typecheck
```

Expected: no new TypeScript errors from `VirtualTranscript.tsx`.

- [ ] **Step 9: Commit**

```bash
git add app/components/VirtualTranscript.tsx
git commit -m "feat: add virtual transcript component"
```

---

## Task 3: Integrate `VirtualTranscript` into `SessionView`

**Files:**
- Modify: `app/components/SessionView.tsx`

- [ ] **Step 1: Replace transcript-specific imports and refs**

Change imports:

```tsx
import { useState, useRef, useEffect, useCallback } from 'react';
import { Send, Square, Play, AlertCircle, Paperclip, X, WifiOff } from 'lucide-react';
import { VirtualTranscript, type VirtualTranscriptHandle } from './VirtualTranscript';
```

Remove these imports from `SessionView.tsx`:

```tsx
import { ChevronDown } from 'lucide-react';
import { MessageBlock } from './MessageBlock';
import { ScrollArea } from '~/components/ui/scroll-area';
```

Remove these refs because `VirtualTranscript` owns them:

```tsx
const bottomRef = useRef<HTMLDivElement>(null);
const scrollRef = useRef<HTMLDivElement>(null);
const contentRef = useRef<HTMLDivElement>(null);
const nearBottomRef = useRef(true);
const isStreamingRef = useRef(false);
```

Add:

```tsx
const transcriptRef = useRef<VirtualTranscriptHandle>(null);
const nearBottomRef = useRef(true);
```

The `nearBottomRef` remains in `SessionView` only as shared state for deciding whether the parent considers the transcript near the bottom; DOM measurement lives in `VirtualTranscript`.

- [ ] **Step 2: Remove obsolete transcript effects**

Delete these effects from `SessionView.tsx`:

- ResizeObserver auto-scroll effect currently around lines 113-152.
- Scroll listener effect currently around lines 154-167.
- Card-switch scroll effect currently around lines 184-191.
- History-loaded scroll effect currently around lines 193-203.

Keep:

- History load/subscription effect.
- Status request effect.
- Card switch reset effect.
- Error notification effect.
- Compaction detection effect.

- [ ] **Step 3: Add stable callbacks for transcript state**

Add callbacks near other handlers:

```tsx
const handleNearBottomChange = useCallback((near: boolean) => {
  nearBottomRef.current = near;
}, []);

const handleShowScrollButtonChange = useCallback((show: boolean) => {
  setShowScrollBtn(show);
}, []);
```

- [ ] **Step 4: Replace the rendered message area**

Replace the existing `<div className="relative flex-1...">...</div>` message area with:

```tsx
<VirtualTranscript
  ref={transcriptRef}
  cardId={cardId}
  conversation={conversation}
  currentBlocks={currentBlocks}
  accentColor={accentColor}
  historyLoaded={historyLoaded}
  isStreaming={isStreaming}
  showScrollButton={showScrollBtn}
  onNearBottomChange={handleNearBottomChange}
  onShowScrollButtonChange={handleShowScrollButtonChange}
/>
```

- [ ] **Step 5: Verify prompt focus click behavior still works**

`handlePanelClick()` should continue focusing `textareaRef` when the user clicks non-interactive transcript whitespace. Because virtual rows use absolutely positioned wrappers, verify the click target still bubbles to the parent. If needed, add `data-interactive` only to controls, not row wrappers.

- [ ] **Step 6: Run typecheck**

```bash
cd /home/ryan/Code/orchestrel
pnpm typecheck
```

Expected: no new TypeScript errors.

- [ ] **Step 7: Commit**

```bash
git add app/components/SessionView.tsx
git commit -m "feat: virtualize session transcript rendering"
```

---

## Task 4: Memoize Stable Message Rows

**Files:**
- Modify: `app/components/MessageBlock.tsx`

Virtualization reduces mounted rows, but scrolling will remount/re-render rows. Add memoization after virtualization works so stable rows are cheap when they stay within overscan.

- [ ] **Step 1: Import `memo`**

Change:

```tsx
import { useState, useMemo, useCallback } from 'react';
```

To:

```tsx
import { memo, useState, useMemo, useCallback } from 'react';
```

- [ ] **Step 2: Wrap the observer component in `memo`**

Change:

```tsx
export const MessageBlock = observer(function MessageBlock({ entry, index: _index, accentColor }: Props) {
  ...
});
```

To:

```tsx
export const MessageBlock = memo(observer(function MessageBlock({ entry, index: _index, accentColor }: Props) {
  ...
}));
```

Do not add a custom comparator unless a trace proves the default prop identity comparison is insufficient. `ConversationEntry` objects should be stable for completed history rows.

- [ ] **Step 3: Hoist date formatter**

Replace per-call `new Intl.DateTimeFormat(...)` with a module-level formatter:

```tsx
const ENTRY_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

function formatEntryTime(timestamp?: number): string | null {
  if (!timestamp) return null;
  return ENTRY_TIME_FORMATTER.format(new Date(timestamp));
}
```

- [ ] **Step 4: Run focused tests**

```bash
cd /home/ryan/Code/orchestrel
pnpm vitest run app/components/MessageBlock.test.tsx
```

Expected: existing `MessageBlock` tests pass.

- [ ] **Step 5: Run typecheck**

```bash
cd /home/ryan/Code/orchestrel
pnpm typecheck
```

Expected: no new TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add app/components/MessageBlock.tsx
git commit -m "perf: memoize stable message block rendering"
```

---

## Task 5: Browser Verification

**Files:**
- No source changes unless issues are found.

- [ ] **Step 1: Start the dev server**

```bash
cd /home/ryan/Code/orchestrel
pnpm dev
```

Use the URL reported by the dev server.

- [ ] **Step 2: Verify card-switch behavior manually**

In the browser:

- Open a card with a large existing session transcript.
- Switch away to another card.
- Switch back.
- Confirm the transcript lands at the bottom.
- Scroll upward and confirm older entries render as they enter view.
- While scrolled up, confirm new streaming output does not force-scroll.
- At bottom, send or stream output and confirm it stays pinned to bottom.
- Confirm the scroll-to-bottom button appears when scrolled up and scrolls smoothly to the newest row.

- [ ] **Step 3: Check browser console**

Expected: no React key warnings, virtualizer measurement warnings, or runtime exceptions.

- [ ] **Step 4: Capture a comparison Chrome trace**

Record the same action as `/tmp/Trace-20260424T123434.json.gz`: switch to a card with a large transcript.

Compare:

- Longest `EventDispatch click` duration.
- DOM node count delta during switch.
- JS listener count delta during switch.
- Heap spike during switch.
- `UpdateLayoutTree`, `ParseHTML`, and `Layout` totals near the click.

Target improvement:

- Card-switch click task under 250ms in dev build.
- DOM node delta reduced by at least 70%.
- Listener delta reduced by at least 70%.
- No new repeated layout thrash pattern.

- [ ] **Step 5: Commit any verification fixes**

If browser verification required follow-up source changes:

```bash
git add <changed-files>
git commit -m "fix: stabilize virtual transcript scrolling"
```

---

## Task 6: Final Validation

- [ ] **Step 1: Run focused component tests**

```bash
cd /home/ryan/Code/orchestrel
pnpm vitest run app/components/MessageBlock.test.tsx
```

- [ ] **Step 2: Run full typecheck**

```bash
cd /home/ryan/Code/orchestrel
pnpm typecheck
```

- [ ] **Step 3: Run lint on touched files**

```bash
cd /home/ryan/Code/orchestrel
pnpm lint app/components/SessionView.tsx app/components/VirtualTranscript.tsx app/components/MessageBlock.tsx
```

If `pnpm lint` does not accept file arguments in this repo, run:

```bash
cd /home/ryan/Code/orchestrel
pnpm lint
```

- [ ] **Step 4: Inspect final diff**

```bash
cd /home/ryan/Code/orchestrel
git diff --stat HEAD~4..HEAD
```

Expected touched files:

- `package.json`
- `pnpm-lock.yaml`
- `app/components/VirtualTranscript.tsx`
- `app/components/SessionView.tsx`
- `app/components/MessageBlock.tsx`

- [ ] **Step 5: Record performance result**

Update shared memory with:

- New trace path.
- Before/after click duration.
- Before/after DOM node and listener deltas.
- Any remaining bottleneck visible in the trace.

---

## Risks and Guardrails

- **Variable row heights:** Use `measureElement` on every virtual row. Do not assume fixed heights; markdown and tool blocks vary substantially.
- **Bottom-pinned chat semantics:** Preserve the existing rule: auto-scroll only on first load/card switch, history-loaded transition, or streaming while already near bottom.
- **Current streaming block:** Include `currentBlocks` as a synthetic final row so in-progress assistant/tool output remains visible and measurable.
- **Row keys:** Start with `virtualRow.key` from the virtualizer. If completed rows reorder or remount excessively, add a local `getEntryKey(entry, index)` helper based on stable fields where available.
- **Radix ScrollArea interaction:** The virtualizer must use the Radix viewport element, not the root wrapper. If measuring or scrolling behaves incorrectly, replace only the transcript's outer scroll container with a native scroll div; do not change app-wide `ScrollArea`.
- **Dev-build trace inflation:** The original trace was a Vite/React dev build. Compare dev-to-dev first; production validation can follow if dev numbers improve.
