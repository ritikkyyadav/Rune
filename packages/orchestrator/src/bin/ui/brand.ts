// ─── Product identity (Gear) ───
// "Gear" is the public product name. Legacy Alan/Berne/Elio identifiers remain
// only where changing them would strand an existing install, session, or credential.
// Every user-visible surface (startup banner, /status card, --version, help) reads
// its name + version from here, so the current brand is defined in one place.

/** Public product name shown to users. */
export const PRODUCT_NAME = "Gear";

/** Command shown in help and guidance. Older elio/berne/alan launchers remain aliases. */
export const PRODUCT_COMMAND = "gear";

/** Display version — rendered as `v0.2.0`. Kept in lockstep with the package semver. */
export const PRODUCT_VERSION = "0.2.0";

/** Full public identifier, e.g. for `--version`: "Gear v0.2.0". */
export const PRODUCT_LABEL = `${PRODUCT_NAME} v${PRODUCT_VERSION}`;
