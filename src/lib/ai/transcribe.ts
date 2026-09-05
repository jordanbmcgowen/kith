/**
 * Whisper, with the user's own contact names fed in as a prompt hint. This is
 * the single highest-leverage line in the pipeline: without it, Whisper turns
 * "Adaeze" into "a daisy" and the whole match fails downstream.
 */
export async function transcribe(opts: {
  audio: Blob;
  filename: string;
  nameHints: string[];
}): Promise<{ text: string; durationSec: number }> {
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
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form,
  });
  if (!res.ok) throw new Error(`Transcription failed: ${await res.text()}`);

  const json = (await res.json()) as { text: string; duration?: number };
  return { text: json.text.trim(), durationSec: json.duration ?? 0 };
}
