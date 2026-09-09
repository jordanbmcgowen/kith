import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { requireUser } from "@/lib/auth";
import { route } from "@/lib/api";
import { db, facts, interactions, people, places, personPlaces } from "@/db";
import { embedVia } from "@/lib/ai/embed";
import { excerpt } from "@/lib/format";
import { bbox, haversineM, locationBoost } from "@/lib/geo";
import { and, eq, inArray, sql } from "drizzle-orm";

/**
 * GET /api/v1/search?q=the+guy+at+the+golf+thing+who+flies&lat=&lng=
 *
 * Hybrid, because you remember people two different ways. Trigram over names,
 * tags and roles for when you remember the word; cosine over facts and visits
 * for when you only remember the shape of the thing. Every result carries the
 * snippet that matched, because "why" is what makes the answer trustworthy
 * instead of magic.
 *
 * The gates below were measured against real data, not guessed:
 * word_similarity scores a real first name or surname at 1.0 while a whole
 * sentence tops out near 0.1 across the roster, and cosine between unrelated
 * facts sits at 0.20 with only the top 1% past 0.50.
 */

/** A name is the strongest thing you can type. Below this it is a coincidence. */
const NAME_GATE = 0.5;
/** Tags and roles are short strings too, but they belong to more than one person. */
const WORD_GATE = 0.6;
/** Cosine. Under this it is the noise floor, not a memory. Measured against
 *  real queries on real data: right answers came back at 0.48 to 0.61 and the
 *  near-misses at 0.34 to 0.44. */
const VECTOR_GATE = 0.40;
/** How far below the best memory a weaker one may still be worth showing. A
 *  confident hit should not drag four vague ones along behind it. */
const VECTOR_BAND = 0.15;
/** One word of a sentence landing on a tag or a role. Whole words only. */
const WORD_IN_GATE = 0.8;
/** How many people a screenful is. */
const LIMIT = 10;
/** Cap on what standing somewhere may add. Reorders near-ties, never overturns a name. */
const MAX_LOCATION_BOOST = 0.08;
/** How far away a place still counts as "you are near it". */
const NEAR_M = 1_500;
/** Longer than this is not a search. The embedding model has a limit too. */
const MAX_Q = 400;

/** Module constants, not input: inline them so Postgres never has to infer a type. */
const n = (x: number) => sql.raw(String(x));

type Source = "name" | "tag" | "role" | "tagword" | "roleword" | "fact" | "visit";

type Hit = {
  person_id: string;
  score: number | string;
  snippet: string;
  source: Source;
  at: Date | string | null;
  display_name: string;
  goes_by: string | null;
  pronunciation: string | null;
  tags: string[];
  role: string | null;
  last_interaction_at: Date | string | null;
  warmth: number;
};

export const GET = route(async (req: Request) => {
  const userId = await requireUser();
  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, MAX_Q);

  // One character is a keystroke, not a question. An empty list, never an error.
  if (q.length < 2) return NextResponse.json({ results: [], hints: await hints(userId) });

  const vec = await embedQuery(q);
  const rows = (await db().execute(searchSql(userId, q, vec))).rows as unknown as Hit[];

  return NextResponse.json({
    results: await rank(userId, rows, coordsOf(url)),
    hints: [],
    // The semantic half is out. The screen says so rather than going quiet.
    ...(vec ? {} : { namesOnly: true }),
  });
});

/**
 * The query vector, from kith-processor over the service binding. The app
 * holds no model key on purpose.
 *
 * If the processor cannot answer, this returns null and search runs on names,
 * tags and roles alone. Half a search you can see beats a blank screen: the
 * response carries `namesOnly` so the app says what happened.
 */
async function embedQuery(q: string): Promise<number[] | null> {
  try {
    const { env } = getCloudflareContext();
    const [v] = await embedVia(env.PROCESSOR, [q]);
    return v?.length && v.every(Number.isFinite) ? v : null;
  } catch (err) {
    console.error("search: no embedding, falling back to names", err);
    return null;
  }
}

