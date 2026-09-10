/**
 * Recognize executed checks, not words in their output or arguments. This is
 * evidence bookkeeping, not a shell safety classifier or a test-quality gate.
 * Unsupported shell syntax stays unclassified rather than inventing a pass.
 */
export function isVerificationCommand(command: string): boolean {
  const chain = lastCommandChain(command);
  return chain !== null && chain.some((words) => checks(words));
}

/**
 * The final list's && chain is covered by the shell's exit status. Earlier
 * lists, pipes, background jobs and || fallbacks can mask a failing check.
 * Keep quotes/escapes intact as words; redirection targets are not arguments.
 * Substitutions remain opaque arguments; their commands cannot establish a
 * check because the outer command can discard their exit status.
 */
function lastCommandChain(command: string): string[][] | null {
  let last: string[][] = [],
    chain: string[][] = [],
    words: string[] = [];
  let word = "",
    started = false,
    redirect = false,
    needsCommand = false;
  let quote: "'" | '"' | null = null;
  const flushWord = () => {
    if (!started) return;
    if (!redirect) words.push(word);
    redirect = false;
    word = "";
    started = false;
  };
  const flushCommand = () => {
    flushWord();
    if (words.length) {
      chain.push(words);
      words = [];
      needsCommand = false;
    }
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!,
      next = command[i + 1];
    if (quote === "'") {
      if (ch === quote) quote = null;
      else word += ch;
      continue;
    }
    if (ch === "`" || (ch === "$" && next === "(")) {
      const end = substitutionEnd(command, i);
      if (end === null) return null;
      word += OPAQUE;
      started = true;
      i = end;
      continue;
    }
    if (ch === "\\") {
      if (next === undefined) return null;
      if (quote && !["$", "`", '"', "\\", "\n"].includes(next)) word += ch;
      else {
        if (next !== "\n") {
          word += next;
          started = true;
        }
        i++;
      }
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else word += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
      continue;
    }
    if (ch === "#" && !started) {
      while (i + 1 < command.length && command[i + 1] !== "\n") i++;
      continue;
    }
    if (ch === "\n" || ch === ";") {
      flushCommand();
      if (redirect || needsCommand) return null;
      if (chain.length) last = chain;
      chain = [];
      continue;
    }
    if (/\s/.test(ch)) {
      flushWord();
      continue;
    }
    if (ch === "&" && next === "&") {
      flushCommand();
      if (redirect || needsCommand || !chain.length) return null;
      needsCommand = true;
      i++;
      continue;
    }
    if (ch === ">" || ch === "<") {
      if (redirect || (ch === "<" && next === "<")) return null;
      // A directly attached decimal word is a file descriptor (2>err).
      if (started && /^\d+$/.test(word)) {
        word = "";
        started = false;
      }
      flushWord();
      redirect = true;
      if (next === ">" || next === "&") i++;
      continue;
    }
    if (/[|&(){}]/.test(ch)) return null;
    word += ch;
    started = true;
  }
  if (quote) return null;
  flushCommand();
  if (redirect || needsCommand) return null;
  return chain.length ? chain : last;
}

const OPAQUE = "\0";

/** Find a balanced substitution without treating its operators as outer
 * shell operators. No expansion is executed or inspected for check names.
 * Heredocs and case syntax need a shell parser and stay unclassified. */
