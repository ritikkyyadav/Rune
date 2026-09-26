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
} from "@rune/tool-registry";
import {
  accent,
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
  speakerSurface,
  hairline,
  codeSurface,
  chip,
  cursorCell,
  quiet,
} from "./theme";
import { fmtTokens } from "./events";
import { glyph } from "./glyphs";
import {
  clampVisible,
  truncate,
  rule,
  visLen,
  wrap,
  railCard,
  graphemeSpans,
  prefixByWidth,
} from "./render";
import * as F from "./flow";
import { pasteChipSpans } from "./paste";
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
  /**
   * Reasoning depth, on providers that have the dial. Lives beside the model
   * because it IS part of which model you are talking to: the same
   * gpt-5.6-sol at "low" and at "max" are not the same collaborator, and the
   * difference was previously invisible everywhere in the product.
   */
  effort?: string;
  /** True when the transcript holds at least one openable fold -- shows the
   *  ctrl+o hint, so the affordance is discoverable exactly when it exists. */
  folds?: boolean;
}

export type PermissionModeId = PermissionMode;

/** Normalize any spelling (canonical ids, legacy autonomy/hands-free names) onto the five gears. */
export function normalizeMode(mode?: string): PermissionModeId {
  return configModeToPermissionMode(mode) ?? "gear-1";
}

/**
 * The autonomy ladder in Rune's own vocabulary -- gears. Shift+Tab shifts up:
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
  /** One clause: what proceeds without asking. Omitted where the label
   *  already says it -- Auto mode has no clause to add. */
  desc?: string;
  /** The banner sentence. */
  detail: string;
  paint: (value: string) => string;
  /** 4th gear silences every prompt -- it announces itself loudly. */
  loud: boolean;
}

/**
 * One mark per gear, from the closed alphabet: `››››` is 4th gear. The count
 * IS the information (see gear-3's note), and the selection glyph is thinner
 * and quieter than the ASCII `>>>>` it replaces -- which is still what a
 * seven-bit terminal gets, as the glyph's own twin.
 */
function ladder(n: number): string {
  return glyph("selection").repeat(n);
}

export function modeInfo(mode?: string): ModeInfo {
  switch (normalizeMode(mode)) {
    case "gear-2":
      return {
        id: "gear-2",
        label: "2nd gear",
        arrows: ladder(2),
        desc: "workspace edits proceed",
        detail:
          "confined workspace edits proceed; commands, delegation, network, and external access ask.",
        paint: quiet,
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
        arrows: ladder(3),
        desc: "edits + sandboxed shell",
        detail:
          "workspace edits, sandboxed local commands, and confined delegation proceed; external access asks.",
        paint: quiet,
        loud: false,
      };
    case "gear-4":
      return {
        id: "gear-4",
        label: "4th gear",
        arrows: ladder(4),
        // "no prompts" was ambiguous in exactly the place it could least
        // afford to be. In a coding agent "prompt" means the system prompt at
        // least as often as it means a confirmation, so a status line reading
        // "full autonomy | no prompts" can be read as "running without
        // instructions" — which is not true and is alarming in the opposite
        // direction from the real risk. Every other gear here names a
        // behaviour, and 1st gear is literally "every action asks first"; this
        // is its opposite, said the same way.
        desc: "never asks first",
        detail: "Rune acts without permission prompts; the OS sandbox is unchanged (see /sandbox).",
        paint: warn,
        loud: true,
      };
    case "auto":
      return {
        id: "auto",
        // The one entry that is not a gear number, so it is the one entry that
        // has to say what it is. Lowercase "auto" beside "4th gear" read as a
        // setting's value rather than a place you are standing; "Auto mode"
        // says you are in it.
        label: "Auto mode",
        arrows: "*",
        // No clause. "never asks; watched for injection" spent a permanent
        // slot on the footer restating what the mode's own name already says,
        // and named the watcher in a place where nothing can be done about it.
        // The sentence still exists in `detail`, where /status and the mode
        // switch can spell it out on request.
        detail:
          "Rune acts without permission prompts inside the sandbox; a watcher above it stops work that did not come from you.",
        paint: warn,
        loud: false,
      };
    default:
      return {
        id: "gear-1",
        label: "1st gear",
        arrows: ladder(1),
        desc: "every action asks first",
        detail: "Rune asks before writing or running.",
        paint: quiet,
        loud: false,
      };
  }
}

/**
 * A compact, always-visible permission readout: `›› 2nd gear`.
 *
 * Coloured only where the gear has stopped asking -- 4th gear and Auto, in the
 * caution ink -- and never bold: on the status line, all day, a bold amber
 * badge was the loudest thing on the screen (founder, 2026-09-26: "chunky").
 * The Shift+Tab announcement still says 4th gear loudly, once, when it happens.
 */
export function permissionModeBadge(mode?: string): string {
  const m = modeInfo(mode);
  return m.paint(`${m.arrows} ${m.label}`);
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

/** A footer key hint. One definition, in the design system -- see F.keyHint;
 *  this alias keeps the local call sites reading as they always did. */
const keyHint = F.keyHint;

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
  // Depth rides with the model and is dropped one tier BEFORE it: when space is
  // short the model's name matters more than its dial.
  const modelWithEffort =
    s.model && s.effort ? `${info(s.model)}${faint(` ${s.effort}`)}` : modelName;
  const right = keyHint("?", "keys");
  const fullHints = [
    ...(s.folds ? [keyHint("ctrl+o", "open")] : []),
    keyHint("shift+tab", "gear"),
    keyHint("esc", "stop"),
  ].join("  ");

  // What is given up first, at each width. The key hints go before the gear's
  // description does: a hint is discovery, useful once, and 80 columns is the
  // width most people are actually at — losing "edits + sandboxed shell" there
  // to buy back a hint would be the wrong trade for someone still learning what
  // the gear means. The model survives to the last tier because it is the only
  // field here that changes under the user.
  const named = [badge, ...(modelWithEffort ? [modelWithEffort] : [])].join(sep);
  const namedBare = [badge, ...(modelName ? [modelName] : [])].join(sep);
  const desc = mode.desc ? [faint(mode.desc)] : [];
  const tiers: Array<[string, string]> = [
    [[named, ...desc, ...(meter ? [meter] : []), ...extras, fullHints].join(sep), right],
    [[named, ...desc, ...(meter ? [meter] : []), ...extras].join(sep), right],
    [[named, ...desc, ...extras].join(sep), right],
    [[named, ...desc].join(sep), right],
    [named, right],
    [namedBare, right],
    [badge, right],
  ];
  for (const [left, edge] of tiers) {
    const gap = max - visLen(left) - visLen(edge);
    if (gap >= 2) return `${left}${" ".repeat(gap)}${edge}`;
  }
  return clampVisible(badge, max);
}

