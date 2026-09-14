// ─── First run: six steps, one ledger ───
//
// The founder's acceptance for Phase 4 is a sentence: *complete setup without
// editing a config file*. Choose a provider and a model, configure a key or a
// supported sign-in, configure internet access, pick a spend cap and a sandbox
// policy, prove the connection works, do a small task, change a setting,
// restart. Nothing here calls a model — this file reads and writes Rune's own
// configuration, and says so.
//
// It is deliberately a HEADLESS state machine with no terminal in it. The TUI
// paints `steps()` in the panel, `receipt` in the workspace and `question` in
// the composer; `tests/integration/fresh-home-onboarding.test.ts` walks the
// same object with no terminal at all. One implementation, two surfaces, and
// the surface that is tested is the one that runs.
//
// Three rules the rest of the file exists to keep:
//
//   1. **A secret never reaches a file it was not asked to reach.** The key is
//      probed from memory, stored by `storeSecret` (the credential store, i.e.
//      the system keychain), and everything that leaves this module carries
//      `maskSecret` — last four characters and nothing else. `config.toml`
//      never sees it, the receipt never sees it, and the probe's own response
//      body is redacted before it is quoted.
//   2. **Saved is not active.** `config.toml` is the lowest-precedence source.
//      A launch flag, an environment variable or a `/model` switch outranks it
//      for this session, so a step that writes the file may leave the running
//      session unchanged — and then it says `active != saved`, names the
//      source, and says a restart is required.
//   3. **A step that did not happen is still information.** Skipping leaves the
//      row in the ledger reading `not set`, never absent.

import {
  CUSTOM_PROVIDER_ID,
  apiKeyAccount,
  describeCredentialBackend,
  getPreset,
  getSearchPreset,
  loadConfig,
  loadSecrets,
  openCredentialStore,
  setConfigValue,
  setCustomEndpoint,
} from "@rune/shared";
import {
  CONFIG_SETTINGS,
  displaySettingValue,
  normalizeSettingValue,
  resolveSetting,
  settingTomlValue,
} from "./config-settings";
import { probeSearchBackend } from "@rune/tool-registry";

// ─── The six steps ───

export type SetupStepId = "provider" | "model" | "key" | "search" | "spend_cap" | "sandbox";

export type StepStatus = "pending" | "current" | "done" | "skipped";

/** Where a value in force actually came from. The order IS the precedence. */
export type ValueSource = "flag" | "env" | "session" | "config" | "default";

export interface SetupStep {
  id: SetupStepId;
  /** The panel's label. Nine cells, so the values line up in a column. */
  label: string;
  /** The composer's title while this step is the current one. */
  question: string;
  /** One quiet line under the question: what the answer is for. */
  hint: string;
  /** The dotted config.toml key this step persists to, when it has one. */
  tomlPath?: string;
  /** The `CONFIG_SETTINGS` key, when the step is one of the catalogued ones. */
  settingKey?: string;
  /** The answer is a secret: masked everywhere, and never written to config. */
  secret?: boolean;
  /** What the panel's value column reads before the step is answered. */
  empty: string;
}

/**
 * The order is the order the panel shows and the wizard walks. It is also the
 * dependency order: a model belongs to a provider, a key belongs to a provider,
 * and the last two are policy that applies whatever the first four chose.
 */
export const SETUP_STEPS: readonly SetupStep[] = [
  {
    id: "provider",
    label: "provider",
    question: "Which provider?",
    hint: "the host Rune sends work to",
    tomlPath: "llm.defaultProvider",
    empty: "not chosen",
  },
  {
    id: "model",
    label: "model",
    question: "Which model?",
    hint: "the model id on that provider",
    empty: "not chosen",
  },
  {
    id: "key",
    label: "key",
    question: "API key",
    hint: "stored by the OS, never in config.toml",
    secret: true,
    empty: "not configured",
  },
  {
    id: "search",
    label: "search",
    question: "Web search engine",
    hint: "auto, an engine id, or off",
    tomlPath: "search.provider",
    empty: "not configured",
  },
  {
    id: "spend_cap",
    label: "spend cap",
    question: "Spend cap for a session, in USD",
    hint: "a cap is a stop, not a failure: the run returns what it has",
    tomlPath: "cost.maxSessionUsd",
    settingKey: "budget",
    empty: "not set",
  },
  {
    id: "sandbox",
    label: "sandbox",
    question: "Sandbox policy",
    hint: "what a shell command is allowed to reach",
    tomlPath: "sandbox.mode",
    settingKey: "sandbox",
    empty: "not set",
  },
] as const;

/**
 * The whole of config precedence, in one line, because that is how much room
 * the panel has and how much of it anybody needs.
 */
export const CONFIG_PRECEDENCE = "flag > env > session > ~/.rune/config.toml";

/**
 * The same ladder, short enough for the 38-cell panel.
 *
 * Not a truncation: an elided `~/.rune/config.…` would be the one rung a reader
 * cannot guess, so the path is shortened to its filename instead and every rung
 * survives. 42 cells does not fit a 38-cell column, and drawing the frame is
 * how that was found.
 */
export const CONFIG_PRECEDENCE_SHORT = "flag > env > session > config.toml";

