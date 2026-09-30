// Acceptance for `pricing-page-mobile`. Run by the grader, never shown to the
// model. Layout, the menu's behaviour and the console — never aesthetics.
//
// The plumbing is the corpus's: browser.mjs is byte-for-byte the helper both
// corpus frontend tasks use (serve the workspace on loopback, open it in
// Chromium, exit 2 with PLAYWRIGHT_UNAVAILABLE when no browser can start), and
// every Playwright call below is one those tasks' checks already make.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { report, withPage } from "./browser.mjs";

// Staged outside the workspace, run with cwd = the workspace (see rune-cli's
// --acceptance help): the tree under test is the working directory, and
// `here` stays the script's own directory for the files staged beside it.
const here = dirname(fileURLToPath(import.meta.url));
const root = process.cwd();
const which = process.argv[2];

const PLANS = ["starter", "team", "enterprise"];

/** The plan cards on screen, in document order, with their boxes. */
async function planCards(page) {
  await page.locator('[data-plan="starter"]').waitFor();
  return page.locator("[data-plan]:visible").evaluateAll((nodes) =>
    nodes.map((node) => {
      const rect = node.getBoundingClientRect();
      return {
        plan: node.getAttribute("data-plan"),
        x: rect.x,
        y: rect.y,
        w: rect.width,
        h: rect.height,
      };
    }),
  );
}

const menuButton = (page) => page.getByRole("button", { name: "Menu", exact: true });
const link = (page, name) => page.getByRole("link", { name, exact: true }).first();

const checks = {
  // 1280 wide is the page it always was: three cards in a row, the links in
  // the header, and no Menu button.
  async desktop() {
    await withPage(root, { width: 1280, height: 900 }, async (page) => {
      const cards = await planCards(page);
      assert.deepEqual(
        cards.map((card) => card.plan),
        PLANS,
        "the three plan cards are not all on the page, in order",
      );
      assert.ok(
        cards.every((card) => Math.abs(card.y - cards[0].y) < 10),
        "at 1280 the plan cards are not side by side",
      );
      assert.ok(
        cards[0].x < cards[1].x && cards[1].x < cards[2].x,
        "at 1280 the plan cards are out of order",
      );
      assert.ok(
        cards.every((card) => card.w >= 200 && card.h >= 100),
        "at 1280 a plan card has collapsed",
      );
      for (const name of ["Features", "Docs", "Sign in"])
        assert.ok(await link(page, name).isVisible(), `at 1280 the ${name} link is not shown`);
      const menus = menuButton(page);
      assert.ok(
        (await menus.count()) === 0 || !(await menus.first().isVisible()),
        "at 1280 there is a Menu button",
      );
      await page.screenshot({ path: join(here, "acceptance-desktop.png"), fullPage: true });
    });
  },
  // 390 wide: one column in the same order, the comparison table still there,
  // nothing scrolling sideways, and no errors in the console.
  async mobile() {
    await withPage(root, { width: 390, height: 844 }, async (page, errors) => {
      const cards = await planCards(page);
      assert.deepEqual(
        cards.map((card) => card.plan),
        PLANS,
        "at 390 the three plan cards are not all on the page, in order",
      );
      for (let i = 1; i < cards.length; i++)
        assert.ok(
          cards[i].y >= cards[i - 1].y + cards[i - 1].h - 1,
          `at 390 the ${cards[i].plan} card is not below the ${cards[i - 1].plan} card`,
        );
      assert.ok(
        cards.every((card) => card.x >= -1 && card.x + card.w <= 391),
        "at 390 a plan card sticks out of the viewport",
      );
      assert.ok(
        await page.locator("table").first().isVisible(),
        "at 390 the comparison table is gone",
      );
      assert.ok(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
        "at 390 the page scrolls sideways",
      );
      await page.screenshot({ path: join(here, "acceptance-mobile.png"), fullPage: true });
      assert.deepEqual(errors, [], "browser errors");
    });
  },
  // 390 wide: the links wait behind a Menu button that says whether it is
  // open, names what it opens, and opens and closes from the keyboard.
  async menu() {
    await withPage(root, { width: 390, height: 844 }, async (page, errors) => {
      const menu = menuButton(page).first();
      await menu.waitFor({ timeout: 4000 });
      assert.equal(
        await menu.getAttribute("aria-expanded"),
        "false",
        "the Menu button does not start with aria-expanded=false",
      );
      const controls = await menu.getAttribute("aria-controls");
      assert.ok(controls, "the Menu button names nothing with aria-controls");
      const panel = page.locator(`[id="${controls.replace(/["\\]/g, "\\$&")}"]`);
      assert.equal(
        await panel.count(),
        1,
        `aria-controls names "${controls}", which is not on the page`,
      );
      const docs = link(page, "Docs");
      assert.equal(
        await docs.isVisible(),
        false,
        "at 390 the links show before the menu is opened",
      );
      await menu.focus();
      await page.keyboard.press("Enter");
      await docs.waitFor({ state: "visible", timeout: 3000 });
      assert.equal(
        await menu.getAttribute("aria-expanded"),
        "true",
        "the open menu does not say aria-expanded=true",
      );
      assert.equal(
        await panel.getByRole("link", { name: "Docs", exact: true }).count(),
        1,
        "the element aria-controls names does not hold the links",
      );
      await menu.focus();
      await page.keyboard.press("Enter");
      await docs.waitFor({ state: "hidden", timeout: 3000 });
      assert.equal(
        await menu.getAttribute("aria-expanded"),
        "false",
        "the closed menu does not say aria-expanded=false",
      );
      assert.deepEqual(errors, [], "browser errors");
    });
  },
};

const run = checks[which];
if (!run) {
  console.log(`acceptance failed: unknown criterion ${which}`);
  process.exit(1);
}
await report(which, run);
