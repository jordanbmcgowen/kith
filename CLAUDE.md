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

## Waiting on Jordan

The running list of things only he can do. Keep it current: add an item when
something needs him, strike it when it is done, and say what is on it when he
asks what is left.

- [ ] **Enable Places API (New) on the Google Cloud project.** One click:
      https://console.developers.google.com/apis/api/places.googleapis.com/overview?project=649824471182
      The key itself is set and working. The trap is that Google ships two
      separate products with almost the same name, each with its own switch:
      "Places API" (legacy, closed to new projects) and "Places API (New)".
      The project has the first one on; the code calls the second
      (`places.googleapis.com/v1/places:searchNearby`). Tested end to end
      2026-09-09: Google answered 403 "Places API (New) has not been used in
      project 649824471182 before or it is disabled". Nothing else is wrong,
      and nothing on our side needs changing. Until then, naming a place by
      hand works and each name makes the next one a tap.
- [ ] **Review the note that half-filed.** The "Soccer people / Green Knoll /
      Schofield" note (5d3ef4f1) is still waiting. Its 41 people exist with
      their tags and roles; only "Diane" is left to create. Tapping File it
      now finishes it without doubling anything. See "A filing that died
      partway" below for what happened.
- [ ] **Two weeks of using it.** Not a task, a standing one: what he hits while
      using the app is what decides the next build. Every item in "Built, from
      use" below came from that.

Done:

- [x] Review the Banner House note (filed 2026-09-09; it is where the Banner
      House, Meridoh and Pizza Hut tags came from).
- [x] Set `GOOGLE_PLACES_KEY` on kith-processor (done 2026-09-09; the key is
      valid and reaching Google. See the open item above for what is left).

## Where things stand

Built and reviewed:

- `src/db/schema.ts`: the complete data model. Read this before anything else.
- `src/db/index.ts`: tenant-scoped query helper.
- `src/lib/auth.ts`: Auth.js + Google, including access token refresh.
- `src/lib/ai/extract.ts`: the transcript-to-records model call. This is the
  core of the product. Treat changes here as high stakes.
- `src/lib/ai/transcribe.ts`, `embed.ts`
- `src/lib/warmth.ts`, `src/lib/geo.ts`
- `src/lib/google/contacts.ts`, `calendar.ts`
- `src/app/api/v1/*`: captures, today, people, search, sync. Every handler
  is wrapped in `route()` from `src/lib/api.ts`, which turns a signed-out
  call into a 401 instead of an opaque 500.
- `src/workers/process-capture.ts`: the queue consumer. Its three model
  calls are injectable so `scripts/pipeline-check.ts` can run the whole
  filing path against the real database with no keys. Run it after any
  change to the worker: `npm run pipeline:check`.
- `src/lib/audio.ts`: the one table mapping a browser's recording mime type
  to the extension Whisper expects. Upload route and worker both use it.
- `docs/SETUP.md`: the ordered account and deploy checklist

Built, step 2 of the build order (record and upload):

- `src/app/globals.css`: the design system, ported from the prototype.
- `src/lib/store.ts`: the data seam described below. `DATA_SOURCE` is
  `"live"`; the demo block exists for building later screens.
- `src/lib/recorder.ts`: MediaRecorder with the browser's own container
  plus an analyser for the waveform.
- `src/components/CaptureScreen.tsx`: voice or typed/pasted note, upload,
  retry without losing the note, and a status list that polls while a note
  is moving through the pipeline. Lives at `/record`; `/` redirects there
  when signed in.
- Where a note happened is a three-way choice on that screen: **Here** sends
  coordinates and an optional name for the place, **Somewhere else** sends a
  typed name and no coordinates (most notes are recorded later, at home),
  **No place** sends neither. `captures.lat/lng` therefore mean where the
  note is about, never where the phone was. The typed name lands in
  `captures.place_hint`; the worker matches it to a known place by name
  (exact, then trigram) or creates one, and learns a place's coordinates the
  first time it is named from there. Coordinates alone only become a place
  through proximity to a known one, or through Google Places if
  `GOOGLE_PLACES_KEY` is set on the processor, which it currently is not.
- The extraction model gets NOW spelled out with the weekday and a two week
  calendar, because it cannot reliably compute weekdays from an ISO
  timestamp. "By Friday" was landing on Saturday before this.

Built, step 3 of the build order (the confirmation screen):

