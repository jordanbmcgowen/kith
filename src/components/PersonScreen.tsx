"use client";
import { useEffect, useState, type CSSProperties } from "react";
import Link from "next/link";
import { store, ApiError, type PersonView } from "@/lib/store";
import { circleColor, circleLabel, initials } from "@/lib/circles";
import { daysSince, fmtChannel, fmtDay, fmtDue, excerpt } from "@/lib/format";
import { BackLink } from "./BackLink";
import { PEOPLE_VIEW_KEY } from "./PeopleScreen";
import { sayOf } from "./PersonRow";

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
      <div className="phead anim" style={style(1)}>
        <span className="mark lg" style={{ "--c": c } as CSSProperties}>{initials(p.displayName)}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1 className="pname">{p.displayName}</h1>
          {say && <div className="say" style={{ marginTop: 7 }}>{say}</div>}
          {role && <div className="role" style={{ marginTop: 7 }}>{role}</div>}
          <div className="meta" style={{ marginTop: 10 }}>
            <span className="circ"><span className="sq" style={{ "--c": c } as CSSProperties} />{circleLabel(p.circle)}</span>
            {p.tags.map((t) => <span key={t} className="tg">{t}</span>)}
          </div>
        </div>
      </div>

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
        <div className="label">History{history.length > 0 && <span className="n">{history.length}</span>}</div>
        {history.length === 0 && <p className="lede" style={{ padding: "12px 0" }}>No visits noted yet.</p>}
        {history.length > 0 && (
          <div className="tl">
            {history.map((e) => <Visit key={e.id} e={e} color={c} index={n++} />)}
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

function Visit({ e, color, index }: { e: Entry; color: string; index: number }) {
  const when = [fmtDay(new Date(e.at).toISOString()), e.channel].filter(Boolean).join(" / ");
  const inner = (
    <>
      <div className="ev-when">
        {when}
        {e.noteId && <span className="act">Open note</span>}
      </div>
      <div className="ev-text">{e.text}</div>
      {e.place && <div className="ev-place">{e.place}</div>}
    </>
  );
  const s = style(index, { "--c": color } as CSSProperties);
  return e.noteId
    ? <Link href={`/notes/${e.noteId}`} className="ev anim" style={s}>{inner}</Link>
    : <div className="ev anim" style={s}>{inner}</div>;
}
