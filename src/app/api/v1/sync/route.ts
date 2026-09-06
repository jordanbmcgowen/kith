import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { route } from "@/lib/api";
import { syncContacts } from "@/lib/google/contacts";
import { syncCalendar } from "@/lib/google/calendar";

/** POST /api/v1/sync — run on first sign-in, then nightly from a Worker cron. */
export const POST = route(async () => {
  const userId = await requireUser();
  const [contacts, calendar] = await Promise.allSettled([
    syncContacts(userId),
    syncCalendar(userId),
  ]);
  return NextResponse.json({
    contacts: contacts.status === "fulfilled" ? contacts.value : { error: String(contacts.reason) },
    calendar: calendar.status === "fulfilled" ? calendar.value : { error: String(calendar.reason) },
  });
});
