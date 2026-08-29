import type {
  CostLedger,
  GatewayConfig,
  GatewayIncidentEvent,
  InferenceRequest,
  InferenceResponse,
  LlmProvider,
  ProviderName,
  StreamEvent,
  StreamOpts,
  TokenUsage,
} from "./types";
import { CostTracker } from "./cost-tracker";
import { ProviderHealthStore } from "./provider-health";
import { providerFallbackRank } from "@gear/shared";

// Default model for each provider, used during fallback.
//
// ROT WARNING: hosted free-tier models get retired without notice (qwen/
// qwen3-coder:free and qwen3-coder:480b both died 2026-07-15 and took every
// fallback chain down with them — 13 consecutive 410s per run). Keep these
// current when providers announce retirements; the model-gone pruning below is
// the safety net that keeps a stale entry from killing runs in the meantime.
const PROVIDER_DEFAULT_MODELS: Record<string, string> = {
  google: "gemini-2.5-flash",
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-4o",
  // deepseek-v4-flash:free was withdrawn from OpenRouter's free tier
  // ("paid version available now" 404, observed 2026-08-26).
  openrouter: "minimax/minimax-m3:free",
  ollama: "llama3",
  // qwen3-coder-next (the previous refresh) was itself retired 2026-07-15.
  // gpt-oss:120b verified live + tool-capable on the keyed free tier 2026-08-26.
  "ollama-turbo": "gpt-oss:120b",
  codex: "gpt-5.6-terra",
};

// Cap how long we'll wait on a single rate-limited attempt. A free-tier quota
// 429 often advises tens of seconds; hanging that long is worse than switching
// providers or surfacing a clear, actionable error.
const RATE_LIMIT_MAX_WAIT_MS = 8_000;

// A model that no longer exists (retired, renamed, never valid). Retrying it
// can only fail identically, so the provider is pruned for the session.
const MODEL_GONE_RE =
  /retired|decommission|deprecat|model.{0,32}(not.?(found|exist|available)|unknown|invalid)|does not exist|no such model/i;

/**
 * True when a failure means the MODEL is gone (retired / renamed / never
 * valid), not a transient fault. Exported so other layers that walk model
 * candidates themselves (the compaction summarizer) classify with the SAME
 * definition instead of growing a divergent copy.
 */
export function isModelGoneError(err: unknown): boolean {
  const status = (err as { status?: number } | undefined)?.status;
  if (status === 404 || status === 410) return true;
  return MODEL_GONE_RE.test(err instanceof Error ? err.message : "");
}

// A 429 that is a PLAN/QUOTA cap ("usage limit reached", weekly caps), not a
// per-minute throttle. Waiting seconds won't clear it — cool the provider down
// for a long window instead of re-hammering it at the top of every turn.
const USAGE_CAP_RE = /usage limit|quota|weekly|plan limit|credit/i;

/** Cooldown for a plan/quota-capped provider when no Retry-After is given. */
const USAGE_CAP_COOLDOWN_MS = 15 * 60_000;
/** Cooldown for a plain rate-limited provider when no Retry-After is given. */
const RATE_LIMIT_COOLDOWN_MS = 60_000;
/** Never cool a provider longer than this, whatever Retry-After claims. */
const MAX_COOLDOWN_MS = 60 * 60_000;

export class LlmGateway {
  private providers: Map<ProviderName, LlmProvider> = new Map();
  private config: GatewayConfig;
  /**
   * Single source of pricing truth. This used to be a hand-rolled ledger with
   * its own copy of the arithmetic — exact-match lookup only, no cache
   * awareness, silently skipping unknown models. Two implementations of "what
   * did this cost" drift the moment either is corrected, so the gateway now
   * delegates to the same tracker the engine uses.
   */
  private costTracker = new CostTracker();
  /**
   * Providers whose model is GONE (404/410/"retired"), pruned for this
   * gateway's lifetime — a retired model does not come back mid-session.
   * Without this, a rotted fallback default re-410s on every turn until the
   * agent loop's consecutive-error breaker kills the whole run mid-task.
   */
  private prunedProviders = new Set<ProviderName>();
  /** Providers cooling down after a rate/usage cap: epoch ms when usable again. */
  private cooldownUntil = new Map<ProviderName, number>();
  /**
   * The subset of cooldowns that are PLAN/QUOTA caps rather than throttles,
   * with the message that announced it. Tracked separately because the two
   * deserve opposite handling: a throttle is a pause, a cap is the end of this
   * model's availability for a long window, and only the second is a reason to
   * stop the run rather than continue somewhere weaker.
   */
  private cappedUntil = new Map<ProviderName, { until: number; message: string }>();

