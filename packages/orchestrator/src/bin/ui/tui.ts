// ─── TUI controller (raw mode) ───
// Rune's terminal UI. TWO layouts, and the default has fixed chrome:
//
//   FIXED (default, ./viewport.ts)
//     The alternate screen split into three zones. The identity header holds
//     the top rows, the composer and status hold the bottom rows, and the
//     transcript in between is the ONLY thing that scrolls. Chrome that is
//     chrome: a wheel flick, a Page Up or a streaming turn move the middle and
//     nothing else. Rune owns the scrollback for the transcript and provides
//     the gestures itself: PgUp/PgDn, the arrows on an empty composer, and
//     the wheel by way of the terminal's alternate-scroll mode (a notch lands
//     as a burst of arrow keys) -- so the mouse is never captured and
//     click-drag copy stays the terminal's.
//
//   INLINE (--inline / RUNE_INLINE, ./screen.ts)
//     The transcript is committed to the terminal's OWN scrollback and only the
//     composer is pinned. Native momentum scrolling, ⌘F, mouse selection and
//     `| tee` all work — at the cost of the frame, because the terminal scrolls
//     the header and the field away along with the text, and on a fresh session
//     both open wherever the shell prompt was (the founder's 2026-09-05
//     screenshot: header and composer "launching together" at the bottom).
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
// Selected over the readline path with `--tui` / RUNE_TUI=1; `--classic` opts
// out to the plain printer. `--fullscreen` names the default and is a no-op.
//
// FOUR FILES, ONE OBJECT. `Tui` outgrew a file: at six thousand lines it was a
// paint loop, a key router and forty slash commands sharing one scope, and any
// two people working on the surface were editing the same thing. The class is
// now declared here and its methods are mixed in from three siblings:
//
//   ./tui-frame.ts     geometry and paint -- the regions, the scroll, resize
//   ./tui-input.ts     keys, the composer's edit operations, prompt history
//   ./tui-commands.ts  the `/` catalogue, its dispatch, and the panels it opens
//
// What is left here is the controller: lifecycle, session and transcript state,
// the turn loop, and the panels with their own state machines. See the bottom
// of this file for how the three are attached, and why nothing is `private`.

import {
  cols,
  rowsCount,
  mouseCaptureEnabled,
  MAX_TRANSCRIPT,
  FRAME_METHODS,
  type ChildPane,
  type FrameFocus,
  type FrameMethods,
} from "./tui-frame";
import { INPUT_METHODS, type InputMethods } from "./tui-input";
import { fleetLedger } from "./agents-panel";
import { COMMAND_METHODS, type CommandMethods } from "./tui-commands";
export { holdOpenRows } from "./tui-frame";
import { setActivityWorkspaceRoot } from "./activity";
import type {
  Engine,
  PermissionHandler,
  UserPermissionDecision,
  TranscriptLine,
} from "../../engine";
import { findCommand, type SlashCommand } from "../../commands";
import {
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
  CUSTOM_PROVIDER_ID,
  loadPrefs,
  savePrefs,
  mayPersistGear,
  shouldAskAboutFourthGear,
  getSystemMemoryPath,
} from "@rune/shared";
import type { CustomEndpoint } from "@rune/shared";
import { BottomRegion } from "./screen";
import { Viewport, zones, VIEWPORT_RESTORE } from "./viewport";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { type Key } from "./keys";
import { fmtTokens } from "./events";
import { PasteScanner, expandPastes } from "./paste";
import {
  workReviewPageSize,
  MEMORY_ACTION_COUNT,
  sessionGroupLabel,
  statusLine,
  setupStatusLine,
  modeInfo,
  permissionModeBanner,
  autoApprovedChip,
  autoDeferralSummary,
  type PickerItem,
  type KeyRow,
  type SessionRowView,
} from "./composer";
import { RUNE_MARK, renderBanner } from "./banner";
import { FRAME_MS, createPaintClock, workingRow } from "./working";
import { notifyWarp } from "./warp";
import { setTitle, clearTitle } from "./title";
import { renderReadBack, renderClose } from "./read-back";
import * as F from "./flow";
import { questionAction, QUESTION_SKIPPED, QUESTION_UNANSWERED } from "./question";
import {
  heldAction,
  heldCloseReceipt,
  heldOutcomeRow,
  nextUndecided,
  type HeldOutcome,
} from "./held";
import { assertNeverSoft } from "@rune/protocol";
import { filesChangedFrom } from "../../lifecycle";
import type { AutoModeDeferral } from "../../auto-mode";
import type { Brief } from "../../brief";
import { TurnRenderer, userBlock, renderReplay, HEX } from "./turn";
import { truncate, clampVisible, setTermWidthOverride } from "./render";
import { renderResearchPlan, renderClarifyingQuestions } from "./research";
import { isClarification } from "../../research-types";
import type { ResearchOptions, ResearchPlan, ResearchReport } from "../../research-types";
import { formatLoopDue, type LoopCompletion, type LoopTask } from "../../loop-mode";
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
  getTheme,
  withThemeBg,
  themeBgSeq,
  terminalThemeSeq,
  stripAnsi,
  TERMINAL_THEME_RESET,
} from "./theme";
import { glyph } from "./glyphs";
import { buildPermissionPreview, type PermissionPreview } from "./permission-preview";
import { FoldLedger, type FoldRegion } from "./folds";
import { BlockLedger, type BlockHandle } from "./blocks";
import { workspaceConfigPath } from "@rune/shared";
import { shouldOfferInteractive } from "./interactive";
import type { FirstRun, StepReceipt } from "../../first-run";
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
   * the transcript to the terminal's own scrollback (--inline / RUNE_INLINE).
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
  /** Setup controller shared with the CLI. Supplied on every interactive launch
   * so `/setup` remains available after onboarding has completed. */
  firstRun?: FirstRun;
  /** Open setup before the ordinary composer on a fresh no-credential launch. */
  firstRunOnLaunch?: boolean;
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
  | "setup"
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

/**
 * The breath of the ONE row drawn before a turn has any events to show.
 *
 * A module clock rather than a field because it animates a single surface that
 * only ever exists while a turn is opening, and because a paint clock must be
 * ticked once per paint by exactly one caller to mean anything. It re-syncs on
 * its own when a new turn restarts the elapsed clock (see `createPaintClock`).
 */
const OPENING_BREATH = createPaintClock();

/** Empty launch placeholders are implementation detail, not conversation history. */
function isMeaningfulSession(session: SessionListItem): boolean {
  return session.eventCount > 0 || Boolean(session.title?.trim());
}

/** How long a window drag has to go quiet before the fixed layout repaints. */

export async function runTui(ctx: TuiContext): Promise<void> {
  await new Tui(ctx).run();
}

