// --- /connectors -- pure rows for the connector screens ---
//
// Three screens, all on the shared picker:
//
//   home      what is connected (state, tools, where it applies), then the
//             ways to add one: four shelves of checked services, a search
//             across everything, and "by address or command"
//   shelf     one category's checked services, each saying how it signs in
//   detail    one connector's actions: sign in, settings, on/off, where it
//             applies, its tools, remove
//
// Everything here is pure: the TUI hands in rows and renders what comes back,
// so every screen is unit-testable without a terminal (the same split as
// login-picker.ts).

import {
  CATEGORY_LABELS,
  CONNECTOR_DIRECTORY,
  optionsIn,
  withArticle,
  type CatalogEntry,
  type DirectoryCategory,
  type DirectoryEntry,
  type DirectoryOption,
  type McpScope,
} from "@rune/tool-registry";
import {
  connectorState,
  editable,
  entryFor,
  signInOf,
  type ConnectorRow,
  type ConnectorState,
} from "../../connectors";
import type { PickerItem } from "./composer";
import { glyph } from "./glyphs";
import { danger, faint, ok, warn } from "./theme";

const DOT = " \u00b7 ";

/** The shelves, in the order a coding agent reaches for them. */
export const SHELVES: readonly DirectoryCategory[] = ["developer", "docs", "work", "design"];

/** A connector's state mark: the live glyph, inked by how it is doing. */
export function stateMark(state: ConnectorState): string {
  const mark = glyph("live");
  if (state === "connected") return ok(mark);
  if (state === "connecting" || state === "degraded") return warn(mark);
  if (state === "needs sign-in" || state === "down") return danger(mark);
  return faint(mark);
}

/** The name a row reads as: the checked entry's label, else its config name. */
export function rowLabel(row: ConnectorRow): string {
  return entryFor(row)?.label ?? row.name;
}

/** Where a connector applies, in the person's words. */
export function whereWord(row: ConnectorRow): string {
  if (row.source === "user") return "every project";
  if (row.source === "workspace") return "this project";
  if (row.source === "plugin") return `plugin ${row.plugin ?? ""}`.trim();
  return "built in";
}

/** How a checked entry signs in, as a hint. */
export function signInWord(entry: DirectoryEntry): string {
  const auth = entry.auth;
  if (auth.kind === "oauth") return "browser sign-in";
  if (auth.kind === "token")
    return auth.optional ? `${auth.noun} optional` : `paste ${withArticle(auth.noun)}`;
  if (auth.kind === "cli") return "runs locally, signs in with its CLI";
  return entry.command ? "runs locally" : "no sign-in";
}

function stateHint(row: ConnectorRow): string {
  const state = connectorState(row);
  const tools = row.status?.toolCount ?? 0;
  return state === "connected" || state === "degraded" ? `${state}${DOT}${tools} tools` : state;
}

// --- home ---

export type HomeChoice =
  | { kind: "connector"; row: ConnectorRow }
  | { kind: "shelf"; category: DirectoryCategory }
  | { kind: "search" }
  | { kind: "custom" };

export interface ConnectorScreen<C> {
  title: string;
  items: PickerItem[];
  choices: C[];
  footnote: string;
}

