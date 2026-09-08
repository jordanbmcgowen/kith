"use client";
import { useEffect, useState, type CSSProperties } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { store, type PeopleList, type Circle } from "@/lib/store";
import { CIRCLES } from "@/lib/circles";
import { PersonRow } from "./PersonRow";

const style = (i: number, extra?: CSSProperties) => ({ "--i": i, ...extra }) as CSSProperties;
const text = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Where the person page's back link returns to. Written here, read there. */
export const PEOPLE_VIEW_KEY = "kith:people";

/**
 * Step 4 of the build order: the people list. Underline filters for the
 * circle and, on a second row, for the tags you have given people. Both
 * live in the URL, so back brings the same view up again. Location never
 * narrows this list; when places exist it will only reorder it.
 */
export function PeopleScreen() {
  const params = useSearchParams();
  const router = useRouter();
  const circleParam = params.get("circle");
  const circle: Circle | "all" = CIRCLES.some((c) => c.key === circleParam) ? (circleParam as Circle) : "all";
  const tag = params.get("tag")?.trim() || null;

  const [data, setData] = useState<PeopleList | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    store.people({ circle, tag })
      .then((next) => { if (alive) { setData(next); setError(null); } })
      .catch((e) => { if (alive) setError(text(e)); });
    return () => { alive = false; };
  }, [circle, tag]);

  useEffect(() => {
    try { sessionStorage.setItem(PEOPLE_VIEW_KEY, params.toString()); } catch { /* private mode */ }
  }, [params]);

  const setFilter = (next: { circle?: Circle | "all"; tag?: string | null }) => {
    const q = new URLSearchParams(params.toString());
    if (next.circle !== undefined) { if (next.circle === "all") q.delete("circle"); else q.set("circle", next.circle); }
    if (next.tag !== undefined) { if (next.tag) q.set("tag", next.tag); else q.delete("tag"); }
    const s = q.toString();
    router.replace(`/people${s ? `?${s}` : ""}`, { scroll: false });
  };

  const filtered = circle !== "all" || !!tag;
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
      <p className="stamp anim" style={style(1, { marginTop: 10 })}>{stamp}</p>

      <div className="tabs circle-row anim" style={style(2, { marginTop: 20 })} role="group" aria-label="Circle">
        <button type="button" aria-pressed={circle === "all"} onClick={() => setFilter({ circle: "all" })}>Everyone</button>
        {CIRCLES.map((c) => (
          <button key={c.key} type="button" aria-pressed={circle === c.key} onClick={() => setFilter({ circle: c.key })}>{c.label}</button>
        ))}
      </div>
      {data && data.tags.length > 0 && (
        <div className="tabs sub anim" style={style(3)} role="group" aria-label="Tag">
          <button type="button" aria-pressed={!tag} onClick={() => setFilter({ tag: null })}>Any tag</button>
          {data.tags.map((t) => (
            <button key={t} type="button" aria-pressed={tag?.toLowerCase() === t.toLowerCase()} onClick={() => setFilter({ tag: t })}>{t}</button>
          ))}
        </div>
      )}

      {error && <p className="empty">Couldn&rsquo;t load your people.<br /><em>{error}</em></p>}
      {data && !error && data.people.length === 0 && (
        <p className="empty">
          {data.counts.people === 0 ? <>No one yet.<br /><em>Record a note and they will be here.</em></> : <>Nobody matches that.<br /><em>Try Everyone, or another tag.</em></>}
        </p>
      )}
      {data && data.people.length > 0 && (
        <div className="list" style={{ marginTop: 4 }}>
          {data.people.map((p, i) => <PersonRow key={p.id} p={p} index={i + 4} />)}
        </div>
      )}
    </>
  );
}
