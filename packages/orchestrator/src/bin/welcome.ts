// ─── Rune Welcome Screen (compat shim) ───
// The banner now lives in ui/banner.ts. These aliases keep existing imports stable.

export { renderBanner as renderWelcome } from "./ui/banner";
export type { BannerOptions as WelcomeOptions } from "./ui/banner";
