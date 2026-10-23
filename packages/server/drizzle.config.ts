import { defineConfig } from 'drizzle-kit';

// Only used by `db:generate`, which diffs the schema against earlier migrations; it never
// connects to a database (so it can't touch a real one, unlike shadow-database tools).
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
});
