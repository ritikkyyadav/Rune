import { describe, expect, test } from "bun:test";

import {
  PLUGIN_TOOL_CAPABILITIES,
  createPluginToolHandler,
  pluginPolicyId,
  pluginToolName,
  pluginToolPermissions,
  unsandboxedToolsAllowed,
  validateToolDeclaration,
  type PluginToolCapability,
  type PluginToolServer,
} from "../../../packages/tool-registry/src/tools/plugin-tools";

// P10.7 part 2: the capability a manifest declares becomes the permission
// category the broker and the classifier see. This file pins that mapping,
// because it is the single place a third party's claim about itself turns into
// how cheaply Rune will run its program.

describe("capability → permission", () => {
  const expected: Record<PluginToolCapability, { category: string }> = {
    none: { category: "execute" },
    "workspace-read": { category: "read" },
    "workspace-write": { category: "write" },
    network: { category: "network" },
  };

  test("each capability maps onto the category that already means that blast radius", () => {
    for (const capability of PLUGIN_TOOL_CAPABILITIES) {
      expect(pluginToolPermissions(capability, true).category).toBe(
        expected[capability].category as never,
      );
    }
  });

  test("no capability is ever `auto` — a manifest cannot make its own tool prompt-free", () => {
    for (const capability of PLUGIN_TOOL_CAPABILITIES) {
      expect(pluginToolPermissions(capability, true).permissionLevel).not.toBe("auto");
      expect(pluginToolPermissions(capability, false).permissionLevel).not.toBe("auto");
    }
  });

  test("the level tracks the containment that is actually wrapping the process", () => {
    expect(pluginToolPermissions("workspace-write", true).permissionLevel).toBe("sandbox");
    expect(pluginToolPermissions("workspace-write", false).permissionLevel).toBe("confirm");
  });

  test("a network tool is categorised like web_fetch, so the classifier sees it the same way", () => {
    expect(pluginToolPermissions("network", true).category).toBe("network");
  });
});

describe("names", () => {
  test("the model-facing name is provider-safe and says which plugin it came from", () => {
    expect(pluginToolName("acme-tools", "word_count")).toBe("plugin_acme-tools_word_count");
    expect(pluginToolName("acme tools", "count")).toBe("plugin_acme_tools_count");
    expect(pluginToolName("a", "b")).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test("the policy identity is the namespaced one a wildcard can cover", () => {
    expect(pluginPolicyId("acme", "fmt")).toBe("plugin:acme:fmt");
  });
});

describe("unsandboxed opt-in", () => {
  test("absent means no", () => {
    expect(unsandboxedToolsAllowed(undefined, "acme")).toBe(false);
    expect(unsandboxedToolsAllowed(false, "acme")).toBe(false);
  });

  test("true covers every plugin; a list covers exactly the named ones", () => {
    expect(unsandboxedToolsAllowed(true, "acme")).toBe(true);
    expect(unsandboxedToolsAllowed(["acme"], "acme")).toBe(true);
    expect(unsandboxedToolsAllowed(["other"], "acme")).toBe(false);
    expect(unsandboxedToolsAllowed([], "acme")).toBe(false);
  });
});

describe("validateToolDeclaration", () => {
  const ok = {
    id: "files",
    command: ["python3", "tools/files.py"],
    capability: "workspace-write",
  };

  test("a well-formed declaration passes", () => {
    expect(validateToolDeclaration(ok, 0)).toBeNull();
  });

  test("the id, the argv and the capability are each required and constrained", () => {
    expect(validateToolDeclaration({ ...ok, id: "has space" }, 0)).toContain("id must be");
    expect(validateToolDeclaration({ ...ok, command: [] }, 0)).toContain("non-empty argv");
    expect(validateToolDeclaration({ ...ok, command: ["python3", 7] }, 0)).toContain(
      "non-empty strings",
    );
    expect(validateToolDeclaration({ ...ok, capability: "everything" }, 0)).toContain(
      "capability must be one of",
    );
    expect(validateToolDeclaration("nope", 3)).toContain("tools[3]");
  });

  test("a network capability must name its hosts, and a non-network one may not", () => {
    expect(validateToolDeclaration({ ...ok, capability: "network" }, 0)).toContain(
      "lists no hosts",
    );
    expect(
      validateToolDeclaration({ ...ok, capability: "network", hosts: ["api.example.com:443"] }, 0),
    ).toBeNull();
    // Hosts on a capability that cannot use them would read as protection the
    // sandbox is not providing.
    expect(validateToolDeclaration({ ...ok, hosts: ["api.example.com:443"] }, 0)).toContain(
      "the hosts would be ignored",
    );
  });
});

describe("the handler a tool server produces", () => {
  function fakeServer(sandboxed: boolean): PluginToolServer {
    return {
      sandboxed,
      mechanism: sandboxed ? "seatbelt" : "none",
      call: async (_tool: string, args: Record<string, unknown>) => ({ ok: true, result: args }),
    } as unknown as PluginToolServer;
  }

  test("carries the plugin, the capability and the containment in its description", () => {
    const handler = createPluginToolHandler(fakeServer(true), {
      plugin: "acme",
      declaration: { id: "files", command: ["python3", "f.py"], capability: "workspace-write" },
      advertised: { name: "write_text", description: "Writes text.", inputSchema: {} },
    });
    expect(handler.schema.name).toBe("plugin_acme_write_text");
    expect(handler.schema.policyId).toBe("plugin:acme:write_text");
    expect(handler.schema.category).toBe("write");
    expect(handler.schema.description).toContain("capability workspace-write");
    expect(handler.schema.description).toContain("sandboxed (seatbelt)");
  });

  test("says so when it is NOT sandboxed, in the text the model reads", () => {
    const handler = createPluginToolHandler(fakeServer(false), {
      plugin: "acme",
      declaration: { id: "files", command: ["python3", "f.py"], capability: "workspace-write" },
      advertised: { name: "write_text", description: "Writes text.", inputSchema: {} },
    });
    expect(handler.schema.description).toContain("NOT sandboxed");
    expect(handler.schema.permissionLevel).toBe("confirm");
  });

  test("validates the advertised schema's required params before spawning a call", () => {
    const handler = createPluginToolHandler(fakeServer(true), {
      plugin: "acme",
      declaration: { id: "files", command: ["python3", "f.py"], capability: "workspace-read" },
      advertised: {
        name: "read_text",
        description: "Reads text.",
        inputSchema: { type: "object", properties: { path: {} }, required: ["path"] },
      },
    });
    expect(handler.validate({}).valid).toBe(false);
    expect(handler.validate({ path: "a.txt" }).valid).toBe(true);
  });

  test("a failed call becomes a failed tool result, never a thrown exception", async () => {
    const failing = {
      sandboxed: true,
      mechanism: "seatbelt",
      call: async () => ({
        ok: false,
        error: "PermissionError: [Errno 1] Operation not permitted",
      }),
    } as unknown as PluginToolServer;
    const handler = createPluginToolHandler(failing, {
      plugin: "acme",
      declaration: { id: "files", command: ["python3", "f.py"], capability: "workspace-write" },
      advertised: { name: "write_text", description: "Writes text.", inputSchema: {} },
    });
    const out = await handler.execute({
      toolName: handler.schema.name,
      callId: "1",
      args: { path: "/etc/passwd" },
      sessionId: "s",
      workspaceRoot: "/ws",
    });
    expect(out.success).toBe(false);
    expect(out.error).toContain("Operation not permitted");
  });
});
