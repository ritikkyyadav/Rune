// ─── Mechanical shell classification for Auto mode ───
//
// Auto mode had a "safe" tier for read_file and grep and no equivalent for
// the shell, so `ls -la`, `cat package.json` and `git status` all rated
// medium, all ran under the supervised tier, and every one of them cost a
// background reviewer call. On a rate-capped reviewer that call is what made
// the mode feel slow: the supervisor competed with the acting agent for the
// same quota, and it flagged `npm audit` and `npm run test:e2e` as suspicious
// after they ran.
//
// This module answers two questions with no model in the loop:
//
//   isReadOnlyShellCommand   every segment is a known read-only program, no
//                            redirection, no substitution, no sudo — it can
//                            take the safe tier: run, unsupervised, unrecorded.
//   isOrdinaryDevCommand     the day's work: builds, tests, installs, linters,
//                            local git, containers. It still runs under the
//                            supervised tier, but when the supervisor is set
//                            to watch only "unusual" work it is not screened.
//
// Both are precision lists, not heuristics. A false "read-only" would let a
// write skip supervision, so anything the list does not name is not read-only;
// a false "ordinary" only skips a screen the mechanical breakers already ran
// ahead of, so that list can afford to be broader. Users extend the read-only
// set with `[permissions.autoMode] safeCommands`, and the tests are where the
// commands of a real workflow get pinned.

import { commandPatternMatches, splitShellSegments, stripLeadingAssignments } from "@rune/shared";

/** Programs whose only effect is their output. */
const READ_ONLY_PROGRAMS = new Set([
  "ls",
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "wc",
  "pwd",
  "echo",
  "printf",
  "true",
  "false",
  "test",
  "[",
  "cd",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "ag",
  "ack",
  "fd",
  "tree",
  "stat",
  "file",
  "du",
  "df",
  "which",
  "whereis",
  "type",
  "basename",
  "dirname",
  "realpath",
  "readlink",
  "sort",
  "uniq",
  "cut",
  "tr",
  "column",
  "nl",
  "tac",
  "rev",
  "paste",
  "join",
  "comm",
  "diff",
  "cmp",
  "md5",
  "md5sum",
  "shasum",
  "sha1sum",
  "sha256sum",
  "cksum",
  "date",
  "cal",
  "uname",
  "hostname",
  "whoami",
  "id",
  "uptime",
  "arch",
  "nproc",
  "sw_vers",
  "sysctl",
  "ps",
  "pgrep",
  "lsof",
  "jq",
  "yq",
  "xxd",
  "hexdump",
  "od",
  "strings",
  "awk",
  "sed",
  "seq",
  "yes",
  "sleep",
  "man",
  "tldr",
  "bat",
  "exa",
  "eza",
  "lsb_release",
]);

/** `git <subcommand>` forms that only read the repository. */
const GIT_READ_SUBCOMMANDS = new Set([
  "status",
  "log",
  "diff",
  "show",
  "rev-parse",
  "rev-list",
  "ls-files",
  "ls-tree",
  "blame",
  "describe",
  "shortlog",
  "reflog",
  "cat-file",
  "count-objects",
  "check-ignore",
  "grep",
  "name-rev",
  "merge-base",
  "for-each-ref",
  "show-ref",
  "symbolic-ref",
  "var",
  "version",
  "help",
]);

/** Per-tool read-only subcommands for the toolchains a shell reaches for. */
const TOOL_READ_SUBCOMMANDS: Record<string, Set<string>> = {
  cargo: new Set(["metadata", "tree", "version", "--version", "-V", "--list", "search"]),
  npm: new Set([
    "ls",
    "list",
    "ll",
    "la",
    "root",
    "prefix",
    "bin",
    "why",
    "explain",
    "--version",
    "-v",
  ]),
  pnpm: new Set(["ls", "list", "why", "root", "bin", "--version", "-v"]),
  yarn: new Set(["list", "why", "bin", "--version", "-v"]),
  bun: new Set(["--version", "-v", "--revision"]),
  go: new Set(["version", "env", "list"]),
  docker: new Set([
    "ps",
    "images",
    "logs",
    "inspect",
    "version",
    "info",
    "stats",
    "top",
    "port",
    "diff",
    "history",
  ]),
  kubectl: new Set([
    "get",
    "describe",
    "logs",
    "version",
    "explain",
    "api-resources",
    "top",
    "cluster-info",
  ]),
  adb: new Set(["devices", "version", "get-state", "get-serialno"]),
  brew: new Set([
    "list",
    "info",
    "--version",
    "-v",
    "config",
    "doctor",
    "outdated",
    "deps",
    "search",
  ]),
  python: new Set(["--version", "-V"]),
  python3: new Set(["--version", "-V"]),
  node: new Set(["--version", "-v"]),
  rustc: new Set(["--version", "-V"]),
  rustup: new Set(["show", "--version", "-V", "which"]),
  gh: new Set(["--version", "version"]),
  make: new Set(["--version", "-v"]),
  tsc: new Set(["--version", "-v"]),
};