function searchSql(userId: string, q: string, vec: number[] | null) {
  // pgvector takes its literal as text.
  const v = vec ? `[${vec.join(",")}]` : null;

  // Typing "coffee" finds the three people whose role says coffee. So should
  // "the guy who does the coffee": the whole sentence scores far too low
  // against a two-word role, so each word of it gets its own look. The words
  // are stripped to letters and digits before they reach SQL.
  const words = queryWords(q);
  const wordwise = words.length
    ? sql`
      union all
      select p.id, t, 'tagword', null::timestamptz, max(word_similarity(w, t))
      from ${people} p, unnest(p.tags) t, unnest(string_to_array(${words.join(",")}, ',')) w
      where p.user_id = ${userId} and p.archived_at is null and word_similarity(w, t) >= ${n(WORD_IN_GATE)}
      group by p.id, t

      union all
      select p.id, p.role, 'roleword', null::timestamptz, max(word_similarity(w, p.role))
      from ${people} p, unnest(string_to_array(${words.join(",")}, ',')) w
      where p.user_id = ${userId} and p.archived_at is null and p.role is not null
        and word_similarity(w, p.role) >= ${n(WORD_IN_GATE)}
      group by p.id, p.role`
    : sql``;

  // Each branch gets its own subquery: an ORDER BY / LIMIT written straight
  // after a UNION ALL binds to the whole union, not to the branch above it.
  const semantic = v
    ? sql`
      union all
      select * from (
        select f.person_id, f.content as snippet, 'fact' as source, f.created_at as at,
               1 - (f.embedding <=> ${v}::vector) as raw
        from ${facts} f
        where f.user_id = ${userId} and f.person_id is not null
          and f.embedding is not null and f.superseded_by_id is null
        order by f.embedding <=> ${v}::vector
        limit 30
      ) fh

      union all
      select * from (
        select i.person_id, i.summary as snippet, 'visit' as source, i.occurred_at as at,
               1 - (i.embedding <=> ${v}::vector) as raw
        from ${interactions} i
        where i.user_id = ${userId} and i.person_id is not null and i.embedding is not null
        order by i.embedding <=> ${v}::vector
        limit 30
      ) vh`
    : sql``;

  // word_similarity, not similarity: it scores the query against the best
  // stretch of the target, so "mcclung" finds Bill McClung at 1.0 where plain
  // similarity gives 0.62 and "ben" only 0.33.
  return sql`
    with merged as (
      select p.id as person_id, p.display_name as snippet, 'name' as source,
             null::timestamptz as at,
             word_similarity(${q}, p.display_name || coalesce(' ' || p.goes_by, '')) as raw
      from ${people} p
      where p.user_id = ${userId} and p.archived_at is null
        and word_similarity(${q}, p.display_name || coalesce(' ' || p.goes_by, '')) >= ${n(NAME_GATE)}

      union all
      select p.id, t, 'tag', null::timestamptz, word_similarity(${q}, t)
      from ${people} p, unnest(p.tags) t
      where p.user_id = ${userId} and p.archived_at is null and word_similarity(${q}, t) >= ${n(WORD_GATE)}

      union all
      select p.id, p.role, 'role', null::timestamptz, word_similarity(${q}, p.role)
      from ${people} p
      where p.user_id = ${userId} and p.archived_at is null and p.role is not null
        and word_similarity(${q}, p.role) >= ${n(WORD_GATE)}
      ${wordwise}
      ${semantic}
    ),
    scored as (
      -- A name outranks a tag outranks a role outranks something you said
      -- about them. If you typed a name you meant the name; the gates above
      -- are what keep a weak trigram from beating a real memory.
      select person_id, snippet, source, at,
             case source
               when 'name'     then 0.60 + 0.40 * raw
               when 'tag'      then 0.50 + 0.30 * raw
               when 'role'     then 0.45 + 0.30 * raw
               -- One word of a sentence landing on a tag or a role is real,
               -- but it is not the sentence. It sits under a good memory.
               when 'tagword'  then 0.44 + 0.06 * raw
               when 'roleword' then 0.42 + 0.06 * raw
               when 'visit'    then raw * 0.97
               else raw
             end as score
      from merged
      where source not in ('fact', 'visit') or raw >= ${n(VECTOR_GATE)}
    ),
    kept as (
      -- Cosine has no absolute meaning, only a shape. When one memory answers
      -- the question at 0.61, the ones at 0.36 are the same few "works in..."
      -- facts that every work-shaped question drags along, and printing them
      -- costs more trust than the chance one was wanted. So a confident hit
      -- raises the floor under the weaker ones. This happens before a person
      -- is reduced to their best row, so someone whose fact is cut can still
      -- come back on their name or their tag.
      select * from (
        select s.*, max(case when source in ('fact', 'visit') then score end) over () as top_vector
        from scored s
      ) w
      where source not in ('fact', 'visit') or score >= top_vector - ${n(VECTOR_BAND)}
    ),
    best as (
      select distinct on (person_id) person_id, snippet, source, at, score
      from kept order by person_id, score desc
    )
    select b.person_id, b.score, b.snippet, b.source, b.at,
           p.display_name, p.goes_by, p.pronunciation, p.tags, p.role,
           p.last_interaction_at, p.warmth
    from best b
    join ${people} p on p.id = b.person_id and p.user_id = ${userId} and p.archived_at is null
    order by b.score desc, p.last_interaction_at desc nulls last
    limit ${n(LIMIT)}`;
}

