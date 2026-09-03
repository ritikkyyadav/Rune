// ─── The two images the founder reviews ───
//
// `/gallery` is thirty primitives in four states on both grounds, plus the six
// composed surfaces. These are the shipping bundle rendering it — the real
// components, the real schemas, the real composer, the real tokens — captured
// once per browser colour scheme.
//
// No engine. The gallery is a static page: the fixture is a Task State literal,
// the composer is pure, and standing up a real Gear to screenshot a component
// catalogue would make the deliverable depend on a provider handshake. So this
// spec serves `apps/web/dist` itself, on a port the OS picks, and stops it
// afterwards — the founder's preview on 7791 is never touched.
//
// `deviceScaleFactor: 0.5` because the page is ~14,000 CSS pixels tall. At 1
// the capture is over Chromium's texture limit and the PNG is unreadable at
// any zoom that fits a screen; at 0.5 the whole vocabulary is one image a
// person can actually scan, and the text is still legible at 100%.

import { expect, test } from "@playwright/test";
import { createReadStream, existsSync, mkdirSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { extname, join, normalize } from "node:path";

import { REPO_ROOT } from "../fixtures/stand-up";

const DIST = join(REPO_ROOT, "apps/web/dist");
const OUT = join(REPO_ROOT, "docs/design/web");

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

let server: Server;
let base: string;

test.beforeAll(async () => {
  test.skip(!existsSync(join(DIST, "index.html")), "apps/web/dist is missing — build it first");
  mkdirSync(OUT, { recursive: true });

  server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0]!;
    const rel = path === "/" ? "index.html" : normalize(path).replace(/^(\.\.[/\\])+/, "");
    const file = join(DIST, rel);
    // Unknown paths are routes, not missing files — the same rule
    // `serve-cli.ts` applies, so `/gallery` reaches the bundle here too.
    const target = existsSync(file) && statSync(file).isFile() ? file : join(DIST, "index.html");
    res.writeHead(200, { "content-type": TYPES[extname(target)] ?? "application/octet-stream" });
    createReadStream(target).pipe(res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  base = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

for (const theme of ["light", "dark"] as const) {
  test(`gallery — ${theme}`, async ({ browser }) => {
    const context = await browser.newContext({
      colorScheme: theme,
      viewport: { width: 1600, height: 1000 },
      deviceScaleFactor: 0.5,
    });
    const page = await context.newPage();

    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });

    await page.goto(`${base}/gallery`);
    await expect(page.locator(".gal")).toBeVisible();
    await expect(page.getByRole("heading", { name: "The primitive catalogue" })).toBeVisible();

    // Every primitive rendered a section, and the composed surfaces are there.
    await expect(page.locator("section.gal-section")).toHaveCount(31);
    await expect(page.locator("#surfaces .surface")).toHaveCount(2);

    // Both grounds are live in one document — the whole point of the layout.
    await expect(page.locator('.gal-cell[data-theme="light"]').first()).toBeVisible();
    await expect(page.locator('.gal-cell[data-theme="dark"]').first()).toBeVisible();

    // The states are on the page rather than behind a control.
    for (const state of ["ready", "empty", "loading", "error"]) {
      await expect(page.locator(`.gal-cell[data-state="${state}"]`).first()).toBeVisible();
    }

    // The refuted hypothesis is folded to one line, and unfolds.
    const refuted = page.locator('.gal-cell[data-state="refuted, folded"]').first();
    await expect(refuted.locator(".p-hypothesis.folded")).toBeVisible();
    await refuted.locator(".p-hyp-head").click();
    await expect(refuted.locator(".p-hypothesis.open")).toBeVisible();
    await refuted.locator(".p-hyp-head").click();

    // Fonts and web fonts settle before the capture, or the image ships with
    // a fallback stack the founder would read as the design.
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(600);

    await page.screenshot({ path: join(OUT, `gallery-${theme}.png`), fullPage: true });

    expect(errors, `console errors: ${errors.join(" | ")}`).toEqual([]);
    await context.close();
  });
}
