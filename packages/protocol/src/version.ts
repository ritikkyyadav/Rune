// ─── Protocol version ───
//
// The one number every client and the host agree on. It is NOT the product
// version: it moves only when the wire contract changes in a way a client can
// observe. A client that speaks a different MAJOR is refused at the door
// rather than left to fail on a field it does not understand three frames
// later.

/** Semver of the wire contract. Bump MAJOR on any breaking frame change. */
export const PROTOCOL_VERSION = "1.0.0" as const;

/** Major component of `PROTOCOL_VERSION`, the compatibility axis. */
export const PROTOCOL_MAJOR = 1 as const;

/**
 * Whether a peer advertising `version` can talk to this build.
 *
 * Same major only. Minor and patch are additive by construction: a newer host
 * may emit event members an older client ignores, which is why every reducer
 * in this repo is required to have an explicit ignore branch rather than
 * throwing on the unknown.
 */
export function isCompatibleVersion(version: string): boolean {
  const major = Number.parseInt(String(version).split(".")[0] ?? "", 10);
  return Number.isFinite(major) && major === PROTOCOL_MAJOR;
}
