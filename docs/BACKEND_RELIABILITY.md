# Capture recovery and atomic filing review

This draft makes capture acceptance durable and filing replacement atomic. It
uses the existing database, queue and processor Worker. Schema migration 0004
adds one job table; extraction prompts and raw capture content are unchanged.
Production rollout still requires independent review and explicit approval.

## Acceptance and recovery

A pending upload carries a UUID `Idempotency-Key`. Its text/audio, location,
place and capture time are frozen together in the capture screen until the
server acknowledges it. The store retains rerun keys across unsuccessful
requests, including in session storage where available. Reusing a key with a
different normalized payload returns 409. Keys are scoped to the tenant.

The upload transaction inserts both the immutable capture and its job, or
neither. Rerun locks the capture, inserts a new job and sets its active status
in one transaction. An unfinished-job unique index prevents overlapping reruns.
Repeating an acknowledged or ambiguous request with the same key returns the
original capture, even after its job has finished.

After commit the route attempts dispatch. A send rejection, lost acknowledgement
or crash leaves the same job unfinished. Dispatch reserves a one-minute retry
window before sending; it never marks work complete based on a queue response.
The processor's existing scheduled handler checks up to 100 eligible jobs per
minute using a producer binding to the same existing queue. Dispatch operations
reserve rows with atomic conditional updates, so overlapping dispatchers do not
both reserve the same due row. Duplicates are still expected and safe.

Legacy upload clients that send a stable capture time and identical payload
receive a deterministic fallback key. Unkeyed calls without capture time retain
the old distinct-note behavior: they cannot distinguish retries from intentional
identical notes. Legacy unkeyed reruns retain the old active-note 409 behavior;
a retry after completion is a new rerun. Full retry identity requires the updated
store or an explicit UUID header. Do not claim otherwise for old API clients.

Audio is uploaded before database acceptance under a fresh object key. A retry
that finds its durable job skips the upload; concurrent first attempts can leave
an unused audio object, as can an uncertain database failure. No ambiguous path
deletes or overwrites audio. Orphan cleanup is outside this change.

## Worker ownership and filing

A worker claims the durable job under tenant and capture row locks. A random
lease token owns it for ten minutes. Each claim increments the durable attempt
count. A duplicate with a live lease, a completed request, a foreign capture or
an unknown request key does no processing. Message-supplied review flags are
ignored; the database job determines whether to stop for review.

Transcription, extraction and embeddings run outside transactions. Every worker
write checks its tenant, capture, request key, lease token, unfinished state and
lease expiry under the same locks. The persisted transcript is reused on retry.
Place resolution is fenced and persisted before extraction, so a failed model
call does not repeat a successful place visit. The optional Google Places lookup
has a ten-second timeout and runs as read-only precompute outside the transaction.
Fenced resolution rechecks nearby local places before applying the prepared
Google candidate. A local place added while Google was pending takes precedence;
no network call occurs under the tenant lock.

Expired leases can be reclaimed; the old worker's later transcription,
extraction, embedding result or failure cannot change the new owner's state.
Three durable claims are allowed. Transient failures invalidate the active worker token and replace it with an
unowned cooldown token expiring after 30 seconds. Both processing claims and
dispatch skip that cooldown. Dispatch's separate available_at reservation does
not postpone processing once the cooldown expires. Duplicate deliveries during
backoff are acknowledged without model calls or attempt increments. Permanent
errors or exhausted claims atomically finish the job and leave
the capture visibly failed. Model calls exceeding ten minutes are discarded;
there is no heartbeat or cancellation guarantee for external model work.

Filing prepares embeddings first, then rechecks extraction/status under the
locks. People, tags, places, facts, visits, threads, loose threads, aggregates and
the capture filing record replace together. Successful automatic filing finishes
its job in that transaction. Successful user confirmation finishes any remaining
job for the capture, fencing old workers. Confirmations of active captures are
rejected. Person reuse/removal, tag spelling and complete-list tag decisions
remain as before. Reconfirming the same named place does not add another visit.
Raw text, audio keys and existing transcripts are not edited.

The transaction uses explicit READ COMMITTED isolation and a fresh Neon Pool
and client within the request. Client
release covers BEGIN failure as well as commit/rollback; pool shutdown runs in
finally. Nothing stores a live connection across Worker requests. Tenant locks
serialize filing and job writers; unrelated contact-sync writers do not take
those locks. This is not a general concurrency rewrite of all account writes.

## Transaction and runtime limits

No application lock_timeout, statement_timeout, connection timeout or whole
transaction deadline is configured. Database or platform defaults may apply but
were not inspected in production. SQL/network stalls and lock contention can
therefore hold or wait for a transaction until the server/runtime ends it; the
ten-minute job lease does not cancel a blocked query or free its locks. There
are no model network calls inside these transactions after the Google precompute
change, but SQL work still grows with note size.

The worker config sets no explicit CPU/duration limit. Transcription, extraction
and embeddings have no application deadline or heartbeat. A platform timeout
or a call exceeding the ten-minute lease leaves recoverable durable work, but
may require another paid model call after reclamation. Expiry fences later writes;
it does not guarantee cancellation of the original external request. Local tests
advance synthetic lease timestamps; they do not establish live Worker wall-time,
CPU, connection or lock-timeout behavior. Those limits require independent review
before any production rollout.

## Local verification

