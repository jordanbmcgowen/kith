# Kith — working context

Read this first. It is the project's standing brief for any session.

## What this is

A private memory system for the people in your life. You talk for twenty
seconds after you leave a room; Kith files what you said against the right
person and hands it back when you need it. Friends, family, coworkers. Not a
sales CRM.

Jordan is the first and only user for now. It is built multi-tenant from the
start so other people can sign into their own.

## Who you are working with

Jordan is not a developer. He designs the product, makes the calls, and reads
code well enough to follow it, but he does not write it. That changes how you
work here:

- Explain what a change does before you make it, in one or two sentences, in
  plain terms. Not a lecture.
- Never leave him at a terminal error with no next step. Give him the exact
  command to run.
- When something is broken, say what is broken and what you are doing about
  it. Do not narrate every file you open.
- No em dashes in anything you write.
- If you are about to do something with real consequences (drop a table, force
  push, change auth scopes, deploy to production), stop and say so first.

## Where things stand

Built and reviewed:

- `src/db/schema.ts` — the complete data model. Read this before anything else.
- `src/db/index.ts` — tenant-scoped query helper.
- `src/lib/auth.ts` — Auth.js + Google, including access token refresh.
- `src/lib/ai/extract.ts` — the transcript-to-records model call. This is the
  core of the product. Treat changes here as high stakes.
- `src/lib/ai/transcribe.ts`, `embed.ts`
- `src/lib/warmth.ts`, `src/lib/geo.ts`
- `src/lib/google/contacts.ts`, `calendar.ts`
- `src/app/api/v1/*` — captures, today, people, search, sync
- `src/workers/process-capture.ts` — the queue consumer
- `docs/SETUP.md` — the ordered account and deploy checklist

Not built yet:

- The entire UI. No React components exist. There is a published visual
  prototype; ask Jordan for the link before designing screens from scratch.
- PWA manifest and service worker
- Web push
- Post-meeting prompts from calendar events
- Any tests

## Build order

Do not skip ahead. Each step is testable on its own.

1. Phase 0 in `docs/SETUP.md`: accounts, keys, migrations, a deployed URL that
   Google sign-in works on. Nothing else until this is done.
2. Record and upload. `MediaRecorder` + geolocation, POST to
   `/api/v1/captures`. Verify with `wrangler tail kith-processor`.
3. The confirmation screen. Render the `extraction` JSON from the capture row.
   This screen decides whether the product feels like magic or homework.
4. Person detail, read only.
5. Search. The API already works once there are ~30 embedded facts.
6. Then, and only then, Google Calendar and Contacts sync.

Jordan should use it on himself for two weeks after step 5 before anything
gets added. If he stops using it, no feature saves it.

## Conventions

- API routes live under `/api/v1`. Keep them versioned. An Expo app will call
  these same routes later, so nothing may assume a browser.
- Every table holding user content has `userId`, and every query filters on it.
  There is no shared data between accounts. A missing tenant filter is the
  worst bug this app can ship.
- Captures are immutable. Facts, interactions and threads are derived and
  re-runnable. Never mutate a capture's transcript or audio.
- Extraction confidence below `AUTO_FILE_THRESHOLD` goes to `needs_review`.
  Silent wrong filing is worse than a confirmation tap.
- Anything the model cannot attach to a person becomes a `loose_thread`. Never
  drop something the user said.
- Location adds to ranking, never filters. Nobody disappears from a list
  because of where Jordan is standing.
- Secrets go in `wrangler secret put`, never in the repo, never in a client
  bundle.

## Gotchas that will bite you

- Neon needs the **pooled** connection string (host contains `-pooler`) for the
  serverless driver.
- `CREATE EXTENSION vector` and `pg_trgm` must run before the first migration.
  See `drizzle/0000_extensions.sql`.
- Google only returns a `refresh_token` with `access_type=offline` **and**
  `prompt=consent`. Both are already set. Do not remove them.
- Cloudflare Queues require the Workers Paid plan. The pipeline does not work
  without it.
- Whisper mangles unusual names unless you pass the contact list as a prompt
  hint. That is already wired in `transcribe.ts`. Do not remove it.
- Calendar and Contacts read are **sensitive** scopes: 100-user cap until
  verified, and verification is a form plus a demo video. Gmail is
  **restricted** and triggers an annual security assessment. Do not add Gmail
  scopes.

## Design direction

There is a published prototype that defines this exactly. Ask Jordan for the
link before designing any screen. Tokens:

```
--ground:#0A1512   pine, not black      --text:#F1EADC   parchment
--raise:#0F1E1A                          --text-2:#8CA69B
--rule:#1B2F2A     hairlines             --text-3:#587068
--rule-2:#294740
--gold:#E8B33F     the app's own voice: live, matched, primary action
--alert:#FF6B4A    OVERDUE ONLY. never decorative, never anything else.
--clay:#C9856B family   --verdigris:#4FB39E friends
--sky:#6D9FD8 work      --wisteria:#B58AD4 neighbors
```

Type: **Fraunces** for names and headings, **Schibsted Grotesk** for interface
text, **DM Mono** for anything countable (dates, distances, confidence,
status). All three from Google Fonts.

Hard rules. Breaking one of these is a bug, not a preference:

- **No cards.** List items are rows on the ground separated by 1px hairlines.
  No fills, no borders around content, no elevation.
- **No colored left rails.** A person's circle reads as a 6px square beside
  their name and as the fill behind their square initials.
- **border-radius: 0** everywhere except the record button and the mic button,
  which are circles because a circle means "press me."
- **No pill chips.** Filters are text with an animated underline on the active
  one.
- **Warmth is a 2px meter**, never a ring around an avatar.
- Coral is reserved for overdue. Nothing else in the app may be that
  saturated.
- Every animation must answer a question the user is already asking. No
  ambience. All of it stops under `prefers-reduced-motion`.

It should feel like a private notebook, not a dashboard. No badges, no
streaks, no gamification. Warmth orders things quietly and is never shown as a
judgment.

## Demo data: the seam

Jordan will hand you a prototype containing placeholder people. Preserve this
structure exactly when porting it to React, and never dissolve it.

- All placeholder data lives in **one fenced block** with `DEMO DATA` start and
  end markers. Nothing outside that block may reference a `DEMO_*` identifier.
- Views never touch the data directly. They call an async `store`.
- `const DATA_SOURCE = "demo" | "live"` picks between `demoStore` and
  `liveStore`. Both are async with identical method names and shapes, so the
  swap is one constant.
- Every demo record carries `_demo: true`, so one grep finds any that escaped.
- **The live store never falls back to demo data on error.** It throws, and the
  view renders an empty state. Silent fallback is exactly how preview data ends
  up in production. If you are ever tempted to add a `?? DEMO_PEOPLE`, don't.
- A visible `DEMO` badge sits in the status bar whenever the demo store is
  active.

When Jordan says the app is ready for live data, the whole change is: flip
`DATA_SOURCE`, delete the fenced block, verify `grep -r "DEMO_\|_demo" src/`
returns nothing.

## What this project does not need

- LiveKit. There is no realtime audio between people, only one-way capture.
- A separate vector database. pgvector on Neon covers it.
- Any Gmail scope.
