import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { route, isUuid } from "@/lib/api";
import { db, captures } from "@/db";
import { embed } from "@/lib/ai/embed";
import { DecisionsSchema, FilingError, fileCapture } from "@/lib/filing";
import { and, eq } from "drizzle-orm";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/v1/captures/:id/confirm
 *
 * Files a note with the user's decisions: the body is a FilingDecisions (see
 * src/db/schema.ts), one entry per item of the stored extraction. Works on a
 * note that is waiting for a look (files it for the first time) and on one
 * that filed itself (replaces what it filed). Running it again with the same
 * decisions changes nothing.
 */
export const POST = route(async (req: Request, ctx: Ctx) => {
  const userId = await requireUser();
  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "No such note" }, { status: 404 });

  const parsed = DecisionsSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return NextResponse.json({ error: `Bad decisions: ${issue?.path.join(".")} ${issue?.message}` }, { status: 400 });
  }

  const capture = await db().query.captures.findFirst({
    where: and(eq(captures.id, id), eq(captures.userId, userId)),
    columns: { status: true, extraction: true },
  });
  if (!capture) return NextResponse.json({ error: "No such note" }, { status: 404 });
  if (capture.status === "failed") {
    return NextResponse.json({ error: "This note failed. Run it again first." }, { status: 409 });
  }
  if (!capture.extraction || (capture.status !== "needs_review" && capture.status !== "filed")) {
    return NextResponse.json({ error: "Still working on this note. Give it a moment." }, { status: 409 });
  }

  try {
    const { counts, filing } = await fileCapture({ userId, captureId: id, decisions: parsed.data, by: "user", embed });
    return NextResponse.json({ status: "filed", counts, filing });
  } catch (err) {
    if (err instanceof FilingError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
});
