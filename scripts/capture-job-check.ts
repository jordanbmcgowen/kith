/** Dedicated synthetic DB only. Same bundle adapter as filing-reliability-check.ts. */
import assert from "node:assert/strict";
import { and, eq, sql } from "drizzle-orm";
import { db, filingTransaction, users, captures, captureJobs, people, facts, interactions, threads, looseThreads, places, personPlaces, type ExtractionResult } from "../src/db";
import { acceptCapture, requestHash, dispatchJob, dispatchDue, claimJob, rerunCapture, findRequest, JobConflict, StaleJob, withLease, type JobMessage } from "../src/lib/capture-jobs";
import worker, { processCapture, type Models } from "../src/workers/process-capture";
import { fileCapture, defaultDecisions } from "../src/lib/filing";
const url = new URL(process.env.DATABASE_URL ?? "");
assert.equal(url.hostname, "127.0.0.1"); assert.equal(url.port, "5543"); assert.equal(url.pathname, "/kith_test");
const d = db();
const [user] = await d.insert(users).values({ email: `jobs-${crypto.randomUUID()}@example.invalid` }).returning();
const [foreign] = await d.insert(users).values({ email: `jobs-foreign-${crypto.randomUUID()}@example.invalid` }).returning();
const vector = Array(1536).fill(0); vector[0] = 1;
const extract = (name = "Synthetic Job Person", content = "Original synthetic fact"): ExtractionResult => ({
  people: [{ name, matchedPersonId: null, isNew: true, confidence: 1, tags: ["Group"] }],
  facts: [{ personName: name, kind: "identity", content, confidence: 1 }],
  interactions: [{ personName: name, summary: "Synthetic meeting", channel: "in_person", occurredAt: "2026-10-17T00:00:00Z" }],
  threads: [], unresolved: [], closesThreadIds: [], place: null,
});
const models = (x = extract()): Models => ({ transcribe: async () => ({ text: "Synthetic transcript", durationSec: 1 }), extract: async () => x, embed: async texts => texts.map(() => vector) });
const env = { AUDIO: { get: async () => { throw new Error("Unexpected audio request"); } } as unknown as R2Bucket };
const ownJob = (key: string) => and(eq(captureJobs.userId, user.id), eq(captureJobs.requestKey, key));
const getJob = (key: string) => d.query.captureJobs.findFirst({ where: ownJob(key) });
const getCapture = (id: string) => d.query.captures.findFirst({ where: and(eq(captures.userId, user.id), eq(captures.id, id)) });
const due = (key: string) => d.update(captureJobs).set({ availableAt: sql`now() - interval '1 minute'` }).where(ownJob(key));
const expire = (key: string) => d.update(captureJobs).set({ leaseUntil: sql`now() - interval '1 minute'` }).where(ownJob(key));
const message = (captureId: string, requestKey: string): JobMessage => ({ userId: user.id, captureId, requestKey });
async function make(key = crypto.randomUUID(), text = "Immutable synthetic raw note") {
  const input = { kind: "text" as const, rawText: text, capturedAt: new Date("2026-10-17T00:00:00Z") };
  const hash = await requestHash(input);
  return { capture: await acceptCapture(user.id, key, hash, input), key, hash, input };
}
async function snapshot(id: string) {
  const result: Record<string, unknown> = { capture: await getCapture(id) };
  for (const [name, table] of Object.entries({ captureJobs, people, facts, interactions, threads, looseThreads, places, personPlaces })) {
    result[name] = (await d.select().from(table).where(eq(table.userId, user.id))).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  return result;
}
function gate() {
  let release!: () => void, entered!: () => void;
  return { wait: new Promise<void>(r => { release = r; }), ready: new Promise<void>(r => { entered = r; }), release: () => release(), enter: () => entered() };
}
try {
  const beforeAcceptance = await d.select().from(captures).where(eq(captures.userId, user.id));
  await assert.rejects(acceptCapture(user.id, crypto.randomUUID(), null as unknown as string,
    { kind: "text", rawText: "must roll back", capturedAt: new Date() }));
  assert.deepEqual(await d.select().from(captures).where(eq(captures.userId, user.id)), beforeAcceptance,
    "job insertion failure must roll back capture insertion");
  const first = await make();
  const concurrent = await Promise.all(Array.from({ length: 4 }, () => acceptCapture(user.id, first.key, first.hash, first.input)));
  assert(concurrent.every(c => c.id === first.capture.id));
  assert.equal((await d.select().from(captures).where(eq(captures.userId, user.id))).length, 1);
  await assert.rejects(acceptCapture(user.id, first.key, "different hash", first.input), JobConflict);
  await assert.rejects(findRequest(user.id, first.key, "different hash"), JobConflict);
  assert.equal(await requestHash({ a: 1 }, new Blob(["same audio"])), await requestHash({ a: 1 }, new Blob(["same audio"])));
  assert.notEqual(await requestHash({ a: 1 }, new Blob(["audio A"])), await requestHash({ a: 1 }, new Blob(["audio B"])));

  await dispatchJob(user.id, first.key, { send: async () => { throw new Error("definitely rejected"); } });
  assert.equal((await getJob(first.key))!.finishedAt, null);
  assert.equal((await getCapture(first.capture.id))!.status, "uploaded");
  assert.equal((await getCapture(first.capture.id))!.rawText, first.input.rawText);
  const deliveries: JobMessage[] = [];
  await due(first.key);
  await dispatchJob(user.id, first.key, { send: async msg => { deliveries.push(msg); throw new Error("timeout AFTER acceptance"); } });
  assert.equal(deliveries.length, 1);
  assert.equal((await getJob(first.key))!.finishedAt, null);
  assert.equal((await make(first.key)).capture.id, first.capture.id, "HTTP retry reuses original note after ambiguous enqueue");
  await due(first.key);
  await dispatchDue({ send: async msg => { deliveries.push(msg); } });
  assert.equal(deliveries.length, 2);
  assert.deepEqual(deliveries[0], deliveries[1]);

  const extracting = gate(); let calls = 0;
  const originalModels = models();
  const slowModels = { ...originalModels, extract: async () => { calls++; extracting.enter(); await extracting.wait; return extract(); } };
  const running = processCapture(deliveries[0], env, slowModels);
  await extracting.ready;
  try {
    await processCapture(deliveries[1], env, slowModels);
    assert.equal(calls, 1, "duplicate delivery cannot run another model while leased");
  } finally { extracting.release(); await running; }
  const complete = await snapshot(first.capture.id);
  await processCapture(deliveries[0], env, models(extract("Wrong", "Must not appear")));
  assert.deepEqual(await snapshot(first.capture.id), complete, "late duplicate cannot modify completed notes");
  assert((await getJob(first.key))!.finishedAt);
  console.log("PASS durable acceptance, rejection, timeout-after-accept, recovery, duplicate delivery and request mismatch");

  const dispatchRace = await make(); let reserved = 0;
  const countedQueue = { send: async () => { reserved++; } };
  await Promise.all([dispatchJob(user.id, dispatchRace.key, countedQueue), dispatchJob(user.id, dispatchRace.key, countedQueue)]);
  assert.equal(reserved, 1, "concurrent dispatchers reserve only one due send");
  const inline = await make();
  await dispatchJob(user.id, inline.key, { send: async msg => {
    await processCapture(msg, env, models(extract("Inline acknowledged person")));
    throw new Error("Lost acknowledgement after consumer completion");
  } });
  assert((await getJob(inline.key))!.finishedAt);
  assert.equal((await getJob(inline.key))!.lastError, null, "late dispatch failure cannot dirty a completed job");
  assert.equal((await getCapture(inline.capture.id))!.status, "filed");

  const transient = await make(); let attempts = 0; let outage = true;
  let failedToken: string | null = null;
  const flaky = { ...models(), extract: async () => {
    attempts++;
    if (outage) {
      failedToken ??= (await getJob(transient.key))!.leaseToken;
      throw new Error("transient extraction failure");
    }
    return extract("Retry person");
  } };
  await assert.rejects(processCapture(message(transient.capture.id, transient.key), env, flaky), /transient/);
  const duplicates = await Promise.allSettled(Array.from({ length: 3 }, () =>
    processCapture(message(transient.capture.id, transient.key), env, flaky)));
  assert.equal(attempts, 1, "duplicate deliveries during backoff must not spend model calls or attempts");
  assert(duplicates.every(result => result.status === "fulfilled"), "backoff deliveries are harmless ACKs");
  const cooling = (await getJob(transient.key))!;
  assert.equal(cooling.attempts, 1);
  assert.equal(cooling.finishedAt, null);
  assert(cooling.leaseUntil && cooling.leaseUntil.getTime() > Date.now());
  assert(cooling.leaseToken && cooling.leaseToken !== failedToken, "failed worker token must be invalidated during cooldown");
  assert.notEqual((await getCapture(transient.capture.id))!.status, "failed");
  await assert.rejects(withLease({ userId: user.id, captureId: transient.capture.id, requestKey: transient.key,
    token: failedToken!, attempts: 1, review: false }, async () => {}), StaleJob);
  const earlySends: JobMessage[] = [];
  await dispatchJob(user.id, transient.key, { send: async msg => { earlySends.push(msg); } });
  assert.equal(earlySends.length, 0, "dispatcher also respects processing backoff");
  // Advance only synthetic timestamps, rather than sleeping through backoff.
  await expire(transient.key); await due(transient.key); outage = false;
  const retryMessages: JobMessage[] = [];
  await dispatchJob(user.id, transient.key, { send: async msg => { retryMessages.push(msg); } });
  assert.equal(retryMessages.length, 1);
  assert((await getJob(transient.key))!.availableAt.getTime() > Date.now(), "dispatch reserves its own future send window");
  await processCapture(retryMessages[0], env, flaky);
  assert.equal((await getJob(transient.key))!.attempts, 2);
  assert.equal((await getCapture(transient.capture.id))!.status, "filed");
  console.log("PASS duplicate burst during processing backoff preserves attempts; later dispatch reservation does not delay eligible processing");

  const failed = await make();
  const permanent = { ...models(), extract: async () => { throw Object.assign(new Error("permanent fixture rejection"), { status: 400 }); } };
  await assert.rejects(processCapture(message(failed.capture.id, failed.key), env, permanent), /permanent/);
  assert.equal((await getCapture(failed.capture.id))!.status, "failed");
  assert((await getJob(failed.key))!.finishedAt);
  const rerunKey = crypto.randomUUID();
  await rerunCapture(user.id, failed.capture.id, rerunKey);
  await assert.rejects(rerunCapture(user.id, failed.capture.id, crypto.randomUUID()), JobConflict);
  await processCapture(message(failed.capture.id, rerunKey), env, models(extract("Re-read person")));
  assert.equal((await getCapture(failed.capture.id))!.status, "needs_review");
  await rerunCapture(user.id, failed.capture.id, rerunKey);
  assert.equal((await getCapture(failed.capture.id))!.status, "needs_review", "retry of completed rerun must not restart it");
  await assert.rejects(rerunCapture(user.id, transient.capture.id, rerunKey), JobConflict);
  console.log("PASS retry after transient/permanent failure, durable rerun identity and active-job exclusion");

  // An expired model call returns after a replacement worker and confirmation.
  for (const stage of ["extract", "embed", "error"] as const) {
    const note = await make();
    const paused = gate();
    const staleModels = models(extract(`Old ${stage}`, "Old output must never land"));
    if (stage === "error") staleModels.extract = async () => { paused.enter(); await paused.wait; throw new Error("Stale worker failure"); };
    else if (stage === "extract") staleModels.extract = async () => { paused.enter(); await paused.wait; return extract(`Old ${stage}`, "Old output must never land"); };
    else staleModels.embed = async texts => { paused.enter(); await paused.wait; return texts.map(() => vector); };
    const old = processCapture(message(note.capture.id, note.key), env, staleModels).then(() => null, err => err);
    await paused.ready;
    try {
      await expire(note.key);
      await processCapture(message(note.capture.id, note.key), env, models(extract(`New ${stage}`, "Newer worker output")));
      const saved = (await getCapture(note.capture.id))!;
      const decisions = defaultDecisions(saved.extraction!, saved.placeId);
      decisions.people[0].tags = ["Confirmed newer tags"];
      await fileCapture({ userId: user.id, captureId: saved.id, by: "user", decisions, embed: models().embed });
      const confirmed = await snapshot(saved.id);
      paused.release();
      const oldError = await old;
      if (stage === "error") assert.match(oldError?.message ?? "", /Stale worker failure/);
      else assert.equal(oldError, null);
      assert.deepEqual(await snapshot(saved.id), confirmed, `old ${stage} completion must not overwrite newer confirmation`);
      assert.equal((await getJob(note.key))!.attempts, 2);
      assert.equal(saved.rawText, note.input.rawText);
      assert.equal(saved.audioKey, note.capture.audioKey);
      assert.equal(saved.transcript, note.capture.transcript);
    } finally { paused.release(); await old; }
  }
  // An old transcription must not overwrite the first saved transcript.
  const voiceKey = crypto.randomUUID();
  const voice = await acceptCapture(user.id, voiceKey, "synthetic-voice", {
    kind: "voice", audioKey: "synthetic/immutable.webm", capturedAt: new Date("2026-10-17T00:00:00Z"),
  });
  const speech = gate();
  const oldSpeech = { ...models(), transcribe: async () => { speech.enter(); await speech.wait; return { text: "Stale transcription", durationSec: 2 }; } };
  const audioEnv = { AUDIO: { get: async () => ({ httpMetadata: { contentType: "audio/webm" }, arrayBuffer: async () => new TextEncoder().encode("synthetic audio").buffer }) } as unknown as R2Bucket };
  const talking = processCapture(message(voice.id, voiceKey), audioEnv, oldSpeech);
  await speech.ready;
  try {
    await expire(voiceKey);
    await processCapture(message(voice.id, voiceKey), audioEnv, models(extract("Voice person")));
    const voiced = await snapshot(voice.id);
    assert.equal((await getCapture(voice.id))!.transcript, "Synthetic transcript");
    speech.release(); await talking;
    assert.deepEqual(await snapshot(voice.id), voiced, "stale transcription cannot replace saved transcript/audio key");
  } finally { speech.release(); await talking; }

  const exhausted = await make();
  const lease = await claimJob(message(exhausted.capture.id, exhausted.key)); assert(lease);
  await expire(exhausted.key);
  await assert.rejects(withLease(lease, async tx => { await tx.delete(facts).where(eq(facts.userId, user.id)); }), StaleJob);
  await d.update(captureJobs).set({ attempts: 3 }).where(ownJob(exhausted.key));
  assert.equal(await claimJob(message(exhausted.capture.id, exhausted.key)), null);
  assert.equal((await getCapture(exhausted.capture.id))!.status, "failed");
  assert((await getJob(exhausted.key))!.finishedAt);
  console.log("PASS expired lease reclamation, attempt exhaustion, expired-owner rejection and stale extraction/filing completion");

  // Google network time must hold no tenant lock. A place added while the
  // lookup is pending must win when the fenced write rechecks local places.
  const googleKey = crypto.randomUUID();
  const googleCapture = await acceptCapture(user.id, googleKey, "synthetic-google-note", {
    kind: "text", rawText: "Synthetic Google lookup", capturedAt: new Date(), lat: -43, lng: -145,
  });
  const searching = gate(); const realFetch = globalThis.fetch; let googleCalls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).startsWith("https://places.googleapis.com/")) {
      googleCalls++; searching.enter(); await searching.wait;
      return Response.json({ places: [{ id: "synthetic-google-result", displayName: { text: "Google candidate" }, location: { latitude: -43, longitude: -145 } }] });
    }
    return realFetch(input, init);
  }) as typeof fetch;
  const lookup = processCapture(message(googleCapture.id, googleKey), { ...env, GOOGLE_PLACES_KEY: "synthetic-stub-only" }, models(extract("Google person")));
  await searching.ready;
  const concurrentPlace = filingTransaction(user.id, async tx => {
    const [place] = await tx.insert(places).values({ userId: user.id, name: "Added while Google waited", lat: -43, lng: -145 }).returning();
    return place;
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const known = await Promise.race([concurrentPlace, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Google lookup held the tenant lock")), 2000);
    })]);
    searching.release(); await lookup;
    assert.equal(googleCalls, 1);
    assert.equal((await getCapture(googleCapture.id))!.placeId, known.id);
    const savedPlace = await d.query.places.findFirst({ where: and(eq(places.userId, user.id), eq(places.id, known.id)) });
    assert.equal(savedPlace!.visitCount, 1);
    assert.equal((await d.select().from(places).where(and(eq(places.userId, user.id), eq(places.googlePlaceId, "synthetic-google-result")))).length, 0);
  } finally {
    clearTimeout(timer); searching.release(); await Promise.allSettled([lookup, concurrentPlace]); globalThis.fetch = realFetch;
  }
  console.log("PASS Google precompute holds no tenant lock and fenced resolution prefers a newly known local place");

  const isolated = await make(); const beforeForeign = await snapshot(isolated.capture.id);
  await processCapture({ userId: foreign.id, captureId: isolated.capture.id, requestKey: isolated.key }, env, models());
  await processCapture({ userId: user.id, captureId: isolated.capture.id, requestKey: crypto.randomUUID() }, env, models());
  assert.equal(await rerunCapture(foreign.id, isolated.capture.id, crypto.randomUUID()), null);
  assert.equal(await findRequest(foreign.id, isolated.key, isolated.hash), undefined);
  await dispatchJob(foreign.id, isolated.key, { send: async () => { assert.fail("Foreign tenant must not dispatch this job"); } });
  assert.deepEqual(await snapshot(isolated.capture.id), beforeForeign);
  const foreignCapture = await acceptCapture(foreign.id, isolated.key, isolated.hash, isolated.input);
  assert.notEqual(foreignCapture.id, isolated.capture.id, "same key is independent per tenant");
  // Exercise the real queue wrapper too: it must ACK completed duplicates.
  let acked = 0;
  await worker.queue({ messages: [{ body: deliveries[0], attempts: 1, ack: () => { acked++; }, retry: () => { assert.fail("Completed duplicate retried"); } }] } as unknown as MessageBatch<JobMessage>, env);
  assert.equal(acked, 1);
  console.log("PASS cross-tenant capture/request IDs and real queue wrapper duplicate ACK");
} finally {
  await d.delete(users).where(and(eq(users.id, user.id), eq(users.email, user.email!)));
  await d.delete(users).where(and(eq(users.id, foreign.id), eq(users.email, foreign.email!)));
}
