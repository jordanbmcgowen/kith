import { redirect } from "next/navigation";
import { auth, signOut } from "@/lib/auth";
import { Shell } from "@/components/Shell";
import { CaptureScreen } from "@/components/CaptureScreen";

export default async function RecordPage() {
  const session = await auth();
  if (!session?.user) redirect("/");

  return (
    <Shell>
      <CaptureScreen />
      <footer className="foot">
        <span>{session.user.email}</span>
        <form
          action={async () => {
            "use server";
            await signOut({ redirectTo: "/" });
          }}
        >
          <button type="submit">Sign out</button>
        </form>
      </footer>
    </Shell>
  );
}
