import type { ToolCallInput, ToolCallOutput, ToolHandler, ToolSchema } from "./types";
import type { ToolDefinition } from "@gear/llm-gateway";
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

  register(handler: ToolHandler): void {
    this.tools.set(handler.schema.name, handler);
    this.circuits.set(handler.schema.name, {
      failures: 0,
      lastFailure: 0,
      disabled: false,
    });
  }

  unregister(name: string): boolean {
    this.circuits.delete(name);
    return this.tools.delete(name);
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
    return [...this.tools.values()]
      .filter((h) => {
        const capability = CAPABILITY_GATED_TOOLS[h.schema.name];
        if (capability && !capability(process.env)) return false;
        const gate = FAMILY_GATED_TOOLS[h.schema.name];
        if (!gate) return true;
        return forModel !== undefined && gate(forModel);
      })
      .map((h) => ({
        name: h.schema.name,
        // Same tool, phrased the way this model family reads instructions.
        description: toolDescriptionFor(h.schema.description, h.schema.name, forModel),
        inputSchema: h.schema.inputSchema,
      }));
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
