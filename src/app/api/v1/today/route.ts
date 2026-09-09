import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { route } from "@/lib/api";
import { db, users, people, places, personPlaces, threads, looseThreads, captures } from "@/db";
import { and, eq, desc, asc, sql, isNull, inArray } from "drizzle-orm";
import { bbox, haversineM, locationBoost } from "@/lib/geo";
import { cadenceFor, CADENCE_DEFAULTS } from "@/lib/warmth";

/**
 * GET /api/v1/today?lat=&lng=
 *
 * The home screen in one round trip: where you are, who is probably here, what
 * you owe, who is slipping, and what Kith heard but could not place.
 *
 * Every block hides when it is empty, so a quiet day is a short screen rather
 * than five headings over nothing. Location only ever adds: it names the place
 * and lifts the people you see there, and removes nobody.
 */

/** How far a place still counts as "you are here". */
const NEAR_M = 1_500;

export const GET = route(async (req: Request) => {
  const userId = await requireUser();
  const url = new URL(req.url);
  const lat = Number(url.searchParams.get("lat"));
  const lng = Number(url.searchParams.get("lng"));
  const here = Number.isFinite(lat) && Number.isFinite(lng) && (lat !== 0 || lng !== 0) ? { lat, lng } : null;

  const d = db();
  const [me, roster, open, loose, waiting, near] = await Promise.all([
    d.query.users.findFirst({ where: eq(users.id, userId), columns: { name: true, cadenceDefaults: true } }),
    d.select({
      id: people.id, displayName: people.displayName, goesBy: people.goesBy, pronunciation: people.pronunciation,
      circle: people.circle, tags: people.tags, role: people.role,
      lastInteractionAt: people.lastInteractionAt, warmth: people.warmth, cadenceDays: people.cadenceDays,
    }).from(people).where(and(eq(people.userId, userId), isNull(people.archivedAt))).limit(1000),
    d.select({
      id: threads.id, title: threads.title, dueAt: threads.dueAt, personId: threads.personId,
      createdFromCaptureId: threads.createdFromCaptureId,
    }).from(threads)
      .where(and(eq(threads.userId, userId), eq(threads.status, "open")))
      .orderBy(sql`${threads.dueAt} asc nulls last`)
      .limit(12),
    d.select({ id: looseThreads.id, content: looseThreads.content, captureId: looseThreads.captureId, createdAt: looseThreads.createdAt })
      .from(looseThreads)
      .where(and(eq(looseThreads.userId, userId), isNull(looseThreads.resolvedPersonId), isNull(looseThreads.dismissedAt)))
      .orderBy(desc(looseThreads.createdAt))
      .limit(5),
    d.select({ id: captures.id, capturedAt: captures.capturedAt })
      .from(captures)
      .where(and(eq(captures.userId, userId), eq(captures.status, "needs_review")))
      .orderBy(asc(captures.capturedAt))
      .limit(20),
    here ? nearbyPlaces(userId, here) : Promise.resolve([]),
  ]);

  const byId = new Map(roster.map((p) => [p.id, p]));
  const defaults = me?.cadenceDefaults ?? CADENCE_DEFAULTS;

  // Who you are probably standing near, and why.
  const links = near.length
    ? await d.select().from(personPlaces).where(and(
        eq(personPlaces.userId, userId),
        inArray(personPlaces.placeId, near.map((p) => p.id)),
      ))
    : [];
  const hereNow = new Map<string, { place: string; boost: number }>();
  for (const link of links) {
    const place = near.find((n) => n.id === link.placeId);
    if (!place) continue;
    const boost = locationBoost({ distanceM: place.distanceM, placeWeight: link.weight, radiusM: place.radiusM });
    const had = hereNow.get(link.personId);
    if (boost > 0 && (!had || boost > had.boost)) hereNow.set(link.personId, { place: place.name, boost });
  }

  // Slipping is only ever about someone you have actually seen. A person you
  // added and never met is not slipping; they were never warm.
  const now = Date.now();
  const slipping = roster
    .filter((p) => p.lastInteractionAt && !hereNow.has(p.id))
    .map((p) => {
      const days = Math.floor((now - new Date(p.lastInteractionAt!).getTime()) / 86_400_000);
      const cadence = cadenceFor(p, defaults);
      return { person: row(p), daysSince: days, cadenceDays: cadence, over: days - cadence };
    })
    .filter((x) => x.over > 0)
    .sort((a, b) => b.over - a.over)
    .slice(0, 5)
    .map(({ over, ...rest }) => rest);

  return NextResponse.json({
    /** For the greeting. The phone knows the time of day; only the name comes from here. */
    firstName: (me?.name ?? "").trim().split(/\s+/)[0] || null,
    place: near[0] ? { id: near[0].id, name: near[0].name, distanceM: Math.round(near[0].distanceM) } : null,
    likelyHere: [...hereNow.entries()]
      .sort((a, b) => b[1].boost - a[1].boost)
      .slice(0, 4)
      .map(([id, v]) => ({ person: row(byId.get(id)!), place: v.place }))
      .filter((x) => x.person),
    threads: open.map((t) => ({
      id: t.id,
      title: t.title,
      dueAt: t.dueAt?.toISOString() ?? null,
      captureId: t.createdFromCaptureId,
      person: t.personId && byId.has(t.personId)
        ? { id: t.personId, displayName: byId.get(t.personId)!.displayName }
        : null,
    })),
    slipping,
    loose: loose.map((l) => ({ id: l.id, content: l.content, captureId: l.captureId, at: l.createdAt.toISOString() })),
    /** Notes still waiting for a look, oldest first. The strip counts them; this opens them. */
    review: { count: waiting.length, oldestId: waiting[0]?.id ?? null },
  });
});

/** The people list's row shape, so Today and People draw the same person. */
function row(p: {
  id: string; displayName: string; goesBy: string | null; pronunciation: string | null;
  circle: string; tags: string[]; role: string | null; lastInteractionAt: Date | null; warmth: number;
}) {
  return {
    id: p.id, displayName: p.displayName, goesBy: p.goesBy, pronunciation: p.pronunciation,
    circle: p.circle, tags: p.tags, role: p.role,
    lastInteractionAt: p.lastInteractionAt?.toISOString() ?? null, warmth: p.warmth,
  };
}

async function nearbyPlaces(userId: string, here: { lat: number; lng: number }) {
  const b = bbox(here.lat, here.lng, NEAR_M);
  const rows = await db().select().from(places).where(and(
    eq(places.userId, userId),
    sql`${places.lat} between ${b.minLat} and ${b.maxLat}`,
    sql`${places.lng} between ${b.minLng} and ${b.maxLng}`,
  )).limit(50);
  return rows
    .filter((p) => p.lat != null && p.lng != null)
    .map((p) => ({ ...p, distanceM: haversineM(here, { lat: p.lat!, lng: p.lng! }) }))
    .filter((p) => p.distanceM <= NEAR_M)
    .sort((a, b2) => a.distanceM - b2.distanceM)
    .slice(0, 6);
}