/** The widest form of the ladder that fits `width`, never a cut-off rung. */
export function precedenceLine(width: number): string {
  if (width >= CONFIG_PRECEDENCE.length) return CONFIG_PRECEDENCE;
  if (width >= CONFIG_PRECEDENCE_SHORT.length) return CONFIG_PRECEDENCE_SHORT;
  return "flag > env > session > file";
}

/**
 * Environment variables that outrank the file, per step. This mirrors
 * `applyEnvOverrides` in @rune/shared's config loader: when one of these is
 * set, writing the file changes what a LATER session sees and nothing else.
 */
const STEP_ENV: Partial<Record<SetupStepId, readonly string[]>> = {
  provider: ["RUNE_PROVIDER"],
  model: ["RUNE_MODEL"],
  search: ["RUNE_SEARCH_BACKEND"],
  sandbox: ["RUNE_SANDBOX_MODE", "RUNE_SANDBOX_ENABLED"],
};

// ─── Secrets, everywhere they are shown ───

/**
 * The two faces of the mask cell.
 *
 * The bullet is one cell on a UTF-8 terminal and mojibake on a seven-bit one,
 * and a masked key is the one string in the product where a replacement
 * character would read as part of the value — so the cell has an ASCII twin
 * like every mark in the closed set does.
 *
 * Which one is in force is the SURFACE's decision, passed in, never read here:
 * this module is on the engine side of the graph and `bin/ui` is where the
 * terminal's rung is resolved (`engine-graph-purity.test.ts` enforces the
 * direction, and it is right to — a state machine that knew what a terminal
 * was could not be walked by a test with no terminal in it). `stepMark` below
 * takes the rung as an argument for exactly the same reason.
 */
export const MASK_CELL_UTF8 = "•";
export const MASK_CELL_ASCII = ".";

/**
 * The one way a secret is ever rendered: eight dots and the last four
 * characters, which is enough to tell two keys apart and not enough to be one.
 * Anything shorter than five characters shows as dots alone — a four-character
 * key masked to its last four would be the key.
 */
export function maskSecret(secret: string, cell: string = MASK_CELL_UTF8): string {
  const k = secret.trim();
  if (k.length === 0) return "";
  if (k.length <= 4) return cell.repeat(Math.max(4, k.length));
  return `${cell.repeat(8)}${k.slice(-4)}`;
}

/**
 * A secret still being typed, masked whole.
 *
 * `maskSecret` shows a stored key's last four because it is showing you a key
 * you already have and the question is *which* one. A key being TYPED has no
 * last four — the last four is whatever was pressed a moment ago — so the live
 * field masks all of it, and it masks with the same cell so the two surfaces
 * do not read as two different kinds of hidden.
 */
export function maskLive(value: string, cell: string = MASK_CELL_UTF8): string {
  return cell.repeat(value.length);
}

/**
 * Remove a secret from text that is about to be shown or logged.
 *
 * The provider's own error body is the most useful half of a failed
 * validation — and some providers echo the key back inside it. Quoting it
 * verbatim would put the key in the transcript through the one path that looks
 * like honesty.
 */
export function redactSecret(textValue: string, secret?: string): string {
  if (!secret) return textValue;
  const k = secret.trim();
  if (k.length < 5) return textValue;
  let out = textValue.split(k).join(maskSecret(k));
  // Providers commonly echo a shortened form: `sk-…7f2a`.
  const tail = k.slice(-4);
  if (tail.length === 4) {
    out = out.replace(
      new RegExp(`${escapeRe(k.slice(0, 3))}[\\w-]*${escapeRe(tail)}`, "g"),
      maskSecret(k),
    );
  }
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─── Receipts ───

/**
 * What a step produced, in the shape §2.8 asks for: the request in the title
 * row, the evidence in the body, and a close row that says what state the world
 * is in now and what the user can do.
 *
 * Structured rather than pre-painted so the TUI can draw it in the workspace's
 * grammar and the test can assert on it without parsing ANSI.
 */
export interface StepReceipt {
  ok: boolean;
  /** `write ~/.rune/config.toml`, `check POST https://…` */
  title: string;
  /** The evidence. Already redacted. */
  body: string[];
  /** The close row: `key accepted - stored in the system keychain`. */
  close: string;
}

export interface ProbeResult {
  ok: boolean;
  /** HTTP status, or 0 when the request never got an answer. */
  status: number;
  statusText: string;
  ms: number;
  /** The host's own words, capped and redacted. */
  body: string;
  url: string;
}

export interface ProbeTarget {
  url: string;
  key?: string;
  timeoutMs?: number;
}

/**
 * One real request, reported exactly as it came back.
 *
 * `GET {baseUrl}/models` is the OpenAI-compatible listing every host in the
 * roster answers, it costs nothing, and it is the smallest request that proves
 * the three things the step claims: the host is reachable, the key is accepted,
 * and the transport is the one the session will use. It is NOT a model call —
 * no completion is requested and none is billed.
 */
export async function probeEndpoint(target: ProbeTarget): Promise<ProbeResult> {
  const started = Date.now();
  const url = target.url;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: target.key ? { authorization: `Bearer ${target.key}` } : {},
      signal: AbortSignal.timeout(target.timeoutMs ?? 10_000),
    });
    const raw = (await res.text()).slice(0, 400).replace(/\s+/g, " ").trim();
    return {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText || (res.ok ? "OK" : "error"),
      ms: Date.now() - started,
      body: redactSecret(raw, target.key).slice(0, 220),
      url,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      statusText: err instanceof Error ? err.message : String(err),
      ms: Date.now() - started,
      body: "",
      url,
    };
  }
}

