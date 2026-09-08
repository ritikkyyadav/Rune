import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import type { AuthMethod } from "./providers.js";
import { adoptLegacyEnv, getRuneHome, workspaceConfigPath } from "./paths.js";

// ─── Config Types ───

export interface RuneConfig {
  engine: {
    socketPath: string;
    logDir: string;
    dbPath: string;
    maxSessions: number;
  };
  llm: {
    // Full ProviderName set (was missing groq/xai/deepseek/custom, which
    // are valid providers — widened so config.toml can name any of them).
    defaultProvider:
      | "anthropic"
      | "openai"
      | "openrouter"
      | "ollama"
      | "ollama-turbo"
      | "google"
      | "groq"
      | "xai"
      | "deepseek"
      | "custom";
    /**
     * Optional default auth method for all providers when a provider block omits
     * its own. When unset, the method is auto-selected (see the auth resolver):
     * the first supported method with stored credentials, else the provider's
     * default (api_key for cloud, local for runtimes). Additive — no existing
     * config needs it.
     */
    authentication?: AuthMethod;
    /**
     * Reasoning depth sent to every provider that has the dial (Codex/OpenAI
     * `reasoning.effort`). Unset means "high" — see AgentLoop. This exists
     * because the dial was previously unreachable: a ChatGPT-subscription
     * session ran at the server default forever, with `max` available and no
     * way to ask for it.
     */
    reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
    /** "jit" (default) injects situational doctrine at first relevance; "full" keeps it in every request. */
    doctrineDelivery?: "jit" | "full";
    /** "conservative" (default) steps ordinary turns one effort notch down, escalating on difficulty; "off" disables routing. */
    effortRouting?: "conservative" | "off";
    anthropic?: {
      apiKey: string;
      model: string;
      maxTokens: number;
      /** Override the auth method for this provider (api_key | oauth | device | local). */
      authentication?: AuthMethod;
    };
    openai?: {
      apiKey: string;
      model: string;
      maxTokens: number;
      authentication?: AuthMethod;
    };
    openrouter?: {
      apiKey: string;
      model: string;
      maxTokens: number;
      authentication?: AuthMethod;
    };
    google?: {
      apiKey: string;
      model: string;
      maxTokens: number;
      authentication?: AuthMethod;
    };
    ollama?: {
      baseUrl: string;
      model: string;
      authentication?: AuthMethod;
      /** How long Ollama holds the model + KV cache after a request ("30m"). */
      keepAlive?: string;
    };
    planner?: {
      provider: string;
      model: string;
    };
    executor?: {
      provider: string;
      model: string;
    };
  };
  /**
   * `[providers.<id>]` — per-route settings for the enterprise clouds.
   *
   * Deliberately a SEPARATE section from `[llm.<id>]`, which holds api keys.
   * Nothing here is a secret: a region, a GCP project, an Azure endpoint and a
   * deployment-name map are the coordinates of an account, so they belong in a
   * `config.toml` a team checks in and shares — while the credential stays in
   * the cloud's own chain and never enters a file Rune writes.
   */
  providers?: {
    bedrock?: {
      /** AWS region. Falls back to AWS_REGION, then the profile's region. */
      region?: string;
      /**
       * Which cross-region inference profile family to prefix model ids with,
       * or "none" to send them untouched. Defaults to the region's family.
       */
      inferenceProfile?: "us" | "eu" | "apac" | "none";
    };
    vertex?: {
      /** GCP project id. Falls back to GOOGLE_CLOUD_PROJECT, then the credential's. */
      project?: string;
      /** Vertex location, e.g. "us-east5" or "global". Falls back to GOOGLE_CLOUD_LOCATION. */
      location?: string;
    };
    "azure-openai"?: {
      /** Resource endpoint, e.g. https://my-resource.openai.azure.com. */
      endpoint?: string;
      /** `api-version` query parameter. Defaults to a GA version, never a preview. */
      apiVersion?: string;
      /**
       * `[providers.azure-openai.deployments]` — model id → the deployment name
       * your resource actually has. Defaults to the model id itself, which is
       * what Azure's portal names a deployment by default.
       */
      deployments?: Record<string, string>;
    };
  };
  /** Unified metered-equivalent session ceiling. 0 or absent = unlimited. */
  cost?: { maxSessionUsd?: number };
  permissions: {
    defaultLevel: "auto" | "confirm" | "sandbox";
    rules: PermissionRule[];
    /**
     * The gear the session STARTS in — the persisted counterpart of the
     * Shift+Tab cycle ("shift up"):
     *   1 | "1"   — 1st gear: guided — ask before writes and commands (default)
     *   2 | "2"   — 2nd gear: workspace file edits proceed; commands still ask
     *   3 | "3"   — 3rd gear: also sandboxed commands and confined delegation
     *   4 | "4"   — 4th gear: full autonomy, no permission prompts
     *               (the OS sandbox is the separate [sandbox] switch)
     *   "auto"    — automatic: a separate classifier reviews risky actions
     * Ordinals ("3rd"), ids ("gear-3") and the legacy autonomy names are read
     * too. Explicit `--gear` / `--yolo` / `--trust` flags override this at
     * launch. Absent ⇒ 1st gear. Org policy can forbid gears regardless.
     */
    gear?: 1 | 2 | 3 | 4 | "1" | "2" | "3" | "4" | "auto" | (string & {});
    /**
     * LEGACY key (pre-rune). Still read when `rune` is absent. Historical
     * values: confirm → 1st gear; autonomy-i/ii/iii → 2nd/3rd/4th;
     * hands-free/turing → 4th; and the OLD meaning of "auto" (auto-approve
     * workspace work) → 3rd gear — never the classifier.
     */
    mode?:
      "confirm" | "autonomy-i" | "autonomy-ii" | "autonomy-iii" | "auto" | "hands-free" | "turing";
    /**
     * LEGACY storage flag for the old "workspace trust" (today's 3rd gear).
     * Read when neither `rune` nor `mode` is set.
     */
    trustWorkspace?: boolean;
    /**
     * Classifier-backed Auto mode. Semantic policy text shapes the isolated
     * reviewer; *Rules are mechanical tool/glob gates evaluated deny -> ask -> allow.
     */
    autoMode?: {
      enabled?: boolean;
      classifierProvider?: string;
      classifierModel?: string;
      environment?: string[];
      allow?: string[];
      softDeny?: string[];
      hardDeny?: string[];
      allowRules?: string[];
      askRules?: string[];
      denyRules?: string[];
      timeoutMs?: number;
      maxAutomaticDenials?: number;
      /**
       * Default true. `false` (reviewer outage = allow everything) is honored
       * only when the signed org policy permits fail-open (`autoMode.allowFailOpen`
       * or its own `failClosed = false`); otherwise it is ignored with a loud
       * one-time warning and reported in /status as `failOpenAllowed = false`.
       */
      failClosed?: boolean;
      /**
       * Default true. Screens UNTRUSTED-SOURCE tool results (web, MCP, browser,
       * shell stdout, webhooks) for prompt injection; workspace reads are never probed.
       */
      probeToolResults?: boolean;
      /**
       * Default true. Retry a failed reviewer call once — against the engine's
       * own heavy/standard tier when distinct from the pinned reviewer — before
       * failing closed. Stays within the session's existing data boundary.
       */
      reviewerFallback?: boolean;
      /**
       * Default true. The end-of-turn list of held steps is interactive: each
       * one can be approved ("run exactly this") or left unrun, per step.
       * `false` keeps the plain printed list.
       */
      heldStepPrompt?: boolean;
      /**
       * Default FALSE. Keep an encrypted local sidecar of the raw arguments
       * behind each safety decision (`~/.rune/auto-eval.db`, AES-256-GCM under
       * `~/.rune/auto-eval.key`), so recorded decisions can be replayed as
       * labelled eval scenarios.
       *
       * The audit log deliberately stores only `argsHash`, which is why the
       * decisions of 601 sessions could not be turned into a corpus. This is
       * the opt-in that makes them labellable. It never leaves the machine:
       * no telemetry path, no export, no black box reads it.
       */
      collectForEval?: boolean;
      /**
       * The out-of-band supervisor's scope. `all` screens every supervised
       * action with a background reviewer call; `unusual` (default) skips
       * recognized ordinary development work — builds, tests, installs,
       * linters, local git, containers — which the mechanical breakers have
       * already read; `off` disables the background supervisor entirely.
       */
      supervisor?: "all" | "unusual" | "off";
      /**
       * What Auto does with a shell command that will NOT run inside the OS
       * sandbox (sandbox off, an excluded command, or a fallback retry).
       * `review` (default): read-only commands run; anything else pays one
       * in-path reviewer call. `ask`: anything that is not read-only prompts.
       * `allow`: the mechanical breakers alone decide, as in 4th gear.
       */
      unsandboxedShell?: "review" | "ask" | "allow";
      /**
       * Extra read-only command patterns that join Auto's built-in safe tier
       * (`adb devices`, `emulator -list-avds`). Same glob/prefix grammar as
       * `[sandbox] excludedCommands`.
       */
      safeCommands?: string[];
    };
  };
  sandbox: {
    /** LEGACY on/off switch; `mode` wins when both are present. */
    enabled: boolean;
    /**
     * auto-allow (default): commands run in the OS sandbox and, because the
     * sandbox is the boundary, 3rd gear and Auto approve them without a prompt.
     * regular: same containment, but the gear's ordinary permission prompt
     * still applies. off: no sandbox — full host access, prompts as usual.
     */
    mode?: "auto-allow" | "regular" | "off";
    /**
     * The Overrides tab. true (default): a command that failed on a sandbox
     * restriction may be retried with `unsandboxed: true`, which runs on the
     * host under regular permissions. false: strict — every command runs
     * sandboxed unless it is listed in `excludedCommands`.
     */
    allowUnsandboxedFallback?: boolean;
    /**
     * Command patterns that always run OUTSIDE the sandbox (`adb *`,
     * `docker`). A pattern with `*` globs the whole segment; a bare name is a
     * command prefix. Excluded commands lose auto-allow along with the
     * walls, so the gear's ordinary permission decision applies to them.
     */
    excludedCommands?: string[];
    /** `[sandbox.filesystem]` — paths the profile denies or additionally allows. */
    filesystem?: {
      /** Denied for reading, on top of the built-in credential stores. */
      denyRead?: string[];
      /** Extra writable roots, on top of the workspace, Rune's cache and temp. */
      allowWrite?: string[];
      /** Denied for writing even inside an allowed root. */
      denyWrite?: string[];
    };
    networkDeny: boolean;
    fsAllowlist: string[];
    /**
     * Refuse sandbox-tier bash instead of degrading when this machine has no
     * OS isolation backend (sandbox-exec/bwrap). Default false: degraded runs
     * are allowed but lose auto-approval and are labelled honestly.
     */
    requireOs?: boolean;
  };
  /**
   * Language-server integration. `autoFeedback` attaches the language
   * server's errors and warnings for the touched file to every successful
   * write_file / edit_file / multi_edit / apply_patch result (2s budget, at
   * most 20 lines), so type errors are corrected in the same turn instead of
   * at the verifier.
   *
   * UNSET is not "off": it defaults ON for TypeScript and Python workspaces
   * whose server binary is on PATH, and off everywhere else. Set it to false
   * to turn it off for a project regardless of what is installed, or true to
   * force it on (Rust and Go included, which are excluded from the default
   * because their first publish usually lands after the 2s budget).
   */
  lsp?: {
    autoFeedback?: boolean;
  };
  /**
   * Loop recovery bounds — how many times the agent retries/waits/nudges
   * before giving up. Absent fields use per-model-family defaults
   * (orchestrator/reliability-policy.ts). All plain integers, e.g.
   * `[reliability] maxConsecutiveErrors = 5`.
   */
  reliability?: {
    maxConsecutiveErrors?: number;
    maxStuckNudges?: number;
    maxRateWaits?: number;
    maxOverflowCompactions?: number;
    maxEmptyCompletionRetries?: number;
    maxTruncationRetries?: number;
    maxVerifyAttempts?: number;
    readThrashCount?: number;
    editChurnCount?: number;
    maxPlanNudges?: number;
    maxReplanNudges?: number;
    maxStruggleNudges?: number;
    /**
     * The turn ceiling for a run of real work (default 80). A runaway guard,
     * not a work budget: long builds legitimately spend 30–50, and turns the
     * harness spends on itself are refunded (turn-refunds.ts).
     */
    maxTurns?: number;
    /**
     * How many times the ceiling may extend itself when the plan is open and
     * moving (default 2). 0 keeps the hard ceiling.
     */
    secondWinds?: number;
    /**
     * What the plan ledger does with a step closed on nothing. "attest" (the
     * default) accepts the completion, marks the step unproven, and tells the
     * model so in one line of fact. "refuse" sends the list back once, in one
     * line, and accepts the re-submission as unproven. Neither ever tells the
     * model to re-run anything: the ledger arguing with the model used to
     * write the transcript's worst sentences.
     */
    evidenceGate?: "attest" | "refuse";
  };
  /**
   * Tool execution settings.
   *
   * `rateLimit` is the tool pacer (tool-registry/rate-limiter.ts). Read-
   * category tools are never limited; a call over a limit is held for the
   * short remainder of its window rather than refused, and refused only when
   * the wait would exceed `maxWaitMs`. Defaults: 600 global, 120 per tool,
   * 60 bash, 60 write per minute, 5000 ms. `enabled = false` turns it off.
   */
  tools?: {
    rateLimit?: {
      enabled?: boolean;
      globalPerMinute?: number;
      perToolPerMinute?: number;
      bashPerMinute?: number;
      writePerMinute?: number;
      maxWaitMs?: number;
    };
  };
  /**
   * Which provider the gateway hands the work to when the active one fails
   * MID-TASK (`[fallback] order = ["anthropic", "codex"]`).
   *
   * Absent, the built-in capacity ranking decides: funded API keys, then
   * subscription seats, then free tiers, then local runtimes — so a capped
   * frontier session degrades as little as possible instead of landing on
   * whichever provider happened to register next. Names here are tried first,
   * in this order; providers left out are NOT excluded, they simply follow.
   */
  fallback?: {
    order?: string[];
    /**
     * Auto-resume the interactive session when a quota stop's retry window
     * passes (default true). `false` restores the old behavior: the run stays
     * stopped until the user sends something.
     */
    autoResume?: boolean;
    /**
     * What a plan/QUOTA cap does mid-task: "stop" (default) ends the run with
     * the retry window and keeps the work, rather than letting a weaker model
     * inherit an extensive task; "degrade" restores automatic downgrade.
     * Ordinary rate limits are unaffected — they clear in seconds.
     */
    onQuotaExceeded?: string;
    /**
     * Whether mid-task inference may move to a different provider/model at
     * all. "pin" (default): the model that started the task finishes it —
     * rate limits wait it out, caps stop with the resume window, and nothing
     * weaker ever inherits the work. "flex" restores the substitute chain
     * (capacity-ranked, labeled) for lineups that prefer a degraded answer
     * over a paused run. `[fallback] order` only matters under "flex".
     */
    modelIntegrity?: string;
  };
  /**
   * Sub-agent orchestration (`[subagents]`).
   *   mode = "auto"       (default) delegate freely, tier-routed
   *   mode = "off"        no sub-agents; one agent does everything itself
   *   mode = "configured" every sub-agent runs `model` ("provider/model" or a
   *                       model id on the session's provider) at `effort`
   *   mode = "mirror"     every sub-agent runs the session's exact model,
   *                       provider, and reasoning effort
   */
  subagents?: {
    mode?: string;
    /** "configured": the model sub-agents run — "provider/model" or a model id. */
    model?: string;
    /** "configured": sub-agent reasoning effort (none|minimal|low|medium|high|xhigh|max). */
    effort?: string;
    /**
     * How many sub-agents may run at once. Default 8, clamped to 1–16.
     *
     * This was a hard 8 in the agent loop with no key at all — a reasonable
     * default and an unreasonable ceiling, since eight concurrent heavy workers
     * is a lot of money at once and eight worktrees is a lot of disk on a small
     * machine. Zero is not accepted: "no delegation" is `mode = "off"`.
     */
    maxParallel?: number;
    /**
     * Default per-call ceilings for delegated work, overriding the per-effort
     * defaults. A sub-agent that hits one STOPS and returns what it has, the
     * same way it does on a turn limit — a budget must never destroy work.
     */
    costCapUsd?: number;
    deadlineMs?: number;
  };
  /**
   * Post-edit verification (`[verify]`). Auto-detection covers the common
   * stacks; `commands` overrides it with the project's own checks, e.g.
   * `[verify] commands = ["bun run lint", "bun test tests/unit/"]`.
   * These fields were previously ENGINE-ONLY — no config key, no flag — so a
   * user could not point verification at their real checks at all.
   */
  verify?: {
    /** Default true. Set false to skip post-edit verification entirely. */
    enabled?: boolean;
    /** Explicit check commands; when non-empty, auto-detection is skipped. */
    commands?: string[];
    /** Per-command timeout in seconds. Default 120. */
    timeoutSecs?: number;
    /**
     * Run the compile-class check (typecheck / cargo check / go build) when a
     * plan step that wrote files is closed without any check of its own.
     * Default true.
     */
    perStep?: boolean;
    /**
     * Per-ecosystem control (`[verify.ecosystems]`). Detection covers js, go,
     * python, rust and jvm (Java + Kotlin, which share gradle and maven, and
     * which `java` and `kotlin` both name). Each entry is either a bare
     * boolean or a table:
     *
     *   [verify.ecosystems]
     *   python = false                       # never run Python checks here
     *
     *   [verify.ecosystems.go]
     *   commands = ["go build -race ./..."]  # replace the detected Go set
     *
     * Unlisted ecosystems stay enabled. This is narrower than the top-level
     * `commands` override, which switches detection off entirely — useful when
     * one stack in a polyglot repo needs different treatment and the rest do
     * not.
     */
    ecosystems?: Record<string, boolean | { enabled?: boolean; commands?: string[] }>;
  };
  /**
   * Opt-in, transparent telemetry — the ONLY path by which anything leaves the
   * machine. Off by default; even `enabled = true` transmits nothing until BOTH
   * an `endpoint` is configured AND the local user has granted consent
   * (~/.rune/telemetry.json, set by the first-run prompt or `rune telemetry on`).
   * What ships is the already-redacted Black Box incident stream plus an
   * anonymous daily usage heartbeat — never file contents, never raw IPs, never
   * device fingerprints. `rune telemetry preview` prints the exact bytes.
   */
  telemetry: {
    /** Master switch / hard kill-switch. Default false. */
    enabled: boolean;
    /**
     * Collector URL that reports POST to. Empty/undefined ⇒ no network, ever —
     * this is the second half of the hard gate. Vendors bake their own
     * collector URL in here for shipped builds; users/enterprises can blank it.
     */
    endpoint?: string;
    /** Optional bearer token sent to the collector (shared secret). */
    token?: string;
    /** Send redacted crash/incident reports. Default true (only when enabled+consented). */
    crashReports?: boolean;
    /** Send the anonymous daily usage heartbeat. Default true (only when enabled+consented). */
    usageStats?: boolean;
  };
  checkpoint?: {
    enabled: boolean;
    intervalTurns: number;
    autoVerifyAudit: boolean;
  };
  search?: {
    /**
     * Preferred web_search engine: "auto" (answer order by rank) or any id from
     * SEARCH_PROVIDER_PRESETS — tavily, exa, brave, serper, perplexity,
     * firecrawl, jina, you, kagi, serpapi, searxng, duckduckgo. Keys are
     * connected with `/login` → Web search (or the engine's env var).
     */
    provider?: string;
    /** Use provider-native grounding (Gemini/Anthropic) when available. Default true. */
    nativeGrounding?: boolean;
  };
  /** Deep-research (`/research`) defaults. */
  research?: {
    /** Depth preset: quick | standard | deep. Default standard. */
    depth?: "quick" | "standard" | "deep";
    /** Investigate→reflect cycles (round 1 = the plan, later rounds fill gaps). */
    maxRounds?: number;
    /** Max sub-questions in a plan. */
    maxSubQuestions?: number;
    /** Max investigators run in parallel (keep modest for keyless DuckDuckGo). */
    maxParallel?: number;
    /** Max sources fetched per sub-question. */
    maxSourcesPerStep?: number;
    /** Skip the approve gate and run immediately. Default false. */
    autoApprove?: boolean;
    /** Save the finished report as a markdown file. Default true. */
    save?: boolean;
    /** Directory for saved reports. Default `<workspace>/.rune/research`. */
    outputDir?: string;
  };
  ui?: {
    /**
     * Default color theme name (see orchestrator ui/themes.ts). Used at startup unless
     * overridden by the RUNE_THEME env var or a runtime `/theme` choice (~/.rune/theme.json).
     */
    theme?: string;
  };
  /**
   * Model tiers — route work by weight instead of hardcoding one model.
   * Values are "model" (active provider) or "provider/model" (cross-provider),
   * e.g.  heavy = "anthropic/claude-opus-4-8", light = "deepseek/deepseek-chat".
   * heavy: hardest tasks · standard: main loop · light: sub-agents, compaction
   * summaries, and other internal utility calls.
   */
  tiers?: {
    heavy?: string;
    standard?: string;
    light?: string;
  };
  /**
   * `[routing]` — where Rune's OWN calls go, as opposed to the user's work.
   *
   * The compaction summarizer, the intent read and the sub-agent report repair
   * are completions nobody asked for, and they ran on the session model
   * because nothing had ever said otherwise. On a free tier — priced in
   * requests per minute, not dollars — that is the difference between a task
   * finishing and a 429; 45% of this agent's recorded incidents are rate
   * limits (measured 2026-09-07, 3,160 incidents).
   *
   * helper: "auto" (default) picks the cheapest healthy connected route;
   * "off"/"session" keeps the historical behaviour; "model" or
   * "provider/model" names one explicitly. Naming one explicitly ALSO lets it
   * answer Auto mode's safety questions — the automatic pick deliberately
   * never does, because a free model wrongly allowing a dangerous action is
   * worse than the mechanical containment that already backstops the reviewer.
   * The primary model path is untouched by all of this.
   */
  routing?: {
    helper?: string;
  };
  /**
   * System Memory ("dreaming") — Rune's evergreen, narrative profile of the user and the
   * codebases they work in, injected into the system prompt so even small models get cheap,
   * personalised context. Stored at ~/.rune/system-memory.md (see shared/system-memory.ts).
   */
  memory?: {
    /** Inject the memory into the system prompt. Default true. */
    enabled?: boolean;
    /**
     * Automatic-refresh cadence: `manual` (no auto refresh) | `daily` | `weekly` | `3d` (every
     * N days). A live choice via `/memory <cadence>` overrides this. Default `manual` — the
     * dream never spends credits until the user opts in.
     */
    schedule?: string;
    /**
     * Model used for the refresh distillation: `cheapest` (a cheap model on an available
     * provider) | `active` (the current chat model) | `"<provider>/<model>"`. Default `cheapest`.
     */
    model?: string;
    /** Hard cap on the memory size in tokens — keeps it butter-smooth for tiny models. Default 1500. */
    maxTokens?: number;
  };
  /**
   * Black box (flight recorder) — local incident capture to ~/.rune/blackbox.db:
   * every failure, degradation, and struggle, with trail forensics. Local-only;
   * nothing is ever transmitted. Default on.
   */
  diagnostics?: {
    enabled?: boolean;
  };
  /**
   * Tactics notebook (evolution loop) — learned facts/tactics from past
   * sessions, injected under a hard token budget. Capture is rule-based
   * (zero extra model spend). Default on; `rune --pristine` disables per run.
   */
  notebook?: {
    enabled?: boolean;
    /** Injection budget in tokens. Default 600. */
    maxInjectTokens?: number;
  };
  /**
   * Self-evolution. Every run writes a retro (outcome, steps by evidence,
   * checks, cost, lessons) into its session log and folds the lessons into the
   * notebook. `playbook` additionally renders the repository's recurring
   * lessons to .rune/skills/playbook/SKILL.md. Default true.
   */
  evolve?: {
    playbook?: boolean;
  };
  /**
   * Git integration. autoCommit: after every successful run that wrote files,
   * commit exactly those files as one revertible "rune:" commit; revert with
   * /undo. Default false.
   */
  git?: {
    autoCommit?: boolean;
  };
  /**
   * Context assembly. repoMap: include a bounded, request-aware structural
   * map as retrieval context so the model knows what exists without
   * exploratory turns. Default true (falls back to a tracked file tree).
   */
  context?: {
    repoMap?: boolean;
  };
  /**
   * Agent web browser. When enabled, Rune mounts the official Playwright
   * MCP server (bunx @playwright/mcp) as a built-in `browser` MCP server:
   * headless, isolated (fresh profile), accessibility-snapshot based.
   * `/browser on|off` toggles it at runtime and persists to
   * ~/.rune/browser.json; --browser/--no-browser force it for one run.
   * Default off.
   */
  browser?: {
    enabled?: boolean;
    /** Run headless (default true); set false to watch the browser work. */
    headless?: boolean;
    /** Browser: chromium (managed, default) | chrome | firefox | webkit | msedge. */
    browser?: string;
    /** Origins the browser may navigate to; everything else is blocked. */
    allowedOrigins?: string[];
    /** Origins the browser must never touch. */
    blockedOrigins?: string[];
  };
  /**
   * Interactive dashboards. auto: let the model decide on its own when an
   * answer deserves a live HTML dashboard (reports, metrics, comparisons).
   * Default false — dashboards are built only on explicit request
   * (/interactive). Runtime toggle: /interactive auto on|off.
   */
  interactive?: {
    auto?: boolean;
  };
  /**
   * Multi-instance teamwork (config.toml `[team]`). When several Rune
   * processes work in the same repository they register on a local shared
   * bus (~/.rune/team.db): each sees the others' presence and intent, can
   * message them, and can lease path claims. claimEnforcement decides what a
   * write into a PEER's claimed scope does: "warn" (default) lets it proceed
   * with a loud warning in the tool result, "block" refuses it, "off"
   * disables the check. Everything is local to this machine and user.
   */
  team?: {
    enabled?: boolean;
    claimEnforcement?: "warn" | "block" | "off";
    /** Presence heartbeat interval in seconds (default 15). */
    heartbeatSecs?: number;
  };
  /**
   * Staying current. `rune upgrade` is always explicit — nothing is ever
   * downloaded or replaced without the user typing the command. `check`
   * governs only the once-a-day background look at the latest release that
   * produces a one-line nag; set it false and Rune never talks to GitHub on
   * its own.
   */
  update?: {
    /** Daily startup check for a newer release. Default true. */
    check?: boolean;
    /** GitHub repo the releases come from. Default ritikkyyadav/Alan. */
    repo?: string;
  };
  /**
   * `rune serve` / `rune web` / `rune acp` — the supervisor that runs one
   * engine host per session.
   */
  serve?: {
    /**
     * How long a session host may sit with no connected client and no running
     * turn before the supervisor stops it (default 600 = ten minutes).
     *
     * Set it large if you routinely leave sessions parked overnight and want
     * them warm; the cost is one resident engine per session. Set it small on
     * a shared box. It does not affect a turn in flight: a host running a turn
     * is never idle, however long the turn takes.
     */
    idleHostSecs?: number;
  };
  /**
   * Connectors (config.toml `[mcp]`). Defaults for the MCP layer; every
   * individual server can still override its own behaviour in mcp.json.
   */
  mcp?: {
    /** Where `rune mcp add` writes when `--scope` is omitted (default workspace). */
    defaultScope?: "user" | "workspace";
    /** Per-request timeout in seconds for tools/call (default 30). */
    timeoutSecs?: number;
    /** Consult the public MCP registry when resolving a name (default true). */
    registry?: boolean;
    /**
     * Advertise connector tools as a one-line catalog with schemas loaded on
     * demand (default true). Set false to ship every schema on every request —
     * the pre-P4.1 behaviour, kept as an escape, not as a recommendation.
     */
    deferTools?: boolean;
  };
  /**
   * Third-party extensions (config.toml `[extensions]`). Plugins ship skills,
   * commands, MCP servers, hooks — and, since D6 v2, executable tools that run
   * as subprocesses under the OS sandbox with a declared capability.
   */
  extensions?: {
    /**
     * Load executable tools from `<workspace>/.rune/tools` (default false).
     * This is the user's OWN workspace only — never a path a plugin supplies.
     */
    localTools?: boolean;
    /**
     * Where `rune plugin search` / `rune plugin add <name>` resolve names.
     * A URL or a path; empty means the public index. `RUNE_PLUGIN_INDEX`
     * overrides it.
     */
    index?: string;
    /**
     * Run a plugin's executable tools even where this machine has no OS
     * sandbox (Windows, a mac without Seatbelt). `true` for every plugin, or a
     * list of plugin names. Default absent — a tool that cannot be contained
     * does not run, and the refusal names this setting.
     *
     * Turning it on means a third party's program runs with this user's full
     * access and its declared capability is not enforced. Rune says so at
     * startup, in the tool's own description, and in `[SECURITY]` logs.
     */
    allowUnsandboxedTools?: boolean | string[];
  };
}

