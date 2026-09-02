// ─── StruggleDetector: behavioral struggle signals ───
// Errors are easy — the recorder catches those at the chokepoints. Struggles
// are the failures where NO exception fired: the agent thrashing on the same
// file, the user re-asking the same thing, corrections, abandoned todos.
// Every rule here is deterministic and zero-cost (no model calls); each fires
// at most once per run per key, so a long thrash becomes one incident, not
// fifty.

import type { IncidentReporter } from "@gear/shared";

export interface StruggleDetectorConfig {
  /** Same file read this many times in one run (without an intervening edit) → thrash. Default 3. */
  readThrashCount?: number;
  /** Same file edited this many times in one run → churn. Default 4. */
  editChurnCount?: number;
  /** Same search pattern issued this many times in one run → thrash. Default 3. */
  searchThrashCount?: number;
  /** Token-Jaccard similarity between consecutive user messages → rephrase. Default 0.6. */
  rephraseSimilarity?: number;
  /** Aborts within one run → interrupt burst. Default 2. */
  interruptBurst?: number;
}

const DEFAULTS: Required<StruggleDetectorConfig> = {
  readThrashCount: 3,
  editChurnCount: 4,
  searchThrashCount: 3,
  rephraseSimilarity: 0.6,
  interruptBurst: 2,
};

