/** Dedicated local synthetic DB only; bundle with test auth/Cloudflare aliases. */
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { db, users, captures, captureJobs } from "../src/db";
import { POST as upload } from "../src/app/api/v1/captures/route";
import { POST as rerun } from "../src/app/api/v1/captures/[id]/rerun/route";
import { store, type CaptureInput } from "../src/lib/store";
const url = new URL(process.env.DATABASE_URL ?? "");
assert.equal(url.hostname, "127.0.0.1"); assert.equal(url.port, "5543"); assert.equal(url.pathname, "/kith_test");
const globals = globalThis as unknown as { kithTestUser?: string; kithTestBindings: unknown };
const d = db();
const [user] = await d.insert(users).values({ email: `route-${crypto.randomUUID()}@example.invalid` }).returning();
const [foreign] = await d.insert(users).values({ email: `route-foreign-${crypto.randomUUID()}@example.invalid` }).returning();
const audio = new Map<string, Blob>(); let sends = 0; let puts = 0;
globals.kithTestUser = user.id;
globals.kithTestBindings = {
  AUDIO: { put: async (key: string, blob: Blob) => { puts++; audio.set(key, blob); } },
  CAPTURE_QUEUE: { send: async () => { sends++; throw new Error("Synthetic accepted then timeout"); } },
};
function uploadRequest(key: string, bytes = "synthetic bytes") {
  const form = new FormData(); form.append("audio", new Blob([bytes], { type: "audio/webm" }), "note.webm");
  form.append("capturedAt", "2026-10-17T00:00:00Z"); form.append("place", "Synthetic place");
  return new Request("http://localhost/api/v1/captures", { method: "POST", body: form, headers: { "Idempotency-Key": key } });
}
try {
  const key = crypto.randomUUID();
  const accepted = await upload(uploadRequest(key), undefined);
  assert.equal(accepted.status, 202, "durable acceptance survives missing queue acknowledgement");
  const first = await accepted.json() as { id: string };
  const retry = await upload(uploadRequest(key), undefined);
  assert.equal(retry.status, 202); assert.equal((await retry.json() as { id: string }).id, first.id);
  assert.equal(puts, 1, "retry must not overwrite immutable audio"); assert.equal(sends, 1);
  const mismatch = await upload(uploadRequest(key, "different audio"), undefined);
  assert.equal(mismatch.status, 409); assert.equal(puts, 1);
  assert.equal((await d.select().from(captures).where(eq(captures.userId, user.id))).length, 1);
  const [saved] = await d.select().from(captures).where(and(eq(captures.userId, user.id), eq(captures.id, first.id)));
  assert.equal(await audio.get(saved.audioKey!)!.text(), "synthetic bytes");
  assert.equal((await d.select().from(captureJobs).where(eq(captureJobs.userId, user.id))).length, 1);
  assert.equal((await upload(uploadRequest("bad-key"), undefined)).status, 400);
  await d.update(captureJobs).set({ finishedAt: new Date() }).where(eq(captureJobs.captureId, first.id));
  await d.update(captures).set({ status: "failed" }).where(eq(captures.id, first.id));
  const rerunKey = crypto.randomUUID();
  const retryRequest = () => new Request("http://localhost/rerun", { method: "POST", headers: { "Idempotency-Key": rerunKey } });
  const ctx = { params: Promise.resolve({ id: first.id }) };
  assert.equal((await rerun(retryRequest(), ctx)).status, 202);
  assert.equal((await rerun(retryRequest(), ctx)).status, 202);
  assert.equal((await d.select().from(captureJobs).where(eq(captureJobs.captureId, first.id))).length, 2,
    "rerun route retries must retain one additional job");
  assert.equal((await d.query.captures.findFirst({ where: eq(captures.id, first.id) }))!.audioKey, saved.audioKey);
  globals.kithTestUser = undefined;
  assert.equal((await upload(uploadRequest(crypto.randomUUID()), undefined)).status, 401);
  globals.kithTestUser = foreign.id;
  const foreignRetry = await upload(uploadRequest(key), undefined);
  assert.equal(foreignRetry.status, 202); assert.notEqual((await foreignRetry.json() as { id: string }).id, first.id);
  const foreignRerun = await rerun(new Request("http://localhost/rerun", { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() } }), { params: Promise.resolve({ id: first.id }) });
  assert.equal(foreignRerun.status, 404);
  console.log("PASS HTTP acknowledgement-loss retry, immutable audio, payload conflict, key validation, signed-out and foreign capture");

  const realFetch = globalThis.fetch;
  const keys: string[] = []; let fail = true;
  const storage = new Map<string, string>();
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: {
    getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key),
  } });
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    keys.push(new Headers(init.headers).get("Idempotency-Key")!);
    if (fail) { fail = false; throw new Error("Lost HTTP response"); }
    return Response.json({ id: first.id, status: "uploaded", kind: "text" });
  }) as typeof fetch;
  try {
    const pending: CaptureInput = { text: "Synthetic store retry", coords: null, capturedAt: new Date() };
    await assert.rejects(store.capture(pending), /Lost HTTP response/);
    await store.capture(pending);
    assert.equal(keys[0], keys[1]); assert(keys[0]);
    keys.length = 0; fail = true;
    await assert.rejects(store.rerun(first.id), /Lost HTTP response/);
    await store.rerun(first.id);
    assert.equal(keys[0], keys[1]); assert(keys[0]);
    await store.rerun(first.id);
    assert.notEqual(keys[1], keys[2], "a new acknowledged rerun uses a new identity");
    assert.equal(storage.size, 0);
  } finally { globalThis.fetch = realFetch; delete (globalThis as { sessionStorage?: Storage }).sessionStorage; }
  console.log("PASS store upload/rerun retry key retention and new rerun identity after acknowledgement");
} finally {
  globals.kithTestUser = undefined;
  await d.delete(users).where(and(eq(users.id, user.id), eq(users.email, user.email!)));
  await d.delete(users).where(and(eq(users.id, foreign.id), eq(users.email, foreign.email!)));
}
