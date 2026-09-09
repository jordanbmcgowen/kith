import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { route } from "@/lib/api";
import { db, users, accounts, people, facts, interactions, threads, places, captures, looseThreads } from "@/db";
import { cadenceOf, DEFAULT_CADENCE_DAYS } from "@/lib/warmth";
import { refreshEveryone } from "@/lib/people";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

/**
 * GET /api/v1/me
 *
 * Who you are, what Kith is holding, and the one setting that changes what the
 * app says about people: how often you want to keep up. That number decides
 * who Today calls slipping and how warmth reads, and until recently it lived
 * only in the database with nowhere to see it. A judgment you cannot see is
 * not one you can argue with.
 *
 * "Connected" is derived from the scopes Google actually granted, never from a
 * list of what we hope is on.
 */
export const GET = route(async () => {
  const userId = await requireUser();
  const d = db();

  const [me, google, counts] = await Promise.all([
    d.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { name: true, email: true, image: true, timezone: true, cadenceDefaults: true, createdAt: true },
    }),
    d.select({ scope: accounts.scope }).from(accounts)
      .where(and(eq(accounts.userId, userId), eq(accounts.provider, "google")))
      .limit(1),
    d.execute(sql`
      select (select count(*) from ${people} where user_id = ${userId} and archived_at is null) people,
             (select count(*) from ${facts} where user_id = ${userId}) facts,
             (select count(*) from ${interactions} where user_id = ${userId}) visits,
             (select count(*) from ${threads} where user_id = ${userId} and status = 'open') threads,
             (select count(*) from ${places} where user_id = ${userId}) places,
             (select count(*) from ${captures} where user_id = ${userId}) notes,
             (select count(*) from ${looseThreads} where user_id = ${userId} and resolved_person_id is null and dismissed_at is null) loose`),
  ]);
  if (!me) return NextResponse.json({ error: "No account" }, { status: 404 });

  const scopes = (google[0]?.scope ?? "").split(/\s+/).filter(Boolean);
  const c = counts.rows[0] as Record<string, unknown>;

  return NextResponse.json({
    name: me.name,
    email: me.email,
    image: me.image,
    timezone: me.timezone,
    since: me.createdAt.toISOString(),
    cadence: cadenceOf(me.cadenceDefaults),
    /** Only what Google actually granted. Nothing here is aspirational. */
    connected: {
      google: true,
      calendar: scopes.some((s) => s.includes("calendar")),
      contacts: scopes.some((s) => s.includes("contacts")),
    },
    counts: Object.fromEntries(Object.entries(c).map(([k, v]) => [k, Number(v)])),
  });
});

const MePatch = z.object({
  timezone: z.string().trim().min(1).max(60).optional(),
  /** Days between visits. One to a year: anything else is a typo. */
  cadence: z.number().int().min(1).max(365).optional(),
}).strict();

/**
 * PATCH /api/v1/me
 *
 * Changing the cadence changes what keeping up means for everyone who has not
 * been given their own, and warmth is stored rather than worked out on read,
 * so every person is recomputed here. Otherwise the meters would go on
 * describing the old answer until each person happened to be written again.
 */
export const PATCH = route(async (req: Request) => {
  const userId = await requireUser();
  const parsed = MePatch.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return NextResponse.json({ error: `${issue?.path.join(".") || "body"}: ${issue?.message}` }, { status: 400 });
  }
  const body = parsed.data;
  if (!Object.keys(body).length) return NextResponse.json({ error: "Nothing to change" }, { status: 400 });

  const d = db();
  const me = await d.query.users.findFirst({ where: eq(users.id, userId), columns: { cadenceDefaults: true } });
  if (!me) return NextResponse.json({ error: "No account" }, { status: 404 });

  // One key from here on. The old per-circle keys are dropped rather than kept
  // alongside, so nothing can read a stale bucket later.
  const cadence = body.cadence ? { everyone: body.cadence } : undefined;

  await d.update(users).set({
    ...(body.timezone ? { timezone: body.timezone } : {}),
    ...(cadence ? { cadenceDefaults: cadence } : {}),
  }).where(eq(users.id, userId));

  const touched = cadence ? await refreshEveryone(userId) : 0;
  return NextResponse.json({ ok: true, recomputed: touched });
});
