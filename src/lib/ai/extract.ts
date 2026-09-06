import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

/**
 * Turns a rambling voice note into structured records.
 *
 * Two rules govern this file:
 *   1. The model is given the candidate people (name + id + a few facts) and
 *      may only match against that list. It never invents an id.
 *   2. Anything it cannot place becomes `unresolved`, which the app surfaces
 *      as a loose thread. Nothing the user said is ever thrown away.
 */

export const ExtractionSchema = z.object({
  people: z.array(z.object({
    matchedPersonId: z.string().nullable(),
    name: z.string(),
    confidence: z.number().min(0).max(1),
    isNew: z.boolean(),
    circle: z.enum(["family", "friends", "work", "neighbors", "other"]).optional(),
    role: z.string().optional(),
  })),
  facts: z.array(z.object({
    personName: z.string(),
    kind: z.enum(["identity", "relation", "preference", "history", "sensitive", "context"]),
    content: z.string(),
    confidence: z.number().min(0).max(1),
    supersedesFactId: z.string().optional(),
  })),
  interactions: z.array(z.object({
    personName: z.string(),
    summary: z.string(),
    occurredAt: z.string(),
    channel: z.string(),
  })),
  threads: z.array(z.object({
    personName: z.string(),
    title: z.string(),
    dueAt: z.string().nullable(),
  })),
  closesThreadIds: z.array(z.string()),
  place: z.object({ name: z.string().nullable(), confidence: z.number() }).nullable(),
  unresolved: z.array(z.string()),
});

export type Extraction = z.infer<typeof ExtractionSchema>;

/** Cheap and fast for a twenty second note. */
export const EXTRACT_MODEL = "claude-haiku-4-5";
/** One step up when the cheap model returns something malformed. */
export const ESCALATE_MODEL = "claude-sonnet-5";

export type Candidate = {
  id: string;
  displayName: string;
  goesBy: string | null;
  circle: string;
  role: string | null;
  nearHere: boolean;
  topFacts: string[];
};

export type OpenThread = { id: string; personName: string; title: string };

const SYSTEM = `You turn a person's spoken notes about their own life into structured records for a private memory app. You are writing into their notebook, not summarising for anyone else.

Rules:
- Only match a person to an id from CANDIDATES. Never invent an id. If the person is not in the list, set matchedPersonId to null and isNew to true.
- Prefer candidates marked nearHere when a name is ambiguous, but say so in confidence rather than guessing high.
- A fact is something durable and true about the person: family, preferences, history, situation. "He seemed tired" is not a fact. "His mother is ill" is.
- Kind "sensitive" is for things to handle with care: health, grief, subjects to avoid. Mark them so, do not omit them.
- A thread is something the speaker owes or promised. Only create one if they actually committed. "I should probably call him" is a thread. "He should call me" is not.
- Resolve relative dates ("Tuesday", "end of the month") against NOW, in the user's timezone, and return ISO 8601.
- If the note answers or completes an item in OPEN_THREADS, put that thread's id in closesThreadIds.
- Write facts and summaries in the speaker's own voice and register. Do not formalise, do not add detail they did not say, do not editorialise.
- Anything you cannot confidently attach to a person goes in unresolved, verbatim.

Return only JSON matching the tool schema.`;

export async function extract(input: {
  transcript: string;
  now: string;
  timezone: string;
  placeName: string | null;
  candidates: Candidate[];
  openThreads: OpenThread[];
  model?: string;
}): Promise<Extraction> {
  const model = input.model ?? EXTRACT_MODEL;

  // Built per call, not at module load. In a Worker, secrets are only
  // guaranteed readable inside a request, and the SDK throws immediately when
  // handed an empty key, which would take the whole consumer down before its
  // first log line.
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
  const anthropic = new Anthropic({ apiKey });

  const res = await anthropic.messages.create({
    model,
    max_tokens: 8000,
    system: SYSTEM,
    tools: [{
      name: "file_note",
      description: "File the extracted records.",
      input_schema: TOOL_SCHEMA as any,
    }],
    tool_choice: { type: "tool", name: "file_note" },
    messages: [{
      role: "user",
      content: [
        `NOW: ${input.now}`,
        `TIMEZONE: ${input.timezone}`,
        `PLACE: ${input.placeName ?? "unknown"}`,
        ``,
        `CANDIDATES:`,
        JSON.stringify(input.candidates, null, 1),
        ``,
        `OPEN_THREADS:`,
        JSON.stringify(input.openThreads, null, 1),
        ``,
        `NOTE:`,
        input.transcript,
      ].join("\n"),
    }],
  });

  const block = res.content.find((c) => c.type === "tool_use");
  if (!block || block.type !== "tool_use") throw new Error("Model returned no tool call");

  const parsed = ExtractionSchema.safeParse(block.input);
  if (!parsed.success) {
    // One escalation to a stronger model before giving up. Cheap insurance:
    // a malformed extraction means the user's note goes to needs_review.
    if (model !== ESCALATE_MODEL) {
      return extract({ ...input, model: ESCALATE_MODEL });
    }
    throw new Error(`Extraction failed validation: ${parsed.error.message}`);
  }

  // Guard rail 1: never trust an id the model made up.
  const known = new Set(input.candidates.map((c) => c.id));
  for (const p of parsed.data.people) {
    if (p.matchedPersonId && !known.has(p.matchedPersonId)) {
      p.matchedPersonId = null;
      p.isNew = true;
      p.confidence = Math.min(p.confidence, 0.5);
    }
  }
  const knownThreads = new Set(input.openThreads.map((t) => t.id));
  parsed.data.closesThreadIds = parsed.data.closesThreadIds.filter((id) => knownThreads.has(id));

  return parsed.data;
}

/** Confidence below this goes to needs_review instead of filing itself. */
export const AUTO_FILE_THRESHOLD = 0.82;

const TOOL_SCHEMA = {
  type: "object",
  required: ["people", "facts", "interactions", "threads", "closesThreadIds", "place", "unresolved"],
  properties: {
    people: {
      type: "array",
      items: {
        type: "object",
        required: ["matchedPersonId", "name", "confidence", "isNew"],
        properties: {
          matchedPersonId: { type: ["string", "null"] },
          name: { type: "string" },
          confidence: { type: "number" },
          isNew: { type: "boolean" },
          circle: { type: "string", enum: ["family", "friends", "work", "neighbors", "other"] },
          role: { type: "string" },
        },
      },
    },
    facts: {
      type: "array",
      items: {
        type: "object",
        required: ["personName", "kind", "content", "confidence"],
        properties: {
          personName: { type: "string" },
          kind: { type: "string", enum: ["identity", "relation", "preference", "history", "sensitive", "context"] },
          content: { type: "string" },
          confidence: { type: "number" },
          supersedesFactId: { type: "string" },
        },
      },
    },
    interactions: {
      type: "array",
      items: {
        type: "object",
        required: ["personName", "summary", "occurredAt", "channel"],
        properties: {
          personName: { type: "string" },
          summary: { type: "string" },
          occurredAt: { type: "string" },
          channel: { type: "string" },
        },
      },
    },
    threads: {
      type: "array",
      items: {
        type: "object",
        required: ["personName", "title", "dueAt"],
        properties: {
          personName: { type: "string" },
          title: { type: "string" },
          dueAt: { type: ["string", "null"] },
        },
      },
    },
    closesThreadIds: { type: "array", items: { type: "string" } },
    place: {
      type: ["object", "null"],
      properties: { name: { type: ["string", "null"] }, confidence: { type: "number" } },
    },
    unresolved: { type: "array", items: { type: "string" } },
  },
} as const;
