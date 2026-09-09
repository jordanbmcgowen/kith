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
let otherPersonId = null;
// Section S changes this on the real account; section T puts it back.
let cadenceWas = null;
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
  // Filing onto a real row would change their tags and warmth, and
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

  // No circle row to tap any more: the app invents no groups, so there is
  // nothing here but the tags the note itself proposed.
  check("the review screen offers no groups of the app's own", (await page.locator(".circles").count()) === 0);
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
    // What a fact is about is a tap too, not just its words: the model files
    // most work under "context" and that is the wrong drawer.
    check("the open editor offers what the fact is about", (await alphaFacts.nth(0).locator(".kd").count()) === 8);
    await alphaFacts.nth(0).locator(".kd", { hasText: /^work$/i }).click();
    await alphaFacts.nth(0).locator(".acts .act", { hasText: "Done" }).click();
    await page.waitForTimeout(200);
    check("the correction replaces the model's words on the screen", (await alphaFacts.nth(0).locator(".it").innerText()).includes(MARK));
    check("and the row says it was edited", (await alphaFacts.nth(0).locator(".edited").count()) === 1);
    check("the row is relabelled with the kind you picked", /^work$/i.test((await alphaFacts.nth(0).locator(".ik").innerText()).trim()));
  }

  // Add something the model never heard. Editing was only half of it: a note
  // is what you said in twenty seconds, and the rest arrives while you look
  // at the screen.
  const ADDED = "Kith test: taking the family to Banff in March, same lodge as last year.";
  await blocks.nth(0).locator(".act", { hasText: "+ note" }).click();
  await page.waitForSelector(".item .ie", { timeout: 10000 });
  const composer = blocks.nth(0).locator(".item").filter({ has: page.locator(".ie") });
  await composer.locator(".ie").fill(ADDED);
  await composer.locator(".kd", { hasText: /^travel$/i }).click();
  await composer.locator(".acts .act", { hasText: "Add" }).click();
  await page.waitForTimeout(200);
  const addedRow = blocks.nth(0).locator(".item").filter({ hasText: "Banff" });
  check("a typed note joins the person's items", (await addedRow.count()) === 1);
  check("and carries the kind it was given", /^travel$/i.test((await addedRow.locator(".ik").innerText()).trim()));
  check("a typed note is removed, not dropped: there is nothing to keep",
    (await addedRow.locator(".act", { hasText: "Remove" }).count()) === 1);

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
  // Without typing anything. The adder shows eight, the user has more than
  // that, so this only holds while the note's own tags sort to the front.
  check("the tag just typed is offered to the next person, above the user's older ones",
    (await suggestion.count()) === 1, await page.locator(".picker .meta .act").allInnerTexts());
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
  const ppl = await q("select id, display_name from people where id = any($1::uuid[])", [createdIds]);
  check("two people created, the third left out", ppl.length === Math.max(0, x.people.length - 1) && !ppl.some((p) => p.display_name === x.people[2]?.name), ppl);
  const tagged = await q("select display_name, tags from people where id = any($1::uuid[])", [createdIds]);
  check("typed tag landed on both people, one spelling", tagged.every((p) => p.tags.some((t) => t === "Kith Test Board")), tagged);
  const f = await q("select content, person_id from facts where capture_id = $1", [captureId]);
  check("dropped fact stayed out", !droppedFact || !f.some((r) => r.content === droppedFact), f.map((r) => r.content));
  check("the corrected fact is what filed, once", !editedFact || f.filter((r) => r.content.includes(MARK)).length === 1, f.map((r) => r.content));
  const kinds = await q("select content, kind, confidence from facts where capture_id = $1", [captureId]);
  check("the kind you picked is the kind stored", !editedFact || kinds.find((r) => r.content.includes(MARK))?.kind === "work",
    kinds.map((r) => [r.kind, r.content.slice(0, 30)]));
  const addedRowDb = kinds.find((r) => r.content === ADDED);
  check("the note you typed filed, under its kind and at full confidence",
    addedRowDb?.kind === "travel" && Number(addedRowDb?.confidence) === 1, addedRowDb);
  check("it landed on the person it was typed under",
    f.find((r) => r.content === ADDED)?.person_id === ppl.find((r) => r.display_name === x.people[0].name)?.id,
    [f.find((r) => r.content === ADDED)?.person_id, ppl.map((r) => r.display_name)]);
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
  await page.locator("button.btn", { hasText: "Done" }).click();
  await page.waitForURL(`${BASE}/record`, { timeout: 30000 });
  const ppl2 = await q("select display_name from people where id = any($1::uuid[])", [createdIds]);
  check("Done re-filed: still the same two rows", ppl2.length === ppl.length, ppl2);
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
  check("a leftover circle in a URL is ignored, not an error",
    (await page.request.get(`${BASE}/api/v1/people?circle=bogus`)).status() === 200);
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
  const allFacts = views.flatMap((v) => v.facts);
  check("the corrected kind and the typed note both came back on the person route",
    allFacts.some((f) => f.kind === "work" && f.content.includes(MARK)) && allFacts.some((f) => f.kind === "travel" && f.content === ADDED),
    allFacts.map((f) => [f.kind, f.content.slice(0, 28)]));
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
  check("the tag filter is underlined", (await page.locator(".tabs button[aria-pressed='true']").innerText()).trim() === TAG);
  check("the stamp counts the filtered view", /^\d+ of \d+/i.test((await page.locator(".stamp").first().innerText()).trim()), await page.locator(".stamp").first().innerText());
  // One row, holding the user's own tags and nothing the app invented.
  const words = (await page.locator(".tabs button").allInnerTexts()).map((w) => w.trim().toLowerCase());
  check("one filter row, not two", (await page.locator(".tabs").count()) === 1, await page.locator(".tabs").count());
  check("it is Everyone and then the user's tags, nothing else",
    words[0] === "everyone"
    && tj.tags.every((t) => words.includes(t.toLowerCase()))
    && words.length === 1 + tj.tags.length,
    { words, tags: tj.tags });
  check("no circle word survives anywhere in the row",
    !["family", "friends", "work", "neighbors", "other"].some((c) => words.includes(c)), words);
  check("and the list no longer reports circles at all", tj.circles === undefined, Object.keys(tj));
  check("tab bar: People is current and the mic goes to record", (await page.locator(".nav .nv[aria-current='true']").innerText()).trim().toLowerCase() === "people" && (await page.locator(".nav a[href='/record'] .nmic").count()) === 1);
  check("tab bar: all five tabs go somewhere", (await page.locator(".nav .nv.soon").count()) === 0
    && (await page.locator(".nav a").count()) === 5);

  // the person page
  await page.locator(`a.row[href='/people/${who.id}']`).click();
  await page.waitForURL(`${BASE}/people/${who.id}`, { timeout: 20000 });
  await page.waitForSelector(".phead", { timeout: 20000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/10-person.png`, fullPage: true });
  check("name and tag on the page", (await page.locator(".pname").innerText()).trim() === who.displayName && (await page.locator(".phead .meta").innerText()).toLowerCase().includes(TAG.toLowerCase()));
  check("and no circle beside them", !/family|friends|work|neighbors|other/i.test(await page.locator(".phead .meta").innerText()));
  check("stats: since seen, cadence, and warmth as a meter", (await page.locator(".stat").count()) === 3 && (await page.locator(".stat .meter").count()) === 1);
  check("every fact is on the page", (await page.locator(".fact").count()) === V.facts.length, await page.locator(".fact").count());
  // Facts are grouped by what they are about. Which blocks appear is decided
  // by this person's own facts, so the assertion reads the data rather than
  // assuming which of the test people the run ended up driving.
  const SECTIONS = {
    "Remember first": ["identity", "sensitive", "preference", "history", "context"],
    "Work": ["work"], "Family and friends": ["relation"], "Travel": ["travel"],
  };
  const want = Object.entries(SECTIONS).filter(([, ks]) => V.facts.some((f) => ks.includes(f.kind))).map(([l]) => l.toLowerCase());
  // A label carries its count in a span; innerText glues them together.
  const labels = (await page.locator(".block .label").allInnerTexts()).map((t) => t.replace(/[\s\d]+$/, "").trim().toLowerCase());
  check("facts are grouped under what they are about", want.every((l) => labels.includes(l)), { want, labels });
  // One list broken into subjects, so the numbering runs down the page rather
  // than restarting in every block.
  const nums = (await page.locator(".fact .i").allInnerTexts()).map((t) => t.trim());
  check("facts are numbered straight down the page, not per block",
    nums.join(",") === V.facts.map((_, i) => String(i + 1).padStart(2, "0")).join(","), nums);
  check("and a group with nothing in it is not drawn",
    Object.keys(SECTIONS).map((l) => l.toLowerCase()).filter((l) => !want.includes(l)).every((l) => !labels.includes(l)),
    { want, labels });
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
    ["id", "displayName", "goesBy", "pronunciation", "tags", "role", "lastInteractionAt", "warmth"].every((k) => k in (top?.person ?? {}))
    && !("circle" in (top?.person ?? {}))
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
  const [delta] = await q("insert into people (user_id, display_name, tags, role) values ($1, $2, $3, $4) returning id",
    [otherUserId, "Kith Test Delta", [TAG], "belongs to the other account"]);
  otherPersonId = delta.id;
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
  check("tab bar: Find is current, and nothing is dimmed",
    (await page.locator(".nav .nv[aria-current='true'] .nl").innerText()).trim().toLowerCase() === "find"
    && (await page.locator(".nav .nv.soon").count()) === 0);

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
  const edit = await patch({ displayName: `${who.displayName} Jr`, cadenceDays: 7, role: "changed by the live check", tags: [...wasPerson.tags, BRAND] });
  check("PATCH /api/v1/people/:id is 200", edit.status() === 200, edit.status());
  const nowPerson = await readPerson();
  check("name, role, tags and their own cadence all moved",
    nowPerson.displayName === `${who.displayName} Jr` && nowPerson.cadenceDays === 7
    && nowPerson.tags.includes(BRAND) && /live check/.test(nowPerson.role ?? ""),
    { name: nowPerson.displayName, cadence: nowPerson.cadenceDays, tags: nowPerson.tags, role: nowPerson.role });
  check("a person's own cadence overrides the default", !nowPerson.cadenceIsDefault, nowPerson.cadenceIsDefault);
  check("clearing it hands them back the default",
    (await patch({ cadenceDays: null })).ok() && (await readPerson()).cadenceIsDefault);
  // An employer is a tag, which is the whole reason tags and not circles.
  check("a brand tag makes them findable by the brand", (await search(BRAND)).results.some((r) => r.person.id === who.id));
  await patch({ role: "" });
  check("an empty string clears a field", (await readPerson()).role === null);
  check("an unknown field is refused", (await patch({ nope: 1 })).status() === 400);
  check("an empty patch is refused", (await patch({})).status() === 400);
  check("a nameless person is refused", (await patch({ displayName: "   " })).status() === 400);
  check("a circle can no longer be set at all", (await patch({ circle: "work" })).status() === 400);
  check("a malformed id is a 404", (await patch({ role: "x" }, "not-a-uuid")).status() === 404);
  check("someone else's id is a 404", (await patch({ role: "x" }, "00000000-0000-4000-8000-00000000dead")).status() === 404);
  check("editing signed out is a 401",
    (await (await browser.newContext()).request.patch(`${BASE}/api/v1/people/${who.id}`, { data: { role: "x" } })).status() === 401);

  // and the same thing with a thumb
  await page.goto(`${BASE}/people/${who.id}`, { waitUntil: "networkidle" });
  await page.waitForSelector(".phead", { timeout: 20000 });
  await page.locator(".phead .act", { hasText: "Edit" }).click();
  await page.waitForSelector(".pedit", { timeout: 20000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/14-person-edit.png`, fullPage: true });
  await page.locator(".pedit .field input").first().fill(`${who.displayName} Edited`);
  await page.locator(".pedit .act", { hasText: "Save" }).click();
  // Wait for the new name rather than for a timer: the page reloads the row
  // before it leaves edit mode, and a fixed pause races that round trip.
  const saved = await page.waitForFunction(
    (want) => document.querySelector(".pname")?.textContent?.trim() === want,
    `${who.displayName} Edited`, { timeout: 20000 },
  ).then(() => true).catch(() => false);
  await page.screenshot({ path: `${OUT}/15-person-edited.png`, fullPage: true });
  check("the screen saved the name", saved, [saved, await page.locator(".pname").innerText().catch(() => null)]);

  /* M. when you last saw them */
  // Last seen is the newest visit, not a number anyone sets, so these compare
  // whole timestamps: this person already has a visit from the note, dated
  // midnight today, and an older hand-logged one must not displace it.
  const seenBefore = await readPerson();
  const ms = (x) => (x ? new Date(x).getTime() : null);
  const NOW = new Date().toISOString();
  const made = await page.request.post(`${BASE}/api/v1/people/${who.id}/visits`, { data: { occurredAt: NOW, summary: "Saw them, live check." } });
  check("POST a visit is 201", made.status() === 201, made.status());
  const visitId = (await made.json()).visit?.id;
  check("a newer visit becomes last seen", ms((await readPerson()).lastInteractionAt) === ms(NOW), [(await readPerson()).lastInteractionAt, NOW]);
  const OLDER = new Date(Date.now() - 30 * 86400000).toISOString();
  check("moving the day is a 200", (await page.request.patch(`${BASE}/api/v1/people/${who.id}/visits/${visitId}`, { data: { occurredAt: OLDER } })).status() === 200);
  check("moving it back hands last seen to the visit the note made",
    ms((await readPerson()).lastInteractionAt) === ms(seenBefore.lastInteractionAt),
    [(await readPerson()).lastInteractionAt, seenBefore.lastInteractionAt]);
  check("a day that has not happened is refused",
    (await page.request.post(`${BASE}/api/v1/people/${who.id}/visits`, { data: { occurredAt: new Date(Date.now() + 7 * 86400000).toISOString() } })).status() === 400);
  // A visit a note produced belongs to that note: changing it here would be
  // undone by the next re-file, silently, which is worse than not offering it.
  const [fromNote] = await q("select id from interactions where user_id = $1 and person_id = $2 and capture_id is not null limit 1", [user.id, who.id]);
  if (fromNote) {
    check("a note's visit cannot be deleted from the person page",
      (await page.request.delete(`${BASE}/api/v1/people/${who.id}/visits/${fromNote.id}`)).status() === 404);
    check("nor moved from there", (await page.request.patch(`${BASE}/api/v1/people/${who.id}/visits/${fromNote.id}`, { data: { occurredAt: OLDER } })).status() === 404);
  }
  check("removing a hand-logged visit is a 200", (await page.request.delete(`${BASE}/api/v1/people/${who.id}/visits/${visitId}`)).status() === 200);
  check("and last seen is still what the notes say", ms((await readPerson()).lastInteractionAt) === ms(seenBefore.lastInteractionAt));
  check("the removed visit is gone from the table", Number((await q("select count(*) n from interactions where id = $1", [visitId]))[0].n) === 0);
  check("logging a visit signed out is a 401",
    (await (await browser.newContext()).request.post(`${BASE}/api/v1/people/${who.id}/visits`, { data: { occurredAt: OLDER } })).status() === 401);

  // and from the screen
  await page.goto(`${BASE}/people/${who.id}`, { waitUntil: "networkidle" });
  await page.waitForSelector(".phead", { timeout: 20000 });
  await page.locator(".label", { hasText: "History" }).locator(".act").click();
  await page.waitForSelector(".pedit input[type=date]", { timeout: 20000 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/16-saw-them.png`, fullPage: true });
  const seenDay = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);
  await page.locator(".pedit input[type=date]").fill(seenDay);
  await page.locator(".pedit .field input").fill("Saw them, from the screen.");
  await page.locator(".pedit .act", { hasText: "Save" }).click();
  await page.waitForSelector(".tl .ev", { timeout: 20000 });
  await page.waitForTimeout(600);
  const logged = await q(
    "select id, to_char(occurred_at at time zone 'UTC', 'YYYY-MM-DD') d, summary from interactions where user_id = $1 and person_id = $2 and capture_id is null",
    [user.id, who.id]);
  check("Saw them writes a visit on the day you picked", logged.length === 1 && logged[0].d === seenDay && /from the screen/.test(logged[0].summary), logged);
  check("a hand-logged visit offers to move or remove itself", (await page.locator(".ev .act", { hasText: "Remove" }).count()) === 1);
  await page.locator(".ev .act", { hasText: "Remove" }).click();
  await page.waitForTimeout(1500);
  check("and Remove takes it away again",
    Number((await q("select count(*) n from interactions where user_id = $1 and person_id = $2 and capture_id is null", [user.id, who.id]))[0].n) === 0);

  /* M2. saying you saw a room full of people, which is how you actually see them */
  const GROUP_DAY = new Date(Date.now() - 4 * 86400000).toISOString().slice(0, 10);
  const groupIds = createdIds;
  const future = await page.request.post(`${BASE}/api/v1/visits`, { data: { personIds: groupIds, occurredAt: new Date(Date.now() + 5 * 86400000).toISOString() } });
  check("a group visit in the future is refused", future.status() === 400, future.status());
  const foreign = await page.request.post(`${BASE}/api/v1/visits`, { data: { personIds: [...groupIds, otherPersonId], occurredAt: `${GROUP_DAY}T12:00:00Z` } });
  check("one id that is not yours fails the whole call, rather than logging the rest", foreign.status() === 400, foreign.status());
  check("and nothing was written by the call that failed",
    Number((await q("select count(*) n from interactions where user_id = $1 and person_id = any($2::uuid[]) and capture_id is null", [user.id, groupIds]))[0].n) === 0);
  check("a group visit signed out is a 401",
    (await (await browser.newContext()).request.post(`${BASE}/api/v1/visits`, { data: { personIds: groupIds, occurredAt: `${GROUP_DAY}T12:00:00Z` } })).status() === 401);

  // The screen: filter to this note's tag, choose everyone in it, pick a day.
  await page.goto(`${BASE}/people?tag=${encodeURIComponent(TAG)}`, { waitUntil: "networkidle" });
  await page.waitForSelector("a.row[href^='/people/']", { timeout: 20000 });
  await page.locator(".stamp .act", { hasText: "Saw them" }).click();
  await page.waitForSelector(".picking", { timeout: 10000 });
  check("choosing starts with nobody chosen: a visit that did not happen is the one thing this must not invent",
    /^0 selected/i.test((await page.locator(".picking .stamp").first().innerText()).trim()),
    await page.locator(".picking .stamp").first().innerText());
  check("the rows became choices, not links", (await page.locator(".row.pickable").count()) === groupIds.length
    && (await page.locator("a.row[href^='/people/']").count()) === 0);
  await page.locator(".picking .act", { hasText: `All ${groupIds.length}` }).click();
  check("All takes everyone in the filter",
    new RegExp(`^${groupIds.length} selected`, "i").test((await page.locator(".picking .stamp").first().innerText()).trim()),
    await page.locator(".picking .stamp").first().innerText());
  check("and every chosen row says so", (await page.locator(".row.pickable.on").count()) === groupIds.length);
  await page.locator(".row.pickable").first().click();
  check("tapping one takes it back off", (await page.locator(".row.pickable.on").count()) === groupIds.length - 1);
  await page.locator(".picking .act", { hasText: `All ${groupIds.length}` }).click();
  await page.locator(".picking input[type=date]").fill(GROUP_DAY);
  await page.screenshot({ path: `${OUT}/19-saw-them.png`, fullPage: true });
  await page.locator(".picking .act.gold").click();
  await page.waitForSelector(".picking", { state: "detached", timeout: 20000 });

  const groupVisits = await q(
    "select person_id, to_char(occurred_at at time zone 'UTC', 'YYYY-MM-DD') d from interactions where user_id = $1 and person_id = any($2::uuid[]) and capture_id is null",
    [user.id, groupIds]);
  check("one visit each, on the day picked, in one go",
    groupVisits.length === groupIds.length && groupVisits.every((v) => v.d === GROUP_DAY), groupVisits);
  // Last seen is the most recent visit, and these people already have one from
  // the note. So the answer is the later of the two, which is what the
  // database is asked for rather than assumed.
  const groupWarm = await q(`
    select p.id, p.last_interaction_at, p.warmth,
           (select max(i.occurred_at) from interactions i where i.person_id = p.id and i.user_id = p.user_id) newest
    from people p where p.id = any($1::uuid[])`, [groupIds]);
  check("last seen is the newest visit they have, not whichever was written last",
    groupWarm.every((r) => r.last_interaction_at && r.newest && new Date(r.last_interaction_at).getTime() === new Date(r.newest).getTime()), groupWarm);
  check("and warmth was recomputed with it", groupWarm.every((r) => r.warmth > 0), groupWarm.map((r) => r.warmth));

  const twice = await page.request.post(`${BASE}/api/v1/visits`, { data: { personIds: groupIds, occurredAt: `${GROUP_DAY}T12:00:00Z` } });
  const again = await twice.json();
  check("doing the same evening twice logs nothing a second time", again.logged === 0 && again.already === groupIds.length, again);
  check("so the count is still one each",
    Number((await q("select count(*) n from interactions where user_id = $1 and person_id = any($2::uuid[]) and capture_id is null", [user.id, groupIds]))[0].n) === groupIds.length);

  await q("delete from interactions where user_id = $1 and person_id = any($2::uuid[]) and capture_id is null", [user.id, groupIds]);

  /* N. the places you have named, for naming the next one with a tap */
  const near = await (await page.request.get(`${BASE}/api/v1/places?lat=32.8&lng=-96.8`)).json();
  check("GET /api/v1/places near a place you know finds it",
    near.places.some((pl) => pl.name === "Kith Test Hall" && pl.distanceM != null), near.places);
  const far = await (await page.request.get(`${BASE}/api/v1/places?lat=40.7&lng=-74.0`)).json();
  check("and standing 2000km away finds none of it", !far.places.some((pl) => pl.name === "Kith Test Hall"), far.places);
  const anywhere = await (await page.request.get(`${BASE}/api/v1/places`)).json();
  check("with no fix at all it still lists what you know", Array.isArray(anywhere.places) && anywhere.places.some((pl) => pl.name === "Kith Test Hall"), anywhere.places);
  check("places signed out is a 401", (await (await browser.newContext()).request.get(`${BASE}/api/v1/places`)).status() === 401);

  /* P. Today */
  const t0 = await page.request.get(`${BASE}/api/v1/today`);
  const tv = await t0.json();
  check("GET /api/v1/today is 200 with every block it draws", t0.status() === 200
    && ["firstName", "place", "likelyHere", "threads", "slipping", "loose", "review"].every((k) => k in tv), Object.keys(tv));
  check("Today signed out is a 401", (await (await browser.newContext()).request.get(`${BASE}/api/v1/today`)).status() === 401);
  const [openCount] = await q("select count(*) n from threads where user_id = $1 and status = 'open'", [user.id]);
  check("Owed counts the open threads, soonest first",
    tv.threads.length === Math.min(12, Number(openCount.n)), [tv.threads.length, openCount.n]);
  check("a thread carries the person it is owed to", tv.threads.every((t) => t.person === null || typeof t.person.displayName === "string"));
  // Someone you added and never met was never warm, so they are not slipping.
  const [never] = await q("select count(*) n from people where user_id = $1 and last_interaction_at is null", [user.id]);
  check("nobody you have never seen is called slipping",
    Number(never.n) > 0 && tv.slipping.every((x) => x.person.lastInteractionAt !== null), [never.n, tv.slipping.length]);
  check("slipping is only people past their own cadence", tv.slipping.every((x) => x.daysSince > x.cadenceDays), tv.slipping);
  const [waitingNow] = await q("select count(*) n from captures where user_id = $1 and status = 'needs_review'", [user.id]);
  check("the review count matches the notes actually waiting", tv.review.count === Number(waitingNow.n), [tv.review.count, waitingNow.n]);
  // With coordinates at the test place, the place block names it.
  const tHere = await (await page.request.get(`${BASE}/api/v1/today?lat=32.8&lng=-96.8`)).json();
  check("standing at a place you know names it on Today", tHere.place?.name === "Kith Test Hall", tHere.place);
  check("and says who you usually see there", tHere.likelyHere.some((x) => x.person.id === who.id), tHere.likelyHere.map((x) => x.person.displayName));
  check("location adds a block and removes none", tHere.threads.length === tv.threads.length && tHere.slipping.length === tv.slipping.length);

  await page.goto(`${BASE}/today`, { waitUntil: "networkidle" });
  await page.waitForSelector(".h1", { timeout: 20000 });
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${OUT}/17-today.png`, fullPage: true });
  const greeting = (await page.locator(".h1").innerText()).replace(/\s+/g, " ").trim();
  check("Today greets you by name, from the phone's own clock", /^good (morning|afternoon|evening),/i.test(greeting), greeting);
  check("the mic still records and Today is the current tab",
    (await page.locator(".nav .nv[aria-current='true'] .nl").innerText()).trim().toLowerCase() === "today"
    && (await page.locator(".nav a[href='/record'] .nmic").count()) === 1);
  check("every block on Today has something in it", (await page.locator(".block").count()) === (await page.locator(".label").count()));

  /* Q. the shell lines up, and nothing scrolls sideways but the filter row */
  for (const [name, url] of [["today", "/today"], ["people", "/people"], ["record", "/record"], ["find", "/find?q=a"], ["person", `/people/${who.id}`]]) {
    await page.goto(`${BASE}${url}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(600);
    const m = await page.evaluate(() => {
      const left = (sel) => { const e = document.querySelector(sel); return e ? Math.round(e.getBoundingClientRect().left) : null; };
      const de = document.documentElement;
      return { over: de.scrollWidth - de.clientWidth, bar: left(".bar span"), first: left(".h1") ?? left(".back") ?? left(".stamp") };
    });
    check(`${name} does not scroll sideways`, m.over === 0, m.over);
    if (m.bar != null && m.first != null) check(`${name}: the strip lines up with the content`, m.bar === m.first, m);
  }
  await page.goto(`${BASE}/people`, { waitUntil: "networkidle" });
  await page.waitForSelector(".tabs", { timeout: 20000 });
  check("the filter row keeps its own scroll instead of dragging the page",
    (await page.locator(".tabs").evaluate((el) => getComputedStyle(el).overscrollBehaviorX)) === "contain");

  /* S. You: the account, the cadence, and getting your data out */
  const meRes = await page.request.get(`${BASE}/api/v1/me`);
  const me = await meRes.json();
  cadenceWas = me.cadence;
  check("GET /api/v1/me is 200 with the account, the cadence and the counts", meRes.status() === 200
    && ["name", "email", "timezone", "cadence", "connected", "counts"].every((k) => k in me)
    && typeof me.cadence === "number", { keys: Object.keys(me), cadence: me.cadence });
  check("me signed out is a 401", (await (await browser.newContext()).request.get(`${BASE}/api/v1/me`)).status() === 401);
  const [dbCounts] = await q(`select
    (select count(*) from people where user_id = $1 and archived_at is null) people,
    (select count(*) from facts where user_id = $1) facts,
    (select count(*) from captures where user_id = $1) notes`, [user.id]);
  check("the counts are the real rows", me.counts.people === Number(dbCounts.people)
    && me.counts.facts === Number(dbCounts.facts) && me.counts.notes === Number(dbCounts.notes), [me.counts, dbCounts]);
  // Connected is read off the scopes Google granted, never off a wish list.
  const [acct] = await q("select coalesce(scope, '') s from accounts where user_id = $1 and provider = 'google' limit 1", [user.id]);
  check("connected reports the scopes actually granted",
    me.connected.calendar === /calendar/.test(acct?.s ?? "") && me.connected.contacts === /contacts/.test(acct?.s ?? ""),
    [me.connected, acct?.s]);

  // The cadence is the one setting that rewrites what the app says about people.
  const [warmBefore] = await q("select id, warmth from people where user_id = $1 and cadence_days is null and last_interaction_at is not null order by last_interaction_at limit 1", [user.id]);
  check("PATCH /api/v1/me is 200", (await page.request.patch(`${BASE}/api/v1/me`, { data: { cadence: 3 } })).status() === 200);
  const [warmAfter] = await q("select warmth from people where id = $1", [warmBefore.id]);
  check("changing the cadence rewrites every warmth it applies to",
    Number(warmAfter.warmth) !== Number(warmBefore.warmth), [warmBefore.warmth, warmAfter.warmth]);
  check("and the person page reads the new cadence",
    (await (await page.request.get(`${BASE}/api/v1/people/${warmBefore.id}`)).json()).person.cadenceDays === 3);
  await page.request.patch(`${BASE}/api/v1/me`, { data: { cadence: cadenceWas } });
  cadenceWas = null;
  const [warmBack] = await q("select warmth from people where id = $1", [warmBefore.id]);
  check("putting it back puts warmth back", Number(warmBack.warmth) === Number(warmBefore.warmth), [warmBefore.warmth, warmBack.warmth]);
  check("a cadence of zero days is refused", (await page.request.patch(`${BASE}/api/v1/me`, { data: { cadence: 0 } })).status() === 400);
  check("a cadence that is not a number is refused", (await page.request.patch(`${BASE}/api/v1/me`, { data: { cadence: { other: 10 } } })).status() === 400);
  check("an unknown field is refused", (await page.request.patch(`${BASE}/api/v1/me`, { data: { nope: 1 } })).status() === 400);
  check("editing the account signed out is a 401",
    (await (await browser.newContext()).request.patch(`${BASE}/api/v1/me`, { data: { timezone: "UTC" } })).status() === 401);

  // Export: a private memory system you cannot get your memories out of is a
  // worse deal than a notebook.
  const dump = await page.request.get(`${BASE}/api/v1/me/export`);
  const text = await dump.text();
  check("export is a JSON attachment", dump.status() === 200
    && /attachment; filename="kith-\d{4}-\d{2}-\d{2}\.json"/.test(dump.headers()["content-disposition"] ?? ""),
    dump.headers()["content-disposition"]);
  const dumped = JSON.parse(text);
  check("it holds every table, at the real row counts",
    dumped.people.length === Number(dbCounts.people) && dumped.facts.length === Number(dbCounts.facts)
    && ["captures", "interactions", "threads", "places", "personPlaces", "looseThreads"].every((k) => Array.isArray(dumped[k])),
    Object.keys(dumped));
  check("and leaves the embeddings out", !text.includes("\"embedding\""));
  check("export signed out is a 401", (await (await browser.newContext()).request.get(`${BASE}/api/v1/me/export`)).status() === 401);

  await page.goto(`${BASE}/you`, { waitUntil: "networkidle" });
  await page.waitForSelector(".cad", { timeout: 20000 });
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/18-you.png`, fullPage: true });
  check("You shows one cadence, not five", (await page.locator(".cad").count()) === 1);
  check("and the way out", (await page.locator("form button", { hasText: "Sign out" }).count()) === 1);
  check("the record screen no longer carries a stray sign out",
    (await page.goto(`${BASE}/record`, { waitUntil: "networkidle" }), await page.locator(".foot").count()) === 0);
} catch (e) {
  failures++;
  console.log("  CRASH", e?.message ?? e);
  await page.screenshot({ path: `${OUT}/99-crash.png`, fullPage: true }).catch(() => {});
} finally {
  /* T. cleanup, by the ids this run made */
  if (cadenceWas) {
    // The run changed a real setting on the real account and crashed before
    // putting it back. Everything else this script touches it created; this it
    // did not. Restore through the API rather than in SQL, because the API is
    // what recomputes the warmth the change rewrote.
    const put = await page.request.patch(`${BASE}/api/v1/me`, { data: { cadence: cadenceWas } })
      .then((r) => r.status()).catch(() => 0);
    if (put !== 200) await q("update users set cadence_defaults = $2 where id = $1", [user.id, JSON.stringify({ everyone: cadenceWas })]);
    console.log(`cleanup: cadences restored${put === 200 ? " and warmth recomputed" : " in SQL; warmth needs a re-save on You"}`);
  }
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
