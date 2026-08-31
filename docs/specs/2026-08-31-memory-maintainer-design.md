# Memory Maintainer Design

Date: 2026-08-31
Status: Approved (brainstorming, all sections approved 2026-08-31)
Scope: orchestrel — a background memory consolidation service

## Goal

A background maintainer inside orchestrel that turns agent session transcripts
(`~/.pi/agent/sessions`) into curated memories. For the first pass it stages
everything to a per-day JSON file and sends a Telegram alert for review. It
never writes to any memory API until explicitly switched to write mode.

## Decisions (recorded from brainstorming)

1. **Build fresh inside orchestrel.** No reuse of removed architecture
   (queryAgentSdk helper, session-compactor.ts, summarize-session.ts,
   memory-upsert.ts — all gone from source). `@anthropic-ai/sdk` was removed
   from package.json 2026-08-31; the maintainer never imports it.
2. **Raw source:** `~/.pi/agent/sessions/<cwd-slug>/<ts>_<uuid>.jsonl`
   (pi session files; typed JSONL; `session` header carries the exact `cwd`).
3. **Dual memory backends, per-project config.** Each configured project maps
   to one memory server (`apiUrl` + `apiKey` + `project`). Trackable paths
   (`Code/trackable*`, `Code/transcription*`) → `https://memory.trackable.io`
   project `trackable`. Unconfigured projects are skipped — nothing is written
   anywhere by accident.
4. **Staging first.** `mode: stage` (default) writes proposed memory ops to
   `data/memory-staging/YYYY-MM-DD.json` and sends a Telegram alert. No memory
   API writes. `mode: write` (later) applies ops directly.
5. **Model:** global `memory.model` → max.local `assistant`
   (Qwen3.8-27B oQ8 + DFlash2, `http://max.local:11434`, Anthropic-compatible)
   for all projects, driven through `@earendil-works/pi-ai` / pi-coding-agent
   `ModelRuntime` (house pattern from `src/orcd/pi-runtime.ts`). Staging review
   is the quality gate; swapping the model is a one-line config change.
6. **Backlog:** recent-only. Watermark initializes at first run; only sessions
   newer than the watermark are ever processed. No historical drain.
7. **Weekly merge pass:** consolidates recurring patterns across the week's
   staged ops, scoped strictly within one memory server set (same `apiUrl` +
   `project`). No cross-server merging.
8. **Scheduler:** in-process in the orchestrel server (`orchestrel.service`,
   always running) — a daily sweep timer and a separate weekly merge timer.
   Guarded so only one run executes at a time.

## Architecture

New module `src/lib/memory-maintainer/` (fresh, direct modules, no DI):

| File | Responsibility |
|------|----------------|
| `config.ts` | Read `memory:` section from shared OrchestrelConfig (`loadConfig` + `resolveEnvVars`); resolve project by longest cwd prefix |
| `memory-api.ts` | REST client: `searchMemories`, `storeMemory`, `updateMemory`, `deleteMemory` (Bearer auth, plain fetch) |
| `sweep.ts` | Walk `~/.pi/agent/sessions`, apply watermark + settle filter, classify files by project |
| `excerpt.ts` | Build a bounded LLM excerpt from one session JSONL (user text, assistant text, toolCall/toolResult summaries; token cap) |
| `consolidate.ts` | Agent tool-loop via `ModelRuntime`: search/store/update/delete tools; emits staged ops |
| `merge.ts` | Weekly pass: review a week's staged ops per memory server set, propose merged durable memories |
| `staging.ts` | Append ops to the per-day staging JSON file |
| `telegram.ts` | Send run summary to Telegram (plain fetch to `api.telegram.org`) |
| `maintain.ts` | Orchestrate one run: sweep → group by project → consolidate → stage → alert; writes run log |
| `scheduler.ts` | Daily + weekly timers, single-run guard, registered via `init-state.ts` |
| `cli.ts` | `arg`-based CLI: `--run`, `--weekly`, `--status` |

Supporting changes:
- `src/shared/config.ts`: add `memory` section to `OrchestrelConfig`.
- `src/server/models/index.ts`: create `memory_maintainer_watermark` and
  `memory_maintainer_runs` tables in `initDatabase` (CREATE TABLE IF NOT EXISTS,
  same raw-SQL pattern as users/project_users).
- `src/server/init-state.ts`: own the scheduler instance (survives Vite restarts
  per CLAUDE.md rule).
- `orcd.example.yaml`: document the `memory:` section.

## Config

```yaml
memory:
  mode: stage            # stage | write (write is future)
  provider: max          # provider id from providers map
  model: assistant       # alias in providers.max.models
  maxTurns: 30           # agent loop cap per session
  excerptTokens: 24000   # token cap for the session excerpt
  stageDir: data/memory-staging
  settleMs: 600000       # session must be idle this long before processing (10 min)
  telegram:
    botToken: ${TELEGRAM_BOT_TOKEN}
    chatId: ${TELEGRAM_CHAT_ID}
  projects:
    trackable:
      match: ["/home/ryan/Code/trackable", "/home/ryan/Code/transcription"]
      apiUrl: https://memory.trackable.io
      apiKey: ${TRACKABLE_MEMORY_API_KEY}
      project: trackable
```

- `projects` is a map of key → entry. Each entry has `match` (cwd prefixes) and
  the memory server triple. Longest matching prefix wins.
- Env vars resolve through the existing `resolveEnvVars`. `TRACKABLE_MEMORY_API_KEY`
  exists in `/home/ryan/plans/.env`; the two Telegram vars are new (user supplies).
