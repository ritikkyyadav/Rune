// ─── Composer — input prompt + status line ───
// The composer is an open writing surface: one quiet hairline, no heavy card chrome,
// and a footer that keeps control state visible. Readline and raw-mode TUI use the
// same language so switching surfaces never feels like switching products.

import { configModeToPermissionMode, type PermissionMode } from "../../permissions";
import * as os from "os";
import {
  isOsIsolationAvailable,
  isSandboxEnabled,
  getSandboxCapability,
} from "@alan/tool-registry";
import {
  accent,
  faint,
  warn,
  text,
  muted,
  line,
  bold,
  stripAnsi,
  info,
  ok,
  brand,
  panel,
  selection,
  hairline,
  popoverSurface,
  codeSurface,
  chip,
} from "./theme";
import { clampVisible, truncate, rule, visLen, wrap, meterGlyphs, railCard } from "./render";
import { GEAR_MARK } from "./banner";
import type { PermissionPreview, PermissionPreviewLine } from "./permission-preview";

function shortPath(p: string): string {
  const home = os.homedir();
  return p.startsWith(home) ? "~" + p.slice(home.length) : p;
}

/** The readline prompt: the follow-up arrow. */
export function promptString(): string {
  return `  ${muted("›")} `;
}

export interface ComposerStatus {
  model: string;
  workspace: string;
  /** Permission mode in the five-state Confirm/Autonomy/Auto cycle. */
  mode?: string;
  /** Context window usage, 0–100 (shown as "N% context used"). */
  contextPercent?: number;
  /** Files edited so far this session (shown as "K files edited"). */
  filesEdited?: number;
  /** True when the OS sandbox is disabled (/sandbox off) — shown as a loud badge. */
  sandboxOff?: boolean;
  /** Active session-loop readout, e.g. "loop · in 5m". */
  loop?: string;
  /** Current surface mode, kept visible so light/dark is never hidden state. */
  theme?: "light" | "dark" | "auto" | string;
}

export type PermissionModeId = PermissionMode;

/** Normalize any spelling (canonical ids, legacy autonomy/hands-free names) onto the five gears. */
export function normalizeMode(mode?: string): PermissionModeId {
  return configModeToPermissionMode(mode) ?? "gear-1";
}

/**
 * The autonomy ladder in Gear's own vocabulary — gears. Shift+Tab shifts up:
 * 1st gear asks for everything, 2nd lets workspace edits through, 3rd adds the
 * sandboxed shell, 4th is full access, and Auto hands the rest to the
 * classifier. The footer, the Shift+Tab banner, and the waiting rung all read
 * from this one table so the words never drift.
 */
export interface ModeInfo {
  id: PermissionModeId;
  /** Footer/banner label: "1st gear" … "4th gear", "auto". */
  label: string;
  /** Ladder arrows: one ▸ per gear, ◆ for Auto. */
  arrows: string;
  /** One clause: what proceeds without asking. */
  desc: string;
  /** The banner sentence. */
  detail: string;
  paint: (value: string) => string;
  /** 4th gear silences every prompt — it announces itself loudly. */
  loud: boolean;
}

export function modeInfo(mode?: string): ModeInfo {
  switch (normalizeMode(mode)) {
    case "gear-2":
      return {
        id: "gear-2",
        label: "2nd gear",
        arrows: "▸▸",
        desc: "workspace edits proceed",
        detail:
          "confined workspace edits proceed; commands, delegation, network, and external access ask.",
        paint: warn,
        loud: false,
      };
    case "gear-3":
      return {
        id: "gear-3",
        label: "3rd gear",
        arrows: "▸▸▸",
        desc: "edits + sandboxed shell",
        detail:
          "workspace edits, sandboxed local commands, and confined delegation proceed; external access asks.",
        paint: warn,
        loud: false,
      };
    case "gear-4":
      return {
        id: "gear-4",
        label: "4th gear",
        arrows: "▸▸▸▸",
        desc: "full autonomy · no prompts",
        detail: "Gear acts without permission prompts; the OS sandbox is unchanged (see /sandbox).",
        paint: warn,
        loud: true,
      };
    case "auto":
      return {
        id: "auto",
        label: "auto",
        arrows: "◆",
        desc: "classifier reviews the rest",
        detail: "safe workspace work proceeds; risky actions get an isolated classifier check.",
        paint: brand,
        loud: false,
      };
    default:
      return {
        id: "gear-1",
        label: "1st gear",
        arrows: "▸",
        desc: "every action asks first",
        detail: "Gear asks before writing or running.",
        paint: muted,
        loud: false,
      };
  }
}

/** A compact, always-visible permission readout: `▸▸ 2nd gear`. */
export function permissionModeBadge(mode?: string): string {
  const m = modeInfo(mode);
  const label = m.paint(`${m.arrows} ${m.label}`);
  return m.loud ? bold(label) : label;
}

/**
 * The v2 footer context meter: `ctx ▮▮▯▯▯ 41%`. Quiet below the 70% warn
 * threshold, ochre when compaction is near, red when hot (≥90%). Renders
 * nothing until a real percentage exists — the meter never guesses.
 */
export function contextMeter(percent: number | undefined): string | null {
  if (percent == null || !Number.isFinite(percent) || percent <= 0) return null;
  const pct = Math.max(0, Math.min(100, Math.round(percent)));
  const paint = pct >= 90 ? accent : pct >= 70 ? warn : faint;
  return `${paint(`ctx ${meterGlyphs(pct)} ${pct}%`)}`;
}

