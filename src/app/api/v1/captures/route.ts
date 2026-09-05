import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { db, captures } from "@/db";
import { getRequestContext } from "@opennextjs/cloudflare";

/**
 * POST /api/v1/captures
 *
 * The capture endpoint returns in well under a second and never waits on a
 * model. Audio goes to R2, a row goes to Postgres, a message goes on the
 * queue, and the phone gets its 202 back. If the pipeline is down, the note
 * is still safe.
 *
 * Versioned under /v1 on purpose: the Expo app will call these same routes.
 */
export async function POST(req: Request) {
  const userId = await requireUser();
  const form = await req.formData();

  const audio = form.get("audio");
  const text = form.get("text");
  const lat = num(form.get("lat"));
  const lng = num(form.get("lng"));
  const accuracyM = num(form.get("accuracy"));
  const capturedAt = new Date(String(form.get("capturedAt") ?? Date.now()));

  if (!audio && !text) {
    return NextResponse.json({ error: "Send audio or text" }, { status: 400 });
  }

  const id = crypto.randomUUID();
  let audioKey: string | null = null;

  if (audio instanceof File) {
    if (audio.size > 25 * 1024 * 1024) {
      return NextResponse.json({ error: "Recording is too long. Keep notes under about 20 minutes." }, { status: 413 });
    }
    audioKey = `captures/${userId}/${id}.webm`;
    const { env } = getRequestContext();
    await env.AUDIO.put(audioKey, audio.stream(), {
      httpMetadata: { contentType: audio.type || "audio/webm" },
    });
  }

  await db().insert(captures).values({
    id,
    userId,
    kind: audioKey ? "voice" : "text",
    status: "uploaded",
    audioKey,
    rawText: typeof text === "string" ? text : null,
    lat, lng, accuracyM,
    capturedAt,
  });

  const { env } = getRequestContext();
  await env.CAPTURE_QUEUE.send({ captureId: id, userId });

  return NextResponse.json({ id, status: "uploaded" }, { status: 202 });
}

/** GET /api/v1/captures?status=needs_review — the confirmation inbox. */
export async function GET(req: Request) {
  const userId = await requireUser();
  const status = new URL(req.url).searchParams.get("status");
  const rows = await db().query.captures.findMany({
    where: (c, { eq, and }) =>
      status ? and(eq(c.userId, userId), eq(c.status, status as any)) : eq(c.userId, userId),
    orderBy: (c, { desc }) => desc(c.capturedAt),
    limit: 50,
  });
  return NextResponse.json({ captures: rows });
}

const num = (v: FormDataEntryValue | null) => (v == null ? null : Number(v) || null);
