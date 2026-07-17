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
  it("renders a 4-line block with a uniform-width box and caret on the input row", () => {
    const r = renderComposer({ input: "hello", caret: 5, width: 80, status: "  status" });
    expect(r.lines).toHaveLength(4); // top, input, bottom, status
    const box = r.lines.slice(0, 3).map((l) => stripAnsi(l).length);
    expect(new Set(box).size).toBe(1); // top/mid/bottom equal width
    expect(r.caretRow).toBe(1);
    expect(r.caretCol).toBe(11); // 6 chrome cols + caret index 5
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
    expect(plain.some((l) => l.includes("❯") && l.includes("/theme"))).toBe(true); // selected = index 1
    expect(plain.find((l) => l.includes("/model"))!.startsWith("    ")).toBe(true); // unselected = no marker
    expect(plain.join("\n")).toContain("Switch model / provider");
    expect(plain.at(-1)).toContain("tab complete"); // hint footer
  });

  it("returns nothing for an empty list", () => {
    expect(renderSlashPalette([], 0, 100)).toEqual([]);
  });

  it("windows a long list to at most 8 rows + a hint, keeping the selection in view", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ name: "/c" + i, desc: "d" + i }));
    const lines = renderSlashPalette(many, 20, 100);
    expect(lines.length).toBeLessThanOrEqual(9); // 8 rows + 1 hint
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
  it("flags Hands-Free mode in the status line and omits a badge in confirm mode", () => {
    const base = { model: "gemini-2.5-flash", workspace: "/tmp/ws" };
    const confirm = stripAnsi(statusLine({ ...base, mode: "confirm" }));
    expect(confirm).toContain("gemini-2.5-flash");
    expect(confirm).not.toMatch(/turing/i);

    const turing = stripAnsi(statusLine({ ...base, mode: "turing" }));
    expect(turing).toMatch(/HANDS-FREE/);
  });

  it("accepts the legacy 'yolo'/'trusted' aliases", () => {
    expect(stripAnsi(statusLine({ model: "m", workspace: "/w", mode: "yolo" }))).toMatch(
      /HANDS-FREE/,
    );
    expect(stripAnsi(statusLine({ model: "m", workspace: "/w", mode: "trusted" }))).toMatch(/auto/);
  });

  it("permissionModeBanner describes each mode and mentions shift+tab", () => {
    const turing = stripAnsi(permissionModeBanner("turing"));
    expect(turing).toMatch(/Hands-Free/);
    expect(turing).toMatch(/without asking/i);
    expect(turing).toMatch(/shift\+tab/i);

    expect(stripAnsi(permissionModeBanner("auto"))).toMatch(/Auto mode/i);
    expect(stripAnsi(permissionModeBanner("confirm"))).toMatch(/Confirm mode/i);
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
  it("frames a uniform-width box with the action title, clean detail, and allow/session/deny keys", () => {
    const r = renderPermissionCard("bash", "bash: ls -R", 80);
    const plain = r.lines.map(stripAnsi);
    expect(plain[0]).toBe(""); // leading blank separates it from the activity stream
    const box = plain.slice(1, 4).map((l) => l.length);
    expect(new Set(box).size).toBe(1); // top / mid / bottom equal width
    const joined = plain.join("\n");
    expect(joined).toContain("Run shell command");
    expect(joined).toContain("ls -R");
    expect(joined).not.toMatch(/bash.*bash/); // no redundant "bash — bash:"
    const keys = plain.at(-1)!;
    expect(keys).toContain("enter");
    expect(keys).toContain("session");
    expect(keys).toContain("deny");
    expect(r.caretRow).toBe(4); // parked on the keys line
  });

  it("never overflows the terminal width, even with a long command or tool name", () => {
    const r = renderPermissionCard("bash", "bash: " + "echo hi && ".repeat(40), 70);
    for (const l of r.lines) expect(stripAnsi(l).length).toBeLessThan(70);
    // A pathologically long (unknown) tool name must not blow out the titled border.
    const long = renderPermissionCard("some_" + "x".repeat(80) + "_tool", "{}", 70);
    const box = long.lines.slice(1, 4).map((l) => stripAnsi(l).length);
    expect(new Set(box).size).toBe(1);
    for (const l of long.lines) expect(stripAnsi(l).length).toBeLessThan(70);
  });

  it("falls back to a compact two-line form on a narrow terminal", () => {
    const r = renderPermissionCard("bash", "bash: ls", 40);
    expect(r.lines).toHaveLength(3); // blank + question + keys
    const joined = stripAnsi(r.lines.join("\n"));
    expect(joined).toContain("Run shell command");
    expect(joined).toContain("ls");
    for (const l of r.lines) expect(stripAnsi(l).length).toBeLessThan(40);
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
    expect(stripAnsi(r.lines[0])).toContain("Model");
    expect(stripAnsi(r.lines[2])).toContain("❯"); // selected = index 1 → line 2
    expect(stripAnsi(r.lines[1])).not.toContain("❯");
    expect(stripAnsi(r.lines.at(-1)!)).toContain("enter confirm");
    expect(r.caretRow).toBe(2);
  });
});
