import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { pathToFileURL } from "url";
import ts from "typescript";
import {
  GLYPH_DEFINITIONS,
  PULSE_GLYPHS,
  detectGlyphMode,
  foldTerminalData,
} from "../../../packages/orchestrator/src/bin/ui/glyphs";
import { visLen } from "../../../packages/orchestrator/src/bin/ui/render";
import { PRODUCT_LABEL } from "../../../packages/orchestrator/src/bin/ui/brand";

const ROOT = join(import.meta.dir, "../../..");
const UI = join(ROOT, "packages/orchestrator/src/bin/ui");

describe("Flow closed glyph budget", () => {
  test("every product glyph and ASCII twin occupies exactly one terminal cell", () => {
    const definitions = [...Object.values(GLYPH_DEFINITIONS), ...PULSE_GLYPHS];
    for (const definition of definitions) {
      expect(visLen(definition.utf8), `${definition.utf8} utf8`).toBe(1);
      expect(visLen(definition.ascii), `${definition.utf8} ascii twin`).toBe(1);
      expect(definition.ascii).toMatch(/^[\x20-\x7e]$/);
    }
  });

  test("the ornamental UTF-8 vocabulary stays within twenty distinct cells", () => {
    const definitions = [...Object.values(GLYPH_DEFINITIONS), ...PULSE_GLYPHS];
    const ornamental = new Set(
      definitions
        .map((definition) => definition.utf8)
        .filter((glyph) => /[^\x00-\x7f]/.test(glyph)),
    );
    expect(ornamental.size).toBeGreaterThan(0);
    expect(ornamental.size).toBeLessThanOrEqual(20);
  });

  test("renderer literals cannot bypass the closed set", () => {
    const offenders: string[] = [];
    for (const file of readdirSync(UI).filter(
      (name) => name.endsWith(".ts") && name !== "glyphs.ts",
    )) {
      const path = join(UI, file);
      const source = readFileSync(path, "utf8");
      const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node): void => {
        if (
          (ts.isStringLiteralLike(node) ||
            ts.isNoSubstitutionTemplateLiteral(node) ||
            ts.isTemplateExpression(node) ||
            ts.isRegularExpressionLiteral(node)) &&
          /[^\x00-\x7f]/.test(node.getText(tree))
        ) {
          const line = tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
          offenders.push(`${file}:${line}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(tree);
    }
    expect(offenders).toEqual([]);
  });
});

describe("ASCII rung", () => {
  test("is selected once from locale or an explicit compatibility override", () => {
    expect(detectGlyphMode({ LANG: "C" })).toBe("ascii");
    expect(detectGlyphMode({ LC_ALL: "en_US.UTF-8" })).toBe("utf8");
    expect(detectGlyphMode({ LANG: "ja_JP.UTF-8" })).toBe("ambig");
    expect(detectGlyphMode({ RUNE_ASCII: "1", LANG: "en_US.UTF-8" })).toBe("ascii");
  });

  test("folds punctuation, diacritics, and unrepresentable data visibly", () => {
    expect(foldTerminalData("Jos\u00e9 \u2014 \u201c東京\u201d \u2192 3\u2026", "ascii")).toBe(
      'Jose -- "??" -> 3...',
    );
    expect(foldTerminalData("na\u00efve\u00a0file \u2264 4", "ascii")).toBe("naive file <= 4");
    expect(foldTerminalData("Jos\u00e9", "utf8")).toBe("Jos\u00e9");
  });

  test("a representative Flow transcript is seven-bit and escape-free", () => {
    const flowUrl = pathToFileURL(join(UI, "flow.ts")).href;
    const themeUrl = pathToFileURL(join(UI, "theme.ts")).href;
    const script = `
      import { header, said, toolRow } from ${JSON.stringify(flowUrl)};
      import { withThemeBg } from ${JSON.stringify(themeUrl)};
      const out = [
        // The header carries arbitrary data in two fields now — the directory
        // coordinate and the worktree clause — and both are transliterated. This
        // proves non-ASCII DATA is folded, not merely that glyphs have twins.
        header({ name: "Rune", version: "0.3.0", workspace: "Jos\u00e9", worktree: "leave 東京 alone" }),
        said("Checked \u201cJos\u00e9\u201d \u2014 no change to 東京."),
        toolRow({ name: "test", arg: "suite", status: "pass", metric: "3 passed" }),
      ].join("\\n");
      process.stdout.write(withThemeBg(out));
    `;
    const run = Bun.spawnSync([process.execPath, "-e", script], {
      cwd: ROOT,
      env: {
        ...process.env,
        RUNE_ASCII: "1",
        NO_COLOR: "1",
        LC_ALL: "C",
        TERM: "dumb",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = run.stdout.toString();
    expect(run.exitCode, run.stderr.toString()).toBe(0);
    expect(stdout).not.toContain("\x1b");
    expect(stdout).not.toMatch(/[^\x00-\x7f]/);
    expect(stdout).toContain("Jose");
    expect(stdout).toContain("worktree leave ?? alone");
    expect(stdout).toContain("3 passed");
  });

  test("the actual Rune CLI help is seven-bit and escape-free", () => {
    const cli = join(ROOT, "packages/orchestrator/src/bin/rune-cli.ts");
    const run = Bun.spawnSync([process.execPath, cli, "--help"], {
      cwd: ROOT,
      env: {
        ...process.env,
        RUNE_ASCII: "1",
        NO_COLOR: "1",
        LC_ALL: "C",
        TERM: "dumb",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = run.stdout.toString();
    expect(run.exitCode, run.stderr.toString()).toBe(0);
    expect(stdout).not.toContain("\x1b");
    expect(stdout).not.toMatch(/[^\x00-\x7f]/);
    // The label, not a literal version: pinning "v0.3.0" here would make this
    // test a fifth hand-maintained copy of the version, which is the drift
    // scripts/version.sh exists to end. What matters is that the banner
    // carries the product label the build was stamped with.
    expect(stdout).toContain(`${PRODUCT_LABEL} -- AI coding agent`);
    expect(stdout).toMatch(/Rune v\d+\.\d+\.\d+/);
    expect(stdout).toContain("Usage:");
    expect(stdout).toContain("Shift+Tab shifts up: 1st -> 2nd -> 3rd -> 4th -> auto");
  });
});
