import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { db, captures, captureStatusEnum } from "@/db";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { route, isUuid } from "@/lib/api";
import { acceptCapture, dispatchJob, requestHash, legacyRequestKey, findRequest, JobConflict } from "@/lib/capture-jobs";
import { audioExtension, storedContentType } from "@/lib/audio";

/** Whisper's hard limit. About twenty minutes of speech. */
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
/** Typed notes. Generous, but a pasted novel is not a note. */
const MAX_TEXT_CHARS = 20_000;
/** A place name, not a paragraph. */
const MAX_PLACE_CHARS = 120;

/**
 * POST /api/v1/captures
 *
 * The capture endpoint never waits on a model. Audio goes to R2, a row
 * and durable job go to Postgres, a dispatch is attempted on the
 * queue, and the phone gets its 202 back. If the pipeline is down, the note
 * is still safe.
 *
 * Accepts multipart form data with either:
 *   audio       a Blob from MediaRecorder (any browser's container)
 *   text        a typed or pasted note
 * plus optional lat, lng, accuracy (metres), capturedAt (ISO 8601) and place
 * (a typed place name). Send coordinates only when the note is about where
 * the phone is; a note about somewhere else sends a place name and no
 * coordinates.
 *
 * Versioned under /v1 on purpose: the Expo app will call these same routes.
 */
export const POST = route(async (req: Request) => {
  const userId = await requireUser();
  const form = await req.formData();

  const audio = form.get("audio");
  const text = str(form.get("text"));
  const lat = num(form.get("lat"));
  const lng = num(form.get("lng"));
  const accuracyM = num(form.get("accuracy"));
  const capturedAt = when(form.get("capturedAt"));
  const placeHint = str(form.get("place")).slice(0, MAX_PLACE_CHARS) || null;

  // A Blob without a filename is still a Blob. Checking `instanceof File`
  // here would silently turn a real recording into an empty text capture.
  const hasAudio = audio instanceof Blob && audio.size > 0;

  if (!hasAudio && !text) {
    return NextResponse.json({ error: "Send audio or text" }, { status: 400 });
  }
  if (hasAudio && audio.size > MAX_AUDIO_BYTES) {
    return NextResponse.json({ error: "Recording is too long. Keep notes under about 20 minutes." }, { status: 413 });
  }
  if (text.length > MAX_TEXT_CHARS) {
    return NextResponse.json({ error: "That note is too long. Split it up." }, { status: 413 });
  }

  const keyHeader = req.headers.get("Idempotency-Key");
  if (keyHeader && !isUuid(keyHeader)) return NextResponse.json({ error: "Invalid retry key" }, { status: 400 });
  const hash = await requestHash({ kind: hasAudio ? "voice" : "text", text, lat, lng, accuracyM, placeHint,
    capturedAt: str(form.get("capturedAt")) || null, audioType: hasAudio ? storedContentType(audio.type) : null }, hasAudio ? audio : undefined);
  // Older UI builds supply capturedAt, giving stable retry identity. For
  // unkeyed API calls without it, preserve the existing distinct-note behavior;
  // only an explicit key can disambiguate a retry from an identical new note.
  const requestKey = keyHeader ?? (str(form.get("capturedAt")) ? legacyRequestKey(hash) : crypto.randomUUID());
  const { env } = getCloudflareContext();
  try {
    const prior = await findRequest(userId, requestKey, hash);
    if (prior) {
      await dispatchJob(userId, requestKey, env.CAPTURE_QUEUE).catch(() => {});
      const capture = await db().query.captures.findFirst({ where: (c, { and, eq }) => and(eq(c.userId, userId), eq(c.id, prior.captureId)) });
      if (!capture) throw new Error("Capture job has no owned capture");
      return NextResponse.json({ id: capture.id, status: capture.status, kind: capture.kind }, { status: 202 });
    }
  } catch (err) {
    if (err instanceof JobConflict) return NextResponse.json({ error: err.message }, { status: 409 });
    throw err;
  }
  const id = crypto.randomUUID();
  let audioKey: string | null = null;

  if (hasAudio) {
    // The extension has to match the bytes or Whisper rejects the file.
    // iOS records mp4, Chrome records webm; the worker reads it back off this key.
    const ext = audioExtension(audio.type);
    audioKey = `captures/${userId}/${id}.${ext}`;
    await env.AUDIO.put(audioKey, audio, {
      httpMetadata: { contentType: storedContentType(audio.type) },
    });
  }

  try {
    const saved = await acceptCapture(userId, requestKey, hash, {
      id, kind: audioKey ? "voice" : "text", audioKey, rawText: text || null,
      lat, lng, accuracyM, placeHint, capturedAt,
    });
    // Durable acceptance is success even if this immediate dispatch is rejected
    // or its acknowledgement is lost. The scheduled dispatcher owns recovery.
    await dispatchJob(userId, requestKey, env.CAPTURE_QUEUE).catch(() => {});
    return NextResponse.json({ id: saved.id, status: saved.status, kind: saved.kind }, { status: 202 });
  } catch (err) {
    if (err instanceof JobConflict) return NextResponse.json({ error: err.message }, { status: 409 });
    throw err;
  }
});

/** GET /api/v1/captures?status=needs_review — recent captures, newest first. */
export const GET = route(async (req: Request) => {
  const userId = await requireUser();
  const wanted = new URL(req.url).searchParams.get("status");
  const status = (captureStatusEnum.enumValues as readonly string[]).includes(wanted ?? "")
    ? (wanted as (typeof captureStatusEnum.enumValues)[number])
    : null;

  const rows = await db().query.captures.findMany({
    where: (c, { eq, and }) =>
      status ? and(eq(c.userId, userId), eq(c.status, status)) : eq(c.userId, userId),
    orderBy: (c, { desc }) => desc(c.capturedAt),
    limit: 50,
  });
  return NextResponse.json({ captures: rows });
});

/* ------------------------------------------------------------ parsing */

const str = (v: FormDataEntryValue | null) => (typeof v === "string" ? v.trim() : "");

/** A real 0 is a real coordinate. Only blank or non-numeric becomes null. */
const num = (v: FormDataEntryValue | null) => {
  if (typeof v !== "string" || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** ISO 8601 or epoch milliseconds. Anything unparseable means "now". */
const when = (v: FormDataEntryValue | null) => {
  if (typeof v !== "string" || !v.trim()) return new Date();
  const d = /^\d{10,}$/.test(v.trim()) ? new Date(Number(v)) : new Date(v);
  return Number.isNaN(d.getTime()) ? new Date() : d;
};
