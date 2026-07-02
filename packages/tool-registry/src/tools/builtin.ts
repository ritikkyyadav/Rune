import type { ToolSchema } from "../types";
import type { ToolRegistry } from "../registry";
import { createRustToolHandler } from "./rust-bridge";
import { FileFreshness, withFreshness } from "./freshness";
import {
  BackgroundShellManager,
  createBashOutputHandler,
  createKillShellHandler,
  withBackgroundSupport,
} from "./background";
import { createWebFetchHandler } from "./web-fetch";
import { createWebSearchHandler } from "./web-search";
import { createAstQueryHandler } from "./ast-query";
import { createTodoWriteHandler } from "./todo-write";
import { createGlobHandler } from "./glob";
import { createMultiEditHandler } from "./multi-edit";
import { createN8nTriggerHandler } from "./n8n";

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

const BASH_SCHEMA: ToolSchema = {
  name: "bash",
  version: "0.1.0",
  description:
    "Execute a bash command in the workspace directory. Returns stdout, stderr, and exit code. Has a 120s default timeout. For long-running commands (dev servers, watch builds), set run_in_background: true — you get a shell_id immediately; poll bash_output for output and kill_shell to stop it.",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "Bash command to execute" },
      timeout_ms: { type: "number", description: "Timeout in milliseconds" },
      run_in_background: {
        type: "boolean",
        description:
          "Run detached and return a shell_id immediately instead of waiting. Use for servers/watchers.",
      },
    },
    required: ["command"],
  },
  permissionLevel: "sandbox",
  category: "execute",
};

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

const ALL_SCHEMAS: Array<{ schema: ToolSchema; subcommand: string }> = [
  { schema: READ_FILE_SCHEMA, subcommand: "read-file" },
  { schema: LIST_DIR_SCHEMA, subcommand: "list-dir" },
  { schema: GREP_SCHEMA, subcommand: "grep" },
  { schema: WRITE_FILE_SCHEMA, subcommand: "write-file" },
  { schema: EDIT_FILE_SCHEMA, subcommand: "edit-file" },
  { schema: BASH_SCHEMA, subcommand: "bash" },
  { schema: SYMBOL_SEARCH_SCHEMA, subcommand: "symbol-search" },
];

/**
 * Register all built-in tools with the registry.
 * @param binaryPath - Path to the compiled alan-tools binary
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
  const shells = new BackgroundShellManager();

  for (const { schema, subcommand } of ALL_SCHEMAS) {
    let handler = createRustToolHandler(schema, subcommand, binaryPath);
    if (schema.name === "bash") handler = withBackgroundSupport(handler, shells);
    const opts = FRESHNESS_TOOLS[schema.name];
    registry.register(opts ? withFreshness(handler, freshness, opts) : handler);
  }
  registry.register(createBashOutputHandler(shells));
  registry.register(createKillShellHandler(shells));

  // TypeScript-native tools (no Rust binary needed)
  registry.register(createWebFetchHandler());
  registry.register(createWebSearchHandler());
  registry.register(createAstQueryHandler());
  registry.register(createTodoWriteHandler());
  registry.register(createGlobHandler());
  registry.register(withFreshness(createMultiEditHandler(), freshness));
  registry.register(createN8nTriggerHandler());
}
