// Acceptance for `signup-form-states`. Run by the runtime, never shown to the
// model. Behavior, keyboard and layout — never aesthetics.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { report, withPage } from "./browser.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const which = process.argv[2];

const checks = {
  // Nothing is submittable until it is valid, and an invalid field says why,
  // out loud, bound to the input it is about.
  async validation() {
    await withPage(root, { width: 1280, height: 900 }, async (page) => {
      const submit = page.getByRole("button", { name: "Create account", exact: true });
      assert.equal(await submit.isDisabled(), true, "submit must start disabled");
      const email = page.getByLabel("Email", { exact: true });
      await email.fill("not-an-address");
      await email.blur();
      const alert = page.locator('[role="alert"]:visible');
      await alert.first().waitFor({ timeout: 4000 });
      assert.equal(await email.getAttribute("aria-invalid"), "true");
      const describedBy = await email.getAttribute("aria-describedby");
      assert.ok(describedBy, "the email input names no description");
      assert.ok(
        (await page.locator(`#${describedBy}`).innerText()).trim().length > 0,
        "the described error is empty",
      );
      await email.fill("someone@example.com");
      await page.getByLabel("Password", { exact: true }).fill("a-long-passphrase");
      const confirm = page.getByLabel("Confirm password", { exact: true });
      await confirm.fill("something-else");
      await confirm.blur();
      assert.equal(await submit.isDisabled(), true, "a mismatch must keep submit disabled");
      assert.ok(
        /match/i.test(await page.locator("body").innerText()),
        "a password mismatch is never explained",
      );
    });
  },
  // The whole form is reachable from the keyboard, in order, with a focus ring.
  //
  // Filled with valid values first, deliberately: a disabled submit button is
  // not tabbable, so an empty form can never show the full tab order. This
  // criterion is about the ORDER, not about the disabled state, which c1 owns.
  async keyboard() {
    await withPage(root, { width: 1280, height: 900 }, async (page) => {
      await page.getByLabel("Email", { exact: true }).fill("someone@example.com");
      await page.getByLabel("Password", { exact: true }).fill("a-long-passphrase");
      await page.getByLabel("Confirm password", { exact: true }).fill("a-long-passphrase");
      await page.getByLabel("Email", { exact: true }).focus();
      const order = [];
      for (let i = 0; i < 3; i++) {
        await page.keyboard.press("Tab");
        order.push(
          await page.evaluate(() => {
            const node = document.activeElement;
            return node?.dataset?.field ?? node?.id ?? node?.tagName?.toLowerCase() ?? "";
          }),
        );
      }
      assert.deepEqual(
        order,
        ["password", "confirm", "submit"],
        `tab order was ${order.join(" → ")}`,
      );
      const outlined = await page.evaluate(() => {
        const style = window.getComputedStyle(document.activeElement);
        return (
          (style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0) ||
          style.boxShadow !== "none"
        );
      });
      assert.ok(outlined, "the focused control has no visible focus ring");
    });
  },
  // A valid submit confirms out loud, and the narrow viewport does not overflow.
  async successAndMobile() {
    await withPage(root, { width: 390, height: 844 }, async (page, errors) => {
      await page.getByLabel("Email", { exact: true }).fill("someone@example.com");
      await page.getByLabel("Password", { exact: true }).fill("a-long-passphrase");
      await page.getByLabel("Confirm password", { exact: true }).fill("a-long-passphrase");
      const submit = page.getByRole("button", { name: "Create account", exact: true });
      await submit.click();
      await page.locator('[role="status"]:visible').first().waitFor({ timeout: 4000 });
      assert.match(await page.locator("body").innerText(), /account created/i);
      assert.ok(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
        "mobile horizontal overflow",
      );
      await page.screenshot({ path: join(root, "acceptance-mobile.png"), fullPage: true });
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
