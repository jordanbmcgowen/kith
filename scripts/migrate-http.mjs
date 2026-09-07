/**
 * Applies pending drizzle migrations over Neon's HTTPS driver.
 *
 * `npm run db:migrate` (drizzle-kit) opens a raw Postgres connection, which
 * some environments block; the remote Claude Code session is one. This does
 * the same job over HTTPS: same journal table (drizzle.__drizzle_migrations),
 * same hashes, so the two can be used interchangeably. Reads DIRECT_URL, as
 * migrations should.
 *
 *   npm run db:migrate:http            dry run: lists what is applied and what is pending
 *   npm run db:migrate:http -- --apply applies the pending migrations in ./drizzle
 */
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { migrate } from "drizzle-orm/neon-http/migrator";
import { readFileSync } from "node:fs";

const url = process.env.DIRECT_URL?.trim();
if (!url) { console.error("DIRECT_URL is not set. It is the direct (non-pooled) Neon string."); process.exit(1); }
if (url.includes("-pooler")) { console.error("DIRECT_URL points at the pooled host. Use the direct one."); process.exit(1); }

const sql = neon(url);
const journal = JSON.parse(readFileSync(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
const applied = async () => sql.query("select id, created_at from drizzle.__drizzle_migrations order by created_at").catch(() => []);

const before = await applied();
const pending = journal.entries.filter((e) => !before.some((r) => Number(r.created_at) === e.when));
console.log(`applied: ${before.length}   pending: ${pending.map((e) => e.tag).join(", ") || "none"}`);

if (process.argv.includes("--apply")) {
  if (!pending.length) process.exit(0);
  await migrate(drizzle(sql), { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });
  const after = await applied();
  console.log(`applied now: ${after.length}`);
}
