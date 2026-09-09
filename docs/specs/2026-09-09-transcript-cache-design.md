# Incremental transcript synchronization and browser cache

Date: 2026-09-09
Status: Original design approved; no-fork revision awaiting review

## Goal and scope

Open previously viewed transcripts quickly, avoid repeated full-history downloads,
and bound browser memory and disk use without losing live prompts or replies.

Scope is transcript caching only. Card/project caches, service-worker behavior,
offline sending, desktop runtime changes, and unrelated renderer optimizations
are excluded. Cached content may remain visible during a connection failure, but
full offline support is not a requirement. Browser Find is limited to mounted
content; Ryan accepted loading older content on demand.

Deliver in two stages. Stage 1 must work and pass live verification without
IndexedDB. Stage 2 adds storage to that verified protocol.

## Current implementation and constraints

- `app/stores/session-store.ts`: `loadHistory()` downloads all history;
  `ingestHistory()` clears the accumulator before rebuilding it. The terminal
  status transition requests history to recover the final persisted response.
- `src/server/ws/handlers/sessions.ts`: history retrieval and live subscription
  are coupled. The room join and upstream subscription occur after the history
  read. Cache hits cannot bypass subscription.
- `src/lib/pi-session-history.ts`: uses Pi's active session context and assigns
  history UUIDs from array positions. These are not stable cache identities.
  The underlying session tree supplies persisted entry IDs and parent IDs.
- orcd replay uses an in-memory event index. It is not a durable history cursor
  and must not be treated as one across daemon/session restarts.
- `app/lib/message-accumulator.ts`: history rendering is stateful across rows,
  including tool-result attachment and inferred turn markers. Arbitrary page
  boundaries cannot be fed into it as independent complete transcripts.
- `app/components/LazyTranscript.tsx`: limits initial rendered rows but retains
  the full transcript in the store and grows the rendered range when scrolling.
  This is not a bounded RAM cache.
- User identity is available through authenticated socket state and browser sync.

Do not restore the removed full-transcript persistence autorun, lossy update
throttle, per-event dispatch timeout, permanent card listeners, or guessed
text-based final-message reconstruction.

## Stage 1: reliable incremental synchronization

### Ownership and identities

orcd owns the live/history synchronization boundary for its sessions. The backend
checks access and routes requests to the owning node; it must not infer lifecycle
completion from a result event. Inactive history can use the same node-side reader
without creating an agent session.

Expose typed history records based on persisted Pi entry IDs. Include effective
session identity and branch/view revision. IDs derived from array position,
timestamps, or message text are forbidden. Synthetic records use a reserved,
deterministic identity tied to their source entry or effective session.

Keep the existing transcript display policy: this work must not silently replace
Pi's current context view with a different full archival view. Preserve prompt
normalization, tool outputs, model information, and compaction/turn markers.
Use Pi's public `buildContextEntries()` and `sessionEntryToContextMessages()`
to project each source entry while retaining its persisted ID. These APIs exist
in installed Pi 0.84.2. Do not infer correspondence by matching content or array
order. No Pi fork, private method interception, or extension is required.

Separate two cursor types:

1. History cursor: versioned, opaque node-issued token identifying effective
   session, branch/view revision, and synchronization position.
2. Live cursor: session incarnation/epoch plus ordered event sequence. A new
   incarnation invalidates old replay cursors even if the numeric index matches.

### Snapshot and live overlap

Subscribing must not depend on a successful cache or history read. Establish live
delivery before fetching history, but do not claim that subscribe-first alone
solves overlap.

Maintain one orcd-owned display reducer per resident session, attached before
prompting. In one synchronous SDK subscriber callback, clone the event, update
the reducer, assign its sequence, and retain/publish that same envelope. Snapshot
the reducer and sequence together without awaiting. Do not pair a direct read of
Pi's mutable state with an independently sampled event cursor: agent state can
advance before AgentSession has delivered all events or persisted the message.

The reducer contains a confirmed history baseline and a transient display overlay.
Give transient records lifecycle IDs scoped to the stream incarnation and their
message-start sequence. Do not join these IDs to persisted entries by text,
timestamps, array positions, or WeakMap object identity.

At `agent_settled`, capture the authoritative entry projection synchronously and
publish an atomic baseline-replacement event that supersedes the overlay through
that event sequence. Transfer only changed history records and explicit coverage
metadata; replacement of display ownership does not require downloading the whole
transcript. Do not merge fresh persisted entries into the active overlay before
this boundary. Midstream snapshots use the reducer's existing baseline plus its
complete overlay, not a newly read overlapping history prefix.

