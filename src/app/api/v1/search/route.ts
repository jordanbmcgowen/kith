import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { db, facts, interactions, people } from "@/db";
import { embed } from "@/lib/ai/embed";
import { sql, and, eq } from "drizzle-orm";

/**
 * GET /api/v1/search?q=the+guy+at+the+golf+thing+who+flies
 *
 * Hybrid: trigram name match for when you do remember the name, cosine
 * similarity over facts and interactions for when you don't. Results carry the
 * matched snippet so the app can show WHY it matched — that is what makes the
 * answer trustworthy rather than magic.
 */
export async function GET(req: Request) {
  const userId = await requireUser();
  const q = (new URL(req.url).searchParams.get("q") ?? "").trim();
  if (q.length < 2) return NextResponse.json({ results: [] });

  const [vec] = await embed([q]);
  const v = sql.raw(`'[${vec.join(",")}]'::vector`);

  const hits = await db().execute(sql`
    WITH fact_hits AS (
      SELECT person_id, content AS snippet, 'fact' AS source,
             1 - (embedding <=> ${v}) AS score
      FROM ${facts}
      WHERE user_id = ${userId} AND person_id IS NOT NULL AND embedding IS NOT NULL
      ORDER BY embedding <=> ${v} LIMIT 20
    ),
    interaction_hits AS (
      SELECT person_id, summary AS snippet, 'interaction' AS source,
             1 - (embedding <=> ${v}) AS score
      FROM ${interactions}
      WHERE user_id = ${userId} AND person_id IS NOT NULL AND embedding IS NOT NULL
      ORDER BY embedding <=> ${v} LIMIT 20
    ),
    name_hits AS (
      SELECT id AS person_id, display_name AS snippet, 'name' AS source,
             similarity(display_name, ${q}) AS score
      FROM ${people}
      WHERE user_id = ${userId} AND similarity(display_name, ${q}) > 0.3
      LIMIT 10
    ),
    merged AS (
      SELECT * FROM fact_hits
      UNION ALL SELECT * FROM interaction_hits
      UNION ALL SELECT * FROM name_hits
    )
    SELECT person_id,
           MAX(score) AS score,
           (ARRAY_AGG(snippet ORDER BY score DESC))[1] AS snippet,
           (ARRAY_AGG(source  ORDER BY score DESC))[1] AS source
    FROM merged
    WHERE score > 0.25
    GROUP BY person_id
    ORDER BY score DESC
    LIMIT 8;
  `);

  const rows = hits.rows as { person_id: string; score: number; snippet: string; source: string }[];
  if (!rows.length) return NextResponse.json({ results: [] });

  const found = await db().query.people.findMany({
    where: (p, { inArray, and: a }) => a(eq(p.userId, userId), inArray(p.id, rows.map((r) => r.person_id))),
  });

  return NextResponse.json({
    results: rows.map((r) => ({
      person: found.find((p) => p.id === r.person_id),
      score: Number(r.score.toFixed(3)),
      why: `Matched ${r.source}: "${r.snippet}"`,
    })).filter((r) => r.person),
  });
}
