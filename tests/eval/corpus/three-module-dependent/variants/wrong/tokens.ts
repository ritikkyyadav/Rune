export interface Token {
  kind: "word" | "number";
  value: string;
}

export function tokenize(line: string): Token[] {
  return line
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((value) => ({ kind: "word", value }) as Token);
}
