"use client";
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  store, ApiError,
  type CaptureView, type FilingDecisions, type PersonLite, type Suggestion, type ExtractionResult,
} from "@/lib/store";
import { defaultDecisions, mergeTags } from "@/lib/decisions";
import { AUTO_FILE_THRESHOLD } from "@/lib/ai/threshold";
import { toDateInput, fromDateInput, initials } from "@/lib/format";
import { FACT_LABELS, FACT_PICKS, DEFAULT_FACT_KIND } from "@/lib/facts";
import type { FactKind } from "@/db/schema";
import { BackLink as Back } from "./BackLink";
import { TagAdder } from "./TagAdder";

type Status = CaptureView["capture"]["status"];
type PersonDecision = FilingDecisions["people"][number];
type Picker = { kind: "person"; index: number } | { kind: "loose"; index: number } | null;

/** Statuses that are still moving. While the note is in one, the screen polls. */
const ACTIVE = new Set<Status>(["uploaded", "transcribing", "extracting"]);
const POLL_MS = 3000;
/** A pasted roster runs to thousands of characters. Show the start, offer the rest. */
const CLIP = 320;

const WORKING: Record<string, string> = {
  uploaded: "Saved. Waiting for its turn.",
  transcribing: "Listening to it.",
  extracting: "Reading it now.",
};

const style = (i: number, extra?: CSSProperties) => ({ "--i": Math.min(i, 10), ...extra }) as CSSProperties;
const pct = (n: number) => `${Math.round(n * 100)}%`;
const text = (e: unknown) => (e instanceof Error ? e.message : String(e));
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Step 3 of the build order: the confirmation screen. Renders the extraction
 * stored on a capture, lets the user fix it, and files it. A note that is
 * waiting for a look files when they tap File it; a note that filed itself
 * shows what landed and re-files when they change something and tap Done.
 * Every fix is one tap, and nothing here is a form.
 */
