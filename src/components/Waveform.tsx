"use client";
import { useEffect, useRef } from "react";
import type { Recorder } from "@/lib/recorder";

const BARS = 46;

/**
 * Canvas, not CSS bars. While recording it draws the real input level, which
 * answers the one question a voice interface makes people ask: is it hearing
 * me? Idle it is a still resting line. Under reduced motion it never moves.
 */
export function Waveform({ recorder }: { recorder: Recorder | null }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;

    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = cv.clientWidth, h = cv.clientHeight;
    cv.width = w * dpr; cv.height = h * dpr;
    ctx.scale(dpr, dpr);
    const gap = w / BARS;
    // Fallback shape for browsers where the analyser could not be built.
    const seeds = Array.from({ length: BARS }, (_, i) => Math.abs(Math.sin(i * 1.31) * 0.5 + Math.sin(i * 0.47) * 0.5));

    let raf = 0;
    let t = 0;
    const draw = (levels: number[] | null, live: boolean) => {
      ctx.clearRect(0, 0, w, h);
      for (let i = 0; i < BARS; i++) {
        const centre = 1 - Math.abs(i - BARS / 2) / (BARS / 2);
        const level = live ? (levels ? levels[i] : Math.abs(Math.sin(t * 0.06 + i * 0.55)) * seeds[i]) : 0.09;
        const bar = Math.max(2, level * (h * 0.86) * (0.35 + centre * 0.8));
        ctx.fillStyle = live ? `rgba(232,179,63,${0.32 + centre * 0.62})` : "rgba(88,112,104,0.55)";
        ctx.fillRect(i * gap + gap * 0.22, (h - bar) / 2, Math.max(2, gap * 0.42), bar);
      }
    };

    if (!recorder || reduced) { draw(null, false); return; }

    const loop = () => {
      draw(recorder.levels(BARS), true);
      t += 1;
      raf = requestAnimationFrame(loop);
    };
    loop();
    return () => cancelAnimationFrame(raf);
  }, [recorder]);

  return <canvas ref={ref} className="wave" aria-hidden="true" />;
}
