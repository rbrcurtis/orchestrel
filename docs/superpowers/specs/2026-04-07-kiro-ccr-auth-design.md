# Kiro CCR Auth — Multi-Account Token Management for Claude Code Router

CLI tool + CCR custom transformer for managing pooled Kiro (AWS Q Developer) accounts with automatic token refresh, health tracking, and lowest-usage rotation.

## Architecture

```
Orchestrel SessionManager
  ├── provider = "anthropic" → direct to api.anthropic.com (no CCR)
  └── provider = "trackable" | "okkanti" | ...
        → ANTHROPIC_BASE_URL = http://127.0.0.1:3457
        → Claude Code subprocess sends request to CCR
              │
              ▼
        CUSTOM_ROUTER_PATH (custom-router.js)
          → parses "trackable:claude-sonnet-4-6"
          → strips prefix, returns "trackable,claude-sonnet-4-6"
              │
              ▼
        CCR provider "trackable" (type: codewhisperer)
          → converts Anthropic format → CodeWhisperer format
          → KiroAuthTransformer.auth() picks token from pool
          → injects Authorization header + profileArn
              │
              ▼
        https://codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse
```

Key points:
- Anthropic provider bypasses CCR entirely — Agent SDK goes direct with API key.
- Only Kiro providers (trackable, okkanti, future pools) route through CCR.
- CCR is `@musistudio/claude-code-router@2.0.0` (the official package, not the Jason Zhang fork currently installed).
- Per-request token selection via custom transformer — instant failover, no external refresh daemon.

## Project Structure

```
~/Code/kiro-ccr-auth/
  ├── cli.ts              — CLI entry point (arg parsing → commands)
  ├── commands/
  │   ├── login.ts        — OIDC device code flow
  │   ├── status.ts       — show pools, accounts, health
  │   ├── logout.ts       — remove account from pool
  │   └── refresh.ts      — manual token refresh (debugging)
  ├── lib/
  │   ├── db.ts           — SQLite account store (better-sqlite3)
  │   ├── oidc.ts         — OIDC device code flow implementation
  │   ├── refresh.ts      — token refresh (IDC + desktop methods)
  │   └── accounts.ts     — account selection (lowest-usage, health tracking)
  ├── transformer.ts      — CCR custom transformer (loaded by CCR at runtime)
  ├── custom-router.ts    — CCR custom router (provider prefix parsing)
  ├── config.json         — pool definitions (gitignored)
  ├── config.example.json — template (checked in)
  ├── package.json
  └── tsconfig.json

~/.config/kiro-auth/
  └── accounts.db         — SQLite credential store (runtime data)

~/bin/
  └── kiro-auth → ~/Code/kiro-ccr-auth/dist/cli.js  (symlink)
```

## Pool Configuration

`~/Code/kiro-ccr-auth/config.json` (gitignored, template at `config.example.json`):

```json
{
  "pools": {
    "trackable": {
      "startUrl": "https://trackable.awsapps.com/start",
      "profileArn": "arn:aws:codewhisperer:us-east-1:547025169931:profile/WKEWWQMKGKVC",
      "oidcRegion": "us-east-2",
      "serviceRegion": "us-east-1"
    },
    "okkanti": {
      "startUrl": "https://d-90660512b0.awsapps.com/start",
      "profileArn": "arn:aws:codewhisperer:us-east-1:313941174970:profile/Y7VYR77U33DE",
      "oidcRegion": "us-east-1",
      "serviceRegion": "us-east-1"
    }
  },
  "dbPath": "~/.config/kiro-auth/accounts.db",
  "selectionStrategy": "lowest-usage",
  "tokenExpiryBufferMs": 300000
}
```

Adding a new Kiro org is: add a pool entry, run `kiro-auth login <pool-name>`.

## CLI Commands

### `kiro-auth login <pool>`

1. Read pool config (startUrl, oidcRegion, profileArn)
2. Register OIDC client via `POST https://oidc.{oidcRegion}.amazonaws.com/client/register`:
   - `clientName: "Kiro IDE"`, `clientType: "public"`
   - `scopes: ["codewhisperer:completions", "codewhisperer:analysis", "codewhisperer:conversations", "codewhisperer:transformations", "codewhisperer:taskassist"]`
   - `grantTypes: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"]`
   - Returns `clientId`, `clientSecret`
3. Request device authorization via `POST https://oidc.{oidcRegion}.amazonaws.com/device_authorization`:
   - `clientId`, `clientSecret`, `startUrl`
   - Returns `verificationUriComplete`, `userCode`, `deviceCode`, `interval`