- `src/lib/filing.ts`: filing is its own module, called by the worker and by
  the confirm endpoint with the same code. It takes the extraction stored on
  the capture plus `FilingDecisions` (per person: match, new, or drop, plus
  tags; per fact, interaction, follow-up: keep or drop; per loose thread:
  attach or dismiss; place: keep, name, or clear) and writes the rows. It
  records what it did in `captures.filing` (the people it created, the people
  it touched, the decisions), so running it again replaces instead of
  doubling, reuses the person rows it created, and removes those a re-file no
  longer uses when nothing else refers to them. Warmth and last seen come from
  the interaction's date, and `person_places` is rebuilt from interactions.
- Hybrid filing. Every person at or above `AUTO_FILE_THRESHOLD` files itself.
  Anything below, a person the model could not place, or a note that would
  add `NEW_PEOPLE_REVIEW_AT` (3) people at once stops at `needs_review` with
  the extraction stored and nothing written. A queue message with
  `review: true` always stops there; that is what a re-run does.
- `GET /api/v1/captures/:id`, `POST .../confirm`, `POST .../rerun`. The
  confirm route embeds through the `PROCESSOR` service binding: the
  processor's fetch handler answers `POST /embed` with its own OpenAI key,
  and has no public hostname. Model keys live on the processor only.
- `src/components/ConfirmScreen.tsx` at `/notes/[id]`: the prototype's
  "Here's what I got", one block per person with their tags under them, the
  facts under each person with drop and undo, loose threads with attach and
  dismiss, the place, then File it (waiting) or Done (filed). Tapping a
  Recent row opens it. `ReviewCount` in the status bar reads "2 to review"
  while anything is waiting.
- Notes filed before `captures.filing` existed get a reconstructed record on
  read (`reconstructFiling`): person rows added within half an hour of the
  note whose names appear in its extraction count as created by it.
- The extraction prompt says who counts as a person (not someone mentioned in
  passing, but every bare name on a list) and what confidence means for a new
  person (that they are distinct from every candidate).
- Tags. `people.tags` is the user's own words for the groups a person belongs
  to ("YoungLife", "Journeymen"). Circles were removed later; see "Groups are
  the user's tags, and nothing else" below. The model gets
  the user's existing tags and each candidate's, proposes tags per person
  from the note's own headings and phrasing, and filing keeps one spelling
  per tag. A decision's `tags` is the person's complete list; the screen
  starts from what they already carry plus what the note proposes, and
  shows it under each person with one tap to remove and "+ tag" to add.

Step 3 is merged and deployed. Jordan has reviewed his real notes on it.

Built, step 4 of the build order (person detail, read only):

- `GET /api/v1/people/:id`: the person with the cadence that applies to
  them, facts pinned first, open threads soonest first, visits newest first
  with their place, places by how often you see them there, and the notes
  that filed something about them: every capture whose filing record lists
  them, plus any that left a fact, visit, thread or attached loose thread on
  them. A note the user left them out of is not a mention. A malformed or
  foreign id is a 404.
- `GET /api/v1/people` grew a `tag` filter (case-insensitive) and returns
  the user's tags, most used first, and roster counts beside the rows, both
  unfiltered so the filter row holds still. Sorted by last seen, newest
  first, then never-seen people by name.
- `store.people({ tag })` and `store.person(id)` in both stores;
  `PersonRow`, `PeopleList`, `PersonView` in `src/lib/store.ts`.
- `src/components/PeopleScreen.tsx` at `/people`: the prototype's underline
  filters, one row: Everyone and then the user's own tags. It lives in the
  URL. (It started as two rows, circles above tags; see below.) The
  list remembers its query in `sessionStorage` (`kith:people`) so the
  person page's back link returns to the same view. Location never narrows
  this list; when places exist it will only reorder it.
- `src/components/PersonScreen.tsx` at `/people/[id]`: initials, name,
  pronunciation or goes-by, role, tags; since seen ("none yet"
  without a visit), your cadence, warmth as the 2px meter and never a
  number; Remember first; Open threads (no checkbox until marking done
  arrives); History, which is visits only, each opening its note; Notes,
  every note that filed something about them, each opening the note; Where
  you see them. Open threads and places hide when empty; Remember first and
  History say so in one line.
