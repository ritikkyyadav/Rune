import { describe, test, expect, beforeEach, spyOn } from "bun:test";
import { PermissionBroker } from "../../../packages/orchestrator/src/permissions";

describe("PermissionBroker", () => {
  let broker: PermissionBroker;

  beforeEach(() => {
    broker = new PermissionBroker(false);
  });

  test("auto-permits read-only tools", () => {
    const schema = { name: "read_file", permissionLevel: "auto" as const, description: "", parameters: [] };
    const result = broker.check(schema, {});
    expect(result.type).toBe("allowed");
  });

  test("requires confirmation for dangerous tools", () => {
    const schema = { name: "bash", permissionLevel: "confirm" as const, description: "", parameters: [] };
    const result = broker.check(schema, { command: "rm -rf /" });
    expect(result.type).toBe("needs_confirmation");
  });

  test("yolo mode bypasses all checks", () => {
    const yoloBroker = new PermissionBroker(true);
    const schema = { name: "bash", permissionLevel: "confirm" as const, description: "", parameters: [] };
    const result = yoloBroker.check(schema, { command: "rm -rf /" });
    expect(result.type).toBe("allowed");
  });

  test("yolo mode logs a warning", () => {
    const warnSpy = spyOn(console, "warn");
    const yoloBroker = new PermissionBroker(true);
    const schema = { name: "bash", permissionLevel: "confirm" as const, description: "", parameters: [] };
    yoloBroker.check(schema, {});
    expect(warnSpy).toHaveBeenCalled();
    const msg = warnSpy.mock.calls[0]?.[0] as string;
    expect(msg).toContain("Yolo mode");
    warnSpy.mockRestore();
  });

  test("session grant allows subsequent calls", () => {
    const schema = { name: "bash", permissionLevel: "confirm" as const, description: "", parameters: [] };
    // First call should need confirmation
    const first = broker.check(schema, {});
    expect(first.type).toBe("needs_confirmation");

    // Grant for session
    broker.grantTool("bash", "session");

    // Second call should be allowed
    const second = broker.check(schema, {});
    expect(second.type).toBe("allowed");
  });

  test("setYoloMode toggles runtime", () => {
    const schema = { name: "bash", permissionLevel: "confirm" as const, description: "", parameters: [] };

    expect(broker.check(schema, {}).type).toBe("needs_confirmation");
    broker.setYoloMode(true);
    expect(broker.check(schema, {}).type).toBe("allowed");
    broker.setYoloMode(false);
    expect(broker.check(schema, {}).type).toBe("needs_confirmation");
  });
});
