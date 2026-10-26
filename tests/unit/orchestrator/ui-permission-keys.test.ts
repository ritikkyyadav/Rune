import { describe, expect, it } from "bun:test";
import { permissionKeyAction } from "../../../packages/orchestrator/src/bin/ui/tui";

describe("ui permission keyboard contract", () => {
  it("moves predictably through the three visible choices", () => {
    expect(permissionKeyAction({ type: "down" }, 0)).toEqual({ selected: 1, handled: true });
    expect(permissionKeyAction({ type: "tab" }, 1)).toEqual({ selected: 2, handled: true });
    expect(permissionKeyAction({ type: "down" }, 2)).toEqual({ selected: 0, handled: true });
    expect(permissionKeyAction({ type: "up" }, 0)).toEqual({ selected: 2, handled: true });
  });

  it("Enter resolves the highlighted row rather than silently defaulting", () => {
    expect(permissionKeyAction({ type: "enter" }, 0).decision).toEqual({ kind: "allow_once" });
    expect(permissionKeyAction({ type: "enter" }, 1).decision).toEqual({
      kind: "allow_session",
    });
    expect(permissionKeyAction({ type: "enter" }, 2).decision).toEqual({ kind: "deny" });
  });

  it("supports the printed numeric and direct shortcuts", () => {
    expect(permissionKeyAction({ type: "char", value: "1" }, 2).decision).toEqual({
      kind: "allow_once",
    });
    expect(permissionKeyAction({ type: "char", value: "2" }, 0).decision).toEqual({
      kind: "allow_session",
    });
    expect(permissionKeyAction({ type: "char", value: "3" }, 0).decision).toEqual({
      kind: "deny",
    });
    expect(permissionKeyAction({ type: "esc" }, 0).decision).toEqual({ kind: "deny" });
    expect(permissionKeyAction({ type: "ctrl", name: "c" }, 1).decision).toEqual({
      kind: "deny",
    });
  });

  it("shift-tab moves the selection; it no longer grants the session", () => {
    expect(permissionKeyAction({ type: "shift-tab" }, 0)).toEqual({ selected: 2, handled: true });
    expect(permissionKeyAction({ type: "shift-tab" }, 2)).toEqual({ selected: 1, handled: true });
  });

  it("no letter answers the card: each comes back unhandled, to be typed", () => {
    for (const value of ["y", "Y", "a", "A", "s", "S", "n", "N"]) {
      expect(permissionKeyAction({ type: "char", value }, 0)).toEqual({
        selected: 0,
        handled: false,
      });
    }
  });

  it("not armed -- just opened, or mid-typing -- a digit is typed and enter does nothing", () => {
    const guard = { armed: false };
    expect(permissionKeyAction({ type: "char", value: "2" }, 0, 3, guard)).toEqual({
      selected: 0,
      handled: false,
    });
    expect(permissionKeyAction({ type: "enter" }, 0, 3, guard)).toEqual({
      selected: 0,
      handled: true,
    });
    // Esc still declines: refusing is the safe answer to give by accident.
    expect(permissionKeyAction({ type: "esc" }, 0, 3, guard).decision).toEqual({ kind: "deny" });
  });

  it("with a message in the composer, enter never answers; a deliberate digit does", () => {
    const guard = { armed: true, drafting: true };
    expect(permissionKeyAction({ type: "enter" }, 0, 3, guard).decision).toBeUndefined();
    expect(permissionKeyAction({ type: "char", value: "1" }, 0, 3, guard).decision).toEqual({
      kind: "allow_once",
    });
  });

  it("ignores unrelated keys without changing selection", () => {
    expect(permissionKeyAction({ type: "char", value: "x" }, 1)).toEqual({
      selected: 1,
      handled: false,
    });
  });
});

describe("permissionKeyAction on a 2-choice breaker card (no session grant)", () => {
  it("cycles across exactly two rows", () => {
    expect(permissionKeyAction({ type: "down" }, 0, 2)).toEqual({ selected: 1, handled: true });
    expect(permissionKeyAction({ type: "down" }, 1, 2)).toEqual({ selected: 0, handled: true });
    expect(permissionKeyAction({ type: "up" }, 0, 2)).toEqual({ selected: 1, handled: true });
  });

  it("maps digit 2 and enter-on-row-2 to deny — the card's last row is always deny", () => {
    expect(permissionKeyAction({ type: "char", value: "2" }, 0, 2).decision).toEqual({
      kind: "deny",
    });
    expect(permissionKeyAction({ type: "enter" }, 1, 2).decision).toEqual({ kind: "deny" });
    expect(permissionKeyAction({ type: "enter" }, 0, 2).decision).toEqual({ kind: "allow_once" });
  });

  it("swallows shift-tab and a digit past the last row instead of resolving", () => {
    for (const key of [{ type: "shift-tab" } as const, { type: "char", value: "3" } as const]) {
      const action = permissionKeyAction(key, 0, 2);
      expect(action.decision).toBeUndefined();
      // handled=true so shift-tab cannot fall through to the gear cycle
      // while a breaker decision is pending.
      expect(action.handled).toBe(true);
    }
  });

  it("never resolves on a letter: a and s come back unhandled, to be typed", () => {
    for (const value of ["a", "s", "y", "n"]) {
      const action = permissionKeyAction({ type: "char", value }, 0, 2);
      expect(action.decision).toBeUndefined();
      expect(action.handled).toBe(false);
    }
  });
});

// The card wired to a real permKey: what the audit typed, typed again.
describe("permKey: typing while the card is open", () => {
  const { Tui } = require("../../../packages/orchestrator/src/bin/ui/tui");

  function card(openedAgoMs = 10_000) {
    const decisions: unknown[] = [];
    const t: any = Object.create(Tui.prototype);
    Object.assign(t, {
      mode: "permission",
      input: "",
      caret: 0,
      scroll: 0,
      lastTypedAt: 0,
      permOpenedAt: Date.now() - openedAgoMs,
      perm: {
        resolve: (d: unknown) => decisions.push(d),
        toolName: "bash",
        argsSummary: "node src/cli.js build --json",
        preview: { choices: [1, 2, 3] },
        sel: 0,
      },
      print: () => {},
      scheduleDraw: () => {},
    });
    const type = (text: string) => {
      for (const ch of text) t.permKey({ type: "char", value: ch });
    };
    return { t, decisions, type };
  }

  it("a sentence typed into the card answers nothing and is kept as the message", () => {
    const { t, decisions, type } = card();
    type("build it as json again");
    t.permKey({ type: "enter" });
    expect(decisions).toEqual([]);
    expect(t.mode).toBe("permission");
    expect(t.input).toBe("build it as json again");
  });

  it("a digit in the middle of typing is part of the text, not an answer", () => {
    const { t, decisions, type } = card();
    type("update to v2");
    expect(decisions).toEqual([]);
    expect(t.input).toBe("update to v2");
  });

  it("a card that only just opened does not take a digit", () => {
    const { t, decisions } = card(50);
    t.permKey({ type: "char", value: "2" });
    expect(decisions).toEqual([]);
  });

  it("a deliberate digit, after a pause, answers it", () => {
    const { t, decisions } = card();
    t.permKey({ type: "char", value: "1" });
    expect(decisions).toEqual([{ kind: "allow_once" }]);
    expect(t.mode).toBe("turn");
  });
});
