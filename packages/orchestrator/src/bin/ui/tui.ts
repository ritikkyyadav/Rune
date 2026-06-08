// ─── TUI controller (inline-viewport, raw mode) ───
// Opt-in Codex-style terminal UI: a pinned composer at the bottom, transcript
// scrolling into normal scrollback above it. Reuses the pure renderers
// (banner/status/tool-call/events) and the existing engine. The readline path in
// alan-cli stays the default; this is selected with `--tui` / ALAN_TUI=1.

import type { Engine, PermissionHandler, UserPermissionDecision } from "../../engine";
import { findCommand, type SlashCommand } from "../../commands";
import {
  setProviderKey as persistKey,
  clearProviderKey as persistClearKey,
  setCustomEndpoint as persistCustom,
  clearCustomEndpoint as persistClearCustom,
  setProviderDisabled as persistDisabled,
  getPreset,
  CUSTOM_PROVIDER_ID,
} from "@alan/shared";
import type { CustomEndpoint } from "@alan/shared";
import { AltScreen } from "./screen";
import { parseKeys, type Key } from "./keys";
import {
  renderComposer,
  renderPicker,
  renderSlashPalette,
  renderKeysPanel,
  renderKeyEditor,
  statusLine,
  type RenderedBlock,
  type PickerItem,
  type SlashItem,
  type KeyRow,
} from "./composer";
import { renderBanner } from "./banner";
import { renderStatus } from "./status";
import { formatEvent } from "./events";
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
} from "./theme";
import { saveTheme } from "./theme-store";

export interface TuiContext {
  engine: Engine;
  sessionId: string;
  workspaceRoot: string;
  version: string;
  yoloMode: boolean;
  trustWorkspace: boolean;
  customCommands: SlashCommand[];
}

type Mode = "input" | "turn" | "picker" | "permission" | "keys" | "ask";

const cols = () => process.stdout.columns ?? 80;
const rowsCount = () => process.stdout.rows ?? 24;
const MAX_TRANSCRIPT = 5000; // cap the in-memory scrollback
const SCROLL_STEP = 3; // lines per mouse-wheel notch

export async function runTui(ctx: TuiContext): Promise<void> {
  await new Tui(ctx).run();
}