export function homeScreen(rows: readonly ConnectorRow[]): ConnectorScreen<HomeChoice> {
  const items: PickerItem[] = [];
  const choices: HomeChoice[] = [];
  const states = rows.map(connectorState);
  const connected = states.filter((s) => s === "connected" || s === "degraded").length;
  const attention = states.filter((s) => s === "needs sign-in" || s === "down").length;

  rows.forEach((row, i) => {
    const state = states[i]!;
    const entry = entryFor(row);
    items.push({
      label: rowLabel(row),
      prefix: stateMark(state),
      hint: stateHint(row),
      tags: [whereWord(row)],
      description:
        state === "needs sign-in"
          ? "enter, then sign in"
          : state === "down" && row.status?.lastError
            ? row.status.lastError.replace(/\s+/g, " ")
            : (entry?.blurb ?? row.config.url ?? row.config.command ?? ""),
    });
    choices.push({ kind: "connector", row });
  });

  const configured = new Set(rows.map((r) => r.name));
  for (const category of SHELVES) {
    const shelf = CONNECTOR_DIRECTORY.filter((e) => e.category === category);
    const fresh = shelf.filter((e) => !configured.has(e.id));
    const names = shelf.slice(0, 4).map((e) => e.label);
    items.push({
      label: CATEGORY_LABELS[category],
      prefix: faint("+"),
      hint: `${names.join(", ")}${shelf.length > 4 ? ` +${shelf.length - 4}` : ""}`,
      description:
        fresh.length === 0
          ? "every service on this shelf is already on file"
          : `${shelf.length} services, each checked by hand: address and sign-in`,
    });
    choices.push({ kind: "shelf", category });
  }
  items.push({
    label: "Search everything",
    prefix: faint("+"),
    hint: "checked list, bundled catalog, MCP registry",
    description: "only the checked list was looked at by hand; the rest is marked not checked",
  });
  choices.push({ kind: "search" });
  items.push({
    label: "By address or command",
    prefix: faint("+"),
    hint: "any MCP server: https://... or a command line",
  });
  choices.push({ kind: "custom" });

  const summary =
    rows.length === 0
      ? "none yet"
      : [
          `${connected} connected`,
          ...(attention > 0 ? [`${attention} need${attention === 1 ? "s" : ""} attention`] : []),
        ].join(DOT);
  return {
    title: `Connectors${DOT}${summary}`,
    items,
    choices,
    footnote: "gives the agent a service's tools; sign-ins stay in your keychain",
  };
}

// --- a shelf ---

export function shelfScreen(
  category: DirectoryCategory,
  rows: readonly ConnectorRow[],
): ConnectorScreen<DirectoryEntry> {
  const byName = new Map(rows.map((r) => [r.name, r]));
  const entries = CONNECTOR_DIRECTORY.filter((e) => e.category === category);
  const items = entries.map((entry): PickerItem => {
    const row = byName.get(entry.id);
    return {
      label: entry.label,
      hint: `${entry.blurb}${DOT}${signInWord(entry)}`,
      current: row ? connectorState(row) === "connected" : false,
      tags: row ? [connectorState(row)] : [],
      description: entry.gate?.note ?? `${entry.blurb}; ${signInWord(entry)}`,
    };
  });
  return {
    title: `Connectors${DOT}${CATEGORY_LABELS[category]}`,
    items,
    choices: entries,
    footnote: "enter connects; one already on file opens its settings",
  };
}

// --- search ---

export type SearchHit =
  { kind: "checked"; entry: DirectoryEntry } | { kind: "catalog"; entry: CatalogEntry };

/**
 * One list across the three sources, most checked first. A bundled or
 * registry entry that shares a checked entry's name is dropped: the checked
 * one is the same service with an address someone looked at.
 */
export function mergeHits(
  checked: readonly DirectoryEntry[],
  others: readonly CatalogEntry[],
  limit = 40,
): SearchHit[] {
  const out: SearchHit[] = checked.map((entry) => ({ kind: "checked" as const, entry }));
  const seen = new Set(CONNECTOR_DIRECTORY.map((e) => e.id));
  for (const entry of others) {
    const key = entry.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: "catalog", entry });
  }
  return out.slice(0, limit);
}

export function searchScreen(
  query: string,
  hits: readonly SearchHit[],
): ConnectorScreen<SearchHit> {
  const items = hits.map((hit): PickerItem => {
    if (hit.kind === "checked") {
      return {
        label: hit.entry.label,
        hint: `${hit.entry.blurb}${DOT}${signInWord(hit.entry)}`,
        tags: ["checked"],
        description: hit.entry.gate?.note ?? hit.entry.blurb,
      };
    }
    const e = hit.entry;
    const where = e.url ?? [e.command, ...(e.args ?? [])].filter(Boolean).join(" ");
    return {
      label: e.name,
      hint: e.closed ? "cannot connect" : (e.description ?? where),
      tags: [
        e.closed
          ? "closed"
          : e.source === "registry"
            ? "registry, not checked"
            : "bundled, not checked",
      ],
      description: e.closed ?? (where || "no address published"),
    };
  });
  return {
    title: `Connectors${DOT}"${query}"${DOT}${hits.length} found`,
    items,
    choices: [...hits],
    footnote: "not checked: Rune has not looked at its address or sign-in",
  };
}

// --- one connector ---

