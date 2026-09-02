import type { ToolCallInput, ToolCallOutput, ToolHandler, ToolSchema } from "./types";
import type { ToolDefinition } from "@gear/llm-gateway";
import {
  LOAD_TOOLS_SCHEMA,
  LOAD_TOOLS_TOOL,
  catalogSummary,
  deferredByDefault,
  renderCatalog,
  type DeferredEntry,
} from "./tools/load-tools";
import { toolDescriptionFor } from "./model-families";

interface CircuitState {
  failures: number;
  lastFailure: number;
  disabled: boolean;
}

const CIRCUIT_WINDOW_MS = 60_000;
const CIRCUIT_THRESHOLD = 5;

// ─── Model–harness fit: per-family tool advertisement ───
//
// One tool surface for every model fights RL training: OpenAI's Codex-line
// models emit `apply_patch` envelopes natively, while Anthropic models are
// trained on string-replace edits. Tools listed here are REGISTERED for all
// models (execution never depends on who called) but only advertised to
// families whose predicate matches — everyone else keeps the current default
// set, so schema tokens aren't burned on a format the model will never use.
// Resolve the list ONCE per run (agent-loop does) so the advertised set stays
// stable within a session — churning it mid-session invalidates prompt cache.

/** gpt-*, o1/o3/o4*, codex-*, gpt-oss — the apply_patch-trained lineage. */
export function modelUsesApplyPatch(model: string): boolean {
  return /^(gpt-|o[134](-|$)|codex)/i.test(model.trim());
}

const FAMILY_GATED_TOOLS: Record<string, (model: string) => boolean> = {
  apply_patch: modelUsesApplyPatch,
};

/**
 * Tools advertised only when the environment can actually use them.
 *
 * Distinct from FAMILY_GATED_TOOLS above, which asks "does this MODEL speak
 * this format". This asks "is this integration configured at all". Every tool
 * definition costs tokens on every request whether or not the task could reach
 * for it, and an integration nobody has set up is the clearest case of a
 * schema earning nothing.
 *
 * Deliberately conservative: gate only on an unambiguous signal, and only for
 * tools whose absence cannot silently reduce ordinary coding ability. A gate
 * that removes a useful tool to save tokens is a worse trade than the tokens.
 */
const CAPABILITY_GATED_TOOLS: Record<string, (env: NodeJS.ProcessEnv) => boolean> = {
  // n8n is an opt-in workflow integration reached through N8N_BASE_URL. With
  // no base URL configured the tool can only be called with a full webhook
  // URL the model has no way to know.
  n8n_trigger: (env) => Boolean(env.N8N_BASE_URL),
};

export class ToolRegistry {
  private tools: Map<string, ToolHandler> = new Map();
  private circuits: Map<string, CircuitState> = new Map();

  // ─── Deferred advertisement (P4.1) ───
  // A deferred tool is REGISTERED and callable; it is simply advertised as one
  // catalog line rather than a full JSON schema until `load_tools` promotes it.
  // Execution never consults these sets — a tool the model somehow calls
  // without loading still runs, because refusing a correct call to save tokens
  // would be the worst of both trades.
  private deferredNames = new Set<string>();
  private activatedNames = new Set<string>();
  private deferralEnabled = true;

  register(handler: ToolHandler): void {
    const name = handler.schema.name;
    this.tools.set(name, handler);
    this.circuits.set(name, {
      failures: 0,
      lastFailure: 0,
      disabled: false,
    });
    // Re-registration (MCP reconcile after a restart) must not un-defer a tool
    // the model already loaded — `activatedNames` is what keeps that sticky.
    if (name !== LOAD_TOOLS_TOOL && deferredByDefault(name)) this.deferredNames.add(name);
  }

  unregister(name: string): boolean {
    this.circuits.delete(name);
    this.deferredNames.delete(name);
    this.activatedNames.delete(name);
    return this.tools.delete(name);
  }

  /** Turn deferred advertisement off entirely (config escape / eval baselines). */
  setDeferralEnabled(on: boolean): void {
    this.deferralEnabled = on;
  }

