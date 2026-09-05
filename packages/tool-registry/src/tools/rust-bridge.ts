import { isOsIsolationAvailable, isOsIsolationRequired } from "../sandbox-capability";
import { isSandboxEnabled } from "../sandbox-mode";
import type {
  ToolAttachment,
  ToolCallInput,
  ToolCallOutput,
  ToolHandler,
  ToolSchema,
} from "../types";

/** Media types every vision-capable provider accepts. */
const ATTACHABLE = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/**
 * Move a tool's base64 payload out of its JSON result and into a typed
 * attachment, DELETING it from the object first so the stringified result the
 * model reads carries only the description.
 */
function liftAttachments(result: unknown): ToolAttachment[] {
  if (!result || typeof result !== "object") return [];
  const r = result as Record<string, unknown>;
  const data = r.base64;
  const mediaType = r.media_type;
  // Always drop the raw payload, even when it is unusable — leaving a rejected
  // 3 MB blob in the transcript is the failure this exists to prevent.
  delete r.base64;
  if (typeof data !== "string" || !data) return [];
  if (typeof mediaType !== "string" || !ATTACHABLE.has(mediaType)) return [];
  const label = typeof r.path === "string" ? r.path : "image";
  return [{ kind: "image", mediaType, data, label }];
}

/**
 * Creates a ToolHandler that delegates to the rune-tools Rust binary.
 * Each tool invocation spawns: rune-tools --workspace <root> <subcommand>
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
      if (input.signal?.aborted) {
        return {
          callId: input.callId,
          toolName: input.toolName,
          success: false,
          result: "",
          error: "Interrupted before start.",
          durationMs: 0,
        };
      }
      try {
        const args = ["--workspace", input.workspaceRoot];
        // Sandbox-level tools run inside the OS sandbox (deny-net, confined
        // writes) — EXCEPT when the model explicitly requested network access
        // (network: true), which escalates to an unsandboxed run, or when the
        // user disabled the sandbox entirely (/sandbox off, --no-sandbox).
        // The per-call escalation is permission-gated upstream: the broker
        // never auto-approves a network run outside 4th gear.
        if (
          schema.permissionLevel === "sandbox" &&
          input.args.network !== true &&
          isSandboxEnabled()
        ) {
          // requireOs: the user declared containment mandatory. When this
          // machine has no isolation backend, refusing beats the factory's
          // silent path-guard-only degradation.
          if (isOsIsolationRequired() && !isOsIsolationAvailable()) {
            return {
              callId: input.callId,
              toolName: input.toolName,
              success: false,
              result: "",
              error:
                "OS sandbox required ([sandbox] requireOs = true) but no isolation backend " +
                "is available on this machine (sandbox-exec/bwrap missing). Install one, or " +
                "set requireOs = false to allow degraded (path-guard-only) execution.",
              durationMs: Math.round(performance.now() - start),
            };
          }
          args.push("--sandbox");
        }
        args.push(subcommand);
        const proc = Bun.spawn([binaryPath, ...args], {
          stdin: new Blob([JSON.stringify(input.args)]),
          stdout: "pipe",
          stderr: "pipe",
        });

        // Esc must actually stop the work. Forward the abort as SIGTERM —
        // rune-tools' signal handler kills its child's whole process group
        // and exits — escalating to SIGKILL if it doesn't die promptly.
        // Without this, an interrupted bash call kept running for up to its
        // full 120s timeout while the turn appeared hung.
        let killTimer: ReturnType<typeof setTimeout> | null = null;
        const onAbort = () => {
          try {
            proc.kill();
          } catch {
            /* already gone */
          }
          killTimer = setTimeout(() => {
            try {
              proc.kill(9);
            } catch {
              /* already gone */
            }
          }, 1_500);
        };
        input.signal?.addEventListener("abort", onAbort, { once: true });

        let stdout: string;
        let stderr: string;
        let exitCode: number;
        try {
          [stdout, stderr] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
          ]);
          exitCode = await proc.exited;
        } finally {
          input.signal?.removeEventListener("abort", onAbort);
          if (killTimer) clearTimeout(killTimer);
        }
        const durationMs = Math.round(performance.now() - start);

        if (input.signal?.aborted) {
          return {
            callId: input.callId,
            toolName: input.toolName,
            success: false,
            result: "",
            error: "Interrupted by user.",
            durationMs,
          };
        }

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
        // Pixels ride beside the result, never inside it. `result` is
        // JSON.stringify'd straight into the model's transcript, so a base64
        // field left in place would be the same context bomb the binary read
        // used to be — just spelled differently.
        const attachments = liftAttachments(parsed.result);
        return {
          callId: input.callId,
          toolName: input.toolName,
          success: parsed.success,
          result: JSON.stringify(parsed.result),
          error: parsed.error,
          durationMs,
          ...(attachments.length > 0 && { attachments }),
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
