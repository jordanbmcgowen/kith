import Link from "next/link";
import type { CSSProperties } from "react";
import type { PersonRow as Row } from "@/lib/store";
import { daysSince, fmtAgo, fmtDay, initials } from "@/lib/format";

/** How to say their name, if the app knows: a pronunciation, or what they go by. */
export const sayOf = (p: { pronunciation: string | null; goesBy: string | null }) =>
  p.pronunciation ?? (p.goesBy ? `goes by ${p.goesBy}` : null);

/**
 * One person in a list: the initials square, name, role, the warmth meter,
 * then their tags and when you last saw them. The whole row opens their page.
 *
 * The square used to be coloured by circle. Circles are gone, so it is one
 * colour for everyone: the app has no groups of its own to signal.
 */
export function PersonRow({ p, index, big, pick }: {
  p: Row;
  index: number;
  big?: boolean;
  /** In select mode the row stops being a link and becomes a choice. */
  pick?: { on: boolean; toggle: () => void };
}) {
  const say = sayOf(p);
  const days = daysSince(p.lastInteractionAt);
  const style = { "--i": Math.min(index, 12) } as CSSProperties;

  const inside = (
    <>
      <span className="mark" style={pick?.on ? ({ "--c": "var(--gold)" } as CSSProperties) : undefined}>
        {initials(p.displayName)}
      </span>
      <span className="body">
        <span className={`nm${big ? " big" : ""}`}>{p.displayName}</span>
        {say && <span className="say">{say}</span>}
        {p.role && <span className="role">{p.role}</span>}
        <span className="meter" style={{ "--v": p.warmth } as CSSProperties}><i /></span>
        <span className="meta">
          {p.tags.map((t) => <span key={t} className="tg">{t}</span>)}
          {p.lastInteractionAt && days != null && (
            <>
              <span>{fmtDay(p.lastInteractionAt)}</span>
              <span>{fmtAgo(days)}</span>
            </>
          )}
        </span>
      </span>
    </>
  );

  // A button, not a link, while choosing: the row means "I saw them" then,
  // and a row that navigates under your thumb loses the whole selection.
  if (pick) {
    return (
      <button
        type="button" className={`row anim pickable${pick.on ? " on" : ""}`} style={style}
        aria-pressed={pick.on} onClick={pick.toggle}
      >{inside}</button>
    );
  }
  return <Link href={`/people/${p.id}`} className="row anim" style={style}>{inside}</Link>;
}
