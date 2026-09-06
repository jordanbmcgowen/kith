import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { route } from "@/lib/api";
import { db, people } from "@/db";
import { isNull } from "drizzle-orm";
import { z } from "zod";

/** Circles must match the `circle` enum in src/db/schema.ts. */
const CIRCLES = ["family", "friends", "work", "neighbors", "other"] as const;

const newPerson = z.object({
  displayName: z.string().trim().min(1, "Name is required"),
  circle: z.enum(CIRCLES).default("other"),
  role: z.string().trim().nullish(),
  pronunciation: z.string().trim().nullish(),
  goesBy: z.string().trim().nullish(),
});

export const GET = route(async (req: Request) => {
  const userId = await requireUser();
  const circle = new URL(req.url).searchParams.get("circle");
  const rows = await db().query.people.findMany({
    where: (p, { and: a, eq: e }) =>
      a(e(p.userId, userId), isNull(p.archivedAt), ...(circle && circle !== "all" ? [e(p.circle, circle as any)] : [])),
    orderBy: (p, { desc: d }) => d(p.lastInteractionAt),
    limit: 500,
  });
  return NextResponse.json({ people: rows });
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
    circle: body.circle,
    role: body.role ?? null,
    pronunciation: body.pronunciation ?? null,
    goesBy: body.goesBy ?? null,
  }).returning();
  return NextResponse.json({ person: row }, { status: 201 });
});
