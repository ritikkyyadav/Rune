// ─── `bun run eval` must measure the harness, not the shell ───
//
// V6 finding 30 reported that a stray `OLLAMA_API_KEY` turned the mock gate
// from 63/63 into 24/63. The symptom is real and the class is real; the CAUSE
// named there does not reproduce (see .codex/audit-20260910/handoff/m0/
// fix-b-report.md — with the native tool binary present, 63/63 holds with and
// without that key). Two things are pinned here, because both are ways for the
// operator's environment to decide the number:
//
//   1. The mock path reads no provider credential at all. It builds a REAL
//      Engine and only then swaps the mock into its gateway, so anything in the
//      environment has already been read by the time the mock arrives. Nothing
//      credential-shaped survives into that construction.
//   2. A blank tools-binary variable is unset, not a path — and a suite that
//      cannot reach its tool binary refuses instead of printing a percentage.
//      `export RUNE_TOOLS_BIN=$PWD/… RUNE_TOOLS_BINARY=$RUNE_TOOLS_BIN` leaves
//      the second empty in zsh; `??` let "" through, every tool call failed,
//      and the suite reported 24/63 as a measurement. That is the same defect
//      the finding describes, arriving through the other door.

import { expect, test } from "bun:test";
import {
  assertToolsBinary,
  isCredentialShapedEnv,
  resolveToolsBinary,
  scrubProviderEnv,
} from "../../eval/harness";

test("the scrub takes provider credentials by shape, by registry and by chain", () => {
  const env: NodeJS.ProcessEnv = {
    OLLAMA_API_KEY: "x",
    ANTHROPIC_API_KEY: "x",
    // A registry envVar matching neither of the two suffixes a roster knew.
    SCW_SECRET_KEY: "x",
    // Bedrock and vertex authenticate from a chain, not from a secret suffix.
    AWS_PROFILE: "x",
    GOOGLE_APPLICATION_CREDENTIALS: "/tmp/sa.json",
    GITHUB_TOKEN: "x",
    SOME_PASSWORD: "x",
    // Not credentials: the rig's own knobs must survive, or the scrub is the
    // thing that breaks the gate.
    RUNE_TOOLS_BIN: "/bin/rune-tools",
    RUNE_BENCH_PLAYWRIGHT: "/tmp/pw",
    RUNE_EVAL_TASK_DELAY_MS: "0",
  };
  const removed = scrubProviderEnv(env);
  expect(removed.sort()).toEqual(
    [
      "ANTHROPIC_API_KEY",
      "AWS_PROFILE",
      "GITHUB_TOKEN",
      "GOOGLE_APPLICATION_CREDENTIALS",
      "OLLAMA_API_KEY",
      "SCW_SECRET_KEY",
      "SOME_PASSWORD",
    ].sort(),
  );
  expect(Object.keys(env).sort()).toEqual([
    "RUNE_BENCH_PLAYWRIGHT",
    "RUNE_EVAL_TASK_DELAY_MS",
    "RUNE_TOOLS_BIN",
  ]);
  // Nothing credential-shaped survives — asserted by the predicate, not by a
  // second roster that could share the first one's blind spot.
  expect(Object.keys(env).filter(isCredentialShapedEnv)).toEqual([]);
});

test("a blank tools-binary variable is unset, not a path", () => {
  expect(resolveToolsBinary({ RUNE_TOOLS_BINARY: "/a/rune-tools" })).toBe("/a/rune-tools");
  expect(resolveToolsBinary({ RUNE_TOOLS_BIN: "/b/rune-tools" })).toBe("/b/rune-tools");
  // The zsh trap: the second assignment expands to nothing.
  expect(resolveToolsBinary({ RUNE_TOOLS_BINARY: "", RUNE_TOOLS_BIN: "/b/rune-tools" })).toBe(
    "/b/rune-tools",
  );
  expect(resolveToolsBinary({ RUNE_TOOLS_BINARY: "   ", RUNE_TOOLS_BIN: "" })).toMatch(
    /target[/\\]release[/\\]rune-tools$/,
  );
});

test("a suite that cannot reach its tool binary refuses rather than reporting a number", () => {
  expect(() => assertToolsBinary("")).toThrow(/not executable/i);
  expect(() => assertToolsBinary("/no/such/rune-tools")).toThrow(/cargo build --release/);
  // The refusal says why the number would have been meaningless.
  expect(() => assertToolsBinary("")).toThrow(/reports the rig, not the harness/);
});