export interface PermissionRule {
  tool: string;
  level: "auto" | "confirm" | "sandbox";
  pattern?: string;
  scope: "session" | "project" | "global";
}

// ─── Defaults ───

// Legacy RUNE_* env names are adopted before anything reads the environment.
adoptLegacyEnv();
const runeHome = getRuneHome();

const DEFAULT_CONFIG: RuneConfig = {
  engine: {
    socketPath: join(runeHome, "rune.sock"),
    logDir: join(runeHome, "logs"),
    dbPath: join(runeHome, "rune.db"),
    maxSessions: 50,
  },
  llm: {
    // Dev/test default = free tier (Gemini). Override via ~/.rune/config.toml,
    // <workspace>/.rune/config.toml, or RUNE_PROVIDER for production validation.
    defaultProvider: "google",
  },
  permissions: {
    defaultLevel: "confirm",
    rules: [],
    trustWorkspace: false,
  },
  sandbox: {
    enabled: true,
    networkDeny: true,
    fsAllowlist: [],
  },
  telemetry: {
    enabled: false,
  },
  search: {
    provider: "auto",
    nativeGrounding: true,
  },
  research: {
    depth: "standard",
    save: true,
  },
  memory: {
    enabled: true,
    schedule: "manual",
    model: "cheapest",
    maxTokens: 1500,
  },
  team: {
    enabled: true,
    claimEnforcement: "warn",
    heartbeatSecs: 15,
  },
  serve: {
    idleHostSecs: 600,
  },
  mcp: {
    defaultScope: "workspace",
    timeoutSecs: 30,
    registry: true,
    deferTools: true,
  },
  extensions: {
    localTools: false,
  },
};

