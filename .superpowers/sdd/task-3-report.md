# Task 3 Report: Shared Subagent Policy Construction

## Status
Completed and committed as `60eb71f feat: build runtime subagent policies`.

## RED evidence
1. Created `src/shared/subagent-policy.test.ts` before the policy module existed.
2. Ran:
   ```bash
   bun x vitest run src/shared/subagent-policy.test.ts
   ```
3. Observed the expected failure:
   ```text
   Error: Cannot find module './subagent-policy'
   ```
   The suite contained no runnable tests because the requested production module did not yet exist.

## GREEN evidence
Implemented `src/shared/subagent-policy.ts`, then ran:
```bash
bun x vitest run src/shared/subagent-policy.test.ts src/orcd/__tests__/config.test.ts
```
Result:
```text
Test Files  2 passed (2)
Tests  15 passed (15)
```

## Exact verification
```bash
bun x vitest run src/shared/subagent-policy.test.ts src/orcd/__tests__/config.test.ts
# 2 passed, 15 passed

bun run typecheck
# react-router typegen && tsc -b; exit 0

bun run lint
# oxlint -c .oxlintrc.json app src; exit 0

git diff --check
# exit 0
```
The commit hook additionally ran:
```bash
oxlint -c .oxlintrc.json app src --max-warnings=0
```
and exited successfully.

## Changed files
- `src/shared/subagent-policy.ts`
  - Builds deterministic provider-qualified policies using aliases or positional fallback.
  - Adds the parent-model `Plan` default and applies explicit agent overrides last.
  - Throws for unknown explicit agent model keys; it never silently falls back.
  - Serializes only validated policies and validates parsed policy structure, agent fields, and `allowCrossProvider === false`.
  - Removes only legacy `.md` files carrying `managed_by: orchestrel`; preserves unmarked files and unrelated `.pi` resources; does not create `.pi`; safely prunes only empty directories; logs one warning on filesystem failure.
- `src/shared/subagent-policy.test.ts`
  - Retained unit tests cover policy mapping, positional fallback, unknown override rejection, serialization/validation, and destructive cleanup boundaries. These are worthwhile because model routing and filesystem deletion have meaningful failure modes and are pure, fast behavior.
- `src/shared/config.ts`
  - Uses the shared `ProviderAliases` type and documents runtime policy resolution.
- `src/orcd/config.ts`
  - Imports the shared alias type rather than the legacy generated-agent module.

## Self-review
- Confirmed aliases map to fully qualified provider/model IDs.
- Confirmed aliases and explicit agent overrides with missing model keys throw instead of selecting a fallback model.
- Confirmed `Plan` uses the parent model absent an override.
- Confirmed cleanup reads and deletes only marked `.md` files within the existing `.pi/agents` directory, retains custom agent files and `.pi/settings.json`, and removes directories only after they are empty.
- Confirmed cleanup is non-fatal on filesystem errors.
- Confirmed strict TypeScript, lint, focused tests, and whitespace validation pass.

## Concerns
None for Task 3. Runtime installation of this policy and deletion of the old generated-agent writer are intentionally deferred to later tasks.

## Review fixes
- Added strict parse/serialize validation: `parentModel` and every agent `model` must be `provider/modelID`, and their provider must equal `parentProvider` because `allowCrossProvider` is false. Bare values now throw `must be a fully qualified provider/modelID`; cross-provider values identify the expected parent provider.
- Corrected partial alias resolution: a configured tier alias is authoritative, while each missing tier independently uses positional fallback (second model for `subagent`, third with fallback chain for `lightweight`).
- Restricted legacy cleanup ownership detection to the YAML frontmatter block using a strict `managed_by: orchestrel` line parser. A body-only marker no longer permits deletion.

### Review RED evidence
After adding the three regression cases, before production changes:
```bash
bun x vitest run src/shared/subagent-policy.test.ts
# Test Files  1 failed (1)
# Tests  3 failed | 6 passed (9)
```
The failures showed the old behavior: missing lightweight alias selected the first model, bare policy models were accepted, and a body marker deleted an unmarked custom file.

### Review verification
```bash
bun x vitest run src/shared/subagent-policy.test.ts src/orcd/__tests__/config.test.ts
# Test Files  2 passed (2)
# Tests  18 passed (18)

bun run typecheck
# react-router typegen && tsc -b; exit 0

bun run lint
# oxlint -c .oxlintrc.json app src; exit 0

git diff --check
# exit 0
```