export function ConfirmScreen({ id }: { id: string }) {
  const router = useRouter();
  const [view, setView] = useState<CaptureView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [decisions, setDecisions] = useState<FilingDecisions | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [picker, setPicker] = useState<Picker>(null);
  const [undo, setUndo] = useState<Record<number, PersonDecision>>({});
  const [reloadKey, setReloadKey] = useState(0);

  /* ---- load, and keep loading while the note is moving ---- */
  useEffect(() => {
    let alive = true;
    let timer: number | undefined;
    const load = async () => {
      try {
        const next = await store.note(id);
        if (!alive) return;
        setView(next);
        setError(null);
        if (ACTIVE.has(next.capture.status)) timer = window.setTimeout(load, POLL_MS);
      } catch (e) {
        if (alive) setError(e instanceof ApiError && e.status === 404 ? "There is no note here." : text(e));
      }
    };
    load();
    return () => { alive = false; window.clearTimeout(timer); };
  }, [id, reloadKey]);

  /* ---- once it has settled, start from what was filed, or from the proposal ---- */
  useEffect(() => {
    if (!view || decisions) return;
    const x = view.capture.extraction;
    if (!x || ACTIVE.has(view.capture.status)) return;
    const tagsOf = (id: string) => view.people.find((p) => p.id === id)?.tags ?? [];
    setDecisions(view.capture.filing?.decisions ?? defaultDecisions(x, view.capture.place?.id ?? null, tagsOf));
  }, [view, decisions]);

  const rosterById = useMemo(() => new Map((view?.people ?? []).map((p) => [p.id, p])), [view]);
  /**
   * Every tag in play under "+ tag", the ones on this note first.
   *
   * The adder shows the first eight of these. The user's own list is longer
   * than that (fifteen, and growing), so ordering it by their whole roster
   * buried the tag they had just typed on the person above: the one case the
   * suggestions exist for, same tag, next person, one tap. What this note is
   * already about is the better guess, every time.
   */
  const tagPool = useMemo(
    () => mergeTags((decisions?.people ?? []).flatMap((d) => d.tags ?? []), view?.tags ?? []),
    [view, decisions],
  );

  /* ---- edits ---- */
  const update = (fn: (d: FilingDecisions) => FilingDecisions) => {
    setDecisions((d) => (d ? fn(d) : d));
    setDirty(true);
  };
  const setPerson = (i: number, patch: Partial<PersonDecision>) =>
    update((d) => ({ ...d, people: d.people.map((p, k) => (k === i ? { ...p, ...patch } : p)) }));
  const toggle = (key: "facts" | "interactions" | "threads", i: number) =>
    // Spread, so dropping and undoing does not throw away a correction.
    update((d) => ({ ...d, [key]: d[key].map((it, k) => (k === i ? { ...it, keep: !it.keep } : it)) }));
  const editItem = (key: "facts" | "interactions" | "threads", i: number, patch: Record<string, unknown>) =>
    update((d) => ({ ...d, [key]: d[key].map((it, k) => (k === i ? { ...it, ...patch } : it)) }));
  /** A fact the user typed. Keyed by the person's name, as the model's are. */
  const addFact = (personName: string, kind: FactKind, text: string) =>
    update((d) => ({ ...d, added: [...(d.added ?? []), { personName, kind, text }] }));
  const editAdded = (i: number, patch: Partial<NonNullable<FilingDecisions["added"]>[number]>) =>
    update((d) => ({ ...d, added: (d.added ?? []).map((a, k) => (k === i ? { ...a, ...patch } : a)) }));
  const removeAdded = (i: number) =>
    update((d) => ({ ...d, added: (d.added ?? []).filter((_, k) => k !== i) }));

  const setLoose = (i: number, patch: Partial<FilingDecisions["unresolved"][number]>) =>
    update((d) => ({ ...d, unresolved: d.unresolved.map((u, k) => (k === i ? { ...u, ...patch } : u)) }));
  const setPlace = (place: FilingDecisions["place"]) => update((d) => ({ ...d, place }));

  const leaveOut = (i: number) => {
    if (!decisions) return;
    setUndo((u) => ({ ...u, [i]: decisions.people[i] }));
    setPerson(i, { action: "drop" });
  };
  const bringBack = (i: number, p: ExtractionResult["people"][number]) => {
    const prior = undo[i] ?? (p.matchedPersonId
      ? { action: "match" as const, personId: p.matchedPersonId }
      : { action: "new" as const, personId: createdId(p.name) });
    setPerson(i, prior);
  };
  /** The row a previous filing created for this name, so a re-file reuses it. */
  const createdId = (name: string) => view?.capture.filing?.created.find((c) => c.name === name)?.personId ?? null;

  /* ---- file it ---- */
  const confirm = async () => {
    if (!view || !decisions) return;
    if (view.capture.status === "filed" && !dirty) { router.push("/record"); return; }
    setBusy(true);
    setProblem(null);
    try {
      const { counts } = await store.confirm(id, decisions);
      const bits = [plural(counts.people, "person", "people"), plural(counts.facts, "fact")];
      if (counts.threads) bits.push(plural(counts.threads, "follow-up"));
      handOff(`Filed. ${bits.join(", ")}.`);
      router.push("/record");
    } catch (e) {
      setProblem(e instanceof ApiError && e.status === 401
        ? "You are signed out. Open Kith again and sign in; your fixes are still here."
        : text(e));
      setBusy(false);
    }
  };

  const rerun = async () => {
    setBusy(true);
    setProblem(null);
    try {
      await store.rerun(id);
      setDecisions(null);
      setDirty(false);
      setUndo({});
      setPicker(null);
      setReloadKey((k) => k + 1);
    } catch (e) {
      setProblem(text(e));
    }
    setBusy(false);
  };

  /* ---- render ---- */
  if (error) {
    return (
      <>
        <BackLink />
        <p className="empty">Couldn&rsquo;t load this note.<br /><em>{error}</em></p>
      </>
    );
  }
  if (!view) return <BackLink />;

  const c = view.capture;
  const x = c.extraction;
  const body = (c.transcript ?? c.rawText ?? "").trim();
  const moving = ACTIVE.has(c.status);
  const waiting = c.status === "needs_review";
  const failed = c.status === "failed";
  const long = body.length > CLIP + 80;
  const shown = long && !showAll ? `${body.slice(0, CLIP).trimEnd()}…` : body;
  let n = 3;

  return (
    <>
      <BackLink />
      <h1 className="h1 fade" style={{ marginTop: 14 }}>
        {moving && <>Working<br />on <em>it.</em></>}
        {failed && <>Couldn&rsquo;t<br /><em>file it.</em></>}
        {waiting && <>Here&rsquo;s what<br />I <em>got.</em></>}
        {c.status === "filed" && <>Here&rsquo;s what<br />I <em>filed.</em></>}
      </h1>
      <p className="lede anim" style={style(1, { marginTop: 12 })}>
        {moving && WORKING[c.status]}
        {failed && (c.error || "Something went wrong on the way through.")}
        {waiting && "Check it, then file it. Anything wrong, tap to fix."}
        {c.status === "filed" && "Filed on its own. Anything wrong, tap to fix, then Done."}
      </p>
      <p className="stamp anim" style={style(2, { marginTop: 10 })}>
        {fmtWhen(c.capturedAt)}
        {c.durationSec ? ` / ${Math.round(c.durationSec)} seconds` : c.kind === "text" ? " / typed" : ""}
        {c.placeHint ? ` / ${c.placeHint}` : c.place ? ` / ${c.place.name}` : ""}
      </p>

      {(body || moving) && (
        <div className="script anim" style={style(3, { marginTop: 18, fontSize: 13, color: "var(--text-2)" })}>
          {body ? shown : <span className="caret" />}
          {long && (
            <>
              {" "}
              <button className="act" onClick={() => setShowAll((s) => !s)}>{showAll ? "Less" : "Show all"}</button>
            </>
          )}
        </div>
      )}

      {x && decisions && !moving && (
        <>
          <section className="block">
            <div className="label">Found <span className="n">{plural(x.people.length, "person", "people")}</span></div>
            {x.people.length === 0 && <p className="empty" style={{ padding: "24px 0" }}>No one in particular.<br /><em>Everything it heard is below, as loose threads.</em></p>}
            <div className="list">
              {x.people.map((p, i) => (
                <PersonBlock
                  key={i}
                  index={n++}
                  p={p}
                  i={i}
                  x={x}
                  dec={decisions.people[i]}
                  decisions={decisions}
                  first={x.people.findIndex((q) => q.name === p.name) === i}
                  rosterById={rosterById}
                  roster={view.people}
                  suggestions={view.suggestions[String(i)] ?? []}
                  tagPool={tagPool}
                  picker={picker?.kind === "person" && picker.index === i}
                  onPicker={(open) => setPicker(open ? { kind: "person", index: i } : null)}
                  onPerson={(patch) => setPerson(i, patch)}
                  onEdit={editItem}
                  onLeaveOut={() => leaveOut(i)}
                  onBringBack={() => bringBack(i, p)}
                  onToggle={toggle}
                  onAdd={addFact}
                  onEditAdded={editAdded}
                  onRemoveAdded={removeAdded}
                  createdId={createdId(p.name)}
                />
              ))}
            </div>
          </section>

          <KeptFromBefore x={x} decisions={decisions} view={view} rosterById={rosterById} index={n++} />

          <LooseThreads
            x={x}
            decisions={decisions}
            index={n++}
            rosterById={rosterById}
            roster={view.people}
            notePeople={notePeople(decisions, rosterById)}
            picker={picker?.kind === "loose" ? picker.index : null}
            onPicker={(i) => setPicker(i == null ? null : { kind: "loose", index: i })}
            onLoose={setLoose}
          />

          {view.closes.length > 0 && (
            <section className="block anim" style={style(n++)}>
              <div className="label">Closes <span className="n">{view.closes.length}</span></div>
              <div className="list">
                {view.closes.map((t) => (
                  <div key={t.id} className="item" style={{ borderTop: "none" }}>
                    <span className="ik">Done</span>
                    <span className="it">{t.title}{t.personName && <span className="role"> / {t.personName}</span>}</span>
                  </div>
                ))}
              </div>
            </section>
          )}

          <PlaceRow x={x} view={view} dec={decisions.place} index={n++} onPlace={setPlace} />
        </>
      )}

      {!moving && (
        <div className="actions anim" style={style(n++, { marginTop: 28, paddingBottom: 6 })}>
          {problem && <p className="lede" style={{ color: "var(--text)" }}>{problem}</p>}
          {(waiting || c.status === "filed") && decisions && (
            <button className="btn" disabled={busy} onClick={confirm}>{waiting ? "File it" : "Done"}</button>
          )}
          {failed && <button className="btn" disabled={busy} onClick={rerun}>Try again</button>}
          <Link href="/record" className="btn ghost">Record another</Link>
          {(waiting || c.status === "filed") && (
            <button className="link" disabled={busy} onClick={rerun} style={{ alignSelf: "center", marginTop: 6 }}>
              Read it again
            </button>
          )}
        </div>
      )}
    </>
  );
}

