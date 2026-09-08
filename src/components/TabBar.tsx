"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * The tab bar from the prototype: Today, People, the mic, Find, You. People,
 * the mic and Find are live. Today and You are dimmed and inert until their
 * steps; a tab that goes nowhere is better than a screen that says so.
 * The mic is the one circle in the bar because a circle means "press me".
 */
export function TabBar() {
  const path = usePathname() ?? "";
  const current = path === "/people" || path.startsWith("/people/") ? "people"
    : path === "/find" ? "find"
    : null;

  return (
    <nav className="nav" aria-label="Kith">
      <Soon label="Today">{HOME}</Soon>
      <Link href="/people" className="nv" aria-current={current === "people" ? "true" : undefined}>
        {USERS}<span className="nl">People</span>
      </Link>
      <Link href="/record" className="nv" aria-label="Record a note">
        <span className="nmic">{MIC}</span>
      </Link>
      <Link href="/find" className="nv" aria-current={current === "find" ? "true" : undefined}>
        {FIND}<span className="nl">Find</span>
      </Link>
      <Soon label="You">{YOU}</Soon>
    </nav>
  );
}

function Soon({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span className="nv soon" aria-disabled="true" title={`${label} is not built yet`}>
      {children}<span className="nl">{label}</span>
    </span>
  );
}

const HOME = (
  <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" aria-hidden="true">
    <path d="M3.5 10.2 12 3.4l8.5 6.8V20a.8.8 0 0 1-.8.8h-4.9v-6.2H9.2v6.2H4.3a.8.8 0 0 1-.8-.8Z" />
  </svg>
);
const USERS = (
  <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
    <circle cx="9" cy="8" r="3.3" /><path d="M2.6 20a6.4 6.4 0 0 1 12.8 0" /><path d="M16.2 5.5a3.3 3.3 0 0 1 0 6.4" /><path d="M17.6 14.5A6.4 6.4 0 0 1 21.4 20" />
  </svg>
);
const MIC = (
  <svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
    <rect x="9.2" y="2.6" width="5.6" height="10.8" rx="2.8" /><path d="M5.6 11a6.4 6.4 0 0 0 12.8 0" /><path d="M12 17.4V21" />
  </svg>
);
const FIND = (
  <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
    <circle cx="11" cy="11" r="6.4" /><path d="m16 16 4.6 4.6" />
  </svg>
);
const YOU = (
  <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
    <circle cx="12" cy="8" r="3.5" /><path d="M4.6 20.4a7.4 7.4 0 0 1 14.8 0" />
  </svg>
);