4. Print instructions + open browser: `{startUrl}/#/device?user_code={userCode}`
5. Poll `POST https://oidc.{oidcRegion}.amazonaws.com/token` with `grantType: "urn:ietf:params:oauth:grant-type:device_code"` until authorized
   - Handle `authorization_pending` (keep polling), `slow_down` (+5s interval), `expired_token`/`access_denied` (abort)
6. Call `GET https://q.{serviceRegion}.amazonaws.com/getUsageLimits?isEmailRequired=true&origin=AI_EDITOR&resourceType=AGENTIC_REQUEST&profileArn={profileArn}` to fetch email + verify account
7. Store account in DB with all credentials
8. Print summary: "Added ryan.curtis@trackable.io to trackable pool (2 accounts)"

### `kiro-auth status`

```
trackable (2 accounts)
  profileArn: ...547025169931:profile/WKEWWQMKGKVC
  ryan.curtis@trackable.io     healthy  590/2000  expires in 42m
  ryan.curtis+2@trackable.io   healthy  2000/2000 expires in 42m

okkanti (1 account)
  profileArn: ...313941174970:profile/Y7VYR77U33DE
  ryan@okkanti.com             healthy  848/1000  expires in 15m
```

### `kiro-auth logout <pool> [email]`

Remove an account from a pool. If email omitted and pool has one account, removes it. If multiple, lists and prompts.

### `kiro-auth refresh [pool]`

Manually refresh tokens for all accounts (or a specific pool). For debugging — the transformer refreshes on-demand during normal operation.

## Account DB Schema

SQLite at `~/.config/kiro-auth/accounts.db`:

| Column | Type | Description |
|---|---|---|
| `id` | TEXT PK | SHA-256 of `pool:email:clientId` |
| `pool` | TEXT NOT NULL | Pool name (trackable, okkanti) |
| `email` | TEXT NOT NULL | User email from usage API |
| `auth_method` | TEXT NOT NULL | `'idc'` (extensible to `'desktop'`) |
| `region` | TEXT NOT NULL | Service region (from profileArn) |
| `oidc_region` | TEXT NOT NULL | OIDC endpoint region |
| `client_id` | TEXT NOT NULL | OIDC dynamic client ID |
| `client_secret` | TEXT NOT NULL | OIDC dynamic client secret |
| `profile_arn` | TEXT NOT NULL | CodeWhisperer profile ARN |
| `start_url` | TEXT NOT NULL | IDC portal URL |
| `access_token` | TEXT NOT NULL | Current Bearer token |
| `refresh_token` | TEXT NOT NULL | For token refresh |
| `expires_at` | INTEGER NOT NULL | Unix ms timestamp |
| `is_healthy` | INTEGER DEFAULT 1 | 0/1 |
| `fail_count` | INTEGER DEFAULT 0 | Consecutive failures |
| `used_count` | INTEGER DEFAULT 0 | Requests used this period |
| `limit_count` | INTEGER DEFAULT 0 | Quota limit |
| `rate_limit_reset` | INTEGER DEFAULT 0 | Unix ms — cooldown until |
| `last_used` | INTEGER DEFAULT 0 | Unix ms — tie-breaking |

Index on `(pool, is_healthy)` for fast selection.

## CCR Custom Transformer

Loaded via CCR's top-level `"transformers"` config array. The transformer class receives `{ pool: "trackable" }` as constructor options. CCR's `transformRequestIn` hook runs per-request before the provider sends the request.

### `transformRequestIn(body, provider, { req })` — called per-request

1. Determine pool from `req.provider` name (matches pool name in config)
2. Query DB for best account: `SELECT * FROM accounts WHERE pool = ? AND is_healthy = 1 AND rate_limit_reset < ? ORDER BY used_count ASC, last_used ASC LIMIT 1`
3. If no healthy accounts, try unhealthy ones (fail_count < 10, not permanently failed)
4. If selected account's token expires within buffer (5 min default):
   - Refresh via `POST https://oidc.{oidcRegion}.amazonaws.com/token` with `{ refreshToken, clientId, clientSecret, grantType: "refresh_token" }`
   - Update DB with new accessToken, refreshToken, expiresAt
   - On refresh failure: mark unhealthy, select next account
5. Inject `profileArn` into request body (CodeWhisperer requires it)
6. Return `{ body, config: { headers: { Authorization: "Bearer {accessToken}" } } }` — this overrides the default Authorization header

The transformer also increments `used_count` and updates `last_used` on each request.

### `transformResponseIn(response, ctx)` — called per-response

Handles post-response feedback to update account health:

