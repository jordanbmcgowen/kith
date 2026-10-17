import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { Recorder, recorderSupported } from "../src/lib/recorder";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function microphone() {
  let stops = 0;
  const stream = { getTracks: () => [{ stop: () => { stops++; } }] } as unknown as MediaStream;
  return { stream, get stops() { return stops; } };
}

/** Browser substitutes only. These tests never ask for a real microphone. */
function browser(t: TestContext) {
  const requests: ReturnType<typeof deferred<MediaStream>>[] = [];
  const recorders: FakeMediaRecorder[] = [];
  const contexts: FakeAudioContext[] = [];
  const errors: { constructor?: Error; start?: Error; stop?: Error; meter?: Error } = Object.create(null);
  let autoFinish = true;

  class FakeMediaRecorder {
    static isTypeSupported(type: string) { return type === "audio/webm;codecs=opus"; }
    state: RecordingState = "inactive";
    mimeType: string;
    ondataavailable: ((event: BlobEvent) => void) | null = null;
    onstop: ((event: Event) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    stops = 0;
    timeslice: number | undefined;
    constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
      if (errors.constructor) throw errors.constructor;
      this.mimeType = options?.mimeType ?? "audio/webm";
      recorders.push(this);
    }
    start(timeslice?: number) {
      if (errors.start) throw errors.start;
      this.timeslice = timeslice;
      this.state = "recording";
    }
    stop() {
      this.stops++;
      if (errors.stop) throw errors.stop;
      this.state = "inactive";
      if (autoFinish) queueMicrotask(() => this.finish());
    }
    finish(text = "recorded audio") {
      this.ondataavailable?.({ data: new Blob([text]) } as BlobEvent);
      this.onstop?.(new Event("stop"));
    }
  }

  class FakeAudioContext {
    closes = 0;
    constructor() { contexts.push(this); }
    createMediaStreamSource() {
      if (errors.meter) throw errors.meter;
      return { connect() {} };
    }
    createAnalyser() {
      return { frequencyBinCount: 128, fftSize: 256, smoothingTimeConstant: 0.7, getByteFrequencyData() {} };
    }
    close() { this.closes++; return Promise.resolve(); }
  }

  for (const [key, value] of Object.entries({
    window: {},
    navigator: { mediaDevices: { getUserMedia: () => {
      const request = deferred<MediaStream>();
      requests.push(request);
      return request.promise;
    } } },
    MediaRecorder: FakeMediaRecorder,
    AudioContext: FakeAudioContext,
  })) {
    const old = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => {
      if (old) Object.defineProperty(globalThis, key, old);
      else Reflect.deleteProperty(globalThis, key);
    });
  }

  return { requests, recorders, contexts, errors, set autoFinish(value: boolean) { autoFinish = value; } };
}

test("records final audio, keeps the browser format, and releases resources", async (t) => {
  const b = browser(t);
  const mic = microphone();
  const r = new Recorder();
  assert.equal(recorderSupported(), true);
  const starting = r.start();
  b.requests[0].resolve(mic.stream);
  await starting;
  assert.equal(b.recorders[0].timeslice, 1000);
  r.startedAt = Date.now() - 1200;
  const recording = await r.stop();
  assert.equal(await recording.blob.text(), "recorded audio");
  assert.equal(recording.mimeType, "audio/webm;codecs=opus");
  assert.equal(recording.blob.type, recording.mimeType);
  assert.ok(recording.durationMs >= 1200);
  assert.equal(mic.stops, 1);
  assert.equal(b.contexts[0].closes, 1);
});

test("a second start cannot open a second permission request", async (t) => {
  const b = browser(t);
  const mic = microphone();
  const r = new Recorder();
  const starting = r.start();
  await assert.rejects(r.start(), { name: "InvalidStateError" });
  assert.equal(b.requests.length, 1);
  b.requests[0].resolve(mic.stream);
  await starting;
  await assert.rejects(r.start(), { name: "InvalidStateError" });
  r.cancel();
  assert.equal(mic.stops, 1);
});

test("cancel during permission promptly releases a late microphone grant", async (t) => {
  const b = browser(t);
  const mic = microphone();
  const r = new Recorder();
  const cancelled = assert.rejects(r.start(), { name: "AbortError" });
  r.cancel();
  b.requests[0].resolve(mic.stream);
  await cancelled;
  assert.equal(mic.stops, 1);
  assert.equal(b.recorders.length, 0);
  assert.equal(b.contexts.length, 0);
});