Queued prompts remain part of the transient run until settlement. Application
request IDs identify send attempts and acknowledgements only; this design does
not require Pi to persist them. Pending/unaccepted sends must remain separate
from the authoritative transcript. Do not remove them by matching text. The
implementation must specify acceptance behavior in the UI so a pending indicator
does not become a second apparent saved message.

A cache-free integration test must prove baseline replacement during delayed
response delivery: retain events newer than the replacement cursor, and never
let an older response clear a newer live generation.

Replay must report its epoch, retained sequence range, replay completion, and any
gap. Preserve ordered delivery when replay and new events overlap. Deduplicate
by epoch/sequence, never by elapsed time. On a gap, reconcile authoritative history
and obtain current in-progress state from the owner rather than invent missing
text or continuing an incomplete delta sequence.

Stage 1 acceptance requires proving reducer snapshots and settled baseline
replacement with the installed Pi integration. `agent.waitForIdle()` is not a
settlement boundary: the spike observed AgentSession still streaming after it
resolved. `agent_settled` supplies a history reconciliation signal, not permission
for the backend to infer session exit.

A settled fork replaces the runtime and invalidates the stream incarnation.
Compaction replaces the context view after its public completion event. During
an active fork, await the supported abort/replacement operation and its settlement
before publishing the new baseline; verify this in integration before release.
Do not alter the user's fork behavior merely to simplify caching.

### History operations

Support bounded latest-page reads, older/newer-page reads, and synchronization
since a history cursor. Requests and responses identify the effective session,
request generation, and authoritative view revision. Pagination uses stable
record anchors rather than numeric offsets.

Responses contain stable record IDs and ordering, changed records, explicit
invalidations or replacement instructions, page coverage, and continuation
cursors. Empty success, unavailable history, and failure are distinct outcomes.
An empty failure response must not delete cached or live content.

Capture pages against a consistent revision. If a revision cannot be served,
return an explicit retry/reset response rather than pages from mixed snapshots.
Large catch-up ranges must be paginated. The browser advances its committed
cursor only for the portion fully applied; partial cached ranges retain explicit
coverage and must not imply that omitted history was stored.

Appending history retains existing records. A fork, compaction, reset, or source
replacement invalidates only history the server identifies as obsolete in the
current transcript view. A safe reset of persisted pages is permitted if a
precise suffix repair is unavailable. It must preserve unrelated optimistic
prompts and current live content. A different effective session gets a separate
cache identity, not a text/index merge with its predecessor.

### Browser behavior

Maintain persisted history pages separately from the live overlay. Opening a card
starts subscription and history synchronization independently. Apply responses
only to the matching identity and request generation. Coalesce repeated sync
requests without dropping a required follow-up synchronization.

At `agent_settled` and the existing terminal transition, reconcile history
incrementally. Preserve lifecycle ownership and ensure session exit also triggers
final reconciliation independent of status/event ordering. Coalesce duplicate
requests but retain a follow-up request when the history revision changes during
a read. A result or agent settlement alone is not session exit.

History projection and rendering must support page boundaries explicitly. Tool
results must remain associated with their tool calls even when they fall on a
separate page. Turn markers must not be created merely because a page ended.
Provide the boundary metadata or complete record projection needed to render
pages without replaying the entire prior transcript.

## Stage 2: IndexedDB and bounded browser retention

### Storage

Use a dedicated versioned IndexedDB schema, not the old `conv:v1` snapshots.
Store individual authoritative history records and small transcript metadata
(cursor, revision, coverage, last access, accounted bytes).

Scope storage by origin, authenticated user, node, and effective session. Do not
hydrate before the current authenticated identity and card access are established.
On account change, stop old work and clear its in-memory state; never display
another account's cache. Check server authorization on every history/subscription
operation. Remove affected cache access when project/card permission is revoked.

Batch only new or changed authoritative records. Persist records, invalidations,
coverage, cursor, and byte accounting in the same transaction. Do not persist
per-token deltas, duplicate MobX trees, or transient task state. An incomplete
live overlay is recovered from the server, not presented as committed history.

Concurrent tabs must not regress a cursor or mix revisions. Use transaction-time
revision/generation checks; reject stale writes. No permanent per-card listeners
or persistence autoruns. Stop temporary cache work when its view/account ends.

### Budget and eviction

Total logical cache budget: 100 MiB, including accounted records and metadata.
Use encoded record sizes, not UTF-16 character counts. Browser storage-engine
overhead is outside this logical budget. Batch eviction and writes transactionally.

