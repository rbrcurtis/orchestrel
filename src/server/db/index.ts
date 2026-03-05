import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';
import { join } from 'path';
import { mkdirSync } from 'fs';

const DB_DIR = join(process.cwd(), 'data');
mkdirSync(DB_DIR, { recursive: true });

const sqlite = new Database(join(DB_DIR, 'conductor.db'));
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');

export const db = drizzle({ client: sqlite, schema });
