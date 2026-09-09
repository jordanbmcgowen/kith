"use client";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { store, type SearchResults, type Coords } from "@/lib/store";
import { fmtDay } from "@/lib/format";
import { PersonRow } from "./PersonRow";

const style = (i: number, extra?: CSSProperties) => ({ "--i": Math.min(i, 12), ...extra }) as CSSProperties;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Long enough that a word finishes, short enough that it feels like typing. */
const SETTLE_MS = 250;

/**
 * Step 5 of the build order: Find. One field, and under every result the line
 * that says why it matched. That line is the whole point: an answer you can
 * check is worth more than an answer that is merely right.
 *
 * The query lives in the URL, so tapping a result and coming back brings the
 * same search up again.
 */
export function FindScreen() {
  const params = useSearchParams();
  const router = useRouter();
  const q = (params.get("q") ?? "").trim();

  const [text, setText] = useState(q);
  const [data, setData] = useState<SearchResults | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The last query this screen put in the URL, so its own push does not come
  // back and overwrite what is being typed.
  const pushed = useRef(q);

  const ask = (next: string) => {
    pushed.current = next;
    setText(next);
    router.replace(next ? `/find?q=${encodeURIComponent(next)}` : "/find", { scroll: false });
  };

  // Someone else changed the URL: the back button, or a link.
  useEffect(() => {
    if (q === pushed.current) return;
    pushed.current = q;
    setText(q);
  }, [q]);

  // Typing settles into the URL.
  useEffect(() => {
    const next = text.trim();
    if (next === q) return;
    const t = setTimeout(() => {
      pushed.current = next;
      router.replace(next ? `/find?q=${encodeURIComponent(next)}` : "/find", { scroll: false });
    }, SETTLE_MS);
    return () => clearTimeout(t);
  }, [text, q, router]);

  // Where you are standing only ever reorders results: nobody is hidden by it,
  // and a refusal or a phone with no fix costs nothing. Asked once per visit
  // to the screen, not on every keystroke.
  const [here, setHere] = useState<Coords | null>(null);
  useEffect(() => {
    let alive = true;
    store.coords().then((c) => { if (alive && c) setHere(c); });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    let alive = true;
    setBusy(true);
    store.search(q, here)
      .then((next) => { if (alive) { setData(next); setError(null); } })
      .catch((e) => { if (alive) { setError(message(e)); setData(null); } })
      .finally(() => { if (alive) setBusy(false); });
    return () => { alive = false; };
  }, [q, here]);

  const results = q ? data?.results ?? [] : [];
  const hints = data?.hints ?? [];
  const settled = !busy && !!data;

  return (
    <>
      <h1 className="h1 fade" style={{ marginTop: 14 }}>Find <em>them.</em></h1>
      <p className="lede anim" style={style(1, { marginTop: 10 })}>
        Describe them the way you remember them. Names optional.
      </p>

      <div className="field anim" style={style(2, { marginTop: 20 })}>
        <span style={{ color: "var(--text-3)", display: "flex" }}>{FIND}</span>
        <input
          id="q"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="the guy at the golf thing who flies"
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="search"
          aria-label="Search your people"
        />
      </div>

      {data?.namesOnly && (
        <p className="why" style={{ color: "var(--text-3)" }}>
          Names, tags and roles only. The rest of search is not answering.
        </p>
      )}

      {!q && hints.length > 0 && (
        <div className="block">
          <div className="label">Try one</div>
          <div className="list">
            {hints.map((h, i) => (
              <button key={h} type="button" className="row anim" style={style(i + 3)} onClick={() => ask(h)}>
                <span className="body"><span className="recall"><em>&ldquo;{h}&rdquo;</em></span></span>
              </button>
            ))}
          </div>
        </div>
      )}

      {error && <p className="empty">Search is not answering.<br /><em>{error}</em></p>}

      {!error && q && results.length > 0 && (
        <div className="block">
          <div className="label">{results.length} match{results.length > 1 ? "es" : ""}</div>
          {results.map((r, i) => (
            <div key={r.person.id} className="hit anim" style={style(i + 3)}>
              <PersonRow p={r.person} index={i + 3} />
              <div className="why">{r.why}{r.at && ` / ${fmtDay(r.at)}`}</div>
            </div>
          ))}
        </div>
      )}

      {!error && q && settled && results.length === 0 && (
        <p className="empty anim" style={style(3)}>
          Nothing yet.<br /><em>Kith only knows what you have told it.</em>
        </p>
      )}
    </>
  );
}

const FIND = (
  <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
    <circle cx="11" cy="11" r="6.4" /><path d="m16 16 4.6 4.6" />
  </svg>
);
