# Transcript Synchronization Stage 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish and verify the no-fork synchronization boundary before changing production transcript delivery or adding IndexedDB.

**Architecture:** One orcd-owned reducer consumes the same sequenced events it publishes. Its confirmed history baseline is separate from its live overlay. A settled replacement event moves display ownership to stable Pi entries without joining live messages to persisted messages by content.

**Tech Stack:** TypeScript, installed Pi public SDK, Vitest, Node TCP, existing orcd ring-buffer and session infrastructure.

**Spec:** `docs/specs/2026-09-09-transcript-cache-design.md`

## Global Constraints

- No Pi fork, private method interception, or extension is required.
- The server remains authoritative.
- Cache failure must not interrupt chat.
- Total logical cache budget: 100 MiB, including accounted records and metadata.
- Application lifecycle continues to use orcd session exit, not `agent_settled`.
- Never match records by text, timestamps, array position, or JavaScript object identity.
- Do not change running services or installed dependencies during this gate.
- Do not launch an installed Electron binary to inspect its version.
- No shared-branch push or merge without explicit permission.
- No IndexedDB in this plan. The storage limit applies to the subsequent cache stage.

## Scope and execution gate

This is the first executable work package within Stage 1, not a claim that the
complete synchronization feature is already specified at implementation level.
The approved design has two unresolved requirements: bounded state during runs
that do not settle, and correct transport recovery during runtime replacement.
Do not hide these behind an arbitrary API or proceed to browser wiring if they
fail. This package produces reproducible integration evidence and a small,
reviewable synchronization model; the next package wires the proven contract
into existing node/backend/browser interfaces.

The prior scratch spikes were deleted. JSON summaries remain in `/tmp`, but those
summaries are evidence, not reusable test fixtures or passing regression tests.
Build the tests below against the installed SDK and real temporary session files.

## Files and responsibilities

- Create `src/orcd/__tests__/transcript-sync.integration.test.ts`: isolated public
  SDK tests for ordering, persistence, generations, and transport recovery.
- Create `src/orcd/__tests__/transcript-sync-fixture.ts`: a real faux-provider Pi
  runtime and a temporary session directory, shared by the integration tests.
  This helper belongs to tests; never inject it into production services.
- Create `src/orcd/transcript-sync.ts`: protocol-neutral reducer/snapshot state,
  only after the initial tests prove its ownership boundary.
- Create `src/shared/transcript-sync.ts`: shared wire-independent types used by
  the reducer and integration tests. No barrel exports.
- Update this plan and the specification with measured limits and accepted
  contract details after the tests, not with unsupported success claims.

Existing production touchpoints for the following package, not changed by this
one: `src/orcd/pi-runtime.ts`, `src/orcd/session.ts`,
`src/orcd/socket-server.ts`, `src/server/orcd-client.ts`,
`src/shared/orcd-protocol.ts`, `src/shared/ws-protocol.ts`,
`app/stores/session-store.ts`, `app/lib/message-accumulator.ts`, and
`app/components/LazyTranscript.tsx`.

## Task 1: make the public-SDK evidence reproducible

**Files:** Create the fixture and integration test above.

**Interface:** The test fixture owns a runtime, controlled synthetic provider,
real temporary session file, and cleanup. It uses public Pi functions only:
`createAgentSessionRuntime`, `createAgentSessionServices`,
`createAgentSessionFromServices`, `SessionManager`, `fauxProvider`, and
`fauxAssistantMessage`. Verify their actual installed signatures before writing
calls; do not copy the prior report's illustrative signatures as working code.

- [ ] Read installed `README.md`, `docs/sdk.md`, `docs/sessions.md`,
  `docs/session-format.md`, and `docs/compaction.md` completely. Follow relevant
  API references. Inspect existing `src/orcd/__tests__/pi-runtime.test.ts` for
  test conventions without inheriting mocks that bypass real SDK ordering.
- [ ] Create the faux runtime using a temporary cwd/session directory and disable
  discovery of user/project extensions. All responses come from the synthetic
  provider. Fail the test if a network-backed model would be selected.
- [ ] Subscribe before submitting prompts. Clone each observed event immediately
  with `structuredClone`; do not retain mutable Pi payload references.
