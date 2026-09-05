import { googleAccessToken } from "@/lib/auth";
import { db, calendarEvents, syncState } from "@/db";
import { and, eq } from "drizzle-orm";

/**
 * Pulls recent and upcoming events with their attendees. Two jobs:
 *   - Attendee emails match to people, which is how a work circle populates
 *     itself without any manual entry.
 *   - A finished meeting with attendees becomes a post-meeting nudge:
 *     "You just met with Marcus. Anything to remember?"
 */
export async function syncCalendar(userId: string, opts?: { daysBack?: number; daysForward?: number }) {
  const token = await googleAccessToken(userId);
  const daysBack = opts?.daysBack ?? 14;
  const daysForward = opts?.daysForward ?? 14;

  const params = new URLSearchParams({
    timeMin: new Date(Date.now() - daysBack * 86_400_000).toISOString(),
    timeMax: new Date(Date.now() + daysForward * 86_400_000).toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "250",
  });

  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) throw new Error(`Calendar sync failed: ${await res.text()}`);

  const json = (await res.json()) as GoogleEvents;
  let n = 0;

  for (const e of json.items ?? []) {
    const start = e.start?.dateTime ?? e.start?.date;
    if (!start) continue;

    // Solo blocks and focus time are noise. Skip anything with no one else on it.
    const attendees = (e.attendees ?? [])
      .filter((a) => !a.self && !a.resource && a.email)
      .map((a) => ({ email: a.email!, name: a.displayName }));
    if (!attendees.length) continue;

    await db().insert(calendarEvents).values({
      userId,
      googleEventId: e.id,
      title: e.summary ?? null,
      startsAt: new Date(start),
      endsAt: e.end?.dateTime ? new Date(e.end.dateTime) : null,
      location: e.location ?? null,
      attendees,
    }).onConflictDoUpdate({
      target: [calendarEvents.userId, calendarEvents.googleEventId],
      set: { title: e.summary ?? null, startsAt: new Date(start), attendees },
    });
    n++;
  }

  await db().insert(syncState)
    .values({ userId, source: "google_calendar", lastRunAt: new Date() })
    .onConflictDoUpdate({
      target: [syncState.userId, syncState.source],
      set: { lastRunAt: new Date(), lastError: null },
    });

  return { events: n };
}

type GoogleEvents = {
  items?: {
    id: string;
    summary?: string;
    location?: string;
    start?: { dateTime?: string; date?: string };
    end?: { dateTime?: string };
    attendees?: { email?: string; displayName?: string; self?: boolean; resource?: boolean }[];
  }[];
};
