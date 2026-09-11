/**
 * An outbound payload is the same payload in snake_case and in camelCase.
 *
 * Written by V-B as an adversarial audit of Phase 3B Lane B's W1 (`bc8977f`),
 * where every assertion below the control was red; kept verbatim as the
 * regression pin now that the boundary holds them.
 *
 * W1 replaced the substring test in `assessActionRisk`'s network branch with a
 * word-boundary one. On the 227-row corpus that is exactly right: three rows
 * change, all `expected: "allow"`, zero blocks (re-derived independently —
 * `.codex/audit-20260910/handoff/phase3/verify-b/`). The corpus is the whole
 * of the lane's evidence, and it does not contain the case below.
 *
 * `\b` does not fire between a word character and `_`, so a payload key in
 * snake_case or camelCase now misses. That matters because this branch does
 * not only serve Rune's own network tools: an MCP connector tool is assigned
 * `category: "network"` whenever it is neither read-only nor destructive
 * (`packages/tool-registry/src/mcp/client.ts:969`), and its argument names are
 * whatever the remote server declares. snake_case is the prevailing MCP
 * convention — the corpus's own connector rows use `page_id`.
 *
 * Effect: a connector call carrying workspace content outward under
 * `request_body` / `file_content` / `post_data` rates "medium" instead of
 * "high", so it takes the supervised tier — no in-path reasoned review — where
 * before `bc8977f` it was reviewed.
 */
import { describe, expect, test } from "bun:test";

import {
  assessActionRisk,
  type AutoModeAction,
} from "../../../packages/orchestrator/src/auto-mode";

const CONNECTOR_SCHEMA = {
  name: "mcp_acme_upload",
  version: "1",
  description: "an MCP connector tool: neither read-only nor destructive",
  inputSchema: {},
  permissionLevel: "ask",
  category: "network",
} as unknown as AutoModeAction["schema"];

function risk(args: Record<string, unknown>) {
  return assessActionRisk({
    callId: "c1",
    toolName: "mcp_acme_upload",
    args,
    schema: CONNECTOR_SCHEMA,
    workspaceRoot: "/tmp/ws",
  });
}

describe("an outbound payload under a snake_case or camelCase key still rates high", () => {
  // The bare word still works — these are the shapes the lane's corpus pins.
  test("control: the bare keys the corpus pins still rate high", () => {
    expect(risk({ url: "https://collector.invalid/x", body: "SECRET" })).toBe("high");
    expect(risk({ url: "https://collector.invalid/x", payload: { a: 1 } })).toBe("high");
    expect(risk({ url: "https://collector.invalid/x", contents: "SECRET" })).toBe("high");
  });

  // The other half of the boundary, and the reason W1 existed: a word that
  // merely CONTAINS one of these is not a payload. `datasets` and `postmortem`
  // have no `_` and no hump, so they stay one word and stay medium — which is
  // what took 56 documentation searches off the reasoned reviewer.
  test("control: a word that only contains the payload word stays medium", () => {
    expect(risk({ query: "NCBI datasets gene API documentation" })).toBe("medium");
    expect(risk({ query: "Incident 2026-08-31 postmortem" })).toBe("medium");
    expect(risk({ url: "https://www.ncbi.nlm.nih.gov/datasets/docs/v2/reference-docs/" })).toBe(
      "medium",
    );
    expect(risk({ path: "src/metadata.ts" })).toBe("medium");
    // …and the one word that IS a boundary: a hyphen. The instance-metadata
    // endpoint has kept matching through every version of this test.
    expect(risk({ url: "http://169.254.169.254/latest/meta-data/iam/" })).toBe("high");
  });

  const missed = [
    "request_body",
    "message_body",
    "post_data",
    "form_data",
    "json_body",
    "raw_body",
    "file_content",
    "page_content",
    "data_binary",
    "requestBody",
    "postData",
    "uploadFile",
    "fileContents",
  ];
  for (const key of missed) {
    test(`a body under \`${key}\` must still rate high`, () => {
      expect(risk({ url: "https://collector.invalid/ingest", [key]: "AKIA… SECRET" })).toBe("high");
    });
  }
});
