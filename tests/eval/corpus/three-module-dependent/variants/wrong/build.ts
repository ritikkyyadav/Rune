import { tokenize, type Token } from "./tokens";

export interface Record {
  name: string;
  values: number[];
}

const NUMERIC = /^-?\d+(?:\.\d+)?$/;

export function buildRecord(tokens: Token[]): Record {
  const name = tokens.find((token) => !NUMERIC.test(token.value))?.value ?? "";
  const values = tokens
    .filter((token) => NUMERIC.test(token.value))
    .map((token) => Number(token.value));
  return { name, values };
}

export function buildFromLine(line: string): Record {
  return buildRecord(tokenize(line));
}
