import { NextResponse } from "next/server";

/**
 * Wraps a route handler so the two failure modes a phone actually needs to
 * tell apart come back as different status codes.
 *
 *   signed out   -> 401 with a plain message
 *   anything else -> 500, detail logged server-side and never sent to the client
 *
 * Without this, `requireUser()` throwing surfaces as an opaque 500, and "you
 * are logged out" is indistinguishable from "the server is on fire".
 */
export function route<Ctx>(fn: (req: Request, ctx: Ctx) => Promise<Response>) {
  return async (req: Request, ctx: Ctx): Promise<Response> => {
    try {
      return await fn(req, ctx);
    } catch (err: any) {
      if (err?.status === 401) {
        return NextResponse.json({ error: "Sign in to continue" }, { status: 401 });
      }
      console.error("api error", req.method, new URL(req.url).pathname, err);
      return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
    }
  };
}
