import { db, users, people, interactions } from "@/db";
import { cadenceFor, CADENCE_DEFAULTS, warmth as computeWarmth } from "@/lib/warmth";
import { and, eq, sql } from "drizzle-orm";

/**
 * Last seen and warmth are read back out of the interactions table, never
 * bumped. Anything that adds, moves or removes a visit calls this afterwards,
 * so the two numbers can never drift from the visits they describe. A re-file
 * that replaces a visit lands on the same answer as adding one by hand.
 *
 * Warmth also depends on the cadence, which the circle sets, so changing
 * someone's circle goes through here too.
 */
export async function refreshPerson(userId: string, personId: string): Promise<void> {
  const d = db();
  const [person, prefs, agg] = await Promise.all([
    d.query.people.findFirst({
      where: and(eq(people.id, personId), eq(people.userId, userId)),
      columns: { circle: true, cadenceDays: true },
    }),
    d.query.users.findFirst({ where: eq(users.id, userId), columns: { cadenceDefaults: true } }),
    d.execute(sql`
      select count(*) filter (where occurred_at > now() - interval '90 days') recent,
             max(occurred_at) last
      from ${interactions} where user_id = ${userId} and person_id = ${personId}`),
  ]);
  if (!person) return;

  const a = agg.rows[0] as { recent: unknown; last: string | Date | null };
  const last = a?.last ? new Date(a.last) : null;
  await d.update(people)
    .set({
      lastInteractionAt: last,
      warmth: computeWarmth({
        lastInteractionAt: last,
        cadenceDays: cadenceFor(person, prefs?.cadenceDefaults ?? CADENCE_DEFAULTS),
        interactionsLast90: Number(a?.recent ?? 0),
      }),
      updatedAt: new Date(),
    })
    .where(and(eq(people.id, personId), eq(people.userId, userId)));
}