/* ───────────────────────────────── people ───────────────────────────────── */

function PersonBlock({ index, p, i, x, dec, decisions, first, rosterById, roster, suggestions, tagPool, picker, onPicker, onPerson, onLeaveOut, onBringBack, onToggle, onEdit, onAdd, onEditAdded, onRemoveAdded, createdId }: {
  index: number;
  p: ExtractionResult["people"][number];
  i: number;
  x: ExtractionResult;
  dec: PersonDecision;
  decisions: FilingDecisions;
  /** The first entry with this name gets the items; a duplicate name gets none. */
  first: boolean;
  rosterById: Map<string, PersonLite>;
  roster: PersonLite[];
  suggestions: Suggestion[];
  tagPool: string[];
  picker: boolean;
  onPicker: (open: boolean) => void;
  onPerson: (patch: Partial<PersonDecision>) => void;
  onLeaveOut: () => void;
  onBringBack: () => void;
  onToggle: (key: "facts" | "interactions" | "threads", i: number) => void;
  onEdit: (key: "facts" | "interactions" | "threads", i: number, patch: Record<string, unknown>) => void;
  onAdd: (personName: string, kind: FactKind, text: string) => void;
  onEditAdded: (i: number, patch: { kind?: FactKind; text?: string }) => void;
  onRemoveAdded: (i: number) => void;
  createdId: string | null;
}) {
  const row = dec.personId ? rosterById.get(dec.personId) : undefined;
  const matched = dec.action === "match" && row;
  const name = matched ? row.displayName : p.name;
  // Their page, once they have a row: the person they matched, or the row a filing created for this name.
  const pageId = dec.action === "drop" ? null : row ? row.id : createdId && rosterById.has(createdId) ? createdId : null;
  const role = (matched ? row.role : null) ?? p.role ?? null;
  const out = dec.action === "drop";
  const status = statusOf(p, dec);
  const tags = dec.tags ?? [];
  const [adding, setAdding] = useState(false);
  const [writing, setWriting] = useState(false);

  const facts = first ? x.facts.map((f, k) => [f, k] as const).filter(([f]) => f.personName === p.name) : [];
  // Typed facts are keyed by name too, so the first block with a name owns them.
  const added = first
    ? (decisions.added ?? []).map((a, k) => [a, k] as const).filter(([a]) => a.personName === p.name)
    : [];
  const interactions = first ? x.interactions.map((f, k) => [f, k] as const).filter(([f]) => f.personName === p.name) : [];
  const threads = first ? x.threads.map((f, k) => [f, k] as const).filter(([f]) => f.personName === p.name) : [];

  return (
    <div className={`pb anim${out ? " out" : ""}`} style={style(index)}>
      <div className="row">
        <span className="mark">{initials(name)}</span>
        <span className="body">
          {pageId ? <Link href={`/people/${pageId}`} className="nm nm-link">{name}</Link> : <span className="nm">{name}</span>}
          {role && <span className="role">{role}</span>}
          <span className="meta">
            <span className={status.live ? "live" : undefined}>{status.text}</span>
            {out ? (
              <button className="act" onClick={onBringBack}>Undo</button>
            ) : (
              <>
                <button className="act" onClick={() => onPicker(!picker)}>Someone else</button>
                <button className="act" onClick={onLeaveOut}>Leave out</button>
              </>
            )}
          </span>
          {!out && dec.action === "new" && suggestions.length > 0 && (
            <span className="meta">
              <span>Could be</span>
              {suggestions.map((s) => (
                <button key={s.id} className="act gold" onClick={() => onPerson({ action: "match", personId: s.id })}>{s.displayName}</button>
              ))}
            </span>
          )}
          {!out && (
            <div className="tags">
              {tags.map((t) => (
                <span key={t} className="tg">
                  <span>{t}</span>
                  <button type="button" aria-label={`Remove ${t}`} onClick={() => onPerson({ tags: tags.filter((k) => k !== t) })}>×</button>
                </span>
              ))}
              {!adding && <button type="button" className="act" onClick={() => setAdding(true)}>+ tag</button>}
            </div>
          )}
          {adding && !out && (
            <TagAdder
              pool={tagPool.filter((t) => !tags.some((k) => k.toLowerCase() === t.toLowerCase()))}
              onAdd={(t) => { onPerson({ tags: mergeTags(tags, [t]) }); setAdding(false); }}
              onClose={() => setAdding(false)}
            />
          )}
          {picker && !out && (
            <PersonPicker
              roster={roster}
              preferred={[]}
              newName={p.name}
              onPick={(personId) => {
                onPerson(personId ? { action: "match", personId } : { action: "new", personId: createdId });
                onPicker(false);
              }}
              onClose={() => onPicker(false)}
            />
          )}
        </span>
      </div>

      {(facts.length > 0 || added.length > 0 || interactions.length > 0 || threads.length > 0 || (!out && first)) && (
        <div className="items">
          {facts.map(([f, k]) => {
            const d = decisions.facts[k];
            const kind = d.kind ?? f.kind;
            return (
              <ItemRow
                key={`f${k}`} k={FACT_LABELS[kind]} kind={kind} text={d.text ?? f.content}
                edited={!!d.text || (!!d.kind && d.kind !== f.kind)}
                keep={d.keep} muted={out}
                onToggle={() => onToggle("facts", k)}
                onSave={(e) => onEdit("facts", k, {
                  text: e.text === f.content ? undefined : e.text,
                  kind: e.kind === f.kind ? undefined : e.kind,
                })}
              />
            );
          })}
          {added.map(([a, k]) => (
            <ItemRow
              key={`a${k}`} k={FACT_LABELS[a.kind]} kind={a.kind} text={a.text} edited={false}
              keep muted={out}
              onToggle={() => onRemoveAdded(k)}
              onSave={(e) => onEditAdded(k, { text: e.text, kind: e.kind })}
              onRemove={() => onRemoveAdded(k)}
            />
          ))}
          {interactions.map(([it, k]) => {
            const d = decisions.interactions[k];
            const when = d.at ?? it.occurredAt;
            return (
              <ItemRow
                key={`i${k}`} k={fmtDay(when) ?? "Met"} text={d.text ?? it.summary} edited={!!d.text || !!d.at}
                date={when} dateLabel="Happened" keep={d.keep} muted={out}
                onToggle={() => onToggle("interactions", k)}
                onSave={(e) => onEdit("interactions", k, {
                  text: e.text === it.summary ? undefined : e.text,
                  at: e.date && e.date !== it.occurredAt ? e.date : undefined,
                })}
              />
            );
          })}
          {threads.map(([t, k]) => {
            const d = decisions.threads[k];
            const due = d.dueAt === undefined ? t.dueAt : d.dueAt;
            return (
              <ItemRow
                key={`t${k}`} k={due && fmtDay(due) ? `Due ${fmtDay(due)}` : "Follow-up"} text={d.text ?? t.title}
                edited={!!d.text || d.dueAt !== undefined}
                date={due} dateLabel="Due" clearable keep={d.keep} muted={out}
                onToggle={() => onToggle("threads", k)}
                onSave={(e) => onEdit("threads", k, {
                  text: e.text === t.title ? undefined : e.text,
                  dueAt: (e.date ?? null) === (t.dueAt ?? null) ? undefined : e.date ?? null,
                })}
              />
            );
          })}
          {!out && first && (writing
            ? <AddFact onAdd={(kind, text) => onAdd(p.name, kind, text)} onClose={() => setWriting(false)} />
            : <button type="button" className="act add" onClick={() => setWriting(true)}>+ note</button>)}
        </div>
      )}
    </div>
  );
}

