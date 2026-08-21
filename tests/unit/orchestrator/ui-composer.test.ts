import { describe, it, expect } from "vitest";
import {
  renderComposer,
  renderPicker,
  composerRule,
  renderSlashPalette,
  renderKeysPanel,
  renderKeyEditor,
  renderKeyManagerPanel,
  formatKeyDate,
  renderMemoryPanel,
  MEMORY_ACTION_COUNT,
  renderPermissionCard,
  permissionView,
  statusLine,
  permissionModeBanner,
} from "../../../packages/orchestrator/src/bin/ui/composer";
import { stripAnsi } from "../../../packages/orchestrator/src/bin/ui/theme";

describe("ui/composer renderComposer", () => {
  it("renders the reference's 3-line open surface with one hairline and caret on the input row", () => {
    const r = renderComposer({ input: "hello", caret: 5, width: 80, status: "  status" });
    expect(r.lines).toHaveLength(3); // hairline, input, status
    expect(stripAnsi(r.lines[0]).length).toBe(stripAnsi(r.lines[1]).length);
    expect(r.caretRow).toBe(1);
    expect(r.caretCol).toBe(9); // 4 chrome cols + caret index 5
  });

  it("never produces a line at or beyond the terminal width (no auto-wrap)", () => {
    const r = renderComposer({ input: "x".repeat(500), caret: 500, width: 80, status: "  s" });
    for (const l of r.lines) expect(stripAnsi(l).length).toBeLessThan(80);
  });

  it("horizontally scrolls to keep a far caret visible", () => {
    const r = renderComposer({ input: "x".repeat(200), caret: 200, width: 60, status: "  s" });
    // caret column stays inside the box, not off-screen
    expect(r.caretCol).toBeLessThan(60);
    expect(r.caretCol).toBeGreaterThan(5);
  });

  it("fits its frame inside a narrow terminal instead of assuming 28 columns", () => {
    const r = renderComposer({ input: "hello", caret: 5, width: 20, status: "  status" });
    for (const line of r.lines.slice(0, 3)) expect(stripAnsi(line).length).toBeLessThan(20);
  });

  it("shows a working indicator instead of the box when set", () => {
    const r = renderComposer({
      input: "",
      caret: 0,
      width: 80,
      status: "  s",
      working: "• Working (3s · esc to interrupt)",
    });
    expect(r.lines).toHaveLength(2);
    expect(stripAnsi(r.lines[0])).toContain("Working");
    expect(r.caretRow).toBe(0);
  });
});

describe("ui/composer composerRule", () => {
  it("is a chevron-aligned hairline of only ─ glyphs (frames the readline input)", () => {
    const r = stripAnsi(composerRule());
    expect(r.startsWith("  ")).toBe(true); // same 2-col indent as the `›` prompt
    expect(r.trim()).toMatch(/^─+$/); // nothing but box-drawing dashes
    expect(r.trim().length).toBeGreaterThan(10);
  });
});

describe("ui/composer renderSlashPalette", () => {
  const items = [
    { name: "/model", desc: "Switch model / provider" },
    { name: "/theme", desc: "Switch color theme" },
    { name: "/help", desc: "Show commands" },
  ];

  it("highlights the selected row and lists names + descriptions", () => {
    const plain = renderSlashPalette(items, 1, 100).map(stripAnsi);
    expect(plain.some((l) => l.includes("›") && l.includes("/theme"))).toBe(true); // selected = index 1
    expect(plain.find((l) => l.includes("/model"))!.startsWith("    ")).toBe(true); // unselected = no marker
    expect(plain.join("\n")).toContain("Switch model / provider");
    expect(plain[0]).toContain("COMMANDS"); // v2 uppercase header carries the hints
    expect(plain[0]).toContain("tab complete");
  });

  it("returns nothing for an empty list", () => {
    expect(renderSlashPalette([], 0, 100)).toEqual([]);
  });

  it("windows a long list to a header, at most 8 rows, and a hint", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ name: "/c" + i, desc: "d" + i }));
    const lines = renderSlashPalette(many, 20, 100);
    expect(lines.length).toBeLessThanOrEqual(10); // header + 8 rows + hint
    expect(stripAnsi(lines.join("\n"))).toContain("/c20");
  });

  it("accepts a smaller viewport budget and keeps the selected command visible", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ name: "/c" + i, desc: "d" + i }));
    const lines = renderSlashPalette(many, 20, 40, 3);
    expect(lines).toHaveLength(4); // header + 3 commands (hints live in the header)
    expect(stripAnsi(lines.join("\n"))).toContain("/c20");
  });
});

