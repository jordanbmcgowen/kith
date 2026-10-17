/** Isolated browser regressions. Only synthetic fixtures, no login, DB, or models. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { chromium } from "playwright-core";

const root = resolve(import.meta.dirname, "..");
const output = await mkdtemp(join(tmpdir(), "kith-ui-check-"));
await build({
  absWorkingDir: root,
  entryPoints: ["tests/ui/entry.tsx"], outfile: join(output, "app.js"),
  bundle: true, platform: "browser", format: "iife", jsx: "automatic",
  define: { "process.env.NODE_ENV": '"development"' },
  alias: {
    "next/navigation": resolve(root, "tests/ui/navigation.tsx"),
    "next/link": resolve(root, "tests/ui/link.tsx"),
  },
});
const js = await readFile(join(output, "app.js"));
const css = await readFile(join(root, "src/app/globals.css"));
const server = createServer((req, res) => {
  if (req.url === "/app.js") { res.setHeader("Content-Type", "application/javascript"); return res.end(js); }
  if (req.url === "/style.css") { res.setHeader("Content-Type", "text/css"); return res.end(css); }
  if (req.url.startsWith("/api/") || req.url.startsWith("/__fixture/")) {
    void fixtureResponse(req, res);
    return;
  }
  res.setHeader("Content-Type", "text/html");
  res.end('<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>');
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const person = (id, displayName, circle = "friends", tags = []) => ({ id, displayName, circle, tags, role: null, goesBy: null, pronunciation: null, warmth: 50, lastInteractionAt: null });
const alice = person("person-alice", "Alice Example");
const bob = person("person-bob", "Bob Example", "work", ["Colleagues"]);
const cara = person("person-cara", "Cara Example", "family", ["Family"]);
const hit = (p) => ({ person: p, score: 1, why: "Name match", at: null });
const roster = (people) => ({ people, tags: ["Colleagues", "Family"], counts: { people: 3, facts: 2, places: 0 } });
const extraction = (names) => ({
  people: names.map((name) => ({ name, matchedPersonId: null, confidence: 0.6, isNew: true, circle: "friends", tags: ["Book club"] })),
  facts: names.map((name) => ({ personName: name, kind: "context", content: `${name} likes books.`, confidence: 0.9 })),
  interactions: [], threads: [], closesThreadIds: [], place: null, unresolved: [],
});
const note = (id, names = ["Original Person"]) => ({
  capture: { id, status: "needs_review", kind: "text", capturedAt: "2026-10-01T12:00:00Z", durationSec: null, rawText: "Synthetic regression note", transcript: null, error: null, placeHint: null, place: null, extraction: extraction(names), filing: null },
  people: [alice, bob, cara], tags: ["Colleagues", "Family"], suggestions: {}, closes: [],
});
// Server-mode fixtures are also safe to inspect in an existing cloud browser.
// They never proxy to the application or any production service.
const fixtureState = { reread: false, posted: null, searchFailures: 0, peopleFailures: 0 };
async function fixtureResponse(req, res) {
  const url = new URL(req.url, origin);
  let body;
  let status = 200;
  if (url.pathname === "/__fixture/reset" && req.method === "POST") {
    Object.assign(fixtureState, { reread: false, posted: null, searchFailures: 0, peopleFailures: 0 });
    body = { ok: true };
  } else if (url.pathname === "/__fixture/state") body = fixtureState;
  else if (url.pathname.endsWith("/search")) {
    const q = url.searchParams.get("q") ?? "";
    if (q === "bob") await pause(1200);
    if (q === "fail" && fixtureState.searchFailures++ === 0) { status = 503; body = { error: "Synthetic offline fixture" }; }
    else body = { results: q.length < 2 ? [] : [hit(q === "alice" ? alice : q === "bob" ? bob : cara)], hints: ["Colleagues"] };
  } else if (url.pathname.endsWith("/people")) {
    if (url.searchParams.get("circle") === "work") await pause(700);
    if (url.searchParams.get("tag") === "fail" && fixtureState.peopleFailures++ === 0) { status = 503; body = { error: "Synthetic offline fixture" }; }
    else body = roster(url.searchParams.get("circle") === "work" ? [bob] : [alice, bob, cara]);
  } else if (url.pathname.endsWith("/rerun")) { fixtureState.reread = true; body = { status: "uploaded" }; status = 202; }
  else if (url.pathname.endsWith("/confirm")) {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    fixtureState.posted = JSON.parse(raw);
    body = { counts: { people: fixtureState.posted.people.length, facts: fixtureState.posted.facts.length, threads: 0 } };
  } else if (url.pathname === "/api/v1/captures") body = { captures: [] };
  else if (url.pathname.startsWith("/api/v1/captures/")) {
    const id = url.pathname.split("/").at(-1);
    if (id === "review-one") {
      if (fixtureState.reread) await pause(200);
      body = note(id, fixtureState.reread ? ["Second Person", "Third Person"] : ["Original Person"]);
    } else if (id === "labels") {
      body = note(id, ["New Person"]);
      body.suggestions = { "0": [{ ...bob, similarity: 0.8 }] };
    } else body = note(id, id === "second" ? ["Different Person", "Another Person"] : ["First Person"]);
  } else { body = { error: "Not a fixture route" }; status = 404; }
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}
if (process.argv.includes("--serve")) {
  console.log(`Synthetic fixture browser: ${origin}/find?q=alice`);
  console.log(`Self-running UI checks: ${origin}/__checks`);
  await new Promise(() => {});
}
let browser;
try {
  browser = await chromium.launch({
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    headless: true,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    errors.push("Unexpected external request: " + route.request().url());
    return route.abort();
  });
  await page.goto(origin + "/__checks");
  const report = page.locator("#check-results[data-status]");
  await report.waitFor({ timeout: 60_000 });
  console.log(await report.innerText());
  assert.equal(await report.getAttribute("data-status"), "passed", "Browser regressions failed");
  assert.deepEqual(errors, [], "No runtime errors or external services");
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(output, { recursive: true, force: true });
}
