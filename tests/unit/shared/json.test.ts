import { describe, it, expect } from "bun:test";
import { parseToolArguments, tryParseJson } from "../../../packages/shared/src/json";

describe("shared/json parseToolArguments", () => {
  it("parses well-formed object args", () => {
    expect(parseToolArguments('{"path":"a.ts","limit":5}')).toEqual({ path: "a.ts", limit: 5 });
  });

  it("returns {} for empty / whitespace / nullish (never throws)", () => {
    expect(parseToolArguments("")).toEqual({});
    expect(parseToolArguments("   ")).toEqual({});
    expect(parseToolArguments(null)).toEqual({});
    expect(parseToolArguments(undefined)).toEqual({});
  });

  it("returns {} for truncated / malformed JSON instead of throwing", () => {
    // This is the glm/qwen failure that took down the whole turn ("Unable to parse JSON string").
    expect(() => parseToolArguments('{"path":"a.ts"')).not.toThrow();
    expect(parseToolArguments('{"path":"a.ts"')).toEqual({});
    expect(parseToolArguments("not json at all")).toEqual({});
  });

  it("unwraps a double-encoded JSON string", () => {
    expect(parseToolArguments(JSON.stringify('{"path":"a.ts"}'))).toEqual({ path: "a.ts" });
  });

  it("strips a ```json fence", () => {
    expect(parseToolArguments('```json\n{"q":"hi"}\n```')).toEqual({ q: "hi" });
    expect(parseToolArguments('```\n{"q":"hi"}\n```')).toEqual({ q: "hi" });
  });

  it("salvages an object buried in surrounding prose / trailing junk", () => {
    expect(parseToolArguments('Sure! {"path":"a.ts"} done')).toEqual({ path: "a.ts" });
    expect(parseToolArguments('{"a":{"b":1}} trailing')).toEqual({ a: { b: 1 } });
  });

  it("passes through an already-parsed object (endpoints that don't JSON-encode args)", () => {
    expect(parseToolArguments({ path: "a.ts" } as unknown)).toEqual({ path: "a.ts" });
    expect(parseToolArguments([1, 2] as unknown)).toEqual({}); // an array isn't valid args
  });

  it("coerces non-object JSON (array / primitive) to {}", () => {
    expect(parseToolArguments("[1,2,3]")).toEqual({});
    expect(parseToolArguments("42")).toEqual({});
    expect(parseToolArguments('"hello"')).toEqual({});
    expect(parseToolArguments("null")).toEqual({});
  });

  it("keeps nested structures intact", () => {
    const raw = '{"steps":[{"description":"x","success_criteria":"y"}],"reason":"z"}';
    expect(parseToolArguments(raw)).toEqual({
      steps: [{ description: "x", success_criteria: "y" }],
      reason: "z",
    });
  });
});

describe("shared/json tryParseJson", () => {
  it("returns the parsed value on success", () => {
    expect(tryParseJson('{"a":1}')).toEqual({ a: 1 });
    expect(tryParseJson("[1,2]")).toEqual([1, 2]);
  });

  it("returns undefined on failure instead of throwing", () => {
    expect(tryParseJson("{bad")).toBeUndefined();
    expect(tryParseJson("")).toBeUndefined();
  });
});
