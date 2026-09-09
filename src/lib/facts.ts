/**
 * What a fact is about, in the user's words rather than the enum's.
 *
 * `facts.kind` was six values the user never saw: identity, relation,
 * preference, history, sensitive, context. Three of them ("context" most of
 * all) were catch-alls, and the two subjects that come up in nearly every
 * note had nowhere to land. Where someone works went to "history", which also
 * means alma mater, or to "context", which means everything. A trip had no
 * home at all.
 *
 * So work and travel are kinds now, "relation" widened from family to anyone
 * they named, and the kind is on screen: it labels the row on the review
 * screen, it can be changed there with one tap, and it decides which block a
 * fact sits in on the person's page.
 */
import type { FactKind } from "../db/schema";

/** One word per kind. Shown on a review row and in the chooser. */
export const FACT_LABELS: Record<FactKind, string> = {
  work: "Work",
  relation: "Family",
  travel: "Travel",
  preference: "Likes",
  history: "Past",
  sensitive: "Careful",
  identity: "Basics",
  context: "Note",
};

/**
 * The chooser, in order. The three Jordan named come first because they are
 * what a note is usually about; Note is last because it is where anything
 * that is none of the others belongs, and it is the default.
 */
export const FACT_PICKS: FactKind[] = [
  "work", "relation", "travel", "preference", "history", "sensitive", "identity", "context",
];

/** What a fact the user types is, until they say otherwise. */
export const DEFAULT_FACT_KIND: FactKind = "context";

/**
 * How a person's page is divided. In order, and a block with nothing in it
 * is not drawn, the same as every other block in the app: a person with two
 * facts should not get four headings.
 *
 * "Remember first" keeps the general things and stays at the top, because
 * that is what you want in your head walking in. The three specific subjects
 * follow it.
 */
export const FACT_SECTIONS: { label: string; kinds: FactKind[] }[] = [
  { label: "Remember first", kinds: ["identity", "sensitive", "preference", "history", "context"] },
  { label: "Work", kinds: ["work"] },
  { label: "Family and friends", kinds: ["relation"] },
  { label: "Travel", kinds: ["travel"] },
];

/** Group facts into the blocks above, dropping the blocks that stay empty. */
export function bySection<T extends { kind: FactKind }>(facts: T[]): { label: string; facts: T[] }[] {
  return FACT_SECTIONS
    .map(({ label, kinds }) => ({ label, facts: facts.filter((f) => kinds.includes(f.kind)) }))
    .filter((s) => s.facts.length > 0);
}
