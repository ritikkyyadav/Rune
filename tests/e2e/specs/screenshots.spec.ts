// ─── The eight screenshots the founder judges ───
//
// Not mockups. Every image below is the shipping bundle driving a real engine —
// the real permission broker, the real session store, the real protocol, the
// real server — with a fake model in front so the turn happens on cue.
//
// Four states × two themes, at the two sizes a laptop actually is:
//
//   empty      1440×900 · the first thing anyone sees
//   session    1280×800 · a run mid-flight, with the plan ledger and a diff
//   held       1440×900 · a decision the run is stopped on, inline
//   palette    1280×800 · ⌘K over sessions, files and commands
//
// They are committed under docs/design/web/ and kept under 400 KB each, which
// is what a full-page PNG of a mostly-flat interface costs at scale 1. A
// design review that has to run the app is a design review that does not happen.

import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import {
  REPO_ROOT,
  sseText,
  sseToolCall,
  standUp,
  toolsBinary,
  type Stand,
} from "../fixtures/stand-up";

const OUT = join(REPO_ROOT, "docs/design/web");

let stand: Stand;

test.beforeAll(async () => {
  test.skip(!toolsBinary(), "gear-tools is not built");
  mkdirSync(OUT, { recursive: true });
  stand = await standUp([
    // `items`, not `todos` — and no `completed` on the first write: the harness
    // refuses a completion with nothing behind it, which is the point of the
    // ledger and would leave this screenshot without one.
    sseToolCall("call_todo", "todo_write", {
      items: [
        { content: "Run the echo command to prove the shell works", status: "in_progress" },
        { content: "Read the README", status: "pending" },
        { content: "Report what the repository does", status: "pending" },
      ],
    }),
    sseToolCall("call_bash", "bash", { command: "echo hello-from-the-browser" }),
    sseText(
      "The repository is a one-file smoke fixture. `README.md` is the only tracked file and the shell answered `hello-from-the-browser`, so the tool path works end to end.",
    ),
  ]);
});

test.afterAll(async () => {
  await stand?.stop();
});

for (const theme of ["light", "dark"] as const) {
  test(`screenshots — ${theme}`, async ({ browser }) => {
    const context = await browser.newContext({
      colorScheme: theme,
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    // Both themes drive the same engine, and the script is consumed in order.
    stand.reset();
    const shot = (name: string) =>
      page.screenshot({ path: join(OUT, `${name}-${theme}.png`), fullPage: false });

    await page.goto(stand.pageUrl);
    await expect(page.locator(".app")).toBeVisible();
    await expect(page.locator(".app")).toContainText("fake-model", { timeout: 60_000 });

    // ── 1. the empty state, 1440×900 ──
    // Dismiss the first-run card: it is the opener, not the product, and the
    // founder is judging the room the product lives in.
    const skip = page.getByRole("button", { name: "Skip this" });
    if (await skip.isVisible().catch(() => false)) await skip.click();
    await page.waitForTimeout(400);
    await shot("01-empty");

    // ── 2. a session mid-run, 1280×800 ──
    await page.setViewportSize({ width: 1280, height: 800 });
    const composer = page.getByLabel("Give Gear a coding task").or(page.locator(".input-field"));
    await composer.first().click();
    await composer.first().fill("read this repository and run the echo command");
    await composer.first().press("Enter");

    // The permission card is the run stopping on a decision. It is the third
    // image AND the reason the second one has a plan ledger above it.
    const card = page.getByRole("group", { name: "Permission request" });
    await expect(card).toBeVisible({ timeout: 120_000 });
    await expect(page.locator(".ledger")).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(300);
    await shot("02-session");

    // ── 3. the held decision, 1440×900 ──
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(300);
    await shot("03-decision");

    // Answer it so the run finishes; a screenshot set that leaves the engine
    // blocked would leave the last image lying about what happens next.
    await card.getByRole("button", { name: /Allow once/ }).click();
    await expect(page.locator(".main")).toContainText("hello-from-the-browser", {
      timeout: 120_000,
    });

    // ── 4. the palette, 1280×800 ──
    // On a fresh session, so the image is about the palette rather than about
    // whatever happened to be behind it — and so the finished session is in the
    // list it is searching.
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.getByRole("button", { name: /New session/ }).click();
    await page.waitForTimeout(400);
    await page.keyboard.press("Meta+k");
    const palette = page.getByRole("dialog", { name: "Search" });
    await expect(palette).toBeVisible();
    await palette.getByRole("textbox").fill("re");
    await page.waitForTimeout(300);
    await shot("04-palette");

    await context.close();
  });
}
