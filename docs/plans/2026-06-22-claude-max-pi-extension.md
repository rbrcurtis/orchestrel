# Claude Max Pi Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the Claude Max OAuth + Claude Code request-reshaping provider out of orcd's application code into a standalone Pi extension that Pi auto-discovers and self-registers, so orchestrel contains zero provider-specific code.

**Architecture:** A standalone Pi extension (a TypeScript module with a default-exported `ExtensionFactory`) lives at `extensions/claude-max/` in the repo and is symlinked into `~/.pi/agent/extensions/claude-max/`, which `pi-coding-agent`'s `DefaultResourceLoader` discovers automatically (location #2: `agentDir/extensions/`). The extension calls `pi.registerProvider("anthropic", { oauth, streamSimple, baseUrl })` **without** a `models` field, which *augments* the provider orchestrel already registered (per `model-registry.d.ts:92-93`: a no-`models` registration overrides URLs/auth but preserves the model catalog). orchestrel keeps registering the provider's model catalog generically from `config.yaml` and loses its `isClaudeMaxOAuth` branch and all four `claude-code-*.ts` files.

**Tech Stack:** TypeScript (strict), `@earendil-works/pi-coding-agent` (extension API + `ModelRegistry`), `@earendil-works/pi-ai` (OAuth + stream types), `@anthropic-ai/sdk`, jiti (Pi's TS extension loader), vitest.

---

## Decisions (locked)

Per the design discussion the rule is **purest option, every decision**:

- **A2 — disk discovery.** The extension is auto-discovered from `~/.pi/agent/extensions/`. orchestrel's runtime imports nothing from it. (The repo keeps the *source* under `extensions/claude-max/` and a one-time symlink/install step puts it on Pi's discovery path — that is ops/config, not application code.)
- **B1 — self-contained extension.** orcd registers providers generically from `config.yaml` with no Claude-Max branch. The extension targets the provider by name (`"anthropic"`) and attaches auth + reshaping.
- **C2 — native Pi provider registration.** Auth uses Pi's `ProviderConfig.oauth` block (`login`/`refreshToken`/`getApiKey`); request reshaping uses `ProviderConfig.streamSimple` (the only typed seam capable of full message/tool/prompt rewriting — `before_provider_request` carries `payload: unknown` and cannot).

### Credential source of truth
`~/.claude/.credentials.json` stays the source of truth (interop with the `claude` CLI is a hard requirement). The oauth block's `login()` reads that file headlessly (no interactive prompts — orcd is a daemon), `refreshToken()` refreshes against `https://console.anthropic.com/v1/oauth/token` and writes the rotated token back to that file, and `getApiKey()` returns `creds.access`. Pi's own `auth.json` becomes a cache populated from these.

### Simplification unlocked
Because `streamSimple` is now attached to **only** the `"anthropic"` provider (not registered globally by API format), the current global guard `if (model.provider !== oauthProviderId) return streamSimpleAnthropic(...)` is no longer needed — other anthropic-format providers (okkanti/trackable/ray) never receive this `streamSimple`. The guard is removed during the move.

### Spike outcome (Task 0)

Verified against `@earendil-works/pi-coding-agent` (installed version) by source reading + a runtime probe (`ModelRegistry.inMemory(auth)`, register-with-models then re-register-same-name-without-models, then `find()`).

