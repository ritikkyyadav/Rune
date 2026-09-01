// ─── TUI controller (raw mode) ───
// Gear's terminal UI. TWO layouts, and the default has fixed chrome:
//
//   FIXED (default, ./viewport.ts)
//     The alternate screen split into three zones. The identity header holds
//     the top rows, the composer and status hold the bottom rows, and the
//     transcript in between is the ONLY thing that scrolls. Chrome that is
//     chrome: a wheel flick, a Page Up or a streaming turn move the middle and
//     nothing else. Gear owns the scrollback for the transcript and provides
//     the gestures itself (wheel, PgUp/PgDn, shift+arrows, End).
//
//   INLINE (--inline / GEAR_INLINE, ./screen.ts)
//     The transcript is committed to the terminal's OWN scrollback and only the
//     composer is pinned. Native momentum scrolling, ⌘F, mouse selection and
//     `| tee` all work — at the cost of the frame, because the terminal scrolls
//     the header and the field away along with the text.
//
// The fixed layout is what a previous phase deleted, and the reason it was
// deleted is worth keeping straight, because it is NOT "the alternate screen is
// bad": that surface asserted a theme BACKGROUND across every cell, so an empty
// session rendered as a viewport of painted nothing and every terminal whose
// palette disagreed looked broken. This compositor asserts no background. Rows
// no zone claims are erased to the terminal's own colour, exactly like the
// inline surface, so the window inherits the user's theme instead of fighting
// it. What it does own is layout — and layout is the thing that was wrong.
//
// Selected over the readline path with `--tui` / GEAR_TUI=1; `--classic` opts
// out to the plain printer. `--fullscreen` names the default and is a no-op.

import type {
  Engine,
  PermissionHandler,
  UserPermissionDecision,
  TranscriptLine,
} from "../../engine";
import { findCommand, type SlashCommand } from "../../commands";
import {
  hasStoredCredential,
  openCredentialStore,
  setProviderKey as persistKey,
  addProviderKey as persistAddKey,
  removeProviderKey as persistRemoveKey,
  setActiveProviderKey as persistSetActiveKey,
  clearProviderKey as persistClearKey,
  providerKeyEntries as readProviderKeyEntries,
  setCustomEndpoint as persistCustom,
  clearCustomEndpoint as persistClearCustom,
  setProviderDisabled as persistDisabled,
  setLocalEndpoint as persistLocalEndpoint,
  getPreset,
  PROVIDER_PRESETS,
  CUSTOM_PROVIDER_ID,
  loadLastModel,
  loadPrefs,
  savePrefs,
  mayPersistGear,
  shouldAskAboutFourthGear,
  saveLastModel,
  saveSandboxState,
  saveBrowserState,
  getSystemMemoryPath,
} from "@gear/shared";
import type { CustomEndpoint } from "@gear/shared";
import type { ReasoningEffort } from "@gear/llm-gateway";
import { routeChoices, loginTargets, connectedSummary, type LoginTarget } from "./login-picker";
import { getStrategy, type AuthContext } from "@gear/llm-gateway";
import { openBrowser } from "../byop-cli-shared";
import {
  providerChoices,
  accountChoices,
  modelChoices,
  effortChoices,
  fetchLiveModels,
} from "./model-picker";
import { configModeToPermissionMode } from "../../permissions";
import { runTeamCommand } from "../../team/command";
import { BottomRegion } from "./screen";
import { Viewport, composeFrame, zones, VIEWPORT_RESTORE, type Zones } from "./viewport";
import { parseKeys, type Key } from "./keys";
import { fmtTokens } from "./events";
import { PasteScanner, shouldCollapse, pasteChip, expandPastes, livePasteIds } from "./paste";
import {
  renderComposer,
  renderPicker,
  renderSlashPalette,
  renderKeysPanel,
  renderKeyEditor,
  renderKeyManagerPanel,
  renderSessionsPanel,
  renderMemoryPanel,
  renderWorkReview,
  workReviewPageSize,
  MEMORY_ACTION_COUNT,
  renderPermissionCard,
  renderQueueStrip,
  sessionGroupLabel,
  statusLine,
  modeInfo,
  permissionModeBanner,
  autoApprovedChip,
  autoDeferralSummary,
  waitingRung,
  sandboxModeBanner,
  browserModeBanner,
  type RenderedBlock,
  type PickerItem,
  type SlashItem,
  type KeyRow,
  type SessionRowView,
} from "./composer";
import { GEAR_MARK, renderBanner } from "./banner";
import { renderStatus } from "./status";
import { notifyWarp } from "./warp";
import { setTitle, clearTitle } from "./title";
import { renderReadBack, renderClose } from "./read-back";
import * as F from "./flow";
import {
  questionAction,
  questionLines,
  questionPlaceholder,
  QUESTION_SKIPPED,
  QUESTION_UNANSWERED,
} from "./question";
import {
  heldAction,
  heldCloseReceipt,
  heldLines,
  heldOutcomeRow,
  nextUndecided,
  type HeldOutcome,
} from "./held";
import type { AutoModeDeferral } from "../../auto-mode";
import type { Brief } from "../../brief";
import { TurnRenderer, userBlock, renderReplay, HEX } from "./turn";
import { truncate, clampVisible, setTermWidthOverride } from "./render";
import { renderResearchPlan, renderClarifyingQuestions, formatResearchEvent } from "./research";
import { isClarification } from "../../research-types";
import type { ResearchOptions, ResearchPlan, ResearchReport } from "../../research-types";
import {
  formatLoopDue,
  formatLoopInterval,
  loopPromptPreview,
  type LoopCompletion,
  type LoopTask,
} from "../../loop-mode";
import {
  bold,
  text,
  muted,
  faint,
  info,
  brand,
  ok,
  accent,
  danger,
  warn,
  setTheme,
  getTheme,
  listThemes,
  paintBrandWith,
  withThemeBg,
  themeBgSeq,
  terminalThemeSeq,
  stripAnsi,
  TERMINAL_THEME_RESET,
} from "./theme";
import { formatCostReport } from "../../cost-report";
import { glyph } from "./glyphs";
import { saveTheme } from "./theme-store";
import { buildPermissionPreview, type PermissionPreview } from "./permission-preview";
import { FoldLedger, type FoldRegion } from "./folds";
import { renderWorkspaceDiff } from "./workspace-diff";
import { workspaceConfigPath } from "@gear/shared";
import {
  buildInteractiveDirective,
  saveInteractiveAuto,
  shouldOfferInteractive,
} from "./interactive";

export interface TuiContext {
  engine: Engine;
  sessionId: string;
  workspaceRoot: string;
  version: string;
  yoloMode: boolean;
  trustWorkspace: boolean;
  customCommands: SlashCommand[];
  /** Show the "resume a session" picker on launch (default flow with prior history). */
  launchPick?: boolean;
  /**
   * Opt out of the fixed-chrome viewport and use the legacy layout that commits
   * the transcript to the terminal's own scrollback (--inline / GEAR_INLINE).
   * Undefined means the default: pinned header, scrolling body, pinned footer.
   */
  inline?: boolean;
  /**
   * Auto-resume after a quota stop (default true; `[fallback] autoResume =
   * false` opts out). The stop message carries the retry window; the session
   * waits it out visibly and continues from the handoff instead of sitting
   * stuck until someone notices — the observed failure was a run dead for
   * hours because a 429 stop scrolled by.
   */
  quotaAutoResume?: boolean;
  /**
   * Interactive end-of-turn held steps (default true; `[permissions.autoMode]
   * heldStepPrompt = false` opts out). Each outward step Auto declined can be
   * approved — "run exactly this" — or left unrun, per step; off, the list
   * prints as plain text the way it always did.
   */
  heldStepPrompt?: boolean;
}

type Mode =
  | "input"
  | "turn"
  | "picker"
  | "permission"
  | "keys"
  | "ask"
  | "question"
  | "held"
  | "sessions"
  | "memory"
  | "review";

export interface PermissionKeyAction {
  selected: number;
  decision?: UserPermissionDecision;
  handled: boolean;
}

/**
 * Pure reducer so the highlighted approval row and the resolved action cannot
 * drift apart. `choiceCount` is 2 on circuit-breaker cards, which offer no
 * session grant: [allow once, deny] instead of [allow once, session, deny].
 */
export function permissionKeyAction(
  key: Key,
  selected: number,
  choiceCount: 2 | 3 = 3,
): PermissionKeyAction {
  const kinds: Array<UserPermissionDecision["kind"]> =
    choiceCount === 3 ? ["allow_once", "allow_session", "deny"] : ["allow_once", "deny"];
  const current = Math.max(0, Math.min(choiceCount - 1, selected));
  if (key.type === "up" || key.type === "left") {
    return { selected: (current + choiceCount - 1) % choiceCount, handled: true };
  }
  if (key.type === "down" || key.type === "right" || key.type === "tab") {
    return { selected: (current + 1) % choiceCount, handled: true };
  }

  let decision: UserPermissionDecision | undefined;
  if (key.type === "char" && /^[123]$/.test(key.value)) {
    const choice = Number(key.value) - 1;
    if (choice < choiceCount) decision = { kind: kinds[choice]! };
    // A digit past the card's last row is swallowed, not bubbled to the composer.
    else return { selected: current, handled: true };
  } else if (key.type === "char" && (key.value === "n" || key.value === "N")) {
    decision = { kind: "deny" };
  } else if (
    key.type === "shift-tab" ||
    // `a` = "allow for session" per the v2 card's printed shortcut; `s`
    // (session) remains for muscle memory from earlier releases.
    (key.type === "char" && /^[sSaA]$/.test(key.value))
  ) {
    // No session choice on a 2-row card -- swallow the shortcut so shift-tab
    // cannot fall through to the gear cycle while a decision is pending.
    if (choiceCount === 2) return { selected: current, handled: true };
    decision = { kind: "allow_session" };
  } else if (key.type === "char" && (key.value === "y" || key.value === "Y")) {
    decision = { kind: "allow_once" };
  } else if (key.type === "enter") {
    decision = { kind: kinds[current]! };
  } else if (key.type === "esc") {
    decision = { kind: "deny" };
  }
  return { selected: current, decision, handled: decision != null };
}

type SessionListItem = ReturnType<Engine["listSessions"]>[number];

/** Empty launch placeholders are implementation detail, not conversation history. */
function isMeaningfulSession(session: SessionListItem): boolean {
  return session.eventCount > 0 || Boolean(session.title?.trim());
}

// `columns`/`rows` are 0 (not undefined) on a PTY with no winsize -- `||` so a
// zero-size terminal falls back sanely instead of clamping every line to nothing.
const cols = () => process.stdout.columns || 80;
const rowsCount = () => process.stdout.rows || 24;

/**
 * How many blank rows the pinned block holds open beneath the transcript so the
 * field sits on the bottom of the window instead of floating under the header.
 *
 * Pure, and exported, because the interesting case is not the arithmetic — it
 * is what `printedRows` means after the screen has been wiped. It counts rows
 * committed to scrollback and only ever counts UP, which is right while a
 * session accumulates: once a window's worth of output exists there is nothing
 * left to hold open. But /clear erases that output, and if the count survives
 * the erase the padding stays at zero against a screen that is now empty, and
 * the whole bar collapses upward. Every path that clears the screen has to
 * reset the count with it — see resetTranscript.
 */
export function holdOpenRows(viewport: number, printedRows: number, blockRows: number): number {
  // One row spare: a pinned block that reaches the last cell wraps, and a wrap
  // desyncs the relative cursor math for every frame after it.
  return Math.max(0, viewport - printedRows - blockRows - 1);
}
const MAX_TRANSCRIPT = 5000; // cap the in-memory scrollback
const SCROLL_STEP = 3; // lines per mouse-wheel notch
/** Ceiling on the live block above the composer: the rung, its detail row, and
 *  up to a fleet's worth of sub-agent rows plus their `+N more`. Past this the
 *  status stops being a status. */
const LIVE_BLOCK_ROWS = 9;

export async function runTui(ctx: TuiContext): Promise<void> {
  await new Tui(ctx).run();
}

class Tui {
  private region = new BottomRegion(); // --inline compatibility surface only
  /** The fixed-chrome surface: pinned header, scrolling body, pinned footer. */
  private viewport = new Viewport();
  /** False for the default fixed-chrome layout; true only through --inline / GEAR_INLINE. */
  private readonly inline: boolean;
  private transcript: string[] = []; // fixed layout: themed lines, self-managed scrollback window
  /** Blocks that hold more than they show, openable in place -- see ./folds. */
  private folds = new FoldLedger();
  /** Where the body zone sat on the last painted frame, for click -> row math. */
  private lastBodyMap: {
    bodyTop: number;
    bodyRows: number;
    hiddenAbove: number;
    marked: boolean;
  } | null = null;
  /**
   * Rows committed into the terminal's own scrollback so far.
   *
   * Only ever used to decide how much empty space the pinned block should hold
   * open beneath the transcript — see pinnedBlock(). It counts up and never
   * down, which is exactly right: once the session has produced a viewport's
   * worth of output there is nothing left to hold open, and the padding is
   * gone for good.
   */
  private printedRows = 0;
  private scroll = 0; // fixed layout: lines scrolled up from the bottom (0 = following latest)
  private onResize = () => {
    if (this.inline) {
      // Native scrollback reflows itself; just redraw the pinned composer at the
      // new width. There is no frame to invalidate — history above the composer
      // was written once and is the terminal's to reflow, not ours to repaint.
      this.renderRegion();
      return;
    }
    // The fixed layout owns every cell, and a resize invalidates all of them:
    // the row a line was on is not the row it belongs on at the new size, and
    // the diff would happily leave the old ones there. Re-measure the width the
    // flow grammar bounds itself to, forget the screen, repaint it whole.
    setTermWidthOverride(this.contentCols());
    this.viewport.invalidate();
    this.scheduleDraw();
  };
  private input = "";
  private caret = 0;
  private history: string[] = [];
  private histIdx = -1;
  private draft = "";
  private mode: Mode = "input";
  private slashSel = 0; // highlighted row in the `/` command palette
  private sigintArmed = false;
  private paste = new PasteScanner(); // carves bracketed pastes out of the stdin stream (see ./paste)
  // Large/multi-line pastes are collapsed to a `[Pasted text #N +K lines]` chip in the composer
  // (Claude-Code idiom): the real content is held here and expanded back in on submit. Pasting the
  // raw body inline would put newlines into the single-line composer, which breaks the pinned
  // region's row math (garble) and re-renders megabytes every keystroke (freeze).
  private pastes = new Map<number, string>();
  private pasteSeq = 0;

  // `/sessions` manager overlay
  private sessionsList: SessionListItem[] = [];
  private sessionsSel = 0;
  private sessionsView: "active" | "archived" = "active";
  private sessionsPendingDelete: string | null = null; // id armed for two-step delete
  private sessionsQuery = "";
  private sessionsSearching = false;

  // `/memory` System Memory panel
  private memorySel = 0;
  private memoryBusy = false;
  private memoryNote: string | null = null;
  private memoryPendingClear = false;

  // `/keys` BYOK panel
  private keysSel = 0;
  private keysRows: KeyRow[] = [];
  // Per-provider key manager: which provider's pool is open + the selected entry.
  // null = the provider list is showing. Rows are read live from keysRows so the
  // manager reflects adds/removes without a stale copy.
  private keysManage: { id: string; label: string; sel: number } | null = null;
  private keysEdit: {
    id: string;
    label: string;
    field: "key" | "baseUrl" | "model" | "label";
    value: string;
    caret: number;
    masked: boolean;
    // "add" appends a new key to the provider's pool; "replace"/undefined is the
    // single-key / endpoint edit.
    mode?: "add";
    pending: { baseUrl?: string; model?: string; newKey?: string };
    title: string;
    subtitle?: string;
  } | null = null;

  // turn state
  private turnStart = 0;
  private tick: ReturnType<typeof setInterval> | null = null;
  private streamBuf = "";
  private queued: string[] = []; // type-ahead: messages composed mid-turn, run in order on completion
  private aborting = false; // an esc/ctrl-c interrupt is in flight (guards the "interrupting..." flood)
  // Warp's badge is showing this pane as blocked on us. Set when we raise an
  // approval or a question, cleared by the first tool call that finishes after
  // -- which is the event that means the answer landed and work resumed. Kept
  // as a flag so a fifty-call turn writes one sequence, not fifty.
  private warpBlocked = false;
  // Advanced by the turn tick, but only while output is actually arriving --
  // see ./title.ts. Not a clock.
  private titleFrame = 0;

  /** The tab's own name for this project. */
  private titleProject(): string {
    return this.ctx.workspaceRoot.split("/").filter(Boolean).pop() ?? "";
  }

  /** Paint the tab for an in-flight turn. Warp will not badge a pane it has not
   *  classified as an agent, but it renames one on OSC 0 like any terminal. */
  private paintTitle(turn: { beat(): { quietMs: number } }): void {
    const { quietMs } = turn.beat();
    if (quietMs < 4000) this.titleFrame++;
    setTitle({ kind: "working", frame: this.titleFrame, quietMs }, this.titleProject());
  }
  private turnPreview: string[] | null = null; // one live intent row + one evidence row
  private filesEdited = new Set<string>(); // session-wide, shown on the footer readout
  private interactiveTipShown = false; // the /interactive offer fires at most once per session
  private lastWorkLog: string | null = null; // the last turn's full work log (ctrl+r expands it)
  private liveTurn: TurnRenderer | null = null; // in-flight renderer (ctrl+r mid-turn)
  private loopPoll: ReturnType<typeof setInterval> | null = null;
  private activeLoopId: string | null = null;

  // Temporary work-details view. It replaces the pinned region and disappears
  // on Esc/Ctrl+R, so inspecting work never duplicates it into scrollback.
  private reviewLog: string | null = null;
  private reviewTop = 0;
  private reviewReturnMode: "input" | "turn" = "input";

  // render coalescing -- collapse bursts of draw requests into one paint per frame (~60fps), so a
  // streamed token, a held arrow key, or a flick of the mouse wheel never trigger N full repaints.
  private drawScheduled = false;
  private drawTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPaint = 0;

  // hardware-scroll tracking: the visible window's bottom index (`end`) + band geometry at the last
  // and only the newly exposed lines need painting. -1 = no previous frame yet.
  private prevEnd = -1;
  private prevBandTop = -1;
  private prevTransH = -1;

  // transient resolvers
  private picker: {
    items: PickerItem[];
    sel: number;
    title: string;
    resolve: (i: number | null, alt?: boolean) => void;
    onPreview?: (i: number) => void;
    footnote?: string;
    /** Optional second action key (e.g. `d` = "select as default") -- resolves with alt=true. */
    altKey?: string;
  } | null = null;
  private perm: {
    resolve: (d: UserPermissionDecision) => void;
    toolName: string;
    argsSummary: string;
    preview: PermissionPreview;
    sel: number;
  } | null = null;
  // transient single-line text prompt (used by /research clarify & revise)
  private askState: { resolve: (s: string | null) => void; title: string } | null = null;
  /** Grace window before a 4th-gear ask_user picker auto-continues. */
  private static readonly QUESTION_AUTO_CONTINUE_MS = 60_000;
  // ask_user tool: blocking question with numbered options (turn-time).
  private questionState: {
    resolve: (s: string) => void;
    question: string;
    options: string[];
    prevMode: Mode;
    /** The highlighted choice. Enter commits THIS -- never a hardcoded first
     *  option, which is what made Enter a blind commit to a product decision
     *  the reader had not necessarily read. */
    selected: number;
    /** Position in a multi-question round, so the picker can say `2 of 4`. */
    index?: number;
    total?: number;
    /** 4th-gear auto-continue: the run must survive an absent user. */
    timer?: ReturnType<typeof setTimeout>;
    autoContinue?: boolean;
    /** Wall clock the auto-continue fires at, so the hint can tick it down
     *  instead of stating a 60 that was true only when the question opened. */
    deadline?: number;
  } | null = null;
  /** End-of-turn held steps: the interactive half of Auto's deferral ledger. */
  private heldState: {
    steps: AutoModeDeferral[];
    outcomes: Array<HeldOutcome | null>;
    sel: number;
    running: boolean;
    /** Cancels the step executing right now (esc while running). */
    abort?: AbortController;
  } | null = null;
  /** Deferrals delivered by the engine mid-teardown, held until the turn's
   *  finally decides whether the panel may open (an aborted or queued-over
   *  turn gets the plain printed list instead). */
  private pendingHeld: AutoModeDeferral[] | null = null;

  constructor(private ctx: TuiContext) {
    // Default: the fixed-chrome viewport. --inline keeps the legacy layout,
    // where the transcript is committed to the terminal's own scrollback and
    // only the composer is pinned.
    this.inline = Boolean(ctx.inline);
    setTermWidthOverride(this.inline ? null : this.contentCols());
  }

  /**
   * The column the surface is allowed to draw into. The flow grammar bounds
   * itself to a 78-cell measure, so this only has to stop a line from touching
   * the right edge of a narrow window.
   */
  private contentCols(): number {
    const width = cols();
    if (this.inline) return width;
    return Math.max(8, width - 1);
  }

  // -- lifecycle --