describe("ui/composer renderKeysPanel", () => {
  const rows = [
    {
      id: "anthropic",
      label: "Anthropic",
      masked: "sk-a…1f2a",
      source: "saved" as const,
      disabled: false,
      active: true,
    },
    {
      id: "groq",
      label: "Groq",
      masked: "",
      source: "none" as const,
      disabled: false,
      active: false,
    },
    {
      id: "openai",
      label: "OpenAI",
      masked: "sk-o…9999",
      source: "saved" as const,
      disabled: true,
      active: false,
    },
  ];

  it("marks the selection, shows status + masked keys, and never the raw secret", () => {
    const plain = renderKeysPanel(rows, 1, 100).lines.map(stripAnsi);
    expect(plain[0]).toContain("API keys");
    expect(plain.some((l) => l.includes("❯") && l.includes("Groq"))).toBe(true); // selected = index 1
    expect(plain.find((l) => l.includes("Anthropic"))!).toContain("sk-a…1f2a");
    expect(plain.find((l) => l.includes("Groq"))!).toContain("not set");
    expect(plain.find((l) => l.includes("OpenAI"))!).toContain("off"); // toggled off
    expect(plain.at(-1)).toContain("manage keys"); // hint footer
  });

  it("shows a +N badge when a provider has a multi-account pool", () => {
    const pooled = [
      {
        id: "ollama-turbo",
        label: "Ollama Turbo",
        masked: "sk-o…aaaa",
        source: "saved" as const,
        keyCount: 10,
        active: false,
        disabled: false,
      },
    ];
    const plain = renderKeysPanel(pooled, 0, 100).lines.map(stripAnsi);
    expect(plain.find((l) => l.includes("Ollama Turbo"))!).toContain("+9"); // 10 keys → "+9 more"
  });
});

describe("ui/composer renderKeyManagerPanel", () => {
  const keys = [
    {
      id: "k1",
      masked: "key1…aaaa",
      label: "personal",
      addedAt: "2026-07-01T10:00:00Z",
      active: false,
    },
    { id: "k2", masked: "key2…bbbb", label: "work", addedAt: "2026-07-10T10:00:00Z", active: true },
  ];

  it("lists every stored key with its date and marks the active one", () => {
    const r = renderKeyManagerPanel("Ollama Turbo", keys, 1, 100);
    const plain = r.lines.map(stripAnsi);
    expect(plain[0]).toContain("Ollama Turbo");
    expect(plain[0]).toContain("2 keys configured");
    expect(plain.find((l) => l.includes("personal"))!).toContain("2026-07-01");
    expect(plain.find((l) => l.includes("work"))!).toContain("active");
    expect(plain.some((l) => l.includes("❯") && l.includes("work"))).toBe(true); // selected index 1
    expect(plain.at(-1)).toContain("a add key");
    // Never leaks a raw secret.
    expect(plain.join("\n")).not.toContain("SECRET");
  });

  it("shows an empty-state prompt when no keys are stored", () => {
    const plain = renderKeyManagerPanel("Groq", [], 0, 100).lines.map(stripAnsi);
    expect(plain[0]).toContain("none configured");
    expect(plain.some((l) => l.includes("Press a to add"))).toBe(true);
  });
});

describe("ui/composer formatKeyDate", () => {
  it("formats an ISO date as YYYY-MM-DD", () => {
    expect(formatKeyDate("2026-07-10T10:00:00Z")).toBe("2026-07-10");
  });
  it("shows an em-dash for unknown or bad dates", () => {
    expect(formatKeyDate(undefined)).toBe("—");
    expect(formatKeyDate("not-a-date")).toBe("—");
  });
});

