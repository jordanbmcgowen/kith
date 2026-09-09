/**
 * The data seam. Views never fetch directly; they call `store`, and one
 * constant decides whether that is demo data or the live API. Both stores are
 * async with identical method names and shapes, so the swap is one edit.
 *
 * The live store NEVER falls back to demo data on error. It throws, and the
 * view renders an empty state. Silent fallback is exactly how preview data
 * ends up in production.
 *
 * Safe to import from server and client components: nothing here touches
 * `fetch` or `navigator` until a method is called, and the schema imports are
 * types only.
 */
import type { ExtractionResult, CaptureFiling, FilingDecisions, FactKind } from "@/db/schema";
import type { FilingCounts } from "@/lib/filing";

export type { ExtractionResult, CaptureFiling, FilingDecisions, FactKind, FilingCounts };

export type CaptureStatus = "uploaded" | "transcribing" | "extracting" | "needs_review" | "filed" | "failed";

/** What the capture screen needs to show a note's progress. A subset of the captures row. */
export type CaptureSummary = {
  id: string;
  kind: "voice" | "text" | "photo" | "calendar";
  status: CaptureStatus;
  transcript: string | null;
  rawText: string | null;
  durationSec: number | null;
  capturedAt: string;
  /** The place name the user typed, if any. */
  placeHint: string | null;
  error: string | null;
  extraction: ExtractionResult | null;
  _demo?: true;
};

/** A person as the confirmation screen's picker needs them. */
export type PersonLite = {
  id: string;
  displayName: string;
  goesBy: string | null;
  /** The user's own groups for this person: "YoungLife", "Journeymen". Kith
   *  has no groups of its own; these are the only ones. */
  tags: string[];
  role: string | null;
  _demo?: true;
};

/** A person as the people list shows them: the picker's shape plus what the row needs. */
export type PersonRow = PersonLite & {
  pronunciation: string | null;
  lastInteractionAt: string | null;
  /** 0-100. Orders things quietly; never shown as a judgment. */
  warmth: number;
};

/** The people list narrows by tag, and by nothing else. Never by location. */
export type PeopleFilter = { tag?: string | null };

export type PeopleList = {
  people: PersonRow[];
  /** Every tag the user has, most used first, for the filter row. Whole roster, whatever the filter. */
  tags: string[];
  /** For the line under the heading. Whole roster, whatever the filter. */
  counts: { people: number; facts: number; places: number };
};

/** One person with everything the person page shows. Read only. */
export type PersonView = {
  person: PersonRow & {
    pronouns: string | null;
    company: string | null;
    title: string | null;
    birthday: string | null;
    /** The cadence that applies to them, in days: their own or your default. */
    cadenceDays: number;
    cadenceIsDefault: boolean;
    createdAt: string;
    archivedAt: string | null;
  };
  /** Pinned first, then newest. */
  facts: { id: string; kind: FactKind; content: string; pinned: boolean; confidence: number; captureId: string | null; createdAt: string }[];
  /** Open only. Soonest due first, undated last. */
  threads: { id: string; title: string; dueAt: string | null; createdFromCaptureId: string | null; createdAt: string }[];
  /** Newest first, each with the place it happened at when known. */
  interactions: { id: string; occurredAt: string; channel: string; summary: string; captureId: string | null; place: { id: string; name: string } | null }[];
  /** Where you see them, most often first. */
  places: { id: string; name: string; weight: number; lastSeenAt: string | null }[];
  /** Every note that filed something about them, newest first. */
  notes: { id: string; kind: CaptureSummary["kind"]; status: CaptureStatus; capturedAt: string; placeHint: string | null; excerpt: string }[];
};

/** One person search found, with the reason it found them. */
export type SearchHit = {
  person: PersonRow;
  /** 0-1. Orders the list. Never shown: a number here would read as a judgment. */
  score: number;
  /** Why this person matched, in the app's own words. The screen shows it. */
  why: string;
  /** When the matched fact or visit happened, for the screen to say. Null for a name, tag or role. */
  at: string | null;
};

