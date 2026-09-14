export function parseCsv(input: string): string[][] {
  if (input === "") return [];
  return input.split("\n").map((row) => row.split(","));
}