// ─── The state machine ───

export interface StepState {
  id: SetupStepId;
  label: string;
  status: StepStatus;
  /** Already masked for a secret step; `step.empty` while unanswered. */
  value: string;
  /** `(default)`, `checking...`, or the reason a step was skipped. */
  note?: string;
  /** Set once the step has been answered and the file written. */
  restartRequired?: boolean;
}

export interface SavedActiveRow {
  label: string;
  saved: string;
  active: string;
  /** True when the session is not running what the file says. */
  differs: boolean;
  /** Which source won, when it is not the file. */
  source?: ValueSource;
}

export interface StepOutcome {
  ok: boolean;
  step: SetupStepId;
  receipt: StepReceipt;
  /** The file the value landed in, when one was written. */
  savedTo?: string;
  /** The running session took the change too. */
  appliedLive: boolean;
  /** The saved value will not be in force until a restart (and, when
   *  `shadowedBy` is set, not even then until that source is removed). */
  restartRequired: boolean;
  shadowedBy?: ValueSource;
  /** Why the step refused. Present only when `ok` is false. */
  error?: string;
}

export interface FirstRunDeps {
  /** Apply the answer to the RUNNING session. Absent ⇒ restart required. */
  applyLive?: (step: SetupStepId, canonical: string) => { ok: boolean; reason?: string };
  /** What the running session is actually using, for `saved` vs `active`. */
  activeValue?: (step: SetupStepId) => string | undefined;
  /** Where the secret goes. Defaults to the credential store via @rune/shared. */
  storeSecret?: (providerId: string, secret: string) => Promise<string> | string;
  /** The base URL to probe for a provider. Defaults to the preset's. */
  endpointFor?: (providerId: string) => string | undefined;
  probe?: (target: ProbeTarget) => Promise<ProbeResult>;
  probeSearch?: (
    providerId: string,
    secret: string,
  ) => Promise<{ ok: boolean; detail?: string; ms: number }>;
  setConfig?: (tomlPath: string, value: string | number | boolean) => { path: string };
  readSaved?: () => Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
  workspaceRoot?: string;
  /** A launch flag beats everything; the CLI passes what it parsed. */
  flags?: Partial<Record<SetupStepId, string>>;
  /** The cell a masked secret is drawn with. The surface decides — it is the
   *  only side of the graph that knows whether the terminal can draw a bullet.
   *  Defaults to the bullet, which is what a UTF-8 terminal gets. */
  maskCell?: string;
}

interface Answered {
  /** The canonical value as saved. For a secret, the secret itself — held only
   *  in memory, and never returned by any accessor. */
  canonical: string;
  display: string;
  status: StepStatus;
  note?: string;
  restartRequired: boolean;
}

/**
 * The wizard. One instance per run; `steps()` is safe to call on every frame.
 */
export class FirstRun {
  private readonly deps: FirstRunDeps;
  private readonly answers = new Map<SetupStepId, Answered>();
  private index = 0;
  private cancelled = false;
  /** Set while a probe is in flight, so the panel can say `checking...`. */
  private checking: SetupStepId | null = null;
  private child: "custom_endpoint" | "search_key" | null = null;
  private customBaseUrl: string | null = null;
  private searchProvider: string | null = null;

  constructor(deps: FirstRunDeps = {}) {
    this.deps = deps;
  }

  private get env(): NodeJS.ProcessEnv {
    return this.deps.env ?? process.env;
  }

  // -- position --

  current(): SetupStep | undefined {
    if (this.cancelled) return undefined;
    if (this.child === "custom_endpoint") {
      return {
        ...SETUP_STEPS[1]!,
        question: "Custom provider base URL",
        hint: "HTTPS, or HTTP on loopback (localhost / 127.0.0.1 / ::1)",
      };
    }
    if (this.child === "search_key") {
      const preset = this.searchProvider ? getSearchPreset(this.searchProvider) : undefined;
      return {
        ...SETUP_STEPS[3]!,
        question: `${preset?.label ?? this.searchProvider ?? "Search"} API key`,
        hint: "checked with one test search, then stored by the OS",
        secret: true,
      };
    }
    return SETUP_STEPS[this.index];
  }

  /** `2 of 6` — the panel's heading receipt. */
  heading(): string {
    return `${Math.min(this.index + 1, SETUP_STEPS.length)} of ${SETUP_STEPS.length}`;
  }

  done(): boolean {
    return this.cancelled || this.index >= SETUP_STEPS.length;
  }

  wasCancelled(): boolean {
    return this.cancelled;
  }

  /** The cell this run masks secrets with, for the surfaces that mask a value
   *  this object never sees — the composer's live field, while a key is still
   *  being typed. */
  maskCell(): string {
    return this.deps.maskCell ?? MASK_CELL_UTF8;
  }

  /** Start the ledger again for `/setup` without changing anything already saved. */
  reset(): void {
    this.answers.clear();
    this.index = 0;
    this.cancelled = false;
    this.checking = null;
    this.child = null;
    this.customBaseUrl = null;
    this.searchProvider = null;
  }

