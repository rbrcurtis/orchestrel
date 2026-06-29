# Orcd-owned Background Compactor — Pi-native rewrite

**Date:** 2026-06-28
**Status:** Approved (design)
**Area:** orcd (layer 3) compaction

## Problem

After the Pi 0.78 migration, orchestrel's background compactor (BGC) no longer
works as designed. Two compaction systems now run on every orcd session:

1. **Pi's built-in auto-compaction**, enabled by default and never disabled by
   orcd (`createPiRuntimeSession` passes no `settingsManager`). It fires at
   `contextWindow - reserveTokens` (~92% of window) on `agent_end`.
2. **orcd's own BGC**, which triggers at `summarizeThreshold` (default 0.6 / 60%)
   on `context_usage` events, but *defers* the actual compaction to `beforeExit`
   via `pendingSummaries`/`applyPendingCompaction`.

These race. Pi almost always compacts first (mid-loop, at ~92%); by the time
orcd's deferred apply runs, Pi has already compacted, so orcd's
`session.compact()` errors on the already-compacted tree (`"Already compacted"` /
`"Nothing to compact"`). orcd's 60% trigger is effectively a no-op, and its
result plumbing logs a meaningless `applied: 0/0 msgs, 0 chars` (Pi's `compact()`
returns `{summary, firstKeptEntryId, tokensBefore, details}` — none of the fields
orcd reads). The offline summarizer that BGC used pre-migration was stubbed out
(`compactSession` throws, `summarizeSession` throws on non-dry-run).

The two compactors are **not** redundant by intent:

- **BGC** fires early (60%) and summarizes the *oldest 50%* of the conversation
  while the session keeps running. Because it runs in the background and keeps
  the newest half intact, it compacts without disrupting session flow. This is
  the primary, preferred mechanism.
- **Pi's native auto-compaction** at ~92% is a useful safety net for long-running
  sessions whose growth outpaces BGC.

The goal of this work is to make BGC function again, owned by orcd, writing
Pi's native compaction format, running as a true background operation — while
keeping Pi's native auto-compaction as the safety net.

## Policy (unchanged from the original BGC design)

| Parameter | Value | Source |
|-----------|-------|--------|
| Trigger threshold | `summarizeThreshold`, default **0.6** (60% of context window) | per-card `cards.summarize_threshold` |
| Keep target | **~50%** of current context — keep newest half, summarize the oldest half | `keepRecentTokens` |
| Cut selection | Pi's `prepareCompaction`/`findCutPoint` with `keepRecentTokens = floor(currentContextTokens * 0.5)`; snaps to a turn boundary, never splits a tool_use/tool_result pair | Pi `prepareCompaction` |
| Summary model | the session's own model (`card.model`), via Pi's `compact()` summarizer | — |
| Safety net | Pi native auto-compaction at ~92%, left enabled | Pi default |

> **Cut is token-based, not count-based.** The pre-migration BGC used a
> count-based `selectCutoff` (`floor(messageCount * 0.5)`). The Pi-native rewrite
> uses Pi's token-based `prepareCompaction` (`keepRecentTokens ≈ 50% of current
> context tokens`) so it can reuse Pi's tested cut + summarizer + provider auth
> (incl. claude-max OAuth) rather than hand-rolling an OAuth-aware model call.
> Same policy intent ("compact the oldest ~half"), more robust mechanism.

Only the **mechanism** changes, not the policy.

## Mechanism

### What's wrong with today's mechanism

"Prepare at 60%, apply at `beforeExit`" was built for the Claude era, when
compaction was an offline JSONL splice that had to run while the session was
idle. Pi's compaction mutates the live in-memory session tree, so the deferral
both races Pi's native compaction and no longer reflects how Pi works.

### New mechanism — true parallel background + Pi-native write

The correct Pi compaction artifact is a top-level `CompactionEntry` appended to
the session tree (NOT a Claude-shaped `system`/`compact_boundary` event, which
Pi ignores):

```json
{"type":"compaction","id":"<gen>","parentId":"<current leaf id>","timestamp":"<ISO>",
 "summary":"<summary of dropped prefix>","firstKeptEntryId":"<id of first KEPT message entry>",
 "tokensBefore":<int>,"fromHook":true}
