import { describe, expect, it } from "bun:test";
import { renderStatus } from "../../../packages/orchestrator/src/bin/ui/status";
import { stripAnsi } from "../../../packages/orchestrator/src/bin/ui/theme";
import * as F from "../../../packages/orchestrator/src/bin/ui/flow";

// /status is the header expanded — these pin that it renders the live facts
// and reads gear labels from the one modeInfo table instead of a drifted copy.
describe("ui/status renderStatus", () => {
  const base = {
    model: "claude-opus-5",
    provider: "anthropic",
    workspace: "/tmp/proj",
    sessionId: "abc12345",
    cost: 0.42,
  };

  it("opens with the SAME masthead the session opens with", () => {
    // This card called itself "the header, expanded" while drawing a header of
    // its own: a lowercase name inlaid into a line of repeated hyphens, which
    // is the dash-rule texture the rest of the UI dropped, in a different case
    // from the row pinned at the top of the same window. Two dialects, one
    // claim of being one thing. It now calls the header's own lockup.
    const lines = stripAnsi(renderStatus({ ...base, version: "0.3.0" })).split("\n");
    const mark = lines.find((line) => line.includes("G E A R"))!;
    expect(mark).toBe(`${F.MARK}G E A R  0.3.0`);
    // …carried on the header's two-tone rule, at the header's own width.
    expect(lines[lines.indexOf(mark) + 1]).toBe(
      stripAnsi(F.seamRule(F.surfaceWidth(), F.lockup("Gear", "0.3.0").cells)),
    );
    // And no dash rules anywhere: a dash rule reads as texture, a hairline as
    // structure, and this card was the last place still drawing them.
    expect(stripAnsi(renderStatus({ ...base }))).not.toMatch(/-{10}/);
  });

  it("renders the gear row from the shared table", () => {
    const out = stripAnsi(renderStatus({ ...base, permissionMode: "gear-2" as const }));
    expect(out).toContain(">> 2nd gear | workspace edits proceed");
    const auto = stripAnsi(renderStatus({ ...base, permissionMode: "auto" as const }));
    // Auto mode carries no clause -- the name is the whole statement.
    expect(auto).toContain("* Auto mode");
    expect(auto).not.toContain("never asks; watched for injection");
  });

  it("shows the Auto reviewer identity, fallback readiness, and escalation posture", () => {
    const out = stripAnsi(
      renderStatus({
        ...base,
        permissionMode: "auto" as const,
        autoMode: {
          enabled: true,
          failClosed: true,
          reviewer: { provider: "anthropic", model: "isolated-reviewer" },
          conversationalEscalation: true,
          reviewerFallback: { enabled: true, available: true },
          stats: { allowed: 12, asked: 1, denied: 2, injectionsFlagged: 0 },
        },
      }),
    );
    expect(out).toContain("anthropic/isolated-reviewer");
    expect(out).toContain("fail closed");
    expect(out).toContain("fallback ready");
    expect(out).toContain("conversational");
  });

  it("never hides a disabled sandbox", () => {
    const out = stripAnsi(renderStatus({ ...base, sandboxEnabled: false }));
    expect(out.toLowerCase()).toContain("sandbox");
  });
});
