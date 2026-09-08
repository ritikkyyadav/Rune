import type { ToolSchema } from "../types";
import type { ToolRegistry } from "../registry";
import { isOsIsolationAvailable, onSandboxCapabilityChange } from "../sandbox-capability";
import { getSandboxPolicy, isSandboxEnabled, onSandboxPolicyChange } from "../sandbox-mode";
import { createRustToolHandler } from "./rust-bridge";
import { FileFreshness, withFreshness } from "./freshness";
import { createReadManyHandler } from "./read-many";
import {
  BackgroundShellManager,
  createBashOutputHandler,
  createKillShellHandler,
  withBackgroundSupport,
} from "./background";
import { createWebFetchHandler } from "./web-fetch";
import { createWebSearchHandler } from "./web-search";
import { createTodoWriteHandler } from "./todo-write";
import { createGlobHandler } from "./glob";
import { createMultiEditHandler } from "./multi-edit";
import { createApplyPatchHandler } from "./apply-patch";
import { withLspFeedback } from "./lsp/feedback";
import { createN8nTriggerHandler } from "./n8n";
import { createLoadToolsTool } from "./load-tools";
import { createLspHandler } from "./lsp/tool";
import { LspServerManager } from "./lsp/manager";
import { withSyntaxCheck } from "./diagnostics";
import { withFormatting } from "./format-on-write";
import { withNetworkPreflight } from "./net-preflight";

const READ_FILE_SCHEMA: ToolSchema = {
  name: "read_file",
  version: "0.1.0",
  description:
    "Read a file from the workspace. Returns content with line numbers, SHA-256 hash, and truncation info. Use offset/limit for large files.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path (relative to workspace or absolute)" },
      offset: { type: "number", description: "Line offset to start from (0-based)" },
      limit: { type: "number", description: "Maximum number of lines to return" },
    },
    required: ["path"],
  },
  permissionLevel: "auto",
  category: "read",
};

const LIST_DIR_SCHEMA: ToolSchema = {
  name: "list_dir",
  version: "0.1.0",
  description:
    "List directory contents. Returns file names, sizes, and types. Supports recursive listing and glob filtering.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory path" },
      recursive: { type: "boolean", description: "Recurse into subdirectories" },
      glob: { type: "string", description: "Glob pattern to filter entries" },
      limit: { type: "number", description: "Maximum entries to return" },
    },
    required: ["path"],
  },
  permissionLevel: "auto",
  category: "read",
};

const GREP_SCHEMA: ToolSchema = {
  name: "grep",
  version: "0.1.0",
  description:
    "Search file contents using regex or literal patterns. Returns matching lines with file paths and line numbers.",
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Search pattern" },
      path: { type: "string", description: "File or directory to search" },
      glob: { type: "string", description: "Glob to filter files" },
      regex: { type: "boolean", description: "Treat pattern as regex (default true)" },
      case_insensitive: { type: "boolean", description: "Case-insensitive search" },
      max_results: { type: "number", description: "Max matches to return" },
      context_lines: { type: "number", description: "Context lines around matches" },
    },
    required: ["pattern"],
  },
  permissionLevel: "auto",
  category: "read",
};

const WRITE_FILE_SCHEMA: ToolSchema = {
  name: "write_file",
  version: "0.1.0",
  description:
    "Write content to a file atomically. Creates parent directories if needed. Use for creating new files or full rewrites.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path to write" },
      content: { type: "string", description: "Content to write" },
    },
    required: ["path", "content"],
  },
  permissionLevel: "confirm",
  category: "write",
};

const EDIT_FILE_SCHEMA: ToolSchema = {
  name: "edit_file",
  version: "0.1.0",
  description:
    "Edit a file by replacing old_text with new_text. You must have read the file (read_file) in this session first — staleness is checked automatically. old_text must be unique unless replace_all is true.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path to edit" },
      old_text: { type: "string", description: "Exact text to find and replace" },
      new_text: { type: "string", description: "Replacement text" },
      expected_hash: {
        type: "string",
        description:
          "Optional SHA-256 hash from read_file. Usually omit — the harness supplies your last-read hash automatically.",
      },
      replace_all: { type: "boolean", description: "Replace all occurrences" },
    },
    required: ["path", "old_text", "new_text"],
  },
  permissionLevel: "confirm",
  category: "write",
};

