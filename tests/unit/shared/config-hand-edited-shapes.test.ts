// ─── A hand-edited config.toml cannot kill a run ───
//
// Promoted from tests/verification/v6-m3-non-string-authority-kills-the-run.ts
// (V6 finding 13).
//
// `RuneConfig` is a compile-time claim about a file a person edits in a text
// editor. The TOML reader happily yields numbers, booleans and tables for keys
// typed as strings, and the code downstream trusted the type: `[controller]
// authority = 4` reached `.flatMap` inside `Engine.chat` and the run died
// before its first model call, handing the user the engine's internals
// (`(typeof value === "string" ? … ).flatMap is not a function`) — on a line
// whose entire documented promise is that a typo is a no-op.
//
// Two layers, because either one alone leaves the hole open somewhere else:
// the loader narrows the shape and says so, and the parser refuses to trust
// its own type signature.

import { describe, expect, test } from "bun:test";

import { narrowHandEditedShapes } from "../../../packages/shared/src/config";
import { parseAuthority } from "../../../packages/orchestrator/src/arbiter";

describe("narrowHandEditedShapes", () => {
  test("a number, a boolean or a table under [controller] authority is ignored, with a warning", () => {
    for (const value of [4, true, { E4: true }, [1, 2]]) {
      const config: Record<string, unknown> = { controller: { shadow: true, authority: value } };
      const warnings = narrowHandEditedShapes(config);
      expect(warnings).toHaveLength(1);
      // A warning that does not name the key or the accepted shapes is noise.
      expect(warnings[0]).toContain("[controller] authority");
      expect(warnings[0]).toMatch(/string|array/);
      expect(config.controller).toEqual({ shadow: true });
    }
  });

  test("the shapes the key documents are left exactly as written", () => {
    for (const value of ["E4", "E4,E5", ["E4"], []]) {
      const config: Record<string, unknown> = { controller: { authority: value } };
      expect(narrowHandEditedShapes(config)).toEqual([]);
      expect((config.controller as Record<string, unknown>).authority).toEqual(value);
    }
  });

  test("a config without the section is untouched and silent", () => {
    const config: Record<string, unknown> = { llm: { defaultProvider: "custom" } };
    expect(narrowHandEditedShapes(config)).toEqual([]);
    expect(config).toEqual({ llm: { defaultProvider: "custom" } });
  });
});

describe("parseAuthority narrows the shape, not only the tokens", () => {
  test("a value that is neither a string nor an array is dropped, never thrown on", () => {
    for (const value of [4, true, { E4: true }, 0, ""]) {
      expect(() => parseAuthority(value)).not.toThrow();
      expect([...parseAuthority(value)]).toEqual([]);
    }
  });

  test("the shapes the doc names still behave — the control", () => {
    // Pinned so the fix above cannot be mistaken for a change in which shapes
    // are supported.
    expect([...parseAuthority("E5")]).toEqual([]);
    expect([...parseAuthority("e4 ")]).toEqual(["E4"]);
    expect([...parseAuthority(["E4", "E4"])]).toEqual(["E4"]);
    expect([...parseAuthority(undefined)]).toEqual([]);
    expect([...parseAuthority(null)]).toEqual([]);
  });
});
