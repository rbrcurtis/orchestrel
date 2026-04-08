# Kiro CCR Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** CLI tool + CCR custom transformer for managing pooled Kiro (AWS Q Developer) accounts with OIDC device code login, automatic token refresh, health tracking, and lowest-usage rotation.

**Architecture:** Standalone TypeScript project at `~/Code/kiro-ccr-auth/`. CLI handles login/status/logout/refresh. A CCR custom transformer (`transformRequestIn`) dynamically injects auth headers per-request by selecting the best account from a SQLite pool. The custom router parses provider prefixes from model names.

**Tech Stack:** TypeScript, better-sqlite3, arg (CLI), open (browser launch), node fetch (OIDC HTTP calls)

**Spec:** `docs/superpowers/specs/2026-04-07-kiro-ccr-auth-design.md`

---

## File Structure

### New Files
| File | Responsibility |
|------|---------------|
| `~/Code/kiro-ccr-auth/package.json` | Project config, dependencies, build script |
| `~/Code/kiro-ccr-auth/tsconfig.json` | TypeScript config |
| `~/Code/kiro-ccr-auth/.gitignore` | Ignore config.json, node_modules, dist |
| `~/Code/kiro-ccr-auth/config.example.json` | Pool config template |
| `~/Code/kiro-ccr-auth/src/cli.ts` | CLI entry point (arg parsing, command dispatch) |
| `~/Code/kiro-ccr-auth/src/commands/login.ts` | OIDC device code login flow |
| `~/Code/kiro-ccr-auth/src/commands/status.ts` | Show pools, accounts, health |
| `~/Code/kiro-ccr-auth/src/commands/logout.ts` | Remove account from pool |
| `~/Code/kiro-ccr-auth/src/commands/refresh.ts` | Manual token refresh |
| `~/Code/kiro-ccr-auth/src/lib/config.ts` | Load and validate config.json |
| `~/Code/kiro-ccr-auth/src/lib/db.ts` | SQLite account store |
| `~/Code/kiro-ccr-auth/src/lib/oidc.ts` | OIDC client registration + device code flow |
| `~/Code/kiro-ccr-auth/src/lib/refresh.ts` | Token refresh (IDC method) |
| `~/Code/kiro-ccr-auth/src/lib/accounts.ts` | Account selection + health tracking |
| `~/Code/kiro-ccr-auth/src/lib/usage.ts` | getUsageLimits API call |
| `~/Code/kiro-ccr-auth/src/transformer.ts` | CCR custom transformer class |
| `~/Code/kiro-ccr-auth/src/custom-router.ts` | CCR custom router (prefix parsing) |

### Modified Files
| File | Changes |
|------|---------|
| `~/.claude-code-router/config.json` | Rewrite for official musistudio CCR format |
| Orchestrel `src/server/sessions/manager.ts` | Conditional ANTHROPIC_BASE_URL + model prefix |

---

## Task 1: Project Scaffold

**Files:**
- Create: `~/Code/kiro-ccr-auth/package.json`
- Create: `~/Code/kiro-ccr-auth/tsconfig.json`
- Create: `~/Code/kiro-ccr-auth/.gitignore`
- Create: `~/Code/kiro-ccr-auth/config.example.json`

- [ ] **Step 1: Create project directory and initialize**

```bash
mkdir -p ~/Code/kiro-ccr-auth/src/{commands,lib}
cd ~/Code/kiro-ccr-auth
git init
```

- [ ] **Step 2: Write package.json**

Write `~/Code/kiro-ccr-auth/package.json`:

```json
{
  "name": "kiro-ccr-auth",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "bin": {
    "kiro-auth": "./dist/cli.js"
  },
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch"
  },
  "dependencies": {
    "arg": "^5.0.2",
    "better-sqlite3": "^12.6.0",
    "open": "^10.1.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.13",
    "@types/node": "^22.0.0",
    "typescript": "^5.7.0"
  }
}
```

- [ ] **Step 3: Write tsconfig.json**

Write `~/Code/kiro-ccr-auth/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "sourceMap": true
  },
  "include": ["src"]
}
```

- [ ] **Step 4: Write .gitignore**

Write `~/Code/kiro-ccr-auth/.gitignore`:

```
node_modules/
dist/
config.json
```

- [ ] **Step 5: Write config.example.json**

Write `~/Code/kiro-ccr-auth/config.example.json`:

```json
{
  "pools": {
    "trackable": {
      "startUrl": "https://your-org.awsapps.com/start",
      "profileArn": "arn:aws:codewhisperer:us-east-1:ACCOUNT:profile/PROFILEID",
      "oidcRegion": "us-east-2",
      "serviceRegion": "us-east-1"
    }
  },
  "dbPath": "~/.config/kiro-auth/accounts.db",
  "selectionStrategy": "lowest-usage",
  "tokenExpiryBufferMs": 300000
}
```

- [ ] **Step 6: Install dependencies**

