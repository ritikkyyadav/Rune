// ─── TUI controller (raw mode) ───
// Gear's customizer-backed terminal UI: the supplied terminal card becomes the
// terminal itself — a warm-ivory/near-black full-window surface with a centered
// reading column. The browser-only canvas, nav pills, and swatches are not copied
// into production. Two render surfaces share every renderer + the engine:
//   • inline (explicit compatibility mode) — prints the transcript into the terminal's NORMAL buffer and pins
//     only the composer (BottomRegion). The terminal owns scrolling, so you get native
//     momentum smooth-scroll, real scrollback, and copy/paste for free; the theme bg is set
//     via OSC 11 (+ per-line SGR fallback for terminals that ignore it, e.g. Warp).
//   • alt-screen (ctx.fullscreen) — takes the alternate screen and repaints the whole
//     viewport each frame (AltScreen), painting the theme bg edge-to-edge at the cost of a
//     self-managed (non-native) scroll.
// Selected over the readline path with `--tui` / GEAR_TUI=1; `--inline` keeps native scrollback.

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
  PROVIDER_PRESETS,
  CUSTOM_PROVIDER_ID,
  loadLastModel,
  saveLastModel,
  saveSandboxState,
  saveBrowserState,
  getSystemMemoryPath,
} from "@gear/shared";
import type { CustomEndpoint } from "@gear/shared";
import { providerChoices, accountChoices, modelChoices, fetchLiveModels } from "./model-picker";
import { configModeToPermissionMode } from "../../permissions";
import { AltScreen, BottomRegion } from "./screen";
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
import { saveTheme } from "./theme-store";
import { buildPermissionPreview, type PermissionPreview } from "./permission-preview";
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
  /** Use the customizer-backed alternate-screen product surface. This is the default from CLI. */
  fullscreen?: boolean;
}

type Mode =
  | "input"
  | "turn"
  | "picker"
  | "permission"
  | "keys"
  | "ask"
  | "question"
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
    // No session choice on a 2-row card — swallow the shortcut so shift-tab
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

/**
 * Pure region-scroll hint for the alt-screen compositor: when only the
 * transcript window shifted between frames (streamed line, wheel notch) and
 * the band geometry is unchanged, return the `frame()` scroll hint that lets
 * the terminal's own hardware scroll move the band. Undefined = no clean
 * shift; the compositor falls back to its per-row diff. `delta` is negated
 * because a window that advanced (end grew) moves content UP on screen.
 */
export function transcriptScrollHint(
  prev: { end: number; bandTop: number; transH: number },
  next: { end: number; bandTop: number; transH: number; visibleLen: number },
): { top: number; bottom: number; delta: number } | undefined {
  const shifted = next.end - prev.end;
  if (
    prev.bandTop !== next.bandTop ||
    prev.transH !== next.transH ||
    next.transH <= 0 ||
    shifted === 0 ||
    Math.abs(shifted) >= next.transH ||
    // A part-empty band top-pads instead of shifting; only a full window scrolls.
    next.visibleLen !== next.transH
  ) {
    return undefined;
  }
  return { top: next.bandTop, bottom: next.bandTop + next.transH - 1, delta: -shifted };
}

type SessionListItem = ReturnType<Engine["listSessions"]>[number];

/** Empty launch placeholders are implementation detail, not conversation history. */
function isMeaningfulSession(session: SessionListItem): boolean {
  return session.eventCount > 0 || Boolean(session.title?.trim());
}

// `columns`/`rows` are 0 (not undefined) on a PTY with no winsize — `||` so a
// zero-size terminal falls back sanely instead of clamping every line to nothing.
const cols = () => process.stdout.columns || 80;
const rowsCount = () => process.stdout.rows || 24;
const MAX_TRANSCRIPT = 5000; // cap the in-memory scrollback
const SCROLL_STEP = 3; // lines per mouse-wheel notch

export async function runTui(ctx: TuiContext): Promise<void> {
  await new Tui(ctx).run();
}

class Tui {
  private screen = new AltScreen(); // focused full-window product surface
  private region = new BottomRegion(); // explicit inline compatibility surface
  /** False for the default full Gear card; true only through --inline / GEAR_INLINE. */
  private readonly inline: boolean;
  private transcript: string[] = []; // alt-screen only: themed lines, self-managed scrollback window
  private scroll = 0; // alt-screen only: lines scrolled up from the bottom (0 = following latest)
  private onResize = () => {
    if (this.inline) {
      // Native scrollback reflows itself; just redraw the pinned composer at the new width.
      this.renderRegion();
      return;
    }
    // Alt-screen: a resize reflows/clears the terminal, so the diff baseline is stale — repaint.
    setTermWidthOverride(this.contentCols());
    this.screen.invalidate();
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
  private aborting = false; // an esc/ctrl-c interrupt is in flight (guards the "interrupting…" flood)
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

  // render coalescing — collapse bursts of draw requests into one paint per frame (~60fps), so a
  // streamed token, a held arrow key, or a flick of the mouse wheel never trigger N full repaints.
  private drawScheduled = false;
  private drawTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPaint = 0;

  // hardware-scroll tracking: the visible window's bottom index (`end`) + band geometry at the last
  // paint, so drawComposer can tell AltScreen when the transcript band merely shifted (stream/scroll)
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
    /** Optional second action key (e.g. `d` = "select as default") — resolves with alt=true. */
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
    /** 4th-gear auto-continue: the run must survive an absent user. */
    timer?: ReturnType<typeof setTimeout>;
    autoContinue?: boolean;
  } | null = null;

  constructor(private ctx: TuiContext) {
    this.inline = !ctx.fullscreen;
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

  // ── lifecycle ──

  async run(): Promise<void> {
    const { engine } = this.ctx;

    // The banner is a live header (re-themed every frame), so nothing to seed here.
    // The handler is registered in every mode: the broker short-circuits to "allowed"
    // under Autonomy III, so it is never invoked there — and stays ready the instant
    // Shift+Tab cycles back to confirm/auto, without re-wiring.
    engine.setPermissionHandler(this.permissionHandler);
    // Auto mode's classifier approvals are silent at the broker; the chip
    // keeps them visible in the transcript without pausing the run (v2 spec).
    engine.setAutoApprovalNotifier?.((notice) => this.print(autoApprovedChip(notice)));
    engine.setQuestionHandler(this.questionHandler);

    // Poll cheaply; claimDueLoopTask() returns null while nothing is due and
    // runDueLoopTask() itself refuses to start unless the composer is idle.
    this.loopPoll = setInterval(() => void this.runDueLoopTask(), 1_000);

    const stdin = process.stdin;
    stdin.setEncoding("utf8");
    if (stdin.isTTY) stdin.setRawMode(true);
    process.stdout.write("\x1b[?2004h"); // bracketed paste on
    // Alt-screen captures the wheel to drive its self-managed scroll; inline leaves the wheel to
    // the terminal so native momentum scrollback works. So only report the mouse in alt-screen.
    if (!this.inline) process.stdout.write("\x1b[?1000h\x1b[?1006h"); // mouse button + SGR coords
    // Safety net: if we ever exit without running this.exit() (a crash), still leave the terminal
    // usable — drop mouse/paste reporting, restore the user's colours, and show the cursor.
    process.once("exit", () => {
      try {
        process.stdout.write(
          "\x1b[?1000l\x1b[?1006l\x1b[?2004l\x1b[0 q" + TERMINAL_THEME_RESET + "\x1b[?25h",
        );
      } catch {
        /* terminal already gone */
      }
    });
    stdin.resume();

    if (this.inline) this.enterInline();
    else this.screen.enter(themeBgSeq());
    process.stdout.on("resize", this.onResize);
    // Replay prior conversation when launched straight into a session (--resume /
    // `gear resume <id>`). When launchPick is set, the picker runs once input is
    // live (below) instead — a fresh session has nothing to seed.
    if (!this.ctx.launchPick) this.seedFromHistory();
    // First frame synchronous so the composer (and, inline, the banner) appears instantly.
    if (this.inline) this.renderRegion();
    else this.drawComposer();

    // System Memory: a one-time discoverability hint + a background "dream" when the
    // chosen cadence is due. Skipped while the launch picker owns the screen. The
    // dream no-ops fast unless an interval cadence is set and elapsed.
    if (!this.ctx.launchPick) {
      const mem = engine.getSystemMemory();
      if (mem.enabled && !mem.content.trim() && mem.scheduleLabel === "manual") {
        this.print(`  ${faint("tip: Gear can learn your style over time —")} ${info("/memory")}`);
      }
      void engine
        .maybeReflectSystemMemory()
        .then((r) => {
          if (r.updated) {
            this.print(
              `  ${ok("✦")} ${muted(`system memory refreshed (~${r.tokensAfter ?? 0} tokens) · /memory to view`)}`,
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
        if (!this.inline) process.stdout.write("\x1b[?1000l\x1b[?1006l"); // mouse tracking off
        if (this.drawTimer) clearTimeout(this.drawTimer); // cancel any pending coalesced paint
        if (this.inline) {
          this.region.clear(); // unmount the composer, leaving the transcript in scrollback
          process.stdout.write(TERMINAL_THEME_RESET); // restore the user's terminal colours
        } else {
          this.screen.exit(); // restore the main screen + the user's own colours
        }
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
      // skips the process "exit" hooks — which is exactly how a killed TUI
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
    });
  }

  private exit: (code?: number) => void = () => {};

  // ── input rendering ──

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
        workspace: this.ctx.workspaceRoot,
        mode: this.ctx.engine.getPermissionMode(),
        contextPercent,
        filesEdited: this.filesEdited.size || undefined,
        sandboxOff: !this.ctx.engine.isSandboxEnabled(),
        theme: getTheme().name === "auto" ? "auto" : getTheme().appearance,
        loop:
          loop.count > 0 && loop.nextRunAt !== null
            ? `${loop.count === 1 ? "loop" : `${loop.count} loops`} · ${formatLoopDue(loop.nextRunAt)}`
            : undefined,
      },
      this.contentCols(),
    );
  }

  /** Shift up one gear (Shift+Tab / `/gear` / `/mode`) — or straight to `target` — and announce it. */
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
  }