// ─── TOML Parser (minimal, handles our config shape) ───

function parseToml(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let currentSection: Record<string, unknown> = result;
  let sectionPath: string[] = [];

  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;

    // Section header: [section] or [section.subsection]
    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      sectionPath = sectionMatch[1].split(".");
      currentSection = result;
      for (const key of sectionPath) {
        if (!(key in currentSection) || typeof currentSection[key] !== "object") {
          currentSection[key] = {};
        }
        currentSection = currentSection[key] as Record<string, unknown>;
      }
      continue;
    }

    // Key-value: key = value
    const kvMatch = line.match(/^(\w[\w-]*)?\s*=\s*(.+)$/);
    if (kvMatch) {
      const [, key, rawValue] = kvMatch;
      currentSection[key] = parseTomlValue(rawValue.trim());
    }
  }

  return result;
}

function parseTomlValue(raw: string): unknown {
  // String (double or single quoted)
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  // Boolean
  if (raw === "true") return true;
  if (raw === "false") return false;
  // Number
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  // Array (simple one-line)
  if (raw.startsWith("[") && raw.endsWith("]")) {
    const inner = raw.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((s) => parseTomlValue(s.trim()));
  }
  return raw;
}

// ─── Deep Merge ───

function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const sv = source[key];
    const tv = result[key];
    if (
      sv &&
      typeof sv === "object" &&
      !Array.isArray(sv) &&
      tv &&
      typeof tv === "object" &&
      !Array.isArray(tv)
    ) {
      result[key] = deepMerge(tv as Record<string, unknown>, sv as Record<string, unknown>);
    } else if (sv !== undefined) {
      result[key] = sv;
    }
  }
  return result;
}

