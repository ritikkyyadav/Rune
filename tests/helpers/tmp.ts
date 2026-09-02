/**
 * Removing a temp directory, on an operating system that locks files.
 *
 * POSIX lets you unlink a file another process still holds open; Windows does
 * not. So `rmSync(dir, {recursive:true, force:true})` in an `afterEach` — the
 * shape used across this suite — throws `EBUSY: resource busy or locked` on
 * Windows whenever anything inside is still open a moment after being closed.
 * SQLite is the usual culprit: `close()` returns, the handle is released a few
 * milliseconds later, and the directory removal lands in between. That accounted
 * for 64 of the 108 failures in the first Windows run of `bun test tests/unit/`
 * (P10.2) — every one of them a teardown, not a test.
 *
 * So: retry briefly, then give up QUIETLY. Both halves are deliberate.
 *
 * Retrying is right because the lock is transient. Giving up is right because a
 * leftover directory under `%TEMP%` is not a product defect and failing a green
 * test on one is noise — the OS will clear it. What it must NOT do is hide a
 * real failure, which is why it re-throws anything that is not a lock error:
 * a permissions problem or a path bug still fails loudly.
 */

import { rmSync } from "node:fs";

/** Errors that mean "something still has this open", not "this is broken". */
const TRANSIENT = new Set(["EBUSY", "EPERM", "ENOTEMPTY"]);

function codeOf(err: unknown): string {
  return typeof err === "object" && err !== null && "code" in err
    ? String((err as { code: unknown }).code)
    : "";
}

/**
 * Remove a temp directory, tolerating a Windows file lock.
 *
 * Synchronous and blocking by design: teardown runs between tests, and the
 * alternative — an async helper every `afterEach` has to remember to await —
 * is a race waiting to be written.
 */
export function rmTemp(dir: string, attempts = 20, delayMs = 50): void {
  for (let i = 0; i < attempts; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (!TRANSIENT.has(codeOf(err))) throw err;
      if (i === attempts - 1) return; // still locked; the OS will clean it up
      Bun.sleepSync(delayMs);
    }
  }
}