/** What the model thought, and whether the user has overruled it. */
function statusOf(p: ExtractionResult["people"][number], dec: PersonDecision): { text: string; live: boolean } {
  if (dec.action === "drop") return { text: "Left out", live: false };
  if (dec.action === "match") {
    if (dec.personId !== p.matchedPersonId) return { text: "Matched by you", live: true };
    return { text: `Matched ${pct(p.confidence)}`, live: p.confidence >= AUTO_FILE_THRESHOLD };
  }
  if (p.matchedPersonId) return { text: "New, by you", live: true };
  if (!p.isNew) return { text: "Not sure who this is", live: false };
  if (p.confidence < AUTO_FILE_THRESHOLD) return { text: `New / ${pct(p.confidence)} sure`, live: false };
  return { text: "New", live: true };
}

/**
 * One thing the note says, and the ability to fix it. Tap the words, change
 * them, Done. The model is nearly right often enough that dropping a whole
 * fact to correct one word was the wrong and only choice.
 *
 * Nothing here rewrites the note. Facts, visits and follow-ups are derived
 * from it, so a correction is a re-file; the transcript stands as it was said.
 */
function ItemRow({ k, kind, text: t, edited, date, dateLabel, clearable, keep, muted, onToggle, onSave, onRemove }: {
  k: string;
  /** Facts carry one, and it can be changed while editing. Visits and follow-ups do not. */
  kind?: FactKind;
  text: string;
  edited: boolean;
  /** ISO, for the rows that carry a date. Absent on the rows that do not. */
  date?: string | null;
  dateLabel?: string;
  /** Whether the date may be removed altogether. A visit always happened; a follow-up need not be due. */
  clearable?: boolean;
  keep: boolean;
  muted: boolean;
  onToggle: () => void;
  onSave: (e: { text: string; date?: string | null; kind?: FactKind }) => void;
  /** Set on a fact the user typed: there is nothing to keep, so it is removed outright. */
  onRemove?: () => void;
}) {
  const hasDate = date !== undefined;
  const [draft, setDraft] = useState<string | null>(null);
  const [day, setDay] = useState("");
  const [pick, setPick] = useState<FactKind | undefined>(kind);
  const editing = draft !== null;

  const start = () => { setDraft(t); setDay(toDateInput(date)); setPick(kind); };
  const cancel = () => setDraft(null);
  const commit = () => {
    const next = (draft ?? "").trim();
    if (next) onSave({
      text: next,
      ...(hasDate ? { date: day ? fromDateInput(day) : null } : {}),
      ...(pick ? { kind: pick } : {}),
    });
    setDraft(null);
  };

  if (editing) {
    return (
      <div className="item">
        <span className="ik">{k}</span>
        <span className="it">
          <textarea
            className="ie" value={draft ?? "" } autoFocus rows={Math.min(6, Math.ceil((draft ?? "").length / 46) + 1)}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") cancel();
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commit(); }
            }}
          />
          {hasDate && (
            <label className="ie-when">
              {dateLabel}
              <input type="date" value={day} onChange={(e) => setDay(e.target.value)} />
              {clearable && day && <button type="button" className="act" onClick={() => setDay("")}>No date</button>}
            </label>
          )}
          {pick !== undefined && <KindPicker value={pick} onPick={setPick} />}
        </span>
        <span className="acts">
          <button className="act gold" onClick={commit} disabled={!(draft ?? "").trim()}>Done</button>
          <button className="act" onClick={cancel}>Cancel</button>
          {onRemove && <button className="act" onClick={onRemove}>Remove</button>}
        </span>
      </div>
    );
  }

  return (
    <div className={`item${keep ? "" : " off"}`}>
      <span className="ik">{k}</span>
      <span className="it">
        {muted || !keep
          ? <span>{t}</span>
          : <button type="button" className="it-tap" onClick={start} aria-label="Change this">{t}</button>}
        {edited && <span className="edited">Edited</span>}
      </span>
      {!muted && (onRemove
        ? <button className="act" onClick={onRemove}>Remove</button>
        : <button className="act" onClick={onToggle}>{keep ? "Drop" : "Undo"}</button>)}
    </div>
  );
}

