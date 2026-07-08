// ─── Composer — input prompt + status line ───
// readline owns the input line, so the model·dir status line and a hairline rule are
// printed *above* the prompt, with a matching rule on submit — framing each message
// top-and-bottom (a true four-sided live box needs raw mode: the `--tui` path).
// Vermillion/brass flag the looser permission modes so risk is visible at a glance.

import * as os from "os";
import { accent, faint, warn, text, muted, line, bold, stripAnsi, info, ok } from "./theme";
import { truncate, rule, visLen } from "./render";

function shortPath(p: string): string {
  const home = os.homedir();
  return p.startsWith(home) ? "~" + p.slice(home.length) : p;
}

/** The readline prompt: the follow-up arrow. */
export function promptString(): string {
  return `  ${faint("→")} `;
}

export interface ComposerStatus {
  model: string;
  workspace: string;
  /** Permission mode: "confirm" | "auto" | "turing" (legacy "trusted"/"yolo" still accepted). */
  mode?: string;
  /** Context window usage, 0–100 (shown as "N% context used"). */
  contextPercent?: number;
  /** Files edited so far this session (shown as "K files edited"). */
  filesEdited?: number;
  /** True when the OS sandbox is disabled (/sandbox off) — shown as a loud badge. */
  sandboxOff?: boolean;
}

/** Normalize mode aliases onto the internal three-mode vocabulary. The bypass mode is
 *  branded "Hands-Free" to users; its internal token stays "turing" (like "yolo"). */
function normalizeMode(mode?: string): "confirm" | "auto" | "turing" {
  if (mode === "turing" || mode === "yolo" || mode === "hands-free" || mode === "handsfree")
    return "turing";
  if (mode === "auto" || mode === "trusted") return "auto";
  return "confirm";
}

/** The colored badge for a permission mode, or "" for the default (confirm). */
export function permissionModeBadge(mode?: string): string {
  switch (normalizeMode(mode)) {
    case "turing":
      return bold(warn("⚡ HANDS-FREE")); // the yellow bypass mode
    case "auto":
      return warn("● auto");
    default:
      return "";
  }
}

/** The dim two-line footer (Codex-style): the readout, then the key hints.
 *  `model · 23% context used · 2 files edited` / `/ for commands · …` */
export function statusLine(s: ComposerStatus): string {
  const parts: string[] = [s.model];
  if (s.contextPercent != null) parts.push(`${Math.round(s.contextPercent)}% context used`);
  if (s.filesEdited != null && s.filesEdited > 0)
    parts.push(`${s.filesEdited} file${s.filesEdited === 1 ? "" : "s"} edited`);
  if (s.contextPercent == null && s.filesEdited == null) parts.push(shortPath(s.workspace));
  let readout = faint(parts.join(" · "));
  const badge = permissionModeBadge(s.mode);
  if (badge) readout += faint(" · ") + badge;
  if (s.sandboxOff) readout += faint(" · ") + warn("▲ no sandbox");
  const hints = faint("/ for commands · ctrl+r to review work");
  return `  ${readout}\n  ${hints}`;
}

/**
 * A transient one-liner announcing the active permission mode — printed into the
 * transcript each time Shift+Tab cycles. Hands-Free is loud (bold amber) because it
 * silences every prompt; the others are calm.
 */
export function permissionModeBanner(mode?: string): string {
  switch (normalizeMode(mode)) {
    case "turing":
      return (
        `  ${bold(warn("⚡ Hands-Free mode"))} ${faint("·")} ` +
        `${text("Berne will read, write & run commands without asking.")} ` +
        `${faint("(shift+tab to cycle)")}`
      );
    case "auto":
      return (
        `  ${warn("● Auto mode")} ${faint("·")} ` +
        `${muted("in-workspace edits & commands auto-approved; network still asks.")} ` +
        `${faint("(shift+tab to cycle)")}`
      );
    default:
      return (
        `  ${ok("○ Confirm mode")} ${faint("·")} ` +
        `${muted("Berne asks before writing or running.")} ` +
        `${faint("(shift+tab to cycle)")}`
      );
  }
}

