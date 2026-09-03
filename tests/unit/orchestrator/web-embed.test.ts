/**
 * Where `gear serve --web` finds the page it hands out.
 *
 * P10.9a's first defect: the server computed `<engineRoot>/apps/web/dist`, a
 * path that exists only in a source checkout. From the compiled binary the
 * lookup failed, the "not built" message went to a log nobody reads, `--web`
 * silently did nothing, and the browser's first request fell through to the
 * API path and was answered `401 unauthorized`.
 *
 * The rules asserted here are the ones that make that impossible: an on-disk
 * dist wins when it exists (so a developer's rebuild is visible), the embedded
 * copy answers when it does not (so the artifact serves the product), and
 * "neither" is `null` — a caller that must refuse to start rather than serve
 * a 401 to a browser.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  embeddedBundle,
  referencedAssets,
  resolveWebBundle,
} from "../../../packages/orchestrator/src/web-embed";

/**
 * Whether THIS checkout has a generated manifest.
 *
 * It is a build artifact, so the suite runs both with one (after any compile
 * path ran `scripts/gen-web-embed.ts`) and without (a fresh clone). The rules
 * below are written against this fact rather than assuming either, because a
 * test that only passes on an unbuilt tree is a test that starts failing the
 * day the gate gets stricter.
 */
const HAS_EMBED = (await embeddedBundle()) !== null;

const dirs: string[] = [];

function distWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "gear-web-embed-"));
  dirs.push(dir);
  for (const [rel, body] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, body);
  }
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("resolveWebBundle", () => {
  test("an on-disk dist with an index.html is used, and named", async () => {
    const dist = distWith({ "index.html": "<html></html>" });
    const bundle = await resolveWebBundle(dist);
    expect(bundle).not.toBeNull();
    expect(bundle!.source).toBe("disk");
    expect(bundle!.dist).toBe(dist);
    expect(bundle!.label).toBe(dist);
  });

  test("an on-disk dist wins even when this build has an embedded copy", async () => {
    // The developer's case: `bun run --cwd apps/web build` in one terminal and
    // the server in another. A stale embedded copy shadowing the rebuild would
    // be maddening and silent.
    const dist = distWith({ "index.html": "<html>fresh</html>" });
    const bundle = await resolveWebBundle(dist);
    expect(bundle!.source).toBe("disk");
    expect(bundle!.files).toBeUndefined();
  });

  test("a directory without index.html falls through to the embed", async () => {
    // The half-built case: `vite build` interrupted, or a `dist/` left over
    // from another tool. Serving it would answer 404 to the page request.
    const dist = distWith({ "assets/app.js": "console.log(1)" });
    const bundle = await resolveWebBundle(dist);
    if (HAS_EMBED) expect(bundle!.source).toBe("embedded");
    else expect(bundle).toBeNull();
  });

  test("a path that does not exist falls through to the embed", async () => {
    const bundle = await resolveWebBundle("/nonexistent/apps/web/dist");
    if (HAS_EMBED) expect(bundle!.source).toBe("embedded");
    else expect(bundle).toBeNull();
  });

  test("null (no source tree — the compiled case) uses the embed alone", async () => {
    // This is the exact call a compiled binary makes: `sourceDistDir()`
    // returns null because the source is virtual, and the only bundle left is
    // the one inside the executable.
    const bundle = await resolveWebBundle(null);
    if (HAS_EMBED) {
      expect(bundle!.source).toBe("embedded");
      expect(bundle!.files!["index.html"]).toBeTruthy();
      expect(bundle!.dist).toBeUndefined();
      expect(bundle!.label).toContain("embedded in this binary");
    } else {
      // A checkout that has never built the client. The caller must refuse to
      // start rather than answer 401 to a browser.
      expect(bundle).toBeNull();
    }
  });
});

describe("referencedAssets", () => {
  test("finds the hashed script and stylesheet the page loads", () => {
    const html = `<!doctype html><html><head>
      <link rel="stylesheet" href="/assets/index-Di0j9cAO.css">
      <link rel="icon" href="/favicon.svg">
      <script type="module" src="/assets/index-CEeI1pgd.js"></script>
      </head><body></body></html>`;
    expect(referencedAssets(html).sort()).toEqual([
      "/assets/index-CEeI1pgd.js",
      "/assets/index-Di0j9cAO.css",
      "/favicon.svg",
    ]);
  });

  test("ignores absolute URLs and in-page anchors", () => {
    const html = `<a href="#top">t</a><script src="https://cdn.example.com/x.js"></script>`;
    expect(referencedAssets(html)).toEqual([]);
  });

  test("does not repeat an asset referenced twice", () => {
    const html = `<link href="/a.css"><link href="/a.css">`;
    expect(referencedAssets(html)).toEqual(["/a.css"]);
  });

  test("an empty list is a finding, not a pass", () => {
    // `gear serve --check` treats zero assets as a failure: a page that loads
    // nothing is not the real build, and a map with one entry in it would
    // otherwise sail through.
    expect(referencedAssets("<html><body>hi</body></html>")).toEqual([]);
  });
});
