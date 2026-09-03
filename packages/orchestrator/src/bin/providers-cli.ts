// ─── `gear providers` / `gear use` / `gear models` ───
// Non-interactive provider surfaces, dispatched standalone like telemetry/doctor.
//   providers — list every provider, its auth method, and credential status
//   use        — set the active provider (+ optional model) in ~/.gear/model.json
//   models     — live model discovery for a provider, cached for an hour, with
//                the curated preset as the fallback (`--refresh` forces a call)

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
  loadCachedModels,
  saveCachedModels,
  cachedModelsAge,
  describeAge,
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
      // A cloud-chain credential has no secret and no keychain entry — what is
      // worth printing is WHERE the cloud chain found it ("profile default"),
      // which `meta.detail` carries and which is never the credential itself.
      const src =
        cred.meta?.method === "chain"
          ? (cred.meta.detail ?? "cloud credentials")
          : (cred.meta?.source ?? (method === "oauth" ? "oauth" : "saved"));
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

/**
 * Where a catalogue came from — the one thing this command must not blur.
 *
 * "live" is what the provider says it serves right now; "cached" is what it
 * said within the last hour; "curated" is the preset, which is a
 * hand-maintained list and therefore the one that can be wrong. Printing which
 * of the three you are looking at is the whole difference between a list you
 * can act on and a list you have to verify.
 */
type CatalogueSource = "live" | "cached" | "curated";

export async function runModels(args: string[]): Promise<void> {
  const refresh = args.includes("--refresh");
  const positional = args.filter((a) => !a.startsWith("-"));
  const config = loadConfig(process.cwd());
  const secrets = loadSecrets();
  const active = activeProvider(config);
  const providerId = positional[0] ?? active;

  const preset = getPreset(providerId);
  if (!preset) {
    out(danger(`Unknown provider "${providerId}".`));
    out(dim(`Known: ${PROVIDER_PRESETS.map((p) => p.id).join(", ")}`));
    process.exitCode = 1;
    return;
  }

  const staticModels: ModelInfo[] = (preset.models ?? []).map((m) => ({
    id: m.id,
    label: m.label,
  }));

  let models = staticModels;
  let source: CatalogueSource = "curated";
  let age: number | null = null;
  let failure: string | null = null;

  // An hour-old catalogue is served without a round trip. Model lineups change
  // on the order of weeks; a command people run to LOOK at a list should not
  // pay a network call every time.
  const cached = refresh ? null : loadCachedModels(providerId);
  if (cached?.length) {
    models = cached.map((m) => ({ id: m.id, ...(m.label ? { label: m.label } : {}) }));
    source = "cached";
    age = cachedModelsAge(providerId);
  } else {
    const { savedKeys, credentials } = await resolveAll(config, secrets, providerId);
    const gw = buildGateway({
      provider: providerId as ProviderName,
      keys: savedKeys,
      credentials,
      customEndpoint: secrets.custom,
      disabled: new Set(secrets.disabled ?? []),
      localBaseUrls: mergeLocalBaseUrls(config, secrets),
      routes: config.providers,
    });
    const provider = gw.getProvider(providerId as ProviderName);
    if (provider?.listModels) {
      try {
        const discovered = await provider.listModels();
        if (discovered.length) {
          models = discovered;
          source = "live";
          saveCachedModels(providerId, discovered);
        }
      } catch (err) {
        // Fall back to the curated list, and SAY WHY. A silent fallback is how
        // someone spends ten minutes wondering why their new deployment is
        // missing from a list that quietly stopped asking.
        failure = err instanceof Error ? err.message : String(err);
      }
    }
  }

  const suffix =
    source === "live"
      ? "  (live)"
      : source === "cached"
        ? `  (cached${age !== null ? ` · ${describeAge(age)}` : ""})`
        : "  (curated — sign in for live discovery)";
  out(bold(text(`${preset.label} models`)) + faint(suffix));
  if (failure) out(dim(`live discovery unavailable: ${firstLine(failure)}`));
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
  if (source === "cached")
    out(faint("Refresh with ") + info(`gear models ${providerId} --refresh`));
}

/** One line of an error, bounded — a stack trace is not a status line. */
function firstLine(message: string): string {
  return (message.split("\n")[0] ?? message).slice(0, 160);
}
