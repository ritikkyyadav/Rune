// ─── rune pr <n> — the PR as a place to work, not a page to read ───
//
// Reviewing or fixing a pull request starts with the same four commands every
// time: fetch the head, put it somewhere that is not your working tree, read
// the description, and remember what the author said they were doing while you
// look at the diff. This does all four and hands the session the description as
// its brief, so the agent starts from the author's own account of the change
// rather than from a diff with no story attached.
//
// It uses plain git rather than `gh pr checkout`, because `refs/pull/<n>/head`
// is a ref every GitHub remote publishes and a CI runner will not have `gh`
// authenticated. `gh` is used only where there is no substitute — reading the
// title and body — and the REST API with `GITHUB_TOKEN` is the fallback.
//
// The worktree is the point. A PR checked out over your working tree is how
// you lose an hour to "why is my branch wrong"; a worktree is a second
// directory sharing one object store, and removing it leaves nothing behind.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { accent, danger, dim, info, muted, ok } from "./ui/theme";

const say = (s = ""): void => {
  process.stdout.write(s + "\n");
};

function git(cwd: string, args: string[]): { ok: boolean; out: string; err: string } {
  const res = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 120_000 });
  return {
    ok: res.status === 0,
    out: (res.stdout ?? "").trim(),
    err: (res.stderr ?? "").trim(),
  };
}

export interface PullRequest {
  number: number;
  title: string;
  body: string;
  author?: string;
  baseRef?: string;
  headRef?: string;
}

/**
 * The brief a session starts from.
 *
 * The author's own words come FIRST and verbatim. A summary of a PR body
 * written by the thing about to review it is a reading, and the whole value of
 * a read-back is that it can be checked against something the person actually
 * wrote.
 */
export function briefFromPr(pr: PullRequest, task: string): string {
  const body = pr.body.trim();
  return [
    `${task} for pull request #${pr.number}: ${pr.title}`,
    "",
    pr.author ? `Opened by ${pr.author}.` : "",
    pr.baseRef && pr.headRef ? `Merging ${pr.headRef} into ${pr.baseRef}.` : "",
    "",
    "The author's description, verbatim:",
    "",
    body ? body : "(the pull request has no description)",
    "",
    `The head is checked out in this workspace. \`git diff ${pr.baseRef ?? "HEAD~1"}...HEAD\``,
    "is the change under review.",
  ]
    .filter((line, i, all) => !(line === "" && all[i - 1] === ""))
    .join("\n")
    .trim();
}