**(a) MODEL_PRESERVED — design (i) AUGMENT holds (expected).** Re-registering the same provider id with NO `models` field does **not** clobber the previously-registered catalog. Probe output: `MODEL_PRESERVED: true`, `PROVIDER_MODEL_COUNT: 1`, `STREAMSIMPLE_INVOKED_AT_REGISTRATION: false`, `RAW_MODEL` still the sonnet model. Source confirms: in `ModelRegistry.applyProviderConfig` (`dist/core/model-registry.js:740-781`) the full-replacement that filters out existing provider models (`this.models = this.models.filter(m => m.provider !== providerName)`, line 742) runs **only** when `config.models?.length > 0`. With no models, control falls to the `else if (config.baseUrl || config.headers)` branch (line 771) which only patches `baseUrl` on existing models. `registerProvider` (line 662) also calls `upsertRegisteredProvider` (line 689) which merges only *defined* keys, preserving prior config. **Design implication:** the extension can call `pi.registerProvider("anthropic", { oauth, streamSimple, baseUrl })` with no `models` and it augments orchestrel's already-registered "anthropic" catalog. Constraint: a models-bearing registration requires `baseUrl` plus `apiKey` or `oauth`, and each model object must include `reasoning`, `input`, `cost`, `contextWindow`, `maxTokens` (the Task-0 probe's minimal `{id,name,api}` shape does not type-check — the real probe used the full shape). The no-models extension registration only requires `api` (because `streamSimple` is present: `validateProviderConfig`, line 702-703).

**(b) How `streamSimple` gets the token — Pi passes the resolved key IN via `options.apiKey`; the stream function does NOT source it itself.** Chain:
- The Agent's `streamFn` resolves auth and injects it: `dist/core/sdk.js:201-222` — calls `modelRegistry.getApiKeyAndHeaders(model)` (line 202), then `streamSimple(model, context, { ...options, apiKey: auth.apiKey, headers: {...auth.headers} })` (lines 212-221).
- `ModelRegistry.getApiKeyAndHeaders` (`dist/core/model-registry.js:569-600`) resolves the key from `AuthStorage.getApiKey(provider)` (OAuth-backed, line 572) or the provider's configured `apiKey`, returning `{ ok, apiKey, headers }`.
- pi-ai's `streamSimple` (`@earendil-works/pi-ai/dist/stream.js:31-34`) dispatches to the registered api provider's `streamSimple(model, context, withEnvApiKey(model, options))`; `withEnvApiKey` (lines 8-14) keeps the already-set `options.apiKey` (env fallback only fills it when empty).
- The custom `streamSimple` signature is `(model: Model, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream` (`model-registry.d.ts:125`); `SimpleStreamOptions extends StreamOptions` whose `apiKey?: string` field (`pi-ai/dist/types.d.ts:32`) carries the resolved token. **Design implication:** the extension's `streamSimple` reads `options.apiKey` (the OAuth access token resolved from the `oauth` block's `getApiKey()` via AuthStorage) — it must NOT fetch credentials itself.

---

## File Structure

**Created (extension — NOT application code):**
- `extensions/claude-max/index.ts` — default-exported `ExtensionFactory`; the only Pi entry point. Calls `pi.registerProvider`.
- `extensions/claude-max/auth.ts` — the `oauth` block (`login`/`refreshToken`/`getApiKey`) reading/refreshing `~/.claude/.credentials.json`. (Relocated + adapted from `src/orcd/claude-code-auth.ts`.)
- `extensions/claude-max/stream.ts` — `makeClaudeCodeStream` (guard removed). (Relocated from `src/orcd/claude-code-stream.ts`.)
- `extensions/claude-max/convert.ts` — message/tool conversion. (Relocated from `src/orcd/claude-code-convert.ts`.)
- `extensions/claude-max/prompt.ts` — system-prompt builder. (Relocated from `src/orcd/claude-code-prompt.ts`.)
- `extensions/claude-max/package.json` — `{ "name": "claude-max", "pi": { "extensions": ["index.ts"] } }` so directory discovery resolves the entry.
- `extensions/claude-max/__tests__/auth.test.ts`, `convert.test.ts` — relocated unit tests.
- `scripts/install-claude-max-extension.sh` — idempotent symlink of `extensions/claude-max` → `~/.pi/agent/extensions/claude-max`.