```bash
cd ~/Code/kiro-ccr-auth && npm install
```

- [ ] **Step 7: Commit**

```bash
cd ~/Code/kiro-ccr-auth
git add -A
git commit -m "chore: project scaffold"
```

---

## Task 2: Config Loader

**Files:**
- Create: `~/Code/kiro-ccr-auth/src/lib/config.ts`

- [ ] **Step 1: Write config loader**

Write `~/Code/kiro-ccr-auth/src/lib/config.ts`:

```typescript
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

export interface PoolConfig {
  startUrl: string;
  profileArn: string;
  oidcRegion: string;
  serviceRegion: string;
}

export interface Config {
  pools: Record<string, PoolConfig>;
  dbPath: string;
  selectionStrategy: 'lowest-usage' | 'round-robin';
  tokenExpiryBufferMs: number;
}

function expandHome(p: string): string {
  if (p.startsWith('~/')) return resolve(process.env.HOME ?? '', p.slice(2));
  return p;
}

let cached: Config | null = null;

export function loadConfig(): Config {
  if (cached) return cached;

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const configPath = resolve(__dirname, '../../config.json');

  if (!existsSync(configPath)) {
    throw new Error(`Config not found at ${configPath}. Copy config.example.json to config.json`);
  }

  const raw = JSON.parse(readFileSync(configPath, 'utf-8'));

  if (!raw.pools || typeof raw.pools !== 'object') {
    throw new Error('config.json must have a "pools" object');
  }

  cached = {
    pools: raw.pools,
    dbPath: expandHome(raw.dbPath ?? '~/.config/kiro-auth/accounts.db'),
    selectionStrategy: raw.selectionStrategy ?? 'lowest-usage',
    tokenExpiryBufferMs: raw.tokenExpiryBufferMs ?? 300_000,
  };
  return cached;
}

export function getPool(name: string): PoolConfig {
  const config = loadConfig();
  const pool = config.pools[name];
  if (!pool) {
    const available = Object.keys(config.pools).join(', ');
    throw new Error(`Unknown pool "${name}". Available: ${available}`);
  }
  return pool;
}
```

- [ ] **Step 2: Verify it compiles**

```bash
cd ~/Code/kiro-ccr-auth && npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/lib/config.ts && git commit -m "feat: config loader"
```

---

## Task 3: SQLite Account Store

**Files:**
- Create: `~/Code/kiro-ccr-auth/src/lib/db.ts`

- [ ] **Step 1: Write the DB module**

Write `~/Code/kiro-ccr-auth/src/lib/db.ts`:

```typescript
import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { createHash } from 'crypto';
import { loadConfig } from './config.js';

export interface Account {
  id: string;
  pool: string;
  email: string;
  auth_method: string;
  region: string;
  oidc_region: string;
  client_id: string;
  client_secret: string;
  profile_arn: string;
  start_url: string;
  access_token: string;
  refresh_token: string;
  expires_at: number;
  is_healthy: number;
  fail_count: number;
  used_count: number;
  limit_count: number;
  rate_limit_reset: number;
  last_used: number;
}

function accountId(pool: string, email: string, clientId: string): string {
  return createHash('sha256').update(`${pool}:${email}:${clientId}`).digest('hex');
}

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;
  const config = loadConfig();
  mkdirSync(dirname(config.dbPath), { recursive: true });
  _db = new Database(config.dbPath);
  _db.pragma('journal_mode = WAL');
  _db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      pool TEXT NOT NULL,
      email TEXT NOT NULL,
      auth_method TEXT NOT NULL DEFAULT 'idc',
      region TEXT NOT NULL,
      oidc_region TEXT NOT NULL,
      client_id TEXT NOT NULL,
      client_secret TEXT NOT NULL,
      profile_arn TEXT NOT NULL,
      start_url TEXT NOT NULL,
      access_token TEXT NOT NULL,
      refresh_token TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      is_healthy INTEGER NOT NULL DEFAULT 1,
      fail_count INTEGER NOT NULL DEFAULT 0,
      used_count INTEGER NOT NULL DEFAULT 0,
      limit_count INTEGER NOT NULL DEFAULT 0,
      rate_limit_reset INTEGER NOT NULL DEFAULT 0,
      last_used INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_pool_health ON accounts(pool, is_healthy);
  `);
  return _db;
}

export function upsertAccount(acct: Omit<Account, 'id' | 'is_healthy' | 'fail_count' | 'rate_limit_reset' | 'last_used'> & Partial<Pick<Account, 'used_count' | 'limit_count'>>): string {
  const db = getDb();
  const id = accountId(acct.pool, acct.email, acct.client_id);
  db.prepare(`
    INSERT INTO accounts (id, pool, email, auth_method, region, oidc_region, client_id, client_secret, profile_arn, start_url, access_token, refresh_token, expires_at, used_count, limit_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      access_token = excluded.access_token,
      refresh_token = excluded.refresh_token,
      expires_at = excluded.expires_at,
      client_secret = excluded.client_secret,
      is_healthy = 1,
      fail_count = 0,
      used_count = COALESCE(excluded.used_count, used_count),
      limit_count = COALESCE(excluded.limit_count, limit_count)
  `).run(id, acct.pool, acct.email, acct.auth_method, acct.region, acct.oidc_region, acct.client_id, acct.client_secret, acct.profile_arn, acct.start_url, acct.access_token, acct.refresh_token, acct.expires_at, acct.used_count ?? 0, acct.limit_count ?? 0);
  return id;
}