const BASH_DESC_COMMON =
  "Execute a bash command in the workspace directory. Returns stdout, stderr, and exit code. Has a 120s default timeout. " +
  "For long-running commands (dev servers, watch builds), set run_in_background: true — you get a shell_id immediately; poll bash_output for output and kill_shell to stop it.";

const BASH_DESC_SANDBOXED =
  BASH_DESC_COMMON +
  " Commands run in an OS sandbox with NO network access by default; on macOS loopback is open, so a local server on 127.0.0.1 and a curl against it work without it. For commands that need the internet " +
  "(npm/pip/cargo/brew install, git push/pull/fetch/clone, curl/wget to a remote host, gh), set network: true — otherwise they fail with DNS/connection errors.";

const BASH_DESC_FULL_ACCESS =
  BASH_DESC_COMMON +
  " The sandbox is DISABLED for this session: commands run directly on the host with full network and filesystem access. Do not set network: true — it is unnecessary.";

const BASH_DESC_DEGRADED =
  BASH_DESC_COMMON +
  " The sandbox is ON but this machine has NO OS isolation backend: commands run with path-guard checks only — full network and host filesystem access, nothing is contained. Do not set network: true — it is unnecessary. Treat every command as running directly on the user's machine.";

const BASH_NET_DESC_SANDBOXED =
  "Allow network access for this command while retaining filesystem containment and credential protections. Use for package installs and internet requests. This does not permit writes outside the workspace.";

const BASH_NET_DESC_FULL_ACCESS =
  "No effect — the sandbox is disabled, so every command already has full network and filesystem access.";

const BASH_UNSANDBOXED_DESC_FALLBACK =
  "Run this one command OUTSIDE the OS sandbox, on the host with full filesystem access. Only for a command that " +
  "already failed on a sandbox restriction (a write outside the workspace, a tool that needs host state) — " +
  "the result carries a sandbox_hint when that happened. The retry goes through the regular permission prompt. " +
  "Never use it for network access alone: that is network: true.";

const BASH_UNSANDBOXED_DESC_STRICT =
  "Not available — the sandbox is strict. A command that needs host access is refused; report which access it " +
  "needs so the user can add it to excludedCommands.";

const BASH_UNSANDBOXED_DESC_OFF =
  "No effect — the sandbox is disabled, so every command already runs on the host.";

const BASH_SCHEMA: ToolSchema = {
  name: "bash",
  version: "0.1.0",
  description: BASH_DESC_SANDBOXED,
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "Bash command to execute" },
      timeout_ms: { type: "number", description: "Timeout in milliseconds" },
      network: {
        type: "boolean",
        description: BASH_NET_DESC_SANDBOXED,
      },
      run_in_background: {
        type: "boolean",
        description:
          "Run detached and return a shell_id immediately instead of waiting. Use for servers/watchers.",
      },
      unsandboxed: {
        type: "boolean",
        description: BASH_UNSANDBOXED_DESC_FALLBACK,
      },
    },
    required: ["command"],
  },
  permissionLevel: "sandbox",
  category: "execute",
};