- `src/components/TabBar.tsx` in the Shell on every signed-in screen:
  Today, People, the mic, Find, You. People, the mic and Find are live;
  Today and You are dimmed and inert (`.nv.soon`) until their steps.
- On the confirmation screen a person with a row links to their page
  (`.nm-link`), including people kept from an earlier read.
- `src/lib/format.ts`: dates and due lines as the people screens say them.
  The model writes channels loosely ("in-person"); `fmtChannel` normalises
  them and says nothing for in person, because the place says it.

Step 4 is deployed and merged.

Built, step 5 of the build order (search):

- `GET /api/v1/search?q=&lat=&lng=`: hybrid, and every result says why it
  matched. Trigram (`word_similarity`, not `similarity`) over names, tags and
  roles for when you remember the word; cosine over facts and visits for when
  you only remember the shape of the thing. A name outranks a tag outranks a
  role outranks something you said about them, so typing a name gets the name.
  Under two characters it returns an empty list and the hints, never an error.
  No migration: `pg_trgm`, `vector` and the three indexes it needs already
  exist.
- Every threshold was measured, first on the data and then on the deployment
  with real query embeddings. `word_similarity` scores a real first name or
  surname at 1.0 while a whole sentence tops out near 0.1 across the roster.
  Right semantic answers came back at 0.48 to 0.61 and the near-misses at 0.34
  to 0.44, so `VECTOR_GATE` is 0.40. On top of that `VECTOR_BAND` (0.15) lets a
  confident hit raise the floor under the weaker ones, because otherwise every
  work-shaped question drags the same four "works in..." facts along behind the
  answer. The band is applied before a person is reduced to their best row, so
  someone whose fact is cut can still come back on their name or their tag.
- A sentence gets matched word by word against tags and roles as well as whole.
  Typing "coffee" finds the three people whose role says coffee; so does "the
  guy who does the coffee", which scores far too low as a whole sentence. Those
  hits sit below a good memory (0.48 and 0.50) and above the noise. Words are
  stripped to letters and digits, must be four characters or more, and generic
  ones are dropped: matching on "works" turns "who works in consulting" into a
  list of everyone who works anywhere.
- The query is embedded through the `PROCESSOR` service binding, as the
  confirm route does. If the processor cannot answer, the route returns the
  trigram half with `namesOnly: true` and the screen says so in one line.
  Visibly half a search beats a blank screen; it is never silent.
- Location adds and never filters. `lat`/`lng` add at most `MAX_LOCATION_BOOST`
  (0.08) to people you are usually near, enough to reorder near-ties and never
  enough to overturn a name. The Find screen does not ask for the phone's
  position yet: with no places yet the prompt would buy nothing.
- "Try one" under an empty field is built from the user's own rows: their
  most-used tags first, then the commonest words in the roles they wrote,
  deduped so one hint never hides inside another. A new account gets none.
  Nothing is invented, and no person's name is ever offered as an example.
- `store.search(q, coords?)` in both stores; `SearchHit`, `SearchResults` in
  `src/lib/store.ts`. The why line comes back formed; the date it happened
  comes back separately as `at` so the screen says it in the phone's own zone.
- `src/components/FindScreen.tsx` at `/find`: the field with the gold underline
  on focus, the query in the URL (so a tapped result comes back to the same
  search), 250ms settle before it asks, results as the same `PersonRow` the
  people list draws with the why line under each, and "Nothing yet. Kith only
  knows what you have told it." A result is `.hit`: the row and its why line
  inside one hairline, so the reason stays with the person it belongs to.
- The live check grew section K: the empty, one-character and signed-out cases,
  a name by trigram, a fact and a visit by cosine (which is what proves the
  processor binding, since trigram never reads either), a second throwaway
  account whose person must never come back, and one temporary place to prove
  the location boost lifts and never filters. Section L removes all of it.
- Four older checks were asserting state rather than behaviour and had gone red
  on their own: they assumed a note still waiting for review and a note filed
  before `captures.filing` existed. Every note now has a real filing record and
  nothing is waiting, so those checks ask the database what is true and assert
  against that, or say there is nothing left to test. The re-run poll waits five
  minutes rather than two, because the queue backs off 30s then 60s before a
  second attempt and a slow model call was timing the run out.

Built, from use (not from the build order):

Jordan used the app and two things came back. Both are built.

