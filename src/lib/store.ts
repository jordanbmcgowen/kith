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
 * `fetch` or `navigator` until a method is called.
 */

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
  extraction: { people: { name: string }[]; facts: unknown[]; threads: unknown[]; unresolved: string[] } | null;
  _demo?: true;
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
};

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/* ══════════════════ DEMO DATA — DELETE EVERYTHING DOWN TO THE END MARKER ══════════════════
   Placeholder records for building screens before the pipeline has produced
   anything. Every record carries _demo:true so one grep finds any that
   escaped. Nothing outside this block may reference a DEMO_ identifier.
   ══════════════════════════════════════════════════════════════════════════════════════════ */
const DEMO_CAPTURES: CaptureSummary[] = [
  {
    _demo: true, id: "demo-1", kind: "voice", status: "filed", durationSec: 18, error: null,
    capturedAt: new Date(Date.now() - 40 * 60_000).toISOString(), placeHint: "Brook Hollow",
    transcript: "Just saw Marcus at the club. Priya got into Rice, early decision. Told him I'd send the Cirrus article this week.",
    rawText: null,
    extraction: { people: [{ name: "Marcus Ellery" }], facts: [{}, {}], threads: [{}], unresolved: [] },
  },
  {
    _demo: true, id: "demo-2", kind: "text", status: "needs_review", durationSec: null, error: null,
    capturedAt: new Date(Date.now() - 3 * 3_600_000).toISOString(), placeHint: null,
    transcript: null,
    rawText: "Met a Dev at the roaster in Bishop Arts, neighbor, said his kid starts at Lakewood this fall.",
    extraction: { people: [{ name: "Dev" }], facts: [{}], threads: [], unresolved: [] },
  },
];

const demoStore: Store = {
  isDemo: true,
  async coords() { return { lat: 32.858, lng: -96.842, accuracy: 12 }; },
  async capture(input) {
    const id = `demo-${Date.now()}`;
    const row: CaptureSummary = {
      _demo: true, id, kind: input.audio ? "voice" : "text", status: "uploaded",
      durationSec: input.audio ? 14 : null, error: null, capturedAt: input.capturedAt.toISOString(),
      placeHint: input.placeName?.trim() || null,
      transcript: null, rawText: input.text ?? null, extraction: null,
    };
    DEMO_CAPTURES.unshift(row);
    // Walk the row through the pipeline so the status list can be previewed.
    const steps: CaptureStatus[] = ["transcribing", "extracting", "filed"];
    steps.forEach((status, i) => setTimeout(() => {
      row.status = status;
      if (status === "extracting" && !row.transcript) row.transcript = row.rawText ?? "Demo transcript of what you just said.";
      if (status === "filed") row.extraction = { people: [{ name: "Marcus Ellery" }], facts: [{}], threads: [], unresolved: [] };
    }, 2500 * (i + 1)));
    return { id, status: "uploaded", kind: row.kind };
  },
  async captures() { return DEMO_CAPTURES.map((c) => ({ ...c })); },
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
};

export const store: Store = DATA_SOURCE === "demo" ? demoStore : liveStore;
