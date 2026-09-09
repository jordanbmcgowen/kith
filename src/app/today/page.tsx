import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { Shell } from "@/components/Shell";
import { TodayScreen } from "@/components/TodayScreen";

/** Today. What Kith has to say the moment you open it, and nothing more. */
export default async function TodayPage() {
  const session = await auth();
  if (!session?.user) redirect("/");

  return (
    <Shell>
      <TodayScreen />
    </Shell>
  );
}
