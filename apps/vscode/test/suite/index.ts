// ─── The half that runs INSIDE VS Code ───
//
// `@vscode/test-electron` launches a real VS Code with the extension loaded in
// development mode and calls `run()` from this module inside the extension
// host. So everything here is the editor's own API against the real extension:
// no mock of `vscode`, no fake webview, no stub for the command registry.
//
// It is deliberately assertion-only and framework-free. Mocha would be three
// more dependencies and a `.mocharc` to make `expect` work in an Electron
// renderer; a `run()` that throws is the entire contract `test-electron` needs.
//
// What it CANNOT do is look inside the webview: the iframe is cross-origin to
// the extension host and its DOM is opaque from here. That is why the proof is
// split — the launcher (`../runTest.ts`) watches the same `gear serve` through
// the SDK and writes a marker file the moment a session carries the turn, and
// this side waits for that marker. Both halves assert the same fact from
// opposite ends of the integration.

import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import * as vscode from "vscode";

const EXTENSION_ID = "savoir.gear";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Where the launcher and this side leave notes for each other. */
function proofDir(): string {
  const dir = process.env.GEAR_VSCODE_PROOF_DIR;
  assert(dir, "GEAR_VSCODE_PROOF_DIR was not set — the launcher must provide it");
  return dir;
}

function note(name: string, body: string): void {
  writeFileSync(join(proofDir(), name), body);
}

export async function run(): Promise<void> {
  const dir = proofDir();
  const steps: string[] = [];
  const record = (line: string): void => {
    steps.push(line);
    note("suite.log", steps.join("\n") + "\n");
  };

  try {
    // ── the extension loads at all ──
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert(extension, `${EXTENSION_ID} is not present — the .vsix manifest or publisher changed`);
    await extension.activate();
    assert(extension.isActive, `${EXTENSION_ID} did not activate`);
    record(`activated ${EXTENSION_ID} v${String(extension.packageJSON.version)}`);

    // ── every contributed command is registered ──
    //
    // A command in package.json with no `registerCommand` behind it fails only
    // when a person clicks it, which is exactly the class of defect this whole
    // item exists to close.
    const registered = new Set(await vscode.commands.getCommands(true));
    const contributed = (
      extension.packageJSON.contributes?.commands as Array<{ command: string }>
    ).map((c) => c.command);
    for (const command of contributed) {
      assert(registered.has(command), `${command} is contributed but never registered`);
    }
    record(`commands registered: ${contributed.join(", ")}`);

    // ── a file, and a selection in it ──
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert(folder, "no workspace folder — the launcher must open one");
    const file = vscode.Uri.file(join(folder.uri.fsPath, "src", "total.ts"));
    const doc = await vscode.workspace.openTextDocument(file);
    const editor = await vscode.window.showTextDocument(doc);
    // Lines 2–3 (1-based), the body of the function the launcher wrote.
    editor.selection = new vscode.Selection(1, 0, 2, doc.lineAt(2).text.length);
    assert(editor.document.getText(editor.selection).length > 0, "the selection came out empty");
    record(`selected ${file.fsPath}:2-3`);

    // ── the panel, framing a real `gear serve --web` ──
    await vscode.commands.executeCommand("gear.openPanel");
    const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).map((t) => t.label);
    assert(
      tabs.includes("Gear"),
      `gear.openPanel opened no webview — tabs are: ${tabs.join(", ") || "(none)"}`,
    );
    record(`gear.openPanel opened the webview (tabs: ${tabs.join(", ")})`);

    // ── the selection, sent ──
    await vscode.commands.executeCommand("gear.sendSelection");
    record("gear.sendSelection returned");

    // ── the launcher's half ──
    //
    // The webview has to load the bundle, read the token out of the fragment,
    // open its socket, accept the posted message and start a turn. All of that
    // is invisible from here; the launcher sees it on the server and says so.
    const marker = join(dir, "turn-observed");
    const failure = join(dir, "turn-failed");
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      if (existsSync(marker)) {
        record(`launcher observed the turn: ${readFileSync(marker, "utf8").trim()}`);
        return;
      }
      if (existsSync(failure)) {
        throw new Error(`the launcher gave up: ${readFileSync(failure, "utf8").trim()}`);
      }
      await sleep(250);
    }
    throw new Error(
      "the webview never produced a turn on the server within 180s — " +
        "the panel opened, the command ran, and nothing reached the engine",
    );
  } catch (err) {
    record(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
}
