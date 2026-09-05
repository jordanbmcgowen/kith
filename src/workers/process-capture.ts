/**
 * Queue consumer: raw capture -> filed memory.
 *
 * Deployed as a separate Worker bound to the same R2 bucket and Neon database.
 * Kept off the request path so the phone never waits, and so a model outage
 * delays notes rather than losing them.
 */
import { db, captures, people, facts, interactions, threads, places, personPlaces, looseThreads } from "../db";
import { transcribe } from "../lib/ai/transcribe";
import { extract, AUTO_FILE_THRESHOLD, type Candidate } from "../lib/ai/extract";
import { embed } from "../lib/ai/embed";
import { warmth, cadenceFor } from "../lib/warmth";
import { bbox, haversineM } from "../lib/geo";
import { and, eq, gte, lte, isNull, sql } from "drizzle-orm";

type Msg = { captureId: string; userId: string };

export default {
  async queue(batch: MessageBatch<Msg>, env: Env) {
    for (const msg of batch.messages) {
      try {
        await processCapture(msg.body, env);
        msg.ack();
      } catch (err) {
        console.error("capture failed", msg.body.captureId, err);
        await db().update(captures)
          .set({ status: "failed", error: String(err) })
          .where(eq(captures.id, msg.body.captureId));
        // Retry twice, then leave it failed and visible in the app rather than
        // silently gone.
        if (msg.attempts < 3) msg.retry({ delaySeconds: 30 * msg.attempts });
        else msg.ack();
      }
    }
  },
};

export async function processCapture({ captureId, userId }: Msg, env: Env) {
  const capture = await db().query.captures.findFirst({
    where: and(eq(captures.id, captureId), eq(captures.userId, userId)),
  });
  if (!capture) return;

  const roster = await db().query.people.findMany({
    where: and(eq(people.userId, userId), isNull(people.archivedAt)),
    with: { facts: { where: (f, { eq: e }) => e(f.pinned, true), limit: 3 } },
    limit: 500,
  });

  /* 1. transcribe ------------------------------------------------------- */
  let transcript = capture.rawText ?? "";
  if (capture.audioKey && !capture.transcript) {
    await db().update(captures).set({ status: "transcribing" }).where(eq(captures.id, captureId));
    const obj = await env.AUDIO.get(capture.audioKey);
    if (!obj) throw new Error("Audio object missing from R2");

    const out = await transcribe({
      audio: await obj.blob(),
      filename: "note.webm",
      // The names hint is what keeps unusual names from being mangled.
      nameHints: roster.flatMap((p) => [p.displayName, p.goesBy].filter(Boolean) as string[]),
    });
    transcript = out.text;
    await db().update(captures)
      .set({ transcript, durationSec: out.durationSec })
      .where(eq(captures.id, captureId));
  }
  if (!transcript.trim()) throw new Error("Empty transcript");

  /* 2. resolve place ---------------------------------------------------- */
  const place = capture.lat != null && capture.lng != null
    ? await resolvePlace(userId, capture.lat, capture.lng, env)
    : null;

  /* 3. extract ---------------------------------------------------------- */
  await db().update(captures).set({ status: "extracting" }).where(eq(captures.id, captureId));

  const nearIds = place
    ? new Set((await db().select().from(personPlaces).where(
        and(eq(personPlaces.userId, userId), eq(personPlaces.placeId, place.id)))).map((l) => l.personId))
    : new Set<string>();

  const candidates: Candidate[] = roster.map((p) => ({
    id: p.id,
    displayName: p.displayName,
    goesBy: p.goesBy,
    circle: p.circle,
    role: p.role,
    nearHere: nearIds.has(p.id),
    topFacts: (p as any).facts?.map((f: any) => f.content) ?? [],
  }));

  const open = await db().query.threads.findMany({
    where: and(eq(threads.userId, userId), eq(threads.status, "open")),
    limit: 40,
  });

  const result = await extract({
    transcript,
    now: capture.capturedAt.toISOString(),
    timezone: "America/Chicago",
    placeName: place?.name ?? null,
    candidates,
    openThreads: open.map((t) => ({
      id: t.id,
      personName: roster.find((p) => p.id === t.personId)?.displayName ?? "",
      title: t.title,
    })),
  });

  /* 4. file ------------------------------------------------------------- */
  const lowConfidence = result.people.some((p) => p.confidence < AUTO_FILE_THRESHOLD);
  const nameToId = new Map<string, string>();

  for (const p of result.people) {
    if (p.matchedPersonId) { nameToId.set(p.name, p.matchedPersonId); continue; }
    if (!p.isNew) continue;
    const [row] = await db().insert(people).values({
      userId,
      displayName: p.name,
      circle: (p.circle ?? "other") as any,
      role: p.role ?? null,
    }).returning();
    nameToId.set(p.name, row.id);
  }

  const factRows = result.facts
    .filter((f) => nameToId.has(f.personName))
    .map((f) => ({
      userId, personId: nameToId.get(f.personName)!, kind: f.kind as any,
      content: f.content, confidence: f.confidence, captureId,
      pinned: f.kind === "relation" || f.kind === "identity" || f.kind === "sensitive",
    }));

  const interactionRows = result.interactions
    .filter((i) => nameToId.has(i.personName))
    .map((i) => ({
      userId, personId: nameToId.get(i.personName)!, captureId,
      placeId: place?.id ?? null,
      occurredAt: new Date(i.occurredAt), channel: i.channel,
      summary: i.summary, lat: capture.lat, lng: capture.lng,
    }));

  // Embed facts and interactions together so search covers both.
  const vectors = await embed([...factRows.map((f) => f.content), ...interactionRows.map((i) => i.summary)]);
  factRows.forEach((f, i) => Object.assign(f, { embedding: vectors[i] }));
  interactionRows.forEach((r, i) => Object.assign(r, { embedding: vectors[factRows.length + i] }));

  if (factRows.length) await db().insert(facts).values(factRows as any);
  if (interactionRows.length) await db().insert(interactions).values(interactionRows as any);

  for (const t of result.threads) {
    if (!nameToId.has(t.personName)) continue;
    await db().insert(threads).values({
      userId, personId: nameToId.get(t.personName)!, title: t.title,
      dueAt: t.dueAt ? new Date(t.dueAt) : null, createdFromCaptureId: captureId,
    });
  }

  for (const id of result.closesThreadIds) {
    await db().update(threads)
      .set({ status: "done", completedAt: new Date(), closedByCaptureId: captureId })
      .where(and(eq(threads.id, id), eq(threads.userId, userId)));
  }

  for (const text of result.unresolved) {
    await db().insert(looseThreads).values({ userId, captureId, content: text });
  }

  /* 5. bookkeeping ------------------------------------------------------ */
  for (const personId of new Set(interactionRows.map((r) => r.personId))) {
    const person = roster.find((p) => p.id === personId);
    const recent = await db().select({ n: sql<number>`count(*)` }).from(interactions)
      .where(and(eq(interactions.personId, personId),
                 gte(interactions.occurredAt, new Date(Date.now() - 90 * 86_400_000))));

    await db().update(people).set({
      lastInteractionAt: capture.capturedAt,
      updatedAt: new Date(),
      warmth: warmth({
        lastInteractionAt: capture.capturedAt,
        cadenceDays: person ? cadenceFor(person, { family: 14, friends: 21, work: 45, neighbors: 30, other: 90 }) : 45,
        interactionsLast90: Number(recent[0]?.n ?? 0),
      }),
    }).where(eq(people.id, personId));

    if (place) {
      await db().insert(personPlaces)
        .values({ userId, personId, placeId: place.id, weight: 1, lastSeenAt: capture.capturedAt })
        .onConflictDoUpdate({
          target: [personPlaces.personId, personPlaces.placeId],
          set: { weight: sql`${personPlaces.weight} + 1`, lastSeenAt: capture.capturedAt },
        });
    }
  }

  await db().update(captures).set({
    status: lowConfidence ? "needs_review" : "filed",
    extraction: result as any,
    placeId: place?.id ?? null,
  }).where(eq(captures.id, captureId));
}