  async run(): Promise<void> {
    const { engine } = this.ctx;

    // The banner is a live header (re-themed every frame), so nothing to seed here.
    // The handler is registered in every mode: the broker short-circuits to "allowed"
    // in 4th gear, so it is never invoked there -- and stays ready the instant
    // Shift+Tab shifts back to an asking gear, without re-wiring.
    engine.setPermissionHandler(this.permissionHandler);
    // Auto mode never pauses the run, so the transcript is where its decisions
    // live -- but only the ones that changed something. Routine approvals
    // return "" and are not printed: they are the harness allowing what it
    // always allows, and a row each buried the work they were meant to make
    // auditable. Containments, redirects and halts still get a chip, and the
    // outward steps Auto declined get one list at the end of the turn.
    engine.setAutoApprovalNotifier?.((notice) => {
      const chip = autoApprovedChip(notice);
      if (chip) this.print(chip);
    });
    engine.setAutoDeferralNotifier?.((deferrals) => {
      if (this.ctx.heldStepPrompt === false) {
        const block = autoDeferralSummary(deferrals);
        if (block) this.print(block);
        return;
      }
      // The engine fires this from the run's teardown, while runTurn is still
      // consuming events. Hold the list; the finally block opens the panel
      // only when the person is actually free to answer it.
      this.pendingHeld = [...deferrals];
    });
    engine.setQuestionHandler(this.questionHandler);
    engine.setBriefHandler(this.briefHandler);

    // Poll cheaply; claimDueLoopTask() returns null while nothing is due and
    // runDueLoopTask() itself refuses to start unless the composer is idle.
    this.loopPoll = setInterval(() => void this.runDueLoopTask(), 1_000);

    const stdin = process.stdin;
    stdin.setEncoding("utf8");
    if (stdin.isTTY) stdin.setRawMode(true);
    process.stdout.write("\x1b[?2004h"); // bracketed paste on
    process.env.GEAR_TUI_ACTIVE = "1"; // loggers: file sink only, never stderr over the alt screen
    // Safety net: if we ever exit without running this.exit() (a crash), still leave the terminal
    // usable -- leave the alternate screen, drop mouse/paste reporting, restore autowrap and the
    // user's colours, and show the cursor. A process that dies holding the alternate screen with
    // the mouse captured leaves the shell unusable, which is the one failure this must not have.
    process.once("exit", () => {
      try {
        process.stdout.write("\x1b[?2004l\x1b[0 q" + VIEWPORT_RESTORE + TERMINAL_THEME_RESET);
        clearTitle();
      } catch {
        /* terminal already gone */
      }
    });
    stdin.resume();

    this.enterSurface();
    process.stdout.on("resize", this.onResize);
    // Replay prior conversation when launched straight into a session (--resume /
    // `gear resume <id>`). When launchPick is set, the picker runs once input is
    // live (below) instead -- a fresh session has nothing to seed.
    if (!this.ctx.launchPick) this.seedFromHistory();
    // First frame synchronous so the banner and composer appear instantly.
    this.renderRegion();

    // System Memory: a one-time discoverability hint + a background "dream" when the
    // chosen cadence is due. Skipped while the launch picker owns the screen. The
    // dream no-ops fast unless an interval cadence is set and elapsed.
    if (!this.ctx.launchPick) {
      const mem = engine.getSystemMemory();
      if (mem.enabled && !mem.content.trim() && mem.scheduleLabel === "manual") {
        this.print(`  ${faint("tip: Gear can learn your style over time --")} ${info("/memory")}`);
      }
      void engine
        .maybeReflectSystemMemory()
        .then((r) => {
          if (r.updated) {
            this.print(
              `  ${ok(glyph("verified"))} ${muted(`system memory refreshed (~${r.tokensAfter ?? 0} tokens) | /memory to view`)}`,
            );
          }
        })
        .catch(() => {});
    }

    return new Promise<void>((resolve) => {
      const onData = (chunk: string) => this.onData(chunk);
      stdin.on("data", onData);
      // The launch picker needs the input loop wired, so kick it off here.
      if (this.ctx.launchPick) void this.runLaunchPicker();
      this.exit = (code = 0) => {
        stdin.off("data", onData);
        process.stdout.off("resize", this.onResize);
        if (this.loopPoll) {
          clearInterval(this.loopPoll);
          this.loopPoll = null;
        }
        process.stdout.write("\x1b[?2004l"); // bracketed paste off
        delete process.env.GEAR_TUI_ACTIVE; // terminal is the shell's again — loggers may use stderr
        if (this.drawTimer) clearTimeout(this.drawTimer); // cancel any pending coalesced paint
        this.leaveSurface();
        process.stdout.write(TERMINAL_THEME_RESET); // restore the user's terminal colours
        clearTitle(); // and its name -- see ./title.ts
        if (stdin.isTTY) stdin.setRawMode(false);
        setTermWidthOverride(null);
        process.stdout.write(`  ${muted("Goodbye.")}\n`);
        this.discardSessionIfEmpty(this.ctx.sessionId);
        engine.close();
        resolve();
        process.exit(code);
      };
      // SIGTERM (kill, service managers) and SIGHUP (terminal window closed)
      // must run the same teardown as /exit: leave the alternate screen, drop
      // raw mode + mouse reporting, close the engine. A default signal death
      // skips the process "exit" hooks -- which is exactly how a killed TUI
      // used to strand the shell in the alt screen with the mouse captured.
      // 143/129 = 128 + signal number.
      const onSignal = (code: number) => () => {
        try {
          this.exit(code);
        } catch {
          try {
            this.ctx.engine.close();
          } catch {
            // Closing is best-effort mid-signal; the exit hook still restores modes.
          }
          process.exit(code);
        }
      };
      process.once("SIGTERM", onSignal(143));
      process.once("SIGHUP", onSignal(129));
      // Suspension is not death, so it does not run the teardown — but the
      // writing surface hides the hardware cursor to draw its own caret, and a
      // job stopped in that state hands the shell back with no cursor at all.
      // Raw mode means ^Z arrives as a keystroke rather than a signal, so this
      // only fires for an external `kill -TSTP`; it costs nothing and closes
      // the one way this change could leave a terminal worse than it found it.
      process.on("SIGTSTP", () => {
        try {
          process.stdout.write("\x1b[?25h");
        } catch {
          // Nothing to do if the terminal is already gone.
        }
        process.kill(process.pid, "SIGSTOP");
      });
      process.on("SIGCONT", () => {
        // Whatever the shell drew while we were stopped is gone from our idea
        // of the screen, so remount rather than redraw in place.
        if (this.inline) this.region.clear();
        else this.viewport.invalidate();
        this.scheduleDraw();
      });
    });
  }

  private exit: (code?: number) => void = () => {};

  // -- input rendering --

  private statusStr(): string {
    let contextPercent: number | undefined;
    try {
      contextPercent = this.ctx.engine.getContextUsage().percent;
    } catch {
      contextPercent = undefined;
    }
    const loop = this.ctx.engine.getLoopStatus(this.ctx.sessionId);
    return statusLine(
      {
        model: this.ctx.engine.getModel(),
        effort: this.ctx.engine.getReasoningEffortLabel(),
        workspace: this.ctx.workspaceRoot,
        mode: this.ctx.engine.getPermissionMode(),
        contextPercent,
        filesEdited: this.filesEdited.size || undefined,
        sandboxOff: !this.ctx.engine.isSandboxEnabled(),
        folds: !this.inline && this.folds.size > 0,
        theme: getTheme().name === "auto" ? "auto" : getTheme().appearance,
        loop:
          loop.count > 0 && loop.nextRunAt !== null
            ? `${loop.count === 1 ? "loop" : `${loop.count} loops`} | ${formatLoopDue(loop.nextRunAt)}`
            : undefined,
      },
      this.contentCols(),
    );
  }

  /** Shift up one gear (Shift+Tab / `/gear` / `/mode`) -- or straight to `target` -- and announce it. */
  private cyclePermissionMode(mode?: ReturnType<Engine["getPermissionMode"]>): void {
    let next: ReturnType<Engine["getPermissionMode"]>;
    if (mode) {
      const result = this.ctx.engine.setPermissionMode(mode);
      if (!result.ok && result.reason) this.print(`  ${warn(result.reason)}`);
      next = this.ctx.engine.getPermissionMode();
    } else {
      next = this.ctx.engine.cyclePermissionMode();
    }
    // Keep the ctx mirror current for any other reader of these flags.
    this.ctx.yoloMode = next === "gear-4";
    this.ctx.trustWorkspace = next === "gear-3";
    this.print(permissionModeBanner(next));
    void this.rememberGear(next);
  }

  /**
   * Write the chosen gear down, so the next session opens in it.
   *
   * Every gear except the fourth persists without ceremony, because every other
   * gear still asks before it acts — remembering them changes how much typing a
   * session costs, not what it is permitted to do. The fourth bypasses every
   * interactive prompt, so making it sticky silently would mean a machine that
   * quietly stopped asking, forever, on the strength of one afternoon. It is
   * asked about once and the answer is what is kept: yes, and it persists like
   * any other; no, and it stays session-only and is never raised again.
   */
  private async rememberGear(gear: ReturnType<Engine["getPermissionMode"]>): Promise<void> {
    try {
      const prefs = loadPrefs();
      if (shouldAskAboutFourthGear(gear, prefs)) {
        const answer = await this.questionHandler({
          question: "Open new sessions in 4th gear from now on?",
          options: ["no - this session only", "yes - remember 4th gear"],
        });
        // Only an explicit answer is an answer. 4th gear's picker auto-continues
        // after a minute so an autonomous run never parks on an unanswered
        // question — and reading that timeout as "not yes" wrote a permanent
        // decline for a choice nobody made, which, because a decline is never
        // re-asked, locked the user out of it. A timeout leaves the question
        // open; it will be asked again next time.
        const said = answer.trim().toLowerCase();
        const sticky = said.startsWith("yes");
        const declined = said.startsWith("no");
        if (!sticky && !declined) {
          this.print(
            `  ${ok(glyph("verified"))} ${muted("4th gear for this session")} ${faint("| not remembered -- /mode default to make it stick")}`,
          );
          return;
        }
        savePrefs({ stickyFourthGear: sticky, ...(sticky ? { gear } : {}) });
        this.print(
          sticky
            ? `  ${accent(glyph("phase"))} ${muted("remembered --")} ${info("4th gear")} ${faint("at startup (change it any time with shift+tab)")}`
            : `  ${ok(glyph("verified"))} ${muted("4th gear for this session only")} ${faint("| /mode default if you change your mind")}`,
        );
        return;
      }
      if (mayPersistGear(gear, prefs)) savePrefs({ gear });
    } catch {
      // A preference that cannot be written must never interrupt the session.
    }
  }

  // -- slash palette (live `/` menu) --

  private slashCatalog(): SlashItem[] {
    // Ordered by what a person actually reaches for, not alphabetically and
    // not by when it was written. /theme led this list for a long time -- a
    // cosmetic toggle, above the two things (which model, how do I connect)
    // that decide whether the product works at all.
    //
    // What was REMOVED from the surface, and why:
    //   /providers /keys   folded into /login, which asks what you have instead
    //                      of what the system calls it.
    //   /research
    //   /deepresearch      research is already a TOOL the agent reaches for on
    //                      its own (see the doctrine's Research line). Two
    //                      commands that only set a mode taught users to drive
    //                      manually something the agent should decide.
    //   /rename            belongs to a session, so it lives in /sessions where
    //                      you can see which one you are renaming.
    //   /resume            /sessions already opens the picker.
    //   /autonomy          legacy alias for /gear.
    //   /mode              same thing as /gear, twice.
    // All of them still WORK when typed -- they are hidden, not deleted, so no
    // muscle memory or script breaks.
    const builtins: SlashItem[] = [
      { name: "/model", desc: "Choose model, provider, and thinking depth", tag: "settings" },
      { name: "/login", desc: "Connect a subscription, an API key, or a local model" },
      { name: "/sessions", desc: "Browse, resume, rename, archive & delete", tag: "history" },
      {
        name: "/gear",
        desc: "Shift gears -- 1 | 2 | 3 | 4 | auto (empty shifts up)",
        tag: "shift+tab",
      },
      { name: "/diff", desc: "Inspect staged and uncommitted workspace changes", tag: "git" },
      { name: "/undo", desc: "Revert the last Gear auto-commit" },
      { name: "/rewind", desc: "Roll back the conversation" },
      { name: "/cost", desc: "Session cost" },
      { name: "/status", desc: "Session status" },
      { name: "/loop", desc: "Repeat a prompt while this session stays open" },
      { name: "/loops", desc: "List and manage this session's loops" },
      { name: "/team", desc: "Other Gear instances here -- status | send | claim | intent" },
      { name: "/mcp", desc: "Connected MCP servers and tools" },
      { name: "/skills", desc: "Browse or search available skills" },
      { name: "/memory", desc: "System memory -- your evergreen profile" },
      { name: "/notebook", desc: "Learned tactics for this workspace" },
      { name: "/interactive", desc: "Live dashboard -- [focus] | auto on|off | open" },
      { name: "/sandbox", desc: "OS sandbox for commands -- on | off (off = full access)" },
      { name: "/browser", desc: "Agent web browser -- on | off" },
      { name: "/compress", desc: "Summarize & shrink context" },
      { name: "/theme", desc: "Switch accent colors and light / dark mode", tag: "cosmetic" },
      { name: "/bug", desc: "Flag a problem -- records the flight trail" },
      { name: "/clear", desc: "Clear the screen" },
      { name: "/help", desc: "Show commands" },
      { name: "/quit", desc: "Exit Gear" },
    ];
    const custom: SlashItem[] = this.ctx.customCommands.map((c) => ({
      name: "/" + c.name,
      desc: c.description || "Custom command",
    }));
    return [...builtins, ...custom];
  }

  /** Commands matching the `/`-prefixed token being typed; empty hides the palette. */
  private slashMatches(): SlashItem[] {
    if (this.mode !== "input") return [];
    const v = this.input;
    if (!v.startsWith("/") || /\s/.test(v)) return []; // not a command, or name already complete
    const t = v.slice(1).toLowerCase();
    const all = this.slashCatalog();
    const pref = all.filter((c) => c.name.slice(1).toLowerCase().startsWith(t));
    return pref.length ? pref : all.filter((c) => c.name.slice(1).toLowerCase().includes(t));
  }

  private composerBlock(): RenderedBlock {
    if (this.mode === "picker" && this.picker) {
      return renderPicker(
        this.picker.title,
        this.picker.items,
        this.picker.sel,
        this.contentCols(),
        Math.max(3, rowsCount() - 1),
        { footnote: this.picker.footnote },
      );
    }
    if (this.mode === "permission" && this.perm) {
      const card = renderPermissionCard(
        this.perm.toolName,
        this.perm.argsSummary,
        this.contentCols(),
        {
          preview: this.perm.preview,
          selected: this.perm.sel,
          maxPreviewLines: Math.max(2, Math.min(7, rowsCount() - 15)),
        },
      );
      // v2 status ladder: the run is paused on a human decision -- say so in
      // the ochre "Waiting on approval..." rung above the card, with the live
      // elapsed receipt and the gear the decision is needed in.
      const waitSecs = Math.max(0, Math.floor((Date.now() - this.turnStart) / 1000));
      const head = waitingRung(waitSecs, this.perm.toolName, this.ctx.engine.getPermissionMode());
      return {
        lines: [head, ...card.lines],
        caretRow: card.caretRow + 1,
        caretCol: card.caretCol,
      };
    }
    if (this.mode === "held" && this.heldState) {
      const st = this.heldState;
      const lines = heldLines({
        steps: st.steps,
        outcomes: st.outcomes,
        selected: st.sel,
        running: st.running,
        width: this.contentCols(),
      });
      // The caret parks on the hint row: there is no field here, and the
      // marker already says where the selection is.
      return { lines, caretRow: lines.length - 1, caretCol: F.BODY.length };
    }
    if (this.mode === "ask" && this.askState) {
      const base = renderComposer({
        input: this.input,
        caret: this.caret,
        width: this.contentCols(),
        status: this.statusStr(),
      });
      const title = `  ${info("?")} ${text(this.askState.title)} ${faint("(Enter = ok | Esc = skip)")}`;
      return {
        lines: [title, ...base.lines],
        caretRow: base.caretRow + 1,
        caretCol: base.caretCol,
      };
    }
    if (this.mode === "question" && this.questionState) {
      const q = this.questionState;
      const base = renderComposer({
        input: this.input,
        caret: this.caret,
        width: this.contentCols(),
        status: this.statusStr(),
        placeholder: questionPlaceholder(q.options.length),
      });
      const head = questionLines({ ...q, input: this.input, width: this.contentCols() });
      return {
        lines: [...head, ...base.lines],
        // The caret stays in the field, not on the highlighted row: typing an
        // answer is a first-class path here, and the marker already says where
        // the selection is. A caret parked on a list you may not be using is
        // the thing that made this surface feel like it was guessing.
        caretRow: base.caretRow + head.length,
        caretCol: base.caretCol,
      };
    }
    if (this.mode === "keys") {
      if (this.keysEdit) {
        const e = this.keysEdit;
        return renderKeyEditor({
          title: e.title,
          subtitle: e.subtitle,
          value: e.value,
          caret: e.caret,
          width: this.contentCols(),
          masked: e.masked,
        });
      }
      if (this.keysManage) {
        const row = this.keysRows.find((r) => r.id === this.keysManage!.id);
        return renderKeyManagerPanel(
          this.keysManage.label,
          row?.savedKeys ?? [],
          this.keysManage.sel,
          this.contentCols(),
        );
      }
      return renderKeysPanel(this.keysRows, this.keysSel, this.contentCols());
    }
    if (this.mode === "sessions") {
      return renderSessionsPanel(
        this.sessionsList.map((s) => this.sessionRowView(s)),
        this.sessionsSel,
        {
          view: this.sessionsView,
          pendingDelete: this.sessionsPendingDelete != null,
          query: this.sessionsQuery,
          searching: this.sessionsSearching,
        },
        this.contentCols(),
        Math.max(4, rowsCount() - 1),
      );
    }
    if (this.mode === "memory") {
      const m = this.ctx.engine.getSystemMemory();
      return renderMemoryPanel(
        {
          content: m.content,
          scheduleLabel: m.scheduleLabel,
          tokens: m.tokens,
          maxTokens: m.maxTokens,
          lastDreamed: m.meta.lastReflectedAt ? this.relTime(m.meta.lastReflectedAt) : "never",
          busy: this.memoryBusy,
          note: this.memoryNote ?? undefined,
          pendingClear: this.memoryPendingClear,
        },
        this.memorySel,
        this.contentCols(),
      );
    }
    if (this.mode === "review") {
      const log = this.liveTurn?.fullLog() ?? this.reviewLog ?? `  ${faint("No work details yet")}`;
      return renderWorkReview(
        log,
        this.reviewTop,
        this.contentCols(),
        Math.max(4, rowsCount() - 1),
      );
    }
    if (this.mode === "turn") {
      // The composer stays live while a turn streams so the next message can be typed ahead.
      // The working indicator (and any queued messages) float above the still-editable box.
      const base = renderComposer({
        input: this.input,
        caret: this.caret,
        width: this.contentCols(),
        status: this.statusStr(),
      });
      // The buffered prose run streams live here (it commits to the transcript only
      // once the turn decides which partition -- work rail or response -- it belongs to).
      const head = this.turnStateLines();
      head.push(...renderQueueStrip(this.queued, this.contentCols()));
      return {
        lines: [...head, ...base.lines],
        caretRow: base.caretRow + head.length,
        caretCol: base.caretCol,
      };
    }
    const base = renderComposer({
      input: this.input,
      caret: this.caret,
      width: this.contentCols(),
      status: this.statusStr(),
    });
    const matches = this.slashMatches();
    if (matches.length === 0) return base;
    // Float the palette above the input box; the caret stays in the box.
    const palette = renderSlashPalette(
      matches,
      this.slashSel,
      this.contentCols(),
      Math.max(1, rowsCount() - base.lines.length - 2),
      this.slashCatalog().length,
    );
    return {
      lines: [...palette, ...base.lines],
      caretRow: base.caretRow + palette.length,
      caretCol: base.caretCol,
    };
  }

  /** Append a block to the transcript, theming each line in the *current* theme and bounding
   *  the buffer. (Lines keep their theme; switching themes recolours the live composer + new
   *  output, and history stays readable in the theme it was written in.) */
  /** Hard-bound a line to the terminal width. An over-wide line auto-wraps,
   *  which breaks the pinned region's row math -- and then every repaint leaks
   *  stale rows into the scrollback (the "duplicated spam" failure mode). */
  private bound(ln: string): string {
    return clampVisible(ln, Math.max(8, this.contentCols() - 1));
  }

  private pushLines(block: string): number {
    const lines = block.split("\n");
    // Store semantic ANSI only. Card/canvas backgrounds are applied per frame,
    // so a light/dark or accent change recolours the whole existing timeline.
    for (const ln of lines) this.transcript.push(this.bound(ln));
    const overflow = this.transcript.length - MAX_TRANSCRIPT;
    if (overflow > 0) {
      this.transcript.splice(0, overflow);
      this.folds.noteTrim(overflow);
    }
    return lines.length;
  }

  private print(block: string, detail?: string): void {
    if (this.inline) {
      // Inline: completed blocks flow into the terminal's native scrollback above the pinned
      // composer (the terminal owns scrolling from here). printAbove redraws the composer after.
      // A fold's detail has no home here -- the terminal owns those rows now --
      // so it is dropped; ctrl+r's work log still carries the full record.
      const lines = block.split("\n").map((l) => withThemeBg(this.bound(l)));
      this.printedRows += lines.length;
      const comp = this.pinnedBlock();
      // The composer paints its own caret, so the hardware cursor stays
      // hidden — two carets on one row is worse than either alone.
      this.region.printAbove(
        lines.join("\r\n"),
        comp.lines,
        comp.caretRow,
        comp.caretCol,
        this.ownsCaret(),
      );
      return;
    }
    const raw = block.split("\n");
    const added = this.pushLines(block);
    // A block that holds more than it shows registers its two forms with the
    // fold ledger -- the region starts at its first visible row, so the blank
    // rhythm line above a group never becomes part of what a click toggles.
    if (detail) {
      let first = 0;
      while (first < raw.length && !stripAnsi(raw[first]!).trim()) first++;
      const start = this.transcript.length - added + first;
      if (first < raw.length && start >= 0) {
        this.folds.register(
          start,
          raw.slice(first).map((l) => this.bound(l)),
          detail.split("\n").map((l) => this.bound(l)),
        );
      }
    }
    // Follow the bottom when already there; if the user has scrolled up to read, hold their
    // view stationary as new lines stream in (don't yank them back down). Typing or submitting
    // resets scroll to 0, returning to the live tail.
    if (this.scroll > 0) this.scroll += added;
    this.scheduleDraw();
  }

  /**
   * Open or close a fold: splice one form out and the other in, in place.
   *
   * The scroll adjustment is the part with a reason to exist. `scroll` measures
   * from the TAIL, so a splice above the reader's window moves their content and
   * the tail by the same amount and needs nothing -- but a splice at or below
   * the window's top row grows (or shrinks) the distance between their content
   * and the tail, and without the correction the view visibly lurches by the
   * size of the fold.
   */
  private toggleFold(region: FoldRegion): void {
    const top = this.transcript.length - this.scroll - this.frameZones().bodyRows;
    const splice = this.folds.toggle(region);
    this.transcript.splice(splice.start, splice.remove, ...splice.insert);
    const overflow = this.transcript.length - MAX_TRANSCRIPT;
    if (overflow > 0) {
      this.transcript.splice(0, overflow);
      this.folds.noteTrim(overflow);
    }
    if (this.scroll > 0 && splice.start >= top) {
      this.scroll = Math.max(0, this.scroll + splice.delta);
    }
    this.scheduleDraw();
  }

  /** A left click landing in the transcript toggles the fold under it. */
  private clickTranscript(_x: number, y: number): void {
    if (this.inline || !this.lastBodyMap) return;
    if (this.mode !== "input" && this.mode !== "turn") return;
    const map = this.lastBodyMap;
    const row = y - 1; // SGR cells are 1-based
    const first = map.bodyTop + (map.marked ? 1 : 0);
    const last = map.bodyTop + map.bodyRows - 1;
    if (row < first || row > last) return;
    const index = map.hiddenAbove + (row - first);
    if (index < 0 || index >= this.transcript.length) return;
    const fold = this.folds.at(index);
    if (fold) this.toggleFold(fold);
  }

  /** --inline only: redraw just the pinned composer block (the transcript lives in the
   *  terminal's own scrollback). The fixed layout uses renderViewport() instead. */
  private renderRegion(): void {
    const comp = this.pinnedBlock();
    this.region.render(comp.lines, comp.caretRow, comp.caretCol, this.ownsCaret());
  }

  /** The zones of the current frame, without building it. Used by the scroll
   *  keys, which need to know how tall a page is before they can move by one. */
  private frameZones(): Zones {
    const headerRows = this.bannerLines().length;
    return zones(rowsCount(), headerRows, this.footerBlock(headerRows).lines.length);
  }

  /** How far back the transcript can be scrolled: everything that does not fit
   *  in the body. Clamping here (and again in composeFrame) is what stops a
   *  fast wheel from scrolling past the top into a screen of blank rows. */
  private maxScroll(): number {
    return Math.max(0, this.transcript.length - this.frameZones().bodyRows);
  }

