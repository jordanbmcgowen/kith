import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { route, isUuid } from "@/lib/api";
import { db, people, interactions } from "@/db";
import { refreshMany } from "@/lib/people";
import { and, eq, isNull, inArray, sql } from "drizzle-orm";
import { z } from "zod";

/** One evening's worth of people. Well past any real gathering, short of a script. */
const MAX_AT_ONCE = 200;

/**
 * Tapping the same button twice is the obvious way to get two of everything,
 * and a group is exactly what you would tap twice. Anyone who already has a
 * visit within half a day of this one is left alone rather than given a
 * second, which also means a re-run of the same evening is free.
 */
const SAME_DAY_HOURS = 12;

const NewVisits = z.object({
  personIds: z.array(z.string()).min(1).max(MAX_AT_ONCE),
  /** ISO. The day you saw them, which is rarely the day you type it. */
  occurredAt: z.string().trim().min(1).max(40),
  summary: z.string().trim().max(2000).optional(),
  channel: z.string().trim().max(40).optional(),
}).strict();

/**
 * POST /api/v1/visits
 *
 * "I saw these people, on this day." You do not meet one person at a time:
 * a soccer game is eight parents, a Journeymen evening is twenty. Logging
 * them one at a time is the reason three quarters of a roster can sit at
 * never-seen while its owner sees those people every month.
 *
 * The same rules as one visit, because it is the same thing: last seen and
 * warmth are read back out of the visits afterwards rather than bumped, a
 * visit in the future is refused, and nothing is embedded. A visit logged by
 * hand is a date, not a memory; put it in a note if you want it findable.
 *
 * Every row goes in one statement. Forty sequential inserts is forty chances
 * for the request to be cancelled halfway, which is a lesson this app has
 * already paid for once.
 */
export const POST = route(async (req: Request) => {
  const userId = await requireUser();

  const parsed = NewVisits.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return NextResponse.json({ error: `${issue?.path.join(".") || "body"}: ${issue?.message}` }, { status: 400 });
  }
  const { personIds, occurredAt, summary, channel } = parsed.data;

  const ids = [...new Set(personIds)];
  if (!ids.every(isUuid)) return NextResponse.json({ error: "Some of those are not people" }, { status: 400 });

  const when = new Date(occurredAt);
  if (Number.isNaN(when.getTime())) return NextResponse.json({ error: "That is not a date" }, { status: 400 });
  if (when.getTime() > Date.now() + 86_400_000) {
    return NextResponse.json({ error: "That day has not happened yet" }, { status: 400 });
  }

  const d = db();
  // Yours, and still on the roster. A single missing id fails the whole call
  // rather than quietly logging the rest: a partial answer to "I saw these
  // twelve" is worse than an error, because you would never know which.
  const mine = await d.select({ id: people.id }).from(people)
    .where(and(eq(people.userId, userId), isNull(people.archivedAt), inArray(people.id, ids)));
  if (mine.length !== ids.length) {
    return NextResponse.json({ error: "Some of those are not your people" }, { status: 400 });
  }

  const already = await d.select({ personId: interactions.personId }).from(interactions)
    .where(and(
      eq(interactions.userId, userId),
      inArray(interactions.personId, ids),
      sql`abs(extract(epoch from (${interactions.occurredAt} - ${when.toISOString()}::timestamptz))) < ${SAME_DAY_HOURS * 3600}`,
    ));
  const seen = new Set(already.map((r) => r.personId));
  const fresh = ids.filter((id) => !seen.has(id));

  if (fresh.length) {
    await d.insert(interactions).values(fresh.map((personId) => ({
      userId,
      personId,
      occurredAt: when,
      channel: channel?.trim() || "in_person",
      summary: summary?.trim() || "Saw them.",
    })));
    await refreshMany(userId, fresh);
  }

  return NextResponse.json({ logged: fresh.length, already: seen.size }, { status: 201 });
});
