/**
 * Format on write, and the density tripwire behind it.
 *
 * The defect: Gear writes hand-minified code. Measured on EvoLab-3's frontend,
 * 8% of lines ran over 200 characters and the longest was 1,307 — whole React
 * components collapsed onto one line, several statements per line, 0.6% comment
 * density. The same product built by another harness: 0.3% long lines, 417 max,
 * 3.7% comments. It typechecks, the tests pass, and nothing in the harness ever
 * objected, because no gate measures readability.
 *
 * Two halves are pinned here. Formatting runs only where the PROJECT asked for
 * it — a repo with no prettier config keeps exactly what the agent wrote, since
 * imposing a house style uninvited would be its own defect. The tripwire runs
 * everywhere, because the case that produced this was a greenfield app whose
 * formatter was not installed yet.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  withFormatting,
  isUnreadablyDense,
  measureDensity,
  resetFormatterCache,
} from "../../../packages/tool-registry/src/tools/format-on-write";
import type { ToolHandler } from "../../../packages/tool-registry/src/types";

/**
 * The shape a real EvoLab-3 component was written in: several statements per
 * line, JSX collapsed, no breaks. `overview.tsx` in that tree measured 7 long
 * lines out of 37, with a longest of 1,166.
 */
const MINIFIED =
  `"use client";\nimport { useState } from "react";\n` +
  Array.from(
    { length: 4 },
    (_, i) =>
      `export function Panel${i}({ a }: { a: number }) { const [x, setX] = useState(0); ` +
      `const y = a + x; const label = y > 10 ? "big" : "small"; ` +
      `return <div className="panel"><span onClick={() => setX(x + 1)}>{y}</span>` +
      `<button type="button" onClick={() => setX(0)} aria-label="reset the counter to zero">` +
      `reset</button><em>{label}</em></div>; }`,
  ).join("\n") +
  "\n" +
  Array.from({ length: 8 }, (_, i) => `const spacer${i} = ${i};`).join("\n");

/** A write tool that really writes, and reports path + hash like the real one. */
function writeHandler(): ToolHandler {
  return {
    schema: {
      name: "write_file",
      version: "0.1.0",
      description: "",
      inputSchema: { type: "object", properties: {} },
      category: "write",
      permissionLevel: "auto",
    },
    validate: () => ({ valid: true }),
    execute: async (input) => {
      const abs = join(input.workspaceRoot, String(input.args.path));
      const content = String(input.args.content ?? "");
      mkdirSync(join(abs, ".."), { recursive: true });
      writeFileSync(abs, content);
      return {
        callId: input.callId,
        toolName: "write_file",
        success: true,
        result: JSON.stringify({
          path: abs,
          hash: createHash("sha256").update(content).digest("hex"),
        }),
        durationMs: 1,
      };
    },
  };
}

const run = (root: string, path: string, content: string) =>
  withFormatting(writeHandler()).execute({
    toolName: "write_file",
    callId: "c1",
    args: { path, content },
    sessionId: "s1",
    workspaceRoot: root,
  } as any);

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gear-fmt-"));
  resetFormatterCache();
});

