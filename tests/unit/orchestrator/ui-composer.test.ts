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
  autoApprovedChip,
  wrapComposer,
  composerCaret,
  composerIndex,
  composerWindow,
  composerCounts,
  composerTextWidth,
  composerHintRow,
} from "../../../packages/orchestrator/src/bin/ui/composer";
import { setTermWidthOverride, visLen } from "../../../packages/orchestrator/src/bin/ui/render";
import { stripAnsi } from "../../../packages/orchestrator/src/bin/ui/theme";
import { glyph } from "../../../packages/orchestrator/src/bin/ui/glyphs";
import { pasteChip, expandPastes } from "../../../packages/orchestrator/src/bin/ui/paste";
import { INPUT_METHODS } from "../../../packages/orchestrator/src/bin/ui/tui-input";
import { regions, PANEL_COLS } from "../../../packages/orchestrator/src/bin/ui/viewport";

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

  it("WRAPS to keep a far caret visible, instead of scrolling sideways", () => {
    const r = renderComposer({ input: "x".repeat(200), caret: 200, width: 60, status: "  s" });
    // The caret column stays inside the box -- but now because the text came
    // down to it, not because the text slid out from under it. The field is as
    // many rows as 200 characters need at this measure, and the first of them
    // still starts at buffer index 0: nothing has scrolled off to the left.
    expect(r.caretCol).toBeLessThan(60);
    expect(r.caretCol).toBeGreaterThan(5);
    expect(r.lines.length).toBeGreaterThan(5); // gap, rule, >1 field row, rule, status
    const textW = composerTextWidth(60);
    expect(stripAnsi(r.lines[2]!)).toContain("x".repeat(textW));
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
    expect(confirm).toContain(`${glyph("selection")} 1st gear`);
    expect(confirm).toContain("every action asks first");
    expect(confirm).toContain("gemini-2.5-flash"); // live state, not the header's
    expect(confirm).toContain("? keys");
    expect(confirm).not.toMatch(/autonomy/i);

    // The right edge carries the keys that act NOW, and only those (founder,
    // 2026-09-26: no unnecessary information): `? keys` at rest with an empty
    // field, `esc stop` while a turn runs, what enter and esc do to a draft
    // typed mid-turn -- and nothing over a draft at rest, where `?` types a `?`.
    setTermWidthOverride(160);
    try {
      const wide = stripAnsi(statusLine({ ...base, mode: "confirm" }, 160));
      expect(wide).toContain("every action asks first");
      expect(wide).toContain("? keys");
      expect(wide).not.toContain("shift+tab gear"); // the key sheet and the banner say it
      const running = stripAnsi(statusLine({ ...base, mode: "confirm", streaming: true }, 160));
      expect(running).toContain("esc stop");
      expect(running).not.toContain("? keys");
      const typing = stripAnsi(
        statusLine({ ...base, mode: "confirm", streaming: true, drafting: true }, 160),
      );
      expect(typing).toContain(`enter sends ${glyph("observed")} esc clears`);
      expect(
        stripAnsi(statusLine({ ...base, mode: "confirm", drafting: true }, 160)),
      ).not.toContain("? keys");
    } finally {
      setTermWidthOverride(null);
    }

    expect(stripAnsi(statusLine({ ...base, mode: "autonomy-i" }, 120))).toContain(
      `${glyph("selection").repeat(2)} 2nd gear`,
    );
    // The model rides here now, so the gear label is still present but the
    // description may yield to it at narrower widths.
    expect(stripAnsi(statusLine({ ...base, mode: "autonomy-ii" }, 120))).toContain(
      `${glyph("selection").repeat(3)} 3rd gear`,
    );
    expect(stripAnsi(statusLine({ ...base, mode: "autonomy-iii" }, 120))).toContain(
      `${glyph("selection").repeat(4)} 4th gear`,
    );
    expect(stripAnsi(statusLine({ ...base, mode: "auto" }, 120))).toContain("* Auto mode");
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
    expect(line).toContain("? keys");
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
    expect(auto).toMatch(/\* Auto mode/);
    // The banner has to say both halves or it is misleading: no prompts, AND
    // something is still watching. Either one alone reads as a different mode.
    expect(auto).toMatch(/without permission prompts/i);
    expect(auto).toMatch(/watcher/i);
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
    expect(joined).toMatch(/bash \u00b7 (sandboxed|host)/); // the posture is stated, never assumed
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
          "No, tell Rune what to change",
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
    expect(stripAnsi(r.lines[2])).toContain("›"); // selected = index 1 → line 2
    expect(stripAnsi(r.lines[1])).not.toContain("›");
    // The keys are said once, in the legend under the list.
    expect(stripAnsi(r.lines.at(-1)!)).toContain("enter select");
    expect(stripAnsi(r.lines.at(-1)!)).toContain("esc close");
    expect(stripAnsi(r.lines[0])).not.toContain("esc close");
    expect(r.caretRow).toBe(2);
  });

  it("a picker hint yields by whole segments, and goes entirely below twelve cells", () => {
    const title = "fix the failing test in this repo, run bun test to prove…";
    const items = [
      { label: "*  Start a new session", hint: "fresh start" },
      { label: title, hint: "gpt-oss:120b | 35 events | 9.3k tokens" },
    ];
    const rowAt = (cols: number): string => {
      setTermWidthOverride(cols);
      try {
        return stripAnsi(renderPicker("Resume a session", items, 0, cols).lines[2] ?? "");
      } finally {
        setTermWidthOverride(null);
      }
    };
    // 80 columns: room for the first segment whole, or for nothing -- never
    // the fragment "gpt-oss…" this rule exists to prevent.
    expect(rowAt(80)).toContain(title);
    expect(rowAt(80)).not.toMatch(/gpt-oss(?!:120b)/);
    expect(rowAt(80)).not.toContain("35 events");
    // 100 columns: the model and the count fit, the tokens do not, and the
    // cut is at a bar, never inside a word.
    expect(rowAt(100)).toContain("gpt-oss:120b | 35 events");
    expect(rowAt(100)).not.toContain("tokens");
    expect(rowAt(100)).not.toMatch(/\|\s*$/);
    // 140 columns: everything.
    expect(rowAt(140)).toContain("gpt-oss:120b | 35 events | 9.3k tokens");
  });
  it("windows tall pickers to the terminal height and retains the selected row", () => {
    const items = Array.from({ length: 30 }, (_, i) => ({ label: `item ${i}` }));
    const r = renderPicker("Pick", items, 23, 40, 7);
    expect(r.lines).toHaveLength(7);
    expect(stripAnsi(r.lines.join("\n"))).toContain("item 23");
    expect(stripAnsi(r.lines[r.caretRow]!)).toContain("›");
  });

  it("keeps the settings title, selection and hints within the footer including its footnote", () => {
    const items = Array.from({ length: 18 }, (_, i) => ({ label: `setting ${i}` }));
    for (const height of [3, 7, 20]) {
      for (const selected of [0, 9, 17]) {
        const r = renderPicker("Settings", items, selected, 80, height, {
          footnote: "Changes apply now and are saved.",
        });
        expect(r.lines.length).toBeLessThanOrEqual(height);
        expect(stripAnsi(r.lines[0]!)).toContain("settings");
        expect(stripAnsi(r.lines[r.caretRow]!)).toContain(`setting ${selected}`);
        expect(stripAnsi(r.lines.at(-1)!)).toContain("enter select");
        expect(r.lines.some((line) => stripAnsi(line).includes("Changes apply now"))).toBe(
          height >= 4,
        );
      }
    }
  });
});

