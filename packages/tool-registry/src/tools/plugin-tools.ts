// ─── Executable plugin tools: subprocesses, under the OS sandbox (D6 v2) ───
//
// D6 v1 said plugins are declarative, because "a declaration is not a sandbox."
// This is the other half of that sentence: a plugin may ship executable tools
// once they run under one. Each declared tool is a PROGRAM — any language —
// spawned as a subprocess wrapped by Seatbelt or bubblewrap with exactly the
// capability its manifest entry declares, speaking line-delimited JSON on
// stdio. Nothing is ever loaded into the Gear process; there is no `import`
// anywhere in this file's path from a plugin's bytes to this process's heap.
//
// The four rules that make that claim mean something:
//
//  1. **The sandbox is the boundary, and the profile is built in Rust.**
//     `gear-tools sandbox-plan` returns the argv; the policy lives beside the
//     bash sandbox's, in `crates/gear-sandbox/src/spawn.rs`, so the two cannot
//     drift. This module owns the pipes and nothing else.
//  2. **No sandbox, no tool.** A machine with no isolation backend (Windows,
//     a mac without `sandbox-exec`) refuses to start a plugin tool at all.
//     `[extensions] allowUnsandboxedTools` lifts that per plugin, loudly.
//  3. **The declared capability IS the permission category.** A
//     workspace-write tool is a `write` tool to the broker, so it is not
//     auto-approved in 1st gear; a network tool is a `network` tool, so it
//     reaches the Auto classifier the way `web_fetch` does. There is no path
//     where a plugin's own manifest makes its tool cheaper to approve.
//  4. **Org policy can name it.** Every tool carries `policyId`
//     `plugin:<plugin>:<tool>`, so a signed policy denies a whole bundle with
//     `plugin:<plugin>:*`.
//
// The user's own `.gear/tools` loader (custom-loader.ts) is untouched: that is
// in-process code the user wrote, behind `[extensions] localTools`, and it is
// deliberately not the mechanism a third party gets.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@gear/shared";

import { isOsIsolationAvailable } from "../sandbox-capability";
import type {
  PermissionLevel,
  ToolCallInput,
  ToolCallOutput,
  ToolCategory,
  ToolHandler,
  ToolSchema,
} from "../types";

const pluginToolLog = createLogger("plugin-tools");

/** The wire protocol version this build speaks. */
export const PLUGIN_TOOL_PROTOCOL = 1;

const DEFAULT_START_TIMEOUT_MS = 15_000;
const DEFAULT_CALL_TIMEOUT_MS = 120_000;
/** stderr is a diagnostic, not a result: keep the tail, drop the rest. */
const STDERR_RING_LINES = 40;

// ─── What a manifest declares ───

export type PluginToolCapability = "none" | "workspace-read" | "workspace-write" | "network";

export const PLUGIN_TOOL_CAPABILITIES: readonly PluginToolCapability[] = [
  "none",
  "workspace-read",
  "workspace-write",
  "network",
];

export interface PluginToolDeclaration {
  /** Identifies the tool server inside the plugin. Diagnostics and logs. */
  id: string;
  /** argv: the program and its arguments, relative to the plugin root. */
  command: string[];
  capability: PluginToolCapability;
  /** `host:port` entries. Only meaningful for `network`. */
  hosts?: string[];
  description?: string;
  /** Per-call ceiling. Defaults to 120s. */
  timeoutMs?: number;
}

/** One tool the running program advertised on start. */
export interface AdvertisedTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Validate a manifest's `tools` entry. Returns the reason it was refused, or
 * null. Refusals are loud rather than silent: a plugin whose tool never
 * appeared, with nothing said, is the state this whole subsystem exists to
 * avoid repeating.
 */
