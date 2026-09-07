import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { Shell } from "@/components/Shell";
import { ConfirmScreen } from "@/components/ConfirmScreen";

/** One note: what Kith heard, what it made of it, and the chance to fix it. */
export default async function NotePage({ params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) redirect("/");
  const { id } = await params;

  return (
    <Shell>
      <ConfirmScreen id={id} />
    </Shell>
  );
}