describe("ui/composer renderMemoryPanel", () => {
  const base = {
    scheduleLabel: "weekly",
    tokens: 120,
    maxTokens: 1500,
    lastDreamed: "2d ago",
    busy: false,
    pendingClear: false,
  };

  it("shows the profile, status, all actions, and parks the caret on the selection", () => {
    const r = renderMemoryPanel(
      { ...base, content: "# About you\n- Builds Rust CLIs\n- Terse" },
      0,
      100,
    );
    const plain = r.lines.map(stripAnsi);
    expect(plain[0]).toContain("System memory");
    expect(plain.some((l) => l.includes("~120/1500 tokens") && l.includes("weekly"))).toBe(true);
    expect(plain.some((l) => l.includes("Builds Rust CLIs"))).toBe(true);
    for (const action of ["Refresh now", "Auto-update", "Add a note", "Edit", "Clear"]) {
      expect(plain.some((l) => l.includes(action))).toBe(true);
    }
    expect(stripAnsi(r.lines[r.caretRow])).toContain("❯"); // caret on selected action row
    expect(stripAnsi(r.lines[r.caretRow])).toContain("Refresh now");
  });

  it("invites the user when empty", () => {
    const plain = renderMemoryPanel({ ...base, content: "" }, 0, 100).lines.map(stripAnsi);
    expect(plain.some((l) => l.toLowerCase().includes("hasn't learned"))).toBe(true);
    expect(plain.some((l) => l.includes("empty"))).toBe(true);
  });

  it("arms a confirm on the Clear action", () => {
    const plain = renderMemoryPanel(
      { ...base, content: "x", pendingClear: true },
      4,
      100,
    ).lines.map(stripAnsi);
    expect(plain.some((l) => l.includes("press again to confirm"))).toBe(true);
  });

  it("shows a dreaming indicator while busy", () => {
    const plain = renderMemoryPanel({ ...base, content: "x", busy: true }, 0, 100).lines.map(
      stripAnsi,
    );
    expect(plain.some((l) => l.toLowerCase().includes("dreaming"))).toBe(true);
  });

  it("exposes exactly the actions the panel navigates", () => {
    expect(MEMORY_ACTION_COUNT).toBe(5);
  });
});

describe("ui/composer renderKeyEditor", () => {
  it("masks an API key, leaving only the last 4 visible", () => {
    const r = renderKeyEditor({
      title: "Paste API key — Groq",
      value: "gsk_supersecret",
      caret: 15,
      width: 80,
      masked: true,
    });
    const joined = stripAnsi(r.lines.join("\n"));
    expect(joined).toContain("Paste API key");
    expect(joined).not.toContain("supersecret");
    expect(joined).toContain("•");
    expect(joined).toContain("cret"); // last 4 shown
    expect(r.caretRow).toBeGreaterThan(0);
  });

  it("shows a plain value with subtitle when not masked (e.g. a base URL)", () => {
    const r = renderKeyEditor({
      title: "Custom endpoint — base URL",
      subtitle: "OpenAI-compatible /v1 base URL",
      value: "https://api.x.ai/v1",
      caret: 5,
      width: 80,
      masked: false,
    });
    const joined = stripAnsi(r.lines.join("\n"));
    expect(joined).toContain("https://api.x.ai/v1");
    expect(joined).toContain("/v1 base URL");
  });
});

