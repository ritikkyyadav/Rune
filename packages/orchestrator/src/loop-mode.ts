// ─── Session loop mode (/loop) ───
//
// A small, session-scoped scheduler for recurring agent turns. The scheduler is
// deliberately UI-agnostic: terminal frontends poll claimDue(), run the prompt
// only while idle, then report the outcome to complete(). State is persisted as
// append-only session events, so an unexpired loop comes back when the user
// resumes the same conversation without adding another database schema.

import { randomBytes } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const LOOP_MIN_INTERVAL_MS = 60_000;
export const LOOP_MAX_ADAPTIVE_INTERVAL_MS = 60 * LOOP_MIN_INTERVAL_MS;
export const LOOP_EXPIRY_MS = 7 * 24 * 60 * LOOP_MIN_INTERVAL_MS;
export const LOOP_MAX_TASKS = 50;
export const LOOP_PROMPT_MAX_BYTES = 25_000;

export const LOOP_EVENT_UPSERT = "loop_task_upsert";
export const LOOP_EVENT_DELETE = "loop_task_deleted";
export const LOOP_EVENT_CLEAR = "loop_tasks_cleared";

export const DEFAULT_LOOP_MAINTENANCE_PROMPT = [
  "Continue any unfinished work from this conversation.",
  "Then tend to the current branch's pull request: review new comments, failed CI runs, and merge conflicts.",
  "When nothing is pending, run a bounded cleanup pass for clear bugs or needless complexity.",
  "Do not start unrelated initiatives. Irreversible actions such as pushing or deleting may proceed only when the conversation already authorized them.",
].join("\n");

export type LoopCadence = "fixed" | "adaptive";
export type LoopPromptSource = "argument" | "project" | "user" | "builtin";

export interface LoopTask {
  id: string;
  prompt: string;
  promptSource: LoopPromptSource;
  cadence: LoopCadence;
  /** Fixed interval, or the adaptive interval chosen for the next iteration. */
  intervalMs: number;
  createdAt: number;
  expiresAt: number;
  nextRunAt: number;
  lastRunAt?: number;
  runCount: number;
  /** Index into ADAPTIVE_DELAYS; ignored by fixed loops. */
  adaptiveStep: number;
  nextReason: string;
}

export interface LoopRunOutcome {
  responseText?: string;
  toolCalls?: number;
  toolErrors?: number;
  filesChanged?: number;
  aborted?: boolean;
}

export interface LoopControlRequest {
  action: "continue" | "stop";
  delayMinutes?: number;
  reason?: string;
}

export interface LoopControlResult {
  ok: boolean;
  task?: LoopTask;
  message: string;
}

export interface LoopCompletion {
  state: "rescheduled" | "stopped" | "cancelled" | "expired";
  task?: LoopTask;
  reason: string;
}

export interface LoopCancelResult {
  ok: boolean;
  task?: LoopTask;
  error?: string;
}

export interface LoopEventRecord {
  type: string;
  payload: Record<string, unknown>;
}

export interface LoopPersistence {
  readEvents(): LoopEventRecord[];
  appendEvent(type: string, payload: Record<string, unknown>): void;
}

export interface LoopManagerOptions {
  now?: () => number;
  idFactory?: () => string;
  maxTasks?: number;
}

export interface ParsedLoopRequest {
  prompt: string;
  intervalMs?: number;
  warnings: string[];
}

export interface ResolvedLoopPrompt {
  prompt: string;
  source: LoopPromptSource;
  path?: string;
  warning?: string;
  truncated: boolean;
}

const ADAPTIVE_DELAYS = [1, 2, 5, 10, 20, 30, 60].map((minutes) => minutes * LOOP_MIN_INTERVAL_MS);