export function getAccountsByPool(pool: string): Account[] {
  return getDb().prepare('SELECT * FROM accounts WHERE pool = ? ORDER BY used_count ASC, last_used ASC').all(pool) as Account[];
}

export function getAccount(id: string): Account | undefined {
  return getDb().prepare('SELECT * FROM accounts WHERE id = ?').get(id) as Account | undefined;
}

export function getAllAccounts(): Account[] {
  return getDb().prepare('SELECT * FROM accounts ORDER BY pool, used_count ASC').all() as Account[];
}

export function deleteAccount(id: string): void {
  getDb().prepare('DELETE FROM accounts WHERE id = ?').run(id);
}

export function updateTokens(id: string, accessToken: string, refreshToken: string, expiresAt: number): void {
  getDb().prepare('UPDATE accounts SET access_token = ?, refresh_token = ?, expires_at = ?, is_healthy = 1, fail_count = 0 WHERE id = ?').run(accessToken, refreshToken, expiresAt, id);
}

export function markUsed(id: string): void {
  getDb().prepare('UPDATE accounts SET used_count = used_count + 1, last_used = ? WHERE id = ?').run(Date.now(), id);
}

export function markUnhealthy(id: string): void {
  getDb().prepare('UPDATE accounts SET fail_count = fail_count + 1, is_healthy = CASE WHEN fail_count + 1 >= 3 THEN 0 ELSE is_healthy END WHERE id = ?').run(id);
}

export function markHealthy(id: string): void {
  getDb().prepare('UPDATE accounts SET fail_count = 0, is_healthy = 1 WHERE id = ?').run(id);
}

export function setRateLimit(id: string, resetMs: number): void {
  getDb().prepare('UPDATE accounts SET rate_limit_reset = ? WHERE id = ?').run(resetMs, id);
}

export function updateUsage(id: string, usedCount: number, limitCount: number): void {
  getDb().prepare('UPDATE accounts SET used_count = ?, limit_count = ? WHERE id = ?').run(usedCount, limitCount, id);
}
```

- [ ] **Step 2: Verify compilation**

```bash
cd ~/Code/kiro-ccr-auth && npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/lib/db.ts && git commit -m "feat: SQLite account store"
```

---

## Task 4: OIDC Device Code Flow

**Files:**
- Create: `~/Code/kiro-ccr-auth/src/lib/oidc.ts`

- [ ] **Step 1: Write OIDC module**

Write `~/Code/kiro-ccr-auth/src/lib/oidc.ts`:

```typescript
const SCOPES = [
  'codewhisperer:completions',
  'codewhisperer:analysis',
  'codewhisperer:conversations',
  'codewhisperer:transformations',
  'codewhisperer:taskassist',
];

const HEADERS = {
  'Content-Type': 'application/json',
  'Accept': 'application/json',
  'x-amzn-kiro-agent-mode': 'vibe',
  'user-agent': 'aws-sdk-js/3.738.0 ua/2.1 os/other lang/js api/sso-oidc#3.738.0 m/E KiroIDE',
  'Connection': 'close',
};

interface ClientRegistration {
  clientId: string;
  clientSecret: string;
}

export interface DeviceAuth {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  interval: number;
  expiresIn: number;
}

