import { describe, test, expect } from "bun:test";
import {
  batchSignature,
  breakerSignature,
} from "../../../packages/orchestrator/src/call-signature";

// P7: the breaker and loop detector keyed on raw toolName:argsJson, so any
// cosmetic mutation (whitespace, a timestamp, a port) reset the guard. These
// pin the normalization in both directions: trivial variants collapse to one
// signature; genuinely different calls stay distinct.

describe("breakerSignature (aggressive)", () => {
  test("whitespace variance collapses", () => {
    const a = breakerSignature("bash", JSON.stringify({ command: "npm  test   --silent" }));
    const b = breakerSignature("bash", JSON.stringify({ command: "npm test --silent" }));
    expect(a).toBe(b);
  });

  test("key order collapses", () => {
    const a = breakerSignature("edit_file", '{"path":"a.ts","old_text":"x"}');
    const b = breakerSignature("edit_file", '{"old_text":"x","path":"a.ts"}');
    expect(a).toBe(b);
  });

  test("port / numeric mutation collapses (the port-hopping runaway)", () => {
    const a = breakerSignature("bash", JSON.stringify({ command: "serve --port 3000" }));
    const b = breakerSignature("bash", JSON.stringify({ command: "serve --port 3001" }));
    expect(a).toBe(b);
  });

  test("timestamp and uuid mutation collapses", () => {
    const a = breakerSignature(
      "bash",
      JSON.stringify({
        command: "curl api/x?ts=2026-07-14T10:00:00Z&id=6a1f2b3c-1111-2222-3333-444455556666",
      }),
    );
    const b = breakerSignature(
      "bash",
      JSON.stringify({
        command: "curl api/x?ts=2026-07-14T10:05:33Z&id=9b8c7d6e-aaaa-bbbb-cccc-ddddeeeeffff",
      }),
    );
    expect(a).toBe(b);
  });

  test("genuinely different commands stay distinct", () => {
    const a = breakerSignature("bash", JSON.stringify({ command: "npm test" }));
    const b = breakerSignature("bash", JSON.stringify({ command: "npm run build" }));
    expect(a).not.toBe(b);
  });

  test("different tools with identical args stay distinct", () => {
    const args = JSON.stringify({ path: "a.ts" });
    expect(breakerSignature("read_file", args)).not.toBe(breakerSignature("write_file", args));
  });

  test("different file paths stay distinct", () => {
    const a = breakerSignature("read_file", JSON.stringify({ path: "src/auth.ts" }));
    const b = breakerSignature("read_file", JSON.stringify({ path: "src/api.ts" }));
    expect(a).not.toBe(b);
  });

  test("malformed args JSON still normalizes at text level, never throws", () => {
    const a = breakerSignature("bash", "{command:  npm   test");
    const b = breakerSignature("bash", "{command: npm test");
    expect(a).toBe(b);
  });
});

describe("batchSignature (conservative — feeds the loop detector)", () => {
  const call = (toolName: string, args: Record<string, unknown>) => ({
    toolName,
    argsJson: JSON.stringify(args),
  });

  test("whitespace + key-order variance collapses", () => {
    const a = batchSignature([
      { toolName: "grep", argsJson: '{"pattern":"foo   bar","path":"."}' },
      { toolName: "read_file", argsJson: '{"path":"a.ts"}' },
    ]);
    const b = batchSignature([
      { toolName: "grep", argsJson: '{"path":".","pattern":"foo bar"}' },
      { toolName: "read_file", argsJson: '{"path":"a.ts"}' },
    ]);
    expect(a).toBe(b);
  });

  test("hash / long-hex mutation collapses (retry with re-read hash)", () => {
    const a = batchSignature([
      call("edit_file", { path: "a.ts", expected_hash: "aa11bb22cc33dd44ee55" }),
    ]);
    const b = batchSignature([
      call("edit_file", { path: "a.ts", expected_hash: "ff66ee55dd44cc33bb22" }),
    ]);
    expect(a).toBe(b);
  });

  test("paginated reads stay DISTINCT — advancing offsets are progress, not a loop", () => {
    const a = batchSignature([call("read_file", { path: "big.ts", offset: 0 })]);
    const b = batchSignature([call("read_file", { path: "big.ts", offset: 200 })]);
    expect(a).not.toBe(b);
  });

  test("batch order matters (different plan, different signature)", () => {
    const r = call("read_file", { path: "a.ts" });
    const g = call("grep", { pattern: "x" });
    expect(batchSignature([r, g])).not.toBe(batchSignature([g, r]));
  });
});
