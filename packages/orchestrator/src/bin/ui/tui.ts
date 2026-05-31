// ─── TUI controller (inline-viewport, raw mode) ───
// Opt-in Codex-style terminal UI: a pinned composer at the bottom, transcript
// scrolling into normal scrollback above it. Reuses the pure renderers
// (banner/status/tool-call/events) and the existing engine. The readline path in
// alan-cli stays the default; this is selected with `--tui` / ALAN_TUI=1.

import type { Engine, PermissionHandler, UserPermissionDecision } from "../../engine";
import { findCommand, type SlashCommand } from "../../commands";
import { BottomRegion } from "./screen";
import { parseKeys, type Key } from "./keys";
import { renderComposer, renderPicker, statusLine, type RenderedBlock, type PickerItem } from "./composer";
import { renderBanner } from "./banner";
import { renderStatus } from "./status";
import { formatEvent } from "./events";
import { bold, text, muted, faint, info, ok, accent, warn } from "./theme";

export interface TuiContext {
  engine: Engine;
  sessionId: string;
  workspaceRoot: string;
  version: string;
  yoloMode: boolean;
  trustWorkspace: boolean;
  customCommands: SlashCommand[];
}

type Mode = "input" | "turn" | "picker" | "permission";

const cols = () => process.stdout.columns ?? 80;

export async function runTui(ctx: TuiContext): Promise<void> {
  await new Tui(ctx).run();
}

class Tui {
  private region = new BottomRegion();
  private input = "";
  private caret = 0;
  private history: string[] = [];
  private histIdx = -1;
  private draft = "";
  private mode: Mode = "input";
  private sigintArmed = false;
  private pasteMode = false;
  private pasteBuf = "";

  // turn state
  private turnStart = 0;
  private tick: ReturnType<typeof setInterval> | null = null;
  private streamBuf = "";

  // transient resolvers
  private picker: { items: PickerItem[]; sel: number; title: string; resolve: (i: number | null) => void } | null = null;
  private perm: { resolve: (d: UserPermissionDecision) => void; label: string } | null = null;

  constructor(private ctx: TuiContext) {}

  // ── lifecycle ──

