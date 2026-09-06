/**
 * Whisper, with the user's own contact names fed in as a prompt hint. This is
 * the single highest-leverage line in the pipeline: without it, Whisper turns
 * "Adaeze" into "a daisy" and the whole match fails downstream.
 *
 * The Blob's type and the filename's extension must both match the bytes.
 * The worker derives them from the R2 object; see src/lib/audio.ts.
 */
export async function transcribe(opts: {
  audio: Blob;
  filename: string;
  nameHints: string[];
}): Promise<{ text: string; durationSec: number }> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");

  const form = new FormData();
  form.append("file", opts.audio, opts.filename);
  form.append("model", "whisper-1");
  form.append("response_format", "verbose_json");
  form.append("language", "en");
  if (opts.nameHints.length) {
    form.append("prompt", `People who may be mentioned: ${opts.nameHints.slice(0, 60).join(", ")}.`);
  }

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!res.ok) {
    // Carry the status so the worker can tell a bad request (do not retry)
    // from a bad moment (retry).
    throw Object.assign(new Error(`Transcription failed (${res.status}): ${await res.text()}`), { status: res.status });
  }

  const json = (await res.json()) as { text: string; duration?: number };
  return { text: json.text.trim(), durationSec: json.duration ?? 0 };
}
