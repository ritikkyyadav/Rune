/**
 * `/login` -- the three-step connect flow.
 *
 * What it replaces: /providers, /keys and /status. Three commands that exposed
 * the plumbing, and none that answered the only question someone who has just
 * installed Rune actually has -- how do I connect this? A person who pays for
 * ChatGPT knows they pay for ChatGPT. They do not know the provider is called
 * "codex", that it signs in by OAuth, or why "providers" and "keys" are two
 * separate screens.
 *
 * So the flow asks what you HAVE, and names products the way you would say
 * them. These tests pin that vocabulary, because it is the whole point.
 */

import { describe, test, expect } from "bun:test";
import {
  routeChoices,
  loginTargets,
  connectedSummary,
  isFreeRoute,
} from "../../../packages/orchestrator/src/bin/ui/login-picker";
import { searchPresetsByRank } from "../../../packages/shared/src/search-providers";

const ids = (route: Parameters<typeof loginTargets>[0]) =>
  loginTargets(route).map((t) => t.providerId);
const labels = (route: Parameters<typeof loginTargets>[0]) =>
  loginTargets(route).map((t) => t.label);

describe("the first question", () => {
  test("asks what you have, in that order", () => {
    // Subscription leads because it is the case the old surface served worst;
    // web search closes because it is the one thing here that is not a model.
    expect(routeChoices().map((r) => r.id)).toEqual([
      "subscription",
      "api_key",
      "offline",
      "search",
    ]);
  });

  test("the API-key route names the free tiers first, then how wide the roster is", () => {
    const hint = routeChoices().find((r) => r.id === "api_key")!.hint;
    // Someone with no budget decides at level 1 whether this is going to cost
    // them anything, so the free routes are named before the count.
    expect(hint).toContain("free tiers first");
    expect(hint.indexOf("OpenRouter")).toBeLessThan(hint.indexOf("paid"));
    expect(hint).toMatch(/then \d+ paid hosts/);
    const more = Number(hint.match(/then (\d+) paid hosts/)![1]);
    expect(more).toBeGreaterThanOrEqual(20);
  });

  test("the offline route says it is free", () => {
    expect(routeChoices().find((r) => r.id === "offline")!.hint).toContain("free");
  });

  test("every route explains itself without jargon", () => {
    for (const r of routeChoices()) {
      expect(r.hint.length).toBeGreaterThan(0);
      expect(r.hint).not.toContain("provider");
      expect(r.hint).not.toContain("OAuth");
    }
  });
});

describe("subscriptions are named as products", () => {
  test("ChatGPT is called ChatGPT, not codex", () => {
    const list = labels("subscription");
    expect(list).toContain("ChatGPT Plus / Pro");
    expect(list).toContain("Claude Pro / Max");
    expect(list).not.toContain("GitHub Copilot"); // dropped in P8.5
    expect(list.join(" ")).not.toContain("codex");
  });

  test("the plans people are likeliest to hold come first", () => {
    expect(ids("subscription").slice(0, 2)).toEqual(["codex", "anthropic"]);
  });

  test("a plain key mint is not a subscription, so it sorts last", () => {
    // OpenRouter's OAuth just mints an API key; it is not a plan seat.
    expect(ids("subscription").at(-1)).toBe("openrouter");
  });

  test("no key-only provider leaks onto the subscription route", () => {
    // Signing in to "OpenAI" here would be a dead end: the API is key-only.
    expect(ids("subscription")).not.toContain("openai");
    expect(ids("subscription")).not.toContain("google");
  });

  test("each carries the sign-in method the strategy will actually run", () => {
    const byId = Object.fromEntries(loginTargets("subscription").map((t) => [t.providerId, t]));
    expect(byId.codex!.method).toBe("oauth");
    expect(byId.copilot).toBeUndefined(); // dropped in P8.5
  });
});

