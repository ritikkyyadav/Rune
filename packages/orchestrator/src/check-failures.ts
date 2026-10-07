// ─── Which tests are failing, and whether they already were ───
//
// "The check exited 1" cannot tell a run that broke a test from a run that
// worked beside one that was already broken. Both were sent the same sentence
// — "Automated verification failed after your changes" — and both bought a
// repair turn; the second then spent it on a suite it had never touched.
//
// Telling them apart takes two things, and this file is both:
//
//   1. the failing tests BY NAME, read from the runner's own report
//   2. a rule for when a named failure may be called pre-existing
//
// The rule is narrow on purpose. A failure is pre-existing only when the same
// test, in a file nobody has changed, failed with the same assertion on the
// tree the run started from. Not "the check was red before" (an exit code),
// and not "that file was already failing" (a substring): one old failure in a
// file does not excuse a new one beside it. Anything the report does not name
// — a file that would not load, a count that does not add up — is not
// attributed at all.
//
// Bun's report only, for now: it is the runner the corpus is graded with, and
// a second parser written from memory is how a vocabulary goes wrong. Output
// that is not recognisably Bun's is `null`, and `null` means "unknown".
//
// Pure: strings in, records out.

export interface FailingTest {
  /** The test file, as the runner printed it — relative to where it ran. */
  file: string;
  /** The describe path and the test's name, as the runner prints them. */
  name: string;
  /**
   * The assertion's own words (`error:`, `Expected:`, `Received:`, a timeout
   * note). The same test failing for a DIFFERENT reason is a different
   * failure, and this is how that is seen.
   */
  signature: string;
}

export interface ParsedTestRun {
  failing: FailingTest[];
  /** The runner's own totals, from its summary. */
  pass: number;
  fail: number;
  /** Failures that are not a test: a file that would not load. */
  errors: number;
}

const HEADER = /^bun test v\d/m;
const FILE = /^(\S(?:.*\S)?\.[cm]?[jt]sx?):$/;
const FAIL = /^\(fail\) (.+?)(?: \[\d+(?:\.\d+)?ms\])?$/;
const OTHER_VERDICT = /^\((?:pass|skip|todo)\) /;
const TIMEOUT_NOTE = /^\s*\^ (this test timed out after .+)$/;
const WORDS = /^\s*(error:.*|Expected:.*|Received:.*)$/;
const total = (output: string, word: string): number | null => {
  const m = output.match(new RegExp(`^\\s*(\\d+) ${word}$`, "m"));
  return m ? Number(m[1]) : null;
};

/**
 * Bun's test report → the failing tests and the totals.
 *
 * `roots` are directories the run happened under; they are cut out of the
 * assertion text so the same failure reads the same from two checkouts.
 *
 * `null` when this is not Bun's report, or it has no summary to check the
 * parse against. A report that parses but whose totals disagree with what was
 * found is returned as it is — `attributable` is the question to ask of it.
 */
export function parseBunTestRun(
  output: string,
  roots: readonly string[] = [],
): ParsedTestRun | null {
  if (!HEADER.test(output)) return null;
  const fail = total(output, "fail");
  const pass = total(output, "pass");
  if (fail === null || pass === null) return null;
  const errors = total(output, "errors?") ?? 0;

  const strip = (text: string): string => {
    let out = text;
    // Longest first, so `/private/var/x` is not left as `/private` + nothing.
    for (const root of [...roots].sort((a, b) => b.length - a.length)) {
      if (root) out = out.split(root).join("");
    }
    return out;
  };

  const failing: FailingTest[] = [];
  let file = "";
  let words: string[] = [];
  const lines = output.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.replace(/\r$/, "");
    const header = line.match(FILE);
    if (header) {
      file = header[1]!.replace(/^(?:\.\/)+/, "");
      words = [];
      continue;
    }
    const failed = line.match(FAIL);
    if (failed) {
      const after = lines[i + 1]?.match(TIMEOUT_NOTE);
      failing.push({
        file,
        name: failed[1]!,
        signature: strip([...words, ...(after ? [after[1]!] : [])].join("\n")),
      });
      words = [];
      continue;
    }
    if (OTHER_VERDICT.test(line)) {
      words = [];
      continue;
    }
    const said = line.match(WORDS);
    if (said) words.push(said[1]!.trim());
  }
  return { failing, pass, fail, errors };
}

/**
 * Whether every red thing in this run is a test the report names.
 *
 * False when a file would not load (`errors`), or when the summary counts more
 * failures than there are `(fail)` lines. Either way something failed that has
 * no name, and a failure with no name cannot be matched against anything.
 */
export function attributable(run: ParsedTestRun): boolean {
  return run.errors === 0 && run.failing.length === run.fail && run.failing.every((t) => t.file);
}

export interface Attribution {
  /** Failing now, and failing identically on the tree the run started from. */
  existing: FailingTest[];
  /** Failing now, and not accounted for by anything that was failing then. */
  introduced: FailingTest[];
}

/**
 * Which of the failures now were already there.
 *
 * `changed` is every test file — as the runner names them — that differs from
 * the baseline. A failing test in one of those is the run's, whatever the
 * baseline said: the witness is not the witness it was.
 *
 * Matched as a multiset on (file, name, assertion), so two tests with one name
 * are not both excused by a single old failure.
 */
export function attributeFailures(
  now: ParsedTestRun,
  baseline: ParsedTestRun,
  changed: ReadonlySet<string>,
): Attribution {
  const key = (t: FailingTest): string => `${t.file}\0${t.name}\0${t.signature}`;
  const before = new Map<string, number>();
  for (const t of baseline.failing) before.set(key(t), (before.get(key(t)) ?? 0) + 1);

  const existing: FailingTest[] = [];
  const introduced: FailingTest[] = [];
  for (const t of now.failing) {
    const left = before.get(key(t)) ?? 0;
    if (!changed.has(t.file) && left > 0) {
      before.set(key(t), left - 1);
      existing.push(t);
    } else {
      introduced.push(t);
    }
  }
  return { existing, introduced };
}

/** `file :: describe > name` — how a failing test is written down. */
export function testLabel(t: FailingTest): string {
  return `${t.file} :: ${t.name}`;
}