- [ ] Produce three responses: an initial response and two distinct responses to
  identical follow-up text. Queue follow-ups from an earlier message callback.
- [ ] Install a test-only async message-end extension using supported resource
  loading. Delay it with an explicit promise gate, then replace final text. Do
  not use arbitrary sleeps to manufacture event ordering.
- [ ] Assert inside message-end that runtime state and persisted entries are not
  falsely assumed equivalent. At `agent_settled`, reopen the real session file
  and assert all six user/assistant entries are present with distinct entry IDs,
  including the final replacement content.
- [ ] Assert that `agent.waitForIdle()` is not used to acknowledge settlement.
  Capture both streaming flags and record the observed earlier idle transition.
- [ ] Dispose the runtime, unsubscribe, and remove its directory in `finally`.

Run:

```bash
bunx vitest run src/orcd/__tests__/transcript-sync.integration.test.ts
```

**Why keep this test:** It tests a real SDK persistence/queue boundary that mocks
cannot prove. Losing the final replacement or collapsing repeated prompts is a
user-visible transcript defect. This is integration coverage, not a unit test of
Pi internals.

**Commit:** `test: verify public Pi transcript settlement boundaries`

## Task 2: define snapshot ownership and sequenced replay

**Files:** Create the shared types and reducer module; extend the integration test.

The first contract is deliberately independent of durable-to-live identity joins:

```ts
export interface TranscriptCursor {
  streamId: string;
  sequence: number;
}

export interface TranscriptIdentity {
  nodeName: string;
  sessionId: string;
}

export interface TranscriptEnvelope<T> {
  cursor: TranscriptCursor;
  event: T;
}

export type ReplayDecision<E, S> =
  | { type: 'replay'; events: TranscriptEnvelope<E>[] }
  | { type: 'snapshot'; cursor: TranscriptCursor; state: S };
```

`streamId` is a random incarnation ID. Allocate a new one on daemon/session
recreation and runtime replacement, even when the persisted session ID is equal.
`E` is the normalized event union and `S` is the reducer state. Keep these types
separate: an event payload is not a state snapshot.

- [ ] Define concrete discriminated event/state types using the public SDK event
  union. Separate initial confirmed entry projection, transient messages, and
  settled replacement. Preserve tool/progress metadata rather than accepting
  text-only responses as the production contract.
- [ ] Implement the reducer as a session-owned object. A synchronous `accept`
  operation copies an event, increments sequence, reduces it, and inserts the
  same envelope into a bounded replay buffer. Snapshot copies that reducer's
  state and cursor together. Never read live Pi state in the snapshot method.
- [ ] Use message-start sequence as transient lifecycle identity. Final
  message-end payload replaces the corresponding transient message content,
  including asynchronous extension replacements.
- [ ] Keep the baseline fixed during the unsettled run. Do not project newer
  saved entries into it while the overlapping live overlay is displayed.
- [ ] At settlement, synchronously capture source-entry projection and produce a
  replacement event through the same sequence/reducer path. Replace the baseline
  and retire only the overlay covered by that boundary. No await is allowed
  between projection capture and event sequencing.
- [ ] Use a three-envelope ring in tests. Capture while the first response is
  partial, overflow the ring, and request an old cursor. Assert an explicit
  snapshot result, then continue the real synthetic stream and check exact
  final displayed messages. Do not assert correctness by comparing only lengths.
- [ ] Delay delivery of a settled snapshot, begin another prompt, then deliver
  the snapshot and buffered newer events. Assert the new prompt and response
  remain once and in order.
- [ ] Test duplicate delivery and unknown/future cursors. A future or foreign
  cursor must request a snapshot, not skip data. No per-event timeout promises.

Run the integration file after each case and run `bun run typecheck`.

**Why keep these cases:** They protect replay/reset decisions and data ownership
under realistic response delays. They are not duplicate SDK ordering coverage.

**Commit:** `feat: model sequenced transcript snapshots without Pi changes`

## Task 3: prove actual transport and runtime replacement recovery

**Files:** Extend `transcript-sync.integration.test.ts` and its fixture only.

