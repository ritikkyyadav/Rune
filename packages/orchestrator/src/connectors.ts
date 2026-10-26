// ─── Connectors: what `/connectors` does, without the screen ───
//
// The TUI's `/connectors` is a picker over these functions. Every write goes
// to the two files and the credential store `rune mcp` already uses, so a
// connector added in one surface is the same connector in the other: there is
// no second registry to fall out of step.
//
// Nothing here touches the network except `signInWithBrowser`, which is the
// OAuth flow `rune mcp login` runs. The screen decides when to call it.

import type { CredentialStore } from "@rune/shared";
import {
  McpOAuth,
  addressWith,
  directoryConfig,
  directoryEntry,
  isEntryAddress,
  keychainAccountsIn,
  mcpCredentialAccount,
  mcpTokenAccount,
  mergedServers,
  moveServer,
  optionsIn,
  removeServer,
  setServerEnabled,
  upsertServer,
  withArticle,
  type DirectoryEntry,
  type McpOAuthTokens,
  type McpScope,
  type McpServerConfig,
  type McpServerStatus,
  type OptionValues,
} from "@rune/tool-registry";

/** Where a connector's entry lives: one of the two config files, a plugin, or Rune itself. */
export type ConnectorSource = "user" | "workspace" | "plugin" | "built-in";

export interface ConnectorRow {
  name: string;
  source: ConnectorSource;
  /** The plugin that declares it, when `source` is "plugin". */
  plugin?: string;
  config: McpServerConfig;
  /** A workspace entry that hides a user entry of the same name. */
  shadowed?: boolean;
  /** The live client's status; absent when it is off or never started. */
  status?: McpServerStatus;
}

/** The state a row reads as, in the person's words. */
export type ConnectorState =
  "connected" | "connecting" | "needs sign-in" | "degraded" | "down" | "off" | "not started";

export function connectorState(row: ConnectorRow): ConnectorState {
  if (row.config.enabled === false) return "off";
  const s = row.status;
  if (!s) return "not started";
  if (s.needsAuth) return "needs sign-in";
  if (s.ready) return s.health === "degraded" ? "degraded" : "connected";
  // No client and no error yet: the handshake is still in flight.
  if (!s.lastError) return "connecting";
  return "down";
}

/** How a connector on file signs in, read from what it is configured as. */
export type SignIn =
  /** Browser sign-in, OAuth 2.1. */
  | "oauth"
  /** A pasted token in the keychain, named by `${keychain:mcp-token:<name>}`. */
  | "token"
  /** An Authorization header the person wrote themselves (`${VAR}` or literal). */
  | "header"
  /** Nothing to sign in to. */
  | "none"
  /** A local program; it signs in, if at all, its own way. */
  | "local";

export function signInOf(row: ConnectorRow): SignIn {
  const c = row.config;
  if (!c.url) return "local";
  if (keychainAccountsIn(c.headers ?? {}).includes(mcpTokenAccount(row.name))) return "token";
  const headers = Object.keys(c.headers ?? {}).map((h) => h.toLowerCase());
  if (headers.includes("authorization")) return "header";
  if (c.oauth?.enabled === false) return "none";
  return "oauth";
}

/**
 * The checked directory entry a configured connector is, if it is one: same
 * name and the entry's own address. A hand-added server that only shares a
 * name is not offered the entry's settings, which would rewrite its address.
 */
export function entryFor(row: ConnectorRow): DirectoryEntry | undefined {
  const entry = directoryEntry(row.name);
  if (!entry) return undefined;
  if (entry.url) return isEntryAddress(entry, row.config.url) ? entry : undefined;
  return entry.command === row.config.command ? entry : undefined;
}

/** Whether this row's entry is one `/connectors` may edit (it lives in a config file). */
export function editable(row: ConnectorRow): row is ConnectorRow & { source: McpScope } {
  return row.source === "user" || row.source === "workspace";
}

// ─── Adding ───

export interface AddDirectoryOptions {
  workspaceRoot: string;
  store: CredentialStore;
  /** Defaults to user: a service a person signs in to is theirs in every project. */
  scope?: McpScope;
  /** Defaults to the entry's id. */
  name?: string;
  values?: OptionValues;
  /** A token to store, for an entry that signs in with one. */
  token?: string;
}

/**
 * Write a directory entry to a config file, storing its pasted token first.
 * The token goes to the credential store and the config names the account,
 * so the file can be read, shared or committed without leaking anything.
 */
export async function addDirectoryConnector(
  entry: DirectoryEntry,
  opts: AddDirectoryOptions,
): Promise<{ name: string; scope: McpScope; path: string }> {
  const name = opts.name ?? entry.id;
  const scope = opts.scope ?? "user";
  const token = opts.token?.trim() ?? "";
  const auth = entry.auth;
  if (auth.kind === "token" && !auth.optional && !token) {
    throw new Error(`${entry.label} signs in with ${withArticle(auth.noun)}, and none was given`);
  }
  if (auth.kind === "token" && token) await opts.store.set(mcpTokenAccount(name), token);
  const config = directoryConfig(entry, {
    name,
    values: opts.values,
    ...(auth.kind === "token" ? { withToken: token.length > 0 } : {}),
  });
  const path = upsertServer(scope, opts.workspaceRoot, name, config);
  return { name, scope, path };
}

/**
 * A server typed by hand: an `https://` address or a command line. The name
 * defaults the way `rune mcp add` derives it. Null when the text is neither.
 */