test("an old permission response cannot replace or release a newer recording", async (t) => {
  const b = browser(t);
  const oldMic = microphone();
  const newMic = microphone();
  const r = new Recorder();
  const cancelled = assert.rejects(r.start(), { name: "AbortError" });
  r.cancel();
  const starting = r.start();
  b.requests[1].resolve(newMic.stream);
  await starting;
  b.requests[0].resolve(oldMic.stream);
  await cancelled;
  assert.equal(oldMic.stops, 1);
  assert.equal(newMic.stops, 0);
  assert.equal(b.recorders.length, 1);
  assert.equal(b.recorders[0].state, "recording");
  r.cancel();
  assert.equal(newMic.stops, 1);
});

for (const failure of ["constructor", "start"] as const) {
  test(`a MediaRecorder ${failure} failure releases the acquired microphone`, async (t) => {
    const b = browser(t);
    const mic = microphone();
    const r = new Recorder();
    b.errors[failure] = new Error(`Cannot ${failure}`);
    const failed = assert.rejects(r.start(), b.errors[failure]);
    b.requests[0].resolve(mic.stream);
    await failed;
    assert.equal(mic.stops, 1);
    assert.equal(b.contexts.length, 0);
  });
}

test("a refused permission request can be retried", async (t) => {
  const b = browser(t);
  const r = new Recorder();
  const rejected = assert.rejects(r.start(), { name: "NotAllowedError" });
  b.requests[0].reject(new DOMException("Not allowed", "NotAllowedError"));
  await rejected;
  const mic = microphone();
  const starting = r.start();
  b.requests[1].resolve(mic.stream);
  await starting;
  r.cancel();
  assert.equal(mic.stops, 1);
});

test("a failed waveform closes its audio context without stopping recording", async (t) => {
  const b = browser(t);
  const mic = microphone();
  const r = new Recorder();
  b.errors.meter = new Error("Audio graph unavailable");
  const starting = r.start();
  b.requests[0].resolve(mic.stream);
  await starting;
  assert.equal(r.levels(10), null);
  assert.equal(b.contexts[0].closes, 1);
  assert.equal(mic.stops, 0);
  assert.equal(b.recorders[0].state, "recording");
  await r.stop();
  assert.equal(mic.stops, 1);
  assert.equal(b.contexts[0].closes, 1);
});

test("repeated stop calls share the final audio rather than losing an event", async (t) => {
  const b = browser(t);
  const mic = microphone();
  const r = new Recorder();
  const starting = r.start();
  b.requests[0].resolve(mic.stream);
  await starting;
  const stopping = r.stop();
  assert.equal(r.stop(), stopping);
  assert.equal(await (await stopping).blob.text(), "recorded audio");
  assert.equal(b.recorders[0].stops, 1);
  assert.equal(mic.stops, 1);
});

test("a synchronous stop failure rejects and still releases the microphone", async (t) => {
  const b = browser(t);
  const mic = microphone();
  const r = new Recorder();
  const starting = r.start();
  b.requests[0].resolve(mic.stream);
  await starting;
  b.errors.stop = new Error("Cannot stop");
  await assert.rejects(r.stop(), b.errors.stop);
  assert.equal(mic.stops, 1);
  assert.equal(b.contexts[0].closes, 1);
});

test("a browser error while stopping releases resources and rejects", async (t) => {
  const b = browser(t);
  b.autoFinish = false;
  const mic = microphone();
  const r = new Recorder();
  const starting = r.start();
  b.requests[0].resolve(mic.stream);
  await starting;
  const failed = assert.rejects(r.stop(), /could not finish/);
  b.recorders[0].onerror?.(new Event("error"));
  await failed;
  assert.equal(mic.stops, 1);
  assert.equal(b.contexts[0].closes, 1);
});

test("a late stop event from a cancelled recording cannot close a new one", async (t) => {
  const b = browser(t);
  b.autoFinish = false;
  const oldMic = microphone();
  const newMic = microphone();
  const r = new Recorder();
  const first = r.start();
  b.requests[0].resolve(oldMic.stream);
  await first;
  const oldStop = r.stop();
  r.cancel();
  const second = r.start();
  b.requests[1].resolve(newMic.stream);
  await second;
  b.recorders[0].finish("old audio");
  assert.equal(await (await oldStop).blob.text(), "old audio");
  assert.equal(newMic.stops, 0);
  assert.equal(b.contexts[1].closes, 0);
  const newStop = r.stop();
  b.recorders[1].finish("new audio");
  assert.equal(await (await newStop).blob.text(), "new audio");
  assert.equal(newMic.stops, 1);
});
