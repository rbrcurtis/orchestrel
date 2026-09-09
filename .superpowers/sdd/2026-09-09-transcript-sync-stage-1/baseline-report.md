# Baseline repair report

Branch: `feature/transcript-sync-stage-1`  
Baseline commit: `7e00e9f` (`docs: add transcript sync stage 1 plan`)

## Scope

All work was done only in `/home/ryan/Code/orchestrel/.worktrees/transcript-sync-stage-1`. No production configuration, credentials, database files, services, or primary-checkout files were used or changed. No `node_modules` symlink was created.

## Baseline failures and root causes

### `src/shared/ws-protocol.test.ts`: full project row

The full project fixture did not include `defaultSummarizeThreshold`. Commit `c92fb0f` made this a required `projectSchema` field, but it did not update this fixture. The schema correctly rejected the obsolete fixture with `Invalid input: expected number, received undefined` at `defaultSummarizeThreshold`.

Repair: add `defaultSummarizeThreshold: 0` to the full project row fixture. `0` is the current `Project` model default.

Value of test: this schema-contract test catches server/project-row changes that would otherwise cause invalid sync payloads at runtime. Unit level is correct because it directly validates the pure Zod schema. This assertion is not duplicate coverage.

### `bin/orc.test.ts`: missing `config.yaml`

The backend-error import test invoked `bin/orc --import` without `--config`. The CLI correctly loads configuration before it processes an import and therefore failed with `Config not found at <worktree>/config.yaml`. Its test setup already creates an isolated temporary config at `configPath`; the failing test simply did not use it.

Repair: pass `--config configPath` in that isolated test invocation. Production CLI behavior remains unchanged, including its error for a missing default configuration file.

Value of test: this test proves that a backend 422 import failure is displayed to the CLI user. It needs an isolated config so setup state does not hide the backend error. The test covers public CLI behavior and is not plumbing-only coverage.

## Teardown RPC rejection evaluation

A full `bunx vitest run --reporter=verbose` baseline run completed with only the two failures above. It showed no Vitest teardown error, unhandled rejection, or RPC rejection. The log entries containing `processTicksAndRejections` were expected error-path test logging from agent stop and title fallback tests. The possible teardown RPC rejection was not reproducible in this worktree.

## Verification

- Focused: `bunx vitest run src/shared/ws-protocol.test.ts bin/orc.test.ts` — 2 files, 20 tests passed.
- Full: `bunx vitest run` — 74 files, 675 tests passed.
- `bun run typecheck` — passed after `bun run tsoa:generate` created the ignored generated routes file required by the checked-out worktree. The initial typecheck failed only because that generated file was absent; no source repair was needed.
- `bun run lint` — passed.
- `git diff --check` — passed.

The full suite emitted one existing `tsoa` sourcemap warning for its installed package. It did not fail the suite.
