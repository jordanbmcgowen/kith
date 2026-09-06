# Setup: accounts, keys, and the order to do them in

Everything below is doable in an afternoon except the Google verification,
which is a form and a video followed by a few days of waiting.

---

## Phase 0 — Ship sign-in only (about 2 hours)

Goal: a live URL you can add to your home screen, that you can log into with
Google, and that has an empty but real database behind it. No sensitive scopes
yet, so no Google review, no user cap worries.

### 1. GitHub

Create a private repo, push this folder. Everything after this happens in
Claude Code against that repo.

### 2. Neon

- New project, region `us-east-2` (closest to Dallas of the common ones).
- In the Neon SQL editor run, before any migration:
  ```sql
  CREATE EXTENSION IF NOT EXISTS vector;
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  ```
- Copy **both** connection strings. They point at the same database. Neon
  shows one at a time; the **Connection pooling** toggle in the connection
  widget switches between them.

  | Variable | Neon toggle | Host | Used by |
  |---|---|---|---|
  | `DATABASE_URL` | pooling **on** | contains `-pooler` | the app and the Worker, at runtime |
  | `DIRECT_URL` | pooling **off** | no `-pooler` | `drizzle-kit generate` and `drizzle-kit migrate` |

  **Why two, and why this bites.** The pooled host is PgBouncer in transaction
  pooling mode. The serverless driver wants it, because Workers open many
  short lived connections and the pooler is what makes that survivable. But
  transaction mode has no session level advisory locks, and `drizzle-kit
  migrate` takes one so two migrations cannot run at the same time. Point
  migrations at the pooled host and they hang, or fail with a lock error that
  does not explain itself.

  `drizzle.config.ts` reads `DIRECT_URL` and nothing else. It throws a named
  error rather than falling back to `DATABASE_URL`, because a silent fallback
  here is the bug this table exists to prevent.

  `DIRECT_URL` is a local value for running migrations. It never becomes a
  Worker secret.
- Free tier is genuinely fine until you have real users.

### 3. Google Cloud — OAuth client

- console.cloud.google.com → new project "Kith".
- APIs & Services → OAuth consent screen → **External**.
- Fill in app name, support email, developer email. Add your domain later.
- Scopes: for now add **only** `openid`, `email`, `profile`. These are
  non-sensitive and need no review.
- Credentials → Create OAuth client ID → Web application.
  - Authorized JavaScript origins:
    - `http://localhost:3000`
    - `https://withkith.app`
  - Authorized redirect URIs (the path is fixed by Auth.js, do not invent one):
    - `http://localhost:3000/api/auth/callback/google`
    - `https://withkith.app/api/auth/callback/google`
- Copy the client ID and secret into `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET`.

### 4. Cloudflare

- You need the **Workers Paid plan ($5/month)**. Queues are not on the free
  plan, and the whole capture pipeline runs on Queues.
- R2 → create bucket `kith-audio`.
- Queues → create `kith-captures` and `kith-captures-dlq`.
- Add your domain (or a subdomain) to Cloudflare DNS.

### 5. Keys

```
AUTH_SECRET          openssl rand -base64 32
ANTHROPIC_API_KEY    console.anthropic.com
OPENAI_API_KEY       platform.openai.com  (Whisper + embeddings)
```

Set them as Worker secrets, not in the repo:

```bash
wrangler secret put DATABASE_URL      # the POOLED string
wrangler secret put AUTH_SECRET
wrangler secret put AUTH_GOOGLE_ID
wrangler secret put AUTH_GOOGLE_SECRET
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put OPENAI_API_KEY
```

### 6. Deploy

Migrations read `DIRECT_URL` from your local `.env`. The deploys read nothing
from `.env`; the Workers use the secrets you set in step 5.

```bash
npm run db:generate && npm run db:migrate    # uses DIRECT_URL
npm run deploy                               # the app
npm run deploy:worker                        # the queue consumer
```

If `db:migrate` hangs with no output, you have pointed `DIRECT_URL` at the
pooled host. Check that it does not contain `-pooler`.

---

## Phase 1 — The capture loop (the actual product)

Build in this order. Do not skip ahead; each step is testable on its own.

1. **Record and upload.** Built. `/record` records with `MediaRecorder`,
   or takes a typed or pasted note, and posts it with the phone's position to
   `/api/v1/captures`. Works in Safari on iOS as long as the page is HTTPS and
   the user taps. iOS records mp4 and Chrome records webm; the upload names
   the file to match, so do not hardcode an extension anywhere.
