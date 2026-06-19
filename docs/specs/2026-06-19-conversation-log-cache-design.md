# Conversation Log Cache — Design

**Date:** 2026-06-19
**Status:** Approved (pending implementation plan)

## Goal

Make opening a card paint its transcript **instantly** (perceived speed) and keep transcripts **viewable across reloads and backend/orcd outages** (resilience). Today every card open re-ships the entire session JSONL over socket.io and re-parses it; conversation messages live only in the in-memory MobX `MessageAccumulator` and are never persisted.

Drivers: **A) perceived speed** + **C) resilience**. (Not B/network-minimization — we still do a full download every open.)

## Current Behavior (baseline)

- `SessionView` → `sessionStore.loadHistory(cardId, sessionId)` → socket `session:load` → backend reads `~/.claude/projects/.../<sessionId>.jsonl` via the Agent SDK → returns `HistoryMessage[]`.
- `ingestHistory()` does `accumulator.clear()` then re-ingests everything — a **full replace**, not an append.
- Per-load dedup in `message-accumulator.ts` filters the duplicate empty-input `tool_use` blocks the JSONL records twice. It is per-load only.
- `store-persist.ts` persists card/project metadata to IndexedDB via `idb-keyval` (`serialize`/`hydrate` + debounced `autorun`). **Conversation messages are not persisted.**
- Live messages during an active session arrive via socket `session:message` (card-keyed) and are appended to the accumulator.
- `public/sw.js` is **network-first** for same-origin GET assets; skips `/api/`, `/@`/`/__vite`, `manifest.json`.

## Design Overview

Four components, **no backend changes**:

1. Add `serialize()` / `hydrate()` to `MessageAccumulator`.
2. New `app/lib/conversation-cache.ts` — per-card IndexedDB persistence with a size-based LRU.
3. Hydrate-on-open flow in `session-store` (instant paint; full download still replaces; failure keeps the cache).
4. Rewrite `public/sw.js` from network-first to stale-while-revalidate.

### Why this satisfies "download as normal + auto-dedup"

The fresh `session:load` download still runs every open and `ingestHistory()` wholesale **replaces** the hydrated copy (`clear()` + full re-ingest). There is no merge between cache and download, so no cross-load dedup is needed — the existing per-load dedup filter is sufficient. The cache is purely the instant-paint / offline copy that gets superseded once the authoritative JSONL arrives.

## Component 1 — Accumulator serialize/hydrate

In `app/lib/message-accumulator.ts`:

- `serialize(): ConversationEntry[]` — return a plain (JSON-safe) snapshot of `conversation` only.
  - **Excluded:** `currentBlocks` (in-flight stream), `subagents`, and the private trackers (`historyPendingResultTimestamp`, `historyTurnCount`, `blockingSubagentToolIds`). These are transient runtime state with no meaning after reload.
- `hydrate(entries: ConversationEntry[]): void` — replace `conversation`, reconstructing `new ContentBlock(...)` for every `kind:'blocks'` entry so MobX observability and rendering work. A raw JSON round-trip would leave plain objects, not class instances. Other entry kinds (`result`, `tool_activity`, `user`, `system`, `error`, `compact`) are plain data and pass through.

No other accumulator internals change.

## Component 2 — Conversation cache (`app/lib/conversation-cache.ts`)

- **Backing store:** IndexedDB via `idb-keyval` (already a dependency).
- **Key:** `conv:v1:<cardId>`.
  - Keyed by `cardId` (stable; matches `SessionStore.sessions: Map<cardId, SessionState>` and the card-keyed live `session:message` stream). `sessionId` can change across resume/fork; `cardId` does not. A replaced session is harmless — `loadHistory` re-downloads and replaces the entry.
  - **Version tag `v1`** so a future `ConversationEntry` shape change cleanly invalidates old caches (bump to `v2`, old keys are ignored and LRU-evicted).
- **Value:** the `serialize()` snapshot.
- **Write trigger:** a debounced `autorun` (reuse the existing 1000ms pattern) that reads `accumulator.serialize()` and writes it. Because the accumulator's blocks are observable, this also fires during active streaming (throttled to ~1/sec), so **live turns are captured mid-session** — this is what makes resilience cover active sessions, not just last-downloaded state.

### Size-based LRU eviction

- **Budget: 100 MB.**
- **Index key:** `conv:v1:index` = `Array<{ cardId: number; ts: number; bytes: number }>`.
  - We already `JSON.stringify` the snapshot to persist it, so capturing `bytes` is free.
- **On each write:** update the current card's `{ ts: Date.now(), bytes }`, sum total `bytes`, then evict oldest-by-`ts` entries (delete their `conv:v1:<cardId>` key + index row) until the total is under budget.
- **Guard:** never evict the card currently being written — even if it alone exceeds the budget — otherwise opening one huge transcript would evict itself. Evict others oldest-first until under budget or only the active card remains.

## Component 3 — Hydrate-on-open flow

In `app/stores/session-store.ts`:

1. On first access to a card (`getOrCreate`), async-read `conv:v1:<cardId>` from the cache → `accumulator.hydrate(entries)` → set a `cacheHydrated` flag so `SessionView` paints the transcript immediately (goal A) without waiting for the socket round-trip.
2. `loadHistory()` runs exactly as today: socket `session:load` → `ingestHistory()` does `clear()` + full re-ingest, **replacing** the hydrated copy with the authoritative JSONL.
3. **Failure = resilience (goal C):** `loadHistory` only ingests on success (`if (result?.messages)`), so when the backend/orcd is unreachable the hydrated cache remains on screen untouched.

The existing `historyLoaded` guard still prevents redundant reloads during active sessions; `cacheHydrated` is a separate flag tracking that the instant-paint copy is shown.

## Component 4 — Service worker → stale-while-revalidate

Rewrite the `fetch` handler in `public/sw.js`:

- **Strategy:** serve the cached response immediately if present, and fire the network fetch in the background to refresh the cache for the next load. If nothing is cached, fall back to network (then cache the result).
- **Keep:** same-origin GET-only guard; skips for `/api/`, `/@`/`/__vite`, `manifest.json`; `skipWaiting()` + `clients.claim()`.
- **Bump** `CACHE` to `orchestrel-v6` (activate handler already deletes non-current caches).
- **Benefit:** app shell + hashed assets boot instantly from cache (A) and work when the backend is unreachable (C).
- **Tradeoff:** SWR may serve a stale shell for one load before the background refresh lands. Acceptable here; hashed asset filenames make staleness self-correcting on the next navigation.

## Out of Scope

- Incremental/delta downloads (would require backend changes; we still download the full JSONL every open).
- Persisting transient runtime state (subagent progress, in-flight stream blocks).
- Any change to the `session:load` backend handler or the JSONL source of truth.

## Testing / Verification

- Unit: `MessageAccumulator.serialize()` → `hydrate()` round-trip preserves rendered conversation (especially `kind:'blocks'` reconstructed as `ContentBlock` instances). This catches the realistic bug where a JSON round-trip silently drops class behavior — unit level is right because it's pure data transformation.
- Unit: LRU eviction — over-budget writes evict oldest first and never evict the active card.
- Manual: open a long-session card cold (cache miss) → reopen (instant paint from cache, then refresh). Reload mid-active-session and confirm streamed turns survive. Stop the backend and confirm the transcript still renders from cache.
```
