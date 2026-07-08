// ─── TUI controller (raw mode) ───
// Codex/Claude-Code-style terminal UI: a pinned composer at the bottom, transcript
// scrolling above it. Two render surfaces share every renderer + the engine:
//   • inline (default) — prints the transcript into the terminal's NORMAL buffer and pins
//     only the composer (BottomRegion). The terminal owns scrolling, so you get native
//     momentum smooth-scroll, real scrollback, and copy/paste for free; the theme bg is set
//     via OSC 11 (+ per-line SGR fallback for terminals that ignore it, e.g. Warp).
//   • alt-screen (ctx.fullscreen) — takes the alternate screen and repaints the whole
//     viewport each frame (AltScreen), painting the theme bg edge-to-edge at the cost of a
//     self-managed (non-native) scroll.
// Selected over the readline path with `--tui` / ALAN_TUI=1; `--fullscreen` picks alt-screen.

import type {
  Engine,
  PermissionHandler,
  UserPermissionDecision,
  TranscriptLine,
} from "../../engine";
import { findCommand, type SlashCommand } from "../../commands";
import {
  setProviderKey as persistKey,
  clearProviderKey as persistClearKey,
  setCustomEndpoint as persistCustom,
  clearCustomEndpoint as persistClearCustom,
  setProviderDisabled as persistDisabled,
  setLocalEndpoint as persistLocalEndpoint,
  getPreset,
  PROVIDER_PRESETS,
  CUSTOM_PROVIDER_ID,
  saveLastModel,
  saveSandboxState,
  getSystemMemoryPath,
} from "@alan/shared";
import type { CustomEndpoint } from "@alan/shared";
import { AltScreen, BottomRegion } from "./screen";
import { parseKeys, type Key } from "./keys";
import { PasteScanner, shouldCollapse, pasteChip, expandPastes, livePasteIds } from "./paste";
import {
  renderComposer,
  renderPicker,
  renderSlashPalette,
  renderKeysPanel,
  renderKeyEditor,
  renderSessionsPanel,
  renderMemoryPanel,
  MEMORY_ACTION_COUNT,
  renderPermissionCard,
  statusLine,
  permissionModeBanner,
  sandboxModeBanner,
  type RenderedBlock,
  type PickerItem,
  type SlashItem,
  type KeyRow,
  type SessionRowView,
} from "./composer";
import { renderBanner } from "./banner";
import { renderStatus } from "./status";
import { TurnRenderer, userBlock, renderReplay, HEX, cookingVerb } from "./turn";
import { truncate, clampVisible } from "./render";
import { renderResearchPlan, renderClarifyingQuestions, formatResearchEvent } from "./research";
import { isClarification } from "../../research-types";
import type { ResearchOptions, ResearchPlan, ResearchReport } from "../../research-types";
import {
  bold,
  text,
  muted,
  faint,
  info,
  ok,
  accent,
  warn,
  setTheme,
  getTheme,
  listThemes,
  withThemeBg,
  themeBgSeq,
  terminalThemeSeq,
  TERMINAL_THEME_RESET,
} from "./theme";
import { saveTheme } from "./theme-store";
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
  /** Use the alternate-screen full-window renderer (edge-to-edge theme bg) instead of the
   *  default inline renderer (native scrollback + momentum scroll, like Codex/Claude Code). */
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
  | "memory";

