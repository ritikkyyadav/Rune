import { describe, test, expect, beforeEach, spyOn } from "bun:test";
import {
  PermissionBroker,
  nextPermissionMode,
  PERMISSION_MODE_ORDER,
  type PermissionMode,
} from "../../../packages/orchestrator/src/permissions";

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

describe("PermissionBroker — workspace trust", () => {
  const WS = "/tmp/alan-ws";
  const writeSchema = {
    name: "write_file",
    permissionLevel: "confirm" as const,
    description: "",
    parameters: [],
  };
  const bashSchema = {
    name: "bash",
    permissionLevel: "sandbox" as const,
    description: "",
    parameters: [],
  };
  const webSchema = {
    name: "web_fetch",
    permissionLevel: "confirm" as const,
    description: "",
    parameters: [],
  };

  test("auto-approves writes inside the workspace", () => {
    const broker = new PermissionBroker(false, { workspaceRoot: WS, trustWorkspace: true });
    expect(broker.check(writeSchema, { path: `${WS}/src/a.ts` }).type).toBe("allowed");
    // Relative paths resolve under the workspace root.
    expect(broker.check(writeSchema, { path: "src/a.ts" }).type).toBe("allowed");
  });

  test("still prompts for writes outside the workspace", () => {
    const broker = new PermissionBroker(false, { workspaceRoot: WS, trustWorkspace: true });
    expect(broker.check(writeSchema, { path: "/etc/hosts" }).type).toBe("needs_confirmation");
    // Path traversal that escapes the root is not confined.
    expect(broker.check(writeSchema, { path: `${WS}/../escape.ts` }).type).toBe(
      "needs_confirmation",
    );
  });

  test("auto-approves bash (contained by the Rust sandbox)", () => {
    const broker = new PermissionBroker(false, { workspaceRoot: WS, trustWorkspace: true });
    expect(broker.check(bashSchema, { command: "ls -la" }).type).toBe("allowed");
  });

  test("does not auto-approve network tools", () => {
    const broker = new PermissionBroker(false, { workspaceRoot: WS, trustWorkspace: true });
    expect(broker.check(webSchema, { url: "https://example.com" }).type).toBe("needs_confirmation");
  });

  test("is inert when disabled (the default)", () => {
    const broker = new PermissionBroker(false, { workspaceRoot: WS });
    expect(broker.check(writeSchema, { path: `${WS}/src/a.ts` }).type).toBe("needs_confirmation");
    expect(broker.check(bashSchema, { command: "ls" }).type).toBe("needs_confirmation");
  });

  test("is inert without a workspace root", () => {
    const broker = new PermissionBroker(false, { trustWorkspace: true });
    expect(broker.check(writeSchema, { path: `${WS}/src/a.ts` }).type).toBe("needs_confirmation");
  });

  test("setTrustWorkspace toggles at runtime", () => {
    const broker = new PermissionBroker(false, { workspaceRoot: WS });
    expect(broker.check(writeSchema, { path: `${WS}/a.ts` }).type).toBe("needs_confirmation");
    broker.setTrustWorkspace(true);
    expect(broker.check(writeSchema, { path: `${WS}/a.ts` }).type).toBe("allowed");
    broker.setTrustWorkspace(false);
    expect(broker.check(writeSchema, { path: `${WS}/a.ts` }).type).toBe("needs_confirmation");
  });

  test("reports permissive posture when trust is enabled", () => {
    const broker = new PermissionBroker(false, { workspaceRoot: WS, trustWorkspace: true });
    expect(broker.getSecurityPosture()).toBe("permissive");
  });
});

describe("PermissionBroker — permission modes (the Shift+Tab cycle)", () => {
  const WS = "/tmp/alan-ws";
  const bashSchema = {
    name: "bash",
    permissionLevel: "confirm" as const,
    description: "",
    parameters: [],
  };

  test("nextPermissionMode cycles confirm → auto → turing → confirm", () => {
    expect(nextPermissionMode("confirm")).toBe("auto");
    expect(nextPermissionMode("auto")).toBe("turing");
    expect(nextPermissionMode("turing")).toBe("confirm");
    // Three full steps return to the start.
    let m: PermissionMode = "confirm";
    for (const _ of PERMISSION_MODE_ORDER) m = nextPermissionMode(m);
    expect(m).toBe("confirm");
  });

  test("setMode maps onto the underlying booleans, getMode reads them back", () => {
    const broker = new PermissionBroker(false, { workspaceRoot: WS });
    expect(broker.getMode()).toBe("confirm");

    broker.setMode("auto");
    expect(broker.getMode()).toBe("auto");
    expect(broker.isTrustWorkspace()).toBe(true);
    expect(broker.isYoloMode()).toBe(false);

    broker.setMode("turing");
    expect(broker.getMode()).toBe("turing");
    expect(broker.isYoloMode()).toBe(true);
    expect(broker.isTrustWorkspace()).toBe(false);

    broker.setMode("confirm");
    expect(broker.getMode()).toBe("confirm");
    expect(broker.isYoloMode()).toBe(false);
    expect(broker.isTrustWorkspace()).toBe(false);
  });

  test("Turing mode bypasses confirmation; confirm restores it", () => {
    const broker = new PermissionBroker(false, { workspaceRoot: WS });
    expect(broker.check(bashSchema, { command: "rm -rf build" }).type).toBe("needs_confirmation");

    broker.setMode("turing");
    expect(broker.check(bashSchema, { command: "rm -rf build" }).type).toBe("allowed");

    broker.setMode("confirm");
    expect(broker.check(bashSchema, { command: "rm -rf build" }).type).toBe("needs_confirmation");
  });

  test("auto mode auto-approves in-workspace bash but not the network", () => {
    const broker = new PermissionBroker(false, { workspaceRoot: WS });
    broker.setMode("auto");
    expect(broker.check(bashSchema, { command: "ls" }).type).toBe("allowed");
    const webSchema = {
      name: "web_fetch",
      permissionLevel: "confirm" as const,
      description: "",
      parameters: [],
    };
    expect(broker.check(webSchema, { url: "https://example.com" }).type).toBe("needs_confirmation");
  });
});
