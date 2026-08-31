import { describe, test, expect, beforeEach, spyOn } from "bun:test";
import {
  PermissionBroker,
  configModeToPermissionMode,
  nextPermissionMode,
  PERMISSION_MODE_ORDER,
  resolveStartupPermissionFlags,
  type PermissionMode,
  legacyConfigModeToPermissionMode,
  permissionModeToConfig,
  gearLabel,
  GEAR_MODES,
} from "../../../packages/orchestrator/src/permissions";
import { setSandboxCapability } from "../../../packages/tool-registry/src/sandbox-capability";

// These suites model a healthy machine: bash auto-approval is only justified
// when OS isolation actually exists, so say so explicitly.
setSandboxCapability({ mechanism: "seatbelt", osIsolation: true });

describe("PermissionBroker", () => {
  let broker: PermissionBroker;

  beforeEach(() => {
    broker = new PermissionBroker(false);
  });

  test("auto-permits read-only tools", () => {
    const schema = {
      name: "read_file",
      permissionLevel: "auto" as const,
      description: "",
      parameters: [],
    };
    const result = broker.check(schema, {});
    expect(result.type).toBe("allowed");
  });

  test("requires confirmation for dangerous tools", () => {
    const schema = {
      name: "bash",
      permissionLevel: "confirm" as const,
      description: "",
      parameters: [],
    };
    const result = broker.check(schema, { command: "rm -rf /" });
    expect(result.type).toBe("needs_confirmation");
  });

  test("yolo mode bypasses all checks", () => {
    const yoloBroker = new PermissionBroker(true);
    const schema = {
      name: "bash",
      permissionLevel: "confirm" as const,
      description: "",
      parameters: [],
    };
    const result = yoloBroker.check(schema, { command: "rm -rf /" });
    expect(result.type).toBe("allowed");
  });

  test("legacy yolo startup logs a 4th-gear warning, once, via the logger", () => {
    // The announcement goes through the shared logger (stderr outside the TUI,
    // file sink under it) — the per-call console.warn it replaced printed over
    // the alt screen on EVERY tool call and tore across parallel workers.
    delete process.env.GEAR_TUI_ACTIVE;
    const writeSpy = spyOn(process.stderr, "write");
    const yoloBroker = new PermissionBroker(true);
    const schema = {
      name: "bash",
      permissionLevel: "confirm" as const,
      description: "",
      parameters: [],
    };
    yoloBroker.check(schema, {});
    yoloBroker.check(schema, {});
    const lines = writeSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.includes("4th gear"));
    writeSpy.mockRestore();
    expect(lines.length).toBe(1); // once per broker, not once per call
  });

  test("session grant allows subsequent calls", () => {
    const schema = {
      name: "bash",
      permissionLevel: "confirm" as const,
      description: "",
      parameters: [],
    };
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
    const schema = {
      name: "bash",
      permissionLevel: "confirm" as const,
      description: "",
      parameters: [],
    };

    expect(broker.check(schema, {}).type).toBe("needs_confirmation");
    broker.setYoloMode(true);
    expect(broker.check(schema, {}).type).toBe("allowed");
    broker.setYoloMode(false);
    expect(broker.check(schema, {}).type).toBe("needs_confirmation");
  });
});

describe("PermissionBroker — workspace trust", () => {
  const WS = "/tmp/gear-ws";
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

  test("apply_patch: confined when every envelope path is inside the workspace", () => {
    const broker = new PermissionBroker(false, { workspaceRoot: WS, trustWorkspace: true });
    const schema = {
      name: "apply_patch",
      permissionLevel: "confirm" as const,
      description: "",
      parameters: [],
    };
    const confined = `*** Begin Patch
*** Add File: src/new.ts
+x
*** Update File: src/old.ts
*** Move to: src/renamed.ts
 a
-b
+c
*** End Patch`;
    expect(broker.check(schema, { patch: confined }).type).toBe("allowed");

    // ANY path escaping the root (here the move destination) breaks confinement.
    const escaping = confined.replace("src/renamed.ts", "../outside.ts");
    expect(broker.check(schema, { patch: escaping }).type).toBe("needs_confirmation");

    // Unparseable patches are never confined (the handler rejects them anyway).
    expect(broker.check(schema, { patch: "garbage" }).type).toBe("needs_confirmation");
  });
});

