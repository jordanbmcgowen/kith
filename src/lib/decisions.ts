import type { ExtractionResult, FilingDecisions } from "../db/schema";

/**
 * The model's own proposal as decisions: match what it matched, create what
 * it called new, keep everything, keep the place the note resolved to. Tags
 * are the complete list the person ends up with: what they already carry
 * plus what this note proposes. Pure, so the confirmation screen and the
 * filing module start from the same place.
 */
export function defaultDecisions(
  x: ExtractionResult,
  placeId: string | null,
  /** A person's current tags, by id. Absent means nobody has any yet. */
  tagsOf: (personId: string) => string[] = () => [],
): FilingDecisions {
  return {
    people: x.people.map((p) => p.matchedPersonId
      ? { action: "match", personId: p.matchedPersonId, tags: mergeTags(tagsOf(p.matchedPersonId), p.tags ?? []) }
      : { action: "new", personId: null, tags: mergeTags([], p.tags ?? []) }),
    facts: x.facts.map(() => ({ keep: true })),
    interactions: x.interactions.map(() => ({ keep: true })),
    threads: x.threads.map(() => ({ keep: true })),
    unresolved: x.unresolved.map(() => ({ personId: null, dismissed: false })),
    place: { placeId, name: null },
  };
}

/** Existing first, then new ones, no case-insensitive duplicates, no blanks. */
export function mergeTags(existing: string[], proposed: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of [...existing, ...proposed]) {
    const clean = t.trim().replace(/\s+/g, " ");
    const k = clean.toLowerCase();
    if (!clean || seen.has(k)) continue;
    seen.add(k);
    out.push(clean);
  }
  return out;
}
