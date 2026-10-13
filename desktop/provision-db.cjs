// One-shot DB base-table provisioner, run by the Electron main process in a
// short-lived child of the BUNDLED node (out/node/node) — not Electron's
// node, so the bundled better-sqlite3 ABI loads correctly. Usage:
//   node provision-db.cjs <dbPath>
// Creates the base tables (IF NOT EXISTS) before the backend boots: the
// backend opens the DB with synchronize:false and only ALTERs/adds columns,
// so the base tables must already exist on a fresh install. The DDL mirrors
// the FULL post-initDatabase column set from src/server/models (entities +
// the ALTER chain in initDatabase in index.ts) — including users,
// project_users and api_idempotency, which initDatabase would otherwise
// create in-process. The unique index on cards(session_id) is intentionally
// absent — the backend creates it after its own dedupe check.
//
// SYNC OBLIGATION: when src/server/models gains a column (new @Column or new
// ALTER in initDatabase), the DDL in lib/provision-dll.ts (single source of
// truth, imported below via esbuild-bundled copy) must be updated in the same
// change; desktop/provision-db.test.ts is the drift tripwire.
'use strict'
const path = require('node:path')
const dbPath = process.argv[2]
if (!dbPath) {
  console.error('usage: node provision-db.cjs <dbPath>')
  process.exit(2)
}
const Database = require(path.join(__dirname, 'node_modules', 'better-sqlite3'))
const db = new Database(dbPath)
// Single source of truth for the DDL: provision-dll-bundle.cjs is generated
// from lib/provision-dll.ts by build-main.mjs (esbuild, iife) and copied to
// out/ beside this file. Never hand-edit the SQL here.
const { DDL_STATEMENTS } = require(path.join(__dirname, 'provision-dll-bundle.cjs'))
for (const stmt of DDL_STATEMENTS) {
  db.exec(stmt)
}
db.close()
