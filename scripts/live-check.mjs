/**
 * Drives the DEPLOYED app end to end in a headless browser, as a thumb would.
 *
 * It signs in by inserting a temporary row in `sessions` for the first user
 * (that is how Auth.js database sessions work: the cookie is the row's
 * token), types one note with three invented people so it waits for review,
 * opens it, fixes it on the screen, files it, reopens it, re-runs it, reads
 * the people it made, then searches for them. It checks the database at every
 * step. Then it deletes exactly what it made: the capture, the people that
 * filing created, the one place and the second account the search section
 * needs, and the session row.
 *
 *   npm run live:check
 *
 * Needs DATABASE_URL. Chromium comes from PLAYWRIGHT_BROWSERS_PATH or
 * CHROMIUM_PATH. Set RELAY=1 to route the browser's requests through Node's
 * fetch when the browser's own TLS cannot get out (see CLAUDE.md).
 * Screenshots land in OUT (default .wrangler/tmp/live-check).
 *
 * BASE points it at a different origin. Against a local `next dev` the
 * capture pipeline has no consumer, so only the read-only parts work there;
 * the whole run needs the deployment.
 */
import { chromium } from "playwright-core";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { neon } from "@neondatabase/serverless";

const url = process.env.DATABASE_URL?.trim();
if (!url) throw new Error("DATABASE_URL is not set");
const sql = neon(url);
const q = (text, params = []) => sql.query(text, params);

const BASE = process.env.BASE ?? "https://withkith.app";
const SECURE = BASE.startsWith("https:");
const HOST = new URL(BASE).hostname;
// Playwright sends loopback through the proxy unless told not to.
process.env.PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK ??= "1";
const OUT = process.env.OUT ?? ".wrangler/tmp/live-check";
mkdirSync(OUT, { recursive: true });
const CHROMIUM = process.env.CHROMIUM_PATH ?? `${process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/opt/pw-browsers"}/chromium`;
// Invented people with invented roles. One run matched the earlier wording
// ("runs the AV setup", "brings the bagels", "handles cleanup") to three of
// the user's real people on their roles alone, so nothing here may describe
// anyone real, and the guard below refuses to file onto a matched person.
const NOTE = "Lunch with the Kith test group today. Kith Test Alpha runs the projector and just moved here from Denver. Kith Test Bravo brings the kolaches every month, his daughter is starting at SMU this fall. Kith Test Charlie locks up afterward and mentioned he flies a Cirrus out of Addison. I told Bravo I'd send him the SMU parking guide by Friday. Somebody mentioned a golf tournament in October but I missed who.";