**Modified:**
- `src/orcd/pi-runtime.ts` — delete the `CLAUDE_MAX_OAUTH` constant, the `isClaudeMaxOAuth` branch in `registerOrchestrelProvider`, and the `makeClaudeCodeStream` import. `usesBuiltInProvider` keeps its `provider.oauth` early-return (still correct: an oauth provider is never the SDK built-in).
- `src/shared/config.ts` / `src/orcd/config.ts` — unchanged (the `oauth` field stays in config as the human-facing marker; orcd just stops *acting* on it).
- `config.example.yaml` — add a comment that `oauth: claude-max` requires the `claude-max` Pi extension installed.

**Deleted:**
- `src/orcd/claude-code-auth.ts`
- `src/orcd/claude-code-convert.ts`
- `src/orcd/claude-code-prompt.ts`
- `src/orcd/claude-code-stream.ts`
- `src/orcd/__tests__/` Claude-Code-specific tests that move to the extension.

---

## Task 0 (SPIKE): Verify registry augmentation + streamSimple token sourcing

Two integration facts must be confirmed by experiment before building, because they shape the extension's `registerProvider` call.

**Files:**
- Create (throwaway): `src/bin/scratch-verify-pi-augment.ts`

- [ ] **Step 1: Write a probe that registers a provider with models, then re-registers the same name with only `streamSimple`/`baseUrl` and checks both compose.**

```ts
// src/bin/scratch-verify-pi-augment.ts
import { AuthStorage, ModelRegistry, getAgentDir } from '@earendil-works/pi-coding-agent';

async function main() {
  const agentDir = getAgentDir();
  const auth = AuthStorage.create(`${agentDir}/auth.json`);
  const reg = ModelRegistry.create(auth, `${agentDir}/models.json`);

  // 1) orchestrel-style: register provider WITH a model catalog.
  reg.registerProvider('probe-anthropic', {
    api: 'anthropic-messages',
    baseUrl: 'https://api.anthropic.com',
    apiKey: '$PROBE_EMPTY',
    models: [{ id: 'claude-sonnet-4-20250514', name: 'probe', api: 'anthropic-messages' }],
  });

  // 2) extension-style: re-register SAME name, NO models, attach streamSimple.
  let streamSimpleSeen = false;
  reg.registerProvider('probe-anthropic', {
    api: 'anthropic-messages',
    baseUrl: 'https://api.anthropic.com',
    streamSimple: (() => { streamSimpleSeen = true; return undefined as never; }) as never,
  });

  const model = reg.find('probe-anthropic', 'claude-sonnet-4-20250514');
  console.log('MODEL_PRESERVED:', !!model);          // expect true (catalog survived)
  console.log('STREAMSIMPLE_ATTACHED_FIELD:', streamSimpleSeen === false); // registration shouldn't invoke it
  console.log('RAW_MODEL:', JSON.stringify(model));
}
main();
```

- [ ] **Step 2: Run it and record behavior.**

Run: `cd /home/ryan/Code/orchestrel/.claude/worktrees/pi-ai-migration-plan2 && npx tsx src/bin/scratch-verify-pi-augment.ts`
Expected: `MODEL_PRESERVED: true`. If the model is gone, the no-`models` augment path does NOT preserve the catalog → switch to design (ii) (extension owns the full provider incl. `models`, orchestrel stops registering `anthropic`). Record which design holds.

- [ ] **Step 3: Confirm how `streamSimple` receives the oauth-resolved key.**

Inspect the resolved `model` object printed above and `node_modules/@earendil-works/pi-ai/dist/types.d.ts` `StreamFunction`/`Context` to determine whether the resolved API key is passed to `streamSimple` (via `model`/`options`) or whether `streamSimple` must source the token itself. Record the answer; it decides whether `stream.ts` calls the shared auth helper or reads a Pi-provided key.

- [ ] **Step 4: Delete the scratch probe.**

```bash
rm src/bin/scratch-verify-pi-augment.ts
```

- [ ] **Step 5: Commit the recorded decision as a note in this plan file (edit the "Decisions (locked)" section with the spike outcome).**

