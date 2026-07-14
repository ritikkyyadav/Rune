import { renderRepoMap } from "./prompts";
import type { RetrievedChunk } from "./context-engine";

const REPO_MAP_MAX_TOKENS = 1_200;
const REPO_MAP_MAX_FILES = 2_000;
const REPO_MAP_MAX_SYMBOLS = 160;
const REPO_MAP_TIMEOUT_MS = 12_000;

export interface NativeRepoMapOutput {
  content: string;
  estimated_tokens: number;
  total_files: number;
  total_symbols: number;
  selected_symbols: number;
  truncated: boolean;
}

interface NativeToolResponse {
  success?: boolean;
  result?: unknown;
}

export interface RepoMapOptions {
  workspaceRoot: string;
  binaryPath: string;
  query: string;
}

/**
 * Build one request-aware structural map. The Rust binary stays responsible
 * for parsing/ranking; this boundary only validates its JSON and falls back to
 * the legacy tracked-file tree when the optional native binary is unavailable.
 */
export async function buildRepoMap(options: RepoMapOptions): Promise<RetrievedChunk | null> {
  const native = await runNativeRepoMap(options);
  if (native && native.selected_symbols > 0) {
    return { content: native.content, relevance: 0.96 };
  }

  const fallback = renderRepoMap(options.workspaceRoot);
  if (!fallback) return null;
  return {
    content: `${fallback}\n\n[Structural ranking unavailable; this is a bounded file-tree fallback.]`,
    relevance: 0.62,
  };
}

export function parseRepoMapResponse(stdout: string): NativeRepoMapOutput | null {
  try {
    const parsed = JSON.parse(stdout) as NativeToolResponse;
    if (!parsed.success || !parsed.result || typeof parsed.result !== "object") return null;
    const result = parsed.result as Partial<NativeRepoMapOutput>;
    if (
      typeof result.content !== "string" ||
      !result.content.trim() ||
      !Number.isFinite(result.estimated_tokens) ||
      !Number.isFinite(result.total_files) ||
      !Number.isFinite(result.total_symbols) ||
      !Number.isFinite(result.selected_symbols) ||
      typeof result.truncated !== "boolean"
    ) {
      return null;
    }
    return result as NativeRepoMapOutput;
  } catch {
    return null;
  }
}

async function runNativeRepoMap(options: RepoMapOptions): Promise<NativeRepoMapOutput | null> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([options.binaryPath, "--workspace", options.workspaceRoot, "repo-map"], {
      stdin: new Blob([
        JSON.stringify({
          query: options.query.slice(0, 2_000),
          max_tokens: REPO_MAP_MAX_TOKENS,
          max_files: REPO_MAP_MAX_FILES,
          max_symbols: REPO_MAP_MAX_SYMBOLS,
        }),
      ]),
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch {
    return null;
  }

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill();
    } catch {
      // The process may have exited between the timer firing and kill().
    }
  }, REPO_MAP_TIMEOUT_MS);
  try {
    // Start both readers immediately. Leaving stderr unread can block a child
    // that emits a large diagnostic before it exits.
    const stdout = new Response(proc.stdout as ReadableStream<Uint8Array>).text();
    const stderr = new Response(proc.stderr as ReadableStream<Uint8Array>).text();
    const [output, exitCode] = await Promise.all([stdout, proc.exited]);
    await stderr;
    if (timedOut || exitCode !== 0) return null;
    return parseRepoMapResponse(output);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
