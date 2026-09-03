// ─── The catalogue is closed, and every schema is a contract ───
//
// The composer's whole safety argument is that a projection can only name one of
// thirty types and can only supply props that type's schema accepts. These tests
// pin both halves:
//
//   • the catalogue has exactly thirty entries, they are the thirty the brief
//     names, and each has a file, a schema, a component and a bind mode;
//   • every schema accepts its gallery sample and REFUSES an unknown prop, which
//     is what keeps `dangerouslySetInnerHTML` from riding in on a props object;
//   • only one file in the directory renders markup, and it renders it in an
//     iframe with `sandbox="allow-scripts"` and no same-origin;
//   • docs/primitives.md is what the generator produces from the catalogue, so
//     the doc cannot drift from the code.

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  BLOCK_TYPES,
  PRIMITIVES,
  isBlockType,
  type BlockType,
} from "../../../apps/web/src/primitives/index";
import { SAMPLES } from "../../../apps/web/src/gallery/samples";
import { renderPrimitivesDoc } from "../../../scripts/generate-primitives-doc";

const SRC = join(import.meta.dir, "../../../apps/web/src/primitives");
const DOC = join(import.meta.dir, "../../../docs/primitives.md");
const CSS = join(import.meta.dir, "../../../apps/web/src/styles/primitives.css");

/**
 * A file with its comments removed.
 *
 * These tests scan source for things that must not be there —
 * `dangerouslySetInnerHTML`, `allow-same-origin`, a hex colour, a `box-shadow`.
 * Every one of those is also a phrase the files EXPLAIN at length, and a test
 * that cannot tell a prohibition from its own rationale is a test that punishes
 * documentation.
 */
function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** The brief's list, transcribed. Deliberately re-typed rather than imported. */
const BRIEF = [
  "text",
  "heading",
  "metric",
  "table",
  "chart",
  "timeline",
  "diff",
  "file",
  "tree",
  "terminal",
  "source",
  "evidence",
  "hypothesis",
  "decision",
  "checklist",
  "progress",
  "approval",
  "choice",
  "form",
  "comparison",
  "relationship",
  "artifact",
  "preview",
  "log",
  "transcript",
  "agent",
  "cost",
  "warning",
  "link",
  "divider",
];

describe("the catalogue", () => {
  test("is exactly the thirty the brief names, in order", () => {
    expect([...BLOCK_TYPES]).toEqual(BRIEF);
    expect(Object.keys(PRIMITIVES).sort()).toEqual([...BRIEF].sort());
  });

  test("every entry is complete", () => {
    for (const type of BLOCK_TYPES) {
      const e = PRIMITIVES[type];
      expect(e.type, `${type}.type`).toBe(type);
      expect(typeof e.Component, `${type}.Component`).toBe("function");
      expect(e.title.length, `${type}.title`).toBeGreaterThan(0);
      expect(e.summary.length, `${type}.summary`).toBeGreaterThan(10);
      expect(["assign", "merge", "repeat", "none"]).toContain(e.bind.mode);
      if (e.bind.mode === "assign") expect(e.bind.key, `${type}.bind.key`).toBeTruthy();
    }
  });

  test("isBlockType is the gate, and it refuses everything else", () => {
    for (const type of BLOCK_TYPES) expect(isBlockType(type)).toBe(true);
    for (const impostor of [
      "script",
      "html",
      "iframe",
      "Text",
      "__proto__",
      "constructor",
      "toString",
      "",
      null,
      undefined,
      42,
      {},
    ]) {
      expect(isBlockType(impostor), `${String(impostor)} is not a block type`).toBe(false);
    }
  });

  test("one source file per primitive, and no orphans", () => {
    // The three files in the directory that are not a primitive: the shared
    // kit, the catalogue, and the schema reader the doc generator and the
    // gallery both use.
    const support = ["kit.tsx", "index.ts", "describe.ts"];
    const files = readdirSync(SRC).filter((f) => /\.tsx?$/.test(f));
    for (const f of support) expect(files).toContain(f);
    expect(files.length).toBe(BLOCK_TYPES.length + support.length);
  });
});

