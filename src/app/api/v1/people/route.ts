import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { db, people } from "@/db";
import { isNull } from "drizzle-orm";

export async function GET(req: Request) {
  const userId = await requireUser();
  const circle = new URL(req.url).searchParams.get("circle");
  const rows = await db().query.people.findMany({
    where: (p, { and: a, eq: e }) =>
      a(e(p.userId, userId), isNull(p.archivedAt), ...(circle && circle !== "all" ? [e(p.circle, circle as any)] : [])),
    orderBy: (p, { desc: d }) => d(p.lastInteractionAt),
    limit: 500,
  });
  return NextResponse.json({ people: rows });
}

export async function POST(req: Request) {
  const userId = await requireUser();
  const body = await req.json();
  if (!body.displayName) return NextResponse.json({ error: "Name is required" }, { status: 400 });
  const [row] = await db().insert(people).values({
    userId,
    displayName: body.displayName,
    circle: body.circle ?? "other",
    role: body.role ?? null,
    pronunciation: body.pronunciation ?? null,
    goesBy: body.goesBy ?? null,
  }).returning();
  return NextResponse.json({ person: row }, { status: 201 });
}
