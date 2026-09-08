import type { ReactNode } from "react";
import { store } from "@/lib/store";
import { ReviewCount } from "./ReviewCount";
import { TabBar } from "./TabBar";

/**
 * The frame every signed-in screen sits in: a slim top strip, the view, and
 * the tab bar. The strip carries the review count while anything is
 * waiting. The DEMO flag is the one thing that must never be missing while
 * the demo store is active.
 */
export function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="app">
      <div className="bar">
        <span>Kith</span>
        <span className="bar-r">
          {store.isDemo && <span className="demo-flag">Demo</span>}
          <ReviewCount />
        </span>
      </div>
      <main className="view">{children}</main>
      <TabBar />
    </div>
  );
}