describe("every schema accepts its sample and refuses an unknown prop", () => {
  for (const type of BLOCK_TYPES) {
    test(type, () => {
      const entry = PRIMITIVES[type];
      const sample = SAMPLES[type];

      const ready = entry.schema.safeParse(sample.ready);
      expect(ready.success, `${type} ready: ${JSON.stringify(ready.error?.issues)}`).toBe(true);

      const empty = entry.schema.safeParse(sample.empty);
      expect(empty.success, `${type} empty: ${JSON.stringify(empty.error?.issues)}`).toBe(true);

      for (const variant of sample.extra ?? []) {
        const v = entry.schema.safeParse(variant.props);
        expect(v.success, `${type} ${variant.label}: ${JSON.stringify(v.error?.issues)}`).toBe(
          true,
        );
      }

      // The three load states are on every primitive.
      for (const state of ["ready", "loading", "error"] as const) {
        expect(entry.schema.safeParse({ ...sample.ready, state, error: "x" }).success).toBe(true);
      }

      // Strictness. This is the rule that stops a props object smuggling
      // anything React would act on.
      for (const smuggled of [
        { dangerouslySetInnerHTML: { __html: "<img onerror=alert(1)>" } },
        { onClick: "alert(1)" },
        { style: { position: "fixed" } },
        { srcDoc: "<script>" },
      ]) {
        const bad = entry.schema.safeParse({ ...sample.ready, ...smuggled });
        expect(bad.success, `${type} accepted ${Object.keys(smuggled)[0]}`).toBe(false);
      }

      // Not an object at all.
      for (const junk of [null, "string", 7, []]) {
        expect(entry.schema.safeParse(junk).success, `${type} accepted ${String(junk)}`).toBe(
          false,
        );
      }
    });
  }
});

describe("the schemas that carry a rule of their own", () => {
  test("link refuses a javascript: href", () => {
    const link = PRIMITIVES.link.schema;
    expect(link.safeParse({ text: "x", href: "https://example.com" }).success).toBe(true);
    expect(link.safeParse({ text: "x", href: "/local" }).success).toBe(true);
    for (const href of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "data:text/html,<script>",
      "vbscript:x",
      "file:///etc/passwd",
    ]) {
      expect(link.safeParse({ text: "x", href }).success, `accepted ${href}`).toBe(false);
    }
  });

  test("preview refuses a src that is not https, root-relative or a data image", () => {
    const preview = PRIMITIVES.preview.schema;
    expect(preview.safeParse({ form: "image", src: "https://x/y.png" }).success).toBe(true);
    expect(
      preview.safeParse({ form: "image", src: "data:image/png;base64,iVBORw0KGgo=" }).success,
    ).toBe(true);
    for (const src of [
      "javascript:alert(1)",
      "http://x/y.png",
      "data:text/html;base64,PHNjcmlwdD4=",
    ]) {
      expect(preview.safeParse({ form: "image", src }).success, `accepted ${src}`).toBe(false);
    }
  });

  test("a refuted hypothesis must carry the reason it was refuted", () => {
    const h = PRIMITIVES.hypothesis.schema;
    expect(h.safeParse({ text: "t", status: "refuted" }).success).toBe(false);
    expect(h.safeParse({ text: "t", status: "refuted", reason: "" }).success).toBe(false);
    expect(h.safeParse({ text: "t", status: "refuted", reason: "TTL unchanged" }).success).toBe(
      true,
    );
    // Every other status may stand alone.
    for (const status of ["proposed", "testing", "confirmed"]) {
      expect(h.safeParse({ text: "t", status }).success, status).toBe(true);
    }
  });

  test("progress takes counts, and there is no prop that takes a percentage", () => {
    const p = PRIMITIVES.progress.schema;
    expect(p.safeParse({ done: 5, total: 8 }).success).toBe(true);
    expect(p.safeParse({ done: -1, total: 8 }).success).toBe(false);
    expect(p.safeParse({ done: 1.5, total: 8 }).success).toBe(false);
    expect(p.safeParse({ percent: 61 }).success).toBe(false);
    expect(p.safeParse({ done: 5, total: 8, percent: 61 }).success).toBe(false);
  });

  test("cost distinguishes null from zero", () => {
    const c = PRIMITIVES.cost.schema;
    expect(c.safeParse({ usd: null }).success).toBe(true);
    expect(c.safeParse({ usd: 0.14, inputTokens: null }).success).toBe(true);
    expect(c.safeParse({ usd: -1 }).success).toBe(false);
    expect(c.safeParse({}).success).toBe(false);
  });

  test("chart takes two forms and no more", () => {
    const c = PRIMITIVES.chart.schema;
    expect(c.safeParse({ form: "line", points: [] }).success).toBe(true);
    expect(c.safeParse({ form: "bar", points: [{ x: "a", y: 1 }] }).success).toBe(true);
    for (const form of ["pie", "donut", "area", "scatter", "sankey"]) {
      expect(c.safeParse({ form, points: [] }).success, `accepted ${form}`).toBe(false);
    }
  });

  test("the foldable primitives accept `folded`, and the others do not", () => {
    for (const type of BLOCK_TYPES) {
      const entry = PRIMITIVES[type];
      const withFold = entry.schema.safeParse({ ...SAMPLES[type].ready, folded: true });
      expect(withFold.success, `${type} folded`).toBe(entry.foldable === true);
    }
  });
});