Only the dedicated loopback PostgreSQL/pgvector database is permitted. No test
loads .env or invokes live:check. The environment already provides pg, Docker,
the dedicated container and synthetic configuration. Initialize existing SQL
using its supplied start-db.sh if necessary, then apply only the approved 0004:

```sh
source /workspace/kith-local/environment.sh
bash /workspace/kith-local/start-db.sh
docker exec -i kith-synthetic-db psql -v ON_ERROR_STOP=1 -U kith -d kith_test < drizzle/0004_capture_jobs.sql
npm run test:reliability
npm run typecheck
npm run build
./node_modules/.bin/opennextjs-cloudflare build
./node_modules/.bin/wrangler deploy --dry-run --config wrangler.worker.jsonc --outdir /tmp/kith-processor-check
./node_modules/.bin/wrangler deploy --dry-run --config wrangler.jsonc --outdir /tmp/kith-app-check
```

Apply 0004 once on an initialized database, not before every test. The local setup
script rejects nonfixture users. The test runner additionally rejects users
outside example.invalid. Test transport URLs are restricted to loopback,
port 5543 and database kith_test. `KITH_LOCAL_PG_MODULE` can identify an existing
pg install for the test adapter; the cloud environment's install is the default.
The runner starts and stops its own loopback HTTP bridge and removes its bundles.

The suites check database rollback after replacement deletion, serialized
confirmations, no transaction held during embeddings, changed preparation,
request atomicity and identity conflicts, rejection and timeout after queue
acceptance, recovery, duplicate delivery, a three-delivery burst during processing
backoff without attempt consumption, dispatch eligibility after cooldown, transient/permanent failures, rerun
identity, lease expiry/exhaustion, old worker completion after newer confirmation,
stale transcription, cross-tenant IDs, HTTP/store retries and the existing
person/tag/place pipeline assertions. All data and models are synthetic.

A separate transactional migration check drops/recreates only the synthetic job
table, inserts active/filed fixtures, checks legacy adoption and lease constraints,
then rolls the entire check back. It leaves no fixture rows behind.

## Migration and rollback guidance

Migration 0004 backfills only uploaded/transcribing/extracting legacy captures.
Their request key is their capture ID, permitting old messages to resolve to the
adopted job. Backfilled jobs always stop for review. Filed, needs-review and
failed captures are not reprocessed by the migration. No existing capture or
derived row is deleted or rewritten. Job rows are retained after completion to
preserve retry identity. There is no automated retention purge in this change.

For any future production rollout, first pause capture/rerun writes and drain or
stop the old consumer. Apply the reviewed migration through the normal migration
journal, then release the new app and processor together with recovery enabled.
Old consumer code does not respect leases and must not run alongside new work.
Resume writes only after independent validation. This task did none of those
production actions, nor inspected production state.

Prefer rolling forward. Before any rollback, pause new writes, stop recovery and
consumption, wait for in-flight work, and reconcile every unfinished job while
retaining raw captures and the job table. Restoring old code while jobs are
unfinished reintroduces lost enqueue and stale-worker hazards. Do not drop the
table to undo the feature: it destroys retry identity and pending work. A later
explicitly approved cleanup may remove an empty/reconciled table and its journal
entry only as part of a reviewed migration strategy. Existing capture data should
not be rolled back.

## Review limitations and PR 7 coordination

The local adapter exercises real PostgreSQL transactions/locks with pg TCP,
replacing Neon's WebSocket transport. Builds check both Worker bundles; they do
not verify live Neon WebSockets, Cloudflare queue ordering, scheduler delivery,
service bindings or R2 behavior. The installed Neon driver documents request-local
Pool/Client use on Workers, and both configs already use nodejs_compat.

PR 7 was inspected without merging it. The exact overlapping files are
package.json and src/components/CaptureScreen.tsx. Its store/confirmation
signatures remain compatible. Integrate on a separate reviewed branch: combine
all package.json test scripts without dropping either suite, then retain PR 7's
mounted/recorder cancellation and stopping guards alongside this branch's frozen
Pending.input and request key. Keep the mounted check after awaiting the upload.
Run PR 7's recorder/UI suites, this branch's synthetic backend suite, typecheck
and both Worker builds on that combined tree before reviewing it. This task did
not merge either branch or run PR 7's UI suites against a combined tree.

Recovery depends on the existing cron and queue being enabled and the database
being reachable. Dispatch throughput is bounded; extended outages or a backlog
can delay notes. Audio fingerprinting reads up to the existing 25 MB limit into memory; maximum
payload memory/latency has not been load-tested in Workers. Session storage may be unavailable; in-memory rerun identity
still works until navigation/reload. Pending audio/text survives retries on the
current screen, not a browser crash. Those are existing persistence limits, not
an offline capture feature. Independent review remains required before deployment.

## Backoff correction evidence

The independent review found that released leases allowed duplicate deliveries
to spend attempts before available_at became due. The regression now injects a
transient outage and delivers three duplicates during backoff, asserting one
model call/attempt and an unfinished, nonfailed capture. It then advances only
synthetic cooldown/dispatch timestamps and proves that reserved dispatch does
not block eligible processing. It also verifies that the failed worker's old
token cannot write during cooldown. Running this regression with the previous
published capture-jobs implementation fails on the model-call/attempt assertion;
the corrected implementation passes. This correction reuses the existing schema;
no additional migration was created or applied.
