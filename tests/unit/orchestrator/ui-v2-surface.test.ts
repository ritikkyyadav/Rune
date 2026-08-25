/**
 * v2 surface renderers (gear-customizer-v2.html contract):
 * fallback banner, compaction line, footer context meter, queued-input strip,
 * permission risk row + y/a/n keys, model-picker tags, session day-grouping.
 * All pure functions — asserted on ANSI-stripped output.
 */

import { describe, test, expect } from "bun:test";
import {
  formatFallback,
  formatCompaction,
  formatEvent,
} from "../../../packages/orchestrator/src/bin/ui/events";
import {
  contextMeter,
  statusLine,
  renderQueueStrip,
  renderPermissionCard,
  renderPicker,
  sessionGroupLabel,
} from "../../../packages/orchestrator/src/bin/ui/composer";
import { permissionKeyAction } from "../../../packages/orchestrator/src/bin/ui/tui";
import { stripAnsi } from "../../../packages/orchestrator/src/bin/ui/theme";

const FALLBACK = {
  from: { provider: "anthropic", model: "claude-x" },
  to: { provider: "openrouter", model: "qwen/qwen3-coder:free" },
  status: 429,
  reason: "rate limited",
  chain: ["openrouter", "ollama"],
};

describe("provider reroute note", () => {
  test("names what degraded, the chain, and the continuity promise", () => {
    const out = stripAnsi(formatFallback(FALLBACK));
    const flat = out.replace(/\s+/g, " ");
    expect(out).toContain("provider degraded — rerouted mid-turn");
    expect(flat).toContain("anthropic/claude-x returned 429 (rate limited)");
    expect(flat).toContain("anthropic → openrouter → ollama");
    expect(flat).toContain("Resumed on openrouter/qwen/qwen3-coder:free");
    expect(flat).toContain("the turn continues and nothing was lost");
    // It wraps to the measure; every clause here is owed to the reader in full.
    for (const line of out.split("\n")) expect(line.trimEnd()).not.toMatch(/…$/);
  });

  test("formatEvent routes the typed fallback event to the note", () => {
    const out = stripAnsi(formatEvent({ type: "fallback", ...FALLBACK }) ?? "");
    expect(out).toContain("provider degraded");
  });

  test("renders without status or chain (reason-only degradation)", () => {
    const out = stripAnsi(
      formatFallback({
        from: { provider: "google", model: "gemini-2.5-flash" },
        to: { provider: "ollama", model: "llama3" },
        reason: "invalid API key",
      }),
    );
    expect(out.replace(/\s+/g, " ")).toContain("invalid API key");
    expect(out.replace(/\s+/g, " ")).toContain("google → ollama");
  });
});

describe("compaction line", () => {
  test("percentages derive from the provided limit; savings are shown", () => {
    const out = stripAnsi(
      formatCompaction({
        beforeTokens: 82_000,
        afterTokens: 51_000,
        limitTokens: 100_000,
        summarizedCount: 14,
      }),
    );
    expect(out).toContain("✓ compacted");
    expect(out).toContain("82% → 51%");
    expect(out).toContain("−31k tokens");
    expect(out).toContain("14 older messages summarized");
  });

  test("a forced compaction says why", () => {
    const out = stripAnsi(
      formatCompaction({ beforeTokens: 9000, afterTokens: 3000, limitTokens: 8000, forced: true }),
    );
    expect(out).toContain("compacted (window exceeded)");
  });

  test("formatEvent routes compaction; usage/checkpoint stay off the transcript", () => {
    expect(
      formatEvent({ type: "compaction", beforeTokens: 10, afterTokens: 5, limitTokens: 100 }),
    ).toBeTruthy();
    expect(formatEvent({ type: "usage", inputTokens: 1, outputTokens: 2 })).toBeNull();
    expect(formatEvent({ type: "checkpoint_saved", runId: "r", version: 1 })).toBeNull();
  });
});

describe("footer context meter", () => {
  test("absent until a real percentage exists", () => {
    expect(contextMeter(undefined)).toBeNull();
    expect(contextMeter(0)).toBeNull();
    expect(contextMeter(Number.NaN)).toBeNull();
  });

  test("stays quiet until the number is worth acting on, then states it plainly", () => {
    // Below half full there is nothing to decide, so there is nothing to show.
    expect(contextMeter(41)).toBeNull();
    expect(stripAnsi(contextMeter(73) ?? "")).toBe("73% context");
    expect(stripAnsi(contextMeter(95) ?? "")).toBe("95% context");
    // No meter glyphs: five cells said less than the number and cost more room.
    expect(stripAnsi(contextMeter(95) ?? "")).not.toContain("▮");
  });

  test("statusLine carries the readout once it matters", () => {
    const withMeter = stripAnsi(
      statusLine({ model: "m", workspace: "/w", mode: "confirm", contextPercent: 73 }, 140),
    );
    expect(withMeter).toContain("73% context");
    const without = stripAnsi(statusLine({ model: "m", workspace: "/w", mode: "confirm" }, 140));
    expect(without).not.toContain("context");
  });
});

