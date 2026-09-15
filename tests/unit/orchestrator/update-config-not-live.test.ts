/**
 * A setting that cannot be applied live can still be SAVED.
 *
 * `update_config` is the single writer behind `/config layout split`, the
 * `/config` picker and the model's own tool. It applied the value live first
 * and returned before the write when the live switch refused — which is right
 * for a machine that will not honour a change (org policy forbidding the 4th
 * gear), and wrong for a setting that was never meant to apply live.
 *
 * `layout` is the one such entry in the catalog: the transcript is stored
 * already rendered at the old measure, so flipping the frame mid-session would
 * re-wrap the whole history at a width it was never written for. `live: false`
 * said so, `live` was read nowhere, and `Engine.applyConfigSetting` has no
 * `case "layout"` — so every route to the setting answered "no live handler
 * for layout" and nothing ever reached config.toml. A shipped, catalogued,
 * picker-listed setting the product's own writer could not write.
 *
 * The UI lane's report said the value "still writes and persists correctly to
 * [ui] layout — only the current-value hint is wrong". Only the second half was
 * true.
 *
 * End to end through the real writer, the real catalog and the real config
 * loader, under a scratch RUNE_CONFIG_PATH. `~/.rune` is never opened.
 */

import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "../../../packages/shared/src/index";
import { Engine } from "../../../packages/orchestrator/src/engine";
import { runSettingsCommand } from "../../../packages/orchestrator/src/settings-command";
import { CONFIG_SETTINGS } from "../../../packages/orchestrator/src/config-settings";
import { createUpdateConfigTool } from "../../../packages/orchestrator/src/update-config-tool";
import {
  DEFAULT_UI_LAYOUT,
  resolveUiLayout,
} from "../../../packages/orchestrator/src/bin/ui/layout";

const saved = process.env.RUNE_CONFIG_PATH;
let home = "";
let cfg = "";

beforeEach(() => {
  home = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "rune-not-live-"));
  cfg = join(home, "config.toml");
  process.env.RUNE_CONFIG_PATH = cfg;
});

afterAll(() => {
  if (saved === undefined) delete process.env.RUNE_CONFIG_PATH;
  else process.env.RUNE_CONFIG_PATH = saved;
});

/** The live switch, recording what it was asked and refusing `layout` the way
 *  the real `Engine.applyConfigSetting` does — it has no arm for the key. */
function switchThatRefusesLayout() {
  const asked: string[] = [];
  return {
    asked,
    applyLive: (key: string, _value: string) => {
      asked.push(key);
      return key === "layout"
        ? { ok: false, reason: 'no live handler for "layout"' }
        : { ok: true };
    },
  };
}

/** A no-provider Engine over the scratch home — nothing here spends or dials out. */
const engineConfig = () => ({
  model: "gemini-2.5-flash",
  provider: "google" as const,
  workspaceRoot: home,
  dbPath: join(home, "rune.db"),
  toolsBinaryPath: "rune-tools",
  yoloMode: false,
  enableCheckpoints: false,
  enableSecurity: false,
  enableRateLimiting: false,
  enableHooks: false,
  enableMcp: false,
  enableSkills: false,
  enableVerification: false,
});

/** The `/config` row for one key, rendered by the real settings renderer. */
const settingsLine = async (engine: Engine, key: string) =>
  (await runSettingsCommand(engine, "list")).split("\n").find((l) => l.startsWith(key + ":"));

const run = (tool: ReturnType<typeof createUpdateConfigTool>, setting: string, value: string) =>
  tool.execute({
    toolName: "update_config",
    callId: "c1",
    sessionId: "s1",
    workspaceRoot: home,
    args: { setting, value },
  });