  /**
   * Leave the wizard where it stands. Everything already saved stays saved —
   * this writes nothing and undoes nothing, which is the only behaviour that
   * makes `esc` safe to press.
   */
  cancel(): void {
    this.cancelled = true;
  }

  /** Move past the current step without answering it. The row stays. */
  skip(reason = "skipped"): void {
    if (this.child === "search_key") {
      this.child = null;
      this.searchProvider = null;
      return;
    }
    if (this.child === "custom_endpoint") {
      this.child = null;
      this.customBaseUrl = null;
      for (const step of [SETUP_STEPS[1]!, SETUP_STEPS[2]!]) {
        this.answers.set(step.id, {
          canonical: "",
          display: step.empty,
          status: "skipped",
          note: reason,
          restartRequired: false,
        });
      }
      this.index = 3;
      return;
    }
    const step = this.current();
    if (!step) return;
    this.answers.set(step.id, {
      canonical: "",
      display: step.empty,
      status: "skipped",
      note: reason,
      restartRequired: false,
    });
    this.index += 1;
  }

  // -- the ledger the panel paints --

  steps(): StepState[] {
    return SETUP_STEPS.map((step, i) => {
      const answered = this.answers.get(step.id);
      if (answered) {
        return {
          id: step.id,
          label: step.label,
          status: this.child === "search_key" && step.id === "search" ? "current" : answered.status,
          value: answered.display,
          note: this.checking === step.id ? "checking..." : answered.note,
          restartRequired: answered.restartRequired,
        };
      }
      const status: StepStatus = this.cancelled
        ? "pending"
        : this.child === "search_key" && i === this.index
          ? "pending"
          : i === this.index
            ? "current"
            : "pending";
      return {
        id: step.id,
        label: step.label,
        status,
        value: step.empty,
        note: this.checking === step.id ? "checking..." : undefined,
      };
    });
  }

  /**
   * The ledger's last row. `undefined` when nothing set needs a restart, which
   * is the common case and deserves no row at all.
   */
  restartNote(): string | undefined {
    const pending = this.steps().filter((s) => s.restartRequired);
    if (pending.length === 0) return undefined;
    return `${pending.map((s) => s.label).join(", ")} — restart required`;
  }

  /** The ladder, at the width the caller has. `Infinity` gives the full line. */
  precedenceLine(width = Number.POSITIVE_INFINITY): string {
    return precedenceLine(width);
  }

  // -- saved vs active --

  /**
   * Two columns, and they are identical unless something outranks the file.
   *
   * `saved` is read from `~/.rune/config.toml` alone — what a brand-new process
   * would start with if nothing else were set. `active` is what this session is
   * actually using. The difference, when there is one, is the whole point.
   */
  savedVsActive(): SavedActiveRow[] {
    const saved = this.savedConfig();
    return SETUP_STEPS.filter((s) => !s.secret).map((step) => {
      const savedValue = this.savedValueFor(step, saved);
      const activeValue = this.deps.activeValue?.(step.id) ?? savedValue;
      const winner = this.sourceFor(step.id);
      const differs = savedValue !== activeValue;
      return {
        label: step.label,
        saved: savedValue || step.empty,
        active: activeValue || step.empty,
        differs,
        source: differs ? winner : undefined,
      };
    });
  }

  /**
   * Which source is in force for a step. The ladder is fixed and is the same
   * one `CONFIG_PRECEDENCE` states; nothing here invents an ordering.
   */
  sourceFor(id: SetupStepId): ValueSource {
    if (this.deps.flags?.[id]) return "flag";
    for (const name of STEP_ENV[id] ?? []) {
      if (this.env[name]) return "env";
    }
    const answered = this.answers.get(id);
    const active = this.deps.activeValue?.(id);
    if (answered && active !== undefined && active !== answered.canonical) return "session";
    return "config";
  }

