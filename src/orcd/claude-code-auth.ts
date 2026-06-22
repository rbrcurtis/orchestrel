/* oxlint-disable orchestrel/log-before-early-return -- pure OAuth creds helper, guard returns without session context */
/*
 * Claude Max OAuth credentials for the reshaped Anthropic provider.
 *
 * orcd is a daemon, so we can't use Pi's interactive `/login anthropic` browser
 * flow. Instead we read the OAuth token Claude Code already stored on this box
 * (`~/.claude/.credentials.json`) — the same source `claude` itself uses — and
 * refresh it directly against the OAuth endpoint when it nears expiry, writing
 * rotated tokens back so Claude Code and orcd stay in sync. Adapted from
 * cgaravitoq/pi-claude-code-auth + griffinmartin/opencode-claude-auth (MIT).
 */
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CREDENTIALS_PATH = join(homedir(), '.claude', '.credentials.json');
const TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const REFRESH_SKEW_MS = 60_000;

interface OAuthCreds {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

let inflightRefresh: Promise<OAuthCreds> | null = null;

function readCredsFile(): { raw: Record<string, unknown>; oauth: OAuthCreds } {
  const raw = JSON.parse(readFileSync(CREDENTIALS_PATH, 'utf8')) as Record<string, unknown>;
  const o = raw.claudeAiOauth as Record<string, unknown> | undefined;
  const accessToken = o?.accessToken;
  const refreshToken = o?.refreshToken;
  const expiresAt = o?.expiresAt;
  if (typeof accessToken !== 'string' || typeof refreshToken !== 'string' || typeof expiresAt !== 'number') {
    throw new Error(`Claude Max OAuth credentials missing/invalid at ${CREDENTIALS_PATH}. Run \`claude\` to log in.`);
  }
  return { raw, oauth: { accessToken, refreshToken, expiresAt } };
}

function writeCredsFile(raw: Record<string, unknown>, oauth: OAuthCreds): void {
  const prev = (raw.claudeAiOauth as Record<string, unknown>) ?? {};
  const next = {
    ...raw,
    claudeAiOauth: {
      ...prev,
      accessToken: oauth.accessToken,
      refreshToken: oauth.refreshToken,
      expiresAt: oauth.expiresAt,
    },
  };
  // Atomic write so a concurrent reader (claude itself) never sees a torn file.
  const tmp = `${CREDENTIALS_PATH}.orcd.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  renameSync(tmp, CREDENTIALS_PATH);
}

async function refreshCreds(current: OAuthCreds, raw: Record<string, unknown>): Promise<OAuthCreds> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      refresh_token: current.refreshToken,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Claude Max OAuth refresh failed: ${res.status} ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number };
  const next: OAuthCreds = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || current.refreshToken,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  writeCredsFile(raw, next);
  return next;
}

/** Return a valid Claude Max OAuth access token, refreshing if near expiry. */
export async function getClaudeMaxAccessToken(): Promise<string> {
  const { raw, oauth } = readCredsFile();
  if (oauth.expiresAt - Date.now() > REFRESH_SKEW_MS) return oauth.accessToken;

  if (!inflightRefresh) {
    inflightRefresh = refreshCreds(oauth, raw).finally(() => {
      inflightRefresh = null;
    });
  }
  const refreshed = await inflightRefresh;
  return refreshed.accessToken;
}