  /** True when this tool is currently a catalog line rather than a full schema. */
  isDeferred(name: string): boolean {
    return this.deferralEnabled && this.deferredNames.has(name) && !this.activatedNames.has(name);
  }

  /** The catalog the prompt carries: every still-deferred tool, name + one line. */
  deferredCatalog(): DeferredEntry[] {
    const out: DeferredEntry[] = [];
    for (const h of this.tools.values()) {
      if (!this.isDeferred(h.schema.name)) continue;
      out.push({ name: h.schema.name, summary: catalogSummary(h.schema.description) });
    }
    return out.sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  /**
   * Promote deferred tools to full advertisement for the rest of the run.
   * Returns the full definitions of what was loaded, and the names that matched
   * nothing so the caller can say so rather than failing silently.
   */
  activateTools(names: string[]): { loaded: ToolDefinition[]; unknown: string[] } {
    const loaded: ToolDefinition[] = [];
    const unknown: string[] = [];
    for (const raw of names) {
      const name = raw.trim();
      const handler = this.tools.get(name);
      if (!handler || name === LOAD_TOOLS_TOOL) {
        unknown.push(raw);
        continue;
      }
      this.activatedNames.add(name);
      loaded.push({
        name: handler.schema.name,
        description: handler.schema.description,
        inputSchema: handler.schema.inputSchema,
      });
    }
    return { loaded, unknown };
  }

  /**
   * What the advertised tool surface costs, in tokens, on ONE request — and
   * what it would have cost with every tool fully described. Backs the
   * "schema tokens" line in `gear audit`; ~4 chars/token is the repo's
   * standing approximation (system-memory.ts uses the same).
   */
  schemaTokenReport(forModel?: string): {
    advertised: number;
    deferred: number;
    tokens: number;
    eagerTokens: number;
    savedPct: number;
  } {
    const chars = (defs: ToolDefinition[]): number => JSON.stringify(defs).length;
    const current = this.toLlmTools(forModel);
    const wasEnabled = this.deferralEnabled;
    this.deferralEnabled = false;
    const everything = this.toLlmTools(forModel);
    this.deferralEnabled = wasEnabled;

    const tokens = Math.ceil(chars(current) / 4);
    const eagerTokens = Math.ceil(chars(everything) / 4);
    return {
      advertised: current.length,
      deferred: this.deferredCatalog().length,
      tokens,
      eagerTokens,
      savedPct: eagerTokens > 0 ? Math.round(((eagerTokens - tokens) / eagerTokens) * 100) : 0,
    };
  }

  get(name: string): ToolHandler | undefined {
    return this.tools.get(name);
  }

  list(): ToolSchema[] {
    return [...this.tools.values()].map((h) => h.schema);
  }

  /**
   * The tool definitions to advertise to the model. Family-gated tools
   * (apply_patch) are included only when `forModel` matches their family;
   * callers that don't pass a model get exactly the ungated set — advertising
   * a family-specific format to an unknown model is the one-size-fits-all
   * problem this gate exists to end.
   */
  toLlmTools(forModel?: string): ToolDefinition[] {
    const eligible = [...this.tools.values()].filter((h) => {
      const capability = CAPABILITY_GATED_TOOLS[h.schema.name];
      if (capability && !capability(process.env)) return false;
      const gate = FAMILY_GATED_TOOLS[h.schema.name];
      if (!gate) return true;
      return forModel !== undefined && gate(forModel);
    });

    // Without `load_tools` registered there is nothing that could turn a
    // catalog line back into a schema, so deferring would hide a tool the
    // model has no way to reach. Advertise everything instead: saving tokens
    // is never worth making a registered tool unreachable.
    const canDefer = this.tools.has(LOAD_TOOLS_TOOL);

    const defs: ToolDefinition[] = [];
    const catalog: DeferredEntry[] = [];
    for (const h of eligible) {
      // load_tools is appended last, carrying the catalog it just collected.
      if (h.schema.name === LOAD_TOOLS_TOOL) continue;
      if (canDefer && this.isDeferred(h.schema.name)) {
        catalog.push({ name: h.schema.name, summary: catalogSummary(h.schema.description) });
        continue;
      }
      defs.push({
        name: h.schema.name,
        // Same tool, phrased the way this model family reads instructions.
        description: toolDescriptionFor(h.schema.description, h.schema.name, forModel),
        inputSchema: h.schema.inputSchema,
      });
    }

    // Nothing deferred ⇒ no catalog, so `load_tools` itself is not advertised.
    // A session with no connectors pays nothing for the mechanism.
    if (catalog.length > 0) {
      catalog.sort((a, b) => (a.name < b.name ? -1 : 1));
      defs.push({
        name: LOAD_TOOLS_TOOL,
        description: renderCatalog(catalog),
        inputSchema: LOAD_TOOLS_SCHEMA.inputSchema,
      });
    }
    return defs;
  }

  async execute(input: ToolCallInput): Promise<ToolCallOutput> {
    const handler = this.tools.get(input.toolName);
    if (!handler) {
      return {
        callId: input.callId,
        toolName: input.toolName,
        success: false,
        result: "",
        error: `Tool not found: ${input.toolName}`,
        durationMs: 0,
      };
    }

    // Check circuit breaker
    const circuit = this.circuits.get(input.toolName)!;
    if (circuit.disabled) {
      const elapsed = Date.now() - circuit.lastFailure;
      if (elapsed < CIRCUIT_WINDOW_MS) {
        return {
          callId: input.callId,
          toolName: input.toolName,
          success: false,
          result: "",
          error: `Tool "${input.toolName}" is temporarily disabled (circuit breaker open)`,
          durationMs: 0,
        };
      }
      // Reset after window
      circuit.disabled = false;
      circuit.failures = 0;
    }

    // Validate args
    const validation = handler.validate(input.args);
    if (!validation.valid) {
      return {
        callId: input.callId,
        toolName: input.toolName,
        success: false,
        result: "",
        error: `Validation failed: ${validation.error}`,
        durationMs: 0,
      };
    }

    // Execute
    const start = performance.now();
    try {
      const output = await handler.execute(input);
      // Reset the circuit on SUCCESS ONLY.
      //
      // This used to reset on any returned output, success or not. Because a
      // returned `{success: false}` is the normal failure convention across
      // this codebase, one such result zeroed the counter — so a tool could
      // throw, throw, throw, return a soft failure, and start again from zero,
      // never reaching CIRCUIT_THRESHOLD inside the window. The breaker was
      // effectively disarmed by the very failures it was counting.
      //
      // Deliberately NOT tripping the breaker on a returned failure: those are
      // usually the CALL being wrong rather than the tool being broken — a
      // stale edit_file hash, a grep pattern that matches nothing, a bad path.
      // Disabling edit_file for 60s because the model made five stale edits
      // would cost far more than the retry loop it prevents. That class is the
      // agent loop's job (maxConsecutiveErrors in reliability-policy.ts); the
      // breaker's job is a tool whose implementation is faulting.
      if (output.success) circuit.failures = 0;
      return output;
    } catch (err) {
      const durationMs = Math.round(performance.now() - start);
      this.recordFailure(input.toolName);
      return {
        callId: input.callId,
        toolName: input.toolName,
        success: false,
        result: "",
        error: err instanceof Error ? err.message : String(err),
        durationMs,
      };
    }
  }

  private recordFailure(toolName: string): void {
    const circuit = this.circuits.get(toolName);
    if (!circuit) return;

    const now = Date.now();
    // Reset counter if outside window
    if (now - circuit.lastFailure > CIRCUIT_WINDOW_MS) {
      circuit.failures = 0;
    }

    circuit.failures++;
    circuit.lastFailure = now;

    if (circuit.failures >= CIRCUIT_THRESHOLD) {
      circuit.disabled = true;
    }
  }
}