export interface TokenResult {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export async function registerClient(oidcRegion: string): Promise<ClientRegistration> {
  const url = `https://oidc.${oidcRegion}.amazonaws.com/client/register`;
  const res = await fetch(url, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({
      clientName: 'Kiro IDE',
      clientType: 'public',
      scopes: SCOPES,
      grantTypes: ['urn:ietf:params:oauth:grant-type:device_code', 'refresh_token'],
    }),
  });
  if (!res.ok) throw new Error(`Client registration failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return { clientId: data.clientId, clientSecret: data.clientSecret };
}

export async function startDeviceAuth(
  oidcRegion: string,
  clientId: string,
  clientSecret: string,
  startUrl: string,
): Promise<DeviceAuth> {
  const url = `https://oidc.${oidcRegion}.amazonaws.com/device_authorization`;
  const res = await fetch(url, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({ clientId, clientSecret, startUrl }),
  });
  if (!res.ok) throw new Error(`Device authorization failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return {
    deviceCode: data.deviceCode,
    userCode: data.userCode,
    verificationUri: data.verificationUri ?? data.verificationUriComplete,
    verificationUriComplete: data.verificationUriComplete ?? data.verificationUri,
    interval: data.interval ?? 5,
    expiresIn: data.expiresIn ?? 600,
  };
}

export async function pollForToken(
  oidcRegion: string,
  clientId: string,
  clientSecret: string,
  deviceCode: string,
  interval: number,
  expiresIn: number,
): Promise<TokenResult> {
  const deadline = Date.now() + expiresIn * 1000;
  let pollInterval = interval;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollInterval * 1000));

    const url = `https://oidc.${oidcRegion}.amazonaws.com/token`;
    const res = await fetch(url, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({
        clientId,
        clientSecret,
        deviceCode,
        grantType: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    });

    if (res.ok) {
      const data = await res.json();
      const accessToken = data.accessToken ?? data.access_token;
      const refreshToken = data.refreshToken ?? data.refresh_token;
      const expiresInSec = data.expiresIn ?? data.expires_in ?? 3600;
      return {
        accessToken,
        refreshToken,
        expiresAt: Date.now() + expiresInSec * 1000,
      };
    }

    const err = await res.json().catch(() => ({ error: 'unknown' }));
    if (err.error === 'authorization_pending') continue;
    if (err.error === 'slow_down') { pollInterval += 5; continue; }
    if (err.error === 'expired_token') throw new Error('Device code expired. Please try again.');
    if (err.error === 'access_denied') throw new Error('Access denied. The authorization was rejected.');
    throw new Error(`Token poll failed: ${err.error ?? res.status}`);
  }

  throw new Error('Device code expired (timeout). Please try again.');
}
```

- [ ] **Step 2: Verify compilation**

```bash
cd ~/Code/kiro-ccr-auth && npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/lib/oidc.ts && git commit -m "feat: OIDC device code flow"
```

---

## Task 5: Token Refresh + Usage API

**Files:**
- Create: `~/Code/kiro-ccr-auth/src/lib/refresh.ts`
- Create: `~/Code/kiro-ccr-auth/src/lib/usage.ts`

- [ ] **Step 1: Write token refresh module**

Write `~/Code/kiro-ccr-auth/src/lib/refresh.ts`:

```typescript
import type { Account } from './db.js';

const HEADERS = {
  'Content-Type': 'application/json',
  'Accept': 'application/json',
  'amz-sdk-request': 'attempt=1; max=1',
  'x-amzn-kiro-agent-mode': 'vibe',
  'user-agent': 'aws-sdk-js/3.738.0 ua/2.1 os/other lang/js api/sso-oidc#3.738.0 m/E KiroIDE',
  'Connection': 'close',
};

export interface RefreshResult {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export async function refreshToken(account: Account): Promise<RefreshResult> {
  if (account.auth_method === 'idc') {
    return refreshIdc(account);
  }
  return refreshDesktop(account);
}

async function refreshIdc(account: Account): Promise<RefreshResult> {
  const url = `https://oidc.${account.oidc_region}.amazonaws.com/token`;
  const res = await fetch(url, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({
      refreshToken: account.refresh_token,
      clientId: account.client_id,
      clientSecret: account.client_secret,
      grantType: 'refresh_token',
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`IDC token refresh failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  const accessToken = data.accessToken ?? data.access_token;
  const newRefreshToken = data.refreshToken ?? data.refresh_token ?? account.refresh_token;
  const expiresInSec = data.expiresIn ?? data.expires_in ?? 3600;

  return {
    accessToken,
    refreshToken: newRefreshToken,
    expiresAt: Date.now() + expiresInSec * 1000,
  };
}

async function refreshDesktop(account: Account): Promise<RefreshResult> {
  const url = `https://prod.${account.region}.auth.desktop.kiro.dev/refreshToken`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: account.refresh_token }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Desktop token refresh failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  return {
    accessToken: data.accessToken,
    refreshToken: data.refreshToken ?? account.refresh_token,
    expiresAt: data.expiresAt ? new Date(data.expiresAt).getTime() : Date.now() + 3600_000,
  };
}
```

- [ ] **Step 2: Write usage API module**

Write `~/Code/kiro-ccr-auth/src/lib/usage.ts`:

```typescript
export interface UsageResult {
  email: string;
  usedCount: number;
  limitCount: number;
}

export async function fetchUsageLimits(
  accessToken: string,
  serviceRegion: string,
  profileArn: string,
): Promise<UsageResult> {
  const params = new URLSearchParams({
    isEmailRequired: 'true',
    origin: 'AI_EDITOR',
    resourceType: 'AGENTIC_REQUEST',
    profileArn,
  });

  const url = `https://q.${serviceRegion}.amazonaws.com/getUsageLimits?${params}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'x-amzn-kiro-agent-mode': 'vibe',
      'amz-sdk-request': 'attempt=1; max=1',
    },
  });

  if (!res.ok) throw new Error(`getUsageLimits failed: ${res.status} ${await res.text()}`);

  const data = await res.json();
  const email = data.userInfo?.email ?? 'unknown';
  const breakdown = data.usageBreakdownList?.[0];
  const free = breakdown?.freeTrialInfo;
  const usedCount = free?.currentUsage ?? breakdown?.currentUsage ?? 0;
  const limitCount = free?.usageLimit ?? breakdown?.usageLimit ?? 0;

  return { email, usedCount, limitCount };
}
```

- [ ] **Step 3: Verify compilation**

```bash
cd ~/Code/kiro-ccr-auth && npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add src/lib/refresh.ts src/lib/usage.ts && git commit -m "feat: token refresh and usage API"
```

---

## Task 6: Account Selection

**Files:**
- Create: `~/Code/kiro-ccr-auth/src/lib/accounts.ts`

- [ ] **Step 1: Write account selection module**

Write `~/Code/kiro-ccr-auth/src/lib/accounts.ts`:

```typescript
import { getAccountsByPool, markUsed, markUnhealthy, markHealthy, setRateLimit, updateTokens, type Account } from './db.js';
import { refreshToken } from './refresh.js';
import { loadConfig } from './config.js';

export async function selectAccount(pool: string): Promise<Account> {
  const config = loadConfig();
  const now = Date.now();
  const accounts = getAccountsByPool(pool);

  if (accounts.length === 0) {
    throw new Error(`No accounts in pool "${pool}". Run: kiro-auth login ${pool}`);
  }

  // Filter to usable accounts: healthy + not rate-limited
  let candidates = accounts.filter((a) => a.is_healthy && a.rate_limit_reset < now);

  // Fallback: try unhealthy accounts with low fail count
  if (candidates.length === 0) {
    candidates = accounts.filter((a) => a.fail_count < 10 && a.rate_limit_reset < now);
  }

  if (candidates.length === 0) {
    throw new Error(`All accounts in pool "${pool}" are unhealthy or rate-limited`);
  }

  // lowest-usage selection (already sorted by used_count ASC, last_used ASC from query)
  const account = candidates[0];

  // Refresh token if expiring within buffer
  if (account.expires_at - now < config.tokenExpiryBufferMs) {
    try {
      const result = await refreshToken(account);
      updateTokens(account.id, result.accessToken, result.refreshToken, result.expiresAt);
      account.access_token = result.accessToken;
      account.refresh_token = result.refreshToken;
      account.expires_at = result.expiresAt;
    } catch (err) {
      console.error(`[kiro-auth] refresh failed for ${account.email}: ${err}`);
      markUnhealthy(account.id);
      // Recurse to try next account
      return selectAccount(pool);
    }
  }

  return account;
}

export function recordSuccess(id: string): void {
  markUsed(id);
  markHealthy(id);
}

export function recordAuthFailure(id: string): void {
  markUnhealthy(id);
}

export function recordRateLimit(id: string, retryAfterMs = 60_000): void {
  setRateLimit(id, Date.now() + retryAfterMs);
}
```

- [ ] **Step 2: Verify compilation**

```bash
cd ~/Code/kiro-ccr-auth && npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/lib/accounts.ts && git commit -m "feat: account selection with lowest-usage rotation"
```

---

## Task 7: CCR Custom Transformer

**Files:**
- Create: `~/Code/kiro-ccr-auth/src/transformer.ts`

- [ ] **Step 1: Write the transformer**

Write `~/Code/kiro-ccr-auth/src/transformer.ts`:

```typescript
import { selectAccount, recordSuccess, recordAuthFailure, recordRateLimit } from './lib/accounts.js';
import { getDb } from './lib/db.js';

class KiroAuthTransformer {
  name = 'kiro-auth';
  private lastAccountId: string | null = null;

  constructor(_options: Record<string, unknown>) {
    // Force DB initialization on load
    getDb();
  }

  async transformRequestIn(
    body: Record<string, unknown>,
    provider: { name: string; baseUrl: string; apiKey: string },
    { req }: { req: { provider: string } },
  ): Promise<{ body: Record<string, unknown>; config: { headers: Record<string, string> } }> {
    const pool = req.provider ?? provider.name;

    try {
      const account = await selectAccount(pool);
      this.lastAccountId = account.id;

      // Inject profileArn into request body (CodeWhisperer requires it)
      body.profileArn = account.profile_arn;

      // Increment usage optimistically
      recordSuccess(account.id);

      return {
        body,
        config: {
          headers: {
            Authorization: `Bearer ${account.access_token}`,
          },
        },
      };
    } catch (err) {
      console.error(`[kiro-auth] account selection failed for pool "${pool}": ${err}`);
      throw err;
    }
  }

  async transformResponseIn(
    response: Record<string, unknown>,
    _ctx: unknown,
  ): Promise<Record<string, unknown>> {
    const status = response.status as number | undefined;
    const id = this.lastAccountId;
    if (!id) return response;

    if (status === 429) {
      recordRateLimit(id);
    } else if (status === 401 || status === 403) {
      recordAuthFailure(id);
    }

    return response;
  }
}

// CommonJS export for CCR transformer loader
module.exports = KiroAuthTransformer;
```

- [ ] **Step 2: Verify compilation**

```bash
cd ~/Code/kiro-ccr-auth && npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/transformer.ts && git commit -m "feat: CCR custom transformer for Kiro auth"
```

---

## Task 8: CCR Custom Router

**Files:**
- Create: `~/Code/kiro-ccr-auth/src/custom-router.ts`

- [ ] **Step 1: Write the custom router**

Write `~/Code/kiro-ccr-auth/src/custom-router.ts`:

```typescript
// CCR custom router: parses provider prefix from model name
// e.g., "trackable:claude-sonnet-4-6" routes to "trackable" provider with model "claude-sonnet-4-6"

interface RouterReq {
  body: { model: string; [k: string]: unknown };
  [k: string]: unknown;
}

async function router(req: RouterReq, _config: unknown): Promise<string | null> {
  const model = req.body.model;
  if (!model || !model.includes(':')) return null;

  const colonIdx = model.indexOf(':');
  const provider = model.slice(0, colonIdx);
  const actualModel = model.slice(colonIdx + 1);

  req.body.model = actualModel;
  return `${provider},${actualModel}`;
}

// CommonJS export for CCR
module.exports = router;
```

- [ ] **Step 2: Verify compilation**

```bash
cd ~/Code/kiro-ccr-auth && npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/custom-router.ts && git commit -m "feat: CCR custom router for provider prefix parsing"
```

---

## Task 9: CLI Commands

**Files:**
- Create: `~/Code/kiro-ccr-auth/src/commands/login.ts`
- Create: `~/Code/kiro-ccr-auth/src/commands/status.ts`
- Create: `~/Code/kiro-ccr-auth/src/commands/logout.ts`
- Create: `~/Code/kiro-ccr-auth/src/commands/refresh.ts`
- Create: `~/Code/kiro-ccr-auth/src/cli.ts`

- [ ] **Step 1: Write login command**

Write `~/Code/kiro-ccr-auth/src/commands/login.ts`:

```typescript
import open from 'open';
import { getPool } from '../lib/config.js';
import { registerClient, startDeviceAuth, pollForToken } from '../lib/oidc.js';
import { fetchUsageLimits } from '../lib/usage.js';
import { upsertAccount, getAccountsByPool } from '../lib/db.js';

export async function login(poolName: string): Promise<void> {
  const pool = getPool(poolName);

  console.log(`Registering OIDC client for ${poolName}...`);
  const { clientId, clientSecret } = await registerClient(pool.oidcRegion);

  console.log('Starting device authorization...');
  const device = await startDeviceAuth(pool.oidcRegion, clientId, clientSecret, pool.startUrl);

  const loginUrl = `${pool.startUrl}/#/device?user_code=${device.userCode}`;
  console.log(`\nOpen this URL and authorize:\n  ${loginUrl}\n`);
  console.log(`Code: ${device.userCode}\n`);

  try {
    await open(loginUrl);
    console.log('Browser opened. Waiting for authorization...');
  } catch {
    console.log('Could not open browser. Please open the URL manually.');
  }

  const token = await pollForToken(
    pool.oidcRegion,
    clientId,
    clientSecret,
    device.deviceCode,
    device.interval,
    device.expiresIn,
  );

  console.log('Authorized! Verifying account...');

  const usage = await fetchUsageLimits(token.accessToken, pool.serviceRegion, pool.profileArn);
  console.log(`Account: ${usage.email} (${usage.usedCount}/${usage.limitCount} used)`);

  upsertAccount({
    pool: poolName,
    email: usage.email,
    auth_method: 'idc',
    region: pool.serviceRegion,
    oidc_region: pool.oidcRegion,
    client_id: clientId,
    client_secret: clientSecret,
    profile_arn: pool.profileArn,
    start_url: pool.startUrl,
    access_token: token.accessToken,
    refresh_token: token.refreshToken,
    expires_at: token.expiresAt,
    used_count: usage.usedCount,
    limit_count: usage.limitCount,
  });

  const accounts = getAccountsByPool(poolName);
  console.log(`\nAdded ${usage.email} to ${poolName} pool (${accounts.length} account${accounts.length > 1 ? 's' : ''})`);
}
```

- [ ] **Step 2: Write status command**

Write `~/Code/kiro-ccr-auth/src/commands/status.ts`:

```typescript
import { loadConfig } from '../lib/config.js';
import { getAccountsByPool } from '../lib/db.js';

export function status(): void {
  const config = loadConfig();
  const pools = Object.keys(config.pools);

  if (pools.length === 0) {
    console.log('No pools configured. Edit config.json to add pools.');
    return;
  }

  for (const poolName of pools) {
    const pool = config.pools[poolName];
    const accounts = getAccountsByPool(poolName);
    const arnShort = pool.profileArn.split(':').slice(-1)[0];

    console.log(`${poolName} (${accounts.length} account${accounts.length !== 1 ? 's' : ''})`);
    console.log(`  profileArn: ...${arnShort}`);

    if (accounts.length === 0) {
      console.log('  (no accounts — run: kiro-auth login ' + poolName + ')');
    }

    for (const a of accounts) {
      const healthy = a.is_healthy ? 'healthy' : `UNHEALTHY(${a.fail_count})`;
      const usage = `${a.used_count}/${a.limit_count}`;
      const expiresMs = a.expires_at - Date.now();
      const expiresMin = Math.max(0, Math.round(expiresMs / 60_000));
      const expires = expiresMs > 0 ? `expires in ${expiresMin}m` : 'EXPIRED';
      console.log(`  ${a.email.padEnd(35)} ${healthy.padEnd(15)} ${usage.padEnd(12)} ${expires}`);
    }
    console.log();
  }
}
```

- [ ] **Step 3: Write logout command**

Write `~/Code/kiro-ccr-auth/src/commands/logout.ts`:

```typescript
import { getAccountsByPool, deleteAccount } from '../lib/db.js';
import { getPool } from '../lib/config.js';

export function logout(poolName: string, email?: string): void {
  getPool(poolName); // validate pool exists
  const accounts = getAccountsByPool(poolName);

  if (accounts.length === 0) {
    console.log(`No accounts in pool "${poolName}".`);
    return;
  }

  if (email) {
    const match = accounts.find((a) => a.email === email);
    if (!match) {
      console.log(`No account "${email}" in pool "${poolName}".`);
      console.log('Accounts:', accounts.map((a) => a.email).join(', '));
      return;
    }
    deleteAccount(match.id);
    console.log(`Removed ${email} from ${poolName} pool.`);
    return;
  }

  if (accounts.length === 1) {
    deleteAccount(accounts[0].id);
    console.log(`Removed ${accounts[0].email} from ${poolName} pool.`);
    return;
  }

  console.log(`Multiple accounts in "${poolName}". Specify which to remove:`);
  for (const a of accounts) {
    console.log(`  kiro-auth logout ${poolName} ${a.email}`);
  }
}
```

- [ ] **Step 4: Write refresh command**

Write `~/Code/kiro-ccr-auth/src/commands/refresh.ts`:

```typescript
import { getAccountsByPool, getAllAccounts, updateTokens, updateUsage } from '../lib/db.js';
import { refreshToken } from '../lib/refresh.js';
import { fetchUsageLimits } from '../lib/usage.js';
import { loadConfig } from '../lib/config.js';

export async function refresh(poolName?: string): Promise<void> {
  const accounts = poolName ? getAccountsByPool(poolName) : getAllAccounts();
  const config = loadConfig();

  if (accounts.length === 0) {
    console.log(poolName ? `No accounts in pool "${poolName}".` : 'No accounts.');
    return;
  }

  for (const acct of accounts) {
    process.stdout.write(`${acct.pool}/${acct.email}... `);
    try {
      const result = await refreshToken(acct);
      updateTokens(acct.id, result.accessToken, result.refreshToken, result.expiresAt);

      const pool = config.pools[acct.pool];
      if (pool) {
        try {
          const usage = await fetchUsageLimits(result.accessToken, pool.serviceRegion, pool.profileArn);
          updateUsage(acct.id, usage.usedCount, usage.limitCount);
          console.log(`OK (${usage.usedCount}/${usage.limitCount})`);
        } catch {
          console.log('OK (usage check failed)');
        }
      } else {
        console.log('OK');
      }
    } catch (err) {
      console.log(`FAILED: ${err}`);
    }
  }
}
```

- [ ] **Step 5: Write CLI entry point**

Write `~/Code/kiro-ccr-auth/src/cli.ts`:

```typescript
#!/usr/bin/env node

import arg from 'arg';

const args = arg(
  {
    '--help': Boolean,
    '-h': '--help',
  },
  { permissive: true },
);

const command = args._[0];

async function main() {
  switch (command) {
    case 'login': {
      const pool = args._[1];
      if (!pool) {
        console.error('Usage: kiro-auth login <pool>');
        process.exit(1);
      }
      const { login } = await import('./commands/login.js');
      await login(pool);
      break;
    }

    case 'status': {
      const { status } = await import('./commands/status.js');
      status();
      break;
    }

    case 'logout': {
      const pool = args._[1];
      if (!pool) {
        console.error('Usage: kiro-auth logout <pool> [email]');
        process.exit(1);
      }
      const { logout } = await import('./commands/logout.js');
      logout(pool, args._[2]);
      break;
    }

    case 'refresh': {
      const { refresh } = await import('./commands/refresh.js');
      await refresh(args._[1]);
      break;
    }

    default:
      console.log(`kiro-auth — Kiro multi-account auth for Claude Code Router

Commands:
  login <pool>          Add an account to a pool via browser login
  status                Show all pools and account health
  logout <pool> [email] Remove an account from a pool
  refresh [pool]        Manually refresh tokens`);
      if (command && command !== 'help') {
        console.error(`\nUnknown command: ${command}`);
        process.exit(1);
      }
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
```

- [ ] **Step 6: Build, create symlink, and test**

```bash
cd ~/Code/kiro-ccr-auth && npm run build
chmod +x dist/cli.js
mkdir -p ~/bin
ln -sf ~/Code/kiro-ccr-auth/dist/cli.js ~/bin/kiro-auth
~/bin/kiro-auth --help
```

Expected: help text listing commands.

- [ ] **Step 7: Commit**

```bash
cd ~/Code/kiro-ccr-auth
git add src/commands/ src/cli.ts
git commit -m "feat: CLI with login, status, logout, refresh commands"
```

---

## Task 10: Install Official CCR + Configure

- [ ] **Step 1: Install official CCR**

```bash
npm uninstall -g claude-code-router
npm install -g @musistudio/claude-code-router
ccr --version
```

Expected: 2.0.0

- [ ] **Step 2: Write CCR config**

Write `~/.claude-code-router/config.json`:

```json
{
  "PORT": 3457,
  "CUSTOM_ROUTER_PATH": "/home/ryan/Code/kiro-ccr-auth/dist/custom-router.js",
  "transformers": [
    {
      "path": "/home/ryan/Code/kiro-ccr-auth/dist/transformer.js",
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

- [ ] **Step 3: Test CCR starts**

```bash
ccr start
```

Verify it starts on port 3457. Stop with Ctrl+C.

---

## Task 11: End-to-End Test

- [ ] **Step 1: Create kiro-ccr-auth config.json**

Write `~/Code/kiro-ccr-auth/config.json` (the real one, with actual pool data from the spec).

- [ ] **Step 2: Login to trackable**

```bash
kiro-auth login trackable
```

Follow the browser flow. After success:

```bash
kiro-auth status
```

Should show 1 account in trackable pool.

- [ ] **Step 3: Start CCR and test a request**

Start CCR in background, then send a test request:

```bash
ccr start &
curl -X POST http://127.0.0.1:3457/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: placeholder" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"trackable:claude-sonnet-4-6","max_tokens":50,"messages":[{"role":"user","content":"Say hi in 3 words"}]}'
```

Should return a response from Claude via CodeWhisperer.

- [ ] **Step 4: Verify usage updated**

```bash
kiro-auth status
```

Verify `used_count` incremented for the account used.

---

## Task 12: Orchestrel SessionManager Update

**Files:**
- Modify: `~/Code/orchestrel/.worktrees/claude-agent-sdk/src/server/sessions/manager.ts`

- [ ] **Step 1: Update SessionManager for conditional CCR routing**

In `src/server/sessions/manager.ts`, replace the model string and env construction in the `start()` method:

```typescript
    const isKiroProvider = opts.provider !== 'anthropic';
    const modelStr = isKiroProvider ? `${opts.provider}:${opts.model}` : opts.model;
    const q = query({
      prompt,
      options: {
        model: modelStr,
        cwd,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        settingSources: ['user', 'project'],
        includePartialMessages: true,
        ...(opts.resume ? { resume: opts.resume } : {}),
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? '',
          ...(isKiroProvider ? { ANTHROPIC_BASE_URL: process.env.CCR_URL ?? 'http://127.0.0.1:3457' } : {}),
        },
      },
    });
```

- [ ] **Step 2: Verify compilation**

```bash
cd ~/Code/orchestrel/.worktrees/claude-agent-sdk && npx tsc --noEmit --project tsconfig.json
```

- [ ] **Step 3: Commit**

```bash
cd ~/Code/orchestrel/.worktrees/claude-agent-sdk
git add src/server/sessions/manager.ts
git commit -m "feat: conditional CCR routing — anthropic direct, kiro via CCR"
```

---

## Post-Implementation Notes

**Manual testing checklist:**
- Login multiple accounts to trackable pool (`kiro-auth login trackable` repeated)
- Login okkanti account (`kiro-auth login okkanti`)
- `kiro-auth status` shows both pools correctly
- Start CCR (`ccr start`)
- Start Orchestrel dev server
- Create card with trackable provider, move to running — session starts via CCR
- Create card with anthropic provider, move to running — session goes direct
- `kiro-auth status` after trackable session — usage incremented
- `kiro-auth refresh` — tokens refreshed
- `kiro-auth logout trackable <email>` — account removed

**Known unknowns to verify during implementation:**
1. CCR transformer loading — exact config shape for `transformers[]` may need adjustment based on official CCR source
2. `transformResponseIn` — verify CCR actually calls this on the transformer for response handling
3. `profileArn` injection — verify CodeWhisperer transformer in CCR doesn't overwrite it
4. CCR `req.provider` — verify this field exists on the Fastify request object when `transformRequestIn` is called
