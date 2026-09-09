"use client";
import { useEffect, useState, type CSSProperties } from "react";
import Link from "next/link";
import { store, ApiError, type PersonView, type PersonPatch, type Circle } from "@/lib/store";
import { CIRCLES, circleColor, circleLabel, initials } from "@/lib/circles";
import { mergeTags } from "@/lib/decisions";
import { daysSince, fmtChannel, fmtDay, fmtDue, excerpt, toDateInput, fromDateInput } from "@/lib/format";
import { BackLink } from "./BackLink";
import { PEOPLE_VIEW_KEY } from "./PeopleScreen";
import { sayOf } from "./PersonRow";
import { TagAdder } from "./TagAdder";

const style = (i: number, extra?: CSSProperties) => ({ "--i": Math.min(i, 14), ...extra }) as CSSProperties;
const text = (e: unknown) => (e instanceof Error ? e.message : String(e));
const pad = (n: number) => String(n).padStart(2, "0");

/** One line of the timeline: a visit, with the note it came from. */
type Entry = {
  id: string;
  at: number;
  text: string;
  place: string | null;
  channel: string | null;
  noteId: string | null;
};

/**
 * Step 4 of the build order: the person page, read only. What to remember
 * first, what you owe them, what has happened, where you see them, and the
 * notes all of it came from. Every visit and every note opens the note, so
 * nothing here is more than one tap from what you actually said.
 */
