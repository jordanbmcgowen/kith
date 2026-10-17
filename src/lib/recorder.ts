/**
 * MediaRecorder with the browser's own container, plus an analyser so the
 * waveform can show real input level. Browser only.
 *
 * Works in Safari on iOS as long as the page is HTTPS and start() runs from a
 * tap. iOS produces audio/mp4; Chrome and Android produce audio/webm. The
 * upload names the file from the blob's type, so the worker and Whisper see
 * the right extension either way.
 */
const CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/ogg;codecs=opus",
];

type Recording = { blob: Blob; mimeType: string; durationMs: number };

export function recorderSupported(): boolean {
  return typeof window !== "undefined"
    && typeof MediaRecorder !== "undefined"
    && !!navigator.mediaDevices?.getUserMedia;
}

function pickMimeType(): string | undefined {
  return CANDIDATES.find((t) => MediaRecorder.isTypeSupported(t));
}

export class Recorder {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private audioCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private bins: Uint8Array<ArrayBuffer> | null = null;
  private generation = 0;
  private starting = false;
  private stopping = false;
  private stopPromise: Promise<Recording> | null = null;
  startedAt = 0;

  /** Asks for the microphone. Throws if refused; the caller turns that into words. */
  async start(): Promise<void> {
    if (this.starting || this.stopping || this.recorder) {
      throw new DOMException("A recording is already in progress.", "InvalidStateError");
    }
    const generation = ++this.generation;
    this.starting = true;
    this.stopPromise = null;
    this.startedAt = 0;
    this.chunks = [];
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // A permission prompt can outlive the screen that requested it. Cancel
      // cannot dismiss that prompt, but it must release any stream it returns.
      if (generation !== this.generation) {
        stream.getTracks().forEach((t) => t.stop());
        throw new DOMException("Recording was cancelled.", "AbortError");
      }
      this.stream = stream;
      const mimeType = pickMimeType();
      this.recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      const chunks: Blob[] = [];
      this.chunks = chunks;
      // Keep a cancelled recorder's final event out of any later recording.
      this.recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      // Timeslice so long notes are collected as they go, not in one lump at the end.
      this.recorder.start(1000);
      this.startedAt = Date.now();
    } catch (e) {
      if (generation === this.generation) this.release();
      throw e;
    } finally {
      if (generation === this.generation) this.starting = false;
    }

    // The level meter is a nicety. If the audio graph fails, recording must not.
    try {
      this.audioCtx = new AudioContext();
      const src = this.audioCtx.createMediaStreamSource(this.stream);
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 256;
      this.analyser.smoothingTimeConstant = 0.7;
      src.connect(this.analyser);
      this.bins = new Uint8Array(this.analyser.frequencyBinCount);
    } catch {
      this.releaseMeter();
    }
  }

  /** 0..1 per bar, left to right, for a waveform of `count` bars. Null when no analyser. */
  levels(count: number): number[] | null {
    if (!this.analyser || !this.bins) return null;
    this.analyser.getByteFrequencyData(this.bins);
    // Speech lives in the bottom third of the spectrum. Spread it over the bars
    // and mirror around the centre so the picture reads as one voice, not a
    // spectrum analyser.
    const usable = Math.floor(this.bins.length * 0.35);
    const half = Math.ceil(count / 2);
    const out: number[] = new Array(count).fill(0);
    for (let i = 0; i < half; i++) {
      const bin = Math.min(usable - 1, Math.floor((i / half) * usable));
      const v = this.bins[bin] / 255;
      out[half - 1 - i] = v;
      out[Math.min(count - 1, half + i)] = v;
    }
    return out;
  }

  /** Stops, releases the microphone, and returns the recording. */
  stop(): Promise<Recording> {
    if (this.stopPromise) return this.stopPromise;
    if (this.starting) this.cancel();
    const generation = this.generation;
    this.stopping = true;
    this.stopPromise = new Promise((resolve, reject) => {
      const rec = this.recorder;
      const chunks = this.chunks;
      const durationMs = this.startedAt ? Date.now() - this.startedAt : 0;
      const release = () => {
        // A late stop event from a cancelled recording must not close a new one.
        if (generation === this.generation) {
          this.release();
          this.stopping = false;
        }
      };
      const finish = () => {
        try {
          const mimeType = rec?.mimeType || pickMimeType() || "audio/webm";
          const blob = new Blob(chunks, { type: mimeType });
          resolve({ blob, mimeType, durationMs });
        } catch (e) {
          reject(e);
        } finally {
          release();
        }
      };
      const fail = (e: unknown) => {
        release();
        reject(e);
      };
      if (!rec || rec.state === "inactive") return finish();
      rec.onstop = finish;
      rec.onerror = () => fail(new Error("The browser could not finish the recording."));
      try { rec.stop(); } catch (e) { fail(e); }
    });
    return this.stopPromise;
  }

  /** Abandon the recording and release the microphone. */
  cancel(): void {
    ++this.generation;
    this.starting = false;
    this.stopping = false;
    try { if (this.recorder && this.recorder.state !== "inactive") this.recorder.stop(); } catch { /* already stopped */ }
    this.release();
  }

  private release(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.recorder = null;
    this.releaseMeter();
  }

  private releaseMeter(): void {
    void this.audioCtx?.close().catch(() => {});
    this.audioCtx = null;
    this.analyser = null;
    this.bins = null;
  }
}
