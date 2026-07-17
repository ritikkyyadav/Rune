// ─── `berne login`: authenticate a provider (API key / OAuth / device / local) ───
// The one place interactive authentication runs. It picks a provider + method,
// builds an AuthContext with real browser/prompt hooks, runs the strategy's
// authenticate(), and persists to the secure credential store. Mirrors the
// standalone dispatch of `telemetry`/`doctor` — no Engine boot.

import {
  loadConfig,
  loadSecrets,
  getPreset,
  getProviderDescriptor,
  PROVIDER_PRESETS,
  openCredentialStore,
  migrateLegacySecrets,
  saveLastModel,
  apiKeyAccount,
  oauthAccount,
  authMethodLabel,
  accountLoginLabel,
  type AuthMethod,
} from "@alan/shared";
import { getStrategy, AuthError, type AuthContext } from "@alan/llm-gateway";
import { accent, bold, dim, faint, info, ok, text, warn } from "./ui/theme";
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

  // `berne login --migrate` — copy legacy secrets.json keys into the secure store.
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

  const preset = getPreset(providerId);
  const descriptor = getProviderDescriptor(providerId);
  if (!preset || !descriptor) {
    log(accent(`Unknown provider "${providerId}".`));
    log(dim(`Known: ${PROVIDER_PRESETS.map((p) => p.id).join(", ")}`));
    process.exitCode = 1;
    return;
  }

  // Choose the auth method: --method, else the provider's preferred (or ask).
  const method = await chooseMethod(descriptor.auth, methodArg, providerId);
  if (!method) {
    log(accent(`"${providerId}" doesn't support the "${methodArg}" method.`));
    log(dim(`Supported: ${descriptor.auth.join(", ")}`));
    process.exitCode = 1;
    return;
  }

  const strategy = getStrategy(method, providerId);
  if (!strategy) {
    log(accent(`The "${method}" method isn't wired for ${descriptor.label} yet.`));
    if (method === "oauth" && providerId === "anthropic") {
      log(dim("Anthropic OAuth is experimental — set BERNE_ANTHROPIC_OAUTH=1 to enable it."));
    }
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
        )} ${info("berne use <provider>")}`,
      );
    }
  } catch (err) {
    log();
    if (err instanceof AuthError) {
      log(accent(`✕ ${err.message}`));
      if (err.recovery) log(dim(err.recovery));
    } else {
      log(accent(`✕ Login failed: ${err instanceof Error ? err.message : String(err)}`));
    }
    process.exitCode = 1;
  }
}

/** `berne logout <provider>` — remove any stored key/OAuth session for a provider. */
export async function runLogout(positionals: string[]): Promise<void> {
  const providerId = positionals[0];
  if (!providerId) {
    log(accent("Usage: ") + info("berne logout <provider>"));
    log(faint("Providers: ") + PROVIDER_PRESETS.map((p) => p.id).join(", "));
    process.exitCode = 1;
    return;
  }
  const preset = getPreset(providerId);
  if (!preset) {
    log(accent(`Unknown provider "${providerId}".`));
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
        `No env/config key remains — ${info(`berne login ${providerId}`)}${faint(" to sign in again.")}`,
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
  const rows = PROVIDER_PRESETS;
  log(bold(text("Select provider to configure:")));
  rows.forEach((p, i) => {
    const d = getProviderDescriptor(p.id)!;
    // Prefer the subscription/account name where a provider has one (Claude
    // Pro/Max, ChatGPT Plus/Pro, GitHub Copilot); otherwise show the methods.
    const hint = accountLoginLabel(p.id) ?? d.auth.join(", ");
    log(`  ${info(String(i + 1).padStart(2))}. ${text(p.label.padEnd(22))} ${faint(hint)}`);
  });
  const answer = (await promptLine(`${pad}Choose a provider [1-${rows.length}]:`)).trim();
  const idx = Number(answer) - 1;
  if (!Number.isInteger(idx) || idx < 0 || idx >= rows.length) {
    log(dim("Nothing selected."));
    return undefined;
  }
  return rows[idx].id;
}

function printUsage(): void {
  log(bold(text("berne login")) + faint(" — authenticate a provider"));
  log();
  log(
    `${info("berne login <provider>")}            ${faint("sign in (API key, or OAuth where supported)")}`,
  );
  log(
    `${info("berne login <provider> --method oauth")} ${faint("force a method: api_key | oauth | device | local")}`,
  );
  log(
    `${info("berne login <provider> --no-browser")}  ${faint("print the OAuth URL instead of opening a browser")}`,
  );
  log(
    `${info("berne login --migrate")}               ${faint("move legacy secrets.json keys into the OS keychain")}`,
  );
  log();
  log(faint("Providers: ") + PROVIDER_PRESETS.map((p) => p.id).join(", "));
}
