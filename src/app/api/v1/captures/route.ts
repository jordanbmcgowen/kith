import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { db, captures, captureStatusEnum } from "@/db";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { route } from "@/lib/api";
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
 * The capture endpoint returns in well under a second and never waits on a
 * model. Audio goes to R2, a row goes to Postgres, a message goes on the
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

  const id = crypto.randomUUID();
  let audioKey: string | null = null;

  if (hasAudio) {
    // The extension has to match the bytes or Whisper rejects the file.
    // iOS records mp4, Chrome records webm; the worker reads it back off this key.
    const ext = audioExtension(audio.type);
    audioKey = `captures/${userId}/${id}.${ext}`;
    const { env } = getCloudflareContext();
    await env.AUDIO.put(audioKey, audio, {
      httpMetadata: { contentType: storedContentType(audio.type) },
    });
  }

  await db().insert(captures).values({
    id,
    userId,
    kind: audioKey ? "voice" : "text",
    status: "uploaded",
    audioKey,
    rawText: text || null,
    lat, lng, accuracyM,
    placeHint,
    capturedAt,
  });

  const { env } = getCloudflareContext();
  await env.CAPTURE_QUEUE.send({ captureId: id, userId });

  return NextResponse.json({ id, status: "uploaded", kind: audioKey ? "voice" : "text" }, { status: 202 });
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