/** Where the global settings file lives, as the ledger's own ladder names it. */
export const SETUP_CONFIG_LABEL = "~/.rune/config.toml";

/**
 * The status strip while the setup wizard is open (§2.8).
 *
 * The ordinary strip names the model, the gear and the context meter — three
 * measurements about a conversation that has not started. During setup none of
 * them is the fact the reader needs, and the one they do need is the one the
 * wizard cannot demonstrate by drawing a number: that editing configuration
 * costs nothing, because no call is made. So the strip says exactly that, and
 * then where the two things being edited live. The first call happens when the
 * user sends a message, and not before.
 *
 * Tiers, like `statusLine`: the promise survives to the last one. Where the
 * keys go is deliberately vague about the BACKEND — it is the OS keychain on a
 * Mac and something else elsewhere, and the receipt names the real one once it
 * has actually stored something. What is invariant, and what matters here, is
 * that it is not the file named to its left.
 */
export function setupStatusLine(
  width = process.stdout.columns || 80,
  configLabel = SETUP_CONFIG_LABEL,
): string {
  const max = Math.max(8, Math.min(F.surfaceWidth(), width - 1));
  const sep = ` ${faint(glyph("observed"))} `;
  const head = `  ${accent(glyph("phase"))} ${text("setup")}`;
  const promise = faint("no model called yet");
  const tiers: string[][] = [
    [head, promise, faint(`config ${configLabel}`), faint("keys are stored outside it")],
    [head, promise, faint(`config ${configLabel}`)],
    [head, promise],
  ];
  for (const parts of tiers) {
    const row = parts.join(sep);
    if (visLen(row) <= max) return row;
  }
  return clampVisible(head, max);
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
  const lines = [`  ${faint("queued \u00b7 sends when this turn completes")}`];
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

/**
 * The Auto chip (`.auto-chip`): one line per decision Auto made that the reader
 * would want to find afterwards — and nothing for the ones they would not.
 *
 * An approval gets no chip. This used to print one per call, on the reasoning
 * that Auto never stops to ask so scrollback is the only record of what it did.
 * That reasoning holds for the decisions that CHANGED something — a contained
 * call, a redirected command, a deferred publish, a halt. It does not hold for
 * `read_file | safe-listed | risk low`, which is the harness telling you it
 * allowed the thing it always allows. Printed once per call it buried the work
 * it was supposed to make auditable: a burst of twelve reads cost twelve rows
 * of consent paperwork above the twelve rows of actual reading. Auto's whole
 * promise is not interrupting you, and a chip per approval reinstates the
 * interruption as text.
 *
 * The full decision record still exists in the audit log, and the outward steps
 * Auto declined to take are collected once, at the end, by autoDeferralSummary.
 *
 * Returns "" when there is nothing worth a row; callers must not print empties.
 */
export function autoApprovedChip(notice: {
  toolName: string;
  risk: string;
  tier?: string;
  kind?: string;
  route?: string;
  substitute?: string;
}): string {
  const kind = notice.kind ?? "approved";
  if (kind === "approved") return "";
  const headline =
    kind === "halted"
      ? warn("run halted")
      : kind === "deferred"
        ? warn("held for you")
        : kind === "redirected"
          ? muted("redirected")
          : muted("contained");
  // The row says what happened to the work. It does not say which tier decided
  // it or what risk score it carried: `safe-listed | risk low` is the audit
  // layer describing its own machinery, in the one place the reader can do
  // nothing with it, and it made every row a negotiation between two
  // vocabularies. The full decision — tier, risk, rule, timing — is in the
  // audit log and in /details, where it can actually be examined.
  const detail =
    kind === "halted"
      ? "the run stopped here, nothing further ran"
      : kind === "redirected" && notice.substitute
        ? `ran instead: ${notice.substitute.slice(0, 60)}`
        : kind === "deferred"
          ? "waiting for you at the end of the turn"
          : "kept inside the sandbox";
  return F.flowRow(
    `${F.MARK}${warn(glyph("selection"))} ${headline}  ${text(notice.toolName)}`,
    faint(detail),
  );
}

/**
 * The end-of-turn list of outward steps Auto declined to take unattended.
 *
 * This is the whole trade Auto mode makes, printed: instead of interrupting
 * the run N times to ask about N irreversible steps, it finishes the work and
 * shows you the N steps once, when you can actually judge them.
 */
export function autoDeferralSummary(
  deferrals: ReadonlyArray<{ toolName: string; summary: string; reason: string }>,
): string {
  if (deferrals.length === 0) return "";
  const head = F.flowRow(
    `${F.MARK}${warn(glyph("selection"))} ${warn(`held for you (${deferrals.length})`)}`,
    faint("outward steps Auto did not take on its own"),
  );
  const rows = deferrals.map(
    (d) =>
      `${F.BODY}  ${text(d.summary.slice(0, 88))}\n${F.BODY}    ${faint(d.reason.slice(0, 96))}`,
  );
  return [head, ...rows].join("\n");
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
    `${faint(`${Math.max(0, seconds)}s \u00b7 ${kind} needs a decision in ${modeInfo(mode).label}`)}`
  );
}

/**
 * The sandbox posture, printed when `/sandbox` toggles (and as a readout when
 * it is called with no argument). Off is loud for the same reason 4th gear is:
 * it removes a containment layer. "On" is only an isolation claim when this
 * machine can actually isolate -- on the degraded path the banner is just as
 * loud, because the user would otherwise be trusting a layer that is not there.
 */
