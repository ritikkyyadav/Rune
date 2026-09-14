export function slidingMax(values: number[], size: number): number[] {
  const out: number[] = [];
  for (let i = 0; i <= values.length - size; i++) {
    let best = values[i]!;
    for (let j = i + 1; j < i + size; j++) if (values[j]! > best) best = values[j]!;
    out.push(best);
  }
  return out;
}
