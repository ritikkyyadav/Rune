// --- Composer -- input prompt + status line ---
// The composer is an open writing surface: one quiet hairline, no heavy card chrome,
// and a footer that keeps control state visible. Readline and raw-mode TUI use the
// same language so switching surfaces never feels like switching products.

import { configModeToPermissionMode, type PermissionMode } from "../../permissions";
import * as os from "os";
import {
  isOsIsolationAvailable,
  isSandboxEnabled,
  getSandboxCapability,
} from "@gear/tool-registry";
import {
  danger,
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
import { fmtTokens } from "./events";
import { glyph } from "./glyphs";
import { clampVisible, truncate, rule, visLen, wrap, railCard } from "./render";
import * as F from "./flow";
import { GEAR_MARK } from "./banner";
import type { PermissionPreview, PermissionPreviewLine } from "./permission-preview";

function shortPath(p: string): string {
  const home = os.homedir();
  return p.startsWith(home) ? "~" + p.slice(home.length) : p;
}

/** The readline prompt: the follow-up arrow. */
export function promptString(): string {
  return `  ${muted(glyph("selection"))} `;
}

export interface ComposerStatus {
  model: string;
  workspace: string;
  /** Permission mode -- one of the five gears (gear-1..gear-4, auto). */
  mode?: string;
  /** Context window usage, 0-100 (shown as "N% context used"). */
  contextPercent?: number;
  /** Files edited so far this session (shown as "K files edited"). */
  filesEdited?: number;
  /** True when the OS sandbox is disabled (/sandbox off) -- shown as a loud badge. */
  sandboxOff?: boolean;
  /** Active session-loop readout, e.g. "loop | in 5m". */
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
 * The autonomy ladder in Gear's own vocabulary -- gears. Shift+Tab shifts up:
 * 1st gear asks for everything, 2nd lets workspace edits through, 3rd adds the
 * sandboxed shell, 4th is full access, and Auto hands the rest to the
 * classifier. The footer, the Shift+Tab banner, and the waiting rung all read
 * from this one table so the words never drift.
 */
export interface ModeInfo {
  id: PermissionModeId;
  /** Footer/banner label: "1st gear" ... "4th gear", "auto". */
  label: string;
  /** Ladder arrows: one > per gear, * for Auto. */
  arrows: string;
  /** One clause: what proceeds without asking. */
  desc: string;
  /** The banner sentence. */
  detail: string;
  paint: (value: string) => string;
  /** 4th gear silences every prompt -- it announces itself loudly. */
  loud: boolean;
}

export function modeInfo(mode?: string): ModeInfo {
  switch (normalizeMode(mode)) {
    case "gear-2":
      return {
        id: "gear-2",
        label: "2nd gear",
        arrows: ">>",
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
        // Rung three of five. It was briefly a diamond, on the grounds that
        // ">>>" was arrow soup under a chevron prompt — which missed that the
        // count IS the information: one mark per gear, so the ladder can be
        // read at a glance without parsing the label beside it. Breaking the
        // sequence in exactly one position made 3rd gear look like a different
        // product from 4th.
        arrows: ">>>",
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
        arrows: ">>>>",
        desc: "full autonomy | no prompts",
        detail: "Gear acts without permission prompts; the OS sandbox is unchanged (see /sandbox).",
        paint: warn,
        loud: true,
      };
    case "auto":
      return {
        id: "auto",
        label: "auto",
        arrows: "*",
        desc: "classifier reviews the rest",
        detail: "safe workspace work proceeds; risky actions get an isolated classifier check.",
        paint: brand,
        loud: false,
      };
    default:
      return {
        id: "gear-1",
        label: "1st gear",
        arrows: ">",
        desc: "every action asks first",
        detail: "Gear asks before writing or running.",
        paint: muted,
        loud: false,
      };
  }
}

/** A compact, always-visible permission readout: `>> 2nd gear`. */
export function permissionModeBadge(mode?: string): string {
  const m = modeInfo(mode);
  const label = m.paint(`${m.arrows} ${m.label}`);
  return m.loud ? bold(label) : label;
}

/**
 * Context occupancy as a plain number. A five-cell meter told you less than
 * `41% context` does and cost four more columns to say it -- and it stays quiet
 * until it matters: ochre when compaction is near, red when it is imminent.
 */
export function contextMeter(percent: number | undefined): string | null {
  if (percent == null || !Number.isFinite(percent) || percent <= 0) return null;
  const pct = Math.max(0, Math.min(100, Math.round(percent)));
  if (pct < 50) return null;
  const paint = pct >= 90 ? danger : pct >= 70 ? warn : faint;
  return paint(`${pct}% context`);
}

/** A footer key hint: the key in the secondary tone, the word faint. */
function keyHint(key: string, word: string): string {
  return `${muted(key)} ${faint(word)}`;
}

/**
 * The footer: what gear you are in and what that means, then the two keys that
 * change it. Everything else the terminal already knows. Narrow terminals drop
 * the description, then the hint words -- the gear itself never drops, because a
 * hidden permission state is the one thing this strip exists to prevent.
 */
export function statusLine(s: ComposerStatus, width = process.stdout.columns || 80): string {
  const max = Math.max(8, Math.min(F.surfaceWidth(), width - 1));
  const mode = modeInfo(s.mode);
  const meter = contextMeter(s.contextPercent);
  const sep = ` ${faint(glyph("observed"))} `;
  const extras: string[] = [];
  if (s.filesEdited) {
    extras.push(faint(`${s.filesEdited} file${s.filesEdited === 1 ? "" : "s"} edited`));
  }
  if (s.loop) extras.push(faint(`${glyph("retry")} ${s.loop}`));
  if (s.sandboxOff) extras.push(warn("sandbox off"));

  const badge = `  ${permissionModeBadge(s.mode)}`;
  // The model belongs HERE, not in the header.
  //
  // The header is committed scrollback: written once at launch and never
  // rewritten, which is the whole reason history in this UI cannot develop
  // rendering bugs. It also means anything printed there is a record of how the
  // session STARTED, not of what is true now — so a model named up there went
  // stale the moment /model switched, and sat there naming the wrong model for
  // the rest of the session. Under the old alt screen the banner repainted
  // every frame and hid this; deleting that surface exposed it.
  //
  // The pinned region redraws on every frame, so live state put here is live by
  // construction. It outranks the gear's description, which is static and
  // learned once, and the model is the field a person actually re-checks.
  const modelName = s.model ? info(s.model) : "";
  const right = keyHint("?", "keys");
  const fullHints = [keyHint("shift+tab", "gear"), keyHint("esc", "stop")].join("  ");

  // What is given up first, at each width. The key hints go before the gear's
  // description does: a hint is discovery, useful once, and 80 columns is the
  // width most people are actually at — losing "edits + sandboxed shell" there
  // to buy back a hint would be the wrong trade for someone still learning what
  // the gear means. The model survives to the last tier because it is the only
  // field here that changes under the user.
  const named = [badge, ...(modelName ? [modelName] : [])].join(sep);
  const tiers: Array<[string, string]> = [
    [[named, faint(mode.desc), ...(meter ? [meter] : []), ...extras, fullHints].join(sep), right],
    [[named, faint(mode.desc), ...(meter ? [meter] : []), ...extras].join(sep), right],
    [[named, faint(mode.desc), ...extras].join(sep), right],
    [[named, faint(mode.desc)].join(sep), right],
    [named, right],
    [badge, right],
  ];
  for (const [left, edge] of tiers) {
    const gap = max - visLen(left) - visLen(edge);
    if (gap >= 2) return `${left}${" ".repeat(gap)}${edge}`;
  }
  return clampVisible(badge, max);
}

/**
 * The v2 queued-input strip (`.queue-strip`), floated above the composer while
 * a turn runs: a quiet uppercase header stating the contract, then one bounded
 * row per queued message; the last row carries the undo hint. Pure -- the TUI
 * supplies state.
 */
export function renderQueueStrip(queued: readonly string[], width: number): string[] {
  if (queued.length === 0) return [];
  const max = Math.max(12, F.measure(width - 1));
  const inner = Math.max(10, Math.min(100, max - 2));
  const lines = [`  ${faint("queued | sends when this turn completes")}`];
  const hint = "backspace removes the last";
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
 * A transient one-liner announcing a state change: a mark, the state, and the
 * sentence that says what it costs you -- wrapped to the measure so a long
 * explanation is readable rather than clipped, and always ending with the exact
 * command that reverses it.
 */
function stateBanner(
  mark: string,
  label: string,
  detail: string,
  undo: string,
  paint: (v: string) => string,
  loud = false,
): string {
  const head = `${F.MARK}${paint(mark)} ${loud ? bold(paint(label)) : paint(label)}`;
  const body = wrap(`${detail} ${undo}`, F.proseWidth()).map((part) => `${F.BODY}${muted(part)}`);
  return ["", head, ...body].join("\n");
}

/**
 * The active gear, printed each time Shift+Tab shifts. 4th gear is loud because
 * it silences every prompt; the others are calm, because they still ask.
 */
export function permissionModeBanner(mode?: string): string {
  const m = modeInfo(mode);
  return stateBanner(m.arrows, m.label, m.detail, "(shift+tab to shift up)", m.paint, m.loud);
}

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
  return F.row(
    `${F.BODY}${info(glyph("verified"))} ${muted("auto-approved")}  ${text(notice.toolName)}`,
    faint(`${how} | risk ${notice.risk}`),
  );
}

/**
 * The rung shown while a human decision is pending. It uses the same caution
 * mark the approval prompt does, so the thing you are waiting on and the thing
 * asking look like the same thing.
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
    `${F.MARK}${warn(glyph("selection"))} ${warn("waiting on you")}  ` +
    `${faint(`${Math.max(0, seconds)}s | ${kind} needs a decision in ${modeInfo(mode).label}`)}`
  );
}

/**
 * The sandbox posture, printed when `/sandbox` toggles (and as a readout when
 * it is called with no argument). Off is loud for the same reason 4th gear is:
 * it removes a containment layer. "On" is only an isolation claim when this
 * machine can actually isolate -- on the degraded path the banner is just as
 * loud, because the user would otherwise be trusting a layer that is not there.
 */
export function sandboxModeBanner(enabled: boolean): string {
  if (!enabled) {
    return stateBanner(
      "!",
      "sandbox off",
      "Commands run directly on this machine, with full network and filesystem access.",
      "(/sandbox on to re-enable)",
      warn,
      true,
    );
  }
  if (!isOsIsolationAvailable()) {
    return stateBanner(
      "!",
      "sandbox on -- not isolated",
      `No OS sandbox backend on this machine (${getSandboxCapability().mechanism}): commands run with path-guard checks only, full network and host access, and bash still asks for approval.`,
      "(install sandbox-exec or bwrap for real isolation)",
      warn,
      true,
    );
  }
  return stateBanner(
    glyph("verified"),
    "sandbox on",
    "Commands run in an OS sandbox -- no network, workspace-confined writes. A call that sets network: true escalates just that one command.",
    "(/sandbox off for full access)",
    ok,
  );
}

/**
 * The agent-browser posture, printed when `/browser` toggles. First enable is
 * chatty on purpose: bunx fetches @playwright/mcp, so the tools take a few
 * seconds to appear and silence would read as a hang.
 */
export function browserModeBanner(enabled: boolean): string {
  return enabled
    ? stateBanner(
        glyph("verified"),
        "browser on",
        "Gear can drive a headless, isolated browser (Playwright MCP) -- navigate, read, fill, click. First use fetches @playwright/mcp, and a managed Chromium if none is installed.",
        "(/browser off to disable)",
        ok,
      )
    : stateBanner(
        "o",
        "browser off",
        "No agent browser -- web_fetch and web_search only.",
        "(/browser on to enable)",
        muted,
      );
}

/**
 * A hairline rule spanning the composer width, indented to the `>` chevron.
 * Printed directly above the input so the classic readline surface echoes the
 * same light visual boundary as the raw-mode composer.
 */
export function composerRule(): string {
  return F.hairline();
}

// --- Pinned composer (TUI) ---

/** The composer sits in the same column as everything else. */
const PAD = F.MARK;

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
    source.length > pageSize ? ` | ${start + 1}-${start + view.length} of ${source.length}` : "";
  const maxWidth = Math.max(8, F.measure(width - 1));
  const lines = [
    clampVisible(`${title}${faint(range)}`, maxWidth),
    ...view.map((line) => clampVisible(line, maxWidth)),
    `  ${faint("up/down scroll | page up/down | ctrl+r or esc close")}`,
  ];
  return { lines, caretRow: 0, caretCol: 0 };
}

/** Placeholder shown in the empty composer. It says the two things a first-run
 *  reader cannot guess, and nothing else. */
export const COMPOSER_PLACEHOLDER = "describe a change, or / for commands";

/**
 * The writing surface: one hairline, one chevron, your text. It spans the same
 * measure as the transcript above it, so the whole session reads as a single
 * column rather than a wide footer under a narrow log.
 */
export function renderComposer(state: ComposerState): RenderedBlock {
  // Chrome spans the window: the hairline divides the screen, not the sentence,
  // and a composer that stops short of the edge reads as a half-drawn box.
  const width = Math.max(12, Math.min(F.surfaceWidth(), state.width - 1));
  const statusLines = state.status ? state.status.split("\n") : [];

  if (state.working) {
    return {
      lines: [`${PAD}${state.working}`, ...statusLines],
      caretRow: 0,
      caretCol: stripAnsi(`${PAD}${state.working}`).length,
    };
  }

  const textW = Math.max(1, width - 4); // PAD(2) + `>`(1) + space(1)

  // Horizontal scroll so the caret stays visible within the window.
  let scroll = 0;
  if (state.caret > textW - 1) scroll = state.caret - textW + 1;
  // Newlines/control chars would spill the "single-line" box across rows and break the pinned
  // region's row math (pastes are collapsed to chips upstream, but a stray control byte must
  // never desync the frame).
  const slice = state.input
    .slice(scroll, scroll + textW)
    .replace(/[\r\n\t\x00-\x08\x0b-\x1f]/g, " ");
  const body =
    state.input.length === 0
      ? faint(COMPOSER_PLACEHOLDER.padEnd(textW, " ").slice(0, textW))
      : text(slice.padEnd(textW, " "));

  // A rule above AND below. One rule is a divider — it separates the composer
  // from the transcript but leaves the input itself floating, so on a quiet
  // screen there is nothing telling you where the typing goes. Two rules make
  // it a place: the field has edges, and the status hint sits outside them
  // rather than looking like more input.
  // The SAME rule the header draws — indented to the content column, so the
  // field's edges line up with the text inside it and with everything above.
  const edge = F.hairline(width);
  const mid = `${PAD}${muted(glyph("selection"))} ${body}`;

  // The blank line above the field belongs to the FIELD, not to whatever is
  // above it. Owning it here is what makes the frame hold in both directions:
  // on a long session it keeps the input from touching the last line of
  // output, and on a fresh one it keeps this rule off the row directly below
  // the header's rule, where the two would draw as a doubled border. The
  // caller above cannot know which case it is in; this block always can.
  //
  // PAD(2) + chevron(1) + space(1) = 4 cols before the input text.
  const caretCol = 4 + (state.caret - scroll);
  return { lines: ["", edge, mid, edge, ...statusLines], caretRow: 2, caretCol };
}

// --- Permission request card (TUI) ---

/**
 * A human title + one clean line of detail for a permission request. The broker's
 * `argsSummary` repeats the tool name ("bash: ls -R", "write_file /x"); strip that so
 * the card reads "Run shell command / ls -R" instead of "Allow bash -- bash: ls -R".
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

/** The three decisions, as answers to the question rather than button labels. */
const PERMISSION_LABELS = [
  "yes, once",
  "yes, and stop asking this session",
  "no, skip it",
] as const;

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
    choices: [...PERMISSION_LABELS],
  };
}