export function sandboxModeBanner(state: boolean | "auto-allow" | "regular" | "off"): string {
  const mode = state === true ? "auto-allow" : state === false ? "off" : state;
  if (mode === "off") {
    return stateBanner(
      "!",
      "sandbox off",
      "Commands run directly on this machine, with full network and filesystem access. In Auto, read-only commands run and anything else is reviewed first.",
      "(/sandbox to choose a mode)",
      warn,
      true,
    );
  }
  if (!isOsIsolationAvailable()) {
    return stateBanner(
      "!",
      `sandbox ${mode} -- not isolated`,
      `No OS sandbox backend on this machine (${getSandboxCapability().mechanism}): commands run with path-guard checks only, full network and host access, and bash still asks for approval.`,
      "(install sandbox-exec or bwrap for real isolation)",
      warn,
      true,
    );
  }
  if (mode === "regular") {
    return stateBanner(
      glyph("verified"),
      "sandbox on -- regular permissions",
      "Commands run in an OS sandbox -- no network, workspace-confined writes -- and the gear's usual permission prompt still applies to each one.",
      "(/sandbox to choose a mode)",
      ok,
    );
  }
  return stateBanner(
    glyph("verified"),
    "sandbox on -- auto-allow",
    "Commands run in an OS sandbox -- no network, workspace-confined writes -- and are approved without a prompt in 3rd gear and Auto. A call that sets network: true escalates just that one command.",
    "(/sandbox to choose a mode, an override, or exclusions)",
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
        "Rune can drive a headless, isolated browser (Playwright MCP) -- navigate, read, fill, click. First use fetches @playwright/mcp, and a managed Chromium if none is installed.",
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
  /**
   * What the empty field is for, right now. It defaults to the session's
   * placeholder, and a surface that has borrowed the composer for something
   * else overrides it: while the agent is waiting on an answer, a field that
   * still reads "describe a change, or / for commands" is the UI telling you
   * to do the one thing it is not currently listening for.
   */
  placeholder?: string;
  /**
   * The most FIELD rows this composer may draw -- the rules, the hint and the
   * status line are the caller's and are not counted here.
   *
   * The field grows into whatever block it shares until it reaches this, and
   * then scrolls inside itself with the caret row kept visible. Absent, it
   * grows as far as the text goes; the callers that share a frame always pass
   * one, because a field that can take the whole window is a field that can
   * erase the thing it is being written about.
   */
  maxRows?: number;
}

// --- The wrapped field ---
//
// The buffer stays ONE string and ONE caret index -- that is the right model,
// and it is why every edit operation (insert, backspace, ctrl+u, history
// recall) kept working unchanged when the field learned to wrap. What changed
// is the renderer: it maps that index onto a grid of rows.
//
// The field used to scroll HORIZONTALLY, one row, keeping the caret in the last
// visible cell. That is the thing that made a long message unreadable while you
// were writing it -- you could see forty characters of the four hundred you had
// typed, and no amount of arrowing back showed you the whole sentence at once.

/** One visual row of the field: a half-open slice of the buffer. */
export interface ComposerRow {
  /** Buffer index of this row's first rendered character. */
  start: number;
  /** Buffer index one past this row's last rendered character. */
  end: number;
}

/**
 * A caret position on the grid, and its inverse.
 *
 * `composerIndex(rows, pos)` is exactly `rows[pos.row].start + pos.col`, and
 * `composerCaret` is built so that composing the two is the identity for every
 * index in the buffer. That round-trip is not decoration: it is the property
 * that makes "the caret is where you think it is" testable rather than
 * eyeballed, and it is what forces the two awkward cases below to be handled
 * instead of clamped away.
 */
export interface ComposerPos {
  row: number;
  col: number;
}

/**
 * Wrap one segment of a logical line into rows.
 *
 * Two rules earn their keep here, and both exist so that EVERY buffer index has
 * a cell to sit in -- no caret is ever stranded at column `textW`, which is one
 * past the last cell the field owns:
 *
 *  - a row breaks at the last space STRICTLY inside the window, never at the
 *    window's last column, so the space that was eaten is still a column this
 *    row can put the caret on;
 *  - a segment whose length is an exact multiple of `textW` ends with an empty
 *    row, which is where the caret goes and where the next character lands.
 *
 * `keepTail` is false only when another segment follows on the same logical
 * line (a paste chip, or the prose after one): that segment's first row starts
 * at the same index, so the empty row would be a blank line with nothing to do.
 */
function wrapSegment(
  rows: ComposerRow[],
  input: string,
  from: number,
  to: number,
  textW: number,
  breakable: boolean,
  keepTail: boolean,
): void {
  // Measured in terminal CELLS, not JS string units, so a double-width
  // character (CJK, fullwidth forms, ...) spends two of the row's budget
  // instead of one -- `render.ts`'s own stated policy, which this path did
  // not follow even though the file already imports `visLen` for everything
  // else. `graphemeSpans` also makes a hard break safe: a surrogate pair or a
  // base+combining-mark cluster is one indivisible unit with its own index
  // span, so a break can never land inside one.
  const spans = graphemeSpans(input.slice(from, to)).map((s) => ({
    start: s.start + from,
    end: s.end + from,
    width: s.width,
  }));
  // Cells remaining from spans[m..] onward, suffix-summed once so the "does
  // the rest fit on one row" check below stays O(1) per row rather than
  // O(rows) -- this runs on every keystroke (wrapComposer's own doc comment).
  const suffixCells = new Array<number>(spans.length + 1).fill(0);
  for (let m = spans.length - 1; m >= 0; m--)
    suffixCells[m] = suffixCells[m + 1]! + spans[m]!.width;

  let i = from; // buffer index the row under construction starts at
  let k = 0; // spans[k..] is what still needs to go on a row
  for (;;) {
    if (suffixCells[k]! < textW) {
      if (i === to && !keepTail) return;
      rows.push({ start: i, end: to });
      return;
    }
    // Grow the row grapheme by grapheme while it still fits in `textW` cells.
    // `lastInsideLimit` is the last span index that ends STRICTLY before the
    // window's final cell -- never ON it -- the same "never break at the
    // window's last column" rule as before, generalised from code units to
    // cells so the eaten space still leaves the caret a column to land on.
    let cells = 0;
    let end = k;
    let lastInsideLimit = k;
    while (end < spans.length && cells + spans[end]!.width <= textW) {
      cells += spans[end]!.width;
      end++;
      if (cells < textW) lastInsideLimit = end;
    }
    let brk = -1; // spans index of a break space
    if (breakable) {
      for (let m = lastInsideLimit; m > k; m--) {
        if (input.slice(spans[m - 1]!.start, spans[m - 1]!.end) === " ") {
          brk = m - 1;
          break;
        }
      }
    }
    if (brk >= k) {
      rows.push({ start: i, end: spans[brk]!.start });
      i = spans[brk]!.end; // the space is this row's last column
      k = brk + 1;
    } else {
      // One glyph cluster wider than the field, or nothing breakable: hard
      // break after the last grapheme that fit. `cut` is always > k, so a row
      // always makes progress -- even a single wide glyph that alone exceeds
      // `textW` gets a row of its own rather than being split across two.
      const cut = Math.max(k + 1, Math.min(end, spans.length));
      rows.push({ start: i, end: spans[cut - 1]!.end });
      i = spans[cut - 1]!.end;
      k = cut;
    }
  }
}

/** Split one logical line at its paste chips, then wrap each piece. A chip is
 *  unbreakable and starts a row of its own, so the message's shape is visible. */
function wrapLine(
  rows: ComposerRow[],
  input: string,
  from: number,
  to: number,
  textW: number,
  chips: Array<{ start: number; end: number }>,
): void {
  const segs: Array<{ start: number; end: number; chip: boolean }> = [];
  let at = from;
  for (const chip of chips) {
    if (chip.start < at || chip.end > to) continue;
    if (chip.start > at) segs.push({ start: at, end: chip.start, chip: false });
    // The space between a chip and the sentence after it belongs to the chip's
    // row. Left on the next row it renders as a one-cell indent nobody typed,
    // and every row under it inherits the offset -- which is exactly the kind
    // of drift that makes a wrapped field look broken. It still has a cell to
    // put the caret in, at the end of the chip's own row.
    const gap = chip.end < to && input[chip.end] === " " ? 1 : 0;
    segs.push({ start: chip.start, end: chip.end + gap, chip: true });
    at = chip.end + gap;
  }
  if (at < to || segs.length === 0) segs.push({ start: at, end: to, chip: false });
  segs.forEach((seg, i) =>
    wrapSegment(rows, input, seg.start, seg.end, textW, !seg.chip, i === segs.length - 1),
  );
}

/** The buffer as a grid of rows `textW` columns wide. Newlines are structure,
 *  not characters: they end a row and are never rendered.
 *
 *  The chip scan is done ONCE for the whole buffer rather than once per logical
 *  line. This function runs on every keystroke, and a 40-line draft would
 *  otherwise re-run the matcher over the whole string forty times to answer a
 *  question whose answer never changed. */
export function wrapComposer(input: string, textW: number): ComposerRow[] {
  const w = Math.max(1, Math.floor(textW));
  const chips = pasteChipSpans(input);
  const rows: ComposerRow[] = [];
  let lineStart = 0;
  for (;;) {
    const nl = input.indexOf("\n", lineStart);
    wrapLine(rows, input, lineStart, nl < 0 ? input.length : nl, w, chips);
    if (nl < 0) return rows;
    lineStart = nl + 1;
  }
}

/**
 * Where a buffer index sits on the grid.
 *
 * The rule is "the LAST row that starts at or before the index", which resolves
 * both boundary cases correctly and without a special case: at a hard break the
 * next row starts exactly at the index, so the caret goes to its column 0,
 * which is where the next character will appear; at a soft break the eaten
 * space belongs to the row above it, so the caret stays at the end of the word
 * it just finished.
 */
export function composerCaret(rows: ComposerRow[], index: number): ComposerPos {
  if (rows.length === 0) return { row: 0, col: 0 };
  let at = 0;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i]!.start <= index) at = i;
    else break;
  }
  return { row: at, col: Math.max(0, index - rows[at]!.start) };
}

