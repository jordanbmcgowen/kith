import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { route, isUuid } from "@/lib/api";
import { db, captures, people, places, threads, type ExtractionResult, type CaptureFiling } from "@/db";
import { reconstructFiling } from "@/lib/filing";
import type { Suggestion } from "@/lib/store";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/v1/captures/:id
 *
 * Everything the confirmation screen needs in one round trip: the capture
 * with its extraction and filing record, the place it resolved to, the
 * user's people (for the "someone else" picker), the closest existing names
 * for each person the model called new, and the titles of any threads the
 * note closes.
 */
export const GET = route(async (_req: Request, ctx: Ctx) => {
  const userId = await requireUser();
  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "No such note" }, { status: 404 });

  const capture = await db().query.captures.findFirst({
    where: and(eq(captures.id, id), eq(captures.userId, userId)),
  });
  if (!capture) return NextResponse.json({ error: "No such note" }, { status: 404 });

  const x = capture.extraction;
  const filing = capture.filing ?? (x ? await reconstructFiling(userId, capture) : null);

  const [roster, place, closes, suggestions] = await Promise.all([
    db().query.people.findMany({
      where: and(eq(people.userId, userId), isNull(people.archivedAt)),
      columns: { id: true, displayName: true, goesBy: true, circle: true, role: true },
      orderBy: (p, { asc }) => asc(p.displayName),
      limit: 500,
    }),
    capture.placeId
      ? db().query.places.findFirst({
          where: and(eq(places.id, capture.placeId), eq(places.userId, userId)),
          columns: { id: true, name: true },
        })
      : Promise.resolve(null),
    x?.closesThreadIds.length
      ? db().query.threads.findMany({
          where: and(eq(threads.userId, userId), inArray(threads.id, x.closesThreadIds)),
          columns: { id: true, title: true, personId: true },
        })
      : Promise.resolve([]),
    x ? suggest(userId, x, filing) : Promise.resolve({}),
  ]);

  return NextResponse.json({
    capture: { ...capture, filing, place: place ?? null },
    people: roster,
    closes: closes.map((t) => ({
      id: t.id, title: t.title,
      personName: roster.find((p) => p.id === t.personId)?.displayName ?? null,
    })),
    suggestions,
  });
});

/**
 * For each person the model could not match, the existing people whose names
 * look like it, by trigram similarity. "Keith" offers "Keith Ryan"; "Dev"
 * offers "Dev Patel". Rows this very note created are left out: a note's own
 * product is not a candidate for its own people.
 */
async function suggest(userId: string, x: ExtractionResult, filing: CaptureFiling | null) {
  const wanted = x.people.map((p, i) => ({ i, name: p.name })).filter(({ i }) => !x.people[i].matchedPersonId);
  const out: Record<string, Suggestion[]> = {};
  if (!wanted.length) return out;

  const own = new Set(filing?.created.map((c) => c.personId) ?? []);
  const names = sql.join(wanted.map((w) => sql`${w.name}`), sql`, `);
  const indexes = sql.join(wanted.map((w) => sql`${w.i}::int`), sql`, `);
  const score = sql`greatest(similarity(p.display_name, n.name), similarity(coalesce(p.goes_by, ''), n.name))`;
  const res = await db().execute(sql`
    select n.i, p.id, p.display_name, p.role, ${score} as s
    from unnest(array[${names}]::text[], array[${indexes}]) as n(name, i)
    join ${people} p on p.user_id = ${userId} and p.archived_at is null
    where ${score} > 0.3
    order by n.i, s desc`);

  for (const r of res.rows as { i: number; id: string; display_name: string; role: string | null; s: number }[]) {
    if (own.has(r.id)) continue;
    const list = (out[String(r.i)] ??= []);
    if (list.length < 3) list.push({ id: r.id, displayName: r.display_name, role: r.role, similarity: Number(r.s) });
  }
  return out;
}