describe("the API-key route", () => {
  test("lists every keyed provider and no local ones", () => {
    const list = ids("api_key");
    for (const id of ["openai", "anthropic", "google", "groq", "xai", "deepseek"]) {
      expect({ id, listed: list.includes(id) }).toEqual({ id, listed: true });
    }
    expect(list).not.toContain("ollama");
  });

  test("carries the wider roster — the hosts OpenCode and Pi users expect", () => {
    const list = ids("api_key");
    for (const id of [
      "mistral",
      "cerebras",
      "together",
      "fireworks",
      "moonshot",
      "zai",
      "minimax",
      "alibaba",
      "nvidia",
      "huggingface",
      "github-models",
      "vercel",
    ]) {
      expect({ id, listed: list.includes(id) }).toEqual({ id, listed: true });
    }
    expect(list.length).toBeGreaterThanOrEqual(30);
  });

  test("free tiers lead the key list, then the frontier labs in roster order", () => {
    // The list used to open with four rows that all need a funded account. On
    // a machine with no budget — the ordinary case — those are the four rows
    // that cannot answer a prompt tonight.
    const list = ids("api_key");
    expect(list.slice(0, 4)).toEqual(["openrouter", "google", "ollama-turbo", "github-models"]);
    // Within each group the roster's own order survives: the sort is stable,
    // so the frontier labs still lead the paid block in their old order.
    const paid = list.filter((id) => !isFreeRoute(id));
    expect(paid.slice(0, 2)).toEqual(["anthropic", "openai"]);
  });

  test("a free route is marked in its label, and a paid one is not", () => {
    const targets = loginTargets("api_key");
    expect(targets.find((t) => t.providerId === "openrouter")!.label).toContain("free");
    expect(targets.find((t) => t.providerId === "google")!.label).toContain("free tier");
    expect(targets.find((t) => t.providerId === "anthropic")!.label).not.toContain("free");
    // Local runtimes carry it too, on the offline route.
    expect(loginTargets("offline").find((t) => t.providerId === "ollama")!.label).toContain("free");
  });

  test("names the env var, so an existing key is discoverable rather than re-typed", () => {
    const openai = loginTargets("api_key").find((t) => t.providerId === "openai");
    expect(openai?.hint).toContain("OPENAI_API_KEY");
    // A wider-roster host leads with its pitch and still names the var.
    const mistral = loginTargets("api_key").find((t) => t.providerId === "mistral");
    expect(mistral?.hint).toContain("MISTRAL_API_KEY");
    expect(mistral?.hint).toMatch(/Codestral/);
  });

  test("every target says which roster it belongs to", () => {
    for (const t of loginTargets("api_key")) expect(t.kind).toBe("model");
    for (const t of loginTargets("search")) expect(t.kind).toBe("search");
  });

  test("codex is absent — a ChatGPT plan has no API key to paste", () => {
    expect(ids("api_key")).not.toContain("codex");
  });
});

describe("the offline route", () => {
  test("is the local runtimes plus one slot for any other local server", () => {
    // `custom` is LM Studio / vLLM / llama.cpp: the OpenAI-compatible endpoint
    // that was reachable only as `/keys custom <url> <model> <key>`.
    expect(ids("offline")).toEqual(["ollama", "custom"]);
  });

  test("says where each one lives, since that is the only thing to get wrong", () => {
    const byId = Object.fromEntries(loginTargets("offline").map((t) => [t.providerId, t]));
    expect(byId.ollama!.hint).toContain("11434");
    expect(byId.custom!.hint).toMatch(/LM Studio/);
  });

  test("a local runtime needs no credential to count as usable; the custom slot reflects its setup", () => {
    const byId = Object.fromEntries(loginTargets("offline").map((t) => [t.providerId, t]));
    expect(byId.ollama!.connected).toBe(true);
    expect(byId.custom!.connected).toBe(false);
    const configured = loginTargets("offline", { connected: (id) => id === "custom" });
    expect(configured.find((t) => t.providerId === "custom")!.connected).toBe(true);
  });
});

describe("the web-search route", () => {
  test("lists the engines in answer order: an LLM-built index first, the built-in scraper last", () => {
    const list = ids("search");
    expect(list).toEqual(searchPresetsByRank().map((p) => p.id));
    expect(list[0]).toBe("tavily");
    expect(list.at(-1)).toBe("duckduckgo");
  });

  test("a keyed engine pastes a key; the self-hosted and built-in ones run the local step", () => {
    const byId = Object.fromEntries(loginTargets("search").map((t) => [t.providerId, t]));
    expect(byId.exa!.method).toBe("api_key");
    expect(byId.searxng!.method).toBe("local");
    expect(byId.duckduckgo!.method).toBe("local");
  });

  test("the built-in engine is always connected; the rest report what they were told", () => {
    const targets = loginTargets("search", { connected: (id) => id === "brave" });
    const byId = Object.fromEntries(targets.map((t) => [t.providerId, t]));
    expect(byId.duckduckgo!.connected).toBe(true);
    expect(byId.brave!.connected).toBe(true);
    expect(byId.tavily!.connected).toBe(false);
  });

  test("every engine explains what it is good for, without jargon", () => {
    for (const t of loginTargets("search")) {
      expect(t.hint.length).toBeGreaterThan(0);
      expect(t.hint).not.toContain("backend");
      expect(t.hint).not.toContain("provider");
    }
  });
});

describe("the list doubles as a status readout", () => {
  test("what you are already signed in to is marked", () => {
    const targets = loginTargets("subscription", { connected: (id) => id === "codex" });
    expect(targets.find((t) => t.providerId === "codex")?.connected).toBe(true);
    expect(targets.find((t) => t.providerId === "anthropic")?.connected).toBe(false);
  });

  test("the summary speaks product names, and says so plainly when empty", () => {
    expect(connectedSummary([])).toBe("nothing connected yet");
    expect(connectedSummary(["codex"])).toContain("ChatGPT Plus / Pro");
  });

  test("the summary answers both halves: can it think, and can it look things up", () => {
    expect(connectedSummary(["codex"], ["tavily"])).toBe(
      "connected: ChatGPT Plus / Pro | search: Tavily",
    );
    expect(connectedSummary(["mistral"], [])).toBe("connected: Mistral AI");
    expect(connectedSummary([], ["exa"])).toBe("no model connected yet | search: Exa");
  });
});