export function validateToolDeclaration(raw: unknown, index: number): string | null {
  const at = `tools[${index}]`;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return `${at} is not an object`;
  const decl = raw as Record<string, unknown>;
  if (typeof decl.id !== "string" || !/^[A-Za-z0-9_-]+$/.test(decl.id)) {
    return `${at}.id must be letters, digits, - or _`;
  }
  if (!Array.isArray(decl.command) || decl.command.length === 0) {
    return `${at}.command must be a non-empty argv array`;
  }
  if (!decl.command.every((c) => typeof c === "string" && c.length > 0)) {
    return `${at}.command must contain only non-empty strings`;
  }
  if (!PLUGIN_TOOL_CAPABILITIES.includes(decl.capability as PluginToolCapability)) {
    return `${at}.capability must be one of ${PLUGIN_TOOL_CAPABILITIES.join(", ")}`;
  }
  if (decl.hosts !== undefined) {
    if (!Array.isArray(decl.hosts) || !decl.hosts.every((h) => typeof h === "string")) {
      return `${at}.hosts must be an array of "host:port" strings`;
    }
  }
  if (decl.capability === "network" && (!Array.isArray(decl.hosts) || decl.hosts.length === 0)) {
    return `${at} declares capability "network" but lists no hosts — declare them or use "none"`;
  }
  if (decl.capability !== "network" && Array.isArray(decl.hosts) && decl.hosts.length > 0) {
    return `${at} lists hosts but its capability is "${String(decl.capability)}" — the hosts would be ignored`;
  }
  return null;
}

// ─── Capability → permission ───

/**
 * The mapping the broker and the classifier see.
 *
 * A capability is a claim about blast radius, so it maps onto the category
 * that already means that blast radius — no plugin-specific permission path,
 * no new tier for third parties. `permissionLevel` is never `auto`: `auto`
 * means "never prompts, in any gear", and that is not something a manifest
 * gets to assert about a stranger's program. `sandbox` and `confirm` differ
 * only in the scope the prompt suggests (a sandboxed call is a narrower thing
 * to approve once), so the level tracks whether OS isolation is actually
 * wrapping the process rather than whether it was requested.
 */
export function pluginToolPermissions(
  capability: PluginToolCapability,
  sandboxed: boolean,
): { category: ToolCategory; permissionLevel: PermissionLevel } {
  const category: ToolCategory =
    capability === "workspace-read"
      ? "read"
      : capability === "workspace-write"
        ? "write"
        : capability === "network"
          ? "network"
          : "execute";
  return { category, permissionLevel: sandboxed ? "sandbox" : "confirm" };
}

/** The model-facing name: `plugin_<plugin>_<tool>`. */
export function pluginToolName(plugin: string, tool: string): string {
  return `plugin_${plugin}_${tool}`.replace(/[^A-Za-z0-9_-]/g, "_");
}

/** The org-policy identity: `plugin:<plugin>:<tool>`, matched by `plugin:<plugin>:*`. */
export function pluginPolicyId(plugin: string, tool: string): string {
  return `plugin:${plugin}:${tool}`;
}

/**
 * `[extensions] allowUnsandboxedTools`: `true` for every plugin, or a list of
 * plugin names. Absent means "no" — the direction that fails safe.
 */
export function unsandboxedToolsAllowed(
  setting: boolean | string[] | undefined,
  plugin: string,
): boolean {
  if (setting === true) return true;
  if (Array.isArray(setting)) return setting.includes(plugin);
  return false;
}

// ─── The launch plan (from gear-tools) ───

export interface PluginToolSpawnPlan {
  argv: string[];
  mechanism: string;
  os_isolation: boolean;
  host_enforcement: string;
  notes: string[];
}

export type SpawnPlanner = (req: {
  workspaceRoot: string;
  capability: PluginToolCapability;
  hosts: string[];
  pluginRoot: string;
  scratchDir: string;
  program: string;
  args: string[];
}) => PluginToolSpawnPlan;

/**
 * Ask `gear-tools sandbox-plan` how to wrap this program on this machine.
 *
 * Synchronous on purpose: it runs once per tool server at start, costs ~10ms,
 * and no permission decision may ever race a half-known containment state.
 * Any failure yields an UNSANDBOXED plan — which the caller then refuses,
 * because "we could not determine the sandbox" must land on the same side of
 * the line as "there is no sandbox".
 */
export function makeGearToolsPlanner(binaryPath: string): SpawnPlanner {
  return (req) => {
    const payload = {
      capability: req.capability,
      hosts: req.hosts,
      plugin_root: req.pluginRoot,
      scratch_dir: req.scratchDir,
      program: req.program,
      args: req.args,
    };
    const fallback: PluginToolSpawnPlan = {
      argv: [req.program, ...req.args],
      mechanism: "none",
      os_isolation: false,
      host_enforcement: "none",
      notes: [],
    };
    try {
      const proc = Bun.spawnSync([binaryPath, "--workspace", req.workspaceRoot, "sandbox-plan"], {
        stdin: new TextEncoder().encode(JSON.stringify(payload)),
        stdout: "pipe",
        stderr: "pipe",
      });
      const parsed = JSON.parse(new TextDecoder().decode(proc.stdout)) as {
        success?: boolean;
        result?: PluginToolSpawnPlan;
      };
      if (parsed?.success === true && Array.isArray(parsed.result?.argv)) return parsed.result;
      return { ...fallback, notes: ["gear-tools sandbox-plan returned no plan"] };
    } catch (err) {
      return {
        ...fallback,
        notes: [`gear-tools sandbox-plan failed: ${err instanceof Error ? err.message : err}`],
      };
    }
  };
}

