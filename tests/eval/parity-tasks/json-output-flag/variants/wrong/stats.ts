/** Counting log lines by level. */

export const LEVELS = ["DEBUG", "INFO", "WARN", "ERROR"] as const;

export type Level = (typeof LEVELS)[number];

export interface Summary {
  /** Lines counted: every line with a recognised level, after any level filter. */
  total: number;
  levels: Record<Level, number>;
}

/** A timestamp, then the level: `2026-09-29T10:00:00Z INFO server started`. */
const LINE = /^\S+\s+(DEBUG|INFO|WARN|ERROR)\b/;

export function isLevel(value: string): value is Level {
  return (LEVELS as readonly string[]).includes(value);
}

/** Count a log's lines by level. Lines without a recognised level are skipped. */
export function summarize(text: string, only?: Level): Summary {
  const levels: Record<Level, number> = { DEBUG: 0, INFO: 0, WARN: 0, ERROR: 0 };
  let total = 0;
  for (const line of text.split(/\r?\n/)) {
    const match = LINE.exec(line);
    if (!match) continue;
    const level = match[1] as Level;
    if (only && level !== only) continue;
    levels[level] += 1;
    total += 1;
  }
  return { total, levels };
}

/** The summary as an aligned two-column table: one row per level, then the total. */
export function formatTable(summary: Summary): string {
  const row = (label: string, count: number) => `${label.padEnd(6)}${String(count).padStart(6)}`;
  const rows = LEVELS.map((level) => row(level, summary.levels[level]));
  return [...rows, row("TOTAL", summary.total)].join("\n");
}
