/**
 * The held-step panel's contract, pinned.
 *
 * The panel is the "approve exactly this" surface: each outward step Auto
 * declined can be run — precisely as the agent asked for it — or left unrun,
 * per step. The rules worth a test are the ones that protect the promise:
 * a key may only mean what the hint says it means, a decided step can never
 * be re-run by a stray key, and while a step is executing the only live
 * binding is the cancel.
 */
import { describe, expect, test } from "bun:test";

import {
  heldAction,
  heldCloseReceipt,
  heldHint,
  heldLines,
  heldOutcomeRow,
  nextUndecided,
  type HeldOutcome,
  type HeldView,
} from "../../../packages/orchestrator/src/bin/ui/held";
import { stripAnsi } from "../../../packages/orchestrator/src/bin/ui/theme";
import type { Key } from "../../../packages/orchestrator/src/bin/ui/keys";

const key = (k: Key): Key => k;
const char = (value: string): Key => ({ type: "char", value });

function view(overrides: Partial<HeldView> = {}): HeldView {
  return {
    steps: [
      {
        toolName: "bash",
        summary: "npm publish --access public",
        reason: "This publishes workspace content to people outside this session.",
        route: "publication",
      },
      {
        toolName: "bash",
        summary: "gh release create v0.3.1",
        reason: "This mutates a remote resource.",
        route: "remote-mutation",
      },
    ],
    outcomes: [null, null],
    selected: 0,
    running: false,
    ...overrides,
  };
}

describe("held panel keys", () => {
  test("enter runs the highlighted undecided step", () => {
    expect(heldAction(key({ type: "enter" }), view())).toEqual({ kind: "run", index: 0 });
  });

  test("a digit picks and runs in one keystroke", () => {
    expect(heldAction(char("2"), view())).toEqual({ kind: "run", index: 1 });
  });

  test("a digit past the list does nothing", () => {
    expect(heldAction(char("7"), view())).toEqual({ kind: "ignore" });
  });

  test("a decided step can never be re-run — not by enter, not by its digit", () => {
    const v = view({ outcomes: ["ran", null], selected: 0 });
    expect(heldAction(key({ type: "enter" }), v)).toEqual({ kind: "ignore" });
    expect(heldAction(char("1"), v)).toEqual({ kind: "ignore" });
  });

  test("s leaves the highlighted step unrun", () => {
    expect(heldAction(char("s"), view())).toEqual({ kind: "skip", index: 0 });
  });

  test("up and down walk the list, wrapping at both edges", () => {
    expect(heldAction(key({ type: "down" }), view())).toEqual({ kind: "move", selected: 1 });
    expect(heldAction(key({ type: "up" }), view())).toEqual({ kind: "move", selected: 1 });
  });

  test("esc leaves the panel with everything undecided staying unrun", () => {
    expect(heldAction(key({ type: "esc" }), view())).toEqual({ kind: "leave" });
  });

  test("while a step is running the only live binding is the cancel", () => {
    const running = view({ running: true });
    expect(heldAction(key({ type: "esc" }), running)).toEqual({ kind: "cancel" });
    expect(heldAction(key({ type: "enter" }), running)).toEqual({ kind: "ignore" });
    expect(heldAction(char("2"), running)).toEqual({ kind: "ignore" });
    expect(heldAction(char("s"), running)).toEqual({ kind: "ignore" });
  });
});

describe("held panel rendering", () => {
  test("the trust line — the reason this surface exists — is always present", () => {
    const plain = heldLines(view()).map(stripAnsi).join("\n");
    expect(plain).toContain("nothing broader is granted");
  });

  test("every step is listed and the selected one carries its reason", () => {
    const plain = heldLines(view()).map(stripAnsi).join("\n");
    expect(plain).toContain("npm publish --access public");
    expect(plain).toContain("gh release create v0.3.1");
    expect(plain).toContain("publishes workspace content");
    // The unselected step's reason stays folded.
    expect(plain).not.toContain("mutates a remote resource");
  });

  test("a redirect says its stand-in already ran", () => {
    const v = view();
    v.steps[0]!.substitute = "npm pack";
    const plain = heldLines(v).map(stripAnsi).join("\n");
    expect(plain).toContain("already ran instead: npm pack");
  });

  test("the hint changes wholesale while a step runs", () => {
    expect(stripAnsi(heldHint(view()))).toContain("run exactly this");
    const running = stripAnsi(heldHint(view({ running: true })));
    expect(running).toContain("running exactly this");
    expect(running).toContain("esc");
    expect(running).not.toContain("enter");
  });

  test("decided steps show their outcome and the header counts them", () => {
    const plain = heldLines(view({ outcomes: ["ran", null], selected: 1 }))
      .map(stripAnsi)
      .join("\n");
    expect(plain).toContain("1 of 2 decided");
  });

  test("rows stay within the pinned region's measure", () => {
    const long = view();
    long.steps[0]!.summary = "x".repeat(300);
    long.steps[0]!.reason = "y".repeat(300);
    for (const line of heldLines({ ...long, width: 80 })) {
      expect(stripAnsi(line).length).toBeLessThanOrEqual(80);
    }
  });
});

describe("held receipts", () => {
  test("nextUndecided walks forward and wraps", () => {
    expect(nextUndecided([null, null], 1)).toBe(1);
    expect(nextUndecided(["ran", null], 0)).toBe(1);
    expect(nextUndecided([null, "skipped"], 1)).toBe(0);
    expect(nextUndecided(["ran", "skipped"], 0)).toBe(-1);
  });

  test("outcome rows say exactly what happened", () => {
    const step = view().steps[0]!;
    expect(stripAnsi(heldOutcomeRow(step, "ran", "published"))).toContain("ran exactly");
    expect(stripAnsi(heldOutcomeRow(step, "failed", "exit 1"))).toContain("ran and failed");
    expect(stripAnsi(heldOutcomeRow(step, "refused", "org policy"))).toContain("refused");
    expect(stripAnsi(heldOutcomeRow(step, "skipped"))).toContain("left unrun");
  });

  test("the closing receipt tells the panel's whole story", () => {
    const outcomes: Array<HeldOutcome | null> = ["ran", "failed", "skipped"];
    const plain = stripAnsi(heldCloseReceipt(outcomes));
    expect(plain).toContain("1 ran");
    expect(plain).toContain("1 failed");
    expect(plain).toContain("1 left unrun");
  });
});
