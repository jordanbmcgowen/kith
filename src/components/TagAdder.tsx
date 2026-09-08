"use client";
import { useState } from "react";

/**
 * One field and the user's other tags as text to tap. Enter or a tap adds;
 * Escape or Cancel closes. Inline, never a modal. Shared by the
 * confirmation screen and a person's own page, so a tag is added one way.
 */
export function TagAdder({ pool, onAdd, onClose }: { pool: string[]; onAdd: (tag: string) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const s = q.trim().toLowerCase();
  const shown = (s ? pool.filter((t) => t.toLowerCase().includes(s)) : pool).slice(0, 8);
  const submit = () => { const t = q.trim(); if (t) onAdd(t); };
  return (
    <div className="picker">
      <label className="field">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Group, team, club"
          autoFocus
          autoComplete="off"
          spellCheck={false}
          maxLength={40}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } if (e.key === "Escape") onClose(); }}
        />
        {q.trim() && <button className="act gold" type="button" onClick={submit}>Add</button>}
        <button className="act" type="button" onClick={onClose}>Cancel</button>
      </label>
      {shown.length > 0 && (
        <div className="meta" style={{ padding: "10px 0 6px", gap: 16 }}>
          {shown.map((t) => <button key={t} type="button" className="act" onClick={() => onAdd(t)}>{t}</button>)}
        </div>
      )}
    </div>
  );
}