```bash
git add docs/plans/2026-06-22-claude-max-pi-extension.md
git commit -m "docs: record claude-max extension spike outcome"
```

> **Branch point:** If Step 2 shows the catalog is preserved (expected), proceed with design (i) below. If not, the extension's `registerProvider` in Task 3 must include the `models` array (copied from `config.yaml`) and Task 4 must make orcd skip registering the `anthropic` provider entirely. Tasks 1–2 and 5–8 are unaffected.

---

## Task 1: Scaffold the extension package and move the pure conversion module

**Files:**
- Create: `extensions/claude-max/package.json`
- Create: `extensions/claude-max/prompt.ts` (from `src/orcd/claude-code-prompt.ts`)
- Create: `extensions/claude-max/convert.ts` (from `src/orcd/claude-code-convert.ts`)
- Create: `extensions/claude-max/__tests__/convert.test.ts`

- [ ] **Step 1: Create the extension manifest.**

```json
{
  "name": "claude-max",
  "private": true,
  "pi": { "extensions": ["index.ts"] }
}
```

- [ ] **Step 2: Move `claude-code-prompt.ts` → `extensions/claude-max/prompt.ts` unchanged** (it is pure; keep the top-of-file `oxlint-disable` comment). Update no imports — it has none beyond local.

- [ ] **Step 3: Move `claude-code-convert.ts` → `extensions/claude-max/convert.ts`.** Change its import of the prompt module from `'./claude-code-prompt'` to `'./prompt'`. Everything else unchanged.

- [ ] **Step 4: Move the convert test.** Copy any existing `src/orcd/__tests__/claude-code-convert*.test.ts` to `extensions/claude-max/__tests__/convert.test.ts`, updating the import path to `'../convert'`. If no such test exists today, write one asserting `toClaudeCodeToolName('read') === 'Read'` and that `convertPiMessagesToAnthropic` synthesizes a `tool_result` for an orphan `tool_use` (the existing behavior).

```ts
import { describe, expect, it } from 'vitest';
import { toClaudeCodeToolName, convertPiMessagesToAnthropic } from '../convert';

describe('claude code convert', () => {
  it('maps tool names to Claude Code spellings', () => {
    expect(toClaudeCodeToolName('read')).toBe('Read');
    expect(toClaudeCodeToolName('unknown_tool')).toBe('unknown_tool');
  });
});
```

- [ ] **Step 5: Run the convert test.**

Run: `npx vitest run extensions/claude-max/__tests__/convert.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add extensions/claude-max/package.json extensions/claude-max/prompt.ts extensions/claude-max/convert.ts extensions/claude-max/__tests__/convert.test.ts
git commit -m "feat(claude-max-ext): scaffold extension, move prompt+convert modules"
```

---

## Task 2: Move + adapt the auth module to the oauth-block shape

**Files:**
- Create: `extensions/claude-max/auth.ts`
- Create: `extensions/claude-max/__tests__/auth.test.ts`

- [ ] **Step 1: Write a failing test for the credential mapping.**

```ts
// extensions/claude-max/__tests__/auth.test.ts
import { describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', async (orig) => {
  const real = await orig<typeof import('node:fs')>();
  return {
    ...real,
    readFileSync: () =>
      JSON.stringify({ claudeAiOauth: { accessToken: 'A', refreshToken: 'R', expiresAt: Date.now() + 600000 } }),
  };
});

import { claudeMaxOAuth } from '../auth';

describe('claudeMaxOAuth block', () => {
  it('login() reads ~/.claude credentials headlessly into OAuthCredentials shape', async () => {
    const creds = await claudeMaxOAuth.login({} as never);
    expect(creds.access).toBe('A');
    expect(creds.refresh).toBe('R');
    expect(typeof creds.expires).toBe('number');
  });

  it('getApiKey returns the access token', () => {
    expect(claudeMaxOAuth.getApiKey({ access: 'A', refresh: 'R', expires: 1 })).toBe('A');
  });
});
```

