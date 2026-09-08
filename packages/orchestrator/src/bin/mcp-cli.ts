// ─── `rune mcp`: connecting a service is one command ───
//
// Before this, `/mcp` was read-only and told the user to hand-edit a JSON file
// they had to know the shape of, pointed at a URL they had to find, for a
// service they then could not authenticate to. Connecting Notion was a
// research project.
//
//   rune mcp add notion          resolve the name, write the entry
//   rune mcp login notion        OAuth in the browser, token in the keychain
//   rune mcp list                what is configured, from where, and its health
//   rune mcp doctor              what is broken and the command that fixes it
//
// No Engine boot and no provider validation — like `rune doctor`, this is
// instant. `doctor` and `list` start the servers because their whole job is to
// report real health; the rest are pure file and keychain operations.

import { openCredentialStore, describeCredentialBackend, loadConfig } from "@rune/shared";
import {
  McpDiscovery,
  McpOAuth,
  mcpCredentialAccount,
  loadVendoredCatalog,
  fetchRegistryCatalog,
  resolveConnector,
  nearestNames,
  mcpConfigPath,
  mergedServers,
  preflightServer,
  upsertServer,
  removeServer,
  setServerEnabled,
  type CatalogEntry,
  type McpScope,
  type McpServerConfig,
  type McpServerStatus,
} from "@rune/tool-registry";
import { accent, danger, dim, faint, info, ok, text, warn } from "./ui/theme";
import { glyph } from "./ui/glyphs";
import { openBrowser } from "./byop-cli-shared";

const pad = "  ";
const say = (line = ""): void => {
  process.stdout.write(`${pad}${line}\n`);
};

/**
 * The one part of this surface that needs the outside world.
 *
 * Injected rather than imported so the whole `add` → `login` → call path can be
 * driven end to end against a local server, with the browser click replaced by
 * a direct fetch. A test that stubs the OAuth engine proves nothing about the
 * command; this proves the command.
 */
export interface McpCliDeps {
  openAuthorizationUrl?: (url: string) => void | Promise<void>;
}

function usage(): void {
  say();
  say(`${accent("rune mcp")} ${dim("— connect Rune to the services you already use")}`);
  say();
  say(`${text("Commands")}`);
  say(
    `  ${accent("add")} <name|url|command> ${dim("[--scope user|workspace] [--header K=V] [--env K=V] [--name N]")}`,
  );
  say(`  ${accent("remove")} <name> ${dim("[--scope user|workspace]")}`);
  say(
    `  ${accent("list")} ${dim("[--catalog]      configured connectors, their scope, auth and health")}`,
  );
  say(
    `  ${accent("login")} <name> ${dim("           OAuth 2.1 in the browser; token to the OS keychain")}`,
  );
  say(`  ${accent("logout")} <name>`);
  say(`  ${accent("enable")} <name> ${dim(" / ")} ${accent("disable")} <name>`);
  say(
    `  ${accent("doctor")} ${dim("               check the config, start every connector, report what is wrong")}`,
  );
  say();
  say(`  ${dim("in a session:")} ${accent("/mcp")} ${dim("·")} ${accent("/mcp reconnect <name>")}`);
  say();
  say(`${text("Examples")}`);
  say(`  ${dim("$")} rune mcp add notion ${dim("--scope user")}`);
  say(`  ${dim("$")} rune mcp login notion`);
  say(`  ${dim("$")} rune mcp add ${dim("https://mcp.example.com/mcp --name example")}`);
  say(
    `  ${dim("$")} rune mcp add ${dim('"npx -y @modelcontextprotocol/server-filesystem ." --name files')}`,
  );
  say();
}

/** `--header K=V` / `--env K=V`, repeatable, from the parsed values bag. */
function pairs(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const list = Array.isArray(value) ? value : value === undefined ? [] : [value];
  for (const raw of list) {
    if (typeof raw !== "string") continue;
    const eq = raw.indexOf("=");
    if (eq <= 0) continue;
    out[raw.slice(0, eq).trim()] = raw.slice(eq + 1);
  }
  return out;
}