/**
 * What a fact is about, as words with an underline on the chosen one. The
 * app has no pill chips, and a native select would be the only one in it.
 */
function KindPicker({ value, onPick }: { value: FactKind; onPick: (k: FactKind) => void }) {
  return (
    <span className="kinds" role="radiogroup" aria-label="What this is about">
      {FACT_PICKS.map((k) => (
        <button
          key={k} type="button" role="radio" aria-checked={k === value}
          className={`kd${k === value ? " on" : ""}`}
          onClick={() => onPick(k)}
        >{FACT_LABELS[k]}</button>
      ))}
    </span>
  );
}

/**
 * Something the model did not hear. The note is the record, so this is not a
 * way to rewrite it: it is a way to add what you know about the person while
 * they are in front of you, which is the only moment you will remember to.
 */
function AddFact({ onAdd, onClose }: { onAdd: (kind: FactKind, text: string) => void; onClose: () => void }) {
  const [draft, setDraft] = useState("");
  const [kind, setKind] = useState<FactKind>(DEFAULT_FACT_KIND);
  const commit = () => { const next = draft.trim(); if (next) onAdd(kind, next); onClose(); };

  return (
    <div className="item">
      <span className="ik">{FACT_LABELS[kind]}</span>
      <span className="it">
        <textarea
          className="ie" value={draft} autoFocus rows={2} placeholder="What do you want to remember?"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commit(); }
          }}
        />
        <KindPicker value={kind} onPick={setKind} />
      </span>
      <span className="acts">
        <button className="act gold" onClick={commit} disabled={!draft.trim()}>Add</button>
        <button className="act" onClick={onClose}>Cancel</button>
      </span>
    </div>
  );
}


