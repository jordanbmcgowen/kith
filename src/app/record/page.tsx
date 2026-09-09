import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { Shell } from "@/components/Shell";
import { CaptureScreen } from "@/components/CaptureScreen";

/** Record. Signing out used to hang off the bottom of this screen; it lives on You now. */
export default async function RecordPage() {
  const session = await auth();
  if (!session?.user) redirect("/");

  return (
    <Shell>
      <CaptureScreen />
    </Shell>
  );
}
