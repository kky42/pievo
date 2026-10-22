import { defineConfig } from "drizzle-kit";

// Only `db:generate` is used: it diffs the schema into SQL without a database.
// The embedded PGlite database applies migrations in-process at boot.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
});