describe("PermissionBroker — permission modes (the Shift+Tab cycle)", () => {
  const WS = "/tmp/gear-ws";
  const bashSchema = {
    name: "bash",
    permissionLevel: "confirm" as const,
    description: "",
    parameters: [],
  };

  test("nextPermissionMode shifts up 1st → 2nd → 3rd → 4th → auto and wraps", () => {
    expect(nextPermissionMode("gear-1")).toBe("gear-2");
    expect(nextPermissionMode("gear-2")).toBe("gear-3");
    expect(nextPermissionMode("gear-3")).toBe("gear-4");
    expect(nextPermissionMode("gear-4")).toBe("auto");
    expect(nextPermissionMode("auto")).toBe("gear-1");
    // Five full steps return to the start.
    let m: PermissionMode = "gear-1";
    for (const _ of PERMISSION_MODE_ORDER) m = nextPermissionMode(m);
    expect(m).toBe("gear-1");
  });

  test("gear grammar: numbers, ordinals, ids, words — and the legacy 'auto' means 3rd gear only on the old key", () => {
    for (const v of ["1", "1st", "first", "gear-1", "gear 1", "g1", "confirm", "guided"])
      expect(configModeToPermissionMode(v)).toBe("gear-1");
    for (const v of ["2", "2nd", "second", "gear-2", "autonomy-i", "Autonomy I", "edits"])
      expect(configModeToPermissionMode(v)).toBe("gear-2");
    for (const v of ["3", "3rd", "third", "gear-3", "autonomy-ii", "trusted", "auto-approve"])
      expect(configModeToPermissionMode(v)).toBe("gear-3");
    for (const v of [
      "4",
      "4th",
      "fourth",
      "gear-4",
      "autonomy-iii",
      "hands-free",
      "turing",
      "yolo",
    ])
      expect(configModeToPermissionMode(v)).toBe("gear-4");
    for (const v of ["auto", "automatic", "classifier"])
      expect(configModeToPermissionMode(v)).toBe("auto");
    expect(configModeToPermissionMode("banana")).toBeUndefined();
    // The OLD [permissions] mode = "auto" meant workspace trust → 3rd gear.
    expect(legacyConfigModeToPermissionMode("auto")).toBe("gear-3");
    expect(resolveStartupPermissionFlags({ configMode: "auto" }).permissionMode).toBe("gear-3");
    // The NEW [permissions] gear = "auto" is the classifier.
    expect(resolveStartupPermissionFlags({ configGear: "auto" }).permissionMode).toBe("auto");
    expect(resolveStartupPermissionFlags({ configGear: 4 }).permissionMode).toBe("gear-4");
    // Precedence: --gear beats everything, then legacy --autonomy, --yolo, --trust, config.
    expect(
      resolveStartupPermissionFlags({ gearFlag: "2", modeFlag: "III", yoloFlag: true })
        .permissionMode,
    ).toBe("gear-2");
    expect(resolveStartupPermissionFlags({ trustFlag: true, configGear: "4" }).permissionMode).toBe(
      "gear-3",
    );
    expect(permissionModeToConfig("gear-3")).toBe("3");
    expect(permissionModeToConfig("auto")).toBe("auto");
    expect(gearLabel("gear-4")).toBe("4th gear");
    expect(GEAR_MODES).toEqual(["gear-1", "gear-2", "gear-3", "gear-4", "auto"]);
  });

  test("startup config and legacy aliases resolve to the intended gear", () => {
    expect(configModeToPermissionMode("Autonomy II")).toBe("gear-3");
    expect(configModeToPermissionMode("hands-free")).toBe("gear-4");
    expect(resolveStartupPermissionFlags({ configMode: "autonomy-i" }).permissionMode).toBe(
      "gear-2",
    );
    expect(resolveStartupPermissionFlags({ modeFlag: "III" }).permissionMode).toBe("gear-4");
    expect(resolveStartupPermissionFlags({ trustFlag: true }).permissionMode).toBe("gear-3");
  });

  test("setMode tracks all five gears and legacy turing maps to 4th gear", () => {
    const broker = new PermissionBroker(false, { workspaceRoot: WS });
    expect(broker.getMode()).toBe("gear-1");

    broker.setMode("autonomy-i");
    expect(broker.getMode()).toBe("gear-2");
    expect(broker.isTrustWorkspace()).toBe(true);
    expect(broker.isYoloMode()).toBe(false);

    broker.setMode("autonomy-ii");
    expect(broker.getMode()).toBe("gear-3");
    expect(broker.isTrustWorkspace()).toBe(true);

    broker.setMode("turing"); // migration alias
    expect(broker.getMode()).toBe("gear-4");
    expect(broker.isYoloMode()).toBe(true);
    expect(broker.isTrustWorkspace()).toBe(false);

    broker.setMode("auto");
    expect(broker.getMode()).toBe("auto");
    expect(broker.isTrustWorkspace()).toBe(true);
    expect(broker.isYoloMode()).toBe(false);

    broker.setMode("confirm");
    expect(broker.getMode()).toBe("gear-1");
    expect(broker.isYoloMode()).toBe(false);
    expect(broker.isTrustWorkspace()).toBe(false);
  });

  test("Autonomy III bypasses confirmation; confirm restores it", () => {
    const broker = new PermissionBroker(false, { workspaceRoot: WS });
    expect(broker.check(bashSchema, { command: "rm -rf build" }).type).toBe("needs_confirmation");

    broker.setMode("autonomy-iii");
    expect(broker.check(bashSchema, { command: "rm -rf build" }).type).toBe("allowed");

    broker.setMode("confirm");
    expect(broker.check(bashSchema, { command: "rm -rf build" }).type).toBe("needs_confirmation");
  });

  test("Autonomy I permits confined edits but still prompts for shell", () => {
    const broker = new PermissionBroker(false, { workspaceRoot: WS });
    broker.setMode("autonomy-i");
    const writeSchema = {
      name: "write_file",
      permissionLevel: "confirm" as const,
      description: "",
      parameters: [],
    };
    expect(broker.check(writeSchema, { path: "src/a.ts" }).type).toBe("allowed");
    expect(broker.check(bashSchema, { command: "bun test" }).type).toBe("needs_confirmation");
  });

  test("Autonomy II additionally permits sandboxed local shell", () => {
    const broker = new PermissionBroker(false, { workspaceRoot: WS });
    broker.setMode("autonomy-ii");
    expect(broker.check(bashSchema, { command: "bun test" }).type).toBe("allowed");
    expect(broker.check(bashSchema, { command: "bun install", network: true }).type).toBe(
      "needs_confirmation",
    );
  });

  test("auto-mode broker marks confined bash as a candidate but not network access", () => {
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

describe("resolveStartupPermissionFlags config fallbacks", () => {
  test("the legacy [permissions] trustWorkspace boolean maps to 3rd gear", () => {
    expect(resolveStartupPermissionFlags({ configTrustWorkspace: true })).toEqual({
      yoloMode: false,
      trustWorkspace: true,
      permissionMode: "gear-3",
    });
    // …and stays subordinate to every explicit source.
    expect(
      resolveStartupPermissionFlags({ configTrustWorkspace: true, gearFlag: "1" }).permissionMode,
    ).toBe("gear-1");
    expect(
      resolveStartupPermissionFlags({ configTrustWorkspace: true, yoloFlag: true }).permissionMode,
    ).toBe("gear-4");
    // Absent everything: 1st gear.
    expect(resolveStartupPermissionFlags({}).permissionMode).toBe("gear-1");
  });
});
