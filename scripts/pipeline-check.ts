/**
 * Runs the capture pipeline's filing logic against the REAL database with the
 * three model calls (Whisper, Claude, embeddings) replaced by stubs.
 *
 * Why: src/workers/process-capture.ts had never executed before this script
 * existed. Drizzle queries, enum values, vector inserts and upserts all look
 * fine in an editor and only fail when they hit Postgres. This makes them hit
 * Postgres, on purpose, before a deploy does.
 *
 * What it touches: it inserts clearly marked rows (every name starts with
 * "PIPELINE CHECK") for the first user in the database, runs the worker
 * against them, asserts on what landed, and deletes everything it created,
 * both before it starts and after it finishes. It never touches rows it did
 * not create.
 *
 *   npm run pipeline:check
 *
 * Needs DATABASE_URL (the pooled Neon string) in the environment or .env.
 */
import { and, eq, like, inArray } from "drizzle-orm";
import {
  db, users, people, captures, facts, interactions, threads, places, personPlaces, looseThreads,
} from "../src/db";
import { processCapture, type Models } from "../src/workers/process-capture";
import type { Extraction } from "../src/lib/ai/extract";

const MARK = "PIPELINE CHECK";
const DIM = 1536;

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${detail !== undefined && !ok ? `  ->  ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
}

/** Fixture coordinates sit in the South Pacific so a proximity match can never touch a real place. */
/** Deterministic unit vector so the vector() column gets exercised for real. */
const fakeVector = (seed: number) => {
  const v = Array.from({ length: DIM }, (_, i) => Math.sin(seed * 7 + i));
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
};

let lastExtractInput: Parameters<Models["extract"]>[0] | null = null;
const models = (extraction: Extraction, transcript = "stub transcript"): Models => ({
  transcribe: async () => ({ text: transcript, durationSec: 12.5 }),
  extract: async (input) => { lastExtractInput = input; return extraction; },
  embed: async (texts) => texts.map((_, i) => fakeVector(i + 1)),
});

const env = {
  AUDIO: {
    get: async () => { throw new Error("AUDIO.get should not be called in this check"); },
  } as unknown as R2Bucket,
};

async function rowCounts(userId: string) {
  const d = db();
  const n = async (q: Promise<unknown[]>) => (await q).length;
  return {
    people: await n(d.select({ id: people.id }).from(people).where(eq(people.userId, userId))),
    captures: await n(d.select({ id: captures.id }).from(captures).where(eq(captures.userId, userId))),
    facts: await n(d.select({ id: facts.id }).from(facts).where(eq(facts.userId, userId))),
    interactions: await n(d.select({ id: interactions.id }).from(interactions).where(eq(interactions.userId, userId))),
    threads: await n(d.select({ id: threads.id }).from(threads).where(eq(threads.userId, userId))),
    places: await n(d.select({ id: places.id }).from(places).where(eq(places.userId, userId))),
    loose: await n(d.select({ id: looseThreads.id }).from(looseThreads).where(eq(looseThreads.userId, userId))),
  };
}

async function cleanup(userId: string) {
  const d = db();
  const ids = (await d.select({ id: people.id }).from(people)
    .where(and(eq(people.userId, userId), like(people.displayName, `${MARK}%`)))).map((r) => r.id);
  if (ids.length) await d.delete(people).where(inArray(people.id, ids)); // cascades facts, interactions, threads, person_places
  await d.delete(captures).where(and(eq(captures.userId, userId), like(captures.rawText, `${MARK}%`))); // cascades loose_threads
  await d.delete(places).where(and(eq(places.userId, userId), like(places.name, `${MARK}%`)));
}

async function main() {
  const [user] = await db().select().from(users).limit(1);
  if (!user) throw new Error("No user row. Sign in once first.");
  const userId = user.id;
  console.log(`user ${user.email}`);
  await cleanup(userId);
  const baseline = await rowCounts(userId);

  try {
    /* ---- fixtures: one known person, one open thread, one known place ---- */
    const [marcus] = await db().insert(people).values({
      userId, displayName: `${MARK} Marcus Ellery`, goesBy: "Marcus", circle: "friends", role: "golf, flies a Cirrus",
    }).returning();
    const [openThread] = await db().insert(threads).values({
      userId, personId: marcus.id, title: `${MARK} send Marcus the Cirrus article`,
    }).returning();
    const [club] = await db().insert(places).values({
      userId, name: `${MARK} Brook Hollow Golf Club`, lat: -45.0000, lng: -130.0000, radiusM: 200, visitCount: 3,
    }).returning();

    /* ---- 1. a typed note, filed clean ---- */
    const [c1] = await db().insert(captures).values({
      userId, kind: "text", status: "uploaded",
      rawText: `${MARK} Just saw Marcus at the club. His daughter Priya got into Rice, early decision. I told him I'd send the Cirrus article this week. Also met a guy named Dev Patel who runs a coffee roaster in Bishop Arts, he's a neighbor. Someone mentioned a birthday on the 14th but I missed whose.`,
      lat: -45.0002, lng: -130.0002, accuracyM: 12, capturedAt: new Date(),
    }).returning();

    const extraction1: Extraction = {
      people: [
        { matchedPersonId: marcus.id, name: "Marcus", confidence: 0.96, isNew: false },
        { matchedPersonId: null, name: `${MARK} Dev Patel`, confidence: 0.9, isNew: true, circle: "neighbors", role: "runs a coffee roaster in Bishop Arts" },
        { matchedPersonId: "not-a-real-id", name: "Ghost", confidence: 0.9, isNew: false }, // must not crash, must not file
      ],
      facts: [
        { personName: "Marcus", kind: "relation", content: "Daughter Priya, got into Rice early decision", confidence: 0.95 },
        { personName: `${MARK} Dev Patel`, kind: "context", content: "Runs a coffee roaster in Bishop Arts", confidence: 0.9 },
        { personName: "Nobody Known", kind: "context", content: "should become a loose thread, not vanish", confidence: 0.9 },
      ],
      interactions: [
        { personName: "Marcus", summary: "Ran into him at the club, talked about Priya and Rice", occurredAt: new Date().toISOString(), channel: "in_person" },
        { personName: `${MARK} Dev Patel`, summary: "Met for the first time at the club", occurredAt: "not a date", channel: "in_person" },
      ],
      threads: [
        { personName: "Marcus", title: "Send the Cirrus article", dueAt: new Date(Date.now() + 5 * 86_400_000).toISOString() },
      ],
      closesThreadIds: [openThread.id],
      place: { name: "Brook Hollow Golf Club", confidence: 0.8 },
      unresolved: ["Someone mentioned a birthday on the 14th but I missed whose"],
    };

    console.log("\n1. typed note, high confidence");
    await processCapture({ captureId: c1.id, userId }, env, models(extraction1));

    const after1 = await db().query.captures.findFirst({ where: eq(captures.id, c1.id) });
    check("status is filed", after1?.status === "filed", after1?.status);
    check("extraction JSON stored", !!after1?.extraction && after1.extraction.people.length === 3);
    check("place resolved from cache (no Google key needed)", after1?.placeId === club.id, after1?.placeId);

    const clubAfter = await db().query.places.findFirst({ where: eq(places.id, club.id) });
    check("place visit count incremented 3 -> 4", clubAfter?.visitCount === 4, clubAfter?.visitCount);

    const dev = await db().query.people.findFirst({ where: and(eq(people.userId, userId), eq(people.displayName, `${MARK} Dev Patel`)) });
    check("new person created with circle", dev?.circle === "neighbors", dev?.circle);

    const f = await db().select().from(facts).where(eq(facts.captureId, c1.id));
    check("2 facts filed (orphan excluded)", f.length === 2, f.length);
    check("relation fact is pinned", f.find((x) => x.kind === "relation")?.pinned === true);
    check("facts carry a 1536-dim embedding", f.every((x) => Array.isArray(x.embedding) && x.embedding.length === DIM));

    const ix = await db().select().from(interactions).where(eq(interactions.captureId, c1.id));
    check("2 interactions filed", ix.length === 2, ix.length);
    check("interaction with a bad date fell back to capturedAt", ix.every((x) => !Number.isNaN(x.occurredAt.getTime())));
    check("interactions tagged with the place", ix.every((x) => x.placeId === club.id));

    const th = await db().select().from(threads).where(eq(threads.userId, userId));
    const closed = th.find((t) => t.id === openThread.id);
    const created = th.find((t) => t.createdFromCaptureId === c1.id);
    check("open thread closed by this capture", closed?.status === "done" && closed.closedByCaptureId === c1.id, closed?.status);
    check("new thread created with due date", !!created?.dueAt, created);

    const loose = await db().select().from(looseThreads).where(eq(looseThreads.captureId, c1.id));
    check("2 loose threads: the unresolved line plus the orphaned fact", loose.length === 2, loose.map((l) => l.content));

    const marcusAfter = await db().query.people.findFirst({ where: eq(people.id, marcus.id) });
    check("warmth recomputed on the matched person", (marcusAfter?.warmth ?? 0) >= 90 && !!marcusAfter?.lastInteractionAt, marcusAfter?.warmth);

    const pp = await db().select().from(personPlaces).where(eq(personPlaces.placeId, club.id));
    check("person_places linked for both people", pp.length === 2, pp.length);
    check("model was given NOW with a weekday and a calendar", /^(Sun|Mon|Tues|Wednes|Thurs|Fri|Satur)day, /.test(lastExtractInput?.now ?? "") && /\(today\), .*\(tomorrow\)/.test(lastExtractInput?.dateContext ?? ""), { now: lastExtractInput?.now, cal: lastExtractInput?.dateContext?.slice(0, 60) });

    /* ---- 2. re-run the same capture: the upsert path must not blow up ---- */
    console.log("\n2. same capture processed again (what a queue retry looks like)");
    await processCapture({ captureId: c1.id, userId }, env, models(extraction1));
    const pp2 = await db().select().from(personPlaces).where(and(eq(personPlaces.placeId, club.id), eq(personPlaces.personId, marcus.id)));
    check("person_places weight upserted 1 -> 2", pp2[0]?.weight === 2, pp2[0]?.weight);
    const f2 = await db().select().from(facts).where(eq(facts.captureId, c1.id));
    const ix2 = await db().select().from(interactions).where(eq(interactions.captureId, c1.id));
    const loose2 = await db().select().from(looseThreads).where(eq(looseThreads.captureId, c1.id));
    check("re-run replaced rather than duplicated: still 2 facts, 2 interactions, 2 loose", f2.length === 2 && ix2.length === 2 && loose2.length === 2, [f2.length, ix2.length, loose2.length]);

    /* ---- 3. a voice capture retried after transcription already succeeded ---- */
    console.log("\n3. voice capture on its second attempt (transcript already saved)");
    const [c3] = await db().insert(captures).values({
      userId, kind: "voice", status: "transcribing", audioKey: `captures/${userId}/check.mp4`,
      rawText: `${MARK} marker only, voice captures have no rawText in production`,
      transcript: "Marcus says hi.", capturedAt: new Date(),
    }).returning();
    await db().update(captures).set({ rawText: null }).where(eq(captures.id, c3.id));
    await processCapture({ captureId: c3.id, userId }, env, models({
      ...extraction1, people: [{ matchedPersonId: marcus.id, name: "Marcus", confidence: 0.99, isNew: false }],
      facts: [], interactions: [], threads: [], closesThreadIds: [], unresolved: [], place: null,
    }));
    const after3 = await db().query.captures.findFirst({ where: eq(captures.id, c3.id) });
    check("did not throw 'Empty transcript', filed from the saved transcript", after3?.status === "filed", after3?.status);
    await db().delete(captures).where(eq(captures.id, c3.id));

    /* ---- 4. low confidence goes to needs_review ---- */
    console.log("\n4. low confidence match");
    const [c4] = await db().insert(captures).values({
      userId, kind: "text", status: "uploaded", rawText: `${MARK} maybe Marcus, maybe not`, capturedAt: new Date(),
    }).returning();
    await processCapture({ captureId: c4.id, userId }, env, models({
      people: [{ matchedPersonId: marcus.id, name: "Marcus", confidence: 0.6, isNew: false }],
      facts: [], interactions: [], threads: [], closesThreadIds: [], unresolved: [], place: null,
    }));
    const after4 = await db().query.captures.findFirst({ where: eq(captures.id, c4.id) });
    check("status is needs_review", after4?.status === "needs_review", after4?.status);

    /* ---- 6. a typed place name finds an existing place, fuzzily ---- */
    console.log("\n6. typed place, lowercase and partial, matches the known club");
    const [c6] = await db().insert(captures).values({
      userId, kind: "text", status: "uploaded", rawText: `${MARK} saw Marcus at the club`,
      placeHint: "pipeline check brook hollow", lat: -45.0002, lng: -130.0002, capturedAt: new Date(),
    }).returning();
    await processCapture({ captureId: c6.id, userId }, env, models({
      people: [{ matchedPersonId: marcus.id, name: "Marcus", confidence: 0.97, isNew: false }],
      facts: [], interactions: [{ personName: "Marcus", summary: "Saw him at the club", occurredAt: new Date().toISOString(), channel: "in_person" }],
      threads: [], closesThreadIds: [], unresolved: [], place: null,
    }));
    const after6 = await db().query.captures.findFirst({ where: eq(captures.id, c6.id) });
    check("resolved to the existing club by name, no new place", after6?.placeId === club.id, after6?.placeId);
    const placesNow = await db().select().from(places).where(and(eq(places.userId, userId), like(places.name, `${MARK}%`)));
    check("still exactly one place row", placesNow.length === 1, placesNow.map((p) => p.name));

    /* ---- 7. a new typed place, recorded from the couch: no coordinates ---- */
    console.log("\n7. new typed place with no coordinates (delayed note from home)");
    const [c7] = await db().insert(captures).values({
      userId, kind: "text", status: "uploaded", rawText: `${MARK} dinner at Alex's parents`,
      placeHint: `${MARK} Alex's Parents`, capturedAt: new Date(),
    }).returning();
    await processCapture({ captureId: c7.id, userId }, env, models({
      people: [{ matchedPersonId: marcus.id, name: "Marcus", confidence: 0.97, isNew: false }],
      facts: [], interactions: [{ personName: "Marcus", summary: "Dinner", occurredAt: new Date().toISOString(), channel: "in_person" }],
      threads: [], closesThreadIds: [], unresolved: [], place: null,
    }));
    const parents = await db().query.places.findFirst({ where: and(eq(places.userId, userId), eq(places.name, `${MARK} Alex's Parents`)) });
    check("new place created from the typed name", !!parents, parents);
    check("new place has no coordinates", parents?.lat == null && parents?.lng == null);
    const ix7 = await db().select().from(interactions).where(eq(interactions.captureId, c7.id));
    check("interaction tagged with the new place and no coordinates", ix7[0]?.placeId === parents?.id && ix7[0]?.lat == null);

    /* ---- 8. naming the place you are at teaches its coordinates ---- */
    console.log("\n8. 'Here' with a name learns where the place is, then plain GPS finds it");
    const [c8] = await db().insert(captures).values({
      userId, kind: "text", status: "uploaded", rawText: `${MARK} at the range`,
      placeHint: `${MARK} Alex's Parents`, lat: -46.0000, lng: -131.0000, capturedAt: new Date(),
    }).returning();
    await processCapture({ captureId: c8.id, userId }, env, models({
      people: [], facts: [], interactions: [], threads: [], closesThreadIds: [], unresolved: [], place: null,
    }));
    const learned = await db().query.places.findFirst({ where: eq(places.id, parents!.id) });
    check("existing place learned coordinates from a visit there", learned?.lat === -46 && learned?.lng === -131, [learned?.lat, learned?.lng]);
    const [c8b] = await db().insert(captures).values({
      userId, kind: "text", status: "uploaded", rawText: `${MARK} back at the range, no name typed`,
      lat: -46.0003, lng: -131.0002, capturedAt: new Date(),
    }).returning();
    await processCapture({ captureId: c8b.id, userId }, env, models({
      people: [], facts: [], interactions: [], threads: [], closesThreadIds: [], unresolved: [], place: null,
    }));
    const after8b = await db().query.captures.findFirst({ where: eq(captures.id, c8b.id) });
    check("coordinates alone now match the learned place", after8b?.placeId === parents?.id, after8b?.placeId);

    /* ---- 5. silence is a permanent failure, not three retries ---- */
    console.log("\n5. empty transcript");
    const [c5] = await db().insert(captures).values({
      userId, kind: "text", status: "uploaded", rawText: `${MARK}`, capturedAt: new Date(),
    }).returning();
    await db().update(captures).set({ rawText: "   " }).where(eq(captures.id, c5.id));
    let permanent = false;
    try { await processCapture({ captureId: c5.id, userId }, env, models(extraction1)); }
    catch (e: any) { permanent = e?.permanent === true; }
    check("throws a permanent error", permanent);
    await db().delete(captures).where(eq(captures.id, c5.id));
  } finally {
    await cleanup(userId);
    const after = await rowCounts(userId);
    const clean = JSON.stringify(after) === JSON.stringify(baseline);
    console.log(`\ncleanup: ${clean ? "clean, every table back to its starting count" : `ROWS LEFT BEHIND before=${JSON.stringify(baseline)} after=${JSON.stringify(after)}`}`);
    if (!clean) failures++;
  }

  console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error("\npipeline check crashed:", e); process.exit(1); });
