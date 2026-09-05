import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { db, users, accounts, sessions, verificationTokens } from "@/db";
import { eq, and } from "drizzle-orm";

/**
 * Scopes, in the order you should turn them on:
 *
 *   openid email profile        — no verification needed, ever.
 *   calendar.readonly           — SENSITIVE. 100-user cap until verified.
 *   contacts.readonly           — SENSITIVE. Same cap, same review.
 *
 * Sensitive-scope verification is a form plus a demo video, typically 3-5
 * business days. It does NOT require the CASA security assessment; that only
 * applies to restricted scopes such as Gmail. Ship with sign-in only, add the
 * other two when you are ready to record the video.
 */
export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/contacts.readonly",
].join(" ");

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: DrizzleAdapter(db(), {
    usersTable: users,
    accountsTable: accounts,
    sessionsTable: sessions,
    verificationTokensTable: verificationTokens,
  }),
  session: { strategy: "database" },
  providers: [
    Google({
      authorization: {
        params: {
          scope: GOOGLE_SCOPES,
          // Both are required to actually receive a refresh_token, which is
          // what background Calendar/Contacts sync depends on.
          access_type: "offline",
          prompt: "consent",
        },
      },
    }),
  ],
  callbacks: {
    session({ session, user }) {
      session.user.id = user.id;
      return session;
    },
  },
});

/** Every API route starts with this. No session, no data. */
export async function requireUser() {
  const session = await auth();
  if (!session?.user?.id) {
    throw Object.assign(new Error("Unauthorized"), { status: 401 });
  }
  return session.user.id as string;
}

/**
 * Google access tokens expire in an hour. This refreshes in place using the
 * stored refresh_token and hands back a token you can use right now.
 */
export async function googleAccessToken(userId: string): Promise<string> {
  const [acct] = await db()
    .select()
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.provider, "google")));

  if (!acct?.refresh_token) {
    throw new Error("No Google refresh token. User must reconnect Google.");
  }
  const stillValid = acct.expires_at && acct.expires_at * 1000 > Date.now() + 60_000;
  if (stillValid && acct.access_token) return acct.access_token;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.AUTH_GOOGLE_ID!,
      client_secret: process.env.AUTH_GOOGLE_SECRET!,
      grant_type: "refresh_token",
      refresh_token: acct.refresh_token,
    }),
  });
  if (!res.ok) throw new Error(`Google token refresh failed: ${await res.text()}`);
  const tok = (await res.json()) as { access_token: string; expires_in: number };

  await db()
    .update(accounts)
    .set({
      access_token: tok.access_token,
      expires_at: Math.floor(Date.now() / 1000) + tok.expires_in,
    })
    .where(and(eq(accounts.userId, userId), eq(accounts.provider, "google")));

  return tok.access_token;
}
