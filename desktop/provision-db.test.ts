// Drift tripwire between the desktop DB provisioner and the backend schema.
// Runs the exact DDL provision-db.cjs executes (DDL_STATEMENTS, the single
// source of truth it requires at runtime) against a TEMP database, then
// asserts via PRAGMA table_info that every table the backend touches on a
// fresh boot has the expected columns. The expected column sets are DERIVED
// from the backend's own TypeORM entity metadata (a second DataSource over
// :memory: with the production entity list), so a new @Column upstream fails
// this test with no hand-maintained list to fall out of sync. That failure is
// the point: it names the column, before the next desktop fresh-install
// silently boots a backend on a schema missing it.
//
// Note: the backend creates its own unique index on cards(session_id) after a
// dedupe check, so the provisioner intentionally omits it; the table_info
// check below covers columns only.
import 'reflect-metadata'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'
import { DataSource } from 'typeorm'
import { test, expect } from 'vitest'
import { Card } from '../src/server/models/Card'
import { Project } from '../src/server/models/Project'
import { User, ProjectUser } from '../src/server/models/User'
import { ApiIdempotency } from '../src/server/models/ApiIdempotency'
import { DDL_STATEMENTS } from './lib/provision-dll'

// Same entity list the production DataSource registers
// (src/server/models/index.ts); the metadata is the column truth.
const ENTITIES = [Card, Project, User, ProjectUser, ApiIdempotency]

async function entityColumns(): Promise<Record<string, string[]>> {
  const ds = new DataSource({
    type: 'better-sqlite3',
    database: ':memory:',
    entities: ENTITIES,
    synchronize: true,
  })
  await ds.initialize()
  try {
    const out: Record<string, string[]> = {}
    for (const m of ds.entityMetadatas) out[m.tableName] = m.columns.map((c) => c.databaseName)
    return out
  } finally {
    await ds.destroy()
  }
}

test('provision DDL columns match the backend entity metadata exactly', async () => {
  const expected = await entityColumns()
  // Columns the hosted schema carries but no current entity declares — the
  // desktop DB must stay at parity with the hosted one, so the DDL keeps
  // creating them. Trim this list as the schema is cleaned up.
  const LEGACY_DDL_ONLY: Record<string, string[]> = {
    cards: ['queue_position', 'pending_prompt', 'pending_files'],
  }
  const dir = mkdtempSync(join(tmpdir(), 'provision-db-test-'))
  const db = new Database(join(dir, 'orchestrel.db'))
  try {
    for (const stmt of DDL_STATEMENTS) db.exec(stmt)
    for (const [table, wanted] of Object.entries(expected)) {
      const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
      const got = rows.map((r) => r.name)
      const missing = wanted.filter((c) => !got.includes(c))
      expect(missing, `table ${table}: entity declares columns the DDL lacks`).toEqual([])
      const legacy = LEGACY_DDL_ONLY[table] ?? []
      const extra = got.filter((c) => !wanted.includes(c) && !legacy.includes(c))
      expect(extra, `table ${table}: DDL has columns the entity does not declare (and are not documented legacy)`).toEqual([])
    }
    // and in the other direction: every table the provisioner creates belongs
    // to an entity — a stray table here would ship unused schema
    const ddlTables = DDL_STATEMENTS.map((s) =>
      /CREATE TABLE (?:IF NOT EXISTS )?(\w+)/.exec(s)?.[1] ?? '',
    )
    expect([...new Set(ddlTables)].sort()).toEqual(Object.keys(expected).sort())
  } finally {
    db.close()
    void rm(dir, { recursive: true, force: true })
  }
})