Evict least-recently-used transcripts first. For an oversized transcript, retain
recent pages that fit and record partial coverage. No active-transcript exemption
may cause the budget to grow without limit. An individual record too large to
cache is served without persistence. Quota/storage errors fall back to server
loading and must not block chat.

### RAM and display

Load the newest cached page for immediate display, then reconcile it with the
server. Older pages come from IndexedDB when valid and covered, otherwise from
the server. Uncached missing ranges must remain distinguishable from empty history.

Keep a bounded range around the viewport and release distant pages and their
render objects. Bound retained payload bytes as well as row count; large tool
outputs make row-only limits insufficient. Preserve the visible scroll anchor
when fetching or releasing pages. Keep normal Markdown rendering and Radix
scroll areas. Browser Find across unmounted content is not required.

Closed inactive views release transcript RAM. Off-screen active sessions retain
only bounded live state and lightweight status/subscription metadata, not an
unbounded transcript. A single large active message is an explicit exception
until it is committed; do not silently truncate its user-visible contents.

Cache reads must never overwrite newer live or authoritative state. Storage
failure/corruption clears only affected cache data and continues via the server.

## Verification and release gates

### Stage 1, without IndexedDB

- Cache-free latest/older/incremental reads preserve the current transcript view.
- A prompt or reply arriving during a delayed history read remains visible once.
- Repeated identical prompts remain distinct through lifecycle order and durable
  entry IDs; pending-send acknowledgements do not depend on text matching.
- Final text, tools, model metadata, and turn/compaction markers match after reload.
- Forks, branch changes, compaction, and stale responses do not mix histories.
- Reconnect, daemon restart, ring-buffer overflow, duplicate replay, and
  replay/live interleaving have explicit recovery behavior.
- Local and remote nodes use the same contract and authorization checks.
- Large histories are transferred in bounded pages; unchanged syncs do not
  retransmit the full transcript. Measure wire bytes and node-side history work.

### Stage 2

- Warm card opening displays valid cached content before history synchronization.
- Cache writes scale with changed records, not transcript size or delta count.
- Repeated card switching and scrolling do not cause retained RAM/pages to grow
  without bound; measure heap, DOM count, and process memory separately.
- LRU, oversized transcripts, interrupted transactions, quota failures, corrupted
  records, concurrent tabs, account switching, and access revocation are covered.
- Live prompts/replies, normal Markdown, selectors, and scroll anchoring work in
  browser and Electron. Do not launch an installed desktop binary merely to read
  its version; use metadata or an explicitly approved test instance.

Use protocol/integration tests for ordering and persistence boundaries, browser
checks for scroll and IDB behavior, and focused unit tests only where they catch
independent identity/projection/eviction defects. Run lint, typecheck, relevant
existing tests, and build before delivery.

## Likely implementation areas

Node: `src/lib/pi-session-history.ts`, `src/orcd/session.ts`,
`src/orcd/pi-runtime.ts`, `src/orcd/pi-events.ts`, `src/orcd/ring-buffer.ts`,
`src/orcd/socket-server.ts`, and `src/shared/orcd-protocol.ts`.

Backend: `src/server/orcd-client.ts`, `src/server/controllers/card-sessions.ts`,
`src/server/ws/handlers/sessions.ts`, subscription routing, and
`src/shared/ws-protocol.ts`.

Browser: `app/lib/ws-client.ts`, `app/lib/sdk-types.ts`,
`app/lib/message-accumulator.ts`, `app/stores/session-store.ts`,
`app/stores/root-store.ts`, `app/components/SessionView.tsx`,
`app/components/LazyTranscript.tsx`, and a dedicated transcript cache module.

## No-fork prototype evidence and remaining gates

Isolated synthetic-provider tests used public Pi 0.84.2 APIs and temporary disk
sessions, without real model calls or production session changes. They verified
settled fork history, compaction context projection, async message-end replacement,
identical queued prompts, durable file reopen at settlement, and a three-event
replay ring overflowing during an active response. The tests also showed that
message-end notifications precede entry append and low-level waitForIdle can
resolve before session settlement.

These are feasibility results, not production protocol acceptance. Actual socket
loss, daemon termination midstream, fork during active generation, delayed
incremental baseline delivery, long runs without settlement, and page-boundary
rendering still require integration verification. Long unsettled runs can retain
many completed overlay records; Stage 1 must measure and bound that state without
inventing live-to-entry matches. If this cannot meet the memory target, stop and
review the design rather than introduce private Pi hooks.

This document does not authorize a shared-branch push or merge. Implementation
planning follows review of this revised written specification.