describe("the density tripwire", () => {
  test("measures the worst line, not the average alone", () => {
    const d = measureDensity("a\n\n" + "x".repeat(500) + "\nbb\n");
    expect(d.maxLine).toBe(500);
    expect(d.lines).toBe(3);
  });

  test("a minified component is called out, with its real numbers", async () => {
    const out = await run(root, "panel.tsx", MINIFIED);
    const result = JSON.parse(out.result);

    expect(result.readability).toBeDefined();
    expect(result.readability).toContain("not readable as written");
    expect(result.readability).toContain("panel.tsx");
    // The note carries the measurement, so the agent is not arguing with taste.
    expect(result.readability).toMatch(/\d+ of \d+ lines run over 200 characters/);
    expect(result.readability).toMatch(/the longest is \d{3,}/);
    // And it names the rule the doctrine already states.
    expect(result.readability).toContain("brevity applies to your prose");
  });

  test("ordinary code is left alone entirely", async () => {
    const clean = Array.from({ length: 20 }, (_, i) => `const value${i} = ${i};`).join("\n");
    const out = await run(root, "clean.ts", clean);
    const result = JSON.parse(out.result);

    expect(result.readability).toBeUndefined();
    expect(result.formatted).toBeUndefined();
  });

  test("prose and data are not judged as code", () => {
    const longProse = "# Title\n\n" + "word ".repeat(200) + "\n";
    expect(isUnreadablyDense("notes.md", longProse)).toBeNull();
    expect(isUnreadablyDense("data.json", `{"a":"${"x".repeat(900)}"}`)).toBeNull();
    // The same shape in a source file is a finding.
    expect(isUnreadablyDense("a.ts", MINIFIED)).not.toBeNull();
  });

  test("a short file is never judged — three dense lines is not a pattern", () => {
    expect(isUnreadablyDense("a.ts", `const x = ${JSON.stringify("y".repeat(600))};`)).toBeNull();
  });
});

describe("formatting runs only where the project asked for it", () => {
  test("no prettier config: the file is left exactly as written", async () => {
    // Binary present, config absent — the binary alone is not consent.
    mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
    writeFileSync(join(root, "node_modules", ".bin", "prettier"), "#!/bin/sh\nexit 0\n", {
      mode: 0o755,
    });

    const out = await run(root, "a.ts", MINIFIED);
    expect(JSON.parse(out.result).formatted).toBeUndefined();
    expect(readFileSync(join(root, "a.ts"), "utf8")).toBe(MINIFIED);
  });

  test("no formatter at all: the write still succeeds and reports the density", async () => {
    const out = await run(root, "a.tsx", MINIFIED);
    expect(out.success).toBe(true);
    expect(JSON.parse(out.result).readability).toBeDefined();
  });
});

// The real prettier from this repo's own node_modules — the exact path a
// project's formatter takes.
const REPO_PRETTIER = join(process.cwd(), "node_modules", ".bin", "prettier");

describe.skipIf(!existsSync(REPO_PRETTIER))("with a real configured prettier", () => {
  beforeEach(() => {
    mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
    // Symlinking the repo's prettier is how a project's own install looks.
    Bun.spawnSync(["ln", "-sf", REPO_PRETTIER, join(root, "node_modules", ".bin", "prettier")]);
    writeFileSync(join(root, ".prettierrc"), JSON.stringify({ printWidth: 100 }));
  });

  test("a minified component comes back readable", async () => {
    const out = await run(root, "panel.tsx", MINIFIED);
    const onDisk = readFileSync(join(root, "panel.tsx"), "utf8");

    expect(JSON.parse(out.result).formatted).toContain("Reformatted");
    expect(measureDensity(onDisk).maxLine).toBeLessThan(measureDensity(MINIFIED).maxLine);
    expect(measureDensity(onDisk).maxLine).toBeLessThanOrEqual(101);
  });

  test("the reported hash matches the file on disk AFTER formatting", async () => {
    // The subtle one. Reformatting behind the freshness tracker's back would
    // leave it holding the pre-format hash, and the very next edit_file would
    // be rejected as stale — a fix that breaks editing is not a fix.
    const out = await run(root, "panel.tsx", MINIFIED);
    const onDisk = readFileSync(join(root, "panel.tsx"), "utf8");

    expect(JSON.parse(out.result).hash).toBe(createHash("sha256").update(onDisk).digest("hex"));
  });

  test("a file prettier cannot parse is written, unchanged, and never lost", async () => {
    const broken = "export function oops( {\n  const x =\n";
    const out = await run(root, "broken.ts", broken);

    expect(out.success).toBe(true);
    expect(readFileSync(join(root, "broken.ts"), "utf8")).toBe(broken);
    expect(JSON.parse(out.result).formatted).toBeUndefined();
  });
});
