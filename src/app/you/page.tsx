import { redirect } from "next/navigation";
import { auth, signOut } from "@/lib/auth";
import { Shell } from "@/components/Shell";
import { YouScreen } from "@/components/YouScreen";

/** You. Your account, your cadences, and everything Kith is holding. */
export default async function YouPage() {
  const session = await auth();
  if (!session?.user) redirect("/");

  return (
    <Shell>
      <YouScreen
        signOut={
          <form
            action={async () => {
              "use server";
              await signOut({ redirectTo: "/" });
            }}
          >
            <button type="submit" className="act">Sign out</button>
          </form>
        }
      />
    </Shell>
  );
}
