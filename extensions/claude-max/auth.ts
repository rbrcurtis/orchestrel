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
