import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { route } from "@/lib/api";
import { db, people, facts, places } from "@/db";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";

const newPerson = z.object({
  displayName: z.string().trim().min(1, "Name is required"),
  tags: z.array(z.string().trim().min(1).max(40)).max(8).default([]),
  role: z.string().trim().nullish(),
  pronunciation: z.string().trim().nullish(),
  goesBy: z.string().trim().nullish(),
});

/**
 * GET /api/v1/people?tag=
 *
 * The people list. `tag` narrows it, and nothing else does: circles were five
 * groups the app invented and sixty of sixty-one people landed in "other", so
 * they are gone and the user's own tags are the only grouping. Location will
 * never narrow it either; when places exist it only reorders.
 *
 * Sorted by last seen, newest first; people with no visit noted yet come after,
 * by name. Alongside the rows: every tag the user has, most used first, for the
 * filter row, and the counts for the line under the heading. Both are for the
 * whole roster whatever the filter, so the filters do not move while you tap.
 */
export const GET = route(async (req: Request) => {
  const userId = await requireUser();
  const url = new URL(req.url);
  const tag = url.searchParams.get("tag")?.trim() || null;

  const d = db();
  const own = and(eq(people.userId, userId), isNull(people.archivedAt));
  const [rows, roster, totals] = await Promise.all([
    d.select({
      id: people.id, displayName: people.displayName, goesBy: people.goesBy, pronunciation: people.pronunciation,
      tags: people.tags, role: people.role,
      lastInteractionAt: people.lastInteractionAt, warmth: people.warmth,
    })
      .from(people)
      .where(and(
        own,
        // Tags keep one spelling per user, but a link typed by hand may not.
        ...(tag ? [sql`exists (select 1 from unnest(${people.tags}) as t where lower(t) = lower(${tag}))`] : []),
      ))
      .orderBy(sql`${people.lastInteractionAt} desc nulls last`, asc(people.displayName))
      .limit(500),
    d.select({ tags: people.tags }).from(people).where(own),
    d.execute(sql`
      select (select count(*) from ${facts} where ${facts.userId} = ${userId}) as facts,
             (select count(*) from ${places} where ${places.userId} = ${userId}) as places`),
  ]);

  const tagCounts = new Map<string, number>();
  for (const p of roster) for (const t of p.tags) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
  const tags = [...tagCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([t]) => t);
  const t = totals.rows[0] as { facts: unknown; places: unknown };

  return NextResponse.json({
    people: rows,
    tags,
    counts: { people: roster.length, facts: Number(t.facts), places: Number(t.places) },
  });
});

export const POST = route(async (req: Request) => {
  const userId = await requireUser();
  const parsed = newPerson.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }
  const body = parsed.data;
  const [row] = await db().insert(people).values({
    userId,
    displayName: body.displayName,
    tags: body.tags,
    role: body.role ?? null,
    pronunciation: body.pronunciation ?? null,
    goesBy: body.goesBy ?? null,
  }).returning();
  return NextResponse.json({ person: row }, { status: 201 });
});
