const esc = (code: string) => `\x1b[${code}m`;
const reset = esc("0");

function color(code: string, value: string): string {
  return `${esc(code)}${value}${reset}`;
}

export const bold = (value: string): string => color("1", value);
export const dim = (value: string): string => color("38;5;244", value);
export const paper = (value: string): string => color("38;5;255", value);
export const vermillion = (value: string): string => color("38;5;166", value);
export const brass = (value: string): string => color("38;5;179", value);
export const cyanotype = (value: string): string => color("38;5;31", value);
export const green = (value: string): string => color("38;5;71", value);
export const draftLine = (value: string): string => color("38;5;240", value);

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

export function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, "");
}