export function customConnector(
  target: string,
  name?: string,
): { name: string; config: McpServerConfig } | null {
  const t = target.trim();
  if (!t) return null;
  if (/^https?:\/\//i.test(t)) {
    let derived: string;
    try {
      const host = new URL(t).hostname.split(".");
      derived = (host.length > 1 ? host[host.length - 2] : host[0]) || "server";
    } catch {
      return null;
    }
    return { name: cleanName(name ?? derived), config: { type: "http", url: t } };
  }
  const parts = t.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  const derived = parts[0]!.split(/[\\/]/).pop() ?? "server";
  return {
    name: cleanName(
      name ?? (parts[0] === "npx" && parts.length > 1 ? packageName(parts) : derived),
    ),
    config: { command: parts[0]!, ...(parts.length > 1 ? { args: parts.slice(1) } : {}) },
  };
}

/** `npx -y @scope/thing-mcp@latest` → `thing-mcp`: the part a person would call it. */
function packageName(parts: string[]): string {
  const pkg = parts.slice(1).find((p) => !p.startsWith("-")) ?? parts[0]!;
  const bare = pkg.replace(/^@[^/]+\//, "").replace(/@[^@]*$/, "");
  return bare || pkg;
}

/** Names become tool prefixes (`mcp_<name>_…`): keep them to the safe charset. */
export function cleanName(name: string): string {
  const s = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "server";
}

// ─── Signing in and out ───

/**
 * The OAuth flow `rune mcp login` runs, for a connector on file. The token set
 * lands under `mcp:<name>`; the caller restarts the connector to use it.
 */
export async function signInWithBrowser(
  row: ConnectorRow,
  store: CredentialStore,
  openAuthorizationUrl: (url: string) => void | Promise<void>,
  signal?: AbortSignal,
): Promise<McpOAuthTokens> {
  if (!row.config.url)
    throw new Error(`${row.name} is a local program; it has nothing to sign in to`);
  const provider = new McpOAuth({
    serverName: row.name,
    serverUrl: row.config.url,
    store,
    clientId: row.config.oauth?.clientId,
    callbackPort: row.config.oauth?.callbackPort,
    scopes: row.config.oauth?.scopes,
  });
  return provider.login({ openAuthorizationUrl, signal });
}

/**
 * Store a new pasted token for a connector on file. A connector whose token
 * was optional and never given (Context7 without a key) has no header yet; it
 * gets one, pointing at the account just written.
 */
export async function setConnectorToken(
  row: ConnectorRow,
  token: string,
  workspaceRoot: string,
  store: CredentialStore,
): Promise<void> {
  const clean = token.trim();
  if (!clean) throw new Error("no token given");
  await store.set(mcpTokenAccount(row.name), clean);
  if (signInOf(row) === "token") return;
  const entry = entryFor(row);
  if (!entry || entry.auth.kind !== "token" || !editable(row)) return;
  const values = optionsIn(entry, row.config.url ?? "");
  const fresh = directoryConfig(entry, { name: row.name, values, withToken: true });
  const next: McpServerConfig = { ...row.config, ...fresh };
  delete next.oauth;
  upsertServer(row.source, workspaceRoot, row.name, next);
}

/** Forget what a connector signed in with: its OAuth token set and its pasted token. */
export async function forgetSignIn(name: string, store: CredentialStore): Promise<boolean> {
  let had = false;
  for (const account of [mcpCredentialAccount(name), mcpTokenAccount(name)]) {
    if (await store.get(account).catch(() => null)) had = true;
    await store.delete(account).catch(() => {});
  }
  return had;
}

/** Whether anything is stored for a connector: a token set or a pasted token. */
export async function hasSignIn(name: string, store: CredentialStore): Promise<boolean> {
  for (const account of [mcpCredentialAccount(name), mcpTokenAccount(name)]) {
    if (await store.get(account).catch(() => null)) return true;
  }
  return false;
}

// ─── Configuring ───

/** Turn a config-file connector on or off; it stays on file either way. */
export function setConnectorEnabled(
  row: ConnectorRow,
  enabled: boolean,
  workspaceRoot: string,
): McpScope | null {
  if (!editable(row)) return null;
  return setServerEnabled(workspaceRoot, row.name, enabled);
}

/**
 * Set one of a directory entry's options on a connector on file, changing that
 * one setting in its address and nothing else. Returns the new address.
 */
export function setConnectorOption(
  row: ConnectorRow,
  optionId: string,
  value: string | boolean | undefined,
  workspaceRoot: string,
): string {
  const entry = entryFor(row);
  if (!entry || !editable(row)) throw new Error(`${row.name} has no settings Rune can change`);
  if (!(entry.options ?? []).some((o) => o.id === optionId)) {
    throw new Error(`${entry.label} has no setting "${optionId}"`);
  }
  const url = addressWith(entry, { [optionId]: value }, row.config.url);
  upsertServer(row.source, workspaceRoot, row.name, { ...row.config, url });
  return url;
}

/** Move a config-file connector between "every project" and "this project". */
export function moveConnector(row: ConnectorRow, to: McpScope, workspaceRoot: string): boolean {
  if (!editable(row)) return false;
  return moveServer(workspaceRoot, row.name, row.source, to);
}

/**
 * Remove a config-file connector, and forget its sign-in unless another entry
 * of the same name still uses it (a user entry a workspace one was hiding):
 * tokens are stored by name, so forgetting would sign that one out too.
 */
export async function removeConnector(
  row: ConnectorRow,
  workspaceRoot: string,
  store: CredentialStore,
): Promise<{ removed: boolean; forgot: boolean; stillOnFile: McpScope | null }> {
  if (!editable(row)) return { removed: false, forgot: false, stillOnFile: null };
  const removed = removeServer(row.source, workspaceRoot, row.name);
  const other = mergedServers(workspaceRoot).servers.find((s) => s.name === row.name);
  if (other) return { removed, forgot: false, stillOnFile: other.scope };
  const forgot = await forgetSignIn(row.name, store);
  return { removed, forgot, stillOnFile: null };
}
