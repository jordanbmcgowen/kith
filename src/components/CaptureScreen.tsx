"use client";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { store, ApiError, type Coords } from "@/lib/store";
import { Recorder, recorderSupported } from "@/lib/recorder";
import { audioExtension } from "@/lib/audio";
import { Waveform } from "./Waveform";
import { RecentCaptures } from "./RecentCaptures";

type Stage = "idle" | "typing" | "recording" | "saving" | "failed";

/** A note that has been captured but not yet accepted by the server. Kept until it is. */
type Pending = { audio?: Blob; text?: string; capturedAt: Date; durationMs: number };

/** Whisper's file limit is 25MB; twenty minutes of opus or aac stays well under it. */
const MAX_MS = 20 * 60 * 1000;
const MIN_MS = 600;

const style = (i: number, extra?: CSSProperties) => ({ "--i": i, ...extra }) as CSSProperties;

/**
 * Step 2 of the build order: record and upload. Voice through MediaRecorder,
 * or a typed or pasted note, plus the phone's position, posted to
 * /api/v1/captures. What happens after that is the worker's job, and the
 * list underneath shows it happening.
 */
export function CaptureScreen() {
  const [stage, setStage] = useState<Stage>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  // undefined: still asking. null: unavailable or refused.
  const [coords, setCoords] = useState<Coords | null | undefined>(undefined);
  const [canRecord, setCanRecord] = useState(true);

  const recorder = useRef<Recorder | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);

  /* ---- setup ---- */
  useEffect(() => {
    setCanRecord(recorderSupported());
    let alive = true;
    store.coords().then((c) => { if (alive) setCoords(c); });
    return () => {
      alive = false;
      recorder.current?.cancel();
      window.clearTimeout(toastTimer.current);
    };
  }, []);

  /* ---- timer, and the twenty minute ceiling ---- */
  useEffect(() => {
    if (stage !== "recording") return;
    const id = window.setInterval(() => {
      const r = recorder.current;
      if (!r) return;
      const ms = Date.now() - r.startedAt;
      setElapsed(ms);
      if (ms >= MAX_MS) void stop();
    }, 250);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage]);

  const showToast = (msg: string) => {
    setToast(msg);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2800);
  };

  /* ---- voice ---- */
  const start = async () => {
    setError(null);
    const r = new Recorder();
    try {
      await r.start();
    } catch (e) {
      setError(micProblem(e));
      return;
    }
    recorder.current = r;
    setElapsed(0);
    setStage("recording");
    // A fresh fix while they talk. Whatever we have at upload time is what gets sent.
    void store.coords({ fresh: true }).then((c) => { if (c) setCoords(c); });
  };

  const stop = useCallback(async () => {
    const r = recorder.current;
    if (!r) return;
    recorder.current = null;
    setStage("saving");
    const { blob, durationMs } = await r.stop();
    if (blob.size === 0 || durationMs < MIN_MS) {
      setStage("idle");
      setError("That was too short to hear anything. Hold it a moment longer.");
      return;
    }
    await upload({ audio: blob, capturedAt: new Date(r.startedAt), durationMs });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coords]);

  /* ---- typed or pasted ---- */
  const submitText = async () => {
    const t = text.trim();
    if (!t) return;
    await upload({ text: t, capturedAt: new Date(), durationMs: 0 });
  };

  /* ---- upload, with the note held until the server has it ---- */
  const upload = async (p: Pending) => {
    setPending(p);
    setStage("saving");
    try {
      await store.capture({
        audio: p.audio,
        filename: p.audio ? `note.${audioExtension(p.audio.type)}` : undefined,
        text: p.text,
        coords: coords ?? null,
        capturedAt: p.capturedAt,
      });
      setPending(null);
      setText("");
      setError(null);
      setStage("idle");
      setRefreshKey((k) => k + 1);
      showToast("Saved. Filing it now.");
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 401
          ? "You are signed out. Open Kith again and sign in; your note is still here."
          : `Couldn't reach Kith (${e instanceof Error ? e.message : String(e)}). Your note is still here.`,
      );
      setStage("failed");
    }
  };

  const discard = () => {
    setPending(null);
    setError(null);
    setStage(pending?.text ? "typing" : "idle");
  };

  /* ---- render ---- */
  return (
    <>
      {stage === "idle" && (
        <div className="cap">
          <div className="fade">
            <h1 className="h1" style={{ marginTop: 14 }}>Talk.<br /><em>That&rsquo;s it.</em></h1>
            <p className="lede" style={{ marginTop: 12 }}>
              Say what happened the way you would say it to a friend. Names, details, anything you promised. Kith sorts it out.
            </p>
          </div>

          <div className="anim" style={style(2)}>
            <Waveform recorder={null} />
            <div className="recwrap">
              <i /><i />
              <button className="recbtn" onClick={start} disabled={!canRecord} aria-label="Start recording">
                <MicIcon />
              </button>
            </div>
            <p className="timer quiet" style={{ marginTop: 22 }}>
              {canRecord ? "Tap to record" : "No microphone here"}
            </p>
          </div>

          {error && <p className="lede anim" style={style(3, { color: "var(--text)" })}>{error}</p>}

          <button className="link anim" style={style(3, { alignSelf: "center" })} onClick={() => { setError(null); setStage("typing"); }}>
            Type or paste it instead
          </button>

          <LocationStrip coords={coords} />
        </div>
      )}

      {stage === "typing" && (
        <div className="cap">
          <div className="fade">
            <h1 className="h1" style={{ marginTop: 14 }}>Write it <em>down.</em></h1>
            <p className="lede" style={{ marginTop: 12 }}>
              Paste from Notes or type it out. Same filing, no microphone. One note per person or moment works best.
            </p>
          </div>
          <textarea
            className="note anim"
            style={style(1)}
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Saw Marcus at the club. His daughter got into Rice, early decision. Told him I'd send the Cirrus article this week."
          />
          <div className="actions anim" style={style(2)}>
            <button className="btn" disabled={!text.trim()} onClick={submitText}>File it</button>
            <button className="btn ghost" onClick={() => setStage("idle")}>Back to recording</button>
          </div>
          <LocationStrip coords={coords} />
        </div>
      )}

      {stage === "recording" && (
        <div className="cap rec">
          <div className="fade">
            <h1 className="h1" style={{ marginTop: 14 }}>Listening</h1>
            <p className="stamp" style={{ marginTop: 10 }}>{placeLabel(coords)} / {stamp(new Date())}</p>
          </div>
          <div>
            <Waveform recorder={recorder.current} />
            <div className="recwrap">
              <i /><i />
              <button className="recbtn" onClick={stop} aria-label="Stop recording"><StopIcon /></button>
            </div>
            <p className="timer" style={{ marginTop: 22 }}>{fmtElapsed(elapsed)}</p>
          </div>
          <button className="btn ghost" onClick={stop}>Stop and file it</button>
        </div>
      )}

      {stage === "saving" && (
        <div className="fade" style={{ paddingTop: 16 }}>
          <h1 className="h1">Saving</h1>
          <p className="stamp" style={{ marginTop: 10 }}>
            {pending?.audio ? `${Math.round((pending.durationMs) / 1000)} seconds` : "typed note"} / uploading
          </p>
          <div className="script" style={{ marginTop: 22 }}><span className="caret" /></div>
        </div>
      )}

      {stage === "failed" && (
        <div className="cap">
          <div className="fade">
            <h1 className="h1" style={{ marginTop: 14 }}>Not <em>saved.</em></h1>
            <p className="lede" style={{ marginTop: 12 }}>{error}</p>
          </div>
          <div className="actions anim" style={style(1)}>
            <button className="btn" onClick={() => pending && upload(pending)}>Try again</button>
            <button className="btn ghost" onClick={discard}>Discard it</button>
          </div>
        </div>
      )}

      {(stage === "idle" || stage === "typing") && <RecentCaptures refreshKey={refreshKey} />}

      <div className={`toast${toast ? " up" : ""}`} role="status" aria-live="polite">{toast}</div>
    </>
  );
}