// ─── Environment Variable Overlay ───

function applyEnvOverrides(config: Record<string, unknown>): void {
  const envMap: Record<string, (c: Record<string, unknown>) => void> = {
    RUNE_PROVIDER: (c) => setNested(c, "llm.defaultProvider", process.env.RUNE_PROVIDER!),
    RUNE_MODEL: (c) => {
      const provider = getDefaultProvider(c);
      setNested(c, `llm.${provider}.model`, process.env.RUNE_MODEL!);
    },
    RUNE_MAX_TOKENS: (c) =>
      setNested(c, `llm.${getDefaultProvider(c)}.maxTokens`, Number(process.env.RUNE_MAX_TOKENS!)),
    RUNE_DB_PATH: (c) => setNested(c, "engine.dbPath", process.env.RUNE_DB_PATH!),
    RUNE_SOCKET_PATH: (c) => setNested(c, "engine.socketPath", process.env.RUNE_SOCKET_PATH!),
    RUNE_LOG_DIR: (c) => setNested(c, "engine.logDir", process.env.RUNE_LOG_DIR!),
    RUNE_SANDBOX_ENABLED: (c) =>
      setNested(c, "sandbox.enabled", process.env.RUNE_SANDBOX_ENABLED === "true"),
    RUNE_SANDBOX_MODE: (c) => setNested(c, "sandbox.mode", process.env.RUNE_SANDBOX_MODE!),
    RUNE_SANDBOX_NETWORK: (c) =>
      setNested(c, "sandbox.networkDeny", process.env.RUNE_SANDBOX_NETWORK !== "allow"),
    RUNE_TRUST_WORKSPACE: (c) =>
      setNested(c, "permissions.trustWorkspace", process.env.RUNE_TRUST_WORKSPACE === "true"),
    RUNE_PERMISSION_MODE: (c) =>
      setNested(c, "permissions.mode", process.env.RUNE_PERMISSION_MODE!),
    // New-style: the gear itself (1|2|3|4|auto). `auto` here = the classifier.
    RUNE_GEAR: (c) => setNested(c, "permissions.gear", process.env.RUNE_GEAR!),
    RUNE_AUTO_CLASSIFIER_PROVIDER: (c) =>
      setNested(
        c,
        "permissions.autoMode.classifierProvider",
        process.env.RUNE_AUTO_CLASSIFIER_PROVIDER!,
      ),
    RUNE_AUTO_CLASSIFIER_MODEL: (c) =>
      setNested(c, "permissions.autoMode.classifierModel", process.env.RUNE_AUTO_CLASSIFIER_MODEL!),
    RUNE_AUTO_FAIL_CLOSED: (c) =>
      setNested(
        c,
        "permissions.autoMode.failClosed",
        process.env.RUNE_AUTO_FAIL_CLOSED !== "false",
      ),
    RUNE_TELEMETRY: (c) => setNested(c, "telemetry.enabled", process.env.RUNE_TELEMETRY === "true"),
    RUNE_TELEMETRY_ENDPOINT: (c) =>
      setNested(c, "telemetry.endpoint", process.env.RUNE_TELEMETRY_ENDPOINT!),
    RUNE_TELEMETRY_TOKEN: (c) => setNested(c, "telemetry.token", process.env.RUNE_TELEMETRY_TOKEN!),
    RUNE_SEARCH_BACKEND: (c) => setNested(c, "search.provider", process.env.RUNE_SEARCH_BACKEND!),
    RUNE_NATIVE_GROUNDING: (c) =>
      setNested(c, "search.nativeGrounding", process.env.RUNE_NATIVE_GROUNDING !== "false"),
    RUNE_RESEARCH_DEPTH: (c) => setNested(c, "research.depth", process.env.RUNE_RESEARCH_DEPTH!),
    RUNE_RESEARCH_MAX_ROUNDS: (c) =>
      setNested(c, "research.maxRounds", Number(process.env.RUNE_RESEARCH_MAX_ROUNDS!)),
    RUNE_RESEARCH_MAX_PARALLEL: (c) =>
      setNested(c, "research.maxParallel", Number(process.env.RUNE_RESEARCH_MAX_PARALLEL!)),
    RUNE_RESEARCH_MAX_SUBQUESTIONS: (c) =>
      setNested(c, "research.maxSubQuestions", Number(process.env.RUNE_RESEARCH_MAX_SUBQUESTIONS!)),
    RUNE_RESEARCH_AUTO_APPROVE: (c) =>
      setNested(c, "research.autoApprove", process.env.RUNE_RESEARCH_AUTO_APPROVE === "true"),
    RUNE_RESEARCH_SAVE: (c) =>
      setNested(c, "research.save", process.env.RUNE_RESEARCH_SAVE !== "false"),
    RUNE_MEMORY_ENABLED: (c) =>
      setNested(c, "memory.enabled", process.env.RUNE_MEMORY_ENABLED !== "false"),
    RUNE_MEMORY_SCHEDULE: (c) => setNested(c, "memory.schedule", process.env.RUNE_MEMORY_SCHEDULE!),
    RUNE_MEMORY_MODEL: (c) => setNested(c, "memory.model", process.env.RUNE_MEMORY_MODEL!),
    RUNE_MEMORY_MAX_TOKENS: (c) =>
      setNested(c, "memory.maxTokens", Number(process.env.RUNE_MEMORY_MAX_TOKENS!)),
    RUNE_TEAM: (c) => setNested(c, "team.enabled", process.env.RUNE_TEAM !== "false"),
    RUNE_TEAM_ENFORCEMENT: (c) =>
      setNested(c, "team.claimEnforcement", process.env.RUNE_TEAM_ENFORCEMENT!),
    RUNE_PLUGIN_INDEX: (c) => setNested(c, "extensions.index", process.env.RUNE_PLUGIN_INDEX!),
    ANTHROPIC_API_KEY: (c) => setNested(c, "llm.anthropic.apiKey", process.env.ANTHROPIC_API_KEY!),
    OPENAI_API_KEY: (c) => setNested(c, "llm.openai.apiKey", process.env.OPENAI_API_KEY!),
    OPENROUTER_API_KEY: (c) =>
      setNested(c, "llm.openrouter.apiKey", process.env.OPENROUTER_API_KEY!),
    GOOGLE_API_KEY: (c) => setNested(c, "llm.google.apiKey", process.env.GOOGLE_API_KEY!),
  };

  for (const [envVar, apply] of Object.entries(envMap)) {
    if (process.env[envVar]) {
      apply(config);
    }
  }
}