export type DetailAction =
  | { kind: "reconnect" }
  | { kind: "sign-in" }
  | { kind: "token" }
  | { kind: "sign-out" }
  | { kind: "option"; option: DirectoryOption }
  | { kind: "enable"; enabled: boolean }
  | { kind: "move"; to: McpScope }
  | { kind: "tools" }
  | { kind: "remove" }
  | { kind: "managed" };

/**
 * Where the cursor goes when the settings screen is drawn again after an
 * action: on the same action, wherever it now sits. The list changes shape as
 * things change ("Sign out" goes, "Reconnect" goes with "Turn off"), and a
 * cursor left at the old row number puts a second enter on a different action.
 */
export function sameActionIndex(
  actions: readonly DetailAction[],
  last: DetailAction | null,
): number {
  if (!last) return 0;
  const i = actions.findIndex(
    (a) =>
      a.kind === last.kind &&
      (a.kind !== "option" || (last.kind === "option" && a.option.id === last.option.id)),
  );
  return Math.max(0, i);
}

export function detailScreen(row: ConnectorRow, signedIn: boolean): ConnectorScreen<DetailAction> {
  const items: PickerItem[] = [];
  const actions: DetailAction[] = [];
  const add = (item: PickerItem, action: DetailAction) => {
    items.push(item);
    actions.push(action);
  };
  const entry = entryFor(row);
  const how = signInOf(row);
  const off = row.config.enabled === false;

  if (!off) {
    add({ label: "Reconnect", hint: "start it again with what is on file" }, { kind: "reconnect" });
  }
  if (how === "oauth") {
    add(
      {
        label: signedIn ? "Sign in again" : "Sign in",
        hint: "in your browser",
        description: entry?.gate?.note,
      },
      { kind: "sign-in" },
    );
  }
  if (how === "token" || (entry?.auth.kind === "token" && editable(row))) {
    const auth = entry?.auth.kind === "token" ? entry.auth : undefined;
    const noun = auth?.noun ?? "token";
    add(
      {
        label: how === "token" ? `Replace ${noun}` : `Add ${noun}`,
        hint: `paste ${withArticle(`new ${noun}`)}`,
        description: auth
          ? `create one at ${auth.createAt}${auth.optional ? "; optional, it raises limits" : ""}`
          : undefined,
      },
      { kind: "token" },
    );
  }
  if (signedIn) {
    add(
      { label: "Sign out", hint: "forget the stored sign-in; the entry stays" },
      { kind: "sign-out" },
    );
  }
  if (entry && editable(row)) {
    const values = optionsIn(entry, row.config.url ?? "");
    for (const option of entry.options ?? []) {
      const v = values[option.id];
      const shown =
        option.kind === "query-value"
          ? typeof v === "string"
            ? v
            : option.unset
          : v === true
            ? "on"
            : "off";
      add({ label: `${option.label}: ${shown}`, hint: option.hint }, { kind: "option", option });
    }
  }
  if (editable(row)) {
    add(
      off
        ? { label: "Turn on", hint: "start using it again" }
        : { label: "Turn off", hint: "keep it on file, stop using it" },
      { kind: "enable", enabled: off },
    );
    add(
      row.source === "user"
        ? { label: "Use in this project only", hint: "move it into this project's .rune/mcp.json" }
        : { label: "Use in every project", hint: "move it into ~/.rune/mcp.json" },
      { kind: "move", to: row.source === "user" ? "workspace" : "user" },
    );
  }
  const tools = row.status?.tools ?? [];
  if (tools.length > 0) {
    add({ label: "Tools", hint: `${tools.length} tools` }, { kind: "tools" });
  }
  if (editable(row)) {
    add(
      {
        label: "Remove",
        hint: "delete the entry and forget its sign-in",
        description: row.shadowed
          ? "the entry in every-project scope with the same name takes its place"
          : undefined,
      },
      { kind: "remove" },
    );
  } else {
    add(
      {
        label:
          row.source === "plugin"
            ? `Managed by plugin ${row.plugin ?? ""}`.trim()
            : "Managed by /browser",
        hint:
          row.source === "plugin"
            ? `rune plugin disable ${row.plugin ?? ""}`.trim()
            : "/browser off removes it",
      },
      { kind: "managed" },
    );
  }

  const address = row.config.url ?? [row.config.command, ...(row.config.args ?? [])].join(" ");
  return {
    title: `${rowLabel(row)}${DOT}${stateHint(row)}`,
    items,
    choices: actions,
    footnote: `${whereWord(row)}${DOT}${address}`,
  };
}
