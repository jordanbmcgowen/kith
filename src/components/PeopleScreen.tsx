"use client";
import { useEffect, useState, type CSSProperties } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { store, type PeopleList } from "@/lib/store";
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
      <p className="stamp anim" style={style(1, { marginTop: 10 })}>{stamp}</p>

      {(data?.tags.length ?? 0) > 0 && (
        <div className="tabs tag-row anim" style={style(2, { marginTop: 20 })} role="group" aria-label="Narrow by tag">
          <button type="button" aria-pressed={!tag} onClick={() => setTag(null)}>Everyone</button>
          {(data?.tags ?? []).map((t) => (
            <button key={t} type="button" aria-pressed={tag?.toLowerCase() === t.toLowerCase()} onClick={() => setTag(t)}>{t}</button>
          ))}
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
          {data.people.map((p, i) => <PersonRow key={p.id} p={p} index={i + 4} />)}
        </div>
      )}
    </>
  );
}