export type SearchResults = {
  results: SearchHit[];
  /** "Try one", under an empty field. Words from the user's own rows, or none. */
  hints: string[];
  /** The processor did not answer, so only names, tags and roles were searched. */
  namesOnly?: boolean;
};

/**
 * What a person's page lets you change. Only what moved needs to be sent.
 * Facts, visits and threads are not here: they are derived from notes, and
 * the place to correct one is the note it came from.
 */
export type PersonPatch = {
  displayName?: string;
  goesBy?: string | null;
  pronunciation?: string | null;
  pronouns?: string | null;
  role?: string | null;
  company?: string | null;
  /** Days between visits for this one person. Null goes back to your default. */
  cadenceDays?: number | null;
  /** The complete list after this edit, not an addition. */
  tags?: string[];
};

/** The home screen in one shape. Every block hides when it is empty. */
export type TodayView = {
  /** For the greeting. The time of day comes from the phone, not from here. */
  firstName: string | null;
  place: { id: string; name: string; distanceM: number } | null;
  likelyHere: { person: PersonRow; place: string }[];
  threads: { id: string; title: string; dueAt: string | null; captureId: string | null; person: { id: string; displayName: string } | null }[];
  /** Seen at least once and past their cadence. Someone never met was never warm. */
  slipping: { person: PersonRow; daysSince: number; cadenceDays: number }[];
  loose: { id: string; content: string; captureId: string | null; at: string }[];
  review: { count: number; oldestId: string | null };
};

/** Who you are, what Kith holds, and the one setting that changes what it says. */
export type Me = {
  name: string | null;
  email: string | null;
  image: string | null;
  timezone: string;
  since: string;
  /** Days between visits. One number: what Today means by slipping. */
  cadence: number;
  /** Derived from the scopes Google actually granted, never from a wish list. */
  connected: { google: boolean; calendar: boolean; contacts: boolean };
  counts: { people: number; facts: number; visits: number; threads: number; places: number; notes: number; loose: number };
};

/** A place you have already named. Nearest first when the phone has a fix. */
export type NearbyPlace = { id: string; name: string; distanceM: number | null };

/** An existing person whose name looks like one the model called new. */
export type Suggestion = { id: string; displayName: string; role: string | null; similarity: number };

/** One note, with everything the confirmation screen renders. */
export type CaptureView = {
  capture: CaptureSummary & {
    filing: CaptureFiling | null;
    place: { id: string; name: string } | null;
  };
  /** The user's people, for "someone else" and "attach to". */
  people: PersonLite[];
  /** Every tag the user has, most used first. Suggestions under "+ tag". */
  tags: string[];
  /** Keyed by the index of the person in extraction.people. Only for people the model called new. */
  suggestions: Record<string, Suggestion[]>;
  /** Open threads this note closes, by title. */
  closes: { id: string; title: string; personName: string | null }[];
};

export type Coords = { lat: number; lng: number; accuracy: number | null };

export type CaptureInput = {
  audio?: Blob;
  /** Must carry the extension that matches the blob's type. See src/lib/audio.ts. */
  filename?: string;
  text?: string;
  /** Only when the note is about where the phone is right now. A note recorded
   *  at home about somewhere else sends null here and a placeName instead. */
  coords: Coords | null;
  /** Where this happened, in the user's words. Optional. */
  placeName?: string;
  capturedAt: Date;
};

