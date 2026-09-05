import { readFileSync } from "node:fs";

// --- Product identity (Rune) ---
// "Rune" is the only product name -- in the UI and in the internals (dirs, env,
// packages, binaries). It replaced "Gear" on 2026-09-03 (which had replaced
// "Alan"); the previous spellings survive only as read-through migration shims
// -- shared/paths.ts (home, database, memory file, env), credential-store.ts
// (keychain service), git-undo.ts (commit prefix), playbook.ts and
// evolve/promote.ts (markers), org-policy.ts (system paths) -- never as a name
// anything prints.
// Every user-visible surface (startup banner, /status card, --version, help) reads
// its name + version from here, so the current brand is defined in one place.

/** Public product name shown to users. */
export const PRODUCT_NAME = "Rune";

/** Command shown in help and guidance. */
export const PRODUCT_COMMAND = "rune";

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

/** Full public identifier, e.g. for `--version`: "Rune v0.3.0". */
export const PRODUCT_LABEL = `${PRODUCT_NAME} v${PRODUCT_VERSION}`;
