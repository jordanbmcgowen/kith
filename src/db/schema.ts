/**
 * Kith — database schema (Drizzle ORM / Neon Postgres)
 *
 * Design notes
 * ------------
 * 1. Every row that holds user content carries `userId`. There are no shared
 *    tables between accounts. Row-level isolation is enforced in the query
 *    layer (see src/db/index.ts -> scoped()), never left to the caller.
 * 2. `captures` are raw and immutable. `interactions` and `facts` are derived
 *    from them. If extraction is wrong, you re-run it; you never lose the
 *    original.
 * 3. Embeddings live on `facts` and `interactions` so fuzzy recall
 *    ("the guy at the golf thing who flies") searches both what someone told
 *    you and what happened.
 * 4. Run `CREATE EXTENSION IF NOT EXISTS vector;` on Neon before migrating.
 */

import {
  pgTable, pgEnum, text, timestamp, integer, real, boolean, jsonb,
  uuid, index, uniqueIndex, primaryKey, doublePrecision, vector,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";

/* ------------------------------------------------------------------ enums */

/**
 * NOTE the Postgres type name is `circle_kind`, not `circle`.
 *
 * `circle` is a built-in Postgres geometric type in pg_catalog, and pg_catalog
 * is always searched before the schema search path. An enum named `circle`
 * therefore gets shadowed: the column resolves to pg_catalog.circle and the
 * migration dies on `DEFAULT 'other'` with "invalid input syntax for type
 * circle". The column is still named `circle`; only the type name changed.
 */
export const circleEnum = pgEnum("circle_kind", [
  "family", "friends", "work", "neighbors", "other",
]);

export const captureKindEnum = pgEnum("capture_kind", [
  "voice", "text", "photo", "calendar",
]);

export const captureStatusEnum = pgEnum("capture_status", [
  "uploaded", "transcribing", "extracting", "needs_review", "filed", "failed",
]);

export const factKindEnum = pgEnum("fact_kind", [
  "identity",     // pronunciation, goes-by, how we met
  "relation",     // spouse, kids, siblings
  "preference",   // drinks bourbon not scotch
  "history",      // alma mater, career
  "sensitive",    // allergies, things not to bring up
  "context",      // current situation, what they're working on
]);

export const threadStatusEnum = pgEnum("thread_status", [
  "open", "done", "dropped",
]);

export const placeKindEnum = pgEnum("place_kind", [
  "home", "work", "venue", "city", "other",
]);

/* ------------------------------------------------------------------ auth */
/* Shapes match the Auth.js Drizzle adapter. Do not rename these columns.    */

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name"),
  email: text("email").notNull().unique(),
  emailVerified: timestamp("email_verified", { withTimezone: true }),
  image: text("image"),
  timezone: text("timezone").default("America/Chicago").notNull(),
  // Defaults the user can tune per circle, in days.
  cadenceDefaults: jsonb("cadence_defaults")
    .$type<Record<string, number>>()
    .default({ family: 14, friends: 21, work: 45, neighbors: 30, other: 90 })
    .notNull(),
  onboardedAt: timestamp("onboarded_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const accounts = pgTable("accounts", {
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  provider: text("provider").notNull(),
  providerAccountId: text("provider_account_id").notNull(),
  refresh_token: text("refresh_token"),
  access_token: text("access_token"),
  expires_at: integer("expires_at"),
  token_type: text("token_type"),
  scope: text("scope"),
  id_token: text("id_token"),
  session_state: text("session_state"),
}, (t) => [primaryKey({ columns: [t.provider, t.providerAccountId] })]);

export const sessions = pgTable("sessions", {
  sessionToken: text("session_token").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  expires: timestamp("expires", { withTimezone: true }).notNull(),
});

export const verificationTokens = pgTable("verification_tokens", {
  identifier: text("identifier").notNull(),
  token: text("token").notNull(),
  expires: timestamp("expires", { withTimezone: true }).notNull(),
}, (t) => [primaryKey({ columns: [t.identifier, t.token] })]);

/* ---------------------------------------------------------------- places */

export const places = pgTable("places", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  kind: placeKindEnum("kind").default("venue").notNull(),
  googlePlaceId: text("google_place_id"),
  lat: doublePrecision("lat"),
  lng: doublePrecision("lng"),
  // How close you have to be for this place to count as "you are here", metres.
  radiusM: integer("radius_m").default(120).notNull(),
  visitCount: integer("visit_count").default(0).notNull(),
  lastVisitedAt: timestamp("last_visited_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index("places_user_idx").on(t.userId),
  uniqueIndex("places_user_google_idx").on(t.userId, t.googlePlaceId),
  // Bounding-box prefilter for "what is near me" before the haversine sort.
  index("places_geo_idx").on(t.userId, t.lat, t.lng),
]);

