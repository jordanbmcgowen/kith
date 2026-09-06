import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { route } from "@/lib/api";
import { db, people, places, personPlaces, threads } from "@/db";
import { and, eq, lte, sql, isNull, gte, inArray } from "drizzle-orm";
import { bbox, haversineM, locationBoost } from "@/lib/geo";

/**
 * GET /api/v1/today?lat=&lng=
 *
 * The home screen in one round trip. Ranking is:
 *   base = urgency from warmth decay
 *        + overdue threads
 *        + location boost, if coordinates were sent
 *
 * Location only ever adds. Nobody drops off the list because of where you are.
 */
export const GET = route(async (req: Request) => {
  const userId = await requireUser();
  const url = new URL(req.url);
  const lat = Number(url.searchParams.get("lat"));
  const lng = Number(url.searchParams.get("lng"));
  const hasGeo = Number.isFinite(lat) && Number.isFinite(lng);

  const [roster, due, nearbyPlaces] = await Promise.all([
    db().query.people.findMany({
      where: and(eq(people.userId, userId), isNull(people.archivedAt)),
      with: { facts: { where: (f, { eq }) => eq(f.pinned, true), limit: 3 } },
      limit: 500,
    }),
    db().query.threads.findMany({
      where: and(eq(threads.userId, userId), eq(threads.status, "open")),
      orderBy: (t, { asc }) => asc(t.dueAt),
      limit: 25,
    }),
    hasGeo ? nearby(userId, lat, lng) : Promise.resolve([]),
  ]);

  const placeIds = new Set(nearbyPlaces.map((p) => p.id));
  const links = placeIds.size
    ? await db().select().from(personPlaces).where(
        and(eq(personPlaces.userId, userId), inArray(personPlaces.placeId, [...placeIds])),
      )
    : [];

  const overdueByPerson = new Map<string, number>();
  const now = Date.now();
  for (const t of due) {
    if (!t.personId) continue;
    const late = t.dueAt && t.dueAt.getTime() < now;
    overdueByPerson.set(t.personId, (overdueByPerson.get(t.personId) ?? 0) + (late ? 30 : 10));
  }

  const ranked = roster.map((p) => {
    let score = Math.max(0, 60 - p.warmth) + (overdueByPerson.get(p.id) ?? 0);
    let hereBecause: string | null = null;

    for (const link of links.filter((l) => l.personId === p.id)) {
      const place = nearbyPlaces.find((n) => n.id === link.placeId)!;
      const boost = locationBoost({ distanceM: place.distanceM, placeWeight: link.weight, radiusM: place.radiusM });
      if (boost > 0) { score += boost; hereBecause = place.name; }
    }
    return { ...p, score, hereBecause };
  }).sort((a, b) => b.score - a.score);

  return NextResponse.json({
    place: nearbyPlaces[0]?.name ?? null,
    likelyHere: ranked.filter((p) => p.hereBecause).slice(0, 4),
    slipping: ranked.filter((p) => !p.hereBecause && p.warmth < 55).slice(0, 5),
    threads: due.slice(0, 8),
  });
});

async function nearby(userId: string, lat: number, lng: number) {
  const b = bbox(lat, lng, 1500);
  const rows = await db().select().from(places).where(and(
    eq(places.userId, userId),
    gte(places.lat, b.minLat), lte(places.lat, b.maxLat),
    gte(places.lng, b.minLng), lte(places.lng, b.maxLng),
  ));
  return rows
    .filter((p) => p.lat != null && p.lng != null)
    .map((p) => ({ ...p, distanceM: haversineM({ lat, lng }, { lat: p.lat!, lng: p.lng! }) }))
    .sort((a, b2) => a.distanceM - b2.distanceM)
    .slice(0, 6);
}