- [ ] **Step 2: Run it to confirm it fails.**

Run: `npx vitest run extensions/claude-max/__tests__/auth.test.ts`
Expected: FAIL with "Cannot find module '../auth'".

- [ ] **Step 3: Implement `auth.ts`** by adapting `src/orcd/claude-code-auth.ts` into Pi's `ProviderConfig['oauth']` shape. Keep `~/.claude/.credentials.json` as source of truth; map its `{accessToken,refreshToken,expiresAt}` to Pi's `{access,refresh,expires}`.

```ts
/* oxlint-disable orchestrel/log-before-early-return -- pure OAuth creds helper, guard returns without session context */
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { OAuthCredentials, OAuthLoginCallbacks } from '@earendil-works/pi-ai';

const CREDENTIALS_PATH = join(homedir(), '.claude', '.credentials.json');
const TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

function readClaudeCreds(): OAuthCredentials {
  const raw = JSON.parse(readFileSync(CREDENTIALS_PATH, 'utf8')) as Record<string, unknown>;
  const o = raw.claudeAiOauth as Record<string, unknown> | undefined;
  const access = o?.accessToken;
  const refresh = o?.refreshToken;
  const expires = o?.expiresAt;
  if (typeof access !== 'string' || typeof refresh !== 'string' || typeof expires !== 'number') {
    throw new Error(`Claude Max OAuth credentials missing/invalid at ${CREDENTIALS_PATH}. Run \`claude\` to log in.`);
  }
  return { access, refresh, expires };
}

function writeClaudeCreds(next: OAuthCredentials): void {
  const raw = JSON.parse(readFileSync(CREDENTIALS_PATH, 'utf8')) as Record<string, unknown>;
  const prev = (raw.claudeAiOauth as Record<string, unknown>) ?? {};
  const merged = {
    ...raw,
    claudeAiOauth: { ...prev, accessToken: next.access, refreshToken: next.refresh, expiresAt: next.expires },
  };
  const tmp = `${CREDENTIALS_PATH}.orcd.tmp`;
  writeFileSync(tmp, JSON.stringify(merged, null, 2), { mode: 0o600 });
  renameSync(tmp, CREDENTIALS_PATH);
}

