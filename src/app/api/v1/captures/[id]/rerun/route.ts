import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { requireUser } from "@/lib/auth";
import { route, isUuid } from "@/lib/api";
import { db, captures } from "@/db";
import { and, eq } from "drizzle-orm";

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

  const capture = await db().query.captures.findFirst({
    where: and(eq(captures.id, id), eq(captures.userId, userId)),
    columns: { status: true },
  });
  if (!capture) return NextResponse.json({ error: "No such note" }, { status: 404 });
  if (capture.status === "uploaded" || capture.status === "transcribing" || capture.status === "extracting") {
    return NextResponse.json({ error: "Already working on this note." }, { status: 409 });
  }

  await db().update(captures).set({ status: "uploaded", error: null }).where(eq(captures.id, id));
  const { env } = getCloudflareContext();
  await env.CAPTURE_QUEUE.send({ captureId: id, userId, review: true });

  return NextResponse.json({ id, status: "uploaded" }, { status: 202 });
});
