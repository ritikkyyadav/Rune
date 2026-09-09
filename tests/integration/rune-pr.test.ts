/**
 * `rune pr <n>`, run against a pull request that exists.
 *
 * Not a real one — a local bare repository with a `refs/pull/<n>/head` ref in
 * it, which is exactly the shape GitHub publishes and the only thing the
 * command actually needs from a remote. That is the point of using plain git
 * rather than `gh pr checkout`: the fetch works on any remote that publishes
 * the ref, so it can be exercised without a network, a token, or a pull request
 * somebody has to keep alive for the test's benefit.
 *
 * `pr-cli.test.ts` covers the pure halves — the brief's wording, the slug
 * parsing, how the CLI re-invokes itself. What could only be checked by running
 * it is what this file runs: the fetch, the worktree, the branch, and the two
 * ways the command learns a pull request's title and body.
 *
 * Both metadata paths are driven, because they fail differently:
 *
 *   - `gh pr view`, with a stub `gh` first on PATH. This is the path a person
 *     with the CLI authenticated takes, and it is tried first.
 *   - the REST API, with `GITHUB_API_URL` pointed at a local server. That is
 *     the runner's own variable — it names the Enterprise Server API root on a
 *     self-hosted runner — so honouring it is GHES support, and the seam a test
 *     can reach through.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../..");
const CLI = join(repoRoot, "packages", "orchestrator", "src", "bin", "rune-cli.ts");

const PR_NUMBER = 4242;
const PR_TITLE = "Make total() subtract, which is the change under review";
const PR_BODY = [
  "The author's own account of the change.",
  "",
  "- flips `+` to `-`",
  "- deliberately, to give the reviewer something to find",
].join("\n");

function git(cwd: string, args: string[]): string {
  const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}

describe("rune pr <n> (a real fetch, a real worktree, a fake pull request)", () => {
  let dir: string;
  /** The "GitHub" side: a bare repo publishing refs/pull/<n>/head. */
  let remote: string;
  /** The clone a person is working in. */
  let local: string;
  let binDir: string;
  let api: ReturnType<typeof Bun.serve> | null = null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rune-pr-"));
    remote = join(dir, "remote.git");
    local = join(dir, "checkout");
    binDir = join(dir, "bin");
    mkdirSync(binDir, { recursive: true });

    // ── the upstream, with a base branch and a pull request head on it ──
    const seed = join(dir, "seed");
    mkdirSync(seed, { recursive: true });
    git(seed, ["init", "-q", "-b", "main"]);
    git(seed, ["config", "user.email", "test@example.com"]);
    git(seed, ["config", "user.name", "Test"]);
    writeFileSync(join(seed, "app.ts"), "export const total = (a: number, b: number) => a + b;\n");
    git(seed, ["add", "-A"]);
    git(seed, ["commit", "-qm", "base"]);
    git(seed, ["checkout", "-q", "-b", "the-change"]);
    writeFileSync(join(seed, "app.ts"), "export const total = (a: number, b: number) => a - b;\n");
    git(seed, ["add", "-A"]);
    git(seed, ["commit", "-qm", "flip the operator"]);
    const head = git(seed, ["rev-parse", "HEAD"]);

    // `-b main` on the bare remote too: a clone checks out whatever the
    // remote's HEAD names, and a bare `git init` names `init.defaultBranch`,
    // which is `master` on the Linux runner — the clone then sat on `master`
    // and the "local is untouched, still on main" assertion below failed there.
    git(dir, ["init", "-q", "--bare", "-b", "main", remote]);
    git(seed, ["push", "-q", remote, "main"]);
    // The ref GitHub publishes for every open pull request. Writing it by hand
    // is the whole trick: `rune pr` needs nothing else from a remote.
    git(seed, ["push", "-q", remote, `HEAD:refs/pull/${PR_NUMBER}/head`]);

    git(dir, ["clone", "-q", remote, local]);
    git(local, ["config", "user.email", "test@example.com"]);
    git(local, ["config", "user.name", "Test"]);
    // `repoSlug` reads `origin`; a filesystem path is not a GitHub URL, so give
    // the clone the remote a person would have.
    git(local, ["remote", "set-url", "--push", "origin", remote]);

    expect(git(local, ["ls-remote", remote, `refs/pull/${PR_NUMBER}/head`])).toContain(head);
  });

  afterEach(() => {
    api?.stop(true);
    api = null;
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * A stub `gh`, first on PATH.
   *
   * Always installed — including the "unauthenticated" variant — because the
   * alternative is the machine's own `gh` answering, and a test whose result
   * depends on whether the developer has a GitHub CLI logged in is not a test.
   * The first version of this file left PATH alone for the REST cases and spent
   * five minutes per run watching a real `gh` time out against the network.
   */
  function stubGh(mode: "authenticated" | "unauthenticated" = "authenticated"): void {
    const path = join(binDir, "gh");
    const body =
      mode === "authenticated"
        ? [
            `cat <<'JSON'`,
            JSON.stringify({
              number: PR_NUMBER,
              title: PR_TITLE,
              body: PR_BODY,
              author: { login: "a-contributor" },
              baseRefName: "main",
              headRefName: "the-change",
            }),
            "JSON",
          ]
        : ['echo "gh: To get started with GitHub CLI, please run: gh auth login" >&2', "exit 4"];
    writeFileSync(
      path,
      [
        "#!/bin/sh",
        // Anything but `pr view` must fail, so a test that accidentally depends
        // on some other `gh` call fails loudly instead of quietly passing.
        'if [ "$1" != "pr" ] || [ "$2" != "view" ]; then echo "stub gh: unsupported $*" >&2; exit 1; fi',
        ...body,
      ].join("\n"),
      { mode: 0o755 },
    );
    chmodSync(path, 0o755);
  }

  /** PATH with the stub in front of whatever this machine has. */
  const withStub = (): Record<string, string> => ({
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
  });

  /** A GitHub REST API on loopback, for the `gh`-less path. */
  function fakeApi(): string {
    api = Bun.serve({
      port: 0,
      fetch: (req) => {
        const { pathname } = new URL(req.url);
        if (pathname !== `/repos/savoir/rune/pulls/${PR_NUMBER}`) {
          return new Response("not found", { status: 404 });
        }
        return Response.json({
          number: PR_NUMBER,
          title: PR_TITLE,
          body: PR_BODY,
          user: { login: "a-contributor" },
          base: { ref: "main" },
          head: { ref: "the-change" },
        });
      },
    });
    return `http://127.0.0.1:${api.port}`;
  }

  /**
   * Run the CLI. ASYNC on purpose.
   *
   * `Bun.spawnSync` blocks this process's event loop, and the fake GitHub API
   * lives in this process — so a synchronous spawn deadlocks: the child waits
   * on a server whose host is blocked waiting on the child. That cost five
   * minutes a run to discover, which is also the argument for the kill timer.
   */
  async function runPr(
    args: string[],
    env: Record<string, string>,
  ): Promise<{ out: string; code: number }> {
    const p = Bun.spawn(["bun", CLI, "pr", String(PR_NUMBER), ...args], {
      cwd: local,
      env: {
        ...process.env,
        RUNE_HOME: join(dir, "home"),
        RUNE_DB_PATH: join(dir, "rune.db"),
        NO_COLOR: "1",
        ...env,
      },
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    const guard = setTimeout(() => p.kill("SIGKILL"), 60_000);
    const [out, err, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    clearTimeout(guard);
    return { out: out + err, code };
  }

  test("fetches the head into its own worktree and hands the session the author's brief", async () => {
    stubGh();
    const { out, code } = await runPr(["--brief", "--workspace", local], withStub());
    expect(code, out).toBe(0);

    // ── the worktree, beside the checkout rather than over it ──
    const worktree = join(local, ".rune", "worktrees", `pr-${PR_NUMBER}`);
    expect(out).toContain(worktree);
    expect(out).toContain(`rune/pr-${PR_NUMBER}`);
    // It is a real worktree with the pull request's content in it — not a
    // directory the command printed the name of. `symbolic-ref --short`, not
    // `rev-parse --abbrev-ref`: the latter answers `heads/rune/pr-N` for a
    // branch name with a slash in it.
    expect(git(worktree, ["symbolic-ref", "--short", "HEAD"])).toBe(`rune/pr-${PR_NUMBER}`);
    expect(git(worktree, ["show", "HEAD:app.ts"])).toContain("a - b");
    // …and the working tree it was run from is untouched, which is the reason
    // a worktree is used at all.
    expect(git(local, ["symbolic-ref", "--short", "HEAD"])).toBe("main");
    // Tracked files only: the command does add `.rune/worktrees/pr-N`, which is
    // untracked in a repository that has not ignored `.rune/` (backlog).
    expect(git(local, ["status", "--porcelain", "--untracked-files=no"])).toBe("");

    // ── the brief ──
    expect(out).toContain(`Work on the change for pull request #${PR_NUMBER}`);
    expect(out).toContain(PR_TITLE);
    expect(out).toContain("Opened by a-contributor.");
    expect(out).toContain("Merging the-change into main.");
    // The author's words, verbatim and whole. A summary written by the thing
    // about to review it is already a reading.
    expect(out).toContain("The author's description, verbatim:");
    expect(out).toContain("deliberately, to give the reviewer something to find");
    expect(out).toContain("git diff main...HEAD");
  }, 120_000);

  test("--review frames the same brief as a review", async () => {
    stubGh();
    const { out, code } = await runPr(["--brief", "--review", "--workspace", local], withStub());
    expect(code, out).toBe(0);
    expect(out).toContain(`Review the change for pull request #${PR_NUMBER}`);
  }, 120_000);

  test("re-running after a push moves the worktree instead of refusing", async () => {
    stubGh();
    const env = withStub();
    expect((await runPr(["--brief", "--workspace", local], env)).code).toBe(0);

    // The author pushes again; the ref moves.
    const seed = join(dir, "seed");
    writeFileSync(join(seed, "app.ts"), "export const total = (a: number, b: number) => a * b;\n");
    git(seed, ["add", "-A"]);
    git(seed, ["commit", "-qm", "second thoughts"]);
    git(seed, ["push", "-qf", remote, `HEAD:refs/pull/${PR_NUMBER}/head`]);

    const again = await runPr(["--brief", "--workspace", local], env);
    // Until P10.6 this failed outright: `git fetch` refuses to update a branch
    // that is checked out in a worktree, so the fetch died before any of the
    // "move it to the new head" logic could run. The second `rune pr 12` — the
    // one a person runs BECAUSE the author pushed — was the broken one.
    expect(again.code, again.out).toBe(0);
    const worktree = join(local, ".rune", "worktrees", `pr-${PR_NUMBER}`);
    // Silently reviewing a stale diff is the other failure this rules out.
    expect(git(worktree, ["show", "HEAD:app.ts"])).toContain("a * b");
  }, 120_000);

  test("falls back to the REST API, at GITHUB_API_URL, when `gh` cannot answer", async () => {
    // `gh` is present and not authenticated, which is the common case on a
    // runner. The command must fall through to the REST API rather than
    // treating a non-zero `gh` as the end of the road.
    stubGh("unauthenticated");
    const { out, code } = await runPr(["--brief", "--workspace", local], {
      // Without a root to point at, this test would reach api.github.com —
      // exactly the thing that makes a test depend on someone else's uptime.
      GITHUB_API_URL: fakeApi(),
      GITHUB_REPOSITORY: "savoir/rune",
      ...withStub(),
    });
    expect(code, out).toBe(0);
    expect(out).toContain(PR_TITLE);
    expect(out).toContain("Opened by a-contributor.");
  }, 120_000);

  test("says which repository and number it could not read, rather than failing blank", async () => {
    stubGh("unauthenticated");
    const { out, code } = await runPr(["--brief", "--workspace", local], {
      GITHUB_API_URL: fakeApi(),
      GITHUB_REPOSITORY: "savoir/nothing-here",
      ...withStub(),
    });
    expect(code).toBe(1);
    expect(out).toContain(`savoir/nothing-here#${PR_NUMBER}`);
    expect(out).toContain("set GITHUB_TOKEN");
  }, 120_000);
});
