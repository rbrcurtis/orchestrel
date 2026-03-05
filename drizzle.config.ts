import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  out: './drizzle',
  schema: './src/server/db/schema.ts',
  dialect: 'sqlite',
  dbCredentials: { url: './data/conductor.db' },
});
