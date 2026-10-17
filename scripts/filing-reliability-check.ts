/**
 * Synthetic local PostgreSQL only. The environment's start-db.sh initializes
 * existing migrations in its dedicated pgvector container; bridge.mjs exposes
 * the existing HTTP queries on loopback. Models are stubbed, Pool uses local pg.
 *
 * source /workspace/kith-local/environment.sh
 * bash /workspace/kith-local/start-db.sh
 * node /workspace/kith-local/bridge.mjs  # separate terminal, if not running
 * ./node_modules/.bin/esbuild scripts/filing-reliability-check.ts --bundle --platform=node --format=esm --alias:@neondatabase/serverless=./scripts/test-support/neon-local.mjs --outfile=/tmp/kith-reliability.mjs
 * node /tmp/kith-reliability.mjs
 * Use the same bundle command for scripts/pipeline-check.ts and run it locally.
 * The adapter substitutes pg TCP for Neon WebSockets; runtime WebSocket behavior
 * is not covered. No .env file is loaded by these commands.
 */
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { db, filingTransaction, users, captures, people, facts, interactions, threads, looseThreads, personPlaces, places, type ExtractionResult } from "../src/db";
import { fileCapture, defaultDecisions } from "../src/lib/filing";

const url = new URL(process.env.DATABASE_URL ?? "");
assert.equal(url.hostname, "127.0.0.1");
assert.equal(url.port, "5543");
assert.equal(url.pathname, "/kith_test");
const d = db();
const [user] = await d.insert(users).values({ email: `filing-${crypto.randomUUID()}@example.invalid` }).returning();
const [foreign] = await d.insert(users).values({ email: `foreign-${crypto.randomUUID()}@example.invalid` }).returning();
const vector = Array(1536).fill(0); vector[0] = 1;
const x: ExtractionResult = {
  people: [{ name: "Synthetic Person", isNew: true, matchedPersonId: null, confidence: 1, tags: ["Group"] }],
  facts: [{ personName: "Synthetic Person", kind: "identity", content: "Synthetic fact", confidence: 1 }],
  interactions: [{ personName: "Synthetic Person", summary: "Synthetic meeting", occurredAt: "2026-10-01T12:00:00Z", channel: "in_person" }],
  threads: [{ personName: "Synthetic Person", title: "Synthetic follow-up", dueAt: null }],
  closesThreadIds: [], unresolved: ["Synthetic loose"], place: null,
};
const [capture] = await d.insert(captures).values({ userId: user.id, kind: "text", rawText: "immutable synthetic note", status: "needs_review", capturedAt: new Date(), extraction: x }).returning();
const run = (embed: (texts: string[]) => Promise<number[][]>, decisions?: ReturnType<typeof defaultDecisions>) => fileCapture({ userId: user.id, captureId: capture.id, by: "user", embed, decisions });
const embed = async (texts: string[]) => texts.map(() => vector);
async function snapshot() {
  const result: Record<string, unknown> = {};
  for (const [name, table] of Object.entries({ captures, people, facts, interactions, threads, looseThreads, personPlaces, places })) {
    const rows = await d.select().from(table).where(eq(table.userId, user.id));
    result[name] = rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  return result;
}
try {
  const initial = await snapshot();
  await assert.rejects(run(async () => { throw new Error("injected embedding failure"); }), /injected/);
  assert.deepEqual(await snapshot(), initial, "embedding failure rolls back newly created people and interim filing");
  await run(embed);
  const named = defaultDecisions(x, null);
  named.place = { name: "Synthetic repeated venue", placeId: null };
  await run(embed, named);
  await run(embed, named);
  const repeatedPlaces = await d.select().from(places).where(eq(places.userId, user.id));
  assert.equal(repeatedPlaces.length, 1);
  assert.equal(repeatedPlaces[0].visitCount, 1, "same named-place confirmation is one visit");
  const before = await snapshot();
  const changed = defaultDecisions(x, null);
  changed.people[0].tags = ["Changed"];
  changed.people[0].circle = "family";
  changed.place = { name: "Synthetic rollback venue", placeId: null };
  await assert.rejects(run(async texts => texts.map(() => [1, 2]), changed),
    (err: any) => /expected 1536 dimensions, not 2/.test(err.cause?.message ?? ""));
  assert.deepEqual(await snapshot(), before, "late vector insert failure restores deleted rows, people, tags, place and filing");
  await run(embed);
  assert.equal((await d.select().from(people).where(eq(people.userId, user.id))).length, 1);
  for (const table of [facts, interactions, threads, looseThreads]) {
    assert.equal((await d.select().from(table).where(eq(table.userId, user.id))).length, 1, "retry replaces each derived collection");
  }

  // Embedding stalls must not hold a tenant lock or connection transaction.
  let entered!: () => void;
  const entering = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const slow = run(async texts => { entered(); await gate; return embed(texts); });
  await entering;
  try {
    await filingTransaction(user.id, async () => {});
  } finally { release(); await slow; }

  // Hold the same tenant lock to observe both confirmations waiting in SQL.
  let locked!: () => void;
  const locking = new Promise<void>(resolve => { locked = resolve; });
  let unlock!: () => void;
  const lockGate = new Promise<void>(resolve => { unlock = resolve; });
  const blocker = filingTransaction(user.id, async () => { locked(); await lockGate; });
  await locking;
  const firstDecisions = defaultDecisions(x, null); firstDecisions.people[0].tags = ["First"];
  const secondDecisions = defaultDecisions(x, null); secondDecisions.people[0].tags = ["Second"];
  const first = run(embed, firstDecisions);
  async function waitForBlocked(n: number) {
    for (let i = 0; i < 100; i++) {
      const { sql } = await import("drizzle-orm");
      const r = await d.execute(sql`select count(*)::int as n from pg_stat_activity where datname = 'kith_test' and wait_event_type = 'Lock' and query like '%users%'`);
      if (Number(r.rows[0].n) >= n) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail(`Expected ${n} filings blocked on tenant lock`);
  }
  let second: ReturnType<typeof run> | undefined;
  try {
    await waitForBlocked(1);
    second = run(embed, secondDecisions);
    await waitForBlocked(2);
  } finally { unlock(); await Promise.all([blocker, first, second]); }
  const rows = await d.select().from(people).where(eq(people.userId, user.id));
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].tags, ["Second"]);
  const [saved] = await d.select().from(captures).where(eq(captures.id, capture.id));
  assert.equal(saved.rawText, capture.rawText);
  assert.equal(saved.transcript, capture.transcript);
  assert.equal(saved.audioKey, capture.audioKey);
  assert.equal(saved.status, "filed");
  assert.deepEqual(saved.filing?.decisions?.people[0].tags, ["Second"]);
  const staleBefore = await snapshot();
  await assert.rejects(run(async texts => {
    await d.update(captures).set({ extraction: { ...x, unresolved: ["Changed extraction"] } })
      .where(and(eq(captures.id, capture.id), eq(captures.userId, user.id)));
    return embed(texts);
  }), /changed while preparing/);
  await d.update(captures).set({ extraction: x }).where(eq(captures.id, capture.id));
  assert.deepEqual(await snapshot(), staleBefore, "stale preparation must not replace filed content");
  await assert.rejects(fileCapture({ userId: foreign.id, captureId: capture.id, by: "user", embed }), /No such note/);
  const [foreignPerson] = await d.insert(people).values({ userId: foreign.id, displayName: "Foreign synthetic" }).returning();
  const bad = defaultDecisions(x, null); bad.people[0] = { action: "match", personId: foreignPerson.id };
  const tenantBefore = await snapshot();
  await assert.rejects(run(embed, bad), /not in your people/);
  assert.deepEqual(await snapshot(), tenantBefore);
  console.log("PASS: rollback before/after deletion, retry replacement, serialized confirmations, tenant rejection, immutable raw capture");
} finally {
  await d.delete(users).where(and(eq(users.id, user.id), eq(users.email, user.email!)));
  await d.delete(users).where(and(eq(users.id, foreign.id), eq(users.email, foreign.email!)));
}