describe("queued-input strip", () => {
  test("empty queue renders nothing", () => {
    expect(renderQueueStrip([], 100)).toEqual([]);
  });

  test("states the contract and numbers each message in order", () => {
    const lines = renderQueueStrip(["first message", "second message"], 100).map(stripAnsi);
    expect(lines[0]).toContain("queued · sends when this turn completes");
    expect(lines[1]).toMatch(/^\s+1\s+first message/);
    expect(lines[2]).toMatch(/^\s+2\s+second message/);
    expect(lines[2]).toContain("removes the last"); // the undo hint rides the last row
  });

  test("stays inside the terminal width", () => {
    const long = "x".repeat(500);
    for (const line of renderQueueStrip([long], 60)) {
      expect(stripAnsi(line).length).toBeLessThan(60);
    }
  });
});

describe("permission card v2", () => {
  const preview = {
    question: "Run this command?",
    scope: "sandboxed command · workspace",
    detail: "$ bun test tests/unit/",
    lines: [],
    added: 0,
    removed: 0,
    truncated: false,
    guard: "Command has not run · review before execute",
    choices: ["Yes, run this command", "Yes, allow shell commands for this session", "No"] as [
      string,
      string,
      string,
    ],
    risk: [
      { label: "writes outside workspace", value: "blocked (sandbox)", tone: "ok" as const },
      { label: "network egress", value: "blocked", tone: "ok" as const },
      { label: "est. runtime", value: "≤120s cap", tone: "muted" as const },
      { label: "rate limit", value: "4/10 per min", tone: "muted" as const },
    ],
  };

  test("states every computed consequence, and what has not happened yet", () => {
    const out = renderPermissionCard("bash", "bash: bun test", 120, { preview })
      .lines.map((l) => stripAnsi(l).trim())
      .join(" ");
    expect(out).toContain("writes outside workspace blocked (sandbox)");
    expect(out).toContain("network egress blocked");
    expect(out).toContain("est. runtime ≤120s cap");
    expect(out).toContain("rate limit 4/10 per min");
    expect(out).toContain("recorded in the audit trail");
    expect(out).toContain("Command has not run");
  });

  test("numbers the caller's own answers and names escape as the default", () => {
    const out = renderPermissionCard("bash", "bash: ls", 120, { preview })
      .lines.map(stripAnsi)
      .join("\n");
    expect(out).toContain("1   Yes, run this command");
    expect(out).toContain("2   Yes, allow shell commands for this session");
    expect(out).toContain("3   No");
    expect(out).toContain("esc cancel");
    // The command is shown verbatim on its own rail, with no added prompt glyph.
    expect(out).toContain("│ bun test tests/unit/");
    expect(out).not.toContain("$ ");
  });

  test("`a` resolves to allow-for-session in the key reducer (y/n unchanged)", () => {
    expect(permissionKeyAction({ type: "char", value: "a" }, 0).decision).toEqual({
      kind: "allow_session",
    });
    expect(permissionKeyAction({ type: "char", value: "A" }, 2).decision).toEqual({
      kind: "allow_session",
    });
    expect(permissionKeyAction({ type: "char", value: "y" }, 2).decision).toEqual({
      kind: "allow_once",
    });
    expect(permissionKeyAction({ type: "char", value: "n" }, 0).decision).toEqual({
      kind: "deny",
    });
  });
});

describe("model picker v2", () => {
  test("renders free/local/provider tags and the gateway footnote", () => {
    const r = renderPicker(
      "Select model and effort",
      [
        {
          label: "Gemini 2.5 Flash",
          hint: "google/gemini-2.5-flash",
          tags: ["free", "google"],
          current: true,
        },
        { label: "Llama 3", hint: "ollama/llama3", tags: ["local", "ollama"] },
      ],
      0,
      120,
      Number.POSITIVE_INFINITY,
      {
        footnote:
          "Gateway retries with backoff and falls back down the provider chain on rate limits.",
      },
    );
    const out = r.lines.map(stripAnsi).join("\n");
    expect(out).toContain("free");
    expect(out).toContain("local");
    expect(out).toContain("current");
    expect(out).toContain("select model and effort");
    expect(out).toContain("Gateway retries with backoff");
  });
});

describe("session day grouping", () => {
  const now = new Date("2026-08-20T00:30:00"); // just past midnight, local time
  test("correct across midnight: 23:50 yesterday is Yesterday, 00:10 today is Today", () => {
    expect(sessionGroupLabel(new Date("2026-08-20T00:10:00").toISOString(), now)).toBe("Today");
    expect(sessionGroupLabel(new Date("2026-08-19T23:50:00").toISOString(), now)).toBe("Yesterday");
    expect(sessionGroupLabel(new Date("2026-08-15T12:00:00").toISOString(), now)).toBe(
      "Past 7 days",
    );
  });
  test("older sessions collapse to Month YYYY; garbage is Earlier", () => {
    expect(sessionGroupLabel(new Date("2026-06-01T12:00:00").toISOString(), now)).toMatch(/2026/);
    expect(sessionGroupLabel("not-a-date", now)).toBe("Earlier");
  });
});
