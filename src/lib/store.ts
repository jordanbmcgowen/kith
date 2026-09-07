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
import type { ExtractionResult, CaptureFiling, FilingDecisions, Circle } from "@/db/schema";
import type { FilingCounts } from "@/lib/filing";

export type { ExtractionResult, CaptureFiling, FilingDecisions, Circle, FilingCounts };

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
  circle: Circle;
  role: string | null;
  _demo?: true;
};

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
};

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/* ══════════════════ DEMO DATA — DELETE EVERYTHING DOWN TO THE END MARKER ══════════════════
   Placeholder records for building screens before the pipeline has produced
   anything. Every record carries _demo:true so one grep finds any that
   escaped. Nothing outside this block may reference a DEMO_ identifier.
   ══════════════════════════════════════════════════════════════════════════════════════════ */
const DEMO_PEOPLE: PersonLite[] = [
  { _demo: true, id: "00000000-0000-4000-8000-000000000001", displayName: "Marcus Ellery", goesBy: null, circle: "friends", role: "Franchisee, three territories. Flies a Cirrus." },
  { _demo: true, id: "00000000-0000-4000-8000-000000000002", displayName: "Priya Raman", goesBy: null, circle: "friends", role: "Wine buyer, Bishop Cellars" },
  { _demo: true, id: "00000000-0000-4000-8000-000000000003", displayName: "Carlos Mendez", goesBy: null, circle: "neighbors", role: "Two doors down, the blue house" },
  { _demo: true, id: "00000000-0000-4000-8000-000000000004", displayName: "Dana Whitfield", goesBy: null, circle: "work", role: "VP Operations, Bright Path Brands" },
];

const DEMO_EXTRACTION_1: ExtractionResult = {
  people: [{ matchedPersonId: DEMO_PEOPLE[0].id, name: "Marcus", confidence: 0.96, isNew: false }],
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
  people: [{ matchedPersonId: null, name: "Dev", confidence: 0.55, isNew: true, circle: "neighbors", role: "Runs the roaster in Bishop Arts" }],
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
    return { capture: { ...capture }, people: DEMO_PEOPLE, suggestions: { 0: [{ id: DEMO_PEOPLE[2].id, displayName: "Carlos Mendez", role: DEMO_PEOPLE[2].role, similarity: 0.4 }] }, closes: [] };
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
};

export const store: Store = DATA_SOURCE === "demo" ? demoStore : liveStore;
