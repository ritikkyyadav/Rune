// ─── Product identity (Berne) ───
// "Berne" is the public product name. "Alan" remains the internal codename used
// throughout package names (`@alan/*`), the `~/.alan` data directory, env vars and
// code identifiers — none of which the user sees. Every user-visible surface (startup
// banner, /status card, --version, help) reads its name + version from here, so the
// brand is defined in exactly one place.

/** Public product name shown to users. */
export const PRODUCT_NAME = "Berne";

/** Display version — rendered as `v0.2.0`. Kept in lockstep with the package semver. */
export const PRODUCT_VERSION = "0.2.0";

/** Full public identifier, e.g. for `--version`: "Berne v0.2.0". */
export const PRODUCT_LABEL = `${PRODUCT_NAME} v${PRODUCT_VERSION}`;
