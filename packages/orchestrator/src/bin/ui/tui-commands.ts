// ─── The frame: slash commands ───
// Split out of tui.ts. `/`-commands and the panels they open: the catalogue the
// palette reads, the one big `handleSlash` dispatch, the model tree, the
// settings and sandbox pickers, the login flow and the key sheet.
//
// This is the largest of the three halves and the one that grows every time a
// command is added, which is exactly why it is no longer sharing a file with
// the paint loop.
//
// Mixed onto `Tui.prototype` at the bottom of tui.ts; see ./tui-frame.ts for
// why the `this: Tui` parameter is there.

import type { Tui } from "./tui";
import { findCommand } from "../../commands";
import { discoverUserSkills, ORIGIN_LABEL } from "../../skills-user";
import {
  hasStoredCredential,
  openCredentialStore,
  setActiveProviderKey as persistSetActiveKey,
  providerKeyEntries as readProviderKeyEntries,
  setCustomEndpoint as persistCustom,
  setProviderDisabled as persistDisabled,
  setLocalEndpoint as persistLocalEndpoint,
  getPreset,
  getSearchPreset,
  PROVIDER_PRESETS,
  SEARCH_PROVIDER_PRESETS,
  searchProviderConnected,
  CUSTOM_PROVIDER_ID,
  loadLastModel,
  loadPrefs,
  savePrefs,
  saveLastModel,
  saveBrowserState,
  describeMemoryMode,
  isWithdrawnCadence,
  MEMORY_CADENCE_REFUSAL,
} from "@rune/shared";
import type { CustomEndpoint } from "@rune/shared";
import type { ReasoningEffort } from "@rune/llm-gateway";
import { routeChoices, loginTargets, connectedSummary, type LoginTarget } from "./login-picker";
import { getStrategy, type AuthContext } from "@rune/llm-gateway";
import { probeSearchBackend } from "@rune/tool-registry";
import { openBrowser } from "../byop-cli-shared";
import {
  providerChoices,
  accountChoices,
  modelChoices,
  effortChoices,
  fetchLiveModels,
} from "./model-picker";
import { configModeToPermissionMode } from "../../permissions";
import { CONFIG_SETTINGS, displaySettingValue, settingChoices } from "../../config-settings";
import { runSettingsCommand } from "../../settings-command";
import { settingsPickerChrome } from "../../first-run";
import {
  runSandboxCommand,
  SANDBOX_MODE_CHOICES,
  SANDBOX_OVERRIDE_CHOICES,
} from "../../sandbox-command";
import { runTeamCommand } from "../../team/command";
import { join } from "node:path";
import {
  modeInfo,
  sandboxModeBanner,
  browserModeBanner,
  type PickerItem,
  type SlashItem,
  type KeyRow,
} from "./composer";
import { renderStatus } from "./status";
import * as F from "./flow";
import { truncate, visLen } from "./render";
import { formatLoopDue, formatLoopInterval, loopPromptPreview } from "../../loop-mode";
import {
  bold,
  text,
  muted,
  faint,
  info,
  ok,
  accent,
  danger,
  warn,
  setTheme,
  getTheme,
  getFinish,
  setFinish,
  setAppearanceChosen,
  stripAnsi,
} from "./theme";
import { THEME_CHOICES, finishLabel, parseThemeChoice, themeChoiceIndex } from "./themes";
import { formatCostReport, formatRunEconomics } from "../../cost-report";
import { glyph } from "./glyphs";
import { mcpPanel } from "./mcp-panel";
import { saveTheme } from "./theme-store";
import { renderWorkspaceDiff } from "./workspace-diff";
import { buildInteractiveDirective, saveInteractiveAuto } from "./interactive";
import { cols, rowsCount } from "./tui-frame";
/**
 * Put a transcript row back in the gutter every other row keeps.
 *
 * `/config`'s confirmation was the one row in the TUI that started at column 0
 * (frame `80x24-settings-saved`, 2026-09-10): `runSettingsCommand` returns the
 * raw `update_config` result and `print` writes exactly what it is given, while
 * every neighbouring call passes a string that already begins with two spaces.
 * Indenting at the call site rather than inside the command keeps the string
 * the model's tool returns identical to the one the terminal shows.
 */
export function transcriptGutter(block: string): string {
  return block
    .split("\n")
    .map((line) => (line.trim() === "" ? "" : `  ${line}`))
    .join("\n");
}

