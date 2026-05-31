// ─── Composer — input prompt + status line ───
// readline owns the input line, so the model·dir status line is printed *above* the
// prompt (a true below-cursor pinned line is Phase 2). Vermillion/brass flag the
// looser permission modes so risk is visible at a glance.

import * as os from "os";
import { accent, faint, warn, text, muted, line, bold, stripAnsi } from "./theme";
import { truncate } from "./render";

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

  const boxW = Math.min(width - 3, 100); // total box width incl. corners
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
