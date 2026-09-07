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
    /** Producer side of the kith-captures queue. Consumed by kith-processor.
     *  `review` asks the consumer to stop at needs_review whatever the confidence. */
    CAPTURE_QUEUE: Queue<{ captureId: string; userId: string; review?: boolean }>;
    /** Service binding to kith-processor, which holds the model keys. POST /embed. */
    PROCESSOR: Fetcher;
  }
}

export {};
