"use client";
import { useEffect, useState, type CSSProperties } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { store, type PeopleList } from "@/lib/store";
import { toDateInput, fromDateInput } from "@/lib/format";
import { PersonRow } from "./PersonRow";

const style = (i: number, extra?: CSSProperties) => ({ "--i": i, ...extra }) as CSSProperties;
const text = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Where the person page's back link returns to. Written here, read there. */
export const PEOPLE_VIEW_KEY = "kith:people";

/**
 * The people list. One row of underline filters, holding the tags you have
 * given people and nothing else. The tag lives in the URL, so back brings the
 * same view up again. Location never narrows this list; when places exist it
 * will only reorder it.
 */
export function PeopleScreen() {
  const params = useSearchParams();
  const router = useRouter();
  const tag = params.get("tag")?.trim() || null;

  const [data, setData] = useState<PeopleList | null>(null);
  const [error, setError] = useState<string | null>(null);

  /**
   * Saying you saw people. Nobody meets one person at a time: a soccer game is
   * eight parents, a Journeymen evening is twenty, and logging them one by one
   * is why three quarters of a roster can sit at never-seen while its owner
   * sees those people every month.
   *
   * Nothing is selected to begin with, and switching the tag filter keeps what
   * is already chosen, so one evening can span two groups. Recording a visit
   * that did not happen is the one thing this must never do quietly, which is
   * also why the count is always on screen.
   */
  const [picking, setPicking] = useState(false);
  const [chosen, setChosen] = useState<string[]>([]);
  const [day, setDay] = useState(() => toDateInput(new Date().toISOString()));
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);

  const on = new Set(chosen);
  const toggle = (id: string) => setChosen((c) => (c.includes(id) ? c.filter((k) => k !== id) : [...c, id]));
  const stop = () => { setPicking(false); setChosen([]); };

  const save = async () => {
    const when = fromDateInput(day);
    if (!chosen.length || !when) return;
    setBusy(true);
    try {
      const r = await store.addVisits(chosen, { occurredAt: when });
      setSaid(r.already
        ? `Logged ${r.logged}. ${r.already} already had that day.`
        : `Logged ${r.logged}.`);
      stop();
      setData(await store.people({ tag }));
    } catch (e) {
      setSaid(text(e));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    let alive = true;
    store.people({ tag })
      .then((next) => { if (alive) { setData(next); setError(null); } })
      .catch((e) => { if (alive) setError(text(e)); });
    return () => { alive = false; };
  }, [tag]);

  useEffect(() => {
    try { sessionStorage.setItem(PEOPLE_VIEW_KEY, params.toString()); } catch { /* private mode */ }
  }, [params]);

  /**
   * Your tags, and nothing else. There used to be a row of circles in front of
   * them, five groups the app invented; sixty of sixty-one people landed in
   * "other", which is what an invented group looks like. The only groups now
   * are the ones you named yourself.
   */
  const setTag = (next: string | null) => {
    router.replace(next ? `/people?tag=${encodeURIComponent(next)}` : "/people", { scroll: false });
  };

  const filtered = !!tag;
  const stamp = data
    ? [
        filtered ? `${data.people.length} of ${data.counts.people}` : `${data.counts.people} ${data.counts.people === 1 ? "person" : "people"}`,
        `${data.counts.facts} ${data.counts.facts === 1 ? "fact" : "facts"}`,
        ...(data.counts.places ? [`${data.counts.places} ${data.counts.places === 1 ? "place" : "places"}`] : []),
      ].join(" / ")
    : " ";

  return (
    <>
      <h1 className="h1 fade" style={{ marginTop: 14 }}>Your people</h1>
      <p className="stamp anim" style={style(1, { marginTop: 10 })}>
        {stamp}
        {!picking && (data?.people.length ?? 0) > 0 && (
          <button className="act" style={{ marginLeft: 16 }} onClick={() => { setSaid(null); setPicking(true); }}>Saw them</button>
        )}
      </p>
      {said && !picking && <p className="stamp anim" style={style(1, { color: "var(--gold)" })}>{said}</p>}

      {(data?.tags.length ?? 0) > 0 && (
        <div className="tabs tag-row anim" style={style(2, { marginTop: 20 })} role="group" aria-label="Narrow by tag">
          <button type="button" aria-pressed={!tag} onClick={() => setTag(null)}>Everyone</button>
          {(data?.tags ?? []).map((t) => (
            <button key={t} type="button" aria-pressed={tag?.toLowerCase() === t.toLowerCase()} onClick={() => setTag(t)}>{t}</button>
          ))}
        </div>
      )}

      {picking && (
        <div className="picking anim" style={style(3)}>
          <span className="stamp">{chosen.length} selected</span>
          <label className="ie-when" style={{ margin: 0 }}>
            On
            <input type="date" value={day} max={toDateInput(new Date().toISOString())} onChange={(e) => setDay(e.target.value)} />
          </label>
          <span className="meta">
            {data && data.people.length > 0 && (
              <button className="act" onClick={() => setChosen((c) => [...new Set([...c, ...data.people.map((q) => q.id)])])}>
                All {data.people.length}
              </button>
            )}
            {chosen.length > 0 && <button className="act" onClick={() => setChosen([])}>None</button>}
            <button className="act gold" onClick={save} disabled={busy || !chosen.length || !day}>
              {busy ? "Saving" : "Saw them"}
            </button>
            <button className="act" onClick={stop} disabled={busy}>Cancel</button>
          </span>
          {said && <span className="stamp" style={{ color: "var(--gold)" }}>{said}</span>}
        </div>
      )}

      {error && <p className="empty">Couldn&rsquo;t load your people.<br /><em>{error}</em></p>}
      {data && !error && data.people.length === 0 && (
        <p className="empty">
          {data.counts.people === 0 ? <>No one yet.<br /><em>Record a note and they will be here.</em></> : <>Nobody has that tag.<br /><em>Try Everyone, or another one.</em></>}
        </p>
      )}
      {data && data.people.length > 0 && (
        <div className="list" style={{ marginTop: 4 }}>
          {data.people.map((p, i) => (
            <PersonRow
              key={p.id} p={p} index={i + 4}
              pick={picking ? { on: on.has(p.id), toggle: () => toggle(p.id) } : undefined}
            />
          ))}
        </div>
      )}
    </>
  );
}