- [ ] Use a real loopback TCP server on an ephemeral port. Frame snapshot and
  event messages as newline-delimited JSON, as orcd does. Keep the production
  daemon and configured ports untouched.
- [ ] Disconnect the client while the synthetic provider is paused mid-response.
  Advance the provider beyond the ring's retained range, reconnect with the old
  cursor, and apply the returned snapshot followed by newer events. Assert the
  displayed text is exact and unique without content-based deduplication.
- [ ] Repeat with a retained cursor to verify replay rather than reset.
- [ ] Dispose the runtime and recreate it from its real session file. Use a new
  stream ID with the same persisted session ID. Assert the old cursor is rejected
  and the confirmed persisted history is restored. Do not claim unsaved partial
  output survives daemon termination; the new epoch supersedes that output.
- [ ] Exercise public runtime fork during active streaming. Let the supported
  operation perform its normal abort/replacement. Assert outgoing old-epoch
  events cannot enter the replacement view. Do not change application fork
  semantics to make this test pass.
- [ ] Exercise compaction with synthetic summary output. Project entries using
  `buildContextEntries()` and `sessionEntryToContextMessages()`. Assert the view
  matches Pi's selected context while the append-only entry log remains intact.
- [ ] Close client/server sockets, remove listeners, and dispose temporary
  sessions after every test, including assertion failures.

**Why keep these cases:** Socket framing, disconnect recovery, and runtime
replacement cannot be proven by comparing fabricated cursor objects. These tests
exercise the actual boundary missing from the original spike.

Run:

```bash
bunx vitest run src/orcd/__tests__/transcript-sync.integration.test.ts
bun run typecheck
bun run lint
```

**Commit:** `test: cover transcript reconnect and active replacement recovery`

## Task 4: measure unsettled memory and decide the next package

**Files:** Extend the integration fixture for repeatable measurements; update this
plan with results. Do not add timers or sampling to production code.

- [ ] Generate a long tool-loop response with no settlement between rounds and
  large synthetic tool outputs. Record reducer retained payload bytes, replay
  bytes, confirmed baseline bytes, and process heap separately.
- [ ] Verify the replay ring bounds bytes as well as envelope count. Cloned full
  partial-message objects must not accumulate once per token; store normalized
  deltas plus final replacements, not repeated growing snapshots.
- [ ] Check that duplicate baseline/overlay copies are not retained after settled
  replacement, runtime replacement, unsubscribe, and disposal.
- [ ] Document whether completed unsettled overlay records grow with the run.
  They currently cannot be retired by guessed correspondence with persisted
  entries. If this prevents bounded paging, STOP and review a server-owned
  transient spool/page mechanism before planning browser integration. Do not
  silently turn the spec's single-active-message exception into a whole-run
  exception.
- [ ] Record source file paths, tested SDK version, measured values, passing and
  failing cases, and cleanup status. Do not retain session content from real
  users in test fixtures or documentation.

**Acceptance:** Actual transport recovery and active replacement pass; the
baseline/live ownership contract has no heuristic joins; long-run retention has
an explicit measured bound or an openly documented design blocker.

**Commit:** `docs: record transcript synchronization gate results`

## Following work package, after the gate passes

Write the next executable plan against the verified types rather than provisional
APIs. Its acceptance scope must include:

1. Source-ID history projection and typed bounded anchor pagination, preserving
   prompt normalization, model metadata, compaction, and tool attachment.
2. Consistent history revisions, explicit range coverage, and incremental
   baseline replacement on the existing node protocol.
3. Authorization and separate subscription/history actions on backend sockets.
4. Browser persisted-page/live-overlay separation, pending-send acknowledgement,
   stale-generation rejection, and independent lifecycle reconciliation.
5. Bounded viewport paging, scroll anchoring, page-boundary turn/tool rendering,
   and cache-free browser/Electron smoke verification.
6. Only then the Stage 2 IndexedDB plan: transactional record/cursor writes,
   account isolation, concurrent-tab revision checks, 100 MiB LRU, quota fallback,
   and measured warm-open/download/write/RAM behavior.

This is deliberate staging, not authorization to implement browser caching from
an incomplete server contract.
