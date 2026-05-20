import type { ToolCallInput, ToolCallOutput, ToolHandler, ToolSchema } from "../types";

/**
 * Creates a ToolHandler that delegates to the alan-tools Rust binary.
 * Each tool invocation spawns: alan-tools --workspace <root> <subcommand>
 * with JSON piped to stdin, JSON read from stdout.
 */
export function createRustToolHandler(
  schema: ToolSchema,
  subcommand: string,
  binaryPath: string,
): ToolHandler {
  return {
    schema,
    validate: (_args) => ({ valid: true }),
    execute: async (input: ToolCallInput): Promise<ToolCallOutput> => {
      const start = performance.now();
      try {
        const args = ["--workspace", input.workspaceRoot];
        if (schema.permissionLevel === "sandbox") {
          args.push("--sandbox");
        }
        args.push(subcommand);
        const proc = Bun.spawn([binaryPath, ...args], {
          stdin: new Blob([JSON.stringify(input.args)]),
          stdout: "pipe",
          stderr: "pipe",
        });

        const [stdout, stderr] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);

        const exitCode = await proc.exited;
        const durationMs = Math.round(performance.now() - start);

        if (exitCode !== 0) {
          // Try to parse error from JSON output
          try {
            const parsed = JSON.parse(stdout);
            return {
              callId: input.callId,
              toolName: input.toolName,
              success: false,
              result: "",
              error: parsed.error || stderr || `Exit code ${exitCode}`,
              durationMs,
            };
          } catch {
            return {
              callId: input.callId,
              toolName: input.toolName,
              success: false,
              result: "",
              error: stderr || `Exit code ${exitCode}`,
              durationMs,
            };
          }
        }

        const parsed = JSON.parse(stdout);
        return {
          callId: input.callId,
          toolName: input.toolName,
          success: parsed.success,
          result: JSON.stringify(parsed.result),
          error: parsed.error,
          durationMs,
        };
      } catch (err) {
        const durationMs = Math.round(performance.now() - start);
        return {
          callId: input.callId,
          toolName: input.toolName,
          success: false,
          result: "",
          error: err instanceof Error ? err.message : String(err),
          durationMs,
        };
      }
    },
  };
}
