import 'reflect-metadata';
import { describe, it, expect, afterAll } from 'vitest';
import { DataSource } from 'typeorm';
import { Card, CardSubscriber } from './Card';
import { Project, ProjectSubscriber } from './Project';
import { User, ProjectUser } from './User';
import { ApiIdempotency } from './ApiIdempotency';
import { seedLocalUser } from './index';

const ENTITIES = [Card, Project, User, ProjectUser, ApiIdempotency];
const SUBSCRIBERS = [CardSubscriber, ProjectSubscriber];

/**
 * Creates a temp DataSource mirroring the real one (synchronize creates all
 * tables) and replays only the DDL initDatabase runs afterward — the
 * users/project_users/api_idempotency CREATE statements. With synchronize,
 * those tables already exist, so CREATE IF NOT EXISTS is a no-op; what matters
 * is the same table shape the production path produces.
 */
async function freshDb(): Promise<DataSource> {
  const ds = new DataSource({
    type: 'better-sqlite3',
    database: ':memory:',
    entities: ENTITIES,
    subscribers: SUBSCRIBERS,
    synchronize: true,
  });
  await ds.initialize();
  return ds;
}

describe('seedLocalUser (called by initDatabase)', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterAll(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  it('seeds a local admin user when users table is empty', async () => {
    const ds = await freshDb();
    cleanups.push(() => ds.destroy());
    expect(await ds.getRepository(User).find()).toHaveLength(0);

    await seedLocalUser(ds);

    const users = await ds.getRepository(User).find();
    expect(users).toHaveLength(1);
    expect(users[0].email).toBe('local@orchestrel.local');
    expect(users[0].role).toBe('admin');
    expect(users[0].createdAt).toBeTruthy();
  });

  it('leaves existing users untouched (hosted deployment, non-empty table)', async () => {
    const ds = await freshDb();
    cleanups.push(() => ds.destroy());

    const existing = ds.getRepository(User).create({
      email: 'someone@example.com',
      role: 'user',
      createdAt: new Date(0).toISOString(),
    });
    await existing.save();

    await seedLocalUser(ds);

    const users = await ds.getRepository(User).find();
    expect(users).toHaveLength(1);
    expect(users[0].email).toBe('someone@example.com');
    expect(users[0].role).toBe('user');
  });

  it('is idempotent: does not re-seed when the local user already exists', async () => {
    const ds = await freshDb();
    cleanups.push(() => ds.destroy());

    await seedLocalUser(ds);
    await seedLocalUser(ds);

    expect(await ds.getRepository(User).find()).toHaveLength(1);
  });
});
