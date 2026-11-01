// The audit's T9 and T10 (2026-10-26): a first launch opened a configuration
// debugger, Esc from it left a default model with no key, and /config listed
// twenty-seven harness dials with values like `budget 0` for "no limit".
import { afterEach, describe, expect, it } from "bun:test";
import { COMMAND_METHODS } from "../../../packages/orchestrator/src/bin/ui/tui-commands";
import { Tui } from "../../../packages/orchestrator/src/bin/ui/tui";
import { stripAnsi } from "../../../packages/orchestrator/src/bin/ui/theme";
import { setTermWidthOverride } from "../../../packages/orchestrator/src/bin/ui/render";
import {
  CONFIG_SETTINGS,
  resolveSetting,
  settingInWords,
  settingLabel,
} from "../../../packages/orchestrator/src/config-settings";

afterEach(() => setTermWidthOverride(null));

const setting = (key: string) => CONFIG_SETTINGS.find((s) => s.key === key)!;

describe("settings say their values in words", () => {
  it("a spend cap of 0 is no limit, and money reads as money", () => {
    expect(settingLabel(setting("budget"))).toBe("spend cap");
    expect(settingInWords(setting("budget"), "0")).toBe("no limit");
    expect(settingInWords(setting("budget"), "5")).toBe("$5");
    expect(settingInWords(setting("subagent_budget"), "0.5")).toBe("$0.5");
  });

  it("a gear is the status line's own phrase, and an empty authority is none", () => {
    expect(settingLabel(setting("gear"))).toBe("permissions");
    expect(settingInWords(setting("gear"), "3")).toBe("3rd gear -- edits + sandboxed shell");
    expect(settingInWords(setting("controller_authority"), "")).toBe("none");
    expect(settingInWords(setting("shadow_controller"), "true")).toBe("on");
  });

  it("'no limit' can be typed back", () => {
    const resolved = resolveSetting("spend cap");
    expect(resolved?.key).toBe("budget");
  });
});

type Row = { label: string; hint?: string };

/** A `/config` rig: the real method, a picker that records what it was shown. */
function settingsRig(answers: Array<number | null>) {
  const shown: Array<{ title: string; rows: Row[] }> = [];
  const slashes: string[] = [];
  const values: Record<string, string> = { budget: "0", gear: "3", memory: "auto" };
  const t: any = {
    ctx: {
      engine: {
        readConfigSetting: (key: string) => values[key] ?? "",
        isBrowserEnabled: () => false,
      },
    },
    pick: async (title: string, rows: Row[]) => {
      shown.push({ title: stripAnsi(title), rows });
      return answers.length > 0 ? answers.shift()! : null;
    },
    handleSlash: async (cmd: string) => {
      slashes.push(cmd);
      return true;
    },
    print: () => {},
  };
  t.showSettings = COMMAND_METHODS.showSettings.bind(t);
  return { t, shown, slashes };
}

describe("/config is settings first, the harness behind Advanced", () => {
  it("the first page fits an 80x24 window and says its values in words", async () => {
    const { t, shown } = settingsRig([null]);
    await t.showSettings();
    const first = shown[0]!;
    expect(first.title).toBe("Settings");
    // 24 rows less the picker's own chrome: the whole page is visible.
    expect(first.rows.length).toBeLessThanOrEqual(14);
    const labels = first.rows.map((r) => r.label);
    for (const want of ["Model and reasoning", "Theme", "permissions", "memory", "spend cap"]) {
      expect(labels).toContain(want);
    }
    for (const harness of ["shadow controller", "controller authority", "evidence gate"]) {
      expect(labels).not.toContain(harness);
    }
    const cap = first.rows.find((r) => r.label === "spend cap")!;
    expect(cap.hint).toBe("no limit");
    expect(first.rows.at(-1)!.label).toBe("Advanced");
  });

  it("Advanced holds every other setting, and Esc from it comes back", async () => {
    const { t, shown } = settingsRig([-1, null, null]);
    // The first answer selects the last row (Advanced) -- resolved below.
    const pick = t.pick;
    t.pick = async (title: string, rows: Row[]) => {
      const r = await pick(title, rows);
      return r === -1 ? rows.length - 1 : r;
    };
    await t.showSettings();
    expect(shown.map((s) => s.title.split(" (")[0])).toEqual([
      "Settings",
      "Settings · Advanced",
      "Settings",
    ]);
    const everyday = CONFIG_SETTINGS.filter((s) => s.everyday).length;
    expect(shown[1]!.rows).toHaveLength(CONFIG_SETTINGS.length - everyday);
    expect(shown[1]!.rows.map((r) => r.label)).toContain("shadow controller");
  });
});

