import type { ExtractionResult, FilingDecisions } from "../db/schema";

/**
 * The model's own proposal as decisions: match what it matched, create what
 * it called new, keep everything, keep the place the note resolved to. Pure,
 * so the confirmation screen and the filing module start from the same place.
 */
export function defaultDecisions(x: ExtractionResult, placeId: string | null): FilingDecisions {
  return {
    people: x.people.map((p) => p.matchedPersonId
      ? { action: "match", personId: p.matchedPersonId }
      : { action: "new", personId: null, ...(p.circle ? { circle: p.circle } : {}) }),
    facts: x.facts.map(() => ({ keep: true })),
    interactions: x.interactions.map(() => ({ keep: true })),
    threads: x.threads.map(() => ({ keep: true })),
    unresolved: x.unresolved.map(() => ({ personId: null, dismissed: false })),
    place: { placeId, name: null },
  };
}