const coordsOf = (url: URL) => {
  const lat = Number(url.searchParams.get("lat"));
  const lng = Number(url.searchParams.get("lng"));
  return Number.isFinite(lat) && Number.isFinite(lng) && (lat !== 0 || lng !== 0) ? { lat, lng } : null;
};

/** The driver hands timestamps back as Date or as text depending on the path. */
const iso = (v: Date | string | null) => (v instanceof Date ? v.toISOString() : v);

/**
 * Rows into what the screen renders. Where you are standing adds a little to
 * people you are usually near; it never removes anyone, and it is capped so
 * it can only reorder people who were already close together.
 */
async function rank(userId: string, rows: Hit[], here: { lat: number; lng: number } | null) {
  if (!rows.length) return [];
  const near = here
    ? await nearby(userId, rows.map((r) => r.person_id), here)
    : new Map<string, { boost: number; place: string }>();

  return rows
    .map((r) => {
      const close = near.get(r.person_id);
      return {
        person: {
          id: r.person_id,
          displayName: r.display_name,
          goesBy: r.goes_by,
          pronunciation: r.pronunciation,
          tags: r.tags,
          role: r.role,
          lastInteractionAt: iso(r.last_interaction_at),
          warmth: Number(r.warmth),
        },
        score: Number(Math.min(1, Number(r.score) + (close?.boost ?? 0)).toFixed(3)),
        why: why(r, close?.place),
        at: iso(r.at),
      };
    })
    .sort((a, b) => b.score - a.score);
}

/** The places you see these people, within reach of where you are standing. */
async function nearby(userId: string, ids: string[], here: { lat: number; lng: number }) {
  const box = bbox(here.lat, here.lng, NEAR_M);
  const rows = await db()
    .select({
      personId: personPlaces.personId,
      name: places.name,
      lat: places.lat,
      lng: places.lng,
      radiusM: places.radiusM,
      weight: personPlaces.weight,
    })
    .from(personPlaces)
    .innerJoin(places, eq(places.id, personPlaces.placeId))
    .where(and(
      eq(personPlaces.userId, userId),
      inArray(personPlaces.personId, ids),
      sql`${places.lat} between ${box.minLat} and ${box.maxLat}`,
      sql`${places.lng} between ${box.minLng} and ${box.maxLng}`,
    ));

  const best = new Map<string, { boost: number; place: string }>();
  for (const r of rows) {
    if (r.lat == null || r.lng == null) continue;
    const boost = Math.min(MAX_LOCATION_BOOST, locationBoost({
      distanceM: haversineM(here, { lat: r.lat, lng: r.lng }),
      placeWeight: r.weight,
      radiusM: r.radiusM,
    }) / 100);
    const had = best.get(r.personId);
    if (boost > 0 && (!had || boost > had.boost)) best.set(r.personId, { boost, place: r.name });
  }
  return best;
}

