/** Metres between two coordinates. */
export function haversineM(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** Degrees of latitude/longitude covering `metres`, for a cheap SQL prefilter. */
export function bbox(lat: number, lng: number, metres: number) {
  const dLat = metres / 111_320;
  const dLng = metres / (111_320 * Math.max(Math.cos((lat * Math.PI) / 180), 0.01));
  return { minLat: lat - dLat, maxLat: lat + dLat, minLng: lng - dLng, maxLng: lng + dLng };
}

/**
 * Location is a ranking signal, not a filter. A person you always see at this
 * place floats up; nobody is ever hidden because of where you are standing.
 */
export function locationBoost(opts: {
  distanceM: number;
  placeWeight: number;   // how often you have seen them here
  radiusM: number;
}): number {
  const { distanceM, placeWeight, radiusM } = opts;
  if (distanceM > radiusM * 8) return 0;
  const proximity = Math.max(0, 1 - distanceM / (radiusM * 8));
  const familiarity = Math.min(1, placeWeight / 5);
  return proximity * familiarity * 45;
}