const UNIT_MS: Record<string, number> = {
  s: 1_000,
  sec: 1_000,
  secs: 1_000,
  second: 1_000,
  seconds: 1_000,
  m: LOOP_MIN_INTERVAL_MS,
  min: LOOP_MIN_INTERVAL_MS,
  mins: LOOP_MIN_INTERVAL_MS,
  minute: LOOP_MIN_INTERVAL_MS,
  minutes: LOOP_MIN_INTERVAL_MS,
  h: 60 * LOOP_MIN_INTERVAL_MS,
  hr: 60 * LOOP_MIN_INTERVAL_MS,
  hrs: 60 * LOOP_MIN_INTERVAL_MS,
  hour: 60 * LOOP_MIN_INTERVAL_MS,
  hours: 60 * LOOP_MIN_INTERVAL_MS,
  d: 24 * 60 * LOOP_MIN_INTERVAL_MS,
  day: 24 * 60 * LOOP_MIN_INTERVAL_MS,
  days: 24 * 60 * LOOP_MIN_INTERVAL_MS,
};

const UNIT_PATTERN =
  "s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days";
const LEADING_INTERVAL_RE = new RegExp(
  `^\\s*(\\d+(?:\\.\\d+)?)\\s*(${UNIT_PATTERN})(?=\\s|$)\\s*`,
  "i",
);
const TRAILING_INTERVAL_RE = new RegExp(
  `(?:,?\\s+every\\s+(\\d+(?:\\.\\d+)?)\\s*(${UNIT_PATTERN}))\\s*$`,
  "i",
);

/** Parse `/loop` arguments: `5m check CI`, `check CI every 2 hours`, or prompt-only. */
export function parseLoopRequest(raw: string): ParsedLoopRequest {
  let prompt = raw.trim();
  let intervalMs: number | undefined;
  const warnings: string[] = [];

  const leading = prompt.match(LEADING_INTERVAL_RE);
  if (leading) {
    intervalMs = parseInterval(leading[1]!, leading[2]!, warnings);
    prompt = prompt.slice(leading[0].length).trim();
  } else {
    const trailing = prompt.match(TRAILING_INTERVAL_RE);
    if (trailing) {
      intervalMs = parseInterval(trailing[1]!, trailing[2]!, warnings);
      prompt = prompt.slice(0, trailing.index).trim();
    }
  }

  return intervalMs === undefined ? { prompt, warnings } : { prompt, intervalMs, warnings };
}

function parseInterval(value: string, unit: string, warnings: string[]): number {
  const quantity = Number(value);
  const multiplier = UNIT_MS[unit.toLowerCase()];
  if (!Number.isFinite(quantity) || quantity <= 0 || !multiplier) {
    throw new Error("Loop interval must be a positive duration such as 5m, 2h, or 1d.");
  }
  const requested = Math.ceil(quantity * multiplier);
  if (requested < LOOP_MIN_INTERVAL_MS) {
    warnings.push("Sub-minute intervals are rounded up to Gear's one-minute minimum.");
    return LOOP_MIN_INTERVAL_MS;
  }
  if (requested >= LOOP_EXPIRY_MS) {
    throw new Error("Loop interval must be shorter than the seven-day session-loop expiry.");
  }
  return requested;
}

