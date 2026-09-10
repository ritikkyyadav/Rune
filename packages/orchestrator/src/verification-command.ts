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
    if (/^python/.test(program) && words[0] === "-m")
      return /^(pytest|unittest|mypy)$/.test(words[1] ?? "");
    if (program === "node" && (words[0] === "--test" || words[0] === "--check")) return true;
    if (program === "deno" && (words[0] === "test" || words[0] === "check")) return true;
    return checkScript(positional(words)[0] ?? "");
  }
  return checkScript(executable) && /[\\/]/.test(executable);
}
