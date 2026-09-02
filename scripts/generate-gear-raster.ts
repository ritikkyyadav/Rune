// ─── The mark, rasterised ───
//
// Browsers take `favicon.svg`, and everything else in the world still wants a
// PNG or an ICO: an old browser's tab, an iOS home screen, a package listing,
// an OS icon. This renders those from the SAME generated SVG rather than from a
// second drawing, so there is one mark and not five that drifted.
//
// Rendered with the Playwright chromium `tests/e2e` already installs. That is a
// developer-machine dependency, not a build-time one: the PNGs and the ICO are
// committed, and this script exists so the founder's vector can replace
// `gear-mark.svg` and the derivatives can be regenerated in one command. When
// chromium is not installed it says so and exits 0 — a missing browser must not
// fail a build that is not rasterising anything.
//
// Usage:  bun run scripts/generate-gear-raster.ts [outdir]

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

/** The PNGs to emit, and the SVG each is rendered from. */
const TARGETS: Array<{ file: string; from: string; size: number }> = [
  { file: "icon-1024.png", from: "icon-1024.svg", size: 1024 },
  { file: "apple-touch-icon.png", from: "apple-touch-icon.svg", size: 180 },
];

/** The sizes packed into `favicon.ico`, rendered from `favicon.svg`. */
const ICO_SIZES = [16, 32, 48];

/**
 * An ICO file wrapping PNGs.
 *
 * The format is a six-byte header, one sixteen-byte directory entry per image,
 * then the images. A 256px image records its width as 0, which is the format's
 * way of saying "not 1..255"; nothing here is that big, but the encoder is
 * written to the spec rather than to the inputs.
 */
export function buildIco(images: Array<{ size: number; png: Uint8Array }>): Uint8Array {
  const header = 6;
  const entry = 16;
  const dirBytes = header + entry * images.length;
  const total = dirBytes + images.reduce((n, i) => n + i.png.length, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);

  view.setUint16(0, 0, true); // reserved
  view.setUint16(2, 1, true); // 1 = icon
  view.setUint16(4, images.length, true);

  let offset = dirBytes;
  images.forEach((img, i) => {
    const at = header + entry * i;
    out[at] = img.size >= 256 ? 0 : img.size;
    out[at + 1] = img.size >= 256 ? 0 : img.size;
    out[at + 2] = 0; // palette size: none, this is a PNG
    out[at + 3] = 0; // reserved
    view.setUint16(at + 4, 1, true); // colour planes
    view.setUint16(at + 6, 32, true); // bits per pixel
    view.setUint32(at + 8, img.png.length, true);
    view.setUint32(at + 12, offset, true);
    out.set(img.png, offset);
    offset += img.png.length;
  });
  return out;
}

/** The chromium `tests/e2e` installs, or null with a reason. */
async function loadChromium(): Promise<{
  launch: () => Promise<{
    newPage: (o: unknown) => Promise<{
      setContent: (html: string) => Promise<void>;
      screenshot: (o: unknown) => Promise<Buffer>;
      close: () => Promise<void>;
    }>;
    close: () => Promise<void>;
  }>;
} | null> {
  // Resolved from `tests/e2e`, not from here: Playwright is that workspace's
  // devDependency and nothing at the repo root depends on a browser.
  const from = join(import.meta.dir, "..", "tests", "e2e");
  for (const spec of ["@playwright/test", "playwright-core"]) {
    try {
      const mod = (await import(Bun.resolveSync(spec, from))) as {
        chromium?: unknown;
        default?: { chromium?: unknown };
      };
      const chromium = mod.chromium ?? mod.default?.chromium;
      if (chromium) return chromium as never;
    } catch {
      /* try the next spelling */
    }
  }
  return null;
}

async function main(): Promise<number> {
  const dir = process.argv[2] ?? "apps/web/branding";
  const chromium = await loadChromium();
  if (!chromium) {
    console.log(
      "playwright-core is not installed — skipping the raster derivatives.\n" +
        "  bun install --cwd tests/e2e && bun x --cwd tests/e2e playwright install chromium",
    );
    return 0;
  }

  const browser = await chromium.launch();
  const shoot = async (svgPath: string, size: number): Promise<Uint8Array> => {
    const svg = readFileSync(svgPath, "utf8");
    const page = await browser.newPage({
      viewport: { width: size, height: size },
      deviceScaleFactor: 1,
    });
    // `omitBackground` so the transparent parts of the mark stay transparent —
    // an icon composited onto white is an icon that cannot sit on a dark dock.
    await page.setContent(
      `<!doctype html><style>html,body{margin:0;padding:0}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`,
    );
    const png = await page.screenshot({ omitBackground: true });
    await page.close();
    return new Uint8Array(png);
  };

  for (const t of TARGETS) {
    const src = join(dir, t.from);
    if (!existsSync(src)) {
      console.error(`  missing ${src} — run scripts/generate-gear-mark.ts first`);
      await browser.close();
      return 1;
    }
    const png = await shoot(src, t.size);
    writeFileSync(join(dir, t.file), png);
    console.log(`  ${t.file}  ${t.size}×${t.size}  ${(png.length / 1024).toFixed(1)} KB`);
  }

  const faviconSvg = join(dir, "favicon.svg");
  const images = [];
  for (const size of ICO_SIZES) images.push({ size, png: await shoot(faviconSvg, size) });
  const ico = buildIco(images);
  writeFileSync(join(dir, "favicon.ico"), ico);
  console.log(`  favicon.ico  ${ICO_SIZES.join("/")}  ${(ico.length / 1024).toFixed(1)} KB`);

  await browser.close();
  return 0;
}

if (import.meta.main) process.exit(await main());
