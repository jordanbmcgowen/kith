/**
 * Turning what the user said about where a note happened into a places row.
 * Shared by the queue consumer (at extraction time) and filing (when the user
 * picks a place on the confirmation screen).
 */
import { and, eq, gte, lte, sql } from "drizzle-orm";
import { db, places } from "../db";
import { bbox, haversineM } from "./geo";

/**
 * The user typed where this happened. Match it to a place they already have,
 * case-insensitively and then by trigram similarity so "Brook Hollow" finds
 * "Brook Hollow Golf Club", or create it. If they typed a name while standing
 * there (coordinates present) and the place had none, learn them: from then
 * on plain "Here" matches it by proximity.
 */
export async function resolvePlaceByName(userId: string, hint: string, lat: number | null, lng: number | null) {
  const name = hint.trim().replace(/\s+/g, " ");
  if (!name) return null;

  const exact = sql`lower(${places.name}) = lower(${name})`;
  const similar = sql`similarity(${places.name}, ${name})`;
  const [hit] = await db().select({ place: places })
    .from(places)
    .where(and(eq(places.userId, userId), sql`(${exact} or ${similar} > 0.45)`))
    .orderBy(sql`${exact} desc`, sql`${similar} desc`)
    .limit(1);

  if (hit) {
    const learn = lat != null && lng != null && hit.place.lat == null;
    await db().update(places).set({
      visitCount: sql`${places.visitCount} + 1`,
      lastVisitedAt: new Date(),
      ...(learn ? { lat, lng } : {}),
    }).where(eq(places.id, hit.place.id));
    return learn ? { ...hit.place, lat, lng } : hit.place;
  }

  const [row] = await db().insert(places).values({
    userId, name, kind: "other", lat, lng, visitCount: 1, lastVisitedAt: new Date(),
  }).returning();
  return row;
}

/**
 * Matches coordinates to a place you already know before asking Google. Most
 * captures happen at the handful of places you actually go, so this keeps the
 * Places bill near zero. Without a Google key, unknown coordinates stay
 * unnamed rather than guessed.
 */
export async function resolvePlace(userId: string, lat: number, lng: number, googleKey?: string) {
  const b = bbox(lat, lng, 400);
  const known = await db().select().from(places).where(and(
    eq(places.userId, userId),
    gte(places.lat, b.minLat), lte(places.lat, b.maxLat),
    gte(places.lng, b.minLng), lte(places.lng, b.maxLng),
  ));

  const hit = known
    .filter((p) => p.lat != null && p.lng != null)
    .map((p) => ({ p, d: haversineM({ lat, lng }, { lat: p.lat!, lng: p.lng! }) }))
    .filter((x) => x.d <= x.p.radiusM)
    .sort((a, c) => a.d - c.d)[0];

  if (hit) {
    await db().update(places)
      .set({ visitCount: sql`${places.visitCount} + 1`, lastVisitedAt: new Date() })
      .where(eq(places.id, hit.p.id));
    return hit.p;
  }

  if (!googleKey) return null;
  const res = await fetch("https://places.googleapis.com/v1/places:searchNearby", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": googleKey,
      "X-Goog-FieldMask": "places.id,places.displayName,places.location",
    },
    body: JSON.stringify({
      maxResultCount: 1,
      locationRestriction: { circle: { center: { latitude: lat, longitude: lng }, radius: 90 } },
    }),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as any;
  const g = json.places?.[0];
  if (!g) return null;

  const [row] = await db().insert(places).values({
    userId,
    name: g.displayName?.text ?? "Unnamed place",
    googlePlaceId: g.id,
    lat: g.location?.latitude ?? lat,
    lng: g.location?.longitude ?? lng,
    visitCount: 1,
    lastVisitedAt: new Date(),
  }).onConflictDoUpdate({
    target: [places.userId, places.googlePlaceId],
    set: { visitCount: sql`${places.visitCount} + 1`, lastVisitedAt: new Date() },
  }).returning();

  return row;
}
