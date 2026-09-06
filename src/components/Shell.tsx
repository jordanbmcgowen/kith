import type { ReactNode } from "react";
import { store } from "@/lib/store";

/**
 * The frame every signed-in screen sits in: a slim top strip and the view.
 * The tab bar arrives with the second screen. The DEMO flag is the one thing
 * that must never be missing while the demo store is active.
 */
export function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="app">
      <div className="bar">
        <span>Kith</span>
        {store.isDemo && <span className="demo-flag">Demo</span>}
      </div>
      <main className="view">{children}</main>
    </div>
  );
}
