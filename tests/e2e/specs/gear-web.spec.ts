// ─── The browser smoke for `gear web` ───
//
// One test, one path, and it is the path the product is judged on: open the
// page, watch it attach to a real engine, send a prompt, get stopped by a
// permission card that is INLINE and not a modal, answer it, watch the turn
// finish, and read the trace that says why the answer is what it is.
//
// Everything is real except the model. This is deliberately end-to-end: the
// unit tests already cover the reducers, and what they cannot cover is the
// three seams that broke the desktop before — the transport, the round-trips,
// and the page actually being served with a working token.

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

test("a browser drives a whole turn: prompt → permission card → answer → trace → export", async ({
  page,
}) => {
  const consoleErrors: string[] = [];
  page.on("console", (m) => {
    if (process.env.E2E_DEBUG) console.log(`[${m.type()}]`, m.text());
    if (m.type() === "error") consoleErrors.push(m.text());
  });

  // ── the page, and the endpoint it was served with ──
  await page.goto(stand.pageUrl);
  const embedded = await page.evaluate(
    () => (window as unknown as { __GEAR_SERVE__?: { url: string; token: string } }).__GEAR_SERVE__,
  );
  expect(embedded?.url, "gear web embeds the socket URL in the page it serves").toContain("ws://");
  expect(embedded?.token?.length, "and the token it just minted").toBeGreaterThan(20);

  // ── it attaches to the engine, over the websocket, with no further setup ──
  // The model name is the honest readiness signal: it is not in the bundle, it
  // arrives on the `ready` stream, so seeing it means the handshake completed
  // and this page is talking to a real host. Typing before it appears is how
  // the first draft of this test sent a prompt into a transport that was still
  // opening.
  await expect(page.locator(".app")).toBeVisible();
  await expect(page.locator(".app")).toContainText("fake-model", { timeout: 60_000 });

  // ── first run ──
  // A fresh browser profile has never seen this app, so the three-step opener
  // is on screen. It is the two minutes the product is judged on.
  const firstRun = page.getByRole("region", { name: "First run" });
  await expect(firstRun).toBeVisible();
  await expect(firstRun).toContainText("Connect a model");

  // ── the provider panel: which models this machine can actually reach ──
  await firstRun.getByRole("button", { name: "Open providers" }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await expect(settings).toBeVisible();
  // The mock provider is `custom` — the user-defined OpenAI-compatible
  // endpoint, pointed at the fake model by `secrets.custom`. It reads as
  // connected because a base URL and a key are configured.
  await expect(settings).toContainText(/custom endpoint/i);
  await settings.getByRole("button", { name: /Close/ }).click();
  await expect(settings).toBeHidden();

  // ── the prompt ──
  const composer = page.getByLabel("Give Gear a coding task");
  await composer.click();
  await composer.fill("run the echo command");
  await composer.press("Enter");

  // ── the permission card, inline in the transcript ──
  // "Never a modal" is a design contract term, not a preference: a modal takes
  // the stream away from you at the moment you most need to read it. Assert it.
  const card = page.getByRole("group", { name: "Permission request" });
  await expect(card).toBeVisible({ timeout: 120_000 });
  await expect(card).toContainText("echo hello-from-the-browser");
  const inTranscript = await card.evaluate((el) => Boolean(el.closest(".transcript, .main")));
  expect(inTranscript, "the permission card lives in the transcript, not over it").toBe(true);
  const overlays = await page.locator("dialog[open], [role='dialog']").count();
  expect(overlays, "no modal dialog is opened for a permission").toBe(0);

  // ── answering it lets the turn finish ──
  await card.getByRole("button", { name: /Allow once/ }).click();
  await expect(card).toContainText(/allowed once/, { timeout: 60_000 });
  await expect(page.locator(".transcript, .main")).toContainText("hello-from-the-browser", {
    timeout: 120_000,
  });

  // ── the trace rail: the surface no rival has ──
  const rail = page.getByRole("complementary", { name: "Trace" });
  await expect(rail).toBeVisible();
  await expect
    .poll(async () => rail.locator(".span").count(), { timeout: 60_000 })
    .toBeGreaterThan(2);
  // A model call, the tool it decided on, and the permission that gated it —
  // the three kinds that answer "why is the answer what it is".
  await expect(rail).toContainText("bash");

  // ── inspect a span ──
  // Clicking a row selects it and fills the inspector with that span's record:
  // the trace rail is only worth having if a row answers a question.
  await rail.locator(".span").first().click();
  await expect(rail.locator(".span.sel")).toHaveCount(1);
  await expect(rail.locator(".inspector .insp-head")).toBeVisible();

  // ── the review workspace ──
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
    .poll(() => page.evaluate(() => (window as unknown as { __copied?: string }).__copied ?? ""), {
      timeout: 60_000,
    })
    .toContain("Session Export");
  const exported = await page.evaluate(
    () => (window as unknown as { __copied?: string }).__copied ?? "",
  );
  expect(exported, "the turn's own prompt is in the export").toContain("run the echo command");
  expect(exported, "and it is signed").toContain("ed25519:");

  // A page that throws on the way through is not a passing smoke.
  expect(consoleErrors.filter((e) => !/favicon|ResizeObserver/i.test(e))).toEqual([]);
});
