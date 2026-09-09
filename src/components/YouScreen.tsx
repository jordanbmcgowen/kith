"use client";
import { useEffect, useState, type ReactNode, type CSSProperties } from "react";
import { store, type Me } from "@/lib/store";
import { CIRCLES, initials } from "@/lib/circles";
import { fmtDay } from "@/lib/format";

const style = (i: number, extra?: CSSProperties) => ({ "--i": Math.min(i, 14), ...extra }) as CSSProperties;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * You. Not the prototype's four toggles: three of those four switched things
 * that do not exist yet, and a screen of dead switches is worse than no screen.
 * What is here is what is real.
 *
 * The cadences matter most. They decide who Today calls slipping and how
 * warmth orders every list, and until now they lived in the database with
 * nowhere to see them. A judgment you cannot see is not one you can argue
 * with, so they are on screen and editable.
 */
export function YouScreen({ signOut }: { signOut: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, number> | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    store.me()
      .then((next) => { if (alive) { setMe(next); setError(null); } })
      .catch((e) => { if (alive) setError(message(e)); });
    return () => { alive = false; };
  }, []);

  if (error) return <p className="empty">Couldn&rsquo;t load your account.<br /><em>{error}</em></p>;

  const cadence = draft ?? me?.cadence ?? {};
  const changed = !!draft && !!me && CIRCLES.some((c) => draft[c.key] !== me.cadence[c.key]);

  const save = async () => {
    if (!draft || !me) return;
    setBusy(true);
    try {
      await store.updateMe({ cadence: draft });
      setMe(await store.me());
      setDraft(null);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  const c = me?.counts;

  return (
    <>
      <h1 className="h1 fade" style={{ marginTop: 14 }}>Your account</h1>

      <div className="row anim" style={style(1, { marginTop: 18, borderBottom: "1px solid var(--rule-2)" })}>
        <span className="mark" style={{ "--c": "var(--gold)" } as CSSProperties}>{initials(me?.name ?? "?")}</span>
        <span className="body">
          <span className="nm">{me?.name ?? " "}</span>
          <span className="role">{me?.email ?? " "}</span>
          <span className="meta">
            <span>Signed in with Google</span>
            {me && <span>Since {fmtDay(me.since)}</span>}
            {signOut}
          </span>
        </span>
      </div>

      <section className="block">
        <div className="label">Keeping up</div>
        <p className="lede" style={{ padding: "6px 0 4px" }}>
          How often you want to see each circle. It is what Today means by slipping,
          and what the warmth meter reads against. Nobody is told, and nothing is scored.
        </p>
        <div className="list">
          {CIRCLES.map((circle, i) => (
            <label key={circle.key} className="cad anim" style={style(i + 2)}>
              <span className="sq" style={{ "--c": circle.color } as CSSProperties} />
              <span className="cad-name">{circle.label}</span>
              <input
                type="number" min={1} max={365} inputMode="numeric"
                value={cadence[circle.key] ?? ""}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  setDraft({ ...cadence, [circle.key]: Number.isFinite(n) ? n : 0 });
                }}
              />
              <span className="cad-unit">days</span>
            </label>
          ))}
        </div>
        {changed && (
          <div className="meta" style={{ marginTop: 16, gap: 18 }}>
            <button className="act gold" onClick={save} disabled={busy}>{busy ? "Saving" : "Save"}</button>
            <button className="act" onClick={() => setDraft(null)} disabled={busy}>Cancel</button>
            <span>Rewrites every warmth meter</span>
          </div>
        )}
      </section>

      {me && (me.connected.calendar || me.connected.contacts) && (
        <section className="block">
          <div className="label">Connected</div>
          <div className="list">
            {me.connected.contacts && <Line title="Google Contacts" note="Kith may read your contacts to seed people." />}
            {me.connected.calendar && <Line title="Google Calendar" note="Kith may read who you met with." />}
          </div>
        </section>
      )}

      {c && (
        <section className="block">
          <div className="label">What Kith holds</div>
          <p className="stamp" style={{ padding: "8px 0 2px", lineHeight: 2 }}>
            {c.people} people / {c.facts} facts / {c.visits} visits / {c.notes} notes
            {c.threads > 0 && <> / {c.threads} open</>}
            {c.loose > 0 && <> / {c.loose} loose</>}
            {c.places > 0 && <> / {c.places} places</>}
          </p>
          <a className="act gold" href="/api/v1/me/export" download style={{ display: "inline-block", marginTop: 12 }}>
            Export everything as JSON
          </a>
        </section>
      )}

      <section className="block">
        <div className="label">Your data</div>
        <div className="list">
          <div className="fact anim" style={style(10)}>
            <span className="i">01</span>
            <span>Everything here is yours alone. Nothing is shared with the people you record.</span>
          </div>
          <div className="fact anim" style={style(11)}>
            <span className="i">02</span>
            <span>A note is transcribed by OpenAI and read by Anthropic, then it lives only in your database. Nothing else sees it.</span>
          </div>
          <div className="fact anim" style={style(12)}>
            <span className="i">03</span>
            <span>
              {me?.connected.calendar || me?.connected.contacts
                ? "Kith reads the Google data you connected above, and nothing else."
                : "Kith is not reading your calendar or your contacts. It knows only what you have told it."}
            </span>
          </div>
        </div>
      </section>
    </>
  );
}

function Line({ title, note }: { title: string; note: string }) {
  return (
    <div className="row">
      <span className="stamp" style={{ flex: "0 0 26px", color: "var(--verdigris)", paddingTop: 3 }}>On</span>
      <span className="body">
        <span className="nm" style={{ fontSize: 14 }}>{title}</span>
        <span className="role">{note}</span>
      </span>
    </div>
  );
}
