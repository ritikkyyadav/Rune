// ─── Gear ───
// A terminal design system for an autonomous coding agent.
//
// Most coding-agent interfaces are a chat log with tool calls in it. This one is built
// around a different object: **a mission** — a contract signed at minute zero and
// handed back, checked off, with its evidence attached.
//
//   runtime → typed append-only event log → reducer → state → surface
//
// No component in this package parses model prose. A model that hangs, lies, or
// returns malformed output cannot make this UI claim the work succeeded, because the
// UI never read what the model said.

export * from "./events";
export * from "./reduce";
export * from "./log";
export * from "./format";

export * from "./render/caps";
export * from "./render/row";
export * from "./render/ansi";
export * from "./render/code";
export * from "./render/pulse";

export * from "./surface/terminal";
export * from "./surface/ledger";
export * as stream from "./surface/stream";
export * as holds from "./surface/holds";

export * from "./adapt/engine";