function permissionDiffLine(row: PermissionPreviewLine, width: number): string {
  if (row.kind === "hunk") return `${F.BODY}   ${faint(truncate(`... ${row.text}`, width))}`;
  return F.diffRows([
    {
      kind: row.kind === "add" ? "add" : row.kind === "remove" ? "remove" : "context",
      line: row.kind === "add" ? row.newLine : row.oldLine,
      text: row.text,
    },
  ])[0]!;
}

/** The head chip: `bash | sandboxed`, `edit_file | workspace`, `web_fetch | network`.
 *  A shell's posture comes from the preview when it states one, else from the
 *  live sandbox state -- never a reassuring default. */
function permissionTag(toolName: string, preview: PermissionPreview): string {
  if (toolName === "bash") {
    if (/host/.test(preview.scope)) return "bash | host";
    if (/sandboxed/.test(preview.scope)) return "bash | sandboxed";
    return isSandboxEnabled() && isOsIsolationAvailable() ? "bash | sandboxed" : "bash | host";
  }
  const scope = preview.scope.split("|")[0]?.trim() ?? "";
  return scope && scope !== "explicit approval" ? `${toolName} | ${scope}` : toolName;
}

/**
 * The approval prompt. It reads as a question with answers, not a dialog with
 * buttons: the caution mark and the question, the literal thing that would
 * happen, what it costs, then numbered choices with escape as the stated
 * default. Nothing has run yet, and the footnote says so.
 */
