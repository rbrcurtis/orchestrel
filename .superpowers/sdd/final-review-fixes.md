# Final Review Fix Evidence — 2026-07-21

## Scope

- `pi-subagents`: explicit fully qualified subagent model requests now resolve only through `modelRegistry.find(provider, modelID)`. They cannot invoke fuzzy matching or provider fallback. Unqualified legacy requests continue through `resolveModel()`.
- `Orchestrel`: policy extension request validation requires `parentModel` to be a non-empty fully qualified `parentProvider/modelID` identity, and its provider prefix must match `parentProvider`. It deliberately does not require equality with `policy.parentModel`, allowing parent-model changes within a session provider.

## TDD evidence

### RED

1. `cd /home/ryan/Code/pi-subagents && npx vitest run test/model-policy.test.ts`
   - Before implementation: 2 failures.
   - `trackable/missing` fuzzily fell back to `anthropic/missing`, then failed with a provider-mismatch error instead of identifying the exact requested identity.
   - `trackable/claude-sonnet-4.6` fuzzily selected `trackable/claude-sonnet-4-6` rather than failing.

2. `cd /home/ryan/Code/orchestrel && bun x vitest run src/pi-extensions/orchestrel-subagent-policy.test.ts`
   - Before implementation: the unqualified parent-model validation regression failed because `validateRequest` accepted `parentModel: "auto"`.

## Regression coverage

### pi-subagents (`test/model-policy.test.ts`)

- Qualified `trackable/missing` with a same-ID model available on another provider throws `Model not found: "trackable/missing"` and emits no policy event.
- Qualified near-match `trackable/claude-sonnet-4.6` throws the exact requested identity and emits no policy event.
- Qualified `trackable/` missing its model identity throws the exact requested identity and emits no policy event.
- Existing tests continue to cover unqualified legacy fuzzy selection, cross-provider rejection before policy event emission, and policy-selected exact model lookup.

### Orchestrel (`src/pi-extensions/orchestrel-subagent-policy.test.ts`)

- A dynamic same-provider parent model (`trackable/claude-sonnet-4-6`) is accepted even though policy was built with `trackable/auto`.
- Bare `parentModel: "auto"` is rejected as not fully qualified.
- `parentModel` with a different provider prefix is rejected.

## GREEN / verification

Executed after implementation:

```text
cd /home/ryan/Code/pi-subagents
npx vitest run test/model-policy.test.ts
# 1 file passed, 12 tests passed
npm run typecheck
# tsc --noEmit: exit 0
npm run lint
# biome: Checked 67 files, no fixes applied

git diff --check
# exit 0

cd /home/ryan/Code/orchestrel
bun x vitest run src/pi-extensions/orchestrel-subagent-policy.test.ts
# 1 file passed, 8 tests passed
bun run typecheck
# react-router typegen && tsc -b: exit 0
bun run lint
# oxlint: exit 0

git diff --check
# exit 0
```

## Commits

- pi-subagents: `9ee0c5d fix: resolve qualified subagent models exactly`
- Orchestrel: `9215f89 fix: validate subagent policy parent model identity`

---

# Final Review Follow-up — 2026-07-21

## Scope

- `src/pi-extensions/orchestrel-subagent-policy.ts`: request `parentModel` now follows the shared qualified identity rule exactly: one slash, a non-empty provider and model ID, and no whitespace. Its validated provider prefix is then compared with `parentProvider`, preserving dynamic same-provider parent models.

## TDD evidence

### RED

```text
bun x vitest run src/pi-extensions/orchestrel-subagent-policy.test.ts
# 1 failed, 7 passed
# malformed parent models were accepted by the previous first-slash validation
```

### GREEN

```text
bun x vitest run src/pi-extensions/orchestrel-subagent-policy.test.ts
# 1 file passed, 8 tests passed
```

## Regression coverage

- Rejects an empty parent model ID (`trackable/`).
- Rejects an extra slash (`trackable/claude/sonnet`).
- Rejects whitespace (`trackable/claude sonnet`).
- Retains acceptance of dynamic same-provider parent models.

## Final verification

```text
bun run typecheck
# react-router typegen && tsc -b: exit 0

bun run lint
# oxlint -c .oxlintrc.json app src: exit 0

git diff --check
# exit 0
```