/** The [mcp] block, defaults included. Read once per command. */
function mcpConfig(): NonNullable<ReturnType<typeof loadConfig>["mcp"]> {
  try {
    return loadConfig().mcp ?? {};
  } catch {
    // A broken config.toml must not stop someone from listing connectors.
    return {};
  }
}

function scopeOf(values: Record<string, unknown>): McpScope {
  if (values.scope === "user") return "user";
  if (values.scope === "workspace") return "workspace";
  return mcpConfig().defaultScope === "user" ? "user" : "workspace";
}

function workspaceOf(values: Record<string, unknown>): string {
  return typeof values.workspace === "string" ? values.workspace : process.cwd();
}

// ─── add ───

/** What the user typed: a catalog name, a URL, or a shell command. */
function classifyTarget(target: string): "url" | "command" | "name" {
  if (/^https?:\/\//i.test(target)) return "url";
  if (/[\s/\\]/.test(target) || target.endsWith(".js") || target.endsWith(".py")) return "command";
  return "name";
}

function entryToConfig(entry: CatalogEntry): McpServerConfig {
  return entry.url
    ? {
        type: "http",
        url: entry.url,
        ...(entry.headers ? { headers: entry.headers } : {}),
        ...(entry.oauth ? { oauth: entry.oauth } : {}),
      }
    : { command: entry.command!, ...(entry.args ? { args: entry.args } : {}) };
}

async function cmdAdd(args: string[], values: Record<string, unknown>): Promise<number> {
  const target = args[0];
  if (!target) {
    say(`  ${danger(glyph("failure"))} usage: rune mcp add <name|url|command>`);
    return 1;
  }
  const scope = scopeOf(values);
  const workspaceRoot = workspaceOf(values);
  const headers = pairs(values.header);
  const env = pairs(values.env);
  const explicitName = typeof values.name === "string" ? values.name : undefined;

  let name = explicitName;
  let config: McpServerConfig;
  let provenance = "";

  const kind = classifyTarget(target);
  if (kind === "url") {
    name = name ?? new URL(target).hostname.split(".").slice(-2)[0];
    config = { type: "http", url: target, ...(Object.keys(headers).length ? { headers } : {}) };
    provenance = "url";
  } else if (kind === "command") {
    const parts = target.split(/\s+/).filter(Boolean);
    name = name ?? parts[0].split("/").pop()!;
    config = {
      command: parts[0],
      ...(parts.length > 1 ? { args: parts.slice(1) } : {}),
      ...(Object.keys(env).length ? { env } : {}),
    };
    provenance = "command";
  } else {
    const entry = await resolveConnector(target, {
      includeRegistry: mcpConfig().registry !== false,
    });
    if (!entry) {
      const vendored = loadVendoredCatalog();
      const near = nearestNames(target, vendored);
      say(`  ${danger(glyph("failure"))} no connector named ${accent(target)} in the catalog`);
      if (near.length > 0)
        say(`    ${dim("did you mean")} ${near.map((n) => accent(n)).join(dim(" · "))}`);
      say(`    ${dim("or pass a URL:")} rune mcp add https://… --name ${target}`);
      say(`    ${dim("see everything:")} rune mcp list --catalog`);
      return 1;
    }
    if (!entry.url && !entry.command) {
      // Snowflake / Databricks / Benchling in the vendored files: the vendor
      // has not published an endpoint. Saying so beats writing a broken entry.
      say(
        `  ${warn(glyph("retry"))} ${accent(entry.name)} is in the catalog but publishes no endpoint yet`,
      );
      say(`    ${dim("add it by URL once you have one:")} rune mcp add <url> --name ${entry.name}`);
      return 1;
    }
    name = name ?? entry.name;
    config = entryToConfig(entry);
    if (Object.keys(headers).length) config.headers = { ...config.headers, ...headers };
    provenance =
      entry.source === "vendored"
        ? `bundled catalog${entry.usedBy?.length ? ` (used by ${entry.usedBy.slice(0, 3).join(", ")})` : ""}`
        : "public MCP registry";
  }

  const existing = mergedServers(workspaceRoot).servers.find((s) => s.name === name);
  const path = upsertServer(scope, workspaceRoot, name!, config);

  say();
  say(
    `  ${ok(glyph("verified"))} ${existing ? "updated" : "added"} ${accent(name!)}${provenance ? dim(` — ${provenance}`) : ""}`,
  );
  say(
    `    ${dim(config.url ? config.url : `${config.command} ${(config.args ?? []).join(" ")}`.trim())}`,
  );
  say(`    ${faint(`${scope} scope · ${path}`)}`);
  if (existing && existing.scope !== scope && scope === "user") {
    say(`    ${warn(glyph("retry"))} the workspace entry for ${accent(name!)} still wins here`);
  }
  if (config.url) {
    const provider = new McpOAuth({
      serverName: name!,
      serverUrl: config.url,
      store: await openCredentialStore(),
    });
    if (!(await provider.hasCredentials())) {
      say();
      say(
        `  ${text("Next")}  ${accent(`rune mcp login ${name}`)} ${dim("— most remote connectors require it")}`,
      );
    }
  }
  say();
  return 0;
}

// ─── remove ───

async function cmdRemove(args: string[], values: Record<string, unknown>): Promise<number> {
  const name = args[0];
  if (!name) {
    say(`  ${danger(glyph("failure"))} usage: rune mcp remove <name>`);
    return 1;
  }
  const workspaceRoot = workspaceOf(values);
  const scopes: McpScope[] = values.scope ? [scopeOf(values)] : ["workspace", "user"];
  let removed = false;
  for (const scope of scopes) {
    if (removeServer(scope, workspaceRoot, name)) {
      say(`  ${ok(glyph("verified"))} removed ${accent(name)} ${dim(`from ${scope} scope`)}`);
      removed = true;
    }
  }
  if (!removed) {
    say(`  ${warn(glyph("retry"))} ${accent(name)} is not configured`);
    return 1;
  }
  // The token outlives the entry unless we say otherwise — deleting a
  // credential is not something a `remove` should do silently.
  const store = await openCredentialStore();
  if (await store.get(mcpCredentialAccount(name))) {
    say(`    ${dim("its stored token is still in the keychain —")} rune mcp logout ${name}`);
  }
  return 0;
}

// ─── list ───

function authLabel(status: McpServerStatus | undefined, hasCreds: boolean): string {
  if (status?.needsAuth) return danger("needs login");
  if (hasCreds) return ok("authorized");
  return dim("none");
}

function healthLabel(status: McpServerStatus | undefined, enabled: boolean): string {
  if (!enabled) return dim("disabled");
  if (!status) return dim("not started");
  if (status.needsAuth) return danger("down");
  if (status.health === "healthy") return ok("up");
  if (status.health === "degraded") return warn("degraded");
  return danger("down");
}

async function cmdList(args: string[], values: Record<string, unknown>): Promise<number> {
  if (values.catalog === true) return cmdCatalog();

  const workspaceRoot = workspaceOf(values);
  const { servers, errors } = mergedServers(workspaceRoot);
  for (const e of errors) say(`  ${danger(glyph("failure"))} ${e}`);

  say();
  if (servers.length === 0) {
    say(`  ${dim("No connectors configured.")}`);
    say(
      `  ${text("Add one")}  ${accent("rune mcp add notion")} ${dim("·")} ${accent("rune mcp list --catalog")}`,
    );
    say();
    return 0;
  }

  // Health needs live servers. `list` is worth the second it costs.
  const statuses = new Map<string, McpServerStatus>();
  const discovery = new McpDiscovery(workspaceRoot);
  try {
    await discovery.discover();
    for (const s of discovery.getStatus()) statuses.set(s.name, s);
  } catch {
    // A discovery failure still leaves the configured list worth printing.
  }

  const store = await openCredentialStore();
  const accounts = new Set(await store.list());

  say(`  ${text("Connectors")}  ${dim(`${servers.length} configured`)}`);
  for (const s of servers) {
    const status = statuses.get(s.name);
    const enabled = s.config.enabled !== false;
    const hasCreds = accounts.has(mcpCredentialAccount(s.name));
    const where = s.config.url ?? `${s.config.command} ${(s.config.args ?? []).join(" ")}`.trim();
    say(
      `    ${accent(s.name.padEnd(16))} ${healthLabel(status, enabled).padEnd(20)} ` +
        `${authLabel(status, hasCreds).padEnd(20)} ${dim(`${status?.toolCount ?? 0} tools`)}`,
    );
    say(`      ${faint(where)}  ${faint(`[${s.scope}${s.shadowed ? ", shadows user" : ""}]`)}`);
    if (status?.lastError) say(`      ${danger(status.lastError.slice(0, 140))}`);
  }
  say();
  say(`  ${faint(`tokens in ${describeCredentialBackend(store)}`)}`);
  say();
  await discovery.stopAll().catch(() => {});
  return 0;
}

async function cmdCatalog(): Promise<number> {
  const vendored = loadVendoredCatalog();
  const registry = mcpConfig().registry === false ? [] : await fetchRegistryCatalog();
  const known = new Set(vendored.map((e) => e.name.toLowerCase()));
  const extra = registry.filter((e) => !known.has(e.name.toLowerCase()));

  say();
  say(`  ${text("Bundled catalog")}  ${dim(`${vendored.length} connectors`)}`);
  for (const e of vendored) {
    const endpoint = e.url ?? (e.command ? `${e.command} ${(e.args ?? []).join(" ")}`.trim() : "");
    say(
      `    ${accent(e.name.padEnd(18))} ${endpoint ? faint(endpoint) : warn("no endpoint published")}`,
    );
  }
  if (extra.length > 0) {
    say();
    say(`  ${text("Public MCP registry")}  ${dim(`${extra.length} more`)}`);
    for (const e of extra.slice(0, 40)) {
      say(`    ${accent(e.name.padEnd(18))} ${faint(e.url ?? "")}`);
    }
  } else {
    say();
    say(`  ${faint("public MCP registry unreachable — the bundled catalog is what you get")}`);
  }
  say();
  return 0;
}

// ─── login / logout ───

async function cmdLogin(
  args: string[],
  values: Record<string, unknown>,
  deps: McpCliDeps = {},
): Promise<number> {
  const name = args[0];
  if (!name) {
    say(`  ${danger(glyph("failure"))} usage: rune mcp login <name>`);
    return 1;
  }
  const workspaceRoot = workspaceOf(values);
  const entry = mergedServers(workspaceRoot).servers.find((s) => s.name === name);
  if (!entry) {
    say(
      `  ${danger(glyph("failure"))} ${accent(name)} is not configured — ${accent(`rune mcp add ${name}`)} first`,
    );
    return 1;
  }
  if (!entry.config.url) {
    say(
      `  ${warn(glyph("retry"))} ${accent(name)} is a local (stdio) server — it has nothing to log in to`,
    );
    return 1;
  }

  const store = await openCredentialStore();
  if (!store.secure) {
    say(
      `  ${warn(glyph("retry"))} no OS keychain available — the token will be written to a 0600 file`,
    );
  }
  const provider = new McpOAuth({
    serverName: name,
    serverUrl: entry.config.url,
    store,
    clientId: entry.config.oauth?.clientId,
    callbackPort: entry.config.oauth?.callbackPort,
    scopes: entry.config.oauth?.scopes,
  });

  say();
  say(`  ${info(glyph("selection"))} opening your browser to authorize ${accent(name)}…`);
  try {
    const tokens = await provider.login({
      openAuthorizationUrl:
        deps.openAuthorizationUrl ??
        (async (url) => {
          await openBrowser(url).catch(() => {
            say(`  ${dim("could not open a browser — visit this URL:")}`);
            say(`  ${url}`);
          });
        }),
    });
    say(`  ${ok(glyph("verified"))} ${accent(name)} connected`);
    say(
      `    ${faint(`token stored as ${mcpCredentialAccount(name)} in ${describeCredentialBackend(store)}`)}`,
    );
    if (tokens.expiresAt) {
      say(
        `    ${faint(`expires ${new Date(tokens.expiresAt).toISOString().slice(0, 16).replace("T", " ")} — refreshed automatically`)}`,
      );
    }
    say();
    return 0;
  } catch (err) {
    say(`  ${danger(glyph("failure"))} ${err instanceof Error ? err.message : String(err)}`);
    say();
    return 1;
  }
}

async function cmdLogout(args: string[]): Promise<number> {
  const name = args[0];
  if (!name) {
    say(`  ${danger(glyph("failure"))} usage: rune mcp logout <name>`);
    return 1;
  }
  const store = await openCredentialStore();
  const had = await store.get(mcpCredentialAccount(name));
  await store.delete(mcpCredentialAccount(name));
  say(
    had
      ? `  ${ok(glyph("verified"))} forgot the stored token for ${accent(name)}`
      : `  ${dim(`no stored token for ${name}`)}`,
  );
  return 0;
}

// ─── enable / disable ───

function cmdToggle(args: string[], values: Record<string, unknown>, enabled: boolean): number {
  const name = args[0];
  if (!name) {
    say(`  ${danger(glyph("failure"))} usage: rune mcp ${enabled ? "enable" : "disable"} <name>`);
    return 1;
  }
  const scope = setServerEnabled(workspaceOf(values), name, enabled);
  if (!scope) {
    say(`  ${warn(glyph("retry"))} ${accent(name)} is not configured`);
    return 1;
  }
  say(
    `  ${ok(glyph("verified"))} ${accent(name)} ${enabled ? "enabled" : "disabled"} ${dim(`in ${scope} scope`)}`,
  );
  if (!enabled) say(`    ${faint("the entry is kept — only the connection stops")}`);
  return 0;
}

// ─── doctor ───

/** The row already names the connector; the problem should not say it twice. */
function stripName(problem: string, name: string): string {
  return problem.startsWith(`${name}: `) ? problem.slice(name.length + 2) : problem;
}

async function cmdDoctor(values: Record<string, unknown>): Promise<number> {
  const workspaceRoot = workspaceOf(values);
  const { servers, errors } = mergedServers(workspaceRoot);

  say();
  say(`${pad}${accent("rune mcp doctor")}`);
  say();
  say(`  ${text("Config")}`);
  say(`    ${faint(`user       ${mcpConfigPath("user", workspaceRoot)}`)}`);
  say(`    ${faint(`workspace  ${mcpConfigPath("workspace", workspaceRoot)}`)}`);
  for (const e of errors) say(`    ${danger(glyph("failure"))} ${e}`);

  if (servers.length === 0) {
    say();
    say(`  ${dim("No connectors configured — nothing to check.")}`);
    say(`  ${accent("rune mcp add notion")} ${dim("·")} ${accent("rune mcp list --catalog")}`);
    say();
    return 0;
  }

  const store = await openCredentialStore();
  const accounts = new Set(await store.list());
  say();
  say(`  ${text("Credentials")}  ${dim(describeCredentialBackend(store))}`);
  if (!store.secure) {
    say(`    ${warn(glyph("retry"))} no OS keychain — tokens are in a 0600 file`);
  }

  // What is wrong on paper, before anything is spawned.
  //
  // A connector whose directory does not exist dies with the server's own
  // stderr in the notice — which reports that a process exited and nothing
  // about why. The answer was on disk the whole time.
  const paper = new Map(servers.map((s) => [s.name, preflightServer(s.name, s.config)]));

  const discovery = new McpDiscovery(workspaceRoot);
  await discovery.discover().catch(() => []);
  const statuses = new Map(discovery.getStatus().map((s) => [s.name, s]));

  say();
  say(`  ${text("Connectors")}`);
  let problems = 0;
  for (const s of servers) {
    const enabled = s.config.enabled !== false;
    const status = statuses.get(s.name);
    const hasCreds = accounts.has(mcpCredentialAccount(s.name));
    const label = `${accent(s.name.padEnd(16))}`;

    if (!enabled) {
      say(`    ${label} ${dim("disabled")} ${faint(`— rune mcp enable ${s.name}`)}`);
      continue;
    }

    const onPaper = paper.get(s.name) ?? [];
    if (onPaper.length > 0) {
      problems++;
      const first = onPaper[0]!;
      say(
        `    ${label} ${danger("misconfigured")} ${dim(`— ${stripName(first.problem, s.name)}`)}`,
      );
      for (const p of onPaper) say(`      ${faint(`fix: ${p.fix}`)}`);
      continue;
    }
    if (!status) {
      problems++;
      say(`    ${label} ${danger("down")} ${dim("— did not start")}`);
      continue;
    }
    if (status.needsAuth) {
      problems++;
      say(`    ${label} ${danger("needs login")}`);
      say(`      ${faint(`fix: rune mcp login ${s.name}`)}`);
      continue;
    }
    if (status.health === "down" || !status.ready) {
      problems++;
      say(`    ${label} ${danger("down")}`);
      if (status.lastError) say(`      ${faint(status.lastError.slice(0, 160))}`);
      say(
        `      ${faint(
          s.config.url
            ? `fix: check the URL, or rune mcp login ${s.name}`
            : `fix: check the command runs — ${s.config.command} ${(s.config.args ?? []).join(" ")}`.trim(),
        )}`,
      );
      continue;
    }
    if (status.health === "degraded") {
      problems++;
      say(`    ${label} ${warn("degraded")} ${dim(`${status.toolCount} tools`)}`);
      continue;
    }
    say(
      `    ${label} ${ok("up")} ${dim(`${status.toolCount} tools · ${status.dialect ?? status.kind} · ${status.protocolVersion ?? "?"}`)}` +
        `${hasCreds ? dim(" · authorized") : ""}`,
    );
  }

  say();
  say(
    problems === 0
      ? `  ${ok(glyph("verified"))} every connector is up`
      : `  ${danger(glyph("failure"))} ${problems} connector${problems === 1 ? "" : "s"} need attention`,
  );
  say();
  await discovery.stopAll().catch(() => {});
  return problems === 0 ? 0 : 1;
}

// ─── dispatch ───

export async function runMcp(
  args: string[],
  values: Record<string, unknown>,
  deps: McpCliDeps = {},
): Promise<number> {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case "add":
      return cmdAdd(rest, values);
    case "remove":
    case "rm":
      return cmdRemove(rest, values);
    case "list":
    case "ls":
      return cmdList(rest, values);
    case "login":
      return cmdLogin(rest, values, deps);
    case "logout":
      return cmdLogout(rest);
    case "enable":
      return cmdToggle(rest, values, true);
    case "disable":
      return cmdToggle(rest, values, false);
    case "doctor":
      return cmdDoctor(values);
    case undefined:
    case "help":
    case "--help":
    case "-h":
      usage();
      return 0;
    default:
      say(`  ${danger(glyph("failure"))} unknown subcommand ${accent(sub)}`);
      usage();
      return 1;
  }
}
