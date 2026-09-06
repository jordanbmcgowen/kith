"use client";
import { useEffect, useState } from "react";
import { store, type CaptureSummary, type CaptureStatus } from "@/lib/store";

/** Statuses that are still moving. While any row is in one, the list polls. */
const ACTIVE = new Set<CaptureStatus>(["uploaded", "transcribing", "extracting"]);
const POLL_MS = 3000;

const LABEL: Record<CaptureStatus, string> = {
  uploaded: "Uploaded",
  transcribing: "Transcribing",
  extracting: "Extracting",
  filed: "Filed",
  needs_review: "Needs review",
  failed: "Failed",
};

/**
 * The pipeline, visible. Each note shows where it is: uploaded, transcribing,
 * extracting, then filed or needs review. This is a status list, not the
 * confirmation screen; that comes next and renders the extraction itself.
 */
export function RecentCaptures({ refreshKey }: { refreshKey: number }) {
  const [rows, setRows] = useState<CaptureSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    let timer: number | undefined;
    const load = async () => {
      try {
        const next = await store.captures();
        if (!alive) return;
        setRows(next);
        setError(null);
        if (next.some((c) => ACTIVE.has(c.status))) timer = window.setTimeout(load, POLL_MS);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    };
    load();
    return () => { alive = false; window.clearTimeout(timer); };
  }, [refreshKey]);

  if (error) {
    return <p className="empty">Couldn&rsquo;t load recent notes.<br /><em>{error}</em></p>;
  }
  if (!rows?.length) return null;

  return (
    <section className="block">
      <div className="label">Recent <span className="n">{rows.length}</span></div>
      <div className="list">
        {rows.map((c, i) => <CaptureRow key={c.id} c={c} index={i} />)}
      </div>
    </section>
  );
}

function CaptureRow({ c, index }: { c: CaptureSummary; index: number }) {
  const active = ACTIVE.has(c.status);
  const text = (c.transcript ?? c.rawText ?? "").trim();
  const filed = c.status === "filed" || c.status === "needs_review";
  const x = c.extraction;

  return (
    <div className="row anim" style={{ "--i": Math.min(index, 8) + 1 } as React.CSSProperties}>
      <span className="sq" style={{ "--c": active ? "var(--gold)" : "var(--text-3)", marginTop: 7 } as React.CSSProperties} />
      <span className="body">
        <span className="recall">
          {text ? clip(text, 160) : <em>{c.kind === "voice" ? "Waiting for the transcript" : "Empty note"}</em>}
        </span>
        <span className="meta">
          <span className={active ? "live" : undefined}>{LABEL[c.status]}</span>
          {c.durationSec != null && c.durationSec > 0 && <span>{fmtDuration(c.durationSec)}</span>}
          <span>{fmtWhen(c.capturedAt)}</span>
          {filed && x && <span>{x.people.length} {x.people.length === 1 ? "person" : "people"} / {x.facts.length} {x.facts.length === 1 ? "fact" : "facts"}{x.unresolved.length ? ` / ${x.unresolved.length} loose` : ""}</span>}
        </span>
        {c.status === "failed" && c.error && <span className="role">{clip(c.error, 200)}</span>}
      </span>
    </div>
  );
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

function fmtDuration(sec: number) {
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function fmtWhen(iso: string) {
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" });
}
