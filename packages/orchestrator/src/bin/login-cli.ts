// ─── `rune login`: authenticate a provider (API key / OAuth / device / local) ───
// The one place interactive authentication runs. It picks a provider + method,
// builds an AuthContext with real browser/prompt hooks, runs the strategy's
// authenticate(), and persists to the secure credential store. Mirrors the
// standalone dispatch of `telemetry`/`doctor` — no Engine boot.
//
// Two rosters answer to it: model providers (`rune login mistral`) and
// web-search engines (`rune login exa`). An engine takes the same API-key
// strategy and the same keychain account, then proves the key with one real
// search instead of a format check.

import {
  loadConfig,
  loadSecrets,
  getPreset,
  getProviderDescriptor,
  getSearchPreset,
  keyedSearchPresets,
  PROVIDER_PRESETS,
  SEARCH_PROVIDER_PRESETS,
  setLocalEndpoint,
  savePrefs,
  openCredentialStore,
  migrateLegacySecrets,
  saveLastModel,
  apiKeyAccount,
  oauthAccount,
  authMethodLabel,
  accountLoginLabel,
  type AuthMethod,
} from "@rune/shared";
import { getStrategy, AuthError, type AuthContext } from "@rune/llm-gateway";
import { probeSearchBackend } from "@rune/tool-registry";
import { bold, danger, dim, faint, info, ok, text, warn } from "./ui/theme";
import { glyph } from "./ui/glyphs";
import {
  buildSavedKeys,
  readAuthOverrides,
  insecureNoticeLine,
  openBrowser,
  promptLine,
  isInteractive,
} from "./byop-cli-shared";

const pad = "  ";
const log = (line = "") => process.stdout.write(`${pad}${line}\n`);

