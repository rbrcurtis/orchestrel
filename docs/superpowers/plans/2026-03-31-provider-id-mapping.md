# Provider ID Mapping & Config-Driven Defaults

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `ocProviderID` mapping field so Orchestrel provider names (e.g. `"anthropic"`) can differ from OpenCode provider names (e.g. `"opencode-proxy"`), and eliminate all hardcoded `'anthropic'` fallback defaults in favor of config-driven values.

**Architecture:** The `providers.json` config gains an optional `ocProviderID` per provider. A new `getOcProviderID()` helper resolves Orchestrel provider → OpenCode provider (falling back to the Orchestrel ID if unmapped). A new `getDefaultProviderID()` returns the first provider key from config, replacing every hardcoded `'anthropic'` — including the TypeORM column default in `Project.ts` (removed, since all creation paths set it explicitly).

**Tech Stack:** TypeScript, Zod, TypeORM, Vitest

---

### Task 1: Extend provider config schema with `ocProviderID`

**Files:**

- Modify: `providers.json` (add `ocProviderID` to `anthropic` provider)
- Modify: `src/server/config/providers.ts:5-18` (add field to schema, add helper functions)
- Modify: `src/shared/ws-protocol.ts:94-97` (add field to shared schema so frontend can access it if needed)

- [ ] **Step 1: Write failing tests for new helpers**

Add to `src/server/config/providers.test.ts`:

```typescript
describe('getOcProviderID()', () => {
  it('returns ocProviderID when set', async () => {
    const fs = await import('fs');
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        providers: {
          anthropic: {
            label: 'Anthropic',
            ocProviderID: 'opencode-proxy',
            models: {
              sonnet: { label: 'Sonnet', modelID: 'claude-sonnet-4-6', contextWindow: 200000 },
            },
          },
        },
      }),
    );
    const { getOcProviderID } = await importModule();
    expect(getOcProviderID('anthropic')).toBe('opencode-proxy');
  });

  it('falls back to provider key when ocProviderID not set', async () => {
    const { getOcProviderID } = await importModule();
    expect(getOcProviderID('anthropic')).toBe('anthropic');
  });

  it('falls back to providerID for unknown providers', async () => {
    const { getOcProviderID } = await importModule();
    expect(getOcProviderID('unknown')).toBe('unknown');
  });
});

describe('getDefaultProviderID()', () => {
  it('returns the first provider key from config', async () => {
    const { getDefaultProviderID } = await importModule();
    expect(getDefaultProviderID()).toBe('anthropic');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/ryan/Code/orchestrel && npx vitest run src/server/config/providers.test.ts`
Expected: FAIL — `getOcProviderID` and `getDefaultProviderID` not exported

- [ ] **Step 3: Add `ocProviderID` to Zod schema and implement helpers**

In `src/server/config/providers.ts`, update the provider schema:

```typescript
const providerConfigSchema = z.object({
  label: z.string(),
  ocProviderID: z.string().optional(),
  models: z.record(z.string(), modelConfigSchema),
});
```

Add two new exported functions:

```typescript
/** Resolve Orchestrel provider ID → OpenCode provider ID */
export function getOcProviderID(providerID: string): string {
  const config = loadProviders();
  return config.providers[providerID]?.ocProviderID ?? providerID;
}

/** Get the first provider key from config (used as system-wide default) */
export function getDefaultProviderID(): string {
  const config = loadProviders();
  const keys = Object.keys(config.providers);
  if (!keys.length) throw new Error('No providers configured in providers.json');
  return keys[0];
}
```

- [ ] **Step 4: Update shared schema**

In `src/shared/ws-protocol.ts`, add `ocProviderID` to the provider config schema:

```typescript
export const providerConfigSchema = z.object({
  label: z.string(),
  ocProviderID: z.string().optional(),
  models: z.record(z.string(), modelConfigSchema),
});
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /home/ryan/Code/orchestrel && npx vitest run src/server/config/providers.test.ts`
Expected: PASS

- [ ] **Step 6: Update `providers.json`**

Change the `anthropic` provider entry to include `ocProviderID`:

```json
"anthropic": {
  "label": "Anthropic",
  "ocProviderID": "opencode-proxy",
  "models": { ... }
}
```

The `okkanti` and `trackable` providers don't need `ocProviderID` because their Orchestrel IDs already match their OpenCode IDs.

- [ ] **Step 7: Commit**

```bash
git add src/server/config/providers.ts src/server/config/providers.test.ts src/shared/ws-protocol.ts providers.json
git commit -m "feat: add ocProviderID mapping and getDefaultProviderID to provider config"
```

---

### Task 2: Use OC provider ID in the agent factory

**Files:**

- Modify: `src/server/agents/factory.ts:15-21` (resolve OC provider ID before passing to session)

- [ ] **Step 1: Update factory to resolve OC provider ID**

In `src/server/agents/factory.ts`, import `getOcProviderID` and use it:

