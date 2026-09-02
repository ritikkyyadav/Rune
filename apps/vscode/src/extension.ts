// ─── The only file that imports `vscode` ───
//
// Everything with a decision in it lives in `serve.ts`, `panel.ts`,
// `editor.ts` and `status.ts`, which import nothing from the editor and are
// unit-tested in `tests/unit/vscode/`. This file is the wiring: commands,
// the webview, the status bar, and the child process.
//
// The extension is deliberately THIN. It does not reimplement the UI — it
// frames `gear web`, the same React bundle the desktop runs, trace rail
// included. A fourth client that had to be kept in step with the protocol by
// hand is exactly what Phase 2 exists to prevent.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import * as vscode from "vscode";

import { panelHtml, unavailableHtml } from "./panel";
import { relativePath, selectionMessage, traceMessage } from "./editor";
import { statusText, statusTooltip, type EngineStatus } from "./status";
import {
  endpointFromConfigFile,
  endpointFromSetting,
  listeningPort,
  spawnCommand,
  type ServeEndpoint,
} from "./serve";

const TOKEN_SECRET = "gear.serverToken";

let panel: vscode.WebviewPanel | null = null;
let child: ChildProcessWithoutNullStreams | null = null;
let endpoint: ServeEndpoint | null = null;
let status: vscode.StatusBarItem;
let output: vscode.OutputChannel;

// ─── Finding an engine ───

function gearHome(): string {
  return process.env.GEAR_HOME ?? join(homedir(), ".gear");
}

function runningEndpoint(): ServeEndpoint | null {
  try {
    return endpointFromConfigFile(
      JSON.parse(readFileSync(join(gearHome(), "serve.json"), "utf8")) as Record<string, never>,
    );
  } catch {
    return null;
  }
}

/** Whether something is actually answering there — the file outlives the process. */
async function alive(pageUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${pageUrl}/health`, { signal: AbortSignal.timeout(1_500) });
    return res.ok;
  } catch {
    return false;
  }
}

async function resolveEndpoint(context: vscode.ExtensionContext): Promise<ServeEndpoint> {
  const config = vscode.workspace.getConfiguration("gear");
  const local = runningEndpoint();

  // 1. A server the user pointed us at. They meant it.
  const configured = endpointFromSetting(
    config.get<string>("serverUrl") || undefined,
    (await context.secrets.get(TOKEN_SECRET)) || undefined,
    local,
  );
  if (configured && (await alive(configured.pageUrl))) return configured;

  // 2. One already running on this machine. Starting a second engine beside an
  //    engine somebody is watching is worse than any connection error.
  if (local && (await alive(local.pageUrl))) return local;

  // 3. Start one.
  return startServer(config.get<string>("path") || "gear");
}

function startServer(gearPath: string): Promise<ServeEndpoint> {
  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  // Port 0 is not offered: `gear serve` has its own default and the port it
  // actually bound is read back off stdout below.
  const [cmd, ...args] = spawnCommand(gearPath, workspace, 7788);
  output.appendLine(`$ ${cmd} ${args.join(" ")}`);

  return new Promise((resolve, reject) => {
    let proc: ChildProcessWithoutNullStreams;
    try {
      proc = spawn(cmd!, args, { cwd: workspace, env: process.env });
    } catch (err) {
      reject(new Error(`could not run ${gearPath}: ${String(err)}`));
      return;
    }
    child = proc;

    const timer = setTimeout(
      () => reject(new Error("gear serve did not report a port within 60s")),
      60_000,
    );

    const onLine = (line: string): void => {
      output.appendLine(line);
      const port = listeningPort(line);
      if (port == null) return;
      clearTimeout(timer);
      // The token file is written before the banner, so by the time a port has
      // been printed there is one to read.
      const found = runningEndpoint();
      if (!found) {
        reject(new Error("gear serve came up but wrote no token file"));
        return;
      }
      resolve({ ...found, pageUrl: `http://127.0.0.1:${port}`, source: "spawned" });
    };

    for (const stream of [proc.stdout, proc.stderr]) {
      let buffer = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => {
        buffer += chunk;
        let at: number;
        while ((at = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, at);
          buffer = buffer.slice(at + 1);
          if (line.trim()) onLine(line);
        }
      });
    }

    proc.on("exit", (code) => {
      output.appendLine(`gear serve exited (${code})`);
      child = null;
      clearTimeout(timer);
      reject(new Error(`gear serve exited with code ${code}`));
    });
  });
}

