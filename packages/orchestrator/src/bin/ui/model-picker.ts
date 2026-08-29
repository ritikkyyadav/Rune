// --- /model tree picker -- pure data + line rendering ---
// The clutter fix for many providers x many models: /model navigates a tree
// instead of dumping one flat list.
//
//   Level 1 | providers   -- only the ones actually configured (key, endpoint,
//                           or active), plus local runtimes (discoverable).
//   Level 2 | accounts    -- the real access paths for the chosen provider:
//                           saved key, env key, local endpoint, custom
//                           endpoint. Skipped when only one path exists.
//   Level 3 | models      -- what's reachable under that account: live-listed
//                           from local runtimes (/api/tags, /models), the
//                           curated preset list otherwise. A plain number
//                           switches this session; `d<n>` sets the startup
//                           default (~/.gear/model.json).
//
// Everything here is pure (no readline, no engine): the CLI feeds it status
// rows and prints the lines it returns, so every level is unit-testable.

import type { ProviderPreset, CustomEndpoint, LastModel } from "@gear/shared";
import { CUSTOM_PROVIDER_ID, maskKey } from "@gear/shared";
import type { ProviderStatusRow } from "../../provider-registry";
import { text, muted, faint, accent, info, warn, ok } from "./theme";
import { glyph } from "./glyphs";

// -- Level 1: providers --

export interface ProviderChoice {
  id: string;
  label: string;
  /** Themed one-glance state: `o active | key saved`, `localhost:11434`, ... */
  hint: string;
  local?: boolean;
}

/**
 * The providers worth showing: anything with a usable access path (key saved,
 * env key, custom endpoint), every local runtime (reachable without a key --
 * kept discoverable), and whatever is currently active. Disabled providers
 * (`/providers off`) stay hidden unless active. Active first, then cloud in
 * preset order, then local, then the custom endpoint.
 */
export function providerChoices(
  rows: ProviderStatusRow[],
  custom: CustomEndpoint | undefined,
  env: NodeJS.ProcessEnv = process.env,
  presetFor: (id: string) => ProviderPreset | undefined = () => undefined,
): ProviderChoice[] {
  const eligible = rows.filter((r) => {
    if (r.id === CUSTOM_PROVIDER_ID) return !!custom && (!r.disabled || r.active);
    if (r.disabled && !r.active) return false;
    return r.hasKey || r.local || r.active;
  });

  const hintFor = (r: ProviderStatusRow): string => {
    const bits: string[] = [];
    if (r.active) bits.push(ok(`${glyph("live")} active`));
    if (r.id === CUSTOM_PROVIDER_ID && custom) {
      bits.push(muted(`${hostOf(custom.baseUrl)} | ${custom.model}`));
    } else if (r.local) {
      bits.push(muted(hostOf(r.endpoint ?? "")));
    } else if (r.source === "oauth") {
      bits.push(ok("oauth | signed in") + (r.keyCount > 0 ? faint(" | +keys") : ""));
    } else if (r.source === "keychain") {
      bits.push(muted(`key | keychain ${r.masked}`.trim()));
    } else if (r.source === "saved") {
      const preset = presetFor(r.id);
      const envAlso = preset?.envVar && env[preset.envVar];
      bits.push(
        muted(`key saved ${r.masked}`) +
          (r.keyCount > 1 ? faint(` | ${r.keyCount} keys`) : "") +
          (envAlso ? faint(" | +env") : ""),
      );
    } else if (r.source === "env") {
      bits.push(muted(`key env ${presetFor(r.id)?.envVar ?? ""}`.trim()));
    }
    return bits.join(faint(" | "));
  };

  const order = (r: ProviderStatusRow): number =>
    r.active ? 0 : r.id === CUSTOM_PROVIDER_ID ? 3 : r.local ? 2 : 1;

  return eligible
    .slice()
    .sort((a, b) => order(a) - order(b))
    .map((r) => ({
      id: r.id,
      label: r.id === CUSTOM_PROVIDER_ID ? (custom?.label ?? "Custom endpoint") : r.label,
      hint: hintFor(r),
      ...(r.local ? { local: true } : {}),
    }));
}

// -- Level 2: accounts / endpoints --

export interface AccountChoice {
  kind: "oauth" | "keychain" | "key" | "env" | "endpoint" | "custom";
  label: string;
  detail: string;
  /** For kind "key": the pool entry to make active when selected. */
  entryId?: string;
  /** True when this is the credential the gateway actually uses right now. */
  active?: boolean;
}

/**
 * The real access paths for one provider, in wire-precedence order: the
 * signed-in OAuth / keychain credential (what BYOP resolved), then every
 * stored API key in the pool (selecting one makes it the active key), then
 * the env var. The tree skips this level when only one path exists.
 */
