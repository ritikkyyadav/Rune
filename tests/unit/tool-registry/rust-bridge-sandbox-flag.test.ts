/**
 * The Rust bridge decides per-call whether bash runs inside the OS sandbox:
 * default → `--sandbox`; `network: true` retains that flag and enables network
 * inside the native filesystem boundary. A stub binary echoes its
 * argv back as the tool result.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRustToolHandler } from "../../../packages/tool-registry/src/tools/rust-bridge";
import type { ToolSchema } from "../../../packages/tool-registry/src/types";

const BASH_SCHEMA: ToolSchema = {
  name: "bash",
  version: "0.1.0",
  description: "",
  inputSchema: { type: "object", properties: {} },
  permissionLevel: "sandbox",
  category: "execute",
};

/**
 * POSIX-only, twice over: the stub is a `#!/bin/bash` script and Windows has no
 * shebang dispatch, so `Bun.spawn` cannot run it at all; and the `--sandbox`
 * flag under test selects an OS isolation backend (seatbelt, bwrap) that does
 * not exist on Windows. There is no Windows behaviour here to assert.
 */
const POSIX = process.platform !== "win32";

let dir = "";
let stub = "";

beforeAll(() => {
  if (!POSIX) return;
  dir = mkdtempSync(join(tmpdir(), "bridge-test-"));
  stub = join(dir, "stub-tools");
  // Echoes argv as the JSON result so the test can assert which flags the
  // bridge passed. Drains stdin to avoid EPIPE on the piped input.
  writeFileSync(
    stub,
    `#!/bin/bash
cat > /dev/null
printf '{"success":true,"result":{"argv":"%s"}}\\n' "$*"
`,
  );
  chmodSync(stub, 0o755);
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

async function argvFor(args: Record<string, unknown>): Promise<string> {
  const handler = createRustToolHandler(BASH_SCHEMA, "bash", stub);
  const out = await handler.execute({
    toolName: "bash",
    callId: "c1",
    args,
    sessionId: "s1",
    workspaceRoot: dir,
  });
  expect(out.success).toBe(true);
  return (JSON.parse(out.result) as { argv: string }).argv;
}

describe.skipIf(!POSIX)("rust-bridge sandbox flag routing", () => {
  test("plain bash runs sandboxed (--sandbox present)", async () => {
    const argv = await argvFor({ command: "bun test" });
    expect(argv).toContain("--sandbox");
    expect(argv).toContain("bash");
  });

  test("network: true retains filesystem isolation (--sandbox present)", async () => {
    const argv = await argvFor({ command: "npm install", network: true });
    expect(argv).toContain("--sandbox");
    expect(argv).toContain("bash");
  });

  test("network: false stays sandboxed", async () => {
    const argv = await argvFor({ command: "ls", network: false });
    expect(argv).toContain("--sandbox");
  });
});