export type Store = {
  isDemo: boolean;
  /** Current position, or null if unavailable or refused. Never throws. */
  coords(opts?: { fresh?: boolean }): Promise<Coords | null>;
  capture(input: CaptureInput): Promise<{ id: string; status: CaptureStatus; kind: string }>;
  /** Most recent first. */
  captures(): Promise<CaptureSummary[]>;
  /** One note with its extraction, for the confirmation screen. */
  note(id: string): Promise<CaptureView>;
  /** File a note with the user's decisions. Works on waiting and on already filed notes. */
  confirm(id: string, decisions: FilingDecisions): Promise<{ counts: FilingCounts }>;
  /** Put a note back through extraction. It stops at needs_review. */
  rerun(id: string): Promise<void>;
  /** How many notes are waiting for a look, and the oldest one. */
  reviewQueue(): Promise<{ count: number; oldestId: string | null }>;
  /** The people list, narrowed by tag. */
  people(filter?: PeopleFilter): Promise<PeopleList>;
  /** One person with everything the person page shows. 404 becomes an ApiError. */
  person(id: string): Promise<PersonView>;
  /**
   * Names, tags, roles, facts and visits. Under two characters it returns no
   * results and the hints instead. Coordinates only ever reorder the list.
   */
  search(q: string, coords?: Coords | null): Promise<SearchResults>;
  /** Change who someone is. Tags are where employers live. */
  updatePerson(id: string, patch: PersonPatch): Promise<void>;
  /** "I saw them, on this day." Last seen and warmth follow from the visits. */
  addVisit(personId: string, visit: { occurredAt: string; summary?: string }): Promise<void>;
  /** Only a visit that came from no note. A note's visit is corrected on the note. */
  editVisit(personId: string, visitId: string, patch: { occurredAt?: string; summary?: string }): Promise<void>;
  removeVisit(personId: string, visitId: string): Promise<void>;
  /** Places you have already named, nearest first. Never throws on no fix. */
  places(coords?: Coords | null): Promise<NearbyPlace[]>;
  /** The home screen. Coordinates name the place and lift who is near; they hide nobody. */
  today(coords?: Coords | null): Promise<TodayView>;
  /** Your account, your counts, and your cadences. */
  me(): Promise<Me>;
  /** Changing a cadence recomputes warmth for everyone who inherits it. */
  updateMe(patch: { timezone?: string; cadence?: number }): Promise<void>;
};

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/* ══════════════════ DEMO DATA — DELETE EVERYTHING DOWN TO THE END MARKER ══════════════════
   Placeholder records for building screens before the pipeline has produced
   anything. Every record carries _demo:true so one grep finds any that
   escaped. Nothing outside this block may reference a DEMO_ identifier.
   ══════════════════════════════════════════════════════════════════════════════════════════ */
const DEMO_DAY = 86_400_000;
const DEMO_AGO = (days: number) => new Date(Date.now() - days * DEMO_DAY).toISOString();
const DEMO_PEOPLE: PersonRow[] = [
  { _demo: true, id: "00000000-0000-4000-8000-000000000001", displayName: "Marcus Ellery", goesBy: null, pronunciation: "MAR-kus ELL-er-ee", tags: ["Brook Hollow"], role: "Franchisee, three territories. Flies a Cirrus.", lastInteractionAt: DEMO_AGO(8), warmth: 74 },
  { _demo: true, id: "00000000-0000-4000-8000-000000000002", displayName: "Priya Raman", goesBy: null, pronunciation: null, tags: [], role: "Wine buyer, Bishop Cellars", lastInteractionAt: DEMO_AGO(6), warmth: 88 },
  { _demo: true, id: "00000000-0000-4000-8000-000000000003", displayName: "Carlos Mendez", goesBy: null, pronunciation: null, tags: ["Lakewood"], role: "Two doors down, the blue house", lastInteractionAt: DEMO_AGO(4), warmth: 92 },
  { _demo: true, id: "00000000-0000-4000-8000-000000000004", displayName: "Dana Whitfield", goesBy: null, pronunciation: "WIT-field", tags: ["Bright Path"], role: "VP Operations, Bright Path Brands", lastInteractionAt: null, warmth: 50 },
];

