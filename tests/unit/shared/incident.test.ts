import { describe, expect, test } from "bun:test";
import {
  INCIDENT_CLASSES,
  fingerprintIncident,
  incidentFamily,
  normalizeForFingerprint,
} from "../../../packages/shared/src/incident";
import {
  parseToolArguments,
  setToolArgsSalvageListener,
  type ToolArgsSalvageInfo,
} from "../../../packages/shared/src/json";

describe("incident taxonomy", () => {
  test("every class is family.kind shaped", () => {
    for (const cls of INCIDENT_CLASSES) {
      expect(cls).toMatch(/^[a-z]+\.[a-z_]+$/);
    }
  });

  test("incidentFamily extracts the family", () => {
    expect(incidentFamily("provider.rate_limit")).toBe("provider");
    expect(incidentFamily("struggle.thrash_reads")).toBe("struggle");
  });
});

describe("fingerprinting", () => {
  test("same defect with different volatile details → same fingerprint", () => {
    const a = fingerprintIncident(
      "tool.exec_failure",
      "tool:bash",
      'Command failed with exit 1: cd /Users/alice/proj/x && npm test (took 4123ms, run 42)',
    );
    const b = fingerprintIncident(
      "tool.exec_failure",
      "tool:bash",
      'Command failed with exit 2: cd /home/bob/other/repo && npm test (took 99ms, run 7)',
    );
    expect(a).toBe(b);
  });

  test("different class or component → different fingerprint", () => {
    const base = fingerprintIncident("tool.exec_failure", "tool:bash", "boom");
    expect(fingerprintIncident("tool.timeout", "tool:bash", "boom")).not.toBe(base);
    expect(fingerprintIncident("tool.exec_failure", "tool:grep", "boom")).not.toBe(base);
  });

  test("normalization strips uuids, hex, digits, paths, quotes", () => {
    const n = normalizeForFingerprint(
      `Failed "secret payload" at /Users/x/deep/path/file.ts id 550e8400-e29b-41d4-a716-446655440000 hash deadbeefcafe1234 after 300ms`,
    );
    expect(n).not.toContain("secret payload");
    expect(n).not.toContain("550e8400");
    expect(n).not.toContain("deadbeef");
    expect(n).not.toContain("300");
    expect(n).not.toContain("/Users/");
    expect(n).toContain("<uuid>");
    expect(n).toContain("<path>");
  });

  test("fingerprint is stable and 16 hex chars", () => {
    const fp = fingerprintIncident("loop.max_turns", "agent-loop", "max turns reached");
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
    expect(fingerprintIncident("loop.max_turns", "agent-loop", "max turns reached")).toBe(fp);
  });
});

describe("salvage listener", () => {
  test("fires on fence salvage with stage and snippet, not on clean parse", () => {
    const seen: ToolArgsSalvageInfo[] = [];
    setToolArgsSalvageListener((i) => seen.push(i));
    try {
      parseToolArguments('{"path":"a.ts"}');
      expect(seen.length).toBe(0);
      parseToolArguments('```json\n{"path":"a.ts"}\n```');
      expect(seen.length).toBe(1);
      expect(seen[0].stage).toBe("fence");
      expect(seen[0].snippet).toContain("```json");
    } finally {
      setToolArgsSalvageListener(null);
    }
  });

  test("fires gave_up on unsalvageable junk; slice on buried object", () => {
    const seen: ToolArgsSalvageInfo[] = [];
    setToolArgsSalvageListener((i) => seen.push(i));
    try {
      expect(parseToolArguments("total junk, no braces")).toEqual({});
      expect(seen[0]?.stage).toBe("gave_up");
      expect(parseToolArguments('here you go: {"k":1} hope that helps')).toEqual({ k: 1 });
      expect(seen[1]?.stage).toBe("slice");
    } finally {
      setToolArgsSalvageListener(null);
    }
  });

  test("a throwing listener never breaks parsing", () => {
    setToolArgsSalvageListener(() => {
      throw new Error("observer bug");
    });
    try {
      expect(parseToolArguments("junk")).toEqual({});
    } finally {
      setToolArgsSalvageListener(null);
    }
  });
});