/**
 * A transient one-liner announcing the sandbox posture — printed when `/sandbox`
 * toggles (and by `/sandbox` with no argument as a status readout). Off is loud
 * for the same reason Hands-Free is: it removes a containment layer.
 */
export function sandboxModeBanner(enabled: boolean): string {
  return enabled
    ? `  ${ok("◆ Sandbox on")} ${faint("·")} ` +
        `${muted("commands run in an OS sandbox — no network, workspace-confined writes; network: true escalates one call.")} ` +
        `${faint("(/sandbox off for full access)")}`
    : `  ${bold(warn("▲ Sandbox off"))} ${faint("·")} ` +
        `${text("commands run directly on this machine with full network & filesystem access.")} ` +
        `${faint("(/sandbox on to re-enable)")}`;
}

/**
 * A hairline rule spanning the composer width, indented to the `›` chevron.
 * Printed directly above the input — and again on submit — so each message is
 * framed top-and-bottom: the readline-mode echo of Claude/Codex's bordered
 * composer. (A true four-sided live box needs raw mode; that's the `--tui` path.)
 */
export function composerRule(): string {
  return rule();
}

// ─── Pinned composer (TUI) ───

const PAD = "  ";

export interface ComposerState {
  input: string;
  caret: number; // caret index within input
  width: number; // terminal columns
  status: string; // pre-rendered status line (from statusLine())
  working?: string; // when set, show this instead of the input box
}

export interface RenderedBlock {
  lines: string[];
  caretRow: number;
  caretCol: number;
}

/** Placeholder shown in the empty composer (the terminal cursor sits on its first char). */
export const COMPOSER_PLACEHOLDER = "Add a follow-up";

/** The pinned composer: a hairline box, `→` prompt, placeholder when empty,
 *  and the dim multi-line footer beneath — the Codex idiom. */
export function renderComposer(state: ComposerState): RenderedBlock {
  const width = Math.max(28, state.width);
  const statusLines = state.status ? state.status.split("\n") : [];

  if (state.working) {
    return {
      lines: [`${PAD}${state.working}`, ...statusLines],
      caretRow: 0,
      caretCol: stripAnsi(`${PAD}${state.working}`).length,
    };
  }

  const boxW = width - 3; // total box width incl. corners — spans the full terminal, like Codex/Claude
  const innerW = boxW - 4; // cols between "│ " and " │"
  const textW = Math.max(4, innerW - 2); // minus the "→ " prefix

  // Horizontal scroll so the caret stays visible within the window.
  let scroll = 0;
  if (state.caret > textW - 1) scroll = state.caret - textW + 1;
  // Newlines/control chars would spill the "single-line" box across rows and break the pinned
  // region's row math — flatten them to spaces (pastes are collapsed to chips upstream, but a stray
  // control byte must never desync the frame).
  const slice = state.input
    .slice(scroll, scroll + textW)
    .replace(/[\r\n\t\x00-\x08\x0b-\x1f]/g, " ");
  const body =
    state.input.length === 0
      ? faint(COMPOSER_PLACEHOLDER.padEnd(textW, " ").slice(0, textW))
      : text(slice.padEnd(textW, " "));

  const top = `${PAD}${line("╭" + "─".repeat(boxW - 2) + "╮")}`;
  const mid = `${PAD}${line("│")} ${faint("→")} ${body} ${line("│")}`;
  const bot = `${PAD}${line("╰" + "─".repeat(boxW - 2) + "╯")}`;

  // PAD(2) + "│"(1) + " "(1) + "→"(1) + " "(1) = 6 cols before the input text.
  const caretCol = 6 + (state.caret - scroll);
  return { lines: [top, mid, bot, ...statusLines], caretRow: 1, caretCol };
}

// ─── Permission request card (TUI) ───

/**
 * A human title + one clean line of detail for a permission request. The broker's
 * `argsSummary` repeats the tool name ("bash: ls -R", "write_file /x"); strip that so
 * the card reads "Run shell command / ls -R" instead of "Allow bash — bash: ls -R".
 */