```typescript
import { resolveModel } from './opencode/models';
import { openCodeServer } from '../opencode/server';
import { getOcProviderID } from '../config/providers';

// ... (CreateSessionOpts interface unchanged — providerID stays as Orchestrel ID)

export function createAgentSession(opts: CreateSessionOpts): AgentSession {
  if (!openCodeServer.client) {
    throw new Error('OpenCode server not ready');
  }
  const ocProvider = getOcProviderID(opts.providerID);
  const { modelID, variant } = resolveModel(opts.providerID, opts.model, opts.thinkingLevel);
  return new OpenCodeSession(openCodeServer.client, opts.cwd, ocProvider, modelID, variant, opts.resumeSessionId);
}
```

Note: `resolveModel` still uses the Orchestrel provider ID to look up model config from `providers.json`. Only the OC session gets the mapped ID.

- [ ] **Step 2: Verify build compiles**

Run: `cd /home/ryan/Code/orchestrel && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/server/agents/factory.ts
git commit -m "feat: resolve ocProviderID in agent factory before passing to OpenCode session"
```

---

### Task 3: Replace hardcoded `'anthropic'` defaults with config-driven defaults

**Files:**

- Modify: `src/server/services/session.ts:122,128,253,260,334,340` (replace `'anthropic'` with `getDefaultProviderID()`)
- Modify: `src/server/services/card.ts:50,54,84` (replace `'anthropic'` with `getDefaultProviderID()`)
- Modify: `src/server/models/Project.ts:66` (remove TypeORM column default)

- [ ] **Step 1: Update `session.ts`**

Add import at top:

```typescript
import { getDefaultProviderID } from '../config/providers';
```

Replace all 6 occurrences of hardcoded `'anthropic'` with `getDefaultProviderID()`:

Line 122: `let providerID = getDefaultProviderID();`
Line 128: `providerID = proj.providerID ?? getDefaultProviderID();`
Line 253: `let providerID = getDefaultProviderID();`
Line 260: `providerID = proj.providerID ?? getDefaultProviderID();`
Line 334: `let providerID = getDefaultProviderID();`
Line 340: `providerID = proj.providerID ?? getDefaultProviderID();`

- [ ] **Step 2: Update `card.ts`**

Add import at top:

```typescript
import { getDefaultProviderID } from '../config/providers';
```

Replace all 3 occurrences:

Line 50: `let providerID = getDefaultProviderID();`
Line 54: `providerID = proj.providerID ?? getDefaultProviderID();`
Line 84: `const providerID = proj?.providerID ?? getDefaultProviderID();`

- [ ] **Step 3: Remove hardcoded default from `Project.ts`**

In `src/server/models/Project.ts`, remove the `default` from the `provider_id` column. TypeORM column defaults are static strings — we can't call a function. Since all project creation paths (the UI form) always send a `providerID`, we don't need a DB default. The `?? getDefaultProviderID()` guards in session.ts and card.ts handle the read-side fallback for any legacy rows.

Change:

```typescript
@Column({ name: 'provider_id', type: 'text', default: 'anthropic' })
providerID!: string;
```

To:

```typescript
@Column({ name: 'provider_id', type: 'text' })
providerID!: string;
```

Note: Existing DB rows already have `provider_id` values set, so removing the TypeORM default won't affect them. SQLite doesn't enforce NOT NULL without an explicit constraint, and TypeORM won't ALTER the column.

- [ ] **Step 4: Verify build compiles**

Run: `cd /home/ryan/Code/orchestrel && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Run all tests**

Run: `cd /home/ryan/Code/orchestrel && npx vitest run`
Expected: All pass

- [ ] **Step 6: Commit**

```bash
git add src/server/services/session.ts src/server/services/card.ts src/server/models/Project.ts
git commit -m "fix: replace hardcoded 'anthropic' fallbacks with config-driven getDefaultProviderID()"
```

---

### Task 4: Verify end-to-end

- [ ] **Step 1: Run full test suite**

Run: `cd /home/ryan/Code/orchestrel && npx vitest run`
Expected: All pass (config-store tests use optional `ocProviderID`, so existing fixtures work as-is)

- [ ] **Step 2: Restart dev server and test card 557**

```bash
sudo systemctl restart orchestrel
```

Open the UI and start card 557. Check the server logs for `provider=opencode-proxy` in the session creation line. The session should start without the "Anthropic API key is missing" error.

---

## Summary of changes

| File                                  | Change                                                                             |
| ------------------------------------- | ---------------------------------------------------------------------------------- |
| `providers.json`                      | Add `"ocProviderID": "opencode-proxy"` to `anthropic` provider                     |
| `src/server/config/providers.ts`      | Add `ocProviderID` to schema, add `getOcProviderID()` and `getDefaultProviderID()` |
| `src/shared/ws-protocol.ts`           | Add `ocProviderID` to shared schema                                                |
| `src/server/config/providers.test.ts` | Add tests for new helpers                                                          |
| `src/server/agents/factory.ts`        | Resolve `ocProviderID` before passing to OpenCode session                          |
| `src/server/services/session.ts`      | Replace 6x `'anthropic'` with `getDefaultProviderID()`                             |
| `src/server/services/card.ts`         | Replace 3x `'anthropic'` with `getDefaultProviderID()`                             |
| `src/server/models/Project.ts`        | Remove hardcoded `default: 'anthropic'` from column definition                     |
