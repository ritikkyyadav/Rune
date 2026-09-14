export function slidingMax(values: number[], size: number): number[] {
  if (!Number.isInteger(size) || size < 1) throw new Error("size must be a positive integer");
  const out: number[] = [];
  // TODO: the last window is still missing.
  for (let i = 0; i < values.length - size; i++) {
    let best = values[i]!;
    for (let j = i + 1; j < i + size; j++) if (values[j]! > best) best = values[j]!;
    out.push(best);
  }
  return out;
}