- **Corrections.** A fact, a visit, a follow-up or a loose thread was keep or
  drop, nothing else, so a fact that was 80% right could only be thrown away.
  Now the words on the confirmation screen are tappable: change them, Done.
  `FilingDecisions` carries an optional `text` per item (plus `at` on a visit
  and `dueAt` on a follow-up), and filing writes those instead of the model's
  when they are there. The transcript is never touched. Facts are derived, so
  a correction is a re-file, and the edited words are what gets embedded.
  Dropping and undoing keeps a correction: the toggle spreads rather than
  replacing.
- **Employers are tags, not circles.** Jordan asked for the work circle to
  become specific brands. Tags do it and circles cannot: a circle holds one
  value, so the day someone changes jobs a company-as-circle overwrites the
  history that was the point, and circles also set the cadence and the four
  colors. A tag list holds Yum and Neighborly at once. Verified on the
  deployment: a note saying someone "just moved to Brightwater Logistics from
  Halloway Foods" now tags them with both.
- `PATCH /api/v1/people/:id` and an editor on a person's page: name, goes by,
  pronunciation, who they are, tags, and their own cadence. Strict body; an
  empty string clears a field; tags keep one spelling; warmth is recomputed
  after, because the cadence is what warmth is read against. That is what lets the
  existing roster get brand tags without re-recording a note about each person.
  Facts, visits and threads are deliberately NOT editable there: they come
  from notes, and the note is where a correction survives a re-file.
- `src/components/TagAdder.tsx` is shared by the confirmation screen and the
  person page, so a tag is added one way.
- **One filter row, not two.** Circles and tags were two rows of the same
  underlined words. This was the first step; circles went entirely soon after,
  so the row is now Everyone plus the user's tags. The tag lives in the URL.
- **When you last saw them.** `POST /api/v1/people/:id/visits` logs a visit on
  a chosen day, `PATCH`/`DELETE .../visits/:id` move or remove one. "Saw them"
  sits in the History block. Last seen and warmth are never set directly: they
  are read back out of the interactions table by `refreshPerson` in
  `src/lib/people.ts`, which every write that touches a visit or a cadence
  calls afterwards, so the two numbers cannot drift from the visits they describe.
  A visit that came from a note is not editable there, and says so: changing it
  on the person page would be undone by the next re-file, silently. The note is
  where those are corrected, and the visit links to it.
- **Location, working.** `GET /api/v1/places?lat=&lng=` returns the places you
  have already named, nearest first (bounding box, then real distance), or your
  most-visited when there is no fix. The record screen offers them under Here
  and Somewhere else as one tap, so the first visit to a place is typing and
  every one after is a tap. Without that the place list never accumulates, and
  with no places location can rank nothing. The Find screen now asks for a fix
  once per visit and passes it to search, where it only ever reorders.
- Still missing for location to feel automatic: `GOOGLE_PLACES_KEY` on
  kith-processor, which turns coordinates alone into a named place. See
  "Waiting on Jordan" at the top.
- **Today.** `GET /api/v1/today?lat=&lng=` in one round trip: the place you are
  at, who you usually see there, what you owe, who is slipping, what Kith heard
  and could not place, and how many notes are waiting for a look. Every block
  hides when it is empty, so a quiet day is a short screen and not five
  headings over nothing. `src/components/TodayScreen.tsx` at `/today`; the
  greeting reads the phone's clock, not the server's, because a good morning
  from the wrong timezone is worse than none. Slipping means seen at least once
  and past their own cadence: someone added and never met was never warm, and
  34 of the roster are in that state. Only You is a placeholder tab now.
- **Two sizing bugs, both measured rather than guessed.** The top strip sat at
  22px while every row under it sat at 20px, which reads as the whole app being
  slightly loose; they are both 20px now. And `.tabs` had no
  `overscroll-behavior`, so a sideways fling on the filter row chained out to
  the page and the whole app rubber-banded; it is `contain` now. Worth knowing
  for the next report of "it feels off": the document itself measures 0px of
  horizontal overflow on every screen at 320, 390 and 430 wide, so the page has
  never scrolled sideways. The filter row was the only thing that moved. The
  live check now asserts both, on all five screens.
- Row-shaped links (`a.row`, `a.thread`, `a.loose`) carry no underline: the row
  is the affordance. Underlines belong to `.act` and `.link`, which are words
  you press.
