import { googleAccessToken } from "@/lib/auth";
import { db, people, syncState } from "@/db";
import { and, eq } from "drizzle-orm";

/**
 * Seeds the People list from Google Contacts so the app is never empty on day
 * one. Uses incremental sync tokens: the first run is a full pull, every run
 * after that only sees what changed.
 *
 * Contacts are seeded as skeletons. Kith does not pretend a Google contact is
 * a relationship — it is a name waiting for a memory.
 */
export async function syncContacts(userId: string) {
  const token = await googleAccessToken(userId);
  const [state] = await db().select().from(syncState)
    .where(and(eq(syncState.userId, userId), eq(syncState.source, "google_contacts")));

  const params = new URLSearchParams({
    personFields: "names,emailAddresses,organizations,birthdays,photos,nicknames",
    pageSize: "500",
    requestSyncToken: "true",
  });
  if (state?.syncToken) params.set("syncToken", state.syncToken);

  let pageToken: string | undefined;
  let nextSyncToken: string | undefined;
  let created = 0;

  do {
    if (pageToken) params.set("pageToken", pageToken);
    const res = await fetch(
      `https://people.googleapis.com/v1/people/me/connections?${params}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    // 410 means the sync token expired. Drop it and do a full resync.
    if (res.status === 410) {
      await db().update(syncState).set({ syncToken: null })
        .where(and(eq(syncState.userId, userId), eq(syncState.source, "google_contacts")));
      return syncContacts(userId);
    }
    if (!res.ok) throw new Error(`Contacts sync failed: ${await res.text()}`);

    const json = (await res.json()) as GoogleConnections;
    for (const c of json.connections ?? []) {
      const name = c.names?.[0];
      if (!name?.displayName) continue;

      await db().insert(people).values({
        userId,
        googleContactId: c.resourceName,
        displayName: name.displayName,
        firstName: name.givenName ?? null,
        lastName: name.familyName ?? null,
        goesBy: c.nicknames?.[0]?.value ?? null,
        company: c.organizations?.[0]?.name ?? null,
        title: c.organizations?.[0]?.title ?? null,
        avatarUrl: c.photos?.find((p) => !p.default)?.url ?? null,
        birthday: formatBirthday(c.birthdays?.[0]?.date),
        circle: "other",
      }).onConflictDoUpdate({
        target: [people.userId, people.googleContactId],
        // Only refresh fields Google owns. Never overwrite what the user or
        // an extraction has written.
        set: { displayName: name.displayName, updatedAt: new Date() },
      });
      created++;
    }
    pageToken = json.nextPageToken;
    nextSyncToken = json.nextSyncToken ?? nextSyncToken;
  } while (pageToken);

  await db().insert(syncState)
    .values({ userId, source: "google_contacts", syncToken: nextSyncToken ?? null, lastRunAt: new Date() })
    .onConflictDoUpdate({
      target: [syncState.userId, syncState.source],
      set: { syncToken: nextSyncToken ?? null, lastRunAt: new Date(), lastError: null },
    });

  return { touched: created };
}

function formatBirthday(d?: { year?: number; month?: number; day?: number }) {
  if (!d?.month || !d.day) return null;
  const mm = String(d.month).padStart(2, "0");
  const dd = String(d.day).padStart(2, "0");
  return d.year ? `${d.year}-${mm}-${dd}` : `--${mm}-${dd}`;
}

type GoogleConnections = {
  connections?: {
    resourceName: string;
    names?: { displayName?: string; givenName?: string; familyName?: string }[];
    nicknames?: { value: string }[];
    organizations?: { name?: string; title?: string }[];
    photos?: { url: string; default?: boolean }[];
    birthdays?: { date?: { year?: number; month?: number; day?: number } }[];
  }[];
  nextPageToken?: string;
  nextSyncToken?: string;
};