function getDefaultProvider(config: Record<string, unknown>): string {
  const llm = config.llm as Record<string, unknown> | undefined;
  return typeof llm?.defaultProvider === "string" ? llm.defaultProvider : "anthropic";
}

function setNested(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!(parts[i] in current) || typeof current[parts[i]] !== "object") {
      current[parts[i]] = {};
    }
    current = current[parts[i]] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
}

// ─── Config Loader ───

/**
 * Load Rune configuration with this precedence (later wins):
 * 1. Built-in defaults
 * 2. ~/.rune/config.toml (global)
 * 3. <workspace>/.rune/config.toml (project)
 * 4. RUNE_* environment variables
 */
export function loadConfig(workspaceRoot?: string): RuneConfig {
  let merged: Record<string, unknown> = JSON.parse(JSON.stringify(DEFAULT_CONFIG));

  // Global config (RUNE_CONFIG_PATH overrides ~/.rune/config.toml — see the writer).
  const globalConfig = globalConfigPath();
  if (existsSync(globalConfig)) {
    try {
      const text = readFileSync(globalConfig, "utf-8");
      merged = deepMerge(merged, parseToml(text));
    } catch {
      // Ignore malformed global config
    }
  }

  // Project config
  if (workspaceRoot) {
    const projectConfig = workspaceConfigPath(workspaceRoot, "config.toml");
    if (existsSync(projectConfig)) {
      try {
        const text = readFileSync(projectConfig, "utf-8");
        merged = deepMerge(merged, parseToml(text));
      } catch {
        // Ignore malformed project config
      }
    }
  }

  // Env overrides
  applyEnvOverrides(merged);

  return merged as unknown as RuneConfig;
}