export function PersonScreen({ id }: { id: string }) {
  const [view, setView] = useState<PersonView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [back, setBack] = useState("/people");
  const [editing, setEditing] = useState(false);
  const [logging, setLogging] = useState(false);
  /** Every tag the user has, for the suggestions under "+ tag". Fetched only when editing. */
  const [tagPool, setTagPool] = useState<string[]>([]);

  const reload = () =>
    store.person(id).then((next) => { setView(next); setError(null); });

  const openEditor = () => {
    setEditing(true);
    store.people().then((l) => setTagPool(l.tags)).catch(() => { /* suggestions are a nicety */ });
  };

  useEffect(() => {
    try {
      const q = sessionStorage.getItem(PEOPLE_VIEW_KEY);
      if (q) setBack(`/people?${q}`);
    } catch { /* private mode */ }
  }, []);

  useEffect(() => {
    let alive = true;
    setView(null);
    store.person(id)
      .then((next) => { if (alive) { setView(next); setError(null); } })
      .catch((e) => { if (alive) setError(e instanceof ApiError && e.status === 404 ? "There is no one here." : text(e)); });
    return () => { alive = false; };
  }, [id]);

  const backLink = <BackLink href={back}>All people</BackLink>;
  if (error) return <>{backLink}<p className="empty">Couldn&rsquo;t load this person.<br /><em>{error}</em></p></>;
  if (!view) return backLink;

  const { person: p, facts, threads, places, notes } = view;
  const c = circleColor(p.circle);
  const say = sayOf(p);
  const role = p.role ?? [p.title, p.company].filter(Boolean).join(", ") ?? null;
  const days = daysSince(p.lastInteractionAt);
  const history = visits(view);
  let n = 3;

  return (
    <>
      {backLink}
      {editing ? (
        <PersonEditor
          person={p}
          pool={tagPool}
          onClose={() => setEditing(false)}
          // Reload first, then close: leaving edit mode before the new row
          // arrives shows the old name for as long as the round trip takes.
          onSaved={async () => { await reload(); setEditing(false); }}
        />
      ) : (
        <div className="phead anim" style={style(1)}>
          <span className="mark lg" style={{ "--c": c } as CSSProperties}>{initials(p.displayName)}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h1 className="pname">{p.displayName}</h1>
            {say && <div className="say" style={{ marginTop: 7 }}>{say}</div>}
            {role && <div className="role" style={{ marginTop: 7 }}>{role}</div>}
            <div className="meta" style={{ marginTop: 10 }}>
              <span className="circ"><span className="sq" style={{ "--c": c } as CSSProperties} />{circleLabel(p.circle)}</span>
              {p.tags.map((t) => <span key={t} className="tg">{t}</span>)}
              <button className="act" onClick={openEditor}>Edit</button>
            </div>
          </div>
        </div>
      )}

      <div className="stats anim" style={style(2)}>
        <div className="stat">
          {days == null
            ? <span className="sv none">none yet</span>
            : <span className="sv">{days}<span className="unit">d</span></span>}
          <span className="sk">Since seen</span>
        </div>
        <div className="stat">
          <span className="sv">{p.cadenceDays}<span className="unit">d</span></span>
          <span className="sk">Your cadence</span>
        </div>
        <div className="stat">
          <span className="meter" style={{ "--c": c, "--v": p.warmth } as CSSProperties} role="img" aria-label={`Warmth ${p.warmth} of 100`}><i /></span>
          <span className="sk">Warmth</span>
        </div>
      </div>

      <section className="block">
        <div className="label">Remember first{facts.length > 0 && <span className="n">{facts.length}</span>}</div>
        {facts.length === 0 && <p className="lede" style={{ padding: "12px 0" }}>Nothing yet. Say something about them after you next see them.</p>}
        <div className="list">
          {facts.map((f, i) => (
            <div key={f.id} className="fact anim" style={style(n++)}>
              <span className="i">{pad(i + 1)}</span>
              <span>{f.content}</span>
            </div>
          ))}
        </div>
      </section>

      {threads.length > 0 && (
        <section className="block">
          <div className="label">Open threads <span className="n">{threads.length}</span></div>
          <div className="list">
            {threads.map((t) => {
              const due = fmtDue(t.dueAt);
              return (
                <div key={t.id} className="thread anim" style={style(n++)}>
                  <div style={{ flex: 1 }}>
                    <div className="tt">{t.title}</div>
                    <div className="tmeta">
                      {due.late && <span className="dot-late" />}
                      <span className={due.late ? "late" : undefined}>{due.text}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <section className="block">
        <div className="label">
          History{history.length > 0 && <span className="n">{history.length}</span>}
          <button className="act" onClick={() => setLogging((v) => !v)}>{logging ? "Never mind" : "Saw them"}</button>
        </div>
        {logging && (
          <VisitLogger
            personId={p.id}
            onDone={async () => { await reload(); setLogging(false); }}
            onCancel={() => setLogging(false)}
          />
        )}
        {history.length === 0 && !logging && (
          <p className="lede" style={{ padding: "12px 0" }}>No visits noted yet. Saw them puts a date on it.</p>
        )}
        {history.length > 0 && (
          <div className="tl">
            {history.map((e) => <Visit key={e.id} e={e} color={c} index={n++} personId={p.id} onChanged={reload} />)}
          </div>
        )}
      </section>

      {notes.length > 0 && (
        <section className="block">
          <div className="label">Notes <span className="n">{notes.length}</span></div>
          <div className="list">
            {notes.map((x) => (
              <Link key={x.id} href={`/notes/${x.id}`} className="row anim" style={style(n++)}>
                <span className="sq" style={{ "--c": x.status === "needs_review" ? "var(--gold)" : "var(--text-3)", marginTop: 7 } as CSSProperties} />
                <span className="body">
                  <span className="recall">
                    {x.excerpt.trim() ? excerpt(x.excerpt, 160) : <em>{x.kind === "voice" ? "Waiting for the transcript" : "Empty note"}</em>}
                  </span>
                  <span className="meta">
                    <span>{fmtDay(x.capturedAt)}</span>
                    {x.kind === "voice" && <span>Spoken</span>}
                    {x.kind === "text" && <span>Typed</span>}
                    {x.placeHint && <span>at {x.placeHint}</span>}
                    {x.status === "needs_review" && <span className="live">Waiting for a look</span>}
                  </span>
                </span>
              </Link>
            ))}
          </div>
        </section>
      )}

      {places.length > 0 && (
        <section className="block">
          <div className="label">Where you see them</div>
          <div className="list">
            {places.map((pl) => (
              <div key={pl.id} className="row anim" style={style(n++, { padding: "12px 0" })}>
                <span className="sq" style={{ "--c": c, marginTop: 6 } as CSSProperties} />
                <span className="body">
                  <span style={{ fontSize: 13.5 }}>{pl.name}</span>
                  <span className="meta">
                    <span>{pl.weight === 1 ? "once" : `${pl.weight} times`}</span>
                    {pl.lastSeenAt && <span>{fmtDay(pl.lastSeenAt)}</span>}
                  </span>
                </span>
              </div>
            ))}
          </div>
        </section>
      )}
    </>
  );
}

/** Visits, newest first. The API sends them that way; sorting here keeps the screen honest if that changes. */
function visits(view: PersonView): Entry[] {
  return view.interactions
    .map((i) => ({
      id: i.id, at: new Date(i.occurredAt).getTime(), text: i.summary,
      place: i.place?.name ?? null, channel: fmtChannel(i.channel), noteId: i.captureId,
    }))
    .sort((a, b) => b.at - a.at);
}

/**
 * One visit. A visit that came from a note opens that note, and is corrected
 * there: changing it here would be undone the next time the note files again.
 * A visit with no note behind it has nowhere else to be fixed, so it carries
 * its own date and a way to remove it.
 */
function Visit({ e, color, index, personId, onChanged }: {
  e: Entry; color: string; index: number; personId: string; onChanged: () => Promise<unknown>;
}) {
  const [day, setDay] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const when = [fmtDay(new Date(e.at).toISOString()), e.channel].filter(Boolean).join(" / ");
  const s = style(index, { "--c": color } as CSSProperties);

  if (e.noteId) {
    return (
      <Link href={`/notes/${e.noteId}`} className="ev anim" style={s}>
        <div className="ev-when">{when}<span className="act">Open note</span></div>
        <div className="ev-text">{e.text}</div>
        {e.place && <div className="ev-place">{e.place}</div>}
      </Link>
    );
  }

  const commit = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); await onChanged(); } finally { setBusy(false); setDay(null); }
  };

  return (
    <div className="ev anim" style={s}>
      {day === null ? (
        <div className="ev-when">
          {when}
          <button className="act" onClick={() => setDay(toDateInput(new Date(e.at).toISOString()))}>Change the day</button>
          <button className="act" disabled={busy} onClick={() => commit(() => store.removeVisit(personId, e.id))}>Remove</button>
        </div>
      ) : (
        <div className="ie-when" style={{ marginTop: 0 }}>
          Seen
          <input type="date" value={day} max={toDateInput(new Date().toISOString())} onChange={(ev) => setDay(ev.target.value)} />
          <button className="act gold" disabled={busy || !day} onClick={() => {
            const iso = fromDateInput(day);
            if (iso) commit(() => store.editVisit(personId, e.id, { occurredAt: iso }));
          }}>Done</button>
          <button className="act" disabled={busy} onClick={() => setDay(null)}>Cancel</button>
        </div>
      )}
      <div className="ev-text">{e.text}</div>
      {e.place && <div className="ev-place">{e.place}</div>}
    </div>
  );
}

/**
 * "I saw them, on this day." Last seen and warmth are read from the visits,
 * so this is how you correct either: by correcting what they are computed
 * from, never by overwriting the number itself.
 */
function VisitLogger({ personId, onDone, onCancel }: { personId: string; onDone: () => void | Promise<void>; onCancel: () => void }) {
  const today = toDateInput(new Date().toISOString());
  const [day, setDay] = useState(today);
  const [line, setLine] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const save = async () => {
    const iso = fromDateInput(day);
    if (!iso) { setProblem("Pick a day."); return; }
    setBusy(true);
    setProblem(null);
    try {
      await store.addVisit(personId, { occurredAt: iso, ...(line.trim() ? { summary: line.trim() } : {}) });
      await onDone();
    } catch (e) {
      setProblem(text(e));
      setBusy(false);
    }
  };

  return (
    <div className="pedit" style={{ marginTop: 6 }}>
      <div className="ie-when" style={{ marginTop: 0, padding: "12px 0" }}>
        Seen
        <input type="date" value={day} max={today} onChange={(e) => setDay(e.target.value)} />
      </div>
      <label className="field">
        <input value={line} onChange={(e) => setLine(e.target.value)} maxLength={200} placeholder="What happened, if you want to say" autoComplete="off" />
      </label>
      {problem && <p className="why" style={{ color: "var(--alert)" }}>{problem}</p>}
      <div className="meta" style={{ marginTop: 16, gap: 18 }}>
        <button className="act gold" onClick={save} disabled={busy}>{busy ? "Saving" : "Save"}</button>
        <button className="act" onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </div>
  );
}

/**
 * Who someone is, editable in place. Their name, how you say it, what they
 * are to you, their circle, and their tags.
 *
 * Tags are where employers live. Circles are fixed at five and set the
 * cadence, so a company cannot be one: you would lose every previous employer
 * the day someone changes jobs, which is the opposite of the point. A tag list
 * holds Yum and Neighborly at once, and "everyone I know at Neighborly" stays
 * a question you can ask.
 *
 * Facts, visits and threads are not editable here. Those are derived from
 * notes, so the place to correct one is the note it came from, where the
 * correction survives a re-file.
 */
function PersonEditor({ person, pool, onClose, onSaved }: {
  person: PersonView["person"];
  pool: string[];
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const [name, setName] = useState(person.displayName);
  const [goesBy, setGoesBy] = useState(person.goesBy ?? "");
  const [saying, setSaying] = useState(person.pronunciation ?? "");
  const [role, setRole] = useState(person.role ?? "");
  const [circle, setCircle] = useState<Circle>(person.circle);
  const [tags, setTags] = useState<string[]>(person.tags);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const save = async () => {
    const patch: PersonPatch = {
      displayName: name.trim(),
      goesBy: goesBy.trim() || null,
      pronunciation: saying.trim() || null,
      role: role.trim() || null,
      circle,
      tags,
    };
    if (!patch.displayName) { setProblem("A name is the one thing it needs."); return; }
    setBusy(true);
    setProblem(null);
    try {
      await store.updatePerson(person.id, patch);
      await onSaved();
    } catch (e) {
      setProblem(text(e));
      setBusy(false);
    }
  };

  return (
    <div className="pedit anim" style={style(1)}>
      <label className="field">
        <span className="fl">Name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoComplete="off" />
      </label>
      <label className="field">
        <span className="fl">Goes by</span>
        <input value={goesBy} onChange={(e) => setGoesBy(e.target.value)} maxLength={60} placeholder="Sully" autoComplete="off" />
      </label>
      <label className="field">
        <span className="fl">Say it</span>
        <input value={saying} onChange={(e) => setSaying(e.target.value)} maxLength={60} placeholder="MAR-kus ELL-er-ee" autoComplete="off" />
      </label>
      <label className="field">
        <span className="fl">Who they are</span>
        <input value={role} onChange={(e) => setRole(e.target.value)} maxLength={200} placeholder="Two doors down, the blue house" autoComplete="off" />
      </label>

      <div className="tabs circle-row" style={{ marginTop: 16 }} role="group" aria-label="Circle">
        {CIRCLES.map((x) => (
          <button key={x.key} type="button" aria-pressed={circle === x.key} onClick={() => setCircle(x.key)}>{x.label}</button>
        ))}
      </div>

      <div className="meta" style={{ marginTop: 14 }}>
        {tags.map((t) => (
          <span key={t} className="tg">
            {t}
            <button className="x" onClick={() => setTags(tags.filter((y) => y !== t))} aria-label={`Remove ${t}`}>&times;</button>
          </span>
        ))}
        <button className="act" onClick={() => setAdding((v) => !v)}>+ Tag</button>
      </div>
      {adding && (
        <TagAdder
          pool={pool.filter((t) => !tags.some((h) => h.toLowerCase() === t.toLowerCase()))}
          onAdd={(t) => { setTags(mergeTags(tags, [t])); setAdding(false); }}
          onClose={() => setAdding(false)}
        />
      )}

      {problem && <p className="why" style={{ color: "var(--alert)" }}>{problem}</p>}

      <div className="meta" style={{ marginTop: 18, gap: 18 }}>
        <button className="act gold" onClick={save} disabled={busy}>{busy ? "Saving" : "Save"}</button>
        <button className="act" onClick={onClose} disabled={busy}>Cancel</button>
      </div>
    </div>
  );
}
