// Acceptance for `responsive-project-board`. Run by the runtime, never shown to
// the model. Derived from tests/eval/comparison/frontend-task.ts's single
// grader, split so each half of the brief has its own status. It checks
// behavior and layout, never aesthetics.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { report, withPage } from "./browser.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const which = process.argv[2];

const checks = {
  // 1440 wide: six cards, more than one column, nothing collapsed to a sliver.
  async desktop() {
    await withPage(root, { width: 1440, height: 1000 }, async (page) => {
      await page.locator('[data-project-id="kestrel"]').waitFor();
      const cards = page.locator("[data-project-id]:visible");
      assert.equal(await cards.count(), 6);
      const boxes = await cards.evaluateAll((nodes) =>
        nodes.map((node) => {
          const rect = node.getBoundingClientRect();
          return { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
        }),
      );
      assert.ok(
        boxes.some((a, i) =>
          boxes.some((b, j) => i !== j && Math.abs(a.y - b.y) < 10 && Math.abs(a.x - b.x) > 100),
        ),
        "desktop needs multiple card columns",
      );
      assert.ok(boxes.every((box) => box.w >= 180 && box.h >= 70));
      await page.screenshot({ path: join(root, "acceptance-desktop.png"), fullPage: true });
    });
  },
  // The favorite toggle: reachable by keyboard, announced by aria-pressed, and
  // still on after a reload.
  async favorites() {
    await withPage(root, { width: 1440, height: 1000 }, async (page) => {
      await page.locator('[data-project-id="kestrel"]').waitFor();
      const fav = page.getByRole("button", { name: "Favorite Kestrel", exact: true });
      await fav.focus();
      await page.keyboard.press("Enter");
      assert.equal(
        await page
          .getByRole("button", { name: /Favorite Kestrel|Favorited/ })
          .first()
          .getAttribute("aria-pressed"),
        "true",
      );
      await page.reload({ waitUntil: "networkidle" });
      assert.equal(
        await page
          .locator('[data-project-id="kestrel"] [aria-pressed]')
          .first()
          .getAttribute("aria-pressed"),
        "true",
        "the favorite did not survive a reload",
      );
    });
  },
  // Filter and search combine, the empty state appears, and 390 wide neither
  // overflows nor drops a card. Console errors fail the criterion.
  async filteringAndMobile() {
    await withPage(root, { width: 1440, height: 1000 }, async (page, errors) => {
      await page.locator('[data-project-id="kestrel"]').waitFor();
      const cards = page.locator("[data-project-id]:visible");
      await page.getByRole("button", { name: "Archived", exact: true }).click();
      assert.equal(await cards.count(), 2);
      await page.getByRole("button", { name: "All", exact: true }).click();
      const search = page.getByLabel("Search projects", { exact: true });
      await search.fill("kestrel");
      await page.waitForTimeout(350);
      assert.equal(await cards.count(), 1);
      await page.getByRole("button", { name: "Archived", exact: true }).click();
      assert.equal(await cards.count(), 0);
      assert.match(
        await page.locator("body").innerText(),
        /no (?:projects|results|matches)|nothing (?:found|matches)/i,
        "no empty state",
      );
      await page.getByRole("button", { name: "All", exact: true }).click();
      await search.fill("");
      await page.waitForTimeout(350);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: join(root, "acceptance-mobile.png"), fullPage: true });
      assert.equal(await cards.count(), 6);
      assert.ok(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
        "mobile horizontal overflow",
      );
      const mobile = await cards.evaluateAll((nodes) =>
        nodes.map((node) => {
          const rect = node.getBoundingClientRect();
          return { x: rect.x, right: rect.right, w: rect.width };
        }),
      );
      assert.ok(mobile.every((box) => box.x >= -1 && box.right <= 391 && box.w >= 180));
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
