"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { store } from "@/lib/store";

/**
 * "2 to review" in the status bar while any note is waiting for a look. Text,
 * not a badge; it links to the oldest one and is absent at zero. Refreshes
 * when the tab comes back and whenever the Recent list reloads.
 */
export function ReviewCount() {
  const [queue, setQueue] = useState<{ count: number; oldestId: string | null } | null>(null);

  useEffect(() => {
    let alive = true;
    // Mounting is cheap: this remounts on every navigation, and the store
    // holds the answer. The two refreshes below are the ones that matter, and
    // they ask again rather than take what is held.
    const load = (fresh = false) => { store.reviewQueue({ fresh }).then((q) => { if (alive) setQueue(q); }).catch(() => { /* the bar stays quiet */ }); };
    const again = () => load(true);
    const onVisible = () => { if (document.visibilityState === "visible") again(); };
    load();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("kith:captures", again);
    return () => {
      alive = false;
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("kith:captures", again);
    };
  }, []);

  if (!queue?.count || !queue.oldestId) return null;
  return <Link href={`/notes/${queue.oldestId}`} className="review">{queue.count} to review</Link>;
}