export function renderPermissionCard(
  toolName: string,
  argsSummary: string,
  width: number,
  options: PermissionCardOptions = {},
): RenderedBlock {
  const preview = options.preview ?? fallbackPermissionPreview(toolName, argsSummary);
  const selected = Math.max(0, Math.min(2, options.selected ?? 0));
  const measure = F.measure(width);
  const body = Math.max(12, measure - F.RAIL_IN.length);
  const previewLimit = Math.max(
    0,
    Math.min(options.maxPreviewLines ?? (width < 52 ? 3 : 9), preview.lines.length),
  );
  const shownPreview = preview.lines.slice(0, previewLimit);
  const clipped = preview.truncated || shownPreview.length < preview.lines.length;

  // The proposal itself: a command verbatim, or the located diff it would write.
  const command = toolName === "bash" ? (preview.detail ?? "").replace(/^\$\s+/, "") : "";
  const evidence: string[] = [];
  if (!command && preview.target) {
    evidence.push(
      F.row(
        `${F.BODY}${info(truncate(preview.target, Math.max(4, body - 20)))}`,
        shownPreview.length > 0 ? muted(F.editMetric(preview.added, preview.removed)) : "",
      ),
    );
    for (const diffLine of shownPreview) evidence.push(permissionDiffLine(diffLine, body));
    if (clipped) evidence.push(`${F.BODY}   ${faint(`${glyph("elision")} preview clipped`)}`);
  } else if (!command && preview.detail) {
    evidence.push(`${F.BODY}${text(truncate(preview.detail, body))}`);
  }

  // Every fact computed from the real arguments -- absent when it cannot be known.
  const irreversible = (preview.risk ?? []).find((fact) => fact.tone === "accent");
  const impact = [
    permissionTag(toolName, preview),
    ...(preview.risk ?? [])
      .filter((fact) => fact !== irreversible)
      .map((fact) => `${fact.label} ${fact.value}`),
  ].join(" | ");

  const lines = F.ask({
    question: preview.question || `${permissionView(toolName, argsSummary).title}?`,
    command: command || undefined,
    evidence,
    impact,
    irreversible: irreversible
      ? `This ${irreversible.label} ${irreversible.value}.`.replace(/\.\.$/, ".")
      : undefined,
    options: preview.choices?.length ? [...preview.choices] : [...PERMISSION_LABELS],
    selected,
    escape: "cancel",
    width,
  });
  const guard = `${preview.guard} | the decision is recorded in the audit trail`;
  lines.push("");
  for (const part of wrap(guard, body)) lines.push(`${F.BODY}${faint(part)}`);

  // The caret rests on the highlighted answer, four rows above the escape line.
  const firstOption = lines.findIndex((row) => stripAnsi(row).trimStart().startsWith("1 "));
  return {
    lines,
    caretRow: firstOption >= 0 ? firstOption + selected : 0,
    caretCol: 4,
  };
}