export function accountChoices(
  preset: ProviderPreset | undefined,
  row: ProviderStatusRow,
  custom: CustomEndpoint | undefined,
  env: NodeJS.ProcessEnv = process.env,
): AccountChoice[] {
  if (row.id === CUSTOM_PROVIDER_ID) {
    if (!custom) return [];
    return [
      {
        kind: "custom",
        label: custom.label ?? "Custom endpoint",
        detail: `${custom.baseUrl} | ${custom.model}`,
        active: true,
      },
    ];
  }
  if (row.local) {
    return [
      { kind: "endpoint", label: "Local endpoint", detail: row.endpoint ?? "", active: true },
    ];
  }

  const out: AccountChoice[] = [];

  // The BYOP secure-store credential the gateway resolved (OAuth login or a
  // keychain-held key) -- always the one on the wire when present.
  if (row.source === "oauth" || row.source === "keychain") {
    out.push({
      kind: row.source,
      label: row.source === "oauth" ? "OAuth account" : "API key | keychain",
      detail:
        row.source === "oauth"
          ? row.authMethod === "device"
            ? "signed in | device flow"
            : "signed in"
          : row.masked || "secure store",
      active: true,
    });
  }

  // The stored key pool (multi-account), or the single legacy saved key.
  if (row.savedKeys.length > 0) {
    for (const k of row.savedKeys) {
      out.push({
        kind: "key",
        label: k.label ? `API key | ${k.label}` : "API key",
        detail: `${k.masked}${k.addedAt ? ` | added ${k.addedAt.slice(0, 10)}` : ""}`,
        entryId: k.id,
        active: row.source === "saved" && k.active,
      });
    }
  } else if (row.source === "saved") {
    out.push({ kind: "key", label: "API key | saved", detail: row.masked, active: true });
  }

  const envKey = preset?.envVar ? env[preset.envVar] : undefined;
  if (envKey) {
    out.push({
      kind: "env",
      label: "API key | env",
      detail: `${preset!.envVar} ${maskKey(envKey)}`,
      active: row.source === "env",
    });
  }
  return out;
}

// -- Level 3: models --

export interface ModelChoice {
  id: string;
  label: string;
  current: boolean;
  isDefault: boolean;
}

export interface ModelChoiceOpts {
  /** Live-listed ids (local runtimes); null/undefined -> fall back to the preset list. */
  live?: string[] | null;
  custom?: CustomEndpoint;
  current: { provider: string; model: string };
  def: LastModel | null;
}

/** The models offered under one provider+account, with current/default marks. */
export function modelChoices(
  preset: ProviderPreset | undefined,
  providerId: string,
  opts: ModelChoiceOpts,
): ModelChoice[] {
  let base: { id: string; label: string }[];
  if (providerId === CUSTOM_PROVIDER_ID) {
    base = opts.custom ? [{ id: opts.custom.model, label: opts.custom.model }] : [];
  } else if (opts.live && opts.live.length > 0) {
    base = opts.live.map((id) => ({ id, label: id }));
  } else {
    base = preset?.models ?? [];
  }
  return base.map((m) => ({
    id: m.id,
    label: m.label,
    current: opts.current.provider === providerId && opts.current.model === m.id,
    isDefault: opts.def?.provider === providerId && opts.def?.model === m.id,
  }));
}

/**
 * Live model listing for local runtimes -- what this endpoint can actually
 * serve, matching the tree's "only what's available under the selected
 * account" rule. Ollama speaks `/api/tags`; LM Studio (openai-compat) speaks
 * `GET {base}/models`. Best-effort: unreachable/odd hosts -> null (the caller
 * falls back to the curated list). Never throws.
 */
export async function fetchLiveModels(
  kind: ProviderPreset["kind"],
  baseUrl: string,
  timeoutMs = 1500,
): Promise<string[] | null> {
  const base = baseUrl.replace(/\/+$/, "");
  const url =
    kind === "ollama" ? `${base}/api/tags` : kind === "openai-compat" ? `${base}/models` : null;
  if (!url) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      models?: { name?: string }[]; // ollama /api/tags
      data?: { id?: string }[]; // openai-compat /v1/models
    };
    const names =
      kind === "ollama"
        ? (body.models ?? []).map((m) => m.name).filter((n): n is string => !!n)
        : (body.data ?? []).map((m) => m.id).filter((n): n is string => !!n);
    return names.length > 0 ? names : null;
  } catch {
    return null;
  }
}

// -- Line rendering (shared by every level) --

function hostOf(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

/** `current |||||| openai/gpt-5` readout rows for the tree header. */
export function treeHeadline(
  current: { provider: string; model: string },
  def: LastModel | null,
): string[] {
  const rows = [
    `  ${muted("CURRENT")} ${faint("||||")} ${info(`${current.provider}/${current.model}`)}`,
  ];
  if (def)
    rows.push(
      `  ${muted("DEFAULT")} ${faint("||||")} ${text(`${def.provider}/${def.model}`)} ${accent(glyph("phase"))}`,
    );
  return rows;
}

export function formatProviderLine(n: number, c: ProviderChoice): string {
  const pad = c.hint ? "  " : "";
  return `    ${warn(`[${n}]`)} ${text(c.label)}${pad}${c.hint}`;
}

export function formatAccountLine(n: number, a: AccountChoice): string {
  const mark = a.active ? ` ${ok(glyph("live"))}` : "";
  return `    ${warn(`[${n}]`)} ${text(a.label)}  ${muted(a.detail)}${mark}`;
}

export function formatModelLine(n: number, m: ModelChoice): string {
  const marks = [
    m.current ? ` ${ok("< current")}` : "",
    m.isDefault ? ` ${accent(`${glyph("phase")} default`)}` : "",
  ].join("");
  const id = m.label !== m.id ? `  ${faint(m.id)}` : "";
  return `    ${warn(`[${n}]`)} ${text(m.label)}${id}${marks}`;
}