export class Tui {
  region = new BottomRegion(); // --inline compatibility surface only
  /** The fixed-chrome surface: pinned header, scrolling body, pinned footer. */
  viewport = new Viewport();
  /** False for the default fixed-chrome layout; true only through --inline / RUNE_INLINE. */
  readonly inline: boolean;
  transcript: string[] = []; // fixed layout: themed lines, self-managed scrollback window
  /**
   * How to set a committed block down again at a new width, by handle.
   *
   * Rows are stored rendered, at the measure the window had when they
   * landed. That is the right trade for a transcript (a row never re-wraps
   * under the reader's hands), and the wrong one at the moment the window
   * changes size: an answer wrapped at 160 columns is clipped at 100, and one
   * wrapped at 100 sits in the left half of 160. A block committed with a
   * `reflow` closure is re-rendered here after a resize settles (see
   * reflowTranscript), in place, through the same amend path a streaming
   * answer uses. Blocks without one -- tool boxes, receipts, chrome -- keep
   * their rows: they truncate rather than wrap by design, so the frame's
   * clip is the right thing for them.
   */
  reflows = new Map<BlockHandle, () => string>();
  /** The measure the transcript's reflowable blocks were last set at. */
  reflowCols = 0;
  reflowTimer: ReturnType<typeof setTimeout> | null = null;
  /** Blocks that hold more than they show, openable in place -- see ./folds. */
  folds = new FoldLedger();
  /** Every committed block's rows, so the renderer can amend one in place --
   *  a call's row finishing, a burst folding, prose streaming. See ./blocks. */
  blocks = new BlockLedger();
  /** Where the body zone sat on the last painted frame, for click -> row math. */
  lastBodyMap: {
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
  printedRows = 0;
  scroll = 0; // fixed layout: lines scrolled up from the bottom (0 = following latest)
  /**
   * Which region the keys act on, and the one piece of frame state the other
   * lanes read: the agents panel paints its selection only when `focus` is
   * "panel", and the composer's caret is its own focus marker. `ctrl+f`
   * advances it, `esc` returns it here.
   */
  focus: FrameFocus = "composer";
  /** Collapsed widths only: the agents panel opened over the workspace. */
  panelOverlay = false;
  /** The child transcript in the workspace split. One at a time; lane B fills
   *  its rows and lane A places the pane. */
  childPane: ChildPane | null = null;
  /** The child pane's own scroll offset. Per region, so paging one pane never
   *  moves the other. */
  childScroll = 0;
  /** SIGWINCH. A field, not a method, because `process.stdout.on("resize", ...)`
   *  needs a stable bound reference to add and remove; the work is in
   *  ./tui-frame.ts with the rest of the geometry. */
  onResize = () => this.handleResize();
  input = "";
  caret = 0;
  history: string[] = [];
  histIdx = -1;
  draft = "";
  mode: Mode = "input";
  slashSel = 0; // highlighted row in the `/` command palette
  sigintArmed = false;
  paste = new PasteScanner(); // carves bracketed pastes out of the stdin stream (see ./paste)
  // Large/multi-line pastes are collapsed to a `[Pasted text #N +K lines]` chip in the composer
  // (Claude-Code idiom): the real content is held here and expanded back in on submit. Pasting the
  // raw body inline would put newlines into the single-line composer, which breaks the pinned
  // region's row math (garble) and re-renders megabytes every keystroke (freeze).
  pastes = new Map<number, string>();
  pasteSeq = 0;

  // `/sessions` manager overlay
  sessionsList: SessionListItem[] = [];
  sessionsSel = 0;
  sessionsView: "active" | "archived" = "active";
  sessionsPendingDelete: string | null = null; // id armed for two-step delete
  sessionsQuery = "";
  sessionsSearching = false;

  // `/memory` System Memory panel
  memorySel = 0;
  memoryBusy = false;
  memoryNote: string | null = null;
  memoryPendingClear = false;

  // `/setup` and first launch. The answer buffer is deliberately the ordinary
  // composer buffer, but setup submission bypasses runInput/history/transcript.
  // A secret therefore never reaches any of those durable surfaces.
  setupReceipt: StepReceipt | null = null;
  setupBusy = false;

  // `/keys` BYOK panel
  keysSel = 0;
  keysRows: KeyRow[] = [];
  // Per-provider key manager: which provider's pool is open + the selected entry.
  // null = the provider list is showing. Rows are read live from keysRows so the
  // manager reflects adds/removes without a stale copy.
  keysManage: { id: string; label: string; sel: number } | null = null;
  keysEdit: {
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
  turnStart = 0;
  tick: ReturnType<typeof setInterval> | null = null;
  streamBuf = "";
  queued: string[] = []; // type-ahead: messages composed mid-turn, run in order on completion
  aborting = false; // an esc/ctrl-c interrupt is in flight (guards the "interrupting..." flood)
  // Warp's badge is showing this pane as blocked on us. Set when we raise an
  // approval or a question, cleared by the first tool call that finishes after
  // -- which is the event that means the answer landed and work resumed. Kept
  // as a flag so a fifty-call turn writes one sequence, not fifty.
  warpBlocked = false;
  // Advanced by the turn tick, but only while output is actually arriving --
  // see ./title.ts. Not a clock.
  titleFrame = 0;

  /**
   * Redirect console.* to ~/.rune/logs/tui-console.log for the life of the
   * surface. Never swallowed: the lines are still written, just not over the
   * screen. Restored by exit().
   */
  guardConsole(): void {
    if (this.consoleRestore) return;
    const methods = ["log", "info", "warn", "error", "debug"] as const;
    const saved = methods.map((m) => [m, console[m]] as const);
    const logPath = join(homedir(), ".rune", "logs", "tui-console.log");
    const sink = (level: string, args: unknown[]): void => {
      try {
        mkdirSync(dirname(logPath), { recursive: true });
        const line = args
          .map((a) =>
            typeof a === "string"
              ? a
              : (() => {
                  try {
                    return JSON.stringify(a);
                  } catch {
                    return String(a);
                  }
                })(),
          )
          .join(" ");
        appendFileSync(logPath, `${new Date().toISOString()} ${level} ${line}\n`);
      } catch {
        /* a log that cannot be written is not worth a crash */
      }
    };
    for (const m of methods) console[m] = (...args: unknown[]) => sink(m, args);
    this.consoleRestore = () => {
      for (const [m, fn] of saved) console[m] = fn as never;
      this.consoleRestore = null;
    };
  }
  consoleRestore: (() => void) | null = null;

  /** The tab's own name for this project. */
  titleProject(): string {
    return this.ctx.workspaceRoot.split("/").filter(Boolean).pop() ?? "";
  }

  /** Paint the tab for an in-flight turn. Warp will not badge a pane it has not
   *  classified as an agent, but it renames one on OSC 0 like any terminal. */
  paintTitle(turn: { beat(): { quietMs: number } }): void {
    const { quietMs } = turn.beat();
    if (quietMs < 4000) this.titleFrame++;
    setTitle({ kind: "working", frame: this.titleFrame, quietMs }, this.titleProject());
  }
  turnPreview: string[] | null = null; // one live intent row + one evidence row
  filesEdited = new Set<string>(); // session-wide, shown on the footer readout
  interactiveTipShown = false; // the /interactive offer fires at most once per session
  lastWorkLog: string | null = null; // the last turn's full work log (ctrl+r expands it)
  liveTurn: TurnRenderer | null = null; // in-flight renderer (ctrl+r mid-turn)
  /** The plan as the last turn set it down, so the next turn's first checklist
   *  is not a reprint of carried-over state. */
  lastPlanKey: string | null = null;
  loopPoll: ReturnType<typeof setInterval> | null = null;
  activeLoopId: string | null = null;

  // Temporary work-details view. It replaces the pinned region and disappears
  // on Esc/Ctrl+R, so inspecting work never duplicates it into scrollback.
  reviewLog: string | null = null;
  reviewTop = 0;
  reviewReturnMode: "input" | "turn" = "input";

  // render coalescing -- collapse bursts of draw requests into one paint per frame (~60fps), so a
  // streamed token, a held arrow key, or a flick of the mouse wheel never trigger N full repaints.
  drawScheduled = false;
  drawTimer: ReturnType<typeof setTimeout> | null = null;
  lastPaint = 0;

  // hardware-scroll tracking: the visible window's bottom index (`end`) + band geometry at the last
  // and only the newly exposed lines need painting. -1 = no previous frame yet.
  prevEnd = -1;
  prevBandTop = -1;
  prevTransH = -1;

  // transient resolvers
  picker: {
    items: PickerItem[];
    sel: number;
    title: string;
    resolve: (i: number | null, alt?: boolean) => void;
    onPreview?: (i: number) => void;
    footnote?: string;
    /** Optional second action key (e.g. `d` = "select as default") -- resolves with alt=true. */
    altKey?: string;
  } | null = null;
  perm: {
    resolve: (d: UserPermissionDecision) => void;
    toolName: string;
    argsSummary: string;
    preview: PermissionPreview;
    sel: number;
  } | null = null;
  // transient single-line text prompt (used by /research clarify & revise)
  askState: { resolve: (s: string | null) => void; title: string } | null = null;
  /** Grace window before a 4th-gear ask_user picker auto-continues. */
  static readonly QUESTION_AUTO_CONTINUE_MS = 60_000;
  // ask_user tool: blocking question with numbered options (turn-time).
  questionState: {
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
  heldState: {
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
  pendingHeld: AutoModeDeferral[] | null = null;

  constructor(readonly ctx: TuiContext) {
    // Default: the fixed-chrome viewport. --inline keeps the legacy layout,
    // where the transcript is committed to the terminal's own scrollback and
    // only the composer is pinned.
    this.inline = Boolean(ctx.inline);
    setTermWidthOverride(this.inline ? null : this.contentCols());
  }

  // -- lifecycle --

  async run(): Promise<void> {
    const { engine } = this.ctx;
    if (this.ctx.firstRunOnLaunch && this.ctx.firstRun && !this.ctx.firstRun.done()) {
      this.mode = "setup";
    }

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
    process.env.RUNE_TUI_ACTIVE = "1"; // loggers: file sink only, never stderr over the alt screen
    // Nothing but the compositor may write to this screen. Rune's own loggers
    // honour the flag above; a third-party module (an MCP client, a plugin)
    // calling console.log would land on the alternate screen at the cursor and
    // rot the row diff. Route the console to the log file while the surface
    // is up, and hand it back on exit.
    this.guardConsole();
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

    // Tool rows name files against this root: `src/app.ts`, not the
    // abbreviated absolute path the tool answered with.
    setActivityWorkspaceRoot(this.ctx.workspaceRoot);
    this.enterSurface();
    process.stdout.on("resize", this.onResize);
    // Replay prior conversation when launched straight into a session (--resume /
    // `rune resume <id>`). When launchPick is set, the picker runs once input is
    // live (below) instead -- a fresh session has nothing to seed.
    if (!this.ctx.launchPick) this.seedFromHistory();
    // First frame synchronous so the banner and composer appear instantly --
    // through the surface that owns the screen. Drawing the inline block on
    // the alternate screen painted a full-height composer at the cursor and
    // then overwrote it 16ms later: a mispositioned flash on every launch.
    if (this.inline) this.renderRegion();
    else this.renderViewport();

    // System Memory: a one-time discoverability hint + a background "dream" when the
    // chosen cadence is due. Skipped while the launch picker owns the screen. The
    // dream no-ops fast unless an interval cadence is set and elapsed.
    if (!this.ctx.launchPick) this.openFreshSession();

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
        delete process.env.RUNE_TUI_ACTIVE; // terminal is the shell's again — loggers may use stderr
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

  exit: (code?: number) => void = () => {};

  // -- input rendering --

  statusStr(width = this.contentCols()): string {
    // §2.8: while the wizard is open the strip states the one fact the screen
    // cannot otherwise prove -- that editing configuration makes no model call.
    // The ordinary strip's fields (model, gear, context) are measurements of a
    // conversation that has not started yet.
    if (this.mode === "setup" && this.ctx.firstRun) return setupStatusLine(width);
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
      width,
    );
  }

  /** Shift up one gear (Shift+Tab / `/gear` / `/mode`) -- or straight to `target` -- and announce it. */
  cyclePermissionMode(mode?: ReturnType<Engine["getPermissionMode"]>): void {
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
   * rune still asks before it acts — remembering them changes how much typing a
   * session costs, not what it is permitted to do. The fourth bypasses every
   * interactive prompt, so making it sticky silently would mean a machine that
   * quietly stopped asking, forever, on the strength of one afternoon. It is
   * asked about once and the answer is what is kept: yes, and it persists like
   * any other; no, and it stays session-only and is never raised again.
   */
  async rememberGear(gear: ReturnType<Engine["getPermissionMode"]>): Promise<void> {
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

  pushLines(block: string): number {
    const lines = block.split("\n");
    // Store semantic ANSI only, at full width. Card/canvas backgrounds and the
    // width bound are applied per frame (renderViewport's themeBody), so a
    // light/dark or accent change recolours the whole existing timeline, and a
    // narrower window re-clips every row instead of hard-clipping rows bound at
    // a width the terminal no longer has.
    for (const ln of lines) this.transcript.push(ln);
    const overflow = this.transcript.length - MAX_TRANSCRIPT;
    if (overflow > 0) {
      this.transcript.splice(0, overflow);
      this.folds.noteTrim(overflow);
      this.blocks.noteTrim(overflow);
    }
    return lines.length;
  }

  /** Register a block's fold, if it has one: the region starts at its first
   *  visible row, so the blank rhythm line above a group never becomes part
   *  of what a click toggles. */
  registerFold(raw: string[], start: number, detail: string): void {
    let first = 0;
    while (first < raw.length && !stripAnsi(raw[first]!).trim()) first++;
    if (first < raw.length && start + first >= 0) {
      this.folds.register(
        start + first,
        raw.slice(first).map((l) => this.bound(l)),
        detail.split("\n").map((l) => this.bound(l)),
      );
    }
  }

  print(block: string, detail?: string, reflow?: () => string): BlockHandle | undefined {
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
      return undefined;
    }
    const raw = block.split("\n");
    const added = this.pushLines(block);
    const start = this.transcript.length - added;
    // The block's identity, so the renderer can amend it in place later.
    const handle = this.blocks.register(start, added);
    if (reflow) {
      this.reflows.set(handle, reflow);
      if (!this.reflowCols) this.reflowCols = this.contentCols();
    }
    // A block that holds more than it shows registers its two forms with the
    // fold ledger.
    if (detail) this.registerFold(raw, start, detail);
    // Follow the bottom when already there; if the user has scrolled up to read, hold their
    // view stationary as new lines stream in (don't yank them back down). Typing or submitting
    // resets scroll to 0, returning to the live tail.
    if (this.scroll > 0) this.scroll += added;
    this.scheduleDraw();
    return handle;
  }

  /**
   * Replace a committed block in place: the same splice a fold makes, driven
   * by the renderer instead of a click. A call's provisional row becomes its
   * finished row, three gathering rows become one chamber row, the model's
   * prose grows as it streams. An empty block removes the rows. The scroll
   * correction is the fold's: a splice at or below the reader's window
   * changes the distance between their content and the tail.
   */
  amend(handle: BlockHandle, block: string, detail?: string, reflow?: () => string): void {
    if (this.inline) return;
    const region = this.blocks.get(handle);
    if (!region) return;
    if (reflow) {
      this.reflows.set(handle, reflow);
      if (!this.reflowCols) this.reflowCols = this.contentCols();
    }
    const top = this.transcript.length - this.scroll - this.frameZones().bodyRows;
    const raw = block ? block.split("\n") : [];
    const start = region.start;
    const remove = region.rows;
    this.transcript.splice(start, remove, ...raw);
    this.folds.replaceRange(start, remove, raw.length);
    const splice = this.blocks.replace(handle, raw.length);
    const delta = splice?.delta ?? raw.length - remove;
    if (detail && raw.length > 0) this.registerFold(raw, start, detail);
    const overflow = this.transcript.length - MAX_TRANSCRIPT;
    if (overflow > 0) {
      this.transcript.splice(0, overflow);
      this.folds.noteTrim(overflow);
      this.blocks.noteTrim(overflow);
    }
    if (this.scroll > 0 && start >= top) this.scroll = Math.max(0, this.scroll + delta);
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
  /**
   * Set every reflowable block down again at the window's current measure.
   *
   * Called once a resize has settled (handleResize), not on every SIGWINCH of
   * a drag: the frame repaints and re-clips on every one of those already, and
   * re-rendering a long answer sixty times a second would be the CPU a
   * keypress waits behind. Blocks are re-rendered in buffer order through
   * `amend`, which keeps the ledgers and the reader's scroll position honest
   * for each splice. A block the buffer has since trimmed is forgotten.
   */
  reflowTranscript(): void {
    if (this.inline) return;
    const cols = this.contentCols();
    if (cols === this.reflowCols) return;
    this.reflowCols = cols;
    const order = [...this.reflows.entries()]
      .map(([handle, render]) => ({ handle, render, region: this.blocks.get(handle) }))
      .sort((a, b) => (a.region?.start ?? -1) - (b.region?.start ?? -1));
    for (const { handle, render, region } of order) {
      if (!region) {
        this.reflows.delete(handle);
        continue;
      }
      let block: string;
      try {
        block = render();
      } catch {
        continue; // a block that cannot re-render keeps its rows
      }
      this.amend(handle, block);
    }
  }

  toggleFold(region: FoldRegion): void {
    const top = this.transcript.length - this.scroll - this.frameZones().bodyRows;
    const splice = this.folds.toggle(region);
    this.transcript.splice(splice.start, splice.remove, ...splice.insert);
    this.blocks.noteSplice(splice.start, splice.delta);
    const overflow = this.transcript.length - MAX_TRANSCRIPT;
    if (overflow > 0) {
      this.transcript.splice(0, overflow);
      this.folds.noteTrim(overflow);
      this.blocks.noteTrim(overflow);
    }
    if (this.scroll > 0 && splice.start >= top) {
      this.scroll = Math.max(0, this.scroll + splice.delta);
    }
    this.scheduleDraw();
  }

  /** Print the banner once at the top; it scrolls away with the conversation.
   *
   *  This used to also clear the screen and paint it in the theme background.
   *  Both are gone. Starting a program is not a licence to erase what the user
   *  had on screen — their last command's output is often the reason they
   *  opened Rune — and asserting a background is the single largest reason a
   *  TUI looks broken on someone else's theme. Inherit; do not assert. */
  /** Tell Warp this pane is an agent, and where it is. */
  warp(
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
  enterSurface(): void {
    // The cursor is the one piece of terminal chrome that sits inside our own
    // field, so it takes the theme's accent — see terminalThemeSeq. Handed back
    // on exit and by the crash handler; a terminal that ignores OSC 12 ignores
    // it harmlessly.
    process.stdout.write(terminalThemeSeq());
    if (!this.inline) {
      this.viewport.enter();
      // The mouse is deliberately NOT captured by default.
      //
      // Capturing it (?1000h) lets the wheel scroll our own buffer, but it also
      // intercepts click-drag, so the terminal can no longer select text and
      // the founder cannot copy the transcript ("often it gets blocked when you
      // jam the footer at one fixed place"). Copy matters more than the wheel:
      // released, native selection works on everything visible. The wheel
      // still reaches the transcript: enter() switches on the terminal's
      // alternate-scroll mode (?1007), which turns a notch into arrow keys on
      // the alternate screen, and onData routes that burst as a scroll. Set
      // RUNE_MOUSE=1 to capture the wheel outright at the cost of drag-to-select.
      if (mouseCaptureEnabled()) this.viewport.captureMouse();
    }
    this.warp("session_start");
    // Name the tab the moment we own the pane. Without this the tab keeps
    // whatever the terminal derived from the command until the first turn
    // starts, so a session sitting at the prompt looks like a bare shell --
    // which is most of the time anyone is actually glancing at the tab strip.
    setTitle({ kind: "idle" }, this.titleProject());
    // The one-line header opens the session. When the launch picker owns the
    // screen it is printed AFTER the picker resolves instead (printMastheadOnce,
    // called from every session-start path); printing it here first would only
    // be drawn over.
    if (!this.ctx.launchPick) this.printMastheadOnce();
    if (!this.inline) this.scheduleDraw();
  }

  mastheadPrinted = false;
  /**
   * Commit the one-line header once per session start (the wordmark row + the
   * seam rule). Idempotent: the launch picker and the direct-start path both
   * try, and only the first wins, so the header shows exactly once whether you
   * land in a fresh session or resume one.
   *
   * INLINE only: it is committed into scrollback and scrolls away with the
   * conversation. In the fixed frame the header is PINNED and re-rendered every
   * frame (bannerLines), so committing a copy here would leave a stale one
   * scrolling underneath the live one.
   */
  /**
   * The opening of a fresh session: the logo (inline surface), what to type
   * and which keys matter -- once, only when nothing has been said -- the
   * memory tip, and the background dream. Runs at launch, or once the launch
   * picker settles on "new". That path used to print nothing at all and, on
   * the fixed frame, left the picker painted until the next keystroke.
   */
  openFreshSession(): void {
    this.printMastheadOnce();
    const { engine } = this.ctx;
    // The empty start screen said nothing but a memory tip. A person's first
    // question is what to type and which keys matter; answer both in the
    // transcript's own grammar.
    if (engine.getTranscript(this.ctx.sessionId).length === 0) {
      this.print(
        [
          `  ${muted("try")}  ${[
            '"fix the failing test"',
            '"explain how this repo is wired"',
            ...(cols() >= 100 ? ['"add a --dry-run flag"'] : []),
          ]
            .map((example) => faint(example))
            .join(` ${faint(glyph("observed"))} `)}`,
          `  ${muted("keys")} ${faint("?")} ${faint("shortcuts")} ${faint(glyph("observed"))} ${faint("/")} ${faint("commands")} ${faint(glyph("observed"))} ${faint("shift+tab")} ${faint("shifts gear")}`,
        ].join("\n"),
      );
    }
    const mem = engine.getSystemMemory();
    if (mem.mode !== "off" && !mem.content.trim()) {
      this.print(`  ${faint("tip: Rune can learn your style over time --")} ${info("/memory")}`);
    }
    // The cadence is withdrawn: a user who had chosen one hears it once, here,
    // rather than discovering that nothing refreshes any more. No startup
    // refresh runs — `maybeReflectSystemMemory()` is a permanent no-op now.
    const migrated = engine.takeMemoryModeNotice();
    if (migrated) {
      this.print(`  ${faint(`memory: ${migrated.note}`)}`);
    }
    this.scheduleDraw();
  }

  printMastheadOnce(): void {
    if (this.mastheadPrinted) return;
    this.mastheadPrinted = true;
    if (!this.inline) return;
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

  /** Unmount the render surface, leaving the terminal as it was found. */
  leaveSurface(): void {
    if (this.inline)
      this.region.clear(); // leaves the transcript in scrollback
    else this.viewport.leave(); // restores the shell's screen untouched
    this.consoleRestore?.(); // the console is the terminal's again
  }

  /** Apply a runtime theme change to the terminal surface as well as future tokens. */
  refreshThemeSurface(): void {
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
  modelLabel(): string | undefined {
    const { engine } = this.ctx;
    const model = engine.getModel();
    return getPreset(engine.getProvider())?.models?.find((m) => m.id === model)?.label;
  }

  /** Connected MCP servers, for the header badge. */
  mcpServerCount(): number {
    try {
      return this.ctx.engine.getMcpStatus().length;
    } catch {
      return 0;
    }
  }

  /** The active gear, as the header states it: what proceeds without asking,
   *  and -- in 1st gear, where nothing does -- what still asks. */
  gearScope(): { scope: string; caution?: string } {
    const mode = modeInfo(this.ctx.engine.getPermissionMode());
    return {
      scope: mode.label,
      caution: mode.desc || undefined,
    };
  }

  /** Print the banner into the transcript (inline surface). The alt-screen surface renders it
   *  live as a pinned header via bannerLines() instead. */
  /** Clear the visible transcript, on explicit user request only.
   *
   *  The absolute clear here is deliberate and is the one place it is allowed:
   *  the user asked for a clear screen, and this is exactly what clear(1) does.
   *  It is not a render path — nothing repaints through here — so it cannot rot
   *  the way a per-frame absolute address does. No background is painted. */
  resetTranscript(): void {
    this.transcript = [];
    this.reflows.clear();
    this.folds.clear();
    this.blocks.clear();
    this.scroll = 0;
    // The agents panel is part of the transcript's story, not a separate one:
    // /clear, a resume and a session switch all arrive here, and a finished
    // card surviving one of them would be the right column reporting a fan-out
    // that belongs to a session no longer on screen.
    fleetLedger.reset();
    this.closeChildPane();
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
    this.printedRows = 0;
    // A fresh screen re-earns the masthead: /clear and a resume (which clears
    // then replays) both open with the gear logo, not the one-line banner. This
    // is also why resume shows the logo -- replayTranscript() calls this first.
    this.mastheadPrinted = false;
    this.printMastheadOnce();
  }

  workingText(): string {
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
  /** Wall-clock of the last turn that finished, so the strip can say `Done -
   *  1m 58s` at rest instead of nothing. Null until a turn has run. */
  lastTurnMs: number | null = null;

  turnStateLines(): string[] {
    if (this.aborting) return this.pinLiveHeight([`  ${this.workingText()}`]);
    const lines = [...(this.turnPreview ?? [])];
    if (lines.length === 0) {
      // Before the first event lands there is genuinely nothing to report but
      // the state and the clock -- so this is the working indicator with an
      // empty turn behind it, not a second dialect of it. It used to be the
      // brand mark and a bold `Thinking...`, which is the one place in the
      // product where the accent colour and a bold weight were spent on the
      // fact that nothing had happened yet.
      return this.pinLiveHeight([
        `  ${workingRow(
          { kind: "working", elapsedMs: Math.max(0, Date.now() - this.turnStart) },
          // One frame of the breath per paint, not per 90ms of wall clock:
          // a late repaint breathes slower instead of skipping levels.
          { animMs: OPENING_BREATH.tick(Math.max(0, Date.now() - this.turnStart)) },
        )}`,
      ]);
    }
    // This was a flat two rows, which is why a fan-out of sub-agents could only
    // ever be a count: there was nowhere to put the other five. The block earns
    // rows now, and it is trimmed from the BOTTOM, so a short window loses the
    // fleet's later members and keeps the rung and its clock -- the opposite of
    // what the viewport's own footer trim would do. It never takes more than a
    // third of the window either way: this is the last few lines of the screen,
    // not the screen.
    const budget = this.liveBlockBudget();
    return this.pinLiveHeight(
      lines.slice(0, budget).map((line) => clampVisible(line, Math.max(8, cols() - 1))),
    );
  }

  /** High-water mark of the live block this turn; reset when a turn starts. */
  liveBlockRows = 0;
  /** What the tick last painted, so an unchanged rung costs no frame. */
  lastTickKey = "";

  // -- stdin routing --

  // -- input mode --

  // -- submit --

  async submit(): Promise<void> {
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

  /** The v2 task-bar receipt: the turn about to run and the latest checkpoint. */
  /** Echo, record, and execute one line of input -- a slash command or a model turn. Shared by
   *  submit() and the type-ahead queue drained when a turn completes, so both run identically. */
  async runInput(raw: string, scheduledLoop?: LoopTask): Promise<void> {
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
      this.print(userBlock(raw), undefined, () => userBlock(raw));
    } else if (raw.startsWith("/")) this.print(`  ${info(glyph("selection"))} ${text(raw)}`);
    else this.print(userBlock(raw), undefined, () => userBlock(raw));

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

  // -- picker mode --

  pick(
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
  pickAlt(
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

  pickerKey(key: Key): void {
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
    } else if (key.type === "char" && /^[a-z]$/i.test(key.value)) {
      // Type-to-jump. With thirty-odd providers on one list the arrow keys
      // alone are a chore: a letter moves to the next row whose label starts
      // with it, cycling from the top, so "m" reaches Mistral in one press and
      // a second "m" reaches MiniMax. Digits keep their quick-select meaning.
      const c = key.value.toLowerCase();
      const n = p.items.length;
      for (let step = 1; step <= n; step++) {
        const i = (p.sel + step) % n;
        if (p.items[i]!.label.toLowerCase().startsWith(c)) {
          p.sel = i;
          p.onPreview?.(i);
          this.scheduleDraw();
          break;
        }
      }
    } else if (key.type === "enter") {
      this.closePicker(p.sel);
    } else if (key.type === "esc" || (key.type === "ctrl" && key.name === "c")) {
      this.closePicker(null);
    }
  }

  closePicker(result: number | null, alt = false): void {
    const p = this.picker;
    this.picker = null;
    this.mode = "input";
    p?.resolve(result, alt);
    // The resolver usually prints, which repaints; when it does not (the
    // launch picker settling on "new" in the fixed frame) the popover stayed
    // on screen until the next keystroke. One scheduled draw either way.
    this.scheduleDraw();
  }

  // -- ask mode (transient single-line text prompt; used by /research) --

  promptLine(title: string, initial = ""): Promise<string | null> {
    return new Promise((resolve) => {
      this.input = initial;
      this.caret = initial.length;
      this.askState = { resolve, title };
      this.mode = "ask";
      this.scheduleDraw();
    });
  }

  askKey(key: Key): void {
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
  relTime(iso: string): string {
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

  shortId(id: string): string {
    // The tail, as the header shows it -- see flow.sessionTail.
    return id.slice(-8);
  }

  sessionGroup(iso: string): string {
    return sessionGroupLabel(iso, new Date(), { withDate: true });
  }

  /** Permanently discard only untouched, unnamed launch placeholders. */
  discardSessionIfEmpty(id: string): void {
    const session = this.ctx.engine.getSessionInfo(id);
    if (!session || session.eventCount > 0 || session.title?.trim()) return;
    try {
      this.ctx.engine.purgeSession(id);
    } catch {
      // Cleanup is best-effort; it must never prevent exit or resume.
    }
  }

  sessionRowView(s: SessionListItem): SessionRowView {
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

  filteredSessions(view: "active" | "archived"): SessionListItem[] {
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

  openSessions(view: "active" | "archived" = "active"): void {
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
  refreshSessions(): void {
    this.sessionsList = this.filteredSessions(this.sessionsView);
    if (this.sessionsSel >= this.sessionsList.length) {
      this.sessionsSel = Math.max(0, this.sessionsList.length - 1);
    }
    this.scheduleDraw();
  }

  closeSessions(): void {
    this.sessionsPendingDelete = null;
    this.sessionsSearching = false;
    this.mode = "input";
    this.scheduleDraw();
  }

  sessionsKey(key: Key): void {
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

  startNewSession(): void {
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
  resumeSelected(): void {
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

  replayTranscript(
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
    this.print(`  ${faint("continue where you left off")}`);
  }

  /** Render replayed history lines into the transcript (shared by resume + startup seeding).
   *  Uses the same two-partition renderer as a live turn so a resumed session is faithful:
   *  work inside the rail, each turn's final answer outside it. */
  printTranscriptLines(lines: TranscriptLine[]): void {
    if (lines.length === 0) return;
    this.print(renderReplay(lines), undefined, () => renderReplay(lines));
  }

  /**
   * On launch, if the session already has history (started with `--resume` /
   * `rune resume`), replay it into the viewport so the user lands where they left
   * off instead of on a blank screen.
   */
  seedFromHistory(): void {
    const lines = this.ctx.engine.getTranscript(this.ctx.sessionId);
    if (lines.length === 0) return;
    const info = this.ctx.engine.getSessionInfo(this.ctx.sessionId);
    const title = info?.title?.trim() || "untitled";
    this.print(
      `  ${faint("--")} ${muted("resumed")} ${text(title)} ${faint(this.shortId(this.ctx.sessionId))} ${faint("--")}`,
    );
    this.printTranscriptLines(lines);
    this.print(`  ${faint("continue where you left off")}`);
  }

  /**
   * Launch flow: started without a target session but prior work exists -> offer a
   * compact "resume a session" picker (Enter / Esc / "new" = keep the fresh
   * session). Picking an older session loads it and discards the throwaway session
   * we created to land in, so launches never litter the history.
   */
  async runLaunchPicker(): Promise<void> {
    const fresh = this.ctx.sessionId;
    const recent = this.ctx.engine
      .listSessions({ status: "active" })
      .filter((s) => s.id !== fresh && isMeaningfulSession(s))
      .slice(0, 12);
    if (recent.length === 0) {
      this.openFreshSession(); // nothing to resume -- open the fresh session
      return;
    }

    const items: PickerItem[] = [
      { label: "*  Start a new session", hint: "fresh start" },
      ...recent.map((s) => {
        const v = this.sessionRowView(s);
        return { label: v.title, hint: v.meta };
      }),
    ];
    const i = await this.pick("Resume a session", items, 0);
    if (i == null || i === 0) {
      this.openFreshSession(); // Esc or "new" -> open the fresh session
      return;
    }

    const s = recent[i - 1];
    if (!s) {
      this.openFreshSession();
      return;
    }
    const res = this.ctx.engine.resumeSession(s.id);
    if (!res) {
      this.openFreshSession();
      this.print(`  ${danger(glyph("failure"))} ${muted("could not open that session")}`);
      return;
    }
    // replayTranscript() clears the screen and re-prints the masthead itself
    // (via resetTranscript), so the logo lands above the replayed history.
    this.replayTranscript(s.id, s, res);
  }

  async renameSelected(): Promise<void> {
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

  archiveSelected(): void {
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

  restoreSelected(): void {
    const s = this.sessionsList[this.sessionsSel];
    if (!s) return;
    this.ctx.engine.restoreSession(s.id);
    this.print(
      `  ${ok(glyph("verified"))} ${muted("restored")} ${faint(s.title?.trim() || "untitled")}`,
    );
    this.refreshSessions();
  }

  /** Two-step delete: the first 'd' arms (footer shows a confirm); the second deletes. */
  deleteSelected(): void {
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

  openMemory(): void {
    this.memorySel = 0;
    this.memoryBusy = false;
    this.memoryNote = null;
    this.memoryPendingClear = false;
    this.mode = "memory";
    this.scheduleDraw();
  }

  closeMemory(): void {
    this.memoryPendingClear = false;
    this.memoryNote = null;
    this.mode = "input";
    this.scheduleDraw();
  }

  memoryKey(key: Key): void {
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

  async memoryRunAction(action: number): Promise<void> {
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

  async memoryRefresh(): Promise<void> {
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

  memoryCycleCadence(): void {
    // The cadence is withdrawn (2026-09-15): memory has three modes — off,
    // auto, manual — and this key cycles them. The name stays for the keymap.
    const mode = this.ctx.engine.cycleMemoryMode();
    this.memorySel = 1;
    this.memoryNote = `memory ${mode}`;
    this.scheduleDraw();
  }

  async memoryAddNote(): Promise<void> {
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

  memoryClear(): void {
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
  async editMemoryInEditor(): Promise<void> {
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
    delete process.env.RUNE_TUI_ACTIVE; // the editor owns the terminal now

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
    process.env.RUNE_TUI_ACTIVE = "1";
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

  keysKey(key: Key): void {
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
  openKeyManager(row: KeyRow): void {
    this.keysManage = { id: row.id, label: row.label, sel: 0 };
    this.scheduleDraw();
  }

  keysManageKey(key: Key): void {
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
  startKeyAdd(mgr: { id: string; label: string }): void {
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
  setActiveManagedKey(entryId: string): void {
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
  removeManagedKey(entryId: string): void {
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

  startKeyEdit(): void {
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

  keysEditKey(key: Key): void {
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

  commitKeyEdit(): void {
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

  toggleSelected(): void {
    const row = this.keysRows[this.keysSel];
    if (!row) return;
    const next = !row.disabled;
    persistDisabled(row.id, next);
    const res = this.ctx.engine.setProviderDisabled(row.id, next, this.ctx.sessionId);
    this.noteForcedSwitch(res);
    this.keysRows = this.buildKeyRows();
    this.scheduleDraw();
  }

  clearSelectedKey(): void {
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
  noteForcedSwitch(res: { switchedTo?: { provider: string; model: string } }): void {
    if (res.switchedTo) {
      this.print(
        `  ${warn("->")} ${muted("active provider unavailable -- now on")} ${info(`${res.switchedTo.provider}/${res.switchedTo.model}`)}`,
      );
    }
  }

  // -- permission mode --

  permissionHandler: PermissionHandler = async (prompt) => {
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

  questionHandler = (q: {
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
  printClose(): void {
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
  briefHandler = async (
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
  finishQuestion(answer: string, chosen?: number): void {
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

  questionKey(key: Key): void {
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

  permKey(key: Key): void {
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

  turnKey(key: Key): void {
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
          this.print(userBlock(raw), undefined, () => userBlock(raw));
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
    // Read the transcript (arrows on an empty composer, PgUp/PgDn) or recall
    // history (ctrl+p / ctrl+n, or the arrows over a draft) while waiting.
    if (key.type === "ctrl" && key.name === "p") return this.historyPrev();
    if (key.type === "ctrl" && key.name === "n") return this.historyNext();
    if (key.type === "up")
      return this.arrowScrolls(false) ? this.scrollLines(1) : this.historyPrev();
    if (key.type === "down")
      return this.arrowScrolls(false) ? this.scrollLines(-1) : this.historyNext();
    if (key.type === "pageup") return this.scrollBy(1);
    if (key.type === "pagedown") return this.scrollBy(-1);
    // Anything else edits the composer (type-ahead).
    if (this.editComposer(key)) this.scheduleDraw();
  }

  async runTurn(input: string, scheduledLoop?: LoopTask): Promise<void> {
    const { engine } = this.ctx;
    this.mode = "turn";
    this.aborting = false;
    this.warpBlocked = false;
    this.turnStart = Date.now();
    // A new turn starts with a fresh high-water mark for the live block.
    this.liveBlockRows = 0;
    this.lastTickKey = "";
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
        commit: (block, detail, reflow) => this.print(block, detail, reflow),
        // The fixed viewport owns its buffer, so a row can be amended after
        // it lands; --inline writes to the terminal's scrollback and cannot.
        amend: this.inline
          ? undefined
          : (handle, block, detail, reflow) => this.amend(handle, block, detail, reflow),
        preview: (lines) => {
          this.turnPreview = lines;
          this.scheduleDraw();
        },
      },
      {
        model: engine.getModel(),
        getCost: () => engine.getCost(),
        priorPlanKey: this.lastPlanKey ?? undefined,
      },
    );
    this.liveTurn = turn;
    // The animation clock. A terminal cannot rotate a glyph, so Rune's pulse
    // eases up and down the block ramp instead (./working.ts) while the phrase
    // shimmers and the elapsed receipt advances. This interval IS the frame
    // clock -- FRAME_MS, 11.1fps, under the 12fps ceiling -- and it is
    // deliberately the only thing repainting the rung on a timer: the stream
    // may arrive as fast as it likes and the footer still moves no faster than
    // a person can read it. It must not be slower than FRAME_MS either, or the
    // repaint samples the easing curve unevenly and puts back exactly the
    // stepping the curve exists to remove.
    this.tick = setInterval(() => {
      if (this.mode === "turn") {
        // The title dedupes itself; the frame is scheduled only when the rung
        // actually reads differently. Eight unconditional repaints a second
        // rebuilt the banner, the composer and four engine readouts to draw
        // the same rows, and that CPU was what a keypress waited behind.
        this.paintTitle(turn);
        turn.tick();
        const lines = turn.liveLines();
        const key = lines.join("\n");
        if (key !== this.lastTickKey) {
          this.lastTickKey = key;
          this.turnPreview = lines;
          this.scheduleDraw();
        }
      } else if (this.mode === "question" && this.questionState?.deadline != null) {
        // 4th gear's grace window is real time passing, so it has to LOOK like
        // real time passing. A static "auto-continues in 60s" tells you nothing
        // about whether you have fifty seconds left or two.
        this.scheduleDraw();
      }
    }, FRAME_MS);

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
      // ── The TUI's OWN reducer over the event union ──
      //
      // It was a chain of `if (ev.type === …)` with no `assertNever` and no
      // test: a fourth live consumer of the same stream that the drift law
      // could not see, so a new member compiled clean here and this shell
      // silently ignored it forever. It is a switch now, it ends in
      // `assertNeverSoft`, and `tests/unit/protocol/exhaustiveness.test.ts`
      // names it — every member below is either counted or named as ignored.
      for await (const ev of engine.chat(this.ctx.sessionId, input)) {
        turn.onEvent(ev);
        switch (ev.type) {
          case "text_delta":
            answerText += ev.text;
            break;

          case "stream_reset":
            answerText = "";
            break;

          case "tool_call_end": {
            toolCalls++;
            if (!ev.output?.success) toolErrors++;
            // The answer landed and the work moved: take the pane off blocked.
            if (this.warpBlocked) {
              this.warpBlocked = false;
              this.warp("tool_complete", { toolName: ev.output?.toolName });
            }
            if (ev.output?.toolName === "interactive_dashboard") dashboardTouched = true;
            // Session-wide edited-files readout on the footer. One predicate
            // for every surface (see filesChangedFrom): before it, this footer
            // counted write/edit, the transcript counted those plus
            // apply_patch, the auto-commit scope counted multi_edit and worker
            // files, and headless counted a fourth set — four answers to "what
            // did this run change".
            if (ev.output?.success) {
              // The RESULT is part of the predicate's input, not an optional
              // extra: `apply_patch` reports its files there and has no `path`
              // argument, so a call without it silently dropped every patched
              // file from this readout while the other three surfaces counted
              // them.
              const paths = filesChangedFrom(ev.output.toolName, ev.args, ev.output.result);
              for (const path of paths) {
                if (!this.filesEdited.has(path)) filesChanged++;
                this.filesEdited.add(path);
              }
            }
            break;
          }

          // A quota stop ends the run but names its retry window — captured
          // here so the finally block can schedule the auto-resume.
          case "error":
            if (ev.error.includes("Quota exceeded")) quotaStop = ev.error;
            break;

          // ── Named and deliberately not counted by the shell ──
          // The transcript renderer above (`turn.onEvent`) draws all of these;
          // this reducer exists only for the shell's own bookkeeping — the
          // answer buffer, the tool counters, the footer's file set, the
          // checkpoint label and the quota stop. A member that needs none of
          // those is named here rather than defaulted.
          // A durability receipt, not a row: it says a resume pointer was
          // written. `rune doctor` reports the table and the resume path reads
          // it; the shell tracked it in a field nothing ever drew.
          case "checkpoint_saved":
          case "thinking_delta":
          case "tool_call_start":
          case "tool_call_args_delta":
          case "turn_complete":
          case "context_warning":
          case "notice":
          case "verification_started":
          case "verification_completed":
          case "todo_updated":
          case "step_check":
          case "fallback":
          case "retry":
          case "usage":
          case "compaction":
          case "lifecycle":
          case "handoff":
          case "replanning":
          case "tool_progress":
          case "task_kind":
          case "hypothesis":
          case "hypothesis_updated":
          case "decision":
          case "artifact":
          case "pending_decision":
          case "decision_resolved":
          case "decision_record":
            break;

          default:
            // Compile-time exhaustiveness: a new member is a type error here
            // until it is named above. At runtime an event from a NEWER host
            // is ignored rather than thrown (additive-minor contract).
            assertNeverSoft(ev, undefined);
            break;
        }
      }
    } catch (err) {
      // A user interrupt surfaces as an abort error -- that's expected, not a failure to report.
      if (!this.aborting) {
        turnFailed = true;
        turn.onError(err);
      }
    } finally {
      this.lastTurnMs = Math.max(0, Date.now() - this.turnStart);
      turn.finish({ aborted: this.aborting });
      this.lastPlanKey = turn.planKey() ?? this.lastPlanKey;
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

  openHeldPanel(steps: AutoModeDeferral[]): void {
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

  heldKey(key: Key): void {
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

  async runHeldSelected(index: number): Promise<void> {
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

  advanceHeld(from: number): void {
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
  closeHeldPanel(): void {
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

  quotaResume: { timer: ReturnType<typeof setTimeout>; at: number } | null = null;
  quotaResumeAttempts = 0;

  scheduleQuotaResume(stopMessage: string): void {
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

  cancelQuotaResume(silent = false): void {
    if (!this.quotaResume) return;
    clearTimeout(this.quotaResume.timer);
    this.quotaResume = null;
    if (!silent) this.print(`  ${faint("auto-resume cancelled")}`);
  }

  renderLoopCompletion(task: LoopTask, completion: LoopCompletion): string {
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

  async runDueLoopTask(): Promise<void> {
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
  expandWorkLog(): void {
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

  moveWorkReview(delta: number): void {
    const log = this.liveTurn?.fullLog() ?? this.reviewLog ?? "";
    const body = Math.max(0, log.split("\n").filter((line) => stripAnsi(line).trim()).length - 1);
    const maxTop = Math.max(0, body - workReviewPageSize(Math.max(4, rowsCount() - 1)));
    this.reviewTop = Math.max(0, Math.min(maxTop, this.reviewTop + delta));
    this.scheduleDraw();
  }

  closeWorkReview(): void {
    this.mode = this.reviewReturnMode === "turn" && this.liveTurn ? "turn" : "input";
    this.reviewLog = null;
    this.reviewTop = 0;
    this.scheduleDraw();
  }

  workReviewKey(key: Key): void {
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
  drainQueue(wasAborted: boolean): void {
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

  async runResearchFlow(query: string, depth?: ResearchOptions["depth"]): Promise<void> {
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

  async runResearchTurn(
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
    // A new turn starts with a fresh high-water mark for the live block.
    this.liveBlockRows = 0;
    this.lastTickKey = "";
    this.streamBuf = "";
    this.turnPreview = null;
    this.scheduleDraw();

    const turn = new TurnRenderer(
      {
        commit: (block, detail, reflow) => this.print(block, detail, reflow),
        // The fixed viewport owns its buffer, so a row can be amended after
        // it lands; --inline writes to the terminal's scrollback and cannot.
        amend: this.inline
          ? undefined
          : (handle, block, detail, reflow) => this.amend(handle, block, detail, reflow),
        preview: (lines) => {
          this.turnPreview = lines;
          this.scheduleDraw();
        },
      },
      {
        model: engine.getModel(),
        getCost: () => engine.getCost(),
        priorPlanKey: this.lastPlanKey ?? undefined,
      },
    );
    this.liveTurn = turn;
    this.tick = setInterval(() => {
      if (this.mode === "turn") {
        this.paintTitle(turn);
        turn.tick();
        const lines = turn.liveLines();
        const key = lines.join("\n");
        if (key !== this.lastTickKey) {
          this.lastTickKey = key;
          this.turnPreview = lines;
          this.scheduleDraw();
        }
      }
    }, FRAME_MS);

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
      this.lastTurnMs = Math.max(0, Date.now() - this.turnStart);
      turn.finish({ aborted: this.aborting });
      this.lastPlanKey = turn.planKey() ?? this.lastPlanKey;
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

  saveResearchReport(plan: ResearchPlan, question: string, report: ResearchReport): void {
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
      const body = `# Research: ${plan.question}\n\n_Generated by Rune | ${new Date().toISOString()}_\n\n${report.markdown}\n`;
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

// ─── The other three quarters ───
//
// `Tui` is one object spread over four files. The methods below were lifted out
// of this one verbatim; they are mixed onto the prototype here, at module load,
// long before anything constructs a Tui. The interface merge is what tells
// TypeScript they exist — an interface and a class of the same name in the same
// file are one declaration, so `this.renderViewport()` type-checks inside the
// class and `tui.frameZones()` type-checks inside tui-frame.ts.
//
// The members the moved methods reach are not marked `private` for the same
// reason: TypeScript's `private` is per declaration site, and there is only one
// declaration site. Nothing outside these four files imports `Tui`.
export interface Tui extends FrameMethods, InputMethods, CommandMethods {}
Object.assign(Tui.prototype, FRAME_METHODS, INPUT_METHODS, COMMAND_METHODS);