// --- List picker overlay (TUI: /model) ---

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
  if (tag === "default") return chip("brand", " * default ");
  return chip("muted", ` ${tag} `);
}

/**
 * The v2 overlay list (`/model`, `/theme`): an uppercase header with `esc
 * close` at the right edge, numbered rows with the name, a secondary-tone
 * description, and chips (`free` | `local` | provider | `current`), the
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
  const maxWidth = Math.max(8, F.measure(width - 1));
  const popoverRow = (row: string): string =>
    popoverSurface(row + " ".repeat(Math.max(0, maxWidth - visLen(row))));
  const heading = `${PAD}${muted(title.toLowerCase())}`;
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
    const marker = on ? brand(glyph("selection")) : " ";
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
  lines.push(
    popoverRow(`${PAD}${faint("up/down navigate | 1-9 quick select | enter select | esc close")}`),
  );
  return { lines, caretRow: sel - start + 1, caretCol: 0 };
}

// --- Slash-command palette (TUI: live `/` menu) ---

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
 * hints, then filtered rows -- command, secondary-tone description, a quiet
 * category chip -- with the selection on the bar surface. Windows around the
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
  const maxWidth = Math.max(8, F.measure(width - 1));
  const popoverRow = (row: string): string =>
    popoverSurface(row + " ".repeat(Math.max(0, maxWidth - visLen(row))));

  const rows = view.map((it, i) => {
    const on = start + i === sel;
    const marker = on ? brand(glyph("selection")) : " ";
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
  const heading = `${PAD}${muted("commands")} ${faint(`| ${count}`)}`;
  const hints =
    width >= 64
      ? faint("up/down navigate | tab complete | enter run | esc close")
      : faint("enter run | esc close");
  const headGap = " ".repeat(Math.max(1, maxWidth - visLen(heading) - visLen(hints) - 1));
  return [clampVisible(popoverRow(`${heading}${headGap}${hints}`), maxWidth), ...rows];
}

// --- API keys panel (TUI: `/keys` BYOK) ---

/** One stored key as the per-provider manager lists it (masked + dated). */
export interface KeyManagerRow {
  id: string;
  masked: string;
  label?: string;
  /** ISO add-date, or undefined for keys that predate multi-key storage. */
  addedAt?: string;
  /** The active key of the pool -- the one the gateway uses. */
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
 * Format an ISO add-date for the keys panel: a compact `YYYY-MM-DD`, or "--" when
 * the key predates multi-key storage (we never fabricate a date). Bad input also
 * degrades to "--" rather than throwing in the render path.
 */
export function formatKeyDate(iso?: string): string {
  if (!iso) return "--";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "--";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * The `/keys` panel: every provider with its status dot, masked key, source, and
 * on/off toggle. A leading `>` marks the selected row. Returns a RenderedBlock so
 * the TUI can pin it like the picker; the caret is parked on the selected row.
 */
export function renderKeysPanel(rows: KeyRow[], selected: number, width: number): RenderedBlock {
  const sel = rows.length ? Math.max(0, Math.min(selected, rows.length - 1)) : 0;
  const labelW = Math.min(15, Math.max(8, ...rows.map((r) => r.label.length), 8));
  const keyW = Math.max(10, Math.min(22, width - labelW - 24));

  const lines: string[] = [
    `${PAD}${bold(text("API keys"))}   ${faint("bring your own -- applied live, saved to ~/.gear/secrets.json")}`,
  ];

  rows.forEach((r, i) => {
    const on = i === sel;
    // Local runtimes are usable without a key; treat a configured/active one as "ready".
    const ready = r.local ? !!r.hasKey : r.source !== "none";
    const marker = on ? info(glyph("selection")) : " ";
    const dot = r.disabled
      ? faint("o")
      : r.active
        ? ok(glyph("live"))
        : ready
          ? info(glyph("live"))
          : faint("o");
    const name = (on ? text : muted)(r.label.padEnd(labelW));
    // For a multi-account pool, show the active key plus a "+N" badge so the
    // count is visible at a glance; the per-provider manager lists them all.
    const poolBadge = !r.local && (r.keyCount ?? 0) > 1 ? ` +${(r.keyCount ?? 1) - 1}` : "";
    const keyShown = truncate(r.masked || "set", Math.max(4, keyW - poolBadge.length));
    const keyPad = " ".repeat(Math.max(0, keyW - keyShown.length - poolBadge.length));
    const keyCell = r.local
      ? faint(truncate(r.endpoint || "--", keyW).padEnd(keyW))
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
    const toggle = r.disabled ? warn("off") : ready ? ok("on") : faint("-");
    lines.push(`${PAD}${marker} ${dot} ${name} ${keyCell} ${srcCell} ${toggle}`);
  });

  lines.push(
    `${PAD}${faint("up/down move | enter manage keys | space on/off | d clear | esc close")}`,
  );
  return { lines, caretRow: sel + 1, caretCol: 0 };
}

/**
 * The per-provider key manager: every key stored for one provider, masked, with
 * the date it was added and an optional account label. A filled dot + "active"
 * tag marks the key the gateway uses. This is the view that answers "how many
 * keys do I have configured, and which is which" -- reached by pressing enter on a
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
    `${PAD}${bold(text(`${providerLabel} | keys`))}   ${faint(
      count === 0 ? "none configured" : `${count} key${count === 1 ? "" : "s"} configured`,
    )}`,
  ];

  if (count === 0) {
    lines.push("");
    lines.push(`${PAD}${muted("No keys saved for this provider yet.")}`);
    lines.push(`${PAD}${faint("Press a to add one -- paste a key from any account.")}`);
  } else {
    const maskW = Math.min(22, Math.max(8, ...rows.map((r) => r.masked.length)));
    const labelW = Math.min(16, Math.max(0, ...rows.map((r) => (r.label ?? "").length)));
    rows.forEach((r, i) => {
      const on = i === sel;
      const marker = on ? info(glyph("selection")) : " ";
      const dot = r.active ? ok(glyph("live")) : faint("o");
      const mask = (on ? text : muted)(truncate(r.masked, maskW).padEnd(maskW));
      const label = labelW > 0 ? "  " + faint(truncate(r.label ?? "", labelW).padEnd(labelW)) : "";
      const date = "  " + faint(`added ${formatKeyDate(r.addedAt)}`);
      const activeTag = r.active ? "  " + ok("active") : "";
      lines.push(`${PAD}${marker} ${dot} ${mask}${label}${date}${activeTag}`);
    });
  }

  lines.push("");
  lines.push(`${PAD}${faint("a add key | enter/space set active | d remove | esc back")}`);
  const caretRow = count === 0 ? 2 : sel + 1;
  return { lines, caretRow, caretCol: 0 };
}

// --- System Memory panel (TUI: `/memory`) ---

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
  /** A transient status note (e.g. "refreshed | ~120 tokens"). */
  note?: string;
  /** Clear is armed for a confirming second press. */
  pendingClear: boolean;
}

/** Number of selectable actions in the memory panel (refresh/cadence/add/edit/clear). */
export const MEMORY_ACTION_COUNT = 5;

/**
 * The `/memory` panel: the evergreen profile with a row of single-key actions
 * (refresh / cadence / add note / edit / clear). Mirrors the keys + picker panels;
 * a leading `>` marks the selected action and the caret parks on it.
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
    `${PAD}${bold(text("System memory"))}   ${faint("a guide Gear tailors to -- it never overrides what you ask")}`,
  );
  const empty = !v.content.trim();
  lines.push(
    `${PAD}${faint(
      empty
        ? `empty | auto-update ${v.scheduleLabel}`
        : `~${v.tokens}/${v.maxTokens} tokens | auto-update ${v.scheduleLabel} | dreamed ${v.lastDreamed}`,
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
      lines.push(`${PAD}${faint(`...(+${body.length - MAX} more lines | edit to see all)`)}`);
    }
  }
  lines.push("");

  const actionStart = lines.length;
  const row = (i: number, label: string, hint: string) => {
    const on = i === sel;
    const marker = on ? info(glyph("selection")) : " ";
    const lab = on ? text(label) : muted(label);
    lines.push(`${PAD}${marker} ${lab}${hint ? "   " + faint(hint) : ""}`);
  };
  row(0, "Refresh now", v.busy ? "dreaming..." : "learn from your recent sessions");
  row(1, `Auto-update: ${v.scheduleLabel}`, "enter cycles manual | daily | 3d | weekly");
  row(2, "Add a note", "jot a quick fact about you");
  row(3, "Edit in your editor", "open the full profile in $EDITOR");
  row(
    4,
    v.pendingClear ? "Clear -- press again to confirm" : "Clear",
    v.pendingClear ? "" : "wipe the profile (keeps your cadence)",
  );

  if (v.busy) {
    lines.push(`${PAD}${ok(glyph("phase"))} ${muted("dreaming -- distilling your profile...")}`);
  } else if (v.note) {
    lines.push(`${PAD}${ok(glyph("verified"))} ${muted(v.note)}`);
  }
  lines.push(
    `${PAD}${faint("up/down move | enter choose | r refresh | c cadence | a add | e edit | x clear | esc close")}`,
  );

  return { lines, caretRow: actionStart + sel, caretCol: 0 };
}

// --- Sessions manager panel (TUI: `/sessions`) ---

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
  // The v2 timeline header names the day: "Today | Thu Aug 20".
  const date = () =>
    `${value.toLocaleDateString("en-US", { weekday: "short" })} ${value.toLocaleDateString("en-US", { month: "short" })} ${value.getDate()}`;
  if (days === 0) return opts.withDate ? `Today | ${date()}` : "Today";
  if (days === 1) return opts.withDate ? `Yesterday | ${date()}` : "Yesterday";
  if (days < 7) return "Past 7 days";
  return value.toLocaleDateString([], { month: "short", year: "numeric" });
}

export interface SessionRowView {
  id?: string;
  /** Resolved display title (already falls back to "untitled"). */
  title: string;
  /** Pre-rendered meta line — kept for callers that still supply only this. */
  meta: string;
  /** Structured, so the panel can lay out columns instead of splitting a string. */
  model?: string;
  events?: number;
  tokens?: number;
  workspace?: string;
  updatedAt?: string;
  /** Chronological divider supplied by the controller (Today, Yesterday, ...). */
  group?: string;
  /** The session currently loaded in this window. */
  current: boolean;
}

