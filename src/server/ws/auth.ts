import type { IncomingMessage } from 'http';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Socket } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents, SocketData } from '../../shared/ws-protocol';

const CF_TEAM_DOMAIN = process.env.CF_TEAM_DOMAIN ?? '';
const CERTS_URL = `https://${CF_TEAM_DOMAIN}.cloudflareaccess.com/cdn-cgi/access/certs`;

const jwks = CF_TEAM_DOMAIN ? createRemoteJWKSet(new URL(CERTS_URL)) : null;

export interface AuthResult {
  valid: boolean;
  email?: string;
  isLocal: boolean;
}

function isLocalRequest(req: IncomingMessage): boolean {
  const host = req.headers.host ?? '';
  if (host.startsWith('localhost') || host.startsWith('127.') || host.startsWith('192.168.')) {
    console.log(`[ws:auth] isLocalRequest: host=${host} matched local range`);
    return true;
  }
  return false;
}

export async function validateCfAccess(req: IncomingMessage): Promise<AuthResult> {
  if (isLocalRequest(req)) {
    console.log(`[ws:auth] validateCfAccess: local request, bypassing CF Access`);
    return { valid: true, isLocal: true };
  }

  if (!jwks) {
    console.log('[ws:auth] no jwks configured, rejecting');
    return { valid: false, isLocal: false };
  }

  const cookie = req.headers.cookie ?? '';
  const match = cookie.match(/CF_Authorization=([^;]+)/);
  if (!match) {
    console.log(
      '[ws:auth] no CF_Authorization cookie found. host=%s, cookies=%s',
      req.headers.host,
      cookie ? cookie.substring(0, 80) + '...' : '(none)',
    );
    return { valid: false, isLocal: false };
  }

  try {
    const { payload } = await jwtVerify(match[1], jwks, {
      issuer: `https://${CF_TEAM_DOMAIN}.cloudflareaccess.com`,
    });
    const email = typeof payload.email === 'string' ? payload.email : undefined;
    console.log(`[ws:auth] validateCfAccess: JWT valid for ${email ?? '(no email)'}`);
    return { valid: true, email, isLocal: false };
  } catch (err) {
    console.log('[ws:auth] JWT verify failed:', err instanceof Error ? err.message : err);
    return { valid: false, isLocal: false };
  }
}

type AppSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

/** Socket.IO middleware — validates CF Access JWT and attaches user identity to socket.data */
export async function socketAuthMiddleware(
  socket: AppSocket,
  next: (err?: Error) => void,
): Promise<void> {
  try {
    const req = socket.request;
    const auth = await validateCfAccess(req);
    if (!auth.valid) {
      console.warn(`[ws:auth] socket connect rejected: Unauthorized (host=${socket.request.headers.host})`);
      next(new Error('Unauthorized'));
      return;
    }
    const { userService, LOCAL_ADMIN } = await import('../services/user');
    const identity = auth.isLocal || !auth.email ? LOCAL_ADMIN : await userService.findOrCreate(auth.email);
    socket.data.identity = { id: identity.id, email: identity.email, role: identity.role };
    console.log(`[ws] auth: ${identity.email} (${identity.role})`);
    next();
  } catch (err) {
    console.error(`[ws:auth] socketAuthMiddleware error:`, err);
    next(new Error(err instanceof Error ? err.message : 'Auth failed'));
  }
}