/* ───────────────────────────── kept from before ────────────────────────── */

/**
 * People this note added the first time it was read that the model did not
 * list on a re-read. They keep their rows; only Leave out removes a person.
 * Shown so a re-run never quietly loses a name.
 */
function KeptFromBefore({ x, decisions, view, rosterById, index }: {
  x: ExtractionResult;
  decisions: FilingDecisions;
  view: CaptureView;
  rosterById: Map<string, PersonLite>;
  index: number;
}) {
  const referenced = new Set<string>();
  for (const p of x.people) if (p.matchedPersonId) referenced.add(p.matchedPersonId);
  for (const d of decisions.people) if (d.personId) referenced.add(d.personId);
  const names = new Set(x.people.map((p) => p.name.trim().toLowerCase()));
  const kept = (view.capture.filing?.created ?? [])
    .filter((c) => !referenced.has(c.personId) && !names.has(c.name.trim().toLowerCase()))
    .map((c) => rosterById.get(c.personId))
    .filter((p): p is PersonLite => !!p);
  if (!kept.length) return null;

  return (
    <section className="block anim" style={style(index)}>
      <div className="label">Also from this note <span className="n">{kept.length}</span></div>
      <p className="lede" style={{ marginTop: 8 }}>Added the first time this note was read. Not mentioned this time; they stay.</p>
      <div className="list" style={{ marginTop: 6 }}>
        {kept.map((p) => (
          <div key={p.id} className="row" style={{ padding: "12px 0" }}>
            <span className="mark">{initials(p.displayName)}</span>
            <span className="body">
              <Link href={`/people/${p.id}`} className="nm nm-link">{p.displayName}</Link>
              {p.role && <span className="role">{p.role}</span>}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ───────────────────────────── loose threads ───────────────────────────── */

/** The people this note resolves to, for attaching loose threads. Only rows that exist. */
function notePeople(decisions: FilingDecisions, rosterById: Map<string, PersonLite>): PersonLite[] {
  const out: PersonLite[] = [];
  for (const d of decisions.people) {
    if (d.action === "drop" || !d.personId) continue;
    const row = rosterById.get(d.personId);
    if (row && !out.includes(row)) out.push(row);
  }
  return out;
}

function LooseThreads({ x, decisions, index, rosterById, roster, notePeople: note, picker, onPicker, onLoose }: {
  x: ExtractionResult;
  decisions: FilingDecisions;
  index: number;
  rosterById: Map<string, PersonLite>;
  roster: PersonLite[];
  notePeople: PersonLite[];
  picker: number | null;
  onPicker: (i: number | null) => void;
  onLoose: (i: number, patch: Partial<FilingDecisions["unresolved"][number]>) => void;
}) {
  const names = new Set(x.people.map((p) => p.name));
  // Things the model attached to a name it never listed. They file as loose threads.
  const orphans = [
    ...x.facts.filter((f) => !names.has(f.personName)).map((f) => `${f.personName}: ${f.content}`),
    ...x.interactions.filter((f) => !names.has(f.personName)).map((f) => `${f.personName}: ${f.summary}`),
    ...x.threads.filter((f) => !names.has(f.personName)).map((f) => `${f.personName}: ${f.title}`),
  ];
  const total = x.unresolved.length + orphans.length;
  if (!total) return null;

  return (
    <section className="block anim" style={style(index)}>
      <div className="label">Loose threads <span className="n">{total}</span></div>
      <div className="list">
        {x.unresolved.map((t, i) => {
          const dec = decisions.unresolved[i];
          const target = dec.personId ? rosterById.get(dec.personId) : undefined;
          const off = dec.dismissed;
          return (
            <div key={i} className={`loose${off ? " off" : ""}`}>
              <LooseText text={dec.text ?? t} edited={!!dec.text} locked={off} onSave={(next) => onLoose(i, { text: next === t ? undefined : next })} />
              <div className="tmeta">
                {off && <><span>Dismissed</span><button className="act" onClick={() => onLoose(i, { dismissed: false })}>Undo</button></>}
                {!off && target && <><span className="live" style={{ color: "var(--gold)" }}>Attached to {target.displayName}</span><button className="act" onClick={() => onLoose(i, { personId: null })}>Detach</button></>}
                {!off && !target && (
                  <>
                    <span>No match yet</span>
                    <button className="act" onClick={() => onPicker(picker === i ? null : i)}>Attach</button>
                    <button className="act" onClick={() => onLoose(i, { dismissed: true, personId: null })}>Dismiss</button>
                  </>
                )}
              </div>
              {picker === i && !off && !target && (
                <PersonPicker
                  roster={roster}
                  preferred={note}
                  newName={null}
                  onPick={(personId) => { if (personId) onLoose(i, { personId, dismissed: false }); onPicker(null); }}
                  onClose={() => onPicker(null)}
                />
              )}
            </div>
          );
        })}
        {orphans.map((t, i) => (
          <div key={`o${i}`} className="loose">
            <q>{t}</q>
            <div className="tmeta"><span>Kept as a loose thread</span></div>
          </div>
        ))}
      </div>
    </section>
  );
}

/** A loose thread's own words, correctable in place like everything else. */
function LooseText({ text, edited, locked, onSave }: { text: string; edited: boolean; locked: boolean; onSave: (next: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => { const next = (draft ?? "").trim(); if (next) onSave(next); setDraft(null); };
  if (draft === null) {
    return (
      <q>
        {locked ? text : <button type="button" className="it-tap" onClick={() => setDraft(text)} aria-label="Change this">{text}</button>}
        {edited && <span className="edited">Edited</span>}
      </q>
    );
  }
  return (
    <div>
      <textarea
        className="ie" value={draft} autoFocus rows={Math.min(6, Math.ceil(draft.length / 46) + 1)}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setDraft(null);
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commit(); }
        }}
      />
      <div className="tmeta">
        <button className="act gold" onClick={commit} disabled={!draft.trim()}>Done</button>
        <button className="act" onClick={() => setDraft(null)}>Cancel</button>
      </div>
    </div>
  );
}

/* ───────────────────────────────── place ───────────────────────────────── */

function PlaceRow({ x, view, dec, index, onPlace }: {
  x: ExtractionResult;
  view: CaptureView;
  dec: FilingDecisions["place"];
  index: number;
  onPlace: (place: FilingDecisions["place"]) => void;
}) {
  const known = view.capture.place;
  const chosen = dec.placeId ? (known?.id === dec.placeId ? known.name : "A place you know") : dec.name;
  const heard = x.place?.name?.trim() || null;
  return (
    <section className="block anim" style={style(index)}>
      <div className="label">Place</div>
      <div className="item" style={{ borderTop: "none" }}>
        <span className="it">{chosen ?? "No place"}</span>
        {chosen ? (
          <button className="act" onClick={() => onPlace({ placeId: null, name: null })}>Clear</button>
        ) : (
          <span className="meta" style={{ gap: 10 }}>
            {known && <button className="act" onClick={() => onPlace({ placeId: known.id, name: null })}>Use {known.name}</button>}
            {heard && heard.toLowerCase() !== known?.name.toLowerCase() && (
              <button className="act" onClick={() => onPlace({ placeId: null, name: heard })}>Use &ldquo;{heard}&rdquo;</button>
            )}
          </span>
        )}
      </div>
    </section>
  );
}

/* ───────────────────────────────── picker ──────────────────────────────── */

/**
 * Inline, never a modal. A search over the user's people, with the people
 * already in this note first when there is nothing typed, and the option to
 * keep the name as someone new when that makes sense.
 */
function PersonPicker({ roster, preferred, newName, onPick, onClose }: {
  roster: PersonLite[];
  preferred: PersonLite[];
  /** Offer "someone new" under this name. Null hides the option. */
  newName: string | null;
  onPick: (personId: string | null) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const s = q.trim().toLowerCase();
  const hits = s
    ? roster.filter((p) => p.displayName.toLowerCase().includes(s) || (p.goesBy ?? "").toLowerCase().includes(s) || (p.role ?? "").toLowerCase().includes(s))
    : [...preferred, ...roster.filter((p) => !preferred.includes(p))];
  const shown = hits.slice(0, 8);

  return (
    <div className="picker">
      <label className="field">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={roster.length ? "Who is it?" : "No one yet"}
          autoFocus
          autoComplete="off"
          spellCheck={false}
          onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}
        />
        <button className="act" type="button" onClick={onClose}>Cancel</button>
      </label>
      <div className="list">
        {newName && !s && (
          <button className="row" type="button" onClick={() => onPick(null)}>
            <span className="mark" style={{ "--c": "var(--gold)" } as CSSProperties}>+</span>
            <span className="body"><span className="nm" style={{ fontSize: 14 }}>Someone new: {newName}</span></span>
          </button>
        )}
        {shown.map((p) => (
          <button key={p.id} className="row" type="button" onClick={() => onPick(p.id)}>
            <span className="mark">{initials(p.displayName)}</span>
            <span className="body">
              <span className="nm" style={{ fontSize: 14 }}>{p.displayName}</span>
              {p.role && <span className="role">{p.role}</span>}
            </span>
          </button>
        ))}
        {s && !shown.length && <p className="empty" style={{ padding: "18px 0" }}>Nobody by that name.</p>}
        {!s && hits.length > shown.length && <p className="stamp" style={{ padding: "10px 0" }}>Type to narrow it down</p>}
      </div>
    </div>
  );
}

/* ───────────────────────────────── bits ────────────────────────────────── */

function BackLink() {
  return <Back href="/record">Recent notes</Back>;
}

/** A toast for the screen we are about to leave. Read once by the capture screen. */
function handOff(message: string) {
  try { sessionStorage.setItem("kith:toast", message); } catch { /* private mode */ }
}

function fmtWhen(iso: string) {
  const d = new Date(iso);
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })}, ${d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

function fmtDay(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}
