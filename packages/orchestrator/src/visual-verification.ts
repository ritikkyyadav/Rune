import { existsSync, readdirSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolCallOutput } from "@rune/tool-registry";

export interface VisualReviewState {
  revision: number;
  origins: string[];
  url?: string;
  width?: number;
  captures: Array<{
    revision: number;
    url: string;
    width?: number;
    pixels: boolean;
    fetched?: boolean;
  }>;
  interactionRevision?: number;
  interactionObserved?: boolean;
  status: "pending" | "reviewed";
  missing: string[];
  /** Evidence available for this revision. A fetch is partial evidence, never completed visual review. */
  method?: "browser" | "fetch";
}
const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]", "0.0.0.0"]);
const HTML_DOCUMENT = /<!doctype html|<html[\s>]/i;
export class VisualVerification {
  private state: VisualReviewState;
  /**
   * Whether a browser is mounted in this run. The receipts below can only be
   * produced by the Playwright MCP, which is off unless `--browser` or
   * `[browser] enabled`; asking a run without one for a narrow-viewport
   * screenshot is asking for something no tool can give. Without a browser
   * the bar is the best this environment can do: fetch the served page and
   * read what it actually returns.
   */
  private readonly browser: boolean;
  constructor(
    private root: string,
    prior?: VisualReviewState,
    opts: { browser?: boolean } = {},
  ) {
    this.state = prior
      ? structuredClone(prior)
      : { revision: 0, origins: [], captures: [], status: "pending", missing: [] };
    this.browser = opts.browser ?? true;
  }
  changed(): void {
    this.state.revision++;
    this.state.captures = [];
    this.state.interactionRevision = undefined;
    this.state.interactionObserved = false;
  }
  private own(url: string): boolean {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "file:") {
        const rel = relative(this.root, fileURLToPath(parsed));
        return rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel);
      }
      return this.state.origins.includes(parsed.origin);
    } catch {
      return false;
    }
  }
  observe(
    tool: string,
    args: Record<string, unknown>,
    output: ToolCallOutput,
    imagesVisible: boolean,
    sameBatchWrite = false,
  ): boolean {
    if (!output.success) return false;
    if (["bash", "bash_output", "interactive_dashboard"].includes(tool)) {
      // Only a URL emitted by this workspace's runtime establishes a preview.
      // Visiting an arbitrary localhost site does not establish ownership.
      const cwd = typeof args.cwd === "string" ? resolve(this.root, args.cwd) : this.root;
      const rel = relative(this.root, cwd);
      if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) return false;
      for (const value of output.result.match(/https?:\/\/[^\s<>"'\\)]+/g) ?? []) {
        try {
          const url = new URL(value);
          if (LOCAL.has(url.hostname) && !this.state.origins.includes(url.origin))
            this.state.origins.push(url.origin);
        } catch {
          /* incomplete output */
        }
      }
      this.state.origins = this.state.origins.slice(-16);
      // The no-browser receipt: the shell fetched a page the workspace itself
      // is serving and got a real HTML document back. Weaker than pixels — it
      // cannot see layout — but it is the served response, not the source.
      const command = typeof args.command === "string" ? args.command : "";
      const served = this.state.origins.find((origin) => command.includes(origin));
      if (tool === "bash" && served && !sameBatchWrite && HTML_DOCUMENT.test(output.result)) {
        this.state.captures.push({
          revision: this.state.revision,
          url: served,
          pixels: false,
          fetched: true,
        });
        this.state.captures = this.state.captures.slice(-24);
        return true;
      }
    }
    if (!/^mcp_browser_(?:browser_)?/.test(tool)) return false;
    const action = tool.replace(/^mcp_browser_(?:browser_)?/, "");
    const reported = /(?:Page URL|URL):\s*(https?:\/\/\S+|file:\/\/\S+)/i.exec(output.result)?.[1];
    if (reported) this.state.url = reported.replace(/[)"'`]+$/, "");
    else if (action === "navigate" && typeof args.url === "string") this.state.url = args.url;
    else if (action === "tabs") this.state.url = undefined; // unknown selected tab
    if (action === "resize" && typeof args.width === "number" && args.width > 0)
      this.state.width = args.width;
    if (!this.state.url || !this.own(this.state.url) || sameBatchWrite) return false;
    if (/^(?:click|type|fill_form|press_key|select_option|drag)$/.test(action)) {
      this.state.interactionRevision = this.state.revision;
    }
    const pixels =
      action === "take_screenshot" &&
      imagesVisible &&
      (output.attachments?.some((a) => a.kind === "image") ?? false);
    const structure =
      action === "snapshot" &&
      /(?:Page Snapshot|Snapshot:|```yaml|\b(?:heading|button|main|document)\b)/i.test(
        output.result,
      );
    if (!pixels && !structure) return false;
    this.state.captures.push({
      revision: this.state.revision,
      url: this.state.url,
      width: this.state.width,
      pixels,
    });
    this.state.captures = this.state.captures.slice(-24);
    if (this.state.interactionRevision === this.state.revision)
      this.state.interactionObserved = true;
    return true;
  }
  snapshot(): VisualReviewState {
    const captures = this.state.captures.filter((c) => c.revision === this.state.revision);
    const missing: string[] = [];
    // A browser call that actually happened outranks the registry's opinion:
    // the receipts it produced are the stronger evidence, so they set the bar.
    const browser = this.browser || this.state.captures.some((c) => !c.fetched);
    if (browser) {
      const seen = captures.filter((c) => !c.fetched);
      if (!seen.some((c) => c.pixels))
        missing.push("inspect a screenshot of the current workspace preview");
      if (!seen.some((c) => (c.width ?? Infinity) <= 480))
        missing.push("inspect a narrow viewport (480px or less)");
      if (!seen.some((c) => (c.width ?? 0) >= 1024))
        missing.push("inspect a wide viewport (1024px or more)");
      if (!this.state.interactionObserved)
        missing.push("exercise an interaction and inspect its resulting state");
      this.state.method = "browser";
    } else {
      if (!captures.some((c) => c.fetched))
        missing.push(
          "fetch the served page (curl its local URL) and read what it actually returns — no browser is mounted in this run; enable one with --browser for screenshot review",
        );
      missing.push(
        "visual review is incomplete: enable --browser to inspect layout and interactions; fetching HTML only checks the served response",
      );
      this.state.method = "fetch";
    }
    this.state.missing = missing;
    this.state.status = missing.length ? "pending" : "reviewed";
    return structuredClone(this.state);
  }
  get required(): boolean {
    return this.state.revision > 0;
  }
}

/** Multi-file patches must invalidate screenshots just like write_file does. */
export function visualChangedPaths(
  tool: string,
  args: Record<string, unknown>,
  output: ToolCallOutput,
): string[] {
  if (!output.success || output.structured?.integration === "retained") return [];
  const paths: string[] = [];
  if (typeof args.path === "string") paths.push(args.path);
  if (Array.isArray(args.edits))
    for (const edit of args.edits) if (edit && typeof edit.path === "string") paths.push(edit.path);
  if (tool === "worker") {
    const changed = output.structured?.filesChanged;
    if (Array.isArray(changed))
      for (const file of changed) {
        if (typeof file === "string") paths.push(file);
        else if (file && typeof file.path === "string") paths.push(file.path);
      }
  }
  if (tool === "apply_patch") {
    const patch = args.patch ?? args.input;
    if (typeof patch === "string")
      for (const match of patch.matchAll(/^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/gm))
        paths.push(match[1]!);
  }
  return paths;
}

// ─── Pre-flight: what this run can and cannot see (Phase 5 F2) ───
//
// The expensive discovery used to arrive at the finish gate: a frontend build
// ran to completion, G6 asked for screenshots, and only then did it emerge
// that no browser was mounted and none could be. The whole run had been
// planned around a capability it never had.
//
// So the limit is stated on the FIRST turn instead, in the two places a limit
// has to appear to be real: on screen as a notice, and in the read-back's
// `leave` list, where the model's own contract with the person records what it
// is not going to be able to do.

/** The one sentence. Same words on screen, in the brief, and in the prompt. */
export const NO_BROWSER_PREFLIGHT =
  "no browser in this run: visual review will be a fetch, not a capture";

/**
 * What a run without a browser should be told before it spends anything.
 * Null when a browser IS mounted, or the request is not frontend-shaped —
 * a backend fix must not pay one byte for this.
 */
export function browserPreflightNote(
  frontendShaped: boolean,
  browserMounted: boolean,
): string | null {
  if (!frontendShaped || browserMounted) return null;
  return NO_BROWSER_PREFLIGHT;
}

/** Where a Playwright module or a downloaded Chromium was found, if anywhere. */
export interface BrowserRuntimeProbe {
  /** A resolvable `@playwright/mcp` — what `buildBrowserServerSpec` runs. */
  mcpModule: string | null;
  /** A resolvable `playwright` / `playwright-core`, or one named by the env. */
  playwrightModule: string | null;
  /** Playwright's browsers root, when it exists on this machine. */
  browsersDir: string | null;
  /** Chromium builds found under it, newest-looking first. */
  chromium: string[];
}

/**
 * Probe this machine for the browser runtime, the way the browser server
 * itself reaches it.
 *
 * `buildBrowserServerSpec` runs `bunx @playwright/mcp@latest`, which is a
 * NETWORK fetch on a machine that has never run it, and `--browser chromium`
 * needs a managed Chromium that `playwright install chromium` downloads into
 * Playwright's own cache. Neither is installed by Rune, and neither failure is
 * visible until the first navigate call fails inside a run. Reported here
 * instead, free and offline, alongside the config state.
 *
 * `RUNE_TEST_PLAYWRIGHT` / `RUNE_BENCH_PLAYWRIGHT` are honoured because they
 * are how this repository's own browser tests and the frontend eval fixture
 * find a module; a machine that has one has a Playwright, whatever npm thinks.
 */
export function probeBrowserRuntime(
  env: Record<string, string | undefined> = process.env,
  home = process.env.HOME ?? "",
): BrowserRuntimeProbe {
  const resolve_ = (spec: string): string | null => {
    try {
      const bun = (globalThis as { Bun?: { resolveSync?: (s: string, from: string) => string } })
        .Bun;
      if (bun?.resolveSync) return bun.resolveSync(spec, process.cwd());
    } catch {
      /* not installed here */
    }
    return null;
  };
  const named = env.RUNE_TEST_PLAYWRIGHT || env.RUNE_BENCH_PLAYWRIGHT || "";
  const playwrightModule =
    (named && existsSync(named) ? named : null) ??
    resolve_("playwright") ??
    resolve_("playwright-core");
  const roots = [
    env.PLAYWRIGHT_BROWSERS_PATH,
    home ? `${home}/Library/Caches/ms-playwright` : "",
    home ? `${home}/.cache/ms-playwright` : "",
  ].filter((p): p is string => !!p && existsSync(p));
  const browsersDir = roots[0] ?? null;
  // A full `chromium-<rev>` outranks a `chromium_headless_shell-<rev>`: the
  // shell can render but cannot do everything `--browser chromium` asks of it,
  // so the line must not report a full browser when only the shell is there.
  const chromium = browsersDir
    ? readdirSync(browsersDir)
        .filter((entry) => /^chromium[-_]/.test(entry))
        .sort()
        .reverse()
        .sort((a, b) => Number(a.startsWith("chromium_")) - Number(b.startsWith("chromium_")))
    : [];
  return { mcpModule: resolve_("@playwright/mcp"), playwrightModule, browsersDir, chromium };
}
