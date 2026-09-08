import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { Shell } from "@/components/Shell";
import { PersonScreen } from "@/components/PersonScreen";

/** One person: what to remember, what you owe, what has happened, where. */
export default async function PersonPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) redirect("/");
  const { id } = await params;

  return (
    <Shell>
      <PersonScreen id={id} />
    </Shell>
  );
}