// ─── The stdio protocol ───

type OutgoingFrame =
  | { type: "hello"; protocol: number; gear: string; plugin: string; workspaceRoot: string }
  | { type: "call"; id: string; tool: string; args: Record<string, unknown> }
  | { type: "shutdown" };

interface SchemaFrame {
  type: "schema";
  protocol?: number;
  tools?: unknown;
}

interface ResultFrame {
  type: "result";
  id?: string;
  ok?: boolean;
  result?: unknown;
  error?: string;
}

export interface PluginToolServerOptions {
  plugin: string;
  pluginRoot: string;
  workspaceRoot: string;
  declaration: PluginToolDeclaration;
  planner: SpawnPlanner;
  /** `[extensions] allowUnsandboxedTools`. */
  allowUnsandboxed?: boolean | string[];
  gearVersion?: string;
  startTimeoutMs?: number;
  /** Extra environment for the child. `TMPDIR` is always the private scratch. */
  env?: Record<string, string>;
}

export interface PluginToolStart {
  ok: boolean;
  /** What the program advertised, when it started. */
  tools: AdvertisedTool[];
  /** Why it did not start, or what the user must be told about how it did. */
  message?: string;
  plan?: PluginToolSpawnPlan;
}

/**
 * One plugin tool program: spawn, read its schema advertisement, then answer
 * calls until the session ends.
 */