// ─── Config Writer ───
// Persist a single setting back into config.toml so a change made at runtime
// (Shift+Tab, `/config`, or "shift to 4th gear" spoken in chat) survives
// the next launch. This is deliberately a LINE-ORIENTED editor, not a
// serialize-the-whole-object writer: it rewrites only the one key's line and
// leaves every comment, blank line, and unrelated key exactly as the user wrote
// them. The reader above stays the source of truth for precedence/merging.

export type ConfigScope = "global" | "project";

/** The config.toml path for a scope: global = ~/.rune, project = <root>/.rune. */
export function getConfigFilePath(scope: ConfigScope, workspaceRoot?: string): string {
  if (scope === "project") {
    if (!workspaceRoot) throw new Error("project config scope requires a workspaceRoot");
    return workspaceConfigPath(workspaceRoot, "config.toml");
  }
  // RUNE_CONFIG_PATH overrides the global file (tests + advanced setups); the
  // loader honors the same override so reader and writer never disagree.
  return globalConfigPath();
}

/** The effective global config.toml path (honors RUNE_CONFIG_PATH). */
function globalConfigPath(): string {
  return process.env.RUNE_CONFIG_PATH || join(getRuneHome(), "config.toml");
}

/** Render a JS value as a TOML scalar/array literal. */
function toTomlValue(value: string | number | boolean | string[]): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return `[${value.map((v) => tomlString(v)).join(", ")}]`;
  return tomlString(value);
}

