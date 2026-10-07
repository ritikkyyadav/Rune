import { describe, expect, test } from "bun:test";

import { EMPTY_LEDGER, parseRuneOutput } from "../../eval/comparison/arms/rune";
import { terminalOf, type ArmCapture } from "../../eval/comparison/arms/types";

function capture(envelope?: Record<string, unknown>, exitCode = 1): ArmCapture {
  return {
    stdout: [
      JSON.stringify({ type: "usage", inputTokens: 1 }),
      envelope && JSON.stringify(envelope),
    ]
      .filter(Boolean)
      .join("\n"),
    stderr: "",
    exitCode,
    durationMs: 1,
  };
}

describe("Rune completion verdict in the parity arm", () => {
  test.each(["unmet", "partial"])("end_turn %s is incomplete", (kind) => {
    const parsed = parseRuneOutput(
      capture({
        ok: false,
        stopReason: "end_turn",
        verdict: { kind },
        error: `The task is ${kind}; the completion criteria were not all satisfied.`,
      }),
      EMPTY_LEDGER,
    );
    expect(parsed.claimedSuccess).toBe(false);
    expect(parsed.signals.selfStopped).toBe(`completion_${kind}`);
    expect(terminalOf(parsed.signals)).toBe("incomplete");
    expect(parsed.scored).toBe(true);
  });

  test("a legacy ok:true unmet verdict cannot claim success", () => {
    const parsed = parseRuneOutput(
      capture({ ok: true, stopReason: "end_turn", verdict: { kind: "unmet" } }, 0),
      EMPTY_LEDGER,
    );
    expect(parsed.claimedSuccess).toBe(false);
    expect(parsed.signals.selfStopped).toBe("completion_unmet");
    expect(terminalOf(parsed.signals)).toBe("incomplete");
  });

  test("a fatal error with an unmet verdict is still a crash", () => {
    const parsed = parseRuneOutput(
      capture({
        ok: false,
        stopReason: "end_turn",
        verdict: { kind: "unmet" },
        error: "engine threw",
      }),
      EMPTY_LEDGER,
    );
    expect(parsed.claimedSuccess).toBe(false);
    expect(parsed.signals.selfStopped).toBeUndefined();
    expect(terminalOf(parsed.signals)).toBe("crashed");
  });

  test("a provider failure retains precedence over an unmet verdict", () => {
    const parsed = parseRuneOutput(
      capture({
        ok: false,
        stopReason: "provider_lost",
        verdict: { kind: "unmet" },
        error: "provider unavailable",
      }),
      EMPTY_LEDGER,
    );
    expect(parsed.signals.selfStopped).toBeUndefined();
    expect(terminalOf(parsed.signals)).toBe("refused");
  });

  test("a successful met verdict remains completed", () => {
    const parsed = parseRuneOutput(
      capture({ ok: true, stopReason: "end_turn", verdict: { kind: "met" } }, 0),
      EMPTY_LEDGER,
    );
    expect(parsed.claimedSuccess).toBe(true);
    expect(terminalOf(parsed.signals)).toBe("completed");
  });
});
