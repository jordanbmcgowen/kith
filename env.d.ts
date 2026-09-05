/**
 * The Cloudflare bindings declared in wrangler.jsonc, typed.
 *
 * @opennextjs/cloudflare declares an empty global `CloudflareEnv`; this merges
 * our bindings into it so `getCloudflareContext().env` is checked rather than
 * guessed. Add a binding here whenever you add one to wrangler.jsonc.
 */
declare global {
  interface CloudflareEnv {
    /** R2 bucket kith-audio. Raw capture audio, immutable once written. */
    AUDIO: R2Bucket;
    /** Producer side of the kith-captures queue. Consumed by kith-processor. */
    CAPTURE_QUEUE: Queue<{ captureId: string; userId: string }>;
  }
}

export {};
