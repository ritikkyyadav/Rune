import { describe, test, expect } from "bun:test";
import { CustomToolsLoader } from "../../../packages/tool-registry/src/tools/custom-loader";

describe("CustomToolsLoader", () => {
  test("validates tool with correct schema", () => {
    const loader = new CustomToolsLoader("/tmp/test-workspace");
    const result = loader.validate({
      schema: { name: "my_tool", description: "A test tool", inputSchema: {} },
      execute: async () => "ok",
    });
    expect(result.valid).toBe(true);
    expect(result.riskLevel).toBe("safe");
    expect(result.errors).toHaveLength(0);
  });

  test("rejects tool with empty name", () => {
    const loader = new CustomToolsLoader("/tmp/test-workspace");
    const result = loader.validate({
      schema: { name: "", description: "A test tool", inputSchema: {} },
      execute: async () => "ok",
    });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("rejects tool with invalid characters in name", () => {
    const loader = new CustomToolsLoader("/tmp/test-workspace");
    const result = loader.validate({
      schema: { name: "my tool!", description: "A test tool", inputSchema: {} },
      execute: async () => "ok",
    });
    expect(result.valid).toBe(false);
  });

  test("rejects tool without execute function", () => {
    const loader = new CustomToolsLoader("/tmp/test-workspace");
    const result = loader.validate({
      schema: { name: "my_tool", description: "A test tool", inputSchema: {} },
      execute: "not a function" as any,
    });
    expect(result.valid).toBe(false);
  });

  test("rejects tool without description", () => {
    const loader = new CustomToolsLoader("/tmp/test-workspace");
    const result = loader.validate({
      schema: { name: "my_tool", description: "", inputSchema: {} },
      execute: async () => "ok",
    });
    expect(result.valid).toBe(false);
  });

  test("flags tools using child_process as dangerous", () => {
    const loader = new CustomToolsLoader("/tmp/test-workspace");
    const result = loader.validate({
      schema: { name: "danger_tool", description: "Runs commands", inputSchema: {} },
      execute: async () => {
        const { exec } = require("child_process");
        return exec("ls");
      },
    } as any);
    expect(result.riskLevel).toBe("dangerous");
    expect(result.valid).toBe(false);
  });

  test("flags tools using process.env for review", () => {
    const loader = new CustomToolsLoader("/tmp/test-workspace");
    const fn = async () => {
      return process.env.SECRET;
    };
    const result = loader.validate({
      schema: { name: "env_tool", description: "Reads env", inputSchema: {} },
      execute: fn,
    } as any);
    expect(result.riskLevel).toBe("review");
  });
});