describe("ui/composer footer filesEdited readout", () => {
  it("shows the session's edited-file count once files change", () => {
    // A window with room for everything: the count is a session fact, the
    // first thing the ladder gives up, so it needs the width to be seen.
    setTermWidthOverride(140);
    try {
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
    } finally {
      setTermWidthOverride(null);
    }
  });

  it("gives the session facts up before the context meter, which is a state", () => {
    const line = stripAnsi(
      statusLine(
        { model: "m", workspace: "/w", mode: "gear-2", filesEdited: 3, contextPercent: 93 },
        80,
      ),
    );
    expect(line).toContain("93% context");
    expect(line).not.toContain("files edited");
  });
});

describe("the gear ladder", () => {
  // The count is the information: one mark per gear, readable at a glance
  // without parsing the label. A gap anywhere in the sequence makes that gear
  // look like a different product.
  it("is a counting sequence with no gaps", () => {
    const { modeInfo } = require("../../../packages/orchestrator/src/bin/ui/composer");
    expect(modeInfo("gear-1").arrows).toBe(glyph("selection"));
    expect(modeInfo("gear-2").arrows).toBe(glyph("selection").repeat(2));
    expect(modeInfo("gear-3").arrows).toBe(glyph("selection").repeat(3));
    expect(modeInfo("gear-4").arrows).toBe(glyph("selection").repeat(4));
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

describe("the Auto chip — only decisions that changed something", () => {
  it("says nothing about a routine approval", () => {
    // The case that buried the work: a burst of safe-listed reads, each one
    // printing a row to say the harness allowed what it always allows.
    expect(autoApprovedChip({ toolName: "read_file", risk: "low", tier: "safe" })).toBe("");
    expect(
      autoApprovedChip({ toolName: "bash", risk: "medium", tier: "classifier", kind: "approved" }),
    ).toBe("");
  });

  it("still records a containment, a redirect, and a deferral", () => {
    const contained = stripAnsi(
      autoApprovedChip({ toolName: "bash", risk: "high", kind: "contained", route: "sandboxed" }),
    );
    expect(contained).toContain("contained");
    expect(contained).toContain("kept inside the sandbox");
    // The row says what happened to the work, never which tier scored it.
    expect(contained).not.toContain("risk");

    const redirected = stripAnsi(
      autoApprovedChip({
        toolName: "bash",
        risk: "medium",
        kind: "redirected",
        substitute: "rg --files",
      }),
    );
    expect(redirected).toContain("redirected");
    expect(redirected).toContain("ran instead: rg --files");

    expect(
      stripAnsi(autoApprovedChip({ toolName: "web_fetch", risk: "high", kind: "deferred" })),
    ).toContain("held for you");
  });

  it("tells a halt in terms of the run, not the classifier that fired", () => {
    const halted = stripAnsi(
      autoApprovedChip({
        toolName: "bash",
        risk: "critical",
        kind: "halted",
        route: "supervisor_halt",
      }),
    );
    expect(halted).toContain("run halted");
    expect(halted).toContain("the run stopped here");
    expect(halted).toContain("nothing further ran");
    // Neither the internal routing token nor the risk score is the user's
    // business on the row -- both are in the audit log and /details.
    expect(halted).not.toContain("supervisor_halt");
    expect(halted).not.toContain("risk");
  });
});

// Depth belongs beside the model in the pinned status line: the same
// gpt-5.6-sol at "low" and at "max" are not the same collaborator, and that
// difference used to be invisible everywhere in the product. The banner is
// committed scrollback and goes stale the moment /model switches; this region
// redraws every frame, so live state put here is live by construction.
describe("ui/composer statusLine — thinking depth", () => {
  const wide = 200;

  it("rides beside the model when the provider has the dial", () => {
    const out = stripAnsi(
      statusLine({ model: "gpt-5.6-sol", effort: "max", workspace: "/w" }, wide),
    );
    expect(out).toContain("gpt-5.6-sol");
    expect(out).toContain("max");
  });

  it("says nothing when the model has no dial, rather than printing a lie", () => {
    // Anthropic and Google ignore the effort field entirely; a readout there
    // would name a control that does not exist.
    const out = stripAnsi(statusLine({ model: "claude-sonnet-4-6", workspace: "/w" }, wide));
    expect(out).toContain("claude-sonnet-4-6");
    expect(out).not.toContain("high");
  });

  it("keeps the model name when the width forces a choice", () => {
    // Squeezed, a model's identity outranks its dial.
    const out = stripAnsi(statusLine({ model: "gpt-5.6-sol", effort: "max", workspace: "/w" }, 44));
    expect(out).toContain("gpt-5.6-sol");
  });
});

// ─── The wrapped field (Phase 4B, lane C) ───
//
// The field used to be one row that scrolled sideways: of four hundred typed
// characters you could see forty, and no amount of arrowing back showed you the
// sentence you were in the middle of. It wraps now, grows upward into the panel
// to the region's cap, and past that scrolls inside itself. Everything below is
// a property of that, and the two that matter most are the ones a reader cannot
// check by eye: every buffer index has a cell, and the caret is always in one
// that is on screen.

/** The right column of the 120x40 frame: 40 cells, so a 36-column field. */
const COLUMN_WIDTH = PANEL_COLS + 1;

/** Field rows only: everything between the two rules. Found rather than
 *  counted, because the status line below the lower rule is optional. */
function fieldRows(lines: string[]): string[] {
  const plain = lines.map((l) => stripAnsi(l));
  const isRule = (s: string): boolean => /^\s*[\u2500-]+\s*$/.test(s) && s.trim().length > 4;
  const bottom = plain.findLastIndex(isRule);
  return plain.slice(2, bottom);
}

describe("ui/composer — wrapComposer, the grid", () => {
  it("maps every buffer index to a cell, and back, in a wrapped buffer", () => {
    // The round-trip is the whole contract of the caret. It is checked for
    // EVERY index of every shape the field has to survive -- prose that breaks
    // on spaces, a word longer than the measure, runs of spaces, explicit
    // newlines, a chip, an empty buffer -- because the interesting failures are
    // all at boundaries, and a spot check lands between them.
    const shapes = [
      "",
      "a",
      "hello world",
      "x".repeat(500),
      "aaaaaa", // an exact multiple of a 6-cell field
      "one\ntwo\nthree",
      "\n\n\n",
      "line one\n\nline three after a blank\n",
      `prose before ${pasteChip(1, "l\n".repeat(38))} prose after, going on a while`,
      "   leading   and   interior   runs   of   spaces   everywhere   here",
      "supercalifragilisticexpialidocioussupercalifragilisticexpialidocious short",
      "trailing space at the very end ",
      "word ".repeat(40),
    ];
    for (const input of shapes) {
      for (const textW of [1, 2, 3, 7, 12, 36, 73]) {
        const grid = wrapComposer(input, textW);
        for (const row of grid) expect(row.end - row.start).toBeLessThanOrEqual(textW);
        for (let i = 0; i <= input.length; i++) {
          if (input[i] === "\n") continue; // a newline is structure, not a cell
          const pos = composerCaret(grid, i);
          expect(composerIndex(grid, pos)).toBe(i);
          // No caret is ever stranded at column `textW`, which is one past the
          // last cell the field owns.
          expect(pos.col).toBeLessThan(textW);
          expect(pos.row).toBeGreaterThanOrEqual(0);
          expect(pos.row).toBeLessThan(Math.max(1, grid.length));
        }
      }
    }
  });

  it("keeps every character of the buffer except the spaces a break ate", () => {
    const input = "the quick brown fox jumps over the lazy dog and keeps going";
    const grid = wrapComposer(input, 12);
    const shown = new Set<number>();
    for (const r of grid) for (let k = r.start; k < r.end; k++) shown.add(k);
    for (let i = 0; i < input.length; i++) {
      if (shown.has(i)) continue;
      // The only thing a wrap may drop is the single space it broke on, and
      // the row above it still has a column for that index.
      expect(input[i]).toBe(" ");
      expect(grid.some((r, k) => r.end === i && grid[k + 1]?.start === i + 1)).toBe(true);
    }
  });

  it("spends a newline on ending a row and never renders it", () => {
    const grid = wrapComposer("ab\ncd", 20);
    expect(grid).toEqual([
      { start: 0, end: 2 },
      { start: 3, end: 5 },
    ]);
    const r = renderComposer({ input: "ab\ncd", caret: 5, width: 40, status: "" });
    const rows = fieldRows(r.lines);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("ab");
    expect(rows[1]).toContain("cd");
    for (const row of rows) expect(row).not.toContain("\n");
  });

  it("gives a paste chip a row of its own, unbroken", () => {
    const chip = pasteChip(1, "line\n".repeat(38));
    expect(chip).toBe("[Pasted text #1 +39 lines]");
    const input = `before the paste ${chip} and the sentence that follows it`;
    const grid = wrapComposer(input, 36);
    const at = input.indexOf(chip);
    const chipRow = grid.find((r) => r.start === at);
    expect(chipRow).toBeDefined();
    // Unbroken: one row holds the whole chip. The space after it is the chip
    // row's, so the prose below is not indented by a cell nobody typed.
    expect(input.slice(chipRow!.start, chipRow!.end)).toBe(`${chip} `);
    const next = grid[grid.indexOf(chipRow!) + 1]!;
    expect(input.slice(next.start, next.end).startsWith("and")).toBe(true);
  });
});

describe("ui/composer — the field grows, then scrolls", () => {
  it("caps a 500-char input at 40 cells to the row budget, caret still visible", () => {
    setTermWidthOverride(COLUMN_WIDTH + 1);
    try {
      const input = "x".repeat(500);
      const textW = composerTextWidth(COLUMN_WIDTH);
      expect(textW).toBe(36);
      const want = wrapComposer(input, textW).length;
      expect(want).toBe(14); // 500 chars is fourteen rows the field would like
      const r = renderComposer({
        input,
        caret: 500,
        width: COLUMN_WIDTH,
        status: "",
        maxRows: 8,
      });
      const rows = fieldRows(r.lines);
      expect(rows).toHaveLength(8); // exactly the cap, never one row more
      // One row of the eight states the elision, and states it as a count.
      expect(rows[0]).toContain(`${want - 7} lines above`);
      expect(rows[0]).toContain(glyph("elision"));
      // The caret is on a drawn row, and inside it.
      const caretRow = r.caretRow - 2;
      expect(caretRow).toBeGreaterThanOrEqual(0);
      expect(caretRow).toBeLessThan(rows.length);
      expect(r.caretCol).toBeLessThan(rows[caretRow]!.length);
    } finally {
      setTermWidthOverride(null);
    }
  });

  it("keeps the caret on screen at EVERY position of a long capped draft", () => {
    setTermWidthOverride(COLUMN_WIDTH + 1);
    try {
      const input = "word ".repeat(120);
      for (let caret = 0; caret <= input.length; caret += 7) {
        const r = renderComposer({ input, caret, width: COLUMN_WIDTH, status: "", maxRows: 6 });
        const rows = fieldRows(r.lines);
        expect(rows).toHaveLength(6);
        const caretRow = r.caretRow - 2;
        expect(caretRow).toBeGreaterThanOrEqual(0);
        expect(caretRow).toBeLessThan(rows.length);
        expect(r.caretCol).toBeLessThan(rows[caretRow]!.length);
      }
    } finally {
      setTermWidthOverride(null);
    }
  });

  it("states the elision on the side the rows went, and both when both", () => {
    // The window is the tail by default, so the count is "above". ctrl+a sends
    // the caret to the top, and a field that then dropped its tail in silence
    // would be lying about how much had been written -- so it says "below".
    expect(composerWindow(20, 19, 8)).toEqual({ top: 13, count: 7, above: 13, below: 0 });
    expect(composerWindow(20, 0, 8)).toEqual({ top: 0, count: 7, above: 0, below: 13 });
    expect(composerWindow(20, 6, 8)).toEqual({ top: 6, count: 7, above: 6, below: 7 });
    // Whatever the caret is doing, the field costs the same rows.
    for (let caret = 0; caret < 20; caret++) {
      const w = composerWindow(20, caret, 8);
      expect(w.count + (w.above > 0 || w.below > 0 ? 1 : 0)).toBe(8);
      expect(caret).toBeGreaterThanOrEqual(w.top);
      expect(caret).toBeLessThan(w.top + w.count);
    }
    // Under the cap nothing is hidden and nothing is claimed to be.
    expect(composerWindow(4, 3, 8)).toEqual({ top: 0, count: 4, above: 0, below: 0 });
  });

  it("puts the below-marker under the rows, where the rows went", () => {
    setTermWidthOverride(COLUMN_WIDTH + 1);
    try {
      const input = "word ".repeat(60);
      const r = renderComposer({ input, caret: 0, width: COLUMN_WIDTH, status: "", maxRows: 5 });
      const rows = fieldRows(r.lines);
      expect(rows).toHaveLength(5);
      expect(rows[0]).toContain("word"); // the top of the draft, where the caret is
      expect(rows[4]).toContain("lines below");
      expect(r.caretRow).toBe(2); // first field row, no marker above it
    } finally {
      setTermWidthOverride(null);
    }
  });

  it("grows by taking rows from the PANEL and never from the workspace", () => {
    // The invariant lane A's geometry exists to hold. Every field height the
    // composer can ask for is fed through regions(), and the workspace row
    // count must not move -- the transcript is stored rendered, so a workspace
    // that resized under a keystroke would re-wrap the whole session.
    const at = (composerRows: number) =>
      regions({
        columns: 120,
        rows: 40,
        headerRows: 3,
        composerRows,
        strip: true,
        layout: "split",
      });
    const rest = at(4);
    expect(rest.workspaceRows).toBe(36);
    expect(rest.panelRows).toBe(32);
    const cap = at(rest.bandRows).composerRows;
    expect(cap).toBe(21); // §2.1: 21 rows at most, leaving the panel 15
    for (let want = 4; want <= 60; want++) {
      const r = at(want);
      expect(r.workspaceRows).toBe(rest.workspaceRows);
      expect(r.composerRows).toBeLessThanOrEqual(cap);
      expect(r.composerRows + r.panelRows).toBe(r.bandRows);
      expect(r.panelRows).toBeGreaterThanOrEqual(8);
    }
    // What the field itself may draw inside that region: the cap less this
    // region's chrome (two rules and the hint row).
    setTermWidthOverride(COLUMN_WIDTH + 1);
    try {
      const r = renderComposer({
        input: "word ".repeat(200),
        caret: 0,
        width: COLUMN_WIDTH,
        status: "",
        maxRows: cap - 3,
      });
      expect(fieldRows(r.lines)).toHaveLength(cap - 3);
    } finally {
      setTermWidthOverride(null);
    }
  });
});

describe("ui/composer — no row reaches the measure", () => {
  it("wraps at the pane width at 80 columns and at the 40-cell column", () => {
    // 80 columns: the right column has collapsed, so the composer is the full
    // width of the window -- and still ends short of it, because a row that
    // touches the last cell wraps, and a wrap desyncs the pinned region.
    setTermWidthOverride(79); // contentCols() at an 80-column window
    try {
      // The wrap column is the field's own measure, and every row is exactly
      // it plus the four chrome columns -- so the wrap point and the row width
      // cannot drift apart, whatever flow's surface measure is tuned to.
      const textW = composerTextWidth(79);
      expect(textW).toBeGreaterThanOrEqual(70);
      const r = renderComposer({ input: "word ".repeat(80), caret: 10, width: 79, status: "" });
      for (const l of r.lines) expect(stripAnsi(l).length).toBeLessThan(80);
      const rows = fieldRows(r.lines);
      expect(rows.length).toBeGreaterThan(4);
      for (const row of rows) expect(row.length).toBe(textW + 4);
      for (const row of wrapComposer("word ".repeat(80), textW)) {
        expect(row.end - row.start).toBeLessThanOrEqual(textW);
      }
    } finally {
      setTermWidthOverride(null);
    }
    setTermWidthOverride(COLUMN_WIDTH + 1);
    try {
      const r = renderComposer({
        input: "word ".repeat(80),
        caret: 10,
        width: COLUMN_WIDTH,
        status: "",
        maxRows: 18,
      });
      for (const l of r.lines) expect(stripAnsi(l).length).toBeLessThanOrEqual(COLUMN_WIDTH - 1);
    } finally {
      setTermWidthOverride(null);
    }
  });

  it("shows a stray control byte as a space rather than desyncing the row", () => {
    const r = renderComposer({ input: "a\x07b\x1bc", caret: 5, width: 40, status: "" });
    const rows = fieldRows(r.lines);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("a b c");
  });
});

describe("ui/composer — ctrl+b, the explicit newline", () => {
  /** `editComposer` with the smallest `this` it actually reads. */
  function composer(input = "", caret = input.length) {
    const state: Record<string, unknown> = { input, caret, scroll: 4 };
    state.insert = INPUT_METHODS.insert.bind(state as never);
    return {
      state,
      key: (k: unknown): boolean => INPUT_METHODS.editComposer.call(state as never, k as never),
    };
  }

  it("inserts a real \\n that survives the trim submit() does", () => {
    const c = composer();
    for (const ch of "first") c.key({ type: "char", value: ch });
    expect(c.key({ type: "ctrl", name: "b" })).toBe(true);
    for (const ch of "second") c.key({ type: "char", value: ch });
    expect(c.state.input).toBe("first\nsecond");
    // submit() expands the chips and trims the ends; an interior newline is
    // the message, not whitespace around it.
    expect(expandPastes(c.state.input as string, new Map()).trim()).toBe("first\nsecond");
    expect(c.state.scroll).toBe(0); // typing returns to the live tail
  });

  it("leaves every other ctrl key to the handler that owns it", () => {
    // ctrl+c clears then arms then exits; ctrl+u kills to the start; ctrl+p
    // recalls history. editComposer swallowing them would be a dead keyboard.
    const c = composer("draft");
    for (const name of ["c", "d", "u", "a", "e", "l", "p", "n", "f", "w", "r", "o"]) {
      expect(c.key({ type: "ctrl", name })).toBe(false);
    }
    expect(c.state.input).toBe("draft");
  });

  it("is not shift+enter and not ctrl+j: those are Enter at the wire", () => {
    // A terminal never sends the shift, and ctrl+j / ctrl+m ARE \n / \r --
    // keys.ts turns both into {type:"enter"} before a handler sees them, which
    // is why the widely-suggested binding cannot be built. ctrl+b was free.
    const c = composer();
    expect(c.key({ type: "enter" })).toBe(false);
    expect(c.state.input).toBe("");
  });
});

describe("ui/composer — a collapsed paste keeps its newlines", () => {
  it("is one chip row in the field and expands verbatim on submit", () => {
    const body = Array.from({ length: 38 }, (_, i) => `line ${i + 1}`).join("\n");
    expect(body.split("\n")).toHaveLength(38);
    const chip = pasteChip(1, body);
    expect(chip).toBe("[Pasted text #1 +38 lines]");
    setTermWidthOverride(COLUMN_WIDTH + 1);
    try {
      const input = `read this ${chip} and say what it does`;
      const r = renderComposer({
        input,
        caret: input.length,
        width: COLUMN_WIDTH,
        status: "",
        maxRows: 18,
      });
      const rows = fieldRows(r.lines);
      // The 38 lines cost ONE row, and that row is the chip alone.
      const chipRows = rows.filter((l) => l.includes("[Pasted text #1"));
      expect(chipRows).toHaveLength(1);
      expect(chipRows[0]!.trim()).toBe(chip);
      expect(rows).toHaveLength(3);
      // And the hint counts what the field shows, not what it holds.
      expect(composerCounts(input, composerTextWidth(COLUMN_WIDTH)).lines).toBe(3);
    } finally {
      setTermWidthOverride(null);
    }
    // Verbatim on submit: all 38 lines, in order, newlines intact.
    const expanded = expandPastes(`read this ${chip} and say what it does`, new Map([[1, body]]));
    expect(expanded).toBe(`read this ${body} and say what it does`);
    expect(expanded.split("\n")).toHaveLength(38);
  });
});

describe("ui/composer — the hint row", () => {
  const sep = ` ${glyph("observed")} `;

  it("says nothing at rest: the keys are said once, elsewhere", () => {
    // The resting legend restated the placeholder (`/ for commands`), the key
    // sheet and the status line's `? keys` (founder, 2026-09-26: "there should
    // not be unnecessary information"). The row now costs the frame nothing.
    const rest = { lines: 0, chars: 0 };
    for (const max of [10, 20, 36, 73]) {
      expect(composerHintRow({ streaming: false, counts: rest, max })).toBe("");
    }
    expect(composerHintRow({ streaming: false, counts: { lines: 1, chars: 32 }, max: 36 })).toBe(
      "",
    );
  });

  it("switches to counts once the draft has WRAPPED, not on the first keystroke", () => {
    expect(composerHintRow({ streaming: false, counts: { lines: 12, chars: 318 }, max: 36 })).toBe(
      `12 lines${sep}318 chars   ctrl+b line`,
    );
    for (const max of [10, 20, 30, 36, 50, 73]) {
      expect(
        stripAnsi(composerHintRow({ streaming: false, counts: { lines: 12, chars: 318 }, max }))
          .length,
      ).toBeLessThanOrEqual(Math.max(max, "12 lines".length));
    }
  });

  it("leaves a streaming turn's keys to the status line", () => {
    expect(composerHintRow({ streaming: true, counts: { lines: 1, chars: 9 }, max: 36 })).toBe("");
    // A wrapped draft typed during the turn still says how big it is.
    expect(composerHintRow({ streaming: true, counts: { lines: 3, chars: 90 }, max: 36 })).toBe(
      `3 lines${sep}90 chars   ctrl+b line`,
    );
  });
});

// Promoted from tests/verification/v4-laneC-wide-char-overflow.test.ts (V-4
// Lane C, C6). The wrap path measured in JS string units -- `.length` and
// `.slice` -- in a file that already imported `visLen` for everything else, so
// a row of double-width characters was a row of double-width CELLS: 36 CJK
// characters at the panel's 36-column field rendered 76 cells wide and bled
// across the divider into the panel. A hard break could also land between an
// astral emoji's two UTF-16 units and corrupt that glyph on screen.
describe("ui/composer — the field is measured in terminal cells, not string units", () => {
  it("a row of double-width characters stays inside the pane's cell budget", () => {
    setTermWidthOverride(COLUMN_WIDTH + 1);
    try {
      const textW = composerTextWidth(COLUMN_WIDTH);
      expect(textW).toBe(36); // the panel's known text width, so this tracks reality
      const cjk = "字".repeat(40); // one UTF-16 unit each, two display cells each
      const r = renderComposer({ input: cjk, caret: 0, width: COLUMN_WIDTH, status: "" });
      const paneBudget = COLUMN_WIDTH - 1; // the measure the rule and the edge are drawn at
      for (const row of fieldRows(r.lines)) {
        expect(visLen(row)).toBeLessThanOrEqual(paneBudget);
      }
    } finally {
      setTermWidthOverride(null);
    }
  });

  it("a hard break never lands inside a surrogate pair", () => {
    const emoji = "\u{1F600}".repeat(20); // no spaces, so every break is a hard one
    for (const textW of [3, 5, 7]) {
      for (const row of wrapComposer(emoji, textW)) {
        const piece = emoji.slice(row.start, row.end);
        if (!piece) continue;
        const first = piece.charCodeAt(0);
        const last = piece.charCodeAt(piece.length - 1);
        expect(last >= 0xd800 && last <= 0xdbff, `textW ${textW}`).toBe(false);
        expect(first >= 0xdc00 && first <= 0xdfff, `textW ${textW}`).toBe(false);
      }
    }
  });

  it("a glyph wider than the field gets a row of its own instead of being split", () => {
    // textW 1 cannot fit a 2-cell glyph at all. Progress still has to be made,
    // or the wrap loops forever -- the row overruns by one cell, visibly, which
    // is the honest failure for a field too narrow for one character.
    const grid = wrapComposer("字字字", 1);
    const filled = grid.filter((row) => row.end > row.start);
    expect(filled).toHaveLength(3); // one glyph per row, and the caret's tail row
    for (const row of filled) expect(row.end - row.start).toBe(1);
  });
});
