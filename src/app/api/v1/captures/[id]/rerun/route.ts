import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { requireUser } from "@/lib/auth";
import { route, isUuid } from "@/lib/api";
import { rerunCapture, dispatchJob, JobConflict } from "@/lib/capture-jobs";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/v1/captures/:id/rerun
 *
 * Puts a note back on the queue. The transcript is kept (captures are
 * immutable; extraction is what gets re-run), and the consumer stops at
 * needs_review whatever it finds, so nothing re-files without a look. This is
 * Try again for a failed note and "read it again" for a filed one.
 */
export const POST = route(async (_req: Request, ctx: Ctx) => {
  const userId = await requireUser();
  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "No such note" }, { status: 404 });

  const supplied = _req.headers.get("Idempotency-Key");
  if (supplied && !isUuid(supplied)) return NextResponse.json({ error: "Invalid retry key" }, { status: 400 });
  // Old callers retain their active-note 409 behavior. Updated clients keep
  // a request key until they receive an acknowledgement, even after completion.
  const { env } = getCloudflareContext();
  const key = supplied ?? crypto.randomUUID();
  try {
    const capture = await rerunCapture(userId, id, key);
    if (!capture) return NextResponse.json({ error: "No such note" }, { status: 404 });
    await dispatchJob(userId, key, env.CAPTURE_QUEUE).catch(() => {});
    return NextResponse.json({ id, status: capture.status }, { status: 202 });
  } catch (err) {
    if (err instanceof JobConflict) return NextResponse.json({ error: err.message }, { status: 409 });
    throw err;
  }
});