  /**
   * The pinned FOOTER of the fixed layout.
   *
   * Same block as the inline surface's, minus the padding: the inline layout
   * has to hold blank rows open beneath the transcript to push the field to the
   * bottom of the window, because the terminal decides where the block lands.
   * Here the footer is at the bottom by construction, so the padding would be
   * a hole in the middle of the screen.
   *
   * A full-height panel (sessions, keys, memory, the work review) is still a
   * footer as far as layout is concerned; it just claims almost every row. The
   * clamp leaves the header standing and one row of transcript behind it, so
   * even a panel never erases where you are.
   */
  private footerBlock(headerRows: number): { lines: string[]; caretRow: number; caretCol: number } {
    const comp = this.composerBlock();
    let lines = comp.lines.map((l) => withThemeBg(this.bound(l)));
    let caretRow = comp.caretRow;
    const max = Math.max(3, rowsCount() - headerRows - 1);
    if (lines.length > max) {
      const drop = lines.length - max;
      const marker = withThemeBg(
        this.bound(
          `  ${faint(`... ${drop} more line${drop === 1 ? "" : "s"} above (ctrl+r to expand)`)}`,
        ),
      );
      lines = [marker, ...lines.slice(drop + 1)];
      caretRow = Math.max(0, caretRow - drop);
    }
    return { lines, caretRow, caretCol: comp.caretCol };
  }

  /**
   * Paint one whole frame of the fixed layout.
   *
   * The header is re-rendered every frame rather than drawn once, so a model
   * switch, a gear change or a theme change is reflected in the band the moment
   * it happens -- and costs nothing, because the diff only writes the rows whose
   * text actually changed.
   */
  private renderViewport(): void {
    const header = this.bannerLines().map((l) => withThemeBg(l));
    const footer = this.footerBlock(header.length);
    const frame = composeFrame({
      rows: rowsCount(),
      header,
      transcript: this.transcript,
      themeBody: (l) => withThemeBg(l),
      footer: footer.lines,
      scroll: this.scroll,
      caretRow: footer.caretRow,
      caretCol: footer.caretCol,
      blank: "",
      scrolledMarker: (hidden) =>
        withThemeBg(
          this.bound(
            `  ${faint(`${hidden} earlier line${hidden === 1 ? "" : "s"} above -- pgdn to follow the latest`)}`,
          ),
        ),
    });
    // composeFrame clamps the scroll to what the transcript can offer; adopting
    // its answer is what keeps a held PgUp from accumulating an offset the body
    // cannot honour, then swallowing the first N presses of PgDn on the way back.
    this.scroll = frame.scroll;
    // Where the body landed, for the click -> transcript-row math. Recorded
    // from the frame actually painted, never recomputed later against state
    // that may have moved.
    this.lastBodyMap = {
      bodyTop: frame.zones.bodyTop,
      bodyRows: frame.zones.bodyRows,
      hiddenAbove: frame.hiddenAbove,
      marked: frame.scroll > 0 && frame.zones.bodyRows > 1,
    };
    this.viewport.render(frame, !this.ownsCaret());
  }

  /** --inline only. The pinned composer block, themed, width-bounded, and height-clamped to the
   *  viewport. (The fixed layout's equivalent is footerBlock(), which needs none of the padding
   *  below because its footer is at the bottom of the window by construction.) The
   *  inline region draws with *relative* cursor moves, so a block taller than the screen would
   *  scroll the terminal mid-draw and desync that math (garbled/duplicated footer under heavy
   *  streaming). Keep the tail -- the composer + status the user is actually using -- and elide the
   *  top (the older work/prose preview) behind a marker. */
  /**
   * The pinned block — and, at launch, the empty space that puts it where it
   * belongs.
   *
   * A program that prints eight lines into a forty-row window leaves the header
   * floating in the middle of the screen with the field somewhere under it and
   * dead space below. Both are technically "in the terminal"; neither is in its
   * place. The old surface solved this by taking the alternate screen and
   * owning every cell, which put the header on row one and the field on the
   * last row — and cost native scrollback, wheel scroll, ⌘F and pipeability to
   * do it, and painted an empty session as a viewport of nothing.
   *
   * This holds the space open from below instead. The pinned block carries the
   * blank rows itself, so the field sits on the bottom rows of the window from
   * the first frame while the header stays at the top. As output arrives the
   * padding shrinks by exactly as much as was printed, so the field never
   * moves — and once the session has filled the window the padding reaches zero
   * and the whole thing scrolls like any other program, with its history in the
   * terminal's own buffer where it belongs.
   *
   * Nothing is painted into the held space: they are ordinary blank rows, so a
   * pipe, NO_COLOR and a narrow window all see exactly what they should.
   */
  /**
   * Whether the block about to be drawn paints its own caret.
   *
   * Only the writing surface does. A picker, a permission card and the sessions
   * panel all use the caret purely to park the terminal's cursor somewhere
   * sensible, and hiding it there would take away the one signal that says the
   * pane is focused at all.
   */
  private ownsCaret(): boolean {
    // Only the writing surface paints a caret. Every other mode — pickers, the
    // permission card, the sessions panel, the key sheet — parks the terminal's
    // cursor somewhere sensible and needs it visible, because there it is the
    // only signal that the pane has focus at all.
    return this.mode === "input" || this.mode === "turn";
  }

  private pinnedBlock(): { lines: string[]; caretRow: number; caretCol: number } {
    const comp = this.composerBlock();
    let lines = comp.lines.map((l) => withThemeBg(this.bound(l)));
    let caretRow = comp.caretRow;

    // Hold the field on the bottom rows until real output has earned the space.
    const pad = holdOpenRows(rowsCount(), this.printedRows, lines.length);
    if (pad > 0) {
      const blank = withThemeBg(this.bound(""));
      lines = [...Array.from({ length: pad }, () => blank), ...lines];
      caretRow += pad;
    }
    const max = Math.max(3, rowsCount() - 1);
    if (lines.length > max) {
      const drop = lines.length - max;
      const marker = withThemeBg(
        this.bound(
          `  ${faint(`... ${drop} more line${drop === 1 ? "" : "s"} above (ctrl+r to expand)`)}`,
        ),
      );
      lines = [marker, ...lines.slice(drop + 1)];
      caretRow = Math.max(0, caretRow - drop);
    }
    return { lines, caretRow, caretCol: comp.caretCol };
  }

  /** Print the banner once at the top; it scrolls away with the conversation.
   *
   *  This used to also clear the screen and paint it in the theme background.
   *  Both are gone. Starting a program is not a licence to erase what the user
   *  had on screen — their last command's output is often the reason they
   *  opened Gear — and asserting a background is the single largest reason a
   *  TUI looks broken on someone else's theme. Inherit; do not assert. */
  /** Tell Warp this pane is an agent, and where it is. */
  private warp(
    event: Parameters<typeof notifyWarp>[0]["event"],
    extra: {
      query?: string;
      response?: string;
      toolName?: string;
      summary?: string;
      toolInput?: string;
    } = {},
  ): void {
    notifyWarp(
      {
        event,
        sessionId: this.ctx.sessionId,
        cwd: this.ctx.workspaceRoot,
        ...extra,
      },
      this.ctx.version,
    );
  }

  /**
   * Mount the render surface. Called at launch and again after anything that
   * hands the terminal to a child (the $EDITOR path), so both layouts have
   * exactly one place that knows how they are put on screen.
   */
  private enterSurface(): void {
    // The cursor is the one piece of terminal chrome that sits inside our own
    // field, so it takes the theme's accent — see terminalThemeSeq. Handed back
    // on exit and by the crash handler; a terminal that ignores OSC 12 ignores
    // it harmlessly.
    process.stdout.write(terminalThemeSeq());
    if (!this.inline) {
      this.viewport.enter();
      // The wheel is the terminal's scroll gesture, and on the alternate screen
      // there is nothing for it to scroll. Capture it and give it the body.
      this.viewport.captureMouse();
    }
    this.warp("session_start");
    // Name the tab the moment we own the pane. Without this the tab keeps
    // whatever the terminal derived from the command until the first turn
    // starts, so a session sitting at the prompt looks like a bare shell --
    // which is most of the time anyone is actually glancing at the tab strip.
    setTitle({ kind: "idle" }, this.titleProject());
    // Inline commits the banner into scrollback once. In the fixed layout the
    // banner IS the header zone, re-rendered live every frame -- printing it
    // into the transcript as well would leave a stale copy scrolling around
    // underneath the real one.
    if (this.inline) this.printBanner();
    else this.scheduleDraw();
  }

  /** Unmount the render surface, leaving the terminal as it was found. */
  private leaveSurface(): void {
    if (this.inline)
      this.region.clear(); // leaves the transcript in scrollback
    else this.viewport.leave(); // restores the shell's screen untouched
  }

  /** Apply a runtime theme change to the terminal surface as well as future tokens. */
  private refreshThemeSurface(): void {
    // Reset first so switching from an explicit palette back to Auto truly hands
    // foreground/background control back to the host terminal.
    process.stdout.write(TERMINAL_THEME_RESET + terminalThemeSeq());
    if (this.inline) {
      this.region.setBgFill(themeBgSeq());
    } else {
      // Every row on screen was written in the old palette, and the diff would
      // keep every one of them because their text is unchanged. Forget the
      // screen so the new palette actually reaches the rows already drawn.
      this.viewport.invalidate();
    }
    this.scheduleDraw();
  }

  /** The preset's human label for the active model ("Gemini 2.5 Flash"), when known. */
  private modelLabel(): string | undefined {
    const { engine } = this.ctx;
    const model = engine.getModel();
    return getPreset(engine.getProvider())?.models?.find((m) => m.id === model)?.label;
  }

  /** Connected MCP servers, for the header badge. */
  private mcpServerCount(): number {
    try {
      return this.ctx.engine.getMcpStatus().length;
    } catch {
      return 0;
    }
  }

  /** The active gear, as the header states it: what proceeds without asking,
   *  and -- in 1st gear, where nothing does -- what still asks. */
  private gearScope(): { scope: string; caution?: string } {
    const mode = modeInfo(this.ctx.engine.getPermissionMode());
    return {
      scope: mode.label,
      caution: mode.desc || undefined,
    };
  }

  /** Print the banner into the transcript (inline surface). The alt-screen surface renders it
   *  live as a pinned header via bannerLines() instead. */
  private printBanner(): void {
    const { engine } = this.ctx;
    this.print(
      renderBanner({
        model: engine.getModel(),
        modelLabel: this.modelLabel(),
        provider: engine.getProvider(),
        effort: engine.getReasoningEffort(),
        sessionId: this.ctx.sessionId,
        workspace: this.ctx.workspaceRoot,
        version: this.ctx.version,
        ...this.gearScope(),
      }),
    );
  }

  /** Clear the visible transcript, on explicit user request only.
   *
   *  The absolute clear here is deliberate and is the one place it is allowed:
   *  the user asked for a clear screen, and this is exactly what clear(1) does.
   *  It is not a render path — nothing repaints through here — so it cannot rot
   *  the way a per-frame absolute address does. No background is painted. */
  private resetTranscript(): void {
    this.transcript = [];
    this.folds.clear();
    this.scroll = 0;
    if (!this.inline) {
      // The fixed layout's screen is ours: dropping the transcript and
      // repainting IS the clear, and it leaves the user's shell scrollback
      // (which is behind the alternate screen) alone.
      this.printedRows = 0;
      this.viewport.invalidate();
      this.scheduleDraw();
      return;
    }
    this.region.clear();
    process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
    // The screen is empty again, so the row count that decides how much space
    // the field holds open has to be empty too. Without this, /clear wipes the
    // window while the padding still believes a full screen of output is above
    // it — it computes zero, and the bar jumps up under the banner leaving the
    // bottom of the window blank. printBanner() re-counts its own rows below.
    this.printedRows = 0;
    this.printBanner();
  }

  /** The banner, rendered live (re-themed every frame) so the header always matches the
   *  current theme -- pinned at the top of the viewport by renderViewport(). */
  private bannerLines(): string[] {
    const { engine } = this.ctx;
    return renderBanner({
      model: engine.getModel(),
      modelLabel: this.modelLabel(),
      provider: engine.getProvider(),
      effort: engine.getReasoningEffort(),
      sessionId: this.ctx.sessionId,
      workspace: this.ctx.workspaceRoot,
      version: this.ctx.version,
      ...this.gearScope(),
    })
      .split("\n")
      .map((l) => this.bound(l));
  }

  /** Request a repaint, coalesced to at most one paint per ~16ms (60fps). Almost every input and
   *  stream event funnels through here; together with the diff renderer this turns a burst of
   *  changes into a single frame, which is what removes the scroll/stream jitter. */
  private scheduleDraw(): void {
    if (this.drawScheduled) return;
    this.drawScheduled = true;
    const wait = Math.max(0, 16 - (Date.now() - this.lastPaint));
    this.drawTimer = setTimeout(() => this.paint(), wait);
  }

  private paint(): void {
    this.drawScheduled = false;
    this.drawTimer = null;
    this.lastPaint = Date.now();
    if (this.inline) this.renderRegion();
    else this.renderViewport();
  }

  /** Scroll the body by whole screens (PgUp/PgDn). One row of overlap, so the
   *  line you were reading at the seam is still there after the jump. */
  private scrollBy(pages: number): void {
    this.scrollLines(pages * Math.max(1, this.frameZones().bodyRows - 1));
  }

  /**
   * Scroll the body. Positive moves back through history, negative returns
   * toward the live tail -- matching `scroll`, which counts lines ABOVE the
   * bottom.
   *
   * Under --inline this stays a no-op on purpose: there the transcript is in
   * the terminal's own buffer, and a program that also scrolled it would be
   * fighting the scrollbar the user is already holding.
   */
  private scrollLines(lines: number): void {
    if (this.inline) return;
    const next = Math.max(0, Math.min(this.maxScroll(), this.scroll + lines));
    if (next === this.scroll) return;
    this.scroll = next;
    this.scheduleDraw();
  }

