import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import { db, filingTransaction, captureJobs, captures, type FilingTransaction } from "../db";

export type JobMessage = { userId: string; captureId: string; requestKey?: string; review?: boolean };
export type JobLease = { userId: string; captureId: string; requestKey: string; token: string; attempts: number; review: boolean };
export type CaptureQueue = { send(message: JobMessage): Promise<unknown> };
export const MAX_JOB_ATTEMPTS = 3;
export class StaleJob extends Error {}
export class JobConflict extends Error { readonly status = 409; }
const owned = (userId: string, key: string) => and(eq(captureJobs.userId, userId), eq(captureJobs.requestKey, key));

/** Hash the normalized payload, never the multipart boundary or filename. */
export async function requestHash(metadata: unknown, audio?: Blob) {
  const digest = async (bytes: BufferSource) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
    .map(v => v.toString(16).padStart(2, "0")).join("");
  return digest(new TextEncoder().encode(JSON.stringify([metadata, audio ? await digest(await audio.arrayBuffer()) : null])));
}

export async function findRequest(userId: string, requestKey: string, hash: string) {
  const job = await db().query.captureJobs.findFirst({ where: owned(userId, requestKey) });
  if (job && job.requestHash !== hash) throw new JobConflict("This retry key belongs to a different request.");
  return job;
}

/** Caller holds the tenant/capture locks. Never accept an expired or replaced lease. */
export async function assertLease(tx: FilingTransaction, lease: JobLease) {
  const [job] = await tx.select().from(captureJobs).where(and(
    owned(lease.userId, lease.requestKey), eq(captureJobs.captureId, lease.captureId),
    eq(captureJobs.leaseToken, lease.token), isNull(captureJobs.finishedAt),
    sql`${captureJobs.leaseUntil} > clock_timestamp()`,
  ));
  if (!job) throw new StaleJob("This capture job no longer owns the note");
}

export async function withLease<T>(lease: JobLease, work: (tx: FilingTransaction) => Promise<T>) {
  return filingTransaction(lease.userId, async tx => {
    await tx.select({ id: captures.id }).from(captures).where(and(eq(captures.id, lease.captureId), eq(captures.userId, lease.userId))).for("update");
    await assertLease(tx, lease);
    const result = await work(tx);
    const [job] = await tx.select({ finishedAt: captureJobs.finishedAt, leaseToken: captureJobs.leaseToken }).from(captureJobs).where(owned(lease.userId, lease.requestKey));
    // Only this callback can change ownership while holding the tenant lock.
    // Failure can replace the worker token with an unowned cooldown token;
    // finishing clears it. Otherwise check expiry again before committing.
    if (!job || (!job.finishedAt && job.leaseToken === lease.token)) await assertLease(tx, lease);
    return result;
  });
}

export async function claimJob(msg: JobMessage): Promise<JobLease | null> {
  const requestKey = msg.requestKey ?? msg.captureId; // only migration-backed legacy jobs
  return filingTransaction(msg.userId, async tx => {
    const [capture] = await tx.select().from(captures)
      .where(and(eq(captures.id, msg.captureId), eq(captures.userId, msg.userId))).for("update");
    if (!capture) return null;
    const [job] = await tx.select().from(captureJobs).where(and(owned(msg.userId, requestKey), eq(captureJobs.captureId, msg.captureId), isNull(captureJobs.finishedAt),
      or(isNull(captureJobs.leaseUntil), lte(captureJobs.leaseUntil, sql`clock_timestamp()`))));
    if (!job) return null;
    if (job.attempts >= MAX_JOB_ATTEMPTS) {
      await tx.update(captureJobs).set({ finishedAt: sql`now()`, leaseToken: null, leaseUntil: null, lastError: "Processing attempts exhausted" }).where(owned(msg.userId, requestKey));
      await tx.update(captures).set({ status: "failed", error: "Processing attempts exhausted. Try again." }).where(and(eq(captures.id, msg.captureId), eq(captures.userId, msg.userId)));
      return null;
    }
    const token = crypto.randomUUID();
    await tx.update(captureJobs).set({ leaseToken: token, leaseUntil: sql`clock_timestamp() + interval '10 minutes'`, attempts: job.attempts + 1 })
      .where(owned(msg.userId, requestKey));
    return { userId: msg.userId, captureId: msg.captureId, requestKey, token, attempts: job.attempts + 1, review: job.review };
  });
}

export async function finishJob(tx: FilingTransaction, lease: JobLease) {
  await assertLease(tx, lease);
  await tx.update(captureJobs).set({ finishedAt: sql`now()`, leaseToken: null, leaseUntil: null, lastError: null }).where(owned(lease.userId, lease.requestKey));
}

