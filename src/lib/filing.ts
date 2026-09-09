/**
 * Filing: a capture's stored extraction, plus the user's decisions, becomes
 * rows. Facts, interactions, threads, loose threads, people, warmth.
 *
 * The same function runs in two places. The queue consumer calls it when every
 * person in the extraction clears AUTO_FILE_THRESHOLD, with no decisions, which
 * means "as proposed". POST /api/v1/captures/:id/confirm calls it with the
 * decisions the user made on the confirmation screen, whether the note was
 * waiting for them or had already filed itself.
 *
 * Everything it writes is derived from one capture and re-runnable. A second
 * run replaces what the first one filed, reuses the person rows the first one
 * created, and removes any of those the new run no longer needs, as long as
 * nothing else refers to them. Running it twice with the same decisions leaves
 * the database exactly as it was after the first run.
 */
import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { z } from "zod";
import {
  db, users, captures, people, facts, interactions, threads, places, personPlaces, looseThreads,
  factKindEnum,
  type ExtractionResult, type CaptureFiling, type FilingDecisions,
} from "../db";
import { warmth, cadenceFor } from "./warmth";
import { resolvePlaceByName } from "./places";
import { AUTO_FILE_THRESHOLD } from "./ai/threshold";
import { defaultDecisions, mergeTags } from "./decisions";

export { defaultDecisions };

/** A note that would add this many people at once waits for a look, whatever the confidence. */
export const NEW_PEOPLE_REVIEW_AT = 3;

/** Kinds worth surfacing first on a person. Matches the old worker. */
const PINNED_KINDS = new Set(["relation", "identity", "sensitive"]);

const uuid = z.string().uuid();

/** The request body of the confirm endpoint. Same shape as FilingDecisions in the schema. */
export const DecisionsSchema = z.object({
  people: z.array(z.object({
    action: z.enum(["match", "new", "drop"]),
    personId: uuid.nullable(),
    tags: z.array(z.string().trim().min(1).max(40)).max(8).optional(),
  })),
  // `text` and the dates are the user's corrections. Absent means the model's
  // own words stand.
  facts: z.array(z.object({
    keep: z.boolean(),
    text: z.string().trim().min(1).max(2000).optional(),
    kind: z.enum(factKindEnum.enumValues).optional(),
  })),
  interactions: z.array(z.object({
    keep: z.boolean(),
    text: z.string().trim().min(1).max(2000).optional(),
    at: z.string().trim().min(1).max(40).optional(),
  })),
  threads: z.array(z.object({
    keep: z.boolean(),
    text: z.string().trim().min(1).max(200).optional(),
    dueAt: z.string().trim().min(1).max(40).nullable().optional(),
  })),
  unresolved: z.array(z.object({
    personId: uuid.nullable(),
    dismissed: z.boolean(),
    text: z.string().trim().min(1).max(2000).optional(),
  })),
  place: z.object({ placeId: uuid.nullable(), name: z.string().trim().max(120).nullable() }),
  // Typed on the review screen, so capped at what a thumb writes rather than
  // what a model returns. Absent in a body written before this existed.
  added: z.array(z.object({
    personName: z.string().trim().min(1).max(120),
    kind: z.enum(factKindEnum.enumValues),
    text: z.string().trim().min(1).max(2000),
  })).max(40).optional(),
});

/** A filing problem the caller can show to the user, with the HTTP status it deserves. */
export class FilingError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export type FilingCounts = {
  people: number; facts: number; interactions: number; threads: number; loose: number; closed: number;
};

/**
 * Why a note should wait for the user, or null when it can file itself.
 * Confidence is per person: one uncertain match holds the whole note, because
 * a wrong filing is worse than a tap.
 */
export function reviewReason(x: ExtractionResult): string | null {
  for (const p of x.people) {
    if (p.matchedPersonId == null && !p.isNew) return `not sure who "${p.name}" is`;
    if (p.confidence < AUTO_FILE_THRESHOLD) return `${p.name} at ${Math.round(p.confidence * 100)}%`;
  }
  const fresh = x.people.filter((p) => !p.matchedPersonId).length;
  if (fresh >= NEW_PEOPLE_REVIEW_AT) return `${fresh} new people`;
  return null;
}

