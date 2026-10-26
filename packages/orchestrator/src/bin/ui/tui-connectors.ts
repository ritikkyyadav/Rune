// --- The frame: /connectors ---
//
// Connect a service and change what it does, from the session. The screens
// are pure (connectors-picker.ts) and the writes are shared with `rune mcp`
// (../../connectors.ts); this file is the order things happen in.
//
// Two rules shape it:
//
//   - A flow that waits on something outside the terminal (a browser
//     sign-in) ends there instead of reopening a picker. The person may have
//     typed a message meanwhile, and a picker opened over a running turn would
//     take its keys.
//   - Every change reaches the live session before the flow returns: a
//     connector added, signed in or reconfigured is restarted from its entry,
//     and its tools are in the next request without a restart of Rune.
//
// Mixed onto `Tui.prototype` at the bottom of tui.ts, like tui-commands.ts.

import type { Tui } from "./tui";
import { loadConfig, openCredentialStore, type CredentialStore } from "@rune/shared";
import {
  closedConnector,
  directoryEntry,
  fetchRegistryCatalog,
  loadVendoredCatalog,
  optionsIn,
  searchDirectory,
  withArticle,
  upsertServer,
  type CatalogEntry,
  type DirectoryCategory,
  type DirectoryEntry,
  type McpServerConfig,
} from "@rune/tool-registry";
import {
  addDirectoryConnector,
  cleanName,
  connectorState,
  customConnector,
  entryFor,
  forgetSignIn,
  hasSignIn,
  moveConnector,
  removeConnector,
  setConnectorEnabled,
  setConnectorOption,
  setConnectorToken,
  signInOf,
  signInWithBrowser,
  type ConnectorRow,
} from "../../connectors";
import {
  detailScreen,
  homeScreen,
  mergeHits,
  rowLabel,
  sameActionIndex,
  searchScreen,
  shelfScreen,
  whereWord,
  type DetailAction,
} from "./connectors-picker";
import { openBrowser } from "../byop-cli-shared";
import { glyph } from "./glyphs";
import { danger, faint, info, muted, ok, text, warn } from "./theme";

/** How long a browser sign-in may take before it is given up. */
export const SIGN_IN_WAIT_MS = 5 * 60_000;

const DOT = " \u00b7 ";

/** A catalog entry (bundled or registry) as a config, the way `rune mcp add` writes it. */
function catalogConfig(entry: CatalogEntry): McpServerConfig | null {
  if (entry.url) {
    return {
      type: "http",
      url: entry.url,
      ...(entry.headers ? { headers: entry.headers } : {}),
      ...(entry.oauth ? { oauth: entry.oauth } : {}),
    };
  }
  if (entry.command) return { command: entry.command, ...(entry.args ? { args: entry.args } : {}) };
  return null;
}

/** Case-insensitive match on what a person would type: the name, or the description. */
function catalogMatches(entry: CatalogEntry, query: string): boolean {
  const q = query.toLowerCase();
  return (
    entry.name.toLowerCase().includes(q) || (entry.description ?? "").toLowerCase().includes(q)
  );
}

