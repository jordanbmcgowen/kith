import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { route, isUuid } from "@/lib/api";
import { db, users, people, facts, interactions, threads, places, personPlaces, captures, looseThreads } from "@/db";
import { cadenceFor, CADENCE_DEFAULTS } from "@/lib/warmth";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/v1/people/:id
 *
 * One person, read only, in one round trip: the row with the cadence that
 * applies to them, their facts with the pinned ones first, open threads
 * soonest first, visits newest first with the place each happened at, the
 * places you see them at by how often, and the notes that filed something
 * about them.
 *
 * Every query carries the user id. A malformed id, or somebody else's, is a
 * 404: never a 500, never a row.
 */
export const GET = route(async (_req: Request, ctx: Ctx) => {
  const userId = await requireUser();
  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "No one here" }, { status: 404 });

  const d = db();
  const person = await d.query.people.findFirst({
    where: and(eq(people.id, id), eq(people.userId, userId)),
    columns: {
      id: true, displayName: true, goesBy: true, pronunciation: true, pronouns: true,
      circle: true, tags: true, role: true, company: true, title: true, birthday: true,
      cadenceDays: true, lastInteractionAt: true, warmth: true, createdAt: true, archivedAt: true,
    },
  });
  if (!person) return NextResponse.json({ error: "No one here" }, { status: 404 });

  const [prefs, factRows, threadRows, visitRows, placeRows, noteRows] = await Promise.all([
    d.query.users.findFirst({ where: eq(users.id, userId), columns: { cadenceDefaults: true } }),
    d.select({
      id: facts.id, kind: facts.kind, content: facts.content, pinned: facts.pinned,
      confidence: facts.confidence, captureId: facts.captureId, createdAt: facts.createdAt,
    })
      .from(facts)
      .where(and(eq(facts.userId, userId), eq(facts.personId, id), isNull(facts.supersededById)))
      .orderBy(desc(facts.pinned), desc(facts.createdAt))
      .limit(200),
    d.select({
      id: threads.id, title: threads.title, dueAt: threads.dueAt,
      createdFromCaptureId: threads.createdFromCaptureId, createdAt: threads.createdAt,
    })
      .from(threads)
      .where(and(eq(threads.userId, userId), eq(threads.personId, id), eq(threads.status, "open")))
      .orderBy(sql`${threads.dueAt} asc nulls last`, asc(threads.createdAt))
      .limit(100),
    d.select({
      id: interactions.id, occurredAt: interactions.occurredAt, channel: interactions.channel,
      summary: interactions.summary, captureId: interactions.captureId,
      placeId: places.id, placeName: places.name,
    })
      .from(interactions)
      .leftJoin(places, and(eq(places.id, interactions.placeId), eq(places.userId, userId)))
      .where(and(eq(interactions.userId, userId), eq(interactions.personId, id)))
      .orderBy(desc(interactions.occurredAt))
      .limit(200),
    d.select({ id: places.id, name: places.name, weight: personPlaces.weight, lastSeenAt: personPlaces.lastSeenAt })
      .from(personPlaces)
      .innerJoin(places, and(eq(places.id, personPlaces.placeId), eq(places.userId, userId)))
      .where(and(eq(personPlaces.userId, userId), eq(personPlaces.personId, id)))
      .orderBy(desc(personPlaces.weight), desc(personPlaces.lastSeenAt)),
    notesAbout(userId, id),
  ]);

  const { cadenceDays, ...rest } = person;
  return NextResponse.json({
    person: {
      ...rest,
      cadenceDays: cadenceFor(person, prefs?.cadenceDefaults ?? CADENCE_DEFAULTS),
      cadenceIsDefault: cadenceDays == null,
    },
    facts: factRows,
    threads: threadRows,
    interactions: visitRows.map(({ placeId, placeName, ...v }) => ({
      ...v,
      place: placeId && placeName ? { id: placeId, name: placeName } : null,
    })),
    places: placeRows,
    notes: noteRows,
  });
});

/**
 * The notes that filed something about this person, newest first: every
 * capture whose filing record lists them, plus any that left a fact, visit,
 * thread or attached loose thread on them, which covers notes filed before
 * the record existed. A note the user left them out of is not a mention.
 */
async function notesAbout(userId: string, personId: string) {
  const res = await db().execute(sql`
    select c.id, c.kind, c.status, c.captured_at as "capturedAt", c.place_hint as "placeHint",
           left(coalesce(c.transcript, c.raw_text, ''), 240) as excerpt
    from ${captures} c
    where c.user_id = ${userId} and (
      coalesce(c.filing->'peopleIds', '[]'::jsonb) @> to_jsonb(${personId}::text)
      or exists (select 1 from ${facts} f where f.user_id = ${userId} and f.capture_id = c.id and f.person_id = ${personId}::uuid)
      or exists (select 1 from ${interactions} i where i.user_id = ${userId} and i.capture_id = c.id and i.person_id = ${personId}::uuid)
      or exists (select 1 from ${threads} t where t.user_id = ${userId} and t.created_from_capture_id = c.id and t.person_id = ${personId}::uuid)
      or exists (select 1 from ${looseThreads} l where l.user_id = ${userId} and l.capture_id = c.id and l.resolved_person_id = ${personId}::uuid)
    )
    order by c.captured_at desc
    limit 50`);
  return (res.rows as { id: string; kind: string; status: string; capturedAt: string | Date; placeHint: string | null; excerpt: string }[])
    .map((r) => ({ ...r, capturedAt: new Date(r.capturedAt).toISOString() }));
}
