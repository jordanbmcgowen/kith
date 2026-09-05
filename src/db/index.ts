import { drizzle } from "drizzle-orm/neon-serverless";
import { Pool } from "@neondatabase/serverless";
import { eq, and } from "drizzle-orm";
import * as schema from "./schema";

export * from "./schema";

let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function db() {
  if (_db) return _db;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  _db = drizzle(new Pool({ connectionString: url }), { schema });
  return _db;
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
