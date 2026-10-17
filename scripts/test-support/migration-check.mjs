// Exercise the actual migration and roll back this entire synthetic check.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const pg = require(process.env.KITH_LOCAL_PG_MODULE ?? '/workspace/kith-local/node_modules/pg/lib/index.js');
const url = new URL(process.env.DATABASE_URL ?? '');
assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.port, '5543'); assert.equal(url.pathname, '/kith_test');
const client = new pg.Client({ connectionString: url.href });
await client.connect();
try {
  const { rows } = await client.query("select id from users where email = 'fixture@example.invalid'");
  assert.equal(rows.length, 1);
  await client.query('BEGIN');
  await client.query('DROP TABLE capture_jobs');
  const active = crypto.randomUUID(), filed = crypto.randomUUID();
  await client.query("insert into captures (id, user_id, kind, status, raw_text, captured_at) values ($1, $2, 'text', 'extracting', 'SYNTHETIC MIGRATION', now()), ($3, $2, 'text', 'filed', 'SYNTHETIC MIGRATION', now())", [active, rows[0].id, filed]);
  await client.query(await readFile(new URL('../../drizzle/0004_capture_jobs.sql', import.meta.url), 'utf8'));
  const jobs = await client.query('select * from capture_jobs where capture_id in ($1, $2)', [active, filed]);
  assert.equal(jobs.rows.length, 1);
  assert.equal(jobs.rows[0].capture_id, active); assert.equal(jobs.rows[0].request_key, active); assert.equal(jobs.rows[0].review, true);
  await client.query('SAVEPOINT invalid_lease');
  await assert.rejects(client.query('update capture_jobs set lease_token = $1 where capture_id = $2', [crypto.randomUUID(), active]), err => err.code === '23514');
  await client.query('ROLLBACK TO SAVEPOINT invalid_lease');
  await client.query('SAVEPOINT duplicate_job');
  await assert.rejects(client.query("insert into capture_jobs (user_id, request_key, capture_id, request_hash) values ($1, $2, $3, 'duplicate')", [rows[0].id, crypto.randomUUID(), active]), err => err.code === '23505');
  await client.query('ROLLBACK TO SAVEPOINT duplicate_job');
  console.log('PASS migration backfill, filed-note exclusion, lease pair constraint and one unfinished job per capture');
} finally {
  await client.query('ROLLBACK');
  await client.end();
}
