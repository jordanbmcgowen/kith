/**
 * Runs the capture pipeline's filing logic against the REAL database with the
 * three model calls (Whisper, Claude, embeddings) replaced by stubs.
 *
 * Why: src/workers/process-capture.ts and src/lib/filing.ts never execute
 * anywhere else before a deploy. Drizzle queries, enum values, vector inserts
 * and raw SQL all look fine in an editor and only fail when they hit Postgres.
 * This makes them hit Postgres, on purpose, before a deploy does.
 *
 * What it touches: it inserts clearly marked rows (every name starts with
 * "PIPELINE CHECK") for the first user in the database, runs the worker and
 * the filing module against them, asserts on what landed, and deletes
 * everything it created, both before it starts and after it finishes. It
 * never touches rows it did not create.
 *
 *   npm run pipeline:check
 *
 * Needs DATABASE_URL (the pooled Neon string) in the environment or .env.
 */
import { and, eq, like, inArray } from "drizzle-orm";
import {
  db, users, people, captures, facts, interactions, threads, places, personPlaces, looseThreads,
} from "../src/db";
import type { FilingDecisions } from "../src/db/schema";
import { processCapture, type Models } from "../src/workers/process-capture";
import { fileCapture, reconstructFiling, reviewReason, defaultDecisions, NEW_PEOPLE_REVIEW_AT } from "../src/lib/filing";
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
const embed: Models["embed"] = async (texts) => texts.map((_, i) => fakeVector(i + 1));
const models = (extraction: Extraction, transcript = "stub transcript"): Models => ({
  transcribe: async () => ({ text: transcript, durationSec: 12.5 }),
  extract: async (input) => { lastExtractInput = input; return extraction; },
  embed,
});

const env = {
  AUDIO: {
    get: async () => { throw new Error("AUDIO.get should not be called in this check"); },
  } as unknown as R2Bucket,
};

const empty: Extraction = { people: [], facts: [], interactions: [], threads: [], closesThreadIds: [], unresolved: [], place: null };

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
    personPlaces: await n(d.select({ id: personPlaces.personId }).from(personPlaces).where(eq(personPlaces.userId, userId))),
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

const factsOf = (captureId: string) => db().select().from(facts).where(eq(facts.captureId, captureId));
const interactionsOf = (captureId: string) => db().select().from(interactions).where(eq(interactions.captureId, captureId));
const looseOf = (captureId: string) => db().select().from(looseThreads).where(eq(looseThreads.captureId, captureId));
const peopleNamed = (userId: string, name: string) =>
  db().select().from(people).where(and(eq(people.userId, userId), eq(people.displayName, name)));
const captureRow = (id: string) => db().query.captures.findFirst({ where: eq(captures.id, id) });

