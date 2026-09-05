/**
 * `rune pr <n>` — the parts that do not need GitHub.
 *
 * The brief is the interesting one. A session that starts from a summary of a
 * pull request has already lost the thing a review is checked against: the
 * author's own account of what they were doing. So the body goes in verbatim,
 * and this asserts that rather than trusting it.
 */

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { briefFromPr, repoSlug, selfCommand } from "../../../packages/orchestrator/src/bin/pr-cli";

const pr = {
  number: 12,
  title: "Deferred tool schemas",
  body: "A 40-tool server costs 40 schemas per request.\n\nThis defers them until first use.",
  author: "someone",
  baseRef: "main",
  headRef: "feat/deferred-tools",
};

describe("the brief a PR session starts from", () => {
  test("carries the author's description verbatim", () => {
    const brief = briefFromPr(pr, "Review the change");
    expect(brief).toContain("A 40-tool server costs 40 schemas per request.");
    expect(brief).toContain("This defers them until first use.");
  });

  test("names the pull request, the author and the merge direction", () => {
    const brief = briefFromPr(pr, "Review the change");
    expect(brief).toContain("pull request #12: Deferred tool schemas");
    expect(brief).toContain("Opened by someone.");
    expect(brief).toContain("Merging feat/deferred-tools into main.");
  });

  test("says so when there is no description rather than inventing one", () => {
    const brief = briefFromPr({ ...pr, body: "   " }, "Review the change");
    expect(brief).toContain("(the pull request has no description)");
  });

  test("points at the diff range, so the session knows what is under review", () => {
    expect(briefFromPr(pr, "Review the change")).toContain("git diff main...HEAD");
  });

  test("the task frames the session", () => {
    expect(briefFromPr(pr, "Work on the change")).toStartWith(
      "Work on the change for pull request",
    );
  });
});

describe("finding the repository", () => {
  test("reads a slug out of either URL shape git writes", () => {
    expect(repoSlug("git@github.com:ritikkyyadav/Alan.git")).toBe("ritikkyyadav/Alan");
    expect(repoSlug("https://github.com/ritikkyyadav/Alan.git")).toBe("ritikkyyadav/Alan");
    expect(repoSlug("https://github.com/ritikkyyadav/Alan")).toBe("ritikkyyadav/Alan");
    // GITHUB_REPOSITORY is already a slug.
    expect(repoSlug("ritikkyyadav/Alan")).toBe("ritikkyyadav/Alan");
    expect(repoSlug("https://gitlab.com/x/y.git")).toBeNull();
  });
});

describe("re-invoking this CLI", () => {
  test("from a source checkout it is bun plus the script", () => {
    const dir = join(import.meta.dir, "../../../packages/orchestrator/src/bin");
    expect(existsSync(join(dir, "rune-cli.ts"))).toBe(true);
    expect(selfCommand(dir, "/usr/local/bin/bun")).toEqual([
      "/usr/local/bin/bun",
      join(dir, "rune-cli.ts"),
    ]);
  });

  test("from the compiled binary it is the binary", () => {
    // A compiled build's script path is virtual and not on disk; passing it as
    // an argument is a spawn failure that only happens on the installed build.
    expect(selfCommand("/nowhere", "/usr/local/bin/rune")).toEqual(["/usr/local/bin/rune"]);
  });
});
