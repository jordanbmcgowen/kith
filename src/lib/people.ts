import { db, users, people, interactions } from "@/db";
import { cadenceFor, warmth as computeWarmth } from "@/lib/warmth";
import { and, eq, sql } from "drizzle-orm";

/**
 * Last seen and warmth are read back out of the interactions table, never
 * bumped. Anything that adds, moves or removes a visit calls this afterwards,
 * so the two numbers can never drift from the visits they describe. A re-file
 * that replaces a visit lands on the same answer as adding one by hand.
 *
 * Warmth is read against the cadence, so changing a person's own cadence, or
 * the default behind it, goes through here too.
 */
export async function refreshPerson(userId: string, personId: string): Promise<void> {
  await refreshMany(userId, [personId]);
}

/**
 * The same, for a handful at once, in two reads and one write however many
 * there are. Logging a visit for everyone at the soccer game is one action,
 * so recomputing what it means to them is one statement, not one per person.
 *
 * Both numbers are written here. Warmth is read against the cadence and last
 * seen is the date of the most recent visit, and both come out of the same
 * aggregate, so they cannot be written from different answers.
 */
export async function refreshMany(userId: string, personIds: string[]): Promise<number> {
  const ids = [...new Set(personIds)];
  if (!ids.length) return 0;
  const d = db();

  const [prefs, rows] = await Promise.all([
    d.query.users.findFirst({ where: eq(users.id, userId), columns: { cadenceDefaults: true } }),
    d.execute(sql`
      select p.id, p.cadence_days,
             max(i.occurred_at) as last,
             count(i.id) filter (where i.occurred_at > now() - interval '90 days') as recent
      from ${people} p
      left join ${interactions} i on i.person_id = p.id and i.user_id = ${userId}
      where p.user_id = ${userId} and p.id in (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
      group by p.id`),
  ]);

  const defaults = prefs?.cadenceDefaults ?? {};
  const next = (rows.rows as { id: string; cadence_days: number | null; last: string | Date | null; recent: unknown }[])
    .map((r) => ({
      id: r.id,
      last: r.last ? new Date(r.last) : null,
      warmth: computeWarmth({
        lastInteractionAt: r.last ? new Date(r.last) : null,
        cadenceDays: cadenceFor({ cadenceDays: r.cadence_days }, defaults),
        interactionsLast90: Number(r.recent ?? 0),
      }),
    }));
  if (!next.length) return 0;

  await d.execute(sql`
    update ${people} set last_interaction_at = v.last, warmth = v.w, updated_at = now()
    from (values ${sql.join(next.map((n) => sql`(${n.id}::uuid, ${n.last ? sql`${n.last.toISOString()}::timestamptz` : sql`null::timestamptz`}, ${n.warmth}::int)`), sql`, `)}) as v(id, last, w)
    where ${people}.id = v.id and ${people}.user_id = ${userId}`);
  return next.length;
}

/**
 * The same recompute, for everyone at once. Changing your cadence changes what
 * "keeping up" means for every person who inherits it, and warmth
 * is stored rather than derived on read, so it has to be rewritten or the
 * meters go on describing the old answer.
 *
 * Two reads and one write, whatever the roster size. The formula stays in
 * warmth.ts: writing a second copy of it in SQL is how the two drift apart.
 */
export async function refreshEveryone(userId: string): Promise<number> {
  const d = db();
  const [prefs, rows] = await Promise.all([
    d.query.users.findFirst({ where: eq(users.id, userId), columns: { cadenceDefaults: true } }),
    d.execute(sql`
      select p.id, p.cadence_days,
             max(i.occurred_at) as last,
             count(i.id) filter (where i.occurred_at > now() - interval '90 days') as recent
      from ${people} p
      left join ${interactions} i on i.person_id = p.id and i.user_id = ${userId}
      where p.user_id = ${userId} and p.archived_at is null
      group by p.id`),
  ]);

  const defaults = prefs?.cadenceDefaults ?? {};
  const next = (rows.rows as { id: string; cadence_days: number | null; last: string | Date | null; recent: unknown }[])
    .map((r) => ({
      id: r.id,
      warmth: computeWarmth({
        lastInteractionAt: r.last ? new Date(r.last) : null,
        cadenceDays: cadenceFor({ cadenceDays: r.cadence_days }, defaults),
        interactionsLast90: Number(r.recent ?? 0),
      }),
    }));
  if (!next.length) return 0;

  await d.execute(sql`
    update ${people} set warmth = v.w, updated_at = now()
    from (values ${sql.join(next.map((n) => sql`(${n.id}::uuid, ${n.warmth}::int)`), sql`, `)}) as v(id, w)
    where ${people}.id = v.id and ${people}.user_id = ${userId}`);
  return next.length;
}