describe("a first launch asks which model, and nothing runs without one", () => {
  function loginRig(answer: number | null) {
    const printed: string[] = [];
    const picks: Array<{ title: string; rows: Row[]; footnote: string }> = [];
    const t: any = {
      ctx: { engine: { getCustomEndpoint: () => undefined } },
      print: (block: string) => printed.push(stripAnsi(block)),
      pick: async (title: string, rows: Row[], _i: number, _o: unknown, footnote: string) => {
        picks.push({ title: stripAnsi(title), rows, footnote: stripAnsi(footnote) });
        return answer;
      },
      searchConnected: () => false,
      runLoginFor: async () => {},
    };
    return { t, printed, picks };
  }

  it("offers the three ways to a model, and Esc says what it means", async () => {
    const { t, printed, picks } = loginRig(null);
    await COMMAND_METHODS.openLogin.call(t, { needModel: true });
    expect(printed[0]).toContain("Rune needs a model to talk to.");
    expect(picks[0]!.rows.map((r) => r.label)).toEqual(["Subscription", "API key", "Offline"]);
    expect(picks[0]!.footnote).toContain("nothing runs until a model is connected");
    expect(printed.at(-1)).toContain("/login connects one when you are ready");
  });

  it("asks the question once: reopening after a held message does not repeat it", async () => {
    const { t, printed } = loginRig(null);
    await COMMAND_METHODS.openLogin.call(t, { needModel: true });
    await COMMAND_METHODS.openLogin.call(t, { needModel: true });
    expect(printed.filter((p) => p.includes("needs a model to talk to"))).toHaveLength(1);
  });

  it("/login itself still offers web search", async () => {
    const { t, picks } = loginRig(null);
    await COMMAND_METHODS.openLogin.call(t);
    expect(picks[0]!.rows.map((r) => r.label)).toContain("Web search");
  });

  function submitRig(registered: string[]) {
    const t: any = Object.create(Tui.prototype);
    const printed: string[] = [];
    let opened = 0;
    let ran = 0;
    t.ctx = { engine: { getRegisteredProviders: () => registered } };
    t.input = "fix the failing test";
    t.caret = t.input.length;
    t.pastes = new Map();
    t.print = (block: string) => printed.push(stripAnsi(block));
    t.openLogin = async () => {
      opened++;
    };
    t.runInput = async () => {
      ran++;
    };
    t.gcPastes = () => {};
    t.scheduleDraw = () => {};
    return { t, printed, opened: () => opened, ran: () => ran };
  }

  it("a message sent with no model is kept, and the picker opens", async () => {
    const r = submitRig([]);
    await r.t.submit();
    expect(r.ran()).toBe(0);
    expect(r.opened()).toBe(1);
    expect(r.t.input).toBe("fix the failing test");
    expect(r.printed.join("\n")).toContain("connect a model first");
  });

  it("with a model connected the message runs as before", async () => {
    const r = submitRig(["codex"]);
    await r.t.submit();
    expect(r.ran()).toBe(1);
    expect(r.opened()).toBe(0);
    expect(r.t.input).toBe("");
  });

  it("a slash command is never held back -- /login is one", async () => {
    const r = submitRig([]);
    r.t.input = "/login";
    await r.t.submit();
    expect(r.ran()).toBe(1);
  });

  it("the status line names no model rather than a default with no key", () => {
    setTermWidthOverride(100);
    const t: any = Object.create(Tui.prototype);
    t.ctx = {
      workspaceRoot: "/tmp/ws",
      sessionId: "s",
      engine: {
        getRegisteredProviders: () => [],
        getModel: () => "nvidia/nemotron-3-ultra-550b-a55b:free",
        getReasoningEffortLabel: () => undefined,
        getContextUsage: () => ({ percent: 0 }),
        getLoopStatus: () => ({ count: 0, nextRunAt: null }),
        getPermissionMode: () => "gear-1",
        isSandboxEnabled: () => true,
      },
    };
    t.mode = "input";
    t.input = "";
    t.filesEdited = new Set();
    t.folds = { size: 0 };
    t.inline = false;
    t.agentsLegend = () => "";
    const line = stripAnsi(t.statusStr(100));
    expect(line).toContain("no model -- /login");
    expect(line).not.toContain("nemotron");
  });
});
