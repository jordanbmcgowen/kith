import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { route, isUuid } from "@/lib/api";
import { db, interactions } from "@/db";
import { refreshPerson } from "@/lib/people";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";

type Ctx = { params: Promise<{ id: string; visitId: string }> };

const EditVisit = z.object({
  occurredAt: z.string().trim().min(1).max(40).optional(),
  summary: z.string().trim().min(1).max(2000).optional(),
}).strict();

/**
 * PATCH and DELETE /api/v1/people/:id/visits/:visitId
 *
 * Only visits that came from nowhere. A visit a note produced belongs to that
 * note: changing it here would be undone the next time the note is filed
 * again, and silently, which is worse than not offering it. The note's own
 * screen is where those are corrected, and the person page links to it.
 */
export const PATCH = route(async (req: Request, ctx: Ctx) => {
  const userId = await requireUser();
  const { id, visitId } = await ctx.params;
  if (!isUuid(id) || !isUuid(visitId)) return NextResponse.json({ error: "No such visit" }, { status: 404 });

  const parsed = EditVisit.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return NextResponse.json({ error: `${issue?.path.join(".") || "body"}: ${issue?.message}` }, { status: 400 });
  }
  if (!Object.keys(parsed.data).length) return NextResponse.json({ error: "Nothing to change" }, { status: 400 });

  let when: Date | undefined;
  if (parsed.data.occurredAt !== undefined) {
    when = new Date(parsed.data.occurredAt);
    if (Number.isNaN(when.getTime())) return NextResponse.json({ error: "That is not a date" }, { status: 400 });
    if (when.getTime() > Date.now() + 86_400_000) {
      return NextResponse.json({ error: "That day has not happened yet" }, { status: 400 });
    }
  }

  const [row] = await db().update(interactions)
    .set({ ...(when ? { occurredAt: when } : {}), ...(parsed.data.summary ? { summary: parsed.data.summary } : {}) })
    .where(and(
      eq(interactions.id, visitId),
      eq(interactions.userId, userId),
      eq(interactions.personId, id),
      // The note is where a note's visit gets corrected.
      isNull(interactions.captureId),
    ))
    .returning({ id: interactions.id });
  if (!row) return NextResponse.json({ error: "That visit came from a note. Change it there." }, { status: 404 });

  await refreshPerson(userId, id);
  return NextResponse.json({ ok: true });
});

export const DELETE = route(async (_req: Request, ctx: Ctx) => {
  const userId = await requireUser();
  const { id, visitId } = await ctx.params;
  if (!isUuid(id) || !isUuid(visitId)) return NextResponse.json({ error: "No such visit" }, { status: 404 });

  const [row] = await db().delete(interactions)
    .where(and(
      eq(interactions.id, visitId),
      eq(interactions.userId, userId),
      eq(interactions.personId, id),
      isNull(interactions.captureId),
    ))
    .returning({ id: interactions.id });
  if (!row) return NextResponse.json({ error: "That visit came from a note. Change it there." }, { status: 404 });

  await refreshPerson(userId, id);
  return NextResponse.json({ ok: true });
});
