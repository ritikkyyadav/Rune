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
} from "../../../packages/orchestrator/src/bin/ui/login-picker";

const ids = (route: Parameters<typeof loginTargets>[0]) =>
  loginTargets(route).map((t) => t.providerId);
const labels = (route: Parameters<typeof loginTargets>[0]) =>
  loginTargets(route).map((t) => t.label);

describe("the first question", () => {
  test("asks what you have, in that order", () => {
    // Subscription leads because it is the case the old surface served worst.
    expect(routeChoices().map((r) => r.id)).toEqual(["subscription", "api_key", "offline"]);
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

  test("names the env var, so an existing key is discoverable rather than re-typed", () => {
    const openai = loginTargets("api_key").find((t) => t.providerId === "openai");
    expect(openai?.hint).toContain("OPENAI_API_KEY");
  });

  test("codex is absent — a ChatGPT plan has no API key to paste", () => {
    expect(ids("api_key")).not.toContain("codex");
  });
});

describe("the offline route", () => {
  test("is exactly the local runtimes", () => {
    expect(ids("offline").sort()).toEqual(["ollama"]);
  });

  test("says where each one lives, since that is the only thing to get wrong", () => {
    const byId = Object.fromEntries(loginTargets("offline").map((t) => [t.providerId, t]));
    expect(byId.ollama!.hint).toContain("11434");
  });

  test("needs no credential to count as usable", () => {
    for (const t of loginTargets("offline")) expect(t.connected).toBe(true);
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
});