// Opening patterns that read as the user correcting the agent's last output.
// Deliberately anchored to the start of the message — "no, that's the wrong
// file" is a correction; "there is no such file" mid-sentence is not.
const CORRECTION_RES: RegExp[] = [
  /^(no+|nope|nah)\b/i,
  /^(wrong|incorrect)\b/i,
  /^that'?s (wrong|not what|not it|incorrect)/i,
  /^not what i (asked|meant|wanted)/i,
  /^(stop|wait|hold on)\b/i,
  /^don'?t\b/i,
  /^you (broke|deleted|removed|ruined)\b/i,
  /^(undo|revert) (that|this|it)\b/i,
  /^(still|it'?s still) (broken|failing|not working|wrong)/i,
  /^(that )?(didn'?t|doesn'?t|does not|did not) (work|help|fix)/i,
];

/**
 * An actionable struggle the LIVE RUN should hear about — not just the black
 * box. `advice` is the in-context corrective note, written imperatively.
 * Only the signals where intervention beats observation carry one: edit churn
 * and search thrash (the run is burning turns on a failing approach RIGHT
 * NOW). Read-thrash and user corrections stay observe-only — re-reading can
 * be legitimate exploration, and corrections arrive between runs.
 */
export interface StruggleSignal {
  cls: "struggle.thrash_edits" | "struggle.thrash_search";
  message: string;
  advice: string;
}

export class StruggleDetector {
  private cfg: Required<StruggleDetectorConfig>;
  private report: IncidentReporter;
  private onSignal?: (signal: StruggleSignal) => void;

  // per-run state
  private reads = new Map<string, number>();
  private edits = new Map<string, number>();
  private searches = new Map<string, number>();
  private fired = new Set<string>();
  private aborts = 0;
  private prevUserMessage: string | null = null;

  constructor(
    report: IncidentReporter,
    config: StruggleDetectorConfig = {},
    onSignal?: (signal: StruggleSignal) => void,
  ) {
    this.report = report;
    this.cfg = { ...DEFAULTS, ...config };
    this.onSignal = onSignal;
  }

  /**
   * Did any struggle signal fire this run? Read by the lessons lifecycle: a
   * run the user or the harness had to steer is not a win for whatever advice
   * happened to be injected into it.
   */
  struggled(): boolean {
    return this.fired.size > 0;
  }

  /** Reset per-run counters. The previous user message survives — rephrase compares across runs. */
  beginRun(): void {
    this.reads.clear();
    this.edits.clear();
    this.searches.clear();
    this.fired.clear();
    this.aborts = 0;
  }

  onToolCall(toolName: string, args: Record<string, unknown>, success: boolean): void {
    try {
      if (toolName === "read_file") {
        const path = str(args.path);
        if (!path) return;
        const n = (this.reads.get(path) ?? 0) + 1;
        this.reads.set(path, n);
        if (n === this.cfg.readThrashCount) {
          this.fire("struggle.thrash_reads", "warn", `read ${path} ${n}× without editing it`);
        }
      } else if (
        toolName === "edit_file" ||
        toolName === "write_file" ||
        toolName === "multi_edit"
      ) {
        const path = str(args.path);
        if (!path) return;
        // an edit legitimately resets the "re-read the same file" signal
        this.reads.delete(path);
        if (!success) return; // failed edits are already counted by the tool tap
        const n = (this.edits.get(path) ?? 0) + 1;
        this.edits.set(path, n);
        if (n === this.cfg.editChurnCount) {
          this.fire("struggle.thrash_edits", "warn", `edited ${path} ${n}× in one run`);
          this.signal({
            cls: "struggle.thrash_edits",
            message: `edited ${path} ${n}× in one run`,
            advice:
              `You have now edited ${path} ${n} times this run. Stop patching this file. ` +
              "Re-read the ACTUAL failing output, reconsider the approach, and update your " +
              "todo list (todo_write) before the next edit.",
          });
        }
      } else if (toolName === "grep" || toolName === "glob") {
        const pattern = str(args.pattern) ?? str(args.glob);
        if (!pattern) return;
        const key = `${toolName}:${pattern}`;
        const n = (this.searches.get(key) ?? 0) + 1;
        this.searches.set(key, n);
        if (n === this.cfg.searchThrashCount) {
          this.fire(
            "struggle.thrash_search",
            "warn",
            `${toolName} for ${JSON.stringify(pattern)} repeated ${n}×`,
          );
          this.signal({
            cls: "struggle.thrash_search",
            message: `${toolName} for ${JSON.stringify(pattern)} repeated ${n}×`,
            advice:
              `The same ${toolName} (${JSON.stringify(pattern)}) has now run ${n} times — ` +
              "it will keep returning the same results. Change the query, search a different " +
              "way (symbol_search, search_code, list_dir), or step back and rethink where the " +
              "answer actually lives.",
          });
        }
      }
    } catch {
      // a detector bug must never affect the run
    }
  }

  /** Call with each new user message BEFORE the run starts. */
  onUserMessage(text: string): void {
    try {
      const prev = this.prevUserMessage;
      this.prevUserMessage = text;
      const trimmed = text.trim();
      if (!trimmed) return;

      if (prev !== null && CORRECTION_RES.some((re) => re.test(trimmed))) {
        this.fire("struggle.correction", "warn", `user correction: ${trimmed.slice(0, 140)}`);
        return;
      }
      if (prev !== null) {
        const sim = jaccard(tokenize(prev), tokenize(trimmed));
        if (sim >= this.cfg.rephraseSimilarity) {
          this.fire(
            "struggle.rephrase",
            "warn",
            `user re-asked (similarity ${(sim * 100).toFixed(0)}%): ${trimmed.slice(0, 140)}`,
          );
        }
      }
    } catch {
      // never throw
    }
  }

  onAbort(): void {
    try {
      this.aborts++;
      if (this.aborts === this.cfg.interruptBurst) {
        this.fire(
          "struggle.interrupt_burst",
          "warn",
          `user aborted ${this.aborts}× within one run`,
        );
      }
    } catch {
      // never throw
    }
  }

  /** Call at run end with the final todo list (null if todos were never used). */
  onRunEnd(todos: Array<{ content: string; status: string }> | null): void {
    try {
      if (!todos || todos.length === 0) return;
      const unfinished = todos.filter((t) => t.status !== "completed");
      if (unfinished.length > 0) {
        this.fire(
          "struggle.todo_unfinished",
          "debug",
          `run ended with ${unfinished.length}/${todos.length} todos unfinished: ` +
            unfinished
              .slice(0, 3)
              .map((t) => t.content)
              .join("; ")
              .slice(0, 140),
        );
      }
    } catch {
      // never throw
    }
  }

  // ─── internals ───

  /** Guarded delivery of an actionable signal to the live run. */
  private signal(s: StruggleSignal): void {
    try {
      this.onSignal?.(s);
    } catch {
      // a consumer bug must never affect the run
    }
  }

  private fire(
    cls: Parameters<IncidentReporter>[0]["class"],
    severity: "debug" | "warn",
    message: string,
  ): void {
    // once per class+message-key per run
    const key = `${cls}:${message.slice(0, 60)}`;
    if (this.fired.has(key)) return;
    this.fired.add(key);
    try {
      this.report({
        class: cls,
        severity,
        component: "struggle-detector",
        where: "struggle-detector#fire",
        message,
      });
    } catch {
      // reporter bugs never propagate
    }
  }
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function tokenize(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size < 4 || b.size < 4) return 0; // too short to call a rephrase
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}