class Tui {
  private screen = new AltScreen();
  private transcript: string[] = []; // themed lines (bg baked at print time), self-managed scrollback
  private scroll = 0; // lines scrolled up from the bottom (0 = following latest)
  private onResize = () => {
    // A resize reflows/clears the terminal, so the diff baseline is stale — force a full repaint.
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
  private pasteMode = false;
  private pasteBuf = "";

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
  private perm: { resolve: (d: UserPermissionDecision) => void; label: string } | null = null;
  // transient single-line text prompt (used by /research clarify & revise)
  private askState: { resolve: (s: string | null) => void; title: string } | null = null;

  constructor(private ctx: TuiContext) {}

  // ── lifecycle ──

  async run(): Promise<void> {
    const { engine } = this.ctx;

    // The banner is a live header (re-themed every frame), so nothing to seed here.
    if (!this.ctx.yoloMode) engine.setPermissionHandler(this.permissionHandler);

    const stdin = process.stdin;
    stdin.setEncoding("utf8");
    if (stdin.isTTY) stdin.setRawMode(true);
    process.stdout.write("\x1b[?2004h"); // bracketed paste on
    process.stdout.write("\x1b[?1000h\x1b[?1006h"); // mouse button + SGR coords → wheel scroll
    // Safety net: if we ever exit without running this.exit() (a crash), still leave the
    // terminal usable — drop mouse/paste reporting and show the cursor.
    process.once("exit", () => {
      try {
        process.stdout.write("\x1b[?1000l\x1b[?1006l\x1b[?2004l\x1b[?25h");
      } catch {
        /* terminal already gone */
      }
    });
    stdin.resume();

    this.screen.enter(themeBgSeq());
    process.stdout.on("resize", this.onResize);
    this.drawComposer(); // first frame synchronous so the banner appears instantly

    return new Promise<void>((resolve) => {
      const onData = (chunk: string) => this.onData(chunk);
      stdin.on("data", onData);
      this.exit = (code = 0) => {
        stdin.off("data", onData);
        process.stdout.off("resize", this.onResize);
        process.stdout.write("\x1b[?2004l"); // bracketed paste off
        process.stdout.write("\x1b[?1000l\x1b[?1006l"); // mouse tracking off
        if (this.drawTimer) clearTimeout(this.drawTimer); // cancel any pending coalesced paint
        this.screen.exit(); // restore the main screen + the user's own colours
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
    return statusLine({
      model: this.ctx.engine.getModel(),
      effort: this.ctx.engine.getEffort(),
      workspace: this.ctx.workspaceRoot,
      mode: this.ctx.yoloMode ? "yolo" : this.ctx.trustWorkspace ? "trusted" : "confirm",
    });
  }

  // ── slash palette (live `/` menu) ──

  private slashCatalog(): SlashItem[] {
    const builtins: SlashItem[] = [
      { name: "/model", desc: "Switch model / provider" },
      { name: "/effort", desc: "Set reasoning effort" },
      { name: "/theme", desc: "Themes — switch color theme" },
      { name: "/status", desc: "Session status" },
      { name: "/providers", desc: "List providers" },
      { name: "/keys", desc: "Manage API keys" },
      { name: "/research", desc: "Research — propose a plan, then a cited report" },
      { name: "/deepresearch", desc: "Deep research — multi-round, long-form" },
      { name: "/cost", desc: "Session cost" },
      { name: "/plan", desc: "Toggle plan mode" },
      { name: "/rewind", desc: "Roll back the conversation" },
      { name: "/compress", desc: "Summarize & shrink context" },
      { name: "/clear", desc: "Clear the screen" },
      { name: "/help", desc: "Show commands" },
      { name: "/quit", desc: "Exit Alan" },
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
      const q = `  ${warn("?")} ${text("Allow")} ${this.perm.label}${text("?")}`;
      const hint = `  ${ok("enter")} ${faint("allow")}   ${warn("s")} ${faint("session")}   ${accent("n")} ${faint("deny")}`;
      return { lines: [q, hint], caretRow: 1, caretCol: 0 };
    }
    if (this.mode === "ask" && this.askState) {
      const base = renderComposer({
        input: this.input,
        caret: this.caret,
        width: cols(),
        status: this.statusStr(),
      });
      const title = `  ${info("?")} ${text(this.askState.title)} ${faint("(Enter = ok · Esc = skip)")}`;
      return { lines: [title, ...base.lines], caretRow: base.caretRow + 1, caretCol: base.caretCol };
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
    if (this.mode === "turn") {
      return renderComposer({
        input: "",
        caret: 0,
        width: cols(),
        status: this.statusStr(),
        working: this.workingText(),
      });
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
  private pushLines(block: string): number {
    const lines = block.split("\n");
    for (const ln of lines) this.transcript.push(withThemeBg(ln));
    if (this.transcript.length > MAX_TRANSCRIPT) {
      this.transcript.splice(0, this.transcript.length - MAX_TRANSCRIPT);
    }
    return lines.length;
  }

  private print(block: string): void {
    const added = this.pushLines(block);
    // Follow the bottom when already there; if the user has scrolled up to read, hold their
    // view stationary as new lines stream in (don't yank them back down). Typing or submitting
    // resets scroll to 0, returning to the live tail.
    if (this.scroll > 0) this.scroll += added;
    this.scheduleDraw();
  }

  /** The banner, rendered live (re-themed every frame) so the header always matches the
   *  current theme — pinned at the top of the viewport. */
  private bannerLines(): string[] {
    const { engine } = this.ctx;
    return renderBanner({
      model: engine.getModel(),
      provider: engine.getProvider(),
      effort: engine.getEffort(),
      sessionId: this.ctx.sessionId,
      workspace: this.ctx.workspaceRoot,
      version: this.ctx.version,
    })
      .split("\n")
      .map(withThemeBg);
  }

  /** Repaint the whole viewport: live banner header, themed transcript window, composer
   *  pinned at the bottom — every row filled edge-to-edge in the theme bg. */
  private drawComposer(): void {
    if (!this.screen.isActive) return;
    const R = rowsCount();
    const banner = this.bannerLines();
    const comp = this.composerBlock();
    const compLines = comp.lines.map(withThemeBg);
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
    this.drawComposer();
  }

  private scrollBy(pages: number): void {
    const page = Math.max(1, rowsCount() - 6);
    this.scroll = Math.max(0, this.scroll + pages * page);
    this.scheduleDraw(); // clamps to maxScroll
  }

  /** Scroll the transcript by a line delta (positive = toward older output). */
  private scrollLines(lines: number): void {
    this.scroll = Math.max(0, this.scroll + lines);
    this.scheduleDraw(); // clamps to maxScroll
  }

  private workingText(): string {
    const secs = Math.floor((Date.now() - this.turnStart) / 1000);
    const t = secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m${secs % 60}s`;
    return `${accent("•")} ${bold(text("Working"))} ${faint(`(${t} · esc to interrupt)`)}`;
  }

  // ── stdin routing ──

  private onData(chunk: string): void {
    for (const key of parseKeys(chunk)) {
      if (key.type === "paste-start") {
        this.pasteMode = true;
        this.pasteBuf = "";
        continue;
      }
      if (key.type === "paste-end") {
        this.pasteMode = false;
        this.insertActive(this.pasteBuf);
        this.pasteBuf = "";
        this.scheduleDraw();
        continue;
      }
      if (this.pasteMode) {
        if (key.type === "char") this.pasteBuf += key.value;
        else if (key.type === "enter") this.pasteBuf += "\n";
        continue;
      }
      // The mouse wheel scrolls the transcript in every mode — even while a turn streams.
      if (key.type === "wheel-up") {
        this.scrollLines(SCROLL_STEP);
        continue;
      }
      if (key.type === "wheel-down") {
        this.scrollLines(-SCROLL_STEP);
        continue;
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
        case "ask":
          this.askKey(key);
          break;
      }
    }
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
    switch (key.type) {
      case "char":
        this.insert(key.value);
        this.sigintArmed = false;
        this.slashSel = 0;
        this.scroll = 0; // typing returns to the latest output
        this.scheduleDraw();
        break;
      case "pageup":
        this.scrollBy(1);
        break;
      case "pagedown":
        this.scrollBy(-1);
        break;
      case "enter":
        void this.submit();
        break;
      case "backspace":
        if (this.caret > 0) {
          this.input = this.input.slice(0, this.caret - 1) + this.input.slice(this.caret);
          this.caret--;
          this.slashSel = 0;
          this.scheduleDraw();
        }
        break;
      case "delete":
        if (this.caret < this.input.length) {
          this.input = this.input.slice(0, this.caret) + this.input.slice(this.caret + 1);
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
      case "home":
        this.caret = 0;
        this.scheduleDraw();
        break;
      case "end":
        this.caret = this.input.length;
        this.scheduleDraw();
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
        this.transcript = [];
        this.scroll = 0;
        this.scheduleDraw();
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
    const raw = this.input.trim();
    this.input = "";
    this.caret = 0;
    this.histIdx = -1;
    this.slashSel = 0;
    this.scroll = 0; // submitting jumps back to the live tail
    if (!raw) {
      this.scheduleDraw();
      return;
    }
    this.history.push(raw);

    // Echo the prompt into the transcript.
    this.print(`  ${accent("›")} ${text(raw)}`);

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
        this.transcript = [];
        this.scroll = 0;
        return true;
      case "help": {
        const cmds: [string, string][] = [
          ["/model", "Switch model/provider"],
          ["/effort", "Set reasoning effort"],
          ["/theme", "Themes — switch color theme"],
          ["/status", "Session status"],
          ["/providers", "List providers"],
          ["/keys", "Manage API keys"],
          ["/research", "Research — propose a plan, then a cited report"],
          ["/deepresearch", "Deep research — multi-round, long-form"],
          ["/cost", "Session cost"],
          ["/plan", "Toggle plan mode"],
          ["/rewind", "Roll back the conversation"],
          ["/compress", "Summarize & shrink context"],
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
      case "status": {
        const s = engine.getStatus(this.ctx.sessionId);
        this.print(
          renderStatus({
            model: s.model,
            provider: s.provider,
            effort: s.effort,
            workspace: s.workspace,
            sessionId: this.ctx.sessionId,
            cost: s.cost,
            plannerMode: s.plannerMode,
            yoloMode: s.yoloMode,
            trustWorkspace: s.trustWorkspace,
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
        const reg = engine.getRegisteredProviders();
        const cur = engine.getProvider();
        const rows = ["google", "anthropic", "openai", "openrouter"].map((n) => {
          const on = n === cur,
            has = reg.includes(n as any);
          const dot = on ? ok("●") : has ? warn("●") : faint("○");
          const c = on ? ok : has ? text : faint;
          const st = on ? ok("active") : has ? muted("ready") : faint("no key");
          return `    ${dot} ${c(n.padEnd(12))} ${st}`;
        });
        this.print([`  ${bold(text("Providers"))}`, ...rows].join("\n"));
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
      case "effort": {
        const levels = ["low", "medium", "high", "max"] as const;
        if (arg && (levels as readonly string[]).includes(arg)) {
          engine.setEffort(arg as any);
          this.print(`  ${ok("✓")} ${muted("effort set to")} ${warn(arg)}`);
          return true;
        }
        const items: PickerItem[] = levels.map((l) => ({
          label: l,
          hint: l === engine.getEffort() ? "current" : "",
        }));
        const i = await this.pick(
          "Reasoning effort",
          items,
          levels.indexOf(engine.getEffort() as any),
        );
        if (i != null) {
          engine.setEffort(levels[i]!);
          this.print(`  ${ok("✓")} ${muted("effort set to")} ${warn(levels[i]!)}`);
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
    // one-line preset edit — no picker code to touch. Free-form
    // `/model <provider>/<id>` still reaches any model the provider hosts.
    const out: { provider: string; model: string; label: string }[] = [];
    for (const id of reg) {
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

  // ── keys mode (BYOK API keys) ──

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
    this.ctx.engine.setProviderDisabled(row.id, next);
    this.keysRows = this.buildKeyRows();
    this.scheduleDraw();
  }

  private clearSelectedKey(): void {
    const row = this.keysRows[this.keysSel];
    if (!row || row.source !== "saved") return; // only saved keys are ours to clear
    if (row.id === CUSTOM_PROVIDER_ID) {
      persistClearCustom();
      this.ctx.engine.setCustomEndpoint(null);
    } else {
      persistClearKey(row.id);
      this.ctx.engine.setProviderKey(row.id, null);
    }
    this.keysRows = this.buildKeyRows();
    this.scheduleDraw();
  }

  // ── permission mode ──

  private permissionHandler: PermissionHandler = (prompt) =>
    new Promise<UserPermissionDecision>((resolve) => {
      const preview = prompt.argsSummary.slice(0, 60);
      this.perm = {
        resolve,
        label: `${info(prompt.toolName)}${preview ? faint(" — " + preview) : ""}`,
      };
      this.mode = "permission";
      this.scheduleDraw();
    });

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
    if (key.type === "esc" || (key.type === "ctrl" && key.name === "c")) {
      this.ctx.engine.abort();
      this.print(`  ${accent("✕")} ${muted("aborting…")}`);
    }
  }

  private async runTurn(input: string): Promise<void> {
    const { engine } = this.ctx;
    this.mode = "turn";
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

    // Reasoning models stream chain-of-thought separately; render it dimmed so
    // it reads as "thinking", not as the answer.
    let thinkBuf = "";
    const flushThink = (final = false) => {
      let idx: number;
      while ((idx = thinkBuf.indexOf("\n")) >= 0) {
        const ln = thinkBuf.slice(0, idx);
        thinkBuf = thinkBuf.slice(idx + 1);
        this.print(`  ${faint(ln)}`);
      }
      if (final && thinkBuf.length) {
        this.print(`  ${faint(thinkBuf)}`);
        thinkBuf = "";
      }
    };

    try {
      for await (const ev of engine.chat(this.ctx.sessionId, input)) {
        if (ev.type === "thinking_delta") {
          thinkBuf += ev.text;
          flushThink();
          continue;
        }
        if (ev.type === "text_delta") {
          if (thinkBuf) flushThink(true); // close out reasoning before the answer
          this.streamBuf += ev.text;
          flush();
          continue;
        }
        if (ev.type === "tool_call_start") continue; // activity only
        flushThink(true);
        flush(true);
        const block = formatEvent(ev, { cost: engine.getCost() });
        if (block) this.print(block);
      }
      flushThink(true);
      flush(true);
    } catch (err) {
      flush(true);
      this.print(`  ${accent("✕")} ${text(err instanceof Error ? err.message : String(err))}`);
    } finally {
      if (this.tick) {
        clearInterval(this.tick);
        this.tick = null;
      }
      this.mode = "input";
    }
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
      this.print(`  ${accent("✕")} ${text(err instanceof Error ? err.message : String(err))}`);
    } finally {
      if (this.tick) {
        clearInterval(this.tick);
        this.tick = null;
      }
      this.mode = "input";
    }

    if (report) this.saveResearchReport(plan, question, report);
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
      const body = `# Research: ${plan.question}\n\n_Generated by Alan · ${new Date().toISOString()}_\n\n${report.markdown}\n`;
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