- Missing `telegram` config: stage files still written, alert skipped (log only).
- Missing `memory:` section entirely: maintainer is disabled.

## Data model

**Tables (raw SQL, CREATE TABLE IF NOT EXISTS):**

```sql
CREATE TABLE IF NOT EXISTS memory_maintainer_watermark (
  path TEXT PRIMARY KEY,
  mtime_ms INTEGER NOT NULL,
  size INTEGER NOT NULL,
  processed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_maintainer_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_type TEXT NOT NULL,            -- daily | weekly | manual
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,              -- running | done | failed
  summary_json TEXT
);
```

**Staging JSON (`data/memory-staging/YYYY-MM-DD.json`):**

```json
{
  "date": "2026-08-31",
  "entries": [
    {
      "project": "trackable",
      "apiUrl": "https://memory.trackable.io",
      "sessionId": "…",
      "source": "relative/path/to/session.jsonl",
      "ops": [
        { "op": "store", "title": "…", "text": "…", "tags": ["…"] },
        { "op": "update", "id": "…", "title": "…", "text": "…" },
        { "op": "delete", "id": "…", "reason": "stale duplicate" },
        { "op": "skip", "reason": "duplicate of existing memory …" }
      ]
    }
  ]
}
```

Files are append-only for the day; entries carry `project` + `apiUrl` so the
weekly merge can group by memory server set without cross-server merging.

## Pipeline

**Daily run (`maintain.ts`):**
1. Sweep: walk sessions dir; skip files whose (path, mtime, size) match the
   watermark or whose mtime is newer than now − `settleMs`; skip noise (no user
   message, < 3 assistant turns, config-only sessions). Classify each remaining
   file by `cwd` → project via config; unconfigured projects' files are dropped.
2. Group by project; for each project (sequential, one at a time):
   - Build excerpt (`excerpt.ts`).
   - Run the consolidation agent (`consolidate.ts`) against that project's
     memory server. It returns staged ops (no writes in stage mode).
   - Append ops to the day's staging JSON (`staging.ts`).
3. Update watermark rows for every processed file (even if ops were skipped —
   the file has been seen).
4. Write the run row; send Telegram summary (`telegram.ts`): counts per project
   (sessions, store/update/delete/skip), staging file path, duration, errors.

**Weekly merge pass (`merge.ts`):** for each memory server set present in the
week's staging files, collect all staged store ops, run one agent pass that
groups near-duplicates and recurring themes into merged durable memories,
appended to a new staging file `data/memory-staging/merge-YYYY-MM-DD.json` with
`source: "merge"`. No cross-server grouping.

## Consolidation agent

Model setup mirrors `src/orcd/pi-runtime.ts`:
- `ModelRuntime.create({ authPath, modelsPath })`, `ModelRegistry`, register the
  `memory.provider` provider via `registerProvider` (api `anthropic-messages`,
  baseUrl from provider config, anonymous api key if none — oMLX ignores it).
- Model resolved by `memory.model` alias → `modelID`.
- Loop: `runtime.completeSimple(model, { system, messages, tools }, opts)`;
  execute `ToolCall`s (sequential), push `ToolResultMessage`s; stop when the
  assistant content has no tool calls or `maxTurns` is hit.

Tools (thin wrappers over `memory-api.ts`):
- `search_memory(query, limit)` → `{ hits: [{id,title,text,score}] }`
- `store_memory(title, text, tags?)` → `{ id }`
- `update_memory(id, title?, text?, tags?)` → `{ ok }`
- `delete_memory(id)` → `{ ok }`

System prompt rules: one concept per memory; search before store (dedupe);
never store transient content (status checks, "repos clean", merge confirmations,
secrets); prefer concise descriptive titles; STOP when done — no loops. In stage
mode the tools only search; store/update/delete are recorded as ops, not executed.

Excerpt builder: parse pi JSONL entries; keep user text fully, assistant text
fully, toolCall name + truncated arguments, toolResult truncated summaries;
cap at `excerptTokens` (newest entries win when over budget); include session id,
cwd, timestamps, provider/model.

## Guardrails

- Project boundary is hard: a trackable session can never route to a local
  memory server, and vice versa — routing comes only from the config match.
- Secrets filter: any excerpt or staged text matching a key/token pattern is
  redacted; `store` ops containing secrets are rejected.
- No default fallback backend. Unconfigured project → file dropped.
- Single-run guard (in-process flag) — daily and weekly runs never overlap.
- DB: open via better-sqlite3 with busy_timeout; never run WAL management
  commands (CLAUDE.md guardrail). Tables created IF NOT EXISTS.
- Token/cost caps: excerpt cap + maxTurns cap; runs log tokens + cost.

## Out of scope (future)

- `mode: write` (direct API writes) after review quality sign-off.
- Automated pruning of the staging dir (manual cleanup for now).
- A review UI in the orchestrel app (JSON + Telegram is the v1 review channel).
- Retrieval/triggering of skills — this system only curates memories.

## Verification

- Unit tests per module (vitest; mock at boundaries — `mock.module` for service
  deps, `globalThis.fetch` stub for HTTP, mock ModelRuntime for the agent loop).
- Sweep/excerpt tested against a committed real session JSONL fixture.
- Manual end-to-end: `bun run src/lib/memory-maintainer/cli.ts --run` over real sessions
  (recent-only), inspect the staging JSON, confirm the Telegram alert fires.
- Memory API calls verified against a real server in stage mode (search only).