/** What the person page shows for the first demo person. Everyone else is empty, which is also a state to build for. */
const DEMO_DETAIL: Record<string, Omit<PersonView, "person">> = {
  [DEMO_PEOPLE[0].id]: {
    facts: [
      { id: "00000000-0000-4000-8000-0000000000f1", kind: "relation", content: "Wife is Dana. Two boys, Cole (9) and Reid (6). Cole is trying out for travel baseball this fall.", pinned: true, confidence: 0.95, captureId: "00000000-0000-4000-8000-00000000c001", createdAt: DEMO_AGO(8) },
      { id: "00000000-0000-4000-8000-0000000000f2", kind: "sensitive", content: "Texas A&M, class of 2004. Will talk about it. Do not bring up the 2024 season.", pinned: true, confidence: 0.9, captureId: null, createdAt: DEMO_AGO(40) },
      { id: "00000000-0000-4000-8000-0000000000f3", kind: "context", content: "Bought the Fort Worth territory in 2019, added Weatherford in 2023. Wants a third but is capital-shy.", pinned: false, confidence: 0.9, captureId: null, createdAt: DEMO_AGO(30) },
      { id: "00000000-0000-4000-8000-0000000000f4", kind: "preference", content: "Drinks bourbon, not scotch. Learned that the hard way in Nashville.", pinned: false, confidence: 0.85, captureId: null, createdAt: DEMO_AGO(60) },
    ],
    threads: [
      { id: "00000000-0000-4000-8000-0000000000t1", title: "Send Marcus the Q4 territory map", dueAt: DEMO_AGO(2), createdFromCaptureId: "00000000-0000-4000-8000-00000000c001", createdAt: DEMO_AGO(8) },
      { id: "00000000-0000-4000-8000-0000000000t2", title: "Ask how Cole's travel baseball tryout went", dueAt: DEMO_AGO(-4), createdFromCaptureId: null, createdAt: DEMO_AGO(8) },
    ],
    interactions: [
      { id: "00000000-0000-4000-8000-0000000000i1", occurredAt: DEMO_AGO(8), channel: "in_person", summary: "Played nine after the owner council. Frustrated with staffing in Weatherford, thinking about a shared crew model with the Arlington owner.", captureId: "00000000-0000-4000-8000-00000000c001", place: { id: "00000000-0000-4000-8000-0000000000p1", name: "Brook Hollow Golf Club" } },
      { id: "00000000-0000-4000-8000-0000000000i2", occurredAt: DEMO_AGO(24), channel: "meeting", summary: "Owner council. Mentioned Dana went back to teaching this year and the schedule is easier on him now.", captureId: null, place: { id: "00000000-0000-4000-8000-0000000000p2", name: "HQ2, Irving" } },
      { id: "00000000-0000-4000-8000-0000000000i3", occurredAt: DEMO_AGO(64), channel: "call", summary: "Called about the pricing pilot. Wants a longer ramp than the other markets. Promised him a territory map.", captureId: null, place: null },
    ],
    places: [
      { id: "00000000-0000-4000-8000-0000000000p1", name: "Brook Hollow Golf Club", weight: 4, lastSeenAt: DEMO_AGO(8) },
      { id: "00000000-0000-4000-8000-0000000000p2", name: "HQ2, Irving", weight: 2, lastSeenAt: DEMO_AGO(24) },
    ],
    notes: [
      { id: "00000000-0000-4000-8000-00000000c001", kind: "voice", status: "filed", capturedAt: DEMO_AGO(8), placeHint: "Brook Hollow", excerpt: "Just saw Marcus at the club. Priya got into Rice, early decision. Told him I'd send the Cirrus article this week." },
    ],
  },
};

const DEMO_EXTRACTION_1: ExtractionResult = {
  people: [{ matchedPersonId: DEMO_PEOPLE[0].id, name: "Marcus", confidence: 0.96, isNew: false, tags: ["Brook Hollow"] }],
  facts: [
    { personName: "Marcus", kind: "relation", content: "Daughter Priya got into Rice, early decision", confidence: 0.95 },
    { personName: "Marcus", kind: "context", content: "Ready to move on a third territory, wants to talk financing this month", confidence: 0.9 },
  ],
  interactions: [{ personName: "Marcus", summary: "Ran into him at the club, talked about Priya and the third territory", occurredAt: new Date(Date.now() - 40 * 60_000).toISOString(), channel: "in_person" }],
  threads: [{ personName: "Marcus", title: "Send the Cirrus article", dueAt: new Date(Date.now() + 5 * 86_400_000).toISOString() }],
  closesThreadIds: [],
  place: { name: "Brook Hollow", confidence: 0.9 },
  unresolved: [],
};

