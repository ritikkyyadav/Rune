import { groupBy } from "./utils";

export interface Expense {
  date: string;
  category: string;
  cents: number;
}

/** Parse `date,category,amount` lines, the amount in dollars ("12.50"). A header is skipped. */
export function parseExpenses(text: string): Expense[] {
  const expenses: Expense[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim() || (index === 0 && line.startsWith("date,"))) return;
    const [date = "", category = "", amount = ""] = line.split(",");
    const cents = Math.round(Number(amount) * 100);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !category || !amount.trim() || !Number.isFinite(cents))
      throw new Error(`line ${index + 1}: expected date,category,amount`);
    expenses.push({ date, category, cents });
  });
  return expenses;
}

/** Total cents per category, the largest first, ties by name. */
export function totalsByCategory(expenses: Expense[]): Map<string, number> {
  const totals = [...groupBy(expenses, (expense) => expense.category)].map(
    ([category, items]) => [category, items.reduce((sum, item) => sum + item.cents, 0)] as const,
  );
  totals.sort(([a, x], [b, y]) => y - x || a.localeCompare(b));
  return new Map(totals);
}
