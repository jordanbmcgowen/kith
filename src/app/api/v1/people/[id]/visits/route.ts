import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { route, isUuid } from "@/lib/api";
import { db, people, interactions } from "@/db";
import { refreshPerson } from "@/lib/people";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

type Ctx = { params: Promise<{ id: string }> };

const NewVisit = z.object({
  /** ISO. The day you actually saw them, which is rarely the day you type it. */
  occurredAt: z.string().trim().min(1).max(40),
  summary: z.string().trim().max(2000).optional(),
  channel: z.string().trim().max(40).optional(),
}).strict();

/**
 * POST /api/v1/people/:id/visits
 *
 * "I saw them, on this day." Last seen and warmth are the date of the most
 * recent visit, so the way to correct either is to correct the visits, not to
 * overwrite the number they are computed from. A visit that came from a note
 * is fixed on that note, where the fix survives a re-file; this is for the
 * ones that never had a note, which until now had no way to exist at all.
 *
 * No embedding: a visit logged by hand is a date, not a memory, and the
 * processor holds the model key. Type it into a note if you want it findable.
 */
export const POST = route(async (req: Request, ctx: Ctx) => {
  const userId = await requireUser();
  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "No one here" }, { status: 404 });

  const parsed = NewVisit.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return NextResponse.json({ error: `${issue?.path.join(".") || "body"}: ${issue?.message}` }, { status: 400 });
  }
  const when = new Date(parsed.data.occurredAt);
  if (Number.isNaN(when.getTime())) return NextResponse.json({ error: "That is not a date" }, { status: 400 });
  // A visit in the future would make warmth say you are up to date on someone
  // you have not seen yet.
  if (when.getTime() > Date.now() + 86_400_000) {
    return NextResponse.json({ error: "That day has not happened yet" }, { status: 400 });
  }

  const d = db();
  const person = await d.query.people.findFirst({
    where: and(eq(people.id, id), eq(people.userId, userId)),
    columns: { id: true },
  });
  if (!person) return NextResponse.json({ error: "No one here" }, { status: 404 });

  const [row] = await d.insert(interactions).values({
    userId,
    personId: id,
    occurredAt: when,
    channel: parsed.data.channel?.trim() || "in_person",
    summary: parsed.data.summary?.trim() || "Saw them.",
  }).returning({ id: interactions.id });

  await refreshPerson(userId, id);
  return NextResponse.json({ visit: { id: row.id } }, { status: 201 });
});
