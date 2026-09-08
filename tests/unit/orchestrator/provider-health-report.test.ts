// `rune doctor` has to answer two questions the founder's own
// ~/.rune/provider-health.json poses and nothing surfaced:
//
//   1. "Is my Codex cap over?" — the record's window closed days ago and the
//      file is only rewritten when a session records health, so a stale cap
//      looks exactly like a live one.
//   2. "Why does Google think it retired a model?" — the retirement is filed
//      against `google` for `gpt-5.6-sol`, a Codex model id. A misrouted call
//      was blamed on the route it was misdirected to.
//
// The fixture below is the founder's file byte-for-byte (2026-09-07), so these
// tests fail if the wording stops naming either shape.

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatWindow,
  humanDuration,
  providerRouteLines,
  readProviderRouteReport,
} from "../../../packages/orchestrator/src/provider-health-report";

const NOW = Date.UTC(2026, 8, 8, 12, 0, 0); // 2026-09-08 12:00Z

/** The founder's record, verbatim. */
const FOUNDER_FILE = {
  version: 1,
  retired: [
    {
      provider: "google",
      model: "gpt-5.6-sol",
      until: 1789064806171, // 2026-09-10
      reason:
        "models/gpt-5.6-sol is not found for API version v1beta, or is not supported for generateContent.",
    },
  ],
  capped: [
    {
      provider: "codex",
      until: 1788789884460, // 2026-09-06 — already past NOW
      message: "Codex request failed (429): The usage limit has been reached",
    },
  ],
};

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "rune-health-report-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function write(file: unknown): void {
  writeFileSync(join(home, "provider-health.json"), JSON.stringify(file));
}

/** No credential lookup should reach the real machine. */
const ENV: NodeJS.ProcessEnv = { HOME: "/nonexistent-home-for-tests", RUNE_HOME: "" };

function lines(now = NOW): string[] {
  const report = readProviderRouteReport({ home, now, env: { ...ENV, RUNE_HOME: home } });
  return providerRouteLines(report, now).flatMap((l) => [l.text, ...l.sub]);
}

describe("humanDuration", () => {
  test("uses the coarsest unit that still says something", () => {
    expect(humanDuration(42_000)).toBe("42s");
    expect(humanDuration(14 * 60_000)).toBe("14m");
    expect(humanDuration(3 * 3_600_000)).toBe("3h");
    expect(humanDuration(3 * 3_600_000 + 12 * 60_000)).toBe("3h 12m");
    expect(humanDuration(50 * 3_600_000)).toBe("2d 2h");
    expect(humanDuration(48 * 3_600_000)).toBe("2d");
  });
});

describe("formatWindow", () => {
  test("a live window says how long is left", () => {
    expect(formatWindow(NOW + 3 * 3_600_000, NOW)).toContain("left");
    expect(formatWindow(NOW + 3 * 3_600_000, NOW)).toStartWith("until ");
  });

  test("a closed window says it expired, and how long ago", () => {
    const s = formatWindow(NOW - 2 * 86_400_000, NOW);
    expect(s).toStartWith("expired ");
    expect(s).toContain("2d ago");
  });
});

describe("readProviderRouteReport", () => {
  test("a missing file is not an error — nothing has failed on this machine", () => {
    const r = readProviderRouteReport({ home, now: NOW, env: { ...ENV, RUNE_HOME: home } });
    expect(r.missing).toBe(true);
    expect(r.rows).toEqual([]);
    expect(r.unreadable).toBeUndefined();
    expect(lines()[0]).toContain("no cap or retirement recorded");
  });

  test("a corrupt file is reported, not thrown", () => {
    writeFileSync(join(home, "provider-health.json"), "{not json");
    const r = readProviderRouteReport({ home, now: NOW, env: { ...ENV, RUNE_HOME: home } });
    expect(r.unreadable).toBeTruthy();
    expect(lines().join("\n")).toContain("could not be read");
  });

  test("a version this build does not understand is named as such", () => {
    write({ version: 2, retired: [], capped: [] });
    expect(lines().join("\n")).toContain("not a record this build understands");
  });

  test("the founder's expired Codex cap is called expired and stale", () => {
    write(FOUNDER_FILE);
    const joined = lines().join("\n");
    expect(joined).toContain("codex: plan cap expired");
    expect(joined).toContain("ago");
    expect(joined).toContain("STALE");
    expect(joined).toContain("The usage limit has been reached");
  });

  test("the founder's Google retirement is named as a misroute, not a Google failure", () => {
    write(FOUNDER_FILE);
    const joined = lines().join("\n");
    expect(joined).toContain("google: model gpt-5.6-sol recorded retired");
    expect(joined).toContain("gpt-5.6-sol is a codex model id, not a google one");
    expect(joined).toContain("misdirected");
  });

  test("stale entries are counted and explained", () => {
    write(FOUNDER_FILE);
    const joined = lines().join("\n");
    expect(joined).toContain("1 stale entry");
    expect(joined).toContain("nothing has written the file since");
  });

  test("a live cap is reported as in force, with the window", () => {
    write({
      version: 1,
      retired: [],
      capped: [{ provider: "codex", until: NOW + 14 * 60_000, message: "limit reached" }],
    });
    const joined = lines().join("\n");
    expect(joined).toContain("codex: plan cap in force");
    expect(joined).toContain("14m left");
    expect(joined).not.toContain("STALE");
  });

  test("a retirement of a model the provider really offers carries no misroute note", () => {
    write({
      version: 1,
      capped: [],
      retired: [
        { provider: "google", model: "gemini-2.5-flash", until: NOW + 86_400_000, reason: "404" },
      ],
    });
    const joined = lines().join("\n");
    expect(joined).toContain("google: model gemini-2.5-flash recorded retired");
    expect(joined).not.toContain("model id, not a");
  });

  test("a provider whose ids are free-form is never accused of a misroute", () => {
    // Ollama tags and OpenRouter slugs are open sets; the preset's `models` list
    // is a suggestion, so an id outside it means nothing.
    write({
      version: 1,
      capped: [],
      retired: [
        {
          provider: "openrouter",
          model: "qwen/qwen3-coder:free",
          until: NOW + 86_400_000,
          reason: "410",
        },
      ],
    });
    expect(lines().join("\n")).not.toContain("model id, not a");
  });

  test("malformed rows are skipped rather than crashing the page", () => {
    write({
      version: 1,
      capped: [{ provider: "codex" }, { until: 1 }],
      retired: [{ provider: "google", model: "x" }],
    });
    const r = readProviderRouteReport({ home, now: NOW, env: { ...ENV, RUNE_HOME: home } });
    expect(r.rows).toEqual([]);
  });

  test("local routes count as configured without any credential", () => {
    const r = readProviderRouteReport({ home, now: NOW, env: { ...ENV, RUNE_HOME: home } });
    expect(r.configured).toContain("ollama");
  });

  test("an env var is enough to count a route as configured", () => {
    const r = readProviderRouteReport({
      home,
      now: NOW,
      env: { ...ENV, RUNE_HOME: home, OPENROUTER_API_KEY: "sk-or-test" },
    });
    expect(r.configured).toContain("openrouter");
    expect(lines().join("\n")).toContain("configured");
  });
});
