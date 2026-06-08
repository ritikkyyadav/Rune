// ─── Composer — input prompt + status line ───
// readline owns the input line, so the model·dir status line and a hairline rule are
// printed *above* the prompt, with a matching rule on submit — framing each message
// top-and-bottom (a true four-sided live box needs raw mode: the `--tui` path).
// Vermillion/brass flag the looser permission modes so risk is visible at a glance.

import * as os from "os";
import { accent, faint, warn, text, muted, line, bold, stripAnsi, info, ok } from "./theme";
import { truncate, rule } from "./render";

function shortPath(p: string): string {
  const home = os.homedir();
  return p.startsWith(home) ? "~" + p.slice(home.length) : p;
}

/** The readline prompt: a single `›` chevron. */
export function promptString(): string {
  return `  ${accent("›")} `;
}

export interface ComposerStatus {
  model: string;
  effort?: string;
  workspace: string;
  /** "confirm" | "trusted" | "yolo" */
  mode?: string;
}

/** Dimmed `model effort · ~/dir` line, with a colored flag for non-default modes. */
export function statusLine(s: ComposerStatus): string {
  const dir = shortPath(s.workspace);
  const model = s.model + (s.effort ? " " + s.effort : "");
  let out = faint(`${model} · ${dir}`);
  if (s.mode === "yolo") out += faint(" · ") + accent("yolo");
  else if (s.mode === "trusted") out += faint(" · ") + warn("trusted");
  return `  ${out}`;
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

/** The pinned composer: a rounded input box (horizontally scrolled) + status line. */
export function renderComposer(state: ComposerState): RenderedBlock {
  const width = Math.max(28, state.width);

  if (state.working) {
    return {
      lines: [`${PAD}${state.working}`, state.status],
      caretRow: 0,
      caretCol: stripAnsi(`${PAD}${state.working}`).length,
    };
  }

  const boxW = width - 3; // total box width incl. corners — spans the full terminal, like Codex/Claude
  const innerW = boxW - 4; // cols between "│ " and " │"
  const textW = Math.max(4, innerW - 2); // minus the "› " prefix

  // Horizontal scroll so the caret stays visible within the window.
  let scroll = 0;
  if (state.caret > textW - 1) scroll = state.caret - textW + 1;
  const slice = state.input.slice(scroll, scroll + textW);

  const top = `${PAD}${line("╭" + "─".repeat(boxW - 2) + "╮")}`;
  const mid = `${PAD}${line("│")} ${accent("›")} ${text(slice.padEnd(textW, " "))} ${line("│")}`;
  const bot = `${PAD}${line("╰" + "─".repeat(boxW - 2) + "╯")}`;

  // PAD(2) + "│"(1) + " "(1) + "›"(1) + " "(1) = 6 cols before the input text.
  const caretCol = 6 + (state.caret - scroll);
  return { lines: [top, mid, bot, state.status], caretRow: 1, caretCol };
}

// ─── List picker overlay (TUI: /model, /effort) ───

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
  if (items.length > MAX) start = Math.min(Math.max(0, sel - Math.floor(MAX / 2)), items.length - MAX);
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
  /** Toggled off (key kept but excluded). */
  disabled: boolean;
  /** The session's active provider. */
  active: boolean;
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
    const hasKey = r.source !== "none";
    const marker = on ? accent("❯") : " ";
    const dot = r.disabled
      ? faint("○")
      : r.active
        ? ok("●")
        : hasKey
          ? info("●")
          : faint("○");
    const name = (on ? text : muted)(r.label.padEnd(labelW));
    const keyCell =
      r.source === "none"
        ? faint("not set".padEnd(keyW))
        : text(truncate(r.masked || "set", keyW).padEnd(keyW));
    const srcCell =
      r.source === "saved"
        ? faint("saved".padEnd(6))
        : r.source === "env"
          ? faint("env".padEnd(6))
          : faint(" ".repeat(6));
    const toggle = r.disabled ? warn("off") : hasKey ? ok("on") : faint("·");
    lines.push(`${PAD}${marker} ${dot} ${name} ${keyCell} ${srcCell} ${toggle}`);
  });

  lines.push(`${PAD}${faint("↑↓ move · enter edit · space on/off · d clear · esc close")}`);
  return { lines, caretRow: sel + 1, caretCol: 0 };
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
