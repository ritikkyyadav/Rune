export interface Token {
  kind: "word" | "number";
  value: string;
}

const NUMERIC = /^-?\d+(?:\.\d+)?$/;

export function tokenize(line: string): Token[] {
  return line
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((value) => ({ kind: NUMERIC.test(value) ? "number" : "word", value }) as Token);
}
