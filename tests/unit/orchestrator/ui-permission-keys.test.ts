import { describe, expect, it } from "vitest";
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
    expect(permissionKeyAction({ type: "shift-tab" }, 0).decision).toEqual({
      kind: "allow_session",
    });
    expect(permissionKeyAction({ type: "esc" }, 0).decision).toEqual({ kind: "deny" });
  });

  it("ignores unrelated keys without changing selection", () => {
    expect(permissionKeyAction({ type: "char", value: "x" }, 1)).toEqual({
      selected: 1,
      handled: false,
    });
  });
});