export async function failJob(lease: JobLease, terminal: boolean, error: unknown) {
  await withLease(lease, async tx => {
    const message = error instanceof Error ? error.message : "Processing failed";
    await tx.update(captureJobs).set({ lastError: message,
      ...(terminal ? { finishedAt: sql`now()`, leaseToken: null, leaseUntil: null } : {
        // Invalidate the worker and reserve processing eligibility separately
        // from dispatch's available_at. No worker receives this cooldown token.
        // Duplicate deliveries cannot claim or spend attempts for 30 seconds,
        // even if a dispatch reservation changes available_at meanwhile.
        leaseToken: crypto.randomUUID(),
        leaseUntil: sql`clock_timestamp() + interval '30 seconds'`,
        availableAt: sql`clock_timestamp() + interval '30 seconds'`,
      }),
    }).where(owned(lease.userId, lease.requestKey));
    await tx.update(captures).set(terminal ? { status: "failed", error: message } : { error: message })
      .where(and(eq(captures.id, lease.captureId), eq(captures.userId, lease.userId)));
  }).catch(err => { if (!(err instanceof StaleJob)) throw err; });
}

/** Reserve the next dispatch before sending. Both rejection and lost ACK retain
 * this exact row. A crash at any point becomes eligible again in one minute. */
export async function dispatchJob(userId: string, requestKey: string, queue: CaptureQueue) {
  const [job] = await db().update(captureJobs).set({ availableAt: sql`now() + interval '1 minute'` }).where(and(
    owned(userId, requestKey), isNull(captureJobs.finishedAt), lte(captureJobs.availableAt, sql`now()`),
    or(isNull(captureJobs.leaseUntil), lte(captureJobs.leaseUntil, sql`clock_timestamp()`)),
  )).returning();
  if (!job) return;
  try {
    await queue.send({ captureId: job.captureId, userId: job.userId, requestKey: job.requestKey });
  } catch {
    // The transport cannot distinguish rejection from accepted-but-timed-out.
    await db().update(captureJobs).set({ lastError: "Queue acknowledgement unavailable; dispatch will retry" })
      .where(and(owned(userId, requestKey), isNull(captureJobs.finishedAt)));
  }
}

/** System metadata scan only. Content access still requires an explicit tenant. */
export async function dispatchDue(queue: CaptureQueue) {
  const due = await db().select({ userId: captureJobs.userId, requestKey: captureJobs.requestKey }).from(captureJobs).where(and(
    isNull(captureJobs.finishedAt), lte(captureJobs.availableAt, sql`now()`),
    or(isNull(captureJobs.leaseUntil), lte(captureJobs.leaseUntil, sql`clock_timestamp()`)),
  )).orderBy(captureJobs.availableAt).limit(100);
  for (const job of due) await dispatchJob(job.userId, job.requestKey, queue);
}

export async function rerunCapture(userId: string, captureId: string, requestKey: string) {
  const hash = await requestHash({ operation: "rerun", captureId });
  return filingTransaction(userId, async tx => {
    const [capture] = await tx.select().from(captures).where(and(eq(captures.userId, userId), eq(captures.id, captureId))).for("update");
    if (!capture) return null;
    const [prior] = await tx.select().from(captureJobs).where(owned(userId, requestKey));
    if (prior) {
      if (prior.requestHash !== hash || prior.captureId !== captureId) throw new JobConflict("This retry key belongs to a different request.");
      return capture;
    }
    const [active] = await tx.select().from(captureJobs).where(and(eq(captureJobs.userId, userId), eq(captureJobs.captureId, captureId), isNull(captureJobs.finishedAt)));
    if (active) throw new JobConflict("Already working on this note.");
    await tx.insert(captureJobs).values({ userId, captureId, requestKey, requestHash: hash, review: true });
    const [saved] = await tx.update(captures).set({ status: "uploaded", error: null })
      .where(and(eq(captures.userId, userId), eq(captures.id, captureId))).returning();
    return saved;
  });
}

/** Legacy callers already send capturedAt. New callers send a UUID retry key. */
export function legacyRequestKey(hash: string) {
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

export async function acceptCapture(userId: string, requestKey: string, hash: string, input: Omit<typeof captures.$inferInsert, "userId" | "status">) {
  return filingTransaction(userId, async tx => {
    const [prior] = await tx.select().from(captureJobs).where(owned(userId, requestKey));
    if (prior) {
      if (prior.requestHash !== hash) throw new JobConflict("This retry key belongs to a different request.");
      const [capture] = await tx.select().from(captures).where(and(eq(captures.id, prior.captureId), eq(captures.userId, userId)));
      if (!capture) throw new Error("Capture job has no owned capture");
      return capture;
    }
    const [capture] = await tx.insert(captures).values({ ...input, userId, status: "uploaded" }).returning();
    await tx.insert(captureJobs).values({ userId, requestKey, captureId: capture.id, requestHash: hash });
    return capture;
  });
}