- **429 (rate limited)**: set `rate_limit_reset` to `now + retryAfterMs`
- **401/403 (auth failure)**: increment `fail_count`, mark `is_healthy = 0` after 3 consecutive failures
- **Success**: reset `fail_count` to 0 if > 0

Usage limits (`used_count`/`limit_count`) are updated from the `getUsageLimits` API during login and manual refresh, not per-request.

## CCR Custom Router

`~/Code/kiro-ccr-auth/dist/custom-router.js` — loaded via `CUSTOM_ROUTER_PATH` in CCR config.

```javascript
module.exports = async function router(req, config) {
  const model = req.body.model;
  if (!model || !model.includes(':')) return null;

  const colonIdx = model.indexOf(':');
  const provider = model.slice(0, colonIdx);
  const actualModel = model.slice(colonIdx + 1);

  req.body.model = actualModel;
  return `${provider},${actualModel}`;
};
```

Only Kiro providers hit CCR, so every request has a prefix. If somehow a non-prefixed request arrives, returns `null` to fall through to default routing.

## CCR Configuration

`~/.claude-code-router/config.json` — official `@musistudio/claude-code-router` format:

```json
{
  "PORT": 3457,
  "CUSTOM_ROUTER_PATH": "~/Code/kiro-ccr-auth/dist/custom-router.js",
  "transformers": [
    {
      "path": "~/Code/kiro-ccr-auth/dist/transformer.js",
      "options": {}
    }
  ],
  "Providers": [
    {
      "name": "trackable",
      "type": "codewhisperer",
      "baseUrl": "https://codewhisperer.us-east-1.amazonaws.com",
      "apiKey": "placeholder",
      "transformer": "kiro-auth"
    },
    {
      "name": "okkanti",
      "type": "codewhisperer",
      "baseUrl": "https://codewhisperer.us-east-1.amazonaws.com",
      "apiKey": "placeholder",
      "transformer": "kiro-auth"
    }
  ]
}
```

The `apiKey: "placeholder"` is overridden per-request by the transformer's `transformRequestIn` return value. The `transformer: "kiro-auth"` references the transformer by its `name` property. The transformer reads `req.provider` to determine which pool to use (provider name = pool name).

Port 3457 (avoids 3456 which is occupied). No anthropic provider — Orchestrel sends anthropic requests directly.

## Orchestrel Integration

### SessionManager change

In `src/server/sessions/manager.ts`, conditionally set `ANTHROPIC_BASE_URL`:

```typescript
const isKiroProvider = opts.provider !== 'anthropic';
const env = {
  ...process.env,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? '',
  ...(isKiroProvider ? { ANTHROPIC_BASE_URL: process.env.CCR_URL ?? 'http://127.0.0.1:3457' } : {}),
};
```

When `provider === 'anthropic'`, no `ANTHROPIC_BASE_URL` override — the SDK goes direct to `api.anthropic.com`.

### Model name encoding

No change — Orchestrel already encodes `{provider}:{model}` (e.g., `trackable:claude-sonnet-4-6`). The custom router strips it. For anthropic, the model name is sent without prefix since it doesn't go through CCR.

The SessionManager model string construction adjusts:

```typescript
const modelStr = isKiroProvider ? `${opts.provider}:${opts.model}` : opts.model;
```

## CCR Installation

Replace the wrong fork with the official package:

```bash
npm uninstall -g claude-code-router
npm install -g @musistudio/claude-code-router
```

Run as systemd service or manually via `ccr start`.

## OIDC Endpoints Reference

| Endpoint | Purpose |
|---|---|
| `https://oidc.{oidcRegion}.amazonaws.com/client/register` | Register OIDC client |
| `https://oidc.{oidcRegion}.amazonaws.com/device_authorization` | Get device code |
| `https://oidc.{oidcRegion}.amazonaws.com/token` | Poll for token / refresh |
| `https://q.{serviceRegion}.amazonaws.com/getUsageLimits` | Usage + email lookup |
| `https://codewhisperer.{serviceRegion}.amazonaws.com/generateAssistantResponse` | Chat API (CCR target) |

## Dependencies

```
better-sqlite3    — SQLite for account DB
arg               — CLI argument parsing
open              — Open browser for device login
```

Zero external auth libraries — the OIDC flow is simple enough to implement with `fetch()`.

## CCR Package Note

The official package is `@musistudio/claude-code-router@2.0.0` (npm). The currently installed `claude-code-router@2.1.1` is a different fork by a different author — it must be replaced. The transformer API (`transformRequestIn` returning `{ body, config: { headers } }`) is verified from the official package source and matches the built-in `vertex-gemini` transformer pattern.
