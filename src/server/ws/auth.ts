import type { IncomingMessage } from 'http';
import { createRemoteJWKSet, jwtVerify } from 'jose';

const CF_TEAM_DOMAIN = process.env.CF_TEAM_DOMAIN ?? '';
const CERTS_URL = `https://${CF_TEAM_DOMAIN}.cloudflareaccess.com/cdn-cgi/access/certs`;

// jose caches JWK set and handles rotation automatically
const jwks = CF_TEAM_DOMAIN ? createRemoteJWKSet(new URL(CERTS_URL)) : null;

/**
 * Check whether a request originates from localhost or the LAN.
 * These bypass CF Access auth since they never traverse the tunnel.
 */
function isLocalRequest(req: IncomingMessage): boolean {
  const host = req.headers.host ?? '';
  // Direct localhost or LAN IP access — no CF tunnel involved
  if (host.startsWith('localhost') || host.startsWith('127.') || host.startsWith('192.168.')) {
    return true;
  }
  return false;
}

/**
 * Validate Cloudflare Access JWT from the CF_Authorization cookie.
 * Uses jose for full cryptographic signature verification.
 * In dev mode or on localhost/LAN, skip validation.
 */
export async function validateCfAccess(req: IncomingMessage): Promise<boolean> {
  if (process.env.NODE_ENV === 'development') return true;

  // Localhost/LAN connections bypass CF Access (they don't go through the tunnel)
  if (isLocalRequest(req)) return true;

  if (!jwks) {
    console.log('[ws:auth] no jwks configured, rejecting');
    return false;
  }

  const cookie = req.headers.cookie ?? '';
  const match = cookie.match(/CF_Authorization=([^;]+)/);
  if (!match) {
    console.log(
      '[ws:auth] no CF_Authorization cookie found. host=%s, cookies=%s',
      req.headers.host,
      cookie ? cookie.substring(0, 80) + '...' : '(none)',
    );
    return false;
  }

  try {
    await jwtVerify(match[1], jwks, {
      issuer: `https://${CF_TEAM_DOMAIN}.cloudflareaccess.com`,
    });
    return true;
  } catch (err) {
    console.log('[ws:auth] JWT verify failed:', err instanceof Error ? err.message : err);
    return false;
  }
}