describe("a non-live setting persists", () => {
  test("layout is the catalog's one non-live entry", () => {
    const notLive = CONFIG_SETTINGS.filter((s) => !s.live).map((s) => s.key);
    expect(notLive).toEqual(["layout"]);
  });

  test("/config layout split writes [ui] layout and the live switch is never asked", async () => {
    const live = switchThatRefusesLayout();
    const out = await run(
      createUpdateConfigTool({ applyLive: live.applyLive, readSetting: () => undefined }),
      "layout",
      "split",
    );

    expect(out.success).toBe(true);
    expect(readFileSync(cfg, "utf8")).toContain('layout = "split"');
    // Not asked at all: there is nothing to apply, so a refusal is not news.
    expect(live.asked).toEqual([]);
    // And the sentence does not claim a change that did not happen.
    expect(out.result).toContain("next launch");
    expect(out.result).not.toContain("applied now");
  });

  test("the saved value is what the next launch reads", async () => {
    await run(
      createUpdateConfigTool({
        applyLive: switchThatRefusesLayout().applyLive,
        readSetting: () => undefined,
      }),
      "layout",
      "split",
    );
    // The real loader and the real resolver — the path rune-cli takes at boot.
    const config = loadConfig(home);
    expect(config.ui?.layout).toBe("split");
    expect(resolveUiLayout({ env: undefined, configured: config.ui?.layout })).toBe("split");
  });

  test("an alias is canonicalised on the way in, and so is the way back", async () => {
    const tool = createUpdateConfigTool({
      applyLive: switchThatRefusesLayout().applyLive,
      readSetting: () => undefined,
    });
    expect((await run(tool, "frame", "workspace")).success).toBe(true);
    expect(loadConfig(home).ui?.layout).toBe("split");
    expect((await run(tool, "layout", "classic")).success).toBe(true);
    expect(loadConfig(home).ui?.layout).toBe("single");
  });

  test("with nothing written, the launch default is unchanged", () => {
    expect(existsSync(cfg)).toBe(false);
    expect(resolveUiLayout({ env: undefined, configured: loadConfig(home).ui?.layout })).toBe(
      DEFAULT_UI_LAYOUT,
    );
  });

  test("a LIVE setting still refuses to persist when the machine says no", async () => {
    // The behaviour the early return existed for, kept exactly: a value the
    // machine will not honour must not be written as though it took.
    const tool = createUpdateConfigTool({
      applyLive: () => ({ ok: false, reason: "org policy forbids it" }),
      readSetting: () => undefined,
    });
    const out = await run(tool, "gear", "4");
    expect(out.success).toBe(false);
    expect(out.error ?? out.result).toContain("org policy forbids it");
    expect(existsSync(cfg) ? readFileSync(cfg, "utf8") : "").not.toContain("gear");
  });

  test("a live setting that the machine accepts still says it applied now", async () => {
    const tool = createUpdateConfigTool({
      applyLive: () => ({ ok: true }),
      readSetting: () => undefined,
    });
    const out = await run(tool, "doctrine", "jit");
    expect(out.success).toBe(true);
    expect(out.result).toContain("applied now");
  });
});

// ─── …and the hint says what was written ───
//
// Lane D's LOW #30: `Engine.readConfigSetting` had no `case "layout"`, so
// `/config` showed `layout: per effort` — the placeholder for a key the engine
// cannot answer — beside a value that is now genuinely written and honoured.
// Lane D prescribed `this.config.ui?.layout`; `ui` is on RuneConfig, not
// EngineConfig, so the arm reads the file the writer writes.

describe("the /config hint reads the written layout back", () => {
  test("`per effort` is what an unanswered key looks like, and layout is answered", async () => {
    const engine = new Engine(engineConfig());
    try {
      // Nothing written: the launch default, never undefined.
      expect(engine.readConfigSetting("layout")).toBe(DEFAULT_UI_LAYOUT);
      expect(await settingsLine(engine, "layout")).toBe(`layout: ${DEFAULT_UI_LAYOUT}`);
      // A key the engine genuinely cannot answer still renders the placeholder,
      // so the assertion above is about `layout` and not about the renderer.
      expect(engine.readConfigSetting("no_such_setting")).toBeUndefined();

      await run(
        createUpdateConfigTool({
          applyLive: switchThatRefusesLayout().applyLive,
          readSetting: (k) => engine.readConfigSetting(k),
        }),
        "layout",
        "split",
      );
      expect(engine.readConfigSetting("layout")).toBe("split");
      expect(await settingsLine(engine, "layout")).toBe("layout: split");
    } finally {
      engine.close();
    }
  });

  test("a typo in config.toml reads back as the default, not as the typo", async () => {
    const engine = new Engine(engineConfig());
    try {
      writeFileSync(cfg, '[ui]\nlayout = "hexagonal"\n');
      expect(engine.readConfigSetting("layout")).toBe(DEFAULT_UI_LAYOUT);
    } finally {
      engine.close();
    }
  });
});
