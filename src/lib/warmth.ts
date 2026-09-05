/**
 * Warmth is a 0-100 read on whether a relationship is being kept up, relative
 * to the cadence YOU set for that person. It is deliberately not a streak and
 * not a score you can grind. It only ever affects ordering and the "slipping"
 * section; it is never shown to the other person.
 */
export function warmth(opts: {
  lastInteractionAt: Date | null;
  cadenceDays: number;
  interactionsLast90: number;
}): number {
  const { lastInteractionAt, cadenceDays, interactionsLast90 } = opts;
  if (!lastInteractionAt) return 40;

  const days = (Date.now() - lastInteractionAt.getTime()) / 86_400_000;
  const ratio = days / Math.max(cadenceDays, 1);

  // 100 when fresh, 60 at exactly one cadence, decaying after.
  let base: number;
  if (ratio <= 1) base = 100 - 40 * ratio;
  else base = Math.max(0, 60 - 30 * (ratio - 1));

  // A little credit for consistency, capped so it cannot mask a long silence.
  const consistency = Math.min(10, interactionsLast90 * 2);
  return Math.round(Math.max(0, Math.min(100, base + consistency)));
}

export function cadenceFor(
  person: { cadenceDays: number | null; circle: string },
  defaults: Record<string, number>,
): number {
  return person.cadenceDays ?? defaults[person.circle] ?? 60;
}
