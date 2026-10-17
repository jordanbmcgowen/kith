# Focused reliability review

This pass keeps the current design and feature set. It does not change auth,
model prompts, database schema, filing semantics, or deployment settings.

## Fixed in this branch

- A delayed microphone permission grant can no longer start recording after
  leaving the capture screen. Repeated taps cannot open parallel recordings,
  and failed recorder startup/stop releases its resources.
- Search results and people rows belong to the query/filter that produced
  them. Old rows no longer masquerade as results for a new selection. Loading
  and retry states make temporary failures recoverable.
- Re-reading a note clears the old extraction and its positional choices
  together. Opening a different note also starts with that note's choices.
- Choosing an existing person during review starts from that person's tags
  and circle, instead of replacing them with the previous selection's labels.

## Safe local checks

Install the locked dependencies with `npm ci`, then run:

```sh
npm run typecheck
npm run test:recorder
CHROMIUM_PATH=/path/to/chromium npm run test:ui
```

`npm test` runs both regression suites. The browser suite uses actual screen
components with a minimal navigation shim and an isolated, synthetic HTTP
backend. It does not sign in, request actual microphone/location permission,
connect to a database, call models, or access production. The default Playwright
Chromium is used when `CHROMIUM_PATH` is omitted.

If a browser is available separately, `node scripts/ui-check.mjs --serve`
prints a loopback-only URL. Opening its `/__checks` route runs the same browser
checks and displays the result. Ordinary `/find`, `/people`, and `/notes/labels`
routes can be inspected visually with fake people. This fixture is never
included in the deployed application.

A production compilation can use non-production placeholder configuration:

```sh
DATABASE_URL=postgresql://build:build@localhost:5432/build \
AUTH_SECRET=build-only-placeholder AUTH_URL=http://localhost:3000 npm run build
```

This proves compilation, not a connection to a real backend. In restricted
executors, point npm's cache and `XDG_CONFIG_HOME` at writable temporary paths.
Do not run `live:check` or `pipeline:check` against a real account as part of
these isolated tests: those scripts write database rows.

## Separate Codex review before broader changes

These findings are intentionally not changed in this branch:

1. **Queue enqueue failure can strand a capture.** The capture-create and
   rerun routes set `uploaded` before sending to the queue. A rejected send
   can leave no job to process while rerun rejects the active status. Retrying
   an upload after an ambiguous outcome can create another capture. Design
   recovery and idempotency together; inject both definite failure and
   ambiguous-success cases without live queue or model calls.
2. **Re-filing is not atomic.** `src/lib/filing.ts` deletes prior derived rows
   and inserts replacements in separate database operations. Failure between
   them, or overlapping confirmations, can leave incomplete content. Review
   transaction/serialization options supported by the existing Neon client,
   then test rollback and concurrent requests on an isolated database.

Neither item should be fixed by blindly retrying production writes. A later
reviewable task should define migration/rollback needs and test evidence before
any production change. Publishing a branch or draft PR does not deploy it.

## Independent validation, 2026-10-17

Fetched the PR branch and verified its remote head was
`39e13fc70916bedbf13b35ceef45db52889e3f23`. Reviewed the production diff,
recorder tests, and isolated fixture harness. No additional in-scope production
defects were found. The review checked cancellation/resource ownership, query
and filter response ownership, positional decision resets, and selected-person
label preservation.

The first Chromium run passed seven checks, then exposed a test timing bug:
the picker check queried its DOM immediately after a React state update. It now
waits for the picker to render before selecting the synthetic person. No product
code or visual design changed during this validation.

Validation of this follow-up tree in the Kith cloud environment:

- PASS: `npm ci --cache /tmp/kith-npm-cache`.
- PASS: `npm run test:recorder`, 12 tests.
- PASS: `CHROMIUM_PATH=/usr/bin/chromium npm run test:ui`, all 10 checks,
  with no browser runtime errors or external requests.
- PASS: `npm run typecheck`.
- PASS: production `npm run build` using the placeholder database/auth settings
  above and `XDG_CONFIG_HOME=/tmp/kith-config`.
- PASS: `git diff --check`.

These checks validate synthetic browser behavior and compilation, not live
backend integration or real iOS/Safari microphone behavior. No production data,
credentials, authentication scopes, extraction prompts, or infrastructure were
changed. No live checks, merge, or deployment were performed. The two backend
follow-ups above remain outside this review.
