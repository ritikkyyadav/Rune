import { describe, expect, it } from "bun:test";
import { renderStatus } from "../../../packages/orchestrator/src/bin/ui/status";
import { stripAnsi } from "../../../packages/orchestrator/src/bin/ui/theme";

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
