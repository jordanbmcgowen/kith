import { redirect } from "next/navigation";
import type { CSSProperties } from "react";
import { auth, signIn } from "@/lib/auth";

/**
 * Signed out: the front door. Signed in: straight to the capture screen. When
 * the Today screen exists (step 4) it takes this route and capture moves
 * behind the mic in the tab bar; nothing else has to change.
 */
export default async function Home() {
  const session = await auth();
  if (session?.user) redirect("/record");

  return (
    <main className="signin">
      <div className="wordmark fade">Kith<em>.</em></div>
      <p className="lede anim" style={{ "--i": 1, fontSize: 15 } as CSSProperties}>
        A private memory system for the people in your life. Talk for twenty
        seconds after you leave a room. Kith files what you said against the
        right person and hands it back when you need it.
      </p>
      <form
        className="anim"
        style={{ "--i": 2 } as CSSProperties}
        action={async () => {
          "use server";
          await signIn("google", { redirectTo: "/record" });
        }}
      >
        <button type="submit" className="btn ghost">Continue with Google</button>
      </form>
      <p className="stamp anim" style={{ "--i": 3 } as CSSProperties}>Yours alone. Nothing is shared, nothing trains a model.</p>
    </main>
  );
}