/**
 * Matches coordinates to a place you already know before asking Google. Most
 * captures happen at the handful of places you actually go, so this keeps the
 * Places bill near zero.
 */
async function resolvePlace(userId: string, lat: number, lng: number, env: Env) {
  const b = bbox(lat, lng, 400);
  const known = await db().select().from(places).where(and(
    eq(places.userId, userId),
    gte(places.lat, b.minLat), lte(places.lat, b.maxLat),
    gte(places.lng, b.minLng), lte(places.lng, b.maxLng),
  ));

  const hit = known
    .filter((p) => p.lat != null && p.lng != null)
    .map((p) => ({ p, d: haversineM({ lat, lng }, { lat: p.lat!, lng: p.lng! }) }))
    .filter((x) => x.d <= x.p.radiusM)
    .sort((a, c) => a.d - c.d)[0];

  if (hit) {
    await db().update(places)
      .set({ visitCount: sql`${places.visitCount} + 1`, lastVisitedAt: new Date() })
      .where(eq(places.id, hit.p.id));
    return hit.p;
  }

  if (!env.GOOGLE_PLACES_KEY) return null;
  const res = await fetch("https://places.googleapis.com/v1/places:searchNearby", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": env.GOOGLE_PLACES_KEY,
      "X-Goog-FieldMask": "places.id,places.displayName,places.location",
    },
    body: JSON.stringify({
      maxResultCount: 1,
      locationRestriction: { circle: { center: { latitude: lat, longitude: lng }, radius: 90 } },
    }),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as any;
  const g = json.places?.[0];
  if (!g) return null;

  const [row] = await db().insert(places).values({
    userId,
    name: g.displayName?.text ?? "Unnamed place",
    googlePlaceId: g.id,
    lat: g.location?.latitude ?? lat,
    lng: g.location?.longitude ?? lng,
    visitCount: 1,
    lastVisitedAt: new Date(),
  }).onConflictDoUpdate({
    target: [places.userId, places.googlePlaceId],
    set: { visitCount: sql`${places.visitCount} + 1`, lastVisitedAt: new Date() },
  }).returning();

  return row;
}

interface Env {
  AUDIO: R2Bucket;
  GOOGLE_PLACES_KEY?: string;
}