export async function runLogin(
  positionals: string[],
  values: Record<string, unknown> = {},
): Promise<void> {
  const methodArg = typeof values.method === "string" ? values.method : undefined;
  const noBrowser = values["no-browser"] === true;

  const config = loadConfig(process.cwd());
  const secrets = loadSecrets();
  const store = await openCredentialStore();

  const insecure = insecureNoticeLine(store);
  if (insecure) log(warn(insecure));

  // `rune login --migrate` — copy legacy secrets.json keys into the secure store.
  if (values.migrate === true) {
    const result = await migrateLegacySecrets(store);
    if (result.migrated === 0) log(dim("No legacy API keys needed migrating."));
    else
      log(
        ok(
          `Migrated ${result.migrated} key(s) into ${store.backend}: ${result.providerIds.join(", ")}`,
        ),
      );
    return;
  }

  // Resolve the target provider (arg, or interactive picker).
  let providerId: string | undefined = positionals[0];
  if (!providerId) {
    if (!isInteractive()) {
      printUsage();
      return;
    }
    providerId = await pickProvider();
    if (!providerId) return;
  }

  const searchPreset = getSearchPreset(providerId);
  if (searchPreset) {
    await loginSearch(searchPreset, store, noBrowser);
    return;
  }

  const preset = getPreset(providerId);
  const descriptor = getProviderDescriptor(providerId);
  if (!preset || !descriptor) {
    log(danger(`Unknown provider "${providerId}".`));
    log(dim(`Models: ${PROVIDER_PRESETS.map((p) => p.id).join(", ")}`));
    log(dim(`Search: ${SEARCH_PROVIDER_PRESETS.map((p) => p.id).join(", ")}`));
    process.exitCode = 1;
    return;
  }

  // Choose the auth method: --method, else the provider's preferred (or ask).
  const method = await chooseMethod(descriptor.auth, methodArg, providerId);
  if (!method) {
    log(danger(`"${providerId}" doesn't support the "${methodArg}" method.`));
    log(dim(`Supported: ${descriptor.auth.join(", ")}`));
    process.exitCode = 1;
    return;
  }

  const strategy = getStrategy(method, providerId);
  if (!strategy) {
    log(danger(`The "${method}" method isn't wired for ${descriptor.label} yet.`));
    process.exitCode = 1;
    return;
  }

  const ctx: AuthContext = {
    providerId,
    preset,
    store,
    env: process.env,
    savedKey: buildSavedKeys(config, secrets)[providerId],
    baseUrl: secrets.endpoints?.[providerId] ?? preset.baseUrl,
    openBrowser: noBrowser ? undefined : openBrowser,
    prompt: promptLine,
    log,
  };

  log(`${faint("Signing in to")} ${bold(text(descriptor.label))} ${faint(`via ${method}`)}`);
  try {
    const cred = await strategy.authenticate(ctx);
    const okValid = await strategy.validate(ctx, cred);
    log();
    log(ok(`✓ Authenticated ${descriptor.label}${okValid ? "" : dim(" (unverified)")}`));
    // A fresh login is almost always the provider you want to use next.
    if (!preset.local) {
      saveLastModel({ provider: providerId, model: preset.defaultModel });
      log(
        `${faint("Set as active — model")} ${info(preset.defaultModel)}${faint(
          `. Switch anytime with`,
        )} ${info("rune use <provider>")}`,
      );
    }
  } catch (err) {
    log();
    if (err instanceof AuthError) {
      log(danger(`${glyph("failure")} ${err.message}`));
      if (err.recovery) log(dim(err.recovery));
    } else {
      log(
        danger(
          `${glyph("failure")} Login failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
    process.exitCode = 1;
  }
}

/**
 * Connect a web-search engine from the command line: the same API-key strategy
 * and keychain account a model provider uses, then one real search as the
 * verification — a revoked key passes a format check and fails a search.
 */
async function loginSearch(
  preset: NonNullable<ReturnType<typeof getSearchPreset>>,
  store: Awaited<ReturnType<typeof openCredentialStore>>,
  _noBrowser: boolean,
): Promise<void> {
  if (preset.keyless) {
    log(ok(`${preset.label} is built in — it answers whenever nothing better is connected.`));
    return;
  }
  if (preset.urlEnvVar) {
    if (!isInteractive()) {
      log(
        danger(`${preset.label} needs a URL; set ${preset.urlEnvVar} or run this interactively.`),
      );
      process.exitCode = 1;
      return;
    }
    const current = process.env[preset.urlEnvVar] || preset.baseUrl || "";
    const url = (await promptLine(`${pad}${preset.label} URL [${current}]:`)).trim() || current;
    if (!url) return;
    setLocalEndpoint(preset.id, url);
    process.env[preset.urlEnvVar] = url;
    await reportProbe(preset.id, preset.label);
    return;
  }
  const strategy = getStrategy("api_key", preset.id);
  if (!strategy) return;
  log(`${faint("Connecting")} ${bold(text(preset.label))} ${faint(`— ${preset.hint}`)}`);
  try {
    const cred = await strategy.authenticate({
      providerId: preset.id,
      preset,
      store,
      env: process.env,
      prompt: promptLine,
      log,
    });
    if (cred.secret && preset.envVar) process.env[preset.envVar] = cred.secret;
    await reportProbe(preset.id, preset.label);
  } catch (err) {
    log();
    if (err instanceof AuthError) log(danger(`${glyph("failure")} ${err.message}`));
    else
      log(
        danger(
          `${glyph("failure")} Connect failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    process.exitCode = 1;
  }
}

async function reportProbe(id: string, label: string): Promise<void> {
  log(faint("Running a test search…"));
  const probe = await probeSearchBackend(id);
  log();
  if (probe.ok) {
    log(ok(`✓ Connected ${label} — answered in ${probe.ms}ms`));
    // The engine you just connected is the one you meant to use.
    savePrefs({ search: id });
    log(
      `${faint("web_search asks")} ${info(label)} ${faint("first now. Override with")} ${info("[search] provider")} ${faint("in config.toml.")}`,
    );
  } else {
    log(warn(`! Saved, but a test search failed: ${probe.detail ?? "no results"}`));
    log(faint("It stays connected; web_search will try it after the engines that work."));
  }
}

/** `rune logout <provider>` — remove any stored key/OAuth session for a provider or search engine. */
export async function runLogout(positionals: string[]): Promise<void> {
  const providerId = positionals[0];
  if (!providerId) {
    log(warn("Usage: ") + info("rune logout <provider>"));
    log(faint("Models: ") + PROVIDER_PRESETS.map((p) => p.id).join(", "));
    log(
      faint("Search: ") +
        keyedSearchPresets()
          .map((p) => p.id)
          .join(", "),
    );
    process.exitCode = 1;
    return;
  }
  const preset = getPreset(providerId) ?? getSearchPreset(providerId);
  if (!preset) {
    log(danger(`Unknown provider "${providerId}".`));
    process.exitCode = 1;
    return;
  }
  const store = await openCredentialStore();
  // Remove both a stored API key and any OAuth session; leaves env/config keys
  // untouched, so the provider falls back to those (if present) on next boot.
  await store.delete(apiKeyAccount(providerId));
  await store.delete(oauthAccount(providerId));

  // Did an env/config key remain to fall back to?
  const secrets = loadSecrets();
  const config = loadConfig(process.cwd());
  const fallback =
    buildSavedKeys(config, secrets)[providerId] || (preset.envVar && process.env[preset.envVar]);
  log(
    ok(
      `✓ Logged out of ${bold(text(preset.label))} — removed stored key/OAuth from the secure store.`,
    ),
  );
  if (fallback) {
    log(
      faint(
        `Falls back to your ${preset.envVar && process.env[preset.envVar] ? "env" : "config"} key on next run.`,
      ),
    );
  } else {
    log(
      faint(
        `No env/config key remains — ${info(`rune login ${providerId}`)}${faint(" to sign in again.")}`,
      ),
    );
  }
}

async function chooseMethod(
  supported: AuthMethod[],
  requested: string | undefined,
  providerId: string,
): Promise<AuthMethod | undefined> {
  if (requested) {
    return supported.includes(requested as AuthMethod) ? (requested as AuthMethod) : undefined;
  }
  if (supported.length <= 1 || !isInteractive()) return supported[0];
  log(faint("Select authentication method:"));
  supported.forEach((m, i) =>
    log(`  ${info(String(i + 1))}. ${text(authMethodLabel(m, providerId))}`),
  );
  const answer = (await promptLine(`${pad}Choose [1]:`)).trim();
  const idx = answer ? Number(answer) - 1 : 0;
  return supported[Number.isInteger(idx) && idx >= 0 && idx < supported.length ? idx : 0];
}

async function pickProvider(): Promise<string | undefined> {
  const models = PROVIDER_PRESETS;
  const engines = keyedSearchPresets();
  log(bold(text("Select what to connect:")));
  log(faint("Models"));
  models.forEach((p, i) => {
    const d = getProviderDescriptor(p.id)!;
    // Prefer the subscription/account name where a provider has one (Claude
    // Pro/Max, ChatGPT Plus/Pro); then the pitch; otherwise the methods.
    const hint = accountLoginLabel(p.id) ?? p.tagline ?? d.auth.join(", ");
    log(`  ${info(String(i + 1).padStart(2))}. ${text(p.label.padEnd(22))} ${faint(hint)}`);
  });
  log(faint("Web search"));
  engines.forEach((p, i) => {
    log(
      `  ${info(String(models.length + i + 1).padStart(2))}. ${text(p.label.padEnd(22))} ${faint(p.hint)}`,
    );
  });
  const all = [...models, ...engines];
  const answer = (await promptLine(`${pad}Choose [1-${all.length}]:`)).trim();
  const idx = Number(answer) - 1;
  if (!Number.isInteger(idx) || idx < 0 || idx >= all.length) {
    log(dim("Nothing selected."));
    return undefined;
  }
  return all[idx].id;
}

function printUsage(): void {
  log(bold(text("rune login")) + faint(" — authenticate a provider"));
  log();
  log(
    `${info("rune login <provider>")}             ${faint("sign in (API key, or OAuth where supported)")}`,
  );
  log(
    `${info("rune login <provider> --method oauth")} ${faint("force a method: api_key | oauth | device | local")}`,
  );
  log(
    `${info("rune login <provider> --no-browser")}  ${faint("print the OAuth URL instead of opening a browser")}`,
  );
  log(
    `${info("rune login --migrate")}               ${faint("move legacy secrets.json keys into the OS keychain")}`,
  );
  log(
    `${info("rune login <engine>")}               ${faint("connect a web-search engine (tavily, exa, brave, serper, …)")}`,
  );
  log();
  log(faint("Models: ") + PROVIDER_PRESETS.map((p) => p.id).join(", "));
  log(faint("Search: ") + SEARCH_PROVIDER_PRESETS.map((p) => p.id).join(", "));
}
