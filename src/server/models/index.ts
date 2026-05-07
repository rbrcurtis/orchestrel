import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { join } from 'path';
import { mkdirSync } from 'fs';
import { Card, CardSubscriber } from './Card';
import { Project, ProjectSubscriber } from './Project';
import { User, ProjectUser } from './User';

const DB_DIR = join(process.cwd(), 'data');
mkdirSync(DB_DIR, { recursive: true });

export const AppDataSource = new DataSource({
  type: 'better-sqlite3',
  database: join(DB_DIR, 'orchestrel.db'),
  entities: [Card, Project, User, ProjectUser],
  subscribers: [CardSubscriber, ProjectSubscriber],
  synchronize: false,
});

/** Map old CSS token names to hex values */
const TOKEN_TO_HEX: Record<string, string> = {
  'neon-cyan': '#00f0ff',
  'neon-magenta': '#ff00aa',
  'neon-violet': '#bf5af2',
  'neon-amber': '#ffb800',
  'neon-lime': '#39ff14',
  'neon-coral': '#ff6b6b',
  'neon-electric': '#4d4dff',
  'neon-plasma': '#ff5e00',
  'neon-ice': '#a0f0ff',
  'neon-rose': '#ff3d8a',
  'neon-teal': '#00e5bf',
  'neon-gold': '#ffd700',
  'neon-indigo': '#7b61ff',
  'neon-acid': '#ccff00',
  'neon-crimson': '#dc143c',
  'neon-sky': '#00c8ff',
};

export async function initDatabase(): Promise<void> {
  if (!AppDataSource.isInitialized) {
    await AppDataSource.initialize();
    console.log('[db] TypeORM DataSource initialized');

    // One-time migration: convert token color names to hex values
    const runner = AppDataSource.createQueryRunner();
    for (const [token, hex] of Object.entries(TOKEN_TO_HEX)) {
      await runner.query(`UPDATE projects SET color = ? WHERE color = ?`, [hex, token]);
    }
    // Fill any nulls with default
    await runner.query(`UPDATE projects SET color = '#00f0ff' WHERE color IS NULL OR color = ''`);
    // Create users and project_users tables if they don't exist
    await runner.query(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL UNIQUE,
        role TEXT NOT NULL DEFAULT 'user',
        created_at TEXT NOT NULL
      )
    `);
    await runner.query(`
      CREATE TABLE IF NOT EXISTS project_users (
        project_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        PRIMARY KEY (project_id, user_id),
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);
    // Add memory server columns to projects (per-project memory API config)
    try {
      await runner.query(`ALTER TABLE projects ADD COLUMN memory_base_url TEXT`);
      await runner.query(`ALTER TABLE projects ADD COLUMN memory_api_key TEXT`);
    } catch (err) {
      console.log(`[db:migrate] memory_* column add skipped (likely already exists):`, err instanceof Error ? err.message : err);
    }
    try {
      await runner.query(`ALTER TABLE projects ADD COLUMN archived INTEGER NOT NULL DEFAULT 0`);
    } catch (err) {
      console.log(`[db:migrate] archived column add skipped (likely already exists):`, err instanceof Error ? err.message : err);
    }
    await runner.query(`UPDATE projects SET archived = 0 WHERE archived IS NULL`);
    await runner.release();
  }
}