- **Groups are the user's tags, and nothing else.** Circles are gone from the
  whole app: the five words on the review screen, the filter row, the person
  page and its editor, the colour behind a person's initials, the extraction
  prompt, `FilingDecisions`, and every API that returned one. Jordan asked for
  it after seeing FAMILY FRIENDS WORK NEIGHBORS OTHER still sitting under every
  person on the review screen, and the data had already made the case: sixty of
  sixty-one people were in "other", so four of the five words described nobody
  and the fifth described everybody.
  - `people.circle` is **retained in the schema, unused and unwritten**. It is
    a NOT NULL enum with a default, so dropping it is a migration; nothing
    reads it. Do not start reading it again.
  - Cadence was the one thing circles really did: `users.cadenceDefaults` held
    five numbers, one per circle. It is one number now, under the key
    `everyone`. `cadenceOf` and `cadenceFor` in `warmth.ts` read `everyone`,
    then fall back to the old `other` key, so an account written before the
    change keeps the answer it had without a migration.
  - What circles gave in granularity, `people.cadenceDays` gives better: a
    number on the one person who needs it, set on their own page, blank to
    inherit. `PATCH /api/v1/people/:id` takes `cadenceDays` where it used to
    take `circle`.
  - `GET /api/v1/people?circle=` is ignored rather than a 400: old links and
    old `sessionStorage` entries should not error, they should just show
    everyone.
  - `src/lib/circles.ts` is deleted; `initials` moved to `format.ts`.
- **What a fact is about: work, travel, and the people in their life.**
  `facts.kind` was six values the user never saw, three of them catch-alls,
  and the two subjects that come up in nearly every note had nowhere to land:
  where someone works went to "history" (which also means alma mater) or
  "context" (which means everything), and a trip had no home at all. 43 of
  Jordan's 104 facts were "context".
  - `work` and `travel` are kinds now, added in `drizzle/0004_fact_kinds.sql`
    (`ALTER TYPE ... ADD VALUE IF NOT EXISTS`, additive, no row changed).
    `relation` widened from family to anyone they named, friends included.
  - `src/lib/facts.ts` holds the whole vocabulary: `FACT_LABELS` (one word
    per kind, which is what the screen says), `FACT_PICKS` (the chooser, in
    order), `FACT_SECTIONS` and `bySection`. Nothing else names a kind.
  - The extraction prompt now defines each kind with an example and says not
    to use "context" as a default.
  - The review screen labels every fact row with its kind, and the kind is a
    tap: open a fact, and the words to change it sit under the text as an
    underlined row, the same language as the filter row. `FilingDecisions`
    carries `kind?` per fact; filing writes the user's over the model's, the
    same way `text` already worked.
  - A person's page is one list broken into blocks: Remember first, Work,
    Family and friends, Travel. A block with nothing in it is not drawn, and
    the numbering runs straight down the page rather than restarting in each
    block.
- **Adding, not just correcting.** "+ note" under each person on the review
  screen. `FilingDecisions.added` is `{ personName, kind, text }[]`, keyed by
  name exactly as the model's own facts are, so filing resolves it down the
  same path: it embeds with the rest, it leaves with its person when that
  person is left out, and a name with no person entry becomes a loose thread
  instead of vanishing. Confidence 1, because the user wrote it.
- **The tag you just typed comes first.** The "+ tag" suggestions show eight,
  and Jordan has fifteen tags, so ordering the pool by his whole roster buried
  the tag he had just put on the person above: the one case the suggestions
  exist for. The note's own tags sort to the front now.
- **A filing that died partway.** Filing inserted people one at a time. A
  roster note names forty, so that was forty sequential round trips and forty
  chances for the request to be cancelled: a backgrounded phone, a dropped
  signal. It happened to a real note (5d3ef4f1, 43 people): 41 rows were
  created, the request died on the last one, and the record of what it had
  made was only written after the whole loop. The rows existed, the capture
  knew nothing about them, and the next File it would have made all 41 again.
  - The people are made in one statement now. Their ids are generated in the
    app rather than by the database, which is what lets the capture be told
    what is about to exist *before* it exists. A row recorded and never
    inserted is harmless: the next filing does not find it in the roster,
    makes a fresh one, and drops the stale entry.
  - `reconstructFiling` cannot heal this case and should not: it refuses to
    claim people for a note that never wrote a fact, visit or thread, or a
    waiting note would adopt whoever else was added that half hour. The one
    affected note was repaired by writing the record its filing would have
    written, and nothing else.
  - `scripts/pipeline-check.ts` section 14 is the regression: a filing whose
    embed throws still leaves the capture knowing every row it made, and the
    retry reuses them instead of doubling them.