const DEMO_EXTRACTION_2: ExtractionResult = {
  people: [{ matchedPersonId: null, name: "Dev", confidence: 0.55, isNew: true, role: "Runs the roaster in Bishop Arts", tags: ["Bishop Arts"] }],
  facts: [{ personName: "Dev", kind: "relation", content: "Kid starts at Lakewood this fall", confidence: 0.85 }],
  interactions: [{ personName: "Dev", summary: "Met at the roaster in Bishop Arts", occurredAt: new Date(Date.now() - 3 * 3_600_000).toISOString(), channel: "in_person" }],
  threads: [],
  closesThreadIds: [],
  place: { name: "the roaster in Bishop Arts", confidence: 0.6 },
  unresolved: ["Someone mentioned a birthday on the 14th but I missed whose"],
};

const DEMO_CAPTURES: CaptureView["capture"][] = [
  {
    _demo: true, id: "00000000-0000-4000-8000-00000000c001", kind: "voice", status: "filed", durationSec: 18, error: null,
    capturedAt: new Date(Date.now() - 40 * 60_000).toISOString(), placeHint: "Brook Hollow",
    transcript: "Just saw Marcus at the club. Priya got into Rice, early decision. Told him I'd send the Cirrus article this week.",
    rawText: null,
    extraction: DEMO_EXTRACTION_1,
    filing: { filedAt: new Date().toISOString(), by: "auto", created: [], peopleIds: [DEMO_PEOPLE[0].id], placeId: "00000000-0000-4000-8000-0000000000p1", decisions: null },
    place: { id: "00000000-0000-4000-8000-0000000000p1", name: "Brook Hollow Golf Club" },
  },
  {
    _demo: true, id: "00000000-0000-4000-8000-00000000c002", kind: "text", status: "needs_review", durationSec: null, error: null,
    capturedAt: new Date(Date.now() - 3 * 3_600_000).toISOString(), placeHint: null,
    transcript: null,
    rawText: "Met a Dev at the roaster in Bishop Arts, neighbor, said his kid starts at Lakewood this fall.",
    extraction: DEMO_EXTRACTION_2,
    filing: null,
    place: null,
  },
];