/**
 * The filing record for a note that filed before this module existed. Person
 * rows it created are found by name among the people added in the half hour
 * after the note was uploaded; everyone else it touched comes from the rows
 * that carry its capture id. Computed on read; persisted only when a filing
 * or a re-extraction writes it back.
 */
export async function reconstructFiling(
  userId: string,
  capture: { id: string; createdAt: Date; placeId: string | null; extraction: ExtractionResult | null },
): Promise<CaptureFiling> {
  const d = db();
  const x = capture.extraction;
  const created: CaptureFiling["created"] = [];

  const touched = new Set<string>();
  for (const r of await d.select({ personId: facts.personId }).from(facts)
    .where(and(eq(facts.userId, userId), eq(facts.captureId, capture.id)))) if (r.personId) touched.add(r.personId);
  for (const r of await d.select({ personId: interactions.personId }).from(interactions)
    .where(and(eq(interactions.userId, userId), eq(interactions.captureId, capture.id)))) if (r.personId) touched.add(r.personId);
  for (const r of await d.select({ personId: threads.personId }).from(threads)
    .where(and(eq(threads.userId, userId), eq(threads.createdFromCaptureId, capture.id)))) if (r.personId) touched.add(r.personId);
  const loose = await d.select({ id: looseThreads.id }).from(looseThreads)
    .where(and(eq(looseThreads.userId, userId), eq(looseThreads.captureId, capture.id)));

  // Only a note that actually wrote rows can have created people. A note that
  // is waiting for its first look has nothing to reconstruct, and must not
  // claim a same-named person some other note added in the same half hour.
  const filedBefore = touched.size > 0 || loose.length > 0;

  if (filedBefore && x?.people.length) {
    const start = capture.createdAt;
    const end = new Date(start.getTime() + 30 * 60_000);
    const rows = await d.select({ id: people.id, displayName: people.displayName }).from(people)
      .where(and(eq(people.userId, userId), gte(people.createdAt, start), lte(people.createdAt, end)));
    const byName = new Map(rows.map((r) => [key(r.displayName), r.id]));
    for (const p of x.people) {
      const id = byName.get(key(p.name));
      if (id && !created.some((c) => c.personId === id)) created.push({ name: p.name, personId: id });
    }
  }

  return {
    filedAt: capture.createdAt.toISOString(),
    by: "legacy",
    created,
    peopleIds: [...touched],
    placeId: capture.placeId,
    decisions: null,
  };
}

const key = (name: string) => name.trim().toLowerCase();