  /**
   * What previous sessions learned about dead models and capped plans. Seeded
   * into the in-memory cooldowns below so a fresh session starts informed
   * instead of re-paying for the same discoveries — the pattern behind 24
   * recorded failures against a model retired six weeks earlier.
   */
  private health: ProviderHealthStore;

  constructor(config: GatewayConfig, health?: ProviderHealthStore) {
    this.config = config;
    // Persistence is OPT-IN. Defaulting to a store rooted in the real gear
    // home made every gateway built without one — every test, every embedded
    // use — read and write a machine-global file, so a live run in one process
    // silently changed fallback behaviour in another. That is the same
    // read-the-developer's-home bug this audit fixed elsewhere; it does not get
    // an exception for being mine. The CLI passes a store explicitly.
    this.health = health ?? ProviderHealthStore.ephemeral();
    // Seed cooldowns, NOT the fallback policy. getFallbackProviders
    // deliberately re-attempts a capped primary so the gateway can notice the
    // cap has lifted; persisting the cap must make that first attempt
    // better-informed, never remove it.
    for (const cap of this.health.snapshot().capped) {
      const provider = cap.provider as ProviderName;
      this.cooldownUntil.set(provider, cap.until);
      this.cappedUntil.set(provider, { until: cap.until, message: cap.message });
    }
  }

  /** Cool a provider down after a 429; usage-cap 429s cool much longer. */
  private coolDown(provider: ProviderName, err: Error | undefined): number {
    const retryAfter = this.getRetryAfterMs(err);
    const isCap = USAGE_CAP_RE.test(err?.message ?? "");
    const base = isCap ? USAGE_CAP_COOLDOWN_MS : RATE_LIMIT_COOLDOWN_MS;
    const waitMs = Math.min(Math.max(retryAfter, base), MAX_COOLDOWN_MS);
    const until = Date.now() + waitMs;
    this.cooldownUntil.set(provider, until);
    if (isCap) {
      // Persisted too: a plan cap outlives the session that hit it, and a new
      // session walking into the same wall is the single most common failure
      // in the incident log.
      this.health.noteCapped(
        provider,
        until,
        err?.message?.split("\n")[0]?.slice(0, 150) ?? "usage limit reached",
      );
      this.cappedUntil.set(provider, {
        until,
        message: err?.message?.split("\n")[0]?.slice(0, 150) ?? "usage limit reached",
      });
    }
    return waitMs;
  }

  /** True when this failure is a plan/quota cap rather than a passing throttle. */
  private isUsageCap(err: Error | undefined): boolean {
    return USAGE_CAP_RE.test(err?.message ?? "");
  }

  /** Whether a quota cap should end the run instead of degrading. Default: yes. */
  private get stopOnQuota(): boolean {
    return (this.config.quotaPolicy ?? "stop") === "stop";
  }

  /** A live quota cap on this provider, or null. */
  private activeCap(provider: ProviderName): { until: number; message: string } | null {
    const cap = this.cappedUntil.get(provider);
    if (!cap) return null;
    if (cap.until <= Date.now()) {
      this.cappedUntil.delete(provider);
      return null;
    }
    return cap;
  }