export const CONNECTOR_METHODS = {
  /**
   * `/connectors`, `/connectors <name>`, `/connectors add <name>`,
   * `/connectors reconnect <name>`. A bare name opens what is on file under
   * it, or connects the checked service of that name.
   */
  async runConnectors(this: Tui, arg: string): Promise<void> {
    const [verb, ...rest] = arg.split(/\s+/).filter(Boolean);
    if (!verb) return this.connectorsHome();
    const engine = this.ctx.engine;
    if (verb === "reconnect") {
      const who = rest[0];
      if (!who) {
        this.print(`  ${muted("usage: /connectors reconnect <name>")}`);
        return;
      }
      const back = await engine.reconnectMcpServer(who);
      this.print(
        back
          ? `  ${ok(glyph("verified"))} ${text(who)} ${muted("reconnected")}`
          : `  ${warn(glyph("retry"))} ${text(who)} ${muted("did not come back")}  ${info(`/connectors ${who}`)}`,
      );
      return;
    }
    const name = verb === "add" ? (rest[0] ?? "") : verb;
    if (!name) return this.connectorsHome();
    const rows = await engine.listConnectors();
    const row = rows.find((r) => r.name === name);
    if (row) {
      await this.connectorDetail(row.name);
      return;
    }
    const entry = directoryEntry(name);
    if (entry) return this.connectEntry(entry);
    const closed = closedConnector(name);
    if (closed) {
      this.print(`  ${warn("!")} ${text(closed.label)} ${muted(`-- ${closed.reason}`)}`);
      return;
    }
    return this.connectorSearch(name);
  },

  /** The home screen: what is connected, then the ways to add one. */
  async connectorsHome(this: Tui): Promise<void> {
    let start = 0;
    while (true) {
      const rows = await this.ctx.engine.listConnectors();
      const screen = homeScreen(rows);
      const picked = await this.pick(screen.title, screen.items, start, undefined, screen.footnote);
      if (picked == null) return;
      start = picked;
      const choice = screen.choices[picked]!;
      if (choice.kind === "connector") {
        if (await this.connectorDetail(choice.row.name)) return;
      } else if (choice.kind === "shelf") {
        if (await this.connectorShelf(choice.category)) return;
      } else if (choice.kind === "search") {
        return this.connectorSearch();
      } else {
        return this.connectorCustom();
      }
    }
  },

  /** One shelf of checked services. True when a connect ran (the flow is over). */
  async connectorShelf(this: Tui, category: DirectoryCategory): Promise<boolean> {
    const rows = await this.ctx.engine.listConnectors();
    const screen = shelfScreen(category, rows);
    const picked = await this.pick(screen.title, screen.items, 0, undefined, screen.footnote);
    if (picked == null) return false;
    const entry = screen.choices[picked]!;
    const existing = rows.find((r) => r.name === entry.id);
    if (existing) return this.connectorDetail(existing.name);
    await this.connectEntry(entry);
    return true;
  },

  /** Connect one checked service: its token if it takes one, the entry, the sign-in. */
  async connectEntry(this: Tui, entry: DirectoryEntry): Promise<void> {
    const store = await openCredentialStore();
    if (entry.gate) {
      this.print(`  ${warn("!")} ${muted(entry.gate.note)}`);
      this.print(`    ${faint(entry.gate.link)}`);
    }
    let token: string | undefined;
    const auth = entry.auth;
    if (auth.kind === "token") {
      this.print(
        `  ${faint(`${entry.label} signs in with ${withArticle(auth.noun)}${auth.optional ? " (optional)" : ""}; create one at`)} ${info(auth.createAt)}`,
      );
      const answer = await this.promptLine(
        `${entry.label} ${auth.noun}${auth.optional ? ", or enter to go without" : ""}:`,
        "",
        { masked: true },
      );
      if (answer == null) {
        this.print(`  ${faint("not connected")}`);
        return;
      }
      token = answer.trim();
      if (!token && !auth.optional) {
        this.print(`  ${faint(`nothing pasted -- ${entry.label} is not connected`)}`);
        return;
      }
    }
    try {
      const added = await addDirectoryConnector(entry, {
        workspaceRoot: this.ctx.workspaceRoot,
        store,
        ...(token ? { token } : {}),
      });
      this.print(
        `  ${ok(glyph("verified"))} ${muted("added")} ${info(entry.label)} ${faint(`| every project${DOT}${added.path}`)}`,
      );
      if (token && auth.kind === "token") {
        this.print(`    ${faint(`the ${auth.noun} is in your keychain, not in the file`)}`);
      }
    } catch (err) {
      this.print(
        `  ${danger(glyph("failure"))} ${muted("could not add it --")} ${faint(err instanceof Error ? err.message : String(err))}`,
      );
      return;
    }
    if (auth.kind === "cli") {
      this.print(
        `  ${faint(`it signs in with its own CLI; if its tools say you are signed out, run in a shell:`)} ${info(auth.signIn)}`,
      );
    }
    await this.connectorStartAndSignIn(entry.id);
  },

  /**
   * Start a connector from its entry, and run the browser sign-in when that is
   * what it is waiting for. Ends the flow either way.
   */
  async connectorStartAndSignIn(this: Tui, name: string): Promise<void> {
    const row = await this.connectorStart(name);
    if (row && connectorState(row) === "needs sign-in" && signInOf(row) === "oauth") {
      await this.connectorSignIn(name);
    }
  },

  /** Restart one connector from its entry and print how it came up. Returns its row. */
  async connectorStart(this: Tui, name: string): Promise<ConnectorRow | undefined> {
    const engine = this.ctx.engine;
    const before = (await engine.listConnectors()).find((r) => r.name === name);
    const label = before ? rowLabel(before) : name;
    this.print(
      `  ${faint(before?.config.command ? `starting ${label} (its first start can download it)...` : `connecting to ${label}...`)}`,
    );
    await engine.restartMcpServer(name);
    const row = (await engine.listConnectors()).find((r) => r.name === name);
    this.connectorReceipt(row, label);
    return row;
  },

  /** One line on how a connector is doing, and the next step when it is not up. */
  connectorReceipt(this: Tui, row: ConnectorRow | undefined, label: string): void {
    if (!row) {
      this.print(`  ${warn(glyph("retry"))} ${text(label)} ${muted("is no longer on file")}`);
      return;
    }
    const state = connectorState(row);
    if (state === "connected" || state === "degraded") {
      this.print(
        `  ${ok(glyph("verified"))} ${info(label)} ${muted(state)} ${faint(`| ${row.status?.toolCount ?? 0} tools${DOT}${whereWord(row)}`)}`,
      );
      return;
    }
    if (state === "needs sign-in") {
      this.print(`  ${warn("!")} ${info(label)} ${muted("needs a sign-in")}`);
      return;
    }
    if (state === "off") {
      this.print(`  ${faint(`${label} is off`)}`);
      return;
    }
    this.print(`  ${danger(glyph("failure"))} ${info(label)} ${muted("did not connect")}`);
    if (row.status?.lastError) {
      this.print(`    ${faint(row.status.lastError.replace(/\s+/g, " ").slice(0, 200))}`);
    }
    this.print(`    ${faint("settings and a retry:")} ${info(`/connectors ${row.name}`)}`);
  },

  /**
   * The browser sign-in for one connector on file. Esc cancels; it gives up
   * on its own after {@link SIGN_IN_WAIT_MS}. On success the connector is
   * restarted so its tools are in this session.
   */
  async connectorSignIn(this: Tui, name: string): Promise<void> {
    const row = (await this.ctx.engine.listConnectors()).find((r) => r.name === name);
    if (!row) return;
    const label = rowLabel(row);
    const entry = entryFor(row);
    const store = await openCredentialStore();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SIGN_IN_WAIT_MS);
    this.connectorWait = controller;
    this.print(
      `  ${info(glyph("selection"))} ${muted("opening your browser to sign in to")} ${info(label)} ${faint("| esc cancels")}`,
    );
    try {
      await signInWithBrowser(
        row,
        store,
        async (url) => {
          await openBrowser(url).catch(() => {
            this.print(`  ${faint("could not open a browser -- visit:")}`);
            this.print(`  ${url}`);
          });
        },
        controller.signal,
      );
      this.print(`  ${ok(glyph("verified"))} ${muted("signed in to")} ${info(label)}`);
    } catch (err) {
      if (controller.signal.aborted) {
        this.print(
          `  ${faint(`sign-in stopped -- ${label} stays on file;`)} ${info(`/connectors ${name}`)} ${faint("to try again")}`,
        );
      } else {
        this.print(
          `  ${danger(glyph("failure"))} ${muted("sign-in failed --")} ${faint(err instanceof Error ? err.message : String(err))}`,
        );
        if (entry?.gate) this.print(`    ${faint(entry.gate.note)}`);
      }
      return;
    } finally {
      clearTimeout(timer);
      this.connectorWait = null;
    }
    await this.connectorStart(name);
  },

  /**
   * One connector's settings. Loops on the actions that change something in
   * place; returns true after one that ends the flow (a sign-in, a removal,
   * the tool list).
   */
  async connectorDetail(this: Tui, name: string): Promise<boolean> {
    let last: DetailAction | null = null;
    while (true) {
      const row = (await this.ctx.engine.listConnectors()).find((r) => r.name === name);
      if (!row) return false;
      const store = await openCredentialStore();
      const screen = detailScreen(row, await hasSignIn(row.name, store));
      const start = sameActionIndex(screen.choices, last);
      const picked = await this.pick(screen.title, screen.items, start, undefined, screen.footnote);
      if (picked == null) return false;
      last = screen.choices[picked]!;
      if (await this.connectorAction(row, last, store)) return true;
    }
  },

  /** Run one detail action. True when the flow should end. */
  async connectorAction(
    this: Tui,
    row: ConnectorRow,
    action: DetailAction,
    store: CredentialStore,
  ): Promise<boolean> {
    const engine = this.ctx.engine;
    const root = this.ctx.workspaceRoot;
    const label = rowLabel(row);
    switch (action.kind) {
      case "reconnect":
        await this.connectorStart(row.name);
        return false;
      case "sign-in":
        // The stored sign-in stays until the new one succeeds: a cancelled
        // browser tab must not sign the person out. (A client registered for
        // an earlier loopback port is re-registered by the flow itself.)
        await this.connectorSignIn(row.name);
        return true;
      case "token": {
        const entry = entryFor(row);
        const noun = entry?.auth.kind === "token" ? entry.auth.noun : "token";
        const answer = await this.promptLine(`New ${label} ${noun}:`, "", { masked: true });
        if (!answer?.trim()) return false;
        await setConnectorToken(row, answer, root, store);
        this.print(
          `  ${ok(glyph("verified"))} ${muted(`${label} ${noun} replaced`)} ${faint("| in your keychain")}`,
        );
        await this.connectorStart(row.name);
        return false;
      }
      case "sign-out": {
        const had = await forgetSignIn(row.name, store);
        this.print(
          had
            ? `  ${ok(glyph("verified"))} ${muted("signed out of")} ${info(label)} ${faint("| the entry stays")}`
            : `  ${faint(`nothing was stored for ${label}`)}`,
        );
        // The live client still holds the old token in memory until it is
        // started again from what the store now says.
        await engine.restartMcpServer(row.name);
        return false;
      }
      case "option": {
        const option = action.option;
        let value: string | boolean | undefined;
        if (option.kind === "query-value") {
          const answer = await this.promptLine(`${option.ask} (empty: ${option.unset})`, "");
          if (answer == null) return false;
          value = answer.trim() || undefined;
        } else {
          const entry = entryFor(row);
          value = !(entry && optionsIn(entry, row.config.url ?? "")[option.id] === true);
        }
        try {
          setConnectorOption(row, option.id, value, root);
        } catch (err) {
          this.print(
            `  ${danger(glyph("failure"))} ${faint(err instanceof Error ? err.message : String(err))}`,
          );
          return false;
        }
        const shown =
          typeof value === "string"
            ? value
            : value === true
              ? "on"
              : option.kind === "query-value"
                ? option.unset
                : "off";
        this.print(
          `  ${ok(glyph("verified"))} ${muted(`${label} ${option.label.toLowerCase()}:`)} ${info(shown)}`,
        );
        await this.connectorStart(row.name);
        return false;
      }
      case "enable": {
        const scope = setConnectorEnabled(row, action.enabled, root);
        if (!scope) return false;
        if (action.enabled) {
          await this.connectorStart(row.name);
        } else {
          await engine.disconnectMcpServer(row.name);
          this.print(
            `  ${ok(glyph("verified"))} ${info(label)} ${muted("turned off")} ${faint("| its entry and sign-in are kept")}`,
          );
        }
        return false;
      }
      case "move": {
        if (!moveConnector(row, action.to, root)) return false;
        this.print(
          `  ${ok(glyph("verified"))} ${info(label)} ${muted(action.to === "user" ? "is now in every project" : "is now in this project only")}`,
        );
        await engine.restartMcpServer(row.name);
        return false;
      }
      case "tools": {
        const tools = row.status?.tools ?? [];
        this.print(
          [
            `  ${text(label)} ${faint(`| ${tools.length} tools`)}`,
            ...tools.map((t) => `    ${faint(t)}`),
          ].join("\n"),
        );
        return true;
      }
      case "remove": {
        const sure = await this.pick(
          `Remove ${label}?`,
          [
            { label: "Remove", hint: "delete the entry and forget its sign-in" },
            { label: "Keep it" },
          ],
          1,
          undefined,
          "a connector can be added again from /connectors",
        );
        if (sure !== 0) return false;
        await engine.disconnectMcpServer(row.name);
        const out = await removeConnector(row, root, store);
        this.print(
          `  ${ok(glyph("verified"))} ${muted("removed")} ${info(label)}${out.forgot ? faint(" | its sign-in is forgotten") : ""}`,
        );
        if (out.stillOnFile) {
          this.print(
            `    ${faint(`an entry of the same name is still in ${out.stillOnFile === "user" ? "every-project" : "this project's"} file, and its sign-in was kept`)}`,
          );
          await engine.restartMcpServer(row.name);
        }
        return true;
      }
      case "managed":
        this.print(
          `  ${faint(
            row.source === "plugin"
              ? `${label} comes from the plugin ${row.plugin ?? ""}; turn it off with rune plugin disable ${row.plugin ?? ""}`
              : `${label} is Rune's own browser; /browser off removes it`,
          )}`,
        );
        return false;
    }
  },

  /** Search the checked list, the bundled catalog and the public registry together. */
  async connectorSearch(this: Tui, preset?: string): Promise<void> {
    const query = (preset ?? (await this.promptLine("Search connectors:", "")) ?? "").trim();
    if (!query) return;
    let registryOn = true;
    try {
      registryOn = loadConfig().mcp?.registry !== false;
    } catch {
      // A broken config.toml must not stop a search.
    }
    const vendored = loadVendoredCatalog().filter((e) => catalogMatches(e, query));
    const registry = registryOn
      ? (await fetchRegistryCatalog()).filter((e) => catalogMatches(e, query))
      : [];
    const hits = mergeHits(searchDirectory(query), [...vendored, ...registry]);
    if (hits.length === 0) {
      this.print(
        `  ${faint(`nothing matches "${query}" -- /connectors, then "By address or command", adds any MCP server`)}`,
      );
      return;
    }
    const screen = searchScreen(query, hits);
    const picked = await this.pick(screen.title, screen.items, 0, undefined, screen.footnote);
    if (picked == null) return;
    const hit = screen.choices[picked]!;
    const rows = await this.ctx.engine.listConnectors();
    if (hit.kind === "checked") {
      const existing = rows.find((r) => r.name === hit.entry.id);
      if (existing) {
        await this.connectorDetail(existing.name);
        return;
      }
      await this.connectEntry(hit.entry);
      return;
    }
    if (hit.entry.closed) {
      this.print(`  ${warn("!")} ${text(hit.entry.name)} ${muted(`-- ${hit.entry.closed}`)}`);
      return;
    }
    const config = catalogConfig(hit.entry);
    if (!config) {
      this.print(`  ${faint(`${hit.entry.name} publishes no address yet`)}`);
      return;
    }
    await this.connectConfig(cleanName(hit.entry.name), config);
  },

  /** "By address or command": any MCP server, named by the person. */
  async connectorCustom(this: Tui): Promise<void> {
    const target = (
      await this.promptLine("MCP server address (https://...) or command:", "")
    )?.trim();
    if (!target) return;
    const parsed = customConnector(target);
    if (!parsed) {
      this.print(`  ${faint("that is neither an https:// address nor a command")}`);
      return;
    }
    const typed = (await this.promptLine("Name it:", parsed.name))?.trim();
    if (typed == null) return;
    await this.connectConfig(cleanName(typed || parsed.name), parsed.config);
  },

  /** Write a config for a server Rune has not checked, start it, sign in if it asks. */
  async connectConfig(this: Tui, name: string, config: McpServerConfig): Promise<void> {
    const rows = await this.ctx.engine.listConnectors();
    if (rows.some((r) => r.name === name)) {
      this.print(
        `  ${warn("!")} ${muted(`a connector named ${name} is already on file`)} ${info(`/connectors ${name}`)}`,
      );
      return;
    }
    const path = upsertServer("user", this.ctx.workspaceRoot, name, config);
    this.print(
      `  ${ok(glyph("verified"))} ${muted("added")} ${info(name)} ${faint(`| every project${DOT}${path}`)}`,
    );
    await this.connectorStartAndSignIn(name);
  },
};

export type ConnectorMethods = typeof CONNECTOR_METHODS;
