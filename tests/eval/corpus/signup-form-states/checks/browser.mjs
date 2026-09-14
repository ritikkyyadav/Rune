/** Shared browser plumbing for the corpus's two frontend tasks. */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Where Playwright is. `env.json` is written by the corpus runner because the
 * tool sandbox filters environment variables; a check that cannot find the
 * runtime must say so rather than fail as if the page were broken.
 */
export function playwrightConfig() {
  const file = join(here, "env.json");
  const fromFile = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const module = fromFile.playwrightModule ?? process.env.RUNE_BENCH_PLAYWRIGHT;
  const browsers = fromFile.browsersPath ?? process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (browsers) process.env.PLAYWRIGHT_BROWSERS_PATH = browsers;
  return { module };
}

/** Serve the workspace over loopback, run `body(page)`, then tear both down. */
export async function withPage(root, viewport, body) {
  const { module } = playwrightConfig();
  if (!module) throw new Error("PLAYWRIGHT_UNAVAILABLE: no browser runtime is configured here");
  const { chromium } = await import(module);
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const path = new URL(request.url).pathname;
      const relative = path === "/" ? "index.html" : decodeURIComponent(path.slice(1));
      if (relative.split("/").includes("..")) return new Response("forbidden", { status: 403 });
      return new Response(Bun.file(join(root, relative)));
    },
  });
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    server.stop(true);
    throw new Error(
      `PLAYWRIGHT_UNAVAILABLE: chromium would not start — ${String(error?.message ?? error).slice(0, 200)}`,
    );
  }
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(`http://127.0.0.1:${server.port}`, { waitUntil: "networkidle" });
    return await body(page, errors);
  } finally {
    await browser.close();
    server.stop(true);
  }
}

/** Every check script's tail: one word for the reader, one exit code for the runtime. */
export async function report(which, run) {
  const safe = (message) =>
    String(message)
      .replace(/no such file or directory/gi, "missing")
      .replace(/command not found/gi, "unavailable");
  try {
    await run();
    console.log(`acceptance ok: ${which}`);
    process.exit(0);
  } catch (error) {
    const message = safe(error?.message ?? error);
    // A missing browser is not a failed layout. Saying so lets the runtime
    // derive `needs_review` instead of blaming the work.
    if (message.includes("PLAYWRIGHT_UNAVAILABLE")) {
      console.log(`acceptance not-applicable: ${which} — ${message}`);
      process.exit(2);
    }
    console.log(`acceptance failed: ${which} — ${message}`);
    process.exit(1);
  }
}
