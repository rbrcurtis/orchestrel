// Minimal structural typing for the desktop test's direct better-sqlite3
// import (the provisioner itself runs in a bundled-node child and is untyped
// CJS). Only the surface provision-db.test.ts uses; the module ships no types
// of its own in this package's install.
declare module 'better-sqlite3' {
  interface Statement {
    all(...params: unknown[]): unknown[]
    run(...params: unknown[]): { changes: number }
  }
  class Database {
    constructor(path: string)
    exec(sql: string): this
    prepare(sql: string): Statement
    close(): void
  }
  namespace Database {
    type Instance = Database
  }
  export default Database
}
