/*
 * Claude Max token server.
 *
 * Sole owner of the Claude Max OAuth refresh for this box. It proactively keeps
 * ~/.claude/.credentials.json fresh on a timer (renewal is time-driven, not
 * usage-driven, so an idle subscription never lapses) and exposes the current
 * access token over localhost to secondary instances (e.g. Cecil) whose
 * claude-max extension is pointed here via CLAUDE_MAX_TOKEN_URL. Because only
 * this process refreshes, the rotating refresh token never races.
 *
 * Run as the user who owns the Claude Max login (reads/writes ~/.claude).
 * Env: CLAUDE_MAX_TOKEN_PORT (default 8126), CLAUDE_MAX_TOKEN_SECRET (shared
 * bearer secret; required in practice), CLAUDE_MAX_TOKEN_HOST (default 127.0.0.1).
 */
import { createServer } from 'node:http';
import { claudeMaxOAuth, readClaudeCreds } from './auth';

const PORT = Number(process.env.CLAUDE_MAX_TOKEN_PORT ?? 8126);
const HOST = process.env.CLAUDE_MAX_TOKEN_HOST ?? '127.0.0.1';
const SECRET = process.env.CLAUDE_MAX_TOKEN_SECRET ?? '';
// Refresh this far before expiry so a consumer never receives a stale token.
const MARGIN_MS = 5 * 60_000;
const TICK_MS = 60_000;

let current: { access: string; expires: number } | null = null;
let refreshing: Promise<void> | null = null;

async function ensureFresh(): Promise<void> {
  let creds = readClaudeCreds();
  if (creds.expires - Date.now() <= MARGIN_MS) {
    creds = await claudeMaxOAuth.refreshToken(creds); // rotates + writes ~/.claude atomically
    const mins = Math.round((creds.expires - Date.now()) / 60_000);
    console.log(`[token-server] refreshed; expires in ${mins}m`);
  }
  current = { access: creds.access, expires: creds.expires };
}

function tick(): Promise<void> {
  if (!refreshing) {
    refreshing = ensureFresh()
      .catch((e) => console.error('[token-server] refresh error:', e instanceof Error ? e.message : e))
      .finally(() => {
        refreshing = null;
      });
  }
  return refreshing;
}

const server = createServer((req, res) => {
  if (req.method !== 'GET' || req.url !== '/token') {
    res.writeHead(404);
    res.end();
    return;
  }
  if (SECRET && req.headers.authorization !== `Bearer ${SECRET}`) {
    res.writeHead(401);
    res.end();
    return;
  }
  void (async () => {
    try {
      if (!current || current.expires - Date.now() <= MARGIN_MS) await tick();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ access: current?.access ?? '' }));
    } catch (e) {
      res.writeHead(502);
      res.end(String(e instanceof Error ? e.message : e));
    }
  })();
});

tick()
  .then(() => {
    setInterval(() => void tick(), TICK_MS);
    server.listen(PORT, HOST, () => console.log(`[token-server] listening on ${HOST}:${PORT}`));
  })
  .catch((e) => {
    console.error('[token-server] failed initial token load:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