export async function fileCapture(o: {
  userId: string;
  captureId: string;
  /** Absent means "as the model proposed". */
  decisions?: FilingDecisions;
  by: "auto" | "user";
  embed: (texts: string[]) => Promise<number[][]>;
}): Promise<{ filing: CaptureFiling; counts: FilingCounts }> {
  const d = db();
  const { userId, captureId } = o;

  const capture = await d.query.captures.findFirst({
    where: and(eq(captures.id, captureId), eq(captures.userId, userId)),
  });
  if (!capture) throw new FilingError(404, "No such note");
  const x = capture.extraction;
  if (!x) throw new FilingError(409, "This note has not been read yet");

  const prefs = await d.query.users.findFirst({ where: eq(users.id, userId), columns: { cadenceDefaults: true } });
  const cadenceDefaults = prefs?.cadenceDefaults ?? { family: 14, friends: 21, work: 45, neighbors: 30, other: 90 };

  const roster = await d.query.people.findMany({
    where: eq(people.userId, userId),
    columns: { id: true, displayName: true, tags: true, cadenceDays: true, googleContactId: true },
    orderBy: (p, { asc }) => asc(p.createdAt),
  });
  const rosterById = new Map(roster.map((p) => [p.id, p]));

  const decisions = o.decisions ?? defaultDecisions(x, capture.placeId, (id) => rosterById.get(id)?.tags ?? []);
  checkShape(x, decisions);
  const previous = capture.filing ?? await reconstructFiling(userId, capture);

  // One spelling per tag. "younglife" typed on the screen, or proposed by the
  // model, becomes the "YoungLife" the user already has. New spellings are
  // registered as they appear, so two people tagged in one note agree.
  const spelling = new Map<string, string>();
  for (const p of roster) for (const t of p.tags) if (!spelling.has(key(t))) spelling.set(key(t), t);
  const normalizeTags = (tags: string[]) => mergeTags([], tags).map((t) => {
    const known = spelling.get(key(t));
    if (known) return known;
    spelling.set(key(t), t);
    return t;
  });
  const sameTags = (a: string[], b: string[]) => a.length === b.length && a.every((t, i) => t === b[i]);

  /* 1. people ----------------------------------------------------------- */
  // Every name the model used, resolved to a person row: an existing one the
  // user confirmed, one this capture created before (reused, never doubled),
  // or a fresh row. Dropped names resolve to nothing and take their items
  // with them.
  const nameToId = new Map<string, string>();
  const dropped = new Set<string>();
  const used = new Set<string>();
  const created: CaptureFiling["created"] = [];
  const tagChanges = new Map<string, string[]>();

  // Resolve every name first, deciding what already exists and what has to be
  // made, then make all of it in one statement.
  //
  // This used to insert one person at a time. A roster note names forty of
  // them, so that was forty sequential round trips, and forty chances for the
  // request to be cancelled halfway: a backgrounded phone, a dropped signal.
  // When that happened the rows existed and the capture had no record of
  // them, so the next File it made all forty again.
  //
  // The ids are generated here rather than by the database, which is what
  // lets the capture be told what is about to exist before it exists. A row
  // recorded and then never inserted is harmless: the next filing does not
  // find it in the roster, creates a fresh one, and drops the stale entry.
  const resolved = new Map<number, string>();
  const toCreate: { index: number; id: string; name: string; tags: string[]; role: string | null }[] = [];

  for (const [i, p] of x.people.entries()) {
    const dec = decisions.people[i];
    if (dec.action === "drop") { dropped.add(p.name); continue; }

    if (dec.action === "match") {
      if (!dec.personId || !rosterById.has(dec.personId)) {
        throw new FilingError(400, `"${p.name}" was matched to someone who is not in your people`);
      }
      resolved.set(i, dec.personId);
      used.add(dec.personId);
      continue;
    }

    const prior = previous.created.find((c) =>
      rosterById.has(c.personId) && !used.has(c.personId) && (c.personId === dec.personId || key(c.name) === key(p.name)));
    if (prior) {
      resolved.set(i, prior.personId);
      used.add(prior.personId);
      continue;
    }

    const id = crypto.randomUUID();
    toCreate.push({ index: i, id, name: p.name, tags: normalizeTags(dec.tags ?? p.tags ?? []), role: p.role ?? null });
    resolved.set(i, id);
    used.add(id);
  }

  // Tell the capture what is about to exist, before it does. Everything after
  // this point is recoverable: a retry reuses these rows instead of doubling
  // them, whatever happens in between.
  const interimCreated = x.people
    .map((p, i) => [p, i] as const)
    .filter(([, i]) => toCreate.some((t) => t.index === i))
    .map(([p, i]) => ({ name: p.name, personId: resolved.get(i)! }));
  if (interimCreated.length) {
    await d.update(captures).set({
      filing: {
        ...previous,
        created: [...previous.created.filter((c) => !interimCreated.some((n) => n.personId === c.personId)), ...interimCreated],
      },
    }).where(eq(captures.id, captureId));
  }

  if (toCreate.length) {
    const rows = await d.insert(people).values(toCreate.map((t) => ({
      id: t.id, userId, displayName: t.name, tags: t.tags, role: t.role,
    }))).returning({ id: people.id, displayName: people.displayName, tags: people.tags, cadenceDays: people.cadenceDays, googleContactId: people.googleContactId });
    for (const row of rows) rosterById.set(row.id, row);
  }

  // Nothing below can fail on its own: every id is known and every row exists.
  for (const [i, p] of x.people.entries()) {
    const dec = decisions.people[i];
    if (dec.action === "drop") continue;
    const personId = resolved.get(i)!;
    if (!nameToId.has(p.name)) nameToId.set(p.name, personId);
    if (dec.action === "new" || previous.created.some((c) => c.personId === personId)) {
      if (!created.some((c) => c.personId === personId)) created.push({ name: p.name, personId });
    }
    if (dec.tags) {
      const final = normalizeTags(dec.tags);
      if (!sameTags(final, rosterById.get(personId)!.tags)) tagChanges.set(personId, final);
    }
  }

  const interim: CaptureFiling = {
    ...previous,
    created: [...previous.created.filter((c) => !created.some((n) => n.personId === c.personId)), ...created],
  };
  await d.update(captures).set({ filing: interim }).where(eq(captures.id, captureId));

  for (const [personId, tags] of tagChanges) {
    await d.update(people).set({ tags, updatedAt: new Date() })
      .where(and(eq(people.id, personId), eq(people.userId, userId)));
    rosterById.get(personId)!.tags = tags;
  }

  /* 2. place ------------------------------------------------------------ */
  let place: { id: string; lat: number | null; lng: number | null } | null = null;
  if (decisions.place.placeId) {
    const row = await d.query.places.findFirst({
      where: and(eq(places.id, decisions.place.placeId), eq(places.userId, userId)),
      columns: { id: true, lat: true, lng: true },
    });
    if (!row) throw new FilingError(400, "That place is not one of yours");
    place = row;
  } else if (decisions.place.name) {
    place = await resolvePlaceByName(userId, decisions.place.name, capture.lat, capture.lng);
  }

  /* 3. rows ------------------------------------------------------------- */
  const orphans: string[] = [];
  const resolve = (name: string, text: string) => {
    const id = nameToId.get(name);
    if (id) return id;
    // A name the model used without listing it as a person. Loose thread,
    // not silence. Unless the user left that person out on purpose.
    if (!dropped.has(name)) orphans.push(`${name}: ${text}`);
    return null;
  };

  const now = new Date();
  const factRows: (typeof facts.$inferInsert)[] = [];
  const attached: string[] = [];

  x.facts.forEach((f, i) => {
    const dec = decisions.facts[i];
    if (!dec.keep) return;
    const content = dec.text?.trim() || f.content;
    const personId = resolve(f.personName, content);
    if (!personId) return;
    const kind = dec.kind ?? f.kind;
    factRows.push({
      userId, personId, kind, content, confidence: f.confidence, captureId,
      pinned: PINNED_KINDS.has(kind), embedding: null,
    });
  });

  // Something the user typed that the model never heard. Same path as the
  // model's own facts, so it is resolved by name, embedded with them, and
  // left out when its person is. Confidence 1: they wrote it themselves.
  for (const a of decisions.added ?? []) {
    const content = a.text.trim();
    if (!content) continue;
    const personId = resolve(a.personName, content);
    if (!personId) continue;
    factRows.push({
      userId, personId, kind: a.kind, content, confidence: 1, captureId,
      pinned: PINNED_KINDS.has(a.kind), embedding: null,
    });
  }

  // A loose thread the user attached becomes a fact on that person. The loose
  // row stays, marked resolved, so the note still reads the way it was said.
  x.unresolved.forEach((text, i) => {
    const dec = decisions.unresolved[i];
    if (dec.dismissed || !dec.personId) return;
    if (!rosterById.has(dec.personId)) throw new FilingError(400, "That loose thread was attached to someone who is not in your people");
    attached.push(dec.personId);
    factRows.push({ userId, personId: dec.personId, kind: "context", content: dec.text?.trim() || text, confidence: 1, captureId, pinned: false, embedding: null });
  });

  const interactionRows: (typeof interactions.$inferInsert)[] = [];
  x.interactions.forEach((it, i) => {
    const dec = decisions.interactions[i];
    if (!dec.keep) return;
    const summary = dec.text?.trim() || it.summary;
    const personId = resolve(it.personName, summary);
    if (!personId) return;
    interactionRows.push({
      userId, personId, captureId, placeId: place?.id ?? null,
      occurredAt: safeDate(dec.at ?? it.occurredAt, capture.capturedAt), channel: it.channel, summary,
      // The place's coordinates when it has them, else the note's own.
      lat: place?.lat ?? capture.lat, lng: place?.lng ?? capture.lng, embedding: null,
    });
  });

  const threadRows: (typeof threads.$inferInsert)[] = [];
  x.threads.forEach((t, i) => {
    const dec = decisions.threads[i];
    if (!dec.keep) return;
    const title = dec.text?.trim() || t.title;
    const personId = resolve(t.personName, title);
    if (!personId) return;
    // undefined leaves the model's date alone; null is the user clearing it.
    const due = dec.dueAt === undefined ? t.dueAt : dec.dueAt;
    threadRows.push({
      userId, personId, title, dueAt: due ? safeDate(due, null) : null, createdFromCaptureId: captureId,
    });
  });

  const looseRows: (typeof looseThreads.$inferInsert)[] = [
    ...x.unresolved.map((text, i) => {
      const dec = decisions.unresolved[i];
      return {
        userId, captureId, content: dec.text?.trim() || text,
        resolvedPersonId: dec.dismissed ? null : dec.personId,
        dismissedAt: dec.dismissed ? now : null,
      };
    }),
    ...orphans.map((text) => ({ userId, captureId, content: text })),
  ];

  /* 4. embed ------------------------------------------------------------ */
  // The one external call, made before anything is deleted: if it fails, the
  // note is exactly as it was.
  const texts = [...factRows.map((f) => f.content), ...interactionRows.map((r) => r.summary)];
  const vectors = texts.length ? await o.embed(texts) : [];
  factRows.forEach((f, i) => { f.embedding = vectors[i] ?? null; });
  interactionRows.forEach((r, i) => { r.embedding = vectors[factRows.length + i] ?? null; });

  /* 5. replace what this capture filed before ---------------------------- */
  await d.delete(facts).where(and(eq(facts.userId, userId), eq(facts.captureId, captureId)));
  await d.delete(interactions).where(and(eq(interactions.userId, userId), eq(interactions.captureId, captureId)));
  await d.delete(threads).where(and(eq(threads.userId, userId), eq(threads.createdFromCaptureId, captureId)));
  await d.delete(looseThreads).where(and(eq(looseThreads.userId, userId), eq(looseThreads.captureId, captureId)));

  /* 6. people this capture created and the user now leaves out ---------- */
  // Only an explicit "leave out" removes a row, and only when nothing else
  // refers to it: a person another note has written about, or one that came
  // from Google Contacts, stays. A name the model simply stopped listing on a
  // re-run keeps its row. The user said that name once; the model's second
  // reading is not a reason to lose it.
  const droppedIds = new Set<string>();
  x.people.forEach((p, i) => {
    const dec = decisions.people[i];
    if (dec.action !== "drop") return;
    if (dec.personId) droppedIds.add(dec.personId);
    for (const c of interim.created) if (key(c.name) === key(p.name)) droppedIds.add(c.personId);
  });
  for (const c of interim.created) {
    if (used.has(c.personId) || attached.includes(c.personId) || !droppedIds.has(c.personId)) continue;
    const row = rosterById.get(c.personId);
    if (!row || row.googleContactId) continue;
    const refs = await d.execute(sql`
      select (select count(*) from ${facts} where person_id = ${c.personId})
           + (select count(*) from ${interactions} where person_id = ${c.personId})
           + (select count(*) from ${threads} where person_id = ${c.personId})
           + (select count(*) from ${looseThreads} where resolved_person_id = ${c.personId}) as n`);
    if (Number((refs.rows[0] as { n: unknown }).n) > 0) continue;
    await d.delete(people).where(and(eq(people.id, c.personId), eq(people.userId, userId)));
    rosterById.delete(c.personId);
  }

  /* 7. write ------------------------------------------------------------ */
  if (factRows.length) await d.insert(facts).values(factRows);
  if (interactionRows.length) await d.insert(interactions).values(interactionRows);
  if (threadRows.length) await d.insert(threads).values(threadRows);
  if (looseRows.length) await d.insert(looseThreads).values(looseRows);

  for (const id of x.closesThreadIds) {
    await d.update(threads)
      .set({ status: "done", completedAt: now, closedByCaptureId: captureId })
      .where(and(eq(threads.id, id), eq(threads.userId, userId)));
  }

  /* 8. warmth and places, for everyone this or the previous filing touched */
  // Recomputed from the interactions table rather than bumped, so a re-file
  // cannot double count and a note about a January meeting reads as January.
  const touched = [...new Set([...used, ...attached, ...previous.peopleIds])].filter((id) => rosterById.has(id));
  if (touched.length) {
    const ids = sql.join(touched.map((id) => sql`${id}::uuid`), sql`, `);
    const agg = await d.execute(sql`
      select person_id, max(occurred_at) as last,
             count(*) filter (where occurred_at > now() - interval '90 days') as recent
      from ${interactions}
      where user_id = ${userId} and person_id in (${ids})
      group by person_id`);
    const byId = new Map((agg.rows as { person_id: string; last: string | null; recent: unknown }[]).map((r) => [r.person_id, r]));

    const values = touched.map((id) => {
      const a = byId.get(id);
      const last = a?.last ? new Date(a.last) : null;
      const person = rosterById.get(id)!;
      return sql`(${id}::uuid, ${last ? last.toISOString() : null}::timestamptz, ${warmth({
        lastInteractionAt: last,
        cadenceDays: cadenceFor(person, cadenceDefaults),
        interactionsLast90: Number(a?.recent ?? 0),
      })}::int)`;
    });
    await d.execute(sql`
      update ${people} as p
      set last_interaction_at = v.last, warmth = v.warmth, updated_at = now()
      from (values ${sql.join(values, sql`, `)}) as v(id, last, warmth)
      where p.id = v.id and p.user_id = ${userId}`);

    await d.delete(personPlaces).where(and(eq(personPlaces.userId, userId), inArray(personPlaces.personId, touched)));
    await d.execute(sql`
      insert into ${personPlaces} (person_id, place_id, user_id, weight, last_seen_at)
      select person_id, place_id, user_id, count(*), max(occurred_at)
      from ${interactions}
      where user_id = ${userId} and place_id is not null and person_id in (${ids})
      group by person_id, place_id, user_id`);
  }

  /* 9. the record ------------------------------------------------------- */
  const filing: CaptureFiling = {
    filedAt: now.toISOString(),
    by: o.by,
    created: interim.created.filter((c) => rosterById.has(c.personId)),
    peopleIds: [...new Set([...used, ...attached])],
    placeId: place?.id ?? null,
    decisions: {
      ...decisions,
      // Store what each "new" resolved to, so the screen can show the row and a re-file can reuse it.
      people: decisions.people.map((dec, i) => dec.action === "new"
        ? { ...dec, personId: nameToId.get(x.people[i].name) ?? null }
        : dec),
      place: { placeId: place?.id ?? null, name: null },
    },
  };
  await d.update(captures)
    .set({ status: "filed", filing, placeId: place?.id ?? null, error: null })
    .where(eq(captures.id, captureId));

  return {
    filing,
    counts: {
      people: used.size, facts: factRows.length, interactions: interactionRows.length,
      threads: threadRows.length, loose: looseRows.length, closed: x.closesThreadIds.length,
    },
  };
}

/** Decisions must line up with the extraction they were made against. */
function checkShape(x: ExtractionResult, dec: FilingDecisions) {
  const same = dec.people.length === x.people.length && dec.facts.length === x.facts.length
    && dec.interactions.length === x.interactions.length && dec.threads.length === x.threads.length
    && dec.unresolved.length === x.unresolved.length;
  if (!same) throw new FilingError(409, "This note changed since you opened it. Reload it and look again.");
}

/** The model returns ISO strings; a malformed one must not take the whole note down. */
function safeDate(iso: string, fallback: Date): Date;
function safeDate(iso: string, fallback: null): Date | null;
function safeDate(iso: string, fallback: Date | null): Date | null {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? fallback : d;
}
