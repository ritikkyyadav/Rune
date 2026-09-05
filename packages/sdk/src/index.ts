// ─── @rune/sdk ───
//
// Drive a Rune session from anywhere a WebSocket runs. See README.md for the
// worked example, and `docs/protocol.md` for the wire contract.
//
// The whole protocol is re-exported so a consumer installs one package: the
// event union, the round-trip shapes, the command map and the envelope helpers
// are the SAME declarations the engine and the terminal use, which is the
// point of Phase 2 — a client cannot drift from the server, because there is
// only one copy.

export { RuneClient } from "./client";
export type { RuneClientOptions, RuneHandlers } from "./client";
export { readServeToken } from "./token";

export * from "@rune/protocol";