describe("no primitive renders markup except Preview", () => {
  const files = readdirSync(SRC).filter((f) => f.endsWith(".tsx"));

  test("dangerouslySetInnerHTML appears nowhere in the directory", () => {
    const offenders = files.filter((f) => code(join(SRC, f)).includes("dangerouslySetInnerHTML"));
    expect(offenders).toEqual([]);
  });

  test("only Preview.tsx uses an iframe, and it is sandboxed without same-origin", () => {
    const withIframe = files.filter((f) => /<iframe/.test(code(join(SRC, f))));
    expect(withIframe).toEqual(["Preview.tsx"]);

    const preview = code(join(SRC, "Preview.tsx"));
    expect(preview).toContain('sandbox="allow-scripts"');
    expect(preview).not.toContain("allow-same-origin");
    expect(preview).not.toContain("allow-top-navigation");
    expect(preview).not.toContain("allow-forms");
    expect(preview).toContain('referrerPolicy="no-referrer"');
    expect(preview).toContain("Content-Security-Policy");
  });

  test("every external anchor carries rel=noopener noreferrer", () => {
    for (const f of files) {
      const src = code(join(SRC, f));
      const targets = src.match(/target="_blank"/g)?.length ?? 0;
      const rels = src.match(/rel="noopener noreferrer"/g)?.length ?? 0;
      expect(rels, `${f}: ${targets} target=_blank, ${rels} rel=noopener`).toBe(targets);
    }
  });
});

describe("the primitives introduce no pigment and no radius of their own", () => {
  // The brand checklist pins the BUILT stylesheet; this pins the SOURCE, which
  // is where a hex arrives, and it names the file so the fix is one edit rather
  // than a bisect through a 72 KB bundle.
  const files = readdirSync(SRC).filter((f) => /\.tsx?$/.test(f));

  test("no hex colour in any component file", () => {
    const offenders: string[] = [];
    for (const f of files) {
      for (const m of code(join(SRC, f)).matchAll(/#[0-9a-fA-F]{6}\b/g)) {
        offenders.push(`${f}: ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the stylesheet's radii all come from the token set", () => {
    const allowed = new Set(["var(--r-chip)", "var(--r)", "var(--r-composer)", "50%", "0"]);
    const offenders: string[] = [];
    for (const m of code(CSS).matchAll(/border-radius:\s*([^;}]+)/g)) {
      for (const part of m[1]!.trim().split(/\s+/)) {
        if (!allowed.has(part)) offenders.push(m[1]!.trim());
      }
    }
    expect([...new Set(offenders)]).toEqual([]);
  });

  test("no box-shadow anywhere in the primitives' stylesheet", () => {
    expect(code(CSS)).not.toContain("box-shadow");
  });

  test("and every colour in it is a token", () => {
    const offenders = [...code(CSS).matchAll(/#[0-9a-fA-F]{3,8}\b|\brgba?\(/g)].map((m) => m[0]);
    expect(offenders).toEqual([]);
  });
});

describe("docs/primitives.md is generated, not maintained", () => {
  test("the committed doc is what the catalogue produces", async () => {
    const committed = readFileSync(DOC, "utf8");
    expect(
      committed,
      "docs/primitives.md is stale — run `bun run scripts/generate-primitives-doc.ts docs/primitives.md`",
    ).toBe(await renderPrimitivesDoc());
  });

  test("and it documents every primitive", () => {
    const doc = readFileSync(DOC, "utf8");
    for (const type of BLOCK_TYPES as readonly BlockType[]) {
      expect(doc, `${type} is missing from the doc`).toContain(`### \`${type}\``);
    }
  });
});
