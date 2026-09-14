import { tokenize } from "./tokens";

export interface Record {
  name: string;
  values: number[];
}

export function buildRecord(tokens: string[]): Record {
  const name = tokens.find((token) => !/^-?\d+(?:\.\d+)?$/.test(token)) ?? "";
  const values = tokens.filter((token) => /^-?\d+(?:\.\d+)?$/.test(token)).map(Number);
  return { name, values };
}

export function buildFromLine(line: string): Record {
  return buildRecord(tokenize(line));
}
