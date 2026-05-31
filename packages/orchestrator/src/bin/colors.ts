// ─── Colors (compat shim) ───
// The palette now lives in ui/theme.ts — brand-exact L'Atlas in 24-bit truecolor
// with an ANSI-256 fallback. Re-exported here so existing `./colors` imports keep
// working (bold, dim, paper, vermillion, brass, cyanotype, green, draftLine,
// stripAnsi) and gain the new semantic tokens (text, muted, faint, accent, info,
// warn, ok, line).

export * from "./ui/theme";
