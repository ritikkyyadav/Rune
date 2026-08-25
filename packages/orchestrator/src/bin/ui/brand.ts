// ─── Product identity (Gear) ───
// "Gear" is the only product name — in the UI and in the internals (dirs, env,
// packages, binaries). Legacy spellings survive only as read-through migration
// shims in shared/paths.ts and credential-store.ts.
// Every user-visible surface (startup banner, /status card, --version, help) reads
// its name + version from here, so the current brand is defined in one place.

/** Public product name shown to users. */
export const PRODUCT_NAME = "Gear";

/** Command shown in help and guidance. */
export const PRODUCT_COMMAND = "gear";

/** Display version — rendered as `v0.3.0`. Kept in lockstep with the package semver. */
export const PRODUCT_VERSION = "0.3.0";

/** Full public identifier, e.g. for `--version`: "Gear v0.2.0". */
export const PRODUCT_LABEL = `${PRODUCT_NAME} v${PRODUCT_VERSION}`;
