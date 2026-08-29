// ─── `gear providers` / `gear use` / `gear models` ───
// Non-interactive provider surfaces, dispatched standalone like telemetry/doctor.
//   providers — list every provider, its auth method, and credential status
//   use        — set the active provider (+ optional model) in ~/.gear/model.json
//   models     — live model discovery for a provider, with static fallback

import {
  loadConfig,
  loadSecrets,
  getPreset,
  getProviderDescriptor,
  PROVIDER_PRESETS,
  CUSTOM_PROVIDER_ID,
  openCredentialStore,
  loadLastModel,
  saveLastModel,
  describeCredentialBackend,
  type GearConfig,
  type SecretsFile,
} from "@gear/shared";
import type { ProviderName, ModelInfo, ResolvedCredential } from "@gear/llm-gateway";
import { buildGateway, resolveProviderCredentials } from "../provider-registry";
import { bold, danger, dim, faint, info, ok, text, warn } from "./ui/theme";
import { buildSavedKeys, readAuthOverrides, insecureNoticeLine } from "./byop-cli-shared";

const pad = "  ";
const out = (line = "") => process.stdout.write(`${pad}${line}\n`);

/** Active provider = last-used sidecar, else the configured default. */
function activeProvider(config: GearConfig): string {
  return loadLastModel()?.provider ?? config.llm.defaultProvider;
}

function mergeLocalBaseUrls(config: GearConfig, secrets: SecretsFile): Record<string, string> {
  const o: Record<string, string> = {};
  if (config.llm.ollama?.baseUrl) o.ollama = config.llm.ollama.baseUrl;
  if (config.llm.lmstudio?.baseUrl) o.lmstudio = config.llm.lmstudio.baseUrl;
  for (const [id, url] of Object.entries(secrets.endpoints ?? {})) if (url) o[id] = url;
  return o;
}

async function resolveAll(config: GearConfig, secrets: SecretsFile, active: string) {
  const store = await openCredentialStore();
  const savedKeys = buildSavedKeys(config, secrets);
  const credentials = await resolveProviderCredentials({
    store,
    keys: savedKeys,
    active: active as ProviderName,
    disabled: new Set(secrets.disabled ?? []),
    localBaseUrls: mergeLocalBaseUrls(config, secrets),
    authOverrides: readAuthOverrides(config),
  });
  return { store, savedKeys, credentials };
}

// ─── gear providers ───

export async function runProviders(): Promise<void> {
  const config = loadConfig(process.cwd());
  const secrets = loadSecrets();
  const active = activeProvider(config);
  const { store, credentials } = await resolveAll(config, secrets, active);

  out(bold(text("Providers")) + faint(`   credentials: ${describeCredentialBackend(store)}`));
  const insecure = insecureNoticeLine(store);
  if (insecure) out(warn(insecure));
  out();

  for (const preset of PROVIDER_PRESETS) {
    const d = getProviderDescriptor(preset.id)!;
    const isActive = preset.id === active;
    const marker = isActive ? ok("●") : faint("○");
    const cred = credentials[preset.id];
    const method = cred?.meta?.method ?? d.auth[0];
    let status: string;
    if (preset.local) {
      const endpoint = mergeLocalBaseUrls(config, secrets)[preset.id] ?? preset.baseUrl ?? "";
      status = faint(`local · ${endpoint}`);
    } else if (cred) {
      const src = cred.meta?.source ?? (method === "oauth" ? "oauth" : "saved");
      status = ok(`signed in · ${src}`);
    } else {
      status = dim("—");
    }
    // Pad BEFORE styling: ANSI escapes count toward padEnd, so padding the
    // styled string misaligns the columns — and under NO_COLOR (no escapes)
    // any styled-width compensation misaligns them the other way.
    const name = (isActive ? (s: string) => bold(text(s)) : text)(preset.label.padEnd(22));
    out(`${marker} ${name} ${faint(method.padEnd(8))} ${status}`);
  }
  out();
  out(
    faint("Sign in with ") +
      info("gear login <provider>") +
      faint(" · switch with ") +
      info("gear use <provider>"),
  );
}

// ─── gear use ───

export async function runUse(args: string[]): Promise<void> {
  const providerId = args[0];
  const modelArg = args[1];
  if (!providerId) {
    out(warn("Usage: ") + info("gear use <provider> [model]"));
    out(faint("Providers: ") + PROVIDER_PRESETS.map((p) => p.id).join(", "));
    process.exitCode = 1;
    return;
  }
  const preset = getPreset(providerId);
  if (!preset && providerId !== CUSTOM_PROVIDER_ID) {
    out(danger(`Unknown provider "${providerId}".`));
    out(dim(`Known: ${PROVIDER_PRESETS.map((p) => p.id).join(", ")}`));
    process.exitCode = 1;
    return;
  }
  const model = modelArg ?? preset?.defaultModel ?? loadLastModel()?.model ?? "";
  saveLastModel({ provider: providerId, model });
  out(ok(`✓ Active provider set to ${bold(text(preset?.label ?? providerId))}`));
  out(`${faint("model")} ${info(model)}  ${faint("(next `gear` session uses this)")}`);
}

// ─── gear models ───

export async function runModels(args: string[]): Promise<void> {
  const config = loadConfig(process.cwd());
  const secrets = loadSecrets();
  const active = activeProvider(config);
  const providerId = args[0] ?? active;

  const preset = getPreset(providerId);
  if (!preset) {
    out(danger(`Unknown provider "${providerId}".`));
    out(dim(`Known: ${PROVIDER_PRESETS.map((p) => p.id).join(", ")}`));
    process.exitCode = 1;
    return;
  }

  const { savedKeys, credentials } = await resolveAll(config, secrets, providerId);
  const gw = buildGateway({
    provider: providerId as ProviderName,
    keys: savedKeys,
    credentials,
    customEndpoint: secrets.custom,
    disabled: new Set(secrets.disabled ?? []),
    localBaseUrls: mergeLocalBaseUrls(config, secrets),
  });

  const provider = gw.getProvider(providerId as ProviderName);
  const staticModels: ModelInfo[] = (preset.models ?? []).map((m) => ({
    id: m.id,
    label: m.label,
  }));

  let models = staticModels;
  let live = false;
  if (provider?.listModels) {
    try {
      const discovered = await provider.listModels();
      if (discovered.length) {
        models = discovered;
        live = true;
      }
    } catch {
      // fall back to the curated preset list
    }
  }

  out(
    bold(text(`${preset.label} models`)) +
      faint(live ? "  (live)" : "  (curated — sign in for live discovery)"),
  );
  out();
  if (models.length === 0) {
    out(dim("No models to show. Pull/load one, or check credentials."));
    return;
  }
  for (const m of models) {
    const label = m.label && m.label !== m.id ? faint(`  ${m.label}`) : "";
    out(`${info(providerId + "/" + m.id)}${label}`);
  }
  out();
  out(
    faint("Use one with ") +
      info(`gear use ${providerId} <model>`) +
      faint(" or ") +
      info(`gear -m ${providerId}/<model>`),
  );
}