/** Resolve a missing prompt from `.alan/loop.md`, then `~/.alan/loop.md`, then the built-in. */
export function resolveLoopPrompt(
  explicitPrompt: string,
  workspaceRoot: string,
  alanHome: string,
): ResolvedLoopPrompt {
  if (explicitPrompt.trim()) {
    const limited = limitPrompt(explicitPrompt.trim());
    return {
      prompt: limited.text,
      source: "argument",
      truncated: limited.truncated,
      ...(limited.truncated
        ? {
            warning: `Loop prompt was truncated to ${LOOP_PROMPT_MAX_BYTES.toLocaleString()} bytes.`,
          }
        : {}),
    };
  }

  const candidates: Array<{ path: string; source: LoopPromptSource }> = [
    { path: join(workspaceRoot, ".alan", "loop.md"), source: "project" },
    { path: join(alanHome, "loop.md"), source: "user" },
  ];
  let warning: string | undefined;

  for (const candidate of candidates) {
    try {
      const parent = lstatSync(dirname(candidate.path));
      if (parent.isSymbolicLink()) {
        warning = `${dirname(candidate.path)} is a symlink, so Gear ignored it for loop safety.`;
        continue;
      }
      const stat = lstatSync(candidate.path);
      if (stat.isSymbolicLink()) {
        warning = `${candidate.path} is a symlink, so Gear ignored it for loop safety.`;
        continue;
      }
      if (!stat.isFile()) continue;
      const body = readFileSync(candidate.path);
      const limited = limitPrompt(body);
      if (!limited.text.trim()) continue;
      return {
        prompt: limited.text.trim(),
        source: candidate.source,
        path: candidate.path,
        truncated: limited.truncated,
        ...(limited.truncated
          ? {
              warning: `${candidate.path} was truncated to ${LOOP_PROMPT_MAX_BYTES.toLocaleString()} bytes.`,
            }
          : warning
            ? { warning }
            : {}),
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code !== "ENOENT") {
        warning = `Gear could not read ${candidate.path}; the built-in loop prompt will be used.`;
      }
    }
  }

  return {
    prompt: DEFAULT_LOOP_MAINTENANCE_PROMPT,
    source: "builtin",
    truncated: false,
    ...(warning ? { warning } : {}),
  };
}

function limitPrompt(value: string | Buffer): { text: string; truncated: boolean } {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  if (body.byteLength <= LOOP_PROMPT_MAX_BYTES) {
    return { text: body.toString("utf8"), truncated: false };
  }
  return {
    text: body.subarray(0, LOOP_PROMPT_MAX_BYTES).toString("utf8"),
    truncated: true,
  };
}

/** Human-sized duration used by both terminal frontends. */
export function formatLoopInterval(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / LOOP_MIN_INTERVAL_MS));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (hours < 24) return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remainderHours = hours % 24;
  return remainderHours ? `${days}d ${remainderHours}h` : `${days}d`;
}

export function formatLoopDue(nextRunAt: number, now = Date.now()): string {
  const remaining = nextRunAt - now;
  if (remaining <= 0) return "due now";
  const minutes = Math.max(1, Math.ceil(remaining / LOOP_MIN_INTERVAL_MS));
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return rem ? `in ${hours}h ${rem}m` : `in ${hours}h`;
}

