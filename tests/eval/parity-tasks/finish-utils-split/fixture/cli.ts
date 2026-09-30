/**
 * expenses: totals by category from a CSV of expenses.
 *
 *   bun cli.ts expenses.csv         a table of totals
 *   bun cli.ts --csv expenses.csv   the totals as CSV
 */

import { readFileSync } from "node:fs";

import { totalsCsv } from "./csv";
import { parseExpenses, totalsByCategory } from "./expenses";
import { report } from "./report";
import { formatAmount } from "./utils";

export interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

export function main(args: string[]): Result {
  const csv = args.includes("--csv");
  const file = args.find((arg) => !arg.startsWith("--"));
  if (!file) return { code: 2, stdout: "", stderr: "usage: bun cli.ts [--csv] <expenses.csv>\n" };
  const expenses = parseExpenses(readFileSync(file, "utf8"));
  const totals = totalsByCategory(expenses);
  if (csv) return { code: 0, stdout: totalsCsv(totals), stderr: "" };
  const spent = expenses.reduce((sum, expense) => sum + expense.cents, 0);
  const summary = `${expenses.length} expenses, ${formatAmount(spent)} in all\n`;
  return { code: 0, stdout: `${report(totals)}${summary}`, stderr: "" };
}

if (import.meta.main) {
  const result = main(process.argv.slice(2));
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exit(result.code);
}
