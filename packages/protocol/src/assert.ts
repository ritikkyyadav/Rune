// ─── Exhaustiveness ───

/**
 * The compile-time guard that makes an unhandled union member a type error.
 *
 * Every reducer that consumes `AgentTurnEvent` ends in `default:
 * assertNever(ev)`. That is the whole point of Phase 2: before it, adding a
 * member to the event union compiled clean everywhere and rendered nothing —
 * the TUI, the desktop and the headless runner each silently dropped it.
 *
 * Reducers that legitimately ignore members must NAME them in a `case` that
 * falls through to a no-op, so "ignored" is a decision on the record rather
 * than the absence of one.
 */
export function assertNever(value: never, context = "value"): never {
  throw new Error(`unhandled ${context}: ${JSON.stringify(value)}`);
}

/**
 * The same guard for reducers that must not throw on a frame from a NEWER
 * host (a minor-version client talking to a minor-version-ahead server).
 * Compile-time it is still `never`, so a member added in this repo is a type
 * error; at runtime it returns the fallback instead of raising.
 */
export function assertNeverSoft<T>(_value: never, fallback: T): T {
  return fallback;
}
