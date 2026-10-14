import 'reflect-metadata';
import type { IncomingMessage } from 'http';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { DataSource } from 'typeorm';
import { validateCfAccess } from './auth';
import { Card } from '../models/Card';
import { Project } from '../models/Project';
import { User, ProjectUser } from '../models/User';
import { ApiIdempotency } from '../models/ApiIdempotency';

function requestForHost(host: string): IncomingMessage {
  return { headers: { host } } as IncomingMessage;
}

describe('validateCfAccess', () => {
  it('bypasses Cloudflare Access for 10.x VPN hosts', async () => {
    await expect(validateCfAccess(requestForHost('10.88.0.1:6194'))).resolves.toEqual({
      valid: true,
      isLocal: true,
    });
  });
});

describe('resolveIdentity (desktop loopback)', () => {
  // The env gates are read at different times: resolveIdentity checks
  // ORCHESTREL_DESKTOP at CALL time, but userService reads ADMIN_EMAILS at
  // MODULE load. Both must be set before the dynamic import inside
  // resolveIdentity pulls the user service in, so set them before the
  // first await, not in beforeAll alone.
  const prevDesktop = process.env.ORCHESTREL_DESKTOP;
  const prevAdmin = process.env.ADMIN_EMAILS;
  beforeAll(() => {
    process.env.ORCHESTREL_DESKTOP = '1';
    // The desktop supervisor exports exactly this, keeping the seeded local
    // user at role admin when findOrCreate recomputes roles.
    process.env.ADMIN_EMAILS = 'local@orchestrel.local';
  });
  afterAll(() => {
    if (prevDesktop === undefined) delete process.env.ORCHESTREL_DESKTOP;
    else process.env.ORCHESTREL_DESKTOP = prevDesktop;
    if (prevAdmin === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = prevAdmin;
  });

  let ds: DataSource | undefined;
  beforeAll(async () => {
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Card, Project, User, ProjectUser, ApiIdempotency],
      synchronize: true,
    });
    await ds.initialize();
  });
  afterAll(async () => {
    await ds?.destroy();
  });

  it('returns the seeded local user (id > 0, admin) for loopback on desktop', async () => {
    const { resolveIdentity } = await import('./auth');
    const identity = await resolveIdentity(requestForHost('127.0.0.1:6194'));
    expect(identity).not.toBeNull();
    expect(identity!.email).toBe('local@orchestrel.local');
    // id 0 is the synthetic LOCAL_ADMIN; the whole point of the desktop
    // branch is a REAL row the maintainers can group prompts by.
    expect(identity!.id).toBeGreaterThan(0);
    expect(identity!.role).toBe('admin');
    const row = await User.findOneBy({ email: 'local@orchestrel.local' });
    expect(row?.role).toBe('admin');
  });

  it('demotes nothing when re-resolved (role is sticky-admin under ADMIN_EMAILS)', async () => {
    const { resolveIdentity } = await import('./auth');
    const again = await resolveIdentity(requestForHost('127.0.0.1:6194'));
    expect(again!.role).toBe('admin');
  });

  it('falls back to LOCAL_ADMIN when ORCHESTREL_DESKTOP is unset (hosted behavior unchanged)', async () => {
    const { resolveIdentity } = await import('./auth');
    process.env.ORCHESTREL_DESKTOP = '';
    try {
      const identity = await resolveIdentity(requestForHost('127.0.0.1:6194'));
      expect(identity).toEqual({ id: 0, email: 'local', role: 'admin' });
    } finally {
      process.env.ORCHESTREL_DESKTOP = '1';
    }
  });
});
