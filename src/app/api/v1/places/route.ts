import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { route } from "@/lib/api";
import { db, places } from "@/db";
import { bbox, haversineM } from "@/lib/geo";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";

/**
 * GET /api/v1/places?lat=&lng=
 *
 * The places you have already named, nearest first when the phone knows where
 * it is. This exists so naming a place gets cheaper every time: the first
 * visit is typing, the second is a tap. Without it a place list never
 * accumulates, and without places, location can never rank anything.
 *
 * Coordinates only ever order this list. With none, it is your most-visited
 * places, which is still the right list to offer.
 */
const NEAR_M = 800;
const LIMIT = 8;

export const GET = route(async (req: Request) => {
  const userId = await requireUser();
  const url = new URL(req.url);
  const lat = Number(url.searchParams.get("lat"));
  const lng = Number(url.searchParams.get("lng"));
  const here = Number.isFinite(lat) && Number.isFinite(lng) && (lat !== 0 || lng !== 0) ? { lat, lng } : null;

  const d = db();
  if (!here) {
    const rows = await d.select({ id: places.id, name: places.name, lat: places.lat, lng: places.lng, visitCount: places.visitCount })
      .from(places).where(eq(places.userId, userId))
      .orderBy(desc(places.visitCount), desc(places.lastVisitedAt))
      .limit(LIMIT);
    return NextResponse.json({ places: rows.map((r) => ({ id: r.id, name: r.name, distanceM: null })) });
  }

  // A bounding box first, then the real distance on the few rows it returns.
  const box = bbox(here.lat, here.lng, NEAR_M);
  const rows = await d.select({ id: places.id, name: places.name, lat: places.lat, lng: places.lng, visitCount: places.visitCount })
    .from(places)
    .where(and(
      eq(places.userId, userId),
      isNotNull(places.lat),
      isNotNull(places.lng),
      sql`${places.lat} between ${box.minLat} and ${box.maxLat}`,
      sql`${places.lng} between ${box.minLng} and ${box.maxLng}`,
    ))
    .limit(50);

  const near = rows
    .filter((r) => r.lat != null && r.lng != null)
    .map((r) => ({ id: r.id, name: r.name, distanceM: Math.round(haversineM(here, { lat: r.lat!, lng: r.lng! })) }))
    .filter((r) => r.distanceM <= NEAR_M)
    .sort((a, b) => a.distanceM - b.distanceM)
    .slice(0, LIMIT);

  return NextResponse.json({ places: near });
});
