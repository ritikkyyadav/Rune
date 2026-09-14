import { buildRecord } from "./build";

export function report(line: string): string {
  // Still splitting into plain strings, as it always did.
  const record = buildRecord(line.trim().split(/\s+/).filter(Boolean) as never);
  const sum = record.values.reduce((total, value) => total + value, 0);
  return `${record.name}: ${sum} over ${record.values.length}`;
}
