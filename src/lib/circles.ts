import type { Circle } from "../db/schema";

/**
 * The five circles, in the order they appear on screen, with the color each
 * one reads in. A person's circle shows as a 6px square beside their name and
 * as the fill behind their initials; never as a rail, never as a ring.
 */
export const CIRCLES: { key: Circle; label: string; color: string }[] = [
  { key: "family", label: "Family", color: "var(--clay)" },
  { key: "friends", label: "Friends", color: "var(--verdigris)" },
  { key: "work", label: "Work", color: "var(--sky)" },
  { key: "neighbors", label: "Neighbors", color: "var(--wisteria)" },
  { key: "other", label: "Other", color: "var(--text-2)" },
];

export const circleColor = (c: string | null | undefined) =>
  CIRCLES.find((x) => x.key === c)?.color ?? "var(--text-2)";

export const circleLabel = (c: string | null | undefined) =>
  CIRCLES.find((x) => x.key === c)?.label ?? "Other";

/** "Marcus Ellery" -> "ME", "Dre" -> "D". Squared, like a card index. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.slice(0, 2).map((w) => w[0]).join("");
  return (letters || "?").toUpperCase();
}