describe("ui/composer statusLine + permission mode", () => {
  it("keeps the safe default and every gear visible", () => {
    const base = { model: "gemini-2.5-flash", workspace: "/tmp/ws" };
    const confirm = stripAnsi(statusLine({ ...base, mode: "confirm" }, 120));
    expect(confirm).toContain("▸ 1st gear");
    expect(confirm).toContain("every action asks first");
    expect(confirm).toContain("shift+tab mode");
    expect(confirm).toContain("← sessions");
    expect(confirm).toContain("? shortcuts");
    expect(confirm).not.toMatch(/autonomy/i);

    expect(stripAnsi(statusLine({ ...base, mode: "autonomy-i" }, 120))).toContain("▸▸ 2nd gear");
    expect(stripAnsi(statusLine({ ...base, mode: "autonomy-ii" }, 120))).toContain("▸▸▸ 3rd gear");
    expect(stripAnsi(statusLine({ ...base, mode: "autonomy-iii" }, 120))).toContain(
      "▸▸▸▸ 4th gear",
    );
    expect(stripAnsi(statusLine({ ...base, mode: "auto" }, 120))).toContain("◆ auto");
  });

  it("stays on one line in a narrow terminal by dropping the description first", () => {
    const line = stripAnsi(statusLine({ model: "m", workspace: "/w", mode: "autonomy-i" }, 60));
    expect(line).toContain("2nd gear");
    expect(line).not.toContain("\n");
    expect(line.length).toBeLessThan(60);
  });

  it("accepts the legacy 'yolo'/'trusted' aliases", () => {
    expect(stripAnsi(statusLine({ model: "m", workspace: "/w", mode: "yolo" }))).toContain(
      "4th gear",
    );
    // legacy "trusted" = the old workspace trust = 3rd gear, never the classifier
    expect(stripAnsi(statusLine({ model: "m", workspace: "/w", mode: "trusted" }))).toContain(
      "3rd gear",
    );
    expect(stripAnsi(statusLine({ model: "m", workspace: "/w", mode: "gear-4" }))).toContain(
      "4th gear",
    );
  });

  it("keeps an active session loop visible in the compact footer", () => {
    const line = stripAnsi(
      statusLine({ model: "m", workspace: "/w", mode: "confirm", loop: "2 loops · in 5m" }),
    );
    expect(line).toContain("↻ 2 loops · in 5m");
  });

  it("leaves light/dark state to the theme picker", () => {
    const line = stripAnsi(
      statusLine({ model: "m", workspace: "/w", mode: "confirm", theme: "dark" }, 100),
    );
    expect(line).not.toContain("◐ dark");
    expect(line).toContain("esc interrupt");
  });

  it("permissionModeBanner names each gear and mentions shift+tab", () => {
    const fourth = stripAnsi(permissionModeBanner("autonomy-iii"));
    expect(fourth).toMatch(/4th gear/);
    expect(fourth).toMatch(/without permission prompts/i);
    expect(stripAnsi(permissionModeBanner("gear-4"))).toBe(fourth);
    expect(fourth).toMatch(/shift\+tab/i);

    expect(stripAnsi(permissionModeBanner("autonomy-i"))).toMatch(/2nd gear.*workspace edits/i);
    expect(stripAnsi(permissionModeBanner("autonomy-ii"))).toMatch(
      /3rd gear.*sandboxed local commands/i,
    );

    const auto = stripAnsi(permissionModeBanner("auto"));
    expect(auto).toMatch(/◆ auto/);
    expect(auto).toMatch(/isolated classifier/i);
    expect(stripAnsi(permissionModeBanner("confirm"))).toMatch(/1st gear/);
  });
});

describe("ui/composer permissionView", () => {
  it("strips the summarizer's redundant tool prefix and gives a human title", () => {
    expect(permissionView("bash", "bash: ls -R")).toEqual({
      title: "Run shell command",
      body: "ls -R",
    });
    expect(permissionView("write_file", "write_file src/app.ts")).toEqual({
      title: "Write file",
      body: "src/app.ts",
    });
  });

  it("falls back to a generic title and never yields an empty body", () => {
    expect(permissionView("n8n_trigger", "n8n_trigger {}")).toEqual({
      title: "Run n8n_trigger",
      body: "{}",
    });
    expect(permissionView("bash", "bash:").body).toBe("bash"); // empty detail → tool name
  });
});

