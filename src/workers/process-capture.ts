/**
 * Queue consumer: raw capture -> filed memory.
 *
 * Deployed as a separate Worker bound to the same R2 bucket and Neon database.
 * Kept off the request path so the phone never waits, and so a model outage
 * delays notes rather than losing them.
 *
 * Secrets (DATABASE_URL, OPENAI_API_KEY, ANTHROPIC_API_KEY) are read through
 * process.env, which Cloudflare populates from Worker secrets when
 * nodejs_compat is on and the compatibility date is 2025-04-01 or later.
 * Both are set in wrangler.worker.jsonc.
 */
import { db, captures, people, facts, interactions, threads, places, personPlaces, looseThreads } from "../db";
import { transcribe } from "../lib/ai/transcribe";
import { extract, AUTO_FILE_THRESHOLD, type Candidate } from "../lib/ai/extract";
import { embed } from "../lib/ai/embed";
import { warmth, cadenceFor } from "../lib/warmth";
import { bbox, haversineM } from "../lib/geo";
import { audioExtension } from "../lib/audio";
import { and, eq, gte, lte, isNull, sql } from "drizzle-orm";

type Msg = { captureId: string; userId: string };

/** How many deliveries before a capture is left `failed` and visible. */
const MAX_ATTEMPTS = 3;

/**
 * An error that a retry cannot fix: silence, a missing object, a rejected
 * request. Retrying these only burns three Whisper calls before reaching the
 * same failed state.
 */
class PermanentError extends Error {
  readonly permanent = true;
}

const isPermanent = (err: unknown) => {
  const e = err as { permanent?: boolean; status?: number } | null;
  if (e?.permanent) return true;
  // 4xx from a model API means the request itself is bad, not the moment.
  return typeof e?.status === "number" && e.status >= 400 && e.status < 500 && e.status !== 429;
};

export default {
  async queue(batch: MessageBatch<Msg>, env: Env) {
    for (const msg of batch.messages) {
      const { captureId } = msg.body;
      try {
        await processCapture(msg.body, env);
        msg.ack();
      } catch (err) {
        const giveUp = isPermanent(err) || msg.attempts >= MAX_ATTEMPTS;
        console.error(`[capture ${captureId}] attempt ${msg.attempts} failed${giveUp ? ", giving up" : ", will retry"}:`, err);
        // Record the error on every attempt so it is visible in the app, but
        // only flip the status to failed once we are done trying. A note that
        // is about to be retried is not failed yet.
        await db().update(captures)
          .set(giveUp ? { status: "failed", error: String(err) } : { error: String(err) })
          .where(eq(captures.id, captureId));
        if (giveUp) msg.ack();
        else msg.retry({ delaySeconds: 30 * msg.attempts });
      }
    }
  },

  async scheduled(controller: ScheduledController) {
    // Phase 3: threads due today, birthdays this week, warmth that just
    // dropped below cadence. Nothing runs yet; this exists so the cron in
    // wrangler.worker.jsonc has a handler and does not error every morning.
    console.log(`scheduled ${controller.cron}: nothing to do until Phase 3`);
  },
};

/**
 * The three model calls, injectable so scripts/pipeline-check.ts can run the
 * whole filing path against a real database without spending a cent or
 * needing a key. Production never passes this argument.
 */
export type Models = { transcribe: typeof transcribe; extract: typeof extract; embed: typeof embed };
const LIVE: Models = { transcribe, extract, embed };