/**
 * The line under a result. The row already shows the name, the role and the
 * tags, so this says which one caught and, for a memory, reads it back. The
 * date stays in `at` for the screen to say in the phone's own time zone.
 */
function why(r: Hit, place?: string): string {
  const near = place ? ` / near ${place}` : "";
  switch (r.source) {
    case "name": return `Their name${near}`;
    // The row shows every tag, so name the one that caught. It shows the role
    // in full, so repeating it under the row says nothing.
    case "tag": case "tagword": return `Tag / ${r.snippet}${near}`;
    case "role": case "roleword": return `Their role${near}`;
    case "visit": return `Visit / ${excerpt(r.snippet, 80)}${near}`;
    default: return `Fact / ${excerpt(r.snippet, 80)}${near}`;
  }
}

/**
 * Words that identify nobody. They are dropped from a query before it is
 * matched word by word against tags and roles, and never offered as a hint.
 * "works" is in here because half the roles say it: matching on it turns
 * "who works in consulting" into a list of everyone who works anywhere.
 */
const STOP = new Set([
  "with", "from", "that", "this", "they", "their", "them", "been", "have", "some", "into", "also",
  "when", "will", "your", "about", "what", "where", "which", "whose", "there", "here", "just",
  "only", "very", "really", "works", "work", "working", "went", "goes", "going", "does", "doing",
  "know", "knows", "said", "told", "remember", "someone", "somebody", "anyone", "everyone", "thing", "things",
]);

/**
 * A query split into the words worth matching one at a time. Letters and
 * digits only, so nothing that reaches SQL as a comma-joined list can be
 * anything else. Three letters or fewer carries too little to match on.
 */
const queryWords = (q: string) =>
  [...new Set(q.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !STOP.has(w)))].slice(0, 12);

/**
 * "Try one", under an empty field. Every hint is a word the user typed
 * themselves: their most-used tags first, then the words that come up most in
 * the roles they wrote. Nothing invented, and a brand new account gets none,
 * which is the honest answer to "what can I search for" before you have told
 * it anything.
 */
async function hints(userId: string): Promise<string[]> {
  const rows = (await db().execute(sql`
    select word, kind from (
      select t as word, 'tag' as kind, count(*) as n, 1 as ord
      from ${people} p, unnest(p.tags) t
      where p.user_id = ${userId} and p.archived_at is null
      group by t
      union all
      select mode() within group (order by w) as word, 'role' as kind, count(*) as n, 2 as ord
      from ${people} p, unnest(regexp_split_to_array(coalesce(p.role, ''), '[^A-Za-z]+')) w
      where p.user_id = ${userId} and p.archived_at is null and length(w) >= 4
      group by lower(w)
      having count(*) >= 2
    ) h
    order by ord, n desc, word
  `)).rows as unknown as { word: string; kind: string }[];

  const out: string[] = [];
  for (const r of rows) {
    const w = (r.word ?? "").trim();
    const lower = w.toLowerCase();
    if (!w || (r.kind === "role" && STOP.has(lower))) continue;
    // One hint may not hide inside another: "YoungLife board" adds nothing
    // once "YoungLife" is on the list.
    if (out.some((h) => h.toLowerCase().includes(lower) || lower.includes(h.toLowerCase()))) continue;
    out.push(w);
    if (out.length === 3) break;
  }
  return out;
}