  /**
   * The one message the user sees when a cap stops the run. It has to answer
   * four questions at once: what happened, why nothing else took over, whether
   * the work survived, and when to come back.
   */
  private quotaStopError(
    provider: ProviderName,
    model: string,
    until: number,
    why: string,
    /** False when the chain simply ran out rather than a substitute being refused. */
    declinedSubstitute = true,
  ): string {
    const mins = Math.max(1, Math.ceil((until - Date.now()) / 60_000));
    // Only claim to have refused a handover when one was actually available and
    // refused. If the cap landed on a provider we had already fallen back to,
    // nothing was declined — saying otherwise would misdescribe the run in the
    // one message the user gets to reconstruct it from.
    const stance = declinedSubstitute
      ? "Stopped here instead of handing your task to a weaker model."
      : "No provider is left to continue on.";
    return (
      `Quota exceeded on ${provider}/${model}${why ? ` — ${why}` : ""}. ${stance} ` +
      `Your work is saved: resume this session in ~${mins}m, ` +
      `switch now with /model, or set [fallback] onQuotaExceeded = "degrade" to allow automatic downgrade.`
    );
  }

  /** True when the failure means the MODEL is gone (not a transient fault). */
  private isModelGone(status: number | undefined, err: Error | undefined): boolean {
    if (status === 404 || status === 410) return true;
    return isModelGoneError(err);
  }

  /** Introspection for /status-style UIs and tests. */
  getProviderHealth(): {
    pruned: ProviderName[];
    cooling: Array<{ provider: ProviderName; untilMs: number }>;
  } {
    const now = Date.now();
    return {
      pruned: [...this.prunedProviders],
      cooling: [...this.cooldownUntil.entries()]
        .filter(([, until]) => until > now)
        .map(([provider, untilMs]) => ({ provider, untilMs })),
    };
  }

  registerProvider(provider: LlmProvider): void {
    this.providers.set(provider.name, provider);
  }

  /** Guarded black-box tap — an observer bug must never break a stream. */
  private reportIncident(incident: GatewayIncidentEvent): void {
    try {
      this.config.onIncident?.(incident);
    } catch {
      // swallow: observability is strictly best-effort here
    }
  }

  getProvider(name: ProviderName): LlmProvider | undefined {
    return this.providers.get(name);
  }

  getRegisteredProviderNames(): ProviderName[] {
    return [...this.providers.keys()];
  }

