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

const APACHE_USER_EMAILS = new Map(
  (process.env.APACHE_USER_EMAILS ?? '')
    .split(',')
    .map((entry) => entry.trim().split('=', 2))
    .filter((entry): entry is [string, string] => entry.length === 2 && Boolean(entry[0]) && Boolean(entry[1]))
    .map(([user, email]) => [user.toLowerCase(), email.toLowerCase()]),
);

function apacheUser(req: IncomingMessage): string | undefined {
  const address = req.socket?.remoteAddress ?? '';
  const isLoopback = address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
  const value = isLoopback ? req.headers['x-orchestrel-user'] : undefined;
  return typeof value === 'string' && value ? value.toLowerCase() : undefined;
}

function isLocalRequest(req: IncomingMessage): boolean {
  const host = req.headers.host ?? '';
  const hostname = host.startsWith('[')
    ? host.slice(1, host.indexOf(']') === -1 ? undefined : host.indexOf(']'))
    : host.split(':')[0];
  const isPrivate172 = /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname);

  if (
    hostname === 'localhost' ||
    hostname === '::1' ||
    hostname.startsWith('127.') ||
    hostname.startsWith('10.') ||
    hostname.startsWith('192.168.') ||
    isPrivate172
  ) {
    console.log(`[ws:auth] isLocalRequest: host=${host} matched local range`);
    return true;
  }
  return false;
}

export async function validateCfAccess(req: IncomingMessage): Promise<AuthResult> {
  const user = apacheUser(req);
  if (user) {
    const email = APACHE_USER_EMAILS.get(user);
    if (!email) {
      console.warn(`[ws:auth] Apache user has no email mapping: ${user}`);
      return { valid: false, isLocal: false };
    }
    console.log(`[ws:auth] Apache identity valid for ${email}`);
    return { valid: true, email, isLocal: false };
  }

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

/** Socket.IO middleware — validates the upstream identity and attaches it to socket.data */
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
