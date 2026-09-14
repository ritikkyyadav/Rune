export function tokenize(line: string): string[] {
  return line.trim().split(/\s+/).filter(Boolean);
}
