// --- The clipboard, for /copy ---
//
// Code in an answer is drawn inside a frame, and a terminal copies what it
// shows: selecting a long command copies its wrap as a line break. /copy puts
// the exact text on the clipboard instead -- the last code block of the last
// answer, or the whole answer with `/copy all`.
//
// Where the text goes: the platform's own clipboard command when this process
// runs on the machine in front of the person (pbcopy, clip, wl-copy, xclip,
// xsel), and otherwise -- over ssh, or with no command available -- the
// terminal's OSC 52 sequence, which asks the TERMINAL to set its clipboard. A
// terminal may ignore OSC 52 (macOS Terminal does), and nothing tells the
// sender; the result says which way the text went so the reply can be honest.

import { spawnSync } from "node:child_process";

export interface CopyResult {
  /** True when a clipboard command took the text; false when it was only
   *  offered to the terminal over OSC 52, which may ignore it. */
  confirmed: boolean;
  /** How it went: the command's name, or "osc52". */
  via: string;
}

export interface CopyDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Runs a clipboard command with `input` on stdin; true on success. */
  run?: (command: string, args: string[], input: string) => boolean;
  /** Writes to the terminal. */
  write?: (data: string) => void;
}

function runCommand(command: string, args: string[], input: string): boolean {
  try {
    const result = spawnSync(command, args, {
      input,
      timeout: 2000,
      stdio: ["pipe", "ignore", "ignore"],
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

/** The clipboard commands to try, in order, for this platform. */
export function clipboardCommands(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): Array<[string, string[]]> {
  if (platform === "darwin") return [["pbcopy", []]];
  if (platform === "win32") return [["clip", []]];
  const out: Array<[string, string[]]> = [];
  if (env.WAYLAND_DISPLAY) out.push(["wl-copy", []]);
  if (env.DISPLAY) {
    out.push(["xclip", ["-selection", "clipboard"]]);
    out.push(["xsel", ["--clipboard", "--input"]]);
  }
  return out;
}

/** OSC 52: ask the terminal to set its own clipboard. */
export function osc52(text: string): string {
  return `\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`;
}

export function copyText(text: string, deps: CopyDeps = {}): CopyResult {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const run = deps.run ?? runCommand;
  const write = deps.write ?? ((data: string) => void process.stdout.write(data));
  // Over ssh the clipboard commands reach the far machine's clipboard, not the
  // one under the person's hands: only the terminal can.
  const remote = Boolean(env.SSH_CONNECTION || env.SSH_TTY);
  if (!remote) {
    for (const [command, args] of clipboardCommands(platform, env)) {
      if (run(command, args, text)) return { confirmed: true, via: command };
    }
  }
  write(osc52(text));
  return { confirmed: false, via: "osc52" };
}

/**
 * The body of the last fenced code block in a markdown answer, or null.
 * A fence the model never closed still counts, to the end of the text.
 */
export function lastCodeBlock(markdown: string): string | null {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  let open: { mark: string; body: string[] } | null = null;
  let last: string | null = null;
  for (const line of lines) {
    const fence = /^\s*(```+|~~~+)/.exec(line);
    if (open) {
      if (fence && fence[1]!.startsWith(open.mark[0]!) && line.trim().startsWith(open.mark)) {
        last = open.body.join("\n");
        open = null;
      } else {
        open.body.push(line);
      }
    } else if (fence) {
      open = { mark: fence[1]!, body: [] };
    }
  }
  if (open && open.body.length > 0) last = open.body.join("\n");
  return last;
}
