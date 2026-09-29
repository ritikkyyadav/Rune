/**
 * logstats: count the lines of a log file by level.
 *
 *   bun cli.ts [--level LEVEL] <file>
 */

import { readFileSync } from "node:fs";

import { LEVELS, formatTable, isLevel, summarize, type Level } from "./stats";

export const HELP = `Usage: bun cli.ts [options] <file>

Count the lines of a log file by level.

Options:
  --level <LEVEL>  Only count lines at LEVEL (${LEVELS.join(", ")})
  -h, --help       Show this help and exit
`;

export interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run the CLI on `args` without touching the process; the tests call this. */
export function main(args: string[]): Result {
  let level: Level | undefined;
  let file: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "-h" || arg === "--help") return { code: 0, stdout: HELP, stderr: "" };
    if (arg === "--level") {
      const value = args[++i] ?? "";
      if (!isLevel(value)) return { code: 2, stdout: "", stderr: `unknown level: ${value}\n` };
      level = value;
    } else if (arg.startsWith("-")) {
      return { code: 2, stdout: "", stderr: `unknown option: ${arg}\n\n${HELP}` };
    } else if (file) {
      return { code: 2, stdout: "", stderr: `one file at a time: ${arg}\n` };
    } else {
      file = arg;
    }
  }
  if (!file) return { code: 2, stdout: "", stderr: HELP };
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return { code: 1, stdout: "", stderr: `cannot read ${file}\n` };
  }
  return { code: 0, stdout: `${formatTable(summarize(text, level))}\n`, stderr: "" };
}

if (import.meta.main) {
  const result = main(process.argv.slice(2));
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exit(result.code);
}