/** A footer key hint: the key in the secondary tone, the word faint. */
function keyHint(key: string, word: string): string {
  return `${muted(key)} ${faint(word)}`;
}

/**
 * The v2 footer strip: mode indicator + what it means · context meter ·
 * key hints, with `? shortcuts` at the right edge. Narrow terminals drop the
 * description and shorten the hints rather than wrapping.
 */
export function statusLine(s: ComposerStatus, width = process.stdout.columns || 80): string {
  const max = Math.max(8, width - 1);
  const extras: string[] = [];
  if (s.loop) extras.push(faint(`↻ ${s.loop}`));
  if (s.sandboxOff) extras.push(bold(warn("▲ sandbox off")));
  const mode = modeInfo(s.mode);
  const meter = contextMeter(s.contextPercent);
  const sep = ` ${faint("·")} `;
  const right = keyHint("?", "shortcuts");

  const badge = `  ${permissionModeBadge(s.mode)}`;
  const described = `${badge}  ${faint(mode.desc)}`;
  const fullHints = [
    keyHint("shift+tab", "mode"),
    keyHint("esc", "interrupt"),
    keyHint("←", "sessions"),
  ].join("   ");
  const shortHints = [keyHint("shift+tab", "mode"), faint("esc · ←")].join("   ");
  // Widest reading first; each tier gives up one thing (hint words, then the
  // description) before the strip ever wraps or truncates.
  const tiers: Array<[string, string]> = [
    [[described, ...(meter ? [meter] : []), fullHints, ...extras].join(sep), right],
    [[described, ...(meter ? [meter] : []), shortHints, ...extras].join(sep), right],
    [[badge, ...(meter ? [meter] : []), shortHints, ...extras].join(sep), right],
  ];
  for (const [left, edge] of tiers) {
    const gap = max - visLen(left) - visLen(edge);
    if (gap >= 2) return `${left}${" ".repeat(gap)}${edge}`;
  }
  const compact = [
    badge,
    ...(meter ? [meter] : []),
    faint("shift+tab · esc · ← · ?"),
    ...extras,
  ].join(sep);
  return clampVisible(compact, max);
}

/**
 * The v2 queued-input strip (`.queue-strip`), floated above the composer while
 * a turn runs: a quiet uppercase header stating the contract, then one bounded
 * row per queued message; the last row carries the undo hint. Pure — the TUI
 * supplies state.
 */
export function renderQueueStrip(queued: readonly string[], width: number): string[] {
  if (queued.length === 0) return [];
  const max = Math.max(12, width - 1);
  const inner = Math.max(10, Math.min(100, max - 2));
  const lines = [`  ${bold(faint("QUEUED · SENDS WHEN THIS TURN COMPLETES"))}`];
  const hint = "⌫ removes the last";
  queued.forEach((message, index) => {
    const last = index === queued.length - 1;
    const tail = last ? faint(hint) : "";
    const body = truncate(
      message.replace(/\s+/g, " "),
      Math.max(4, inner - 6 - (last ? hint.length + 2 : 0)),
    );
    const row = `${faint(String(index + 1))}  ${muted(body)}`;
    const fill = " ".repeat(Math.max(1, inner - 2 - visLen(row) - visLen(tail)));
    lines.push(`  ${panel(` ${row}${fill}${tail} `)}`);
  });
  return lines.map((row) => clampVisible(row, max));
}

/**
 * A transient one-liner announcing the active gear — printed into the
 * transcript each time Shift+Tab shifts. 4th gear is loud because it silences
 * every prompt; the others are calm.
 */
export function permissionModeBanner(mode?: string): string {
  const m = modeInfo(mode);
  const head = m.loud ? bold(m.paint(`${m.arrows} ${m.label}`)) : m.paint(`${m.arrows} ${m.label}`);
  const body = m.loud ? text(m.detail) : muted(m.detail);
  return `  ${head} ${faint("·")} ${body} ${faint("(shift+tab to shift up)")}`;
}

/** How an Auto-mode allow was reached, in the chip's own words. */
const AUTO_TIER_LABEL: Record<string, string> = {
  safe: "safe-listed",
  workspace: "workspace-confined",
  classifier: "classifier reviewed",
};

/**
 * The v2 auto-review chip (`.auto-chip`): printed inline for every action that
 * proceeded in Auto, so approvals stay visible without pausing the run.
 */
export function autoApprovedChip(notice: {
  toolName: string;
  risk: string;
  tier?: string;
}): string {
  const how = (notice.tier && AUTO_TIER_LABEL[notice.tier]) || "classifier reviewed";
  return (
    `    ${chip("brand", " ⛨ auto-approved ")}  ${muted(notice.toolName)} ` +
    `${faint(`· ${how} · risk: ${notice.risk} · logged to audit trail`)}`
  );
}

/**
 * The ochre rung of the v2 status ladder while a human decision is pending:
 * `⚙︎ Waiting on approval… (6s · shell needs a decision in 1st gear)`.
 */
export function waitingRung(seconds: number, toolName: string, mode?: string): string {
  const kind =
    toolName === "bash"
      ? "shell"
      : /^(edit_file|multi_edit|write_file)$/.test(toolName)
        ? "this edit"
        : /^web_/.test(toolName)
          ? "network access"
          : toolName;
  return (
    `  ${warn(GEAR_MARK)} ${bold(warn("Waiting on approval"))}${faint("…")} ` +
    `${faint(`(${Math.max(0, seconds)}s · ${kind} needs a decision in ${modeInfo(mode).label})`)}`
  );
}

