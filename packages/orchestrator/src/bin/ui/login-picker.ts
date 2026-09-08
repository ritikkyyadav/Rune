// --- /login -- pure data for the three-step connect flow ---
//
// What this replaces: /providers, /keys and /status -- three commands that
// exposed the plumbing and none that answered the only question a new user
// actually has, which is "how do I connect this thing?". Someone who has just
// installed Rune knows they pay for ChatGPT; they do not know that the provider
// is called "codex", that it authenticates by OAuth, or that a "provider" and a
// "key" are different screens.
//
// So the flow asks what they have, not what the system is called:
//
//   Level 1 | route     -- Subscription | API key | Offline | Web search
//   Level 2 | target    -- the real product names, arrow keys, enter
//   Level 3 | the target's own auth strategy runs (OAuth, key, URL, probe)
//
// Two rosters feed it. Model providers (PROVIDER_PRESETS) are the intelligence;
// search engines (SEARCH_PROVIDER_PRESETS) are the eyes -- what web_search and
// /research query. They connect the same way and read back on the same status
// line, which is the whole reason the second roster lives here and not on a
// separate screen.
//
// Everything here is pure (no readline, no network, no engine): the TUI feeds
// it credential state and renders the rows it returns, so every level is
// unit-testable.

import {
  PROVIDER_PRESETS,
  SEARCH_PROVIDER_PRESETS,
  CUSTOM_PROVIDER_ID,
  accountLoginLabel,
  getProviderDescriptor,
  getPreset,
  getSearchPreset,
  searchPresetsByRank,
  type AuthMethod,
} from "@rune/shared";

export type LoginRoute = "subscription" | "api_key" | "offline" | "search";

export interface RouteChoice {
  id: LoginRoute;
  label: string;
  hint: string;
}

/** Keyed, non-local model providers -- the API-key route's row count. */
function keyedProviderCount(): number {
  return PROVIDER_PRESETS.filter((p) => {
    const d = getProviderDescriptor(p.id);
    return !!d && !p.local && d.auth.includes("api_key");
  }).length;
}

/**
 * The first question, in the user's terms. "Subscription" leads because it is
 * the case the old surface served worst: someone paying for ChatGPT or Claude
 * had no way in that mentioned either product by name. "Web search" is last:
 * it is the one thing here that is not a model, and it reads as the answer to
 * "how do I let it look things up?".
 */
export function routeChoices(): RouteChoice[] {
  const more = Math.max(0, keyedProviderCount() - 4);
  return [
    {
      id: "subscription",
      label: "Subscription",
      hint: "you already pay for ChatGPT or Claude",
    },
    {
      id: "api_key",
      label: "API key",
      hint: `paste a key from OpenAI, Anthropic, Google, Mistral and ${more} more`,
    },
    {
      id: "offline",
      label: "Offline",
      hint: "Ollama, LM Studio, vLLM or llama.cpp on this machine",
    },
    {
      id: "search",
      label: "Web search",
      hint: "give the agent an engine: Tavily, Exa, Brave, Serper...",
    },
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
  /** Which roster the target belongs to; the TUI runs a different last step for each. */
  kind: "model" | "search";
}

/**
 * Product names, not provider ids. "codex" is an implementation detail of the
 * ChatGPT backend and means nothing to the person who pays for ChatGPT.
 */
const SUBSCRIPTION_LABELS: Record<string, string> = {
  codex: "ChatGPT Plus / Pro",
  anthropic: "Claude Pro / Max",
  openrouter: "OpenRouter account",
};

const SUBSCRIPTION_HINTS: Record<string, string> = {
  codex: "sign in with ChatGPT - no API key needed",
  anthropic: "sign in with Claude - no API key needed",
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
  /** Targets with a stored credential (or, for engines, any usable one), for the "connected" mark. */
  connected?: (providerId: string) => boolean;
}

/** The things you can connect on one route, in the order worth reading. */
export function loginTargets(route: LoginRoute, opts: LoginTargetOpts = {}): LoginTarget[] {
  const isConnected = opts.connected ?? (() => false);
  const out: LoginTarget[] = [];

  if (route === "search") {
    for (const p of searchPresetsByRank()) {
      out.push({
        providerId: p.id,
        label: p.label,
        hint: p.hint,
        // A keyless engine has nothing to authenticate; a self-hosted one is
        // "connected" by URL, like a local runtime. Both run the local step.
        method: p.envVar ? "api_key" : "local",
        connected: p.keyless ? true : isConnected(p.id),
        kind: "search",
      });
    }
    return out;
  }

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
        kind: "model",
      });
    } else if (route === "api_key") {
      if (preset.local || !auth.includes("api_key")) continue;
      out.push({
        providerId: preset.id,
        label: descriptor.label,
        // The wider roster carries a one-line pitch; the frontier labs need
        // none, and for them the env var is the more useful thing to say.
        hint: preset.tagline
          ? `${preset.tagline} | ${preset.envVar ?? "paste a key"}`
          : preset.envVar
            ? `paste a key, or set ${preset.envVar}`
            : "paste a key",
        method: "api_key",
        connected: isConnected(preset.id),
        kind: "model",
      });
    } else {
      if (!preset.local) continue;
      out.push({
        providerId: preset.id,
        label: descriptor.label,
        hint: OFFLINE_HINTS[preset.id] ?? "a local endpoint on this machine",
        method: "local",
        connected: true, // local runtimes need no credential to be usable
        kind: "model",
      });
    }
  }

  if (route === "offline") {
    // Anything else that speaks the OpenAI wire on this machine -- LM Studio,
    // vLLM, llama.cpp's server, LiteLLM -- is the one custom endpoint slot.
    // It was reachable only as `/keys custom <url> <model> <key>`, an
    // incantation nobody who just installed Rune could guess.
    out.push({
      providerId: CUSTOM_PROVIDER_ID,
      label: "Other local server",
      hint: "LM Studio, vLLM, llama.cpp: any OpenAI-compatible URL",
      method: "local",
      connected: isConnected(CUSTOM_PROVIDER_ID),
      kind: "model",
    });
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
  const order = ["codex", "anthropic", "openrouter"];
  const i = order.indexOf(id);
  return i === -1 ? order.length : i;
}

/** A target's name as the status line says it: the product for subscriptions, the label otherwise. */
function nameOf(id: string): string {
  return SUBSCRIPTION_LABELS[id] ?? getPreset(id)?.label ?? getSearchPreset(id)?.label ?? id;
}

/**
 * One line telling someone what they are already connected to, so /login is
 * also the answer to "what am I signed in with?" -- the question /status and
 * /providers used to split between them. Search engines are named on the same
 * line, after the models: one glance answers both halves of "can it think, and
 * can it look things up?".
 */
export function connectedSummary(connected: string[], search: string[] = []): string {
  const models = connected.map(nameOf);
  const engines = search.map(nameOf);
  if (models.length === 0 && engines.length === 0) return "nothing connected yet";
  const parts: string[] = [];
  parts.push(models.length ? `connected: ${models.join(", ")}` : "no model connected yet");
  if (engines.length) parts.push(`search: ${engines.join(", ")}`);
  return parts.join(" | ");
}

/** The search engines that count as "connected" for the status line: keyed or URL ones, never the built-in. */
export function connectableSearchIds(): string[] {
  return SEARCH_PROVIDER_PRESETS.filter((p) => !p.keyless).map((p) => p.id);
}