function substitutionEnd(source: string, start: number, depth = 0): number | null {
  if (depth > 32) return null;
  const backtick = source[start] === "`";
  let parens = 1;
  let quote: "'" | '"' | null = null;
  for (let i = start + (backtick ? 1 : 2); i < source.length; i++) {
    const ch = source[i]!,
      next = source[i + 1];
    if (backtick) {
      if (ch === "\\") i++;
      else if (ch === "`") return i;
      continue;
    }
    if (quote === "'") {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "`" || (ch === "$" && next === "(")) {
      const end = substitutionEnd(source, i, depth + 1);
      if (end === null) return null;
      i = end;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "#" && /[\s;(]/.test(source[i - 1] ?? "")) {
      while (i + 1 < source.length && source[i + 1] !== "\n") i++;
    } else if (
      (ch === "<" && next === "<") ||
      (source.startsWith("case", i) && /^\s?$/.test(source[i + 4] ?? ""))
    ) {
      return null;
    } else if (ch === "(") parens++;
    else if (ch === ")" && --parens === 0) return i;
  }
  return null;
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const CHECK_NAME =
  /(?:^|[-_.:])(?:tests?|spec|check|verify|validate|smoke|lint|typecheck|build|selftest)(?:$|[-_.:])/i;
const namedCheck = (name: string) => !name.includes(OPAQUE) && CHECK_NAME.test(name);
const PROGRAMS = new Set([
  "test",
  "[",
  "pytest",
  "pytest-3",
  "vitest",
  "jest",
  "mocha",
  "ava",
  "eslint",
  "mypy",
  "pyright",
  "tsc",
  "check",
  "typecheck",
  "lint",
  "build",
]);
const HELP = new Set(["--help", "-h", "--version", "-V", "--list-tests", "--listTests"]);
const OPTION_VALUE = new Set([
  "--cwd",
  "-C",
  "--dir",
  "--prefix",
  "--filter",
  "--workspace",
  "-w",
  "--project",
  "-r",
  "--require",
  "--import",
  "--loader",
  "--env-file",
  "-W",
  "-X",
]);
const NO_VALUE = new Set([
  "--silent",
  "--quiet",
  "-q",
  "--offline",
  "--no-install",
  "--yes",
  "-y",
  "--frozen-lockfile",
  "--experimental-strip-types",
  "--enable-source-maps",
  "--no-warnings",
  "-I",
  "-B",
  "-u",
]);

/**
 * Inline scripts are the executed program itself. One counts as a check when
 * it can fail on its own verdict: an assertion, an expectation, a non-zero
 * exit or a raise. A script that only prints is not one, whatever it prints.
 * (Pilot J, 2026-09-10: a `bun -e '…assert.deepEqual(…)…'` probe passed and
 * was cited twice, and "nothing on record" cost three completions.)
 */
const INLINE_FLAGS: Record<string, readonly string[]> = {
  node: ["-e", "--eval", "-p", "--print"],
  bun: ["-e", "--eval", "-p", "--print"],
  deno: ["eval"],
  python: ["-c"],
  ruby: ["-e"],
  perl: ["-e"],
};
const INLINE_ASSERTION =
  /\bassert\b|\bexpect\s*\(|process\.exit\s*\(\s*[1-9]|sys\.exit\s*\(\s*[1-9]|\braise\b|\bthrow\b/;
/** An exit code the script sets itself. A catch can swallow a throw; it cannot
 *  swallow this. */
const INLINE_NONZERO_EXIT =
  /(?:process\.|sys\.)?\bexit\s*\(\s*[1-9]|\bexitCode\s*=\s*[1-9]|\bexit\s+[1-9]/;
/** Constructs that can absorb the only failure signal the script has. */
const INLINE_SWALLOW = /\bcatch\b|\bexcept\b|\brescue\b/;

/** Which comment and literal syntax the inline script is written in. */
type ScriptStyle = "c" | "hash";
const SCRIPT_STYLE = (program: string): ScriptStyle =>
  /^(?:node|bun|deno)$/.test(program) ? "c" : "hash";

/**
 * Blank out comments and string literals, so the assertion test reads CODE.
 *
 * `node -e 'console.log("assert ok")'` printed a word; `# assert the file
 * parses` is a note to a reader. Both were classified as executed checks
 * (measured 2026-09-10, Lane A: eight shapes of this, plus a swallowed
 * assertion). Anything unterminated ends the scan — the remainder is then
 * data by definition, and being wrong in that direction only costs a rung.
 */
function stripLiterals(script: string, style: ScriptStyle): string {
  let out = "";
  for (let i = 0; i < script.length; i++) {
    const ch = script[i]!,
      next = script[i + 1];
    if (style === "c" && ch === "/" && next === "/") {
      while (i < script.length && script[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (style === "c" && ch === "/" && next === "*") {
      const end = script.indexOf("*/", i + 2);
      if (end < 0) return out;
      i = end + 1;
      out += " ";
      continue;
    }
    if (style === "hash" && ch === "#") {
      while (i < script.length && script[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (ch === '"' || ch === "'" || (style === "c" && ch === "`")) {
      // Python's triple quote spans lines and holds anything, docstrings
      // included; every other literal here closes on its own delimiter.
      const close = style === "hash" && script.startsWith(ch.repeat(3), i) ? ch.repeat(3) : ch;
      let j = i + close.length;
      for (; j < script.length; j++) {
        if (script[j] === "\\") {
          j++;
          continue;
        }
        if (script.startsWith(close, j)) break;
      }
      if (j >= script.length) return out;
      i = j + close.length - 1;
      out += '""';
      continue;
    }
    out += ch;
  }
  return out;
}

function inlineCheck(script: string, style: ScriptStyle): boolean {
  if (script.includes(OPAQUE)) return false;
  const code = stripLiterals(script, style);
  if (!INLINE_ASSERTION.test(code)) return false;
  // A verdict a `catch` can absorb is not one the exit code carries, unless
  // the script sets that code itself.
  if (INLINE_SWALLOW.test(code) && !INLINE_NONZERO_EXIT.test(code)) return false;
  return true;
}

const base = (path: string) =>
  path
    .split(/[\\/]/)
    .at(-1)!
    .replace(/\.(?:exe|cmd)$/i, "");
function checkScript(path: string): boolean {
  if (path.includes(OPAQUE)) return false;
  return (
    (/\.(?:[cm]?jsx?|tsx?|py|sh|bash|zsh|ps1|rb|pl)$/i.test(path) &&
      (CHECK_NAME.test(base(path)) || /(?:^|[\\/])(?:tests?|__tests__|spec)[\\/]/i.test(path))) ||
    (/^[.\\/]/.test(path) && CHECK_NAME.test(base(path)))
  );
}

/** Skip only options whose arity is known. A filename passed to --require is
 * not the entry point; an unknown option is not permission to guess one. */
function positional(words: string[]): string[] {
  let i = 0;
  while (i < words.length) {
    const word = words[i]!;
    if (word === "--") return words.slice(i + 1);
    if (!word.startsWith("-")) return words.slice(i);
    const key = word.split("=", 1)[0]!;
    if (OPTION_VALUE.has(key)) i += word.includes("=") ? 1 : 2;
    else if (NO_VALUE.has(word)) i++;
    else return [];
  }
  return [];
}

function checks(input: string[], depth = 0): boolean {
  if (depth > 4) return false;
  const words = [...input];
  while (ASSIGNMENT.test(words[0] ?? "")) words.shift();
  const executable = words.shift() ?? "";
  const program = base(executable);
  if (!program || executable.includes(OPAQUE) || words.some((w) => HELP.has(w))) return false;
  if (program === "env" || program === "command") return checks(words, depth + 1);
  if (PROGRAMS.has(program)) return true;
  if (program === "git") return words[0] === "diff" && words.includes("--check");
  if (program === "playwright") return words[0] === "test";
  if (program === "cypress") return words[0] === "run";
  if (program === "ruff" || program === "biome") return words[0] === "check";
  if (program === "cargo") {
    if (words[0]?.startsWith("+")) words.shift();
    return (
      /^(test|check|clippy|build)$/.test(words[0] ?? "") ||
      (words[0] === "fmt" && words.includes("--check"))
    );
  }
  if (["go", "swift", "dotnet"].includes(program)) return /^(test|build|vet)$/.test(words[0] ?? "");
  if (program === "xcodebuild")
    return words.length === 0 || words.some((w) => /^(test|build|analyze|archive)$/.test(w));
  if (program === "turbo" || program === "nx") {
    // Monorepo task runners name the check as their task: `turbo typecheck`,
    // `turbo run lint --filter=app`, `nx test app`. `turbo dev` is not one.
    const args = positional(words);
    return namedCheck((args[0] === "run" ? args[1] : args[0]) ?? "");
  }
  if (/^(gradle[w]?|mvn[w]?|make)$/.test(program)) return namedCheck(positional(words)[0] ?? "");
  if (/^(npm|pnpm|yarn|bun|npx|bunx)$/.test(program)) {
    const args = positional(words),
      head = args[0] ?? "";
    if (["exec", "x", "dlx"].includes(head)) return checks(positional(args.slice(1)), depth + 1);
    if (program === "npx" || program === "bunx") return checks(args, depth + 1);
    if (head === "run" || head === "run-script")
      return namedCheck(args[1] ?? "") || checkScript(args[1] ?? "");
    if (namedCheck(head)) return true;
    if (program !== "bun") return false;
  }
  if (/^(python[23]?(?:\.\d+)?|node|bun|deno|bash|sh|zsh|ruby|perl)$/.test(program)) {
    const inlineFlags = /^python/.test(program) ? INLINE_FLAGS.python : INLINE_FLAGS[program];
    if (inlineFlags?.includes(words[0] ?? "") && typeof words[1] === "string") {
      return inlineCheck(words[1], SCRIPT_STYLE(program));
    }
    if (/^python/.test(program) && words[0] === "-m")
      return /^(pytest|unittest|mypy)$/.test(words[1] ?? "");
    if (program === "node" && (words[0] === "--test" || words[0] === "--check")) return true;
    if (program === "deno" && (words[0] === "test" || words[0] === "check")) return true;
    return checkScript(positional(words)[0] ?? "");
  }
  return checkScript(executable) && /[\\/]/.test(executable);
}

// ─── Relatedness: does this check speak to the step it would close? ───

/**
 * The command normalization the citation ledger identifies a command by.
 *
 * Lives here, beside the classifier, because relatedness compares a command
 * a STEP declares against a command the model RAN, and both have to be
 * spelled the same way for that comparison to mean anything. `brief.ts`
 * re-exports it, so every existing importer is unaffected.
 */
export function normalizeCommand(command: string): string {
  // Substitution syntax stays verbatim. Collapsing whitespace inside a quote
  // or a nested program can make a citation identify a different command.
  if (command.includes("$(") || command.includes("`")) return command.trim();
  let out = "",
    quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (ch === "\\" && quote !== "'") {
      out += ch + (command[++i] ?? "");
    } else if (quote) {
      out += ch;
      if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      out += ch;
    } else if (ch === " " || ch === "\t") {
      if (!out.endsWith(" ")) out += " ";
    } else out += ch;
  }
  return out.trim();
}

/** Why a check does or does not speak to the step it was run under. */
export type CheckRelation = {
  /** True when the check may be attributed to the step and close it. */
  related: boolean;
  reason:
    | /** A project-wide runner: the whole suite, typecheck, lint, build. */ "project"
    | /** The step's own wording names this command. */ "declared"
    | /** It names a file the step touched, or that file's test. */ "file"
    | /** The step touched nothing, so there is no file set to judge against. */ "unscoped"
    | /** It names no path at all and is not project-wide. */ "names_nothing"
    | /** It names only files this step never touched. */ "other_files";
  /** The touched file the command matched, for the record. */
  match?: string;
};

/**
 * Programs that run a project's OWN checks rather than one file's. A check
 * from this list is related to any change or verify step by nature: it
 * compiles, lints or exercises the whole project, so whatever the step
 * touched is inside what it just measured.
 *
 * `node`, `python` and the other script hosts are deliberately absent — they
 * run whatever file (or inline script) they are handed, which is exactly the
 * case relatedness has to judge by the file.
 */
const PROJECT_RUNNERS = new Set([
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "bunx",
  "npx",
  "turbo",
  "nx",
  "make",
  "gradle",
  "gradlew",
  "mvn",
  "mvnw",
  "cargo",
  "go",
  "dotnet",
  "swift",
  "xcodebuild",
  "tsc",
  "eslint",
  "biome",
  "ruff",
  "mypy",
  "pyright",
  "pytest",
  "pytest-3",
  "jest",
  "vitest",
  "mocha",
  "ava",
  "playwright",
  "cypress",
  "deno",
  "test",
  "check",
  "lint",
  "typecheck",
  "build",
  "selftest",
]);

/** A source or test FILE named on the command line: the thing that narrows a
 *  project runner to one target. A directory (`pytest tests/`) does not — a
 *  whole tree is still a suite — and neither does a config file. */
const SOURCE_FILE_RE =
  /\.(?:[cm]?[jt]sx?|py|rb|pl|go|rs|java|kt|kts|swift|sh|bash|zsh|ps1|php|ex|exs|erl|scala|c|cc|cpp|cxx|h|hpp|cs|dart|lua|r|jl|vue|svelte)$/i;
const fileTarget = (word: string) =>
  !word.startsWith("-") && !word.includes(OPAQUE) && SOURCE_FILE_RE.test(base(word));

/**
 * Whether the command runs the project's checks rather than a named file's.
 *
 * Built on the same parse the classifier uses, so `A=1 env bun test` and
 * `cd x && cargo test` are read the way the shell reads them. A command that
 * is not a check at all is never project-level.
 */
export function projectLevelCheck(command: string): boolean {
  const chain = lastCommandChain(command);
  if (chain === null) return false;
  return chain.some((words) => checks(words) && projectLevelWords(words));
}

function projectLevelWords(input: string[], depth = 0): boolean {
  if (depth > 4) return false;
  const words = [...input];
  while (ASSIGNMENT.test(words[0] ?? "")) words.shift();
  const executable = words.shift() ?? "";
  const program = base(executable);
  if (!program || executable.includes(OPAQUE)) return false;
  if (program === "env" || program === "command") return projectLevelWords(words, depth + 1);
  // An inline script IS the program. Whatever it asserts, it asserts about
  // what its own text names — never about the project as a whole.
  const inlineFlags = /^python/.test(program) ? INLINE_FLAGS.python : INLINE_FLAGS[program];
  if (inlineFlags?.includes(words[0] ?? "")) return false;
  const runner = /^python[23]?(?:\.\d+)?$/.test(program)
    ? words[0] === "-m"
    : PROJECT_RUNNERS.has(program) ||
      (program === "node" && (words[0] === "--test" || words[0] === "--check"));
  if (!runner) return false;
  return !words.some(fileTarget);
}

/**
 * Every path the command NAMES, wherever it names it — as an argument, or
 * inside an inline script's own text (`node -e "require('./src/csv')"`).
 *
 * Read off the raw command on purpose. The shell parse folds an inline script
 * into one word, and the module a script imports is the strongest signal
 * there is about what that script is checking. The leading executable is
 * skipped so `python3.11 -c '…'` does not look like it named a file.
 */
export function commandPaths(command: string): string[] {
  const from = command.search(/\s/);
  if (from < 0) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /[A-Za-z0-9_@~+.-]*(?:[\\/][A-Za-z0-9_@~+.-]+)+|[A-Za-z0-9_@~+-]+\.[A-Za-z0-9_]{1,8}/g;
  for (const m of command.slice(from).matchAll(re)) {
    const token = m[0]!;
    if (token.includes(OPAQUE) || /^-/.test(token) || seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

type PathParts = {
  norm: string;
  segs: string[];
  /** The basename with its extension, and any `.test`/`_test`, removed. */
  core: string;
  dirs: string[];
};

function pathParts(raw: string): PathParts {
  const norm = raw.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  const segs = norm.split("/").filter((s) => s && s !== "." && s !== "..");
  const baseName = segs.at(-1) ?? "";
  const ext = /\.[^.]+$/.exec(baseName)?.[0] ?? "";
  const stem = ext ? baseName.slice(0, -ext.length) : baseName;
  const core = stem
    .replace(/[._-](?:test|spec)$/i, "")
    .replace(/^(?:test|spec)[._-]/i, "")
    .toLowerCase();
  return { norm, segs, core, dirs: segs.slice(0, -1).map((s) => s.toLowerCase()) };
}

/**
 * Whether a path the command named is about a file the step touched.
 *
 * Three correspondences, in the order a person would check them: the same
 * file however it was spelled; the same module by name, which is what
 * `src/csv.ts` ↔ `tests/unit/csv.test.ts` ↔ `require('./src/csv')` all are;
 * and a directory that holds the file or is named after it.
 */
function pathsCorrespond(named: string, touched: string): boolean {
  const a = pathParts(named),
    b = pathParts(touched);
  if (!a.norm || !b.norm) return false;
  if (a.norm === b.norm || a.norm.endsWith(`/${b.norm}`) || b.norm.endsWith(`/${a.norm}`))
    return true;
  if (a.core && a.core === b.core) return true;
  if (b.norm.startsWith(`${a.norm}/`)) return true;
  if (a.core && b.dirs.includes(a.core)) return true;
  if (b.core && a.dirs.includes(b.core)) return true;
  return false;
}

/** Whether the step's own wording names this command — in backticks, or
 *  verbatim in prose. The step said what would prove it; this ran it. */
function declaredCheckMatches(content: string, command: string): boolean {
  const cmd = normalizeCommand(command);
  if (!cmd) return false;
  for (const m of content.matchAll(/`([^`]+)`/g)) {
    const declared = normalizeCommand(m[1]!);
    if (!declared) continue;
    if (declared === cmd || cmd.startsWith(`${declared} `) || cmd.includes(declared)) return true;
  }
  return normalizeCommand(content).includes(cmd);
}

/**
 * Does this check speak to the step it would close?
 *
 * The defect this answers (Lane A, remaining defect 1): the loop attributed a
 * `bash` check to whichever step was in progress, so `python3 -c "assert
 * True"` run while a step was open closed that step. The harness's own step
 * check has always been scoped to `touchedFiles`; a model-run one was not.
 *
 * Conservative by construction, because the common path has to stay cheap:
 * a project-wide check is related to everything, a step that declared its
 * check keeps it, and a step that has touched NO files has no file set to
 * judge against, so it keeps today's behaviour. Only a check that names
 * nothing, or names only files this step never touched, is set aside — and
 * "set aside" means it still counts as executed everywhere else, it just
 * does not close the step.
 */
export function checkRelatedness(
  command: string,
  step: { content?: string; touched?: readonly string[] },
): CheckRelation {
  if (projectLevelCheck(command)) return { related: true, reason: "project" };
  if (step.content && declaredCheckMatches(step.content, command))
    return { related: true, reason: "declared" };
  const named = commandPaths(command);
  if (named.length === 0) return { related: false, reason: "names_nothing" };
  const touched = (step.touched ?? []).filter(Boolean);
  if (touched.length === 0) return { related: true, reason: "unscoped" };
  for (const file of touched) {
    if (named.some((p) => pathsCorrespond(p, file)))
      return { related: true, reason: "file", match: file };
  }
  return { related: false, reason: "other_files" };
}
