import { tokenize, type Token } from "./tokens";

export interface Record {
  name: string;
  values: number[];
}

export function buildRecord(tokens: Token[]): Record {
  const name = tokens.find((token) => token.kind === "word")?.value ?? "";
  const values = tokens
    .filter((token) => token.kind === "number")
    .map((token) => Number(token.value));
  return { name, values };
}

export function buildFromLine(line: string): Record {
  return buildRecord(tokenize(line));
}