export class PluginToolServer {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private reader: { cancel(): Promise<void> } | null = null;
  private stderrReader: { cancel(): Promise<void> } | null = null;
  private stderrRing: string[] = [];
  private buffer = "";
  private scratchDir: string | null = null;
  private pending = new Map<
    string,
    { resolve: (frame: ResultFrame) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private schemaWaiter: ((frame: SchemaFrame | null) => void) | null = null;
  private nextId = 1;
  private stopped = false;
  private plan: PluginToolSpawnPlan | null = null;

  constructor(private readonly opts: PluginToolServerOptions) {}

  get sandboxed(): boolean {
    return this.plan?.os_isolation === true;
  }

  get mechanism(): string {
    return this.plan?.mechanism ?? "unknown";
  }

  /** The last stderr lines, for a diagnostic when the program misbehaves. */
  stderrTail(): string {
    return this.stderrRing.join("\n");
  }

  async start(): Promise<PluginToolStart> {
    const decl = this.opts.declaration;
    const [program, ...args] = decl.command;
    if (!program) return { ok: false, tools: [], message: "empty command" };

    this.scratchDir = mkdtempSync(join(tmpdir(), `gear-plugin-tool-${this.opts.plugin}-`));
    const plan = this.opts.planner({
      workspaceRoot: this.opts.workspaceRoot,
      capability: decl.capability,
      hosts: decl.hosts ?? [],
      pluginRoot: this.opts.pluginRoot,
      scratchDir: this.scratchDir,
      program,
      args,
    });
    this.plan = plan;

    // Rule 2. A machine that cannot contain the process does not run it.
    if (!plan.os_isolation) {
      const allowed = unsandboxedToolsAllowed(this.opts.allowUnsandboxed, this.opts.plugin);
      if (!allowed) {
        this.cleanupScratch();
        return {
          ok: false,
          tools: [],
          plan,
          message:
            `plugin "${this.opts.plugin}" tool "${decl.id}" needs the OS sandbox and this machine ` +
            `has none (${plan.mechanism})${plan.notes.length ? ` — ${plan.notes.join("; ")}` : ""}. ` +
            `Set [extensions] allowUnsandboxedTools = ["${this.opts.plugin}"] to run it uncontained.`,
        };
      }
      pluginToolLog.warn(
        `[SECURITY] plugin "${this.opts.plugin}" tool "${decl.id}" is running UNSANDBOXED ` +
          `(capability "${decl.capability}" is not enforced) because [extensions] ` +
          `allowUnsandboxedTools permits it. It has this user's full access.`,
      );
    }

    // The working directory is ALWAYS the plugin's own root, for every
    // capability. A relative path in the manifest then means exactly one thing
    // (the plugin's own file), and the workspace reaches the program as an
    // explicit value — `GEAR_WORKSPACE` and the `hello` frame — rather than as
    // an implicit cwd that changes meaning with the capability.
    try {
      this.proc = Bun.spawn(plan.argv, {
        cwd: this.opts.pluginRoot,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          TMPDIR: this.scratchDir,
          // A tool that cannot write its runtime's caches must not die trying.
          PYTHONDONTWRITEBYTECODE: "1",
          GEAR_PLUGIN: this.opts.plugin,
          GEAR_PLUGIN_ROOT: this.opts.pluginRoot,
          GEAR_WORKSPACE: this.opts.workspaceRoot,
          GEAR_TOOL_CAPABILITY: decl.capability,
          ...(this.opts.env ?? {}),
        },
      });
    } catch (err) {
      this.cleanupScratch();
      return {
        ok: false,
        tools: [],
        plan,
        message: `could not spawn ${program}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    this.proc.unref();
    void this.proc.exited.then(() => {
      if (!this.stopped) this.failAllPending("the plugin tool process exited");
    });
    void this.readLoop();
    void this.drainStderr();

    const advertised = await this.awaitSchema();
    if (!advertised) {
      const tail = this.stderrTail();
      await this.stop();
      return {
        ok: false,
        tools: [],
        plan,
        message:
          `plugin "${this.opts.plugin}" tool "${decl.id}" advertised no schema within ` +
          `${this.opts.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS}ms` +
          (tail ? ` — stderr: ${tail.slice(0, 400)}` : ""),
      };
    }

    this.send({
      type: "hello",
      protocol: PLUGIN_TOOL_PROTOCOL,
      gear: this.opts.gearVersion ?? "",
      plugin: this.opts.plugin,
      workspaceRoot: this.opts.workspaceRoot,
    });

    return {
      ok: true,
      tools: advertised,
      plan,
      message: plan.notes.length > 0 ? plan.notes.join("; ") : undefined,
    };
  }

  /** Send one call frame and wait for its result. */
  async call(
    tool: string,
    args: Record<string, unknown>,
    opts: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<{ ok: boolean; result?: unknown; error?: string }> {
    if (this.stopped || !this.proc) return { ok: false, error: "the plugin tool is not running" };
    const id = String(this.nextId++);
    const timeoutMs = opts.timeoutMs ?? this.opts.declaration.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;

    const frame = await new Promise<ResultFrame>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ type: "result", id, ok: false, error: `timed out after ${timeoutMs}ms` });
      }, timeoutMs);
      const onAbort = (): void => {
        this.pending.delete(id);
        clearTimeout(timer);
        resolve({ type: "result", id, ok: false, error: "Interrupted by user." });
      };
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        resolve: (f) => {
          opts.signal?.removeEventListener("abort", onAbort);
          resolve(f);
        },
        timer,
      });
      try {
        this.send({ type: "call", id, tool, args });
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        resolve({
          type: "result",
          id,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });

    if (frame.ok === true) return { ok: true, result: frame.result };
    return { ok: false, error: frame.error ?? "the plugin tool reported a failure" };
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    try {
      this.send({ type: "shutdown" });
    } catch {
      // Already gone.
    }
    this.failAllPending("the plugin tool was stopped");
    try {
      await this.reader?.cancel();
    } catch {
      // Reader already released.
    }
    try {
      await this.stderrReader?.cancel();
    } catch {
      // Reader already released.
    }
    this.reader = null;
    this.stderrReader = null;
    const stdin = this.proc?.stdin;
    if (stdin && typeof stdin !== "number" && "end" in stdin) {
      try {
        (stdin as { end(): void }).end();
      } catch {
        // Already closed.
      }
    }
    this.proc?.kill();
    this.proc = null;
    this.cleanupScratch();
  }

  // ─── internals ───

  private cleanupScratch(): void {
    if (!this.scratchDir) return;
    try {
      rmSync(this.scratchDir, { recursive: true, force: true });
    } catch {
      // A leftover temp dir is not worth failing a shutdown over.
    }
    this.scratchDir = null;
  }

  private send(frame: OutgoingFrame): void {
    const stdin = this.proc?.stdin;
    if (!stdin || typeof stdin === "number" || !("write" in stdin)) {
      throw new Error("the plugin tool's stdin is not available");
    }
    (stdin as { write(data: Uint8Array): number; flush?: () => void }).write(
      new TextEncoder().encode(`${JSON.stringify(frame)}\n`),
    );
    (stdin as { flush?: () => void }).flush?.();
  }

  private failAllPending(reason: string): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.resolve({ type: "result", id, ok: false, error: reason });
    }
    this.pending.clear();
    this.schemaWaiter?.(null);
    this.schemaWaiter = null;
  }

  private awaitSchema(): Promise<AdvertisedTool[] | null> {
    const timeoutMs = this.opts.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.schemaWaiter = null;
        resolve(null);
      }, timeoutMs);
      this.schemaWaiter = (frame) => {
        clearTimeout(timer);
        this.schemaWaiter = null;
        resolve(frame ? normalizeAdvertised(frame.tools) : null);
      };
    });
  }

  private handleFrame(frame: unknown): void {
    if (typeof frame !== "object" || frame === null) return;
    const kind = (frame as { type?: unknown }).type;
    if (kind === "schema") {
      this.schemaWaiter?.(frame as SchemaFrame);
      return;
    }
    if (kind === "log") {
      const message = String((frame as { message?: unknown }).message ?? "");
      pluginToolLog.debug(`[${this.opts.plugin}/${this.opts.declaration.id}] ${message}`);
      return;
    }
    if (kind !== "result") return;
    const result = frame as ResultFrame;
    const id = typeof result.id === "string" ? result.id : String(result.id ?? "");
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    entry.resolve(result);
  }

  private async readLoop(): Promise<void> {
    const stdout = this.proc?.stdout;
    if (!stdout || typeof stdout === "number") return;
    const reader = (stdout as ReadableStream<Uint8Array>).getReader();
    this.reader = reader;
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        this.buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = this.buffer.indexOf("\n")) !== -1) {
          const line = this.buffer.slice(0, nl).trim();
          this.buffer = this.buffer.slice(nl + 1);
          if (!line) continue;
          try {
            this.handleFrame(JSON.parse(line));
          } catch {
            // A program that logs to stdout is not a protocol violation worth
            // killing it over; the line is simply not a frame.
            pluginToolLog.debug(`[${this.opts.plugin}] non-frame stdout: ${line.slice(0, 200)}`);
          }
        }
      }
    } catch {
      // Stream closed or reader cancelled.
    } finally {
      this.reader = null;
    }
  }

  /**
   * Drain stderr. An unread "pipe" fills the OS buffer and then blocks the
   * program's next write forever — a chatty tool would hang the session.
   */
  private async drainStderr(): Promise<void> {
    const stderr = this.proc?.stderr;
    if (!stderr || typeof stderr === "number") return;
    const reader = (stderr as ReadableStream<Uint8Array>).getReader();
    this.stderrReader = reader;
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, nl).trimEnd();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          this.stderrRing.push(line);
          if (this.stderrRing.length > STDERR_RING_LINES) this.stderrRing.shift();
        }
      }
    } catch {
      // Stream closed or reader cancelled.
    } finally {
      this.stderrReader = null;
    }
  }
}

function normalizeAdvertised(raw: unknown): AdvertisedTool[] {
  if (!Array.isArray(raw)) return [];
  const out: AdvertisedTool[] = [];
  for (const candidate of raw) {
    if (typeof candidate !== "object" || candidate === null) continue;
    const t = candidate as Record<string, unknown>;
    if (typeof t.name !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(t.name)) continue;
    out.push({
      name: t.name,
      description: typeof t.description === "string" ? t.description : `Plugin tool ${t.name}`,
      inputSchema:
        typeof t.inputSchema === "object" && t.inputSchema !== null
          ? (t.inputSchema as Record<string, unknown>)
          : { type: "object", properties: {} },
    });
  }
  return out;
}

// ─── Handlers ───

/**
 * Wrap one advertised tool as a `ToolHandler`. The schema carries the
 * capability in its description, because the model deciding whether to reach
 * for a third party's network tool should be able to see that it is one.
 */
export function createPluginToolHandler(
  server: PluginToolServer,
  opts: {
    plugin: string;
    version?: string;
    declaration: PluginToolDeclaration;
    advertised: AdvertisedTool;
  },
): ToolHandler {
  const { category, permissionLevel } = pluginToolPermissions(
    opts.declaration.capability,
    server.sandboxed,
  );
  const containment = server.sandboxed
    ? `sandboxed (${server.mechanism})`
    : "NOT sandboxed on this machine";
  const schema: ToolSchema = {
    name: pluginToolName(opts.plugin, opts.advertised.name),
    version: opts.version ?? "0.1.0",
    description:
      `${opts.advertised.description} ` +
      `[plugin "${opts.plugin}" · capability ${opts.declaration.capability} · ${containment}]`,
    inputSchema: opts.advertised.inputSchema,
    permissionLevel,
    category,
    policyId: pluginPolicyId(opts.plugin, opts.advertised.name),
  };

  return {
    schema,
    validate: (args) => {
      const input = schema.inputSchema as { required?: unknown };
      if (Array.isArray(input.required)) {
        for (const key of input.required as string[]) {
          if (!(key in args)) return { valid: false, error: `Missing required param: ${key}` };
        }
      }
      return { valid: true };
    },
    execute: async (input: ToolCallInput): Promise<ToolCallOutput> => {
      const start = performance.now();
      const outcome = await server.call(opts.advertised.name, input.args, {
        signal: input.signal,
      });
      const durationMs = Math.round(performance.now() - start);
      return {
        callId: input.callId,
        toolName: input.toolName,
        success: outcome.ok,
        result: outcome.ok
          ? typeof outcome.result === "string"
            ? outcome.result
            : JSON.stringify(outcome.result ?? null)
          : "",
        ...(outcome.ok ? {} : { error: outcome.error }),
        durationMs,
      };
    },
  };
}

export interface StartedPluginTools {
  handlers: ToolHandler[];
  servers: PluginToolServer[];
  /** Lines the user must see: refusals, and unsandboxed warnings. */
  notices: string[];
}

/**
 * Start every declared tool server for one plugin and return its handlers.
 * A server that refuses to start contributes a notice and no handlers — never
 * a silent absence.
 */
export async function startPluginTools(opts: {
  plugin: string;
  pluginRoot: string;
  version?: string;
  workspaceRoot: string;
  declarations: PluginToolDeclaration[];
  planner: SpawnPlanner;
  allowUnsandboxed?: boolean | string[];
  gearVersion?: string;
  startTimeoutMs?: number;
}): Promise<StartedPluginTools> {
  const out: StartedPluginTools = { handlers: [], servers: [], notices: [] };
  const claimed = new Set<string>();

  for (const declaration of opts.declarations) {
    const server = new PluginToolServer({
      plugin: opts.plugin,
      pluginRoot: opts.pluginRoot,
      workspaceRoot: opts.workspaceRoot,
      declaration,
      planner: opts.planner,
      allowUnsandboxed: opts.allowUnsandboxed,
      gearVersion: opts.gearVersion,
      startTimeoutMs: opts.startTimeoutMs,
    });
    const started = await server.start();
    if (!started.ok) {
      out.notices.push(
        started.message ?? `plugin "${opts.plugin}" tool "${declaration.id}" failed`,
      );
      continue;
    }
    if (!server.sandboxed) {
      out.notices.push(
        `plugin "${opts.plugin}" tool "${declaration.id}" is running UNSANDBOXED — ` +
          `its declared capability "${declaration.capability}" is not enforced`,
      );
    } else if (started.message) {
      out.notices.push(`plugin "${opts.plugin}" tool "${declaration.id}": ${started.message}`);
    }
    if (started.tools.length === 0) {
      out.notices.push(
        `plugin "${opts.plugin}" tool "${declaration.id}" advertised no usable tools`,
      );
      await server.stop();
      continue;
    }

    out.servers.push(server);
    for (const advertised of started.tools) {
      const name = pluginToolName(opts.plugin, advertised.name);
      if (claimed.has(name)) {
        out.notices.push(
          `plugin "${opts.plugin}" advertises "${advertised.name}" twice — the second is ignored`,
        );
        continue;
      }
      claimed.add(name);
      out.handlers.push(
        createPluginToolHandler(server, {
          plugin: opts.plugin,
          version: opts.version,
          declaration,
          advertised,
        }),
      );
    }
  }

  return out;
}

/**
 * Whether this machine can contain a plugin tool at all — the same question
 * the broker asks about bash, asked before a plugin's program is spawned
 * rather than after.
 */
export function osIsolationAvailableForPluginTools(): boolean {
  return isOsIsolationAvailable();
}
