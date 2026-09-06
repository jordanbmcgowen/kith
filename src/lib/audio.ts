/**
 * Browsers do not agree on what a voice recording is. Chrome and Android
 * produce webm/opus, Safari on iOS produces mp4/aac, Firefox produces ogg.
 * Whisper accepts all of them, but only if the filename extension matches the
 * bytes. This maps the MediaRecorder mime type to that extension, and it is
 * shared by the upload route (which names the R2 object) and the worker
 * (which names the file it hands to Whisper) so the two can never disagree.
 */
const EXTENSIONS: Record<string, string> = {
  "audio/webm": "webm",
  "video/webm": "webm",   // some Chrome builds label audio-only webm this way
  "audio/mp4": "mp4",
  "video/mp4": "mp4",
  "audio/x-m4a": "m4a",
  "audio/m4a": "m4a",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/wave": "wav",
  "audio/x-wav": "wav",
  "audio/flac": "flac",
};

/** "audio/webm;codecs=opus" -> "audio/webm" */
export function baseMimeType(mime: string | null | undefined): string {
  return (mime ?? "").split(";")[0].trim().toLowerCase();
}

/**
 * The extension Whisper expects for this mime type. Unknown types fall back
 * to webm rather than rejecting the upload: a note with a strange container
 * still belongs to the user, and if Whisper cannot read it the capture ends
 * up visibly `failed` instead of silently lost.
 */
export function audioExtension(mime: string | null | undefined): string {
  return EXTENSIONS[baseMimeType(mime)] ?? "webm";
}

/** The mime type to store alongside the object, with codec parameters dropped. */
export function storedContentType(mime: string | null | undefined): string {
  const base = baseMimeType(mime);
  return base || "audio/webm";
}
