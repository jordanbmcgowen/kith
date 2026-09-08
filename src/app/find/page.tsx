import { Suspense } from "react";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { Shell } from "@/components/Shell";
import { FindScreen } from "@/components/FindScreen";

/** Find. Names when you remember them, and what you said when you do not. */
export default async function FindPage() {
  const session = await auth();
  if (!session?.user) redirect("/");

  return (
    <Shell>
      <Suspense>
        <FindScreen />
      </Suspense>
    </Shell>
  );
}
