import { drizzle } from "drizzle-orm/neon-http";
import { neon } from "@neondatabase/serverless";
import { eq, and } from "drizzle-orm";
import * as schema from "./schema";

export * from "./schema";

/**
 * A fresh client per call, on purpose. Do NOT cache this in a module-level
 * variable.
 *
 * Cloudflare reuses an isolate across requests, but an I/O object belongs to
 * the request that created it. A cached WebSocket Pool therefore works on the
 * first request an isolate serves and throws on every later one:
 *
 *   Cannot perform I/O on behalf of a different request. I/O objects ...
 *   created in the context of one request handler cannot be accessed from a
 *   different request's handler.
 *
 * which surfaces as an intermittent Cloudflare 1101. `neon()` here is the HTTP
 * driver: each query is an ordinary fetch, so there is no socket to leak
 * across requests and nothing to cache. Constructing it is cheap.
 *
 * The tradeoff is that the HTTP driver has no interactive transactions. If a
 * future change genuinely needs one, reach for the pooled WebSocket driver in
 * that one place and build it inside the request, never at module scope.
 */
export function db() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  return drizzle(neon(url), { schema });
}

/**
 * Every read of user content goes through this. It exists so that forgetting
 * a `userId` filter is a compile error rather than a data leak between
 * accounts, which is the single worst bug this app could ship.
 */
export function scoped(userId: string) {
  const d = db();
  const own = <T extends { userId: any }>(t: T) => eq(t.userId, userId);
  return {
    d,
    userId,
    own,
    /** Combine the tenant filter with any additional condition. */
    where: <T extends { userId: any }>(t: T, ...rest: any[]) => and(own(t), ...rest),
  };
}