  async infer(request: InferenceRequest): Promise<InferenceResponse> {
    const provider = this.resolveProvider(request.provider);
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        const response = await provider.infer(request);
        this.recordCost(request.model, request.provider, response.usage);
        return response;
      } catch (err) {
        lastError = err as Error;
        // An aborted request is a caller decision (timeout fail-closed, user
        // cancel) — retrying it would resurrect work the caller abandoned.
        if (request.signal?.aborted) break;
        if (!this.shouldRetry(err as Error, attempt)) break;
        // No stream to yield on here, but the retry is still not allowed to be
        // silent — `retryEvent` reports it to the black box on the way past.
        this.retryEvent(request.provider, request.model, attempt, lastError);
        await this.backoff(lastError, attempt);
      }
    }

    throw lastError ?? new Error("Inference failed");
  }

  async *inferStream(request: InferenceRequest, opts?: StreamOpts): AsyncGenerator<StreamEvent> {
    // Build ordered list: requested provider first, then fallbacks
    const fallbackOrder = this.getFallbackProviders(request.provider);

    // The user's chosen provider is being skipped (pruned model / cooling
    // down). Say so up front — a silent per-turn model swap is worse than the
    // failure it papers over.
    if (fallbackOrder[0] !== request.provider && this.providers.has(request.provider)) {
      const until = this.cooldownUntil.get(request.provider) ?? 0;
      const why = this.prunedProviders.has(request.provider)
        ? "its model is no longer available (pick a new one with /model)"
        : `it hit its usage/rate limit — retrying it in ~${Math.max(1, Math.ceil((until - Date.now()) / 60_000))}m`;
      yield {
        type: "notice",
        message: `Skipping ${request.provider} — ${why}. Using ${fallbackOrder[0]}/${
          PROVIDER_DEFAULT_MODELS[fallbackOrder[0]] ?? "default"
        } for now…`,
      };
    }

    // Tracks whether the consumer received any events for the CURRENT
    // assistant message. A retry/fallback after a partial stream must emit
    // stream_reset first, or the consumer's accumulated text/tool calls get
    // duplicated by the re-streamed response.
    let yieldedSinceReset = false;

    for (const providerName of fallbackOrder) {
      const provider = this.providers.get(providerName);
      if (!provider) continue;

      // Adjust model for fallback providers
      const adjustedRequest =
        providerName === request.provider
          ? request
          : {
              ...request,
              provider: providerName,
              model: PROVIDER_DEFAULT_MODELS[providerName] ?? request.model,
            };

      // A model a previous session watched die. Skipping costs nothing;
      // confirming it costs a full request with the entire conversation
      // attached, which is what the incident log shows happening 24 times
      // against one id. The record expires, so a model that returns is
      // re-probed rather than blocked forever.
      if (this.health.isRetired(providerName, adjustedRequest.model)) {
        this.prunedProviders.add(providerName);
        this.reportIncident({
          kind: "terminal",
          provider: providerName,
          model: adjustedRequest.model,
          message: `skipped without a request — known retired: ${
            this.health.retirementReason(providerName, adjustedRequest.model) ?? "model gone"
          }`,
        });
        continue;
      }

      // The next REGISTERED provider in the chain, if any. Used both to fall
      // back fast (don't burn the retry ladder on a down/over-quota model) and
      // to decide whether a failure is terminal.
      const idx = fallbackOrder.indexOf(providerName);
      const nextProvider = fallbackOrder.slice(idx + 1).find((p) => this.providers.has(p));
      const hasNext = nextProvider !== undefined;

      let lastError: Error | undefined;
      let lastStatus: number | undefined;
      let shouldFallback = false;

      for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
        try {
          const gen = provider.inferStream(adjustedRequest, opts);
          for await (const event of gen) {
            if (event.type === "message_stop") {
              this.recordCost(adjustedRequest.model, providerName, event.usage);
            }
            yieldedSinceReset = true;
            yield event;
          }
          return; // success — done
        } catch (err) {
          // User abort: stop dead. Retrying or falling back on an aborted
          // request wastes calls and delays the Esc response.
          if (opts?.signal?.aborted) throw err;

          lastError = err as Error;
          lastStatus = (err as Record<string, unknown>).status as number | undefined;

          const isAuthOrBilling = lastStatus === 401 || lastStatus === 402 || lastStatus === 403;
          const isRateLimit = lastStatus === 429;

          // The model itself is gone (retired / renamed / never existed).
          // Re-trying is guaranteed-identical failure: prune the provider for
          // the session and move on. This is what keeps one rotted model id
          // from burning the agent loop's whole error budget turn after turn.
          if (this.isModelGone(lastStatus, lastError)) {
            this.prunedProviders.add(providerName);
            // Remember it past this session — but only on a STATUS that
            // pertains to this request. isModelGone also matches on message
            // text ("retired", "deprecated"), which is right for pruning
            // in-session but wrong for a 7-day record: a message naming a
            // DIFFERENT model can reach this catch (a summarizer's fallback
            // ladder, a wrapped upstream error) and be filed against the model
            // that happened to be in hand. Observed doing exactly that —
            // google/gemini-2.5-flash recorded as retired with the reason
            // "qwen3-coder:480b was retired", which would have skipped a
            // healthy model for a week. A 404/410 is unambiguous evidence
            // about the request that just failed; nothing else is.
            if (lastStatus === 404 || lastStatus === 410) {
              this.health.noteRetired(
                providerName,
                adjustedRequest.model,
                lastError?.message?.slice(0, 200) ?? `HTTP ${lastStatus}`,
              );
            }
            this.reportIncident({
              kind: "terminal",
              provider: providerName,
              model: adjustedRequest.model,
              status: lastStatus,
              message: `model gone — provider pruned for this session: ${lastError?.message?.slice(0, 120)}`,
            });
            if (hasNext) {
              shouldFallback = true;
            }
            break;
          }

          // Rate/usage-limited: remember it so the NEXT turn skips this
          // provider instantly instead of re-walking a doomed cascade.
          if (isRateLimit) this.coolDown(providerName, lastError);

          // ── A plan/quota cap on the provider the user CHOSE ends the run ──
          // Not a fallback: a frontier model halfway through an extensive task
          // is not interchangeable with whatever happens to be registered next.
          // The substitute inherits the transcript and the authority, produces
          // work at a different standard, and nothing in the output says so —
          // which is exactly how a long run comes back subtly wrong. A cap is
          // also not brief (15m+ here, often much longer), so this is not the
          // "wait it out" case either. Stop, say when to return, keep the work.
          //
          // Scoped to the REQUESTED provider: once we are already on a
          // substitute, stopping buys nothing the first stop did not.
          if (
            isRateLimit &&
            this.stopOnQuota &&
            this.isUsageCap(lastError) &&
            providerName === request.provider
          ) {
            break;
          }

          // Another provider is available → switch NOW. A bad key, exhausted
          // credits, or an over-quota 429 won't clear by retrying the same
          // provider, so falling back immediately is both faster and likelier
          // to succeed than burning the retry ladder here.
          if ((isAuthOrBilling || isRateLimit) && hasNext) {
            shouldFallback = true;
            break;
          }

          // No fallback left. For a sole rate-limited provider, do at most one
          // short, capped retry honoring Retry-After — a long server-advised
          // delay means we give up cleanly instead of hanging the session.
          // A PLAN/QUOTA cap never gets that retry: "usage limit reached"
          // does not clear in seconds, so the retry is pure added latency.
          if (isRateLimit) {
            if (
              attempt >= 1 ||
              USAGE_CAP_RE.test(lastError?.message ?? "") ||
              this.getRetryAfterMs(lastError) > RATE_LIMIT_MAX_WAIT_MS
            )
              break;
            if (yieldedSinceReset) {
              yieldedSinceReset = false;
              yield { type: "stream_reset" };
            }
            yield this.retryEvent(providerName, adjustedRequest.model, attempt, lastError);
            await this.backoff(lastError, attempt);
            continue;
          }

          // Transient 5xx / network → retry with backoff; hard 4xx → stop.
          if (!this.shouldRetry(lastError, attempt)) break;
          if (yieldedSinceReset) {
            yieldedSinceReset = false;
            yield { type: "stream_reset" };
          }
          yield this.retryEvent(providerName, adjustedRequest.model, attempt, lastError);
          await this.backoff(lastError, attempt);
        }
      }

      // A 5xx / network failure that exhausted its retries still falls back to
      // the next provider before we give up.
      if (!shouldFallback && hasNext && (lastStatus === undefined || lastStatus >= 500)) {
        shouldFallback = true;
      }

      if (shouldFallback && nextProvider) {
        if (yieldedSinceReset) {
          yieldedSinceReset = false;
          yield { type: "stream_reset" };
        }
        const nextModel = PROVIDER_DEFAULT_MODELS[nextProvider] ?? "default";
        const why = this.failureReason(lastStatus, lastError);
        this.reportIncident({
          kind: "fallback",
          provider: providerName,
          model: adjustedRequest.model,
          status: lastStatus,
          message: why || lastError?.message?.slice(0, 150) || "provider unavailable",
          fallbackTo: nextProvider,
        });
        // Informational, NOT an error: the agent loop ends the turn on `error`
        // events, so emitting the switch as an error would abandon this
        // generator before the fallback provider streams anything. The reason
        // is included so a fallback (e.g. a subscription-gated model) is never a
        // silent swap to a different model — the user sees WHY it switched.
        // Structured, so UIs render a real banner (provider chain, status,
        // "turn continues") instead of regex-parsing a sentence.
        yield {
          type: "fallback",
          from: { provider: providerName, model: adjustedRequest.model },
          to: { provider: nextProvider, model: nextModel },
          status: lastStatus,
          reason: why || lastError?.message?.slice(0, 120) || undefined,
          chain: fallbackOrder.slice(idx + 1).filter((p) => this.providers.has(p)),
        };
        continue;
      }

      // Last provider in the chain failed — yield one clean, terminal error.
      // Auth / billing / rate-limit are marked non-retryable so the agent loop
      // stops with guidance instead of re-running the whole (doomed) chain and
      // dying with "Too many consecutive errors".
      const cleanMsg = lastError?.message?.split("\n")[0]?.slice(0, 150) ?? "Unknown error";
      const triedList = fallbackOrder.filter((p) => this.providers.has(p)).join(", ");

      // Terminal (non-retryable) failures get reported to the black box here,
      // where the status code is still known. The retryable else-branch is NOT
      // reported — the agent loop records those as stream errors if they stick.
      if (lastStatus === 401 || lastStatus === 402 || lastStatus === 403 || lastStatus === 429) {
        this.reportIncident({
          kind: "terminal",
          provider: providerName,
          model: adjustedRequest.model,
          status: lastStatus,
          message: cleanMsg,
        });
      }

      if (this.isModelGone(lastStatus, lastError)) {
        const why = this.failureReason(lastStatus, lastError);
        yield {
          type: "error",
          error: `${providerName}/${adjustedRequest.model} is gone${
            why ? ` — ${why}` : ""
          }. The model was retired or renamed: pick a current one with /model.`,
          retryable: false,
        };
      } else if (lastStatus === 401 || lastStatus === 403) {
        const why = this.failureReason(lastStatus, lastError);
        yield {
          type: "error",
          error: `${providerName} rejected the request${why ? ` — ${why}` : ""}. Check the model/key or switch with /model.`,
          retryable: false,
        };
      } else if (lastStatus === 402) {
        yield {
          type: "error",
          error: `No credits on ${providerName}. Add billing or switch providers with /model.`,
          retryable: false,
        };
      } else if (lastStatus === 429 && this.stopOnQuota && this.isUsageCap(lastError)) {
        // A CAP, not a throttle. Deliberately worded without "rate limit" and
        // in minutes, so the loop's rateLimitWaitSecs() cannot read it as a
        // short, waitable pause and sit on it — this run is over, and the
        // agent loop's retryable:false path writes the resume handoff.
        const cap = this.activeCap(providerName);
        const until = cap?.until ?? Date.now() + USAGE_CAP_COOLDOWN_MS;
        yield {
          type: "error",
          error: this.quotaStopError(
            providerName,
            adjustedRequest.model,
            until,
            cleanMsg,
            providerName === request.provider,
          ),
          retryable: false,
        };
      } else if (lastStatus === 429) {
        const waitMs = this.getRetryAfterMs(lastError);
        const waitHint = waitMs > 0 ? ` Retry in ~${Math.ceil(waitMs / 1000)}s` : " Wait a moment";
        const scope = triedList.includes(",")
          ? `All providers rate limited (${triedList}).`
          : `Rate limited on ${providerName}.`;
        yield {
          type: "error",
          error: `${scope}${waitHint}, or switch models with /model.`,
          retryable: false,
        };
      } else {
        // Transient (5xx / network) with no fallback: let the agent loop retry.
        yield { type: "error", error: cleanMsg };
      }
      return;
    }

    // No providers available at all
    yield {
      type: "error",
      error:
        "No providers available. Set an API key: GOOGLE_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY, or OPENROUTER_API_KEY",
    };
  }

  /**
   * Returns an ordered list of providers to try: primary first, then fallbacks
   * ranked by how little capability the handover costs.
   *
   * Pruned providers (model gone) and providers inside a rate/usage cooldown
   * are skipped — with one exception: when EVERY registered provider is
   * unusable, the primary is returned alone so the attempt produces a clean,
   * actionable terminal error (and self-heals the moment the limit resets)
   * instead of a lying "No providers available".
   *
   * The ORDER of `rest` used to be raw Map insertion order — i.e. the order
   * `buildGateway` happened to walk PROVIDER_PRESETS, which is a display list.
   * That is how a capped frontier session handed a deep code audit to a free
   * model: openrouter simply sat next in the table. Registration order carries
   * no information about what a handover costs, so it is now a tie-break
   * WITHIN a capacity class rather than the whole policy (the sort is stable,
   * so a user's configured ordering still shows through inside a class).
   *
   * `config.fallbackOrder` overrides the ranking head-first: providers named
   * there are tried in that order before any unnamed one. Omitting a provider
   * DEPRIORITIZES it — it does not remove it, because a degraded answer beats a
   * dead run, and the loop now labels the degradation instead of hiding it.
   */
  private getFallbackProviders(primary: ProviderName): ProviderName[] {
    const now = Date.now();
    // ── A quota-capped primary gets NO substitutes ──
    // Returning it alone (rather than short-circuiting before the call) keeps
    // the author's self-heal: re-attempting is how the gateway learns the cap
    // has lifted, and caps often clear sooner than the 15m we assume. Refusing
    // to try would lock the user out for the full cooldown with no recourse —
    // worse than the silent downgrade this policy exists to prevent. One cheap
    // 429 is the price of noticing recovery; what must not happen is another
    // model quietly inheriting the task, and that is what this prevents.
    if (this.stopOnQuota && this.activeCap(primary) && this.providers.has(primary)) {
      return [primary];
    }
    const usable = (p: ProviderName) =>
      !this.prunedProviders.has(p) && (this.cooldownUntil.get(p) ?? 0) <= now;
    const all = [...this.providers.keys()];
    const preferred = this.config.fallbackOrder ?? [];
    const rankOf = (p: ProviderName): number => {
      const explicit = preferred.indexOf(p);
      // Explicit picks sort ahead of every capacity class; -1 means unnamed.
      return explicit >= 0 ? explicit - preferred.length : providerFallbackRank(p);
    };
    const rest = all
      .filter((p) => p !== primary && usable(p))
      .map((p, i) => ({ p, i, rank: rankOf(p) }))
      // Stable by construction: equal ranks keep registration order.
      .sort((a, b) => a.rank - b.rank || a.i - b.i)
      .map((e) => e.p);
    if (this.providers.has(primary) && usable(primary)) {
      return [primary, ...rest];
    }
    return rest.length > 0 ? rest : [primary];
  }

  async countTokens(
    provider: ProviderName,
    ...args: Parameters<LlmProvider["countTokens"]>
  ): Promise<number> {
    const p = this.resolveProvider(provider);
    return p.countTokens(...args);
  }

  async healthCheck(provider?: ProviderName): Promise<Record<ProviderName, boolean>> {
    const results: Partial<Record<ProviderName, boolean>> = {};
    const toCheck = provider ? [this.resolveProvider(provider)] : [...this.providers.values()];

    await Promise.all(
      toCheck.map(async (p) => {
        results[p.name] = await p.healthCheck();
      }),
    );
    return results as Record<ProviderName, boolean>;
  }

  getCostLedger(): CostLedger {
    return this.costTracker.getLedger();
  }

  getTotalCost(): number {
    return this.costTracker.getLedger().totalCostUsd;
  }

  /**
   * The PERSISTED health record, distinct from getProviderHealth() above,
   * which reports what this session alone has learned. This one survives
   * restarts and is what stops a new session rediscovering a dead model.
   */
  getPersistedHealth(): ProviderHealthStore {
    return this.health;
  }

  /** Metered-equivalent total — what this gateway's traffic is worth at list rates. */
  getTotalListCost(): number {
    return this.costTracker.getLedger().totalListCostUsd;
  }

  // ─── Private ───

  private resolveProvider(name: ProviderName): LlmProvider {
    const provider = this.providers.get(name);
    if (!provider) {
      throw new Error(`Provider "${name}" not registered`);
    }
    return provider;
  }

  private shouldRetry(err: Error, attempt: number): boolean {
    if (attempt >= this.config.maxRetries) return false;
    const status = (err as unknown as { status?: number }).status;
    // Retry 429 (rate limit) and 5xx errors
    if (status === 429) return true;
    if (status && status >= 500) return true;
    // Don't retry other 4xx
    if (status && status >= 400 && status < 500) return false;
    // Retry network errors
    return true;
  }

  /**
   * Best-effort Retry-After in ms. Prefers the structured `ApiError.retryAfterMs`
   * (e.g. parsed from Google's RetryInfo body) and falls back to an HTTP
   * `Retry-After` header on SDK-style errors. Returns 0 when unknown.
   */
  private getRetryAfterMs(err: Error | undefined): number {
    if (!err) return 0;
    const e = err as unknown as { retryAfterMs?: number | null; headers?: unknown };
    if (typeof e.retryAfterMs === "number" && e.retryAfterMs > 0) return e.retryAfterMs;

    const headers = e.headers;
    let raw: string | null | undefined;
    if (headers && typeof (headers as { get?: unknown }).get === "function") {
      raw = (headers as { get(name: string): string | null }).get("retry-after");
    } else if (headers && typeof headers === "object") {
      const h = headers as Record<string, string>;
      raw = h["retry-after"] ?? h["Retry-After"];
    }
    if (raw) {
      const secs = parseInt(raw, 10);
      if (!isNaN(secs)) return secs * 1000;
    }
    return 0;
  }

  /**
   * How long the next retry will wait. Split out of `backoff` so the `retry`
   * event can state the real number rather than an approximation of it — the
   * surface uses it to explain a gap the user is about to sit through.
   */
  private retryWaitMs(err: Error | undefined, attempt: number): number {
    const waitMs = Math.max(
      this.getRetryAfterMs(err),
      this.config.retryBaseMs * Math.pow(2, attempt),
    );
    // Never hang on a long server-advised delay for rate limits — better to fall
    // back or fail fast with guidance than freeze the session.
    const status = (err as unknown as { status?: number } | undefined)?.status;
    return status === 429 ? Math.min(waitMs, RATE_LIMIT_MAX_WAIT_MS) : waitMs;
  }

  /**
   * The retry, as a fact: reported to the black box and returned as a stream
   * event so no retry is ever silent. `attempt` in is 0-based (the attempt that
   * just failed); `attempt` out is 1-based (the retry about to happen).
   */
  private retryEvent(
    provider: string,
    model: string,
    attempt: number,
    err: Error | undefined,
  ): Extract<StreamEvent, { type: "retry" }> {
    const status = (err as unknown as { status?: number } | undefined)?.status;
    const waitMs = this.retryWaitMs(err, attempt);
    const reason = this.failureReason(status, err) || undefined;
    this.reportIncident({
      kind: "retry",
      provider,
      model,
      status,
      message: reason || err?.message?.slice(0, 120) || "transient failure",
      attempt: attempt + 1,
      of: this.config.maxRetries,
      waitMs,
    });
    return {
      type: "retry",
      provider,
      model,
      attempt: attempt + 1,
      of: this.config.maxRetries,
      status,
      waitMs,
      reason,
    };
  }

  private async backoff(err: Error | undefined, attempt: number): Promise<void> {
    const waitMs = this.retryWaitMs(err, attempt);
    const jitter = Math.random() * waitMs * 0.1;
    await new Promise((resolve) => setTimeout(resolve, waitMs + jitter));
  }

  /**
   * A short, human-readable reason for a provider failure. Prefers the upstream
   * message (e.g. Ollama's "this model requires a subscription, upgrade for
   * access") and falls back to a status label. Used so fallbacks and terminal
   * errors explain WHY instead of a bare "unavailable" — turning a silent
   * provider swap into something the user can act on.
   */
  private failureReason(status: number | undefined, err: Error | undefined): string {
    const firstLine =
      (err?.message ?? "")
        .split("\n")[0]
        ?.replace(/^\d{3}\s+/, "") // strip a leading SDK "<status> " prefix
        .trim() ?? "";
    if (firstLine && firstLine.length <= 100 && !/^(error|request failed)/i.test(firstLine)) {
      return firstLine;
    }
    switch (status) {
      case 401:
        return "invalid API key";
      case 402:
        return "no credits";
      case 403:
        return "access denied (may require a subscription)";
      case 429:
        return "rate limited";
      default:
        return status ? `HTTP ${status}` : "";
    }
  }

  private recordCost(model: string, provider: ProviderName, usage: TokenUsage): void {
    try {
      this.costTracker.record(model, provider, usage);
    } catch {
      // record() throws only on a budget cap, which this gateway does not set.
      // Accounting must never abort a response the provider already billed for.
    }
  }
}
