import { afterEach, describe, expect, it } from "bun:test";
import { renderBanner, wordmark } from "../../../packages/orchestrator/src/bin/ui/banner";
import { stripAnsi } from "../../../packages/orchestrator/src/bin/ui/theme";
import * as os from "os";

// Hermetic: the header names the folder you are in, not the whole path — but
// the workspace still has to exist under THIS machine's home for the branch and
// dirty-file probes to behave the same everywhere.
const WORKSPACE = `${os.homedir()}/Projects/sample-app`;

const originalColumns = process.stdout.columns;

afterEach(() => {
  Object.defineProperty(process.stdout, "columns", {
    value: originalColumns,
    configurable: true,
  });
});

function banner(columns: number, extra: Record<string, unknown> = {}): string {
  Object.defineProperty(process.stdout, "columns", { value: columns, configurable: true });
  return stripAnsi(
    renderBanner({
      model: "claude-sonnet-4-6",
      provider: "anthropic",
      version: "0.2.0",
      workspace: WORKSPACE,
      branch: "main",
      dirtyFiles: 0,
      sandbox: true,
      scope: "1st gear",
      caution: "every action asks first",
      ...extra,
    }),
  );
}

describe("ui/banner", () => {
  it("opens with a rule, where you are, and what the agent may do — and no logo", () => {
    const output = banner(100);
    const lines = output.split("\n").filter((line) => line.trim());
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/^──── gear 0\.2\.0 ─+$/);
    expect(lines[1]).toBe("  sample-app · main");
    expect(lines[2]).toBe("  claude-sonnet-4-6 · 1st gear — every action asks first");
    expect(lines[3]).toMatch(/^─+$/);
    // Nothing decorative survives: no mark, no avatar, no wordmark, no tagline.
    expect(output).not.toContain("⚙");
    expect(output).not.toContain("⣴");
    expect(output).not.toContain("Ready to build.");
  });

  it("states the tree's real shape and any guardrail that has been removed", () => {
    const output = banner(100, { dirtyFiles: 3, sandbox: false, mcpServers: 2 });
    expect(output).toContain("sample-app · main · 3 files changed · sandbox off · mcp 2");
  });

  it("prefers the preset's model label and carries the effort dial", () => {
    const output = banner(100, { modelLabel: "Gemini 2.5 Flash", effort: "high" });
    expect(output).toContain("Gemini 2.5 Flash · high effort · 1st gear");
    expect(output).not.toContain("gemini-2.5-flash");
  });

  it("rules span the window; content stays in the reading column", () => {
    for (const columns of [44, 60, 100, 220]) {
      const lines = banner(columns)
        .split("\n")
        .filter((line) => line.trim());
      // The two rules divide the whole surface…
      for (const rule of [lines[0]!, lines.at(-1)!]) {
        expect(rule).toMatch(/─$/);
        expect(rule.length).toBeGreaterThanOrEqual(Math.min(120, columns) - 1);
      }
      // …while every line still stays inside the window, never touching its
      // last cell (a full-width line wraps, and a wrap desyncs the composer).
      for (const line of lines) expect(line.length).toBeLessThan(columns);
    }
  });

  it("uses a text glyph rather than an emoji-font gear in the compact wordmark", () => {
    expect(stripAnsi(wordmark())).toBe("⚙︎ Gear");
  });
});

// ─── The render-path git caches ───
// The header renders every frame. These pin the contract that replaced the
// immortal branch cache and the synchronous every-2s `git status`: first
// resolve is synchronous, steady-state renders return instantly from cache,
// and a stale entry refreshes in the background.

import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { __resetBannerCachesForTest } from "../../../packages/orchestrator/src/bin/ui/banner";

function git(repo: string, ...args: string[]): void {
  execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
}

describe("ui/banner git caches", () => {
  it("resolves branch + dirty count synchronously on first render, then refreshes in the background", async () => {
    const repo = mkdtempSync(join(tmpdir(), "gear-banner-git-"));
    try {
      git(repo, "init", "-b", "first-branch");
      git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "x");
      __resetBannerCachesForTest();

      // First frame: right immediately (synchronous resolve).
      const first = banner(100, { workspace: repo, branch: undefined, dirtyFiles: undefined });
      expect(first).toContain("first-branch");

      // The world changes: new branch, a dirty file.
      git(repo, "checkout", "-q", "-b", "second-branch");
      writeFileSync(join(repo, "dirty.txt"), "x");

      // Within the TTL the header serves the cache — instantly, and still the
      // old branch (staleness bounded by the TTL is the accepted trade).
      const cached = banner(100, { workspace: repo, branch: undefined, dirtyFiles: undefined });
      expect(cached).toContain("first-branch");

      // Age the cache out and render once: the frame returns the OLD value
      // (never blocks) while kicking one background refresh…
      const { __bannerCachesForTest } =
        (await import("../../../packages/orchestrator/src/bin/ui/banner")) as unknown as {
          __bannerCachesForTest?: { age(): void };
        };
      // (test hook ages entries; fall back to waiting out the TTL if absent)
      if (__bannerCachesForTest) __bannerCachesForTest.age();
      const stale = banner(100, { workspace: repo, branch: undefined, dirtyFiles: undefined });
      expect(stale).toContain("first-branch");

      // …which lands within a few tens of ms.
      const deadline = Date.now() + 3000;
      let fresh = "";
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        fresh = banner(100, { workspace: repo, branch: undefined, dirtyFiles: undefined });
        if (fresh.includes("second-branch")) break;
      }
      expect(fresh).toContain("second-branch");
      expect(fresh).toContain("1 file changed");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