export function loopPromptPreview(prompt: string, max = 72): string {
  const oneLine = prompt.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, Math.max(1, max - 1))}…`;
}

/** System-only instructions injected during a claimed scheduled turn. */
export function renderLoopRunDoctrine(task: LoopTask): string {
  const identity = `This user turn is iteration ${task.runCount + 1} of session loop ${task.id}.`;
  if (task.cadence === "fixed") {
    return [
      "<gear-loop-mode>",
      identity,
      `It runs on a fixed ${formatLoopInterval(task.intervalMs)} cadence while this session is open.`,
      "Carry out the recurring prompt autonomously with the session's existing permissions. Do not ask a clarification question; report a blocker plainly and finish the iteration instead.",
      "The fixed loop continues until the user cancels it or it expires. Do not call loop_control for a fixed loop.",
      "</gear-loop-mode>",
    ].join("\n");
  }
  return [
    "<gear-loop-mode>",
    identity,
    "This is an adaptive loop. Carry out the recurring prompt autonomously with the session's existing permissions; do not ask a clarification question.",
    "Before finishing, call loop_control exactly once: use action=stop only when the recurring objective is genuinely complete and no further polling is useful; otherwise use action=continue with a 1-60 minute delay and a short evidence-based reason.",
    "If blocked, continue with an appropriate delay and explain the blocker in the response.",
    "</gear-loop-mode>",
  ].join("\n");
}

export class LoopManager {
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly maxTasks: number;
  private readonly tasks = new Map<string, LoopTask>();
  private readonly inFlight = new Set<string>();
  private readonly controls = new Map<string, LoopControlRequest>();
  private loaded = false;

  constructor(
    private readonly persistence: LoopPersistence,
    options: LoopManagerOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? (() => randomBytes(4).toString("hex"));
    this.maxTasks = options.maxTasks ?? LOOP_MAX_TASKS;
  }

  create(input: { prompt: string; promptSource: LoopPromptSource; intervalMs?: number }): LoopTask {
    this.ensureLoaded();
    const now = this.now();
    this.cleanupExpired(now);
    if (this.tasks.size >= this.maxTasks) {
      throw new Error(`This session already has ${this.maxTasks} loop tasks, the maximum allowed.`);
    }

    const id = this.uniqueId();
    const initial = input.intervalMs
      ? {
          step: -1,
          delay: input.intervalMs,
          reason: `fixed ${formatLoopInterval(input.intervalMs)} cadence`,
        }
      : initialAdaptiveCadence(input.prompt);
    const task: LoopTask = {
      id,
      prompt: input.prompt,
      promptSource: input.promptSource,
      cadence: input.intervalMs ? "fixed" : "adaptive",
      intervalMs: initial.delay,
      createdAt: now,
      expiresAt: now + LOOP_EXPIRY_MS,
      nextRunAt: now + initial.delay,
      runCount: 0,
      adaptiveStep: initial.step,
      nextReason: initial.reason,
    };
    this.tasks.set(id, task);
    this.persistTask(task);
    return cloneTask(task);
  }

  list(): LoopTask[] {
    this.ensureLoaded();
    this.cleanupExpired(this.now());
    return [...this.tasks.values()]
      .sort((a, b) => a.nextRunAt - b.nextRunAt || a.createdAt - b.createdAt)
      .map(cloneTask);
  }

  nextDueAt(): number | null {
    const first = this.list()[0];
    return first?.nextRunAt ?? null;
  }

  /** Claim at most one due task. A session never runs two scheduled turns concurrently. */
  claimDue(): LoopTask | null {
    this.ensureLoaded();
    if (this.inFlight.size > 0) return null;
    const now = this.now();
    this.cleanupExpired(now);
    const task = [...this.tasks.values()]
      .filter((candidate) => candidate.nextRunAt <= now)
      .sort((a, b) => a.nextRunAt - b.nextRunAt || a.createdAt - b.createdAt)[0];
    if (!task) return null;
    this.inFlight.add(task.id);
    return cloneTask(task);
  }

  active(): LoopTask | null {
    this.ensureLoaded();
    const id = this.inFlight.values().next().value as string | undefined;
    const task = id ? this.tasks.get(id) : undefined;
    return task ? cloneTask(task) : null;
  }

  controlActive(request: LoopControlRequest): LoopControlResult {
    const task = this.active();
    if (!task) return { ok: false, message: "No adaptive loop iteration is active." };
    if (task.cadence !== "adaptive") {
      return { ok: false, task, message: "Fixed loops are controlled by the user." };
    }
    if (request.action === "continue") {
      const minutes = request.delayMinutes;
      if (minutes !== undefined && (!Number.isFinite(minutes) || minutes < 1 || minutes > 60)) {
        return {
          ok: false,
          task,
          message: "Adaptive loop delay must be between 1 and 60 minutes.",
        };
      }
    }
    this.controls.set(task.id, { ...request });
    return {
      ok: true,
      task,
      message:
        request.action === "stop"
          ? `Loop ${task.id} will stop after this iteration.`
          : `Loop ${task.id} will continue${request.delayMinutes ? ` in ${request.delayMinutes}m` : " on an adaptive delay"}.`,
    };
  }

  complete(id: string, outcome: LoopRunOutcome = {}): LoopCompletion {
    this.ensureLoaded();
    this.inFlight.delete(id);
    const control = this.controls.get(id);
    this.controls.delete(id);
    const task = this.tasks.get(id);
    if (!task) {
      return { state: "cancelled", reason: "The loop was cancelled while this iteration ran." };
    }

    const now = this.now();
    task.lastRunAt = now;
    task.runCount += 1;

    if (control?.action === "stop") {
      this.deleteTask(task, "completed");
      return {
        state: "stopped",
        reason:
          control.reason?.trim() || "The agent reported that the recurring objective is complete.",
      };
    }
    if (now >= task.expiresAt) {
      this.deleteTask(task, "expired");
      return { state: "expired", reason: "The loop reached its seven-day expiry." };
    }

    if (task.cadence === "adaptive") {
      const adaptive =
        control?.action === "continue" && control.delayMinutes !== undefined
          ? {
              step: nearestAdaptiveStep(control.delayMinutes * LOOP_MIN_INTERVAL_MS),
              delay: control.delayMinutes * LOOP_MIN_INTERVAL_MS,
              reason: control.reason?.trim() || "agent-selected adaptive delay",
            }
          : nextAdaptiveCadence(task, outcome);
      task.adaptiveStep = adaptive.step;
      task.intervalMs = adaptive.delay;
      task.nextReason = adaptive.reason;
    }

    // Keep the definition alive for the full seven-day window even when its
    // next cadence would fall beyond expiry. At the boundary list()/claimDue()
    // removes it instead of ending a day-scale loop early after its last run.
    task.nextRunAt = Math.min(now + task.intervalMs, task.expiresAt);
    this.persistTask(task);
    return { state: "rescheduled", task: cloneTask(task), reason: task.nextReason };
  }

  cancel(idOrPrefix?: string): LoopCancelResult {
    this.ensureLoaded();
    this.cleanupExpired(this.now());
    const tasks = [...this.tasks.values()];
    if (tasks.length === 0)
      return { ok: false, error: "No loop tasks are active in this session." };

    let task: LoopTask | undefined;
    if (!idOrPrefix?.trim()) {
      task = tasks.sort((a, b) => b.createdAt - a.createdAt)[0];
    } else {
      const target = idOrPrefix.trim().toLowerCase();
      const matches = tasks.filter((candidate) => candidate.id.toLowerCase().startsWith(target));
      if (matches.length > 1) {
        return { ok: false, error: `Loop id prefix "${idOrPrefix}" matches more than one task.` };
      }
      task = matches[0];
    }
    if (!task) return { ok: false, error: `No loop task matches "${idOrPrefix}".` };
    this.deleteTask(task, "cancelled");
    return { ok: true, task: cloneTask(task) };
  }

  clear(): number {
    this.ensureLoaded();
    const count = this.tasks.size;
    if (count === 0) return 0;
    this.tasks.clear();
    this.inFlight.clear();
    this.controls.clear();
    this.persistence.appendEvent(LOOP_EVENT_CLEAR, {});
    return count;
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    for (const event of this.persistence.readEvents()) {
      if (event.type === LOOP_EVENT_UPSERT) {
        const task = event.payload.task;
        if (isLoopTask(task)) this.tasks.set(task.id, cloneTask(task));
      } else if (event.type === LOOP_EVENT_DELETE) {
        const id = event.payload.id;
        if (typeof id === "string") this.tasks.delete(id);
      } else if (event.type === LOOP_EVENT_CLEAR) {
        this.tasks.clear();
      }
    }
  }

  private cleanupExpired(now: number): void {
    for (const task of [...this.tasks.values()]) {
      if (now >= task.expiresAt) this.deleteTask(task, "expired");
    }
  }

  private persistTask(task: LoopTask): void {
    this.persistence.appendEvent(LOOP_EVENT_UPSERT, { task: cloneTask(task) });
  }

  private deleteTask(task: LoopTask, reason: string): void {
    this.tasks.delete(task.id);
    this.inFlight.delete(task.id);
    this.controls.delete(task.id);
    this.persistence.appendEvent(LOOP_EVENT_DELETE, { id: task.id, reason });
  }

  private uniqueId(): string {
    for (let attempt = 0; attempt < 20; attempt++) {
      const id = this.idFactory()
        .replace(/[^a-zA-Z0-9]/g, "")
        .slice(0, 8)
        .toLowerCase();
      if (id.length === 8 && !this.tasks.has(id)) return id;
    }
    throw new Error("Could not allocate a unique loop task id.");
  }
}

function cloneTask(task: LoopTask): LoopTask {
  return { ...task };
}

function isLoopTask(value: unknown): value is LoopTask {
  if (!value || typeof value !== "object") return false;
  const task = value as Partial<LoopTask>;
  return (
    typeof task.id === "string" &&
    task.id.length === 8 &&
    typeof task.prompt === "string" &&
    (task.promptSource === "argument" ||
      task.promptSource === "project" ||
      task.promptSource === "user" ||
      task.promptSource === "builtin") &&
    (task.cadence === "fixed" || task.cadence === "adaptive") &&
    typeof task.intervalMs === "number" &&
    task.intervalMs >= LOOP_MIN_INTERVAL_MS &&
    typeof task.createdAt === "number" &&
    typeof task.expiresAt === "number" &&
    typeof task.nextRunAt === "number" &&
    typeof task.runCount === "number" &&
    typeof task.adaptiveStep === "number" &&
    typeof task.nextReason === "string"
  );
}

function initialAdaptiveCadence(prompt: string): { step: number; delay: number; reason: string } {
  const normalized = prompt.toLowerCase();
  let step = 3; // 10m general-purpose default
  let reason = "adaptive starting cadence";
  if (/\b(build|deploy|ci|test|job|process|migration|rollout)\b/.test(normalized)) {
    step = 1;
    reason = "short initial wait for active build or deployment work";
  } else if (
    /\b(pr|pull request|review|issue|status|check|monitor|watch|poll)\b/.test(normalized)
  ) {
    step = 2;
    reason = "initial monitoring cadence";
  }
  return { step, delay: ADAPTIVE_DELAYS[step]!, reason };
}

function nextAdaptiveCadence(
  task: LoopTask,
  outcome: LoopRunOutcome,
): { step: number; delay: number; reason: string } {
  const response = (outcome.responseText ?? "").toLowerCase();
  const toolCalls = outcome.toolCalls ?? 0;
  const toolErrors = outcome.toolErrors ?? 0;
  const filesChanged = outcome.filesChanged ?? 0;
  let step = Math.max(0, Math.min(ADAPTIVE_DELAYS.length - 1, task.adaptiveStep));
  let reason: string;

  if (outcome.aborted) {
    step = Math.max(0, step - 1);
    reason = "iteration was interrupted; retrying sooner";
  } else if (
    toolErrors > 0 ||
    /\b(error|failed|failure|blocked|rate limit|timed out)\b/.test(response)
  ) {
    step = Math.max(0, step - 1);
    reason = "an error or blocker needs a sooner follow-up";
  } else if (
    /\b(pending|running|in progress|queued|waiting|not yet|still processing)\b/.test(response)
  ) {
    step = Math.max(0, step - 1);
    reason = "work is still active";
  } else if (toolCalls > 0 || filesChanged > 0) {
    reason = "the last iteration found activity";
  } else {
    step = Math.min(ADAPTIVE_DELAYS.length - 1, step + 1);
    reason = "nothing changed; backing off the next check";
  }

  return { step, delay: ADAPTIVE_DELAYS[step]!, reason };
}

function nearestAdaptiveStep(delay: number): number {
  let best = 0;
  for (let i = 1; i < ADAPTIVE_DELAYS.length; i++) {
    if (Math.abs(ADAPTIVE_DELAYS[i]! - delay) < Math.abs(ADAPTIVE_DELAYS[best]! - delay)) best = i;
  }
  return best;
}
