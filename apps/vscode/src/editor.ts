// ─── Turning what is on screen into something the agent can use ───
//
// "Send selection to Gear" is only useful if what arrives is a location the
// agent can open, not a naked blob of code. A pasted fragment with no path
// forces the agent to search for something the person was already looking at.

export interface SelectionInput {
  /** Workspace-relative if possible; absolute otherwise. */
  path: string;
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  text: string;
  languageId?: string;
}

/** Characters of selected text sent inline before it is left to the agent to read. */
export const MAX_INLINE_SELECTION = 4_000;

/**
 * The message a selection becomes.
 *
 * The file and line range come FIRST and always, even when the text is
 * included: the agent should reach for the file, and the excerpt is context for
 * what the person meant, not a replacement for reading it.
 */
export function selectionMessage(input: SelectionInput, note?: string): string {
  const range =
    input.startLine === input.endLine
      ? `${input.path}:${input.startLine}`
      : `${input.path}:${input.startLine}-${input.endLine}`;

  const head = note?.trim() ? `${note.trim()}\n\n` : "";
  const body = input.text.trim();

  if (body.length === 0) return `${head}Look at ${range}.`;
  if (body.length > MAX_INLINE_SELECTION) {
    // A whole file pasted into a prompt is a context bill before the agent has
    // decided it needs any of it, and it has tools for reading files.
    return `${head}Look at ${range} — ${body.length} characters, read it from the file.`;
  }

  const fence = input.languageId ?? "";
  return `${head}From ${range}:\n\n\`\`\`${fence}\n${body}\n\`\`\``;
}

/** The message "Open trace for this file" sends. */
export function traceMessage(path: string): string {
  return `Show the trace for ${path}: which tool calls in this session touched it, and what each one did.`;
}

/** Workspace-relative when the file is inside it; absolute when it is not. */
export function relativePath(file: string, workspaceRoot: string | undefined): string {
  if (!workspaceRoot) return file;
  const root = workspaceRoot.replace(/\/+$/, "");
  return file.startsWith(`${root}/`) ? file.slice(root.length + 1) : file;
}