```

On load, Pi's `buildSessionContext` walks leaf→root, finds the latest compaction
on the path, and reconstructs LLM context as
`[summary message] + [entries from firstKeptEntryId onward]`. Everything before
`firstKeptEntryId` is dropped from context but stays in the append-only file.
This directly expresses BGC's "summarize oldest, keep newest" — `firstKeptEntryId`
*is* the cut point.

Pi's own compaction applies a compaction in three lines
(`agent-session.js`):

```js
sessionManager.appendCompaction(summary, firstKeptEntryId, tokensBefore, details, fromHook)
const ctx = sessionManager.buildSessionContext()
agent.state.messages = ctx.messages
```

`session.sessionManager` and `session.agent` are public on the `AgentSession`,
so orcd (the host) can perform the same write+reload. (A Pi *extension* could
not: extensions receive a `ReadonlySessionManager` and can only compact via Pi's
inline `ctx.compact()`, which generates the summary synchronously while holding
the session — not a true background operation. The host has the access required
for parallel background compaction; this is why BGC lives in orcd.)

`fromHook: true` is mandatory — it marks the entry as externally generated so
Pi's native re-trigger guard (the stale-usage / `assistantIsFromBeforeCompaction`
check) stays coherent with the safety-net path.

## Components

### 1 + 2. pi-runtime: summarize + apply — `src/orcd/pi-runtime.ts`

The summary call and the apply both need the live `AgentSession`'s internals
(`agent.streamFn` for OAuth, `sessionManager`, `agent.state.messages`), so both
live on the pi-runtime wrapper, which closes over `session`, `modelRegistry`, and
`model`. Two new methods on `PiRuntimeSession`:

- **`prepareBgCompaction(keepFraction, currentTokens, signal)`** — runs the
  out-of-band summary, parallel-safe (reads entries; does NOT mutate the session
  or abort a turn):
  ```ts
  const entries = session.sessionManager.getBranch()
  const settings = { enabled: true, reserveTokens: 0,
                     keepRecentTokens: Math.floor(currentTokens * keepFraction) }
  const prep = prepareCompaction(entries, settings)   // Pi export; undefined ⇒ nothing to compact
  if (!prep) return null
  const { apiKey, headers } = await modelRegistry.getApiKeyAndHeaders(model)
  const result = await compact(prep, model, apiKey, headers, undefined, signal,
                               thinkingLevel, session.agent.streamFn)   // Pi export
  return result  // { summary, firstKeptEntryId, tokensBefore, details }
  ```

- **`applyBgCompaction(result)`** — the fast splice, done only when the session
  is idle:
  ```ts
  session.sessionManager.appendCompaction(result.summary, result.firstKeptEntryId,
                                          result.tokensBefore, result.details, /*fromHook*/ true)
  session.agent.state.messages = session.sessionManager.buildSessionContext().messages
  ```

`prepareCompaction`/`compact` are imported from `@earendil-works/pi-coding-agent`
(exported from the package root). Because `prepareCompaction` returns `undefined`
when there is nothing left to compact, it also doubles as the staleness check.

### 3. BGC controller — `src/orcd/socket-server.ts`

Replaces `triggerCompaction`, `pendingSummaries`, `applyPendingCompaction`, and
the `onBeforeExit` apply hook. On a `context_usage` event:

- If `summarizeThreshold > 0` and `contextTokens / contextWindow >= threshold`
  and no BGC already in flight for this session: emit `bgc_started`, call
  `prepareBgCompaction(0.5, contextTokens, signal)` **in parallel**
  (fire-and-forget; the live session keeps running). `null` ⇒ nothing to compact,
  clear the guard.
- When the summary resolves: wait for the session to be idle (`turnActive`
  false); re-check that the latest branch entry is not already a compaction; then
  call `applyBgCompaction(result)` and emit `compact_boundary`.
- Reuse the existing `compacting` set as the single-in-flight guard.

The existing `context_usage` *emission* (UI context wheel) is unchanged.

### 4. Safety-net visibility — `src/orcd/pi-events.ts` / `src/orcd/session.ts`

Pi's own auto-compaction (the ~92% safety net) emits `compaction_start` /
`compaction_end`, currently passed through as generic stream events. Map them to
emit `bgc_started` / `compact_boundary` so the UI context wheel resets when the
safety net compacts (not just when orcd's BGC does).

### 5. Cleanup

Delete now-dead Claude-era code, after the new mechanism removes their last
importers:

- `src/lib/session-compactor.ts` (its `applyCompaction`/`PreparedCompaction` were
  the prepare/defer plumbing; its `parseLines`/`buildExcerpt` only fed the dead
  summarize preview).
- `src/lib/summarize-session.ts` and the preview scripts that use it
  (`scripts/summarize.ts`, `scripts/test-summarize.ts`) — dead-run-only, replaced
  by the Pi-native summary path.
- `AUTO_COMPACT_RATIO` in `src/shared/constants.ts` (zero importers).
- `src/orcd/import-claude-session.ts` (zero importers).

The plan re-verifies importers before each deletion.

## Data flow

```
context_usage (>=60%) ──> BGC controller ──> emit bgc_started
                                          └─> summarize oldest 50% (parallel, session model)
                                                  │  (live session keeps taking turns)
                                                  ▼
                                          summary ready ──> wait until session idle
                                                  ▼
                                          applyBgCompaction: appendCompaction(fromHook=true)
                                                              + rebuild agent.state.messages
                                                  ▼
                                          emit compact_boundary (UI wheel resets)