let failures = 0;
const check = (label, ok, detail) => { console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${ok || detail === undefined ? "" : `  ->  ${JSON.stringify(detail).slice(0, 300)}`}`); if (!ok) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const [user] = await q("select id, email from users order by created_at limit 1");
const token = randomUUID();
await q("insert into sessions (session_token, user_id, expires) values ($1, $2, now() + interval '2 hours')", [token, user.id]);
console.log(`temporary session for ${user.email}`);

const browser = await chromium.launch({
  executablePath: CHROMIUM, headless: true, args: ["--no-sandbox"],
  ...(process.env.HTTPS_PROXY ? { proxy: { server: process.env.HTTPS_PROXY, bypass: "localhost,127.0.0.1" } } : {}),
});
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const COOKIE = `${SECURE ? "__Secure-" : ""}authjs.session-token`;
await context.addCookies([{ name: COOKIE, value: token, domain: HOST, path: "/", httpOnly: true, secure: SECURE, sameSite: "Lax" }]);
// Chromium's own TLS is reset by this session's egress proxy, while Node's
// fetch goes through fine. So every browser request is answered by Node:
// same URL, method, headers, body, and the session cookie, with redirects
// handed back to the browser to follow. The app cannot tell the difference.
const cookieHeader = `${COOKIE}=${token}`;
if (process.env.RELAY) await context.route("**/*", async (route) => {
  const req = route.request();
  const url = req.url();
  try {
    if (!url.startsWith(BASE)) {
      if (!/fonts\.g(oogleapis|static)\.com/.test(url)) { console.log("  aborted:", url.slice(0, 100)); return route.abort(); }
      const r = await fetch(url, { redirect: "manual" });
      return route.fulfill({ status: r.status, headers: plain(r.headers), body: Buffer.from(await r.arrayBuffer()) });
    }
    const headers = { ...req.headers(), cookie: cookieHeader };
    delete headers["content-length"];
    const r = await fetch(url, { method: req.method(), headers, body: req.postDataBuffer() ?? undefined, redirect: "manual" });
    return route.fulfill({ status: r.status, headers: plain(r.headers), body: Buffer.from(await r.arrayBuffer()) });
  } catch (e) {
    console.log("  relay error:", url.slice(0, 80), e.message);
    return route.abort();
  }
});
function plain(h) {
  const out = {};
  h.forEach((v, k) => { if (!["content-encoding", "content-length", "transfer-encoding", "set-cookie"].includes(k)) out[k] = v; });
  return out;
}
const page = await context.newPage();
page.setDefaultTimeout(30000);
page.on("pageerror", (e) => console.log("  page error:", e.message));
page.on("console", (m) => { if (m.type() === "error") console.log("  console error:", m.text().slice(0, 200), m.location()?.url?.slice(0, 120) ?? ""); });
page.on("requestfailed", (r) => console.log("  request failed:", r.url().slice(0, 120), r.failure()?.errorText));

let captureId = null;
let createdIds = [];
// Section K makes these and section L removes them, whatever happens in between.
let placeId = null;
let otherUserId = null;
try {
  /* A. auth and the new GET route on a real note, read only */
  const list = await page.request.get(`${BASE}/api/v1/captures`);
  check("GET /api/v1/captures with the temp session is 200", list.status() === 200, list.status());
  const rows = (await list.json()).captures;
  // The note this run drives on screen: the one with the most people on it.
  const legacy = rows.find((c) => c.extraction && c.extraction.people.length > 5) ?? rows[0];
  const detail = await page.request.get(`${BASE}/api/v1/captures/${legacy.id}`);
  check("GET /api/v1/captures/:id is 200", detail.status() === 200, detail.status());
  const dj = await detail.json();
  check("roster and suggestions come back", Array.isArray(dj.people) && dj.people.length > 30 && typeof dj.suggestions === "object", dj.people?.length);

  // Reconstruction is for notes filed before captures.filing existed. Once
  // every note has a real record there is nothing left to reconstruct, so
  // this asks the database whether the case still exists before asserting it.
  const [unrecorded] = await q("select id from captures where user_id = $1 and filing is null and status = 'filed' order by captured_at limit 1", [user.id]);
  if (unrecorded) {
    const rj = await (await page.request.get(`${BASE}/api/v1/captures/${unrecorded.id}`)).json();
    check("a note filed before the filing record existed reconstructs one", rj.capture.filing?.by === "legacy" && rj.capture.filing.created.length > 0, rj.capture.filing);
  } else {
    console.log("  (no notes left without a filing record; nothing to reconstruct)");
  }
  const bad = await page.request.get(`${BASE}/api/v1/captures/not-a-uuid`);
  check("a malformed id is a 404, not a 500", bad.status() === 404, bad.status());
  const anon = await (await browser.newContext()).request.get(`${BASE}/api/v1/captures/${legacy.id}`);
  check("signed out is a 401", anon.status() === 401, anon.status());

  /* B. the record screen */
  await page.goto(`${BASE}/record`, { waitUntil: "networkidle" });
  await page.screenshot({ path: `${OUT}/01-record.png`, fullPage: true });
  const bar = await page.locator(".bar").innerText();
  // Against the real number, not against there being one: with nothing waiting
  // the strip is meant to say nothing at all.
  const waitingBefore = Number((await q("select count(*) n from captures where user_id = $1 and status = 'needs_review'", [user.id]))[0].n);
  check("the status bar says what is waiting, and stays quiet when nothing is",
    waitingBefore ? new RegExp(`${waitingBefore} to review`, "i").test(bar) : !/to review/i.test(bar), [bar, waitingBefore]);
  check("Recent rows are links to notes", (await page.locator("a.row[href^='/notes/']").count()) >= 3);

  /* C. a real legacy note opens read only */
  await page.goto(`${BASE}/notes/${legacy.id}`, { waitUntil: "networkidle" });
  await page.waitForSelector(".pb", { timeout: 20000 });
  await page.screenshot({ path: `${OUT}/02-legacy-note.png`, fullPage: false });
  check("legacy note renders person blocks", (await page.locator(".pb").count()) === legacy.extraction.people.length, await page.locator(".pb").count());
  const waits = dj.capture.status === "needs_review";
  check(`primary button reads ${waits ? "File it" : "Done"} for a ${dj.capture.status} note`,
    (await page.locator("button.btn").first().innerText()).trim() === (waits ? "File it" : "Done"));

  /* D. type a note that waits (three new people) */
  await page.goto(`${BASE}/record`, { waitUntil: "networkidle" });
  await page.getByText("Type or paste it instead").click();
  await page.locator("textarea.note").fill(NOTE);
  await page.getByRole("button", { name: "No place" }).click();
  await page.locator("button.btn", { hasText: "File it" }).click();
  await page.waitForSelector(".toast.up", { timeout: 15000 });
  const after = await (await page.request.get(`${BASE}/api/v1/captures`)).json();
  const mine = after.captures.find((c) => c.rawText === NOTE);
  check("the note was accepted", !!mine, after.captures.length);
  captureId = mine.id;
  console.log(`  capture ${captureId}`);
  let status = mine.status;
  for (let i = 0; i < 40 && ["uploaded", "transcribing", "extracting"].includes(status); i++) {
    await sleep(3000);
    status = (await (await page.request.get(`${BASE}/api/v1/captures/${captureId}`)).json()).capture.status;
  }
  check("three new people: it waits at needs_review", status === "needs_review", status);
  const [pre] = await q("select (select count(*) from facts where capture_id = $1) f, (select count(*) from people where display_name like 'Kith Test%' and user_id = $2) p", [captureId, user.id]);
  check("nothing filed while waiting", Number(pre.f) === 0 && Number(pre.p) === 0, pre);
  await page.screenshot({ path: `${OUT}/03-record-after.png`, fullPage: true });

  /* E. the confirmation screen, driven like a thumb would */
  await page.locator(`a.row[href='/notes/${captureId}']`).click();
  await page.waitForSelector(".pb", { timeout: 20000 });
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/04-note-waiting.png`, fullPage: true });
  const x = (await (await page.request.get(`${BASE}/api/v1/captures/${captureId}`)).json()).capture.extraction;
  console.log(`  extraction: ${x.people.length} people, ${x.facts.length} facts, ${x.interactions.length} interactions, ${x.threads.length} threads, ${x.unresolved.length} loose`);
  console.log(`  people: ${x.people.map((p) => `${p.name} (${p.isNew ? "new" : "match"} ${Math.round(p.confidence * 100)}%)`).join("; ")}`);
  console.log(`  facts: ${x.facts.map((f) => `${f.personName}: ${f.content}`).join(" | ")}`);
  console.log(`  threads: ${x.threads.map((t) => `${t.personName}: ${t.title} due ${t.dueAt}`).join(" | ")}`);
  console.log(`  loose: ${x.unresolved.join(" | ")}`);
  const h1 = (await page.locator("h1").innerText()).replace(/\s+/g, " ");
  check("headline is the prototype's", /Here.s what I got/.test(h1), h1);
  const blocks = page.locator(".pb");
  check("one block per person", (await blocks.count()) === x.people.length);

  // The model may match the test people to the user's own people. Point
  // every matched person at "someone new" through the picker, then prove
  // that every block reads New before a single tap that leads to File it.
  // Filing onto a real row would change their circle, tags and warmth, and
  // cleanup cannot put those back.
  for (let i = 0; i < x.people.length; i++) {
    if (!x.people[i].matchedPersonId) continue;
    console.log(`  ${x.people[i].name} was matched to an existing person; choosing someone new instead`);
    await blocks.nth(i).locator(".act", { hasText: "Someone else" }).click();
    await blocks.nth(i).locator(".picker button.row", { hasText: "Someone new" }).click();
  }
  const statuses = [];
  for (let i = 0; i < x.people.length; i++) statuses.push((await blocks.nth(i).locator(".meta").first().locator("span").first().innerText()).trim());
  const allNew = statuses.every((t) => /^(new\b|not sure)/i.test(t));
  check("every person on the test note is new, none of the user's own", allNew, statuses);
  if (!allNew) throw new Error("refusing to file: the test note would land on the user's own people");

  // circle taps: first person Work, second Friends
  await blocks.nth(0).locator(".circles button", { hasText: "Work" }).click();
  await blocks.nth(1).locator(".circles button", { hasText: "Friends" }).click();
  check("circle tap underlines the choice", /^work$/i.test((await blocks.nth(0).locator(".circles button[aria-pressed='true']").innerText()).trim()));
  // drop the first fact of the second person, if any
  const bravoFacts = blocks.nth(1).locator(".item");
  const droppedFact = (await bravoFacts.count()) ? await bravoFacts.nth(0).locator(".it").innerText() : null;
  if (droppedFact) await bravoFacts.nth(0).locator(".act").click();
  // correct the first person's first fact in place. The model is nearly right
  // often enough that dropping a whole fact to fix one word was the wrong and
  // only choice; this proves the corrected words are what file.
  const MARK = "Corrected on the screen.";
  const alphaFacts = blocks.nth(0).locator(".item");
  let editedFact = null;
  if (await alphaFacts.count()) {
    const was = (await alphaFacts.nth(0).locator(".it").innerText()).trim();
    editedFact = `${was} ${MARK}`;
    await alphaFacts.nth(0).locator(".it-tap").click();
    await page.waitForSelector(".item .ie", { timeout: 10000 });
    await alphaFacts.nth(0).locator(".ie").fill(editedFact);
    await alphaFacts.nth(0).locator(".acts .act", { hasText: "Done" }).click();
    await page.waitForTimeout(200);
    check("the correction replaces the model's words on the screen", (await alphaFacts.nth(0).locator(".it").innerText()).includes(MARK));
    check("and the row says it was edited", (await alphaFacts.nth(0).locator(".edited").count()) === 1);
  }

  // move a follow-up's due date. "By Friday" landing on Saturday used to cost
  // you the whole thread; now it costs a tap.
  const DUE_DAY = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
  let movedDue = false;
  // Index into `.item` rather than into a filtered list: opening a row swaps
  // its text for a textarea, so anything filtered on `.it-tap` shifts under you.
  const itemRows = page.locator(".item");
  for (let i = 0, n = await itemRows.count(); i < n; i++) {
    const row = itemRows.nth(i);
    if (!(await row.locator(".it-tap").count())) continue;
    if (!/^(due|follow-up)/i.test((await row.locator(".ik").innerText()).trim())) continue;
    await row.locator(".it-tap").click();
    await page.waitForSelector(".item .ie", { timeout: 10000 });
    const open = page.locator(".item").filter({ has: page.locator(".ie") });
    if ((await page.locator(".ie-when").count()) && /due/i.test(await page.locator(".ie-when").innerText())) {
      await page.locator(".ie-when input").fill(DUE_DAY);
      await open.locator(".acts .act", { hasText: "Done" }).click();
      await page.waitForTimeout(250);
      movedDue = true;
      check("moving a due date relabels the row", (await row.locator(".ik").innerText()).trim().toLowerCase().startsWith("due"));
      break;
    }
    await open.locator(".acts .act", { hasText: "Cancel" }).click();
    await page.waitForTimeout(150);
  }
  check("a follow-up offered its due date to be moved", movedDue || !x.threads.length, x.threads.length);

  // leave the third person out
  if (x.people.length > 2) await blocks.nth(2).locator(".act", { hasText: "Leave out" }).click();
  check("left out block fades", x.people.length > 2 ? await blocks.nth(2).evaluate((el) => el.classList.contains("out")) : true);
  // dismiss the first loose thread, if any
  if (x.unresolved.length) await page.locator(".loose").first().locator(".act", { hasText: "Dismiss" }).click();
  // tags: whatever the model proposed shows as text; "+ tag" adds one by typing
  const proposed = await blocks.nth(0).locator(".tg span:first-child").allInnerTexts();
  console.log(`  tags proposed for ${x.people[0].name}: ${proposed.join(", ") || "(none)"}`);
  await blocks.nth(0).locator(".act", { hasText: "+ tag" }).click();
  await page.locator(".picker input").fill("Kith Test Board");
  await page.locator(".picker input").press("Enter");
  check("typed tag appears on the person", (await blocks.nth(0).locator(".tg span:first-child").allInnerTexts()).some((t) => /kith test board/i.test(t)));
  // the second person gets the same tag from the suggestions, one tap
  await blocks.nth(1).locator(".act", { hasText: "+ tag" }).click();
  const suggestion = page.locator(".picker .meta .act", { hasText: /kith test board/i });
  check("the tag just typed is offered to the next person", (await suggestion.count()) === 1);
  await suggestion.click();
  // remove one tag from the second person, if the model proposed any, so the × path runs
  const bravoTags = blocks.nth(1).locator(".tg");
  const bravoBefore = await bravoTags.count();
  if (bravoBefore > 1) await bravoTags.nth(0).locator("button").click();
  check("× removes a tag", (await bravoTags.count()) === Math.max(1, bravoBefore - 1), await bravoTags.count());
  // the picker opens inline and closes
  await blocks.nth(0).locator(".act", { hasText: "Someone else" }).click();
  check("picker opens inline with a search field", (await page.locator(".picker input").count()) === 1);
  await page.locator(".picker input").fill("zzzz-nobody");
  check("picker says nobody by that name", /Nobody/.test(await page.locator(".picker").innerText()));
  await page.locator(".picker .act", { hasText: "Cancel" }).click();
  await page.screenshot({ path: `${OUT}/05-note-edited.png`, fullPage: true });

  await page.locator("button.btn", { hasText: "File it" }).click();
  await page.waitForURL(`${BASE}/record`, { timeout: 30000 });
  await page.waitForSelector(".toast.up", { timeout: 10000 });
  const toast = await page.locator(".toast").innerText();
  check("File it lands back on Recent with the toast", /^Filed\./.test(toast), toast);
  await page.screenshot({ path: `${OUT}/06-filed-toast.png`, fullPage: false });

  /* F. what landed */
  const [cap] = await q("select status, filing, place_id from captures where id = $1", [captureId]);
  check("status filed by user", cap.status === "filed" && cap.filing?.by === "user", [cap.status, cap.filing?.by]);
  createdIds = cap.filing?.created.map((c) => c.personId) ?? [];
  const ppl = await q("select id, display_name, circle from people where id = any($1::uuid[])", [createdIds]);
  check("two people created, the third left out", ppl.length === Math.max(0, x.people.length - 1) && !ppl.some((p) => p.display_name === x.people[2]?.name), ppl);
  check("circles came from the taps", ppl.find((p) => p.display_name === x.people[0].name)?.circle === "work" && ppl.find((p) => p.display_name === x.people[1].name)?.circle === "friends", ppl);
  const tagged = await q("select display_name, tags from people where id = any($1::uuid[])", [createdIds]);
  check("typed tag landed on both people, one spelling", tagged.every((p) => p.tags.some((t) => t === "Kith Test Board")), tagged);
  const f = await q("select content, person_id from facts where capture_id = $1", [captureId]);
  check("dropped fact stayed out", !droppedFact || !f.some((r) => r.content === droppedFact), f.map((r) => r.content));
  check("the corrected fact is what filed, once", !editedFact || f.filter((r) => r.content.includes(MARK)).length === 1, f.map((r) => r.content));
  if (movedDue) {
    const [t] = await q("select to_char(due_at at time zone 'UTC', 'YYYY-MM-DD') d from threads where created_from_capture_id = $1 and due_at is not null limit 1", [captureId]);
    check("the due date you set is the one stored", t?.d === DUE_DAY, [t?.d, DUE_DAY]);
  }
  check("facts carry embeddings from the processor over the binding", Number((await q("select count(*) n from facts where capture_id = $1 and embedding is not null", [captureId]))[0].n) === f.length, f.length);
  const loose = await q("select content, dismissed_at from loose_threads where capture_id = $1", [captureId]);
  check("first loose thread dismissed", !x.unresolved.length || loose.some((l) => l.dismissed_at != null), loose);
  const [bar2] = [await page.locator(".bar").innerText()];
  check("review count is back to what it was before the note",
    waitingBefore ? new RegExp(`${waitingBefore} to review`, "i").test(bar2) : !/to review/i.test(bar2), [bar2, waitingBefore]);

  /* G. reopen as filed, change one thing, Done */
  await page.goto(`${BASE}/notes/${captureId}`, { waitUntil: "networkidle" });
  await page.waitForSelector(".pb", { timeout: 20000 });
  const h1b = (await page.locator("h1").innerText()).replace(/\s+/g, " ");
  check("filed note reads 'Here's what I filed' with Done", /I filed/.test(h1b) && (await page.locator("button.btn").first().innerText()).trim() === "Done", h1b);
  check("left-out person still shows as left out", x.people.length > 2 ? await page.locator(".pb").nth(2).evaluate((el) => el.classList.contains("out")) : true);
  await page.screenshot({ path: `${OUT}/07-note-filed.png`, fullPage: true });
  await page.locator(".pb").nth(1).locator(".circles button", { hasText: "Neighbors" }).click();
  await page.locator("button.btn", { hasText: "Done" }).click();
  await page.waitForURL(`${BASE}/record`, { timeout: 30000 });
  const ppl2 = await q("select display_name, circle from people where id = any($1::uuid[])", [createdIds]);
  check("Done re-filed: circle changed, still the same two rows", ppl2.length === ppl.length && ppl2.find((p) => p.display_name === x.people[1].name)?.circle === "neighbors", ppl2);
  const [cnt] = await q("select (select count(*) from facts where capture_id = $1) f, (select count(*) from loose_threads where capture_id = $1) l", [captureId]);
  check("re-file did not duplicate rows", Number(cnt.f) === f.length && Number(cnt.l) === loose.length, cnt);

  /* H. Read it again: the rerun path the legacy notes will use */
  const rr = await page.request.post(`${BASE}/api/v1/captures/${captureId}/rerun`);
  check("rerun accepted", rr.status() === 202, rr.status());
  // The queue backs off 30s then 60s before a second attempt, so a re-run that
  // hits one slow model call needs more than two minutes to come back.
  let s2 = "uploaded";
  for (let i = 0; i < 60 && s2 !== "needs_review" && s2 !== "failed"; i++) {
    await sleep(5000);
    s2 = (await q("select status from captures where id = $1", [captureId]))[0].status;
  }
  const [cap2] = await q("select status, filing, jsonb_array_length(extraction->'people') n from captures where id = $1", [captureId]);
  check("re-run stops at needs_review, keeps what it created, drops old decisions", cap2.status === "needs_review" && cap2.filing?.decisions === null && cap2.filing?.created.length === createdIds.length, [cap2.status, cap2.filing]);
  check("old rows kept until the next look", Number((await q("select count(*) n from facts where capture_id = $1", [captureId]))[0].n) === f.length);
  if (cap2.status === "needs_review") {
    await page.goto(`${BASE}/notes/${captureId}`, { waitUntil: "networkidle" });
    await page.waitForSelector(".pb", { timeout: 20000 });
    await page.screenshot({ path: `${OUT}/08-note-rerun.png`, fullPage: true });
    check("re-run note shows matched people (they exist now) and File it", (await page.locator(".pb .meta .live", { hasText: /Matched/ }).count()) >= 1 && (await page.locator("button.btn").first().innerText()).trim() === "File it");
  } else {
    // Do not take the rest of the run down with it; the check above already failed.
    console.log(`  (the re-run is still ${cap2.status}; skipping its screen)`);
  }

  /* I. step 4: the people list, the person page, and the way back to the note */
  const TAG = "Kith Test Board";
  const byTag = await page.request.get(`${BASE}/api/v1/people?tag=${encodeURIComponent(TAG)}`);
  check("GET /api/v1/people?tag= is 200", byTag.status() === 200, byTag.status());
  const tj = await byTag.json();
  check("the tag filter returns exactly the people this note created", tj.people.length === createdIds.length && tj.people.every((p) => createdIds.includes(p.id) && p.tags.includes(TAG)), tj.people.map((p) => p.displayName));
  check("the list carries the user's tags and roster counts, unfiltered", tj.tags.includes(TAG) && tj.counts.people > createdIds.length && typeof tj.counts.facts === "number", { tags: tj.tags, counts: tj.counts });
  check("an unknown circle is a 400", (await page.request.get(`${BASE}/api/v1/people?circle=bogus`)).status() === 400);
  const views = [];
  for (const id of createdIds) {
    const r = await page.request.get(`${BASE}/api/v1/people/${id}`);
    check("GET /api/v1/people/:id is 200", r.status() === 200, r.status());
    views.push(await r.json());
  }
  // The created person with the most on their page is the one to drive.
  const V = views.sort((a, b) => (b.facts.length + b.threads.length + b.interactions.length) - (a.facts.length + a.threads.length + a.interactions.length))[0];
  const who = V.person;
  console.log(`  person page for ${who.displayName}: ${V.facts.length} facts, ${V.threads.length} threads, ${V.interactions.length} visits, ${V.places.length} places, ${V.notes.length} notes, cadence ${who.cadenceDays}d`);
  check("person view has every block the page renders", ["facts", "threads", "interactions", "places", "notes"].every((k) => Array.isArray(V[k])) && typeof who.cadenceDays === "number", Object.keys(V));
  check("the note that made them is in their notes", V.notes.some((n) => n.id === captureId), V.notes.map((n) => n.id));
  check("their facts and visits point back at this note", [...V.facts, ...V.interactions].every((x) => x.captureId === captureId));
  check("the circle tapped on the note is on the page", ["work", "neighbors"].includes(who.circle), who.circle);
  check("no tenant column on the person", !("userId" in who));
  check("a malformed person id is a 404", (await page.request.get(`${BASE}/api/v1/people/not-a-uuid`)).status() === 404);
  check("an unknown person id is a 404", (await page.request.get(`${BASE}/api/v1/people/00000000-0000-4000-8000-00000000dead`)).status() === 404);
  check("the person route signed out is a 401", (await (await browser.newContext()).request.get(`${BASE}/api/v1/people/${who.id}`)).status() === 401);

  // the list, filtered to this note's tag, with the tab bar
  await page.goto(`${BASE}/people?tag=${encodeURIComponent(TAG)}`, { waitUntil: "networkidle" });
  await page.waitForSelector("a.row[href^='/people/']", { timeout: 20000 });
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/09-people-tag.png`, fullPage: true });
  check("the list shows exactly this note's people under the tag", (await page.locator("a.row[href^='/people/']").count()) === createdIds.length, await page.locator("a.row[href^='/people/']").count());
  check("the tag filter is underlined", (await page.locator(".tabs.sub button[aria-pressed='true']").innerText()).trim() === TAG);
  check("the stamp counts the filtered view", /^\d+ of \d+/i.test((await page.locator(".stamp").first().innerText()).trim()), await page.locator(".stamp").first().innerText());
  check("the circle row has six words", (await page.locator(".tabs.circle-row button").count()) === 6);
  check("tab bar: People is current and the mic goes to record", (await page.locator(".nav .nv[aria-current='true']").innerText()).trim().toLowerCase() === "people" && (await page.locator(".nav a[href='/record'] .nmic").count()) === 1);
  check("tab bar: Today and You are the placeholders left", (await page.locator(".nav .nv.soon").count()) === 2 && (await page.locator(".nav a[href='/find']").count()) === 1);

  // the person page
  await page.locator(`a.row[href='/people/${who.id}']`).click();
  await page.waitForURL(`${BASE}/people/${who.id}`, { timeout: 20000 });
  await page.waitForSelector(".phead", { timeout: 20000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/10-person.png`, fullPage: true });
  check("name, circle and tag on the page", (await page.locator(".pname").innerText()).trim() === who.displayName && (await page.locator(".phead .meta").innerText()).toLowerCase().includes(TAG.toLowerCase()));
  check("stats: since seen, cadence, and warmth as a meter", (await page.locator(".stat").count()) === 3 && (await page.locator(".stat .meter").count()) === 1);
  check("Remember first lists every fact", (await page.locator(".fact").count()) === V.facts.length, await page.locator(".fact").count());
  check("open threads render with a due line", (await page.locator(".thread").count()) === V.threads.length && (V.threads.length === 0 || /Due|Overdue|No date/i.test(await page.locator(".thread .tmeta").first().innerText())), await page.locator(".thread").count());
  check("history: one entry per visit, each opening its note", (await page.locator(".tl a.ev").count()) === V.interactions.filter((x) => x.captureId).length && (await page.locator(".tl .ev").count()) === V.interactions.length, await page.locator(".tl .ev").count());
  check("the notes block links to the note", (await page.locator(`a.row[href='/notes/${captureId}']`).count()) === 1);
  check("the back link keeps the tag filter", ((await page.locator("a.back").getAttribute("href")) ?? "").includes("tag="), await page.locator("a.back").getAttribute("href"));

  // from the person to the note, and from the note back to a person
  await page.locator(`a.row[href='/notes/${captureId}']`).click();
  await page.waitForURL(`${BASE}/notes/${captureId}`, { timeout: 20000 });
  await page.waitForSelector(".pb", { timeout: 20000 });
  const links = page.locator(".pb a.nm-link[href^='/people/']");
  check("on the note, people with a row link to their page", (await links.count()) >= 1, await links.count());
  const hrefs = await links.evaluateAll((as) => as.map((a) => a.getAttribute("href") ?? ""));
  const target = hrefs.find((h) => createdIds.some((id) => h.endsWith(id))) ?? hrefs[0] ?? "";
  await page.locator(`.pb a.nm-link[href='${target}']`).first().click();
  await page.waitForURL(`${BASE}${target}`, { timeout: 20000 });
  await page.waitForSelector(".phead", { timeout: 20000 });
  check("the name on the note opens one of this note's people", createdIds.some((id) => target.endsWith(id)), target);
  await page.goto(`${BASE}/people/00000000-0000-4000-8000-00000000dead`, { waitUntil: "networkidle" });
  await page.waitForSelector(".empty", { timeout: 20000 });
  check("an unknown person is a clean empty state", /no one here/i.test(await page.locator(".empty").innerText()));

  /* K. step 5: search */
  const search = async (q, extra = "") =>
    (await page.request.get(`${BASE}/api/v1/search?q=${encodeURIComponent(q)}${extra}`)).json();

  const s0 = await page.request.get(`${BASE}/api/v1/search?q=`);
  const sj0 = await s0.json();
  check("GET /api/v1/search?q= is 200 with no results", s0.status() === 200 && Array.isArray(sj0.results) && sj0.results.length === 0, s0.status());
  check("an empty query answers with hints in the user's own words", Array.isArray(sj0.hints) && sj0.hints.length > 0 && sj0.hints.every((h) => typeof h === "string" && h.trim()), sj0.hints);
  const s1 = await page.request.get(`${BASE}/api/v1/search?q=a`);
  check("one character is an empty list, not an error", s1.status() === 200 && (await s1.json()).results.length === 0, s1.status());
  check("search signed out is a 401", (await (await browser.newContext()).request.get(`${BASE}/api/v1/search?q=test`)).status() === 401);

  // A name, by trigram.
  const byName = await search(who.displayName);
  const top = byName.results[0];
  check("a name puts that person at the top", top?.person?.id === who.id, byName.results.map((r) => r.person.displayName));
  check("the why line says the name is what caught", /their name/i.test(top?.why ?? ""), top?.why);
  check("the processor answered: this was not the names-only fallback", byName.namesOnly === undefined, byName.namesOnly);
  check("a result carries the row the people list draws, and no tenant column",
    ["id", "displayName", "goesBy", "pronunciation", "circle", "tags", "role", "lastInteractionAt", "warmth"].every((k) => k in (top?.person ?? {}))
    && typeof top?.score === "number" && !("userId" in (top?.person ?? {})), Object.keys(top?.person ?? {}));

  // Facts and visits, by cosine. Trigram never reads either one, so a hit here
  // can only have come back through the embedding kith-processor made.
  const first8 = (s) => s.split(/\s+/).slice(0, 8).join(" ");
  const fromFact = V.facts.length ? await search(first8(V.facts[0].content)) : { results: [] };
  const factHit = fromFact.results.find((r) => r.person.id === who.id);
  check("words from a fact find the person that fact is about", !!factHit, fromFact.results.map((r) => `${r.person.displayName} ${r.score}`));
  check("that why line reads it back, with the date it happened", /^(fact|visit) \//i.test(factHit?.why ?? "") && !!factHit?.at, [factHit?.why, factHit?.at]);
  const fromVisit = V.interactions.length ? await search(first8(V.interactions[0].summary)) : { results: [] };
  const visitHit = fromVisit.results.find((r) => r.person.id === who.id);
  check("words from a visit find the person you were with", !!visitHit, fromVisit.results.map((r) => `${r.person.displayName} ${r.score}`));
  const whys = [factHit?.why ?? "", visitHit?.why ?? ""];
  check("both a fact and a visit come back as themselves, so both are searchable",
    whys.some((w) => /^fact \//i.test(w)) && whys.some((w) => /^visit \//i.test(w)), whys);

  // Another account's person must never come back. The only way to prove a
  // tenant filter is to have a second tenant.
  otherUserId = randomUUID();
  await q("insert into users (id, name, email) values ($1, $2, $3)", [otherUserId, "Kith Test Other", `kith-test-${otherUserId}@example.invalid`]);
  await q("insert into people (user_id, display_name, circle, tags, role) values ($1, $2, 'other', $3, $4)",
    [otherUserId, "Kith Test Delta", [TAG], "belongs to the other account"]);
  const leak = await search("Kith Test Delta");
  check("another account's person never comes back", !leak.results.some((r) => /Delta/.test(r.person.displayName)), leak.results.map((r) => r.person.displayName));
  const leakTag = await search(TAG);
  check("nor under a tag both accounts happen to use", !leakTag.results.some((r) => /Delta/.test(r.person.displayName)), leakTag.results.map((r) => r.person.displayName));

  // Location adds to ranking and never filters. There are no places yet, so
  // this makes one and section L removes it.
  const [pl] = await q("insert into places (user_id, name, lat, lng, radius_m) values ($1, $2, $3, $4, $5) returning id",
    [user.id, "Kith Test Hall", 32.8, -96.8, 150]);
  placeId = pl.id;
  await q("insert into person_places (person_id, place_id, user_id, weight, last_seen_at) values ($1, $2, $3, 5, now())", [who.id, placeId, user.id]);
  const away = await search(TAG);
  const here = await search(TAG, "&lat=32.8&lng=-96.8");
  const wasThere = away.results.find((r) => r.person.id === who.id);
  const isThere = here.results.find((r) => r.person.id === who.id);
  check("standing at a place lifts the people you see there", !!wasThere && !!isThere && isThere.score > wasThere.score, [wasThere?.score, isThere?.score]);
  check("and the why line says where", /near kith test hall/i.test(isThere?.why ?? ""), isThere?.why);
  check("location added nobody and removed nobody", here.results.length === away.results.length, [away.results.length, here.results.length]);

  // The screen
  await page.goto(`${BASE}/find`, { waitUntil: "networkidle" });
  await page.waitForSelector(".block .row", { timeout: 20000 });
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/11-find.png`, fullPage: true });
  check("the empty field offers every hint the API sent", (await page.locator(".block .row .recall").count()) === sj0.hints.length, await page.locator(".block .row .recall").count());
  check("tab bar: Find is current, Today and You are the placeholders",
    (await page.locator(".nav .nv[aria-current='true'] .nl").innerText()).trim().toLowerCase() === "find"
    && (await page.locator(".nav .nv.soon").count()) === 2);

  await page.locator("#q").fill(who.displayName);
  await page.waitForSelector(".hit", { timeout: 20000 });
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/12-find-results.png`, fullPage: true });
  check("the result is a person row with its why line under it",
    (await page.locator(`.hit a.row[href='/people/${who.id}']`).count()) === 1
    && /their name/i.test(await page.locator(".hit .why").first().innerText()));
  check("the query is in the URL", new URL(page.url()).searchParams.get("q") === who.displayName, page.url());
  await page.locator(`.hit a.row[href='/people/${who.id}']`).click();
  await page.waitForURL(`${BASE}/people/${who.id}`, { timeout: 20000 });
  await page.goBack();
  await page.waitForSelector(".hit", { timeout: 20000 });
  check("a result opens their page, and back brings the same search up again", (await page.locator("#q").inputValue()) === who.displayName);

  await page.locator("#q").fill("zzzqqq");
  await page.waitForSelector(".empty", { timeout: 20000 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/13-find-nothing.png`, fullPage: true });
  check("nothing found says so in the app's own words", /kith only knows what you have told it/i.test(await page.locator(".empty").innerText()));

  /* L. editing who someone is */
  const BRAND = "Kith Test Brand";
  const patch = (body, id = who.id) => page.request.patch(`${BASE}/api/v1/people/${id}`, { data: body });
  const readPerson = async () => (await (await page.request.get(`${BASE}/api/v1/people/${who.id}`)).json()).person;
  const wasPerson = await readPerson();
  const edit = await patch({ displayName: `${who.displayName} Jr`, circle: "family", role: "changed by the live check", tags: [...wasPerson.tags, BRAND] });
  check("PATCH /api/v1/people/:id is 200", edit.status() === 200, edit.status());
  const nowPerson = await readPerson();
  check("name, circle, role and tags all moved",
    nowPerson.displayName === `${who.displayName} Jr` && nowPerson.circle === "family"
    && nowPerson.tags.includes(BRAND) && /live check/.test(nowPerson.role ?? ""),
    { name: nowPerson.displayName, circle: nowPerson.circle, tags: nowPerson.tags, role: nowPerson.role });
  check("the cadence follows the circle it was moved to", nowPerson.cadenceDays === 14, [wasPerson.circle, wasPerson.cadenceDays, nowPerson.circle, nowPerson.cadenceDays]);
  // An employer is a tag, which is the whole reason tags and not circles.
  check("a brand tag makes them findable by the brand", (await search(BRAND)).results.some((r) => r.person.id === who.id));
  await patch({ role: "" });
  check("an empty string clears a field", (await readPerson()).role === null);
  check("an unknown field is refused", (await patch({ nope: 1 })).status() === 400);
  check("an empty patch is refused", (await patch({})).status() === 400);
  check("a nameless person is refused", (await patch({ displayName: "   " })).status() === 400);
  check("a malformed id is a 404", (await patch({ circle: "work" }, "not-a-uuid")).status() === 404);
  check("someone else's id is a 404", (await patch({ circle: "work" }, "00000000-0000-4000-8000-00000000dead")).status() === 404);
  check("editing signed out is a 401",
    (await (await browser.newContext()).request.patch(`${BASE}/api/v1/people/${who.id}`, { data: { circle: "work" } })).status() === 401);

  // and the same thing with a thumb
  await page.goto(`${BASE}/people/${who.id}`, { waitUntil: "networkidle" });
  await page.waitForSelector(".phead", { timeout: 20000 });
  await page.locator(".phead .act", { hasText: "Edit" }).click();
  await page.waitForSelector(".pedit", { timeout: 20000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/14-person-edit.png`, fullPage: true });
  await page.locator(".pedit .field input").first().fill(`${who.displayName} Edited`);
  await page.locator(".pedit .tabs button", { hasText: "Neighbors" }).click();
  await page.locator(".pedit .act", { hasText: "Save" }).click();
  await page.waitForSelector(".pname", { timeout: 20000 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/15-person-edited.png`, fullPage: true });
  check("the screen saved the name and the circle",
    (await page.locator(".pname").innerText()).trim() === `${who.displayName} Edited`
    && /neighbors/i.test(await page.locator(".phead .meta").innerText()));
} catch (e) {
  failures++;
  console.log("  CRASH", e?.message ?? e);
  await page.screenshot({ path: `${OUT}/99-crash.png`, fullPage: true }).catch(() => {});
} finally {
  /* M. cleanup, by the ids this run made */
  if (placeId) {
    await q("delete from person_places where place_id = $1", [placeId]);
    await q("delete from places where id = $1 and user_id = $2", [placeId, user.id]);
    console.log("cleanup: the test place removed");
  }
  if (otherUserId) {
    await q("delete from users where id = $1", [otherUserId]);  // cascades their person
    console.log("cleanup: the second test account removed");
  }
  if (captureId) {
    await q("delete from facts where capture_id = $1", [captureId]);
    await q("delete from interactions where capture_id = $1", [captureId]);
    await q("delete from threads where created_from_capture_id = $1", [captureId]);
    await q("delete from captures where id = $1", [captureId]); // cascades loose_threads
    if (createdIds.length) await q("delete from people where id = any($1::uuid[]) and user_id = $2", [createdIds, user.id]);
    const strays = await q("select id from people where display_name like 'Kith Test%' and user_id = $1", [user.id]);
    if (strays.length) await q("delete from people where display_name like 'Kith Test%' and user_id = $1", [user.id]);
    for (const t of ["Kith Test Board", "Kith Test Brand"]) {
      await q("update people set tags = array_remove(tags, $2), updated_at = now() where user_id = $1 and $2 = any(tags)", [user.id, t]);
    }
    console.log(`cleanup: capture ${captureId} and ${createdIds.length + strays.length} people removed`);
  }
  await q("delete from sessions where session_token = $1", [token]);
  console.log("cleanup: temporary session removed");
  await browser.close();
  console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
}
