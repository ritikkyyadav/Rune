/**
 * Regression: freshness keys must survive symlinked workspaces. The Rust
 * tools echo canonicalized paths (macOS: /var → /private/var) while the
 * harness passes the raw workspace root — keying on the raw string made
 * every relative-path edit in a symlinked workspace fail read-before-edit.
 * Caught live against the real binary on 2026-07-07.
 */

import { describe, test, expect } from "bun:test";
import { mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileFreshness } from "../../../packages/tool-registry/src/tools/freshness";

describe("FileFreshness — symlinked workspace roots", () => {
  test("hash noted via the canonical path is found via the symlinked path", () => {
    // real dir + a symlink pointing at it (the /var → /private/var shape).
    const real = realpathSync(mkdtempSync(join(tmpdir(), "fresh-real-")));
    const linkParent = realpathSync(mkdtempSync(join(tmpdir(), "fresh-link-")));
    const link = join(linkParent, "ws");
    symlinkSync(real, link);
    writeFileSync(join(real, "a.ts"), "x\n");

    const f = new FileFreshness();
    // The Rust tool reports the canonicalized absolute path…
    f.note(link, join(real, "a.ts"), "hash-1");
    // …while the next edit call resolves "a.ts" against the SYMLINKED root.
    expect(f.get(link, "a.ts")).toBe("hash-1");

    // And the reverse: noted via the symlinked root, found via canonical.
    const g = new FileFreshness();
    g.note(real, join(link, "a.ts"), "hash-2");
    expect(g.get(real, "a.ts")).toBe("hash-2");
  });

  test("not-yet-existing files still key consistently (first write)", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "fresh-new-")));
    const f = new FileFreshness();
    f.note(dir, "new-file.ts", "h");
    expect(f.get(dir, "new-file.ts")).toBe("h");
  });
});
