import { afterEach, describe, expect, it } from "bun:test";
import { renderBanner, wordmark } from "../../../packages/orchestrator/src/bin/ui/banner";
import { stripAnsi } from "../../../packages/orchestrator/src/bin/ui/theme";
import { glyph } from "../../../packages/orchestrator/src/bin/ui/glyphs";
import * as F from "../../../packages/orchestrator/src/bin/ui/flow";
import * as os from "os";

// Hermetic: the header prints the whole directory coordinate, so the workspace
// has to sit under THIS machine's home for the `~` substitution — and for the
// git probes — to behave the same everywhere.
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
      scope: "1st gear",
      caution: "every action asks first",
      ...extra,
    }),
  );
}

/** The identity row, without the leading blank or the rule under it. */
function row(columns: number, extra: Record<string, unknown> = {}): string {
  return banner(columns, extra)
    .split("\n")
    .filter((line) => line.trim())[0]!;
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
    // Indented to the content column: a rule begins where the row above it does.
    expect(lines[1]).toMatch(/^ {2}━+─+$/);
    // Still no artwork. The name is SET as a mark, never drawn as one.
    expect(output).not.toContain("⚙");
    expect(output).not.toContain("⣴");
    expect(output).not.toContain("Ready to build.");
    // And no dashed rules — a dash rule reads as texture, a hairline as structure.
    expect(output).not.toMatch(/-{10}/);
  });

  it("sets the name as a wordmark: letterspaced and capitalised", () => {
    // The complaint that started this was "it just looks like text", and it was
    // right: `rune · sample-app` used one of the four instruments a terminal
    // actually has (colour) and none of the other three. A monospace grid
    // cannot change family, size or width — it can change TRACKING, CASE and
    // WEIGHT, and a name spaced out across the grid cannot be read as the first
    // word of a sentence.
    expect(row(100)).toContain("R U N E");
    expect(row(100)).not.toContain("rune ·");
  });

  it("names the whole directory coordinate, not the folder", () => {
    // The folder name alone was ambiguous in exactly the case that matters:
    // `web` under two different projects produced two identical headers. The
    // path is `~`-shortened, which is the form a person recognises.
    expect(row(100)).toContain("~/Projects/sample-app");
    expect(row(100)).not.toContain(os.homedir());
  });

  it("puts the build hard against the right edge, and nothing after it", () => {
    for (const columns of [60, 100, 165]) {
      expect(row(columns).trimEnd(), `@${columns}`).toMatch(/v0\.2\.0$/);
    }
    // `v`-prefixed, and it is the only thing on the right — the row reads
    // who / where / which build, in that order, and stops.
    expect(row(100)).not.toContain("0.2.0 ·");
  });

  it("carries nothing that the status line already carries", () => {
    // These were on the row and are gone by request: the dirty-file count, the
    // MCP count, and the sandbox state. Every one of them is live, every one of
    // them is already on the status line above the composer, and this row is
    // committed scrollback under --inline — so the header held the stale copy
    // of a fact stated twice on one screen.
    const output = banner(100, { dirtyFiles: 3, sandbox: false, mcpServers: 2 });
    expect(output).not.toContain("files changed");
    expect(output).not.toContain("sandbox");
    expect(output).not.toContain("mcp");
    // The model and the gear left earlier, for the same reason.
    expect(output).not.toContain("claude-sonnet-4-6");
    expect(output).not.toContain("1st gear");
  });

  it("says nothing about the branch in the main checkout", () => {
    // The row is silent until you are somewhere that can surprise you. A branch
    // on every line is a line you stop reading.
    expect(row(100, { branch: "gear/phase-0-stabilize" })).not.toContain("gear/phase-0-stabilize");
  });

  it("the rule changes tone under the last cell of the wordmark", () => {
    // The mark sits on something instead of merely starting a line. Colour is
    // unreachable in a test process (no tty, so every role paints to plain
    // text), so what is pinned here is the column the tone change lands on —
    // the claim that would actually break if the lockup and the rule drifted.
    const lines = banner(120)
      .split("\n")
      .filter((line) => line.trim());
    expect(stripAnsi(F.seamRule(F.surfaceWidth(), F.lockup("Rune").cells))).toBe(lines[1]);
  });

  it("chrome aligns to the WINDOW, so the build lands on the rule's right edge", () => {
    // Regression: the header row was budgeted to measure(), which caps at 120
    // so prose never becomes a 200-column sentence. Right for prose, wrong for
    // chrome — on a 165-column terminal it parked the right-hand field at
    // column 120 while the rule beneath ran to 164, a 44-column gap that reads
    // as a broken edge.
    for (const columns of [80, 120, 165, 220]) {
      const lines = banner(columns)
        .split("\n")
        .filter((line) => line.trim());
      // Symmetric margin: MARK on the left, the same on the right.
      expect(lines[0]!.length).toBe(Math.max(20, columns - 2));
      expect(lines[0]!.trimEnd()).toMatch(/sample-app/);
    }
  });

  it("rules span the window; every line stays inside it", () => {
    for (const columns of [44, 60, 100, 220]) {
      const lines = banner(columns)
        .split("\n")
        .filter((line) => line.trim());
      const hair = lines.at(-1)!;
      expect(hair).toMatch(/^ {2}━+─+$/);
      expect(hair.length).toBe(Math.max(20, columns - 2));
      // …and it is exactly as wide as the identity row it closes.
      expect(hair.length).toBe(lines[0]!.length);
      // …while every line still stays inside the window, never touching its
      // last cell (a full-width line wraps, and a wrap desyncs the composer).
      for (const line of lines) expect(line.length).toBeLessThan(columns);
    }
  });

  it("uses a text glyph rather than an emoji-font rune in the compact wordmark", () => {
    expect(stripAnsi(wordmark())).toBe(`${glyph("phase")} Rune`);
  });
});

