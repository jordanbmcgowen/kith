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
const url = process.env.DIRECT_URL ?? "";

// The mistake this file exists to catch. A pooled host here means `migrate`
// hangs on an advisory lock PgBouncer will never grant.
if (url.includes("-pooler")) {
  throw new Error(
    "DIRECT_URL points at Neon's POOLED host. Migrations need the direct one, " +
      "whose host has no `-pooler`. See docs/SETUP.md step 2.",
  );
}

// `generate` only reads schema.ts and never connects, so it is allowed to run
// with no credentials at all. `migrate` connects, and says so plainly.
if (!url && process.argv.some((a) => a.includes("migrate") || a.includes("push") || a.includes("studio"))) {
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
