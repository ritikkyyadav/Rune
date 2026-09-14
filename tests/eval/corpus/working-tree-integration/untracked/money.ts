export function parseMinor(text: string): number {
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(text)) throw new Error("invalid amount");
  const [whole, fraction = ""] = text.replace(/^-/, "").split(".");
  const value = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(value)) throw new Error("unsafe amount");
  return text.startsWith("-") ? -value : value;
}