export async function processCapture({ captureId, userId }: Msg, env: Env, models: Models = LIVE) {
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
  // A retry after a successful transcription must reuse it, not start from
  // rawText, which is empty for a voice note.
  let transcript = capture.transcript ?? capture.rawText ?? "";
  if (capture.audioKey && !capture.transcript) {
    console.log(`[capture ${captureId}] transcribe ${capture.audioKey}`);
    await db().update(captures).set({ status: "transcribing" }).where(eq(captures.id, captureId));
    const obj = await env.AUDIO.get(capture.audioKey);
    if (!obj) throw new PermanentError("Audio object missing from R2");

    // The filename extension and the content type both have to match the
    // bytes: iOS records mp4, Chrome records webm, and Whisper rejects a
    // mismatch. The extension was chosen at upload time from the same table.
    const ext = capture.audioKey.split(".").pop() || audioExtension(obj.httpMetadata?.contentType);
    const type = obj.httpMetadata?.contentType || `audio/${ext}`;
    const audio = new Blob([await obj.arrayBuffer()], { type });

    const out = await models.transcribe({
      audio,
      filename: `note.${ext}`,
      // The names hint is what keeps unusual names from being mangled.
      nameHints: roster.flatMap((p) => [p.displayName, p.goesBy].filter(Boolean) as string[]),
    });
    transcript = out.text;
    await db().update(captures)
      .set({ transcript, durationSec: out.durationSec })
      .where(eq(captures.id, captureId));
    console.log(`[capture ${captureId}] transcribed ${out.durationSec}s, ${transcript.length} chars`);
  }
  if (!transcript.trim()) throw new PermanentError("Empty transcript. Nothing was said, or the microphone was muted.");

  /* 2. resolve place ---------------------------------------------------- */
  const place = capture.lat != null && capture.lng != null
    ? await resolvePlace(userId, capture.lat, capture.lng, env)
    : null;

  /* 3. extract ---------------------------------------------------------- */
  console.log(`[capture ${captureId}] extract (${roster.length} candidates, place: ${place?.name ?? "none"})`);
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
    topFacts: p.facts.map((f) => f.content),
  }));

  const open = await db().query.threads.findMany({
    where: and(eq(threads.userId, userId), eq(threads.status, "open")),
    limit: 40,
  });

  const result = await models.extract({
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
  // Everything below is derived from this capture and re-runnable. A retry
  // after a partial failure, or a deliberate re-extraction, replaces what
  // this capture filed before rather than appending a second copy.
  await db().delete(facts).where(and(eq(facts.userId, userId), eq(facts.captureId, captureId)));
  await db().delete(interactions).where(and(eq(interactions.userId, userId), eq(interactions.captureId, captureId)));
  await db().delete(threads).where(and(eq(threads.userId, userId), eq(threads.createdFromCaptureId, captureId)));
  await db().delete(looseThreads).where(and(eq(looseThreads.userId, userId), eq(looseThreads.captureId, captureId)));

  let lowConfidence = result.people.some((p) => p.confidence < AUTO_FILE_THRESHOLD);
  const nameToId = new Map<string, string>();
  // Anything the model attached to a person it could neither match nor call
  // new lands here, so it becomes a loose thread instead of vanishing.
  const unresolved = [...result.unresolved];

  for (const p of result.people) {
    if (p.matchedPersonId) { nameToId.set(p.name, p.matchedPersonId); continue; }
    if (!p.isNew) { lowConfidence = true; continue; }
    const [row] = await db().insert(people).values({
      userId,
      displayName: p.name,
      circle: p.circle ?? "other",
      role: p.role ?? null,
    }).returning();
    nameToId.set(p.name, row.id);
  }

  const orphan = (personName: string, content: string) => {
    unresolved.push(`${personName}: ${content}`);
  };

  const factRows = result.facts
    .filter((f) => nameToId.has(f.personName) || (orphan(f.personName, f.content), false))
    .map((f) => ({
      userId, personId: nameToId.get(f.personName)!, kind: f.kind,
      content: f.content, confidence: f.confidence, captureId,
      pinned: f.kind === "relation" || f.kind === "identity" || f.kind === "sensitive",
      embedding: null as number[] | null,
    }));

  const interactionRows = result.interactions
    .filter((i) => nameToId.has(i.personName) || (orphan(i.personName, i.summary), false))
    .map((i) => ({
      userId, personId: nameToId.get(i.personName)!, captureId,
      placeId: place?.id ?? null,
      occurredAt: safeDate(i.occurredAt, capture.capturedAt), channel: i.channel,
      summary: i.summary, lat: capture.lat, lng: capture.lng,
      embedding: null as number[] | null,
    }));

  // Embed facts and interactions together so search covers both.
  const vectors = await models.embed([...factRows.map((f) => f.content), ...interactionRows.map((i) => i.summary)]);
  factRows.forEach((f, i) => { f.embedding = vectors[i] ?? null; });
  interactionRows.forEach((r, i) => { r.embedding = vectors[factRows.length + i] ?? null; });

  if (factRows.length) await db().insert(facts).values(factRows);
  if (interactionRows.length) await db().insert(interactions).values(interactionRows);

  for (const t of result.threads) {
    if (!nameToId.has(t.personName)) { orphan(t.personName, t.title); continue; }
    await db().insert(threads).values({
      userId, personId: nameToId.get(t.personName)!, title: t.title,
      dueAt: t.dueAt ? safeDate(t.dueAt, null) : null, createdFromCaptureId: captureId,
    });
  }

  for (const id of result.closesThreadIds) {
    await db().update(threads)
      .set({ status: "done", completedAt: new Date(), closedByCaptureId: captureId })
      .where(and(eq(threads.id, id), eq(threads.userId, userId)));
  }

  for (const text of unresolved) {
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

  const status = lowConfidence ? "needs_review" : "filed";
  await db().update(captures).set({
    status,
    extraction: result,
    placeId: place?.id ?? null,
    error: null,
  }).where(eq(captures.id, captureId));
  console.log(`[capture ${captureId}] ${status}: ${result.people.length} people, ${factRows.length} facts, ${interactionRows.length} interactions, ${result.threads.length} threads, ${unresolved.length} loose`);
}

/** The model returns ISO strings; a malformed one must not take the whole note down. */
function safeDate(iso: string, fallback: Date): Date;
function safeDate(iso: string, fallback: null): Date | null;
function safeDate(iso: string, fallback: Date | null): Date | null {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? fallback : d;
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

export interface Env {
  AUDIO: R2Bucket;
  GOOGLE_PLACES_KEY?: string;
}