// ─── The panel ───

function nonce(): string {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

function currentTheme(): "light" | "dark" {
  const kind = vscode.window.activeColorTheme.kind;
  return kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight
    ? "light"
    : "dark";
}

async function openPanel(context: vscode.ExtensionContext): Promise<vscode.WebviewPanel> {
  if (panel) {
    panel.reveal(vscode.ViewColumn.Beside);
    return panel;
  }

  panel = vscode.window.createWebviewPanel("gear.panel", "Gear", vscode.ViewColumn.Beside, {
    enableScripts: true,
    retainContextWhenHidden: true,
  });
  panel.onDidDispose(() => {
    panel = null;
  });

  try {
    endpoint = await resolveEndpoint(context);
    panel.webview.html = panelHtml({
      pageUrl: endpoint.pageUrl,
      token: endpoint.token,
      nonce: nonce(),
      theme: currentTheme(),
    });
    setStatus({ connected: true, gear: null, model: null, costUsd: null });
    output.appendLine(`connected to ${endpoint.pageUrl} (${endpoint.source})`);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    panel.webview.html = unavailableHtml(`Could not reach a Gear engine: ${reason}`, nonce());
    setStatus(null);
    output.appendLine(`failed: ${reason}`);
  }
  return panel;
}

/** Hand the page something the editor produced. */
async function sendToPanel(
  context: vscode.ExtensionContext,
  message: Record<string, unknown>,
): Promise<void> {
  const open = await openPanel(context);
  await open.webview.postMessage(message);
}

// ─── Status bar ───

function setStatus(state: EngineStatus | null): void {
  status.text = statusText(state);
  status.tooltip = statusTooltip(state);
  status.show();
}

// ─── Activation ───

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel("Gear");
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = "gear.openPanel";
  setStatus(null);
  context.subscriptions.push(status, output);

  context.subscriptions.push(
    vscode.commands.registerCommand("gear.openPanel", () => openPanel(context)),

    vscode.commands.registerCommand("gear.sendSelection", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        void vscode.window.showInformationMessage("Gear: no active editor.");
        return;
      }
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const sel = editor.selection;
      const message = selectionMessage({
        path: relativePath(editor.document.uri.fsPath, root),
        startLine: sel.start.line + 1,
        endLine: sel.end.line + 1,
        text: editor.document.getText(sel),
        languageId: editor.document.languageId,
      });
      await sendToPanel(context, { type: "gear.compose", text: message });
    }),

    vscode.commands.registerCommand("gear.openTrace", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        void vscode.window.showInformationMessage("Gear: no active editor.");
        return;
      }
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const path = relativePath(editor.document.uri.fsPath, root);
      await sendToPanel(context, { type: "gear.trace", path, text: traceMessage(path) });
    }),

    vscode.commands.registerCommand("gear.setToken", async () => {
      const value = await vscode.window.showInputBox({
        prompt: "Bearer token for the configured Gear server",
        password: true,
        // Never a plain setting: settings sync between machines and get
        // committed in .vscode/settings.json, and this token is remote code
        // execution with the user's provider credentials attached.
        ignoreFocusOut: true,
      });
      if (value) await context.secrets.store(TOKEN_SECRET, value);
    }),
  );
}

export function deactivate(): void {
  // The engine we started is ours to stop; one that was already running is not.
  if (child && endpoint?.source === "spawned") child.kill();
  child = null;
}