- **You, rebuilt rather than ported.** The prototype's You was four toggles for
  Google Contacts, Google Calendar, Location and Push. Three of those switch
  things that do not exist, and Location is a browser permission the app does
  not own, so porting it would have shipped a screen of dead switches. What is
  there instead is what is real:
  - **The cadence.** `users.cadenceDefaults` decides who Today calls slipping
    and how warmth orders every list, and had nowhere to be seen. It is on
    screen and editable now, as one number. A judgment the user cannot see is
    not one they can argue with.
  - `PATCH /api/v1/me` calls `refreshEveryone` in `src/lib/people.ts`: warmth is
    stored, not derived on read, so changing a cadence has to rewrite every
    meter it applies to or they go on describing the old answer. Two reads and
    one write whatever the roster size, and the formula stays in `warmth.ts`;
    a second copy of it in SQL is how the two drift apart.
  - `GET /api/v1/me/export` gives back every row as one JSON file, embeddings
    stripped (derived from the text beside them, and fifty times the size).
    A private memory system you cannot get your memories out of is a worse deal
    than a notebook.
  - "Connected" is derived from the scopes Google actually granted, so it can
    never claim something that is not on. With no sensitive scopes the block
    hides entirely, the same way Today's blocks hide.
  - Sign out used to hang off the bottom of the record screen. It lives here.
  All five tabs go somewhere now; `.nv.soon` and the `Soon` component are gone.
- Not built on purpose: **delete everything**. The prototype promises it in one
  tap. It is the one irreversible button in the app and wants a typed
  confirmation and a deliberate conversation, not a quiet ship.

Not built yet:

- Deleting the account and everything in it. See the note above.
- Marking a thread done; merging or deleting people.
- PWA manifest and service worker
- Web push
- Post-meeting prompts from calendar events
- The nightly cron does nothing yet: `scheduled()` is a stub so the trigger
  has a handler.

## Build order

Do not skip ahead. Each step is testable on its own.

1. Phase 0 in `docs/SETUP.md`: accounts, keys, migrations, a deployed URL that
   Google sign-in works on. Nothing else until this is done.
2. Record and upload. `MediaRecorder` + geolocation, POST to
   `/api/v1/captures`. Verify with `wrangler tail kith-processor`.
3. The confirmation screen. Render the `extraction` JSON from the capture row.
   This screen decides whether the product feels like magic or homework.
   Built; see above.
4. Person detail, read only. Built; see above.
5. Search. Built; see above.
6. Then, and only then, Google Calendar and Contacts sync.

After step 5 the build order stops being the thing that decides what is next.
What Jordan hits while using it does. Build what use surfaced; leave what only
a roadmap wants until he feels its absence. If he stops using it, no feature
saves it.

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
- Anything that writes rows must record that it wrote them before it can fail.
  Filing tells the capture which people it is about to create, then creates
  them in one statement. A half-finished write that leaves no trace is how a
  retry doubles a roster.
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
- Google ships two products with almost the same name and a separate switch
  for each: "Places API" (legacy, closed to new projects) and "Places API
  (New)". `src/lib/places.ts` calls the second
  (`places.googleapis.com/v1/places:searchNearby`). Enabling the wrong one
  answers 403 with the key working perfectly. Every failure in that branch is
  logged now, so `wrangler tail kith-processor` says which of the three
  reasons it was.
- Neon's HTTP driver has no interactive transactions, so a route that writes N
  rows one at a time is N chances to be cancelled halfway. Batch the insert.
- Whisper mangles unusual names unless you pass the contact list as a prompt
  hint. That is already wired in `transcribe.ts`. Do not remove it.
- Calendar and Contacts read are **sensitive** scopes: 100-user cap until
  verified, and verification is a form plus a demo video. Gmail is
  **restricted** and triggers an annual security assessment. Do not add Gmail
  scopes.

## Working from a Claude Code session

What the remote session can and cannot do, learned the slow way. Jordan does
not use a terminal; everything below runs from the session, and he says yes
or no.