/** The inverse of `composerCaret`. */
export function composerIndex(rows: ComposerRow[], pos: ComposerPos): number {
  const row = rows[Math.max(0, Math.min(pos.row, rows.length - 1))];
  return row ? row.start + pos.col : pos.col;
}

/**
 * The text columns a composer drawn at `width` gives the message.
 *
 * One formula, exported, because the hint row has to count the rows the field
 * will actually draw -- a hint that says "9 lines" over a field that drew ten
 * is worse than no hint. `width` is the same `ComposerState.width` the field is
 * asked for, and this reads the surface measure the same way it does, so both
 * must be called under the same width override.
 */
export function composerTextWidth(width: number): number {
  return Math.max(1, Math.max(12, Math.min(F.surfaceWidth(), width - 1)) - 4);
}

/** Display rows and characters of the buffer, for the hint row. Counted as the
 *  field shows them: a collapsed paste is its chip, not its body. */
export function composerCounts(input: string, textW: number): { lines: number; chars: number } {
  return { lines: wrapComposer(input, textW).length, chars: input.length };
}

/**
 * The one quiet hint row under the field, by the same tier ladder `statusLine`
 * uses: the widest thing that fits, and never a row that overflows the measure.
 *
 * Three states. The counts replace the keys once the draft has WRAPPED, not on
 * the first keystroke -- "1 line · 32 chars" is noise pretending to be data,
 * and it is the second row that makes how much you have written a thing you
 * can no longer see at a glance. `ctrl+b` is the one binding nobody can guess,
 * so among the keys it is the last to go; at forty cells only three of the four
 * fit, and the counts row names it the moment a draft needs it.
 */