// The registry and every provider serialization hold this schema object by
// reference, so swapping the strings in place when /sandbox toggles (or the
// capability probe lands) means the very next model turn sees an accurate
// contract — no re-registration needed. Three truthful states: sandboxed
// (on + isolation available), degraded (on + no backend on this machine),
// full access (off).
function refreshBashDescriptions(): void {
  const enabled = isSandboxEnabled();
  const isolated = isOsIsolationAvailable();
  const policy = getSandboxPolicy();
  // Excluded commands are stated to the model so it neither sets network:
  // true for them nor wonders why `adb` reached the host.
  const excluded =
    enabled && isolated && policy.excludedCommands.length
      ? ` These command patterns run OUTSIDE the sandbox on the host (the user excluded them; the regular permission prompt applies): ${policy.excludedCommands.join(", ")}.`
      : "";
  BASH_SCHEMA.description =
    (!enabled ? BASH_DESC_FULL_ACCESS : isolated ? BASH_DESC_SANDBOXED : BASH_DESC_DEGRADED) +
    excluded;
  const props = BASH_SCHEMA.inputSchema.properties as Record<string, { description?: string }>;
  if (props.network) {
    props.network.description =
      enabled && isolated ? BASH_NET_DESC_SANDBOXED : BASH_NET_DESC_FULL_ACCESS;
  }
  if (props.unsandboxed) {
    props.unsandboxed.description = !enabled
      ? BASH_UNSANDBOXED_DESC_OFF
      : policy.allowUnsandboxedFallback
        ? BASH_UNSANDBOXED_DESC_FALLBACK
        : BASH_UNSANDBOXED_DESC_STRICT;
  }
}
onSandboxPolicyChange(refreshBashDescriptions);
onSandboxCapabilityChange(refreshBashDescriptions);

const SYMBOL_SEARCH_SCHEMA: ToolSchema = {
  name: "symbol_search",
  version: "0.1.0",
  description:
    "Search for code symbols (functions, classes, structs, etc.) across the workspace. Uses the code index for fast lookup. Returns symbol names, file locations, signatures, and doc comments.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Name pattern to search for (substring match)" },
      kind: {
        type: "string",
        description:
          "Filter by symbol kind: function, method, class, struct, enum, trait, interface, type, constant, impl",
      },
      file_glob: {
        type: "string",
        description: "Glob pattern to filter files (e.g. 'src/**/*.rs')",
      },
      limit: { type: "number", description: "Max results (default 25)" },
      reindex: {
        type: "boolean",
        description: "Re-index the workspace before searching (use on first call or after edits)",
      },
    },
    required: ["query"],
  },
  permissionLevel: "auto",
  category: "read",
};

const SEARCH_CODE_SCHEMA: ToolSchema = {
  name: "search_code",
  version: "0.1.0",
  description:
    "Ranked full-text search over the codebase — ask it QUESTIONS, not exact strings. " +
    "Use for 'where do we handle X' / 'which code does Y' queries where grep's literal matching fails; " +
    "results are function/class-sized chunks ranked by relevance (BM25 over symbol-chunked content), " +
    "each with path, symbol, line, and a snippet. The index refreshes incrementally on every call, so " +
    "results are never stale. Prefer grep for exact identifiers you already know; prefer symbol_search " +
    "for name lookups; prefer this for concept and behavior questions.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "Natural-language or keyword query, e.g. 'where are stripe webhook retries handled'",
      },
      limit: { type: "number", description: "Max results (default 10, cap 50)" },
    },
    required: ["query"],
  },
  permissionLevel: "auto",
  category: "read",
};

const ALL_SCHEMAS: Array<{ schema: ToolSchema; subcommand: string }> = [
  { schema: READ_FILE_SCHEMA, subcommand: "read-file" },
  { schema: LIST_DIR_SCHEMA, subcommand: "list-dir" },
  { schema: GREP_SCHEMA, subcommand: "grep" },
  { schema: WRITE_FILE_SCHEMA, subcommand: "write-file" },
  { schema: EDIT_FILE_SCHEMA, subcommand: "edit-file" },
  { schema: BASH_SCHEMA, subcommand: "bash" },
  { schema: SYMBOL_SEARCH_SCHEMA, subcommand: "symbol-search" },
  { schema: SEARCH_CODE_SCHEMA, subcommand: "search-code" },
];

// ONE language-server manager per PROCESS, not per registry. The manager
// already keys its servers by (language, workspace) and installs a
// process-exit teardown hook, so a manager per registry meant one
// typescript-language-server per registry — and every sub-agent, worker and
// research run builds its own registry. That was survivable while servers only
// spawned when the model called the `lsp` tool by hand; post-edit diagnostics
// (P10.1) spawn one on the write path, which makes the multiplier real. Shared,
// a worker's first edit lands on the lead's already-warm server, which is also
// the difference between a block arriving inside the 2s budget and not.
let sharedLspManager: LspServerManager | null = null;
function lspManagerForProcess(): LspServerManager {
  sharedLspManager ??= new LspServerManager();
  return sharedLspManager;
}

