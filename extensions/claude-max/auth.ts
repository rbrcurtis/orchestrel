/* oxlint-disable orchestrel/log-before-early-return -- pure OAuth creds helper, guard returns without session context */
/*
 * Claude Max OAuth block for the Pi claude-max provider extension.
 *
 * orcd is a daemon, so login() must be headless — it can't run Pi's interactive
 * `/login` browser flow. Instead we read the OAuth token Claude Code already
 * stored on this box (`~/.claude/.credentials.json`) — the same source `claude`
 * itself uses — and refresh it directly against the OAuth endpoint, writing
 * rotated tokens back atomically so Claude Code and orcd stay in sync.
 * Adapted from src/orcd/claude-code-auth.ts.
 */
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { OAuthCredentials, OAuthLoginCallbacks } from '@earendil-works/pi-ai';

const CREDENTIALS_PATH = join(homedir(), '.claude', '.credentials.json');
const TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const REFRESH_SKEW_MS = 60_000;

export function readClaudeCreds(): OAuthCredentials {
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
  // Atomic write so a concurrent reader (claude itself) never sees a torn file.
  const tmp = `${CREDENTIALS_PATH}.orcd.tmp`;
  writeFileSync(tmp, JSON.stringify(merged, null, 2), { mode: 0o600 });
  renameSync(tmp, CREDENTIALS_PATH);
}

export const claudeMaxOAuth = {
  name: 'Claude Max',
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
} satisfies NonNullable<import('@earendil-works/pi-coding-agent').ProviderConfig['oauth']>;

let inflight: Promise<OAuthCredentials> | null = null;

// Optional remote token source. When set (e.g. on a secondary instance that
// must run through someone else's subscription), getAccessToken fetches the
// access token from a token server that solely owns the OAuth refresh, instead
// of reading/refreshing ~/.claude itself — so this instance never rotates (and
// thus never invalidates) the shared refresh token. Unset = local path.
const TOKEN_SERVER_URL = process.env.CLAUDE_MAX_TOKEN_URL;
const TOKEN_SERVER_SECRET = process.env.CLAUDE_MAX_TOKEN_SECRET;

async function fetchTokenFromServer(): Promise<string> {
  const url = `${TOKEN_SERVER_URL!.replace(/\/$/, '')}/token`;
  const res = await fetch(url, {
    headers: TOKEN_SERVER_SECRET ? { authorization: `Bearer ${TOKEN_SERVER_SECRET}` } : {},
  });
  if (!res.ok) throw new Error(`claude-max token server ${res.status} ${(await res.text()).slice(0, 120)}`);
  const data = (await res.json()) as { access?: string };
  if (!data.access) throw new Error('claude-max token server returned no access token');
  return data.access;
}

/**
 * Return a valid Claude Max OAuth access token. With CLAUDE_MAX_TOKEN_URL set,
 * fetch it from the token server (which owns refresh). Otherwise source it fresh
 * from ~/.claude/.credentials.json and refresh on near-expiry. Pi's AuthStorage
 * only auto-refreshes its own auth.json, never ~/.claude, so the stream sources
 * its token here instead of trusting options.apiKey. Single-flight dedupes
 * concurrent refreshes so we make at most one token request at a time.
 */
export async function getAccessToken(): Promise<string> {
  if (TOKEN_SERVER_URL) return fetchTokenFromServer();

  const creds = readClaudeCreds();
  if (creds.expires - Date.now() > REFRESH_SKEW_MS) return creds.access;

  if (!inflight) {
    inflight = claudeMaxOAuth.refreshToken(creds).finally(() => {
      inflight = null;
    });
  }
  return (await inflight).access;
}