  private savedConfig(): Record<string, unknown> {
    if (this.deps.readSaved) return this.deps.readSaved();
    try {
      return loadConfig(this.deps.workspaceRoot) as unknown as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  private savedValueFor(step: SetupStep, saved: Record<string, unknown>): string {
    if (step.id === "model") {
      const provider = String(readPath(saved, "llm.defaultProvider") ?? "");
      const model = provider ? readPath(saved, `llm.${provider}.model`) : undefined;
      return model === undefined ? "" : String(model);
    }
    if (!step.tomlPath) return "";
    const raw = readPath(saved, step.tomlPath);
    if (raw === undefined || raw === null) return "";
    if (step.settingKey) {
      const setting = resolveSetting(step.settingKey);
      if (setting) return displaySettingValue(setting, String(raw));
    }
    return String(raw);
  }

  // -- answering --

  /**
   * Answer the current step.
   *
   * The order inside is load-bearing for the key step: probe FIRST, from
   * memory, and store only on a 2xx. A rejected key must leave the machine
   * exactly as it found it — no keychain entry, no config line, nothing to
   * clean up and nothing to mislead the next launch.
   */
  async answer(raw: string): Promise<StepOutcome> {
    const step = this.current();
    if (!step) {
      return {
        ok: false,
        step: "provider",
        appliedLive: false,
        restartRequired: false,
        error: "the wizard has no current step",
        receipt: { ok: false, title: "setup", body: [], close: "nothing to answer" },
      };
    }
    const value = raw.trim();
    if (this.child === "custom_endpoint") return this.answerCustomEndpoint(value);
    if (this.child === "search_key") return this.answerSearchKey(value);
    if (value === "") {
      this.skip("not set");
      return {
        ok: true,
        step: step.id,
        appliedLive: false,
        restartRequired: false,
        receipt: {
          ok: true,
          title: `skip ${step.label}`,
          body: [],
          close: `${step.label} left ${step.empty} · /config ${step.settingKey ?? step.id} sets it later`,
        },
      };
    }
    const out = step.secret
      ? await this.answerSecret(step, value)
      : await this.answerPlain(step, value);
    if (out.ok && step.id === "provider" && value === CUSTOM_PROVIDER_ID) {
      this.child = "custom_endpoint";
    } else if (out.ok && step.id === "search") {
      const preset = getSearchPreset(value);
      if (preset?.envVar) {
        this.searchProvider = value;
        this.child = "search_key";
      }
    }
    return out;
  }

  private async answerCustomEndpoint(value: string): Promise<StepOutcome> {
    const step = SETUP_STEPS[1]!;
    if (!value) return this.refusal(step, "a custom provider needs a base URL");
    const error = validateCustomBaseUrl(value);
    if (error) return this.refusal(step, error);
    this.customBaseUrl = value.replace(/\/+$/, "");
    this.child = null;
    return {
      ok: true,
      step: "model",
      appliedLive: false,
      restartRequired: false,
      receipt: {
        ok: true,
        title: `check custom endpoint ${this.customBaseUrl}`,
        body: ["URL accepted; the models endpoint is checked with the key step"],
        close: "endpoint held in memory · enter the model id",
      },
    };
  }

  private async answerSearchKey(secret: string): Promise<StepOutcome> {
    const step = SETUP_STEPS[3]!;
    const providerId = this.searchProvider;
    if (!providerId) return this.refusal(step, "no search engine is selected");
    if (!secret) {
      this.child = null;
      this.searchProvider = null;
      return {
        ok: true,
        step: "search",
        appliedLive: false,
        restartRequired: false,
        receipt: {
          ok: true,
          title: `skip key for ${providerId}`,
          body: [],
          close: `${providerId} saved without a key · connect it later with /login`,
        },
      };
    }
    this.checking = "search";
    let result: { ok: boolean; detail?: string; ms: number };
    try {
      if (this.deps.probeSearch) result = await this.deps.probeSearch(providerId, secret);
      else {
        const preset = getSearchPreset(providerId)!;
        const probeEnv = { ...this.env, [preset.envVar!]: secret };
        result = await probeSearchBackend(providerId, probeEnv);
      }
    } catch (err) {
      result = {
        ok: false,
        detail: redactSecret(err instanceof Error ? err.message : String(err), secret),
        ms: 0,
      };
    } finally {
      this.checking = null;
    }
    if (!result.ok) {
      return {
        ok: false,
        step: "search",
        appliedLive: false,
        restartRequired: false,
        error: redactSecret(result.detail ?? "search validation failed", secret),
        receipt: {
          ok: false,
          title: `test search with ${providerId}`,
          body: [redactSecret(result.detail ?? "no result", secret)],
          close: "search key rejected · nothing was saved · enter to retry",
        },
      };
    }
    let where: string;
    try {
      where = await this.store(providerId, secret);
    } catch (err) {
      return this.refusal(
        step,
        redactSecret(err instanceof Error ? err.message : String(err), secret),
      );
    }
    const preset = getSearchPreset(providerId)!;
    if (preset.envVar) this.env[preset.envVar] = secret;
    this.child = null;
    this.searchProvider = null;
    return {
      ok: true,
      step: "search",
      appliedLive: true,
      restartRequired: false,
      receipt: {
        ok: true,
        title: `test search with ${providerId}`,
        body: [`answered in ${result.ms} ms`],
        close: `search key accepted · stored in ${where}, not in config.toml or the transcript`,
      },
    };
  }

  private async answerPlain(step: SetupStep, value: string): Promise<StepOutcome> {
    // A catalogued setting is validated by the catalogue, so `/config`, the
    // model's `update_config` tool and this wizard cannot disagree about what
    // "on" means or what a legal budget is.
    let canonical = value;
    let display = value;
    if (step.settingKey) {
      const setting = resolveSetting(step.settingKey);
      if (!setting) {
        return this.refusal(step, `unknown setting "${step.settingKey}"`);
      }
      const norm = normalizeSettingValue(setting, value);
      if ("error" in norm) return this.refusal(step, norm.error);
      canonical = norm.value;
      display = displaySettingValue(setting, canonical);
    }
    if (step.id === "provider" && !getPreset(value) && value !== CUSTOM_PROVIDER_ID) {
      return this.refusal(step, `"${value}" is not a known provider`);
    }
    if (step.id === "search" && value !== "auto" && value !== "off" && !getSearchPreset(value)) {
      return this.refusal(step, `"${value}" is not a known search engine`);
    }

    const tomlPath = this.tomlPathFor(step);
    let savedTo: string | undefined;
    if (tomlPath) {
      const setting = step.settingKey ? resolveSetting(step.settingKey) : undefined;
      const literal = setting ? settingTomlValue(setting, canonical) : canonical;
      try {
        savedTo = this.writeConfig(tomlPath, literal).path;
      } catch (err) {
        return this.refusal(step, err instanceof Error ? err.message : String(err));
      }
    }

    if (step.id === "model" && this.customBaseUrl) {
      try {
        setCustomEndpoint({ baseUrl: this.customBaseUrl, model: canonical, key: "local" });
      } catch (err) {
        return this.refusal(step, err instanceof Error ? err.message : String(err));
      }
    }

    const live = this.deps.applyLive?.(step.id, canonical);
    const appliedLive = live?.ok === true;
    const shadowedBy = this.shadow(step.id);
    const restartRequired = !appliedLive || shadowedBy !== undefined;

    this.answers.set(step.id, {
      canonical,
      display,
      status: "done",
      note: restartRequired ? "restart required" : undefined,
      restartRequired,
    });
    this.index += 1;

    return {
      ok: true,
      step: step.id,
      savedTo,
      appliedLive,
      restartRequired,
      shadowedBy,
      receipt: {
        ok: true,
        title: savedTo ? `write ${savedTo}` : `set ${step.label}`,
        body: tomlPath ? [`${tomlPath} = ${renderLiteral(canonical, step)}`] : [],
        close: this.closeRow(step, display, appliedLive, shadowedBy, live?.reason),
      },
    };
  }

  private async answerSecret(step: SetupStep, secret: string): Promise<StepOutcome> {
    const providerId = this.answers.get("provider")?.canonical || CUSTOM_PROVIDER_ID;
    const url = this.deps.endpointFor?.(providerId) ?? defaultEndpoint(providerId);
    if (!url) {
      // No HTTP endpoint to ask. Say that rather than claim a check happened.
      let where: string;
      try {
        where = await this.store(providerId, secret);
      } catch (err) {
        return this.refusal(
          step,
          redactSecret(err instanceof Error ? err.message : String(err), secret),
        );
      }
      this.answers.set(step.id, {
        canonical: secret,
        display: maskSecret(secret, this.maskCell()),
        status: "done",
        note: "unverified",
        restartRequired: false,
      });
      this.index += 1;
      return {
        ok: true,
        step: step.id,
        appliedLive: true,
        restartRequired: false,
        receipt: {
          ok: true,
          title: `store key for ${providerId}`,
          body: [`${providerId} has no listing endpoint to probe`],
          close: `key stored in ${where} · unverified until the first message`,
        },
      };
    }

    this.checking = step.id;
    let probe: ProbeResult;
    try {
      probe = await (this.deps.probe ?? probeEndpoint)({ url, key: secret });
    } catch (err) {
      probe = {
        ok: false,
        status: 0,
        statusText: redactSecret(err instanceof Error ? err.message : String(err), secret),
        ms: 0,
        body: "",
        url,
      };
    } finally {
      this.checking = null;
    }

    if (!probe.ok) {
      // Nothing is saved. The machine is exactly as it was before the paste.
      //
      // `probe.status === 0` is probeEndpoint()'s own shape for "no HTTP
      // answer at all" -- a closed port, a DNS failure, a timeout -- never a
      // provider's verdict on the key. Reusing "key rejected" for that case
      // told a wrong-host user to go check their key, which is not the fact
      // on screen: two different problems calling for two different next
      // actions must not render the same close line.
      const unreachable = probe.status === 0;
      return {
        ok: false,
        step: step.id,
        appliedLive: false,
        restartRequired: false,
        error: `${probe.status || "no answer"} ${probe.statusText}`,
        receipt: {
          ok: false,
          title: `check GET ${url}`,
          body: [
            probe.status ? `${probe.status} ${probe.statusText}` : probe.statusText,
            ...(probe.body ? [probe.body] : []),
          ],
          close: unreachable
            ? "can't reach the host · nothing was saved · enter to retry"
            : "key rejected · nothing was saved · enter to retry",
        },
      };
    }

    let where: string;
    try {
      where = await this.store(providerId, secret);
    } catch (err) {
      return this.refusal(
        step,
        redactSecret(err instanceof Error ? err.message : String(err), secret),
      );
    }
    const live = this.deps.applyLive?.(step.id, secret);
    this.answers.set(step.id, {
      canonical: secret,
      display: maskSecret(secret, this.maskCell()),
      status: "done",
      note: undefined,
      restartRequired: false,
    });
    this.index += 1;
    return {
      ok: true,
      step: step.id,
      appliedLive: live?.ok !== false,
      restartRequired: false,
      receipt: {
        ok: true,
        title: `check GET ${url}`,
        body: [`${probe.status} ${probe.statusText} · ${probe.ms} ms`],
        close: `key accepted · stored in ${where}, not in config.toml and not in the transcript`,
      },
    };
  }

  /** The masked form of the stored key, for the panel and the status strip. */
  maskedKey(): string | undefined {
    const answered = this.answers.get("key");
    return answered && answered.status === "done" ? answered.display : undefined;
  }

  // -- internals --

  private async store(providerId: string, secret: string): Promise<string> {
    if (this.deps.storeSecret) return await this.deps.storeSecret(providerId, secret);
    const store = await openCredentialStore({ env: this.env });
    await store.set(apiKeyAccount(providerId), secret);
    return describeCredentialBackend(store);
  }

  private tomlPathFor(step: SetupStep): string | undefined {
    if (step.id === "model") {
      const provider = this.answers.get("provider")?.canonical;
      return provider ? `llm.${provider}.model` : undefined;
    }
    return step.tomlPath;
  }

  private writeConfig(tomlPath: string, literal: string | number | boolean): { path: string } {
    if (this.deps.setConfig) return this.deps.setConfig(tomlPath, literal);
    return setConfigValue(tomlPath, literal, {
      scope: "global",
      workspaceRoot: this.deps.workspaceRoot,
    });
  }

  /** The source outranking the file for this step, if any. */
  private shadow(id: SetupStepId): ValueSource | undefined {
    if (this.deps.flags?.[id]) return "flag";
    for (const name of STEP_ENV[id] ?? []) {
      if (this.env[name]) return "env";
    }
    return undefined;
  }

  private closeRow(
    step: SetupStep,
    display: string,
    appliedLive: boolean,
    shadowedBy?: ValueSource,
    reason?: string,
  ): string {
    if (shadowedBy) {
      const which = shadowedBy === "flag" ? "a launch flag" : this.envName(step.id);
      return `${step.label} = ${display} saved · ${which} outranks the file · ${CONFIG_PRECEDENCE}`;
    }
    if (!appliedLive) {
      return `${step.label} = ${display} saved · restart required${reason ? ` — ${reason}` : ""}`;
    }
    return `${step.label} = ${display} · saved and in effect now`;
  }

  private envName(id: SetupStepId): string {
    const names = (STEP_ENV[id] ?? []).filter((n) => this.env[n]);
    return names.length ? `the environment (${names.join(", ")})` : "the environment";
  }

  private refusal(step: SetupStep, why: string): StepOutcome {
    return {
      ok: false,
      step: step.id,
      appliedLive: false,
      restartRequired: false,
      error: why,
      receipt: {
        ok: false,
        title: `set ${step.label}`,
        body: [why],
        close: `nothing was saved · ${step.hint}`,
      },
    };
  }
}

// ─── Helpers shared with the terminal ───

/** `llm.defaultProvider` → the value at that path, or undefined. */
function readPath(root: Record<string, unknown>, dotted: string): unknown {
  let cur: unknown = root;
  for (const part of dotted.split(".")) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function renderLiteral(canonical: string, step: SetupStep): string {
  if (step.settingKey) {
    const setting = resolveSetting(step.settingKey);
    if (setting) {
      const v = settingTomlValue(setting, canonical);
      return typeof v === "string" ? `"${v}"` : String(v);
    }
  }
  return `"${canonical}"`;
}

/** The OpenAI-compatible listing endpoint for a provider, when it has one. */
export function defaultEndpoint(providerId: string): string | undefined {
  if (providerId === CUSTOM_PROVIDER_ID) {
    const base = loadSecrets().custom?.baseUrl;
    return base ? `${base.replace(/\/+$/, "")}/models` : undefined;
  }
  const preset = getPreset(providerId);
  const base = preset?.baseUrl;
  if (!base) return undefined;
  return `${base.replace(/\/+$/, "")}/models`;
}

/** Remote custom providers require TLS; plain HTTP is limited to loopback development servers. */
export function validateCustomBaseUrl(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "enter a complete endpoint URL, including https://";
  }
  if (url.username || url.password) return "credentials must not be embedded in the endpoint URL";
  if (url.protocol === "https:") return undefined;
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "::1" ||
    /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  if (url.protocol === "http:" && loopback) return undefined;
  return "remote custom endpoints must use HTTPS; HTTP is allowed only on loopback";
}

/**
 * Connect the one user-defined OpenAI-compatible endpoint — the route the
 * wizard uses for a local server, and the only one a test can drive without
 * spending money. Separate from `FirstRun` because it is a provider choice and
 * a model choice at once.
 */
export function connectCustomEndpoint(opts: {
  baseUrl: string;
  model: string;
  key?: string;
  label?: string;
}): void {
  setCustomEndpoint({
    baseUrl: opts.baseUrl,
    model: opts.model,
    // The gateway registers the custom slot only with a non-empty key; a
    // keyless local server gets a placeholder it will ignore.
    key: opts.key?.trim() || "local",
    label: opts.label ?? "Local server",
  });
}

/**
 * Every setting reachable from `/config`, as the picker needs them: the
 * catalogue plus the count, so a window that cannot show all of them can say
 * how many it is not showing rather than silently ending the list.
 */
export function settingsReachableCount(): number {
  return CONFIG_SETTINGS.length;
}

/** The picker's heading and footnote, both carrying the total row count. */
export interface SettingsPickerChrome {
  title: string;
  footnote: string;
}

/**
 * `/config`'s heading and footnote.
 *
 * A 24-row window fits seventeen of the picker's rows; the other five were
 * simply absent, with nothing on screen saying the list continued (frame
 * `80x24-settings-open`, 2026-09-10 -- the same failure `/help` was fixed for
 * in 8c4c58f). The list has always scrolled. What was missing is the counted
 * elision that says so, and the heading is the one row that survives every
 * width, so that is where the total goes.
 */
export function settingsPickerChrome(shortcutRows: number): SettingsPickerChrome {
  const rows = shortcutRows + settingsReachableCount();
  return {
    title: `Settings (${rows} rows)`,
    footnote: `Up/down reaches all ${rows}. Changes apply now and are saved.`,
  };
}

// ─── The no-provider splash ───

/** One `export NAME="your-key"` row, split so the caller can colour the parts. */
export interface KeyHintRow {
  /** `export GOOGLE_API_KEY=` — the part that is a command. */
  assign: string;
  /** `"your-key"` — the part that is a placeholder. */
  value: string;
  /** Spaces to the shared comment column. */
  pad: string;
  /** `# free tier — recommended`. */
  comment: string;
}

const KEY_HINTS: readonly (readonly [string, string])[] = [
  ["GOOGLE_API_KEY", "free tier — recommended"],
  ["OPENROUTER_API_KEY", "free models available"],
  ["ANTHROPIC_API_KEY", "Claude models"],
  ["OPENAI_API_KEY", "GPT models"],
] as const;

/**
 * The rows of the "No API keys configured" gate, with the comment column
 * COMPUTED from the longest assignment rather than hand-counted.
 *
 * It was hand-counted, and one of the four was a space short — the `#` column
 * read 45, 45, 45, 44 in the 2026-09-10 pty capture. A column that four
 * string literals have to agree on by eye is a column that drifts the next time
 * a provider is added; measuring it is both the fix and the guarantee.
 */
export function noKeysHintRows(): KeyHintRow[] {
  const value = '"your-key"';
  const assign = (env: string) => `export ${env}=`;
  const col = Math.max(...KEY_HINTS.map(([env]) => assign(env).length + value.length)) + 3;
  return KEY_HINTS.map(([env, note]) => ({
    assign: assign(env),
    value,
    pad: " ".repeat(col - assign(env).length - value.length),
    comment: `# ${note}`,
  }));
}

// ─── The panel's text ───
//
// Plain strings, no colour: the ledger's CONTENT is a fact about the run and
// the TUI's job is only to paint it. Keeping the text here is what lets the
// integration test assert that a resize does not change the ledger — the rows
// are a pure function of `steps()` and a width, and `steps()` does not know
// what a column is.

/** The mark column: done, current, skipped, not yet reached. */
export function stepMark(status: StepStatus, ascii = false): string {
  if (status === "done") return ascii ? "+" : "✓";
  if (status === "current") return ascii ? ">" : "›";
  if (status === "skipped") return ascii ? "-" : "·";
  return " ";
}

const LABEL_COLS = Math.max(...SETUP_STEPS.map((s) => s.label.length));

/**
 * One ledger row: mark, label in a fixed column, value, then the note.
 *
 * The value is elided from the right with a counted marker rather than being
 * dropped, because a panel that silently shortens a model id is a panel that
 * cannot be trusted about the one it shows in full.
 */
export function ledgerRow(state: StepState, width: number, ascii = false): string {
  const head = `${stepMark(state.status, ascii)} ${state.label.padEnd(LABEL_COLS)}  `;
  const note = state.note ? `  ${state.note}` : "";
  const room = Math.max(4, width - head.length - note.length);
  const value = state.value.length > room ? `${state.value.slice(0, room - 1)}…` : state.value;
  return `${head}${value}${note}`;
}

/** The whole ledger, heading excluded: one row per step, in order. */
export function ledgerRows(states: StepState[], width: number, ascii = false): string[] {
  return states.map((s) => ledgerRow(s, width, ascii));
}

/**
 * The saved-vs-active block: a two-column head, one row per comparable step,
 * and one sentence saying what the reader is looking at. A row that differs is
 * the only one that carries a source, and it says which source won.
 */
export function savedActiveRows(rows: SavedActiveRow[], width: number): string[] {
  const labelW = Math.max(...rows.map((r) => r.label.length), 8);
  const col = Math.max(6, Math.floor((width - labelW - 4) / 2));
  const cell = (v: string) => (v.length > col ? `${v.slice(0, col - 1)}…` : v.padEnd(col));
  // The label column carries a heading rather than `labelW` blanks. A run of
  // leading spaces is an indent to everything that reads a rendered row -- the
  // three-rung ladder the TUI enforces, a copy-paste, a screen reader -- and a
  // caller that strips it to satisfy that ladder silently pulls this row out of
  // alignment with the two columns underneath it. A word cannot be stripped.
  const out = [`${"setting".padEnd(labelW)}  ${"saved".padEnd(col)}  active`];
  for (const r of rows) {
    out.push(`${r.label.padEnd(labelW)}  ${cell(r.saved)}  ${cell(r.active).trimEnd()}`);
  }
  const differing = rows.filter((r) => r.differs);
  out.push("");
  if (differing.length === 0) {
    out.push("nothing differs. a session override");
    out.push("would show here and say so.");
  } else {
    for (const r of differing) {
      // `config` is the file, so "config outranks the file" is a sentence that
      // says nothing -- and it is the sentence a real session produces whenever
      // a value in force came from a default rather than from an override. That
      // case gets the two facts and no causal claim; the ladder line below
      // already says how a winner is picked. (Reachable the moment the wizard
      // paints this table, which nothing did until §2.8 was wired up.)
      out.push(
        r.source && r.source !== "config"
          ? `${r.label}: ${r.source} outranks the file`
          : `${r.label}: in force ${r.active}, in the file ${r.saved}`,
      );
    }
    out.push(precedenceLine(width));
  }
  // No row may cross the column's edge. The two-column head is built to the
  // width; the sentences below it are prose, and prose is what overruns.
  return out.map((line) => (line.length > width ? `${line.slice(0, width - 1)}…` : line));
}
