import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { route, isUuid } from "@/lib/api";
import { db, users, people, facts, interactions, threads, places, personPlaces, captures, looseThreads } from "@/db";
import { cadenceFor, CADENCE_DEFAULTS, warmth as computeWarmth } from "@/lib/warmth";
import { mergeTags } from "@/lib/decisions";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";

type Ctx = { params: Promise<{ id: string }> };

/** Must match the `circle_kind` enum in src/db/schema.ts. */
const CIRCLES = ["family", "friends", "work", "neighbors", "other"] as const;

/**
 * What a person's page lets you change. Every field is optional: a PATCH says
 * only what moved. A null clears a field; leaving it out leaves it alone.
 *
 * Not here on purpose: facts, visits and threads. Those are derived from
 * notes, and the place to correct one is the note it came from, where the
 * correction survives a re-file.
 */
const PersonPatch = z.object({
  displayName: z.string().trim().min(1).max(120).optional(),
  goesBy: z.string().trim().max(60).nullish(),
  pronunciation: z.string().trim().max(60).nullish(),
  pronouns: z.string().trim().max(40).nullish(),
  role: z.string().trim().max(200).nullish(),
  company: z.string().trim().max(120).nullish(),
  circle: z.enum(CIRCLES).optional(),
  /** The complete list after this edit, not an addition. One spelling per tag. */
  tags: z.array(z.string().trim().min(1).max(40)).max(12).optional(),
}).strict();

/**
 * PATCH /api/v1/people/:id
 *
 * Edit who someone is: their name, how you say it, what they are to you,
 * their circle, and their tags. Tags are where employers live, which is what
 * makes "everyone I know at Neighborly" a thing you can ask for. A circle is
 * one of five and sets the cadence, so warmth is recomputed after any change
 * rather than left saying something that is no longer true.
 */
export const PATCH = route(async (req: Request, ctx: Ctx) => {
  const userId = await requireUser();
  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "No one here" }, { status: 404 });

  const parsed = PersonPatch.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return NextResponse.json({ error: `${issue?.path.join(".") || "body"}: ${issue?.message}` }, { status: 400 });
  }
  const body = parsed.data;
  if (!Object.keys(body).length) return NextResponse.json({ error: "Nothing to change" }, { status: 400 });

  const d = db();
  const before = await d.query.people.findFirst({
    where: and(eq(people.id, id), eq(people.userId, userId)),
    columns: { id: true, circle: true, cadenceDays: true },
  });
  if (!before) return NextResponse.json({ error: "No one here" }, { status: 404 });

  // An empty string is the user clearing a field, same as null.
  const blankToNull = (v: string | null | undefined) => (v === undefined ? undefined : v?.trim() ? v.trim() : null);
  const patch = {
    ...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
    ...(body.goesBy !== undefined ? { goesBy: blankToNull(body.goesBy) } : {}),
    ...(body.pronunciation !== undefined ? { pronunciation: blankToNull(body.pronunciation) } : {}),
    ...(body.pronouns !== undefined ? { pronouns: blankToNull(body.pronouns) } : {}),
    ...(body.role !== undefined ? { role: blankToNull(body.role) } : {}),
    ...(body.company !== undefined ? { company: blankToNull(body.company) } : {}),
    ...(body.circle !== undefined ? { circle: body.circle } : {}),
    ...(body.tags !== undefined ? { tags: mergeTags([], body.tags) } : {}),
    updatedAt: new Date(),
  };

  const [row] = await d.update(people).set(patch)
    .where(and(eq(people.id, id), eq(people.userId, userId)))
    .returning({ id: people.id, circle: people.circle, cadenceDays: people.cadenceDays, lastInteractionAt: people.lastInteractionAt });

  // The cadence that applies may have moved, and warmth is read against it.
  const [prefs, agg] = await Promise.all([
    d.query.users.findFirst({ where: eq(users.id, userId), columns: { cadenceDefaults: true } }),
    d.execute(sql`
      select count(*) filter (where occurred_at > now() - interval '90 days') recent,
             max(occurred_at) last
      from ${interactions} where user_id = ${userId} and person_id = ${id}`),
  ]);
  const a = agg.rows[0] as { recent: unknown; last: string | Date | null };
  const last = a?.last ? new Date(a.last) : row.lastInteractionAt;
  await d.update(people)
    .set({ warmth: computeWarmth({
      lastInteractionAt: last,
      cadenceDays: cadenceFor(row, prefs?.cadenceDefaults ?? CADENCE_DEFAULTS),
      interactionsLast90: Number(a?.recent ?? 0),
    }) })
    .where(and(eq(people.id, id), eq(people.userId, userId)));

  return NextResponse.json({ ok: true });
});

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