/** Stop every language server this process started (engine shutdown, tests). */
export async function stopLanguageServers(): Promise<void> {
  await sharedLspManager?.stopAll();
}

/**
 * Register all built-in tools with the registry.
 * @param binaryPath - Path to the compiled rune-tools binary
 */
export function registerBuiltinTools(registry: ToolRegistry, binaryPath: string): void {
  // Harness-side file-state tracking: read_file/write_file/edit_file/multi_edit
  // record each file's post-call hash; edit tools get the hash injected
  // automatically instead of making the model plumb SHA-256 strings through.
  const freshness = new FileFreshness();
  const FRESHNESS_TOOLS: Record<string, { requiresFreshRead?: boolean }> = {
    read_file: {},
    write_file: {},
    edit_file: { requiresFreshRead: true },
  };

  // Background shells: bash gains run_in_background; bash_output/kill_shell
  // monitor and stop them. One manager per registry (killed on process exit).
  const shells = new BackgroundShellManager(binaryPath);

  // The on-demand `lsp` tool, the post-edit feedback wrapper and apply_patch
  // all share the process's one manager (see lspManagerForProcess above).
  const lspManager = lspManagerForProcess();

  // Captured after its freshness wrap so read_many's inner reads record
  // hashes exactly like plain read_file calls (edits stay valid either way).
  let readFileHandler: import("../types").ToolHandler | null = null;
  for (const { schema, subcommand } of ALL_SCHEMAS) {
    let handler = createRustToolHandler(schema, subcommand, binaryPath);
    // Order matters: preflight sees the raw args first, so a sandboxed
    // `npm install` fails in ~0ms instead of hanging to the 120s timeout.
    if (schema.name === "bash") {
      handler = withNetworkPreflight(withBackgroundSupport(handler, shells));
    }
    // Write tools get instant post-edit syntax feedback, plus the language
    // server's semantic verdict when [lsp] autoFeedback is on (both inside
    // freshness so the added fields never disturb hash extraction).
    if (schema.category === "write") {
      handler = withLspFeedback(withSyntaxCheck(withFormatting(handler)), lspManager);
    }
    const opts = FRESHNESS_TOOLS[schema.name];
    const wrapped = opts ? withFreshness(handler, freshness, opts) : handler;
    if (schema.name === "read_file") readFileHandler = wrapped;
    registry.register(wrapped);
  }
  // Batched reads: one model round-trip for up to 12 files. Registered right
  // after the single-read tool it composes.
  if (readFileHandler) {
    registry.register(createReadManyHandler(readFileHandler));
  }
  registry.register(createBashOutputHandler(shells));
  registry.register(createKillShellHandler(shells));

  // TypeScript-native tools (no Rust binary needed)
  registry.register(createWebFetchHandler());
  registry.register(createWebSearchHandler());
  // Real language servers, lazily spawned per language on first use; the
  // manager guarantees teardown (graceful on stopAll, SIGKILL on exit).
  registry.register(createLspHandler(lspManager));
  registry.register(createTodoWriteHandler());
  registry.register(createGlobHandler());
  registry.register(
    withFreshness(
      withLspFeedback(withSyntaxCheck(withFormatting(createMultiEditHandler())), lspManager),
      freshness,
    ),
  );
  // Codex-family edit format. Registered for everyone (execution is model-
  // agnostic) but only ADVERTISED to models trained on it — see
  // ToolRegistry.toLlmTools(forModel). Does its own per-file syntax AND
  // language-server pass (both wrappers are single-path; a patch touches many).
  registry.register(createApplyPatchHandler(lspManager));
  registry.register(createN8nTriggerHandler());
  // Turns a catalog line into a usable schema. Advertised only while something
  // is still deferred (ToolRegistry.toLlmTools), so a connector-less session
  // never sees it.
  registry.register(createLoadToolsTool(registry));
}