/**
 * The `/sessions` manager: every stored conversation with a status dot, its
 * title and a meta line (age | message count | model). A leading `>` marks the
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
  const maxWidth = Math.max(8, F.measure(width - 1));
  const query = opts.query ?? "";

  // v2 top bar: mark + heading + Active/Archived tabs, the search field, and
  // `esc close` at the right edge. Wide terminals carry the search inline;
  // narrow ones give it its own row. A hairline closes the bar.
  const tab = (label: string, on: boolean): string =>
    on ? selection(bold(text(` ${label} `))) : muted(` ${label} `);
  const tabs = `${tab("Active", opts.view === "active")} ${tab("Archived", opts.view === "archived")}`;
  const count = query ? faint(`${rows.length} ${rows.length === 1 ? "match" : "matches"}`) : "";
  const headLeft = `${PAD}${brand(GEAR_MARK)} ${bold(text("Sessions"))}  ${tabs}${count ? "  " + count : ""}`;
  const searchText = `${opts.searching ? brand(glyph("selection")) : faint("/")} ${
    query ? text(query) : faint("Search title, path, model...")
  }${opts.searching ? brand("|") : ""}`;
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
  lines.push(F.hairline(maxWidth));

  if (rows.length === 0) {
    const empty = query
      ? "No sessions match this search."
      : opts.view === "archived"
        ? "No archived sessions."
        : "No sessions yet -- start chatting.";
    const emptyRow = lines.length;
    lines.push(`${PAD}${faint(empty)}`);
    lines.push(`${PAD}${faint("/ search | tab active/archived | ctrl+n new | esc close")}`);
    return {
      lines,
      caretRow: opts.searching ? searchRow : emptyRow,
      caretCol: opts.searching ? searchCol : 0,
    };
  }

  // Each timeline card uses two rows and may introduce a day divider. Budget
  // for the worst case so short terminals never hide the selected card/footer.
  const fixedRows = lines.length + 2; // + range note + footer
  // One row each now, so a tall window shows a session list rather than a
  // sample of one. The +3 budget covers the selected row's id line, a day
  // divider and its blank.
  const MAX = Math.max(1, Math.min(24, height - fixedRows - 3));
  const sel = Math.max(0, Math.min(selected, rows.length - 1));
  let start = 0;
  if (rows.length > MAX)
    start = Math.min(Math.max(0, sel - Math.floor(MAX / 2)), rows.length - MAX);
  const view = rows.slice(start, start + MAX);

  let caretRow = lines.length;
  let previousGroup = "";

  // ─── One row per session ───
  //
  // It used to take two: a title row with a status pill hard right, and a
  // detail row underneath carrying `~/Project/x | provider/model | N events |
  // Nk tokens` with the clock time hard right. Three things went wrong with
  // that, and none of them are about density.
  //
  // The two right-hand columns interleaved. Reading down the right edge gave
  // `active now / 11:46 PM / saved / 9:22 PM / saved / 8:40 PM` — two different
  // kinds of fact alternating in one column, which is the layout equivalent of
  // two people talking at once.
  //
  // `saved` was on every row. A state that every row shares is not information;
  // it is twelve repetitions of the default. Only the exceptions earn ink: the
  // live session gets a mark, an archived one says so, and "saved" says nothing
  // because saved is what a session is.
  //
  // And the id sat in the most valuable position on the screen — eight hex
  // characters before the title, on every row, in the column the eye lands on
  // first. It moves to the selected row, where it is occasionally wanted for
  // `gear resume <id>`, and is off the other rows entirely.
  //
  // What is left is a real grid: title left, context dim in the middle, time
  // right. Down the right edge is only ever time.
  const TIME_W = 8;
  const stampOf = (iso?: string): string => {
    if (!iso) return "";
    const then = new Date(iso).getTime();
    if (!Number.isFinite(then)) return "";
    const mins = Math.floor((Date.now() - then) / 60000);
    // Inside the hour, elapsed reads faster than a clock face — "4m" answers
    // "is this the one I just had open" without the subtraction. Past that the
    // day divider already carries the date, so a clock time is unambiguous.
    if (mins < 1) return "now";
    if (mins < 60) return `${mins}m`;
    return new Date(then).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  };
  /** `minimax/minimax-m3:free` -> `minimax-m3:free`. The provider is already
   *  implied by the model name in every case where it is not noise. */
  const shortModel = (m?: string): string => (m ? (m.split("/").pop() ?? m) : "");
  /** `~/Project/evolab2` -> `evolab2`. The parent is the same for every row. */
  const projectOf = (w?: string): string =>
    w ? (shortPath(w).split("/").filter(Boolean).pop() ?? "") : "";

  view.forEach((r, i) => {
    const idx = start + i;
    const on = idx === sel;
    const group = r.group ?? "";
    if (group && group !== previousGroup) {
      // A quiet label, not a rule with a word in it. The blank column to its
      // right is what separates the days; drawing a line there as well says the
      // same thing twice and turns a divider into texture.
      if (lines.length > (maxWidth >= 84 ? 2 : 3)) lines.push("");
      lines.push(clampVisible(`${PAD}${faint(group.toLowerCase())}`, maxWidth));
      previousGroup = group;
    }

    const marker = on ? info(glyph("selection")) : " ";
    // The live session is the only row that earns a mark. Archived rows say so
    // in the context column; everything else is simply a session.
    const dot = r.current ? info(glyph("live")) : " ";

    const context = [
      projectOf(r.workspace),
      shortModel(r.model),
      r.tokens ? fmtTokens(r.tokens) : "",
      opts.view === "archived" ? "archived" : "",
    ]
      .filter(Boolean)
      .join(` ${glyph("observed")} `);

    const stamp = stampOf(r.updatedAt);
    const lead = `${PAD}${marker} ${dot} `;
    const tail = stamp ? stamp.padStart(TIME_W) : " ".repeat(TIME_W);
    // The context column gets a third of the row, the title takes the rest —
    // and on a narrow terminal the context yields entirely rather than
    // squeezing the title down to nothing.
    const room = Math.max(10, maxWidth - visLen(lead) - TIME_W - 2);
    const ctxBudget = room >= 46 ? Math.min(34, Math.floor(room / 2.4)) : 0;
    const titleBudget = Math.max(8, room - (ctxBudget ? ctxBudget + 2 : 0));
    const titleText = truncate(r.title, titleBudget);
    const title = on ? bold(text(titleText)) : text(titleText);
    const ctxText = ctxBudget ? truncate(context, ctxBudget) : "";
    const ctx = ctxText ? faint(ctxText) : "";

    const titleCell = titleText.padEnd(titleBudget).slice(titleText.length);
    let row = `${lead}${title}${titleCell}`;
    if (ctx) row += `  ${ctx}${" ".repeat(Math.max(0, ctxBudget - visLen(ctxText)))}`;
    const gap = Math.max(1, maxWidth - visLen(row) - visLen(tail));
    row += `${" ".repeat(gap)}${faint(tail)}`;

    if (on) caretRow = lines.length;
    lines.push(on ? selection(clampVisible(row, maxWidth)) : clampVisible(row, maxWidth));
  });

  if (rows.length > view.length) {
    lines.push(`${PAD}${faint(`${start + 1}-${start + view.length} of ${rows.length} sessions`)}`);
  }

  // Four hints, not eight. A footer listing every key is a wall that gets read
  // once and skipped forever; these are the ones you reach for on this screen,
  // and `?` already opens the full key sheet. `esc close` is in the top bar.
  // The selected session's id rides the footer rather than a line of its own
  // under the row. Inline, it broke the grid's rhythm and — worse — moved every
  // row below it each time the selection moved, so the list shifted under the
  // cursor while you were reading it. Down here it is available for
  // `gear resume <id>` and costs the list nothing.
  const sep2 = faint(` ${glyph("observed")} `);
  const selectedId = rows[sel]?.id ? faint(rows[sel]!.id!) : "";
  const keys = opts.pendingDelete
    ? warn("press d again to delete") + sep2 + faint("esc cancels")
    : [
        keyHint("enter", "resume"),
        keyHint("/", "search"),
        opts.view === "archived" ? keyHint("u", "restore") : keyHint("a", "archive"),
        keyHint("tab", opts.view === "archived" ? "active" : "archived"),
      ].join(sep2);
  const footLeft = `${PAD}${keys}`;
  const footGap = selectedId
    ? " ".repeat(Math.max(2, maxWidth - visLen(footLeft) - visLen(selectedId)))
    : "";
  lines.push(clampVisible(`${footLeft}${footGap}${selectedId}`, maxWidth));

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
  const top = `${PAD}${line("+" + "-".repeat(boxW - 2) + "+")}`;
  const mid = `${PAD}${line("|")} ${info(glyph("selection"))} ${text(slice.padEnd(textW, " "))} ${line("|")}`;
  const bot = `${PAD}${line("+" + "-".repeat(boxW - 2) + "+")}`;
  const hint = `${PAD}${faint("enter save | esc cancel | paste supported")}`;

  const lines = sub ? [head, sub, top, mid, bot, hint] : [head, top, mid, bot, hint];
  const caretRow = sub ? 3 : 2;
  const caretCol = 6 + (s.caret - scroll);
  return { lines, caretRow, caretCol };
}

/** Mask a value for the editor: dots for all but the last 4 characters. */
function maskField(v: string): string {
  if (v.length <= 4) return ".".repeat(v.length);
  return ".".repeat(v.length - 4) + v.slice(-4);
}