export function composerHintRow(opts: {
  /** Kept for callers; a streaming turn's keys moved to the status line. */
  streaming: boolean;
  counts: { lines: number; chars: number };
  max: number;
}): string {
  const sep = ` ${glyph("observed")} `;
  const fits = (s: string): boolean => visLen(s) <= opts.max;
  const { lines, chars } = opts.counts;
  if (lines > 1) {
    const size = [`${lines} lines`, `${chars} chars`].join(sep);
    for (const tier of [`${size}   ctrl+b line`, size, `${lines} lines`]) {
      if (fits(tier)) return tier;
    }
    return `${lines} lines`;
  }
  // Nothing at rest, and nothing while a turn streams. The resting legend
  // (`enter send · ctrl+b line · ctrl+f agents · ? keys`) restated what the
  // placeholder, the key sheet and the status line already say; the streaming
  // one (`enter queues · esc interrupts`) now rides the status line's right
  // edge, where contextual keys are said in every layout (2026-09-26).
  return "";
}

/** The slice of a capped field's rows that is actually drawn, and what it costs. */
export interface ComposerWindow {
  /** Index of the first drawn row. */
  top: number;
  /** How many rows of text are drawn. */
  count: number;
  /** Rows elided above the window. */
  above: number;
  /** Rows elided below it. */
  below: number;
}

/**
 * The window of rows a capped field shows.
 *
 * The tail by default -- you are almost always typing at the end -- and the
 * caret's row is always inside it. One row of the budget goes to a marker that
 * states the elision, and the marker counts BOTH directions: a field that
 * silently drops rows lies about how much you have written, and `ctrl+a` on a
 * thirty-row draft drops them off the bottom exactly as readily as typing drops
 * them off the top. The whole field is therefore always `min(total, cap)` rows
 * -- what it costs the panel does not depend on where the caret is.
 */
export function composerWindow(total: number, caretRow: number, maxRows: number): ComposerWindow {
  const cap = Math.max(1, Math.floor(maxRows));
  if (total <= cap) return { top: 0, count: total, above: 0, below: 0 };
  // At one row there is nowhere to put the marker, and one row of what you
  // wrote beats one row of chrome saying you wrote it.
  if (cap < 2)
    return { top: Math.max(0, Math.min(caretRow, total - 1)), count: 1, above: 0, below: 0 };
  const count = cap - 1;
  let top = Math.max(0, total - count);
  if (caretRow < top) top = caretRow;
  return { top, count, above: top, below: Math.max(0, total - top - count) };
}