2. **Watch the queue.** `npx wrangler tail kith-processor` while you record.
   You should see `[capture <id>] transcribe`, then `extract`, then `filed`
   (or `needs_review`). The Recent list on the record screen shows the same
   progression. Before deploying a worker change, `npm run pipeline:check`
   runs the filing logic against the real database with the models stubbed.
3. **Confirmation screen.** Render the `extraction` JSON from the capture row.
   This is where the product either feels like magic or feels like homework.
4. **Person detail.** Read path only. Facts, timeline, threads.
5. **Search.** `/api/v1/search` is already written and works once you have
   twenty or thirty facts embedded.

**Test it on yourself for two weeks before adding anything else.** If you stop
using it, no feature will save it.

---

## Phase 2 — Google Calendar and Contacts

This is what removes the empty-app problem, and it is the only part with
paperwork.

### The scopes

| Scope | Class | What it costs you |
|---|---|---|
| `openid` `email` `profile` | Non-sensitive | Nothing. No review. |
| `calendar.readonly` | **Sensitive** | Verification form + demo video. ~3-5 business days. |
| `contacts.readonly` | **Sensitive** | Same review, submitted together. |
| any Gmail scope | **Restricted** | Annual third-party CASA security assessment. Do not do this yet. |

### What "sensitive" actually means

Until your app is verified, **any number of Google accounts can sign in with
the basic scopes, but only 100 accounts total can grant the sensitive ones**,
and every one of them sees an "unverified app" warning screen. For you plus a
handful of testers, that is fine indefinitely. You only need verification when
you want strangers.

Sensitive-scope verification needs:

- A verified domain (Google Search Console, same domain as your redirect URI).
- A privacy policy and terms page at real URLs on that domain.
- A per-scope written justification, including why a narrower scope is not
  enough. Write this honestly and specifically; vague justifications are the
  most common rejection.
- An unlisted YouTube video walking through the OAuth consent screen and
  showing exactly what the app does with the data.

It is a form and a screen recording, not an audit. Budget an afternoon and a
week of waiting.

### Then

- Add the two scopes to `GOOGLE_SCOPES` in `src/lib/auth.ts`.
- Call `POST /api/v1/sync` once after first sign-in, then nightly from the
  Worker cron already configured in `wrangler.worker.jsonc`.

---

## Phase 3 — Reminders and home screen

- **PWA manifest + service worker.** Once installed to the home screen, iOS
  (16.4+) and Android both support Web Push. No app store.
- **VAPID keys:** `npx web-push generate-vapid-keys`.
- **Nightly job** (already scheduled for 8am Central, `0 13 * * *` UTC, with
  a stub `scheduled()` handler): threads due today, birthdays this week,
  people whose warmth just dropped below their cadence.

Keep the notification budget brutal. One a day, maximum. The fastest way to get
uninstalled is to become another app that buzzes.

---

## Phase 4 — Other people, then native

- **Multi-user** already works; every table is scoped by `userId` and the
  `scoped()` helper exists so you cannot forget the filter. What you still need
  is billing (Stripe), a real onboarding flow, and a privacy policy that means
  what it says.
- **Native app:** the API is versioned at `/api/v1` for exactly this. An Expo
  app authenticates against the same Auth.js endpoints and calls the same
  routes. Background location and proper push are the two things it buys you.

---

## Running cost

Directional, for you alone. Check current pricing before you rely on these.

| | Monthly |
|---|---|
| Cloudflare Workers Paid (required for Queues) | $5.00 |
| Neon free tier | $0 |
| R2 storage + egress | $0 (free tier, no egress fees) |
| Whisper, ~30 notes at 20s | ~$0.06 |
| Claude Haiku extraction, ~30 notes | ~$0.15 |
| Embeddings | under $0.01 |
| Google Places (cached, few new places) | $0 within monthly credit |
| Domain | ~$1 |
| **Total** | **about $6** |

At a thousand active users the shape changes: Neon moves to a paid plan, and
the model spend scales roughly linearly at ten to twenty cents per active user
per month. It stays a cheap product to run. It is not a cheap product to get
people to use.

---

## What you do not need

- **LiveKit.** No realtime audio between people. One-way capture only.
- **A vector database.** pgvector on Neon covers it.
- **Render.** Keep it in your back pocket. If a Node-only dependency fights the
  Workers runtime, moving the processor Worker to a Render background job is a
  half-day change and nothing else moves.
