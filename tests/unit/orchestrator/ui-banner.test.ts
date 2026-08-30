import { afterEach, describe, expect, it } from "bun:test";
import { renderBanner, wordmark } from "../../../packages/orchestrator/src/bin/ui/banner";
import { stripAnsi } from "../../../packages/orchestrator/src/bin/ui/theme";
import { glyph } from "../../../packages/orchestrator/src/bin/ui/glyphs";
import * as F from "../../../packages/orchestrator/src/bin/ui/flow";
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
  it("is ONE line of identity and ONE rule — nothing else", () => {
    const output = banner(100);
    const lines = output.split("\n").filter((line) => line.trim());
    // It used to be four: a rule with the name inlaid, a location row, a model
    // row, and a closing rule. Two heavy rules to say "a program started" is a
    // lot of screen spent before the first word of the session.
    // ONE row. The header does not close itself with a second rule: on a fresh
    // session there is no transcript between it and the composer, so its rule
    // would land on the row above the composer's own top rule and draw as a
    // doubled border. The composer's rule is the divider.
    expect(lines).toHaveLength(2);
    // Identity and location only. The model and the gear both change during a
    // session, and this row is committed scrollback that is never rewritten —
    // naming them here produced a header that stated the wrong model for the
    // rest of the run and contradicted the live status line. They live in the
    // pinned region now, which redraws.
    expect(lines[0]).toContain("sample-app · main");
    expect(lines[0]).not.toContain("claude-sonnet-4-6");
    expect(lines[0]).not.toContain("1st gear");
    // Indented to the content column: a rule begins where the row above it does.
    expect(lines[1]).toMatch(/^ {2}─+$/);
    // Still no artwork. The name is SET as a mark, never drawn as one.
    expect(output).not.toContain("⚙");
    expect(output).not.toContain("⣴");
    expect(output).not.toContain("Ready to build.");
    // And no dashed rules — a dash rule reads as texture, a hairline as structure.
    expect(output).not.toMatch(/-{10}/);
  });

  it("sets the name as a wordmark: letterspaced, capitalised, versioned", () => {
    // The complaint that started this was "it just looks like text", and it was
    // right: `gear · sample-app · main` used one of the four instruments a
    // terminal actually has (colour) and none of the other three. A monospace
    // grid cannot change family, size or width — it can change TRACKING, CASE
    // and WEIGHT, and a name spaced out across the grid cannot be read as the
    // first word of a sentence.
    const row = banner(100).split("\n")[1]!;
    expect(row).toContain("G E A R  0.2.0");
    // …and the version rides WITH the mark rather than being dropped. It was
    // plumbed through this header for months and never printed.
    expect(row.indexOf("0.2.0")).toBeLessThan(row.indexOf("sample-app"));
  });

  it("divides the row with the alphabet's own vertical, and only when there is something to divide", () => {
    expect(banner(100)).toContain("│");
    // Nothing on the right-hand side means nothing to divide from: a bar with
    // empty space after it is a bar that is not doing its job.
    const bare = banner(100, { workspace: "", branch: "", dirtyFiles: 0 });
    expect(bare.split("\n")[1]).not.toContain("│");
  });

  it("speaks ONE separator dialect", () => {
    // The environment facts arrived pre-joined with ` | ` while the row around
    // them used ` · ` for the identical job, so the header shipped two
    // punctuation systems on one line. The header receives the parts now.
    const output = banner(100, { dirtyFiles: 3, sandbox: false, mcpServers: 2 });
    expect(output).toContain("sample-app · main · 3 files changed · mcp 2 · sandbox off");
    expect(output.split("\n")[1]).not.toContain("|");
  });

  it("the rule changes tone directly under the divider", () => {
    // The seam is stated twice: once by the vertical on the row, once by the
    // rule beneath changing colour at the same column. Colour is unreachable in
    // a test process (no tty, so every role paints to plain text), so what is
    // pinned here is the column the two share — which is the claim that would
    // actually break if the lockup and the rule ever drifted apart.
    const [row, rule] = banner(120)
      .split("\n")
      .filter((line) => line.trim());
    const { cells } = F.lockup("Gear", "0.2.0");
    expect(row!.indexOf("│")).toBe(F.MARK.length + cells + 2);
    expect(stripAnsi(F.seamRule(F.surfaceWidth(), cells + 3))).toBe(rule);
  });

  it("sheds whole facts, so a removed guardrail is never the character the ellipsis ate", () => {
    // Ordering alone could not do this. `sandbox off` is last in reading order
    // because amber at the end of the row is where the eye stops — and last is
    // exactly what a truncating row drops first. At 80 columns the old row
    // clipped the one word it could least afford to.
    for (const columns of [44, 60, 80, 100, 160]) {
      const row = banner(columns, {
        workspace: `${os.homedir()}/Projects/sample-app`,
        branch: "gear/phase-0-stabilize",
        dirtyFiles: 3,
        sandbox: false,
        mcpServers: 2,
      }).split("\n")[1]!;
      expect(row, `@${columns}`).toContain("sandbox off");
      // The folder is the last thing to go, and it only goes on a window too
      // narrow to hold both it and the guardrail.
      if (columns >= 60) expect(row, `@${columns}`).toContain("sample-app");
      // Whole facts, not half words: nothing here is ever cut mid-value.
      expect(row, `@${columns}`).not.toContain("…");
    }
  });

  it("prefers the preset's model label and carries the effort dial", () => {
    // The label still resolves — it is simply not printed in the header any
    // more, because a model named in committed scrollback goes stale on the
    // next /model. statusLine carries it.
    const output = banner(100, { modelLabel: "Gemini 2.5 Flash", effort: "high" });
    expect(output).not.toContain("Gemini 2.5 Flash");
    expect(output).not.toContain("gemini-2.5-flash");
  });

  it("chrome aligns to the WINDOW, so the mode badge lands on the hairline's right edge", () => {
    // Regression: the header row was budgeted to measure(), which caps at 120
    // so prose never becomes a 200-column sentence. Right for prose, wrong for
    // chrome — on a 165-column terminal it parked the gear at column 120 while
    // the rule beneath ran to 164, a 44-column gap that reads as a broken edge.
    for (const columns of [80, 120, 165, 220]) {
      const lines = banner(columns)
        .split("\n")
        .filter((line) => line.trim());
      const content = lines[0]!;
      // The badge is the right edge, and the row fills the window it is chrome
      // for — measured against the surface, not the 120-column reading column.
      // Symmetric margin: MARK on the left, the same on the right.
      expect(content.length).toBe(Math.max(20, columns - 2));
      expect(content.trimEnd()).toMatch(/sample-app/);
    }
  });

  it("rules span the window; content stays in the reading column", () => {
    for (const columns of [44, 60, 100, 220]) {
      const lines = banner(columns)
        .split("\n")
        .filter((line) => line.trim());
      const hair = lines.at(-1)!;
      expect(hair).toMatch(/^ {2}─+$/);
      expect(hair.length).toBe(Math.max(20, columns - 2));
      // …and it is exactly as wide as the identity row it closes.
      expect(hair.length).toBe(lines[0]!.length);
      // …while every line still stays inside the window, never touching its
      // last cell (a full-width line wraps, and a wrap desyncs the composer).
      for (const line of lines) expect(line.length).toBeLessThan(columns);
    }
  });

  it("uses a text glyph rather than an emoji-font gear in the compact wordmark", () => {
    expect(stripAnsi(wordmark())).toBe(`${glyph("phase")} Gear`);
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