  // ── slash palette (live `/` menu) ──

  private slashCatalog(): SlashItem[] {
    const builtins: SlashItem[] = [
      { name: "/theme", desc: "Switch accent colors and light / dark mode", tag: "cosmetic" },
      { name: "/model", desc: "Choose model and provider", tag: "settings" },
      { name: "/sessions", desc: "Browse, resume, rename, archive & delete", tag: "history" },
      { name: "/mode", desc: "Shift gears — 1st · 2nd · 3rd · 4th · auto", tag: "shift+tab" },
      { name: "/diff", desc: "Inspect staged and uncommitted workspace changes", tag: "git" },
      { name: "/loop", desc: "Repeat a prompt while this session stays open" },
      { name: "/loops", desc: "List and manage this session's loops" },
      { name: "/resume", desc: "Open the session picker to continue past work" },
      { name: "/rename", desc: "Rename the current session" },
      { name: "/status", desc: "Session status" },
      { name: "/providers", desc: "List providers" },
      { name: "/keys", desc: "Manage API keys" },
      { name: "/mcp", desc: "Connected MCP servers and tools" },
      { name: "/skills", desc: "Browse or search available skills" },
      { name: "/research", desc: "Research — propose a plan, then a cited report" },
      { name: "/deepresearch", desc: "Deep research — multi-round, long-form" },
      { name: "/cost", desc: "Session cost" },
      { name: "/gear", desc: "Shift gears — /gear 1 | 2 | 3 | 4 | auto (empty shifts up)" },
      { name: "/autonomy", desc: "Legacy alias — /autonomy I | II | III = 2nd | 3rd | 4th gear" },
      { name: "/sandbox", desc: "OS sandbox for commands — on | off (off = full access)" },
      { name: "/browser", desc: "Agent web browser — on | off" },
      { name: "/rewind", desc: "Roll back the conversation" },
      { name: "/compress", desc: "Summarize & shrink context" },
      { name: "/undo", desc: "Revert the last Gear auto-commit" },
      { name: "/interactive", desc: "Live dashboard — [focus] · auto on|off · open" },
      { name: "/memory", desc: "System memory — your evergreen profile" },
      { name: "/notebook", desc: "Learned tactics for this workspace" },
      { name: "/bug", desc: "Flag a problem — records the flight trail" },
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
      // v2 status ladder: the run is paused on a human decision — say so in
      // the ochre "Waiting on approval…" rung above the card, with the live
      // elapsed receipt and the gear the decision is needed in.
      const waitSecs = Math.max(0, Math.floor((Date.now() - this.turnStart) / 1000));
      const head = waitingRung(waitSecs, this.perm.toolName, this.ctx.engine.getPermissionMode());
      return {
        lines: [head, ...card.lines],
        caretRow: card.caretRow + 1,
        caretCol: card.caretCol,
      };
    }
    if (this.mode === "ask" && this.askState) {
      const base = renderComposer({
        input: this.input,
        caret: this.caret,
        width: this.contentCols(),
        status: this.statusStr(),
      });
      const title = `  ${info("?")} ${text(this.askState.title)} ${faint("(Enter = ok · Esc = skip)")}`;
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
      });
      const head = [
        `  ${info("?")} ${bold(text(q.question))}`,
        ...q.options.map((opt, i) => `    ${info(String(i + 1))} ${text(opt)}`),
        `  ${faint(
          "1-" +
            q.options.length +
            " choose · or type an answer · Enter = 1 · Esc = skip" +
            (q.autoContinue ? " · auto-continues in 60s (4th gear)" : ""),
        )}`,
      ];
      return {
        lines: [...head, ...base.lines],
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
      // once the turn decides which partition — work rail or response — it belongs to).
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
   *  which breaks the pinned region's row math — and then every repaint leaks
   *  stale rows into the scrollback (the "duplicated spam" failure mode). */
  private bound(ln: string): string {
    return clampVisible(ln, Math.max(8, this.contentCols() - 1));
  }

  private pushLines(block: string): number {
    const lines = block.split("\n");
    // Store semantic ANSI only. Card/canvas backgrounds are applied per frame,
    // so a light/dark or accent change recolours the whole existing timeline.
    for (const ln of lines) this.transcript.push(this.bound(ln));
    if (this.transcript.length > MAX_TRANSCRIPT) {
      this.transcript.splice(0, this.transcript.length - MAX_TRANSCRIPT);
    }
    return lines.length;
  }

  private print(block: string): void {
    if (this.inline) {
      // Inline: completed blocks flow into the terminal's native scrollback above the pinned
      // composer (the terminal owns scrolling from here). printAbove redraws the composer after.
      const lines = block.split("\n").map((l) => withThemeBg(this.bound(l)));
      const comp = this.pinnedBlock();
      this.region.printAbove(lines.join("\r\n"), comp.lines, comp.caretRow, comp.caretCol);
      return;
    }
    const added = this.pushLines(block);
    // Follow the bottom when already there; if the user has scrolled up to read, hold their
    // view stationary as new lines stream in (don't yank them back down). Typing or submitting
    // resets scroll to 0, returning to the live tail.
    if (this.scroll > 0) this.scroll += added;
    this.scheduleDraw();
  }

  /** Inline surface only: redraw just the pinned composer block (the transcript lives in the
   *  terminal's own scrollback). The alt-screen surface uses drawComposer() instead. */
  private renderRegion(): void {
    const comp = this.pinnedBlock();
    this.region.render(comp.lines, comp.caretRow, comp.caretCol);
  }

  /** The pinned composer block, themed, width-bounded, and height-clamped to the viewport. The
   *  inline region draws with *relative* cursor moves, so a block taller than the screen would
   *  scroll the terminal mid-draw and desync that math (garbled/duplicated footer under heavy
   *  streaming). Keep the tail — the composer + status the user is actually using — and elide the
   *  top (the older work/prose preview) behind a marker. */
  private pinnedBlock(): { lines: string[]; caretRow: number; caretCol: number } {
    const comp = this.composerBlock();
    let lines = comp.lines.map((l) => withThemeBg(this.bound(l)));
    let caretRow = comp.caretRow;
    const max = Math.max(3, rowsCount() - 1);
    if (lines.length > max) {
      const drop = lines.length - max;
      const marker = withThemeBg(
        this.bound(
          `  ${faint(`… ${drop} more line${drop === 1 ? "" : "s"} above (ctrl+r to expand)`)}`,
        ),
      );
      lines = [marker, ...lines.slice(drop + 1)];
      caretRow = Math.max(0, caretRow - drop);
    }
    return { lines, caretRow, caretCol: comp.caretCol };
  }

  /** Inline surface: recolour the terminal in the theme, clear to a themed screen, and print the
   *  banner once at the top — it scrolls away with the conversation, like Codex/Claude Code. */
  private enterInline(): void {
    this.region.setBgFill(themeBgSeq());
    // OSC 10/11 sets the terminal's default fg/bg (themed margins where honoured); the SGR bg +
    // clear paints the visible screen now so the first frame isn't drawn over the old colours.
    process.stdout.write(terminalThemeSeq() + themeBgSeq() + "\x1b[2J\x1b[H\x1b[0m");
    this.printBanner();
  }

  /** Apply a runtime theme change to the terminal surface as well as future tokens. */
  private refreshThemeSurface(): void {
    if (this.inline) {
      // Reset first so switching from an explicit palette back to Auto truly hands
      // foreground/background control back to the host terminal.
      process.stdout.write(TERMINAL_THEME_RESET + terminalThemeSeq());
      this.region.setBgFill(themeBgSeq());
    } else {
      this.screen.invalidate();
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
   *  and — in 1st gear, where nothing does — what still asks. */
  private gearScope(): { scope: string; caution?: string } {
    const mode = modeInfo(this.ctx.engine.getPermissionMode());
    return {
      scope: mode.label,
      caution: mode.desc,
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
        sessionId: this.ctx.sessionId,
        workspace: this.ctx.workspaceRoot,
        version: this.ctx.version,
        sandbox: engine.isSandboxEnabled(),
        mcpServers: this.mcpServerCount(),
        ...this.gearScope(),
      }),
    );
  }

  /** Clear the visible transcript. Inline clears the real screen (scrollback is preserved) and
   *  reprints the banner; alt-screen just empties its in-memory window and repaints. */
  private resetTranscript(): void {
    this.transcript = [];
    this.scroll = 0;
    if (this.inline) {
      this.region.clear();
      process.stdout.write(themeBgSeq() + "\x1b[2J\x1b[3J\x1b[H\x1b[0m");
      this.printBanner();
    } else {
      this.scheduleDraw();
    }
  }

  /** The banner, rendered live (re-themed every frame) so the header always matches the
   *  current theme — pinned at the top of the viewport. */
  private bannerLines(): string[] {
    const { engine } = this.ctx;
    return renderBanner({
      model: engine.getModel(),
      modelLabel: this.modelLabel(),
      provider: engine.getProvider(),
      sessionId: this.ctx.sessionId,
      workspace: this.ctx.workspaceRoot,
      version: this.ctx.version,
      sandbox: engine.isSandboxEnabled(),
      mcpServers: this.mcpServerCount(),
      ...this.gearScope(),
    })
      .split("\n")
      .map((l) => this.bound(l));
  }

  /**
   * Repaint the whole surface: identity, transcript, anchored composer. The
   * content is left-aligned at its own small indent and bounded by the reading
   * measure — never centered. Centering a terminal's text column makes every
   * line start in a different place than the shell prompt above it, and the
   * measure already stops a wide window from producing 200-column sentences.
   */
  private drawComposer(): void {
    if (!this.screen.isActive) return;
    const R = rowsCount();
    const contentWidth = this.contentCols();
    const left = 0;
    const banner = this.bannerLines();
    const comp = this.composerBlock();
    const compLines = comp.lines.map((l) => clampVisible(l, contentWidth));
    const topRows = R >= 20 ? 1 : 0;
    const bottomRows = R >= 20 ? 1 : 0;
    // When scrolled up, reserve one row above the composer for a "more below" hint so the
    // user knows output isn't frozen and how to catch back up.
    const hintRows = this.scroll > 0 ? 1 : 0;
    const transH = Math.max(
      0,
      R - topRows - bottomRows - banner.length - compLines.length - hintRows,
    );

    const total = this.transcript.length;
    const maxScroll = Math.max(0, total - transH);
    if (this.scroll > maxScroll) this.scroll = maxScroll;
    const end = total - this.scroll;
    const visible = this.transcript.slice(Math.max(0, end - transH), end);

    const content: string[] = [...banner];
    for (let i = 0; i < transH - visible.length; i++) content.push("");
    content.push(...visible);
    if (hintRows) {
      content.push(
        this.scroll > 0
          ? `  ${faint(`↓ ${this.scroll} more line${this.scroll === 1 ? "" : "s"} below · scroll down to resume`)}`
          : "",
      );
    }
    content.push(...compLines);

    const contentRow = (line: string): string =>
      withThemeBg(" ".repeat(left) + clampVisible(line, contentWidth));

    const rows: string[] = [];
    for (let i = 0; i < topRows; i++) rows.push(withThemeBg(""));
    rows.push(...content.map(contentRow));
    for (let i = 0; i < bottomRows; i++) rows.push(withThemeBg(""));

    // Keep exactly R rows (guards tiny terminals / an oversized overlay).
    while (rows.length < R) rows.push(withThemeBg(""));
    if (rows.length > R) rows.splice(topRows + banner.length, rows.length - R);

    const bandTop = topRows + banner.length;
    // Hardware-scroll hint: when only the transcript window shifted since the
    // last frame (a streamed line, a wheel notch) and the band geometry is
    // unchanged, the compositor can shift the band with the terminal's own
    // region scroll and repaint just the exposed rows instead of rewriting
    // every band row. applyScroll verifies the overlap before using the hint,
    // so a stale or wrong hint safely degrades to the per-row diff.
    const scrollHint = transcriptScrollHint(
      { end: this.prevEnd, bandTop: this.prevBandTop, transH: this.prevTransH },
      { end, bandTop, transH, visibleLen: visible.length },
    );
    this.prevEnd = end;
    this.prevBandTop = bandTop;
    this.prevTransH = transH;

    const caretRow = Math.min(R - 1, bandTop + transH + hintRows + comp.caretRow);
    const caretCol = Math.min(cols() - 1, left + comp.caretCol);
    this.screen.frame(rows, caretRow, caretCol, scrollHint);
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
    else this.drawComposer();
  }

  private scrollBy(pages: number): void {
    if (this.inline) return; // native scrollback owns scrolling; nothing to emulate
    const page = Math.max(1, rowsCount() - 6);
    this.scroll = Math.max(0, this.scroll + pages * page);
    this.scheduleDraw(); // clamps to maxScroll
  }

  /** Scroll the transcript by a line delta (positive = toward older output). Alt-screen only —
   *  inline mode lets the terminal scroll its own buffer natively. */
  private scrollLines(lines: number): void {
    if (this.inline) return;
    this.scroll = Math.max(0, this.scroll + lines);
    this.scheduleDraw(); // clamps to maxScroll
  }

  private workingText(): string {
    if (this.aborting) return `${accent(HEX)} ${bold(text("Interrupting…"))}`;
    const elapsed = Date.now() - this.turnStart;
    const secs = Math.floor(elapsed / 1000);
    const t = secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m${secs % 60}s`;
    // The hint adapts: idle composer → how to stop; a typed-ahead draft → how to queue/clear it.
    const hint = this.input.length > 0 ? "enter queues · esc clears" : "esc to interrupt";
    return faint(`${t} · ${hint}`);
  }

  /** The v2 status ladder rung directly above the composer: the TurnRenderer's
   *  live lines (label + receipt, then a faint detail row) — or the
   *  interrupting state while an abort drains. */
  private turnStateLines(): string[] {
    if (this.aborting) return [`  ${this.workingText()}`];
    const lines = [...(this.turnPreview ?? [])];
    if (lines.length === 0) {
      const secs = Math.max(0, Math.floor((Date.now() - this.turnStart) / 1000));
      return [
        `  ${brand(GEAR_MARK)} ${bold(brand("Thinking"))}${faint("…")} ${faint(`(${secs}s)`)}`,
      ];
    }
    return lines.slice(0, 2).map((line) => clampVisible(line, Math.max(8, cols() - 1)));
  }

  // ── stdin routing ──

  private onData(chunk: string): void {
    // Bracketed paste is carved out of the stream as substrings (PasteScanner) — never fed through
    // parseKeys. A multi-megabyte paste (e.g. dumping a large doc) would otherwise allocate one Key
    // object per character and rebuild an accumulator char-by-char (O(n²)), freezing the UI for
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
    // The mouse wheel scrolls the transcript in every mode — even while a turn streams.
    if (key.type === "wheel-up") {
      this.scrollLines(SCROLL_STEP);
      return;
    }
    if (key.type === "wheel-down") {
      this.scrollLines(-SCROLL_STEP);
      return;
    }
    // Shift+Tab cycles confirm → Autonomy I → II → III → Auto → confirm while composing.
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
      case "review":
        this.workReviewKey(key);
        break;
    }
  }

  /** Land a finished paste: small single-line pastes drop in inline; anything multi-line or long
   *  collapses to a chip so the composer stays a clean single line (see `pastes`). */
  private endPaste(content: string): void {
    // Key/URL editor is a single-line field — always inline, newlines stripped by insertActive.
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

  /** Swap `[Pasted text #N …]` chips back to their stored bodies just before a message is sent. */
  private expandPastes(s: string): string {
    return expandPastes(s, this.pastes);
  }

  /** Drop paste bodies whose chip no longer appears in the composer (consumed or edited away). */
  private gcPastes(): void {
    if (this.pastes.size === 0) return;
    const live = livePasteIds(this.input);
    for (const id of [...this.pastes.keys()]) if (!live.has(id)) this.pastes.delete(id);
  }

  // ── input mode ──

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
    // When the `/` palette is open, ↑/↓ navigate it and tab/enter pick from it.
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
              `  ${accent("✕")} ${muted("stopped loop")} ${info(cancelled.task.id)} ${faint(loopPromptPreview(cancelled.task.prompt, 56))}`,
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

  // ── submit ──

  private async submit(): Promise<void> {
    const raw = this.expandPastes(this.input).trim();
    this.input = "";
    this.caret = 0;
    this.histIdx = -1;
    this.slashSel = 0;
    this.scroll = 0; // submitting jumps back to the live tail
    this.gcPastes(); // composer is empty now → release the paste bodies just consumed
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

  /** Echo, record, and execute one line of input — a slash command or a model turn. Shared by
   *  submit() and the type-ahead queue drained when a turn completes, so both run identically. */
  private async runInput(raw: string, scheduledLoop?: LoopTask): Promise<void> {
    if (!scheduledLoop) this.history.push(raw);

    // Echo the prompt into the transcript. A slash command is an instruction to the
    // shell (quiet echo); anything else is the user's message — the loud block.
    if (scheduledLoop) {
      this.print(
        `  ${warn("↻")} ${bold(text("Loop"))} ${info(scheduledLoop.id)} ${faint(`· iteration ${scheduledLoop.runCount + 1} · ${scheduledLoop.cadence}`)}`,
      );
      this.print(userBlock(raw, this.taskBarMeta()));
    } else if (raw.startsWith("/")) this.print(`  ${info("›")} ${text(raw)}`);
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

  // ── slash commands ──

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
            `  ${muted("Notebook is empty for this workspace — Gear fills it as it verifies how your repos work.")}`,
          );
        } else {
          this.print(
            [
              `  ${bold(text("Notebook — active for this workspace"))}`,
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
            ? `  ${text("✦ Logged with the current flight trail.")} ${muted(`gear incidents show ${id.slice(-8)}`)}`
            : `  ${muted("Could not record — see gear doctor.")}`,
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
            `  ${warn("Usage:")} ${info("/rename <title>")} ${faint("— renames the current session (or use /sessions)")}`,
          );
          return true;
        }
        engine.renameSession(this.ctx.sessionId, arg);
        this.print(`  ${ok("✓")} ${muted("renamed session to")} ${text(arg)}`);
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
        return true;
      }
      case "cost":
        this.print(`  ${muted(`$${engine.getCost().toFixed(4)}`)}`);
        return true;
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
              `  ${warn("Unknown provider")} ${info(id)} ${faint("(one word, no spaces — e.g. openai)")}`,
            );
            this.print(
              `  ${faint("Providers: ")}${faint(PROVIDER_PRESETS.map((p) => p.id).join(", "))}`,
            );
            return true;
          }
          const disabled = op === "off";
          persistDisabled(id, disabled);
          const res = engine.setProviderDisabled(id, disabled, this.ctx.sessionId);
          this.print(`  ${ok("✓")} ${info(id)} ${muted(disabled ? "disabled" : "enabled")}`);
          // Enabling only re-includes an already-credentialed provider — it does
          // NOT add a key. If it has none, point the user at how to add one.
          if (!disabled) {
            const row = engine.getProviderStatus().find((r) => r.id === id);
            if (row && !row.hasKey && !row.local) {
              this.print(
                `  ${warn("→")} ${muted(`${id} has no key yet — add one:`)} ${info(`/keys set ${id} <key>`)} ${muted("or")} ${info(`gear login ${id}`)}`,
              );
            }
          }
          if (res.switchedTo) {
            this.print(
              `  ${warn("→")} ${muted("active provider was off — now on")} ${info(`${res.switchedTo.provider}/${res.switchedTo.model}`)}`,
            );
          }
          return true;
        }
        // Data-driven listing: all providers, key state, on/off, active.
        const rows = engine.getProviderStatus().map((r) => {
          const dot = r.disabled
            ? faint("○")
            : r.active
              ? ok("●")
              : r.hasKey
                ? info("●")
                : faint("○");
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
            `  ${faint("toggle /providers on|off <id> · keys /keys · switch /model")}`,
          ].join("\n"),
        );
        return true;
      }
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
                ? ok("●")
                : server.health === "degraded"
                  ? warn("●")
                  : faint("○");
            lines.push(
              `    ${dot} ${text(server.name)} ${muted(`(${server.kind}, ${server.toolCount} tools)`)}`,
            );
            if (server.tools.length) lines.push(`      ${faint(server.tools.join(", "))}`);
            if (server.lastError) lines.push(`      ${warn("⚠")} ${faint(server.lastError)}`);
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
              `  ${bold(text("Skills"))} ${muted(`matching “${arg}”`)}`,
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
                  `    ${ok("●")} ${text(plugin.plugin)} ${muted(`(${plugin.skills.length})`)}`,
                  `      ${faint(plugin.skills.map((skill) => skill.name).join(", "))}`,
                ])
              : [
                  `    ${muted("None found. Add skills under ")}${info("skills/")}${muted(" or ")}${info(".gear/skills/")}${muted(".")}`,
                ]),
            `  ${faint("Skills load automatically when a request matches · search with /skills <keywords>")}`,
          ].join("\n"),
        );
        return true;
      }
      case "research":
      case "deepresearch": {
        const deep = cmd === "deepresearch";
        if (!arg) {
          const verb = deep ? "deep, multi-round research" : "research with a cited report";
          this.print(`  ${warn("Usage:")} ${info(`/${cmd} <question>`)} ${faint(`— ${verb}`)}`);
          return true;
        }
        await this.runResearchFlow(arg, deep ? "deep" : undefined);
        return true;
      }
      case "gear": {
        // /gear          → shift up one gear
        // /gear 3 | 3rd | auto → shift straight to that gear
        const target = configModeToPermissionMode(arg || undefined);
        if (arg && !target) {
          this.print(
            `  ${warn("Usage:")} ${info("/gear")} ${faint("[1|2|3|4|auto] — empty shifts up")}`,
          );
        } else this.cyclePermissionMode(target);
        return true;
      }
      case "autonomy": {
        // Legacy alias: /autonomy I|II|III → 2nd|3rd|4th gear.
        const target = configModeToPermissionMode(arg ? `autonomy-${arg}` : undefined);
        if (target) this.cyclePermissionMode(target);
        else
          this.print(
            `  ${warn("Usage:")} ${info("/autonomy")} ${faint("[I|II|III] — or /gear 1|2|3|4|auto")}`,
          );
        return true;
      }
      case "turing": // hidden compatibility aliases: toggle 4th gear
      case "hands-free": {
        this.cyclePermissionMode(engine.getPermissionMode() === "gear-4" ? "gear-1" : "gear-4");
        return true;
      }
      case "mode": {
        const raw = (arg ?? "").toLowerCase();
        const mode = configModeToPermissionMode(raw);
        if (mode) {
          this.cyclePermissionMode(mode);
        } else if (raw) {
          this.print(
            `  ${warn("Usage:")} ${info("/mode")} ${faint("[1|2|3|4|auto] — empty shifts up (same as /gear)")}`,
          );
        } else {
          this.cyclePermissionMode(); // no arg → advance the cycle, like Shift+Tab
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
            `  ${warn("Usage:")} ${info("/sandbox")} ${faint("[on|off] — empty shows the current state")}`,
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
            `  ${warn("Usage:")} ${info("/browser")} ${faint("[on|off] — empty shows the current state")}`,
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
            this.print(`  ${ok("✓")} ${muted("theme set to")} ${warn(getTheme().label)}`);
          } else this.print(`  ${accent("✕")} ${muted("unknown theme:")} ${faint(arg)}`);
          return true;
        }
        // Live-preview: navigating the picker repaints the whole screen in the theme; Esc reverts.
        const original = getTheme().name;
        // The v2 theme selector: accent name, its one-line character, and the
        // persisted theme id as the quiet tag.
        const ACCENT_DESC: Record<string, string> = {
          cobalt: "Signature blueprint blue",
          orange: "High-contrast amber",
          violet: "Modern editorial purple",
          emerald: "Terminal phosphor green",
          mono: "Minimalist grayscale",
        };
        const items: PickerItem[] = themes.map((t) => ({
          label: t.label,
          hint:
            t.name === "auto"
              ? "follows your terminal's own colors"
              : (t.gearAccent && ACCENT_DESC[t.gearAccent]) || `${t.appearance} surface`,
          prefix: paintBrandWith(t.name, "●"),
          current: t.name === original,
          tags: [t.name],
        }));
        const start = Math.max(
          0,
          themes.findIndex((t) => t.name === original),
        );
        const i = await this.pick(
          `Accent palette · ${getTheme().appearance}`,
          items,
          start,
          (idx) => {
            setTheme(themes[idx]!.name);
            this.refreshThemeSurface();
          },
          "Light or dark: /theme light · /theme dark · persisted to ~/.gear/theme.json",
        );
        if (i != null) {
          setTheme(themes[i]!.name);
          this.refreshThemeSurface();
          saveTheme(themes[i]!.name);
          this.print(`  ${ok("✓")} ${muted("theme set to")} ${warn(getTheme().label)}`);
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
                ? `  ${accent("◆")} ${muted("default:")} ${info(`${def.provider}/${def.model}`)} ${faint("· change: /model default <provider>/<model>, or d in /model")}`
                : `  ${muted("no default set —")} ${info("/model default <provider>/<model>")}${muted(", or press d on a model in /model")}`,
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
        this.print(`  ${ok("✓")} ${muted(`rewound to turn ${n} (removed ${removed})`)}`);
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
              `  ${ok("✓")} ${muted(`autonomous dashboards ${on ? "on" : "off"}`)} ${faint(
                on
                  ? "— Gear builds one when an answer is data-heavy"
                  : "— dashboards only when you ask (/interactive)",
              )}`,
            );
          } else {
            this.print(
              `  ${muted(`Autonomous dashboards: ${engine.isInteractiveAuto() ? "on" : "off"}`)} ${faint(
                "· toggle: /interactive auto on|off",
              )}`,
            );
          }
          return true;
        }
        if (sub === "open") {
          const info = engine.openDashboard(rest[0]);
          this.print(
            info
              ? `  ${ok("✓")} ${muted(`opened "${info.title}"`)} ${faint(info.url)}`
              : `  ${muted("No dashboard yet — run /interactive after a report, or ask for one.")}`,
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
          this.print(`  ${ok("✓")} ${muted(`reverted ${r.undoneSha}`)} ${faint(`(${r.subject})`)}`);
        } else {
          this.print(`  ${muted(`Cannot undo — ${r.reason}`)}`);
          if (!engine.isAutoCommitEnabled()) {
            this.print(
              `  ${faint("Tip: set [git] autoCommit = true in ~/.gear/config.toml so every run lands as a revertible commit.")}`,
            );
          }
        }
        return true;
      }
      case "compress": {
        this.print(`  ${faint("Compressing…")}`);
        const r = await engine.compactSession(this.ctx.sessionId, arg || undefined);
        if (!r.compacted) {
          this.print(`  ${muted(`Nothing to compact — ${r.reason}.`)}`);
          return true;
        }
        const fmtTok = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
        const saved =
          r.sourceTokens > 0
            ? Math.max(0, Math.round((1 - r.summaryTokens / r.sourceTokens) * 100))
            : 0;
        this.print(
          `  ${ok("✓")} ${muted(`compacted ${r.originalMessages} messages · ~${fmtTok(r.sourceTokens)} → ~${fmtTok(r.summaryTokens)} tokens (${saved}% smaller)`)}`,
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

        // ── update / refresh (the "dream") ──
        if (sub === "update" || sub === "refresh" || sub === "dream") {
          this.print(`  ${faint("Dreaming — distilling your profile…")}`);
          const r = await engine.reflectSystemMemory({
            focus: subArg || undefined,
            trigger: "manual",
          });
          if (!r.updated) {
            this.print(`  ${muted(`Memory unchanged — ${r.reason}.`)}`);
            return true;
          }
          const preview = (r.content ?? "")
            .split("\n")
            .map((l) => l.trimEnd())
            .filter(Boolean)
            .slice(0, 8);
          this.print(
            [
              `  ${ok("✦")} ${muted(`system memory refreshed · ~${fmtTok(r.tokensBefore)} → ~${fmtTok(r.tokensAfter)} tokens`)}`,
              ...preview.map((l) => `  ${faint(l.slice(0, 100))}`),
            ].join("\n"),
          );
          return true;
        }

        // ── add a manual note ──
        if (sub === "add" || sub === "note") {
          if (!subArg) {
            this.print(`  ${warn("Usage:")} ${info("/memory add <note>")}`);
            return true;
          }
          const r = engine.appendSystemMemoryNote(subArg);
          this.print(`  ${ok("✓")} ${muted(`noted · ~${fmtTok(r.tokens)} tokens total`)}`);
          return true;
        }

        // ── edit: suspend the TUI and open the profile in $EDITOR for real ──
        if (sub === "edit") {
          await this.editMemoryInEditor();
          return true;
        }

        // ── clear ──
        if (sub === "clear" || sub === "reset" || sub === "forget") {
          engine.clearSystemMemory();
          this.print(`  ${ok("✓")} ${muted("system memory cleared")}`);
          return true;
        }

        // ── set cadence (off | manual | daily | weekly | Nd | every N days) ──
        if (
          sub === "off" ||
          sub === "manual" ||
          sub === "daily" ||
          sub === "weekly" ||
          /^\d+\s*d/.test(arg) ||
          /^every\s+\d+/.test(arg)
        ) {
          const r = engine.setSystemMemorySchedule(arg);
          const verb = r.label === "manual" ? "manual (no auto-refresh)" : `auto · ${r.label}`;
          this.print(`  ${ok("✓")} ${muted("memory cadence:")} ${info(verb)}`);
          return true;
        }

        // ── default: status + show the profile ──
        const mem = engine.getSystemMemory();
        const last = mem.meta.updatedAt ? this.relTime(mem.meta.updatedAt) : "never";
        const dreamt = mem.meta.lastReflectedAt ? this.relTime(mem.meta.lastReflectedAt) : "never";
        const head = [
          `  ${bold(text("System memory"))}${mem.enabled ? "" : ` ${faint("(disabled)")}`}`,
          `  ${faint(`cadence: ${mem.scheduleLabel} · ~${fmtTok(mem.tokens)}/${fmtTok(mem.maxTokens)} tokens · updated ${last} · dreamed ${dreamt}`)}`,
        ];
        if (!mem.content.trim()) {
          this.print(
            [
              ...head,
              `  ${muted("Empty — Gear hasn't built your profile yet.")}`,
              `  ${faint("Seed it: /memory update · note: /memory add <…> · auto: /memory weekly")}`,
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
            `  ${faint("update: /memory update · note: /memory add <…> · cadence: /memory daily|3d|weekly|manual")}`,
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
        this.print(`  ${accent("✕")} ${muted(`unknown command: /${cmd}`)} ${faint("· /help")}`);
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
          `  ${bold(text(`Loops — ${tasks.length} active`))}`,
          ...tasks.map(
            (task) =>
              `    ${warn("↻")} ${info(task.id)} ${text(task.cadence === "fixed" ? `every ${formatLoopInterval(task.intervalMs)}` : `adaptive ${formatLoopInterval(task.intervalMs)}`)} ${faint(`· ${formatLoopDue(task.nextRunAt)} · ${loopPromptPreview(task.prompt, 54)}`)}`,
          ),
          `  ${faint("/loop cancel <id> · /loop clear · Esc stops the newest loop")}`,
        ].join("\n"),
      );
      return;
    }

    if (["cancel", "stop", "off", "delete", "rm"].includes(operation)) {
      const result = this.ctx.engine.cancelLoopTask(this.ctx.sessionId, tokens[1]);
      if (!result.ok || !result.task) {
        this.print(`  ${accent("✕")} ${muted(result.error ?? "Could not stop that loop.")}`);
      } else {
        this.print(
          `  ${accent("✕")} ${muted("stopped loop")} ${info(result.task.id)} ${faint(loopPromptPreview(result.task.prompt, 58))}`,
        );
      }
      return;
    }

    if (["clear", "cancel-all", "stop-all"].includes(operation)) {
      const count = this.ctx.engine.clearLoopTasks(this.ctx.sessionId);
      this.print(
        count > 0
          ? `  ${accent("✕")} ${muted(`stopped ${count} ${count === 1 ? "loop" : "loops"}`)}`
          : `  ${muted("No loops are active in this session.")}`,
      );
      return;
    }

    if (operation === "help") {
      this.print(
        [
          `  ${bold(text("Loop mode"))}`,
          `    ${info("/loop 5m check the deploy")} ${faint("fixed interval")}`,
          `    ${info("/loop check CI and review comments")} ${faint("adaptive 1–60m cadence")}`,
          `    ${info("/loop")} ${faint("built-in maintenance prompt, or .gear/loop.md")}`,
          `    ${info("/loops")} ${faint("list active tasks")}`,
          `    ${info("/loop cancel <id>")} ${faint("stop one · /loop clear stops all")}`,
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
          : `adaptive · first check ${formatLoopDue(task.nextRunAt)}`;
      this.print(
        [
          `  ${ok("✓")} ${text("loop scheduled")} ${info(task.id)} ${faint(`· ${cadence} · expires in 7d`)}`,
          `    ${faint("└")} ${muted(loopPromptPreview(task.prompt, Math.max(36, cols() - 10)))}`,
          ...(result.promptPath ? [`    ${faint(`prompt: ${result.promptPath}`)}`] : []),
          ...result.warnings.map((warning) => `    ${warn("•")} ${muted(warning)}`),
        ].join("\n"),
      );
    } catch (error) {
      this.print(
        `  ${accent("✕")} ${muted(error instanceof Error ? error.message : String(error))}`,
      );
    }
  }

  private modelPresets(reg: string[]): { provider: string; model: string; label: string }[] {
    // Data-driven from the provider presets: every registered provider with a
    // curated `models` list contributes its models, so adding a provider is a
    // one-line preset edit — no picker code to touch. Local runtimes (ollama /
    // lmstudio) are listed even when not yet active so they're discoverable —
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
    if (asDefault) {
      saveLastModel({ provider: engine.getProvider(), model: engine.getModel() });
      this.print(
        `  ${accent("◆")} ${muted("default set —")} ${info(now)} ${faint("(used at startup)")}`,
      );
    } else {
      this.print(
        `  ${ok("✓")} ${muted("switched to")} ${info(now)} ${faint("· this session only — d in /model, or /model default, sets the startup default")}`,
      );
    }
  }

  /**
   * The /model tree: providers → accounts/endpoints → models.
   * Level 1 lists only configured providers (plus local runtimes); level 2 the
   * real access paths for the chosen one (skipped when there is just one);
   * level 3 the models under that account — live-listed for local runtimes.
   * ⏎ switches this session; `d` also makes the pick the startup default.
   */
  private async modelTree(): Promise<void> {
    const engine = this.ctx.engine;
    const rows = engine.getProviderStatus();
    const customEp = engine.getCustomEndpoint();
    const current = { provider: String(engine.getProvider()), model: engine.getModel() };
    const def = loadLastModel();
    const defNote = def ? ` · default ${def.provider}/${def.model}` : "";

    // ── Level 1: providers ──
    const provs = providerChoices(rows, customEp, process.env, getPreset);
    const typeItem: PickerItem = { label: "Type provider/model…", hint: "anything not listed" };
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
      `Model · current ${current.provider}/${current.model}${defNote}`,
      l1,
      l1start,
      undefined,
      provs.length
        ? "subscriptions (Claude Pro/Max · ChatGPT · Copilot): gear login · keys: /keys"
        : "no providers configured yet — add a key with /keys or sign in with gear login",
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

    // ── Level 2: accounts / endpoints (skipped when only one path) ──
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
        `Model · ${chosen.label} · account`,
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
        // Picking a pooled key makes it the ACTIVE key — persisted and applied
        // to the live gateway, same as the /keys manager.
        const file = persistSetActiveKey(chosen.id, account.entryId);
        engine.setProviderKeys(
          chosen.id,
          readProviderKeyEntries(file, chosen.id),
          file.activeKeyId?.[chosen.id],
          this.ctx.sessionId,
        );
        this.print(
          `  ${ok("✓")} ${muted("active key now")} ${text(account.label)} ${faint(account.detail)}`,
        );
      }
      if (row.source === "oauth" || row.source === "keychain") {
        if (account?.kind === "key" || account?.kind === "env") {
          this.print(
            `  ${faint(`note: the signed-in ${row.source} credential wins on the wire —`)} ${info(`gear logout ${chosen.id}`)} ${faint("to use API keys")}`,
          );
        }
      } else if (account?.kind === "env" && accounts.some((x) => x.kind === "key")) {
        this.print(
          `  ${faint("note: the saved key wins on the wire —")} ${info(`/keys clear ${chosen.id}`)} ${faint("to use the env key")}`,
        );
      }
    }

    // ── Level 3: models under that account ──
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
      { label: "Type a model id…", hint: "anything not listed" },
      {
        label: "Back",
        hint: accounts.length > 1 ? "choose another account" : "choose another provider",
      },
    ];
    const crumb =
      accounts.length > 1 && account
        ? `Model · ${chosen.label} · ${account.label.replace("API key · ", "key ")}`
        : `Model · ${chosen.label}`;
    if (chosen.local && !live) {
      this.print(
        `  ${faint(`endpoint ${row.endpoint ?? ""} not reachable — showing suggestions`)}`,
      );
    }
    const a3 = await this.pickAlt(
      crumb,
      l3,
      Math.max(
        0,
        models.findIndex((m) => m.current),
      ),
      "⏎ use now (this session) · d = use now and make it the startup default · esc back",
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
    this.applyModelSwitch(chosen.id, pickM.id, a3.alt);
  }

  // ── picker mode ──

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
   * A picker with a second action key: ⏎ resolves `{ index, alt: false }`,
   * `altKey` resolves `{ index, alt: true }` (the /model tree uses `d` for
   * "use now AND make it the startup default"). esc → null.
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

  // ── ask mode (transient single-line text prompt; used by /research) ──

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

  // ── sessions manager (`/sessions`) ──

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
      meta: parts.filter(Boolean).join(" · "),
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
    this.print(`  ${ok("✓")} ${muted("started a new session")}`);
  }

  /** Load the selected session's history into the transcript and continue it. */
  private resumeSelected(): void {
    const s = this.sessionsList[this.sessionsSel];
    if (!s) {
      this.closeSessions();
      return;
    }
    // Already the live session — nothing to reload.
    if (s.id === this.ctx.sessionId && this.sessionsView === "active") {
      this.closeSessions();
      return;
    }
    const res = this.ctx.engine.resumeSession(s.id);
    this.mode = "input";
    this.sessionsPendingDelete = null;
    if (!res) {
      this.print(`  ${accent("✕")} ${muted("could not open that session")}`);
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
      `  ${faint("╶─")} ${muted("resumed")} ${text(title)} ${faint(this.shortId(id))} ${faint("╶─")}`,
    );
    this.printTranscriptLines(lines);
    if (lines.length === 0) this.print(`  ${faint("(no earlier messages)")}`);

    if (res.switched) {
      this.print(
        `  ${ok("✓")} ${muted("model")} ${info(`${this.ctx.engine.getProvider()}/${this.ctx.engine.getModel()}`)}`,
      );
    } else if (!res.providerKnown) {
      this.print(
        `  ${warn("•")} ${muted("couldn't detect this session's provider —")} ${info("/model")} ${muted("if replies look off")}`,
      );
    }
    this.print(`  ${faint("continue where you left off ↓")}`);
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
      `  ${faint("╶─")} ${muted("resumed")} ${text(title)} ${faint(this.shortId(this.ctx.sessionId))} ${faint("╶─")}`,
    );
    this.printTranscriptLines(lines);
    this.print(`  ${faint("continue where you left off ↓")}`);
  }

  /**
   * Launch flow: started without a target session but prior work exists → offer a
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
    if (recent.length === 0) return; // nothing to resume — stay in the fresh session

    const items: PickerItem[] = [
      { label: "✦  Start a new session", hint: "fresh start" },
      ...recent.map((s) => {
        const v = this.sessionRowView(s);
        return { label: v.title, hint: v.meta };
      }),
    ];
    const i = await this.pick("Resume a session", items, 0);
    if (i == null || i === 0) return; // Esc or "new" → keep the fresh session

    const s = recent[i - 1];
    if (!s) return;
    const res = this.ctx.engine.resumeSession(s.id);
    if (!res) {
      this.print(`  ${accent("✕")} ${muted("could not open that session")}`);
      return;
    }
    this.replayTranscript(s.id, s, res);
  }

  private async renameSelected(): Promise<void> {
    const s = this.sessionsList[this.sessionsSel];
    if (!s) return;
    const current = s.title && s.title.trim() ? s.title.trim() : "untitled";
    const name = await this.promptLine(`Rename "${current}" →`);
    if (name != null && name.trim()) this.ctx.engine.renameSession(s.id, name.trim());
    // promptLine returns us to "input" mode — re-open the manager on the same row.
    this.openSessions(this.sessionsView);
    const idx = this.sessionsList.findIndex((x) => x.id === s.id);
    if (idx >= 0) this.sessionsSel = idx;
    this.scheduleDraw();
  }

  private archiveSelected(): void {
    const s = this.sessionsList[this.sessionsSel];
    if (!s) return;
    this.ctx.engine.archiveSession(s.id);
    this.print(`  ${ok("✓")} ${muted("archived")} ${faint(s.title?.trim() || "untitled")}`);
    // Archiving the live session would orphan chat() (getSession rejects non-active) — land in a fresh one.
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
    this.print(`  ${ok("✓")} ${muted("restored")} ${faint(s.title?.trim() || "untitled")}`);
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
      `  ${ok("✓")} ${muted("deleted")} ${faint(s.title?.trim() || "untitled")} ${faint("· recoverable until purged")}`,
    );
    // Deleting the live session would orphan chat() — open a fresh one to land in.
    if (s.id === this.ctx.sessionId) {
      this.ctx.sessionId = this.ctx.engine.createSession();
      this.resetTranscript();
      this.print(`  ${faint("started a new session")}`);
    }
    this.refreshSessions();
  }

  // ── keys mode (BYOK API keys) ──

  // ── memory panel (`/memory`) ──

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
      ? `refreshed · ~${res.tokensAfter} tokens`
      : `unchanged — ${res.reason}`;
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
   * back in. The genuine in-app edit path — no "go use classic mode" punt.
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

    // ── suspend ──
    if (this.drawTimer) {
      clearTimeout(this.drawTimer);
      this.drawTimer = null;
    }
    process.stdout.write("\x1b[?2004l"); // bracketed paste off
    if (!this.inline) process.stdout.write("\x1b[?1000l\x1b[?1006l"); // mouse off
    if (this.inline) {
      this.region.clear();
      process.stdout.write(TERMINAL_THEME_RESET);
    } else {
      this.screen.exit();
    }
    if (stdin.isTTY) stdin.setRawMode(false);
    stdin.pause();
    process.stdout.write("\x1b[?25h"); // show cursor for the editor

    let okEdit = true;
    try {
      const { spawnSync } = require("node:child_process");
      const r = spawnSync(editor, [path], { stdio: "inherit" });
      if (r?.error) okEdit = false;
    } catch {
      okEdit = false;
    }

    // ── resume ──
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    process.stdout.write("\x1b[?2004h");
    if (!this.inline) process.stdout.write("\x1b[?1000h\x1b[?1006h");
    if (this.inline) this.enterInline();
    else this.screen.enter(themeBgSeq());

    if (okEdit) {
      try {
        const { readFileSync } = require("fs");
        const res = engine.setSystemMemoryContent(readFileSync(path, "utf-8"));
        this.memoryNote = `saved · ~${res.tokens} tokens`;
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
      title: `Add API key — ${mgr.label}`,
      subtitle: preset?.docsUrl ? `paste a key from any account · ${preset.docsUrl}` : undefined,
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
      // Walk base URL → model → key for the user-defined endpoint.
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
        title: "Custom endpoint — base URL",
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
        title: `${row.label} — base URL`,
        subtitle: "local server URL · no API key needed · empty resets to default",
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
        title: `Paste API key — ${row.label}`,
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

    // ── Add a key to a provider's multi-account pool (append, not replace) ──
    if (e.mode === "add") {
      if (e.field === "key") {
        if (!val) {
          this.keysEdit = null; // nothing pasted → back to the manager
          this.scheduleDraw();
          return;
        }
        e.pending.newKey = val;
        e.field = "label";
        e.value = "";
        e.caret = 0;
        e.masked = false;
        e.title = `Label this key — ${e.label}`;
        e.subtitle = "optional · name the account (e.g. work, personal) · enter to skip";
        this.scheduleDraw();
        return;
      }
      // field === "label" → commit the add
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
        `  ${ok("✓")} ${muted("added key for")} ${info(e.label)}${val ? faint(` · ${val}`) : ""} ${faint(`· ${count} configured`)}`,
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
        e.title = "Custom endpoint — model";
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
        e.title = "Custom endpoint — API key";
        e.subtitle = undefined;
        this.scheduleDraw();
        return;
      }
      // field === "key" → commit
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
        `  ${ok("✓")} ${muted("saved custom endpoint")} ${faint(ep.baseUrl)} ${faint("· use /model to switch")}`,
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
        `  ${ok("✓")} ${muted(`${e.label} endpoint`)} ${faint(shown)} ${faint("· /model to switch")}`,
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
      `  ${ok("✓")} ${muted("saved key for")} ${info(e.label)} ${faint("· use /model to switch")}`,
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
        `  ${warn("→")} ${muted("active provider unavailable — now on")} ${info(`${res.switchedTo.provider}/${res.switchedTo.model}`)}`,
      );
    }
  }

  // ── permission mode ──

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
      this.scheduleDraw();
    });
  };

  // ── ask_user question mode ──

  private questionHandler = (q: { question: string; options: string[] }): Promise<string> =>
    new Promise<string>((resolve) => {
      this.questionState = {
        resolve,
        question: q.question,
        options: q.options,
        prevMode: this.mode,
      };
      this.input = "";
      this.caret = 0;
      this.mode = "question";
      // 4th gear asks like every other gear — the user is usually right here —
      // but must never park an autonomous run on a question nobody answers:
      // after a grace window the picker dismisses itself and the model
      // proceeds on its own judgment, keeping fire-and-forget intact.
      if (this.ctx.engine.getPermissionMode() === "gear-4") {
        this.questionState.autoContinue = true;
        this.questionState.timer = setTimeout(() => {
          this.finishQuestion(
            "(no answer within 60s — proceed with your best judgment and state the assumption)",
          );
        }, Tui.QUESTION_AUTO_CONTINUE_MS);
      }
      this.scheduleDraw();
    });

  /** Resolve the pending ask_user question and restore the turn UI. */
  private finishQuestion(answer: string): void {
    const q = this.questionState;
    if (!q) return;
    if (q.timer) clearTimeout(q.timer);
    this.questionState = null;
    this.input = "";
    this.caret = 0;
    // Return to the in-flight turn (questions only fire mid-turn).
    this.mode = q.prevMode === "question" ? "turn" : q.prevMode;
    this.print(`  ${ok("✓")} ${muted(truncate(answer, 80))}`);
    this.scheduleDraw();
    q.resolve(answer);
  }

  private questionKey(key: Key): void {
    const q = this.questionState;
    if (!q) return;
    // Bare digit with an empty composer = instant pick.
    if (key.type === "char" && this.input.length === 0 && /^[1-9]$/.test(key.value)) {
      const n = Number(key.value);
      if (n >= 1 && n <= q.options.length) return this.finishQuestion(q.options[n - 1]);
    }
    if (key.type === "enter") {
      const typed = this.input.trim();
      return this.finishQuestion(typed || q.options[0]);
    }
    if (key.type === "esc") {
      return this.finishQuestion("(user skipped the question — proceed with your best judgment)");
    }
    // Everything else edits the composer (free-text answer).
    if (this.editComposer(key)) this.scheduleDraw();
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
        ? muted("◇ declined · no action taken")
        : ok(decision.kind === "allow_session" ? "✓ approved for session" : "✓ approved once");
    this.print(`  ${label}`);
    r(decision);
  }

  // ── turn mode (streaming) ──

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
            this.print(`  ${accent("✕")} ${muted(`loop ${this.activeLoopId} stopped`)}`);
        }
        // Guard the flood: one interrupt request per turn, however many times esc is pressed.
        this.aborting = true;
        this.ctx.engine.abort();
        this.print(`  ${accent("✕")} ${muted("interrupting…")}`);
        this.scheduleDraw();
      }
      return;
    }
    // Backspace with an empty composer removes the most recently queued
    // message — the strip advertises this, so queueing stays reversible.
    if (key.type === "backspace" && this.input.length === 0 && this.queued.length > 0) {
      this.queued.pop();
      this.scheduleDraw();
      return;
    }
    // Enter mid-turn: STEER the live run — the message is folded into the
    // agent's context at the next tool boundary, so it adapts its plan without
    // restarting (Claude Code-style). Slash commands can't run mid-turn, and
    // planner-mode/research runs aren't steerable — those queue and run when
    // the turn finishes (the previous behaviour).
    if (key.type === "enter") {
      const raw = this.expandPastes(this.input).trim();
      if (raw) {
        const steered = !raw.startsWith("/") && this.ctx.engine.interject(raw);
        if (steered) {
          this.history.push(raw);
          this.print(userBlock(raw));
          this.print(`  ${info("↪")} ${faint("folded into the running task")}`);
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
    this.turnStart = Date.now();
    this.streamBuf = "";
    this.turnPreview = null;
    this.scheduleDraw();

    // Collapsed rendering (see ./turn.ts): narration and the final answer stay in
    // the open; the heavy work accumulates in a hidden log whose live tail — plus
    // the to-do checklist and a preview of the streaming prose — shows in the
    // pinned window above the composer. finish() sets down the collapsed summary,
    // edit chips, the plan's final state, the record line, and the answer.
    const turn = new TurnRenderer(
      {
        commit: (block) => this.print(block),
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
    this.activeLoopId = scheduledLoop?.id ?? null;

    try {
      for await (const ev of engine.chat(this.ctx.sessionId, input)) {
        turn.onEvent(ev);
        if (ev.type === "text_delta") answerText += ev.text;
        if (ev.type === "stream_reset") answerText = "";
        if (ev.type === "tool_call_end") {
          toolCalls++;
          if (!ev.output?.success) toolErrors++;
        }
        if (ev.type === "tool_call_end" && ev.output?.toolName === "interactive_dashboard") {
          dashboardTouched = true;
        }
        if (ev.type === "checkpoint_saved") {
          this.lastCheckpoint = { sessionId: this.ctx.sessionId, label: `v${ev.version}` };
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
      // A user interrupt surfaces as an abort error — that's expected, not a failure to report.
      if (!this.aborting) {
        turnFailed = true;
        turn.onError(err);
      }
    } finally {
      turn.finish({ aborted: this.aborting });
      if (
        !this.aborting &&
        !dashboardTouched &&
        !this.interactiveTipShown &&
        !engine.isInteractiveAuto() &&
        shouldOfferInteractive(answerText)
      ) {
        this.interactiveTipShown = true;
        this.print(`  ${faint("✦ /interactive — view this as a live dashboard")}`);
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
      this.drainQueue(wasAborted);
    }
  }

  private renderLoopCompletion(task: LoopTask, completion: LoopCompletion): string {
    if (completion.state === "rescheduled" && completion.task) {
      return `  ${warn("↻")} ${muted(`loop ${task.id} next ${formatLoopDue(completion.task.nextRunAt)}`)} ${faint(`· ${completion.reason}`)}`;
    }
    if (completion.state === "stopped") {
      return `  ${ok("✓")} ${muted(`loop ${task.id} complete`)} ${faint(`· ${completion.reason}`)}`;
    }
    if (completion.state === "expired") {
      return `  ${muted(`loop ${task.id} expired`)} ${faint(`· ${completion.reason}`)}`;
    }
    return `  ${muted(`loop ${task.id} stopped`)}`;
  }

  private async runDueLoopTask(): Promise<void> {
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
        `  ${accent("✕")} ${muted(`loop failed: ${error instanceof Error ? error.message : String(error)}`)}`,
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
   *  cancelled — the most recent draft is restored to the composer (when empty) so nothing
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

  // ── research mode (/research) ──

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
              { label: "Revise…", hint: "give feedback and re-plan" },
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
      this.print(`  ${accent("✕")} ${text(err instanceof Error ? err.message : String(err))}`);
    }
  }

  private async runResearchTurn(
    plan: ResearchPlan,
    question: string,
    opts?: ResearchOptions,
  ): Promise<void> {
    // Research renders through the SAME TurnRenderer as every other turn —
    // same live rung, same rail rows, same streaming prose, same receipts.
    // (It used to be a second product wearing the same binary: its own event
    // printing, raw unwrapped report streaming, its own error format — the
    // exact "many pieces, not one system" seam.)
    const { engine } = this.ctx;
    this.mode = "turn";
    this.aborting = false;
    this.turnStart = Date.now();
    this.streamBuf = "";
    this.turnPreview = null;
    this.scheduleDraw();

    const turn = new TurnRenderer(
      {
        commit: (block) => this.print(block),
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
        this.scheduleDraw();
      }
    }, 125);

    let report: ResearchReport | null = null;
    try {
      for await (const ev of engine.runResearch(this.ctx.sessionId, plan, opts)) {
        if (ev.type === "research_report_delta") {
          // The report IS the answer — stream it as the turn's prose so it
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
      const body = `# Research: ${plan.question}\n\n_Generated by Gear · ${new Date().toISOString()}_\n\n${report.markdown}\n`;
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
