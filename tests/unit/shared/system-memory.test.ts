import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "os";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import {
  loadSystemMemory,
  loadSystemMemoryMeta,
  saveSystemMemory,
  saveSystemMemoryMeta,
  clearSystemMemory,
  parseSchedule,
  describeSchedule,
  isReflectionDue,
  effectiveSchedule,
  estimateMemoryTokens,
  clampToBudget,
  getSystemMemoryPath,
  getSystemMemoryMetaPath,
} from "../../../packages/shared/src/system-memory";

let dir: string;
let prev: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "alan-sysmem-"));
  prev = process.env.ALAN_SYSTEM_MEMORY_PATH;
  process.env.ALAN_SYSTEM_MEMORY_PATH = join(dir, "system-memory.md");
});

afterEach(() => {
  if (prev === undefined) delete process.env.ALAN_SYSTEM_MEMORY_PATH;
  else process.env.ALAN_SYSTEM_MEMORY_PATH = prev;
  rmSync(dir, { recursive: true, force: true });
});

describe("shared/system-memory — paths", () => {
  it("honors ALAN_SYSTEM_MEMORY_PATH and co-locates the meta json", () => {
    expect(getSystemMemoryPath()).toBe(join(dir, "system-memory.md"));
    expect(getSystemMemoryMetaPath()).toBe(join(dir, "system-memory.json"));
  });
});

describe("shared/system-memory — load/save", () => {
  it("returns empty content + meta when nothing is saved (never throws)", () => {
    const m = loadSystemMemory();
    expect(m.content).toBe("");
    expect(m.meta).toEqual({});
  });

  it("round-trips content and merges meta patches without clobbering", () => {
    saveSystemMemory("# About me\n- likes terse answers", {
      updatedAt: "2026-06-21T00:00:00Z",
      tokens: 8,
    });
    const m = loadSystemMemory();
    expect(m.content).toContain("likes terse answers");
    expect(m.meta.updatedAt).toBe("2026-06-21T00:00:00Z");
    expect(m.meta.tokens).toBe(8);

    saveSystemMemoryMeta({ lastReflectedAt: "2026-06-21T01:00:00Z" });
    const meta = loadSystemMemoryMeta();
    expect(meta.updatedAt).toBe("2026-06-21T00:00:00Z"); // preserved
    expect(meta.lastReflectedAt).toBe("2026-06-21T01:00:00Z"); // merged
  });

  it("treats a malformed meta json as empty (never throws)", () => {
    writeFileSync(getSystemMemoryMetaPath(), "{ not json");
    expect(loadSystemMemoryMeta()).toEqual({});
  });

  it("clear() wipes content but keeps the chosen cadence", () => {
    saveSystemMemory("stuff", { tokens: 2 });
    saveSystemMemoryMeta({ schedule: "weekly" });
    clearSystemMemory();
    const m = loadSystemMemory();
    expect(m.content).toBe("");
    expect(m.meta.schedule).toBe("weekly");
    expect(m.meta.tokens).toBeUndefined();
  });
});

describe("shared/system-memory — schedule parsing", () => {
  it("parses the cadence vocabulary", () => {
    expect(parseSchedule("manual")).toEqual({ kind: "manual" });
    expect(parseSchedule("off")).toEqual({ kind: "manual" });
    expect(parseSchedule(undefined)).toEqual({ kind: "manual" });
    expect(parseSchedule("daily")).toEqual({ kind: "interval", days: 1 });
    expect(parseSchedule("weekly")).toEqual({ kind: "interval", days: 7 });
    expect(parseSchedule("3d")).toEqual({ kind: "interval", days: 3 });
    expect(parseSchedule("every 5 days")).toEqual({ kind: "interval", days: 5 });
    expect(parseSchedule("nonsense")).toEqual({ kind: "manual" });
  });

  it("labels cadences for display", () => {
    expect(describeSchedule("manual")).toBe("manual");
    expect(describeSchedule("daily")).toBe("daily");
    expect(describeSchedule("weekly")).toBe("weekly");
    expect(describeSchedule("3d")).toBe("every 3 days");
  });

  it("effectiveSchedule prefers the meta override over the config default", () => {
    expect(effectiveSchedule({}, "weekly")).toBe("weekly");
    expect(effectiveSchedule({ schedule: "daily" }, "weekly")).toBe("daily");
    expect(effectiveSchedule({}, undefined)).toBe("manual");
  });
});

describe("shared/system-memory — isReflectionDue", () => {
  const now = Date.parse("2026-06-21T12:00:00Z");

  it("manual cadence never fires", () => {
    expect(isReflectionDue({ lastReflectedAt: "2020-01-01T00:00:00Z" }, "manual", now)).toBe(false);
  });

  it("an interval fires when it has never reflected", () => {
    expect(isReflectionDue({}, "daily", now)).toBe(true);
  });

  it("an interval respects the elapsed window", () => {
    const dayAgo = new Date(now - 25 * 3600 * 1000).toISOString();
    const hourAgo = new Date(now - 1 * 3600 * 1000).toISOString();
    expect(isReflectionDue({ lastReflectedAt: dayAgo }, "daily", now)).toBe(true);
    expect(isReflectionDue({ lastReflectedAt: hourAgo }, "daily", now)).toBe(false);
    expect(isReflectionDue({ lastReflectedAt: dayAgo }, "weekly", now)).toBe(false);
  });
});

describe("shared/system-memory — size budget", () => {
  it("estimates tokens (~4 chars/token)", () => {
    expect(estimateMemoryTokens("")).toBe(0);
    expect(estimateMemoryTokens("abcd")).toBe(1);
  });

  it("clamps over-budget content and marks the cut", () => {
    const long = Array.from({ length: 500 }, (_, i) => `line ${i} with some words here`).join("\n");
    const clamped = clampToBudget(long, 50);
    expect(clamped.length).toBeLessThan(long.length);
    expect(clamped).toContain("memory trimmed to fit budget");
  });

  it("leaves within-budget content untouched", () => {
    const small = "# About me\n- terse";
    expect(clampToBudget(small, 1500)).toBe(small);
  });
});
