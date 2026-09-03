// ─── The web client, inside the binary ───
//
// The product is a browser page. Until P10.9a the server found that page by
// computing `<engineRoot>/apps/web/dist` — a path that exists in a source
// checkout and nowhere else. `bun build --compile` produces a single file with
// no `apps/` beside it, so from the artifact people install, `engineRoot()`
// resolved to the binary's virtual root (or, worse, to the machine the binary
// was built on), `webBundleBuilt()` said no, `gear serve --web` logged "the
// web client is not built" to a stream nobody was watching, and the first page
// request fell through to the API path and was answered `401 unauthorized`.
// The founder opened the product URL and read "unauthorized".
//
// The fix is that the bundle travels WITH the binary. Bun copies any file
// imported with `with { type: "file" }` into a `--compile` output and hands
// back a `/$bunfs/root/…` path that `Bun.file()` opens like any other. The
// generated manifest (`generated.js`, written by `scripts/gen-web-embed.ts`)
// is one such import per asset plus a path map; this module is the reader.
//
// Precedence is deliberate: an on-disk `dist/` WINS when it exists. A
// developer running `bun run --cwd apps/web build` in one terminal and the
// server in another must see the rebuild, and they would not if a stale
// embedded copy shadowed it. A compiled binary has no on-disk dist, so it
// falls through to the embedded copy — which is the only copy it has.

import { existsSync } from "node:fs";
import { join } from "node:path";

/** A resolved client bundle and where it came from. */
export interface WebBundle {
  /** The on-disk `apps/web/dist`, when serving from a checkout. */
  dist?: string;
  /** rel path → an openable path, when serving from inside the binary. */
  files?: Record<string, string>;
  /** One line for the banner: which of the two, and where. */
  label: string;
  /** "disk" or "embedded" — asserted by `gear serve --check`. */
  source: "disk" | "embedded";
}

let cached: { files: Record<string, string>; builtAt: string } | null | undefined;

/**
 * The embedded manifest, or null if this build has none.
 *
 * A dynamic import with a literal specifier so the failure is catchable: Bun
 * still resolves and bundles it statically (that is what carries the assets
 * into the executable), but a source run on a checkout that never generated
 * the manifest gets a "Cannot find module" it can shrug off rather than a
 * crash at import time.
 */
export async function embeddedBundle(): Promise<{
  files: Record<string, string>;
  builtAt: string;
} | null> {
  if (cached !== undefined) return cached;
  try {
    const mod = await import("./generated");
    const files = mod.WEB_EMBED;
    cached =
      files && Object.keys(files).length > 0
        ? { files, builtAt: mod.WEB_EMBED_BUILT_AT ?? "unknown" }
        : null;
  } catch {
    cached = null;
  }
  return cached;
}

/** Test seam: forget what `embeddedBundle()` decided. */
export function resetEmbeddedBundleCache(): void {
  cached = undefined;
}

/**
 * The asset paths an `index.html` references.
 *
 * So a check can read the real bundle rather than a hand-maintained list, and
 * so "the bundle is present" means more than one file: a manifest with only
 * `index.html` in it serves a blank page with 404s in the console, and would
 * otherwise pass every assertion anyone thought to write.
 */
export function referencedAssets(html: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/(?:src|href)="(\/[^"]+\.(?:js|css|svg|ico|png|woff2?))"/g)) {
    out.add(m[1]!);
  }
  return [...out];
}

/**
 * Where this process should serve the client from, or null if it cannot.
 *
 * `null` is the honest answer for a source checkout that has never run the
 * web build, and the caller says so loudly rather than starting a server that
 * answers `401` to a browser.
 */
export async function resolveWebBundle(distDir: string | null): Promise<WebBundle | null> {
  if (distDir && existsSync(join(distDir, "index.html"))) {
    return { dist: distDir, label: distDir, source: "disk" };
  }
  const embedded = await embeddedBundle();
  if (embedded && embedded.files["index.html"]) {
    return {
      files: embedded.files,
      label: `embedded in this binary (built ${embedded.builtAt})`,
      source: "embedded",
    };
  }
  return null;
}