export function permissionView(
  toolName: string,
  argsSummary: string,
): { title: string; body: string } {
  // The summarizer prefixes its detail with "<tool>: " (bash) or "<tool> " (others).
  // Strip that leading "<tool>" + separator so the title isn't echoed in the body.
  const esc = toolName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const body = (argsSummary ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(new RegExp("^" + esc + "(?::|\\s)\\s*"), "");
  const titles: Record<string, string> = {
    bash: "Run shell command",
    write_file: "Write file",
    edit_file: "Edit file",
    multi_edit: "Edit file",
    web_fetch: "Fetch from the web",
    web_search: "Search the web",
  };
  return { title: titles[toolName] ?? `Run ${toolName}`, body: body || toolName };
}

/** The allow / session / deny key hints — one shared line for both card and compact layouts. */
function permissionKeys(pad: string, gap: string): string {
  return (
    `${pad}${ok("enter")} ${muted("allow")}` +
    `${gap}${warn("s")} ${muted("session")}` +
    `${gap}${accent("n")} ${muted("deny")}`
  );
}

/**
 * The permission prompt shown while a tool awaits confirmation — it replaces the pinned
 * composer. A titled rounded box names the action and shows the command/target; the
 * allow/session/deny keys sit on the line below. A leading blank line separates it from
 * the activity stream so the ask never glues onto the notice above it. Narrow terminals
 * fall back to a compact two-line form.
 */
export function renderPermissionCard(
  toolName: string,
  argsSummary: string,
  width: number,
): RenderedBlock {
  const { title, body } = permissionView(toolName, argsSummary);

  // Compact form for narrow terminals — the titled box needs room to breathe.
  if (width < 52) {
    const detail = truncate(body, Math.max(8, width - title.length - 8));
    const q = `${PAD}${warn("?")} ${bold(warn(title))} ${faint("—")} ${text(detail)}`;
    return { lines: ["", q, permissionKeys(PAD, "   ")], caretRow: 2, caretCol: 2 };
  }

  const boxW = width - 3; // spans the terminal like the composer box
  const innerW = boxW - 4; // cols between "│ " and " │"

  // Top border with an inlaid title:  ╭─ ? Run shell command ──────╮
  // Truncate the title so the border keeps ≥4 trailing dashes and never overflows.
  const titleStr = truncate(title, Math.max(6, boxW - 11));
  const titleW = 2 + visLen(titleStr); // "? " + title (visible width)
  const dashes = Math.max(4, boxW - 5 - titleW);
  const top = `${PAD}${line("╭─")} ${warn("?")} ${bold(warn(titleStr))} ${line("─".repeat(dashes) + "╮")}`;

  const shown = truncate(body, innerW);
  const fill = Math.max(0, innerW - visLen(shown));
  const mid = `${PAD}${line("│")} ${text(shown)}${" ".repeat(fill)} ${line("│")}`;
  const bot = `${PAD}${line("╰" + "─".repeat(boxW - 2) + "╯")}`;

  // Caret parks on the default action ("enter") two cols into the keys line.
  return {
    lines: ["", top, mid, bot, permissionKeys(PAD + "  ", "      ")],
    caretRow: 4,
    caretCol: 4,
  };
}

// ─── List picker overlay (TUI: /model) ───

export interface PickerItem {
  label: string;
  hint?: string;
}

export function renderPicker(
  title: string,
  items: PickerItem[],
  selected: number,
  width: number,
): RenderedBlock {
  const lines: string[] = [`${PAD}${bold(text(title))}`];
  items.forEach((it, i) => {
    const on = i === selected;
    const marker = on ? accent("❯") : " ";
    const label = on ? text(it.label) : muted(it.label);
    const hint = it.hint ? "  " + faint(truncate(it.hint, 40)) : "";
    lines.push(`${PAD}${marker} ${label}${hint}`);
  });
  lines.push(`${PAD}${faint("↑/↓ select · enter confirm · esc cancel")}`);
  return { lines, caretRow: selected + 1, caretCol: 0 };
}

// ─── Slash-command palette (TUI: live `/` menu) ───

export interface SlashItem {
  /** Command including its leading "/" (e.g. "/model"). */
  name: string;
  /** One-line description. */
  desc: string;
}

/**
 * The slash-command menu that floats above the composer as you type `/` — a filtered,
 * highlightable list (Codex/Claude-style). Returns plain lines the caller stacks on top
 * of the input box. Windows around the selection so a long list never overruns.
 */
export function renderSlashPalette(items: SlashItem[], selected: number, width: number): string[] {
  if (items.length === 0) return [];
  const MAX = 8;
  const sel = Math.max(0, Math.min(selected, items.length - 1));
  let start = 0;
  if (items.length > MAX)
    start = Math.min(Math.max(0, sel - Math.floor(MAX / 2)), items.length - MAX);
  const view = items.slice(start, start + MAX);
  const nameW = Math.min(18, Math.max(...view.map((it) => it.name.length)));
  const descMax = Math.max(8, width - nameW - 8);

  const rows = view.map((it, i) => {
    const on = start + i === sel;
    const marker = on ? accent("❯") : " ";
    const name = (on ? text : info)(it.name.padEnd(nameW));
    const desc = it.desc ? "  " + faint(truncate(it.desc, descMax)) : "";
    return `${PAD}${marker} ${name}${desc}`;
  });
  rows.push(`${PAD}${faint("↑↓ navigate · tab complete · enter run · esc cancel")}`);
  return rows;
}

// ─── API keys panel (TUI: `/keys` BYOK) ───

export interface KeyRow {
  /** Provider id. */
  id: string;
  /** Display label. */
  label: string;
  /** Masked key for display (never the raw secret); "" when unset. */
  masked: string;
  /** Where the key came from. */
  source: "saved" | "env" | "none";
  /** Usable now (has a key, or a configured/active local runtime). */
  hasKey?: boolean;
  /** Toggled off (key kept but excluded). */
  disabled: boolean;
  /** The session's active provider. */
  active: boolean;
  /** A local runtime (ollama / lmstudio) reached by base URL, no key. */
  local?: boolean;
  /** Resolved base URL for a local runtime (shown in place of a key). */
  endpoint?: string;
}

/**
 * The `/keys` panel: every provider with its status dot, masked key, source, and
 * on/off toggle. A leading `❯` marks the selected row. Returns a RenderedBlock so
 * the TUI can pin it like the picker; the caret is parked on the selected row.
 */
export function renderKeysPanel(rows: KeyRow[], selected: number, width: number): RenderedBlock {
  const sel = rows.length ? Math.max(0, Math.min(selected, rows.length - 1)) : 0;
  const labelW = Math.min(15, Math.max(8, ...rows.map((r) => r.label.length), 8));
  const keyW = Math.max(10, Math.min(22, width - labelW - 24));

  const lines: string[] = [
    `${PAD}${bold(text("API keys"))}   ${faint("bring your own — applied live, saved to ~/.alan/secrets.json")}`,
  ];

  rows.forEach((r, i) => {
    const on = i === sel;
    // Local runtimes are usable without a key; treat a configured/active one as "ready".
    const ready = r.local ? !!r.hasKey : r.source !== "none";
    const marker = on ? accent("❯") : " ";
    const dot = r.disabled ? faint("○") : r.active ? ok("●") : ready ? info("●") : faint("○");
    const name = (on ? text : muted)(r.label.padEnd(labelW));
    const keyCell = r.local
      ? faint(truncate(r.endpoint || "—", keyW).padEnd(keyW))
      : r.source === "none"
        ? faint("not set".padEnd(keyW))
        : text(truncate(r.masked || "set", keyW).padEnd(keyW));
    const srcCell = r.local
      ? faint("local".padEnd(6))
      : r.source === "saved"
        ? faint("saved".padEnd(6))
        : r.source === "env"
          ? faint("env".padEnd(6))
          : faint(" ".repeat(6));
    const toggle = r.disabled ? warn("off") : ready ? ok("on") : faint("·");
    lines.push(`${PAD}${marker} ${dot} ${name} ${keyCell} ${srcCell} ${toggle}`);
  });

  lines.push(`${PAD}${faint("↑↓ move · enter edit · space on/off · d clear · esc close")}`);
  return { lines, caretRow: sel + 1, caretCol: 0 };
}

// ─── System Memory panel (TUI: `/memory`) ───

export interface MemoryPanelView {
  /** The profile markdown (may be empty). */
  content: string;
  /** Human cadence label, e.g. "weekly", "manual". */
  scheduleLabel: string;
  tokens: number;
  maxTokens: number;
  /** Relative time of the last automatic refresh, or "never". */
  lastDreamed: string;
  /** A refresh ("dream") is running right now. */
  busy: boolean;
  /** A transient status note (e.g. "refreshed · ~120 tokens"). */
  note?: string;
  /** Clear is armed for a confirming second press. */
  pendingClear: boolean;
}

/** Number of selectable actions in the memory panel (refresh/cadence/add/edit/clear). */
export const MEMORY_ACTION_COUNT = 5;

/**
 * The `/memory` panel: the evergreen profile with a row of single-key actions
 * (refresh / cadence / add note / edit / clear). Mirrors the keys + picker panels;
 * a leading `❯` marks the selected action and the caret parks on it.
 */
export function renderMemoryPanel(
  v: MemoryPanelView,
  selected: number,
  width: number,
): RenderedBlock {
  const sel = Math.max(0, Math.min(selected, MEMORY_ACTION_COUNT - 1));
  const innerW = Math.max(20, width - 6);
  const lines: string[] = [];

  lines.push(
    `${PAD}${bold(text("System memory"))}   ${faint("a guide Berne tailors to — it never overrides what you ask")}`,
  );
  const empty = !v.content.trim();
  lines.push(
    `${PAD}${faint(
      empty
        ? `empty · auto-update ${v.scheduleLabel}`
        : `~${v.tokens}/${v.maxTokens} tokens · auto-update ${v.scheduleLabel} · dreamed ${v.lastDreamed}`,
    )}`,
  );
  lines.push("");

  if (empty) {
    lines.push(`${PAD}${muted("Berne hasn't learned about you yet.")}`);
    lines.push(
      `${PAD}${faint("Refresh to learn from recent sessions, add a note, or write it yourself.")}`,
    );
  } else {
    const body = v.content.split("\n");
    const MAX = 10;
    for (const ln of body.slice(0, MAX)) lines.push(`${PAD}${faint(truncate(ln, innerW))}`);
    if (body.length > MAX) {
      lines.push(`${PAD}${faint(`…(+${body.length - MAX} more lines · edit to see all)`)}`);
    }
  }
  lines.push("");

  const actionStart = lines.length;
  const row = (i: number, label: string, hint: string) => {
    const on = i === sel;
    const marker = on ? accent("❯") : " ";
    const lab = on ? text(label) : muted(label);
    lines.push(`${PAD}${marker} ${lab}${hint ? "   " + faint(hint) : ""}`);
  };
  row(0, "Refresh now", v.busy ? "dreaming…" : "learn from your recent sessions");
  row(1, `Auto-update: ${v.scheduleLabel}`, "↵ cycles manual · daily · 3d · weekly");
  row(2, "Add a note", "jot a quick fact about you");
  row(3, "Edit in your editor", "open the full profile in $EDITOR");
  row(
    4,
    v.pendingClear ? "Clear — press again to confirm" : "Clear",
    v.pendingClear ? "" : "wipe the profile (keeps your cadence)",
  );

  if (v.busy) lines.push(`${PAD}${ok("✦")} ${muted("dreaming — distilling your profile…")}`);
  else if (v.note) lines.push(`${PAD}${ok("✓")} ${muted(v.note)}`);
  lines.push(
    `${PAD}${faint("↑↓ move · enter choose · r refresh · c cadence · a add · e edit · x clear · esc close")}`,
  );

  return { lines, caretRow: actionStart + sel, caretCol: 0 };
}

// ─── Sessions manager panel (TUI: `/sessions`) ───

export interface SessionRowView {
  /** Resolved display title (already falls back to "untitled"). */
  title: string;
  /** Pre-rendered meta line, e.g. "2h ago · 14 msgs · qwen3-coder:480b". */
  meta: string;
  /** The session currently loaded in this window. */
  current: boolean;
}

/**
 * The `/sessions` manager: every stored conversation with a status dot, its
 * title and a meta line (age · message count · model). A leading `❯` marks the
 * selection; the active session gets a filled dot. Windows around the selection
 * so a long history never overruns the viewport. Returns a RenderedBlock so the
 * TUI can pin it like the picker.
 */
export function renderSessionsPanel(
  rows: SessionRowView[],
  selected: number,
  opts: { view: "active" | "archived"; pendingDelete: boolean },
  width: number,
): RenderedBlock {
  const heading =
    opts.view === "archived"
      ? `${bold(text("Sessions"))}  ${faint("· archived")}`
      : `${bold(text("Sessions"))}`;

  if (rows.length === 0) {
    const empty =
      opts.view === "archived" ? "No archived sessions." : "No sessions yet — start chatting.";
    return {
      lines: [
        `${PAD}${heading}`,
        `${PAD}${faint(empty)}`,
        `${PAD}${faint("tab toggle active/archived · esc close")}`,
      ],
      caretRow: 1,
      caretCol: 0,
    };
  }

  const MAX = 12;
  const sel = Math.max(0, Math.min(selected, rows.length - 1));
  let start = 0;
  if (rows.length > MAX)
    start = Math.min(Math.max(0, sel - Math.floor(MAX / 2)), rows.length - MAX);
  const view = rows.slice(start, start + MAX);

  const titleW = Math.min(42, Math.max(16, ...view.map((r) => stripAnsi(r.title).length)));

  const lines: string[] = [`${PAD}${heading}   ${faint(`${rows.length} total`)}`];
  view.forEach((r, i) => {
    const idx = start + i;
    const on = idx === sel;
    const marker = on ? accent("❯") : " ";
    const dot = r.current ? ok("●") : faint("○");
    const titleCell = (on ? text : muted)(truncate(r.title, titleW).padEnd(titleW));
    const meta = faint(truncate(r.meta, Math.max(12, width - titleW - 12)));
    lines.push(`${PAD}${marker} ${dot} ${titleCell}  ${meta}`);
  });
  if (rows.length > MAX) {
    lines.push(`${PAD}  ${faint(`showing ${start + 1}–${start + view.length} of ${rows.length}`)}`);
  }

  const hint = opts.pendingDelete
    ? `${warn("press d again to delete")} ${faint("·")} ${faint("esc cancels")}`
    : opts.view === "archived"
      ? `${faint("↑↓ move · ↵ resume · u restore · d delete · tab active · esc close")}`
      : `${faint("↑↓ move · ↵ resume · r rename · a archive · d delete · tab archived · esc close")}`;
  lines.push(`${PAD}${hint}`);

  // Park the caret on the selected visible row (header offsets it by one).
  return { lines, caretRow: sel - start + 1, caretCol: 0 };
}

export interface KeyEditorState {
  title: string;
  subtitle?: string;
  value: string;
  caret: number;
  width: number;
  /** Mask the value (API keys); false for plain fields like a base URL. */
  masked: boolean;
}

/** The single-field editor shown when adding a key (or a custom endpoint field). */
export function renderKeyEditor(s: KeyEditorState): RenderedBlock {
  const width = Math.max(28, s.width);
  const boxW = width - 3;
  const innerW = boxW - 4;
  const textW = Math.max(4, innerW - 2);

  const display = s.masked ? maskField(s.value) : s.value;
  let scroll = 0;
  if (s.caret > textW - 1) scroll = s.caret - textW + 1;
  const slice = display.slice(scroll, scroll + textW);

  const head = `${PAD}${bold(text(s.title))}`;
  const sub = s.subtitle ? `${PAD}${faint(truncate(s.subtitle, boxW))}` : "";
  const top = `${PAD}${line("╭" + "─".repeat(boxW - 2) + "╮")}`;
  const mid = `${PAD}${line("│")} ${accent("›")} ${text(slice.padEnd(textW, " "))} ${line("│")}`;
  const bot = `${PAD}${line("╰" + "─".repeat(boxW - 2) + "╯")}`;
  const hint = `${PAD}${faint("enter save · esc cancel · paste supported")}`;

  const lines = sub ? [head, sub, top, mid, bot, hint] : [head, top, mid, bot, hint];
  const caretRow = sub ? 3 : 2;
  const caretCol = 6 + (s.caret - scroll);
  return { lines, caretRow, caretCol };
}

/** Mask a value for the editor: dots for all but the last 4 characters. */
function maskField(v: string): string {
  if (v.length <= 4) return "•".repeat(v.length);
  return "•".repeat(v.length - 4) + v.slice(-4);
}