/** Quote a string as a TOML basic string, escaping the essentials. */
function tomlString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Is this line the `[section.path]` header we're looking for? */
function isSectionHeader(line: string): string | null {
  const m = line.trim().match(/^\[([^\]]+)\]$/);
  return m ? m[1].trim() : null;
}

export interface SetConfigResult {
  /** The file that was written. */
  path: string;
  /** The value the key held before (undefined if it was newly added). */
  previousRaw?: string;
  /** Whether a brand-new key/section was created vs an in-place replace. */
  created: boolean;
}

/**
 * Set one dotted key (e.g. `permissions.mode`, `sandbox.enabled`) in a
 * config.toml, creating the file / section / key as needed and preserving
 * everything else byte-for-byte. The final path segment is the key; the rest is
 * the (possibly dotted) section. Returns what changed so callers can report it.
 */
export function setConfigValue(
  dottedKey: string,
  value: string | number | boolean | string[],
  opts: { scope?: ConfigScope; workspaceRoot?: string; preferExistingProject?: boolean } = {},
): SetConfigResult {
  const parts = dottedKey.split(".").filter(Boolean);
  if (parts.length < 2) {
    throw new Error(`config key must be "<section>.<key>" (got "${dottedKey}")`);
  }
  const key = parts[parts.length - 1]!;
  const section = parts.slice(0, -1).join(".");
  const rendered = toTomlValue(value);
  let scope = opts.scope ?? "global";
  if (opts.preferExistingProject && opts.workspaceRoot) {
    const projectPath = getConfigFilePath("project", opts.workspaceRoot);
    if (existsSync(projectPath)) {
      let existingValue: unknown = parseToml(readFileSync(projectPath, "utf8"));
      for (const part of parts) {
        existingValue =
          existingValue && typeof existingValue === "object"
            ? (existingValue as Record<string, unknown>)[part]
            : undefined;
      }
      if (existingValue !== undefined) scope = "project";
    }
  }
  const path = getConfigFilePath(scope, opts.workspaceRoot);

  const existing = existsSync(path) ? readFileSync(path, "utf-8") : "";
  const hadTrailingNewline = existing.endsWith("\n") || existing === "";
  const lines = existing === "" ? [] : existing.replace(/\n$/, "").split("\n");

  // Locate the target section's line range (header index → next-header index).
  let sectionStart = -1;
  let sectionEnd = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const hdr = isSectionHeader(lines[i]!);
    if (hdr === null) continue;
    if (sectionStart === -1 && hdr === section) {
      sectionStart = i;
    } else if (sectionStart !== -1) {
      sectionEnd = i;
      break;
    }
  }

  const keyLineRe = new RegExp(`^(\\s*)${escapeRegExp(key)}\\s*=`);
  let previousRaw: string | undefined;
  let created: boolean;

  if (sectionStart === -1) {
    // Section absent — append a fresh block at EOF.
    if (lines.length && lines[lines.length - 1]!.trim() !== "") lines.push("");
    lines.push(`[${section}]`);
    lines.push(`${key} = ${rendered}`);
    created = true;
  } else {
    // Search for the key within the section body.
    let keyLine = -1;
    for (let i = sectionStart + 1; i < sectionEnd; i++) {
      if (keyLineRe.test(lines[i]!)) {
        keyLine = i;
        break;
      }
    }
    if (keyLine === -1) {
      // Key absent — insert at the end of the section body (after the last
      // non-blank line so we don't strand it past trailing blanks).
      let insertAt = sectionEnd;
      while (insertAt - 1 > sectionStart && lines[insertAt - 1]!.trim() === "") insertAt--;
      lines.splice(insertAt, 0, `${key} = ${rendered}`);
      created = true;
    } else {
      const indent = lines[keyLine]!.match(/^(\s*)/)![1] ?? "";
      previousRaw = lines[keyLine]!.slice(indent.length + key.length)
        .replace(/^\s*=\s*/, "")
        .trim();
      lines[keyLine] = `${indent}${key} = ${rendered}`;
      created = false;
    }
  }

  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, lines.join("\n") + (hadTrailingNewline ? "\n" : ""));
  return { path, previousRaw, created };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
