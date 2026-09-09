import { requireUser } from "@/lib/auth";
import { route } from "@/lib/api";
import { db, users, people, facts, interactions, threads, places, personPlaces, captures, looseThreads } from "@/db";
import { eq } from "drizzle-orm";

/**
 * GET /api/v1/me/export
 *
 * Everything Kith holds about you, as one JSON file you can keep. A private
 * memory system you cannot get your memories out of is a worse deal than a
 * notebook, so this is not a feature so much as the terms.
 *
 * It is your rows only, every one of them scoped by user id. Audio is named
 * by its key rather than inlined: the recordings live in R2 and a JSON file is
 * the wrong shape for them.
 */
export const GET = route(async () => {
  const userId = await requireUser();
  const d = db();
  const mine = <T extends { userId: unknown }>(t: T) => eq(t.userId as never, userId);

  const [me, p, f, i, t, pl, pp, c, l] = await Promise.all([
    d.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { name: true, email: true, timezone: true, cadenceDefaults: true, createdAt: true },
    }),
    d.select().from(people).where(mine(people)),
    d.select().from(facts).where(mine(facts)),
    d.select().from(interactions).where(mine(interactions)),
    d.select().from(threads).where(mine(threads)),
    d.select().from(places).where(mine(places)),
    d.select().from(personPlaces).where(mine(personPlaces)),
    d.select().from(captures).where(mine(captures)),
    d.select().from(looseThreads).where(mine(looseThreads)),
  ]);

  // The vectors are derived from the text that is already in here, and they
  // are 1536 numbers per row. Keeping them would multiply the file by fifty
  // and tell you nothing you cannot read in the fact itself.
  const noVectors = <T extends { embedding?: unknown }>(rows: T[]) =>
    rows.map(({ embedding, ...rest }) => rest);

  const body = JSON.stringify({
    exportedAt: new Date().toISOString(),
    format: "kith/v1",
    note: "Everything Kith holds for this account. Embeddings are left out: they are derived from the text beside them. Audio lives in object storage under audioKey.",
    account: me,
    people: p,
    facts: noVectors(f),
    interactions: noVectors(i),
    threads: t,
    places: pl,
    personPlaces: pp,
    captures: c,
    looseThreads: l,
  }, null, 2);

  const day = new Date().toISOString().slice(0, 10);
  return new Response(body, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="kith-${day}.json"`,
      "Cache-Control": "no-store",
    },
  });
});