export const claudeMaxOAuth = {
  name: 'Claude Max',
  // orcd is a daemon: never run an interactive flow. Read the token claude already stored.
  async login(_callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
    return readClaudeCreds();
  },
  async refreshToken(current: OAuthCredentials): Promise<OAuthCredentials> {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grant_type: 'refresh_token', client_id: CLIENT_ID, refresh_token: current.refresh }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Claude Max OAuth refresh failed: ${res.status} ${body.slice(0, 200)}`);
    }
    const data = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number };
    const next: OAuthCredentials = {
      access: data.access_token,
      refresh: data.refresh_token || current.refresh,
      expires: Date.now() + data.expires_in * 1000,
    };
    writeClaudeCreds(next);
    return next;
  },
  getApiKey(creds: OAuthCredentials): string {
    return creds.access;
  },
};
```

- [ ] **Step 4: Run the auth test.**

Run: `npx vitest run extensions/claude-max/__tests__/auth.test.ts`
Expected: PASS (both cases).

- [ ] **Step 5: Commit.**

```bash
git add extensions/claude-max/auth.ts extensions/claude-max/__tests__/auth.test.ts
git commit -m "feat(claude-max-ext): oauth block over ~/.claude credentials"
```

---

## Task 3: Move the stream module (drop the global guard) and write the extension entry

**Files:**
- Create: `extensions/claude-max/stream.ts` (from `src/orcd/claude-code-stream.ts`)
- Create: `extensions/claude-max/index.ts`

- [ ] **Step 1: Move `claude-code-stream.ts` → `extensions/claude-max/stream.ts`.** Update imports: `'./claude-code-auth'` → `'./auth'` (and use the new helper — see Step 2), `'./claude-code-convert'` → `'./convert'`, `'./claude-code-prompt'` → `'./prompt'`.

- [ ] **Step 2: Remove the provider guard and adapt token sourcing.** Delete the `oauthProviderId` parameter and the `if (model.provider !== oauthProviderId) return streamSimpleAnthropic(...)` early return — this `streamSimple` is now attached only to the `anthropic` provider. For the access token, use the spike (Task 0 Step 3) outcome: if Pi passes the resolved key to `streamSimple`, read it from there; otherwise call a small shared getter. Concretely, export a token getter from `auth.ts` and call it:

```ts
// add to extensions/claude-max/auth.ts
let inflight: Promise<OAuthCredentials> | null = null;
export async function getAccessToken(): Promise<string> {
  const creds = readClaudeCreds();
  if (creds.expires - Date.now() > 60_000) return creds.access;
  if (!inflight) inflight = claudeMaxOAuth.refreshToken(creds).finally(() => { inflight = null; });
  return (await inflight).access;
}
```

```ts
// in extensions/claude-max/stream.ts, replace getClaudeMaxAccessToken() with:
import { getAccessToken } from './auth';
const apiKey = await getAccessToken();
```

Change the exported factory signature from `makeClaudeCodeStream(oauthProviderId: string)` to `makeClaudeCodeStream()` returning the stream function directly (no provider arg, no fallthrough).

- [ ] **Step 3: Write the extension entry `index.ts`.**

```ts
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { claudeMaxOAuth } from './auth';
import { makeClaudeCodeStream } from './stream';

// The provider name the extension augments. Must match the provider id orchestrel
// registers from config.yaml for the Claude Max provider.
const PROVIDER_NAME = process.env.ORCHESTREL_CLAUDE_MAX_PROVIDER ?? 'anthropic';

const extension: ExtensionFactory = (pi) => {
  pi.registerProvider(PROVIDER_NAME, {
    api: 'anthropic-messages',
    baseUrl: 'https://api.anthropic.com',
    oauth: claudeMaxOAuth,
    streamSimple: makeClaudeCodeStream(),
    // No `models`: augments orchestrel's catalog (see Task 0 spike outcome).
  });
};

export default extension;
```

- [ ] **Step 4: Typecheck the extension.**

Run: `npx tsc --noEmit` (from repo root; the extension is included in the project)
Expected: no errors in `extensions/claude-max/*`.

- [ ] **Step 5: Commit.**

```bash
git add extensions/claude-max/stream.ts extensions/claude-max/auth.ts extensions/claude-max/index.ts
git commit -m "feat(claude-max-ext): stream module + registerProvider entry"
```

---

## Task 4: Strip Claude-Max logic out of orcd

**Files:**
- Modify: `src/orcd/pi-runtime.ts`
- Delete: `src/orcd/claude-code-auth.ts`, `claude-code-convert.ts`, `claude-code-prompt.ts`, `claude-code-stream.ts`
- Delete/move: any `src/orcd/__tests__/claude-code-*.test.ts`

- [ ] **Step 1: Edit `registerOrchestrelProvider` to remove the branch.** Replace the `isClaudeMaxOAuth` lines (current `pi-runtime.ts:89,96,97`) so the config is provider-agnostic:

```ts
function registerOrchestrelProvider(
  modelRegistry: ModelRegistry,
  providerId: string,
  provider: NonNullable<CreatePiRuntimeSessionOpts['provider']>,
): void {
  const api = modelApi(provider.type);
  const cfg: ProviderConfigInput = {
    name: provider.label ?? providerId,
    api,
    baseUrl: provider.baseUrl || 'https://api.anthropic.com',
    apiKey: provider.apiKey || provider.authToken || `$${EMPTY_API_KEY_ENV}`,
    models: Object.entries(provider.models).map(([alias, model]) => ({
      id: model.modelID,
      name: modelName(alias, model),
      api,
      reasoning: provider.type === 'anthropic',
      input: ['text', 'image'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: model.contextWindow,
      maxTokens: 64_000,
    })),
  };
  modelRegistry.registerProvider(providerId, cfg);
}
```

- [ ] **Step 2: Remove the now-dead symbols.** Delete the `CLAUDE_MAX_OAUTH` constant (`pi-runtime.ts:14`), its explanatory comment block (`:10-13`), and the `import { makeClaudeCodeStream } from './claude-code-stream';` line (`:6`). Keep `usesBuiltInProvider`'s `if (provider.oauth) return false;` — an oauth provider is still never the SDK built-in.

- [ ] **Step 3: Delete the four vendored files and their orcd tests.**

```bash
git rm src/orcd/claude-code-auth.ts src/orcd/claude-code-convert.ts src/orcd/claude-code-prompt.ts src/orcd/claude-code-stream.ts
git rm -f src/orcd/__tests__/claude-code-*.test.ts 2>/dev/null || true
```

- [ ] **Step 4: Typecheck + lint to prove nothing in orcd still references the removed modules.**

Run: `npx tsc --noEmit && npm run lint`
Expected: no errors, no warnings, no unresolved imports.

- [ ] **Step 5: Run orcd's remaining unit tests.**

Run: `npx vitest run src/orcd`
Expected: PASS (pi-events, pi-provider, pi-runtime tests unaffected).

- [ ] **Step 6: Commit.**

```bash
git add src/orcd/pi-runtime.ts
git commit -m "refactor(orcd): drop Claude-Max provider code; generic registration only"
```

---

## Task 5: Install script + discovery wiring

**Files:**
- Create: `scripts/install-claude-max-extension.sh`

- [ ] **Step 1: Write the idempotent install script.**

```bash
#!/usr/bin/env bash
set -ex
SRC="$(cd "$(dirname "$0")/.." && pwd)/extensions/claude-max"
DEST="${HOME}/.pi/agent/extensions/claude-max"
mkdir -p "${HOME}/.pi/agent/extensions"
rm -rf "$DEST"
ln -s "$SRC" "$DEST"
ls -la "$DEST"
```

- [ ] **Step 2: Run it.**

Run: `bash scripts/install-claude-max-extension.sh`
Expected: symlink created; `ls -la` shows `claude-max -> .../extensions/claude-max`.

- [ ] **Step 3: Verify Pi discovers + loads the extension.** Write a throwaway probe that builds a `DefaultResourceLoader` (or calls `discoverAndLoadExtensions([], cwd, getAgentDir())`) and asserts the `claude-max` extension loaded with no errors.

```ts
// src/bin/scratch-verify-discovery.ts
import { discoverAndLoadExtensions } from '@earendil-works/pi-coding-agent/dist/core/extensions/loader.js';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
async function main() {
  const res = await discoverAndLoadExtensions([], process.cwd(), getAgentDir());
  console.log('LOADED:', res.extensions.map((e) => e.name ?? e));
  console.log('ERRORS:', JSON.stringify(res.errors));
}
main();
```

Run: `npx tsx src/bin/scratch-verify-discovery.ts`
Expected: `LOADED` includes `claude-max`; `ERRORS` is `[]`. If the deep import path is wrong, resolve `loader` via the package's exported surface instead (check `node_modules/@earendil-works/pi-coding-agent/package.json` `exports`).

- [ ] **Step 4: Delete the probe.**

```bash
rm src/bin/scratch-verify-discovery.ts
```

- [ ] **Step 5: Commit.**

```bash
git add scripts/install-claude-max-extension.sh
git commit -m "chore: install script for claude-max pi extension"
```

---

## Task 6: End-to-end live verification (the card-1681 path)

No new code — this proves the refactor preserves the billed, classifier-accepted path.

- [ ] **Step 1: Install the extension and restart the test daemon.**

```bash
bash scripts/install-claude-max-extension.sh
sudo systemctl restart orcd-pi2.service
```

- [ ] **Step 2: Confirm orcd registered the catalog and the extension augmented it.** Tail orcd-pi2 logs while creating a card on the `anthropic` provider (model sonnet) via the pi2 UI (test.orchestrel.com / port 6197). Send the prompt `ping`.

Run: `journalctl --user -u orcd-pi2.service -f` (or the unit's actual scope)
Expected: a request to `api.anthropic.com` with a `200`, an assistant turn streaming `pong`-like text, and **no** `out of extra usage` rejection.

- [ ] **Step 3: Confirm the token refresh path still writes back.** Temporarily set the stored `expiresAt` in `~/.claude/.credentials.json` to a near-past value (back up first), send another prompt, and verify `refreshToken` rotated the token and the file was rewritten atomically.

```bash
cp ~/.claude/.credentials.json /tmp/creds.bak
# edit expiresAt to Date.now()-1000 via jq, send a prompt, then:
diff <(jq .claudeAiOauth.accessToken /tmp/creds.bak) <(jq .claudeAiOauth.accessToken ~/.claude/.credentials.json)
```

Expected: access tokens differ (rotation occurred); the `claude` CLI still works against the same file.

- [ ] **Step 4: Negative check — other anthropic-format providers are untouched.** Create a card on `okkanti` (or `trackable`) and confirm it still routes via its normal `streamSimpleAnthropic` path (no Claude-Code reshaping, no Bearer from `~/.claude`).

Expected: normal behavior; the extension's `streamSimple` did not intercept it (it's attached only to `anthropic`).

---

## Task 7: Docs + memory

**Files:**
- Modify: `config.example.yaml`
- Modify: `CLAUDE.md` (Provider Routing section)

- [ ] **Step 1: Document the dependency in `config.example.yaml`** next to the `oauth: claude-max` example:

```yaml
# oauth: claude-max requires the `claude-max` Pi extension installed at
# ~/.pi/agent/extensions/claude-max (run scripts/install-claude-max-extension.sh).
# orcd itself contains no provider-specific code; the extension self-registers
# auth + Claude Code request reshaping for this provider.
```

- [ ] **Step 2: Update `CLAUDE.md` Provider Routing** to note that Claude Max auth/reshaping lives in a Pi extension (layer 5: provider-specific behavior is out-of-app), preserving the "all providers work identically — no special cases" invariant in orcd.

- [ ] **Step 3: Update shared memory** (the `Meridian … TORN DOWN` note already records native OAuth; add that the native path is now a Pi extension, not inline orcd code).

- [ ] **Step 4: Commit.**

```bash
git add config.example.yaml CLAUDE.md
git commit -m "docs: claude-max provider lives in a pi extension"
```

---

## Self-Review

- **Spec coverage:** A2 (Task 5 disk discovery, orcd imports nothing), B1 (Task 4 removes the branch), C2 (Task 2 oauth block + Task 3 streamSimple) all have tasks. Live path preserved (Task 6). Other providers protected (Task 6 Step 4).
- **Placeholder scan:** All code steps show real code; the two genuine unknowns are isolated to Task 0 spikes with explicit branch points, not hidden as TODOs.
- **Type consistency:** `OAuthCredentials` uses `{access, refresh, expires}` everywhere (matches `pi-ai/dist/utils/oauth/types.d.ts`). `makeClaudeCodeStream()` is parameterless after Task 3 and is called parameterless in `index.ts`. `claudeMaxOAuth` shape matches `ProviderConfig['oauth']` (`name`/`login`/`refreshToken`/`getApiKey`).
- **Risk:** the single largest risk (does no-`models` registration augment vs clobber, and how `streamSimple` gets the key) is retired first, in Task 0, before any irreversible deletion in Task 4.
