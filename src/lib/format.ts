/**
 * Dates as the people screens say them. Everything countable is set in DM
 * Mono on screen, so these stay short. Runs in the browser, in the phone's
 * own time zone.
 */

const DAY = 86_400_000;

/** Whole days since an ISO timestamp, never negative. Null without one. */
export function daysSince(iso: string | null | undefined, now = Date.now()): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now - t) / DAY));
}

/** "Aug 28", or "Aug 28, 2025" when it was not this year. */
export function fmtDay(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const thisYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString([], { month: "short", day: "numeric", ...(thisYear ? {} : { year: "numeric" }) });
}

/** "today", "yesterday", "8d ago". */
export function fmtAgo(days: number): string {
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return `${days}d ago`;
}

/**
 * What a thread's due date says. Late means a whole day has passed, and
 * late is the one thing coral is for.
 */
export function fmtDue(dueAt: string | null, now = Date.now()): { text: string; late: boolean } {
  if (!dueAt) return { text: "No date", late: false };
  const t = new Date(dueAt).getTime();
  if (Number.isNaN(t)) return { text: "No date", late: false };
  const startOf = (ms: number) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const diff = Math.round((startOf(t) - startOf(now)) / DAY);
  if (diff < 0) return { text: `Overdue ${-diff === 1 ? "1 day" : `${-diff} days`}`, late: true };
  if (diff === 0) return { text: "Due today", late: false };
  if (diff === 1) return { text: "Due tomorrow", late: false };
  return { text: `Due ${fmtDay(dueAt)}`, late: false };
}

/**
 * How a visit happened, in a word. In person is the default and says
 * nothing; the place says it. The model writes channels its own way
 * ("in-person", "phone call"), so this reads loosely.
 */
export function fmtChannel(channel: string): string | null {
  const c = channel.trim().toLowerCase().replace(/[\s-]+/g, "_");
  switch (c) {
    case "": case "in_person": case "person": return null;
    case "call": case "phone": case "phone_call": return "Phone";
    case "text": case "sms": case "message": case "imessage": case "texted": return "Text";
    case "email": return "Email";
    case "meeting": return "Meeting";
    case "video": case "zoom": case "facetime": case "video_call": return "Video";
    default: return c.replace(/_/g, " ");
  }
}

/** The first line or so of a note, for a history entry. */
export function excerpt(text: string, max = 120): string {
  const s = text.replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

/**
 * An ISO timestamp as the yyyy-mm-dd a date input wants, read in the phone's
 * own zone so a late-evening note does not show tomorrow's date.
 */
export function toDateInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * A date input's yyyy-mm-dd back to a timestamp. Local midday, not midnight,
 * so it lands on the same calendar day whatever the zone.
 */
export function fromDateInput(v: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v.trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** "Marcus Ellery" -> "ME", "Dre" -> "D". Squared, like a card index. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.slice(0, 2).map((w) => w[0]).join("");
  return (letters || "?").toUpperCase();
}