/* --------------------------------------------------------------- people */

export const people = pgTable("people", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),

  displayName: text("display_name").notNull(),
  firstName: text("first_name"),
  lastName: text("last_name"),
  goesBy: text("goes_by"),                       // "Sully"
  pronunciation: text("pronunciation"),          // "MAR-kus ELL-er-ee"
  pronouns: text("pronouns"),

  circle: circleEnum("circle").default("other").notNull(),
  role: text("role"),                            // one-line "who they are to you"
  company: text("company"),
  title: text("title"),
  avatarUrl: text("avatar_url"),
  birthday: text("birthday"),                    // YYYY-MM-DD or --MM-DD (year optional)

  // Cadence: null means inherit the circle default from users.cadenceDefaults.
  cadenceDays: integer("cadence_days"),
  lastInteractionAt: timestamp("last_interaction_at", { withTimezone: true }),
  // 0-100, recomputed on write. See src/lib/warmth.ts.
  warmth: integer("warmth").default(50).notNull(),

  googleContactId: text("google_contact_id"),    // people/c12345 resource name
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index("people_user_idx").on(t.userId),
  uniqueIndex("people_google_idx").on(t.userId, t.googleContactId),
  index("people_warmth_idx").on(t.userId, t.warmth),
  // Trigram index for typo-tolerant name matching during extraction.
  // Requires: CREATE EXTENSION IF NOT EXISTS pg_trgm;
  index("people_name_trgm_idx").using("gin", sql`${t.displayName} gin_trgm_ops`),
]);

