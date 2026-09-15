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
/**
 * The one kind of string literal that is a PATH and not data: the argument of
 * a module load. `require('./src/csv')` is the strongest statement an inline
 * script makes about what it is checking; `console.log('src/csv.ts')` is a
 * word it prints. Both are literals to the parser, so relatedness needs this
 * to tell them apart.
 */
const LOADER_ARG =
  /(?:^|[^\w$.])(?:require(?:\.resolve)?|import|__import__|open|readFile|readFileSync)\s*\(\s*$|(?:^|[^\w$.])(?:from|import)\s+$/;

function stripLiterals(script: string, style: ScriptStyle, keepLoaderArgs = false): string {
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
      const inner = script.slice(i + close.length, j);
      i = j + close.length - 1;
      out += keepLoaderArgs && LOADER_ARG.test(out) ? ` ${inner} ` : '""';
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
    | /** It names only files this step never touched. */ "other_files"
    | /** It executed no test at all: a receipt, not a verdict. */ "no_tests";
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
  // A run narrowed to test NAMES is not a whole-project verdict, whatever it
  // matched: `bun test --test-name-pattern zzz` exits 0 having executed
  // nothing, and "related to every step by construction" is exactly the wrong
  // answer for it. It can still be related BY FILE, like any other check.
  if (hasSelectorWord(words)) return false;
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
  return pathTokens(command.slice(from));
}

function pathTokens(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /[A-Za-z0-9_@~+.-]*(?:[\\/][A-Za-z0-9_@~+.-]+)+|[A-Za-z0-9_@~+-]+\.[A-Za-z0-9_]{1,8}/g;
  for (const m of text.matchAll(re)) {
    const token = m[0]!;
    if (token.includes(OPAQUE) || /^-/.test(token) || seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

/**
 * The paths a command names that are the command's own SCOPE.
 *
 * `commandPaths` reads the raw text, comments and printed strings included.
 * That is right for "did this command mention a path at all"; it is wrong for
 * "what did this command measure", and relatedness asked the second question
 * with the first answer — so `node -e "// src/csv.ts⏎assert(1===1)"` and
 * `node -e "assert(1); console.log('src/csv.ts')"` closed a step about
 * `src/csv.ts` that they never exercised. `inlineCheck` already blanks that
 * text before deciding whether the script is a check at all; the nine shapes
 * it fixed simply reappeared one layer up, as scope instead of as code.
 *
 * ARGUMENTS are read raw and in full: a path handed to a program is a real
 * path even though the shell called it a string. Only an inline SCRIPT's body
 * is stripped, and there a module load (`require('./src/csv')`) survives —
 * it is the strongest thing such a script says about its subject.
 */
export function commandScopePaths(command: string): string[] {
  const chain = lastCommandChain(command);
  // Unparseable (a heredoc, an unbalanced quote): fall back to the raw
  // reading rather than inventing an empty scope for a command we cannot see.
  if (chain === null) return commandPaths(command);
  return pathTokens(chain.map(scopeWords).join(" "));
}

/**
 * Programs that RUN a script named on their command line, rather than reading
 * every file they are handed. What comes after the script is the script's own
 * argv, and the script decides whether to open any of it — usually it does not.
 */
const SCRIPT_HOSTS = new Set([
  "node",
  "bun",
  "deno",
  "tsx",
  "ts-node",
  "ruby",
  "perl",
  "php",
  "lua",
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "osascript",
]);

const isScriptHost = (program: string) =>
  SCRIPT_HOSTS.has(program) || /^python[23]?(?:\.\d+)?$/.test(program);

/** A word that could name a file: it has a directory part or a source extension. */
const pathShaped = (word: string) =>
  !word.startsWith("-") &&
  !word.includes(OPAQUE) &&
  (word.includes("/") || SOURCE_FILE_RE.test(base(word)));

/**
 * The ENTRY SCRIPT a command runs, per command in the chain — the one file a
 * script host is certain to open.
 *
 * V6 finding 2: relatedness credited any argv token, so `node check.mjs
 * header.csv` settled a criterion about `header.csv` that `check.mjs` never
 * opens, and the run reported `met` with the file byte-identical. Appending a
 * filename is one word of ordinary model output; it reopened V-5B's F1.
 *
 * Entry position is read conservatively: only when the FIRST non-flag word is
 * path-shaped, so `bun test a.test.ts b.test.ts`, `python3 -m pytest x.py y.py`
 * and `node --test dir` keep every target they name — those programs read
 * their arguments. A command whose executable is itself a path (`./verify.sh`)
 * names its entry there.
 */
export function commandProgramPaths(command: string): string[] {
  const chain = lastCommandChain(command);
  if (chain === null) return [];
  const out: string[] = [];
  for (const words of chain) {
    const entry = entryScriptOf(words);
    if (entry && !out.includes(entry)) out.push(entry);
  }
  return out;
}

function entryScriptOf(input: string[], depth = 0): string | null {
  if (depth > 4) return null;
  const words = [...input];
  while (ASSIGNMENT.test(words[0] ?? "")) words.shift();
  const executable = words.shift() ?? "";
  const program = base(executable);
  if (!program || executable.includes(OPAQUE)) return null;
  if (program === "env" || program === "command") return entryScriptOf(words, depth + 1);
  // `./verify.sh` — the program IS the script.
  if (!isScriptHost(program) && pathShaped(executable)) return executable;
  if (!isScriptHost(program)) return null;
  const inlineFlags = /^python/.test(program) ? INLINE_FLAGS.python : INLINE_FLAGS[program];
  const first = words.find((w) => !w.startsWith("-"));
  if (first === undefined || inlineFlags?.includes(words[0] ?? "")) return null;
  return pathShaped(first) ? first : null;
}

/** One command's words as SCOPE text: arguments verbatim, inline scripts stripped. */
function scopeWords(input: string[], depth = 0): string {
  if (depth > 4) return "";
  const words = [...input];
  while (ASSIGNMENT.test(words[0] ?? "")) words.shift();
  const executable = words.shift() ?? "";
  const program = base(executable);
  // The leading executable is not a path the command named — the same rule
  // `commandPaths` applies by skipping the first word.
  if (program === "env" || program === "command") return scopeWords(words, depth + 1);
  const inlineFlags = /^python/.test(program) ? INLINE_FLAGS.python : INLINE_FLAGS[program];
  const entry = entryScriptOf(input, depth);
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    if (inlineFlags?.includes(word) && typeof words[i + 1] === "string") {
      out.push(stripLiterals(words[i + 1]!, SCRIPT_STYLE(program), true));
      i++;
      continue;
    }
    out.push(word);
    // Everything after the entry script is the SCRIPT'S argv, and the script
    // decides whether to open any of it. A path it ignores is not a path the
    // command measured, so it stops here.
    if (entry !== null && word === entry) break;
  }
  return out.join(" ");
}

/**
 * Whether two path spellings name the same file. Deliberately exact — the
 * same path however it was written — with none of `pathsCorrespond`'s module
 * fuzz, because this answers "did the run WRITE this program", and a wrong
 * yes there refuses an honest citation.
 */
export function samePathToken(a: string, b: string): boolean {
  const norm = (raw: string) => raw.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  const x = norm(a),
    y = norm(b);
  if (!x || !y) return false;
  return x === y || x.endsWith(`/${y}`) || y.endsWith(`/${x}`);
}

// ─── A check that ran nothing ───

/**
 * Flags that narrow a test run to names, which can select NOTHING.
 *
 * `--filter` is deliberately absent: a monorepo filter (`turbo run test
 * --filter=app`) narrows to a package and still runs that package's suite.
 */
const SELECTOR_FLAGS = new Set([
  "-t",
  "--test-name-pattern",
  "--testNamePattern",
  "--test-name",
  "-k",
  "--grep",
  "--fgrep",
  "--skip",
  "-run",
]);

const hasSelectorWord = (words: string[]): boolean =>
  words.some((w) => SELECTOR_FLAGS.has(w.split("=", 1)[0]!));

/**
 * A command that could not have failed: `true`, `:`, `exit 0` (V6 finding 25).
 *
 * The false-positive defence catches RUNNER-shaped no-ops — "0 tests", a
 * missing runner — by reading their output. These print nothing at all, so
 * there is nothing to read, and an acceptance command of `true` derived
 * `satisfied` on the strength of an exit code nothing produced.
 */
export function isNoOpCommand(command: string): boolean {
  const chain = lastCommandChain(command);
  if (chain === null || chain.length === 0) return false;
  return chain.every((input) => {
    const words = [...input];
    while (ASSIGNMENT.test(words[0] ?? "")) words.shift();
    const program = base(words.shift() ?? "");
    if (program === "true" || program === ":") return true;
    if (program === "exit") return words.length === 0 || words[0] === "0";
    return false;
  });
}

/** Whether a check's command narrows it by test NAME, so it may match nothing. */
export function hasTestSelector(command: string): boolean {
  const chain = lastCommandChain(command);
  return chain !== null && chain.some(hasSelectorWord);
}

/** Runner summaries that say, in the runner's own words, that nothing ran. */
const ZERO_TESTS = [
  /(?:^|\n)\s*0 pass\b/i, // bun
  /\bno tests? (?:found|ran|were found|to run|matched)\b/i,
  /\bTests:\s+0 total\b/i, // jest
  /\btest result: ok\. 0 passed; 0 failed/i, // cargo
  /\bcollected 0 items\b/i, // pytest
  /\bno tests ran\b/i, // pytest
  /\[no test files\]/i, // go test
  /\b0 (?:tests?|examples?|specs?|assertions?)(?:,| ) ?(?:ran|run|executed|passed|completed)\b/i,
];

/** The same runners saying that something DID run. */
const SOME_TESTS = [
  /(?:^|\n)\s*[1-9]\d* pass\b/i,
  /\bTests:\s+(?:\d+ \w+, )*[1-9]\d* total\b/i,
  /\btest result: \w+\. [1-9]\d* passed/i,
  /\b[1-9]\d* (?:passed|failed|tests?|examples?|specs?)\b/i,
  /\bran [1-9]\d* tests?\b/i,
  /\bcollected [1-9]\d* items?\b/i,
];

/** The text a check produced: the shell's JSON streams if that is what it is. */
function checkOutputText(output: string | undefined): string {
  if (!output) return "";
  try {
    const parsed = JSON.parse(output) as Record<string, unknown>;
    const streams = [parsed.stdout, parsed.stderr].filter(
      (s): s is string => typeof s === "string",
    );
    if (streams.length > 0) return streams.join("\n");
  } catch {
    // Not the shell's shape — read it as plain text.
  }
  return output;
}

/**
 * Whether a check executed no tests at all — an execution receipt, not a
 * verdict, and never enough to close a step.
 *
 * `bun test --test-name-pattern zzz`, `cargo test -- --skip everything` and
 * `pytest -k zzz` all exit 0 having run nothing, and all three answer TRUE to
 * `isVerificationCommand` AND to `projectLevelCheck` — so relatedness, the one
 * thing standing between an empty run and a closed step, was related to every
 * step by construction. The runner's own summary settles it where there is
 * one; where there is not, only a run narrowed by a test-NAME selector is
 * assumed to have run nothing, because that is the only shape that silently
 * selects the empty set. A plain `bun test` with unreadable output keeps its
 * verdict.
 */
export function ranZeroTests(command: string, output: string | undefined): boolean {
  const text = checkOutputText(output);
  if (ZERO_TESTS.some((re) => re.test(text))) return true;
  if (SOME_TESTS.some((re) => re.test(text))) return false;
  return hasTestSelector(command);
}

/** A runner that reports its assertion count, and the count itself. */
const RAN_TESTS = /(?:^|\n)Ran \d+ tests? across \d+ files?\./;
const ASSERTION_COUNT = /(?:^|\n)\s*(\d+) expect\(\) calls/;

/**
 * Whether a runner collected tests, ran them green, and ASSERTED NOTHING.
 *
 * The second half of "the runner measured nothing" (V7 finding 9), and the
 * half `ranZeroTests` cannot see: `test("it works", () => {})` collects,
 * passes, and exits 0. The model wrote exactly that file, ran it, cited it for
 * a criterion naming no file, and the criterion derived `satisfied` at rung
 * `observed` with the product byte-identical to HEAD.
 *
 * Read off the runner's OWN assertion count rather than off the test's source,
 * because the source is not what ran. Bun prints ` N expect() calls` when N is
 * positive and omits the line entirely when it is zero, so a run that says it
 * ran tests and does not say it asserted anything asserted nothing. Scoped to
 * that vocabulary on purpose: a runner that never reports assertions (pytest,
 * cargo) prints no `Ran N tests across` line either and is not judged here —
 * this refuses to guess, exactly as `ranZeroTests` refuses to guess about a
 * `bun test` whose output it cannot read.
 */
export function assertedNothing(output: string | undefined): boolean {
  const text = checkOutputText(output);
  if (!RAN_TESTS.test(text)) return false;
  const stated = ASSERTION_COUNT.exec(text);
  return stated === null || Number(stated[1]) === 0;
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
  // A path in a comment or a printed string is a path the command NAMED (so
  // this is not "names_nothing") but not a path it MEASURED, so it cannot
  // buy the correspondence that closes a step.
  const scope = commandScopePaths(command);
  for (const file of touched) {
    if (scope.some((p) => pathsCorrespond(p, file)))
      return { related: true, reason: "file", match: file };
  }
  return { related: false, reason: "other_files" };
}
