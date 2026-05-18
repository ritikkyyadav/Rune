import type { ToolCallInput, ToolCallOutput, ToolHandler, ToolSchema } from "./types";
import type { ToolDefinition } from "@alan/llm-gateway";

interface CircuitState {
  failures: number;
  lastFailure: number;
  disabled: boolean;
}

const CIRCUIT_WINDOW_MS = 60_000;
const CIRCUIT_THRESHOLD = 5;

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

  toLlmTools(): ToolDefinition[] {
    return [...this.tools.values()].map((h) => ({
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