  private workingText(): string {
    if (this.aborting) return `${accent(HEX)} ${bold(text("Interrupting..."))}`;
    const elapsed = Date.now() - this.turnStart;
    const secs = Math.floor(elapsed / 1000);
    const t = secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m${secs % 60}s`;
    // The hint adapts: idle composer -> how to stop; a typed-ahead draft -> how to queue/clear it.
    const hint = this.input.length > 0 ? "enter queues | esc clears" : "esc to interrupt";
    return faint(`${t} | ${hint}`);
  }

  /** The v2 status ladder rung directly above the composer: the TurnRenderer's
   *  live lines (label + receipt, a faint detail row, then whatever the turn
   *  has to show for itself -- a row per sub-agent in flight, or the tail of
   *  the answer as it streams) -- or the interrupting state while an abort
   *  drains. */
  private turnStateLines(): string[] {
    if (this.aborting) return [`  ${this.workingText()}`];
    const lines = [...(this.turnPreview ?? [])];
    if (lines.length === 0) {
      const secs = Math.max(0, Math.floor((Date.now() - this.turnStart) / 1000));
      return [
        `  ${brand(GEAR_MARK)} ${bold(brand("Thinking"))}${faint("...")} ${faint(`(${secs}s)`)}`,
      ];
    }
    // This was a flat two rows, which is why a fan-out of sub-agents could only
    // ever be a count: there was nowhere to put the other five. The block earns
    // rows now, and it is trimmed from the BOTTOM, so a short window loses the
    // fleet's later members and keeps the rung and its clock -- the opposite of
    // what the viewport's own footer trim would do. It never takes more than a
    // third of the window either way: this is the last few lines of the screen,
    // not the screen.
    const budget = Math.max(2, Math.min(LIVE_BLOCK_ROWS, Math.floor(rowsCount() / 3)));
    return lines.slice(0, budget).map((line) => clampVisible(line, Math.max(8, cols() - 1)));
  }

  // -- stdin routing --

  private onData(chunk: string): void {
    // Bracketed paste is carved out of the stream as substrings (PasteScanner) -- never fed through
    // parseKeys. A multi-megabyte paste (e.g. dumping a large doc) would otherwise allocate one Key
    // object per character and rebuild an accumulator char-by-char (O(n2)), freezing the UI for
    // seconds. Here the whole body is one substring, so a huge paste is effectively free.
    for (const seg of this.paste.push(chunk)) {
      if (seg.type === "paste") this.endPaste(seg.content);
      else for (const key of parseKeys(seg.data)) this.routeKey(key);
    }
  }

  /** Route one decoded key event to the active mode (paste is handled upstream in onData). */
  private routeKey(key: Key): void {
    if (this.mode === "review" && (key.type === "wheel-up" || key.type === "wheel-down")) {
      this.moveWorkReview(key.type === "wheel-up" ? -SCROLL_STEP : SCROLL_STEP);
      return;
    }
    // The mouse wheel scrolls the transcript in every mode -- even while a turn streams.
    if (key.type === "wheel-up") {
      this.scrollLines(SCROLL_STEP);
      return;
    }
    if (key.type === "wheel-down") {
      this.scrollLines(-SCROLL_STEP);
      return;
    }
    // A left click opens or closes the fold under it; ctrl+o answers for the
    // newest fold without leaving the keyboard, and falls back to the full
    // work log where there is nothing to open.
    if (key.type === "click") {
      this.clickTranscript(key.x, key.y);
      return;
    }
    if (
      key.type === "ctrl" &&
      key.name === "o" &&
      (this.mode === "input" || this.mode === "turn")
    ) {
      const fold = this.inline ? undefined : this.folds.newest();
      if (fold) this.toggleFold(fold);
      else this.expandWorkLog();
      return;
    }
    // Shift+Tab cycles confirm -> Autonomy I -> II -> III -> Auto -> confirm while composing.
    // Inside an approval ask it is the explicit "allow for session" shortcut printed
    // beside choice 2, so the visible contract and the keyboard behavior stay identical.
    if (key.type === "shift-tab") {
      if (this.mode === "permission") this.permKey(key);
      else if (this.mode === "input" || this.mode === "turn") this.cyclePermissionMode();
      return;
    }
    switch (this.mode) {
      case "input":
        this.inputKey(key);
        break;
      case "turn":
        this.turnKey(key);
        break;
      case "picker":
        this.pickerKey(key);
        break;
      case "permission":
        this.permKey(key);
        break;
      case "keys":
        this.keysKey(key);
        break;
      case "sessions":
        this.sessionsKey(key);
        break;
      case "memory":
        this.memoryKey(key);
        break;
      case "ask":
        this.askKey(key);
        break;
      case "question":
        this.questionKey(key);
        break;
      case "held":
        this.heldKey(key);
        break;
      case "review":
        this.workReviewKey(key);
        break;
    }
  }

  /** Land a finished paste: small single-line pastes drop in inline; anything multi-line or long
   *  collapses to a chip so the composer stays a clean single line (see `pastes`). */
  private endPaste(content: string): void {
    // Key/URL editor is a single-line field -- always inline, newlines stripped by insertActive.
    if (this.mode === "keys") {
      this.insertActive(content);
      this.scheduleDraw();
      return;
    }
    if (shouldCollapse(content)) {
      const id = ++this.pasteSeq;
      this.pastes.set(id, content);
      this.insert(pasteChip(id, content));
    } else {
      this.insert(content);
    }
    this.scheduleDraw();
  }

  /** Swap `[Pasted text #N ...]` chips back to their stored bodies just before a message is sent. */
  private expandPastes(s: string): string {
    return expandPastes(s, this.pastes);
  }

  /** Drop paste bodies whose chip no longer appears in the composer (consumed or edited away). */
  private gcPastes(): void {
    if (this.pastes.size === 0) return;
    const live = livePasteIds(this.input);
    for (const id of [...this.pastes.keys()]) if (!live.has(id)) this.pastes.delete(id);
  }

  // -- input mode --

  private insert(s: string): void {
    const clean = s.replace(/\r/g, "");
    this.input = this.input.slice(0, this.caret) + clean + this.input.slice(this.caret);
    this.caret += clean.length;
  }

  /** Route pasted text to whichever field is active (composer, or a key editor). */
  private insertActive(s: string): void {
    if (this.mode === "keys") {
      if (!this.keysEdit) return; // ignore pastes on the list view
      const clean = s.replace(/[\r\n]+/g, ""); // keys/URLs are single-line
      const e = this.keysEdit;
      e.value = e.value.slice(0, e.caret) + clean + e.value.slice(e.caret);
      e.caret += clean.length;
      return;
    }
    this.insert(s);
  }

  /** Apply a pure text-editing key to the composer (insert / caret motion / deletion). Returns
   *  true when it handled the key. Shared by input mode and mid-turn type-ahead so the composer
   *  edits identically whether or not a turn is streaming; callers own redraw + side effects. */
  private editComposer(key: Key): boolean {
    switch (key.type) {
      case "char":
        this.insert(key.value);
        this.scroll = 0; // typing returns to the latest output
        return true;
      case "backspace":
        if (this.caret > 0) {
          this.input = this.input.slice(0, this.caret - 1) + this.input.slice(this.caret);
          this.caret--;
        }
        return true;
      case "delete":
        if (this.caret < this.input.length) {
          this.input = this.input.slice(0, this.caret) + this.input.slice(this.caret + 1);
        }
        return true;
      case "left":
        if (this.caret > 0) this.caret--;
        return true;
      case "right":
        if (this.caret < this.input.length) this.caret++;
        return true;
      case "home":
        this.caret = 0;
        return true;
      case "end":
        this.caret = this.input.length;
        return true;
      default:
        return false;
    }
  }

  private inputKey(key: Key): void {
    // Reference-card shortcuts: left from an empty composer opens history; `?`
    // opens the same live command palette as `/` without submitting a message.
    if (key.type === "left" && this.input.length === 0) {
      this.openSessions();
      return;
    }
    if (key.type === "char" && key.value === "?" && this.input.length === 0) {
      this.input = "/";
      this.caret = 1;
      this.slashSel = 0;
      this.scheduleDraw();
      return;
    }
    // When the `/` palette is open, up/down navigate it and tab/enter pick from it.
    const sm = this.slashMatches();
    if (sm.length > 0) {
      const sel = Math.max(0, Math.min(this.slashSel, sm.length - 1));
      switch (key.type) {
        case "up":
          this.slashSel = (sel - 1 + sm.length) % sm.length;
          this.scheduleDraw();
          return;
        case "down":
          this.slashSel = (sel + 1) % sm.length;
          this.scheduleDraw();
          return;
        case "tab":
          this.input = sm[sel]!.name + " ";
          this.caret = this.input.length;
          this.slashSel = 0;
          this.scheduleDraw();
          return;
        case "enter":
          this.input = sm[sel]!.name;
          this.caret = this.input.length;
          this.slashSel = 0;
          void this.submit();
          return;
      }
    }
    // Text editing (insert / caret / delete) is shared with mid-turn type-ahead.
    if (this.editComposer(key)) {
      this.sigintArmed = false;
      this.slashSel = 0;
      this.scheduleDraw();
      return;
    }
    switch (key.type) {
      case "pageup":
        this.scrollBy(1);
        break;
      case "pagedown":
        this.scrollBy(-1);
        break;
      case "enter":
        void this.submit();
        break;
      case "up":
        this.historyPrev();
        break;
      case "down":
        this.historyNext();
        break;
      case "esc":
        if (this.input.length === 0) {
          const cancelled = this.ctx.engine.cancelLoopTask(this.ctx.sessionId);
          if (cancelled.ok && cancelled.task) {
            this.print(
              `  ${danger(glyph("failure"))} ${muted("stopped loop")} ${info(cancelled.task.id)} ${faint(loopPromptPreview(cancelled.task.prompt, 56))}`,
            );
          }
        } else {
          this.input = "";
          this.caret = 0;
          this.scheduleDraw();
        }
        break;
      case "ctrl":
        this.ctrlKey(key.name);
        break;
    }
  }

  private ctrlKey(name: string): void {
    switch (name) {
      case "r":
        this.expandWorkLog();
        return;
      case "c":
        if (this.input.length > 0) {
          this.input = "";
          this.caret = 0;
          this.sigintArmed = false;
          this.scheduleDraw();
          return;
        }
        if (this.sigintArmed) {
          this.exit(0);
          return;
        }
        this.sigintArmed = true;
        this.print(`  ${faint("(ctrl-c again to exit)")}`);
        setTimeout(() => {
          this.sigintArmed = false;
        }, 2000);
        break;
      case "d":
        if (this.input.length === 0) this.exit(0);
        break;
      case "l":
        this.resetTranscript();
        break;
      case "u":
        this.input = this.input.slice(this.caret);
        this.caret = 0;
        this.scheduleDraw();
        break;
      case "a":
        this.caret = 0;
        this.scheduleDraw();
        break;
      case "e":
        this.caret = this.input.length;
        this.scheduleDraw();
        break;
      case "t":
        this.print(`  ${faint("Transcript view (ctrl+t) is coming in a later build.")}`);
        break;
    }
  }

  private historyPrev(): void {
    if (this.history.length === 0) return;
    if (this.histIdx === -1) {
      this.draft = this.input;
      this.histIdx = this.history.length;
    }
    if (this.histIdx > 0) {
      this.histIdx--;
      this.input = this.history[this.histIdx]!;
      this.caret = this.input.length;
      this.scheduleDraw();
    }
  }

  private historyNext(): void {
    if (this.histIdx === -1) return;
    this.histIdx++;
    if (this.histIdx >= this.history.length) {
      this.histIdx = -1;
      this.input = this.draft;
    } else {
      this.input = this.history[this.histIdx]!;
    }
    this.caret = this.input.length;
    this.scheduleDraw();
  }

  // -- submit --

  private async submit(): Promise<void> {
    const raw = this.expandPastes(this.input).trim();
    this.input = "";
    this.caret = 0;
    this.histIdx = -1;
    this.slashSel = 0;
    this.scroll = 0; // submitting jumps back to the live tail
    this.gcPastes(); // composer is empty now -> release the paste bodies just consumed
    if (!raw) {
      this.scheduleDraw();
      return;
    }
    await this.runInput(raw);
  }

  /** The latest durable checkpoint this window has seen, keyed by session so a
   *  resumed session never inherits another session's receipt. */
  private lastCheckpoint: { sessionId: string; label: string } | null = null;

  /** The v2 task-bar receipt: the turn about to run and the latest checkpoint. */
  private taskBarMeta(): { turn?: number; checkpoint?: string } {
    let turn: number | undefined;
    try {
      turn = this.ctx.engine.listUserTurns(this.ctx.sessionId).length + 1;
    } catch {
      turn = undefined;
    }
    const checkpoint =
      this.lastCheckpoint?.sessionId === this.ctx.sessionId ? this.lastCheckpoint.label : undefined;
    return { turn, checkpoint };
  }

  /** Echo, record, and execute one line of input -- a slash command or a model turn. Shared by
   *  submit() and the type-ahead queue drained when a turn completes, so both run identically. */
  private async runInput(raw: string, scheduledLoop?: LoopTask): Promise<void> {
    // A new message supersedes any pending quota auto-resume — the user is
    // driving again.
    this.cancelQuotaResume(true);
    if (!scheduledLoop) this.history.push(raw);

    // Echo the prompt into the transcript. A slash command is an instruction to the
    // shell (quiet echo); anything else is the user's message -- the loud block.
    if (scheduledLoop) {
      this.print(
        `  ${warn(glyph("retry"))} ${bold(text("Loop"))} ${info(scheduledLoop.id)} ${faint(`| iteration ${scheduledLoop.runCount + 1} | ${scheduledLoop.cadence}`)}`,
      );
      this.print(userBlock(raw, this.taskBarMeta()));
    } else if (raw.startsWith("/")) this.print(`  ${info(glyph("selection"))} ${text(raw)}`);
    else this.print(userBlock(raw, this.taskBarMeta()));

    if (!scheduledLoop && raw.startsWith("/")) {
      const handled = await this.handleSlash(raw);
      if (handled) {
        this.scheduleDraw();
        return;
      }
    }
    let agentInput = raw;
    if (scheduledLoop && raw.startsWith("/") && !raw.startsWith("/ ")) {
      const [name, ...args] = raw.slice(1).split(" ");
      const custom = findCommand(this.ctx.customCommands, name);
      if (custom) agentInput = custom.render(args.join(" "));
    }
    await this.runTurn(agentInput, scheduledLoop);
    this.scheduleDraw();
  }

  // -- slash commands --

  private async handleSlash(raw: string): Promise<boolean> {
    const { engine } = this.ctx;
    const [cmd, ...rest] = raw.slice(1).split(" ");
    const arg = rest.join(" ").trim();

    switch (cmd) {
      case "quit":
      case "exit":
        this.exit(0);
        return true;
      case "clear":
        this.resetTranscript();
        return true;
      case "notebook": {
        const entries = engine.getNotebookEntries(10);
        if (entries.length === 0) {
          this.print(
            `  ${muted("Notebook is empty for this workspace -- Gear fills it as it verifies how your repos work.")}`,
          );
        } else {
          this.print(
            [
              `  ${bold(text("Notebook -- active for this workspace"))}`,
              ...entries.map(
                (e) =>
                  `    ${info(e.id.slice(-8))} ${muted(`[${e.scope}]`)} ${text(e.body.slice(0, 90))}`,
              ),
              `    ${muted("manage: gear notebook [show <id>|rm <id>|export]")}`,
            ].join("\n"),
          );
        }
        return true;
      }
      case "bug": {
        const rec = engine.getRecorder();
        if (!rec) {
          this.print(`  ${muted("Diagnostics are disabled ([diagnostics] enabled = false).")}`);
          return true;
        }
        const id = rec.record({
          class: "ux.user_reported",
          severity: "warn",
          component: "tui",
          where: "slash#bug",
          message: arg || "user flagged the last exchange (no note given)",
        });
        this.print(
          id
            ? `  ${text("* Logged with the current flight trail.")} ${muted(`gear incidents show ${id.slice(-8)}`)}`
            : `  ${muted("Could not record -- see gear doctor.")}`,
        );
        return true;
      }
      case "help": {
        const commands = this.slashCatalog();
        const nameWidth = Math.max(...commands.map((item) => item.name.length)) + 2;
        const rows =
          cols() < 64
            ? commands.flatMap((item) => [`    ${info(item.name)}`, `      ${muted(item.desc)}`])
            : commands.map((item) => `    ${info(item.name.padEnd(nameWidth))}${muted(item.desc)}`);
        this.print([`  ${bold(text("Commands"))}`, ...rows].join("\n"));
        return true;
      }
      case "sessions":
      case "resume":
        this.openSessions("active");
        return true;
      case "rename": {
        if (!arg) {
          this.print(
            `  ${warn("Usage:")} ${info("/rename <title>")} ${faint("-- renames the current session (or use /sessions)")}`,
          );
          return true;
        }
        engine.renameSession(this.ctx.sessionId, arg);
        this.print(`  ${ok(glyph("verified"))} ${muted("renamed session to")} ${text(arg)}`);
        return true;
      }
      case "status": {
        const s = engine.getStatus(this.ctx.sessionId);
        this.print(
          renderStatus({
            model: s.model,
            provider: s.provider,
            workspace: s.workspace,
            sessionId: this.ctx.sessionId,
            cost: s.cost,
            costSummary: s.costSummary,
            yoloMode: s.yoloMode,
            trustWorkspace: s.trustWorkspace,
            permissionMode: s.permissionMode,
            sandboxEnabled: s.sandboxEnabled,
            sandboxDegraded: s.sandboxDegraded,
            orgPolicy: s.orgPolicy,
            autoMode: s.autoMode,
            registeredProviders: s.registeredProviders,
            version: this.ctx.version,
            contextUsage: engine.getContextUsage(),
            providerHealth: engine.getProviderHealth(),
          }),
        );
        const team = engine.getTeamStatus();
        if (team.enabled && team.peerCount > 0) {
          this.print(
            `  ${muted("Team")}  ${text(`${team.peerCount} other instance${team.peerCount === 1 ? "" : "s"} in this repo`)} ${faint("(/team)")}`,
          );
        }
        return true;
      }
      case "cost": {
        // Was a lone `$0.0000` — true on a subscription route and useless.
        // The readout now answers the three questions that number can't:
        // what left the building, what it would cost metered, and what the
        // prompt cache is actually saving.
        const rows = formatCostReport(engine.getCostBreakdown());
        const width = Math.max(...rows.map((r) => r.label.length));
        for (const row of rows) {
          const label = faint(row.label.padStart(width));
          const paint =
            row.tone === "warn"
              ? warn
              : row.tone === "good"
                ? ok
                : row.tone === "muted"
                  ? muted
                  : text;
          const note = row.note ? ` ${faint(`(${row.note})`)}` : "";
          this.print(`  ${label}  ${paint(row.value)}${note}`);
        }
        return true;
      }
      case "team": {
        const lines = runTeamCommand(engine.getTeamBus(), arg);
        this.print(lines.map((l, i) => `  ${i === 0 ? text(l) : muted(l)}`).join("\n"));
        return true;
      }
      case "loop":
      case "loops":
        this.handleLoopSlash(cmd, arg);
        return true;
      case "providers": {
        const a = arg.split(/\s+/).filter(Boolean);
        const op = (a[0] ?? "").toLowerCase();
        // `/providers on|off <id>` toggles a provider live.
        if ((op === "on" || op === "off") && a[1]) {
          const id = a[1].toLowerCase();
          if (!getPreset(id) && id !== CUSTOM_PROVIDER_ID) {
            this.print(
              `  ${warn("Unknown provider")} ${info(id)} ${faint("(one word, no spaces -- e.g. openai)")}`,
            );
            this.print(
              `  ${faint("Providers: ")}${faint(PROVIDER_PRESETS.map((p) => p.id).join(", "))}`,
            );
            return true;
          }
          const disabled = op === "off";
          persistDisabled(id, disabled);
          const res = engine.setProviderDisabled(id, disabled, this.ctx.sessionId);
          this.print(
            `  ${ok(glyph("verified"))} ${info(id)} ${muted(disabled ? "disabled" : "enabled")}`,
          );
          // Enabling only re-includes an already-credentialed provider -- it does
          // NOT add a key. If it has none, point the user at how to add one.
          if (!disabled) {
            const row = engine.getProviderStatus().find((r) => r.id === id);
            if (row && !row.hasKey && !row.local) {
              this.print(
                `  ${warn("->")} ${muted(`${id} has no key yet -- add one:`)} ${info(`/keys set ${id} <key>`)} ${muted("or")} ${info(`gear login ${id}`)}`,
              );
            }
          }
          if (res.switchedTo) {
            this.print(
              `  ${warn("->")} ${muted("active provider was off -- now on")} ${info(`${res.switchedTo.provider}/${res.switchedTo.model}`)}`,
            );
          }
          return true;
        }
        // Data-driven listing: all providers, key state, on/off, active.
        const rows = engine.getProviderStatus().map((r) => {
          const dot = r.disabled
            ? faint("o")
            : r.active
              ? ok(glyph("live"))
              : r.hasKey
                ? info(glyph("live"))
                : faint("o");
          const c = r.active ? ok : r.hasKey && !r.disabled ? text : faint;
          const st = r.disabled
            ? warn("off")
            : r.active
              ? ok("active")
              : r.hasKey
                ? muted("ready")
                : faint("no key");
          // Show the real credential source so the panel never lies about what
          // the gateway uses: oauth / keychain / env, or "key" for a saved key.
          const srcLabel = r.source === "none" ? "" : r.source === "saved" ? "key" : r.source; // env | oauth | keychain
          const src = srcLabel ? faint(`  ${srcLabel}`) : "";
          return `    ${dot} ${c(r.id.padEnd(13))} ${st}${src}`;
        });
        this.print(
          [
            `  ${bold(text("Providers"))}`,
            ...rows,
            `  ${faint("toggle /providers on|off <id> | keys /keys | switch /model")}`,
          ].join("\n"),
        );
        return true;
      }
      case "login":
      case "signin":
        void this.openLogin();
        return true;
      case "keys":
        this.openKeys();
        return true;
      case "mcp": {
        const servers = await engine.listMcpServers();
        const lines = [`  ${bold(text("MCP servers"))}`];
        if (servers.length === 0) {
          lines.push(
            `    ${muted("None configured. Add servers in ")}${info(".gear/mcp.json")}${muted(".")}`,
          );
        } else {
          for (const server of servers) {
            const dot =
              server.health === "healthy"
                ? ok(glyph("live"))
                : server.health === "degraded"
                  ? warn(glyph("live"))
                  : faint("o");
            lines.push(
              `    ${dot} ${text(server.name)} ${muted(`(${server.kind}, ${server.toolCount} tools)`)}`,
            );
            if (server.tools.length) lines.push(`      ${faint(server.tools.join(", "))}`);
            if (server.lastError) lines.push(`      ${warn("!")} ${faint(server.lastError)}`);
          }
        }
        this.print(lines.join("\n"));
        return true;
      }
      case "skills": {
        if (arg) {
          const hits = await engine.searchSkills(arg);
          this.print(
            [
              `  ${bold(text("Skills"))} ${muted(`matching "${arg}"`)}`,
              ...(hits.length
                ? hits.flatMap((hit) => [
                    `    ${info(hit.id)}`,
                    ...(hit.description ? [`      ${faint(hit.description)}`] : []),
                  ])
                : [`    ${muted("No matches.")}`]),
            ].join("\n"),
          );
          return true;
        }
        const catalog = await engine.listSkills();
        this.print(
          [
            `  ${bold(text("Skills"))} ${muted(`(${catalog.total} across ${catalog.plugins.length} domains)`)}`,
            ...(catalog.total
              ? catalog.plugins.flatMap((plugin) => [
                  `    ${ok(glyph("live"))} ${text(plugin.plugin)} ${muted(`(${plugin.skills.length})`)}`,
                  `      ${faint(plugin.skills.map((skill) => skill.name).join(", "))}`,
                ])
              : [
                  `    ${muted("None found. Add skills under ")}${info("skills/")}${muted(" or ")}${info(".gear/skills/")}${muted(".")}`,
                ]),
            `  ${faint("Skills load automatically when a request matches | search with /skills <keywords>")}`,
          ].join("\n"),
        );
        return true;
      }
      case "research":
      case "deepresearch": {
        const deep = cmd === "deepresearch";
        if (!arg) {
          const verb = deep ? "deep, multi-round research" : "research with a cited report";
          this.print(`  ${warn("Usage:")} ${info(`/${cmd} <question>`)} ${faint(`-- ${verb}`)}`);
          return true;
        }
        await this.runResearchFlow(arg, deep ? "deep" : undefined);
        return true;
      }
      case "gear": {
        // /gear          -> shift up one gear
        // /gear 3 | 3rd | auto -> shift straight to that gear
        const target = configModeToPermissionMode(arg || undefined);
        if (arg && !target) {
          this.print(
            `  ${warn("Usage:")} ${info("/gear")} ${faint("[1|2|3|4|auto] -- empty shifts up")}`,
          );
        } else this.cyclePermissionMode(target);
        return true;
      }
      case "autonomy": {
        // Legacy alias: /autonomy I|II|III -> 2nd|3rd|4th gear.
        const target = configModeToPermissionMode(arg ? `autonomy-${arg}` : undefined);
        if (target) this.cyclePermissionMode(target);
        else
          this.print(
            `  ${warn("Usage:")} ${info("/autonomy")} ${faint("[I|II|III] -- or /gear 1|2|3|4|auto")}`,
          );
        return true;
      }
      case "turing": // hidden compatibility aliases: toggle 4th gear
      case "hands-free": {
        this.cyclePermissionMode(engine.getPermissionMode() === "gear-4" ? "gear-1" : "gear-4");
        return true;
      }
      case "mode": {
        const raw = (arg ?? "").toLowerCase().trim();
        // `/mode default` pins the CURRENT gear as the startup gear, including
        // 4th. There has to be a way in that is not the one-time prompt: a
        // prompt you can miss, or that times out, is not a control — and the
        // whole point of remembering 4th gear is that it must be chosen out
        // loud, which typing this is.
        if (raw === "default" || raw === "save" || raw === "keep") {
          const current = engine.getPermissionMode();
          savePrefs({ gear: current, ...(current === "gear-4" ? { stickyFourthGear: true } : {}) });
          const label = modeInfo(current).label;
          this.print(
            `  ${accent(glyph("phase"))} ${muted("startup gear --")} ${info(label)}` +
              (current === "gear-4"
                ? ` ${warn("| full autonomy, every prompt bypassed")}`
                : ` ${faint("(used for new sessions)")}`),
          );
          return true;
        }
        if (raw === "forget" || raw === "reset") {
          savePrefs({ gear: undefined, stickyFourthGear: undefined });
          this.print(
            `  ${ok(glyph("verified"))} ${muted("startup gear cleared")} ${faint("| new sessions use the built-in default again")}`,
          );
          return true;
        }
        const mode = configModeToPermissionMode(raw);
        if (mode) {
          this.cyclePermissionMode(mode);
        } else if (raw) {
          this.print(
            `  ${warn("Usage:")} ${info("/mode")} ${faint("[1|2|3|4|auto] -- empty shifts up; `default` pins the current gear for new sessions; `forget` clears it")}`,
          );
        } else {
          this.cyclePermissionMode(); // no arg -> advance the cycle, like Shift+Tab
          const remembered = loadPrefs().gear;
          if (remembered) {
            this.print(
              `  ${faint(`startup gear: ${modeInfo(remembered as never).label} -- /mode default to change it`)}`,
            );
          }
        }
        return true;
      }
      case "sandbox": {
        const raw = (arg ?? "").toLowerCase();
        if (raw === "on" || raw === "off") {
          const enabled = raw === "on";
          engine.setSandboxEnabled(enabled);
          saveSandboxState(enabled); // sticks across sessions, like /theme
          this.print(sandboxModeBanner(enabled));
        } else if (raw) {
          this.print(
            `  ${warn("Usage:")} ${info("/sandbox")} ${faint("[on|off] -- empty shows the current state")}`,
          );
        } else {
          this.print(sandboxModeBanner(engine.isSandboxEnabled()));
        }
        return true;
      }
      case "browser": {
        const raw = (arg ?? "").toLowerCase();
        if (raw === "on" || raw === "off") {
          const enabled = raw === "on";
          await engine.setBrowserEnabled(enabled);
          saveBrowserState(enabled);
          this.print(browserModeBanner(enabled));
        } else if (raw) {
          this.print(
            `  ${warn("Usage:")} ${info("/browser")} ${faint("[on|off] -- empty shows the current state")}`,
          );
        } else {
          this.print(browserModeBanner(engine.isBrowserEnabled()));
        }
        return true;
      }
      case "diff": {
        this.print(renderWorkspaceDiff(this.ctx.workspaceRoot));
        return true;
      }
      case "theme": {
        const themes = listThemes();
        if (arg) {
          if (setTheme(arg)) {
            this.refreshThemeSurface();
            saveTheme(getTheme().name);
            this.print(
              `  ${ok(glyph("verified"))} ${muted("theme set to")} ${warn(getTheme().label)}`,
            );
          } else
            this.print(`  ${danger(glyph("failure"))} ${muted("unknown theme:")} ${faint(arg)}`);
          return true;
        }
        // Live-preview keeps compatibility with the existing picker flow; the
        // choices only select Flow foreground roles or the terminal-native rung.
        const original = getTheme().name;
        const items: PickerItem[] = themes.map((t) => ({
          label: t.label,
          hint: t.name === "auto" ? "follows the host terminal" : "six ANSI16 foreground roles",
          prefix: paintBrandWith(t.name, glyph("live")),
          current: t.name === original,
          tags: [t.name],
        }));
        const start = Math.max(
          0,
          themes.findIndex((t) => t.name === original),
        );
        const i = await this.pick(
          "Color mode",
          items,
          start,
          (idx) => {
            setTheme(themes[idx]!.name);
            this.refreshThemeSurface();
          },
          "Flow or terminal native | persisted to ~/.gear/theme.json",
        );
        if (i != null) {
          setTheme(themes[i]!.name);
          this.refreshThemeSurface();
          saveTheme(themes[i]!.name);
          this.print(
            `  ${ok(glyph("verified"))} ${muted("theme set to")} ${warn(getTheme().label)}`,
          );
        } else {
          setTheme(original); // revert the live preview on cancel
          this.refreshThemeSurface();
        }
        return true;
      }
      case "model": {
        // Quick forms: `/model <provider>/<model>` (this session only),
        // `/model default` (show) and `/model default <provider>/<model>` (persist).
        if (arg === "default" || arg.startsWith("default ")) {
          const rest = arg.slice("default".length).trim();
          if (!rest) {
            const def = loadLastModel();
            this.print(
              def
                ? `  ${accent(glyph("phase"))} ${muted("default:")} ${info(`${def.provider}/${def.model}`)} ${faint("| change: /model default <provider>/<model>, or d in /model")}`
                : `  ${muted("no default set --")} ${info("/model default <provider>/<model>")}${muted(", or press d on a model in /model")}`,
            );
            return true;
          }
          const si = rest.indexOf("/");
          const prov = si > 0 ? rest.slice(0, si) : engine.getProvider();
          const mod = si > 0 ? rest.slice(si + 1) : rest;
          this.applyModelSwitch(String(prov), mod, true);
          return true;
        }
        if (arg.includes("/")) {
          const [p, ...m] = arg.split("/");
          this.applyModelSwitch(p!, m.join("/"), false);
          return true;
        }
        if (arg) {
          this.applyModelSwitch(engine.getProvider(), arg, false);
          return true;
        }
        await this.modelTree();
        return true;
      }
      case "rewind": {
        const turns = engine.listUserTurns(this.ctx.sessionId);
        if (turns.length === 0) {
          this.print(`  ${muted("Nothing to rewind yet.")}`);
          return true;
        }
        const n = parseInt(arg, 10);
        if (!arg || isNaN(n) || n < 1 || n > turns.length) {
          const rows = turns.map(
            (t, i) =>
              `    ${warn(String(i + 1).padStart(2))}  ${muted(t.text.replace(/\s+/g, " ").slice(0, 60))}`,
          );
          this.print(
            [`  ${bold(text("Rewind"))}`, ...rows, `  ${faint("Run /rewind <n>")}`].join("\n"),
          );
          return true;
        }
        const removed = engine.rewindTo(this.ctx.sessionId, turns[n - 1]!.seq - 1);
        this.print(
          `  ${ok(glyph("verified"))} ${muted(`rewound to turn ${n} (removed ${removed})`)}`,
        );
        return true;
      }
      case "interactive": {
        const [sub = "", ...rest] = arg.split(/\s+/).filter(Boolean);
        if (sub === "auto") {
          const v = (rest[0] ?? "").toLowerCase();
          if (v === "on" || v === "off") {
            const on = v === "on";
            engine.setInteractiveAuto(on);
            saveInteractiveAuto(on);
            this.print(
              `  ${ok(glyph("verified"))} ${muted(`autonomous dashboards ${on ? "on" : "off"}`)} ${faint(
                on
                  ? "-- Gear builds one when an answer is data-heavy"
                  : "-- dashboards only when you ask (/interactive)",
              )}`,
            );
          } else {
            this.print(
              `  ${muted(`Autonomous dashboards: ${engine.isInteractiveAuto() ? "on" : "off"}`)} ${faint(
                "| toggle: /interactive auto on|off",
              )}`,
            );
          }
          return true;
        }
        if (sub === "open") {
          const info = engine.openDashboard(rest[0]);
          this.print(
            info
              ? `  ${ok(glyph("verified"))} ${muted(`opened "${info.title}"`)} ${faint(info.url)}`
              : `  ${muted("No dashboard yet -- run /interactive after a report, or ask for one.")}`,
          );
          return true;
        }
        // Bare /interactive (or with a focus) rides the normal turn loop so the
        // model builds the dashboard with full conversation context.
        const focus = sub === "view" ? rest.join(" ") : arg;
        await this.runTurn(buildInteractiveDirective(focus || undefined));
        return true;
      }
      case "undo": {
        const r = engine.undoLastAutoCommit();
        if (r.ok) {
          this.print(
            `  ${ok(glyph("verified"))} ${muted(`reverted ${r.undoneSha}`)} ${faint(`(${r.subject})`)}`,
          );
        } else {
          this.print(`  ${muted(`Cannot undo -- ${r.reason}`)}`);
          if (!engine.isAutoCommitEnabled()) {
            this.print(
              `  ${faint("Tip: set [git] autoCommit = true in ~/.gear/config.toml so every run lands as a revertible commit.")}`,
            );
          }
        }
        return true;
      }
      case "compress": {
        this.print(`  ${faint("Compressing...")}`);
        const r = await engine.compactSession(this.ctx.sessionId, arg || undefined);
        if (!r.compacted) {
          this.print(`  ${muted(`Nothing to compact -- ${r.reason}.`)}`);
          return true;
        }
        const fmtTok = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
        const saved =
          r.sourceTokens > 0
            ? Math.max(0, Math.round((1 - r.summaryTokens / r.sourceTokens) * 100))
            : 0;
        this.print(
          `  ${ok(glyph("verified"))} ${muted(`compacted ${r.originalMessages} messages | ~${fmtTok(r.sourceTokens)} -> ~${fmtTok(r.summaryTokens)} tokens (${saved}% smaller)`)}`,
        );
        return true;
      }
      case "memory": {
        const sub = (arg.split(/\s+/)[0] ?? "").toLowerCase();
        const subArg = arg.slice(sub.length).trim();
        const fmtTok = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

        // Bare `/memory` opens the interactive panel (view + refresh/cadence/add/edit/clear).
        // The `/memory <sub>` text forms below stay for power users + scriptability.
        if (!sub) {
          this.openMemory();
          return true;
        }

        // -- update / refresh (the "dream") --
        if (sub === "update" || sub === "refresh" || sub === "dream") {
          this.print(`  ${faint("Dreaming -- distilling your profile...")}`);
          const r = await engine.reflectSystemMemory({
            focus: subArg || undefined,
            trigger: "manual",
          });
          if (!r.updated) {
            this.print(`  ${muted(`Memory unchanged -- ${r.reason}.`)}`);
            return true;
          }
          const preview = (r.content ?? "")
            .split("\n")
            .map((l) => l.trimEnd())
            .filter(Boolean)
            .slice(0, 8);
          this.print(
            [
              `  ${ok(glyph("verified"))} ${muted(`system memory refreshed | ~${fmtTok(r.tokensBefore)} -> ~${fmtTok(r.tokensAfter)} tokens`)}`,
              ...preview.map((l) => `  ${faint(l.slice(0, 100))}`),
            ].join("\n"),
          );
          return true;
        }

        // -- add a manual note --
        if (sub === "add" || sub === "note") {
          if (!subArg) {
            this.print(`  ${warn("Usage:")} ${info("/memory add <note>")}`);
            return true;
          }
          const r = engine.appendSystemMemoryNote(subArg);
          this.print(
            `  ${ok(glyph("verified"))} ${muted(`noted | ~${fmtTok(r.tokens)} tokens total`)}`,
          );
          return true;
        }

        // -- edit: suspend the TUI and open the profile in $EDITOR for real --
        if (sub === "edit") {
          await this.editMemoryInEditor();
          return true;
        }

        // -- clear --
        if (sub === "clear" || sub === "reset" || sub === "forget") {
          engine.clearSystemMemory();
          this.print(`  ${ok(glyph("verified"))} ${muted("system memory cleared")}`);
          return true;
        }

        // -- set cadence (off | manual | daily | weekly | Nd | every N days) --
        if (
          sub === "off" ||
          sub === "manual" ||
          sub === "daily" ||
          sub === "weekly" ||
          /^\d+\s*d/.test(arg) ||
          /^every\s+\d+/.test(arg)
        ) {
          const r = engine.setSystemMemorySchedule(arg);
          const verb = r.label === "manual" ? "manual (no auto-refresh)" : `auto | ${r.label}`;
          this.print(`  ${ok(glyph("verified"))} ${muted("memory cadence:")} ${info(verb)}`);
          return true;
        }

        // -- default: status + show the profile --
        const mem = engine.getSystemMemory();
        const last = mem.meta.updatedAt ? this.relTime(mem.meta.updatedAt) : "never";
        const dreamt = mem.meta.lastReflectedAt ? this.relTime(mem.meta.lastReflectedAt) : "never";
        const head = [
          `  ${bold(text("System memory"))}${mem.enabled ? "" : ` ${faint("(disabled)")}`}`,
          `  ${faint(`cadence: ${mem.scheduleLabel} | ~${fmtTok(mem.tokens)}/${fmtTok(mem.maxTokens)} tokens | updated ${last} | dreamed ${dreamt}`)}`,
        ];
        if (!mem.content.trim()) {
          this.print(
            [
              ...head,
              `  ${muted("Empty -- Gear hasn't built your profile yet.")}`,
              `  ${faint("Seed it: /memory update | note: /memory add <...> | auto: /memory weekly")}`,
            ].join("\n"),
          );
          return true;
        }
        this.print(
          [
            ...head,
            "",
            ...mem.content.split("\n").map((l) => `  ${text(l)}`),
            "",
            `  ${faint("update: /memory update | note: /memory add <...> | cadence: /memory daily|3d|weekly|manual")}`,
          ].join("\n"),
        );
        return true;
      }
      default: {
        const custom = findCommand(this.ctx.customCommands, cmd!);
        if (custom) {
          await this.runTurn(custom.render(arg));
          return true;
        }
        this.print(
          `  ${danger(glyph("failure"))} ${muted(`unknown command: /${cmd}`)} ${faint("| /help")}`,
        );
        return true;
      }
    }
  }

  private handleLoopSlash(command: "loop" | "loops", arg: string): void {
    const tokens = arg.split(/\s+/).filter(Boolean);
    const operation = (tokens[0] ?? "").toLowerCase();
    const shouldList =
      (command === "loops" && !arg) ||
      operation === "list" ||
      operation === "ls" ||
      operation === "status";

    if (shouldList) {
      const tasks = this.ctx.engine.listLoopTasks(this.ctx.sessionId);
      if (tasks.length === 0) {
        this.print(
          `  ${muted("No loops are active in this session.")} ${faint("Try /loop 5m check CI")}`,
        );
        return;
      }
      this.print(
        [
          `  ${bold(text(`Loops -- ${tasks.length} active`))}`,
          ...tasks.map(
            (task) =>
              `    ${warn(glyph("retry"))} ${info(task.id)} ${text(task.cadence === "fixed" ? `every ${formatLoopInterval(task.intervalMs)}` : `adaptive ${formatLoopInterval(task.intervalMs)}`)} ${faint(`| ${formatLoopDue(task.nextRunAt)} | ${loopPromptPreview(task.prompt, 54)}`)}`,
          ),
          `  ${faint("/loop cancel <id> | /loop clear | Esc stops the newest loop")}`,
        ].join("\n"),
      );
      return;
    }

    if (["cancel", "stop", "off", "delete", "rm"].includes(operation)) {
      const result = this.ctx.engine.cancelLoopTask(this.ctx.sessionId, tokens[1]);
      if (!result.ok || !result.task) {
        this.print(
          `  ${danger(glyph("failure"))} ${muted(result.error ?? "Could not stop that loop.")}`,
        );
      } else {
        this.print(
          `  ${danger(glyph("failure"))} ${muted("stopped loop")} ${info(result.task.id)} ${faint(loopPromptPreview(result.task.prompt, 58))}`,
        );
      }
      return;
    }

    if (["clear", "cancel-all", "stop-all"].includes(operation)) {
      const count = this.ctx.engine.clearLoopTasks(this.ctx.sessionId);
      this.print(
        count > 0
          ? `  ${danger(glyph("failure"))} ${muted(`stopped ${count} ${count === 1 ? "loop" : "loops"}`)}`
          : `  ${muted("No loops are active in this session.")}`,
      );
      return;
    }

    if (operation === "help") {
      this.print(
        [
          `  ${bold(text("Loop mode"))}`,
          `    ${info("/loop 5m check the deploy")} ${faint("fixed interval")}`,
          `    ${info("/loop check CI and review comments")} ${faint("adaptive 1-60m cadence")}`,
          `    ${info("/loop")} ${faint("built-in maintenance prompt, or .gear/loop.md")}`,
          `    ${info("/loops")} ${faint("list active tasks")}`,
          `    ${info("/loop cancel <id>")} ${faint("stop one | /loop clear stops all")}`,
        ].join("\n"),
      );
      return;
    }

    try {
      const result = this.ctx.engine.scheduleLoop(this.ctx.sessionId, arg);
      const task = result.task;
      const cadence =
        task.cadence === "fixed"
          ? `every ${formatLoopInterval(task.intervalMs)}`
          : `adaptive | first check ${formatLoopDue(task.nextRunAt)}`;
      this.print(
        [
          `  ${ok(glyph("verified"))} ${text("loop scheduled")} ${info(task.id)} ${faint(`| ${cadence} | expires in 7d`)}`,
          `    ${faint(glyph("gutter"))} ${muted(loopPromptPreview(task.prompt, Math.max(36, cols() - 10)))}`,
          ...(result.promptPath ? [`    ${faint(`prompt: ${result.promptPath}`)}`] : []),
          ...result.warnings.map((warning) => `    ${warn(glyph("observed"))} ${muted(warning)}`),
        ].join("\n"),
      );
    } catch (error) {
      this.print(
        `  ${danger(glyph("failure"))} ${muted(error instanceof Error ? error.message : String(error))}`,
      );
    }
  }

  private modelPresets(reg: string[]): { provider: string; model: string; label: string }[] {
    // Data-driven from the provider presets: every registered provider with a
    // curated `models` list contributes its models, so adding a provider is a
    // one-line preset edit -- no picker code to touch. Local runtimes (ollama /
    // lmstudio) are listed even when not yet active so they're discoverable --
    // picking one switches to it. Free-form `/model <provider>/<id>` still works.
    const localIds = PROVIDER_PRESETS.filter((p) => p.local).map((p) => p.id);
    const ids = [...reg, ...localIds.filter((id) => !reg.includes(id))];
    const out: { provider: string; model: string; label: string }[] = [];
    for (const id of ids) {
      const preset = getPreset(id);
      if (!preset?.models?.length) continue;
      for (const m of preset.models) out.push({ provider: id, model: m.id, label: m.label });
    }
    return out;
  }

  /** v2 picker chips: provider name, plus real free/local markers from the presets. */
  private modelTags(p: { provider: string; model: string; label: string }): string[] {
    const tags: string[] = [];
    const preset = getPreset(p.provider);
    if (preset?.local) tags.push("local");
    if (/:free$/i.test(p.model) || /\(free\)/i.test(p.label) || /\bfree\b/i.test(p.label)) {
      tags.push("free");
    }
    tags.push(p.provider);
    return tags;
  }

  /** Switch provider/model for this session; `asDefault` also persists it as the startup default. */
  private applyModelSwitch(prov: string, model: string, asDefault: boolean): void {
    const engine = this.ctx.engine;
    engine.switchModel(model, prov as any, this.ctx.sessionId);
    const now = `${engine.getProvider()}/${engine.getModel()}`;
    // Switching model IS the decision. Asking the user to confirm it a second
    // time, with a different key in a different place, meant the next session
    // opened on the model they had already rejected — so a plain pick persists
    // now, and `asDefault` only changes how loudly it says so.
    saveLastModel({ provider: engine.getProvider(), model: engine.getModel() });
    this.print(
      asDefault
        ? `  ${accent(glyph("phase"))} ${muted("default set --")} ${info(now)} ${faint("(used at startup)")}`
        : `  ${ok(glyph("verified"))} ${muted("switched to")} ${info(now)} ${faint("| kept for new sessions too")}`,
    );
  }

  /**
   * The /model tree: providers -> accounts/endpoints -> models.
   * Level 1 lists only configured providers (plus local runtimes); level 2 the
   * real access paths for the chosen one (skipped when there is just one);
   * level 3 the models under that account -- live-listed for local runtimes.
   * enter switches this session; `d` also makes the pick the startup default.
   */
  private async modelTree(): Promise<void> {
    const engine = this.ctx.engine;
    const rows = engine.getProviderStatus();
    const customEp = engine.getCustomEndpoint();
    const current = { provider: String(engine.getProvider()), model: engine.getModel() };
    const def = loadLastModel();
    const defNote = def ? ` | default ${def.provider}/${def.model}` : "";

    // -- Level 1: providers --
    const provs = providerChoices(rows, customEp, process.env, getPreset);
    const typeItem: PickerItem = { label: "Type provider/model...", hint: "anything not listed" };
    const l1: PickerItem[] = [
      ...provs.map((p) => ({
        label: p.label,
        hint: stripAnsi(p.hint),
        current: p.id === current.provider,
        tags: p.local ? ["local"] : [],
      })),
      typeItem,
    ];
    const l1start = Math.max(
      0,
      provs.findIndex((p) => p.id === current.provider),
    );
    const a1 = await this.pick(
      `Model | current ${current.provider}/${current.model}${defNote}`,
      l1,
      l1start,
      undefined,
      provs.length
        ? "subscriptions (Claude Pro/Max | ChatGPT | Copilot): gear login | keys: /keys"
        : "no providers configured yet -- add a key with /keys or sign in with gear login",
    );
    if (a1 == null) return;
    if (a1 >= provs.length) {
      const typed = await this.promptLine("provider/model");
      if (!typed) return;
      const si = typed.indexOf("/");
      if (si <= 0) {
        this.print(`  ${warn("Use the form")} ${info("provider/model")}`);
        return;
      }
      this.applyModelSwitch(typed.slice(0, si), typed.slice(si + 1), false);
      return;
    }
    const chosen = provs[a1]!;
    const row = rows.find((r) => r.id === chosen.id)!;
    const preset = getPreset(chosen.id);
    const accounts = accountChoices(preset, row, customEp, process.env);

    // -- Level 2: accounts / endpoints (skipped when only one path) --
    let account = accounts[0];
    if (accounts.length > 1) {
      const l2: PickerItem[] = [
        ...accounts.map((ac) => ({
          label: ac.label,
          hint: ac.detail,
          current: ac.active === true,
        })),
        { label: "Back", hint: "choose another provider" },
      ];
      const a2 = await this.pick(
        `Model | ${chosen.label} | account`,
        l2,
        Math.max(
          0,
          accounts.findIndex((ac) => ac.active),
        ),
        undefined,
        "the selected credential becomes the active one for this provider",
      );
      if (a2 == null) return;
      if (a2 >= accounts.length) return this.modelTree();
      account = accounts[a2];
      if (account?.kind === "key" && account.entryId && !account.active) {
        // Picking a pooled key makes it the ACTIVE key -- persisted and applied
        // to the live gateway, same as the /keys manager.
        const file = persistSetActiveKey(chosen.id, account.entryId);
        engine.setProviderKeys(
          chosen.id,
          readProviderKeyEntries(file, chosen.id),
          file.activeKeyId?.[chosen.id],
          this.ctx.sessionId,
        );
        this.print(
          `  ${ok(glyph("verified"))} ${muted("active key now")} ${text(account.label)} ${faint(account.detail)}`,
        );
      }
      if (row.source === "oauth" || row.source === "keychain") {
        if (account?.kind === "key" || account?.kind === "env") {
          this.print(
            `  ${faint(`note: the signed-in ${row.source} credential wins on the wire --`)} ${info(`gear logout ${chosen.id}`)} ${faint("to use API keys")}`,
          );
        }
      } else if (account?.kind === "env" && accounts.some((x) => x.kind === "key")) {
        this.print(
          `  ${faint("note: the saved key wins on the wire --")} ${info(`/keys clear ${chosen.id}`)} ${faint("to use the env key")}`,
        );
      }
    }

    // -- Level 3: models under that account --
    let live: string[] | null = null;
    if (preset && (chosen.local || account?.kind === "endpoint")) {
      live = await fetchLiveModels(preset.kind, row.endpoint ?? preset.baseUrl ?? "");
    }
    const models = modelChoices(preset, chosen.id, { live, custom: customEp, current, def });
    const l3: PickerItem[] = [
      ...models.map((m) => ({
        label: m.label,
        hint: m.label !== m.id ? m.id : undefined,
        current: m.current,
        tags: [
          ...(m.isDefault ? ["default"] : []),
          ...(/:free$/i.test(m.id) || /\bfree\b/i.test(m.label) ? ["free"] : []),
          ...(chosen.local ? ["local"] : []),
        ],
      })),
      { label: "Type a model id...", hint: "anything not listed" },
      {
        label: "Back",
        hint: accounts.length > 1 ? "choose another account" : "choose another provider",
      },
    ];
    const crumb =
      accounts.length > 1 && account
        ? `Model | ${chosen.label} | ${account.label.replace("API key | ", "key ")}`
        : `Model | ${chosen.label}`;
    if (chosen.local && !live) {
      this.print(
        `  ${faint(`endpoint ${row.endpoint ?? ""} not reachable -- showing suggestions`)}`,
      );
    }
    const a3 = await this.pickAlt(
      crumb,
      l3,
      Math.max(
        0,
        models.findIndex((m) => m.current),
      ),
      "enter use now (this session) | d = use now and make it the startup default | esc back",
      "d",
    );
    if (a3 == null) return;
    if (a3.index === models.length) {
      const typed = await this.promptLine("model id");
      if (typed) this.applyModelSwitch(chosen.id, typed, a3.alt);
      return;
    }
    if (a3.index > models.length) return this.modelTree();
    const pickM = models[a3.index]!;
    await this.applyModelWithEffort(chosen.id, pickM.id, pickM.label, a3.alt);
  }

  /**
   * Switch the model, then — where the model actually has a depth dial — ask
   * for it in the same breath, with the same keys.
   *
   * Depth used to live behind `/config effort max`, which is the wrong shape
   * twice over: nobody discovers a setting they have to already know the name
   * of, and a person mid-decision about a model should not have to leave the
   * decision to type an incantation. It is a property of the model being
   * chosen, so it is asked for where the model is chosen. Escape keeps
   * whatever was already set — backing out of the depth question must never
   * undo the model switch that already happened.
   */
  private async applyModelWithEffort(
    prov: string,
    model: string,
    label: string,
    asDefault: boolean,
  ): Promise<void> {
    this.applyModelSwitch(prov, model, asDefault);
    const engine = this.ctx.engine;
    const current = engine.getReasoningEffort() as ReasoningEffort;
    const efforts = effortChoices(prov, model, current);
    if (efforts.length === 0) return;

    const items: PickerItem[] = efforts.map((e) => ({
      label: e.label,
      hint: e.hint,
      current: e.current,
    }));
    const picked = await this.pick(
      `Thinking depth | ${label}`,
      items,
      Math.max(
        0,
        efforts.findIndex((e) => e.current),
      ),
      undefined,
      "enter set depth | esc keep " + current,
    );
    if (picked == null) return;
    const chosenEffort = efforts[picked]!.id;
    engine.setReasoningEffort(chosenEffort);
    this.print(
      `  ${ok(glyph("verified"))} ${muted("thinking depth")} ${info(chosenEffort)} ${faint(`| ${efforts[picked]!.hint}`)}`,
    );
  }

  // -- picker mode --

  private pick(
    title: string,
    items: PickerItem[],
    start: number,
    onPreview?: (i: number) => void,
    footnote?: string,
  ): Promise<number | null> {
    return new Promise((resolve) => {
      this.picker = {
        title,
        items,
        sel: Math.max(0, start),
        resolve: (i) => resolve(i),
        onPreview,
        footnote,
      };
      this.mode = "picker";
      this.scheduleDraw();
    });
  }

  /**
   * A picker with a second action key: enter resolves `{ index, alt: false }`,
   * `altKey` resolves `{ index, alt: true }` (the /model tree uses `d` for
   * "use now AND make it the startup default"). esc -> null.
   */
  private pickAlt(
    title: string,
    items: PickerItem[],
    start: number,
    footnote: string,
    altKey: string,
  ): Promise<{ index: number; alt: boolean } | null> {
    return new Promise((resolve) => {
      this.picker = {
        title,
        items,
        sel: Math.max(0, start),
        resolve: (i, alt) => resolve(i == null ? null : { index: i, alt: alt === true }),
        footnote,
        altKey,
      };
      this.mode = "picker";
      this.scheduleDraw();
    });
  }

  private pickerKey(key: Key): void {
    if (!this.picker) return;
    const p = this.picker;
    // onPreview runs before the redraw so the composer renders in the previewed theme.
    if (key.type === "up") {
      p.sel = (p.sel - 1 + p.items.length) % p.items.length;
      p.onPreview?.(p.sel);
      this.scheduleDraw();
    } else if (key.type === "down") {
      p.sel = (p.sel + 1) % p.items.length;
      p.onPreview?.(p.sel);
      this.scheduleDraw();
    } else if (key.type === "char" && /^[1-9]$/.test(key.value)) {
      const picked = Number(key.value) - 1;
      if (picked < p.items.length) this.closePicker(picked);
    } else if (key.type === "char" && p.altKey && key.value.toLowerCase() === p.altKey) {
      this.closePicker(p.sel, true);
    } else if (key.type === "enter") {
      this.closePicker(p.sel);
    } else if (key.type === "esc" || (key.type === "ctrl" && key.name === "c")) {
      this.closePicker(null);
    }
  }

  private closePicker(result: number | null, alt = false): void {
    const p = this.picker;
    this.picker = null;
    this.mode = "input";
    p?.resolve(result, alt); // the resolver (or a following print/redraw) repaints
  }

  // -- ask mode (transient single-line text prompt; used by /research) --

  /**
   * `/login` -- the three-step connect flow.
   *
   * It replaces /providers + /keys as the way in. Those exposed the plumbing
   * and neither answered the only question someone who just installed Gear
   * actually has: how do I connect this? A person who pays for ChatGPT knows
   * that; they do not know the provider is called "codex", that it signs in by
   * OAuth, or why a "provider" and a "key" are two different screens.
   *
   * So it asks what you HAVE (subscription / key / offline), names the products
   * the way you would say them, and runs the provider's own auth strategy --
   * the same one `gear login` uses, so there is one code path for real auth.
   */
  private async openLogin(): Promise<void> {
    const routes = routeChoices();
    const connectedIds = PROVIDER_PRESETS.map((p) => p.id).filter((id) => hasStoredCredential(id));
    this.print(
      [`  ${bold(text("Connect a model"))}`, `  ${faint(connectedSummary(connectedIds))}`].join(
        "\n",
      ),
    );

    const r = await this.pick(
      "Connect | how do you want to sign in?",
      routes.map((c) => ({ label: c.label, hint: c.hint })),
      0,
      undefined,
      "enter choose | esc cancel",
    );
    if (r == null) return;
    const route = routes[r]!;

    const targets = loginTargets(route.id, { connected: (id) => hasStoredCredential(id) });
    if (targets.length === 0) {
      this.print(`  ${faint("nothing to connect on that route")}`);
      return;
    }
    const t = await this.pick(
      `Connect | ${route.label}`,
      targets.map((x) => ({
        label: x.label,
        hint: x.hint,
        current: x.connected,
      })),
      0,
      undefined,
      "enter connect | esc back",
    );
    if (t == null) return;
    const target = targets[t]!;
    await this.runLoginFor(target);
  }

  /** Run one target's real auth strategy and apply the result to this session. */
  private async runLoginFor(target: LoginTarget): Promise<void> {
    const preset = getPreset(target.providerId);
    if (!preset) return;

    // Local runtimes have nothing to authenticate: connecting IS pointing at
    // the endpoint, so confirm reachability instead of asking for a secret.
    if (target.method === "local") {
      this.applyModelSwitch(target.providerId, preset.defaultModel, false);
      this.print(`  ${faint("if it is not running, start it first -")} ${info(target.hint)}`);
      return;
    }

    const strategy = getStrategy(target.method, target.providerId);
    if (!strategy) {
      this.print(`  ${warn("!")} ${muted("that sign-in method is not wired up yet")}`);
      return;
    }

    this.print(`  ${faint("signing in to")} ${info(target.label)}${faint("...")}`);
    try {
      const store = await openCredentialStore();
      const cred = await strategy.authenticate({
        providerId: target.providerId,
        preset,
        store,
        env: process.env,
        baseUrl: preset.baseUrl,
        openBrowser,
        prompt: async (q: string) => (await this.promptLine(q)) ?? "",
        log: (line?: string) => this.print(`  ${faint(line ?? "")}`),
      } as AuthContext);
      const valid = await strategy.validate(
        { providerId: target.providerId, preset, store, env: process.env } as AuthContext,
        cred,
      );
      this.print(
        `  ${ok(glyph("verified"))} ${muted("connected")} ${info(target.label)}${valid ? "" : faint(" (unverified)")}`,
      );
      // A fresh sign-in is almost always what you want to use next -- and this
      // is the moment the choice is unambiguous, so it is made here rather than
      // left as a second errand.
      this.applyModelSwitch(target.providerId, preset.defaultModel, false);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.print(`  ${danger(glyph("failure"))} ${muted("sign-in failed --")} ${faint(message)}`);
    }
  }

  private promptLine(title: string): Promise<string | null> {
    return new Promise((resolve) => {
      this.input = "";
      this.caret = 0;
      this.askState = { resolve, title };
      this.mode = "ask";
      this.scheduleDraw();
    });
  }

  private askKey(key: Key): void {
    if (!this.askState) return;
    const finish = (val: string | null) => {
      const r = this.askState!.resolve;
      this.askState = null;
      this.input = "";
      this.caret = 0;
      this.mode = "input";
      r(val);
    };
    switch (key.type) {
      case "char":
        this.insert(key.value);
        this.scheduleDraw();
        break;
      case "backspace":
        if (this.caret > 0) {
          this.input = this.input.slice(0, this.caret - 1) + this.input.slice(this.caret);
          this.caret--;
          this.scheduleDraw();
        }
        break;
      case "left":
        if (this.caret > 0) {
          this.caret--;
          this.scheduleDraw();
        }
        break;
      case "right":
        if (this.caret < this.input.length) {
          this.caret++;
          this.scheduleDraw();
        }
        break;
      case "enter":
        finish(this.input);
        break;
      case "esc":
        finish(null);
        break;
      case "ctrl":
        if (key.name === "c") finish(null);
        break;
    }
  }

  // -- sessions manager (`/sessions`) --

  /** A compact "2h ago" style age for the session list. */
  private relTime(iso: string): string {
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return "";
    const s = Math.max(0, Math.floor((Date.now() - then) / 1000));
    if (s < 45) return "just now";
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    if (d < 7) return `${d}d ago`;
    const w = Math.floor(d / 7);
    if (w < 5) return `${w}w ago`;
    const mo = Math.floor(d / 30);
    if (mo < 12) return `${mo}mo ago`;
    return `${Math.floor(d / 365)}y ago`;
  }

  private shortId(id: string): string {
    return id.slice(0, 8);
  }

  private sessionGroup(iso: string): string {
    return sessionGroupLabel(iso, new Date(), { withDate: true });
  }

  /** Permanently discard only untouched, unnamed launch placeholders. */
  private discardSessionIfEmpty(id: string): void {
    const session = this.ctx.engine.getSessionInfo(id);
    if (!session || session.eventCount > 0 || session.title?.trim()) return;
    try {
      this.ctx.engine.purgeSession(id);
    } catch {
      // Cleanup is best-effort; it must never prevent exit or resume.
    }
  }

  private sessionRowView(s: SessionListItem): SessionRowView {
    const title = s.title && s.title.trim() ? s.title.trim() : "untitled";
    const parts = [s.model];
    if (s.eventCount > 0) parts.push(`${s.eventCount} events`);
    if (s.lastTokens && s.lastTokens > 0) parts.push(`${fmtTokens(s.lastTokens)} tokens`);
    return {
      id: s.id,
      title,
      meta: parts.filter(Boolean).join(" | "),
      model: s.model,
      events: s.eventCount,
      tokens: s.lastTokens ?? undefined,
      workspace: s.workspaceRoot,
      updatedAt: s.updatedAt,
      group: this.sessionGroup(s.updatedAt),
      current: s.id === this.ctx.sessionId,
    };
  }

  private filteredSessions(view: "active" | "archived"): SessionListItem[] {
    const all = this.ctx.engine
      .listSessions({ status: view })
      .filter((session) => session.id === this.ctx.sessionId || isMeaningfulSession(session));
    const query = this.sessionsQuery.trim().toLowerCase();
    if (!query) return all;
    return all.filter((session) =>
      [
        session.id,
        session.title ?? "",
        session.workspaceRoot,
        session.model,
        session.provider ?? "",
      ]
        .join(" ")
        .toLowerCase()
        .includes(query),
    );
  }

  private openSessions(view: "active" | "archived" = "active"): void {
    if (this.mode !== "sessions") {
      this.sessionsQuery = "";
      this.sessionsSearching = false;
    }
    this.sessionsView = view;
    this.sessionsPendingDelete = null;
    this.sessionsList = this.filteredSessions(view);
    const cur = this.sessionsList.findIndex((s) => s.id === this.ctx.sessionId);
    this.sessionsSel = cur >= 0 ? cur : 0;
    this.mode = "sessions";
    this.scheduleDraw();
  }

  /** Reload the list for the current view after a mutation, keeping the cursor in range. */
  private refreshSessions(): void {
    this.sessionsList = this.filteredSessions(this.sessionsView);
    if (this.sessionsSel >= this.sessionsList.length) {
      this.sessionsSel = Math.max(0, this.sessionsList.length - 1);
    }
    this.scheduleDraw();
  }

  private closeSessions(): void {
    this.sessionsPendingDelete = null;
    this.sessionsSearching = false;
    this.mode = "input";
    this.scheduleDraw();
  }

  private sessionsKey(key: Key): void {
    const n = this.sessionsList.length;
    if (key.type === "ctrl" && key.name === "n") {
      this.startNewSession();
      return;
    }
    if (key.type === "ctrl" && key.name === "d") {
      this.deleteSelected();
      return;
    }
    if (this.sessionsSearching) {
      if (key.type === "char") {
        this.sessionsQuery += key.value;
        this.sessionsSel = 0;
        this.refreshSessions();
        return;
      }
      if (key.type === "backspace") {
        this.sessionsQuery = this.sessionsQuery.slice(0, -1);
        this.sessionsSel = 0;
        this.refreshSessions();
        return;
      }
      if (key.type === "esc") {
        this.sessionsSearching = false;
        this.scheduleDraw();
        return;
      }
    } else if (key.type === "char" && key.value === "/") {
      this.sessionsSearching = true;
      this.scheduleDraw();
      return;
    }
    // Any navigation/action other than a confirming second 'd' disarms a pending delete.
    const disarm = () => {
      if (this.sessionsPendingDelete) this.sessionsPendingDelete = null;
    };
    switch (key.type) {
      case "up":
        disarm();
        if (n) {
          this.sessionsSel = (this.sessionsSel - 1 + n) % n;
          this.scheduleDraw();
        }
        break;
      case "down":
        disarm();
        if (n) {
          this.sessionsSel = (this.sessionsSel + 1) % n;
          this.scheduleDraw();
        }
        break;
      case "tab":
        this.openSessions(this.sessionsView === "active" ? "archived" : "active");
        break;
      case "enter":
        disarm();
        this.resumeSelected();
        break;
      case "char": {
        const c = key.value.toLowerCase();
        if (c === "d") {
          this.deleteSelected();
          break;
        }
        disarm();
        if (c === "r" && this.sessionsView === "active") void this.renameSelected();
        else if (c === "a" && this.sessionsView === "active") this.archiveSelected();
        else if (c === "u" && this.sessionsView === "archived") this.restoreSelected();
        else this.scheduleDraw();
        break;
      }
      case "esc":
        this.closeSessions();
        break;
      case "ctrl":
        if (key.name === "c") this.closeSessions();
        break;
    }
  }

  private startNewSession(): void {
    const previous = this.ctx.sessionId;
    const next = this.ctx.engine.createSession();
    this.ctx.sessionId = next;
    if (previous !== next) this.discardSessionIfEmpty(previous);
    this.sessionsPendingDelete = null;
    this.sessionsSearching = false;
    this.sessionsQuery = "";
    this.mode = "input";
    this.resetTranscript();
    this.print(`  ${ok(glyph("verified"))} ${muted("started a new session")}`);
  }

  /** Load the selected session's history into the transcript and continue it. */
  private resumeSelected(): void {
    const s = this.sessionsList[this.sessionsSel];
    if (!s) {
      this.closeSessions();
      return;
    }
    // Already the live session -- nothing to reload.
    if (s.id === this.ctx.sessionId && this.sessionsView === "active") {
      this.closeSessions();
      return;
    }
    const res = this.ctx.engine.resumeSession(s.id);
    this.mode = "input";
    this.sessionsPendingDelete = null;
    if (!res) {
      this.print(`  ${danger(glyph("failure"))} ${muted("could not open that session")}`);
      return;
    }
    this.replayTranscript(s.id, s, res);
  }

  private replayTranscript(
    id: string,
    s: SessionListItem,
    res: { switched: boolean; providerKnown: boolean },
  ): void {
    const lines = this.ctx.engine.getTranscript(id);
    const previous = this.ctx.sessionId;
    this.ctx.sessionId = id; // set before resetTranscript so the reprinted banner shows this session
    if (previous !== id) this.discardSessionIfEmpty(previous);
    this.resetTranscript();

    const title = s.title && s.title.trim() ? s.title.trim() : "untitled";
    this.print(
      `  ${faint("--")} ${muted("resumed")} ${text(title)} ${faint(this.shortId(id))} ${faint("--")}`,
    );
    this.printTranscriptLines(lines);
    if (lines.length === 0) this.print(`  ${faint("(no earlier messages)")}`);

    if (res.switched) {
      this.print(
        `  ${ok(glyph("verified"))} ${muted("model")} ${info(`${this.ctx.engine.getProvider()}/${this.ctx.engine.getModel()}`)}`,
      );
    } else if (!res.providerKnown) {
      this.print(
        `  ${warn(glyph("observed"))} ${muted("couldn't detect this session's provider --")} ${info("/model")} ${muted("if replies look off")}`,
      );
    }
    this.print(`  ${faint("continue where you left off down")}`);
  }

  /** Render replayed history lines into the transcript (shared by resume + startup seeding).
   *  Uses the same two-partition renderer as a live turn so a resumed session is faithful:
   *  work inside the rail, each turn's final answer outside it. */
  private printTranscriptLines(lines: TranscriptLine[]): void {
    if (lines.length === 0) return;
    this.print(renderReplay(lines));
  }

  /**
   * On launch, if the session already has history (started with `--resume` /
   * `gear resume`), replay it into the viewport so the user lands where they left
   * off instead of on a blank screen.
   */
  private seedFromHistory(): void {
    const lines = this.ctx.engine.getTranscript(this.ctx.sessionId);
    if (lines.length === 0) return;
    const info = this.ctx.engine.getSessionInfo(this.ctx.sessionId);
    const title = info?.title?.trim() || "untitled";
    this.print(
      `  ${faint("--")} ${muted("resumed")} ${text(title)} ${faint(this.shortId(this.ctx.sessionId))} ${faint("--")}`,
    );
    this.printTranscriptLines(lines);
    this.print(`  ${faint("continue where you left off down")}`);
  }

  /**
   * Launch flow: started without a target session but prior work exists -> offer a
   * compact "resume a session" picker (Enter / Esc / "new" = keep the fresh
   * session). Picking an older session loads it and discards the throwaway session
   * we created to land in, so launches never litter the history.
   */
  private async runLaunchPicker(): Promise<void> {
    const fresh = this.ctx.sessionId;
    const recent = this.ctx.engine
      .listSessions({ status: "active" })
      .filter((s) => s.id !== fresh && isMeaningfulSession(s))
      .slice(0, 12);
    if (recent.length === 0) return; // nothing to resume -- stay in the fresh session

    const items: PickerItem[] = [
      { label: "*  Start a new session", hint: "fresh start" },
      ...recent.map((s) => {
        const v = this.sessionRowView(s);
        return { label: v.title, hint: v.meta };
      }),
    ];
    const i = await this.pick("Resume a session", items, 0);
    if (i == null || i === 0) return; // Esc or "new" -> keep the fresh session

    const s = recent[i - 1];
    if (!s) return;
    const res = this.ctx.engine.resumeSession(s.id);
    if (!res) {
      this.print(`  ${danger(glyph("failure"))} ${muted("could not open that session")}`);
      return;
    }
    this.replayTranscript(s.id, s, res);
  }

  private async renameSelected(): Promise<void> {
    const s = this.sessionsList[this.sessionsSel];
    if (!s) return;
    const current = s.title && s.title.trim() ? s.title.trim() : "untitled";
    const name = await this.promptLine(`Rename "${current}" ->`);
    if (name != null && name.trim()) this.ctx.engine.renameSession(s.id, name.trim());
    // promptLine returns us to "input" mode -- re-open the manager on the same row.
    this.openSessions(this.sessionsView);
    const idx = this.sessionsList.findIndex((x) => x.id === s.id);
    if (idx >= 0) this.sessionsSel = idx;
    this.scheduleDraw();
  }

  private archiveSelected(): void {
    const s = this.sessionsList[this.sessionsSel];
    if (!s) return;
    this.ctx.engine.archiveSession(s.id);
    this.print(
      `  ${ok(glyph("verified"))} ${muted("archived")} ${faint(s.title?.trim() || "untitled")}`,
    );
    // Archiving the live session would orphan chat() (getSession rejects non-active) -- land in a fresh one.
    if (s.id === this.ctx.sessionId) {
      this.ctx.sessionId = this.ctx.engine.createSession();
      this.resetTranscript();
      this.print(`  ${faint("started a new session")}`);
    }
    this.refreshSessions();
  }

  private restoreSelected(): void {
    const s = this.sessionsList[this.sessionsSel];
    if (!s) return;
    this.ctx.engine.restoreSession(s.id);
    this.print(
      `  ${ok(glyph("verified"))} ${muted("restored")} ${faint(s.title?.trim() || "untitled")}`,
    );
    this.refreshSessions();
  }

  /** Two-step delete: the first 'd' arms (footer shows a confirm); the second deletes. */
  private deleteSelected(): void {
    const s = this.sessionsList[this.sessionsSel];
    if (!s) return;
    if (this.sessionsPendingDelete !== s.id) {
      this.sessionsPendingDelete = s.id;
      this.scheduleDraw();
      return;
    }
    this.sessionsPendingDelete = null;
    this.ctx.engine.deleteSession(s.id);
    this.print(
      `  ${ok(glyph("verified"))} ${muted("deleted")} ${faint(s.title?.trim() || "untitled")} ${faint("| recoverable until purged")}`,
    );
    // Deleting the live session would orphan chat() -- open a fresh one to land in.
    if (s.id === this.ctx.sessionId) {
      this.ctx.sessionId = this.ctx.engine.createSession();
      this.resetTranscript();
      this.print(`  ${faint("started a new session")}`);
    }
    this.refreshSessions();
  }

  // -- keys mode (BYOK API keys) --

  // -- memory panel (`/memory`) --

  private openMemory(): void {
    this.memorySel = 0;
    this.memoryBusy = false;
    this.memoryNote = null;
    this.memoryPendingClear = false;
    this.mode = "memory";
    this.scheduleDraw();
  }

  private closeMemory(): void {
    this.memoryPendingClear = false;
    this.memoryNote = null;
    this.mode = "input";
    this.scheduleDraw();
  }

  private memoryKey(key: Key): void {
    // While a dream runs, only esc/ctrl-c (leave) are honoured.
    if (this.memoryBusy) {
      if (key.type === "esc" || (key.type === "ctrl" && key.name === "c")) this.closeMemory();
      return;
    }
    const n = MEMORY_ACTION_COUNT;
    switch (key.type) {
      case "up":
        this.memorySel = (this.memorySel - 1 + n) % n;
        this.memoryPendingClear = false;
        this.scheduleDraw();
        break;
      case "down":
        this.memorySel = (this.memorySel + 1) % n;
        this.memoryPendingClear = false;
        this.scheduleDraw();
        break;
      case "enter":
        void this.memoryRunAction(this.memorySel);
        break;
      case "esc":
        this.closeMemory();
        break;
      case "ctrl":
        if (key.name === "c") this.closeMemory();
        break;
      case "char": {
        const c = key.value.toLowerCase();
        if (c === "r") void this.memoryRunAction(0);
        else if (c === "c") void this.memoryRunAction(1);
        else if (c === "a") void this.memoryRunAction(2);
        else if (c === "e") void this.memoryRunAction(3);
        else if (c === "x" || c === "d") void this.memoryRunAction(4);
        else if (c === "q") this.closeMemory();
        break;
      }
    }
  }

  private async memoryRunAction(action: number): Promise<void> {
    // Any action other than (re)pressing Clear disarms the clear confirmation.
    if (action !== 4) this.memoryPendingClear = false;
    switch (action) {
      case 0:
        await this.memoryRefresh();
        break;
      case 1:
        this.memoryCycleCadence();
        break;
      case 2:
        await this.memoryAddNote();
        break;
      case 3:
        await this.editMemoryInEditor();
        break;
      case 4:
        this.memoryClear();
        break;
    }
  }

  private async memoryRefresh(): Promise<void> {
    this.memorySel = 0;
    this.memoryNote = null;
    this.memoryBusy = true;
    this.scheduleDraw();
    let res: Awaited<ReturnType<typeof this.ctx.engine.reflectSystemMemory>>;
    try {
      res = await this.ctx.engine.reflectSystemMemory({ trigger: "manual" });
    } finally {
      this.memoryBusy = false;
    }
    this.memoryNote = res.updated
      ? `refreshed | ~${res.tokensAfter} tokens`
      : `unchanged -- ${res.reason}`;
    this.scheduleDraw();
  }

  private memoryCycleCadence(): void {
    const order = ["manual", "daily", "3d", "weekly"];
    const label = this.ctx.engine.getSystemMemory().scheduleLabel;
    const curToken =
      label === "daily"
        ? "daily"
        : label === "weekly"
          ? "weekly"
          : label === "every 3 days"
            ? "3d"
            : "manual";
    const next = order[(order.indexOf(curToken) + 1) % order.length]!;
    const r = this.ctx.engine.setSystemMemorySchedule(next);
    this.memorySel = 1;
    this.memoryNote = r.label === "manual" ? "auto-update off (manual)" : `auto-update ${r.label}`;
    this.scheduleDraw();
  }

  private async memoryAddNote(): Promise<void> {
    // promptLine switches to "ask" mode and resolves on Enter/Esc; then we return.
    const note = await this.promptLine("Add a note to your memory");
    if (note && note.trim()) {
      this.ctx.engine.appendSystemMemoryNote(note.trim());
      this.memoryNote = "note added";
    }
    this.memorySel = 2;
    this.mode = "memory";
    this.scheduleDraw();
  }

  private memoryClear(): void {
    // Two-step confirm, mirroring the /sessions delete arm.
    if (!this.memoryPendingClear) {
      this.memoryPendingClear = true;
      this.memorySel = 4;
      this.scheduleDraw();
      return;
    }
    this.ctx.engine.clearSystemMemory();
    this.memoryPendingClear = false;
    this.memoryNote = "memory cleared";
    this.scheduleDraw();
  }

  /**
   * Suspend the TUI (leave raw mode + alt-screen/inline, hand the terminal to the
   * child), open the profile in $EDITOR, then restore the TUI and fold the edits
   * back in. The genuine in-app edit path -- no "go use classic mode" punt.
   */
  private async editMemoryInEditor(): Promise<void> {
    const { engine } = this.ctx;
    const path = getSystemMemoryPath();
    if (!engine.getSystemMemory().content.trim()) {
      engine.setSystemMemoryContent(
        "# About me\n- \n\n## How I like to work\n- \n\n## My codebases\n- \n\n## Notes\n",
      );
    }
    const editor = process.env.VISUAL || process.env.EDITOR || "nano";
    const stdin = process.stdin;

    // -- suspend --
    if (this.drawTimer) {
      clearTimeout(this.drawTimer);
      this.drawTimer = null;
    }
    process.stdout.write("\x1b[?2004l"); // bracketed paste off
    // Hand the whole terminal back: $EDITOR takes the alternate screen itself,
    // and two programs on one alternate screen is one program with a corrupt one.
    this.leaveSurface();
    process.stdout.write(TERMINAL_THEME_RESET);
    if (stdin.isTTY) stdin.setRawMode(false);
    stdin.pause();
    process.stdout.write("\x1b[?25h"); // show cursor for the editor
    delete process.env.GEAR_TUI_ACTIVE; // the editor owns the terminal now

    let okEdit = true;
    try {
      const { spawnSync } = require("node:child_process");
      const r = spawnSync(editor, [path], { stdio: "inherit" });
      if (r?.error) okEdit = false;
    } catch {
      okEdit = false;
    }

    // -- resume --
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    process.stdout.write("\x1b[?2004h");
    process.env.GEAR_TUI_ACTIVE = "1";
    this.enterSurface();

    if (okEdit) {
      try {
        const { readFileSync } = require("fs");
        const res = engine.setSystemMemoryContent(readFileSync(path, "utf-8"));
        this.memoryNote = `saved | ~${res.tokens} tokens`;
      } catch {
        this.memoryNote = "no changes";
      }
    } else {
      this.memoryNote = `couldn't open ${editor}`;
    }
    this.memorySel = 3;
    this.mode = "memory";
    this.scheduleDraw();
  }

  private openKeys(): void {
    this.keysRows = this.buildKeyRows();
    this.keysSel = 0;
    this.keysEdit = null;
    this.keysManage = null;
    this.mode = "keys";
    this.scheduleDraw();
  }

  private buildKeyRows(): KeyRow[] {
    // getProviderStatus() returns a superset of KeyRow (adds hasKey + pools).
    return this.ctx.engine.getProviderStatus();
  }

  private closeKeys(): void {
    this.keysEdit = null;
    this.keysManage = null;
    this.mode = "input";
    this.scheduleDraw();
  }

  private keysKey(key: Key): void {
    if (this.keysEdit) {
      this.keysEditKey(key);
      return;
    }
    if (this.keysManage) {
      this.keysManageKey(key);
      return;
    }
    const n = this.keysRows.length;
    if (n === 0) {
      if (key.type === "esc") this.closeKeys();
      return;
    }
    switch (key.type) {
      case "up":
        this.keysSel = (this.keysSel - 1 + n) % n;
        this.scheduleDraw();
        break;
      case "down":
        this.keysSel = (this.keysSel + 1) % n;
        this.scheduleDraw();
        break;
      case "enter": {
        // Cloud providers open the multi-key manager; local runtimes and the
        // custom endpoint keep their single base-URL/key edit flow.
        const row = this.keysRows[this.keysSel];
        if (row && !row.local && row.id !== CUSTOM_PROVIDER_ID) this.openKeyManager(row);
        else this.startKeyEdit();
        break;
      }
      case "delete":
        this.clearSelectedKey();
        break;
      case "char":
        if (key.value === " ") this.toggleSelected();
        else if (key.value === "d" || key.value === "D") this.clearSelectedKey();
        break;
      case "esc":
        this.closeKeys();
        break;
      case "ctrl":
        if (key.name === "c") this.closeKeys();
        break;
    }
  }

  /** Open the per-provider key manager for the selected cloud provider. */
  private openKeyManager(row: KeyRow): void {
    this.keysManage = { id: row.id, label: row.label, sel: 0 };
    this.scheduleDraw();
  }

  private keysManageKey(key: Key): void {
    const mgr = this.keysManage;
    if (!mgr) return;
    const row = this.keysRows.find((r) => r.id === mgr.id);
    const rows = row?.savedKeys ?? [];
    const n = rows.length;
    switch (key.type) {
      case "up":
        if (n) mgr.sel = (mgr.sel - 1 + n) % n;
        this.scheduleDraw();
        break;
      case "down":
        if (n) mgr.sel = (mgr.sel + 1) % n;
        this.scheduleDraw();
        break;
      case "enter":
        // On an empty pool, enter adds the first key; otherwise it activates.
        if (n === 0) this.startKeyAdd(mgr);
        else this.setActiveManagedKey(rows[mgr.sel]!.id);
        break;
      case "delete":
        if (n) this.removeManagedKey(rows[mgr.sel]!.id);
        break;
      case "char":
        if (key.value === "a" || key.value === "A") this.startKeyAdd(mgr);
        else if (key.value === " ") {
          if (n) this.setActiveManagedKey(rows[mgr.sel]!.id);
        } else if (key.value === "d" || key.value === "D") {
          if (n) this.removeManagedKey(rows[mgr.sel]!.id);
        }
        break;
      case "esc":
        this.keysManage = null;
        this.scheduleDraw();
        break;
      case "ctrl":
        if (key.name === "c") {
          this.keysManage = null;
          this.scheduleDraw();
        }
        break;
    }
  }

  /** Begin adding a NEW key to a provider's pool (append, not replace). */
  private startKeyAdd(mgr: { id: string; label: string }): void {
    const preset = getPreset(mgr.id);
    this.keysEdit = {
      id: mgr.id,
      label: mgr.label,
      field: "key",
      value: "",
      caret: 0,
      masked: true,
      mode: "add",
      pending: {},
      title: `Add API key -- ${mgr.label}`,
      subtitle: preset?.docsUrl ? `paste a key from any account | ${preset.docsUrl}` : undefined,
    };
    this.scheduleDraw();
  }

  /** Make one pooled key active (the one the gateway uses), persist + apply live. */
  private setActiveManagedKey(entryId: string): void {
    const mgr = this.keysManage;
    if (!mgr) return;
    const file = persistSetActiveKey(mgr.id, entryId);
    const res = this.ctx.engine.setProviderKeys(
      mgr.id,
      readProviderKeyEntries(file, mgr.id),
      file.activeKeyId?.[mgr.id],
      this.ctx.sessionId,
    );
    this.noteForcedSwitch(res);
    this.keysRows = this.buildKeyRows();
    this.scheduleDraw();
  }

  /** Remove one pooled key, persist + apply live, and keep the cursor in range. */
  private removeManagedKey(entryId: string): void {
    const mgr = this.keysManage;
    if (!mgr) return;
    const file = persistRemoveKey(mgr.id, entryId);
    const res = this.ctx.engine.setProviderKeys(
      mgr.id,
      readProviderKeyEntries(file, mgr.id),
      file.activeKeyId?.[mgr.id],
      this.ctx.sessionId,
    );
    this.noteForcedSwitch(res);
    this.keysRows = this.buildKeyRows();
    const remaining = this.keysRows.find((r) => r.id === mgr.id)?.savedKeys?.length ?? 0;
    mgr.sel = Math.max(0, Math.min(mgr.sel, remaining - 1));
    this.scheduleDraw();
  }

  private startKeyEdit(): void {
    const row = this.keysRows[this.keysSel];
    if (!row) return;
    const localPreset = getPreset(row.id);
    if (row.id === CUSTOM_PROVIDER_ID) {
      // Walk base URL -> model -> key for the user-defined endpoint.
      const c = this.ctx.engine.getCustomEndpoint();
      const base = c?.baseUrl ?? "https://";
      this.keysEdit = {
        id: CUSTOM_PROVIDER_ID,
        label: row.label,
        field: "baseUrl",
        value: base,
        caret: base.length,
        masked: false,
        pending: {},
        title: "Custom endpoint -- base URL",
        subtitle: "OpenAI-compatible /v1 base URL",
      };
    } else if (localPreset?.local) {
      // Local runtime: a single base-URL field, no key.
      const cur = this.ctx.engine.getLocalEndpoint(row.id) ?? localPreset.baseUrl ?? "http://";
      this.keysEdit = {
        id: row.id,
        label: row.label,
        field: "baseUrl",
        value: cur,
        caret: cur.length,
        masked: false,
        pending: {},
        title: `${row.label} -- base URL`,
        subtitle: "local server URL | no API key needed | empty resets to default",
      };
    } else {
      const preset = getPreset(row.id);
      this.keysEdit = {
        id: row.id,
        label: row.label,
        field: "key",
        value: "",
        caret: 0,
        masked: true,
        pending: {},
        title: `Paste API key -- ${row.label}`,
        subtitle: preset?.docsUrl ? `get one at ${preset.docsUrl}` : undefined,
      };
    }
    this.scheduleDraw();
  }

  private keysEditKey(key: Key): void {
    const e = this.keysEdit;
    if (!e) return;
    switch (key.type) {
      case "char":
        e.value = e.value.slice(0, e.caret) + key.value + e.value.slice(e.caret);
        e.caret += key.value.length;
        this.scheduleDraw();
        break;
      case "backspace":
        if (e.caret > 0) {
          e.value = e.value.slice(0, e.caret - 1) + e.value.slice(e.caret);
          e.caret--;
          this.scheduleDraw();
        }
        break;
      case "delete":
        if (e.caret < e.value.length) {
          e.value = e.value.slice(0, e.caret) + e.value.slice(e.caret + 1);
          this.scheduleDraw();
        }
        break;
      case "left":
        if (e.caret > 0) {
          e.caret--;
          this.scheduleDraw();
        }
        break;
      case "right":
        if (e.caret < e.value.length) {
          e.caret++;
          this.scheduleDraw();
        }
        break;
      case "home":
        e.caret = 0;
        this.scheduleDraw();
        break;
      case "end":
        e.caret = e.value.length;
        this.scheduleDraw();
        break;
      case "enter":
        this.commitKeyEdit();
        break;
      case "esc":
        this.keysEdit = null;
        this.scheduleDraw();
        break;
      case "ctrl":
        if (key.name === "c") {
          this.keysEdit = null;
          this.scheduleDraw();
        }
        break;
    }
  }

  private commitKeyEdit(): void {
    const e = this.keysEdit;
    if (!e) return;
    const val = e.value.trim();
    const { engine } = this.ctx;

    // -- Add a key to a provider's multi-account pool (append, not replace) --
    if (e.mode === "add") {
      if (e.field === "key") {
        if (!val) {
          this.keysEdit = null; // nothing pasted -> back to the manager
          this.scheduleDraw();
          return;
        }
        e.pending.newKey = val;
        e.field = "label";
        e.value = "";
        e.caret = 0;
        e.masked = false;
        e.title = `Label this key -- ${e.label}`;
        e.subtitle = "optional | name the account (e.g. work, personal) | enter to skip";
        this.scheduleDraw();
        return;
      }
      // field === "label" -> commit the add
      const file = persistAddKey(e.id, e.pending.newKey ?? "", val || undefined).file;
      const res = engine.setProviderKeys(
        e.id,
        readProviderKeyEntries(file, e.id),
        file.activeKeyId?.[e.id],
        this.ctx.sessionId,
      );
      this.noteForcedSwitch(res);
      this.keysEdit = null;
      this.keysRows = this.buildKeyRows();
      const count = this.keysRows.find((r) => r.id === e.id)?.savedKeys?.length ?? 0;
      if (this.keysManage?.id === e.id) this.keysManage.sel = Math.max(0, count - 1);
      this.print(
        `  ${ok(glyph("verified"))} ${muted("added key for")} ${info(e.label)}${val ? faint(` | ${val}`) : ""} ${faint(`| ${count} configured`)}`,
      );
      this.scheduleDraw();
      return;
    }

    if (e.id === CUSTOM_PROVIDER_ID) {
      if (e.field === "baseUrl") {
        if (!val) {
          this.keysEdit = null;
          this.scheduleDraw();
          return;
        }
        e.pending.baseUrl = val;
        const def = engine.getCustomEndpoint()?.model ?? "";
        e.field = "model";
        e.value = def;
        e.caret = def.length;
        e.masked = false;
        e.title = "Custom endpoint -- model";
        e.subtitle = "Model id to send (e.g. llama-3.3-70b-versatile)";
        this.scheduleDraw();
        return;
      }
      if (e.field === "model") {
        e.pending.model = val;
        e.field = "key";
        e.value = "";
        e.caret = 0;
        e.masked = true;
        e.title = "Custom endpoint -- API key";
        e.subtitle = undefined;
        this.scheduleDraw();
        return;
      }
      // field === "key" -> commit
      const ep: CustomEndpoint = {
        baseUrl: e.pending.baseUrl ?? "",
        model: e.pending.model ?? "",
        key: val,
      };
      persistCustom(ep);
      engine.setCustomEndpoint(ep);
      this.keysEdit = null;
      this.keysRows = this.buildKeyRows();
      this.print(
        `  ${ok(glyph("verified"))} ${muted("saved custom endpoint")} ${faint(ep.baseUrl)} ${faint("| use /model to switch")}`,
      );
      this.scheduleDraw();
      return;
    }

    // Local runtime: a single base-URL field (empty resets to the default).
    if (getPreset(e.id)?.local) {
      persistLocalEndpoint(e.id, val || undefined);
      engine.setLocalEndpoint(e.id, val || null);
      this.keysEdit = null;
      this.keysRows = this.buildKeyRows();
      const shown = engine.getLocalEndpoint(e.id) ?? "";
      this.print(
        `  ${ok(glyph("verified"))} ${muted(`${e.label} endpoint`)} ${faint(shown)} ${faint("| /model to switch")}`,
      );
      this.scheduleDraw();
      return;
    }

    // Named provider: a single masked key field.
    if (!val) {
      this.keysEdit = null;
      this.scheduleDraw();
      return;
    }
    persistKey(e.id, val);
    engine.setProviderKey(e.id, val);
    this.keysEdit = null;
    this.keysRows = this.buildKeyRows();
    this.print(
      `  ${ok(glyph("verified"))} ${muted("saved key for")} ${info(e.label)} ${faint("| use /model to switch")}`,
    );
    this.scheduleDraw();
  }

  private toggleSelected(): void {
    const row = this.keysRows[this.keysSel];
    if (!row) return;
    const next = !row.disabled;
    persistDisabled(row.id, next);
    const res = this.ctx.engine.setProviderDisabled(row.id, next, this.ctx.sessionId);
    this.noteForcedSwitch(res);
    this.keysRows = this.buildKeyRows();
    this.scheduleDraw();
  }

  private clearSelectedKey(): void {
    const row = this.keysRows[this.keysSel];
    if (!row || row.source !== "saved") return; // only saved keys are ours to clear
    let res: ReturnType<Engine["setProviderKey"]>;
    if (row.id === CUSTOM_PROVIDER_ID) {
      persistClearCustom();
      res = this.ctx.engine.setCustomEndpoint(null, this.ctx.sessionId);
    } else {
      persistClearKey(row.id);
      res = this.ctx.engine.setProviderKey(row.id, null, this.ctx.sessionId);
    }
    this.noteForcedSwitch(res);
    this.keysRows = this.buildKeyRows();
    this.scheduleDraw();
  }

  /** Surface an auto-switch (active provider went away) into the transcript. */
  private noteForcedSwitch(res: { switchedTo?: { provider: string; model: string } }): void {
    if (res.switchedTo) {
      this.print(
        `  ${warn("->")} ${muted("active provider unavailable -- now on")} ${info(`${res.switchedTo.provider}/${res.switchedTo.model}`)}`,
      );
    }
  }

  // -- permission mode --

  private permissionHandler: PermissionHandler = async (prompt) => {
    const preview = await buildPermissionPreview({
      toolName: prompt.toolName,
      argsSummary: prompt.argsSummary,
      rawArgs: prompt.rawArgs,
      workspaceRoot: this.ctx.workspaceRoot,
      safety: prompt.safety,
      exactSessionGrant: prompt.exactSessionGrant,
      sessionGrantUnavailable: prompt.sessionGrantUnavailable,
      rateLimit: prompt.rateLimit,
    });
    return new Promise<UserPermissionDecision>((resolve) => {
      this.perm = {
        resolve,
        toolName: prompt.toolName,
        argsSummary: prompt.argsSummary,
        preview,
        sel: 0,
      };
      this.mode = "permission";
      // Until this resolves the pane is waiting on a person, not working. Warp
      // shows that as its own badge, which is what pulls someone back to a tab
      // they left running.
      this.warpBlocked = true;
      setTitle({ kind: "waiting" }, this.titleProject());
      this.warp("permission_request", {
        toolName: prompt.toolName,
        summary: prompt.argsSummary,
        toolInput: prompt.argsSummary,
      });
      this.scheduleDraw();
    });
  };

  // -- ask_user question mode --

  private questionHandler = (q: {
    question: string;
    options: string[];
    index?: number;
    total?: number;
  }): Promise<string> =>
    new Promise<string>((resolve) => {
      this.questionState = {
        resolve,
        question: q.question,
        options: q.options,
        prevMode: this.mode,
        selected: 0,
        index: q.index,
        total: q.total,
      };
      this.input = "";
      this.caret = 0;
      this.mode = "question";
      this.warpBlocked = true;
      setTitle({ kind: "waiting" }, this.titleProject());
      this.warp("idle_prompt", { summary: q.question });
      // 4th gear asks like every other gear -- the user is usually right here --
      // but must never park an autonomous run on a question nobody answers:
      // after a grace window the picker dismisses itself and the model
      // proceeds on its own judgment, keeping fire-and-forget intact.
      if (this.ctx.engine.getPermissionMode() === "gear-4") {
        this.questionState.autoContinue = true;
        this.questionState.deadline = Date.now() + Tui.QUESTION_AUTO_CONTINUE_MS;
        this.questionState.timer = setTimeout(() => {
          this.finishQuestion(QUESTION_UNANSWERED);
        }, Tui.QUESTION_AUTO_CONTINUE_MS);
      }
      this.scheduleDraw();
    });

  /**
   * The close, printed at the end of any turn that opened a brief.
   *
   * This is the half of the read-back that makes the other half mean something:
   * the same criteria, in the same order, each showing the evidence that moved
   * it — or showing plainly that nothing did. It renders whether or not the
   * turn went well, because a brief that quietly stops being mentioned when the
   * work went badly is worse than no brief at all.
   */
  private printClose(): void {
    const ledger = this.ctx.engine.currentLedger();
    if (!ledger || ledger.total === 0) return;
    this.print(renderClose(ledger));
  }

  /**
   * The read-back, made correctable. The block is committed to scrollback first
   * — it is the contract, and it stands whether or not they answer — and then
   * the same picker that serves ask_user takes the one keystroke that accepts,
   * corrects, or questions it.
   *
   * "edit" and "ask" both come back as NOT accepted with the person's own words
   * attached, which sends the model around to read back again rather than
   * letting it start on a brief nobody agreed to. That loop is the entire
   * mechanism: a misread costs four seconds here instead of a session.
   */
  private briefHandler = async (
    brief: Brief,
  ): Promise<{ accepted: boolean; edited?: Brief; note?: string }> => {
    this.print(renderReadBack(brief));
    const answer = await this.questionHandler({
      question: "Work to this?",
      options: ["go", "edit - I'll say what's wrong", "ask me something first"],
    });
    const picked = answer.trim().toLowerCase();
    if (picked === "go" || picked.startsWith("go")) return { accepted: true };
    // Anything else is a correction, including free text they typed instead of
    // choosing — that text IS the correction and must reach the model verbatim.
    return { accepted: false, note: answer.trim() };
  };

  /**
   * Resolve the pending ask_user question and restore the turn UI.
   *
   * `chosen` is the option's index when one was picked. Scrollback then records
   * the decision in the grammar decisions use here -- `> 2   Sounding rockets`
   * -- rather than a tick beside a string clipped at 80 columns, which read as
   * a log line and not as the answer that steered the work.
   */
  private finishQuestion(answer: string, chosen?: number): void {
    const q = this.questionState;
    if (!q) return;
    if (q.timer) clearTimeout(q.timer);
    this.questionState = null;
    this.input = "";
    this.caret = 0;
    // Return to the in-flight turn (questions only fire mid-turn).
    this.mode = q.prevMode === "question" ? "turn" : q.prevMode;
    this.print(
      chosen != null
        ? F.answered(chosen, answer)
        : `  ${ok(glyph("verified"))} ${muted(truncate(answer, F.proseWidth()))}`,
    );
    this.scheduleDraw();
    q.resolve(answer);
  }

  private questionKey(key: Key): void {
    const q = this.questionState;
    if (!q) return;
    // The state machine is pure and lives in ./question, so what a key means
    // here is the same thing the hint above the composer says it means.
    const action = questionAction(key, { ...q, input: this.input });
    switch (action.kind) {
      case "move":
        q.selected = action.selected;
        return this.scheduleDraw();
      case "answer":
        return this.finishQuestion(action.text, action.chosen);
      case "clear":
        this.input = "";
        this.caret = 0;
        return this.scheduleDraw();
      case "skip":
        return this.finishQuestion(QUESTION_SKIPPED);
      case "ignore":
        return;
      case "edit":
        // Everything else edits the composer (free-text answer).
        if (this.editComposer(key)) this.scheduleDraw();
    }
  }

  private permKey(key: Key): void {
    if (!this.perm) return;
    const choiceCount = this.perm.preview.choices.length === 2 ? 2 : 3;
    const action = permissionKeyAction(key, this.perm.sel, choiceCount);
    if (!action.handled) return;
    if (!action.decision) {
      this.perm.sel = action.selected;
      this.scheduleDraw();
      return;
    }
    const decision = action.decision;
    const r = this.perm.resolve;
    this.perm = null;
    this.mode = "turn"; // return to the in-flight turn
    const label =
      decision.kind === "deny"
        ? muted(`${glyph("observed")} declined | no action taken`)
        : ok(
            `${glyph("verified")} ${
              decision.kind === "allow_session" ? "approved for session" : "approved once"
            }`,
          );
    this.print(`  ${label}`);
    r(decision);
  }

  // -- turn mode (streaming) --

  private turnKey(key: Key): void {
    // Ctrl+R mid-turn: print the in-flight work log so far.
    if (key.type === "ctrl" && key.name === "r") {
      this.expandWorkLog();
      return;
    }
    // Esc / Ctrl-C: clear a typed-ahead draft first; with the composer empty, interrupt the turn.
    if (key.type === "esc" || (key.type === "ctrl" && key.name === "c")) {
      if (this.input.length > 0) {
        this.input = "";
        this.caret = 0;
        this.scheduleDraw();
        return;
      }
      if (!this.aborting) {
        if (this.activeLoopId) {
          const cancelled = this.ctx.engine.cancelLoopTask(this.ctx.sessionId, this.activeLoopId);
          if (cancelled.ok)
            this.print(
              `  ${danger(glyph("failure"))} ${muted(`loop ${this.activeLoopId} stopped`)}`,
            );
        }
        // Guard the flood: one interrupt request per turn, however many times esc is pressed.
        this.aborting = true;
        this.ctx.engine.abort();
        this.print(`  ${danger(glyph("failure"))} ${muted("interrupting...")}`);
        this.scheduleDraw();
      }
      return;
    }
    // Backspace with an empty composer removes the most recently queued
    // message -- the strip advertises this, so queueing stays reversible.
    if (key.type === "backspace" && this.input.length === 0 && this.queued.length > 0) {
      this.queued.pop();
      this.scheduleDraw();
      return;
    }
    // Enter mid-turn: STEER the live run -- the message is folded into the
    // agent's context at the next tool boundary, so it adapts its plan without
    // restarting (Claude Code-style). Slash commands can't run mid-turn, and
    // planner-mode/research runs aren't steerable -- those queue and run when
    // the turn finishes (the previous behaviour).
    if (key.type === "enter") {
      const raw = this.expandPastes(this.input).trim();
      if (raw) {
        const steered = !raw.startsWith("/") && this.ctx.engine.interject(raw);
        if (steered) {
          this.history.push(raw);
          this.print(userBlock(raw));
          this.print(`  ${info("->")} ${faint("folded into the running task")}`);
        } else {
          this.queued.push(raw);
        }
        this.input = "";
        this.caret = 0;
        this.histIdx = -1;
        this.gcPastes();
      }
      this.scheduleDraw();
      return;
    }
    // Recall history and scroll the transcript while waiting.
    if (key.type === "up") return this.historyPrev();
    if (key.type === "down") return this.historyNext();
    if (key.type === "pageup") return this.scrollBy(1);
    if (key.type === "pagedown") return this.scrollBy(-1);
    // Anything else edits the composer (type-ahead).
    if (this.editComposer(key)) this.scheduleDraw();
  }

  private async runTurn(input: string, scheduledLoop?: LoopTask): Promise<void> {
    const { engine } = this.ctx;
    this.mode = "turn";
    this.aborting = false;
    this.warpBlocked = false;
    this.turnStart = Date.now();
    this.streamBuf = "";
    this.turnPreview = null;
    // Warp shows the pane as working from here; without this a long run looks
    // idle to the terminal and the tab says nothing while the agent is busy.
    this.warp("prompt_submit", { query: input });
    this.scheduleDraw();

    // Collapsed rendering (see ./turn.ts): narration and the final answer stay in
    // the open; the heavy work accumulates in a hidden log whose live tail -- plus
    // the to-do checklist and a preview of the streaming prose -- shows in the
    // pinned window above the composer. finish() sets down the collapsed summary,
    // edit chips, the plan's final state, the record line, and the answer.
    const turn = new TurnRenderer(
      {
        commit: (block, detail) => this.print(block, detail),
        preview: (lines) => {
          this.turnPreview = lines;
          this.scheduleDraw();
        },
      },
      { model: engine.getModel(), getCost: () => engine.getCost() },
    );
    this.liveTurn = turn;
    // The web comp rotates the gear continuously. Terminals cannot rotate a
    // glyph, so the same mark breathes along a colour ramp instead (breathAt,
    // in ./turn) while the elapsed receipt advances. This tick drives that ramp
    // and the clock, and it is deliberately the only thing repainting the rung
    // on a timer: the stream may arrive as fast as it likes, and the footer
    // still moves no faster than a person can read it.
    this.tick = setInterval(() => {
      if (this.mode === "turn") {
        this.turnPreview = turn.liveLines();
        this.paintTitle(turn);
        this.scheduleDraw();
      } else if (this.mode === "question" && this.questionState?.deadline != null) {
        // 4th gear's grace window is real time passing, so it has to LOOK like
        // real time passing. A static "auto-continues in 60s" tells you nothing
        // about whether you have fifty seconds left or two.
        this.scheduleDraw();
      }
    }, 125);

    // Offer-a-dashboard bookkeeping: the answer text (for the data-density
    // heuristic) and whether the model already built/updated one this turn.
    let answerText = "";
    let dashboardTouched = false;
    let toolCalls = 0;
    let toolErrors = 0;
    let filesChanged = 0;
    let turnFailed = false;
    let quotaStop: string | null = null;
    this.activeLoopId = scheduledLoop?.id ?? null;

    try {
      for await (const ev of engine.chat(this.ctx.sessionId, input)) {
        turn.onEvent(ev);
        if (ev.type === "text_delta") answerText += ev.text;
        if (ev.type === "stream_reset") answerText = "";
        if (ev.type === "tool_call_end") {
          toolCalls++;
          if (!ev.output?.success) toolErrors++;
          // The answer landed and the work moved: take the pane off blocked.
          if (this.warpBlocked) {
            this.warpBlocked = false;
            this.warp("tool_complete", { toolName: ev.output?.toolName });
          }
        }
        if (ev.type === "tool_call_end" && ev.output?.toolName === "interactive_dashboard") {
          dashboardTouched = true;
        }
        if (ev.type === "checkpoint_saved") {
          this.lastCheckpoint = { sessionId: this.ctx.sessionId, label: `v${ev.version}` };
        }
        // A quota stop ends the run but names its retry window — captured here
        // so the finally block can schedule the auto-resume.
        if (
          ev.type === "error" &&
          typeof (ev as { error?: unknown }).error === "string" &&
          (ev as { error: string }).error.includes("Quota exceeded")
        ) {
          quotaStop = (ev as { error: string }).error;
        }
        // Session-wide edited-files readout on the footer.
        if (
          ev.type === "tool_call_end" &&
          ev.output?.success &&
          (ev.output.toolName === "edit_file" || ev.output.toolName === "write_file") &&
          ev.args?.path
        ) {
          this.filesEdited.add(String(ev.args.path));
          filesChanged++;
        }
      }
    } catch (err) {
      // A user interrupt surfaces as an abort error -- that's expected, not a failure to report.
      if (!this.aborting) {
        turnFailed = true;
        turn.onError(err);
      }
    } finally {
      turn.finish({ aborted: this.aborting });
      this.printClose();
      // The event a long run is actually for: Warp raises a notification when
      // the pane is in the background, which is the difference between
      // watching a spinner and being told when it is your turn again.
      this.warp("stop");
      setTitle({ kind: "idle" }, this.titleProject());
      if (
        !this.aborting &&
        !dashboardTouched &&
        !this.interactiveTipShown &&
        !engine.isInteractiveAuto() &&
        shouldOfferInteractive(answerText)
      ) {
        this.interactiveTipShown = true;
        this.print(`  ${faint(`${glyph("phase")} /interactive -- view this as a live dashboard`)}`);
      }
      this.lastWorkLog = turn.fullLog();
      this.liveTurn = null;
      if (this.tick) {
        clearInterval(this.tick);
        this.tick = null;
      }
      this.turnPreview = null;
      const wasAborted = this.aborting;
      if (scheduledLoop) {
        const completion = engine.completeLoopTask(this.ctx.sessionId, scheduledLoop.id, {
          responseText: answerText,
          toolCalls,
          toolErrors: toolErrors + (turnFailed ? 1 : 0),
          filesChanged,
          aborted: wasAborted,
        });
        this.print(this.renderLoopCompletion(scheduledLoop, completion));
      }
      this.activeLoopId = null;
      this.aborting = false;
      this.mode = "input";
      // Captured BEFORE the drain: drainQueue starts a queued turn without
      // synchronously leaving "input" mode, so the mode alone cannot say
      // whether the person's type-ahead is already driving.
      const hadQueued = this.queued.length > 0;
      this.drainQueue(wasAborted);
      if (quotaStop && !wasAborted) {
        this.scheduleQuotaResume(quotaStop);
      } else if (!quotaStop) {
        this.quotaResumeAttempts = 0; // a turn without a wall resets the backoff
      }
      // Held steps open their panel only when the person is free to answer:
      // not mid-abort, not with typed-ahead input already driving, not for a
      // scheduled loop iteration, and not over a quota wall's auto-resume.
      // Everywhere else the list prints exactly as it used to.
      if (this.pendingHeld?.length) {
        const held = this.pendingHeld;
        this.pendingHeld = null;
        if (!wasAborted && !quotaStop && !scheduledLoop && !hadQueued && this.mode === "input") {
          this.openHeldPanel(held);
        } else {
          const block = autoDeferralSummary(held);
          if (block) this.print(block);
        }
      }
    }
  }

  // -- held steps --
  // The interactive half of Auto's end-of-turn ledger. The engine holds the
  // exact declined call; approving a row runs precisely that call as an exact
  // session grant — the "approve exactly this" surface, so the way past a held
  // publish stops being a grant of everything.

  private openHeldPanel(steps: AutoModeDeferral[]): void {
    this.heldState = {
      steps,
      outcomes: steps.map(() => null),
      sel: 0,
      running: false,
    };
    this.mode = "held";
    setTitle({ kind: "waiting" }, this.titleProject());
    this.warp("permission_request", { toolName: "held steps" });
    this.scheduleDraw();
  }

  private heldKey(key: Key): void {
    const st = this.heldState;
    if (!st) return;
    const action = heldAction(key, {
      steps: st.steps,
      outcomes: st.outcomes,
      selected: st.sel,
      running: st.running,
    });
    switch (action.kind) {
      case "move":
        st.sel = action.selected;
        this.scheduleDraw();
        break;
      case "run":
        void this.runHeldSelected(action.index);
        break;
      case "skip":
        st.outcomes[action.index] = "skipped";
        this.advanceHeld(action.index);
        break;
      case "cancel":
        st.abort?.abort();
        break;
      case "leave":
        this.closeHeldPanel();
        break;
      default:
        break;
    }
  }

  private async runHeldSelected(index: number): Promise<void> {
    const st = this.heldState;
    if (!st || st.running) return;
    const step = st.steps[index]!;
    st.sel = index;
    st.running = true;
    st.abort = new AbortController();
    this.scheduleDraw();
    const firstLine = (v: string): string => v.split("\n").find((l) => l.trim()) ?? "";
    let outcome: HeldOutcome;
    let detail: string;
    try {
      const result = await this.ctx.engine.runHeldStep(this.ctx.sessionId, step, st.abort.signal);
      if (!result.ran) {
        outcome = "refused";
        detail = result.refusal ?? "refused";
      } else if (result.output?.success) {
        outcome = "ran";
        detail = firstLine(result.output.result ?? "").slice(0, 60) || "done";
      } else {
        outcome = "failed";
        detail = firstLine(result.output?.error ?? "failed").slice(0, 80);
      }
    } catch (error) {
      outcome = "failed";
      detail = firstLine(error instanceof Error ? error.message : String(error)).slice(0, 80);
    }
    // The panel may have been superseded (a due loop task) while the step ran;
    // the transcript row still records what happened.
    this.print(heldOutcomeRow(step, outcome, detail));
    if (this.heldState !== st) return;
    st.running = false;
    st.abort = undefined;
    st.outcomes[index] = outcome;
    this.advanceHeld(index);
  }

  private advanceHeld(from: number): void {
    const st = this.heldState;
    if (!st) return;
    const next = nextUndecided(st.outcomes, from);
    if (next === -1) {
      this.closeHeldPanel();
      return;
    }
    st.sel = next;
    this.scheduleDraw();
  }

  /** Close the panel; whatever is still undecided stays unrun, and the next
   *  run is told so instead of re-litigating it. */
  private closeHeldPanel(): void {
    const st = this.heldState;
    if (!st) return;
    st.abort?.abort();
    // A step executing right now is not "left unrun" — its own outcome note
    // (ran or failed) tells the truth when it settles.
    const runningIndex = st.running ? st.sel : -1;
    const unrun = st.steps.filter(
      (_, i) => i !== runningIndex && (st.outcomes[i] === null || st.outcomes[i] === "skipped"),
    );
    for (let i = 0; i < st.outcomes.length; i++) {
      if (st.outcomes[i] === null) st.outcomes[i] = "skipped";
    }
    this.ctx.engine.dismissHeldSteps(unrun);
    this.print(heldCloseReceipt(st.outcomes));
    this.heldState = null;
    this.mode = "input";
    setTitle({ kind: "idle" }, this.titleProject());
    this.scheduleDraw();
  }

  // -- quota auto-resume --
  // The stop message is honest about the window ("resume this session in
  // ~15m"); this makes the waiting real instead of leaving the session dead
  // until someone notices. Each retry re-parses the FRESH window from the next
  // stop message, so backoff follows the provider's own clock.

  private quotaResume: { timer: ReturnType<typeof setTimeout>; at: number } | null = null;
  private quotaResumeAttempts = 0;

  private scheduleQuotaResume(stopMessage: string): void {
    if (this.ctx.quotaAutoResume === false) return;
    if (this.mode !== "input" || this.queued.length > 0) return; // user is already driving
    if (this.quotaResume) return;
    if (this.quotaResumeAttempts >= 8) {
      this.print(
        `  ${warn(glyph("retry"))} ${muted("quota wall again - giving up on auto-resume after 8 tries.")} ${faint("send a message to continue manually")}`,
      );
      return;
    }
    this.quotaResumeAttempts++;
    const m = stopMessage.match(/resume this session in ~(\d+)m/);
    const mins = m ? Number(m[1]) : 15;
    const delayMs = Math.min(Math.max(mins * 60_000 + 30_000, 60_000), 6 * 60 * 60_000);
    const at = Date.now() + delayMs;
    const hhmm = new Date(at).toTimeString().slice(0, 5);
    this.print(
      `  ${warn(glyph("retry"))} ${muted(`quota wall - auto-resume at ${hhmm}`)} ${faint(`(attempt ${this.quotaResumeAttempts}, send any message to cancel)`)}`,
    );
    this.scheduleDraw();
    const timer = setTimeout(() => {
      this.quotaResume = null;
      if (this.mode !== "input" || this.queued.length > 0) return; // user took over
      this.print(
        `  ${info(glyph("retry"))} ${muted("quota window should be open - resuming from the handoff")}`,
      );
      void this.runInput("continue");
    }, delayMs);
    this.quotaResume = { timer, at };
  }

  private cancelQuotaResume(silent = false): void {
    if (!this.quotaResume) return;
    clearTimeout(this.quotaResume.timer);
    this.quotaResume = null;
    if (!silent) this.print(`  ${faint("auto-resume cancelled")}`);
  }

  private renderLoopCompletion(task: LoopTask, completion: LoopCompletion): string {
    if (completion.state === "rescheduled" && completion.task) {
      return `  ${warn(glyph("retry"))} ${muted(`loop ${task.id} next ${formatLoopDue(completion.task.nextRunAt)}`)} ${faint(`| ${completion.reason}`)}`;
    }
    if (completion.state === "stopped") {
      return `  ${ok(glyph("verified"))} ${muted(`loop ${task.id} complete`)} ${faint(`| ${completion.reason}`)}`;
    }
    if (completion.state === "expired") {
      return `  ${muted(`loop ${task.id} expired`)} ${faint(`| ${completion.reason}`)}`;
    }
    return `  ${muted(`loop ${task.id} stopped`)}`;
  }

  private async runDueLoopTask(): Promise<void> {
    // A due loop iteration outranks an unanswered held panel: leaving it open
    // would stall every later iteration of an unattended session, which is the
    // exact strand-the-run failure this release keeps paying for. The panel
    // closes as "left unrun" and the loop proceeds.
    if (this.mode === "held" && !this.heldState?.running) this.closeHeldPanel();
    if (this.mode !== "input" || this.queued.length > 0 || this.activeLoopId) return;
    const task = this.ctx.engine.claimDueLoopTask(this.ctx.sessionId);
    if (!task) return;
    try {
      await this.runInput(task.prompt, task);
    } catch (error) {
      // Do not strand the manager's in-flight claim if rendering or persistence
      // throws outside the normal runTurn error boundary.
      try {
        if (this.ctx.engine.getActiveLoopTask(this.ctx.sessionId)?.id === task.id) {
          this.ctx.engine.completeLoopTask(this.ctx.sessionId, task.id, { toolErrors: 1 });
        }
      } catch {
        /* the original failure is the actionable one */
      }
      this.activeLoopId = null;
      this.mode = "input";
      this.print(
        `  ${danger(glyph("failure"))} ${muted(`loop failed: ${error instanceof Error ? error.message : String(error)}`)}`,
      );
      this.scheduleDraw();
    }
  }

  /** Ctrl+R opens a reversible details surface; nothing is copied into scrollback. */
  private expandWorkLog(): void {
    const log = this.liveTurn?.fullLog() ?? this.lastWorkLog;
    if (!log) {
      this.print(`  ${faint("no work log yet")}`);
      return;
    }
    this.reviewLog = log;
    this.reviewReturnMode = this.liveTurn ? "turn" : "input";
    const body = Math.max(0, log.split("\n").filter((line) => stripAnsi(line).trim()).length - 1);
    this.reviewTop = Math.max(0, body - workReviewPageSize(Math.max(4, rowsCount() - 1)));
    this.mode = "review";
    this.scheduleDraw();
  }

  private moveWorkReview(delta: number): void {
    const log = this.liveTurn?.fullLog() ?? this.reviewLog ?? "";
    const body = Math.max(0, log.split("\n").filter((line) => stripAnsi(line).trim()).length - 1);
    const maxTop = Math.max(0, body - workReviewPageSize(Math.max(4, rowsCount() - 1)));
    this.reviewTop = Math.max(0, Math.min(maxTop, this.reviewTop + delta));
    this.scheduleDraw();
  }

  private closeWorkReview(): void {
    this.mode = this.reviewReturnMode === "turn" && this.liveTurn ? "turn" : "input";
    this.reviewLog = null;
    this.reviewTop = 0;
    this.scheduleDraw();
  }

  private workReviewKey(key: Key): void {
    const page = workReviewPageSize(Math.max(4, rowsCount() - 1));
    if (key.type === "up") this.moveWorkReview(-1);
    else if (key.type === "down") this.moveWorkReview(1);
    else if (key.type === "pageup") this.moveWorkReview(-page);
    else if (key.type === "pagedown") this.moveWorkReview(page);
    else if (
      key.type === "esc" ||
      key.type === "enter" ||
      (key.type === "ctrl" && (key.name === "r" || key.name === "c"))
    ) {
      this.closeWorkReview();
    }
  }

  /** Close out a finished turn's type-ahead queue. On a clean finish, run the next queued
   *  message (which itself drains the rest on completion). On an interrupt, the queue is
   *  cancelled -- the most recent draft is restored to the composer (when empty) so nothing
   *  the user typed is silently lost. */
  private drainQueue(wasAborted: boolean): void {
    if (wasAborted) {
      if (this.queued.length && this.input.trim().length === 0) {
        this.input = this.queued[0]!;
        this.caret = this.input.length;
      }
      this.queued = [];
      this.scheduleDraw();
      return;
    }
    if (this.queued.length) void this.runInput(this.queued.shift()!);
    else this.scheduleDraw();
  }

  // -- research mode (/research) --

  private async runResearchFlow(query: string, depth?: ResearchOptions["depth"]): Promise<void> {
    const { engine } = this.ctx;
    const researchOpts: ResearchOptions | undefined = depth ? { depth } : undefined;
    let question = query;
    try {
      // Phase 1: propose (asking clarifying questions if ambiguous).
      let proposal = await engine.proposeResearch(this.ctx.sessionId, question, researchOpts);
      if (isClarification(proposal)) {
        this.print(renderClarifyingQuestions(proposal));
        const ans = await this.promptLine("Answer, or Esc to skip");
        if (ans && ans.trim()) question = `${question}\n\nClarifications: ${ans.trim()}`;
        proposal = await engine.proposeResearch(this.ctx.sessionId, question, {
          ...researchOpts,
          allowClarification: false,
        });
      }
      let plan: ResearchPlan | null = isClarification(proposal) ? null : proposal;
      if (!plan) return;

      // Phase 2: approval gate (unless autoApprove).
      if (engine.getResearchConfig().autoApprove !== true) {
        for (;;) {
          this.print(renderResearchPlan(plan));
          const choice = await this.pick(
            "Research plan",
            [
              { label: "Run research", hint: "fan out & synthesize a cited report" },
              { label: "Revise...", hint: "give feedback and re-plan" },
              { label: "Cancel", hint: "" },
            ],
            0,
          );
          if (choice === 0) break;
          if (choice === 1) {
            const fb = await this.promptLine("What should change?");
            if (fb && fb.trim()) {
              const revised = await engine.reviseResearch(this.ctx.sessionId, plan, fb.trim());
              if (!isClarification(revised)) plan = revised;
            }
            continue;
          }
          this.print(`  ${muted("research cancelled")}`);
          return;
        }
      }

      // Phase 3: execute.
      await this.runResearchTurn(plan, question, researchOpts);
    } catch (err) {
      this.print(
        `  ${danger(glyph("failure"))} ${text(err instanceof Error ? err.message : String(err))}`,
      );
    }
  }

  private async runResearchTurn(
    plan: ResearchPlan,
    question: string,
    opts?: ResearchOptions,
  ): Promise<void> {
    // Research renders through the SAME TurnRenderer as every other turn --
    // same live rung, same rail rows, same streaming prose, same receipts.
    // (It used to be a second product wearing the same binary: its own event
    // printing, raw unwrapped report streaming, its own error format -- the
    // exact "many pieces, not one system" seam.)
    const { engine } = this.ctx;
    this.mode = "turn";
    this.aborting = false;
    this.warpBlocked = false;
    this.turnStart = Date.now();
    this.streamBuf = "";
    this.turnPreview = null;
    this.scheduleDraw();

    const turn = new TurnRenderer(
      {
        commit: (block, detail) => this.print(block, detail),
        preview: (lines) => {
          this.turnPreview = lines;
          this.scheduleDraw();
        },
      },
      { model: engine.getModel(), getCost: () => engine.getCost() },
    );
    this.liveTurn = turn;
    this.tick = setInterval(() => {
      if (this.mode === "turn") {
        this.turnPreview = turn.liveLines();
        this.paintTitle(turn);
        this.scheduleDraw();
      }
    }, 125);

    let report: ResearchReport | null = null;
    try {
      for await (const ev of engine.runResearch(this.ctx.sessionId, plan, opts)) {
        if (ev.type === "research_report_delta") {
          // The report IS the answer -- stream it as the turn's prose so it
          // previews live and lands as rendered markdown at finish.
          turn.onEvent({ type: "text_delta", text: ev.text });
          continue;
        }
        if (ev.type === "research_complete") report = ev.report;
        turn.onEvent(ev);
      }
    } catch (err) {
      if (!this.aborting) turn.onError(err);
    } finally {
      turn.finish({ aborted: this.aborting });
      this.printClose();
      // The event a long run is actually for: Warp raises a notification when
      // the pane is in the background, which is the difference between
      // watching a spinner and being told when it is your turn again.
      this.warp("stop");
      setTitle({ kind: "idle" }, this.titleProject());
      this.lastWorkLog = turn.fullLog();
      this.liveTurn = null;
      if (this.tick) {
        clearInterval(this.tick);
        this.tick = null;
      }
      this.turnPreview = null;
      this.mode = "input";
      this.scheduleDraw();
    }

    if (report) this.saveResearchReport(plan, question, report);
    const wasAborted = this.aborting;
    this.aborting = false;
    this.drainQueue(wasAborted); // run/restore any message typed ahead during research
  }

  private saveResearchReport(plan: ResearchPlan, question: string, report: ResearchReport): void {
    const cfg = this.ctx.engine.getResearchConfig();
    if (cfg.save === false) return;
    try {
      const { writeFileSync, mkdirSync } = require("fs");
      const { join } = require("path");
      const dir = cfg.outputDir || workspaceConfigPath(this.ctx.workspaceRoot, "research");
      mkdirSync(dir, { recursive: true });
      const slug =
        question
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 50) || "research";
      const file = join(dir, `${new Date().toISOString().slice(0, 10)}-${slug}.md`);
      const body = `# Research: ${plan.question}\n\n_Generated by Gear | ${new Date().toISOString()}_\n\n${report.markdown}\n`;
      writeFileSync(file, body);
      const shown = file.startsWith(this.ctx.workspaceRoot)
        ? file.slice(this.ctx.workspaceRoot.length).replace(/^[/\\]/, "")
        : file;
      this.print(`  ${faint("saved to")} ${info(shown)}`);
    } catch (err) {
      this.print(
        `  ${warn("could not save report:")} ${faint(err instanceof Error ? err.message : String(err))}`,
      );
    }
  }
}