const demoStore: Store = {
  isDemo: true,
  async coords() { return { lat: 32.858, lng: -96.842, accuracy: 12 }; },
  async capture(input) {
    const id = `00000000-0000-4000-8000-${String(Date.now()).slice(-12)}`;
    const row: CaptureView["capture"] = {
      _demo: true, id, kind: input.audio ? "voice" : "text", status: "uploaded",
      durationSec: input.audio ? 14 : null, error: null, capturedAt: input.capturedAt.toISOString(),
      placeHint: input.placeName?.trim() || null,
      transcript: null, rawText: input.text ?? null, extraction: null, filing: null, place: null,
    };
    DEMO_CAPTURES.unshift(row);
    // Walk the row through the pipeline so the status list can be previewed.
    const steps: CaptureStatus[] = ["transcribing", "extracting", "filed"];
    steps.forEach((status, i) => setTimeout(() => {
      row.status = status;
      if (status === "extracting" && !row.transcript) row.transcript = row.rawText ?? "Demo transcript of what you just said.";
      if (status === "filed") row.extraction = DEMO_EXTRACTION_1;
    }, 2500 * (i + 1)));
    return { id, status: "uploaded", kind: row.kind };
  },
  async captures() { return DEMO_CAPTURES.map((c) => ({ ...c })); },
  async note(id) {
    const capture = DEMO_CAPTURES.find((c) => c.id === id);
    if (!capture) throw new ApiError(404, "No such note");
    return { capture: { ...capture }, people: DEMO_PEOPLE, tags: ["Brook Hollow", "Lakewood", "Bright Path"], suggestions: { 0: [{ id: DEMO_PEOPLE[2].id, displayName: "Carlos Mendez", role: DEMO_PEOPLE[2].role, similarity: 0.4 }] }, closes: [] };
  },
  async confirm(id, decisions) {
    const capture = DEMO_CAPTURES.find((c) => c.id === id);
    if (!capture) throw new ApiError(404, "No such note");
    capture.status = "filed";
    capture.filing = { filedAt: new Date().toISOString(), by: "user", created: [], peopleIds: [], placeId: null, decisions };
    const x = capture.extraction!;
    return { counts: { people: decisions.people.filter((p) => p.action !== "drop").length, facts: decisions.facts.filter((f) => f.keep).length, interactions: x.interactions.length, threads: decisions.threads.filter((t) => t.keep).length, loose: x.unresolved.length, closed: 0 } };
  },
  async rerun(id) {
    const capture = DEMO_CAPTURES.find((c) => c.id === id);
    if (!capture) throw new ApiError(404, "No such note");
    capture.status = "uploaded";
    setTimeout(() => { capture.status = "extracting"; }, 2000);
    setTimeout(() => { capture.status = "needs_review"; }, 4500);
  },
  async reviewQueue() {
    const waiting = DEMO_CAPTURES.filter((c) => c.status === "needs_review");
    return { count: waiting.length, oldestId: waiting.at(-1)?.id ?? null };
  },
  async people(filter = {}) {
    const tag = filter.tag?.toLowerCase();
    const list = DEMO_PEOPLE.filter((p) => !tag || p.tags.some((t) => t.toLowerCase() === tag));
    const facts = Object.values(DEMO_DETAIL).reduce((n, d) => n + d.facts.length, 0);
    const places = Object.values(DEMO_DETAIL).reduce((n, d) => n + d.places.length, 0);
    return {
      people: list,
      tags: [...new Set(DEMO_PEOPLE.flatMap((p) => p.tags))],
      counts: { people: DEMO_PEOPLE.length, facts, places },
    };
  },
  async person(id) {
    const p = DEMO_PEOPLE.find((x) => x.id === id);
    if (!p) throw new ApiError(404, "No one here");
    const detail = DEMO_DETAIL[id] ?? { facts: [], threads: [], interactions: [], places: [], notes: [] };
    return {
      person: { ...p, pronouns: null, company: null, title: null, birthday: null, cadenceDays: 21, cadenceIsDefault: true, createdAt: DEMO_AGO(90), archivedAt: null },
      ...detail,
    };
  },
  async search(q) {
    // A plain substring stand-in for the real thing, in the same order the API
    // ranks: name, then tag, then role, then something you said about them.
    const s = q.trim().toLowerCase();
    const hints = [...new Set(DEMO_PEOPLE.flatMap((p) => p.tags))].slice(0, 3);
    if (s.length < 2) return { results: [], hints };
    const results: SearchHit[] = [];
    for (const person of DEMO_PEOPLE) {
      const tag = person.tags.find((t) => t.toLowerCase().includes(s));
      const fact = DEMO_DETAIL[person.id]?.facts.find((f) => f.content.toLowerCase().includes(s));
      if (person.displayName.toLowerCase().includes(s)) results.push({ person, score: 1, why: "Their name", at: null });
      else if (tag) results.push({ person, score: 0.8, why: `Tag / ${tag}`, at: null });
      else if (person.role?.toLowerCase().includes(s)) results.push({ person, score: 0.72, why: `Role / ${person.role}`, at: null });
      else if (fact) results.push({ person, score: 0.55, why: `Fact / ${fact.content.slice(0, 80)}`, at: fact.createdAt });
    }
    return { results: results.sort((a, b) => b.score - a.score), hints };
  },
  async updatePerson(id, patch) {
    const p = DEMO_PEOPLE.find((x) => x.id === id);
    if (!p) throw new ApiError(404, "No one here");
    Object.assign(p, patch);
  },
  async addVisit(personId, visit) {
    const p = DEMO_PEOPLE.find((x) => x.id === personId);
    if (!p) throw new ApiError(404, "No one here");
    const detail = (DEMO_DETAIL[personId] ??= { facts: [], threads: [], interactions: [], places: [], notes: [] });
    detail.interactions.unshift({
      id: `00000000-0000-4000-8000-${String(Date.now()).slice(-12)}`, occurredAt: visit.occurredAt,
      channel: "in_person", summary: visit.summary || "Saw them.", captureId: null, place: null,
    });
    p.lastInteractionAt = visit.occurredAt;
  },
  async editVisit(personId, visitId, patch) {
    const v = DEMO_DETAIL[personId]?.interactions.find((x) => x.id === visitId);
    if (!v || v.captureId) throw new ApiError(404, "That visit came from a note. Change it there.");
    Object.assign(v, patch.occurredAt ? { occurredAt: patch.occurredAt } : {}, patch.summary ? { summary: patch.summary } : {});
  },
  async removeVisit(personId, visitId) {
    const detail = DEMO_DETAIL[personId];
    const i = detail?.interactions.findIndex((x) => x.id === visitId && !x.captureId) ?? -1;
    if (i < 0) throw new ApiError(404, "That visit came from a note. Change it there.");
    detail.interactions.splice(i, 1);
  },
  async places() {
    return Object.values(DEMO_DETAIL).flatMap((d) => d.places).map((p) => ({ id: p.id, name: p.name, distanceM: 120 }));
  },
  async today() {
    const detail = DEMO_DETAIL[DEMO_PEOPLE[0].id];
    return {
      firstName: "Jordan",
      place: { id: detail.places[0].id, name: detail.places[0].name, distanceM: 40 },
      likelyHere: [{ person: DEMO_PEOPLE[0], place: detail.places[0].name }],
      threads: detail.threads.map((t) => ({
        id: t.id, title: t.title, dueAt: t.dueAt, captureId: t.createdFromCaptureId,
        person: { id: DEMO_PEOPLE[0].id, displayName: DEMO_PEOPLE[0].displayName },
      })),
      slipping: [{ person: DEMO_PEOPLE[3], daysSince: 96, cadenceDays: 45 }],
      loose: [{ id: "00000000-0000-4000-8000-0000000000l1", content: "Someone at the owner council has a kid at SMU on a golf scholarship.", captureId: null, at: DEMO_AGO(3) }],
      review: { count: DEMO_CAPTURES.filter((c) => c.status === "needs_review").length, oldestId: null },
    };
  },
  async me() {
    return {
      name: "Jordan McGowen", email: "you@example.com", image: null,
      timezone: "America/Chicago", since: DEMO_AGO(120),
      cadence: 60,
      connected: { google: true, calendar: false, contacts: false },
      counts: { people: DEMO_PEOPLE.length, facts: 4, visits: 3, threads: 2, places: 2, notes: DEMO_CAPTURES.length, loose: 1 },
    };
  },
  async updateMe() { /* nothing to persist in demo data */ },
};
/* ══════════════════════ END DEMO DATA — DELETE ABOVE THIS LINE ══════════════════════ */


