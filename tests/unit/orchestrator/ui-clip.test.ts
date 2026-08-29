import { describe, expect, it } from "bun:test";
import { clip } from "../../../packages/orchestrator/src/bin/ui/flow";

/**
 * The output rail exists so a check's result can be read rather than taken on
 * trust. That only works if the budget is spent on the lines that carry the
 * result — which, for the one runner this matters most for, is not where the
 * old head-and-tail rule was spending it.
 *
 * The fixture is the real shape: pytest prints its warnings block, then a link
 * to its own docs, and only then the failures. A positional head lands entirely
 * inside the preamble.
 */
function pytestOutput(): string[] {
  return [
    "cd backend && ../.venv/bin/python -m pytest",
    "............                                                       [100%]",
    "=============================== warnings summary ===============================",
    "../.venv/lib/python3.14/site-packages/fastapi/testclient.py:1",
    "  /Users/x/.venv/lib/python3.14/site-packages/fastapi/testclient.py:1: StarletteDeprecationWarning: Using `httpx` with `starlette`",
    "    from starlette.testclient import TestClient as TestClient  # noqa",
    ...Array.from({ length: 20 }, (_, i) => `  warnings.warn(deprecated call ${i})`),
    "-- Docs: https://docs.pytest.org/en/stable/how-to/capture-warnings.html",
    "12 passed, 1 warning in 0.49s",
    "cd frontend && npm run typecheck && npm test -- --run",
    " src/api.test.ts (16 tests) 6ms",
    " src/App.test.tsx (12 tests | 2 failed) 2395ms",
    "FAILED src/App.test.tsx > raw editor validates malformed JSON",
    "AssertionError: expected 'disabled' to be 'enabled'",
    "  at src/App.test.tsx:42:11",
    "2 failed, 26 passed",
  ];
}

describe("clip — spends the budget on the news", () => {
  it("keeps the failures and drops the runner's self-talk", () => {
    const out = clip(pytestOutput()).join("\n");
    expect(out).toContain("FAILED src/App.test.tsx > raw editor validates malformed JSON");
    expect(out).toContain("AssertionError: expected 'disabled' to be 'enabled'");
    expect(out).toContain("src/App.test.tsx:42:11");
    expect(out).toContain("2 failed, 26 passed");
    // The preamble the old positional head was spending itself on.
    expect(out).not.toContain("StarletteDeprecationWarning");
    expect(out).not.toContain("docs.pytest.org");
    expect(out).not.toContain("warnings.warn");
  });

  it("never reorders — what is kept stays in the order it was written", () => {
    const kept = clip(pytestOutput()).filter((line) => !line.includes("lines"));
    const source = pytestOutput();
    const positions = kept.map((line) => source.indexOf(line)).filter((i) => i >= 0);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it("says exactly how much was dropped", () => {
    const out = clip(pytestOutput());
    const elisions = out.filter((line) => /\d+ lines?$/.test(line));
    expect(elisions.length).toBeGreaterThan(0);
    const source = pytestOutput();
    const dropped = elisions.reduce((sum, line) => sum + Number(/(\d+) lines?$/.exec(line)![1]), 0);
    expect(dropped + (out.length - elisions.length)).toBe(source.length);
  });

  it("leaves a short output entirely alone", () => {
    const short = ["one", "two", "three"];
    expect(clip(short)).toEqual(short);
  });

  it("falls back to head-and-tail for undifferentiated output", () => {
    // A build log: no runner noise, no verdict lines. Nothing to prefer, so the
    // positional rule is still the right shape.
    const build = Array.from({ length: 80 }, (_, i) => `compiling module_${i}`);
    const out = clip(build);
    expect(out[0]).toBe("compiling module_0");
    expect(out.at(-1)).toBe("compiling module_79");
    expect(out.length).toBeLessThan(build.length);
  });

  it("keeps the closing lines even when nothing in them matches", () => {
    const noisy = [...Array.from({ length: 60 }, () => "  warnings.warn(x)"), "Done in 4.2s"];
    expect(clip(noisy).at(-1)).toBe("Done in 4.2s");
  });
});

describe("clip — noise is stripped at any length", () => {
  it("strips a warnings block from output too short to trip the length rule", () => {
    // The real `make verify` case: 22 lines, so the old length test never
    // engaged, and the rail printed the deprecation block verbatim.
    const short = [
      "cd backend && pytest",
      "=============================== warnings summary ===============================",
      "  /x/site-packages/fastapi/testclient.py:1: StarletteDeprecationWarning: using httpx",
      "    from starlette.testclient import TestClient as TestClient  # noqa",
      "  warnings.warn(a)",
      "  warnings.warn(b)",
      "-- Docs: https://docs.pytest.org/en/stable/how-to/capture-warnings.html",
      "FAILED src/App.test.tsx > raw editor validates malformed JSON",
      "2 failed, 26 passed",
    ];
    const out = clip(short).join("\n");
    expect(out).toContain("FAILED src/App.test.tsx");
    expect(out).toContain("2 failed, 26 passed");
    expect(out).not.toContain("StarletteDeprecationWarning");
    expect(out).not.toContain("docs.pytest.org");
  });

  it("leaves a short, clean output completely untouched", () => {
    const clean = ["$ cargo check", "   Compiling gear v0.3.0", "    Finished in 1.2s"];
    expect(clip(clean)).toEqual(clean);
  });

  it("tolerates a single stray warning rather than annotating it", () => {
    const one = ["running 3 tests", "  warnings.warn(x)", "3 passed"];
    expect(clip(one)).toEqual(one);
  });
});
