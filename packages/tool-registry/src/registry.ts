import type { ToolCallInput, ToolCallOutput, ToolHandler, ToolSchema } from "./types";
import type { ToolDefinition } from "@gear/llm-gateway";

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
        const gate = FAMILY_GATED_TOOLS[h.schema.name];
        if (!gate) return true;
        return forModel !== undefined && gate(forModel);
      })
      .map((h) => ({
        name: h.schema.name,
        description: h.schema.description,
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
      // Reset circuit on success
      circuit.failures = 0;
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
