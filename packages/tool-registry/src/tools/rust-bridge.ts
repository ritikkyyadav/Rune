import { isOsIsolationAvailable, isOsIsolationRequired } from "../sandbox-capability";
import {
  isUnsandboxedFallbackAllowed,
  resolveSandboxLaunch,
  sandboxPathsFor,
} from "../sandbox-mode";
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
 * The kernel says "Operation not permitted" and nothing else when Seatbelt or
 * bubblewrap refuses a syscall, so a command that tripped a sandbox rule reads
 * exactly like one with a bug. When a sandboxed run fails with that shape, the
 * result carries a hint naming the likely restriction and the sanctioned way
 * out — `unsandboxed: true` under the fallback override, or the user's
 * excludedCommands under strict — so the model does not spend three turns
 * guessing.
 */
const SANDBOX_DENIAL_RE =
  /operation not permitted|permission denied|read-only file system|eperm|eacces|erofs|sandbox(?:-exec)?:|deny\(1\)|could not (?:create|write|open)|cannot create (?:directory|regular file)/i;

export function sandboxDenialHint(
  stderr: string,
  exitCode: number | null | undefined,
): string | null {
  if (!stderr || exitCode === 0 || exitCode === undefined) return null;
  if (!SANDBOX_DENIAL_RE.test(stderr)) return null;
  const base =
    "This command ran inside the OS sandbox and failed with a permission error, which is usually a " +
    "sandbox restriction: writes are confined to the workspace, temp and Rune's cache; credential " +
    "stores (~/.ssh, ~/.aws, keychains) are unreadable; the network is closed unless network: true.";
  return isUnsandboxedFallbackAllowed()
    ? `${base} If the command genuinely needs host access, re-run it once with unsandboxed: true — it then runs on the host under the regular permission prompt. If it only needs the network, use network: true instead.`
    : `${base} The sandbox is strict, so unsandboxed: true is not available. If the command genuinely needs host access, tell the user which access and why; they can add it to [sandbox] excludedCommands or change the override with /sandbox.`;
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
        // The payload the binary reads. For bash it is the model's arguments
        // with the policy folded in: `unsandboxed` never reaches Rust (it is a
        // launch decision, made here), and the path lists are ALWAYS taken
        // from the trusted policy — whatever the model put in that field is
        // dropped, so a call cannot widen its own sandbox.
        let payload: Record<string, unknown> = input.args;
        // Network is a separate capability, never permission to drop filesystem
        // isolation. The Rust executor reads network from this call's payload.
        if (schema.permissionLevel === "sandbox") {
          const launch = resolveSandboxLaunch(input.args);
          if (launch.refusal) {
            return {
              callId: input.callId,
              toolName: input.toolName,
              success: false,
              result: "",
              error: launch.refusal,
              durationMs: Math.round(performance.now() - start),
            };
          }
          const { unsandboxed: _dropped, sandbox_paths: _model, ...rest } = input.args;
          payload = rest;
          if (launch.sandboxed) {
            // requireOs: the user declared containment mandatory. When this
            // machine has no isolation backend, refusing beats the factory's
            // silent path-guard-only degradation. An excluded or fallback
            // command is the user's own decision to run on the host, so it
            // is not refused here.
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
            payload = { ...payload, sandbox_paths: sandboxPathsFor(input.workspaceRoot) };
          }
        }
        args.push(subcommand);
        const proc = Bun.spawn([binaryPath, ...args], {
          stdin: new Blob([JSON.stringify(payload)]),
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
        // A sandboxed bash that died on a permission error gets the hint that
        // names the wall it hit and the sanctioned way around it.
        if (
          schema.permissionLevel === "sandbox" &&
          parsed.result &&
          typeof parsed.result === "object" &&
          parsed.result.sandboxed === true
        ) {
          const hint = sandboxDenialHint(
            String(parsed.result.stderr ?? ""),
            parsed.result.exit_code as number | null | undefined,
          );
          if (hint) parsed.result.sandbox_hint = hint;
        }
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