/**
 * A transient one-liner announcing the sandbox posture — printed when `/sandbox`
 * toggles (and by `/sandbox` with no argument as a status readout). Off is loud
 * for the same reason Autonomy III is: it removes a containment layer.
 */
export function sandboxModeBanner(enabled: boolean): string {
  if (!enabled) {
    return (
      `  ${bold(warn("▲ Sandbox off"))} ${faint("·")} ` +
      `${text("commands run directly on this machine with full network & filesystem access.")} ` +
      `${faint("(/sandbox on to re-enable)")}`
    );
  }
  // "On" is only an isolation claim when this machine can actually isolate.
  // On the degraded path (no seatbelt/bwrap) the banner must be as loud as
  // "off" — the user is trusting a containment layer that does not exist.
  if (!isOsIsolationAvailable()) {
    return (
      `  ${bold(warn("▲ Sandbox on — NOT ISOLATED"))} ${faint("·")} ` +
      `${text("no OS sandbox backend on this machine (" + getSandboxCapability().mechanism + "): commands run with path-guard checks only, full network & host access; bash prompts for approval.")} ` +
      `${faint("(install sandbox-exec/bwrap for real isolation)")}`
    );
  }
  return (
    `  ${ok("◆ Sandbox on")} ${faint("·")} ` +
    `${muted("commands run in an OS sandbox — no network, workspace-confined writes; network: true escalates one call.")} ` +
    `${faint("(/sandbox off for full access)")}`
  );
}

/**
 * A transient one-liner announcing the agent-browser posture — printed when
 * `/browser` toggles (and by `/browser` with no argument as a status readout).
 * First enable is chatty on purpose: bunx fetches @playwright/mcp, so the
 * tools can take a few seconds to appear.
 */
export function browserModeBanner(enabled: boolean): string {
  return enabled
    ? `  ${ok("◆ Browser on")} ${faint("·")} ` +
        `${muted("Gear can drive a headless, isolated browser (Playwright MCP) — navigate, read, fill, click; first use fetches @playwright/mcp (and a managed Chromium if none is installed).")} ` +
        `${faint("(/browser off to disable)")}`
    : `  ${text("◇ Browser off")} ${faint("·")} ` +
        `${muted("no agent browser — web_fetch/web_search only.")} ` +
        `${faint("(/browser on to enable)")}`;
}

/**
 * A hairline rule spanning the composer width, indented to the `›` chevron.
 * Printed directly above the input so the classic readline surface echoes the
 * same light visual boundary as the raw-mode composer.
 */
