"use client";
import { useEffect, useState, type CSSProperties } from "react";
import Link from "next/link";
import { store, type TodayView, type Coords } from "@/lib/store";
import { fmtDay, fmtDue } from "@/lib/format";
import { PersonRow } from "./PersonRow";

const style = (i: number, extra?: CSSProperties) => ({ "--i": Math.min(i, 14), ...extra }) as CSSProperties;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Today. What the app has to say the moment you open it, and nothing else.
 *
 * Every block hides when it is empty, so a quiet day is a short screen rather
 * than five headings standing over nothing. That is the whole design: this
 * page is allowed to be almost blank, and often should be.
 *
 * Nothing here is a badge or a streak. The counts are how many things there
 * are, and the only saturated colour is on a thread that is actually overdue.
 */
export function TodayScreen() {
  const [view, setView] = useState<TodayView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [here, setHere] = useState<Coords | null>(null);

  // Location names the place and lifts the people you see there. It hides
  // nobody, and a refusal costs nothing but the block.
  useEffect(() => {
    let alive = true;
    store.coords().then((c) => { if (alive && c) setHere(c); });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    let alive = true;
    store.today(here)
      .then((next) => { if (alive) { setView(next); setError(null); } })
      .catch((e) => { if (alive) setError(message(e)); });
    return () => { alive = false; };
  }, [here]);

  if (error) return <p className="empty">Couldn&rsquo;t load today.<br /><em>{error}</em></p>;

  const late = view?.threads.filter((t) => fmtDue(t.dueAt).late).length ?? 0;
  const quiet = view
    && !view.place && !view.likelyHere.length && !view.threads.length
    && !view.slipping.length && !view.loose.length && !view.review.count;
  let n = 2;

  return (
    <>
      <h1 className="h1 fade" style={{ marginTop: 14 }}>
        {partOfDay()},<br /><em>{view?.firstName ?? "you"}.</em>
      </h1>
      <p className="stamp anim" style={style(1, { marginTop: 10 })}>{longDate()}</p>

      {view?.place && (
        <div className="geo anim" style={style(2)}>
          <span className="locator"><span /><span /><b /></span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="geo-name">{view.place.name}</div>
            <div className="stamp" style={{ color: "var(--gold)", marginTop: 9 }}>
              {view.place.distanceM < 40 ? "You are here" : `${view.place.distanceM} m away`}
            </div>
          </div>
        </div>
      )}

      {view && view.review.count > 0 && (
        <Link
          href={view.review.oldestId ? `/notes/${view.review.oldestId}` : "/record"}
          className="row anim"
          style={style(n++, { marginTop: 22, borderBottom: "1px solid var(--rule)" })}
        >
          <span className="sq" style={{ "--c": "var(--gold)", marginTop: 7 } as CSSProperties} />
          <span className="body">
            <span className="recall">
              {view.review.count === 1 ? "One note is waiting for a look." : `${view.review.count} notes are waiting for a look.`}
            </span>
            <span className="meta"><span className="live">Open the oldest</span></span>
          </span>
        </Link>
      )}

      {view && view.likelyHere.length > 0 && (
        <section className="block">
          <div className="label">Likely here <span className="n">{view.likelyHere.length}</span></div>
          <div className="list">
            {view.likelyHere.map((x) => <PersonRow key={x.person.id} p={x.person} index={n++} />)}
          </div>
        </section>
      )}

      {view && view.threads.length > 0 && (
        <section className="block">
          <div className="label">
            Owed <span className="n">{late > 0 ? `${late} late` : view.threads.length}</span>
          </div>
          <div className="list">
            {view.threads.map((t) => {
              const due = fmtDue(t.dueAt);
              const inner = (
                <>
                  <div className="tt">{t.title}</div>
                  <div className="tmeta">
                    {due.late && <span className="dot-late" />}
                    <span className={due.late ? "late" : undefined}>{due.text}</span>
                    {t.person && <span>{t.person.displayName}</span>}
                  </div>
                </>
              );
              return t.person ? (
                <Link key={t.id} href={`/people/${t.person.id}`} className="thread anim" style={style(n++)}>
                  <div style={{ flex: 1 }}>{inner}</div>
                </Link>
              ) : (
                <div key={t.id} className="thread anim" style={style(n++)}>
                  <div style={{ flex: 1 }}>{inner}</div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {view && view.slipping.length > 0 && (
        <section className="block">
          <div className="label">Slipping</div>
          <div className="list">
            {view.slipping.map((x) => (
              <div key={x.person.id} className="hit anim" style={style(n++)}>
                <PersonRow p={x.person} index={n} />
                <div className="why">
                  {x.daysSince}d since / you said every {x.cadenceDays}d
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {view && view.loose.length > 0 && (
        <section className="block">
          <div className="label">Loose threads <span className="n">{view.loose.length}</span></div>
          <div className="list">
            {view.loose.map((l) => {
              const body = (
                <>
                  <q>{l.content}</q>
                  <div className="tmeta">
                    <span>Heard {fmtDay(l.at)}</span>
                    <span>No match yet</span>
                  </div>
                </>
              );
              return l.captureId
                ? <Link key={l.id} href={`/notes/${l.captureId}`} className="loose anim" style={style(n++)}>{body}</Link>
                : <div key={l.id} className="loose anim" style={style(n++)}>{body}</div>;
            })}
          </div>
        </section>
      )}

      {quiet && (
        <p className="empty anim" style={style(3)}>
          Nothing owed, nobody slipping.<br /><em>Go and see someone.</em>
        </p>
      )}
    </>
  );
}

/** The phone's clock, not the server's. A greeting from the wrong timezone is worse than none. */
function partOfDay(now = new Date()): string {
  const h = now.getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

const longDate = (now = new Date()) =>
  now.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });

