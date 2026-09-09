/**
 * Queue consumer: raw capture -> filed memory.
 *
 * Deployed as a separate Worker bound to the same R2 bucket and Neon database.
 * Kept off the request path so the phone never waits, and so a model outage
 * delays notes rather than losing them.
 *
 * It transcribes, resolves the place, and runs extraction. Filing itself lives
 * in src/lib/filing.ts, because the confirmation screen files too: a note
 * whose people all clear AUTO_FILE_THRESHOLD files here on its own; anything
 * less certain stops at needs_review with the extraction stored and nothing
 * written, and files when the user taps File it.
 *
 * Secrets (DATABASE_URL, OPENAI_API_KEY, ANTHROPIC_API_KEY) are read through
 * process.env, which Cloudflare populates from Worker secrets when
 * nodejs_compat is on and the compatibility date is 2025-04-01 or later.
 * Both are set in wrangler.worker.jsonc.
 */
import { db, users, captures, people, threads, places, personPlaces } from "../db";
import { transcribe } from "../lib/ai/transcribe";
import { extract, type Candidate } from "../lib/ai/extract";
import { embed, EMBED_MAX_TEXTS } from "../lib/ai/embed";
import { audioExtension } from "../lib/audio";
import { resolvePlace, resolvePlaceByName } from "../lib/places";
import { fileCapture, reconstructFiling, reviewReason } from "../lib/filing";
import { and, eq, isNull } from "drizzle-orm";

export type Msg = {
  captureId: string;
  userId: string;
  /** Stop at needs_review whatever the confidence. Set when the user asks for a re-run. */
  review?: boolean;
};

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
  /**
   * Reached only over the app's PROCESSOR service binding: this Worker has no
   * public hostname (workers_dev and preview_urls are off in its config).
   * POST /embed with { texts } returns { vectors }, so the confirmation
   * screen can file with embeddings while the OpenAI key stays here.
   */
  async fetch(req: Request) {
    const url = new URL(req.url);
    if (req.method !== "POST" || url.pathname !== "/embed") return new Response("Not found", { status: 404 });
    const body = (await req.json().catch(() => null)) as { texts?: unknown } | null;
    const texts = body?.texts;
    if (!Array.isArray(texts) || texts.length > EMBED_MAX_TEXTS || !texts.every((t) => typeof t === "string")) {
      return new Response("Expected { texts: string[] }", { status: 400 });
    }
    return Response.json({ vectors: await embed(texts) });
  },

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

export async function processCapture(msg: Msg, env: Env, models: Models = LIVE) {
  const { captureId, userId } = msg;
  const capture = await db().query.captures.findFirst({
    where: and(eq(captures.id, captureId), eq(captures.userId, userId)),
  });
  if (!capture) return;

  const roster = await db().query.people.findMany({
    where: and(eq(people.userId, userId), isNull(people.archivedAt)),
    with: { facts: { where: (f, { eq: e }) => e(f.pinned, true), limit: 3 } },
    limit: 500,
  });

  // The user's own timezone. Multi-tenant from day one means nothing about
  // Dallas is allowed to be hardcoded here.
  const prefs = await db().query.users.findFirst({
    where: eq(users.id, userId),
    columns: { timezone: true },
  });
  const timezone = prefs?.timezone ?? "America/Chicago";

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
  // A place already on the note (a re-run, or a retry) is kept as is. Else a
  // typed place name wins. Coordinates alone mean "I am there now" and go
  // through proximity matching (then Google, if a key is set). No hint and
  // no coordinates means the note is filed without a place.
  const place = capture.placeId
    ? (await db().query.places.findFirst({ where: and(eq(places.id, capture.placeId), eq(places.userId, userId)) })) ?? null
    : capture.placeHint
      ? await resolvePlaceByName(userId, capture.placeHint, capture.lat, capture.lng)
      : capture.lat != null && capture.lng != null
        ? await resolvePlace(userId, capture.lat, capture.lng, env.GOOGLE_PLACES_KEY)
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
    role: p.role,
    tags: p.tags,
    nearHere: nearIds.has(p.id),
    topFacts: p.facts.map((f) => f.content),
  }));

  // The user's tags, most used first, so the model reuses a spelling instead
  // of inventing "Young Life" next to "YoungLife".
  const tagCounts = new Map<string, number>();
  for (const p of roster) for (const t of p.tags) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
  const tags = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 50).map(([t]) => t);

  const open = await db().query.threads.findMany({
    where: and(eq(threads.userId, userId), eq(threads.status, "open")),
    limit: 40,
  });

  const result = await models.extract({
    transcript,
    // Weekday and local time spelled out, plus a two week calendar. Models
    // resolve "by Friday" reliably when they can look the date up and
    // unreliably when they have to compute it from an ISO timestamp.
    now: describeNow(capture.capturedAt, timezone),
    timezone,
    dateContext: upcomingDays(capture.capturedAt, timezone, 14),
    placeName: place?.name ?? null,
    candidates,
    tags,
    openThreads: open.map((t) => ({
      id: t.id,
      personName: roster.find((p) => p.id === t.personId)?.displayName ?? "",
      title: t.title,
    })),
  });

  /* 4. store it, then file it or wait ----------------------------------- */
  // A note that filed before keeps the record of what it created, so the next
  // filing can reuse or remove those rows. Its decisions are dropped: they
  // were made against the previous extraction and no longer line up.
  const carried = capture.filing ?? (capture.extraction ? await reconstructFiling(userId, capture) : null);
  const reason = msg.review ? "re-run, waiting for a look" : reviewReason(result);

  await db().update(captures).set({
    extraction: result,
    placeId: place?.id ?? null,
    filing: carried ? { ...carried, decisions: null } : null,
    status: reason ? "needs_review" : "extracting",
    error: null,
  }).where(eq(captures.id, captureId));

  if (reason) {
    console.log(`[capture ${captureId}] needs_review (${reason}): ${result.people.length} people, ${result.facts.length} facts, ${result.threads.length} threads, ${result.unresolved.length} loose. Nothing filed yet.`);
    return;
  }

  const { counts } = await fileCapture({ userId, captureId, by: "auto", embed: models.embed });
  console.log(`[capture ${captureId}] filed: ${counts.people} people, ${counts.facts} facts, ${counts.interactions} interactions, ${counts.threads} threads, ${counts.loose} loose`);
}

/** "Sunday, September 6, 2026 at 4:35 PM CDT (2026-09-06T21:35:16.196Z)" */
function describeNow(d: Date, timeZone: string): string {
  const human = d.toLocaleString("en-US", {
    timeZone, weekday: "long", year: "numeric", month: "long", day: "numeric",
    hour: "numeric", minute: "2-digit", timeZoneName: "short",
  });
  return `${human} (${d.toISOString()})`;
}

/** "Sun Sep 6 (today), Mon Sep 7 (tomorrow), Tue Sep 8, ..." for the next n days. */
function upcomingDays(d: Date, timeZone: string, n: number): string {
  const out: string[] = [];
  for (let i = 0; i <= n; i++) {
    const day = new Date(d.getTime() + i * 86_400_000);
    const label = day.toLocaleDateString("en-US", { timeZone, weekday: "short", month: "short", day: "numeric" });
    out.push(i === 0 ? `${label} (today)` : i === 1 ? `${label} (tomorrow)` : label);
  }
  return out.join(", ");
}

export interface Env {
  AUDIO: R2Bucket;
  GOOGLE_PLACES_KEY?: string;
}