export interface RenderedBlock {
  lines: string[];
  caretRow: number;
  caretCol: number;
  /**
   * The row the window must keep on screen when the block is taller than the
   * footer: the one the reader is standing on.
   *
   * Stated by the block rather than guessed from the bytes, because the
   * selection glyph is also the grammar's notice bullet -- the held panel's
   * own title carries one -- and a window anchored on the first `›` it finds
   * anchors on the title and never moves (verifier pass 3, finding 21).
   * Absent means "no selection", and the caret is the anchor.
   */
  anchorRow?: number;
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
    source.length > pageSize
      ? ` \u00b7 ${start + 1}-${start + view.length} of ${source.length}`
      : "";
  const maxWidth = Math.max(8, F.measure(width - 1));
  const lines = [
    clampVisible(`${title}${faint(range)}`, maxWidth),
    ...view.map((line) => clampVisible(line, maxWidth)),
    `  ${faint("up/down scroll \u00b7 page up/down \u00b7 ctrl+r or esc close")}`,
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
 *
 * It WRAPS. The field is as many rows as the message needs, up to `maxRows`,
 * and past that it scrolls inside itself with a counted marker for what is
 * above. Nothing scrolls sideways: a writing surface whose only view of four
 * hundred typed characters is the last forty is not one you can re-read what
 * you wrote in, and re-reading what you wrote is most of what a composer is
 * for. The rows are never wider than the field, so the frame around them holds
 * whatever is typed into it.
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
      anchorRow: 0,
    };
  }

  const textW = composerTextWidth(state.width); // PAD(2) + `>`(1) + space(1)

  // The caret is painted, not requested.
  //
  // OSC 12 asks the terminal to colour its own cursor, and a terminal is free
  // to ignore that — Warp does, drawing its cursor in its own theme regardless,
  // which left a foreign accent sitting on the first character of the input on
  // every frame. Painting the cell needs nothing from the host and looks the
  // same everywhere.
  const paint = (raw: string, at: number, dim: boolean): string => {
    const head = raw.slice(0, at);
    const cell = raw.slice(at, at + 1) || " ";
    const tail = raw.slice(at + 1);
    const wrapText = dim ? faint : text;
    return `${head ? wrapText(head) : ""}${cursorCell(cell)}${tail ? wrapText(tail) : ""}`;
  };
  // A control byte that survived the edit path is shown as a space rather than
  // written through: one of them is one desynced row, and every row below it
  // lands in the wrong column. Newlines never reach here -- they are structure,
  // and wrapComposer has already spent them ending rows.
  //
  // Padded and (defensively) truncated by terminal CELL width, not JS string
  // length: a row of double-width characters has fewer characters than cells,
  // and padEnd/slice by length there padded it back out past the pane's own
  // edge -- up to 2x over budget for an all-wide-character row. wrapSegment
  // already bounds `s` to `textW` cells for every row it produces, so the
  // truncation branch here is a backstop, not the common path.
  const cell = (s: string): string => {
    const safe = s.replace(/[\x00-\x1f\x7f]/g, " ");
    const fit = visLen(safe) > textW ? prefixByWidth(safe, textW) : safe;
    return fit + " ".repeat(Math.max(0, textW - visLen(fit)));
  };

  const grid = wrapComposer(state.input, textW);
  const pos = composerCaret(grid, Math.max(0, Math.min(state.caret, state.input.length)));
  const win = composerWindow(grid.length, pos.row, state.maxRows ?? grid.length);

  // The elision marker takes the chevron's column, so the field keeps one
  // marker column throughout and the text stays on its own edge. It sits on
  // the side the rows went -- above when the field has scrolled off the top,
  // below when the caret has walked up past a tail. When both are elided one
  // marker says both, because the second row would be a row of the draft.
  const rows = (n: number): string => `${n} line${n === 1 ? "" : "s"}`;
  const marker = (t: string): string => `${PAD}${faint(glyph("elision"))} ${faint(cell(t))}`;
  const field: string[] = [];
  if (win.above > 0) {
    field.push(
      marker(
        win.below > 0
          ? `${win.above} above ${glyph("observed")} ${win.below} below`
          : `${rows(win.above)} above`,
      ),
    );
  }
  if (state.input.length === 0) {
    field.push(
      `${PAD}${muted(glyph("selection"))} ${paint(cell(state.placeholder ?? COMPOSER_PLACEHOLDER), 0, true)}`,
    );
  } else {
    for (let i = win.top; i < win.top + win.count && i < grid.length; i++) {
      const row = grid[i]!;
      const raw = cell(state.input.slice(row.start, row.end));
      // The chevron marks where the message starts; a continuation row is the
      // same message, so it gets the column and not the mark.
      const mark = i === win.top ? muted(glyph("selection")) : " ";
      field.push(`${PAD}${mark} ${i === pos.row ? paint(raw, pos.col, false) : text(raw)}`);
    }
    if (win.above === 0 && win.below > 0) field.push(marker(`${rows(win.below)} below`));
  }

  // A rule above AND below. One rule is a divider — it separates the composer
  // from the transcript but leaves the input itself floating, so on a quiet
  // screen there is nothing telling you where the typing goes. Two rules make
  // it a place: the field has edges, and the status hint sits outside them
  // rather than looking like more input.
  // The SAME rule the header draws — indented to the content column, so the
  // field's edges line up with the text inside it and with everything above.
  const edge = F.hairline(width);

  // The blank line above the field belongs to the FIELD, not to whatever is
  // above it. Owning it here is what makes the frame hold in both directions:
  // on a long session it keeps the input from touching the last line of
  // output, and on a fresh one it keeps this rule off the row directly below
  // the header's rule, where the two would draw as a doubled border. The
  // caller above cannot know which case it is in; this block always can.
  //
  // PAD(2) + chevron(1) + space(1) = 4 cols before the input text.
  const caretRow = 2 + (win.above > 0 ? 1 : 0) + Math.max(0, pos.row - win.top);
  const caretCol = 4 + (state.input.length === 0 ? 0 : pos.col);
  // The anchor is stated, not found: the status line under the field carries
  // the gear's `››››`, and a window that went looking for the last `›` on
  // screen would anchor on the status line instead of on where you type.
  return {
    lines: ["", edge, ...field, edge, ...statusLines],
    caretRow,
    caretCol,
    anchorRow: caretRow,
  };
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
    if (/host/.test(preview.scope)) return "bash \u00b7 host";
    if (/sandboxed/.test(preview.scope)) return "bash \u00b7 sandboxed";
    return isSandboxEnabled() && isOsIsolationAvailable()
      ? "bash \u00b7 sandboxed"
      : "bash \u00b7 host";
  }
  const scope = preview.scope.split(/[|\u00b7]/)[0]?.trim() ?? "";
  return scope && scope !== "explicit approval" ? `${toolName} \u00b7 ${scope}` : toolName;
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
  ].join(" \u00b7 ");

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

  // The caret rests on the highlighted answer.
  //
  // This used to find the option rows by scanning for a line starting with
  // "1 ", which broke the moment ask() began painting a selection marker into
  // the body indent -- the selected row starts with the marker, not the digit,
  // so row zero silently became the caret's home. The options are the last
  // rows ask() emits before its single hint line, and that is knowable without
  // reading the text back. Measured HERE, against ask()'s own output, before
  // the guard footnote below lengthens the block.
  const choiceCount = preview.choices?.length ? preview.choices.length : PERMISSION_LABELS.length;
  const firstOption = lines.length - choiceCount - F.ASK_TRAILING_ROWS;

  const guard = `${preview.guard} \u00b7 the decision is recorded in the audit trail`;
  lines.push("");
  for (const part of wrap(guard, body)) lines.push(`${F.BODY}${faint(part)}`);

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

/**
 * A row's tags, quiet. `free`, `local` and the provider were three colours of
 * chip; they are facts about a model, not states, so they read in the meta
 * grey like every other receipt. `current` is the one that says where you ARE,
 * and gets the secondary ink.
 */
function pickerTags(tags: readonly string[], current: boolean): string {
  const parts = [...tags.map((tag) => faint(tag)), ...(current ? [quiet("current")] : [])];
  return parts.length > 0 ? "  " + parts.join(faint(` ${glyph("observed")} `)) : "";
}

/**
 * A hint yields by whole segments, never mid-word. "gpt-oss:120b | 35 events |
 * 9.3k tokens" behind a long session title at 80 columns rendered as
 * "gpt-oss…", a fragment that carried nothing (2026-09-10). Segments drop from
 * the right until the rest fits; below twelve cells the hint goes entirely --
 * the title is the row's identity, the hint is its receipt.
 */
function fitHint(hint: string, budget: number): string {
  if (budget < 12) return "";
  const sep = hint.includes(" \u00b7 ") ? " \u00b7 " : hint.includes(" | ") ? " | " : null;
  const parts = sep ? hint.split(sep) : [hint];
  while (parts.length > 1 && visLen(parts.join(sep ?? "")) > budget) parts.pop();
  const fitted = parts.join(sep ?? "");
  return "  " + quiet(visLen(fitted) > budget ? truncate(fitted, budget) : fitted);
}

