import Link from "next/link";
import type { CSSProperties } from "react";
import type { PersonRow as Row } from "@/lib/store";
import { circleColor, circleLabel, initials } from "@/lib/circles";
import { daysSince, fmtAgo, fmtDay } from "@/lib/format";

/** How to say their name, if the app knows: a pronunciation, or what they go by. */
export const sayOf = (p: { pronunciation: string | null; goesBy: string | null }) =>
  p.pronunciation ?? (p.goesBy ? `goes by ${p.goesBy}` : null);

/**
 * One person in a list, from the prototype: the initials square in their
 * circle's color, name, role, the warmth meter, then the circle, their tags,
 * and when you last saw them. The whole row opens their page.
 */
export function PersonRow({ p, index, big }: { p: Row; index: number; big?: boolean }) {
  const c = circleColor(p.circle);
  const say = sayOf(p);
  const days = daysSince(p.lastInteractionAt);

  return (
    <Link href={`/people/${p.id}`} className="row anim" style={{ "--i": Math.min(index, 12) } as CSSProperties}>
      <span className="mark" style={{ "--c": c } as CSSProperties}>{initials(p.displayName)}</span>
      <span className="body">
        <span className={`nm${big ? " big" : ""}`}>{p.displayName}</span>
        {say && <span className="say">{say}</span>}
        {p.role && <span className="role">{p.role}</span>}
        <span className="meter" style={{ "--c": c, "--v": p.warmth } as CSSProperties}><i /></span>
        <span className="meta">
          <span className="circ"><span className="sq" style={{ "--c": c } as CSSProperties} />{circleLabel(p.circle)}</span>
          {p.tags.map((t) => <span key={t} className="tg">{t}</span>)}
          {p.lastInteractionAt && days != null && (
            <>
              <span>{fmtDay(p.lastInteractionAt)}</span>
              <span>{fmtAgo(days)}</span>
            </>
          )}
        </span>
      </span>
    </Link>
  );
}