/* ══════════════════════════════════════════════════════════════════════════
   DATA SOURCE. Flip to "demo" to build screens against placeholder data.
   When the demo block above is deleted, delete the "demo" branch here too.
   ══════════════════════════════════════════════════════════════════════════ */
const DATA_SOURCE = "live" as "demo" | "live";

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: "same-origin", ...init });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try { message = ((await res.json()) as { error?: string }).error ?? message; } catch { /* not JSON */ }
    throw new ApiError(res.status, message);
  }
  return res.json() as Promise<T>;
}

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

/** The last fix we got, so a second request can reuse it while asking for a fresh one. */
let lastCoords: Coords | null = null;

const liveStore: Store = {
  isDemo: false,

  coords({ fresh = false } = {}) {
    return new Promise<Coords | null>((resolve) => {
      if (typeof navigator === "undefined" || !navigator.geolocation) return resolve(null);
      navigator.geolocation.getCurrentPosition(
        (p) => {
          lastCoords = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy ?? null };
          resolve(lastCoords);
        },
        () => resolve(lastCoords),
        { timeout: fresh ? 3000 : 6000, maximumAge: fresh ? 15_000 : 60_000, enableHighAccuracy: false },
      );
    });
  },

  async capture(input) {
    const form = new FormData();
    if (input.audio) form.append("audio", input.audio, input.filename ?? "note.webm");
    if (input.text) form.append("text", input.text);
    if (input.coords) {
      form.append("lat", String(input.coords.lat));
      form.append("lng", String(input.coords.lng));
      if (input.coords.accuracy != null) form.append("accuracy", String(input.coords.accuracy));
    }
    if (input.placeName?.trim()) form.append("place", input.placeName.trim());
    form.append("capturedAt", input.capturedAt.toISOString());
    return api("/api/v1/captures", { method: "POST", body: form });
  },

  captures() {
    return api<{ captures: CaptureSummary[] }>("/api/v1/captures").then((r) => r.captures);
  },

  note(id) {
    return api<CaptureView>(`/api/v1/captures/${encodeURIComponent(id)}`);
  },

  confirm(id, decisions) {
    return api<{ counts: FilingCounts }>(`/api/v1/captures/${encodeURIComponent(id)}/confirm`, json(decisions));
  },

  async rerun(id) {
    await api(`/api/v1/captures/${encodeURIComponent(id)}/rerun`, { method: "POST" });
  },

  async reviewQueue() {
    // Newest first, so the oldest waiting note is the last one.
    const rows = await api<{ captures: CaptureSummary[] }>("/api/v1/captures?status=needs_review").then((r) => r.captures);
    return { count: rows.length, oldestId: rows.at(-1)?.id ?? null };
  },

  people(filter = {}) {
    const qs = new URLSearchParams();
    if (filter.tag) qs.set("tag", filter.tag);
    const s = qs.toString();
    return api<PeopleList>(`/api/v1/people${s ? `?${s}` : ""}`);
  },

  person(id) {
    return api<PersonView>(`/api/v1/people/${encodeURIComponent(id)}`);
  },

  search(q, coords) {
    const qs = new URLSearchParams({ q });
    // Ranking only. The API never filters on this, and nothing is hidden
    // because of where the phone is standing.
    if (coords) { qs.set("lat", String(coords.lat)); qs.set("lng", String(coords.lng)); }
    return api<SearchResults>(`/api/v1/search?${qs}`);
  },

  async updatePerson(id, patch) {
    await api(`/api/v1/people/${encodeURIComponent(id)}`, { ...json(patch), method: "PATCH" });
  },

  async addVisit(personId, visit) {
    await api(`/api/v1/people/${encodeURIComponent(personId)}/visits`, json(visit));
  },

  async editVisit(personId, visitId, patch) {
    await api(`/api/v1/people/${encodeURIComponent(personId)}/visits/${encodeURIComponent(visitId)}`, { ...json(patch), method: "PATCH" });
  },

  async removeVisit(personId, visitId) {
    await api(`/api/v1/people/${encodeURIComponent(personId)}/visits/${encodeURIComponent(visitId)}`, { method: "DELETE" });
  },

  places(coords) {
    const qs = new URLSearchParams();
    if (coords) { qs.set("lat", String(coords.lat)); qs.set("lng", String(coords.lng)); }
    const s = qs.toString();
    return api<{ places: NearbyPlace[] }>(`/api/v1/places${s ? `?${s}` : ""}`).then((r) => r.places);
  },

  today(coords) {
    const qs = new URLSearchParams();
    if (coords) { qs.set("lat", String(coords.lat)); qs.set("lng", String(coords.lng)); }
    const s = qs.toString();
    return api<TodayView>(`/api/v1/today${s ? `?${s}` : ""}`);
  },

  me() {
    return api<Me>("/api/v1/me");
  },

  async updateMe(patch) {
    await api("/api/v1/me", { ...json(patch), method: "PATCH" });
  },
};

export const store: Store = DATA_SOURCE === "demo" ? demoStore : liveStore;
