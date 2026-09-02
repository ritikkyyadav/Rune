// --- /login -- pure data for the three-step connect flow ---
//
// What this replaces: /providers, /keys and /status -- three commands that
// exposed the plumbing and none that answered the only question a new user
// actually has, which is "how do I connect this thing?". Someone who has just
// installed Gear knows they pay for ChatGPT; they do not know that the provider
// is called "codex", that it authenticates by OAuth, or that a "provider" and a
// "key" are different screens.
//
// So the flow asks what they have, not what the system is called:
//
//   Level 1 | route     -- Subscription | API key | Offline
//   Level 2 | target    -- the real product names, arrow keys, enter
//   Level 3 | the provider's own auth strategy runs (OAuth, device, key, URL)
//
// Everything here is pure (no readline, no network, no engine): the TUI feeds
// it credential state and renders the rows it returns, so every level is
// unit-testable.

import {
  PROVIDER_PRESETS,
  accountLoginLabel,
  getProviderDescriptor,
  type AuthMethod,
} from "@gear/shared";

export type LoginRoute = "subscription" | "api_key" | "offline";

export interface RouteChoice {
  id: LoginRoute;
  label: string;
  hint: string;
}

/**
 * The first question, in the user's terms. "Subscription" leads because it is
 * the case the old surface served worst: someone paying for ChatGPT or Claude
 * had no way in that mentioned either product by name.
 */
export function routeChoices(): RouteChoice[] {
  return [
    {
      id: "subscription",
      label: "Subscription",
      hint: "you already pay for ChatGPT, Claude, or Copilot",
    },
    { id: "api_key", label: "API key", hint: "paste a key from OpenAI, Anthropic, Google..." },
    { id: "offline", label: "Offline", hint: "Ollama or LM Studio on this machine" },
  ];
}

export interface LoginTarget {
  providerId: string;
  /** The product's own name, as the person buying it would say it. */
  label: string;
  hint: string;
  method: AuthMethod;
  /** Already connected -- shown so the list doubles as a status readout. */
  connected: boolean;
}

/**
 * Product names, not provider ids. "codex" is an implementation detail of the
 * ChatGPT backend and means nothing to the person who pays for ChatGPT.
 */
const SUBSCRIPTION_LABELS: Record<string, string> = {
  codex: "ChatGPT Plus / Pro",
  anthropic: "Claude Pro / Max",
  copilot: "GitHub Copilot",
  openrouter: "OpenRouter account",
};

const SUBSCRIPTION_HINTS: Record<string, string> = {
  codex: "sign in with ChatGPT - no API key needed",
  anthropic: "sign in with Claude - no API key needed",
  copilot: "sign in with GitHub - device code",
  openrouter: "sign in once; OpenRouter mints the key",
};

const OFFLINE_HINTS: Record<string, string> = {
  ollama: "localhost:11434 - models you have pulled",
};

/** True for a provider whose account login IS a paid plan (not a key mint). */
function isAccountLogin(id: string, auth: AuthMethod[]): boolean {
  return (auth.includes("oauth") || auth.includes("device")) && accountLoginLabel(id) !== undefined;
}

export interface LoginTargetOpts {
  /** Providers with a stored credential, for the "connected" mark. */
  connected?: (providerId: string) => boolean;
}

/** The things you can connect on one route, in the order worth reading. */
export function loginTargets(route: LoginRoute, opts: LoginTargetOpts = {}): LoginTarget[] {
  const isConnected = opts.connected ?? (() => false);
  const out: LoginTarget[] = [];

  for (const preset of PROVIDER_PRESETS) {
    const descriptor = getProviderDescriptor(preset.id);
    if (!descriptor) continue;
    const auth = descriptor.auth;

    if (route === "subscription") {
      if (!isAccountLogin(preset.id, auth)) continue;
      out.push({
        providerId: preset.id,
        label: SUBSCRIPTION_LABELS[preset.id] ?? descriptor.label,
        hint: SUBSCRIPTION_HINTS[preset.id] ?? "sign in with your account",
        method: auth.includes("oauth") ? "oauth" : "device",
        connected: isConnected(preset.id),
      });
    } else if (route === "api_key") {
      if (preset.local || !auth.includes("api_key")) continue;
      out.push({
        providerId: preset.id,
        label: descriptor.label,
        hint: preset.envVar ? `paste a key, or set ${preset.envVar}` : "paste a key",
        method: "api_key",
        connected: isConnected(preset.id),
      });
    } else {
      if (!preset.local) continue;
      out.push({
        providerId: preset.id,
        label: descriptor.label,
        hint: OFFLINE_HINTS[preset.id] ?? "a local endpoint on this machine",
        method: "local",
        connected: true, // local runtimes need no credential to be usable
      });
    }
  }

  // Subscriptions read best in the order people are likely to hold them; the
  // key list reads best with the frontier labs first. PROVIDER_PRESETS is
  // already in that order, so only the account-login route needs a nudge: a
  // plain key mint (OpenRouter) is not a subscription and goes last.
  if (route === "subscription") {
    out.sort((a, b) => rank(a.providerId) - rank(b.providerId));
  }
  return out;
}

function rank(id: string): number {
  const order = ["codex", "anthropic", "copilot", "openrouter"];
  const i = order.indexOf(id);
  return i === -1 ? order.length : i;
}

/**
 * One line telling someone what they are already connected to, so /login is
 * also the answer to "what am I signed in with?" -- the question /status and
 * /providers used to split between them.
 */
export function connectedSummary(connected: string[]): string {
  if (connected.length === 0) return "nothing connected yet";
  const named = connected.map((id) => SUBSCRIPTION_LABELS[id] ?? id);
  return `connected: ${named.join(", ")}`;
}
