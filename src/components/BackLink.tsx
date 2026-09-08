import Link from "next/link";

/** The way back from a detail screen: a chevron and where it goes, in the stamp style. */
export function BackLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="back stamp anim">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14.5 5 8 12l6.5 7" /></svg>
      {children}
    </Link>
  );
}
