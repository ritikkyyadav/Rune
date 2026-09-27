// ─── Live model discovery for the `/model` picker ───
//
// The picker used to ask a live endpoint only for local runtimes. Every cloud
// account — an OpenAI key, a ChatGPT sign-in, an Anthropic key — was shown the
// hand-written preset, so a model the vendor shipped this week stayed invisible
// until someone edited providers.ts. GPT-6 Sol and Luna were released on
// 2026-09-22 and were still absent from `/model` a week later; that is the
// failure this module exists to end.
//
// The answer is the one `rune models` already gives, reused: the hour-fresh
// catalogue cache, else the provider's own listing, bounded so the picker
// never hangs on a slow host. `null` means "show the seed list" — discovery is
// an improvement on the preset, never a precondition for the picker.

import { loadCachedModels, saveCachedModels, type CachedModel } from "@rune/shared";
import type { LlmProvider } from "@rune/llm-gateway";

/** How long the picker waits for a listing before showing the seed list. */
export const DISCOVERY_TIMEOUT_MS = 2500;

export interface DiscoverOpts {
  timeoutMs?: number;
  /** Cache file override, for tests. */
  cachePath?: string;
  /** Injectable clock, for tests. */
  now?: number;
}

/**
 * The models a provider's account serves, or null when that cannot be known
 * quickly. Never throws.
 *
 * A listing that outlives the timeout keeps running and still fills the cache,
 * so a slow first open makes the second open instant instead of slow again.
 */
export async function discoverModels(
  providerId: string,
  provider: Pick<LlmProvider, "listModels"> | undefined,
  opts: DiscoverOpts = {},
): Promise<CachedModel[] | null> {
  const cacheOpts = {
    ...(opts.cachePath ? { path: opts.cachePath } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  };
  const cached = loadCachedModels(providerId, cacheOpts);
  if (cached) return cached;
  if (!provider?.listModels) return null;

  const listing = provider.listModels().then((live) => {
    if (live.length) saveCachedModels(providerId, live, cacheOpts);
    return live.map((m) => ({ id: m.id, ...(m.label ? { label: m.label } : {}) }));
  });
  // The race below may settle first; a later rejection must not surface as an
  // unhandled one.
  listing.catch(() => {});

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), opts.timeoutMs ?? DISCOVERY_TIMEOUT_MS);
  });
  try {
    const live = await Promise.race([listing, timeout]);
    return live && live.length > 0 ? live : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
