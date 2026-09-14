import { buildFromLine } from "./build";

export function report(line: string): string {
  const record = buildFromLine(line);
  const sum = record.values.reduce((total, value) => total + value, 0);
  return `${record.name}: ${sum} over ${record.values.length}`;
}
