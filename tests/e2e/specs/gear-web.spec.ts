// ─── The browser smoke ───
//
// One test, one path, and it is the path the product is judged on: open the
// page, watch it attach to a real engine, connect a provider, send a prompt,
// get stopped by a permission card that is INLINE and not a modal, answer it,
// read the trace that says why the answer is what it is, look at the review
// tab, and reload — the session must still be there.
//
// Everything is real except the model. The unit tests already cover the
// reducers; what they cannot cover is the four seams that have broken before —
// the transport, the round-trips, the page actually being served with a working
// token, and a session surviving a page that goes away.
//
// It runs in both themes because the theme is a token swap and a token swap is
// exactly the kind of change that is green in one ground and broken in the
// other.

import { expect, test } from "@playwright/test";

import { sseText, sseToolCall, standUp, toolsBinary, type Stand } from "../fixtures/stand-up";

let stand: Stand;

test.beforeAll(async () => {
  test.skip(!toolsBinary(), "gear-tools is not built");
  stand = await standUp([
    // 1. the model decides to run a command → the permission round-trip
    sseToolCall("call_bash", "bash", { command: "echo hello-from-the-browser" }),
    // 2. having seen the output, it answers
    sseText("The command printed hello-from-the-browser."),
  ]);
});

test.afterAll(async () => {
  await stand?.stop();
});

