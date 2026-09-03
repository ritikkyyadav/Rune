/**
 * How a given host handles prompt caching - declared, not guessed.
 *
 * This replaces a substring test on the base URL
 * (`baseUrl.includes("openrouter.ai")`), which was unmaintainable past one
 * host: every new OpenAI-compatible endpoint either silently got no caching or
 * had to be added to a growing string match, and nothing said which hosts had
 * actually been *measured*. The policy is now set explicitly where each
 * provider is constructed, so the answer to "does this host cache, and how?" is
 * a value you can read and a unit test can assert.
 *
 *   anthropic-style   The host forwards Anthropic `cache_control` breakpoints
 *                     upstream. Writing a breakpoint is what creates the cache
 *                     entry; without one, nothing is cached at all.
 *   prompt-cache-key  The host caches prefixes automatically but accepts
 *                     OpenAI's `prompt_cache_key` routing hint, which keeps
 *                     requests sharing a prefix on the machine holding it.
 *   implicit          The host caches stable prefixes automatically and takes
 *                     no cache field. Byte-stability of the prefix is the only
 *                     lever; sending anything else is noise on the wire.
 *   none              No prompt caching known for this host. Say so rather
 *                     than pretending: a null hit rate reads as "no data",
 *                     and "no data" is the truth here.
 */
export type CacheBreakpointPolicy = "anthropic-style" | "prompt-cache-key" | "implicit" | "none";

/**
 * The policy per provider id. Every id in `PROVIDER_PRESETS` that runs through
 * an OpenAI-compatible adapter appears here; anything absent falls to "none",
 * the honest default for a host nobody has measured.
 *
 * Measured evidence lives in `docs/providers.md`. Entries marked "documented"
 * follow the host's published behaviour and have not yet been measured here.
 */
const POLICY: Record<string, CacheBreakpointPolicy> = {
  // Measured 2026-08-26 (scripts/verify-cache.ts): Anthropic upstreams honour
  // forwarded `cache_control`; every other upstream caches implicitly, and a
  // forced breakpoint changed nothing. See wantsCacheBreakpoints in openai.ts.
  openrouter: "anthropic-style",
  // First-party OpenAI: automatic prefix caching over 1024 tokens, plus the
  // documented `prompt_cache_key` field that routes same-prefix requests to
  // the same machine.
  openai: "prompt-cache-key",
  // Gemini caches stable prefixes automatically on the 2.5 line and reports
  // `cachedContentTokenCount`. MEASURED 2026-09-02 on gemini-2.5-flash: turn 2
  // read 5,085 cached tokens against 15 fresh ones, a 99.7% hit rate, with no
  // explicit cache handle involved. See docs/providers.md.
  google: "implicit",
  // Documented automatic prefix caching, no wire field. Neither has been
  // measured here (no credential on this machine).
  deepseek: "implicit",
  groq: "implicit",
  xai: "implicit",
  // MEASURED 2026-09-02 on gpt-oss:20b: turn 1 and turn 2 both reported
  // input=4301, cached=0, on a byte-identical prefix. Ollama Cloud either does
  // not cache or does not report a cached-token count, and either way there is
  // no cache to claim. This said "implicit" on documentation alone; the
  // measurement says otherwise, so it says "none" and the hit rate reads as
  // "no data" rather than a number nobody earned.
  "ollama-turbo": "none",
  // ─── Enterprise routes (P10.5) ───
  // Bedrock and Vertex serve ANTHROPIC models and both document support for
  // `cache_control` breakpoints, which the shared Anthropic adapter already
  // emits — the breakpoints ride the same system block and stable turn they do
  // on the first-party API, because it is the same code composing the body.
  // NOT MEASURED: neither cloud has a credential on this machine, so these rows
  // are the hosts' documented behaviour, and `scripts/verify-cache.ts
  // --provider bedrock|vertex` is the command that will replace them with a
  // number. The declaration is the request SHAPE, not a claimed hit rate; the
  // hit rate still comes from real usage counters and reads "no data" until one
  // arrives.
  //
  // Vertex's Gemini half caches implicitly and reports the same counter AI
  // Studio does (measured there at 99.7%), so the one policy id covers both
  // halves: the Anthropic half writes breakpoints, the Gemini half ignores them.
  bedrock: "anthropic-style",
  vertex: "anthropic-style",
  // Azure serves the same OpenAI models with the same automatic prefix caching
  // over 1024 tokens, and accepts the same `prompt_cache_key` routing hint —
  // the shared OpenAI adapter sends it unchanged. Documented, not measured: no
  // Azure resource on this machine.
  "azure-openai": "prompt-cache-key",
  // A user-supplied endpoint could be anything; claiming a cache it may not
  // have would put an invented number on screen.
  custom: "none",
};

/** The declared cache-breakpoint policy for a provider id. */
export function cacheBreakpointPolicyFor(providerId: string): CacheBreakpointPolicy {
  return POLICY[providerId] ?? "none";
}

/** Every provider id with an explicit policy - the table a test can walk. */
export function declaredCachePolicies(): Readonly<Record<string, CacheBreakpointPolicy>> {
  return POLICY;
}

/**
 * Whether a model id names an ANTHROPIC upstream, the only family for which a
 * forwarded `cache_control` breakpoint means anything: the field is
 * Anthropic-shaped, and a host that proxies it to (say) an OpenAI upstream
 * either drops it or 400s.
 *
 * Deliberately narrow. Widening this is a measurement, not a guess - see
 * P8.2 in docs/program/08-economics.md and the table in docs/providers.md.
 */
export function isAnthropicUpstream(model: string): boolean {
  return model.toLowerCase().startsWith("anthropic/");
}

/**
 * A stable, content-free identifier for the always-stable head of a prompt -
 * the system prompt plus the tool names. Requests that share a prefix share
 * this key, which is exactly what `prompt_cache_key` routes on. It is a hash,
 * so no prompt text goes on the wire in it.
 */
export function promptCacheKey(system: string | undefined, toolNames: string[]): string {
  const source = `${system ?? ""} ${toolNames.join(",")}`;
  // FNV-1a, 32-bit. Collision-tolerant by design: a collision costs a cache
  // miss, never a wrong answer.
  let hash = 0x811c9dc5;
  for (let i = 0; i < source.length; i++) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `gear-${hash.toString(16).padStart(8, "0")}`;
}
