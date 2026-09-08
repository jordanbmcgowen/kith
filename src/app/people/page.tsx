import { Suspense } from "react";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { Shell } from "@/components/Shell";
import { PeopleScreen } from "@/components/PeopleScreen";

/** Everyone you have told Kith about, by circle and by tag. */
export default async function PeoplePage() {
  const session = await auth();
  if (!session?.user) redirect("/");

  return (
    <Shell>
      <Suspense>
        <PeopleScreen />
      </Suspense>
    </Shell>
  );
}