for (const theme of ["light", "dark"] as const) {
  test(`a browser drives a whole turn — ${theme}`, async ({ browser }) => {
    const context = await browser.newContext({ colorScheme: theme });
    const page = await context.newPage();
    stand.reset();

    const consoleErrors: string[] = [];
    page.on("console", (m) => {
      if (process.env.E2E_DEBUG) console.log(`[${m.type()}]`, m.text());
      if (m.type() === "error") consoleErrors.push(m.text());
    });

    // ── the page, and the endpoint it was served with ──
    await page.goto(stand.pageUrl);
    const embedded = await page.evaluate(
      () =>
        (window as unknown as { __GEAR_SERVE__?: { url: string; token: string } }).__GEAR_SERVE__,
    );
    expect(embedded?.url, "the engine embeds the socket URL in the page it serves").toContain(
      "ws://",
    );
    expect(embedded?.token?.length, "and the token it just minted").toBeGreaterThan(20);

    // ── it attaches to the engine, over the websocket, with no further setup ──
    // The model name is the honest readiness signal: it is not in the bundle, it
    // arrives on the `ready` stream, so seeing it means the handshake completed
    // and this page is talking to a real host.
    await expect(page.locator(".app")).toBeVisible();
    await expect(page.locator(".app")).toContainText("fake-model", { timeout: 60_000 });

    // ── the theme actually resolves to the ground it was asked for ──
    const ground = await page.evaluate(() =>
      getComputedStyle(document.body).backgroundColor.replace(/\s/g, ""),
    );
    expect(ground, `the ${theme} ground`).toBe(
      theme === "dark" ? "rgb(15,17,20)" : "rgb(250,250,248)",
    );

    // ── first run, and connecting a provider ──
    const firstRun = page.getByRole("region", { name: "First run" });
    await expect(firstRun).toBeVisible();
    await expect(firstRun).toContainText("Connect a model");
    await firstRun.getByRole("button", { name: "Connect a model" }).click();

    // Connect is a SECTION, not a dialog. The mock provider is `custom` — the
    // user-defined OpenAI-compatible endpoint pointed at the fake model by
    // `secrets.custom` — and it reads as having a credential because it has one.
    const connect = page.getByLabel("Connect");
    await expect(connect).toBeVisible();
    await expect(connect).toContainText(/custom/i);
    await expect(connect).toContainText("Connectors");
    expect(await page.locator("dialog[open], [role='dialog']").count()).toBe(0);

    // ── the prompt ──
    await page.getByRole("button", { name: /New session/ }).click();
    const composer = page.getByLabel("Give Gear a coding task");
    await composer.click();
    await composer.fill("run the echo command");
    await composer.press("Enter");

    // ── the permission card, inline in the transcript ──
    // "Never a modal" is a design contract term, not a preference: a modal takes
    // the stream away from you at the moment you most need to read it.
    const card = page.getByRole("group", { name: "Permission request" });
    await expect(card).toBeVisible({ timeout: 120_000 });
    await expect(card).toContainText("echo hello-from-the-browser");
    const inTranscript = await card.evaluate((el) => Boolean(el.closest(".transcript, .main")));
    expect(inTranscript, "the permission card lives in the transcript, not over it").toBe(true);
    expect(
      await page.locator("dialog[open], [role='dialog']").count(),
      "no modal dialog is opened for a permission",
    ).toBe(0);

    // ── answering it lets the turn finish ──
    await card.getByRole("button", { name: /Allow once/ }).click();
    await expect(card).toContainText(/allowed once/, { timeout: 60_000 });
    await expect(page.locator(".main")).toContainText("hello-from-the-browser", {
      timeout: 120_000,
    });
    // The store is written at turn end, which is what the reload below depends
    // on, so wait for the turn to actually be over rather than for its output.
    await expect(page.locator(".status-row")).toContainText(/Complete/i, { timeout: 120_000 });

    // ── the trace rail: the surface no rival has ──
    const rail = page.getByRole("complementary", { name: "Trace" });
    await expect(rail).toBeVisible();
    await expect
      .poll(async () => rail.locator(".span").count(), { timeout: 60_000 })
      .toBeGreaterThan(2);
    // A model call, the tool it decided on, and the permission that gated it.
    await expect(rail).toContainText("bash");
    await rail.locator(".span").first().click();
    await expect(rail.locator(".span.sel")).toHaveCount(1);
    await expect(rail.locator(".inspector .insp-head")).toBeVisible();

    // ── ⌘K over sessions, files and commands ──
    await page.keyboard.press("Meta+k");
    const palette = page.getByRole("dialog", { name: "Search" });
    await expect(palette).toBeVisible();
    await palette.getByRole("textbox").fill("echo");
    await expect(palette.locator(".overlay-item").first()).toContainText("echo");
    await page.keyboard.press("Escape");
    await expect(palette).toBeHidden();

    // ── the review tab ──
    // The tree's own answer, not the run's: the fixture leaves one uncommitted
    // line in README.md, so the panel must find it and offer to revert exactly
    // that file.
    await page.getByRole("button", { name: "Review", exact: false }).first().click();
    const review = page.getByRole("region", { name: "Review changes" });
    await expect(review).toBeVisible();
    await expect(review).toContainText("README.md", { timeout: 30_000 });
    await expect(review).toContainText(/differ from HEAD/);
    // Reverting is a two-step: naming the file, then confirming what will happen
    // to it. A one-click revert of the agent's work is not a review tool.
    await review.getByRole("button", { name: "Revert this file" }).click();
    await expect(review).toContainText("restore this file from HEAD?");
    await review.getByRole("button", { name: "Keep" }).click();
    await review.getByRole("button", { name: /Close/ }).click();
    await expect(review).toBeHidden();

    // ── the Files tab reads the workspace ──
    await page.getByRole("button", { name: "Files", exact: true }).first().click();
    const files = page.getByLabel("Files").first();
    await expect(files).toBeVisible();
    await expect(files).toContainText("README.md", { timeout: 30_000 });
    await files
      .getByRole("button", { name: /README\.md/ })
      .first()
      .click();
    await expect(files).toContainText("A repository with one file in it", { timeout: 30_000 });

    // ── reload: the session is still there ──
    //
    // The one thing a page can lose that a window cannot. The engine holds the
    // sessions, so a reload re-attaches and the transcript comes back from the
    // store rather than from anything the tab was keeping.
    //
    // The turn settled before any of the tab-switching above, so the store has
    // the whole history; a reload mid-turn could only bring back what had been
    // written, and asserting otherwise would be asserting a race.
    await page.reload();
    await expect(page.locator(".app")).toContainText("fake-model", { timeout: 60_000 });
    await page
      .getByRole("button", { name: /run the echo command/ })
      .first()
      .click();
    await expect(page.locator(".main")).toContainText("hello-from-the-browser", {
      timeout: 60_000,
    });

    // ── export ──
    // Signed, and through the engine's own exporter — the same artifact
    // `gear export --sign` produces. A client-side dump of the rail would be a
    // picture of the screen, verifiable by nobody who was not watching it.
    await page.evaluate(() => {
      const w = window as unknown as { __copied?: string };
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: (t: string) => {
            w.__copied = t;
            return Promise.resolve();
          },
        },
      });
    });
    await rail.getByRole("button", { name: "Export" }).click();
    await expect
      .poll(
        () => page.evaluate(() => (window as unknown as { __copied?: string }).__copied ?? ""),
        {
          timeout: 60_000,
        },
      )
      .toContain("Session Export");
    const exported = await page.evaluate(
      () => (window as unknown as { __copied?: string }).__copied ?? "",
    );
    expect(exported, "the turn's own prompt is in the export").toContain("run the echo command");
    expect(exported, "and it is signed").toContain("ed25519:");

    // A page that throws on the way through is not a passing smoke.
    expect(consoleErrors.filter((e) => !/favicon|ResizeObserver/i.test(e))).toEqual([]);
    await context.close();
  });
}