/**
 * The list overlay behind `/model`, `/login`, `/config`, `/theme`, `/sandbox`
 * and resume: a quiet lowercase title, the rows, one legend line.
 *
 * The selected row is the full-width bar (flow.ts `band`) -- the founder's
 * `/sessions` bar, now the only way any list in the product says "you are
 * here". Numbers are shown only when every row can be reached by one: a list
 * of seventeen settings that advertised "1-9 quick select" offered a shortcut
 * to half of itself.
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
  const lines: string[] = [clampVisible(`${PAD}${muted(title.toLowerCase())}`, maxWidth)];
  const sel = items.length ? Math.max(0, Math.min(selected, items.length - 1)) : 0;
  // The footnote occupies a row too. Keep the selected item visible even when
  // the caller can give a dialog only its header, one item and key hints.
  const showFootnote = Boolean(options.footnote) && height >= 4;
  const chromeRows = 2 + (showFootnote ? 1 : 0);
  const maxItems = Math.max(1, Math.min(items.length || 1, Math.floor(height) - chromeRows));
  let start = 0;
  if (items.length > maxItems) {
    start = Math.min(Math.max(0, sel - Math.floor(maxItems / 2)), items.length - maxItems);
  }
  const numbered = items.length <= 9;
  const view = items.slice(start, start + maxItems);
  view.forEach((it, i) => {
    const on = start + i === sel;
    const marker = on ? glyph("selection") : " ";
    const number = numbered ? `${faint(`${start + i + 1}.`)} ` : "";
    const label = on ? bold(text(it.label)) : text(it.label);
    const prefix = it.prefix ? `${it.prefix} ` : "";
    const tags = pickerTags(it.tags ?? [], it.current === true);
    const fixed = visLen(`${PAD}${marker} ${number}${prefix}`) + visLen(label) + visLen(tags);
    const hint = it.hint ? fitHint(it.hint, Math.min(52, maxWidth - fixed - 2)) : "";
    const row = clampVisible(`${PAD}${marker} ${number}${prefix}${label}${hint}${tags}`, maxWidth);
    lines.push(on ? F.band(row, maxWidth) : row);
  });
  if (showFootnote) {
    lines.push(`${PAD}${faint(truncate(options.footnote ?? "", maxWidth - 4))}`);
  }
  const keys = [
    "enter select",
    ...(numbered && items.length > 1 ? [`1-${items.length} jump`] : []),
    "esc close",
  ];
  lines.push(`${PAD}${faint(keys.join(` ${glyph("observed")} `))}`);
  return { lines, caretRow: sel - start + 1, caretCol: 0 };
}

// --- Slash-command palette (TUI: live `/` menu) ---

export interface SlashItem {
  /** Command including its leading "/" (e.g. "/model"). */
  name: string;
  /** One-line description. */
  desc: string;
  /** Compact context badge, e.g. "cosmetic" or "history". No longer drawn in
   *  the palette (a category ~130 columns from its row was read as noise);
   *  kept on the item for callers that group by it. */
  tag?: string;
}

