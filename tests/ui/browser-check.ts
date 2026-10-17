/** Self-running fixture checks for environments with an existing cloud browser. */
export async function runBrowserChecks() {
  const report = document.createElement("section");
  report.id = "check-results";
  report.setAttribute("aria-label", "Regression results");
  report.style.cssText = "padding:20px;font:14px monospace;background:#0f1e1a;color:#f1eadc";
  report.innerHTML = "<h2>Isolated WithKith UI checks</h2><p>Running synthetic fixtures. No production data or services.</p>";
  document.body.insertBefore(report, document.body.firstChild);
  const errors: string[] = [];
  window.addEventListener("error", (event) => errors.push(event.message));
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const text = () => document.getElementById("root")!.textContent ?? "";
  const assert = (value: unknown, message: string) => { if (!value) throw new Error(message); };
  const wait = async (predicate: () => boolean, message: string) => {
    const end = Date.now() + 6000;
    while (!predicate()) { if (Date.now() > end) throw new Error(message); await sleep(25); }
  };
  const go = async (path: string) => { history.pushState({}, "", path); dispatchEvent(new PopStateEvent("popstate")); await sleep(20); };
  const button = (label: string, within: Document | Element = document.getElementById("root")!) => {
    const match = [...within.querySelectorAll<HTMLButtonElement>("button")].find((el) => el.textContent?.trim() === label || el.getAttribute("aria-label") === label || el.querySelector(".nm")?.textContent?.trim() === label);
    if (!match) throw new Error(`Missing button: ${label}`);
    return match;
  };
  const type = (value: string) => {
    const input = document.querySelector<HTMLInputElement>("#q")!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const state = () => fetch("/__fixture/state").then((r) => r.json() as Promise<{ posted: { people: { circle: string; tags: string[] }[]; facts: { keep: boolean }[] } }>);
  let passed = 0;
  const check = async (name: string, action: () => Promise<void>) => {
    await action();
    assert(errors.length === 0, `Browser errors: ${errors.join("; ")}`);
    passed++;
    const line = document.createElement("p"); line.textContent = `PASS ${name}`; report.appendChild(line);
  };
  try {
    await fetch("/__fixture/reset", { method: "POST" });
    Object.defineProperty(navigator, "geolocation", { configurable: true, value: { getCurrentPosition: (_ok: unknown, fail: (error: unknown) => void) => fail({ code: 1 }) } });
    await check("Search hides old results and ignores late responses", async () => {
      await go("/find?q=alice"); await wait(() => text().includes("Alice Example"), "Alice never loaded");
      type("bob"); await sleep(40); assert(!text().includes("Alice Example"), "Old search result remained during typing");
      await sleep(350); assert(text().includes("Searching your people"), "Loading message missing");
      type("cara"); await wait(() => text().includes("Cara Example"), "New search did not finish");
      await sleep(1300); assert(!text().includes("Bob Example"), "Late search replaced current result");
      type("a"); await wait(() => text().includes("Type at least two characters"), "Single-letter guidance missing");
    });
    await check("Search errors can retry without editing the query", async () => {
      await go("/find?q=fail"); await wait(() => !!document.querySelector('[role="alert"]'), "Search error missing");
      button("Try again").click(); await wait(() => text().includes("Cara Example"), "Search retry failed");
    });
    await check("People filters hide old rows while loading", async () => {
      await go("/people"); await wait(() => text().includes("Alice Example"), "People never loaded");
      button("Work").click(); await sleep(80);
      assert(!text().includes("Alice Example"), "Old people still shown under Work");
      assert(text().includes("Loading your people"), "People loading message missing");
      button("Colleagues");
      await wait(() => text().includes("Bob Example"), "Work roster never loaded");
    });
    await check("People errors show no stale rows and can retry", async () => {
      await go("/people?circle=work&tag=fail"); await wait(() => !!document.querySelector('[role="alert"]'), "People error missing");
      assert(!text().includes("Bob Example"), "Stale rows shown after error");
      button("Try again").click(); await wait(() => text().includes("Bob Example"), "People retry failed");
    });
    await check("Re-reading rebuilds choices for the new extraction", async () => {
      await go("/notes/review-one"); await wait(() => text().includes("Original Person"), "Note never loaded");
      button("Drop").click(); button("Read it again").click();
      await wait(() => text().includes("Third Person"), "Changed extraction failed");
      assert([...document.querySelectorAll("button")].filter((el) => el.textContent === "Drop").length === 2, "Old choices carried into reread");
      button("File it").click(); await wait(() => location.pathname === "/record", "Confirmation failed");
      const result = await state(); assert(result.posted.people.length === 2 && result.posted.facts.every((f: { keep: boolean }) => f.keep), "Wrong decisions submitted");
    });
    await check("Opening another note resets review choices", async () => {
      await go("/notes/first"); await wait(() => text().includes("First Person"), "First note missing"); button("Drop").click();
      await go("/notes/second"); await wait(() => text().includes("Another Person"), "Second note missing");
      assert([...document.querySelectorAll("button")].filter((el) => el.textContent === "Drop").length === 2, "First note choices leaked");
    });
    for (const mode of ["suggestion", "picker"]) {
      await check(`Reassigning by ${mode} preserves tags and circle`, async () => {
        await go("/notes/labels"); await wait(() => text().includes("New Person"), "Labels note missing");
        if (mode === "suggestion") button("Bob Example").click();
        else { button("Someone else").click(); button("Bob Example", document.querySelector(".picker")!).click(); }
        await wait(() => !!document.querySelector('[aria-label="Remove Colleagues"]'), "Existing tag was lost");
        assert(button("Work").getAttribute("aria-pressed") === "true", "Existing circle was lost");
        button("File it").click(); await wait(() => location.pathname === "/record", "Labels confirmation failed");
        const { posted } = await state();
        assert(posted.people[0].circle === "work" && JSON.stringify(posted.people[0].tags) === JSON.stringify(["Colleagues", "Book club"]), "Wrong replacement labels submitted");
      });
    }
    for (const exit of ["type", "navigate"]) {
      await check(`Microphone double-tap and ${exit} cancellation`, async () => {
        let requests = 0; let tracksStopped = 0; let recorders = 0; let grant!: () => void;
        Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: () => {
          requests++;
          return new Promise((resolve) => { grant = () => resolve({ getTracks: () => [{ stop: () => tracksStopped++ }] }); });
        } } });
        Object.defineProperty(window, "MediaRecorder", { configurable: true, value: class {
          constructor() { recorders++; }
          static isTypeSupported() { return true; }
        } });
        await go("/find"); await go("/record");
        const record = button("Start recording"); record.click(); record.click(); await sleep(30);
        assert(requests === 1 && record.disabled, "Duplicate permission request was not blocked");
        if (exit === "type") button("Type or paste it instead").click(); else await go("/find");
        grant(); await wait(() => tracksStopped === 1, "Late microphone grant was not released");
        assert(recorders === 0 && !text().includes("Listening"), "Cancelled recording started");
      });
    }
    report.dataset.status = "passed";
    const done = document.createElement("h3"); done.textContent = `${passed} checks passed. No production services used.`; report.appendChild(done);
  } catch (error) {
    report.dataset.status = "failed";
    const line = document.createElement("p"); line.textContent = `FAIL ${error instanceof Error ? error.message : String(error)}`; report.appendChild(line);
  }
}
