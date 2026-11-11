import { readFileSync } from "node:fs";
import { PRODUCT_NAME } from "@rune/shared";

// Public branding is shared with browser surfaces and provider authentication.
// The @rune packages, RUNE_* variables, ~/.rune data, keychain services and wire
// identifiers stay stable so the name change never splits an existing install.
export { PRODUCT_NAME, PRODUCT_COMMAND } from "@rune/shared";
export const PRODUCT_WORDMARK = [...PRODUCT_NAME.toUpperCase()].join(" ");

/**
 * Injected at build time by `bun build --define=RUNE_BUILD_VERSION="..."`.
 *
 * `scripts/version.sh` is the one place that decides what this string is — the
 * exact git tag at HEAD for a release build, `<package semver>-dev+<sha>` for
 * everything else — and every build path calls it. The version used to live in
 * four hand-maintained copies that drifted from each other and from the only
 * tag in the repo. A binary can no longer disagree with the tag it was built
 * from, because nothing else knows the version.
 */
declare const RUNE_BUILD_VERSION: string | undefined;

/**
 * The fallback for a source run (`bun packages/orchestrator/src/bin/rune-cli.ts`),
 * where no define exists: the CLI package's own semver, marked dev. A compiled
 * binary never takes this path. `0.0.0-unknown` means the package.json could not
 * be read at all — loud on purpose, because a confidently wrong version is the
 * exact defect this mechanism exists to end.
 */
function sourceRunVersion(): string {
  try {
    const url = new URL("../../../package.json", import.meta.url);
    const parsed = JSON.parse(readFileSync(url, "utf8")) as { version?: string };
    if (typeof parsed.version === "string" && parsed.version.length > 0) {
      return `${parsed.version}-dev`;
    }
  } catch {
    // Fall through to the loud value.
  }
  return "0.0.0-unknown";
}

/** Display version -- rendered as `v0.3.0`. */
export const PRODUCT_VERSION: string =
  typeof RUNE_BUILD_VERSION !== "undefined" && RUNE_BUILD_VERSION
    ? RUNE_BUILD_VERSION
    : sourceRunVersion();

/**
 * The version as a person reads it in the frame: `0.1.1`, never
 * `0.1.1-dev+6b9afcf`. The build marker is for `--version`, `will doctor` and
 * the install guard, which compare builds; the header names the product a
 * person is using (founder, 2026-09-16: "simply v0.1.1"). A source run keeps its
 * `-dev` marker stripped too -- the number is still the truth about which
 * product this is.
 */
export function displayVersion(version: string): string {
  return version.replace(/-dev(\+[0-9a-f]+)?$/i, "");
}

export const PRODUCT_DISPLAY_VERSION: string = displayVersion(PRODUCT_VERSION);

/** Full public identifier, e.g. for `--version`: "Will v0.3.0". */
export const PRODUCT_LABEL = `${PRODUCT_NAME} v${PRODUCT_VERSION}`;