/** `owner/repo` from a remote URL, in either of the two shapes git writes. */
export function repoSlug(remoteUrl: string): string | null {
  const m =
    /github\.com[:/]+([^/]+)\/([^/]+?)(?:\.git)?$/.exec(remoteUrl.trim()) ??
    /^([^/\s]+)\/([^/\s]+)$/.exec(remoteUrl.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * The GitHub REST root.
 *
 * `GITHUB_API_URL` is set by every Actions runner and points at the Enterprise
 * Server API root on a self-hosted one. Reading it is what makes `rune pr` work
 * on GHES at all; `api.github.com` is the default nobody has to set.
 */
export function apiRoot(env: Record<string, string | undefined> = process.env): string {
  const raw = env.GITHUB_API_URL?.trim();
  if (!raw) return "https://api.github.com";
  return raw.replace(/\/+$/, "");
}

/** Title and body, from `gh` if it is authenticated, else the REST API. */
export async function fetchPr(
  repoRoot: string,
  number: number,
  env: Record<string, string | undefined> = process.env,
): Promise<PullRequest> {
  const gh = spawnSync(
    "gh",
    ["pr", "view", String(number), "--json", "number,title,body,author,baseRefName,headRefName"],
    { cwd: repoRoot, encoding: "utf8", timeout: 30_000 },
  );
  if (gh.status === 0 && gh.stdout) {
    const j = JSON.parse(gh.stdout) as {
      number: number;
      title: string;
      body: string;
      author?: { login?: string };
      baseRefName?: string;
      headRefName?: string;
    };
    return {
      number: j.number,
      title: j.title,
      body: j.body ?? "",
      author: j.author?.login,
      baseRef: j.baseRefName,
      headRef: j.headRefName,
    };
  }

  const slug = repoSlug(
    env.GITHUB_REPOSITORY ?? git(repoRoot, ["remote", "get-url", "origin"]).out,
  );
  const token = env.GH_TOKEN ?? env.GITHUB_TOKEN;
  if (!slug) throw new Error("could not work out the GitHub repository from `origin`");
  const res = await fetch(`${apiRoot(env)}/repos/${slug}/pulls/${number}`, {
    headers: {
      accept: "application/vnd.github+json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    // The same 30 s the `gh` call above gets. Without it a GitHub that accepts
    // the connection and never answers hangs `rune pr` with nothing on screen.
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(
      `GitHub said ${res.status} for ${slug}#${number}` +
        (token ? "" : " — set GITHUB_TOKEN, or authenticate `gh`"),
    );
  }
  const j = (await res.json()) as {
    number: number;
    title: string;
    body: string | null;
    user?: { login?: string };
    base?: { ref?: string };
    head?: { ref?: string };
  };
  return {
    number: j.number,
    title: j.title,
    body: j.body ?? "",
    author: j.user?.login,
    baseRef: j.base?.ref,
    headRef: j.head?.ref,
  };
}

/**
 * Fetch `refs/pull/<n>/head` and put it in its own worktree.
 *
 * `--force` on `worktree add` is deliberate: re-running `rune pr 12` after the
 * author pushed should land on the new head, and the alternative is telling a
 * person to delete a directory before a command will work.
 *
 * The head lands on a STAGING ref outside `refs/heads/` first. Fetching
 * straight onto `refs/heads/rune/pr-<n>` worked exactly once: git refuses to
 * update a branch that is checked out in any worktree, so the second
 * `rune pr 12` — the one a person runs precisely because the author pushed —
 * failed at the fetch with "refusing to fetch into branch", before any of the
 * "move it to the new head" logic below could run. A ref that is not a branch
 * is never checked out anywhere, so it always updates; the branch is then moved
 * from inside the worktree that owns it. Found by
 * `tests/integration/rune-pr.test.ts` in P10.6.
 *
 * `refs/rune/pull/<n>` rather than `refs/rune/pr-<n>`: the latter shortens to
 * the same string as `refs/heads/rune/pr-<n>`, so every `git log rune/pr-12` in
 * the worktree would warn about an ambiguous refname.
 */
export function checkoutPrWorktree(
  repoRoot: string,
  number: number,
  remote = "origin",
): { path: string; branch: string } {
  const branch = `rune/pr-${number}`;
  const staging = `refs/rune/pull/${number}`;
  const dir = join(repoRoot, ".rune", "worktrees", `pr-${number}`);

  const fetched = git(repoRoot, ["fetch", remote, `+refs/pull/${number}/head:${staging}`]);
  if (!fetched.ok) {
    throw new Error(`could not fetch pull/${number}/head from ${remote}: ${fetched.err}`);
  }

  mkdirSync(join(repoRoot, ".rune", "worktrees"), { recursive: true });
  if (existsSync(dir)) {
    // Already there from a previous run: move it to the new head rather than
    // refusing, and rather than silently reviewing a stale diff. `-B` from
    // inside the worktree is the only way to move a branch that worktree has
    // checked out.
    const moved = git(dir, ["checkout", "--force", "-B", branch, staging]);
    if (!moved.ok) throw new Error(`could not update ${dir}: ${moved.err}`);
    return { path: dir, branch };
  }
  const pointed = git(repoRoot, ["branch", "--force", branch, staging]);
  if (!pointed.ok) throw new Error(`could not point ${branch} at the head: ${pointed.err}`);
  const added = git(repoRoot, ["worktree", "add", "--force", dir, branch]);
  if (!added.ok) throw new Error(`git worktree add failed: ${added.err || added.out}`);
  return { path: dir, branch };
}

/**
 * How to invoke this CLI again.
 *
 * From a source checkout that is `bun <path>/rune-cli.ts`; from the compiled
 * binary it is the binary itself, whose script path is a virtual one that does
 * not exist on disk. Getting this wrong is a spawn failure with a confusing
 * message, and only on the installed build.
 */
export function selfCommand(dir = import.meta.dir, execPath = process.execPath): string[] {
  const script = join(dir, "rune-cli.ts");
  return existsSync(script) && /(^|\/)bun$/.test(execPath) ? [execPath, script] : [execPath];
}

export async function runPr(args: string[], values: Record<string, unknown>): Promise<number> {
  const number = Number(args[0]);
  if (!Number.isInteger(number) || number <= 0) {
    say(`  ${danger("!")} usage: ${info("rune pr <number>")} ${muted("[--review] [--brief]")}`);
    return 1;
  }

  const repoRoot = typeof values.workspace === "string" ? values.workspace : process.cwd();
  if (git(repoRoot, ["rev-parse", "--is-inside-work-tree"]).out !== "true") {
    say(`  ${danger("!")} ${repoRoot} is not a git repository`);
    return 1;
  }

  let pr: PullRequest;
  try {
    pr = await fetchPr(repoRoot, number);
  } catch (err) {
    say(`  ${danger("!")} ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  let tree: { path: string; branch: string };
  try {
    tree = checkoutPrWorktree(repoRoot, number);
  } catch (err) {
    say(`  ${danger("!")} ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  const task = values.review === true ? "Review the change" : "Work on the change";
  const brief = briefFromPr(pr, task);

  say(`  ${ok("pr")} ${accent(`#${pr.number}`)} ${pr.title}`);
  say(`  ${muted(`worktree  ${tree.path}`)}`);
  say(`  ${muted(`branch    ${tree.branch}`)}`);
  say();

  if (values.brief === true) {
    // The brief alone, for piping into `rune -P` or reading before committing
    // a session to it. (`--print`/`-P` is the global headless flag and means
    // something else, so this one is `--brief`.)
    say(brief);
    return 0;
  }

  say(`  ${dim("starting a session in the worktree…")}`);
  say();
  const child = Bun.spawn(
    [
      ...selfCommand(),
      "--workspace",
      tree.path,
      ...(typeof values.gear === "string" ? ["--gear", values.gear] : []),
      ...(typeof values.model === "string" ? ["--model", values.model] : []),
      "--new",
      "-P",
      brief,
    ],
    { cwd: tree.path, stdout: "inherit", stderr: "inherit", stdin: "inherit" },
  );
  return await child.exited;
}