/** Where you usually run into someone. Drives location-based ranking. */
export const personPlaces = pgTable("person_places", {
  personId: uuid("person_id").notNull().references(() => people.id, { onDelete: "cascade" }),
  placeId: uuid("place_id").notNull().references(() => places.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  // Incremented each time an interaction with this person lands at this place.
  weight: integer("weight").default(1).notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
}, (t) => [
  primaryKey({ columns: [t.personId, t.placeId] }),
  index("person_places_place_idx").on(t.userId, t.placeId, t.weight),
]);

/* ---------------------------------------------------------------- facts */

export const facts = pgTable("facts", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  personId: uuid("person_id").references(() => people.id, { onDelete: "cascade" }),

  kind: factKindEnum("kind").default("context").notNull(),
  content: text("content").notNull(),
  // Surfaced in the "Remember first" block. Max ~5 pinned per person.
  pinned: boolean("pinned").default(false).notNull(),
  // 0-1 from the extraction model. Below 0.7 goes to needs_review.
  confidence: real("confidence").default(1).notNull(),
  captureId: uuid("capture_id"),
  supersededById: uuid("superseded_by_id"),
  embedding: vector("embedding", { dimensions: 1536 }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index("facts_person_idx").on(t.personId, t.pinned),
  index("facts_user_idx").on(t.userId),
  index("facts_vec_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
]);

/* --------------------------------------------------------- interactions */

export const interactions = pgTable("interactions", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  personId: uuid("person_id").references(() => people.id, { onDelete: "cascade" }),
  captureId: uuid("capture_id"),
  placeId: uuid("place_id").references(() => places.id, { onDelete: "set null" }),

  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  channel: text("channel").default("in_person").notNull(), // in_person | call | text | email | meeting
  summary: text("summary").notNull(),
  lat: doublePrecision("lat"),
  lng: doublePrecision("lng"),
  googleEventId: text("google_event_id"),
  embedding: vector("embedding", { dimensions: 1536 }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index("interactions_person_idx").on(t.personId, t.occurredAt),
  index("interactions_user_time_idx").on(t.userId, t.occurredAt),
  index("interactions_vec_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
]);

/* -------------------------------------------------------------- threads */
/* "Threads" rather than "tasks" — these are things owed to a person.        */

export const threads = pgTable("threads", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  personId: uuid("person_id").references(() => people.id, { onDelete: "cascade" }),

  title: text("title").notNull(),
  dueAt: timestamp("due_at", { withTimezone: true }),
  status: threadStatusEnum("status").default("open").notNull(),
  // A thread can be closed by a later capture that answers it.
  closedByCaptureId: uuid("closed_by_capture_id"),
  createdFromCaptureId: uuid("created_from_capture_id"),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  notifiedAt: timestamp("notified_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index("threads_due_idx").on(t.userId, t.status, t.dueAt),
  index("threads_person_idx").on(t.personId, t.status),
]);

/* ------------------------------------------------------------- captures */

export const captures = pgTable("captures", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),

  kind: captureKindEnum("kind").notNull(),
  status: captureStatusEnum("status").default("uploaded").notNull(),

  audioKey: text("audio_key"),        // R2 object key
  durationSec: real("duration_sec"),
  transcript: text("transcript"),
  rawText: text("raw_text"),          // for typed captures

  lat: doublePrecision("lat"),
  lng: doublePrecision("lng"),
  accuracyM: real("accuracy_m"),
  placeId: uuid("place_id").references(() => places.id, { onDelete: "set null" }),

  capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
  // Full model output, kept so a bad extraction can be re-run or audited.
  extraction: jsonb("extraction").$type<ExtractionResult>(),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index("captures_user_status_idx").on(t.userId, t.status, t.capturedAt),
]);

/** Extracted content that did not resolve to a person. Never silently dropped. */
export const looseThreads = pgTable("loose_threads", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  captureId: uuid("capture_id").references(() => captures.id, { onDelete: "cascade" }),
  content: text("content").notNull(),
  candidatePersonIds: jsonb("candidate_person_ids").$type<string[]>().default([]).notNull(),
  resolvedPersonId: uuid("resolved_person_id").references(() => people.id, { onDelete: "set null" }),
  dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [index("loose_user_idx").on(t.userId, t.resolvedPersonId, t.dismissedAt)]);

/* ------------------------------------------------------- google sync ---- */

export const calendarEvents = pgTable("calendar_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  googleEventId: text("google_event_id").notNull(),
  title: text("title"),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  endsAt: timestamp("ends_at", { withTimezone: true }),
  location: text("location"),
  attendees: jsonb("attendees").$type<{ email: string; name?: string }[]>().default([]).notNull(),
  // Set once we have prompted the user for a post-meeting note.
  promptedAt: timestamp("prompted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  uniqueIndex("cal_user_event_idx").on(t.userId, t.googleEventId),
  index("cal_user_start_idx").on(t.userId, t.startsAt),
]);

export const syncState = pgTable("sync_state", {
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  source: text("source").notNull(),               // "google_calendar" | "google_contacts"
  syncToken: text("sync_token"),                  // incremental sync token from Google
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  lastError: text("last_error"),
}, (t) => [primaryKey({ columns: [t.userId, t.source] })]);

export const pushSubscriptions = pgTable("push_subscriptions", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  endpoint: text("endpoint").notNull().unique(),
  p256dh: text("p256dh").notNull(),
  auth: text("auth").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/* ------------------------------------------------------------ relations */

export const usersRelations = relations(users, ({ many }) => ({
  people: many(people), captures: many(captures), threads: many(threads), places: many(places),
}));

export const peopleRelations = relations(people, ({ one, many }) => ({
  user: one(users, { fields: [people.userId], references: [users.id] }),
  facts: many(facts), interactions: many(interactions), threads: many(threads),
  places: many(personPlaces),
}));

export const factsRelations = relations(facts, ({ one }) => ({
  person: one(people, { fields: [facts.personId], references: [people.id] }),
}));

export const interactionsRelations = relations(interactions, ({ one }) => ({
  person: one(people, { fields: [interactions.personId], references: [people.id] }),
  place: one(places, { fields: [interactions.placeId], references: [places.id] }),
}));

/* ----------------------------------------------------------- ai contract */

/** The exact shape the extraction model must return. Mirrored in Zod in
 *  src/lib/ai/extract.ts — change both together. */
export type ExtractionResult = {
  people: {
    matchedPersonId: string | null;
    name: string;
    confidence: number;          // 0-1
    isNew: boolean;
    circle?: "family" | "friends" | "work" | "neighbors" | "other";
    role?: string;
  }[];
  facts: {
    personName: string;
    kind: "identity" | "relation" | "preference" | "history" | "sensitive" | "context";
    content: string;
    confidence: number;
    supersedesFactId?: string;
  }[];
  interactions: { personName: string; summary: string; occurredAt: string; channel: string }[];
  threads: { personName: string; title: string; dueAt: string | null }[];
  closesThreadIds: string[];
  place: { name: string | null; confidence: number } | null;
  unresolved: string[];          // becomes loose_threads
};