/** Only-flag invocations that any program answers without side effects. */
const VERSION_OR_HELP_ARGS = new Set([
  "--version",
  "-version",
  "-V",
  "-v",
  "--help",
  "-h",
  "-help",
  "help",
]);

/**
 * Redirection that only routes standard streams to nowhere or to each other
 * is harmless; anything else that contains `>` writes a file.
 */
const HARMLESS_REDIRECT_RE =
  /(?:\d?>&\d|&>\s*\/dev\/null|\d?>\s*\/dev\/null|>\s*\/dev\/stderr|>\s*\/dev\/stdout)/g;

const SUBSTITUTION_RE = /\$\(|`|<\(|>\(/;
const BACKGROUND_OR_ELEVATION_RE =
  /(?:^|\s)(?:sudo|doas|su|exec|eval|source|xargs|nohup|watch)\b|(?:^|[^&>])&(?:\s|$)|^\.\s/;

/** Read-only if EVERY segment is read-only. Empty commands are not. */
export function isReadOnlyShellCommand(
  command: string,
  safeCommands: readonly string[] = [],
): boolean {
  const segments = splitShellSegments(command);
  if (segments.length === 0) return false;
  return segments.every((segment) => isReadOnlySegment(segment, safeCommands));
}

function isReadOnlySegment(rawSegment: string, safeCommands: readonly string[]): boolean {
  const segment = rawSegment.trim();
  if (!segment) return false;
  if (SUBSTITUTION_RE.test(segment)) return false;
  if (BACKGROUND_OR_ELEVATION_RE.test(segment)) return false;
  if (segment.replace(HARMLESS_REDIRECT_RE, "").includes(">")) return false;
  if (safeCommands.some((p) => commandPatternMatches(p, segment))) return true;
  const words = tokenize(stripLeadingAssignments(segment));
  if (words.length === 0) return false;
  const program = words[0]!.replace(/^.*\//, "");
  const args = words.slice(1);
  if (args.length > 0 && args.every((a) => VERSION_OR_HELP_ARGS.has(a))) return true;
  if (program === "git") return isReadOnlyGit(args);
  if (program === "find")
    return !args.some((a) => /^-(?:delete|exec|execdir|ok|okdir|fprint\w*|fls)$/.test(a));
  if (program === "sed") return !args.some((a) => /^-[a-zA-Z]*i|^--in-place/.test(a));
  if (program === "awk" || program === "gawk")
    return !args.some((a) => a === "-i" || a.startsWith("--in-place"));
  const subcommands = TOOL_READ_SUBCOMMANDS[program];
  if (subcommands) return args.length > 0 && subcommands.has(args[0]!);
  return READ_ONLY_PROGRAMS.has(program);
}

function isReadOnlyGit(args: string[]): boolean {
  const positional = args.filter((a) => !a.startsWith("-"));
  const sub = positional[0];
  if (!sub) return false;
  if (GIT_READ_SUBCOMMANDS.has(sub)) return true;
  switch (sub) {
    case "branch":
      // Listing forms only: a positional after `branch` creates one; -d/-D/-m/-M change refs.
      return (
        positional.length === 1 &&
        !args.some(
          (a) =>
            /^-(?:d|D|m|M|c|C|u|f|--delete|--move|--copy|--set-upstream-to|--unset-upstream|--force)$/.test(
              a,
            ) || /^--(?:delete|move|copy|set-upstream-to|unset-upstream|force)$/.test(a),
        )
      );
    case "tag":
      return (
        positional.length === 1 &&
        !args.some(
          (a) =>
            /^-[a-zA-Z]*[adfmsu]/.test(a) || /^--(?:delete|force|annotate|sign|message)$/.test(a),
        ) &&
        (args.length === 1 ||
          args.some(
            (a) =>
              a === "-l" ||
              a === "--list" ||
              a.startsWith("--contains") ||
              a.startsWith("--points-at") ||
              a.startsWith("--sort"),
          ))
      );
    case "stash":
      return positional[1] === "list" || positional[1] === "show";
    case "worktree":
      return positional[1] === "list";
    case "remote":
      return positional.length === 1 || positional[1] === "show" || positional[1] === "get-url";
    case "config":
      return args.some(
        (a) =>
          a === "--get" ||
          a === "--get-all" ||
          a === "--list" ||
          a === "-l" ||
          a === "--get-regexp",
      );
    default:
      return false;
  }
}

// ── Ordinary development work ──

/**
 * The build-and-check tools of a JavaScript workspace, named once so the bare
 * invocation (`tsc --noEmit`) and the package-runner one (`npx tsc --noEmit`)
 * cannot drift apart.
 */
const DEV_TOOLS =
  "tsc|eslint|prettier|biome|oxlint|stylelint|vitest|jest|mocha|ava|tap|karma|cypress|" +
  "playwright|turbo|nx|lerna|rollup|vite|webpack|esbuild|parcel|next|nuxt|astro|remix|" +
  "storybook|tailwindcss|postcss|sass|shellcheck|hadolint|yamllint|markdownlint|" +
  "commitlint|husky|lint-staged";

const ORDINARY_PATTERNS: RegExp[] = [
  /^(?:npm|pnpm|yarn|bun)\s+(?:install|i|ci|add|remove|rm|uninstall|update|upgrade|test|t|run|run-script|build|lint|typecheck|check|format|fmt|dev|start|stop|restart|watch|clean|generate|gen|coverage|bench|preview|serve|storybook|prepare|migrate|seed|audit|dedupe|prune|outdated|ls|list|why|init|pack|version|link|rebuild|cache|pm|docs|doctor)\b/,
  // `yarn <script>`, `pnpm <script>`, `bun <script>` run a package.json
  // script without `run`. The excluded verbs fetch and execute code from
  // outside the project (dlx/x/exec/create/npx) or publish it.
  /^(?:pnpm|yarn|bun)\s+(?!publish\b|dlx\b|x\b|exec\b|create\b|npx\b|link\b)[\w:.-]+(?:\s|$)/,
  /^(?:pip3?|uv|poetry|pipenv|conda|pipx)\s+(?:install|uninstall|sync|run|lock|add|remove|update|list|show|freeze|check|build|venv|pip)\b/,
  /^(?:pytest|py\.test|tox|nox|coverage|ruff|black|isort|flake8|mypy|pyright|pylint|bandit)\b/,
  /^python3?(?:\s+-m\s+(?:pytest|unittest|venv|pip|build|http\.server|json\.tool|mypy|black|ruff|compileall|py_compile)\b|\s+-[cu]\s|\s+\S+\.py\b)/,
  // Leading flags are allowed before the script: `node --check web/src/app.js`
  // is a syntax check, and requiring the file to be the FIRST argument sent it
  // to the supervisor as unrecognized work.
  /^(?:node|bun|deno|tsx|ts-node)\s+(?:-[\w-]+(?:=\S+)?\s+)*(?:-e\s|--eval\s|-p\s|run\s|\S+\.(?:m?[jt]sx?|cjs)\b)/,
  /^cargo\s+(?:build|b|test|t|check|c|clippy|fmt|run|r|bench|doc|clean|update|fetch|add|remove|rm|tree|metadata|install\s+--path|generate-lockfile|nextest)\b/,
  /^(?:rustc|rustfmt|rustup\s+(?:show|default|update|target|component|toolchain))\b/,
  /^go\s+(?:build|test|vet|run|mod|fmt|generate|get|install|list|env|version|tool|clean|work)\b/,
  /^(?:gofmt|goimports|golangci-lint|staticcheck)\b/,
  /^(?:make|cmake|ninja|meson|bazel|buck2?|gradle|gradlew|\.\/gradlew|mvn|mvnw|\.\/mvnw|ant|sbt|lein|mix|rebar3|xcodebuild|xcrun|swift|dotnet|msbuild|bundle|rake|rails|composer|php|artisan|flutter|dart|expo|eas|fastlane|pod)\b/,
  new RegExp(String.raw`^(?:${DEV_TOOLS})\b`),
  /^git\s+(?:add|commit|checkout|switch|restore|merge|rebase(?!\s+-i\b|\s+--interactive\b)|cherry-pick|stash|branch|tag|reset(?!\s+--hard\b)|fetch|pull|init|mv|rm|clean|worktree|submodule|apply|am|revert|bisect|notes|format-patch|diff|log|status|show|remote|config)\b/,
  /^docker\s+(?:build|buildx|compose|ps|images|logs|run|exec|create|stop|start|restart|kill|rm|rmi|pull|inspect|version|info|cp|tag|load|save|network|volume\s+(?:ls|create|inspect)|stats|top)\b/,
  /^(?:docker-compose|podman|colima|kind|minikube|helm\s+(?:template|lint|dependency|list|status|show|version))\b/,
  /^(?:mkdir|touch|cp|mv|rm|rmdir|ln|chmod|chown|tar|zip|unzip|gzip|gunzip|bzip2|xz|zstd|patch|install|rsync)\b/,
  /^(?:adb|emulator|avdmanager|sdkmanager|xcrun\s+simctl|ios-deploy|idb)\b/,
  /^(?:curl|wget|http|https|xh)\b.*(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)/,
  /^(?:sleep|wait|timeout|time|env|printenv|export|set|unset|alias|source|\.)\b/,
  /^(?:sqlite3|psql|mysql|redis-cli|mongosh)\b/,
  /^(?:\.\/|\.\.\/|scripts\/|bin\/)\S+/,
  // A package runner in front of a tool this list already names. `pnpm dlx`
  // and friends are excluded above because they fetch and execute code from
  // outside the project — but `npx playwright test` and `bun x tsc --version`
  // are the same build step the bare binary would be, and the supervisor was
  // screening both. Only the named tools qualify; `npx some-package` does not.
  new RegExp(
    String.raw`^(?:npx|bunx|pnpm\s+dlx|yarn\s+dlx|bun\s+x|npm\s+exec\s+--)\s+` +
      String.raw`(?:(?:-y|--yes|--no|--no-install|--package\s+\S+|-p\s+\S+)\s+)*(?:${DEV_TOOLS})\b`,
  ),
  // Reading a forge through its CLI: `gh pr view`, `gh run list`. A
  // destructive verb anywhere in the command already rates the whole thing
  // high (isRemoteMutation), and `gh release create` / `gh gist create` are
  // publications, so neither ever reaches this line.
  /^(?:gh|glab)\s+(?:pr|mr|issue|run|repo|project|release|workflow|label|milestone|cache|codespace|extension)\s+(?:view|list|status|checks|diff|watch|download)\b/,
  /^(?:gh|glab)\s+(?:status|search|version)\b/,
  // Enumerating cloud resources: `aws s3 ls`, `aws ec2 describe-instances`,
  // `gcloud compute instances list`. `get` is deliberately NOT a verb here —
  // `get-secret-value`, `get-parameter`, `get-session-token` are all reads of
  // a credential, and `isSecretBearing` below refuses the rest of that family.
  /^(?:aws|gcloud|az|doctl)\s+[\w-]+(?:\s+[\w-]+)?\s+(?:describe|describe-[\w-]+|list|list-[\w-]+|show|ls)\b/,
  // A long-running local process that IS the dev loop: an ASGI/WSGI server, a
  // watcher, a task runner. Binding past loopback is a mechanical breaker of
  // its own (`beyond-loopback-bind`), so the address is already answered for.
  /^(?:uvicorn|gunicorn|hypercorn|daphne|waitress-serve|flask|celery|nodemon|pm2|concurrently|http-server|live-server|serve|air|watchexec|entr|just|mise|direnv|honcho|foreman|overmind)\b/,
];

/**
 * True when every segment is either read-only or recognized ordinary
 * development work. Patterns are anchored to a segment's first word so an
 * unusual program later in a pipeline still counts as unusual.
 */
export function isOrdinaryDevCommand(
  command: string,
  safeCommands: readonly string[] = [],
): boolean {
  const segments = splitShellSegments(command);
  if (segments.length === 0) return false;
  return segments.every((segment) => {
    if (isReadOnlySegment(segment, safeCommands)) return true;
    if (SUBSTITUTION_RE.test(segment) && /\$\((?:curl|wget)\b/.test(segment)) return false;
    const stripped = stripLeadingAssignments(segment.trim());
    // A command that names a secret store is never ordinary, whatever else it
    // looks like. `az keyvault secret show` reads as an enumeration and is a
    // credential read; the pattern list below cannot tell them apart, so the
    // noun does.
    if (SECRET_SUBJECT_RE.test(stripped)) return false;
    return ORDINARY_PATTERNS.some((re) => re.test(stripped));
  });
}

/** Nouns that mean the command is about a credential rather than a resource. */
const SECRET_SUBJECT_RE =
  /\b(?:secret|secrets|password|passwd|credential|credentials|token|keyvault|keychain|keyring|kms)\b|\bsecretsmanager\b/i;

/** Whitespace tokenizer that keeps quoted arguments whole. */
function tokenize(segment: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current) out.push(current);
  return out;
}
