import { describe, expect, it } from "bun:test";
import { renderStatus } from "../../../packages/orchestrator/src/bin/ui/status";
import { stripAnsi } from "../../../packages/orchestrator/src/bin/ui/theme";
import * as F from "../../../packages/orchestrator/src/bin/ui/flow";
import { glyph } from "../../../packages/orchestrator/src/bin/ui/glyphs";

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

  it("opens with a title, not a second masthead", () => {
    // The card drew the header's own lockup -- R U N E and the build -- into
    // the transcript, under the header pinned at the top of the same window
    // (the TUI audit of 2026-10-26: "duplicate header inside the transcript").
    const lines = stripAnsi(renderStatus({ ...base, version: "0.3.0" })).split("\n");
    expect(lines.some((line) => line.includes("R U N E"))).toBe(false);
    const title = lines.find((line) => line.trim().startsWith("Status"))!;
    expect(title.startsWith(`${F.MARK}Status`)).toBe(true);
    // The build still sits hard against the right edge.
    expect(title.trimEnd()).toMatch(/v0\.3\.0$/);
    // And no dash rules anywhere: a dash rule reads as texture, a hairline as
    // structure, and this card was the last place still drawing them.
    expect(stripAnsi(renderStatus({ ...base }))).not.toMatch(/-{10}/);
  });

  it("renders the gear row from the shared table", () => {
    const out = stripAnsi(renderStatus({ ...base, permissionMode: "gear-2" as const }));
    expect(out).toContain(
      `${glyph("selection").repeat(2)} 2nd gear \u00b7 workspace edits proceed`,
    );
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