- `CLOUDFLARE_API_TOKEN`, `DATABASE_URL` (pooled) and `DIRECT_URL` are set.
  `npm run deploy`, `npm run deploy:worker`, `wrangler tail`, and
  `wrangler secret list` all work from here. Secret values never appear
  anywhere; only Jordan holds them.
- Raw Postgres (port 5432) is blocked: `psql` and `npm run db:migrate` hang.
  Neon's HTTPS driver is fine. Migrate with `npm run db:migrate:http`
  (dry run) then `npm run db:migrate:http -- --apply`; it writes the same
  journal drizzle-kit does. Query ad hoc with a few lines of
  `@neondatabase/serverless` in a scratch file, never by printing the URL.
- Outbound HTTPS goes through a proxy. Node scripts need
  `NODE_USE_ENV_PROXY=1` in front of them (the pipeline check included).
  Chromium's own TLS gets reset by that proxy until this policy file exists:
  `/etc/chromium/policies/managed/kith.json` containing
  `{"PostQuantumKeyAgreementEnabled": false, "EncryptedClientHelloEnabled": false}`.
  Playwright's browser is preinstalled at `/opt/pw-browsers/chromium`; use
  `playwright-core` with that path, never `playwright install`.
- Test every step against the deployment before saying it works:
  `NODE_USE_ENV_PROXY=1 npm run live:check`. It signs in with a temporary
  `sessions` row (the cookie is `__Secure-authjs.session-token` = the row's
  token), makes one note, drives the screen, checks the database, and
  deletes exactly what it made. Extend it for each new screen. Delete only
  rows you created, by id or by the `PIPELINE CHECK` marker, never "since
  the run started". Labels are uppercased by CSS, so an assertion on
  `innerText()` compares case-insensitively. `BASE=` points it at another
  origin.
- Screens can be checked before a deploy against a local server on the
  real database, read paths only:
  `NODE_USE_ENV_PROXY=1 AUTH_SECRET=local AUTH_URL=http://localhost:3100 AUTH_TRUST_HOST=true AUTH_GOOGLE_ID=local AUTH_GOOGLE_SECRET=local npx next dev -p 3100`,
  then a temporary `sessions` row exactly as the live check makes one (over
  http the cookie is `authjs.session-token`, no `__Secure-` prefix). A note
  posted locally has no queue consumer, so only reading works there.
  Playwright needs `PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK=1`
  and `proxy: { server: HTTPS_PROXY, bypass: "localhost,127.0.0.1" }`, or
  Chromium sends localhost through the proxy and gets a 405. Hide Next's
  dev button before a screenshot with `nextjs-portal{display:none}`. Stop
  the server by the PID in its own log lines (`(node:PID)`).
- The model keys live only on kith-processor. The app reaches embeddings
  through the `PROCESSOR` service binding. Do not copy keys to the app.
- Re-running extraction on a real note is `POST /api/v1/captures/:id/rerun`
  with a temporary session; it always stops at needs_review. Ask first.
- Never `pkill -f` anything; it has matched the session's own shell. Kill by
  PID or by port.
- Stops that need a yes: a migration, and anything that destroys data Jordan
  cannot get back. He has since said deploys, prompt changes and ordinary
  building do not need asking, only telling: show the prompt wording in the
  report rather than waiting on it. Never re-run extraction on a note he is
  in the middle of reviewing.

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
--clay --verdigris --sky --wisteria   coloured the five circles. Circles are
                                      gone. Only verdigris is still used (the
                                      "why" line); the rest wait for a use.
```

Type: **Fraunces** for names and headings, **Schibsted Grotesk** for interface
text, **DM Mono** for anything countable (dates, distances, confidence,
status). All three from Google Fonts.

Hard rules. Breaking one of these is a bug, not a preference:

- **No cards.** List items are rows on the ground separated by 1px hairlines.
  No fills, no borders around content, no elevation.
- **No colored left rails**, and no colour that means a group. The app has no
  groups of its own to signal: a person's initials square is one colour for
  everyone. Their tags are their groups, and tags are words.
- **border-radius: 0** everywhere except the record button and the mic button,
  which are circles because a circle means "press me."
- **No pill chips.** Filters are text with an animated underline on the active
  one.
- **Warmth is a 2px meter**, never a ring around an avatar.
- Coral is reserved for overdue. Nothing else in the app may be that
  saturated. The prototype's stop button while recording is coral; the app
  uses parchment there instead, on purpose, so this rule holds everywhere.
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