/**
 * The slash-command palette that opens above the composer as you type `/`: a
 * quiet heading with the count, then two columns -- the command, and what it
 * does. The selected row is the full-width bar (flow.ts `band`); nothing sits
 * at the far right of a row any more, so at 186 columns the description is
 * still beside the command it describes. Windows around the selection so a
 * long list never overruns.
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
  const sep = ` ${glyph("observed")} `;

  const rows = view.map((it, i) => {
    const on = start + i === sel;
    const marker = on ? glyph("selection") : " ";
    const name = on ? bold(text(it.name.padEnd(nameW))) : text(it.name.padEnd(nameW));
    const descMax = Math.max(8, maxWidth - nameW - 7);
    const desc = it.desc ? "  " + quiet(truncate(it.desc, descMax)) : "";
    const row = clampVisible(`${PAD}${marker} ${name}${desc}`, maxWidth);
    return on ? F.band(row, maxWidth) : row;
  });
  const count =
    total != null && total !== items.length ? `${items.length} of ${total}` : String(items.length);
  const heading = `${PAD}${muted("commands")}${faint(`${sep}${count}`)}`;
  // Arrows, enter and esc are what every list does; tab is the one key here a
  // person would not guess, so it is the last to go.
  const room = maxWidth - visLen(heading) - 3;
  const legend =
    [["tab complete", "enter run", "esc close"], ["tab complete", "esc close"], ["tab complete"]]
      .map((tier) => tier.join(sep))
      .find((tier) => visLen(tier) <= room) ?? "";
  const headGap = " ".repeat(Math.max(1, maxWidth - visLen(heading) - visLen(legend) - 1));
  return [clampVisible(`${heading}${legend ? headGap + faint(legend) : ""}`, maxWidth), ...rows];
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
  /**
   * Where the credential in use comes from (BYOP-aware: keychain/oauth too).
   * `chain` is an enterprise cloud route (Bedrock / Vertex / Azure with Entra):
   * the machine's own AWS/GCP/Azure credentials, which Rune reads and never
   * stores — so there is no key to mask and `credentialDetail` carries the
   * secret-free description instead.
   */
  source: "keychain" | "oauth" | "saved" | "env" | "chain" | "none";
  /** For sources with no maskable secret: where the credential was found. */
  credentialDetail?: string;
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
  /** A local runtime (ollama) reached by base URL, no key. */
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
export function renderKeysPanel(
  rows: KeyRow[],
  selected: number,
  width: number,
  height = Number.POSITIVE_INFINITY,
): RenderedBlock {
  const sel = rows.length ? Math.max(0, Math.min(selected, rows.length - 1)) : 0;
  // Window around the selection, like the picker: the roster is thirty-odd
  // providers now, and a panel that painted every row overran a short
  // terminal and pushed its own key hints off the bottom.
  const maxRows = Math.max(1, Math.min(rows.length || 1, Math.floor(height) - 2));
  let start = 0;
  if (rows.length > maxRows) {
    start = Math.min(Math.max(0, sel - Math.floor(maxRows / 2)), rows.length - maxRows);
  }
  const view = rows.slice(start, start + maxRows);
  const windowed = rows.length > maxRows ? faint(`  ${sel + 1} of ${rows.length}`) : "";
  const labelW = Math.min(15, Math.max(8, ...rows.map((r) => r.label.length), 8));
  const keyW = Math.max(10, Math.min(22, width - labelW - 24));
  const barWidth = Math.max(8, F.measure(width - 1));

  const lines: string[] = [
    `${PAD}${bold(text("API keys"))}   ${faint("bring your own -- applied live, saved to ~/.rune/secrets.json")}${windowed}`,
  ];

  view.forEach((r, i) => {
    const on = start + i === sel;
    // Local runtimes are usable without a key; treat a configured/active one as "ready".
    const ready = r.local ? !!r.hasKey : r.source !== "none";
    const marker = on ? glyph("selection") : " ";
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
    const row = `${PAD}${marker} ${dot} ${name} ${keyCell} ${srcCell} ${toggle}`;
    lines.push(on ? F.band(row, barWidth) : row);
  });

  lines.push(
    `${PAD}${faint("up/down move \u00b7 enter manage keys \u00b7 space on/off \u00b7 d clear \u00b7 /login connect \u00b7 esc close")}`,
  );
  return { lines, caretRow: sel - start + 1, caretCol: 0 };
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
    `${PAD}${bold(text(`${providerLabel} \u00b7 keys`))}   ${faint(
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
      const marker = on ? glyph("selection") : " ";
      const dot = r.active ? ok(glyph("live")) : faint("o");
      const mask = (on ? text : muted)(truncate(r.masked, maskW).padEnd(maskW));
      const label = labelW > 0 ? "  " + faint(truncate(r.label ?? "", labelW).padEnd(labelW)) : "";
      const date = "  " + faint(`added ${formatKeyDate(r.addedAt)}`);
      const activeTag = r.active ? "  " + ok("active") : "";
      const row = `${PAD}${marker} ${dot} ${mask}${label}${date}${activeTag}`;
      lines.push(on ? F.band(row, Math.max(8, F.measure(width - 1))) : row);
    });
  }

  lines.push("");
  lines.push(
    `${PAD}${faint("a add key \u00b7 enter/space set active \u00b7 d remove \u00b7 esc back")}`,
  );
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
    `${PAD}${bold(text("System memory"))}   ${faint("a guide Rune tailors to -- it never overrides what you ask")}`,
  );
  const empty = !v.content.trim();
  lines.push(
    `${PAD}${faint(
      empty
        ? `empty | auto-update ${v.scheduleLabel}`
        : `~${v.tokens}/${v.maxTokens} tokens \u00b7 auto-update ${v.scheduleLabel} \u00b7 dreamed ${v.lastDreamed}`,
    )}`,
  );
  lines.push("");

  if (empty) {
    lines.push(`${PAD}${muted("Rune hasn't learned about you yet.")}`);
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
    const marker = on ? glyph("selection") : " ";
    const lab = on ? bold(text(label)) : text(label);
    const line = `${PAD}${marker} ${lab}${hint ? "   " + faint(hint) : ""}`;
    lines.push(on ? F.band(line, Math.max(8, F.measure(width - 1))) : line);
  };
  row(0, "Refresh now", v.busy ? "dreaming..." : "learn from your recent sessions");
  row(
    1,
    `Auto-update: ${v.scheduleLabel}`,
    "enter cycles manual \u00b7 daily \u00b7 3d \u00b7 weekly",
  );
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
    `${PAD}${faint("up/down move \u00b7 enter choose \u00b7 r refresh \u00b7 c cadence \u00b7 a add \u00b7 e edit \u00b7 x clear \u00b7 esc close")}`,
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
  if (days === 0) return opts.withDate ? `Today \u00b7 ${date()}` : "Today";
  if (days === 1) return opts.withDate ? `Yesterday \u00b7 ${date()}` : "Yesterday";
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
  // The tab you are on is bold ink; the other is meta grey. Weight, not a
  // coloured chip -- the chrome has no hue to spend on it.
  const tab = (label: string, on: boolean): string =>
    on ? bold(text(` ${label} `)) : faint(` ${label} `);
  const tabs = `${tab("Active", opts.view === "active")} ${tab("Archived", opts.view === "archived")}`;
  const count = query ? faint(`${rows.length} ${rows.length === 1 ? "match" : "matches"}`) : "";
  const headLeft = `${PAD}${bold(text("Sessions"))}  ${tabs}${count ? "  " + count : ""}`;
  const searchText = `${opts.searching ? brand(glyph("selection")) : faint("/")} ${
    query ? text(query) : faint("Search title, path, model...")
  }${opts.searching ? cursorCell(" ") : ""}`;
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
    lines.push(
      `${PAD}${faint("/ search \u00b7 tab active/archived \u00b7 ctrl+n new \u00b7 esc close")}`,
    );
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
  // `rune resume <id>`, and is off the other rows entirely.
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

    // The selected row is a BAND: the same full-width inverse block the user's
    // own messages get (speakerSurface), from the left edge through the title
    // and context to the time. A tinted title alone was not enough to tell
    // which of thirty near-identical rows the cursor was on (the founder's
    // 2026-09-05 screenshot). Inside the band every fragment stays uncoloured
    // -- bold for the title, nothing else -- so the block is one block; a grey
    // context column on a white band would read as a hole in it.
    const marker = on ? glyph("selection") : " ";
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
    const title = on ? bold(titleText) : text(titleText);
    const ctxText = ctxBudget ? truncate(context, ctxBudget) : "";
    const ctx = ctxText ? (on ? ctxText : faint(ctxText)) : "";

    const titleCell = titleText.padEnd(titleBudget).slice(titleText.length);
    let row = `${lead}${title}${titleCell}`;
    if (ctx) row += `  ${ctx}${" ".repeat(Math.max(0, ctxBudget - visLen(ctxText)))}`;
    const gap = Math.max(1, maxWidth - visLen(row) - visLen(tail));
    row += `${" ".repeat(gap)}${on ? tail : faint(tail)}`;

    if (on) caretRow = lines.length;
    // The band is the row's whole width, not the width of its text -- and it
    // is the same bar every other list now draws (flow.ts `band`).
    lines.push(on ? F.band(row, maxWidth) : clampVisible(row, maxWidth));
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
  // `rune resume <id>` and costs the list nothing.
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
  const hint = `${PAD}${faint("enter save \u00b7 esc cancel \u00b7 paste supported")}`;

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
