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

/**
 * Days between visits, until you say otherwise. One number, not five.
 *
 * This used to be a cadence per circle, and circles are gone: they were five
 * buckets the app imposed, and a roster of sixty-one people put sixty of them
 * in "other", which is what a bucket looks like when it is not describing
 * anything. Groups are the user's own tags now, and how often to keep up is
 * one default plus a number on any person who deserves their own.
 */
export const DEFAULT_CADENCE_DAYS = 60;

/** Accounts written before circles were removed carry the five keys. */
export type CadenceDefaults = { everyone?: number } & Record<string, number>;

export function cadenceFor(
  person: { cadenceDays: number | null },
  defaults: CadenceDefaults,
): number {
  // `other` is the bridge: it is where almost everyone already was, so an
  // account that has not been re-saved yet keeps the answer it had.
  return person.cadenceDays ?? defaults.everyone ?? defaults.other ?? DEFAULT_CADENCE_DAYS;
}

/** The one number, however the account happens to have it stored. */
export const cadenceOf = (defaults: CadenceDefaults | null | undefined): number =>
  defaults?.everyone ?? defaults?.other ?? DEFAULT_CADENCE_DAYS;