async function main() {
  const [user] = await db().select().from(users).limit(1);
  if (!user) throw new Error("No user row. Sign in once first.");
  const userId = user.id;
  console.log(`user ${user.email}`);
  await cleanup(userId);
  const baseline = await rowCounts(userId);

  try {
    /* ---- fixtures: one known person, one open thread, one known place ---- */
    const GOLF = `${MARK} Golf`;
    const [marcus] = await db().insert(people).values({
      userId, displayName: `${MARK} Marcus Ellery`, goesBy: "Marcus", role: "golf, flies a Cirrus", tags: [GOLF],
    }).returning();
    const [openThread] = await db().insert(threads).values({
      userId, personId: marcus.id, title: `${MARK} send Marcus the Cirrus article`,
    }).returning();
    const [club] = await db().insert(places).values({
      userId, name: `${MARK} Brook Hollow Golf Club`, lat: -45.0000, lng: -130.0000, radiusM: 200, visitCount: 3,
    }).returning();
    const DEV = `${MARK} Dev Patel`;

    /* ---- 1. a typed note, filed clean ---- */
    const [c1] = await db().insert(captures).values({
      userId, kind: "text", status: "uploaded",
      rawText: `${MARK} Just saw Marcus at the club. His daughter Priya got into Rice, early decision. I told him I'd send the Cirrus article this week. Also met a guy named Dev Patel who runs a coffee roaster in Bishop Arts, he's a neighbor. Someone mentioned a birthday on the 14th but I missed whose.`,
      lat: -45.0002, lng: -130.0002, accuracyM: 12, capturedAt: new Date(),
    }).returning();

    const extraction1: Extraction = {
      people: [
        // Lowercase on purpose: it must land as the spelling Marcus already has, plus one new tag.
        { matchedPersonId: marcus.id, name: "Marcus", confidence: 0.96, isNew: false, tags: [GOLF.toLowerCase(), `${MARK} Board`] },
        { matchedPersonId: null, name: DEV, confidence: 0.9, isNew: true, role: "runs a coffee roaster in Bishop Arts", tags: [`${MARK} Bishop Arts`] },
      ],
      facts: [
        { personName: "Marcus", kind: "relation", content: "Daughter Priya, got into Rice early decision", confidence: 0.95 },
        { personName: DEV, kind: "context", content: "Runs a coffee roaster in Bishop Arts", confidence: 0.9 },
        { personName: "Nobody Known", kind: "context", content: "should become a loose thread, not vanish", confidence: 0.9 },
      ],
      interactions: [
        { personName: "Marcus", summary: "Ran into him at the club, talked about Priya and Rice", occurredAt: new Date().toISOString(), channel: "in_person" },
        { personName: DEV, summary: "Met for the first time at the club", occurredAt: "not a date", channel: "in_person" },
      ],
      threads: [
        { personName: "Marcus", title: "Send the Cirrus article", dueAt: new Date(Date.now() + 5 * 86_400_000).toISOString() },
      ],
      closesThreadIds: [openThread.id],
      place: { name: "Brook Hollow Golf Club", confidence: 0.8 },
      unresolved: ["Someone mentioned a birthday on the 14th but I missed whose"],
    };

    console.log("\n1. typed note, high confidence, files itself");
    await processCapture({ captureId: c1.id, userId }, env, models(extraction1));

    const after1 = await captureRow(c1.id);
    check("status is filed", after1?.status === "filed", after1?.status);
    check("extraction JSON stored", !!after1?.extraction && after1.extraction.people.length === 2);
    check("place resolved from cache (no Google key needed)", after1?.placeId === club.id, after1?.placeId);
    check("filing record: by auto, Dev Patel created, both people touched",
      after1?.filing?.by === "auto" && after1.filing.created.some((c) => c.name === DEV) && after1.filing.peopleIds.length === 2 && !!after1.filing.decisions,
      after1?.filing);

    const clubAfter = await db().query.places.findFirst({ where: eq(places.id, club.id) });
    check("place visit count incremented 3 -> 4", clubAfter?.visitCount === 4, clubAfter?.visitCount);

    const [dev] = await peopleNamed(userId, DEV);
    check("new person created with the tag the note proposed", dev?.tags?.some((t) => t.includes("Bishop Arts")), dev?.tags);
    check("new person carries the proposed tag", JSON.stringify(dev?.tags) === JSON.stringify([`${MARK} Bishop Arts`]), dev?.tags);
    const marcusTagged = await db().query.people.findFirst({ where: eq(people.id, marcus.id) });
    check("matched person keeps his tag in its own spelling and gains the new one",
      JSON.stringify(marcusTagged?.tags) === JSON.stringify([GOLF, `${MARK} Board`]), marcusTagged?.tags);
    check("model was given the user's tags and each candidate's",
      (lastExtractInput?.tags ?? []).includes(GOLF) && lastExtractInput?.candidates.find((c) => c.id === marcus.id)?.tags.includes(GOLF) === true,
      lastExtractInput?.tags);

    const f = await factsOf(c1.id);
    check("2 facts filed (orphan excluded)", f.length === 2, f.length);
    check("relation fact is pinned", f.find((x) => x.kind === "relation")?.pinned === true);
    check("facts carry a 1536-dim embedding", f.every((x) => Array.isArray(x.embedding) && x.embedding.length === DIM));

    const ix = await interactionsOf(c1.id);
    check("2 interactions filed", ix.length === 2, ix.length);
    check("interaction with a bad date fell back to capturedAt", ix.every((x) => !Number.isNaN(x.occurredAt.getTime())));
    check("interactions tagged with the place", ix.every((x) => x.placeId === club.id));

    const th = await db().select().from(threads).where(eq(threads.userId, userId));
    const closed = th.find((t) => t.id === openThread.id);
    const created = th.find((t) => t.createdFromCaptureId === c1.id);
    check("open thread closed by this capture", closed?.status === "done" && closed.closedByCaptureId === c1.id, closed?.status);
    check("new thread created with due date", !!created?.dueAt, created);

    const loose = await looseOf(c1.id);
    check("2 loose threads: the unresolved line plus the orphaned fact", loose.length === 2, loose.map((l) => l.content));

    const marcusAfter = await db().query.people.findFirst({ where: eq(people.id, marcus.id) });
    check("warmth recomputed on the matched person", (marcusAfter?.warmth ?? 0) >= 90 && !!marcusAfter?.lastInteractionAt, marcusAfter?.warmth);

    const pp = await db().select().from(personPlaces).where(eq(personPlaces.placeId, club.id));
    check("person_places linked for both people", pp.length === 2, pp.length);
    check("model was given NOW with a weekday and a calendar", /^(Sun|Mon|Tues|Wednes|Thurs|Fri|Satur)day, /.test(lastExtractInput?.now ?? "") && /\(today\), .*\(tomorrow\)/.test(lastExtractInput?.dateContext ?? ""), { now: lastExtractInput?.now, cal: lastExtractInput?.dateContext?.slice(0, 60) });

    /* ---- 2. re-run the same capture: replace, never double ---- */
    console.log("\n2. same capture processed again (what a queue retry looks like)");
    await processCapture({ captureId: c1.id, userId }, env, models(extraction1));
    const pp2 = await db().select().from(personPlaces).where(and(eq(personPlaces.placeId, club.id), eq(personPlaces.personId, marcus.id)));
    check("person_places weight rebuilt from interactions, still 1", pp2[0]?.weight === 1, pp2[0]?.weight);
    const devs2 = await peopleNamed(userId, DEV);
    check("the new person was reused, not created twice", devs2.length === 1 && devs2[0].id === dev.id, devs2.length);
    const f2 = await factsOf(c1.id);
    const ix2 = await interactionsOf(c1.id);
    const loose2 = await looseOf(c1.id);
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
      ...empty, people: [{ matchedPersonId: marcus.id, name: "Marcus", confidence: 0.99, isNew: false }],
    }));
    const after3 = await captureRow(c3.id);
    check("did not throw 'Empty transcript', filed from the saved transcript", after3?.status === "filed", after3?.status);
    await db().delete(captures).where(eq(captures.id, c3.id));

    /* ---- 4. low confidence waits, and files nothing until confirmed ---- */
    console.log("\n4. low confidence match: stored, nothing filed");
    const [c4] = await db().insert(captures).values({
      userId, kind: "text", status: "uploaded", rawText: `${MARK} maybe Marcus, maybe not`, capturedAt: new Date(),
    }).returning();
    const extraction4: Extraction = {
      ...empty,
      people: [{ matchedPersonId: marcus.id, name: "Marcus", confidence: 0.6, isNew: false }],
      facts: [{ personName: "Marcus", kind: "context", content: "Thinking about a new plane", confidence: 0.8 }],
      interactions: [{ personName: "Marcus", summary: "Quick chat", occurredAt: new Date().toISOString(), channel: "call" }],
    };
    await processCapture({ captureId: c4.id, userId }, env, models(extraction4));
    const after4 = await captureRow(c4.id);
    check("status is needs_review", after4?.status === "needs_review", after4?.status);
    check("extraction stored, no filing record yet", after4?.extraction?.people.length === 1 && after4.filing == null);
    check("nothing filed: 0 facts, 0 interactions, 0 loose", (await factsOf(c4.id)).length === 0 && (await interactionsOf(c4.id)).length === 0 && (await looseOf(c4.id)).length === 0);

    console.log("   ...then confirmed as proposed");
    const r4 = await fileCapture({ userId, captureId: c4.id, by: "user", embed });
    const after4b = await captureRow(c4.id);
    check("confirm files it: status filed, by user", after4b?.status === "filed" && after4b.filing?.by === "user", after4b?.filing);
    check("1 fact and 1 interaction landed on Marcus", (await factsOf(c4.id)).length === 1 && (await interactionsOf(c4.id)).length === 1);
    check("counts reported", r4.counts.people === 1 && r4.counts.facts === 1, r4.counts);
    await fileCapture({ userId, captureId: c4.id, by: "user", embed });
    check("confirming again changes nothing: still 1 fact, 1 interaction", (await factsOf(c4.id)).length === 1 && (await interactionsOf(c4.id)).length === 1);

    /* ---- 9. a waiting note confirmed with fixes, then fixed again ---- */
    console.log("\n9. waiting note filed with edits: tags, dropped fact, attached and dismissed loose threads, cleared place");
    const DEV2 = `${MARK} Dev Patel 2`;
    const [c9] = await db().insert(captures).values({
      userId, kind: "text", status: "uploaded", rawText: `${MARK} met another Dev`,
      placeHint: "pipeline check brook hollow", capturedAt: new Date(),
    }).returning();
    const extraction9: Extraction = {
      ...empty,
      people: [{ matchedPersonId: null, name: DEV2, confidence: 0.5, isNew: true, role: "the other Dev" }],
      facts: [
        { personName: DEV2, kind: "context", content: "Keep this one", confidence: 0.9 },
        { personName: DEV2, kind: "context", content: "Drop this one", confidence: 0.9 },
      ],
      interactions: [{ personName: DEV2, summary: "Met at the club", occurredAt: new Date().toISOString(), channel: "in_person" }],
      unresolved: [`${MARK} loose a, goes to Marcus`, `${MARK} loose b, dismissed`],
    };
    await processCapture({ captureId: c9.id, userId }, env, models(extraction9));
    const after9 = await captureRow(c9.id);
    check("waits: needs_review with the typed place resolved", after9?.status === "needs_review" && after9.placeId === club.id, [after9?.status, after9?.placeId]);
    check("no person created while waiting", (await peopleNamed(userId, DEV2)).length === 0);

    const decisions9: FilingDecisions = {
      ...defaultDecisions(extraction9, club.id),
      people: [{ action: "new", personId: null, tags: [`${MARK} Work Group`, ` ${MARK} work group `] }],
      // The first fact is re-filed under a different heading than the model
      // chose; the second is dropped.
      facts: [{ keep: true, kind: "work" }, { keep: false }],
      unresolved: [{ personId: marcus.id, dismissed: false }, { personId: null, dismissed: true }],
      place: { placeId: null, name: null },
      // Typed on the review screen. The second names nobody in the note, so
      // it must become a loose thread rather than disappear.
      added: [
        { personName: DEV2, kind: "travel", text: "Banff in March, same lodge as last year" },
        { personName: "Nobody In This Note", kind: "work", text: `${MARK} added for a name the model never listed` },
      ],
    };
    await fileCapture({ userId, captureId: c9.id, decisions: decisions9, by: "user", embed });
    const [dev2] = await peopleNamed(userId, DEV2);
    const after9b = await captureRow(c9.id);
    const f9 = await factsOf(c9.id);
    const loose9 = await looseOf(c9.id);
    check("new person created with the typed tags, one spelling", dev2?.tags?.filter((t) => /work group/i.test(t)).length === 1, dev2?.tags);
    check("typed tags: trimmed, one spelling, no duplicate", JSON.stringify(dev2?.tags) === JSON.stringify([`${MARK} Work Group`]), dev2?.tags);
    check("dropped fact stayed out; attached loose thread became a fact on Marcus",
      f9.length === 3 && f9.some((x) => x.personId === dev2?.id && x.content === "Keep this one") && f9.some((x) => x.personId === marcus.id && x.kind === "context" && x.content.includes("loose a")),
      f9.map((x) => [x.content, x.personId === marcus.id ? "marcus" : "dev2"]));
    check("the kind the user picked replaced the model's",
      f9.find((x) => x.content === "Keep this one")?.kind === "work",
      f9.find((x) => x.content === "Keep this one")?.kind);
    const typed = f9.find((x) => x.content.startsWith("Banff"));
    check("a fact typed on the review screen is filed, with its kind and full confidence",
      typed?.personId === dev2?.id && typed?.kind === "travel" && typed?.confidence === 1, typed);
    check("loose rows: one resolved to Marcus, one dismissed, one from a typed fact naming nobody",
      loose9.length === 3 && loose9.some((l) => l.resolvedPersonId === marcus.id) && loose9.some((l) => l.dismissedAt != null)
        && loose9.some((l) => l.content.includes("Nobody In This Note")), loose9);
    const ix9 = await interactionsOf(c9.id);
    check("place cleared: capture and interaction carry none", after9b?.placeId == null && ix9.length === 1 && ix9[0].placeId == null, [after9b?.placeId, ix9[0]?.placeId]);
    check("decisions stored with the created person's id", after9b?.filing?.decisions?.people[0].personId === dev2?.id && after9b?.filing?.created[0]?.personId === dev2?.id, after9b?.filing);
    const dev2Warm = await db().query.people.findFirst({ where: eq(people.id, dev2.id) });
    check("new person's last seen came from the interaction", !!dev2Warm?.lastInteractionAt);

    console.log("   ...then that person is left out");
    await fileCapture({ userId, captureId: c9.id, decisions: { ...after9b!.filing!.decisions!, people: [{ action: "drop", personId: dev2.id }] }, by: "user", embed });
    check("person row this note created is gone", (await peopleNamed(userId, DEV2)).length === 0);
    const f9b = await factsOf(c9.id);
    check("only the attached fact on Marcus remains; the typed fact went with its person",
      f9b.length === 1 && f9b[0].personId === marcus.id && (await interactionsOf(c9.id)).length === 0, f9b.length);

    console.log("   ...then brought back as new, twice");
    const back: FilingDecisions = { ...after9b!.filing!.decisions!, people: [{ action: "new", personId: dev2.id, tags: [] }] };
    await fileCapture({ userId, captureId: c9.id, decisions: back, by: "user", embed });
    await fileCapture({ userId, captureId: c9.id, decisions: back, by: "user", embed });
    const dev2s = await peopleNamed(userId, DEV2);
    check("exactly one row again", dev2s.length === 1, dev2s.length);
    check("an empty tag list on the screen clears the tags", dev2s[0]?.tags.length === 0, dev2s[0]?.tags);
    // 3 facts: the one kept, the one typed, and the loose thread attached to
    // Marcus. 3 loose: attached, dismissed, and the typed one naming nobody.
    const f9c = await factsOf(c9.id);
    check("3 facts, 1 interaction, 3 loose, no duplicates",
      f9c.length === 3 && (await interactionsOf(c9.id)).length === 1 && (await looseOf(c9.id)).length === 3,
      f9c.map((x) => [x.kind, x.content.slice(0, 24)]));
    check("the typed fact came back with its kind, not the default",
      f9c.find((x) => x.content.startsWith("Banff"))?.kind === "travel", f9c.map((x) => x.kind));

    /* ---- 10. a re-run asks for a look, and keeps what was filed until it gets one ---- */
    console.log("\n10. re-run with review: true on a note that filed itself");
    await processCapture({ captureId: c1.id, userId, review: true }, env, models(extraction1));
    const after10 = await captureRow(c1.id);
    check("status is needs_review", after10?.status === "needs_review", after10?.status);
    check("old rows still there: 2 facts", (await factsOf(c1.id)).length === 2);
    check("filing kept what it created, decisions dropped", !!after10?.filing?.created.some((c) => c.personId === dev.id) && after10?.filing?.decisions === null, after10?.filing);
    await fileCapture({ captureId: c1.id, userId, by: "user", embed });
    check("confirmed: filed, one Dev Patel, 2 facts", (await captureRow(c1.id))?.status === "filed" && (await peopleNamed(userId, DEV)).length === 1 && (await factsOf(c1.id)).length === 2);

    console.log("   ...then re-read without Dev Patel in it");
    await processCapture({ captureId: c1.id, userId }, env, models({ ...extraction1, people: [extraction1.people[0]], facts: [extraction1.facts[0]], interactions: [extraction1.interactions[0]] }));
    check("filed itself again", (await captureRow(c1.id))?.status === "filed");
    check("a person the model stopped listing keeps the row it was given", (await peopleNamed(userId, DEV)).length === 1 && (await factsOf(c1.id)).length === 1);
    check("and stays in the record as this note's", (await captureRow(c1.id))?.filing?.created.some((c) => c.personId === dev.id) === true);
    await processCapture({ captureId: c1.id, userId }, env, models(extraction1));
    check("listed again: the same row, no second Dev Patel", (await peopleNamed(userId, DEV)).length === 1 && (await peopleNamed(userId, DEV))[0].id === dev.id);

    /* ---- 11. notes filed before the filing record existed ---- */
    console.log("\n11. legacy note: person rows found by name and time, removed on leave out when unreferenced");
    const LEGACY = `${MARK} Legacy Person`;
    const KEPT = `${MARK} Legacy Kept`;
    const extraction11: Extraction = {
      ...empty,
      people: [
        { matchedPersonId: null, name: LEGACY, confidence: 0.9, isNew: true },
        { matchedPersonId: null, name: KEPT, confidence: 0.9, isNew: true },
      ],
      facts: [
        { personName: LEGACY, kind: "context", content: "old fact", confidence: 0.9 },
        { personName: KEPT, kind: "context", content: "old fact on the kept one", confidence: 0.9 },
      ],
    };
    const [c11] = await db().insert(captures).values({
      userId, kind: "text", status: "needs_review", rawText: `${MARK} legacy`, capturedAt: new Date(), extraction: extraction11,
    }).returning();
    const [legacy] = await db().insert(people).values({ userId, displayName: LEGACY }).returning();
    const [kept] = await db().insert(people).values({ userId, displayName: KEPT }).returning();
    await db().insert(facts).values([
      { userId, personId: legacy.id, kind: "context", content: "old fact", captureId: c11.id },
      { userId, personId: kept.id, kind: "context", content: "old fact on the kept one", captureId: c11.id },
      { userId, personId: kept.id, kind: "context", content: "a fact from some other note", captureId: c1.id },
    ]);
    const recon = await reconstructFiling(userId, (await captureRow(c11.id))!);
    check("reconstruction: both rows recognised as created by this note", recon.by === "legacy" && recon.created.length === 2 && recon.peopleIds.length === 2, recon);
    const fresh = await captureRow(c4.id);
    check("a note that never filed rows reconstructs nothing", (await reconstructFiling(userId, { ...fresh!, extraction: extraction1 })).created.length === 0);
    await fileCapture({ userId, captureId: c11.id, decisions: { ...defaultDecisions(extraction11, null), people: [{ action: "drop", personId: null }, { action: "drop", personId: null }] }, by: "user", embed });
    check("unreferenced legacy person removed", (await peopleNamed(userId, LEGACY)).length === 0);
    const keptRows = await peopleNamed(userId, KEPT);
    const keptFacts = await db().select().from(facts).where(eq(facts.personId, kept.id));
    check("legacy person another note wrote about survives, with that note's fact", keptRows.length === 1 && keptFacts.length === 1 && keptFacts[0].captureId === c1.id, [keptRows.length, keptFacts.length]);

    /* ---- 12. many new people wait ---- */
    console.log("\n12. review reasons");
    const three: Extraction = { ...empty, people: [1, 2, 3].map((i) => ({ matchedPersonId: null, name: `${MARK} Roster ${i}`, confidence: 0.95, isNew: true })) };
    check(`${NEW_PEOPLE_REVIEW_AT} new people wait even at 95%`, reviewReason(three) !== null, reviewReason(three));
    check("two new people at 95% file themselves", reviewReason({ ...three, people: three.people.slice(0, 2) }) === null);
    check("a hedged person (no match, not new) waits", reviewReason({ ...empty, people: [{ matchedPersonId: null, name: "?", confidence: 0.95, isNew: false }] }) !== null);
    const [c12] = await db().insert(captures).values({ userId, kind: "text", status: "uploaded", rawText: `${MARK} roster`, capturedAt: new Date() }).returning();
    await processCapture({ captureId: c12.id, userId }, env, models(three));
    check("roster note stops at needs_review with nobody created", (await captureRow(c12.id))?.status === "needs_review" && (await peopleNamed(userId, `${MARK} Roster 1`)).length === 0);

    /* ---- 13. warmth follows the interaction's date, not the note's ---- */
    console.log("\n13. a note today about a meeting 200 days ago");
    const OLD = `${MARK} Old Friend`;
    // Their own cadence, so the check does not read whatever the account's
    // default happens to be. Circles used to supply this and no longer do.
    const [old] = await db().insert(people).values({ userId, displayName: OLD, cadenceDays: 21 }).returning();
    const then = new Date(Date.now() - 200 * 86_400_000);
    const [c13] = await db().insert(captures).values({ userId, kind: "text", status: "uploaded", rawText: `${MARK} old meeting`, capturedAt: new Date() }).returning();
    await processCapture({ captureId: c13.id, userId }, env, models({
      ...empty,
      people: [{ matchedPersonId: old.id, name: OLD, confidence: 0.99, isNew: false }],
      interactions: [{ personName: OLD, summary: "Coffee, back in the spring", occurredAt: then.toISOString(), channel: "in_person" }],
    }));
    const oldAfter = await db().query.people.findFirst({ where: eq(people.id, old.id) });
    check("last seen is the meeting's date", !!oldAfter?.lastInteractionAt && Math.abs(oldAfter.lastInteractionAt.getTime() - then.getTime()) < 60_000, oldAfter?.lastInteractionAt);
    check("warmth reflects 200 days of silence against their own 21 days", (oldAfter?.warmth ?? 100) < 20, oldAfter?.warmth);

    /* ---- 14. a filing that dies after the people are made ---- */
    // What happened to a real roster note: forty-three people, inserted one
    // at a time, and the request was cancelled partway. The rows existed and
    // the capture had no record of them, so the next File it made them again.
    console.log("\n14. a filing that dies partway does not double the people on retry");
    const ROSTER = [1, 2, 3, 4, 5].map((i) => `${MARK} Crash ${i}`);
    const [c14] = await db().insert(captures).values({
      userId, kind: "text", status: "needs_review", rawText: `${MARK} a list of names`, capturedAt: new Date(),
    }).returning();
    const extraction14: Extraction = {
      ...empty,
      people: ROSTER.map((n) => ({ matchedPersonId: null, name: n, confidence: 0.6, isNew: true })),
      facts: ROSTER.map((n) => ({ personName: n, kind: "work" as const, content: `${MARK} on the list`, confidence: 0.9 })),
    };
    await db().update(captures).set({ extraction: extraction14 }).where(eq(captures.id, c14.id));
    const boom = async () => { throw new Error("pipeline check: embedding died"); };
    let threw = false;
    try {
      await fileCapture({ userId, captureId: c14.id, decisions: defaultDecisions(extraction14, null), by: "user", embed: boom });
    } catch { threw = true; }
    check("the filing failed, as arranged", threw);
    const made14 = await db().select({ id: people.id }).from(people)
      .where(and(eq(people.userId, userId), inArray(people.displayName, ROSTER)));
    const rec14 = await captureRow(c14.id);
    check("the people it made exist", made14.length === ROSTER.length, made14.length);
    check("and the note knows it made them, even though it never finished",
      (rec14?.filing?.created ?? []).length === ROSTER.length, rec14?.filing?.created?.length);
    check("nothing else was written", (await factsOf(c14.id)).length === 0 && rec14?.status === "needs_review", rec14?.status);

    await fileCapture({ userId, captureId: c14.id, decisions: defaultDecisions(extraction14, null), by: "user", embed });
    const again14 = await db().select({ id: people.id }).from(people)
      .where(and(eq(people.userId, userId), inArray(people.displayName, ROSTER)));
    check("the retry reused every row instead of doubling it", again14.length === ROSTER.length, again14.length);
    check("and this time it filed", (await captureRow(c14.id))?.status === "filed" && (await factsOf(c14.id)).length === ROSTER.length);

    /* ---- 6. a typed place name finds an existing place, fuzzily ---- */
    console.log("\n6. typed place, lowercase and partial, matches the known club");
    const [c6] = await db().insert(captures).values({
      userId, kind: "text", status: "uploaded", rawText: `${MARK} saw Marcus at the club`,
      placeHint: "pipeline check brook hollow", lat: -45.0002, lng: -130.0002, capturedAt: new Date(),
    }).returning();
    await processCapture({ captureId: c6.id, userId }, env, models({
      ...empty,
      people: [{ matchedPersonId: marcus.id, name: "Marcus", confidence: 0.97, isNew: false }],
      interactions: [{ personName: "Marcus", summary: "Saw him at the club", occurredAt: new Date().toISOString(), channel: "in_person" }],
    }));
    const after6 = await captureRow(c6.id);
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
      ...empty,
      people: [{ matchedPersonId: marcus.id, name: "Marcus", confidence: 0.97, isNew: false }],
      interactions: [{ personName: "Marcus", summary: "Dinner", occurredAt: new Date().toISOString(), channel: "in_person" }],
    }));
    const parents = await db().query.places.findFirst({ where: and(eq(places.userId, userId), eq(places.name, `${MARK} Alex's Parents`)) });
    check("new place created from the typed name", !!parents, parents);
    check("new place has no coordinates", parents?.lat == null && parents?.lng == null);
    const ix7 = await interactionsOf(c7.id);
    check("interaction tagged with the new place and no coordinates", ix7[0]?.placeId === parents?.id && ix7[0]?.lat == null);

    /* ---- 8. naming the place you are at teaches its coordinates ---- */
    console.log("\n8. 'Here' with a name learns where the place is, then plain GPS finds it");
    const [c8] = await db().insert(captures).values({
      userId, kind: "text", status: "uploaded", rawText: `${MARK} at the range`,
      placeHint: `${MARK} Alex's Parents`, lat: -46.0000, lng: -131.0000, capturedAt: new Date(),
    }).returning();
    await processCapture({ captureId: c8.id, userId }, env, models(empty));
    const learned = await db().query.places.findFirst({ where: eq(places.id, parents!.id) });
    check("existing place learned coordinates from a visit there", learned?.lat === -46 && learned?.lng === -131, [learned?.lat, learned?.lng]);
    const [c8b] = await db().insert(captures).values({
      userId, kind: "text", status: "uploaded", rawText: `${MARK} back at the range, no name typed`,
      lat: -46.0003, lng: -131.0002, capturedAt: new Date(),
    }).returning();
    await processCapture({ captureId: c8b.id, userId }, env, models(empty));
    const after8b = await captureRow(c8b.id);
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