  async run(): Promise<void> {
    const { engine, workspaceRoot } = this.ctx;
    process.stdout.write(
      renderBanner({
        model: engine.getModel(),
        provider: engine.getProvider(),
        effort: engine.getEffort(),
        sessionId: this.ctx.sessionId,
        workspace: workspaceRoot,
        version: this.ctx.version,
      }) + "\n",
    );

    if (!this.ctx.yoloMode) engine.setPermissionHandler(this.permissionHandler);

    const stdin = process.stdin;
    stdin.setEncoding("utf8");
    if (stdin.isTTY) stdin.setRawMode(true);
    process.stdout.write("\x1b[?2004h"); // bracketed paste on
    stdin.resume();

    this.drawComposer();

    return new Promise<void>((resolve) => {
      const onData = (chunk: string) => this.onData(chunk);
      stdin.on("data", onData);
      this.exit = (code = 0) => {
        stdin.off("data", onData);
        process.stdout.write("\x1b[?2004l"); // bracketed paste off
        if (stdin.isTTY) stdin.setRawMode(false);
        this.region.clear();
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

  private composerBlock(): RenderedBlock {
    if (this.mode === "picker" && this.picker) {
      return renderPicker(this.picker.title, this.picker.items, this.picker.sel, cols());
    }
    if (this.mode === "permission" && this.perm) {
      const q = `  ${warn("?")} ${text("Allow")} ${this.perm.label}${text("?")}`;
      const hint = `  ${ok("enter")} ${faint("allow")}   ${warn("s")} ${faint("session")}   ${accent("n")} ${faint("deny")}`;
      return { lines: [q, hint], caretRow: 1, caretCol: 0 };
    }
    if (this.mode === "turn") {
      return renderComposer({ input: "", caret: 0, width: cols(), status: this.statusStr(), working: this.workingText() });
    }
    return renderComposer({ input: this.input, caret: this.caret, width: cols(), status: this.statusStr() });
  }

  private drawComposer(): void {
    const b = this.composerBlock();
    this.region.render(b.lines, b.caretRow, b.caretCol);
  }

  private print(block: string): void {
    const b = this.composerBlock();
    this.region.printAbove(block + "\n", b.lines, b.caretRow, b.caretCol);
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
        this.insert(this.pasteBuf);
        this.pasteBuf = "";
        this.drawComposer();
        continue;
      }
      if (this.pasteMode) {
        if (key.type === "char") this.pasteBuf += key.value;
        else if (key.type === "enter") this.pasteBuf += "\n";
        continue;
      }
      switch (this.mode) {
        case "input": this.inputKey(key); break;
        case "turn": this.turnKey(key); break;
        case "picker": this.pickerKey(key); break;
        case "permission": this.permKey(key); break;
      }
    }
  }

  // ── input mode ──

  private insert(s: string): void {
    const clean = s.replace(/\r/g, "");
    this.input = this.input.slice(0, this.caret) + clean + this.input.slice(this.caret);
    this.caret += clean.length;
  }

  private inputKey(key: Key): void {
    switch (key.type) {
      case "char":
        this.insert(key.value);
        this.sigintArmed = false;
        this.drawComposer();
        break;
      case "enter":
        void this.submit();
        break;
      case "backspace":
        if (this.caret > 0) {
          this.input = this.input.slice(0, this.caret - 1) + this.input.slice(this.caret);
          this.caret--;
          this.drawComposer();
        }
        break;
      case "delete":
        if (this.caret < this.input.length) {
          this.input = this.input.slice(0, this.caret) + this.input.slice(this.caret + 1);
          this.drawComposer();
        }
        break;
      case "left": if (this.caret > 0) { this.caret--; this.drawComposer(); } break;
      case "right": if (this.caret < this.input.length) { this.caret++; this.drawComposer(); } break;
      case "home": this.caret = 0; this.drawComposer(); break;
      case "end": this.caret = this.input.length; this.drawComposer(); break;
      case "up": this.historyPrev(); break;
      case "down": this.historyNext(); break;
      case "esc": this.input = ""; this.caret = 0; this.drawComposer(); break;
      case "ctrl":
        this.ctrlKey(key.name);
        break;
    }
  }

  private ctrlKey(name: string): void {
    switch (name) {
      case "c":
        if (this.input.length > 0) { this.input = ""; this.caret = 0; this.sigintArmed = false; this.drawComposer(); return; }
        if (this.sigintArmed) { this.exit(0); return; }
        this.sigintArmed = true;
        this.print(`  ${faint("(ctrl-c again to exit)")}`);
        setTimeout(() => { this.sigintArmed = false; }, 2000);
        break;
      case "d":
        if (this.input.length === 0) this.exit(0);
        break;
      case "l":
        process.stdout.write("\x1b[2J\x1b[H");
        this.region = new BottomRegion();
        this.drawComposer();
        break;
      case "u":
        this.input = this.input.slice(this.caret); this.caret = 0; this.drawComposer();
        break;
      case "a": this.caret = 0; this.drawComposer(); break;
      case "e": this.caret = this.input.length; this.drawComposer(); break;
      case "t":
        this.print(`  ${faint("Transcript view (ctrl+t) is coming in a later build.")}`);
        break;
    }
  }

  private historyPrev(): void {
    if (this.history.length === 0) return;
    if (this.histIdx === -1) { this.draft = this.input; this.histIdx = this.history.length; }
    if (this.histIdx > 0) {
      this.histIdx--;
      this.input = this.history[this.histIdx]!;
      this.caret = this.input.length;
      this.drawComposer();
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
    this.drawComposer();
  }

  // ── submit ──

  private async submit(): Promise<void> {
    const raw = this.input.trim();
    this.input = "";
    this.caret = 0;
    this.histIdx = -1;
    if (!raw) { this.drawComposer(); return; }
    this.history.push(raw);

    // Echo the prompt into the transcript.
    this.print(`  ${accent("›")} ${text(raw)}`);

    if (raw.startsWith("/")) {
      const handled = await this.handleSlash(raw);
      if (handled) { this.drawComposer(); return; }
    }
    await this.runTurn(raw);
    this.drawComposer();
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
        process.stdout.write("\x1b[2J\x1b[H");
        this.region = new BottomRegion();
        return true;
      case "help": {
        const cmds: [string, string][] = [
          ["/model", "Switch model/provider"],
          ["/effort", "Set reasoning effort"],
          ["/status", "Session status"],
          ["/providers", "List providers"],
          ["/cost", "Session cost"],
          ["/plan", "Toggle plan mode"],
          ["/rewind", "Roll back the conversation"],
          ["/clear", "Clear the screen"],
          ["/quit", "Exit"],
        ];
        this.print(
          [`  ${bold(text("Commands"))}`, ...cmds.map(([c, d]) => `    ${info(c.padEnd(12))}${muted(d)}`)].join("\n"),
        );
        return true;
      }
      case "status": {
        const s = engine.getStatus(this.ctx.sessionId);
        this.print(
          renderStatus({
            model: s.model, provider: s.provider, effort: s.effort, workspace: s.workspace,
            sessionId: this.ctx.sessionId, cost: s.cost, plannerMode: s.plannerMode,
            yoloMode: s.yoloMode, trustWorkspace: s.trustWorkspace,
            registeredProviders: s.registeredProviders, version: this.ctx.version,
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
          const on = n === cur, has = reg.includes(n as any);
          const dot = on ? ok("●") : has ? warn("●") : faint("○");
          const c = on ? ok : has ? text : faint;
          const st = on ? ok("active") : has ? muted("ready") : faint("no key");
          return `    ${dot} ${c(n.padEnd(12))} ${st}`;
        });
        this.print([`  ${bold(text("Providers"))}`, ...rows].join("\n"));
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
        const items: PickerItem[] = levels.map((l) => ({ label: l, hint: l === engine.getEffort() ? "current" : "" }));
        const i = await this.pick("Reasoning effort", items, levels.indexOf(engine.getEffort() as any));
        if (i != null) { engine.setEffort(levels[i]!); this.print(`  ${ok("✓")} ${muted("effort set to")} ${warn(levels[i]!)}`); }
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
        if (turns.length === 0) { this.print(`  ${muted("Nothing to rewind yet.")}`); return true; }
        const n = parseInt(arg, 10);
        if (!arg || isNaN(n) || n < 1 || n > turns.length) {
          const rows = turns.map((t, i) => `    ${warn(String(i + 1).padStart(2))}  ${muted(t.text.replace(/\s+/g, " ").slice(0, 60))}`);
          this.print([`  ${bold(text("Rewind"))}`, ...rows, `  ${faint("Run /rewind <n>")}`].join("\n"));
          return true;
        }
        const removed = engine.rewindTo(this.ctx.sessionId, turns[n - 1]!.seq - 1);
        this.print(`  ${ok("✓")} ${muted(`rewound to turn ${n} (removed ${removed})`)}`);
        return true;
      }
      default: {
        const custom = findCommand(this.ctx.customCommands, cmd!);
        if (custom) { await this.runTurn(custom.render(arg)); return true; }
        this.print(`  ${accent("✕")} ${muted(`unknown command: /${cmd}`)} ${faint("· /help")}`);
        return true;
      }
    }
  }

  private modelPresets(reg: string[]): { provider: string; model: string; label: string }[] {
    const p: { provider: string; model: string; label: string }[] = [];
    if (reg.includes("google")) p.push(
      { provider: "google", model: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
      { provider: "google", model: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
    );
    if (reg.includes("anthropic")) p.push(
      { provider: "anthropic", model: "claude-sonnet-4-20250514", label: "Claude Sonnet 4" },
    );
    if (reg.includes("openai")) p.push({ provider: "openai", model: "gpt-4o", label: "GPT-4o" });
    if (reg.includes("openrouter")) p.push(
      { provider: "openrouter", model: "deepseek/deepseek-v4-flash:free", label: "DeepSeek V4 (free)" },
    );
    return p;
  }

  // ── picker mode ──

  private pick(title: string, items: PickerItem[], start: number): Promise<number | null> {
    return new Promise((resolve) => {
      this.picker = { title, items, sel: Math.max(0, start), resolve };
      this.mode = "picker";
      this.drawComposer();
    });
  }

  private pickerKey(key: Key): void {
    if (!this.picker) return;
    const p = this.picker;
    if (key.type === "up") { p.sel = (p.sel - 1 + p.items.length) % p.items.length; this.drawComposer(); }
    else if (key.type === "down") { p.sel = (p.sel + 1) % p.items.length; this.drawComposer(); }
    else if (key.type === "enter") { this.closePicker(p.sel); }
    else if (key.type === "esc" || (key.type === "ctrl" && key.name === "c")) { this.closePicker(null); }
  }

  private closePicker(result: number | null): void {
    const p = this.picker;
    this.picker = null;
    this.mode = "input";
    // Clear the picker block before the resolver prints its result.
    this.region.clear();
    this.region = new BottomRegion();
    p?.resolve(result);
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
      this.drawComposer();
    });

  private permKey(key: Key): void {
    if (!this.perm) return;
    let decision: UserPermissionDecision | null = null;
    if (key.type === "char" && (key.value === "n" || key.value === "N")) decision = { kind: "deny" };
    else if (key.type === "char" && (key.value === "s" || key.value === "S")) decision = { kind: "allow_session" };
    else if (key.type === "enter" || (key.type === "char" && (key.value === "y" || key.value === "Y"))) decision = { kind: "allow_once" };
    else if (key.type === "esc") decision = { kind: "deny" };
    if (!decision) return;
    const r = this.perm.resolve;
    this.perm = null;
    this.mode = "turn"; // return to the in-flight turn
    const label = decision.kind === "deny" ? accent("✕ denied") : ok(decision.kind === "allow_session" ? "✓ session" : "✓ allowed");
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
    this.drawComposer();
    this.tick = setInterval(() => { if (this.mode === "turn") this.drawComposer(); }, 250);

    const flush = (final = false) => {
      let idx: number;
      while ((idx = this.streamBuf.indexOf("\n")) >= 0) {
        const ln = this.streamBuf.slice(0, idx);
        this.streamBuf = this.streamBuf.slice(idx + 1);
        this.print(`  ${text(ln)}`);
      }
      if (final && this.streamBuf.length) { this.print(`  ${text(this.streamBuf)}`); this.streamBuf = ""; }
    };

    try {
      for await (const ev of engine.chat(this.ctx.sessionId, input)) {
        if (ev.type === "text_delta") { this.streamBuf += ev.text; flush(); continue; }
        if (ev.type === "tool_call_start") continue; // activity only
        flush(true);
        const block = formatEvent(ev, { cost: engine.getCost() });
        if (block) this.print(block);
      }
      flush(true);
    } catch (err) {
      flush(true);
      this.print(`  ${accent("✕")} ${text(err instanceof Error ? err.message : String(err))}`);
    } finally {
      if (this.tick) { clearInterval(this.tick); this.tick = null; }
      this.mode = "input";
    }
  }
}
