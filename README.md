# Kith

A private memory system for the people in your life. Talk for twenty seconds
after you leave a room; Kith files what you said against the right person and
hands it back the moment you need it.

## What is here

This is the foundation, not the finished app. The data model, the auth, the
capture-to-memory pipeline, and the deploy config are real and complete. The UI
lives in the prototype artifact and still needs to be built as React.

```
src/
  db/schema.ts            the whole data model, heavily commented
  db/index.ts             tenant-scoped query helper
  lib/auth.ts             Auth.js + Google, incl. token refresh
  lib/warmth.ts           the relationship-decay score
  lib/geo.ts              distance, bounding box, location ranking
  lib/ai/transcribe.ts    Whisper, primed with your contact names
  lib/ai/extract.ts       Claude -> structured records (the core of the product)
  lib/ai/embed.ts         embeddings for fuzzy recall
  lib/google/*.ts         Contacts and Calendar sync
  lib/audio.ts            recording mime type -> the extension Whisper expects
  lib/filing.ts           extraction + decisions -> rows. worker and API share it
  lib/places.ts           a typed name or coordinates -> a places row
  lib/store.ts            the data seam: one constant picks demo or live
  lib/recorder.ts         MediaRecorder + level meter, browser only
  app/api/v1/*            the API. versioned, so an Expo app can reuse it
  app/record/             the capture screen (step 2 of the build order)
  app/notes/[id]/         the confirmation screen (step 3)
  components/             CaptureScreen, ConfirmScreen, RecentCaptures, Shell
  workers/process-capture.ts   the queue consumer that ties it together
scripts/
  pipeline-check.ts       runs the worker's filing path against the real DB, models stubbed
prototype/
  index.html              the interactive design reference. open it in a browser.
```

The capture and confirmation screens exist as React. Everything after them
(person detail, search) is still only in `prototype/index.html`, which remains
the design reference and carries the demo-data seam described in `CLAUDE.md`.

## The one idea worth protecting

Capture must cost less effort than remembering, or the app dies. Everything in
here bends to that: the capture endpoint returns in under a second and never
waits on a model; the phone is allowed to be wrong; ambiguity becomes a one-tap
confirmation instead of a form; and anything the model cannot place becomes a
visible loose thread rather than a silent drop.

## Architecture

```
  phone ──POST /api/v1/captures──▶ Worker
                                   ├─▶ R2  (audio)
                                   ├─▶ Neon (capture row, status=uploaded)
                                   └─▶ Queue ──▶ kith-processor
                                                  ├─ Whisper transcribe
                                                  ├─ resolve place (cache first)
                                                  ├─ Claude extract → JSON
                                                  ├─ every person sure? file it (lib/filing.ts)
                                                  │    facts/interactions/threads, embed → pgvector
                                                  └─ else status = needs_review, nothing written
  phone ──POST /api/v1/captures/:id/confirm──▶ Worker ─▶ lib/filing.ts with your decisions
```

## Getting it running

See `docs/SETUP.md`. Short version:

```bash
npm install
cp .env.example .env            # fill in
psql $DATABASE_URL -f drizzle/0000_extensions.sql
npm run db:generate && npm run db:migrate
npm run dev
```

## Decisions already made, and why

- **Postgres, not a vector database.** Facts need to be relational *and*
  searchable. pgvector on Neon does both in one query, and there is no second
  store to keep in sync.
- **Location adds, never filters.** GPS reorders the home screen. It never
  hides anyone. A ranking signal you can be wrong about is safe; a filter you
  can be wrong about is infuriating.
- **Raw captures are immutable.** Extraction is derived and re-runnable. A bad
  model day costs you a re-run, not a memory.
- **Confidence below 0.82 goes to review, and files nothing until you tap.**
  Silent wrong filing is worse than a confirmation tap. A note that would add
  three or more people at once waits too, so a pasted roster lands with
  circles set instead of as a pile of "other".
- **Every query is scoped by `userId`.** `scoped()` in `src/db/index.ts` is there
  to make the tenant filter hard to forget as the route count grows.
- **No LiveKit.** There is no realtime audio between people here, only one-way
  capture. It is the right tool for a different problem.
