import type { Config } from "drizzle-kit";

/**
 * Migrations run against the DIRECT connection, not the pooled one.
 *
 * Neon's pooled host (the one containing `-pooler`) is PgBouncer in
 * transaction pooling mode, which does not support session level advisory
 * locks. `drizzle-kit migrate` takes one so two migrations cannot run at
 * once, so pointing it at the pooler makes it hang or fail with a lock error
 * that does not explain itself.
 *
 * DATABASE_URL stays pooled, because the serverless driver needs the pooler
 * at runtime. See docs/SETUP.md step 2.
 */
const url = process.env.DIRECT_URL;
if (!url) {
  throw new Error(
    "DIRECT_URL is not set. Migrations need Neon's DIRECT connection string " +
      "(the host WITHOUT `-pooler`), not the pooled DATABASE_URL. See docs/SETUP.md step 2.",
  );
}

export default {
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url },
} satisfies Config;
