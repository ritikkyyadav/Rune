import { describe, expect, test } from "bun:test";
import { parseRepoMapResponse } from "../../../packages/orchestrator/src/repo-map";

describe("repo-map native bridge", () => {
  test("accepts a complete successful native response", () => {
    const parsed = parseRepoMapResponse(
      JSON.stringify({
        success: true,
        result: {
          content: "# Repository map\n- src/core.ts:2 — function run",
          estimated_tokens: 14,
          total_files: 3,
          total_symbols: 9,
          selected_symbols: 4,
          truncated: false,
        },
      }),
    );
    expect(parsed?.selected_symbols).toBe(4);
    expect(parsed?.content).toContain("Repository map");
  });

  test("rejects partial, failed, and malformed responses", () => {
    expect(parseRepoMapResponse('{"success":false}')).toBeNull();
    expect(parseRepoMapResponse('{"success":true,"result":{"content":"x"}}')).toBeNull();
    expect(parseRepoMapResponse("not json")).toBeNull();
  });
});
