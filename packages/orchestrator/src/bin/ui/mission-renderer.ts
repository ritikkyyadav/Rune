// ─── Gear renderer ───
// An opt-in surface for `berne --gear`. It consumes exactly the same engine event
// stream the existing renderer does and draws it as a mission instead of as a chat
// log. It shares nothing with ./theme, ./themes or ./turn — the existing theme modes
// are untouched and keep working exactly as before; this is a second surface beside
// them, not a replacement for them.
//
// The one rule it inherits from @gear/mission: it never reads what the model said in
// order to decide what to draw. Every row here is a projection of state folded from
// typed events by the reducer.

import { execSync } from "node:child_process";
import {
  EngineAdapter,
  MissionLog,
  Prose,
  Pulse,
  Surface,
  detectCaps,
  holdWidth,
  initialState,
  ledger,
  queryGround,
  screenFor,
  stdoutSink,
  wrapText,
  holds,
  stream,
  type Caps,
  type EngineEvent,
  type MissionState,
  type Row,
} from "@gear/mission";

const { header, project, toolRunning } = stream;
const { terminus } = holds;

const git = (args: string): string => {
  try {
    return execSync(`git ${args}`, { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "";
  }
};

export interface MissionRendererOptions {
  /** the product's real version — the header states facts, so it may not be a literal */
  version: string;
  model: string;
  effort?: string;
  sandboxed: boolean;
  /** the permission posture, in the words the gate will use later */
  posture: string;
  workspace: string;
}

export class MissionRenderer {
  private readonly caps: Caps;
  private readonly surface: Surface;
  private readonly log: MissionLog;
  private readonly adapter = new EngineAdapter();
  private readonly pulses = new Map<string, Pulse>();
  private previous: MissionState = initialState();
  private prose = new Prose({}, Date.now());
  /** the paragraph so far, re-wrapped every frame because it may still grow */
  private proseBuffer = "";
  /** how many of its lines can no longer change, and so have been committed */
  private proseSettled = 0;
  /** the line that is still growing. lives in the live region, never in scrollback. */
  private proseTail = "";
  private ticker?: ReturnType<typeof setInterval>;
  private opened = false;

  private constructor(
    private readonly opts: MissionRendererOptions,
    caps: Caps,
    ground: [number, number, number] | undefined,
  ) {
    this.caps = caps;
    this.surface = new Surface(stdoutSink(), caps, screenFor(ground));
    this.log = new MissionLog(undefined, { now: () => Date.now() });
  }

  /** Queries the terminal's own ground once, for the row tint. */
  static async create(opts: MissionRendererOptions): Promise<MissionRenderer> {
    const caps = detectCaps();
    const ground = caps.tint ? await queryGround() : undefined;
    return new MissionRenderer(opts, caps, ground);
  }

  /** Four rows at minute zero, then it gets out of the way. */
  banner(): void {
    const root = git("rev-parse --show-toplevel");
    this.surface.commit(
      header(
        {
          version: this.opts.version,
          // A repo and a branch are facts. Outside a repo there is neither, and an
          // empty `git` result must never be read as "clean".
          repo: root
            ? root.split("/").slice(-2).join("/")
            : this.opts.workspace.split("/").filter(Boolean).slice(-1)[0]!,
          branch: root ? git("rev-parse --abbrev-ref HEAD") || "detached" : "not a repo",
          treeClean: root ? git("status --porcelain") === "" : null,
          model: this.opts.model,
          effort: this.opts.effort ?? "normal",
          sandboxed: this.opts.sandboxed,
          posture: this.opts.posture,
        },
        this.caps,
      ),
    );
  }

  /**
   * The objective, as the contract for this turn. A chat turn agrees no criteria, and
   * the terminus says so rather than inventing four.
   */
  open(objective: string): void {
    this.log.append({
      type: "MISSION_OPENED",
      id: "m-" + Math.abs(hash(objective)).toString(16).slice(0, 4),
      objective: objective.split("\n")[0]!.slice(0, 72),
      scope: [this.opts.workspace],
      exclusions: ["everything outside the workspace"],
      budget: "no cap set",
      baseline: git("rev-parse --short HEAD") || "unknown",
      criteria: [],
    });
    this.opened = true;
    this.previous = this.log.current;
    this.proseBuffer = "";
    this.proseSettled = 0;
    this.proseTail = "";
    // The live region redraws on its own clock so a wedged tool goes quiet on screen
    // without needing another engine event to arrive.
    this.ticker = setInterval(() => this.paintLive(), 120);
    if (typeof this.ticker.unref === "function") this.ticker.unref();
  }

  onEvent(ev: EngineEvent): void {
    if (!this.opened) return;

    // Prose streams; code does not. Text is committed on word boundaries only.
    if (ev.type === "text_delta") {
      const safe = this.prose.push(ev.text, Date.now());
      if (safe) this.absorb(safe);
      return;
    }
    if (ev.type === "stream_reset") {
      // The provider abandoned the stream mid-response: drop what was live, keep what
      // was already committed — it was only committed because it could not change.
      this.prose = new Prose({}, Date.now());
      this.proseBuffer = "";
      this.proseSettled = 0;
      this.proseTail = "";
      return;
    }

    if (ev.type === "tool_call_start") this.pulses.set(ev.callId, new Pulse(Date.now()));
    if (ev.type === "tool_call_args_delta")
      this.pulses.get(ev.callId)?.sample(ev.partialJson.length, Date.now());
    if (ev.type === "tool_call_end") this.pulses.delete(ev.callId);

    for (const mission of this.adapter.translate(ev)) {
      const before = this.log.current;
      const applied = this.log.append(mission);
      const rows = project(applied, this.log.current, before, this.caps);
      if (rows.length) this.surface.commit(rows);
      this.previous = this.log.current;
    }
    this.paintLive();
  }

  onError(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.surface.settle([]);
    this.surface.commit([
      null,
      {
        spans: [
          { t: "  ✗ ", c: "danger" },
          { t: message.slice(0, 200), c: "strong" },
        ],
      },
      // What broke, then what state the world is in now — the one every CLI forgets.
      {
        spans: [{ t: "     " }, { t: "Your tree is untouched by this failure.", c: "dim" }],
      },
      null,
    ]);
  }

  /** The result. The one screen in the product worth owning. */
  finish(): void {
    if (this.ticker) clearInterval(this.ticker);
    const tail = this.prose.flush();
    if (tail) this.absorb(tail);
    // End of turn: the last line can no longer change either.
    this.surface.settle(this.proseTail ? [{ spans: [{ t: "  " + this.proseTail }] }] : []);
    this.proseTail = "";
    if (!this.opened) return;

    const state = this.log.current;
    if (!state.changes.length && !state.findings.length && !state.phases.length) {
      // Nothing happened worth a terminus. Do not draw a receipt for a conversation.
      this.surface.close();
      return;
    }
    this.surface.commit([
      null,
      ...terminus(
        state,
        {
          notDone: [],
          evidence: [
            `${state.tools.length} tool calls · ${state.changes.length} files changed`,
            `every claim above has an event id · baseline ${state.baseline}`,
          ],
          branch: git("rev-parse --abbrev-ref HEAD") || undefined,
        },
        holdWidth(this.caps),
      ),
    ]);
    this.surface.close();
  }

  close(): void {
    if (this.ticker) clearInterval(this.ticker);
    this.surface.close();
  }

  // ── internals ──

  /**
   * A line is committed the instant it can no longer change — which is when a later
   * word has pushed past it. Everything after that stays live and free to re-wrap,
   * because freezing half a paragraph into scrollback means it is wrapped at today's
   * width forever. Body text is never coloured: the user's foreground wins.
   */
  private absorb(text: string): void {
    this.proseBuffer += text;
    const lines = wrapText(this.proseBuffer.replace(/\s+/g, " ").trim(), this.caps.measure - 4);
    const settled = lines.slice(0, -1);
    if (settled.length > this.proseSettled) {
      this.surface.commit(
        settled.slice(this.proseSettled).map((l): Row => ({ spans: [{ t: "  " + l }] })),
      );
      this.proseSettled = settled.length;
    }
    this.proseTail = lines[lines.length - 1] ?? "";
    this.paintLive();
  }

  private paintLive(): void {
    if (!this.opened) return;
    const now = Date.now();
    const state = this.log.current;
    const running = state.tools.filter((t) => t.running);
    const rows: Array<Row | null> = running.map((t) => {
      const p = this.pulses.get(t.id);
      return toolRunning(t, p?.level(now) ?? 0, p?.quietMs(now) ?? 0);
    });
    if (this.proseTail) rows.push({ spans: [{ t: "  " + this.proseTail }] });
    if (state.phase !== "concluded") rows.push(...ledger(state, { caps: this.caps, now }));
    this.surface.live(rows);
  }
}

const hash = (s: string): number => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
};
