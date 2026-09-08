# Kith, step 5: search

Paste everything below this line into a fresh Claude Code session on this
repository. It is written to be read by that session, not by you.

---

Kith, step 5: search.

Read CLAUDE.md, README.md, and docs/SETUP.md first. CLAUDE.md must have a
section called "Working from a Claude Code session" and a block that begins
"Built, step 4 of the build order". If either is missing, stop and tell me;
the step 4 pull request has not been merged. Then open prototype/index.html
and read the search view, the function search(), lines 1067 to 1099, and the
DEMO_QUERIES block near line 631. Tell me your plan before you write
anything.

WHERE THINGS STAND

Steps 0 through 4 are merged to main and deployed. main is what is live.

- https://withkith.app. /record captures. /notes/[id] is the confirmation
  screen. /people is the list with circle and tag filters. /people/[id] is
  the person page, read only. The tab bar has People and Record live;
  Today, Find and You are dimmed placeholders in src/components/TabBar.tsx.
- GET /api/v1/search exists from the foundation and has never run in
  production. It calls embed() with an OpenAI key the app does not hold.
  The confirm route shows the right pattern: embedVia(env.PROCESSOR, texts)
  through the service binding. Model keys live on the processor only.
- My data: about 40 people, about 50 facts, all embedded at filing, a few
  visits, no places. Treat it as mine, not test data.
- src/lib/store.ts is the seam. Views call the store, never fetch. Add
  search there, matching shapes in both stores. PersonRow is the row shape
  the people list uses; src/components/PersonRow.tsx renders it.
- NODE_USE_ENV_PROXY=1 npm run live:check drives the deployment in a
  headless browser and cleans up after itself. Extend it for the Find
  screen. Read the guard in section E before touching anything: the test
  note must never file onto my real people.

WHAT STEP 4 TAUGHT US

- The extraction model matched three invented test people to three of my
  real people on their roles alone, and the check filed onto them. Any
  fixture that describes a person must describe nobody real, and nothing
  files onto a matched person without a look.
- Labels are uppercased by CSS. Assertions on innerText compare
  case-insensitively.
- Screens can be screenshotted before a deploy against a local server on
  the real database. CLAUDE.md has the exact command. Only reads work
  there.

DECISIONS

1. Search is hybrid, as written: trigram on names for when I remember the
   name, cosine over facts and visits for when I do not. Every result
   carries why it matched, and the screen shows that line. It is what makes
   the answer trustworthy instead of magic.
2. The Find tab goes live. Today and You stay placeholders.
3. With an empty field, the prototype shows "Try one" with a few example
   phrasings. Draw them from my own data or show none. Do not invent
   people.
4. Location adds to ranking, never filters.
5. No editing, no marking done, no new tables. If search needs a migration,
   stop and say why before writing it.

GOAL FOR THIS SESSION

- API: GET /api/v1/search?q= working in production through the processor
  binding, tenant scoped, returning people in the PersonRow shape with a
  why line and a score. Names, facts and visits all searchable. An empty or
  one-character query returns an empty list, not an error. A signed-out
  call is a 401.
- Screen: the Find tab at /find, ported from the prototype: the field with
  the gold underline on focus, results as person rows opening the person
  page, the why line under each, and the empty state "Nothing yet. Kith
  only knows what you have told it."
- Tested against the real deployment with the live check before you tell
  me it works. Screenshots before you ask me to deploy.

Stop there. Do not build Today. After this step I use it for two weeks
before anything else gets added.

WARNINGS

- Before deploying, running a migration, re-running extraction on my real
  notes, or changing the extraction prompt, say what is about to happen
  and wait for my yes.
- Tests against the database run against my real notes. Delete only rows
  you created, by id or by marker. Never file a test note onto a matched
  person.
- Never pkill -f. Kill by PID or by port.

HOW TO WORK WITH ME

I am not a developer. I design the product and make the calls. I do not
use a terminal; everything runs from your session and I say yes or no.

- One step at a time. Do the step, tell me what happened, wait for me.
- When something needs me in a browser, tell me exactly where to tap.
- Never ask me to paste a secret, and never print one.
- No em dashes.
- Screenshots of any new screen before you ask me to deploy it.