/**
 * Where this note will be tagged. There is no place name yet: that is the
 * worker's job, and it only exists once a place has been seen. What the
 * phone can honestly say is whether it has a fix and how tight it is.
 */
function LocationStrip({ coords }: { coords: Coords | null | undefined }) {
  const searching = coords === undefined;
  const off = coords === null;
  return (
    <div className="geo anim" style={style(4, { margin: 0 })}>
      <span className={`locator${searching ? " searching" : ""}${off ? " off" : ""}`}><span /><span /><b /></span>
      <div style={{ flex: 1 }}>
        <div className="geo-name" style={{ fontSize: 16 }}>
          {searching ? "Finding you" : off ? "Location off" : "Location on"}
        </div>
        <div className="lede" style={{ marginTop: 4 }}>
          {searching && "Asking the phone where you are."}
          {off && "This note will be filed without a place. Allow location for Kith to tag where you were."}
          {coords && `This note will be tagged here${coords.accuracy ? `, within ${Math.round(coords.accuracy)} m` : ""}.`}
        </div>
      </div>
    </div>
  );
}

function micProblem(e: unknown): string {
  const name = (e as { name?: string } | null)?.name;
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Microphone is blocked. Allow it for withkith.app in your browser settings, or type the note instead.";
  }
  if (name === "NotFoundError") return "No microphone found on this device. Type the note instead.";
  return `Couldn't start the microphone (${e instanceof Error ? e.message : String(e)}). Type the note instead.`;
}

const placeLabel = (c: Coords | null | undefined) => (c ? "Located" : c === null ? "No location" : "Locating");

function fmtElapsed(ms: number) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function stamp(d: Date) {
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })}, ${d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

const MicIcon = () => (
  <svg width="38" height="38" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
    <rect x="9.2" y="2.6" width="5.6" height="10.8" rx="2.8" />
    <path d="M5.6 11a6.4 6.4 0 0 0 12.8 0" />
    <path d="M12 17.4V21" />
  </svg>
);

const StopIcon = () => (
  <svg width="30" height="30" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <rect x="7" y="7" width="10" height="10" />
  </svg>
);