describe("ui/flow pathTail", () => {
  const deep = "~/Project/Alan/packages/orchestrator/src/bin/ui";

  it("cuts from the LEFT, on a separator", () => {
    // Dropping the tail is right for prose and wrong for a path:
    // `~/Project/Alan/packages/orchestr…` spends thirty columns saying nothing
    // you did not already know, and throws away the segment that says where you
    // actually are.
    expect(F.pathTail(deep, 22)).toBe("…/src/bin/ui");
    expect(F.pathTail(deep, 30)).toBe("…/orchestrator/src/bin/ui");
    // Whole segments only — never `…rc/bin/ui`.
    for (const max of [8, 12, 16, 20, 24, 28, 32, 40]) {
      const cut = F.pathTail(deep, max);
      expect(cut.length, `max ${max}`).toBeLessThanOrEqual(max);
      expect(cut[0], `max ${max}`).toBe("…");
      expect(cut.slice(1), `max ${max}`).toBe(deep.slice(deep.length - cut.length + 1));
    }
  });

  it("returns the path untouched when it fits", () => {
    expect(F.pathTail(deep, deep.length)).toBe(deep);
    expect(F.pathTail("~/a", 40)).toBe("~/a");
  });

  it("keeps the END of a segment too long to fit whole", () => {
    // `…gle-segment` still identifies the place; `~/one-very-l…` does not.
    expect(F.pathTail("~/one-very-long-single-segment", 12)).toBe("…gle-segment");
  });
});

// ─── The render-path git facts ───
// The header renders every frame. These pin the contract that replaced the
// immortal branch cache and the synchronous every-2s `git status`: first
// resolve is synchronous, steady-state renders return instantly from cache,
// and a stale entry refreshes in the background.

import { execFileSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { __resetBannerCachesForTest } from "../../../packages/orchestrator/src/bin/ui/banner";

function git(repo: string, ...args: string[]): void {
  execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
}

describe("ui/banner git facts", () => {
  it("names a linked worktree by its branch, and stays quiet in the main checkout", () => {
    const root = mkdtempSync(join(tmpdir(), "rune-banner-wt-"));
    const repo = join(root, "repo");
    const tree = join(root, "stream-wt");
    try {
      execFileSync("git", ["init", "-q", "-b", "main", repo], { stdio: "ignore" });
      git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "x");
      git(repo, "worktree", "add", "-q", "-b", "fix/stream", tree);
      __resetBannerCachesForTest();

      // The main checkout of a repo that HAS worktrees is still the main
      // checkout, and the row stays quiet. This is the case that separates
      // "is a worktree" from "has worktrees".
      expect(banner(140, { workspace: repo, branch: undefined })).not.toContain("worktree");

      // Inside the linked worktree it says so, and names the branch.
      expect(banner(140, { workspace: tree, branch: undefined })).toContain("worktree fix/stream");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolves the branch synchronously on first render, then refreshes in the background", async () => {
    const root = mkdtempSync(join(tmpdir(), "rune-banner-branch-"));
    const repo = join(root, "repo");
    const tree = join(root, "wt");
    try {
      execFileSync("git", ["init", "-q", "-b", "main", repo], { stdio: "ignore" });
      git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "x");
      git(repo, "worktree", "add", "-q", "-b", "first-branch", tree);
      __resetBannerCachesForTest();

      // First frame: right immediately (synchronous resolve).
      expect(banner(140, { workspace: tree, branch: undefined })).toContain("first-branch");

      // The world changes under the session.
      git(tree, "checkout", "-q", "-b", "second-branch");

      // Within the TTL the header serves the cache — instantly, and still the
      // old branch (staleness bounded by the TTL is the accepted trade).
      expect(banner(140, { workspace: tree, branch: undefined })).toContain("first-branch");

      // Age the cache out and render once: the frame returns the OLD value
      // (never blocks) while kicking one background refresh…
      const { __bannerCachesForTest } =
        (await import("../../../packages/orchestrator/src/bin/ui/banner")) as unknown as {
          __bannerCachesForTest?: { age(): void };
        };
      if (__bannerCachesForTest) __bannerCachesForTest.age();
      expect(banner(140, { workspace: tree, branch: undefined })).toContain("first-branch");

      // …which lands within a few tens of ms.
      const deadline = Date.now() + 3000;
      let fresh = "";
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        fresh = banner(140, { workspace: tree, branch: undefined });
        if (fresh.includes("second-branch")) break;
      }
      expect(fresh).toContain("second-branch");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
