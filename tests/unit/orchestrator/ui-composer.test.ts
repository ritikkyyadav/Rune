import { describe, it, expect } from "bun:test";
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
import { glyph } from "../../../packages/orchestrator/src/bin/ui/glyphs";

describe("ui/composer renderComposer", () => {
  it("is a CLOSED field: a rule above and below, so the input has edges", () => {
    const r = renderComposer({ input: "hello", caret: 5, width: 80, status: "  status" });
    // One rule is a divider — it separates the composer from the transcript but
    // leaves the input floating, so on a quiet screen nothing says where the
    // typing goes. Two make it a place, with the status hint outside the edges
    // rather than looking like more input.
    expect(r.lines).toHaveLength(5); // gap, rule, input, rule, status
    expect(stripAnsi(r.lines[0]).trim()).toBe(""); // the field owns its own gap
    const top = stripAnsi(r.lines[1]);
    const bottom = stripAnsi(r.lines[3]);
    expect(top).toBe(bottom);
    expect(top.trim()).toMatch(/^─+$/);
    expect(top.length).toBe(stripAnsi(r.lines[2]).length);
    expect(r.caretRow).toBe(2); // still on the input row, between the rules
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
    for (const line of r.lines.slice(0, 3)) expect(stripAnsi(line).length).toBeLessThanOrEqual(20);
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
  it("is a hairline from the closed glyph set, not a dashed rule", () => {
    const r = stripAnsi(composerRule());
    expect(r.startsWith("  ")).toBe(true); // same 2-col indent as the `›` prompt
    // A dash rule reads as texture; a hairline reads as structure. Both fold to
    // "-" on the ASCII rung, so nothing is lost on a serial console.
    expect(r.trim()).toMatch(/^─+$/);
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
    expect(plain[0]).toContain("commands"); // the header carries the hints
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
    expect(plain.some((l) => l.includes(glyph("selection")) && l.includes("Groq"))).toBe(true);
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
    expect(plain.some((l) => l.includes(glyph("selection")) && l.includes("work"))).toBe(true);
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
  it("shows an ASCII dash pair for unknown or bad dates", () => {
    expect(formatKeyDate(undefined)).toBe("--");
    expect(formatKeyDate("not-a-date")).toBe("--");
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
    expect(stripAnsi(r.lines[r.caretRow])).toContain(glyph("selection"));
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
    expect(joined).toContain(".");
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
    expect(confirm).toContain("> 1st gear");
    expect(confirm).toContain("every action asks first");
    expect(confirm).toContain("shift+tab gear");
    expect(confirm).toContain("esc stop");
    expect(confirm).toContain("? keys");
    expect(confirm).not.toMatch(/autonomy/i);

    expect(stripAnsi(statusLine({ ...base, mode: "autonomy-i" }, 120))).toContain(">> 2nd gear");
    expect(stripAnsi(statusLine({ ...base, mode: "autonomy-ii" }, 120))).toContain(">>> 3rd gear");
    expect(stripAnsi(statusLine({ ...base, mode: "autonomy-iii" }, 120))).toContain(
      ">>>> 4th gear",
    );
    expect(stripAnsi(statusLine({ ...base, mode: "auto" }, 120))).toContain("* auto");
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
    expect(line).toContain("esc stop");
  });

  it("permissionModeBanner names each gear, what it allows, and how to shift", () => {
    // The sentence wraps to the measure, so read it flat.
    const flat = (mode: string) => stripAnsi(permissionModeBanner(mode)).replace(/\s+/g, " ");
    const fourth = flat("autonomy-iii");
    expect(fourth).toMatch(/4th gear/);
    expect(fourth).toMatch(/without permission prompts/i);
    expect(flat("gear-4")).toBe(fourth);
    expect(fourth).toMatch(/shift\+tab/i);

    expect(flat("autonomy-i")).toMatch(/2nd gear.*workspace edits/i);
    expect(flat("autonomy-ii")).toMatch(/3rd gear.*sandboxed local commands/i);

    const auto = flat("auto");
    expect(auto).toMatch(/\* auto/);
    expect(auto).toMatch(/isolated classifier/i);
    expect(flat("confirm")).toMatch(/1st gear/);

    // Every banner holds the measure rather than running off the right edge.
    for (const mode of ["confirm", "gear-4", "auto"]) {
      for (const line of stripAnsi(permissionModeBanner(mode)).split("\n")) {
        expect(line.length).toBeLessThanOrEqual(120);
      }
    }
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
  it("asks a question, shows the literal command, and numbers the answers", () => {
    const r = renderPermissionCard("bash", "bash: ls -R", 80);
    const plain = r.lines.map(stripAnsi);
    expect(plain[0]).toBe(""); // a blank line separates it from the work above
    const joined = plain.join("\n");
    expect(joined).toContain(`${glyph("selection")} Run shell command?`);
    expect(joined).toMatch(/bash \| (sandboxed|host)/); // the posture is stated, never assumed
    expect(joined).toContain("│ ls -R");
    expect(joined).not.toMatch(/bash: bash/); // no redundant "bash — bash:"
    expect(joined).toContain("1   yes, once");
    expect(joined).toContain("2   yes, and stop asking this session");
    expect(joined).toContain("3   no, skip it");
    expect(joined).toContain("esc cancel");
    expect(joined).toContain("(default)"); // the safe answer is the one your hands know
    expect(joined).toContain("No action taken yet");
    expect(plain.join(" ")).toContain("recorded in the audit trail");
    expect(plain[r.caretRow]).toContain("yes, once");
  });

  it("holds the reading measure, whatever the command or tool name throws at it", () => {
    const r = renderPermissionCard("bash", "bash: " + "echo hi && ".repeat(40), 70);
    for (const l of r.lines) expect(stripAnsi(l).length).toBeLessThanOrEqual(70);
    // A pathologically long (unknown) tool name must not blow out the prompt.
    const long = renderPermissionCard("some_" + "x".repeat(80) + "_tool", "{}", 70);
    for (const l of long.lines) expect(stripAnsi(l).length).toBeLessThanOrEqual(70);
  });

  it("keeps all three answers visible on a narrow terminal", () => {
    const r = renderPermissionCard("bash", "bash: ls", 40);
    const joined = stripAnsi(r.lines.join("\n"));
    expect(joined).toContain("│ ls");
    expect(joined).toContain("1   yes, once");
    expect(joined).toContain("3   no, skip it");
    for (const l of r.lines) expect(stripAnsi(l).length).toBeLessThanOrEqual(40);
  });

  it("shows a line-numbered change preview and parks the caret on the selected answer", () => {
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
    expect(joined).toContain(`${glyph("selection")} Apply this edit to src/palette.ts?`);
    expect(joined).toContain("src/palette.ts");
    expect(joined).toContain("+1 -1");
    expect(joined).toContain("  11   const delay = 42;");
    expect(joined).toContain("  12 - filterSoon(query);");
    expect(joined).toContain("  12 + filterNow(query);");
    expect(joined).toContain("Working tree unchanged");
    // The prompt uses the caller's own words for the answers when it has them.
    expect(joined).toContain("2   Yes, allow file edits for this session");
    expect(plain[r.caretRow]).toContain("Yes, allow file edits for this session");
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
    expect(stripAnsi(r.lines[0])).toContain("model"); // the overlay header
    expect(stripAnsi(r.lines[0])).toContain("esc close");
    expect(stripAnsi(r.lines[2])).toContain("›"); // selected = index 1 → line 2
    expect(stripAnsi(r.lines[1])).not.toContain("›");
    expect(stripAnsi(r.lines.at(-1)!)).toContain("enter select");
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

describe("ui/composer footer filesEdited readout", () => {
  it("shows the session's edited-file count once files change", () => {
    const line = stripAnsi(
      statusLine(
        { model: "m", workspace: "/w", mode: "gear-2", filesEdited: 3, contextPercent: 55 },
        140,
      ),
    );
    expect(line).toContain("3 files edited");
    expect(
      stripAnsi(statusLine({ model: "m", workspace: "/w", mode: "gear-2" }, 140)),
    ).not.toContain("files edited");
  });
});

describe("the gear ladder", () => {
  // The count is the information: one mark per gear, readable at a glance
  // without parsing the label. A gap anywhere in the sequence makes that gear
  // look like a different product.
  it("is a counting sequence with no gaps", () => {
    const { modeInfo } = require("../../../packages/orchestrator/src/bin/ui/composer");
    expect(modeInfo("gear-1").arrows).toBe(">");
    expect(modeInfo("gear-2").arrows).toBe(">>");
    expect(modeInfo("gear-3").arrows).toBe(">>>");
    expect(modeInfo("gear-4").arrows).toBe(">>>>");
    for (const [id, n] of [
      ["gear-1", 1],
      ["gear-2", 2],
      ["gear-3", 3],
      ["gear-4", 4],
    ] as const) {
      expect(modeInfo(id).arrows.length, id).toBe(n);
    }
  });
});