/** Slash commands and the panels they open, mixed onto `Tui.prototype`. */
export const COMMAND_METHODS = {
  slashCatalog(this: Tui): SlashItem[] {
    // Ordered by what a person actually reaches for, not alphabetically and
    // not by when it was written. /theme led this list for a long time -- a
    // cosmetic toggle, above the two things (which model, how do I connect)
    // that decide whether the product works at all.
    //
    // What was REMOVED from the surface, and why:
    //   /providers /keys   folded into /login, which asks what you have instead
    //                      of what the system calls it.
    //   /research
    //   /deepresearch      research is already a TOOL the agent reaches for on
    //                      its own (see the doctrine's Research line). Two
    //                      commands that only set a mode taught users to drive
    //                      manually something the agent should decide.
    //   /rename            belongs to a session, so it lives in /sessions where
    //                      you can see which one you are renaming.
    //   /resume            /sessions already opens the picker.
    //   /autonomy          legacy alias for /gear.
    //   /mode              same thing as /gear, twice.
    // All of them still WORK when typed -- they are hidden, not deleted, so no
    // muscle memory or script breaks.
    const builtins: SlashItem[] = [
      { name: "/model", desc: "Choose model, provider, and thinking depth", tag: "settings" },
      {
        name: "/config",
        desc: "Settings: cost, reasoning, agents, sandbox and learning",
        tag: "settings",
      },
      { name: "/login", desc: "Connect a subscription, an API key, a local model, or web search" },
      { name: "/setup", desc: "Configure provider, model, key, search, spend, and sandbox" },
      { name: "/sessions", desc: "Browse, resume, rename, archive and delete", tag: "history" },
      {
        name: "/gear",
        desc: "Shift gears: 1, 2, 3, 4 or auto (empty shifts up)",
        tag: "shift+tab",
      },
      { name: "/diff", desc: "Inspect staged and uncommitted workspace changes", tag: "git" },
      { name: "/undo", desc: "Revert the last Rune auto-commit" },
      { name: "/rewind", desc: "Roll back the conversation" },
      { name: "/cost", desc: "Session cost" },
      { name: "/status", desc: "Session status" },
      { name: "/loop", desc: "Repeat a prompt while this session stays open" },
      { name: "/loops", desc: "List and manage this session's loops" },
      { name: "/team", desc: "Other Rune instances here: status, send, claim, intent" },
      { name: "/mcp", desc: "MCP connectors: health and tools, or reconnect <server>" },
      { name: "/skills", desc: "Browse or search available skills" },
      { name: "/memory", desc: "System memory: your evergreen profile" },
      { name: "/notebook", desc: "Learned tactics for this workspace" },
      { name: "/interactive", desc: "Live dashboard: [focus], auto on or off, open" },
      {
        name: "/sandbox",
        desc: "OS sandbox for commands: mode, override, exclude, config",
      },
      { name: "/browser", desc: "Agent web browser: on or off" },
      { name: "/compress", desc: "Summarize and shrink the context" },
      { name: "/theme", desc: "Dark or light, matte or crisp", tag: "cosmetic" },
      { name: "/bug", desc: "Flag a problem and record the flight trail" },
      { name: "/clear", desc: "Clear the screen" },
      { name: "/help", desc: "Show commands" },
      { name: "/quit", desc: "Exit Rune" },
    ];
    const custom: SlashItem[] = this.ctx.customCommands.map((c) => ({
      name: "/" + c.name,
      desc: c.description || "Custom command",
    }));
    return [...builtins, ...custom];
  },

  async handleSlash(this: Tui, raw: string): Promise<boolean> {
    const { engine } = this.ctx;
    const [cmd, ...rest] = raw.slice(1).split(" ");
    const arg = rest.join(" ").trim();

    switch (cmd) {
      case "setup": {
        if (!this.ctx.firstRun) {
          this.print(`  ${warn("Setup is unavailable in this launch.")}`);
          return true;
        }
        if (this.ctx.firstRun.done()) {
          this.print(`  ${warn("Setup has already closed; restart Rune and run /setup again.")}`);
          return true;
        }
        this.mode = "setup";
        this.input = "";
        this.caret = 0;
        this.setupReceipt = null;
        this.scheduleDraw();
        return true;
      }
      case "settings":
      case "config": {
        if (arg) this.print(transcriptGutter(await runSettingsCommand(engine, arg)));
        else await this.showSettings();
        return true;
      }
      case "quit":
      case "exit":
        this.exit(0);
        return true;
      case "clear":
        this.resetTranscript();
        return true;
      case "notebook": {
        const entries = engine.getNotebookEntries(10);
        if (entries.length === 0) {
          this.print(
            `  ${muted("Notebook is empty for this workspace -- Rune fills it as it verifies how your repos work.")}`,
          );
        } else {
          this.print(
            [
              `  ${bold(text("Notebook -- active for this workspace"))}`,
              ...entries.map(
                (e) =>
                  `    ${info(e.id.slice(-8))} ${muted(`[${e.scope}]`)} ${text(e.body.slice(0, 90))}`,
              ),
              `    ${muted("manage: rune notebook [show <id>|rm <id>|export]")}`,
            ].join("\n"),
          );
        }
        return true;
      }
      case "bug": {
        const rec = engine.getRecorder();
        if (!rec) {
          this.print(`  ${muted("Diagnostics are disabled ([diagnostics] enabled = false).")}`);
          return true;
        }
        const id = rec.record({
          class: "ux.user_reported",
          severity: "warn",
          component: "tui",
          where: "slash#bug",
          message: arg || "user flagged the last exchange (no note given)",
        });
        this.print(
          id
            ? `  ${text("* Logged with the current flight trail.")} ${muted(`rune incidents show ${id.slice(-8)}`)}`
            : `  ${muted("Could not record -- see rune doctor.")}`,
        );
        return true;
      }
      case "help": {
        // Grouped by what the person is doing, most-reached-for group first.
        // A flat list of 26 rows scrolled its own top half off a 24-row
        // window, so /help opened on /loop and /team and never showed /model
        // or /login (2026-09-10). Wide windows get two columns.
        const commands = this.slashCatalog();
        const groups: Array<[string, string[]]> = [
          ["work", ["/diff", "/undo", "/rewind", "/compress", "/clear", "/cost", "/status"]],
          ["setup", ["/model", "/login", "/config", "/theme"]],
          ["autonomy", ["/gear", "/sandbox", "/browser", "/interactive", "/loop", "/loops"]],
          ["knowledge", ["/memory", "/notebook", "/skills", "/mcp", "/team"]],
          ["session", ["/sessions", "/bug", "/help", "/quit"]],
        ];
        const placed = new Set(groups.flatMap(([, names]) => names));
        const custom = commands.filter((item) => !placed.has(item.name)).map((i) => i.name);
        if (custom.length > 0) groups.push(["custom", custom]);
        const byName = new Map(commands.map((item) => [item.name, item]));
        const nameWidth = Math.max(...commands.map((item) => item.name.length)) + 2;
        // The measure is the WORKSPACE's, not the window's (§2.8: `/help` is a
        // document committed to the workspace). `cols()` is the whole terminal,
        // and at 120 columns that put the two-column layout's right-hand column
        // at cells 62-116 of a 78-cell left column -- so every second command
        // was written and then clipped away by `bound()`, and the document was
        // missing half its rows with nothing to say it was.
        const width = this.contentCols();
        const rows: string[] = [`  ${bold(text("Commands"))}`];
        // A window too short for the full list gets one row per group, names
        // only: every command visible at once, descriptions in the palette as
        // you type. The full list on a 24-row window scrolled /model and
        // /login off the top before anyone read them.
        const fullRows = groups.reduce((n, [, names]) => n + 1 + names.length, 1);
        // Counted against the region the document lands in. `rowsCount() - 8`
        // is the footer layout's arithmetic -- the whole window, less the
        // header and the composer block -- and in the band those rows are
        // already gone: the workspace is what is left after them. Measured
        // against the window, a 36-row workspace that can hold all thirty-four
        // rows of the full list was told it could not, and a 120x40 terminal
        // got the compact names-only form it was wide and tall enough to
        // outgrow. Collapsed, `workspaceRows` is smaller than the old number
        // and the branch is the same one, so nothing at 80x24 moves.
        const usable = this.bandLayout()
          ? Math.max(4, this.regionsNow().workspaceRows - 2)
          : rowsCount() - 8;
        if (width < 110 && fullRows > usable) {
          for (const [label, names] of groups) {
            const present = names.filter((name) => byName.has(name));
            if (present.length === 0) continue;
            rows.push(`  ${faint(label.padEnd(10))}${present.map((name) => info(name)).join(" ")}`);
          }
          this.print(rows.join("\n"));
          return true;
        }
        for (const [label, names] of groups) {
          const items = names.map((name) => byName.get(name)).filter((i): i is SlashItem => !!i);
          if (items.length === 0) continue;
          rows.push(`  ${faint(label)}`);
          if (width < 64) {
            for (const item of items)
              rows.push(`    ${info(item.name)}`, `      ${muted(item.desc)}`);
            continue;
          }
          // Two columns when the window can hold two descriptions side by side.
          const colWidth = Math.floor((width - 4) / 2);
          const cell = (item: SlashItem): string =>
            `${info(item.name.padEnd(nameWidth))}${muted(truncate(item.desc, colWidth - nameWidth - 2))}`;
          if (width >= 110) {
            for (let i = 0; i < items.length; i += 2) {
              const left = items[i]!;
              const right = items[i + 1];
              const leftCell = cell(left);
              const pad = " ".repeat(Math.max(1, colWidth - visLen(leftCell)));
              rows.push(`    ${leftCell}${right ? pad + cell(right) : ""}`);
            }
          } else {
            for (const item of items) {
              rows.push(`    ${info(item.name.padEnd(nameWidth))}${muted(item.desc)}`);
            }
          }
        }
        this.print(rows.join("\n"));
        return true;
      }
      case "sessions":
      case "resume":
        this.openSessions("active");
        return true;
      case "rename": {
        if (!arg) {
          this.print(
            `  ${warn("Usage:")} ${info("/rename <title>")} ${faint("-- renames the current session (or use /sessions)")}`,
          );
          return true;
        }
        engine.renameSession(this.ctx.sessionId, arg);
        this.print(`  ${ok(glyph("verified"))} ${muted("renamed session to")} ${text(arg)}`);
        return true;
      }
      case "status": {
        const s = engine.getStatus(this.ctx.sessionId);
        this.print(
          renderStatus({
            model: s.model,
            provider: s.provider,
            workspace: s.workspace,
            sessionId: this.ctx.sessionId,
            cost: s.cost,
            costSummary: s.costSummary,
            yoloMode: s.yoloMode,
            trustWorkspace: s.trustWorkspace,
            permissionMode: s.permissionMode,
            sandboxEnabled: s.sandboxEnabled,
            sandboxDegraded: s.sandboxDegraded,
            sandboxMode: s.sandboxMode,
            sandboxFallback: s.sandboxFallback,
            sandboxExcluded: s.sandboxExcluded,
            orgPolicy: s.orgPolicy,
            autoMode: s.autoMode,
            registeredProviders: s.registeredProviders,
            version: this.ctx.version,
            contextUsage: engine.getContextUsage(),
            providerHealth: engine.getProviderHealth(),
          }),
        );
        const team = engine.getTeamStatus();
        if (team.enabled && team.peerCount > 0) {
          this.print(
            `  ${muted("Team")}  ${text(`${team.peerCount} other instance${team.peerCount === 1 ? "" : "s"} in this repo`)} ${faint("(/team)")}`,
          );
        }
        return true;
      }
      case "cost": {
        // Was a lone `$0.0000` — true on a subscription route and useless.
        // The readout now answers the three questions that number can't:
        // what left the building, what it would cost metered, and what the
        // prompt cache is actually saving.
        // Money first, then the half free tiers actually run on: completions
        // split work vs governance, fresh tokens per call, cache-read ratio,
        // list estimate, and what a prompt is made of. Appended rather than
        // replacing anything — the existing readout is unchanged.
        const rows = [
          ...formatCostReport(engine.getCostBreakdown()),
          ...formatRunEconomics(engine.getRunEconomics()),
        ];
        const width = Math.max(...rows.map((r) => r.label.length));
        for (const row of rows) {
          const label = faint(row.label.padStart(width));
          const paint =
            row.tone === "warn"
              ? warn
              : row.tone === "good"
                ? ok
                : row.tone === "muted"
                  ? muted
                  : text;
          const note = row.note ? ` ${faint(`(${row.note})`)}` : "";
          this.print(`  ${label}  ${paint(row.value)}${note}`);
        }
        return true;
      }
      case "team": {
        const lines = runTeamCommand(engine.getTeamBus(), arg);
        this.print(lines.map((l, i) => `  ${i === 0 ? text(l) : muted(l)}`).join("\n"));
        return true;
      }
      case "loop":
      case "loops":
        this.handleLoopSlash(cmd, arg);
        return true;
      case "providers": {
        const a = arg.split(/\s+/).filter(Boolean);
        const op = (a[0] ?? "").toLowerCase();
        // `/providers on|off <id>` toggles a provider live.
        if ((op === "on" || op === "off") && a[1]) {
          const id = a[1].toLowerCase();
          if (!getPreset(id) && id !== CUSTOM_PROVIDER_ID) {
            this.print(
              `  ${warn("Unknown provider")} ${info(id)} ${faint("(one word, no spaces -- e.g. openai)")}`,
            );
            this.print(
              `  ${faint("Providers: ")}${faint(PROVIDER_PRESETS.map((p) => p.id).join(", "))}`,
            );
            return true;
          }
          const disabled = op === "off";
          persistDisabled(id, disabled);
          const res = engine.setProviderDisabled(id, disabled, this.ctx.sessionId);
          this.print(
            `  ${ok(glyph("verified"))} ${info(id)} ${muted(disabled ? "disabled" : "enabled")}`,
          );
          // Enabling only re-includes an already-credentialed provider -- it does
          // NOT add a key. If it has none, point the user at how to add one.
          if (!disabled) {
            const row = engine.getProviderStatus().find((r) => r.id === id);
            if (row && !row.hasKey && !row.local) {
              this.print(
                `  ${warn("->")} ${muted(`${id} has no key yet -- add one:`)} ${info(`/keys set ${id} <key>`)} ${muted("or")} ${info(`rune login ${id}`)}`,
              );
            }
          }
          if (res.switchedTo) {
            this.print(
              `  ${warn("->")} ${muted("active provider was off -- now on")} ${info(`${res.switchedTo.provider}/${res.switchedTo.model}`)}`,
            );
          }
          return true;
        }
        // Data-driven listing: all providers, key state, on/off, active.
        const rows = engine.getProviderStatus().map((r) => {
          const dot = r.disabled
            ? faint("o")
            : r.active
              ? ok(glyph("live"))
              : r.hasKey
                ? info(glyph("live"))
                : faint("o");
          const c = r.active ? ok : r.hasKey && !r.disabled ? text : faint;
          const st = r.disabled
            ? warn("off")
            : r.active
              ? ok("active")
              : r.hasKey
                ? muted("ready")
                : faint("no key");
          // Show the real credential source so the panel never lies about what
          // the gateway uses: oauth / keychain / env, or "key" for a saved key.
          // "chain" is an enterprise cloud route with no Rune-held secret; it
          // reads as "cloud" because that is what a user recognises.
          const srcLabel =
            r.source === "none"
              ? ""
              : r.source === "saved"
                ? "key"
                : r.source === "chain"
                  ? "cloud"
                  : r.source; // env | oauth | keychain
          const src = srcLabel ? faint(`  ${srcLabel}`) : "";
          return `    ${dot} ${c(r.id.padEnd(13))} ${st}${src}`;
        });
        this.print(
          [
            `  ${bold(text("Providers"))}`,
            ...rows,
            `  ${faint("toggle /providers on|off <id> \u00b7 keys /keys \u00b7 switch /model")}`,
          ].join("\n"),
        );
        return true;
      }
      case "login":
      case "signin":
        void this.openLogin();
        return true;
      case "keys":
        this.openKeys();
        return true;
      case "mcp": {
        const [verb, who] = arg.split(/\s+/, 2);
        if (verb === "reconnect") {
          if (!who) {
            this.print(`  ${muted("usage: /mcp reconnect <server>")}`);
            return true;
          }
          const back = await engine.reconnectMcpServer(who);
          this.print(
            back
              ? `  ${ok(glyph("verified"))} ${text(who)} ${muted("reconnected")}`
              : `  ${warn(glyph("retry"))} ${text(who)} ${muted("did not come back")}  ${info("rune mcp doctor")}`,
          );
          return true;
        }
        this.print(mcpPanel(await engine.listMcpServers()));
        return true;
      }
      case "skills": {
        if (arg) {
          const hits = await engine.searchSkills(arg);
          this.print(
            [
              `  ${bold(text("Skills"))} ${muted(`matching "${arg}"`)}`,
              ...(hits.length
                ? hits.flatMap((hit) => [
                    `    ${info(hit.id)}`,
                    ...(hit.description ? [`      ${faint(hit.description)}`] : []),
                  ])
                : [`    ${muted("No matches.")}`]),
            ].join("\n"),
          );
          return true;
        }
        const catalog = await engine.listSkills();
        // The loader files both `.rune/skills` and `~/.rune/skills` under the
        // synthetic "user" plugin; a listing has to say which of the two, and
        // what each skill is for, or it cannot be acted on.
        const origins = new Map(
          discoverUserSkills(this.ctx.workspaceRoot).map(
            (skill) => [skill.name, ORIGIN_LABEL[skill.origin]] as const,
          ),
        );
        const groupRows = (plugin: (typeof catalog.plugins)[number]): string[] => {
          const head = `    ${ok(glyph("live"))} ${text(plugin.plugin)} ${muted(`(${plugin.skills.length})`)}`;
          if (plugin.plugin !== "user") {
            return [head, `      ${faint(plugin.skills.map((skill) => skill.name).join(", "))}`];
          }
          return [
            head,
            ...plugin.skills.flatMap((skill) => {
              const from = origins.get(skill.name);
              return [
                `      ${info("/" + skill.name)}${from ? ` ${muted(from)}` : ""}`,
                ...(skill.description ? [`        ${faint(skill.description)}`] : []),
              ];
            }),
          ];
        };
        this.print(
          [
            `  ${bold(text("Skills"))} ${muted(`(${catalog.total} across ${catalog.plugins.length} domains)`)}`,
            ...(catalog.total
              ? catalog.plugins.flatMap(groupRows)
              : [
                  `    ${muted("None found. Add one with ")}${info("rune skill add <path>")}${muted(".")}`,
                ]),
            `  ${faint("Skills load automatically when a request matches \u00b7 run one with /<name> \u00b7 search with /skills <keywords>")}`,
          ].join("\n"),
        );
        return true;
      }
      case "research":
      case "deepresearch": {
        const deep = cmd === "deepresearch";
        if (!arg) {
          const verb = deep ? "deep, multi-round research" : "research with a cited report";
          this.print(`  ${warn("Usage:")} ${info(`/${cmd} <question>`)} ${faint(`-- ${verb}`)}`);
          return true;
        }
        await this.runResearchFlow(arg, deep ? "deep" : undefined);
        return true;
      }
      case "gear": {
        // /gear          -> shift up one gear
        // /gear 3 | 3rd | auto -> shift straight to that gear
        const target = configModeToPermissionMode(arg || undefined);
        if (arg && !target) {
          this.print(
            `  ${warn("Usage:")} ${info("/gear")} ${faint("[1|2|3|4|auto] -- empty shifts up")}`,
          );
        } else this.cyclePermissionMode(target);
        return true;
      }
      case "autonomy": {
        // Legacy alias: /autonomy I|II|III -> 2nd|3rd|4th gear.
        const target = configModeToPermissionMode(arg ? `autonomy-${arg}` : undefined);
        if (target) this.cyclePermissionMode(target);
        else
          this.print(
            `  ${warn("Usage:")} ${info("/autonomy")} ${faint("[I|II|III] -- or /gear 1|2|3|4|auto")}`,
          );
        return true;
      }
      case "turing": // hidden compatibility aliases: toggle 4th gear
      case "hands-free": {
        this.cyclePermissionMode(engine.getPermissionMode() === "gear-4" ? "gear-1" : "gear-4");
        return true;
      }
      case "mode": {
        const raw = (arg ?? "").toLowerCase().trim();
        // `/mode default` pins the CURRENT gear as the startup gear, including
        // 4th. There has to be a way in that is not the one-time prompt: a
        // prompt you can miss, or that times out, is not a control — and the
        // whole point of remembering 4th gear is that it must be chosen out
        // loud, which typing this is.
        if (raw === "default" || raw === "save" || raw === "keep") {
          const current = engine.getPermissionMode();
          savePrefs({ gear: current, ...(current === "gear-4" ? { stickyFourthGear: true } : {}) });
          const label = modeInfo(current).label;
          this.print(
            `  ${accent(glyph("phase"))} ${muted("startup gear --")} ${info(label)}` +
              (current === "gear-4"
                ? ` ${warn("| full autonomy, every prompt bypassed")}`
                : ` ${faint("(used for new sessions)")}`),
          );
          return true;
        }
        if (raw === "forget" || raw === "reset") {
          savePrefs({ gear: undefined, stickyFourthGear: undefined });
          this.print(
            `  ${ok(glyph("verified"))} ${muted("startup gear cleared")} ${faint("| new sessions use the built-in default again")}`,
          );
          return true;
        }
        const mode = configModeToPermissionMode(raw);
        if (mode) {
          this.cyclePermissionMode(mode);
        } else if (raw) {
          this.print(
            `  ${warn("Usage:")} ${info("/mode")} ${faint("[1|2|3|4|auto] -- empty shifts up; `default` pins the current gear for new sessions; `forget` clears it")}`,
          );
        } else {
          this.cyclePermissionMode(); // no arg -> advance the cycle, like Shift+Tab
          const remembered = loadPrefs().gear;
          if (remembered) {
            this.print(
              `  ${faint(`startup rune: ${modeInfo(remembered as never).label} -- /mode default to change it`)}`,
            );
          }
        }
        return true;
      }
      case "sandbox": {
        const raw = (arg ?? "").trim();
        if (!raw) {
          await this.runSandboxMenu();
          return true;
        }
        const result = runSandboxCommand(engine, raw);
        if (result.changed === "mode")
          this.print(sandboxModeBanner(engine.getSandboxPolicy().mode));
        this.print(result.lines.map((l, i) => `  ${i === 0 ? text(l) : muted(l)}`).join("\n"));
        return true;
      }
      case "browser": {
        const raw = (arg ?? "").toLowerCase();
        if (raw === "on" || raw === "off") {
          const enabled = raw === "on";
          await engine.setBrowserEnabled(enabled);
          saveBrowserState(enabled);
          this.print(browserModeBanner(enabled));
        } else if (raw) {
          this.print(
            `  ${warn("Usage:")} ${info("/browser")} ${faint("[on|off] -- empty shows the current state")}`,
          );
        } else {
          this.print(browserModeBanner(engine.isBrowserEnabled()));
        }
        return true;
      }
      case "diff": {
        this.print(renderWorkspaceDiff(this.ctx.workspaceRoot));
        return true;
      }
      case "theme": {
        // Two axes, one list: the appearance (dark | light | terminal) and the
        // finish (matte | crisp). A typed argument may name either half or
        // both -- `/theme light`, `/theme crisp`, `/theme dark-matte`.
        const receipt = (): string => {
          const t = getTheme();
          const mode = t.name === "auto" ? "Terminal" : t.label;
          return `  ${ok(glyph("verified"))} ${muted("theme")} ${text(mode)} ${faint(glyph("observed"))} ${text(finishLabel(getFinish()))}`;
        };
        if (arg) {
          const choice = parseThemeChoice(arg);
          const themeOk = choice.theme ? setTheme(choice.theme) : true;
          if (!themeOk) {
            this.print(`  ${danger(glyph("failure"))} ${muted("unknown theme:")} ${faint(arg)}`);
            return true;
          }
          if (choice.finish) setFinish(choice.finish);
          setAppearanceChosen(true);
          this.refreshThemeSurface();
          saveTheme(getTheme().name, undefined, getFinish());
          this.print(receipt());
          return true;
        }
        // Live preview: every arrow key repaints the whole frame in the row's
        // theme; esc puts back exactly what was there.
        const originalTheme = getTheme().name;
        const originalFinish = getFinish();
        const apply = (idx: number): void => {
          const choice = THEME_CHOICES[idx]!;
          setTheme(choice.theme);
          setFinish(choice.finish ?? originalFinish);
          this.refreshThemeSurface();
        };
        const items: PickerItem[] = THEME_CHOICES.map((choice) => ({
          label: `${choice.label.padEnd(9)}${choice.note}`,
          hint: choice.hint,
          current:
            themeChoiceIndex(originalTheme, originalFinish) === THEME_CHOICES.indexOf(choice),
        }));
        const start = Math.max(0, themeChoiceIndex(originalTheme, originalFinish));
        const i = await this.pick("Theme", items, start, apply, "saved for your next session");
        if (i != null) {
          apply(i);
          setAppearanceChosen(true);
          saveTheme(getTheme().name, undefined, getFinish());
          this.print(receipt());
        } else {
          setTheme(originalTheme); // revert the live preview on cancel
          setFinish(originalFinish);
          this.refreshThemeSurface();
        }
        return true;
      }
      case "model": {
        // Quick forms: `/model <provider>/<model>` (this session only),
        // `/model default` (show) and `/model default <provider>/<model>` (persist).
        if (arg === "default" || arg.startsWith("default ")) {
          const rest = arg.slice("default".length).trim();
          if (!rest) {
            const def = loadLastModel();
            this.print(
              def
                ? `  ${accent(glyph("phase"))} ${muted("default:")} ${info(`${def.provider}/${def.model}`)} ${faint("| change: /model default <provider>/<model>, or d in /model")}`
                : `  ${muted("no default set --")} ${info("/model default <provider>/<model>")}${muted(", or press d on a model in /model")}`,
            );
            return true;
          }
          const si = rest.indexOf("/");
          const prov = si > 0 ? rest.slice(0, si) : engine.getProvider();
          const mod = si > 0 ? rest.slice(si + 1) : rest;
          this.applyModelSwitch(String(prov), mod, true);
          return true;
        }
        if (arg.includes("/")) {
          const [p, ...m] = arg.split("/");
          this.applyModelSwitch(p!, m.join("/"), false);
          return true;
        }
        if (arg) {
          this.applyModelSwitch(engine.getProvider(), arg, false);
          return true;
        }
        await this.modelTree();
        return true;
      }
      case "rewind": {
        const turns = engine.listUserTurns(this.ctx.sessionId);
        if (turns.length === 0) {
          this.print(`  ${muted("Nothing to rewind yet.")}`);
          return true;
        }
        const n = parseInt(arg, 10);
        if (!arg || isNaN(n) || n < 1 || n > turns.length) {
          const rows = turns.map(
            (t, i) =>
              `    ${warn(String(i + 1).padStart(2))}  ${muted(t.text.replace(/\s+/g, " ").slice(0, 60))}`,
          );
          this.print(
            [`  ${bold(text("Rewind"))}`, ...rows, `  ${faint("Run /rewind <n>")}`].join("\n"),
          );
          return true;
        }
        const removed = engine.rewindTo(this.ctx.sessionId, turns[n - 1]!.seq - 1);
        this.print(
          `  ${ok(glyph("verified"))} ${muted(`rewound to turn ${n} (removed ${removed})`)}`,
        );
        return true;
      }
      case "interactive": {
        const [sub = "", ...rest] = arg.split(/\s+/).filter(Boolean);
        if (sub === "auto") {
          const v = (rest[0] ?? "").toLowerCase();
          if (v === "on" || v === "off") {
            const on = v === "on";
            engine.setInteractiveAuto(on);
            saveInteractiveAuto(on);
            this.print(
              `  ${ok(glyph("verified"))} ${muted(`autonomous dashboards ${on ? "on" : "off"}`)} ${faint(
                on
                  ? "-- Rune builds one when an answer is data-heavy"
                  : "-- dashboards only when you ask (/interactive)",
              )}`,
            );
          } else {
            this.print(
              `  ${muted(`Autonomous dashboards: ${engine.isInteractiveAuto() ? "on" : "off"}`)} ${faint(
                "| toggle: /interactive auto on|off",
              )}`,
            );
          }
          return true;
        }
        if (sub === "open") {
          const info = engine.openDashboard(rest[0]);
          this.print(
            info
              ? `  ${ok(glyph("verified"))} ${muted(`opened "${info.title}"`)} ${faint(info.url)}`
              : `  ${muted("No dashboard yet -- run /interactive after a report, or ask for one.")}`,
          );
          return true;
        }
        // Bare /interactive (or with a focus) rides the normal turn loop so the
        // model builds the dashboard with full conversation context.
        const focus = sub === "view" ? rest.join(" ") : arg;
        await this.runTurn(buildInteractiveDirective(focus || undefined));
        return true;
      }
      case "undo": {
        const r = engine.undoLastAutoCommit();
        if (r.ok) {
          this.print(
            `  ${ok(glyph("verified"))} ${muted(`reverted ${r.undoneSha}`)} ${faint(`(${r.subject})`)}`,
          );
        } else {
          this.print(`  ${muted(`Cannot undo -- ${r.reason}`)}`);
          if (!engine.isAutoCommitEnabled()) {
            this.print(
              `  ${faint("Tip: set [git] autoCommit = true in ~/.rune/config.toml so every run lands as a revertible commit.")}`,
            );
          }
        }
        return true;
      }
      case "compress": {
        this.print(`  ${faint("Compressing...")}`);
        const r = await engine.compactSession(this.ctx.sessionId, arg || undefined);
        if (!r.compacted) {
          this.print(`  ${muted(`Nothing to compact -- ${r.reason}.`)}`);
          return true;
        }
        const fmtTok = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
        const saved =
          r.sourceTokens > 0
            ? Math.max(0, Math.round((1 - r.summaryTokens / r.sourceTokens) * 100))
            : 0;
        this.print(
          `  ${ok(glyph("verified"))} ${muted(`compacted ${r.originalMessages} messages | ~${fmtTok(r.sourceTokens)} -> ~${fmtTok(r.summaryTokens)} tokens (${saved}% smaller)`)}`,
        );
        return true;
      }
      case "memory": {
        const sub = (arg.split(/\s+/)[0] ?? "").toLowerCase();
        const subArg = arg.slice(sub.length).trim();
        const fmtTok = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

        // Bare `/memory` opens the interactive panel (view + refresh/cadence/add/edit/clear).
        // The `/memory <sub>` text forms below stay for power users + scriptability.
        if (!sub) {
          this.openMemory();
          return true;
        }

        // -- update: the user's own hand, in auto AND manual --
        // One command, both halves: the deterministic extractor over THIS
        // session (which manual mode otherwise never runs) and the profile
        // refresh, right now.
        if (sub === "update" || sub === "refresh" || sub === "dream") {
          this.print(`  ${faint("Updating your memory...")}`);
          const r = await engine.updateMemoryNow(this.ctx.sessionId, {
            focus: subArg || undefined,
          });
          if (r.learned && r.learned.promoted > 0) {
            this.print(
              `  ${ok(glyph("verified"))} ${muted(`learned ${r.learned.promoted} thing${r.learned.promoted === 1 ? "" : "s"} from this session`)}`,
            );
          }
          if (!r.updated) {
            this.print(`  ${muted(`Profile unchanged -- ${r.reason}.`)}`);
            return true;
          }
          const preview = (r.content ?? "")
            .split("\n")
            .map((l) => l.trimEnd())
            .filter(Boolean)
            .slice(0, 8);
          this.print(
            [
              `  ${ok(glyph("verified"))} ${muted(`system memory refreshed | ~${fmtTok(r.tokensBefore)} -> ~${fmtTok(r.tokensAfter)} tokens`)}`,
              ...preview.map((l) => `  ${faint(l.slice(0, 100))}`),
            ].join("\n"),
          );
          return true;
        }

        // -- add a manual note --
        if (sub === "add" || sub === "note") {
          if (!subArg) {
            this.print(`  ${warn("Usage:")} ${info("/memory add <note>")}`);
            return true;
          }
          const r = engine.appendSystemMemoryNote(subArg);
          this.print(
            `  ${ok(glyph("verified"))} ${muted(`noted | ~${fmtTok(r.tokens)} tokens total`)}`,
          );
          return true;
        }

        // -- edit: suspend the TUI and open the profile in $EDITOR for real --
        if (sub === "edit") {
          await this.editMemoryInEditor();
          return true;
        }

        // -- restore: put a kept copy of the profile back --
        // Every write to the profile keeps the file it replaces. This is the
        // way back from a bad dream, a bad edit, or a `/memory clear`.
        if (sub === "restore") {
          const backups = engine.systemMemoryBackups();
          if (!backups.length) {
            this.print(`  ${muted("No kept copies of the profile yet.")}`);
            return true;
          }
          if (subArg.toLowerCase() === "list") {
            this.print(
              [
                `  ${bold(text("Kept copies of the profile"))}`,
                ...backups.map((b) => `  ${faint(b.stamp)} ${muted(`${b.bytes} bytes`)}`),
                `  ${faint("restore the newest: /memory restore \u00b7 a specific one: /memory restore <stamp>")}`,
              ].join("\n"),
            );
            return true;
          }
          const r = engine.restoreSystemMemory(subArg || undefined);
          this.print(
            r.restored
              ? `  ${ok(glyph("verified"))} ${muted(`profile restored \u00b7 ${r.bytes} bytes from`)} ${faint(r.from ?? "")}`
              : `  ${danger(glyph("failure"))} ${muted(`nothing restored -- ${r.reason}`)}`,
          );
          return true;
        }

        // -- clear --
        // `forget` with an id belongs to the store (below); bare, it is the
        // old alias for clearing the whole profile. Without the `!subArg`
        // guard `/memory forget <id>` wiped everything.
        if (sub === "clear" || sub === "reset" || (sub === "forget" && !subArg)) {
          engine.clearSystemMemory();
          this.print(`  ${ok(glyph("verified"))} ${muted("system memory cleared")}`);
          return true;
        }

        // ── the autonomous store: forget / pin / unpin ──
        // A memory the user cannot delete is a memory they have to live with,
        // so these come before the cadence switches: correcting the store is
        // the common case, changing how often it dreams is the rare one.
        if (sub === "forget" || sub === "pin" || sub === "unpin") {
          const id = subArg.split(/\s+/)[0] ?? "";
          if (!id) {
            this.print(`  ${warn("Usage:")} ${info(`/memory ${sub} <id>`)}`);
            return true;
          }
          if (sub === "forget") {
            const gone = engine.forgetMemory(id);
            this.print(
              gone
                ? `  ${ok(glyph("verified"))} ${muted("forgotten:")} ${faint(id)}`
                : `  ${danger(glyph("failure"))} ${muted(`no memory with id ${id}`)}`,
            );
            return true;
          }
          const entry = engine.pinMemory(id, sub === "pin");
          this.print(
            entry
              ? `  ${ok(glyph("verified"))} ${muted(sub === "pin" ? "pinned:" : "unpinned:")} ${text(entry.text)}`
              : `  ${danger(glyph("failure"))} ${muted(`no memory with id ${id}`)}`,
          );
          return true;
        }

        // -- set the mode (off | auto | manual) --
        // Three, and only three. A cadence is refused by name rather than
        // quietly reinterpreted: the user asked for a clock and there isn't one.
        if (isWithdrawnCadence(sub === "every" ? arg : sub)) {
          this.print(`  ${warn(glyph("failure"))} ${muted(MEMORY_CADENCE_REFUSAL)}`);
          this.print(`  ${faint("/memory auto \u00b7 /memory manual \u00b7 /memory off")}`);
          return true;
        }
        if (sub === "off" || sub === "auto" || sub === "manual" || sub === "on") {
          const r = engine.setMemoryMode(sub);
          if (!r.ok) {
            this.print(`  ${warn(glyph("failure"))} ${muted(r.reason ?? "unknown mode")}`);
            return true;
          }
          this.print(
            `  ${ok(glyph("verified"))} ${muted("memory:")} ${info(r.mode)} ${faint(describeMemoryMode(r.mode))}`,
          );
          return true;
        }

        // -- default: the mode first, then status, then the profile --
        const mem = engine.getSystemMemory();
        if (mem.mode === "off") {
          this.print(
            [
              `  ${bold(text("Memory"))} ${info("off")}`,
              `  ${muted("Nothing is read, written or remembered between sessions.")}`,
              `  ${faint("turn it on: /memory auto (Rune decides when to update) \u00b7 /memory manual (only /memory update)")}`,
            ].join("\n"),
          );
          return true;
        }
        const last = mem.meta.updatedAt ? this.relTime(mem.meta.updatedAt) : "never";
        const refreshed = mem.meta.lastRefresh
          ? `${this.relTime(mem.meta.lastRefresh.at)} (${mem.meta.lastRefresh.origin === "agent" ? "by Rune" : "by you"})`
          : mem.meta.lastReflectedAt
            ? this.relTime(mem.meta.lastReflectedAt)
            : "never";
        const head = [
          `  ${bold(text("Memory"))} ${info(mem.mode)} ${faint(mem.modeDescription)}`,
          `  ${faint(`~${fmtTok(mem.tokens)}/${fmtTok(mem.maxTokens)} tokens \u00b7 updated ${last} \u00b7 refreshed ${refreshed}`)}`,
        ];
        // A withdrawn cadence, said out loud once: the user chose `daily` at
        // some point and should hear that it no longer exists.
        const migrated = engine.takeMemoryModeNotice();
        if (migrated) head.push(`  ${muted(migrated.note)}`);
        // A refresh the floor turned away stays on the panel until a later one
        // succeeds: the user should be able to come back and look at the day a
        // model nearly replaced their profile with a stub.
        const refusal = mem.meta.lastRefusal;
        if (refusal) {
          head.push(
            `  ${warn(glyph("failure"))} ${muted(`a refresh was refused ${this.relTime(refusal.at)} -- ${refusal.reason}`)}`,
          );
        }
        const kept = engine.systemMemoryBackups();
        if (kept.length) {
          head.push(
            `  ${faint(`${kept.length} kept cop${kept.length === 1 ? "y" : "ies"} \u00b7 restore: /memory restore [stamp] \u00b7 list: /memory restore list`)}`,
          );
        }
        // ── what the run learned on its own ──
        // Shown with ids and provenance, because the only way to trust a
        // learned memory is to be able to see where it came from and delete it.
        const store = engine.getMemoryEntries();
        const learned: string[] = [];
        if (store.promoted.length) {
          learned.push("", `  ${bold(text("Learned"))} ${faint(`(${store.promoted.length})`)}`);
          for (const e of store.promoted.slice(0, 12)) {
            const mark = e.pinned ? "*" : " ";
            learned.push(
              `  ${faint(e.id)}${mark} ${text(e.text)} ${faint(`[${e.kind} | ${e.provenance.source}]`)}`,
            );
          }
        }
        if (store.candidates.length) {
          learned.push(
            "",
            `  ${muted(`${store.candidates.length} in quarantine -- not injected until promoted`)}`,
          );
        }
        if (store.refusals.length) {
          const rules = [...new Set(store.refusals.map((r) => r.rule))].join(", ");
          learned.push(`  ${muted(`${store.refusals.length} refused by the guard (${rules})`)}`);
        }
        if (learned.length) {
          learned.push(
            "",
            `  ${faint("forget: /memory forget <id> \u00b7 pin: /memory pin <id>")}`,
          );
        }
        if (!store.learning) {
          learned.push(
            `  ${faint(mem.mode === "manual" ? "manual mode -- nothing is learned until you run /memory update" : "autonomous learning is off")}`,
          );
        }

        if (!mem.content.trim()) {
          this.print(
            [
              ...head,
              ...(learned.length
                ? learned
                : [
                    `  ${muted("Empty -- Rune hasn't learned anything about you yet.")}`,
                    `  ${faint("It learns from what you say and what checks prove, at the end of each run.")}`,
                  ]),
              `  ${faint("Seed it: /memory update \u00b7 note: /memory add <...> \u00b7 mode: /memory off|auto|manual")}`,
            ].join("\n"),
          );
          return true;
        }
        this.print(
          [
            ...head,
            "",
            ...mem.content.split("\n").map((l) => `  ${text(l)}`),
            ...learned,
            "",
            `  ${faint("update: /memory update \u00b7 note: /memory add <...> \u00b7 mode: /memory off|auto|manual")}`,
          ].join("\n"),
        );
        return true;
      }
      default: {
        const custom = findCommand(this.ctx.customCommands, cmd!);
        if (custom) {
          await this.runTurn(custom.render(arg));
          return true;
        }
        this.print(
          `  ${danger(glyph("failure"))} ${muted(`unknown command: /${cmd}`)} ${faint("| /help")}`,
        );
        return true;
      }
    }
  },

  handleLoopSlash(this: Tui, command: "loop" | "loops", arg: string): void {
    const tokens = arg.split(/\s+/).filter(Boolean);
    const operation = (tokens[0] ?? "").toLowerCase();
    const shouldList =
      (command === "loops" && !arg) ||
      operation === "list" ||
      operation === "ls" ||
      operation === "status";

    if (shouldList) {
      const tasks = this.ctx.engine.listLoopTasks(this.ctx.sessionId);
      if (tasks.length === 0) {
        this.print(
          `  ${muted("No loops are active in this session.")} ${faint("Try /loop 5m check CI")}`,
        );
        return;
      }
      this.print(
        [
          `  ${bold(text(`Loops -- ${tasks.length} active`))}`,
          ...tasks.map(
            (task) =>
              `    ${warn(glyph("retry"))} ${info(task.id)} ${text(task.cadence === "fixed" ? `every ${formatLoopInterval(task.intervalMs)}` : `adaptive ${formatLoopInterval(task.intervalMs)}`)} ${faint(`| ${formatLoopDue(task.nextRunAt)} | ${loopPromptPreview(task.prompt, 54)}`)}`,
          ),
          `  ${faint("/loop cancel <id> \u00b7 /loop clear \u00b7 Esc stops the newest loop")}`,
        ].join("\n"),
      );
      return;
    }

    if (["cancel", "stop", "off", "delete", "rm"].includes(operation)) {
      const result = this.ctx.engine.cancelLoopTask(this.ctx.sessionId, tokens[1]);
      if (!result.ok || !result.task) {
        this.print(
          `  ${danger(glyph("failure"))} ${muted(result.error ?? "Could not stop that loop.")}`,
        );
      } else {
        this.print(
          `  ${danger(glyph("failure"))} ${muted("stopped loop")} ${info(result.task.id)} ${faint(loopPromptPreview(result.task.prompt, 58))}`,
        );
      }
      return;
    }

    if (["clear", "cancel-all", "stop-all"].includes(operation)) {
      const count = this.ctx.engine.clearLoopTasks(this.ctx.sessionId);
      this.print(
        count > 0
          ? `  ${danger(glyph("failure"))} ${muted(`stopped ${count} ${count === 1 ? "loop" : "loops"}`)}`
          : `  ${muted("No loops are active in this session.")}`,
      );
      return;
    }

    if (operation === "help") {
      this.print(
        [
          `  ${bold(text("Loop mode"))}`,
          `    ${info("/loop 5m check the deploy")} ${faint("fixed interval")}`,
          `    ${info("/loop check CI and review comments")} ${faint("adaptive 1-60m cadence")}`,
          `    ${info("/loop")} ${faint("built-in maintenance prompt, or .rune/loop.md")}`,
          `    ${info("/loops")} ${faint("list active tasks")}`,
          `    ${info("/loop cancel <id>")} ${faint("stop one \u00b7 /loop clear stops all")}`,
        ].join("\n"),
      );
      return;
    }

    try {
      const result = this.ctx.engine.scheduleLoop(this.ctx.sessionId, arg);
      const task = result.task;
      const cadence =
        task.cadence === "fixed"
          ? `every ${formatLoopInterval(task.intervalMs)}`
          : `adaptive \u00b7 first check ${formatLoopDue(task.nextRunAt)}`;
      this.print(
        [
          `  ${ok(glyph("verified"))} ${text("loop scheduled")} ${info(task.id)} ${faint(`| ${cadence} | expires in 7d`)}`,
          `    ${faint(glyph("gutter"))} ${muted(loopPromptPreview(task.prompt, Math.max(36, cols() - 10)))}`,
          ...(result.promptPath ? [`    ${faint(`prompt: ${result.promptPath}`)}`] : []),
          ...result.warnings.map((warning) => `    ${warn(glyph("observed"))} ${muted(warning)}`),
        ].join("\n"),
      );
    } catch (error) {
      this.print(
        `  ${danger(glyph("failure"))} ${muted(error instanceof Error ? error.message : String(error))}`,
      );
    }
  },

  modelPresets(this: Tui, reg: string[]): { provider: string; model: string; label: string }[] {
    // Data-driven from the provider presets: every registered provider with a
    // curated `models` list contributes its models, so adding a provider is a
    // one-line preset edit -- no picker code to touch. Local runtimes (ollama /
    // are listed even when not yet active so they're discoverable --
    // picking one switches to it. Free-form `/model <provider>/<id>` still works.
    const localIds = PROVIDER_PRESETS.filter((p) => p.local).map((p) => p.id);
    const ids = [...reg, ...localIds.filter((id) => !reg.includes(id))];
    const out: { provider: string; model: string; label: string }[] = [];
    for (const id of ids) {
      const preset = getPreset(id);
      if (!preset?.models?.length) continue;
      for (const m of preset.models) out.push({ provider: id, model: m.id, label: m.label });
    }
    return out;
  },

  /** v2 picker chips: provider name, plus real free/local markers from the presets. */
  modelTags(this: Tui, p: { provider: string; model: string; label: string }): string[] {
    const tags: string[] = [];
    const preset = getPreset(p.provider);
    if (preset?.local) tags.push("local");
    if (/:free$/i.test(p.model) || /\(free\)/i.test(p.label) || /\bfree\b/i.test(p.label)) {
      tags.push("free");
    }
    tags.push(p.provider);
    return tags;
  },

  /** Switch provider/model for this session; `asDefault` also persists it as the startup default. */
  applyModelSwitch(this: Tui, prov: string, model: string, asDefault: boolean): void {
    const engine = this.ctx.engine;
    engine.switchModel(model, prov as any, this.ctx.sessionId);
    const now = `${engine.getProvider()}/${engine.getModel()}`;
    // Switching model IS the decision. Asking the user to confirm it a second
    // time, with a different key in a different place, meant the next session
    // opened on the model they had already rejected — so a plain pick persists
    // now, and `asDefault` only changes how loudly it says so.
    saveLastModel({ provider: engine.getProvider(), model: engine.getModel() });
    this.print(
      asDefault
        ? `  ${accent(glyph("phase"))} ${muted("default set --")} ${info(now)} ${faint("(used at startup)")}`
        : `  ${ok(glyph("verified"))} ${muted("switched to")} ${info(now)} ${faint("| kept for new sessions too")}`,
    );
  },

  /**
   * The /model tree: providers -> accounts/endpoints -> models.
   * Level 1 lists only configured providers (plus local runtimes); level 2 the
   * real access paths for the chosen one (skipped when there is just one);
   * level 3 the models under that account -- live-listed for local runtimes.
   * enter switches this session; `d` also makes the pick the startup default.
   */
  async modelTree(this: Tui): Promise<void> {
    const engine = this.ctx.engine;
    const rows = engine.getProviderStatus();
    const customEp = engine.getCustomEndpoint();
    const current = { provider: String(engine.getProvider()), model: engine.getModel() };
    const def = loadLastModel();
    const defNote = def ? ` \u00b7 default ${def.provider}/${def.model}` : "";

    // -- Level 1: providers --
    const provs = providerChoices(rows, customEp, process.env, getPreset);
    const typeItem: PickerItem = { label: "Type provider/model...", hint: "anything not listed" };
    const l1: PickerItem[] = [
      ...provs.map((p) => ({
        label: p.label,
        hint: stripAnsi(p.hint),
        current: p.id === current.provider,
        tags: p.local ? ["local"] : [],
      })),
      typeItem,
    ];
    const l1start = Math.max(
      0,
      provs.findIndex((p) => p.id === current.provider),
    );
    const a1 = await this.pick(
      `Model \u00b7 current ${current.provider}/${current.model}${defNote}`,
      l1,
      l1start,
      undefined,
      provs.length
        ? "subscriptions (Claude Pro/Max or ChatGPT): rune login \u00b7 keys: /keys"
        : "no providers configured yet -- add a key with /keys or sign in with rune login",
    );
    if (a1 == null) return;
    if (a1 >= provs.length) {
      const typed = await this.promptLine("provider/model");
      if (!typed) return;
      const si = typed.indexOf("/");
      if (si <= 0) {
        this.print(`  ${warn("Use the form")} ${info("provider/model")}`);
        return;
      }
      this.applyModelSwitch(typed.slice(0, si), typed.slice(si + 1), false);
      return;
    }
    const chosen = provs[a1]!;
    const row = rows.find((r) => r.id === chosen.id)!;
    const preset = getPreset(chosen.id);
    const accounts = accountChoices(preset, row, customEp, process.env);

    // -- Level 2: accounts / endpoints (skipped when only one path) --
    let account = accounts[0];
    if (accounts.length > 1) {
      const l2: PickerItem[] = [
        ...accounts.map((ac) => ({
          label: ac.label,
          hint: ac.detail,
          current: ac.active === true,
        })),
        { label: "Back", hint: "choose another provider" },
      ];
      const a2 = await this.pick(
        `Model \u00b7 ${chosen.label} \u00b7 account`,
        l2,
        Math.max(
          0,
          accounts.findIndex((ac) => ac.active),
        ),
        undefined,
        "the selected credential becomes the active one for this provider",
      );
      if (a2 == null) return;
      if (a2 >= accounts.length) return this.modelTree();
      account = accounts[a2];
      if (account?.kind === "key" && account.entryId && !account.active) {
        // Picking a pooled key makes it the ACTIVE key -- persisted and applied
        // to the live gateway, same as the /keys manager.
        const file = persistSetActiveKey(chosen.id, account.entryId);
        engine.setProviderKeys(
          chosen.id,
          readProviderKeyEntries(file, chosen.id),
          file.activeKeyId?.[chosen.id],
          this.ctx.sessionId,
        );
        this.print(
          `  ${ok(glyph("verified"))} ${muted("active key now")} ${text(account.label)} ${faint(account.detail)}`,
        );
      }
      if (row.source === "oauth" || row.source === "keychain") {
        if (account?.kind === "key" || account?.kind === "env") {
          this.print(
            `  ${faint(`note: the signed-in ${row.source} credential wins on the wire --`)} ${info(`rune logout ${chosen.id}`)} ${faint("to use API keys")}`,
          );
        }
      } else if (account?.kind === "env" && accounts.some((x) => x.kind === "key")) {
        this.print(
          `  ${faint("note: the saved key wins on the wire --")} ${info(`/keys clear ${chosen.id}`)} ${faint("to use the env key")}`,
        );
      }
    }

    // -- Level 3: models under that account --
    let live: string[] | null = null;
    if (preset && (chosen.local || account?.kind === "endpoint")) {
      live = await fetchLiveModels(preset.kind, row.endpoint ?? preset.baseUrl ?? "");
    }
    const models = modelChoices(preset, chosen.id, { live, custom: customEp, current, def });
    const l3: PickerItem[] = [
      ...models.map((m) => ({
        label: m.label,
        hint: m.label !== m.id ? m.id : undefined,
        current: m.current,
        tags: [
          ...(m.isDefault ? ["default"] : []),
          ...(/:free$/i.test(m.id) || /\bfree\b/i.test(m.label) ? ["free"] : []),
          ...(chosen.local ? ["local"] : []),
        ],
      })),
      { label: "Type a model id...", hint: "anything not listed" },
      {
        label: "Back",
        hint: accounts.length > 1 ? "choose another account" : "choose another provider",
      },
    ];
    const crumb =
      accounts.length > 1 && account
        ? `Model \u00b7 ${chosen.label} \u00b7 ${account.label.replace("API key \u00b7 ", "key ")}`
        : `Model \u00b7 ${chosen.label}`;
    if (chosen.local && !live) {
      this.print(
        `  ${faint(`endpoint ${row.endpoint ?? ""} not reachable -- showing suggestions`)}`,
      );
    }
    const a3 = await this.pickAlt(
      crumb,
      l3,
      Math.max(
        0,
        models.findIndex((m) => m.current),
      ),
      "enter use now (this session) \u00b7 d = use now and make it the startup default \u00b7 esc back",
      "d",
    );
    if (a3 == null) return;
    if (a3.index === models.length) {
      const typed = await this.promptLine("model id");
      if (typed) this.applyModelSwitch(chosen.id, typed, a3.alt);
      return;
    }
    if (a3.index > models.length) return this.modelTree();
    const pickM = models[a3.index]!;
    await this.applyModelWithEffort(chosen.id, pickM.id, pickM.label, a3.alt);
  },

  /**
   * Switch the model, then — where the model actually has a depth dial — ask
   * for it in the same breath, with the same keys.
   *
   * Depth used to live behind `/config effort max`, which is the wrong shape
   * twice over: nobody discovers a setting they have to already know the name
   * of, and a person mid-decision about a model should not have to leave the
   * decision to type an incantation. It is a property of the model being
   * chosen, so it is asked for where the model is chosen. Escape keeps
   * whatever was already set — backing out of the depth question must never
   * undo the model switch that already happened.
   */
  async applyModelWithEffort(
    this: Tui,
    prov: string,
    model: string,
    label: string,
    asDefault: boolean,
  ): Promise<void> {
    this.applyModelSwitch(prov, model, asDefault);
    const engine = this.ctx.engine;
    const current = engine.getReasoningEffort() as ReasoningEffort;
    const efforts = effortChoices(prov, model, current);
    if (efforts.length === 0) return;

    const items: PickerItem[] = efforts.map((e) => ({
      label: e.label,
      hint: e.hint,
      current: e.current,
    }));
    const picked = await this.pick(
      `Thinking depth \u00b7 ${label}`,
      items,
      Math.max(
        0,
        efforts.findIndex((e) => e.current),
      ),
      undefined,
      "enter set depth \u00b7 esc keep " + current,
    );
    if (picked == null) return;
    const chosenEffort = efforts[picked]!.id;
    engine.setReasoningEffort(chosenEffort);
    this.print(
      `  ${ok(glyph("verified"))} ${muted("thinking depth")} ${info(chosenEffort)} ${faint(`| ${efforts[picked]!.hint}`)}`,
    );
  },

  async showSettings(this: Tui): Promise<void> {
    const engine = this.ctx.engine;
    const shortcuts = [
      { label: "Model and reasoning", hint: "choose intelligence", command: "model" },
      {
        label: "API keys and internet search",
        hint: "manage keys \u00b7 /login to connect",
        command: "keys",
      },
      { label: "Browser", hint: engine.isBrowserEnabled() ? "on" : "off", command: "browser" },
    ];
    while (true) {
      const rows: PickerItem[] = [
        ...shortcuts,
        ...CONFIG_SETTINGS.map((s) => {
          const value = engine.readConfigSetting(s.key);
          return {
            label: s.key.replaceAll("_", " "),
            hint: value === undefined ? "per effort" : displaySettingValue(s, value),
          };
        }),
      ];
      // The total is in the heading and the footnote, never only in the list:
      // a window that cannot show all of them says how many it is not showing.
      const chrome = settingsPickerChrome(shortcuts.length);
      const selected = await this.pick(chrome.title, rows, 0, undefined, chrome.footnote);
      if (selected === null) return;
      if (selected < shortcuts.length) {
        await this.handleSlash(`/${shortcuts[selected]!.command}`);
        return;
      }
      const setting = CONFIG_SETTINGS[selected - shortcuts.length]!;
      const current = engine.readConfigSetting(setting.key);
      let value: string | null = null;
      if (setting.kind === "number") {
        value = await this.promptLine(`${setting.key} (${settingChoices(setting)})`, current ?? "");
      } else {
        const values = setting.kind === "boolean" ? ["true", "false"] : [...setting.values!];
        const choice = await this.pick(
          setting.key.replaceAll("_", " "),
          values.map((v) => ({ label: displaySettingValue(setting, v) })),
          Math.max(0, values.indexOf(current ?? "")),
          undefined,
          setting.description,
        );
        if (choice !== null) value = values[choice]!;
      }
      if (value !== null && value.trim())
        this.print(transcriptGutter(await runSettingsCommand(engine, `${setting.key} ${value}`)));
    }
  },

  /**
   * `/sandbox` with no argument: the three-tab menu. Mode and Overrides are
   * pickers with the current choice marked; Config is a readout of what the
   * sandbox actually enforces, plus how to change it. Every choice made here
   * is also reachable as text (`/sandbox mode regular`), which is what the
   * plain CLI uses.
   */
  async runSandboxMenu(this: Tui): Promise<void> {
    const engine = this.ctx.engine;
    const policy = engine.getSandboxPolicy();
    const tab = await this.pick(
      "sandbox",
      [
        {
          label: "Mode",
          hint: `${policy.mode} -- ${SANDBOX_MODE_CHOICES.find((c) => c.mode === policy.mode)?.hint ?? ""}`,
        },
        {
          label: "Overrides",
          hint: policy.allowUnsandboxedFallback
            ? "allow unsandboxed fallback"
            : "strict sandbox mode",
        },
        {
          label: "Config",
          hint: `${policy.excludedCommands.length} excluded, filesystem read/write rules`,
        },
      ],
      0,
      undefined,
      "Learn more: docs/sandbox.md -- text forms: /sandbox mode|override|exclude|config",
    );
    if (tab === null) return;
    if (tab === 0) {
      const current = SANDBOX_MODE_CHOICES.findIndex((c) => c.mode === policy.mode);
      const picked = await this.pick(
        "sandbox mode",
        SANDBOX_MODE_CHOICES.map((c) => ({
          label: c.label,
          hint: c.hint,
          current: c.mode === policy.mode,
        })),
        Math.max(0, current),
        undefined,
        "Auto-allow: the sandbox vouches for a command. Regular: contained but still prompted. Off: full access.",
      );
      if (picked === null) return;
      const result = runSandboxCommand(engine, `mode ${SANDBOX_MODE_CHOICES[picked]!.mode}`);
      this.print(sandboxModeBanner(engine.getSandboxPolicy().mode));
      this.print(result.lines.map((l) => `  ${muted(l)}`).join("\n"));
      return;
    }
    if (tab === 1) {
      const picked = await this.pick(
        "sandbox overrides",
        SANDBOX_OVERRIDE_CHOICES.map((c) => ({
          label: c.label,
          hint: c.hint,
          current: c.fallback === policy.allowUnsandboxedFallback,
        })),
        policy.allowUnsandboxedFallback ? 0 : 1,
        undefined,
        "Strict: unsandboxed: true is refused; only excludedCommands run on the host.",
      );
      if (picked === null) return;
      const result = runSandboxCommand(
        engine,
        `override ${SANDBOX_OVERRIDE_CHOICES[picked]!.fallback ? "fallback" : "strict"}`,
      );
      this.print(result.lines.map((l, i) => `  ${i === 0 ? text(l) : muted(l)}`).join("\n"));
      return;
    }
    const result = runSandboxCommand(engine, "config");
    this.print(result.lines.map((l, i) => `  ${i === 0 ? text(l) : muted(l)}`).join("\n"));
  },

  /**
   * `/login` -- the three-step connect flow.
   *
   * It replaces /providers + /keys as the way in. Those exposed the plumbing
   * and neither answered the only question someone who just installed Rune
   * actually has: how do I connect this? A person who pays for ChatGPT knows
   * that; they do not know the provider is called "codex", that it signs in by
   * OAuth, or why a "provider" and a "key" are two different screens.
   *
   * So it asks what you HAVE (subscription / key / offline), names the products
   * the way you would say them, and runs the provider's own auth strategy --
   * the same one `rune login` uses, so there is one code path for real auth.
   */
  async openLogin(this: Tui): Promise<void> {
    const routes = routeChoices();
    const engine = this.ctx.engine;
    const connectedIds = PROVIDER_PRESETS.map((p) => p.id).filter((id) => hasStoredCredential(id));
    const searchIds = SEARCH_PROVIDER_PRESETS.filter(
      (p) => !p.keyless && this.searchConnected(p.id),
    ).map((p) => p.id);
    this.print(
      [
        `  ${bold(text("Connect"))} ${faint("| a model, an API key, a local server, or web search")}`,
        `  ${faint(connectedSummary(connectedIds, searchIds))}`,
      ].join("\n"),
    );

    const r = await this.pick(
      "Connect \u00b7 what do you want to connect?",
      routes.map((c) => ({ label: c.label, hint: c.hint })),
      0,
      undefined,
      "enter choose \u00b7 esc cancel",
    );
    if (r == null) return;
    const route = routes[r]!;

    const targets = loginTargets(route.id, {
      connected: (id) =>
        route.id === "search"
          ? this.searchConnected(id)
          : id === CUSTOM_PROVIDER_ID
            ? !!engine.getCustomEndpoint()
            : hasStoredCredential(id),
    });
    if (targets.length === 0) {
      this.print(`  ${faint("nothing to connect on that route")}`);
      return;
    }
    const t = await this.pick(
      `Connect \u00b7 ${route.label}`,
      targets.map((x) => ({
        label: x.label,
        hint: x.hint,
        current: x.connected,
      })),
      0,
      undefined,
      targets.length > 9
        ? "enter connect \u00b7 type a letter to jump \u00b7 esc back"
        : "enter connect \u00b7 esc back",
    );
    if (t == null) return;
    const target = targets[t]!;
    await this.runLoginFor(target);
  },

  /** A search engine counts as connected on any usable credential: keychain, secrets, env, or URL. */
  searchConnected(this: Tui, id: string): boolean {
    return hasStoredCredential(id) || searchProviderConnected(id);
  },

  /** Run one target's real auth strategy and apply the result to this session. */
  async runLoginFor(this: Tui, target: LoginTarget): Promise<void> {
    if (target.kind === "search") return this.runSearchLogin(target);
    if (target.providerId === CUSTOM_PROVIDER_ID) return this.runCustomLocalLogin();
    const preset = getPreset(target.providerId);
    if (!preset) return;

    // Local runtimes have nothing to authenticate: connecting IS pointing at
    // the endpoint, so confirm reachability instead of asking for a secret.
    if (target.method === "local") {
      this.applyModelSwitch(target.providerId, preset.defaultModel, false);
      this.print(`  ${faint("if it is not running, start it first -")} ${info(target.hint)}`);
      return;
    }

    const strategy = getStrategy(target.method, target.providerId);
    if (!strategy) {
      this.print(`  ${warn("!")} ${muted("that sign-in method is not wired up yet")}`);
      return;
    }

    this.print(`  ${faint("signing in to")} ${info(target.label)}${faint("...")}`);
    try {
      const store = await openCredentialStore();
      const cred = await strategy.authenticate({
        providerId: target.providerId,
        preset,
        store,
        env: process.env,
        baseUrl: preset.baseUrl,
        openBrowser,
        prompt: async (q: string) => (await this.promptLine(q)) ?? "",
        log: (line?: string) => this.print(`  ${faint(line ?? "")}`),
      } as AuthContext);
      const valid = await strategy.validate(
        { providerId: target.providerId, preset, store, env: process.env } as AuthContext,
        cred,
      );
      // Hand the credential to the engine BEFORE switching to it. The gateway
      // rebuilds from the credentials the engine holds, and until now nobody
      // told it about this one: the key went into the keychain, the model
      // switched, and the next message failed with "provider not registered"
      // until a restart re-read the store.
      this.ctx.engine.setResolvedCredential(target.providerId, cred, this.ctx.sessionId);
      this.print(
        `  ${ok(glyph("verified"))} ${muted("connected")} ${info(target.label)}${valid ? "" : faint(" (unverified)")}`,
      );
      // A fresh sign-in is almost always what you want to use next -- and this
      // is the moment the choice is unambiguous, so it is made here rather than
      // left as a second errand.
      this.applyModelSwitch(target.providerId, preset.defaultModel, false);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.print(`  ${danger(glyph("failure"))} ${muted("sign-in failed --")} ${faint(message)}`);
    }
  },

  /**
   * Connect a web-search engine: paste a key (or a URL for a self-hosted one),
   * keep it in the keychain, and prove it with one real search. A format check
   * would pass a revoked key; the engine's own answer is the only verification
   * that means anything, so that is what "connected" reports.
   */
  async runSearchLogin(this: Tui, target: LoginTarget): Promise<void> {
    const preset = getSearchPreset(target.providerId);
    if (!preset) return;
    if (preset.keyless) {
      this.print(
        `  ${ok(glyph("verified"))} ${info(preset.label)} ${muted("is built in -- it answers whenever nothing better is connected")}`,
      );
      return;
    }
    if (preset.urlEnvVar) {
      const current = process.env[preset.urlEnvVar] || preset.baseUrl || "";
      const url = (await this.promptLine(`${preset.label} URL:`, current))?.trim();
      if (!url) return;
      persistLocalEndpoint(preset.id, url);
      process.env[preset.urlEnvVar] = url;
      if (await this.reportSearchProbe(preset.id, preset.label)) this.preferSearch(preset);
      return;
    }
    const strategy = getStrategy("api_key", preset.id);
    if (!strategy) return;
    this.print(`  ${faint("connecting")} ${info(preset.label)} ${faint(`-- ${preset.hint}`)}`);
    try {
      const store = await openCredentialStore();
      const cred = await strategy.authenticate({
        providerId: preset.id,
        preset,
        store,
        env: process.env,
        prompt: async (q: string) => (await this.promptLine(q)) ?? "",
        log: (line?: string) => this.print(`  ${faint(line ?? "")}`),
      } as AuthContext);
      // The backends read the environment at call time; this is how the key
      // reaches the very next web_search without a restart.
      if (cred.secret && preset.envVar) process.env[preset.envVar] = cred.secret;
      if (await this.reportSearchProbe(preset.id, preset.label)) this.preferSearch(preset);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.print(`  ${danger(glyph("failure"))} ${muted("connect failed --")} ${faint(message)}`);
    }
  },

  /** One real search, reported honestly: connected, or saved-but-failing with the host's words. */
  async reportSearchProbe(this: Tui, id: string, label: string): Promise<boolean> {
    this.print(`  ${faint("running a test search...")}`);
    const probe = await probeSearchBackend(id);
    if (probe.ok) {
      this.print(
        `  ${ok(glyph("verified"))} ${muted("connected")} ${info(label)} ${faint(`| answered in ${probe.ms}ms`)}`,
      );
    } else {
      this.print(
        `  ${warn("!")} ${muted("saved, but a test search failed --")} ${faint(probe.detail ?? "no results")}`,
      );
      this.print(
        `  ${faint("it stays connected; web_search will try it after the engines that work")}`,
      );
    }
    return probe.ok;
  },

  /**
   * The engine you just connected is the one you meant to use -- the same
   * reasoning that makes a fresh model sign-in the session model. It leads
   * this session (RUNE_SEARCH_BACKEND is read per call) and the next ones
   * (prefs); `[search] provider` in config.toml still outranks it at boot.
   */
  preferSearch(this: Tui, preset: { id: string; label: string }): void {
    process.env.RUNE_SEARCH_BACKEND = preset.id;
    savePrefs({ search: preset.id });
    this.print(
      `  ${accent(glyph("phase"))} ${muted("web_search asks")} ${info(preset.label)} ${muted("first now")} ${faint("| kept for new sessions too")}`,
    );
  },

  /**
   * "Other local server" on the Offline route: LM Studio, vLLM, llama.cpp,
   * LiteLLM -- anything OpenAI-compatible on this machine. It is the one
   * custom endpoint slot, previously reachable only as
   * `/keys custom <url> <model> <key>`. The server's own /models list picks the
   * model when the server is up; otherwise the id is typed.
   */
  async runCustomLocalLogin(this: Tui): Promise<void> {
    const engine = this.ctx.engine;
    const existing = engine.getCustomEndpoint();
    const baseUrl = (
      await this.promptLine(
        "Server URL (OpenAI-compatible):",
        existing?.baseUrl ?? "http://localhost:1234/v1",
      )
    )?.trim();
    if (!baseUrl) return;
    const live = await fetchLiveModels("openai-compat", baseUrl);
    let model: string | undefined;
    if (live && live.length > 0) {
      const picked = await this.pick(
        `Model \u00b7 ${baseUrl}`,
        live.map((id) => ({ label: id, current: id === existing?.model })),
        Math.max(0, live.indexOf(existing?.model ?? "")),
        undefined,
        "enter choose \u00b7 esc back",
      );
      if (picked == null) return;
      model = live[picked];
    } else {
      this.print(
        `  ${warn("!")} ${muted("no model list at")} ${info(baseUrl)} ${faint("-- is the server running? type the model id")}`,
      );
      model = (await this.promptLine("Model id:", existing?.model ?? ""))?.trim();
    }
    if (!model) return;
    const typedKey = (
      await this.promptLine(
        "API key (enter for none):",
        existing?.key && existing.key !== "local" ? existing.key : "",
      )
    )?.trim();
    // The gateway registers the custom slot only with a non-empty key; a
    // keyless local server gets a placeholder it will ignore.
    const ep: CustomEndpoint = {
      baseUrl,
      model,
      key: typedKey || "local",
      label: existing?.label ?? "Local server",
    };
    persistCustom(ep);
    engine.setCustomEndpoint(ep, this.ctx.sessionId);
    this.applyModelSwitch(CUSTOM_PROVIDER_ID, model, false);
  },

  openKeys(this: Tui): void {
    this.keysRows = this.buildKeyRows();
    this.keysSel = 0;
    this.keysEdit = null;
    this.keysManage = null;
    this.mode = "keys";
    this.scheduleDraw();
  },

  buildKeyRows(this: Tui): KeyRow[] {
    // getProviderStatus() returns a superset of KeyRow (adds hasKey + pools).
    return this.ctx.engine.getProviderStatus();
  },

  closeKeys(this: Tui): void {
    this.keysEdit = null;
    this.keysManage = null;
    this.mode = "input";
    this.scheduleDraw();
  },
};

export type CommandMethods = typeof COMMAND_METHODS;