export function composerRule(): string {
  return rule(undefined, { color: hairline });
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

/** Number of detail rows available after the fixed review header and footer. */
export function workReviewPageSize(height: number): number {
  return Math.max(1, height - 3);
}

/** A temporary, bounded work-details surface. It never appends another copy to scrollback. */
export function renderWorkReview(
  log: string,
  top: number,
  width: number,
  height: number,
): RenderedBlock {
  const source = log.split("\n").filter((line) => stripAnsi(line).trim());
  const title = source.shift() ?? `  ${bold(text("Work details"))}`;
  const pageSize = workReviewPageSize(height);
  const maxTop = Math.max(0, source.length - pageSize);
  const start = Math.max(0, Math.min(top, maxTop));
  const view = source.slice(start, start + pageSize);
  const range =
    source.length > pageSize ? ` · ${start + 1}–${start + view.length} of ${source.length}` : "";
  const maxWidth = Math.max(8, width - 1);
  const lines = [
    clampVisible(`${title}${faint(range)}`, maxWidth),
    ...view.map((line) => clampVisible(line, maxWidth)),
    `  ${faint("↑↓ scroll · page up/down · ctrl+r or esc close")}`,
  ];
  return { lines, caretRow: 0, caretCol: 0 };
}

/** Placeholder shown in the empty composer (the terminal cursor sits on its first char). */
export const COMPOSER_PLACEHOLDER = "Give Gear a coding task (or / for commands)…";

/** The pinned composer: an open hairline writing surface and quiet status footer. */
export function renderComposer(state: ComposerState): RenderedBlock {
  const width = Math.max(12, state.width);
  const statusLines = state.status ? state.status.split("\n") : [];

  if (state.working) {
    return {
      lines: [`${PAD}${state.working}`, ...statusLines],
      caretRow: 0,
      caretCol: stripAnsi(`${PAD}${state.working}`).length,
    };
  }

  const frameW = width - 4; // PAD + frame stays strictly inside the terminal edge
  const textW = Math.max(1, frameW - 2); // minus the `› ` prompt

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

  // The reference has one hairline above the prompt, then the footer directly
  // beneath it. A second rule made the composer feel like a heavy input box.
  const top = `${PAD}${hairline("─".repeat(frameW))}`;
  const mid = `${PAD}${muted("›")} ${body}`;

  // PAD(2) + `›`(1) + space(1) = 4 cols before the input text.
  const caretCol = 4 + (state.caret - scroll);
  return { lines: [top, mid, ...statusLines], caretRow: 1, caretCol };
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

export interface PermissionCardOptions {
  /** Source-located proposal built before the renderer opens. */
  preview?: PermissionPreview;
  /** Current keyboard selection: once, session, or deny. */
  selected?: number;
  /** Lets short terminals trade code context for a stable composer. */
  maxPreviewLines?: number;
  /** Classic readline cannot capture every raw-mode shortcut. */
  hints?: [string, string, string];
}

function fallbackPermissionPreview(toolName: string, argsSummary: string): PermissionPreview {
  const { title, body } = permissionView(toolName, argsSummary);
  return {
    question: `${title}?`,
    scope: "explicit approval",
    detail: body,
    lines: [],
    added: 0,
    removed: 0,
    truncated: false,
    guard: "No action taken yet",
    choices: ["Yes, allow once", "Yes, allow this tool for this session", "No, cancel"],
  };
}

function permissionDiffLine(row: PermissionPreviewLine, width: number): string {
  if (row.kind === "hunk") return faint(truncate(`@@ ${row.text}`, width));

  const number = row.kind === "add" ? row.newLine : row.oldLine;
  const gutter = `${String(number ?? "").padStart(4)} `;
  const marker = row.kind === "add" ? "+" : row.kind === "remove" ? "-" : " ";
  const contentWidth = Math.max(1, width - visLen(gutter) - 2);
  const code = truncate(row.text, contentWidth);
  if (row.kind === "add") return `${faint(gutter)}${bold(ok(marker))} ${ok(code)}`;
  if (row.kind === "remove") return `${faint(gutter)}${bold(accent(marker))} ${accent(code)}`;
  return `${faint(gutter + marker + " ")}${muted(code)}`;
}

/** The head chip: `bash · sandboxed`, `edit_file · workspace`, `web_fetch · network`.
 *  A shell's posture comes from the preview when it states one, else from the
 *  live sandbox state — never a reassuring default. */
function permissionTag(toolName: string, preview: PermissionPreview): string {
  if (toolName === "bash") {
    if (/host/.test(preview.scope)) return "bash · host";
    if (/sandboxed/.test(preview.scope)) return "bash · sandboxed";
    return isSandboxEnabled() && isOsIsolationAvailable() ? "bash · sandboxed" : "bash · host";
  }
  const scope = preview.scope.split("·")[0]?.trim() ?? "";
  return scope && scope !== "explicit approval" ? `${toolName} · ${scope}` : toolName;
}

/** The three decisions, in the contract's words (the action itself is the card). */
const PERMISSION_LABELS = ["Allow once", "Allow for session", "Deny"] as const;

/**
 * The v2 permission card (`.perm-card`): an ochre left rail on the bar
 * surface — head + tag, the proposed action (command box or located diff), the
 * risk row computed from real arguments, three button-style decisions, and the
 * audit-trail note. Still an open rail, never a floating dialog: one accent,
 * real evidence, three predictable choices, and no fake chrome.
 */
export function renderPermissionCard(
  toolName: string,
  argsSummary: string,
  width: number,
  options: PermissionCardOptions = {},
): RenderedBlock {
  const preview = options.preview ?? fallbackPermissionPreview(toolName, argsSummary);
  const selected = Math.max(0, Math.min(2, options.selected ?? 0));
  const max = Math.max(11, width - 1);
  const cardWidth = Math.max(16, Math.min(100, max - 2));
  const inner = cardWidth - 3; // railCard's row width
  const body = Math.max(6, inner - 2); // rows indented two cells under the head
  const previewLimit = Math.max(
    0,
    Math.min(options.maxPreviewLines ?? (width < 52 ? 3 : 7), preview.lines.length),
  );
  const shownPreview = preview.lines.slice(0, previewLimit);
  const clipped = preview.truncated || shownPreview.length < preview.lines.length;
  const rows: string[] = [];

  rows.push(
    `${warn("⚠")} ${bold(text("Permission required"))}  ${chip("warn", ` ${permissionTag(toolName, preview)} `)}`,
  );
  if (preview.reason) {
    rows.push(
      `  ${faint("Why Gear paused:")} ${muted(truncate(preview.reason, Math.max(4, body - 17)))}`,
    );
  }
  rows.push("");

  // The proposed action: a command box, a located diff, or the plain detail.
  if (toolName === "bash") {
    const command = truncate((preview.detail ?? "").replace(/^\$\s+/, ""), Math.max(4, body - 6));
    rows.push(`  ${codeSurface(` ${bold(muted("$"))} ${text(command)} `)}`);
  } else if (preview.target) {
    const counts =
      shownPreview.length > 0
        ? `  ${ok("+" + preview.added)} ${accent("−" + preview.removed)}`
        : "";
    const summary = preview.summary ? `  ${faint(preview.summary)}` : "";
    const clip = clipped ? `  ${faint("· preview clipped")}` : "";
    rows.push(
      `  ${bold(text(truncate(preview.target, Math.max(4, body - 24))))}${counts}${summary}${clip}`,
    );
    for (const diffLine of shownPreview) rows.push(`  ${permissionDiffLine(diffLine, body)}`);
  } else if (preview.detail) {
    rows.push(`  ${text(truncate(preview.detail, body))}`);
  }

  // v2 risk row: each fact computed from the actual arguments (and the live
  // rate limiter), colored by tone. Facts that cannot be known are absent —
  // the row never pads itself with reassuring guesses. Facts wrap onto extra
  // rows rather than truncate: a clipped risk statement is worse than none.
  if (preview.risk && preview.risk.length > 0) {
    const tonePaint = { ok, warn, accent, muted } as const;
    const facts = preview.risk.map((fact) => {
      const paint = tonePaint[fact.tone ?? "muted"] ?? muted;
      return `${faint(fact.label + ":")} ${paint(fact.value)}`;
    });
    let row = "";
    for (const factText of facts) {
      const candidate = row ? `${row}${faint(" · ")}${factText}` : factText;
      if (row && visLen(candidate) > body) {
        rows.push(`  ${row}`);
        row = factText;
      } else {
        row = candidate;
      }
    }
    if (row) rows.push(`  ${row}`);
  }
  rows.push("");

  // Decisions as buttons: the selection is the filled primary, Deny turns red.
  const hints = options.hints ?? ["y", "a", "n"];
  const buttons = PERMISSION_LABELS.map((label, index) => {
    const active = index === selected;
    const keyText = hints[index] ?? "";
    if (active) {
      const paint = index === 2 ? accent : text;
      return selection(` ${bold(paint(label))}  ${muted(keyText)} `);
    }
    return `${muted(` ${label}`)}  ${faint(keyText)} `;
  });
  const oneRow = `  ${buttons.join("  ")}`;
  const choiceStart = rows.length;
  const inline = visLen(oneRow) <= inner;
  if (inline) rows.push(oneRow);
  else for (const button of buttons) rows.push(`  ${button}`);
  const caretRow = inline ? choiceStart : choiceStart + selected;

  // The honest footnote: nothing has happened yet, and the decision is recorded.
  const note = `${preview.guard} · decision is appended to the tamper-evident audit trail · policy: ~/.alan/config.toml`;
  for (const part of wrap(note, body)) rows.push(`  ${faint(part)}`);

  const lines = ["", ...railCard(rows, { rail: warn, surface: panel, width: cardWidth })];
  return { lines, caretRow: caretRow + 1, caretCol: 4 };
}

// ─── List picker overlay (TUI: /model) ───

export interface PickerItem {
  label: string;
  hint?: string;
  /** Pre-painted theme swatch or other compact visual signal. */
  prefix?: string;
  /** Marks the live model/theme without relying on cursor position. */
  current?: boolean;
  /** v2 chips after the label: "free" (green), "local" (ochre), else faint. */
  tags?: string[];
}

export interface PickerOptions {
  /** One faint footer line under the list (e.g. the gateway-fallback note). */
  footnote?: string;
}

/** v2 `.oi-tag` chips: free = green, local = ochre, everything else quiet. */
function pickerTag(tag: string): string {
  if (tag === "free") return chip("ok", " free ");
  if (tag === "local") return chip("warn", " local ");
  return chip("muted", ` ${tag} `);
}

/**
 * The v2 overlay list (`/model`, `/theme`): an uppercase header with `esc
 * close` at the right edge, numbered rows with the name, a secondary-tone
 * description, and chips (`free` · `local` · provider · `current`), the
 * selection on the bar surface, then an optional footnote and the key hints.
 */
export function renderPicker(
  title: string,
  items: PickerItem[],
  selected: number,
  width: number,
  height = Number.POSITIVE_INFINITY,
  options: PickerOptions = {},
): RenderedBlock {
  const maxWidth = Math.max(8, width - 1);
  const popoverRow = (row: string): string =>
    popoverSurface(row + " ".repeat(Math.max(0, maxWidth - visLen(row))));
  const heading = `${PAD}${bold(faint(title.toUpperCase()))}`;
  const close = keyHint("esc", "close");
  const headGap = " ".repeat(Math.max(1, maxWidth - visLen(heading) - visLen(close) - 1));
  const lines: string[] = [clampVisible(popoverRow(`${heading}${headGap}${close}`), maxWidth)];
  const sel = items.length ? Math.max(0, Math.min(selected, items.length - 1)) : 0;
  const maxItems = Math.max(1, Math.min(items.length || 1, Math.floor(height) - 2));
  let start = 0;
  if (items.length > maxItems) {
    start = Math.min(Math.max(0, sel - Math.floor(maxItems / 2)), items.length - maxItems);
  }
  const view = items.slice(start, start + maxItems);
  view.forEach((it, i) => {
    const on = start + i === sel;
    const marker = on ? brand("›") : " ";
    const number = faint(`${start + i + 1}.`.padStart(3));
    const label = on ? bold(text(it.label)) : text(it.label);
    const prefix = it.prefix ? `${it.prefix} ` : "";
    const chips = [
      ...(it.tags ?? []).map((tag) => pickerTag(tag)),
      ...(it.current ? [chip("brand", " current ")] : []),
    ];
    const tags = chips.length > 0 ? "  " + chips.join(" ") : "";
    const hintBudget = Math.max(8, maxWidth - visLen(prefix) - visLen(label) - visLen(tags) - 12);
    const hint = it.hint ? "  " + muted(truncate(it.hint, Math.min(44, hintBudget))) : "";
    const row = clampVisible(`${PAD}${marker} ${number} ${prefix}${label}${hint}${tags}`, maxWidth);
    lines.push(on ? popoverRow(selection(row)) : popoverRow(row));
  });
  if (options.footnote) {
    lines.push(popoverRow(`${PAD}${faint(truncate(options.footnote, maxWidth - 4))}`));
  }
  lines.push(popoverRow(`${PAD}${faint("↑↓ navigate · 1–9 quick select · ⏎ select · esc close")}`));
  return { lines, caretRow: sel - start + 1, caretCol: 0 };
}

// ─── Slash-command palette (TUI: live `/` menu) ───

export interface SlashItem {
  /** Command including its leading "/" (e.g. "/model"). */
  name: string;
  /** One-line description. */
  desc: string;
  /** Compact context badge, e.g. "cosmetic" or "history". */
  tag?: string;
}

/**
 * The v2 slash-command palette (`#cmd-popover`) that floats above the composer
 * as you type `/`: an uppercase header with the live match count and the key
 * hints, then filtered rows — command, secondary-tone description, a quiet
 * category chip — with the selection on the bar surface. Windows around the
 * selection so a long list never overruns.
 */
export function renderSlashPalette(
  items: SlashItem[],
  selected: number,
  width: number,
  maxVisible = 8,
  total?: number,
): string[] {
  if (items.length === 0) return [];
  const MAX = Math.max(1, Math.min(8, maxVisible));
  const sel = Math.max(0, Math.min(selected, items.length - 1));
  let start = 0;
  if (items.length > MAX)
    start = Math.min(Math.max(0, sel - Math.floor(MAX / 2)), items.length - MAX);
  const view = items.slice(start, start + MAX);
  const nameW = Math.min(18, Math.max(...view.map((it) => it.name.length)));
  const maxWidth = Math.max(8, width - 1);
  const popoverRow = (row: string): string =>
    popoverSurface(row + " ".repeat(Math.max(0, maxWidth - visLen(row))));

  const rows = view.map((it, i) => {
    const on = start + i === sel;
    const marker = on ? brand("›") : " ";
    const name = on ? bold(text(it.name.padEnd(nameW))) : text(it.name.padEnd(nameW));
    const tag = it.tag && width >= 64 ? chip("muted", ` ${it.tag} `) : "";
    const descMax = Math.max(8, maxWidth - nameW - visLen(tag) - 9);
    const desc = it.desc ? "  " + muted(truncate(it.desc, descMax)) : "";
    const gap = tag
      ? " ".repeat(Math.max(1, maxWidth - visLen(`${PAD}  ${name}${desc}`) - visLen(tag) - 1))
      : "";
    const row = clampVisible(`${PAD}${marker} ${name}${desc}${gap}${tag}`, maxWidth);
    return on ? popoverRow(selection(row)) : popoverRow(row);
  });
  const count =
    total != null && total !== items.length ? `${items.length} of ${total}` : String(items.length);
  const heading = `${PAD}${bold(faint("COMMANDS"))} ${faint(`· ${count}`)}`;
  const hints =
    width >= 64
      ? faint("↑↓ navigate · tab complete · ⏎ run · esc close")
      : faint("⏎ run · esc close");
  const headGap = " ".repeat(Math.max(1, maxWidth - visLen(heading) - visLen(hints) - 1));
  return [clampVisible(popoverRow(`${heading}${headGap}${hints}`), maxWidth), ...rows];
}

// ─── API keys panel (TUI: `/keys` BYOK) ───

/** One stored key as the per-provider manager lists it (masked + dated). */
export interface KeyManagerRow {
  id: string;
  masked: string;
  label?: string;
  /** ISO add-date, or undefined for keys that predate multi-key storage. */
  addedAt?: string;
  /** The active key of the pool — the one the gateway uses. */
  active: boolean;
}

export interface KeyRow {
  /** Provider id. */
  id: string;
  /** Display label. */
  label: string;
  /** Masked key for display (never the raw secret); "" when unset. */
  masked: string;
  /** Where the credential in use comes from (BYOP-aware: keychain/oauth too). */
  source: "keychain" | "oauth" | "saved" | "env" | "none";
  /** Usable now (has a key, or a configured/active local runtime). */
  hasKey?: boolean;
  /** How many keys are stored (0/1, or >1 for a multi-account pool). */
  keyCount?: number;
  /** The stored keys for the per-provider manager (masked + dated). */
  savedKeys?: KeyManagerRow[];
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
 * Format an ISO add-date for the keys panel: a compact `YYYY-MM-DD`, or "—" when
 * the key predates multi-key storage (we never fabricate a date). Bad input also
 * degrades to "—" rather than throwing in the render path.
 */
export function formatKeyDate(iso?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
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
    const marker = on ? info("❯") : " ";
    const dot = r.disabled ? faint("○") : r.active ? ok("●") : ready ? info("●") : faint("○");
    const name = (on ? text : muted)(r.label.padEnd(labelW));
    // For a multi-account pool, show the active key plus a "+N" badge so the
    // count is visible at a glance; the per-provider manager lists them all.
    const poolBadge = !r.local && (r.keyCount ?? 0) > 1 ? ` +${(r.keyCount ?? 1) - 1}` : "";
    const keyShown = truncate(r.masked || "set", Math.max(4, keyW - poolBadge.length));
    const keyPad = " ".repeat(Math.max(0, keyW - keyShown.length - poolBadge.length));
    const keyCell = r.local
      ? faint(truncate(r.endpoint || "—", keyW).padEnd(keyW))
      : r.source === "none"
        ? faint("not set".padEnd(keyW))
        : text(keyShown) + (poolBadge ? info(poolBadge) : "") + keyPad;
    // "secure" = an api key held in the OS keychain; "oauth" = an OAuth session.
    const srcLabel: Record<string, string> = {
      saved: "saved",
      env: "env",
      oauth: "oauth",
      keychain: "secure",
    };
    const srcCell = r.local
      ? faint("local".padEnd(6))
      : r.source === "none"
        ? faint(" ".repeat(6))
        : faint((srcLabel[r.source] ?? r.source).padEnd(6));
    const toggle = r.disabled ? warn("off") : ready ? ok("on") : faint("·");
    lines.push(`${PAD}${marker} ${dot} ${name} ${keyCell} ${srcCell} ${toggle}`);
  });

  lines.push(`${PAD}${faint("↑↓ move · enter manage keys · space on/off · d clear · esc close")}`);
  return { lines, caretRow: sel + 1, caretCol: 0 };
}

/**
 * The per-provider key manager: every key stored for one provider, masked, with
 * the date it was added and an optional account label. A filled dot + "active"
 * tag marks the key the gateway uses. This is the view that answers "how many
 * keys do I have configured, and which is which" — reached by pressing enter on a
 * provider row. Reveals no raw secrets.
 */
export function renderKeyManagerPanel(
  providerLabel: string,
  rows: KeyManagerRow[],
  selected: number,
  width: number,
): RenderedBlock {
  const sel = rows.length ? Math.max(0, Math.min(selected, rows.length - 1)) : 0;
  const count = rows.length;
  const lines: string[] = [
    `${PAD}${bold(text(`${providerLabel} · keys`))}   ${faint(
      count === 0 ? "none configured" : `${count} key${count === 1 ? "" : "s"} configured`,
    )}`,
  ];

  if (count === 0) {
    lines.push("");
    lines.push(`${PAD}${muted("No keys saved for this provider yet.")}`);
    lines.push(`${PAD}${faint("Press a to add one — paste a key from any account.")}`);
  } else {
    const maskW = Math.min(22, Math.max(8, ...rows.map((r) => r.masked.length)));
    const labelW = Math.min(16, Math.max(0, ...rows.map((r) => (r.label ?? "").length)));
    rows.forEach((r, i) => {
      const on = i === sel;
      const marker = on ? info("❯") : " ";
      const dot = r.active ? ok("●") : faint("○");
      const mask = (on ? text : muted)(truncate(r.masked, maskW).padEnd(maskW));
      const label = labelW > 0 ? "  " + faint(truncate(r.label ?? "", labelW).padEnd(labelW)) : "";
      const date = "  " + faint(`added ${formatKeyDate(r.addedAt)}`);
      const activeTag = r.active ? "  " + ok("active") : "";
      lines.push(`${PAD}${marker} ${dot} ${mask}${label}${date}${activeTag}`);
    });
  }

  lines.push("");
  lines.push(`${PAD}${faint("a add key · enter/space set active · d remove · esc back")}`);
  const caretRow = count === 0 ? 2 : sel + 1;
  return { lines, caretRow, caretCol: 0 };
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
    `${PAD}${bold(text("System memory"))}   ${faint("a guide Gear tailors to — it never overrides what you ask")}`,
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
    lines.push(`${PAD}${muted("Gear hasn't learned about you yet.")}`);
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
    const marker = on ? info("❯") : " ";
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

/**
 * Chronological divider label for a session timestamp: Today / Yesterday /
 * Past 7 days / "Mon YYYY". Pure (injectable `now`) so the midnight and
 * month-boundary cases are testable, and shared by every sessions surface.
 */
export function sessionGroupLabel(
  iso: string,
  now: Date = new Date(),
  opts: { withDate?: boolean } = {},
): string {
  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) return "Earlier";
  const day = new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const days = Math.max(0, Math.round((today - day) / 86_400_000));
  // The v2 timeline header names the day: "Today · Thu Aug 20".
  const date = () =>
    `${value.toLocaleDateString("en-US", { weekday: "short" })} ${value.toLocaleDateString("en-US", { month: "short" })} ${value.getDate()}`;
  if (days === 0) return opts.withDate ? `Today · ${date()}` : "Today";
  if (days === 1) return opts.withDate ? `Yesterday · ${date()}` : "Yesterday";
  if (days < 7) return "Past 7 days";
  return value.toLocaleDateString([], { month: "short", year: "numeric" });
}

export interface SessionRowView {
  id?: string;
  /** Resolved display title (already falls back to "untitled"). */
  title: string;
  /** Pre-rendered meta line, e.g. "14 events · qwen3-coder:480b". */
  meta: string;
  workspace?: string;
  updatedAt?: string;
  /** Chronological divider supplied by the controller (Today, Yesterday, …). */
  group?: string;
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
  opts: {
    view: "active" | "archived";
    pendingDelete: boolean;
    query?: string;
    searching?: boolean;
  },
  width: number,
  height = Number.POSITIVE_INFINITY,
): RenderedBlock {
  const maxWidth = Math.max(8, width - 1);
  const query = opts.query ?? "";

  // v2 top bar: mark + heading + Active/Archived tabs, the search field, and
  // `esc close` at the right edge. Wide terminals carry the search inline;
  // narrow ones give it its own row. A hairline closes the bar.
  const tab = (label: string, on: boolean): string =>
    on ? selection(bold(text(` ${label} `))) : muted(` ${label} `);
  const tabs = `${tab("Active", opts.view === "active")} ${tab("Archived", opts.view === "archived")}`;
  const count = query ? faint(`${rows.length} ${rows.length === 1 ? "match" : "matches"}`) : "";
  const headLeft = `${PAD}${brand(GEAR_MARK)} ${bold(text("Sessions"))}  ${tabs}${count ? "  " + count : ""}`;
  const searchText = `${opts.searching ? brand("›") : faint("/")} ${
    query ? text(query) : faint("Search title, path, model…")
  }${opts.searching ? brand("▌") : ""}`;
  const close = keyHint("esc", "close");
  const lines: string[] = [];
  let searchRow: number;
  let searchCol: number;
  if (maxWidth >= 84) {
    const left = `${headLeft}   ${searchText}`;
    const gap = " ".repeat(Math.max(1, maxWidth - visLen(left) - visLen(close)));
    lines.push(clampVisible(`${left}${gap}${close}`, maxWidth));
    searchRow = 0;
    searchCol = visLen(headLeft) + 3 + 2 + query.length;
  } else {
    const gap = " ".repeat(Math.max(1, maxWidth - visLen(headLeft) - visLen(close)));
    lines.push(clampVisible(`${headLeft}${gap}${close}`, maxWidth));
    lines.push(clampVisible(`${PAD}${searchText}`, maxWidth));
    searchRow = 1;
    searchCol = 4 + query.length;
  }
  lines.push(`${PAD}${hairline("─".repeat(Math.max(3, maxWidth - 3)))}`);

  if (rows.length === 0) {
    const empty = query
      ? "No sessions match this search."
      : opts.view === "archived"
        ? "No archived sessions."
        : "No sessions yet — start chatting.";
    const emptyRow = lines.length;
    lines.push(`${PAD}${faint(empty)}`);
    lines.push(`${PAD}${faint("/ search · tab active/archived · ctrl+n new · esc close")}`);
    return {
      lines,
      caretRow: opts.searching ? searchRow : emptyRow,
      caretCol: opts.searching ? searchCol : 0,
    };
  }

  // Each timeline card uses two rows and may introduce a day divider. Budget
  // for the worst case so short terminals never hide the selected card/footer.
  const fixedRows = lines.length + 2; // + range note + footer
  const MAX = Math.max(1, Math.min(12, Math.floor((height - fixedRows) / 3)));
  const sel = Math.max(0, Math.min(selected, rows.length - 1));
  let start = 0;
  if (rows.length > MAX)
    start = Math.min(Math.max(0, sel - Math.floor(MAX / 2)), rows.length - MAX);
  const view = rows.slice(start, start + MAX);

  let caretRow = lines.length;
  let previousGroup = "";
  view.forEach((r, i) => {
    const idx = start + i;
    const on = idx === sel;
    const group = r.group ?? "";
    if (group && group !== previousGroup) {
      const label = bold(faint(group.toUpperCase()));
      lines.push(
        clampVisible(
          `${PAD}${label} ${hairline("─".repeat(Math.max(3, maxWidth - visLen(label) - 4)))}`,
          maxWidth,
        ),
      );
      previousGroup = group;
    }

    const marker = on ? brand("›") : " ";
    const dot = r.current ? brand("●") : faint("○");
    const id = faint(r.id ? r.id.slice(0, 8) : "session");
    const pill = r.current
      ? chip("brand", " active now ")
      : opts.view === "archived"
        ? chip("muted", " archived ")
        : chip("ok", " saved ");
    const titleBudget = Math.max(10, maxWidth - visLen(pill) - 20);
    const title = on
      ? bold(text(truncate(r.title, titleBudget)))
      : text(truncate(r.title, titleBudget));
    const prefix = `${PAD}${marker} ${dot} ${id}  ${title}`;
    const titleGap = " ".repeat(Math.max(1, maxWidth - visLen(prefix) - visLen(pill)));
    const titleRow = clampVisible(`${prefix}${titleGap}${pill}`, maxWidth);

    const workspace = r.workspace ? shortPath(r.workspace) : "";
    const detail = [workspace, r.meta].filter(Boolean).join(" · ");
    const stamp = r.updatedAt
      ? new Date(r.updatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
      : "";
    const detailPrefix = `${PAD}    ${faint(truncate(detail, Math.max(8, maxWidth - stamp.length - 8)))}`;
    const detailGap = stamp
      ? " ".repeat(Math.max(1, maxWidth - visLen(detailPrefix) - stamp.length))
      : "";
    const detailRow = clampVisible(`${detailPrefix}${detailGap}${faint(stamp)}`, maxWidth);
    if (on) caretRow = lines.length;
    lines.push(on ? selection(titleRow) : titleRow, on ? selection(detailRow) : detailRow);
  });

  if (rows.length > view.length) {
    lines.push(`${PAD}${faint(`${start + 1}–${start + view.length} of ${rows.length} sessions`)}`);
  }

  const hint = opts.pendingDelete
    ? `${warn("press d again to delete")} ${faint("·")} ${faint("esc cancels")}`
    : opts.view === "archived"
      ? faint(
          "↑↓ navigate · ⏎ resume · u restore · ctrl+d twice to delete · / search · tab active · esc close",
        )
      : faint(
          "↑↓ navigate · ⏎ resume · r rename · a archive · ctrl+d twice to delete · / search · tab archived · esc close",
        );
  lines.push(`${PAD}${hint}`);

  return {
    lines,
    caretRow: opts.searching ? searchRow : caretRow,
    caretCol: opts.searching ? searchCol : 0,
  };
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
  const mid = `${PAD}${line("│")} ${info("›")} ${text(slice.padEnd(textW, " "))} ${line("│")}`;
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