type SessionListItem = ReturnType<Engine["listSessions"]>[number];

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
  private screen = new AltScreen(); // alt-screen surface (ctx.fullscreen)
  private region = new BottomRegion(); // inline surface (default): pinned composer over native scrollback
  /** Inline (native-scrollback) renderer is the default; alt-screen is opt-in via ctx.fullscreen. */
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

  // `/memory` System Memory panel
  private memorySel = 0;
  private memoryBusy = false;
  private memoryNote: string | null = null;
  private memoryPendingClear = false;

  // `/keys` BYOK panel
  private keysSel = 0;
  private keysRows: KeyRow[] = [];
  private keysEdit: {
    id: string;
    label: string;
    field: "key" | "baseUrl" | "model";
    value: string;
    caret: number;
    masked: boolean;
    pending: { baseUrl?: string; model?: string };
    title: string;
    subtitle?: string;
  } | null = null;

  // turn state
  private turnStart = 0;
  private tick: ReturnType<typeof setInterval> | null = null;
  private streamBuf = "";
  private queued: string[] = []; // type-ahead: messages composed mid-turn, run in order on completion
  private aborting = false; // an esc/ctrl-c interrupt is in flight (guards the "interrupting…" flood)
  private currentActivity: string | null = null; // in-flight tool label, shown on the status line
  private turnPreview: string[] | null = null; // live window: recent work + to-dos + prose preview
  private filesEdited = new Set<string>(); // session-wide, shown on the footer readout
  private interactiveTipShown = false; // the /interactive offer fires at most once per session
  private lastWorkLog: string | null = null; // the last turn's full work log (ctrl+r expands it)
  private liveTurn: TurnRenderer | null = null; // in-flight renderer (ctrl+r mid-turn)
  private turnSeed = 0; // picks this turn's working word (Cooking…, Brewing…, …)

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
    resolve: (i: number | null) => void;
    onPreview?: (i: number) => void;
  } | null = null;
  private perm: {
    resolve: (d: UserPermissionDecision) => void;
    toolName: string;
    argsSummary: string;
  } | null = null;
  // transient single-line text prompt (used by /research clarify & revise)
  private askState: { resolve: (s: string | null) => void; title: string } | null = null;
  // ask_user tool: blocking question with numbered options (turn-time).
  private questionState: {
    resolve: (s: string) => void;
    question: string;
    options: string[];
    prevMode: Mode;
  } | null = null;

  constructor(private ctx: TuiContext) {
    this.inline = !ctx.fullscreen;
  }

  // ── lifecycle ──

  async run(): Promise<void> {
    const { engine } = this.ctx;

    // The banner is a live header (re-themed every frame), so nothing to seed here.
    // The handler is registered in every mode: the broker short-circuits to "allowed"
    // under Hands-Free, so it's simply never invoked there — and stays ready the instant
    // Shift+Tab cycles back to confirm/auto, without re-wiring.
    engine.setPermissionHandler(this.permissionHandler);
    engine.setQuestionHandler(this.questionHandler);

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
          "\x1b[?1000l\x1b[?1006l\x1b[?2004l" + TERMINAL_THEME_RESET + "\x1b[?25h",
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
    // `alan resume <id>`). When launchPick is set, the picker runs once input is
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
        this.print(
          `  ${faint("✦ tip: Berne can learn your style & codebases over time —")}${info("/memory")}${faint(" (auto-update: /memory weekly)")}`,
        );
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
        process.stdout.write(`  ${muted("Goodbye.")}\n`);
        engine.close();
        resolve();
        process.exit(code);
      };
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
    return statusLine({
      model: this.ctx.engine.getModel(),
      workspace: this.ctx.workspaceRoot,
      mode: this.ctx.engine.getPermissionMode(),
      contextPercent,
      filesEdited: this.filesEdited.size || undefined,
      sandboxOff: !this.ctx.engine.isSandboxEnabled(),
    });
  }

  /** Advance the permission mode one step (Shift+Tab / `/hands-free` / `/mode`) and announce it. */
  private cyclePermissionMode(mode?: ReturnType<Engine["getPermissionMode"]>): void {
    let next: ReturnType<Engine["getPermissionMode"]>;
    if (mode) {
      this.ctx.engine.setPermissionMode(mode);
      next = mode;
    } else {
      next = this.ctx.engine.cyclePermissionMode();
    }
    // Keep the ctx mirror current for any other reader of these flags.
    this.ctx.yoloMode = next === "turing";
    this.ctx.trustWorkspace = next === "auto";
    this.print(permissionModeBanner(next));
  }

  // ── slash palette (live `/` menu) ──

  private slashCatalog(): SlashItem[] {
    const builtins: SlashItem[] = [
      { name: "/model", desc: "Switch model / provider" },
      { name: "/theme", desc: "Themes — switch color theme" },
      { name: "/sessions", desc: "Browse, resume, rename, archive & delete sessions" },
      { name: "/resume", desc: "Open the session picker to continue past work" },
      { name: "/rename", desc: "Rename the current session" },
      { name: "/status", desc: "Session status" },
      { name: "/providers", desc: "List providers" },
      { name: "/keys", desc: "Manage API keys" },
      { name: "/research", desc: "Research — propose a plan, then a cited report" },
      { name: "/deepresearch", desc: "Deep research — multi-round, long-form" },
      { name: "/cost", desc: "Session cost" },
      { name: "/plan", desc: "Toggle plan mode" },
      { name: "/hands-free", desc: "Hands-Free — toggle bypass mode (shift+tab)" },
      { name: "/mode", desc: "Cycle permission mode (confirm/auto/hands-free)" },
      { name: "/sandbox", desc: "OS sandbox for commands — on | off (off = full access)" },
      { name: "/rewind", desc: "Roll back the conversation" },
      { name: "/compress", desc: "Summarize & shrink context" },
      { name: "/undo", desc: "Revert the last Berne auto-commit" },
      { name: "/interactive", desc: "Live dashboard — [focus] · auto on|off · open" },
      { name: "/memory", desc: "System memory — your evergreen profile" },
      { name: "/notebook", desc: "Learned tactics for this workspace" },
      { name: "/bug", desc: "Flag a problem — records the flight trail" },
      { name: "/clear", desc: "Clear the screen" },
      { name: "/help", desc: "Show commands" },
      { name: "/quit", desc: "Exit Berne" },
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
      return renderPicker(this.picker.title, this.picker.items, this.picker.sel, cols());
    }
    if (this.mode === "permission" && this.perm) {
      return renderPermissionCard(this.perm.toolName, this.perm.argsSummary, cols());
    }
    if (this.mode === "ask" && this.askState) {
      const base = renderComposer({
        input: this.input,
        caret: this.caret,
        width: cols(),
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
        width: cols(),
        status: this.statusStr(),
      });
      const head = [
        `  ${info("?")} ${bold(text(q.question))}`,
        ...q.options.map((opt, i) => `    ${info(String(i + 1))} ${text(opt)}`),
        `  ${faint("1-" + q.options.length + " choose · or type an answer · Enter = 1 · Esc = skip")}`,
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
          width: cols(),
          masked: e.masked,
        });
      }
      return renderKeysPanel(this.keysRows, this.keysSel, cols());
    }
    if (this.mode === "sessions") {
      return renderSessionsPanel(
        this.sessionsList.map((s) => this.sessionRowView(s)),
        this.sessionsSel,
        { view: this.sessionsView, pendingDelete: this.sessionsPendingDelete != null },
        cols(),
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
        cols(),
      );
    }
    if (this.mode === "turn") {
      // The composer stays live while a turn streams so the next message can be typed ahead.
      // The working indicator (and any queued messages) float above the still-editable box.
      const base = renderComposer({
        input: this.input,
        caret: this.caret,
        width: cols(),
        status: this.statusStr(),
      });
      // The buffered prose run streams live here (it commits to the transcript only
      // once the turn decides which partition — work rail or response — it belongs to).
      const head: string[] = [...(this.turnPreview ?? []), `  ${this.workingText()}`];
      for (const q of this.queued) {
        head.push(`  ${faint("↳ queued ·")} ${muted(truncate(q, Math.max(8, cols() - 16)))}`);
      }
      return {
        lines: [...head, ...base.lines],
        caretRow: base.caretRow + head.length,
        caretCol: base.caretCol,
      };
    }
    const base = renderComposer({
      input: this.input,
      caret: this.caret,
      width: cols(),
      status: this.statusStr(),
    });
    const matches = this.slashMatches();
    if (matches.length === 0) return base;
    // Float the palette above the input box; the caret stays in the box.
    const palette = renderSlashPalette(matches, this.slashSel, cols());
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
    return clampVisible(ln, Math.max(8, cols() - 1));
  }

  private pushLines(block: string): number {
    const lines = block.split("\n");
    for (const ln of lines) this.transcript.push(withThemeBg(this.bound(ln)));
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
    process.stdout.write(terminalThemeSeq() + themeBgSeq() + "\x1b[2J\x1b[3J\x1b[H\x1b[0m");
    this.printBanner();
  }

  /** Print the banner into the transcript (inline surface). The alt-screen surface renders it
   *  live as a pinned header via bannerLines() instead. */
  private printBanner(): void {
    const { engine } = this.ctx;
    this.print(
      renderBanner({
        model: engine.getModel(),
        provider: engine.getProvider(),
        sessionId: this.ctx.sessionId,
        workspace: this.ctx.workspaceRoot,
        version: this.ctx.version,
        sandbox: engine.isSandboxEnabled(),
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
      provider: engine.getProvider(),
      sessionId: this.ctx.sessionId,
      workspace: this.ctx.workspaceRoot,
      version: this.ctx.version,
    })
      .split("\n")
      .map((l) => withThemeBg(this.bound(l)));
  }

  /** Repaint the whole viewport: live banner header, themed transcript window, composer
   *  pinned at the bottom — every row filled edge-to-edge in the theme bg. */
  private drawComposer(): void {
    if (!this.screen.isActive) return;
    const R = rowsCount();
    const banner = this.bannerLines();
    const comp = this.composerBlock();
    const compLines = comp.lines.map((l) => withThemeBg(this.bound(l)));
    // When scrolled up, reserve one row above the composer for a "more below" hint so the
    // user knows output isn't frozen and how to catch back up.
    const hintRows = this.scroll > 0 ? 1 : 0;
    const transH = Math.max(0, R - banner.length - compLines.length - hintRows);

    const total = this.transcript.length;
    const maxScroll = Math.max(0, total - transH);
    if (this.scroll > maxScroll) this.scroll = maxScroll;
    const end = total - this.scroll;
    const visible = this.transcript.slice(Math.max(0, end - transH), end);

    const rows: string[] = [...banner];
    for (let i = 0; i < transH - visible.length; i++) rows.push(withThemeBg("")); // padding
    rows.push(...visible);
    if (hintRows) {
      rows.push(
        this.scroll > 0
          ? withThemeBg(
              `  ${faint(`↓ ${this.scroll} more line${this.scroll === 1 ? "" : "s"} below · scroll down to resume`)}`,
            )
          : withThemeBg(""),
      );
    }
    rows.push(...compLines);
    // Keep exactly R rows (guards tiny terminals / an oversized composer).
    while (rows.length < R) rows.push(withThemeBg(""));
    if (rows.length > R) rows.splice(banner.length, rows.length - R);

    // Detect a clean vertical shift of the transcript band (a streamed append or a scroll) so the
    // renderer can hardware-scroll instead of rewriting every row. The band geometry must be
    // unchanged frame-to-frame; AltScreen re-verifies the shift and falls back safely otherwise.
    const bandTop = banner.length;
    let scrollHint: { top: number; bottom: number; delta: number } | undefined;
    if (
      this.prevEnd >= 0 &&
      transH > 1 &&
      bandTop === this.prevBandTop &&
      transH === this.prevTransH &&
      end !== this.prevEnd &&
      Math.abs(this.prevEnd - end) < transH
    ) {
      // delta > 0 → window moved toward older output (content shifts down); < 0 → toward newer.
      scrollHint = { top: bandTop, bottom: bandTop + transH - 1, delta: this.prevEnd - end };
    }
    this.prevEnd = end;
    this.prevBandTop = bandTop;
    this.prevTransH = transH;

    const caretRow = Math.min(R - 1, banner.length + transH + hintRows + comp.caretRow);
    this.screen.frame(rows, caretRow, comp.caretCol, scrollHint);
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
    const act = this.currentActivity ? faint(` · ${this.currentActivity}`) : "";
    const verb = cookingVerb(this.turnSeed, elapsed);
    return `${ok(HEX)} ${bold(text(`${verb}…`))}${act} ${faint(`(${t} · ${hint})`)}`;
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
    // The mouse wheel scrolls the transcript in every mode — even while a turn streams.
    if (key.type === "wheel-up") {
      this.scrollLines(SCROLL_STEP);
      return;
    }
    if (key.type === "wheel-down") {
      this.scrollLines(-SCROLL_STEP);
      return;
    }
    // Shift+Tab cycles the permission mode (confirm → auto → Hands-Free → …). Allowed while
    // typing or mid-turn; ignored over a modal overlay (picker/permission/keys/ask) so it
    // never hijacks a confirmation the user is answering.
    if (key.type === "shift-tab") {
      if (this.mode === "input" || this.mode === "turn") this.cyclePermissionMode();
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
        this.input = "";
        this.caret = 0;
        this.scheduleDraw();
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

  /** Echo, record, and execute one line of input — a slash command or a model turn. Shared by
   *  submit() and the type-ahead queue drained when a turn completes, so both run identically. */
  private async runInput(raw: string): Promise<void> {
    this.history.push(raw);

    // Echo the prompt into the transcript. A slash command is an instruction to the
    // shell (quiet echo); anything else is the user's message — the loud block.
    if (raw.startsWith("/")) this.print(`  ${accent("›")} ${text(raw)}`);
    else this.print(userBlock(raw));

    if (raw.startsWith("/")) {
      const handled = await this.handleSlash(raw);
      if (handled) {
        this.scheduleDraw();
        return;
      }
    }
    await this.runTurn(raw);
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
            `  ${muted("Notebook is empty for this workspace — Berne fills it as it verifies how your repos work.")}`,
          );
        } else {
          this.print(
            [
              `  ${bold(text("Notebook — active for this workspace"))}`,
              ...entries.map(
                (e) =>
                  `    ${info(e.id.slice(-8))} ${muted(`[${e.scope}]`)} ${text(e.body.slice(0, 90))}`,
              ),
              `    ${muted("manage: alan notebook [show <id>|rm <id>|export]")}`,
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
            ? `  ${text("✦ Logged with the current flight trail.")} ${muted(`alan incidents show ${id.slice(-8)}`)}`
            : `  ${muted("Could not record — see alan doctor.")}`,
        );
        return true;
      }
      case "help": {
        const cmds: [string, string][] = [
          ["/model", "Switch model/provider"],
          ["/theme", "Themes — switch color theme"],
          ["/sessions", "Browse, resume, rename, archive & delete sessions"],
          ["/resume", "Open the session picker to continue past work"],
          ["/rename", "Rename the current session"],
          ["/status", "Session status"],
          ["/providers", "List providers"],
          ["/keys", "Manage API keys"],
          ["/research", "Research — propose a plan, then a cited report"],
          ["/deepresearch", "Deep research — multi-round, long-form"],
          ["/cost", "Session cost"],
          ["/plan", "Toggle plan mode"],
          ["/hands-free", "Hands-Free — toggle bypass mode (shift+tab)"],
          ["/mode", "Cycle permission mode (confirm/auto/hands-free)"],
          ["/sandbox", "OS sandbox for commands — on | off (off = full access)"],
          ["/rewind", "Roll back the conversation"],
          ["/compress", "Summarize & shrink context"],
          ["/undo", "Revert the last Berne auto-commit"],
          ["/interactive", "Live dashboard from the last report (auto on|off · open)"],
          ["/memory", "System memory — /memory [update|add|edit|clear|daily|3d|weekly|manual]"],
          ["/notebook", "Learned tactics active for this workspace"],
          ["/bug", "Flag a problem — records the flight trail to the black box"],
          ["/clear", "Clear the screen"],
          ["/quit", "Exit"],
        ];
        this.print(
          [
            `  ${bold(text("Commands"))}`,
            ...cmds.map(([c, d]) => `    ${info(c.padEnd(12))}${muted(d)}`),
          ].join("\n"),
        );
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
            plannerMode: s.plannerMode,
            yoloMode: s.yoloMode,
            trustWorkspace: s.trustWorkspace,
            permissionMode: s.permissionMode,
            sandboxEnabled: s.sandboxEnabled,
            registeredProviders: s.registeredProviders,
            version: this.ctx.version,
          }),
        );
        return true;
      }
      case "cost":
        this.print(`  ${muted(`$${engine.getCost().toFixed(4)}`)}`);
        return true;
      case "providers": {
        const a = arg.split(/\s+/).filter(Boolean);
        const op = (a[0] ?? "").toLowerCase();
        // `/providers on|off <id>` toggles a provider live.
        if ((op === "on" || op === "off") && a[1]) {
          const id = a[1].toLowerCase();
          if (!getPreset(id) && id !== CUSTOM_PROVIDER_ID) {
            this.print(`  ${warn("Unknown provider")} ${info(id)}`);
            return true;
          }
          const disabled = op === "off";
          persistDisabled(id, disabled);
          const res = engine.setProviderDisabled(id, disabled, this.ctx.sessionId);
          this.print(`  ${ok("✓")} ${info(id)} ${muted(disabled ? "disabled" : "enabled")}`);
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
          const src = r.source === "none" ? "" : faint(`  ${r.source === "env" ? "env" : "key"}`);
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
      case "plan": {
        const on = !engine.isPlannerMode();
        engine.setPlannerMode(on);
        this.print(`  ${ok("✓")} ${muted(`plan mode ${on ? "on" : "off"}`)}`);
        return true;
      }
      case "turing": // hidden back-compat alias for /hands-free
      case "hands-free": {
        // Explicit toggle: jump into Hands-Free, or back out to confirm.
        this.cyclePermissionMode(engine.getPermissionMode() === "turing" ? "confirm" : "turing");
        return true;
      }
      case "mode": {
        // "hands-free" is the public name for the internal "turing" bypass mode.
        const raw = (arg ?? "").toLowerCase();
        const norm = raw === "hands-free" || raw === "handsfree" ? "turing" : raw;
        const valid = ["confirm", "auto", "turing"] as const;
        if (norm && (valid as readonly string[]).includes(norm)) {
          this.cyclePermissionMode(norm as (typeof valid)[number]);
        } else if (raw) {
          this.print(
            `  ${warn("Usage:")} ${info("/mode")} ${faint("[confirm|auto|hands-free] — empty cycles")}`,
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
      case "theme": {
        const themes = listThemes();
        if (arg) {
          if (setTheme(arg)) {
            saveTheme(arg);
            this.print(`  ${ok("✓")} ${muted("theme set to")} ${warn(getTheme().label)}`);
          } else this.print(`  ${accent("✕")} ${muted("unknown theme:")} ${faint(arg)}`);
          return true;
        }
        // Live-preview: navigating the picker repaints the whole screen in the theme; Esc reverts.
        const original = getTheme().name;
        const items: PickerItem[] = themes.map((t) => ({
          label: t.label,
          hint: t.appearance + (t.name === original ? " · current" : ""),
        }));
        const start = Math.max(
          0,
          themes.findIndex((t) => t.name === original),
        );
        const i = await this.pick("Themes", items, start, (idx) => setTheme(themes[idx]!.name));
        if (i != null) {
          setTheme(themes[i]!.name);
          saveTheme(themes[i]!.name);
          this.print(`  ${ok("✓")} ${muted("theme set to")} ${warn(getTheme().label)}`);
        } else {
          setTheme(original); // revert the live preview on cancel
        }
        return true;
      }
      case "model": {
        const reg = engine.getRegisteredProviders();
        const presets = this.modelPresets(reg);
        if (arg.includes("/")) {
          const [p, ...m] = arg.split("/");
          engine.switchModel(m.join("/"), p as any, this.ctx.sessionId);
          saveLastModel({ provider: engine.getProvider(), model: engine.getModel() });
          this.print(`  ${ok("✓")} ${muted("switched to")} ${info(arg)}`);
          return true;
        }
        const items: PickerItem[] = presets.map((p) => ({ label: `${p.provider}/${p.label}` }));
        const cur = `${engine.getProvider()}/${engine.getModel()}`;
        const start = presets.findIndex((p) => `${p.provider}/${p.model}` === cur);
        const i = await this.pick("Model", items, start < 0 ? 0 : start);
        if (i != null) {
          const p = presets[i]!;
          engine.switchModel(p.model, p.provider as any, this.ctx.sessionId);
          saveLastModel({ provider: engine.getProvider(), model: engine.getModel() });
          this.print(`  ${ok("✓")} ${muted("switched to")} ${info(`${p.provider}/${p.label}`)}`);
        }
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
                  ? "— Berne builds one when an answer is data-heavy"
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
              `  ${faint("Tip: set [git] autoCommit = true in ~/.alan/config.toml so every run lands as a revertible commit.")}`,
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
              `  ${muted("Empty — Berne hasn't built your profile yet.")}`,
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

  // ── picker mode ──

  private pick(
    title: string,
    items: PickerItem[],
    start: number,
    onPreview?: (i: number) => void,
  ): Promise<number | null> {
    return new Promise((resolve) => {
      this.picker = { title, items, sel: Math.max(0, start), resolve, onPreview };
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
    } else if (key.type === "enter") {
      this.closePicker(p.sel);
    } else if (key.type === "esc" || (key.type === "ctrl" && key.name === "c")) {
      this.closePicker(null);
    }
  }

  private closePicker(result: number | null): void {
    const p = this.picker;
    this.picker = null;
    this.mode = "input";
    p?.resolve(result); // the resolver (or a following print/redraw) repaints
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

  private sessionRowView(s: SessionListItem): SessionRowView {
    const title = s.title && s.title.trim() ? s.title.trim() : "untitled";
    const parts = [this.relTime(s.updatedAt), s.model];
    if (s.eventCount > 0) parts.push(`${s.eventCount} events`);
    return {
      title,
      meta: parts.filter(Boolean).join(" · "),
      current: s.id === this.ctx.sessionId,
    };
  }

  private openSessions(view: "active" | "archived" = "active"): void {
    this.sessionsView = view;
    this.sessionsPendingDelete = null;
    this.sessionsList = this.ctx.engine.listSessions({ status: view });
    const cur = this.sessionsList.findIndex((s) => s.id === this.ctx.sessionId);
    this.sessionsSel = cur >= 0 ? cur : 0;
    this.mode = "sessions";
    this.scheduleDraw();
  }

  /** Reload the list for the current view after a mutation, keeping the cursor in range. */
  private refreshSessions(): void {
    this.sessionsList = this.ctx.engine.listSessions({ status: this.sessionsView });
    if (this.sessionsSel >= this.sessionsList.length) {
      this.sessionsSel = Math.max(0, this.sessionsList.length - 1);
    }
    this.scheduleDraw();
  }

  private closeSessions(): void {
    this.sessionsPendingDelete = null;
    this.mode = "input";
    this.scheduleDraw();
  }

  private sessionsKey(key: Key): void {
    const n = this.sessionsList.length;
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
    this.ctx.sessionId = id; // set before resetTranscript so the reprinted banner shows this session
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
   * `alan resume`), replay it into the viewport so the user lands where they left
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
      .filter((s) => s.id !== fresh)
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
    // Discard the throwaway session we created to land in (only if untouched).
    if (this.ctx.engine.getTranscript(fresh).length === 0) {
      try {
        this.ctx.engine.deleteSession(fresh);
      } catch {
        /* non-fatal — a lingering empty session is harmless */
      }
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
    this.mode = "keys";
    this.scheduleDraw();
  }

  private buildKeyRows(): KeyRow[] {
    // getProviderStatus() returns a superset of KeyRow (adds hasKey).
    return this.ctx.engine.getProviderStatus();
  }

  private closeKeys(): void {
    this.keysEdit = null;
    this.mode = "input";
    this.scheduleDraw();
  }

  private keysKey(key: Key): void {
    if (this.keysEdit) {
      this.keysEditKey(key);
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
      case "enter":
        this.startKeyEdit();
        break;
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

  private permissionHandler: PermissionHandler = (prompt) =>
    new Promise<UserPermissionDecision>((resolve) => {
      this.perm = { resolve, toolName: prompt.toolName, argsSummary: prompt.argsSummary };
      this.mode = "permission";
      this.scheduleDraw();
    });

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
      this.scheduleDraw();
    });

  private questionKey(key: Key): void {
    const q = this.questionState;
    if (!q) return;
    const finish = (answer: string) => {
      this.questionState = null;
      this.input = "";
      this.caret = 0;
      // Return to the in-flight turn (questions only fire mid-turn).
      this.mode = q.prevMode === "question" ? "turn" : q.prevMode;
      this.print(`  ${ok("✓")} ${muted(truncate(answer, 80))}`);
      q.resolve(answer);
    };
    // Bare digit with an empty composer = instant pick.
    if (key.type === "char" && this.input.length === 0 && /^[1-9]$/.test(key.value)) {
      const n = Number(key.value);
      if (n >= 1 && n <= q.options.length) return finish(q.options[n - 1]);
    }
    if (key.type === "enter") {
      const typed = this.input.trim();
      return finish(typed || q.options[0]);
    }
    if (key.type === "esc") {
      return finish("(user skipped the question — proceed with your best judgment)");
    }
    // Everything else edits the composer (free-text answer).
    if (this.editComposer(key)) this.scheduleDraw();
  }

  private permKey(key: Key): void {
    if (!this.perm) return;
    let decision: UserPermissionDecision | null = null;
    if (key.type === "char" && (key.value === "n" || key.value === "N"))
      decision = { kind: "deny" };
    else if (key.type === "char" && (key.value === "s" || key.value === "S"))
      decision = { kind: "allow_session" };
    else if (
      key.type === "enter" ||
      (key.type === "char" && (key.value === "y" || key.value === "Y"))
    )
      decision = { kind: "allow_once" };
    else if (key.type === "esc") decision = { kind: "deny" };
    if (!decision) return;
    const r = this.perm.resolve;
    this.perm = null;
    this.mode = "turn"; // return to the in-flight turn
    const label =
      decision.kind === "deny"
        ? accent("✕ denied")
        : ok(decision.kind === "allow_session" ? "✓ session" : "✓ allowed");
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
        // Guard the flood: one interrupt request per turn, however many times esc is pressed.
        this.aborting = true;
        this.ctx.engine.abort();
        this.print(`  ${accent("✕")} ${muted("interrupting…")}`);
        this.scheduleDraw();
      }
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
          this.print(`  ${accent("↪")} ${faint("folded into the running task")}`);
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

  private async runTurn(input: string): Promise<void> {
    const { engine } = this.ctx;
    this.mode = "turn";
    this.aborting = false;
    this.turnStart = Date.now();
    this.turnSeed = Math.floor(Math.random() * 1000);
    this.streamBuf = "";
    this.currentActivity = null;
    this.turnPreview = null;
    this.scheduleDraw();
    this.tick = setInterval(() => {
      if (this.mode === "turn") this.scheduleDraw();
    }, 250);

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

    // Offer-a-dashboard bookkeeping: the answer text (for the data-density
    // heuristic) and whether the model already built/updated one this turn.
    let answerText = "";
    let dashboardTouched = false;

    try {
      for await (const ev of engine.chat(this.ctx.sessionId, input)) {
        turn.onEvent(ev);
        this.currentActivity = turn.activity; // surfaced on the Cooking… line
        if (ev.type === "text_delta") answerText += ev.text;
        if (ev.type === "stream_reset") answerText = "";
        if (ev.type === "tool_call_end" && ev.output?.toolName === "interactive_dashboard") {
          dashboardTouched = true;
        }
        // Session-wide edited-files readout on the footer.
        if (
          ev.type === "tool_call_end" &&
          ev.output?.success &&
          (ev.output.toolName === "edit_file" || ev.output.toolName === "write_file") &&
          ev.args?.path
        ) {
          this.filesEdited.add(String(ev.args.path));
        }
      }
    } catch (err) {
      // A user interrupt surfaces as an abort error — that's expected, not a failure to report.
      if (!this.aborting) turn.onError(err);
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
      this.currentActivity = null;
      this.turnPreview = null;
      const wasAborted = this.aborting;
      this.aborting = false;
      this.mode = "input";
      this.drainQueue(wasAborted);
    }
  }

  /** Ctrl+R: bring the hidden work out — the in-flight log mid-turn, else the
   *  last turn's. Prints into the transcript (scrollback keeps it). */
  private expandWorkLog(): void {
    const log = this.liveTurn?.fullLog() ?? this.lastWorkLog;
    if (!log) {
      this.print(`  ${faint("no work log yet")}`);
      return;
    }
    this.print("");
    this.print(log);
    this.print("");
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
    const { engine } = this.ctx;
    this.mode = "turn";
    this.aborting = false;
    this.turnStart = Date.now();
    this.streamBuf = "";
    this.scheduleDraw();
    this.tick = setInterval(() => {
      if (this.mode === "turn") this.scheduleDraw();
    }, 250);

    const flush = (final = false) => {
      let idx: number;
      while ((idx = this.streamBuf.indexOf("\n")) >= 0) {
        const ln = this.streamBuf.slice(0, idx);
        this.streamBuf = this.streamBuf.slice(idx + 1);
        this.print(`  ${text(ln)}`);
      }
      if (final && this.streamBuf.length) {
        this.print(`  ${text(this.streamBuf)}`);
        this.streamBuf = "";
      }
    };

    let report: ResearchReport | null = null;
    try {
      for await (const ev of engine.runResearch(this.ctx.sessionId, plan, opts)) {
        if (ev.type === "research_report_delta") {
          this.streamBuf += ev.text;
          flush();
          continue;
        }
        flush(true);
        if (ev.type === "research_complete") report = ev.report;
        if (ev.type === "error") {
          this.print(`  ${accent("✕")} ${text(ev.error)}`);
          continue;
        }
        const block = formatResearchEvent(ev);
        if (block) this.print(block);
      }
      flush(true);
    } catch (err) {
      flush(true);
      if (!this.aborting) {
        this.print(`  ${accent("✕")} ${text(err instanceof Error ? err.message : String(err))}`);
      }
    } finally {
      if (this.tick) {
        clearInterval(this.tick);
        this.tick = null;
      }
      this.mode = "input";
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
      const dir = cfg.outputDir || join(this.ctx.workspaceRoot, ".alan", "research");
      mkdirSync(dir, { recursive: true });
      const slug =
        question
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 50) || "research";
      const file = join(dir, `${new Date().toISOString().slice(0, 10)}-${slug}.md`);
      const body = `# Research: ${plan.question}\n\n_Generated by Berne · ${new Date().toISOString()}_\n\n${report.markdown}\n`;
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