describe("ui/composer renderPermissionCard", () => {
  it("renders an open approval rail with explicit scope, choices, shortcuts, and guard state", () => {
    const r = renderPermissionCard("bash", "bash: ls -R", 80);
    const plain = r.lines.map(stripAnsi);
    expect(plain[0]).toBe(""); // leading blank separates it from the activity stream
    const joined = plain.join("\n");
    expect(joined).toContain("Permission required");
    expect(joined).toMatch(/bash · (sandboxed|host)/); // the tag chip states the posture
    expect(joined).toContain("$ ls -R");
    expect(joined).not.toMatch(/bash: bash/); // no redundant "bash — bash:"
    expect(joined).toContain("Allow once");
    expect(joined).toContain("Allow for session");
    expect(joined).toContain("Deny");
    expect(joined).toContain("No action taken yet");
    // The footnote wraps across rail rows; read it as one sentence.
    const flat = plain.map((l) => l.replace(/^\s*▌\s*/, "").trim()).join(" ");
    expect(flat).toContain("tamper-evident audit trail");
    expect(plain[r.caretRow]).toContain("Allow once");
  });

  it("never overflows the terminal width, even with a long command or tool name", () => {
    const r = renderPermissionCard("bash", "bash: " + "echo hi && ".repeat(40), 70);
    for (const l of r.lines) expect(stripAnsi(l).length).toBeLessThan(70);
    // A pathologically long (unknown) tool name must not blow out the approval rail.
    const long = renderPermissionCard("some_" + "x".repeat(80) + "_tool", "{}", 70);
    for (const l of long.lines) expect(stripAnsi(l).length).toBeLessThan(70);
  });

  it("keeps all three decisions visible on a narrow terminal", () => {
    const r = renderPermissionCard("bash", "bash: ls", 40);
    const joined = stripAnsi(r.lines.join("\n"));
    expect(joined).toContain("Permission required");
    expect(joined).toContain("$ ls");
    expect(joined).toContain("Allow once");
    expect(joined).toContain("Allow for session");
    expect(joined).toContain("Deny");
    for (const l of r.lines) expect(stripAnsi(l).length).toBeLessThan(40);
  });

  it("shows a line-numbered change preview and parks the caret on the selected decision", () => {
    const r = renderPermissionCard("edit_file", "edit_file src/palette.ts", 92, {
      selected: 1,
      preview: {
        question: "Apply this edit to src/palette.ts?",
        scope: "workspace · reversible",
        target: "src/palette.ts",
        lines: [
          { kind: "context", text: "const delay = 42;", oldLine: 11, newLine: 11 },
          { kind: "remove", text: "filterSoon(query);", oldLine: 12 },
          { kind: "add", text: "filterNow(query);", newLine: 12 },
        ],
        added: 1,
        removed: 1,
        truncated: false,
        guard: "Working tree unchanged · review before write",
        choices: [
          "Yes, apply this edit",
          "Yes, allow file edits for this session",
          "No, tell Gear what to change",
        ],
      },
    });
    const plain = r.lines.map(stripAnsi);
    const joined = plain.join("\n");
    expect(joined).toContain("src/palette.ts  +1 −1");
    expect(joined).toContain("11   const delay = 42;");
    expect(joined).toContain("12 - filterSoon(query);");
    expect(joined).toContain("12 + filterNow(query);");
    expect(joined).toContain("Working tree unchanged");
    expect(plain[r.caretRow]).toContain("Allow for session");
  });
});

describe("ui/composer renderPicker", () => {
  it("marks the selected row and includes a hint footer", () => {
    const r = renderPicker(
      "Model",
      [{ label: "Gemini 2.5 Flash" }, { label: "Gemini 2.5 Pro" }],
      1,
      80,
    );
    expect(stripAnsi(r.lines[0])).toContain("MODEL"); // v2 uppercase overlay header
    expect(stripAnsi(r.lines[0])).toContain("esc close");
    expect(stripAnsi(r.lines[2])).toContain("›"); // selected = index 1 → line 2
    expect(stripAnsi(r.lines[1])).not.toContain("›");
    expect(stripAnsi(r.lines.at(-1)!)).toContain("⏎ select");
    expect(r.caretRow).toBe(2);
  });

  it("windows tall pickers to the terminal height and retains the selected row", () => {
    const items = Array.from({ length: 30 }, (_, i) => ({ label: `item ${i}` }));
    const r = renderPicker("Pick", items, 23, 40, 7);
    expect(r.lines).toHaveLength(7);
    expect(stripAnsi(r.lines.join("\n"))).toContain("item 23");
    expect(stripAnsi(r.lines[r.caretRow]!)).toContain("›");
  });
});
