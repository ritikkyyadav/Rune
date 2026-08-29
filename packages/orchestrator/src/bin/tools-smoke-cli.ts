// ─── `gear tools-smoke` — end-to-end native-tools diagnostic ───
// Boots the real ToolRegistry against the resolved gear-tools binary and runs
// a write → read → edit → bash round-trip in a throwaway workspace. This is
// what CI runs against the PACKAGED binary: `--version` proves the bundle
// starts; this proves the artifact pair users download can actually touch
// files and run commands through the native executor. Exit 0 = every step
// passed. No engine, no provider, no network.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry, registerBuiltinTools } from "@gear/tool-registry";
import { danger, dim, faint, ok } from "./ui/theme";
import { glyph } from "./ui/glyphs";

export async function runToolsSmoke(toolsBinary: string): Promise<number> {
  const workspace = mkdtempSync(join(tmpdir(), "gear-tools-smoke-"));
  const registry = new ToolRegistry();
  registerBuiltinTools(registry, toolsBinary);

  let step = "startup";
  const call = async (toolName: string, args: Record<string, unknown>) => {
    step = toolName;
    const output = await registry.execute({
      toolName,
      callId: `smoke-${toolName}`,
      args,
      sessionId: "tools-smoke",
      workspaceRoot: workspace,
    });
    if (!output.success) {
      throw new Error(`${toolName} failed: ${output.error ?? output.result}`);
    }
    return output;
  };

  try {
    await call("write_file", { path: "smoke.txt", content: "gear tools smoke\n" });
    const read = await call("read_file", { path: "smoke.txt" });
    if (!String(read.result).includes("gear tools smoke")) {
      throw new Error("read_file returned unexpected content");
    }
    await call("edit_file", { path: "smoke.txt", old_text: "smoke", new_text: "SMOKE" });
    const bash = await call("bash", { command: "printf smoke-ok" });
    // bash results are a JSON envelope; transport success ≠ command success.
    const shell = JSON.parse(String(bash.result)) as {
      exit_code?: number;
      stdout?: string;
      stderr?: string;
    };
    if (shell.exit_code !== 0 || !String(shell.stdout ?? "").includes("smoke-ok")) {
      throw new Error(
        `bash exited ${shell.exit_code}: ${String(shell.stderr ?? shell.stdout ?? "").slice(0, 200)}`,
      );
    }
    console.log(
      `  ${ok("✓")} native tools round-trip: write · read · edit · bash ${faint(`(${toolsBinary})`)}`,
    );
    return 0;
  } catch (error) {
    console.error(
      `  ${danger(glyph("failure"))} tools-smoke failed at ${step}: ${error instanceof Error ? error.message : String(error)}`,
    );
    console.error(`  ${dim(`binary: ${toolsBinary} · workspace: ${workspace}`)}`);
    return 1;
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}