```

## Concurrency & error handling

- **Parallel summarization is safe:** new messages added during summarization
  land after the cut point, so `firstKeptEntryId` stays valid and the post-apply
  `buildSessionContext` keeps them automatically.
- **Apply only when idle:** never reassign `agent.state.messages` while a turn is
  in flight. Use the existing `turnActive` tracking; if a turn is running when the
  summary completes, wait for `turn_end`/idle before applying.
- **Staleness guard:** if, at apply time, the latest branch entry is already a
  `compaction` (Pi's safety net fired in the interim), skip the apply — there is
  nothing left to compact and re-applying would error.
- **Single in flight:** one BGC per session at a time (existing `compacting`
  guard). A new threshold crossing while one is running is ignored.
- **Summarizer failure:** log and clear the guard; the session is unaffected
  (no mutation occurred). Pi's safety net still covers runaway growth.

## Testing

- Unit: `selectCutoff` boundary snapping (never splits tool_use/tool_result;
  honors 0.5 ratio; rejects too-few-messages).
- Unit: staleness guard (apply is skipped when the latest entry is already a
  compaction).
- Rewrite `src/orcd/__tests__/socket-server-compaction.test.ts` to the new flow
  (parallel summarize → idle apply), removing the prepare/defer assertions.
- Integration: a 60% crossing produces a Pi `compaction` entry with the correct
  `firstKeptEntryId`, context is reduced, and `compact_boundary` is emitted.
- Manual: confirm on a real session that the UI context wheel resets both when
  BGC fires (60%) and when Pi's safety net fires (~92%).

## Out of scope

- Changing the per-card `summarize_threshold` knob or its UI (kept as-is).
- Changing Pi's native auto-compaction trigger point (left at default).
## Manual `/compact` interaction

`/compact` was wired this session to route to orcd compaction
(`handleCompact` → `beginCompaction` → `triggerCompaction`). Since
`triggerCompaction` is being removed, the manual path is repointed at the new
mechanism: a manual `/compact` runs the same summarize-oldest-50% → apply flow,
but **immediately** (it does not wait for the 60% threshold; it still applies
only when the session is idle and respects the staleness guard). No separate
Pi-inline `session.compact()` path remains for the manual command.
