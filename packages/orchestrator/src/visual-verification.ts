import { existsSync, readdirSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolCallOutput } from "@rune/tool-registry";

export interface VisualReviewState {
  revision: number;
  origins: string[];
  /**
   * Origins a delegated child SAID it was serving (Phase 5 F2 / v7 finding 24).
   *
   * A sub-agent is a separate `AgentLoop` with its own `VisualVerification`,
   * so an origin it established dies with it: the lead delegates "build and
   * serve the page", drives the browser itself, and its own real screenshot of
   * the real page is discarded because its allowlist is empty.
   *
   * The child's word is NOT enough to fix that. A claim is a lead that never
   * saw the server, and "some process on this machine answers on :4173" is
   * exactly what the ownership rule exists to refuse. A claim is a POINTER: it
   * tells the lead which origin is worth re-probing, and the lead's own fetch —
   * from inside the workspace, returning an HTML document — is what promotes it
   * into `origins`. First-hand evidence, one step later.
   */
  claimedOrigins?: string[];
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
  /**
   * Why the browser this run mounted cannot be used, once it has proved so.
   *
   * A `@playwright/mcp` server registers its tool list on handshake and only
   * fails at LAUNCH time, so "the registry lists mcp_browser_*" is not the same
   * question as "a screenshot is possible here". A navigate that comes back
   * saying the executable does not exist has answered the second question, and
   * the bar falls to the fetch this environment CAN do — rather than the finish
   * gate asking for four receipts no tool in the run can produce.
   */
  browserBroken?: string;
}
const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]", "0.0.0.0"]);
/**
 * A browser tool failure that is about the BROWSER, not about the page.
 *
 * A 404, a timeout on a slow dev server or a selector that matched nothing are
 * all failures of the work, and the run should keep trying. These are failures
 * of the runtime itself: nothing this run does will make the next call work.
 */
const BROWSER_UNUSABLE_RE =
  /browserType\.(?:launch|connect)|[Ee]xecutable doesn'?t exist|playwright install|[Ff]ailed to launch|Chromium distribution .* is not found|spawn .*(?:chrome|chromium).* ENOENT/;
/** The half-sentence the preflight and the finish gate both quote. */
function unusableReason(result: string): string {
  if (/[Ee]xecutable doesn'?t exist|playwright install|Chromium distribution/.test(result))
    return "the browser mounted but has no Chromium to launch";
  return "the browser mounted but cannot launch";
}
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
    if (!output.success) {
      // A browser that cannot launch is a capability this run does not have,
      // whatever the registry says. Recorded once, and it demotes the bar.
      if (
        /^mcp_browser_/.test(tool) &&
        !this.state.browserBroken &&
        BROWSER_UNUSABLE_RE.test(output.result ?? "")
      ) {
        this.state.browserBroken = unusableReason(output.result ?? "");
      }
      return false;
    }
    // A delegated child's report of where it is serving. Recorded as a claim
    // and nothing more — see `claimedOrigins`. It establishes no ownership, so
    // this returns false and no capture is made from it.
    if (["task", "worker", "team"].includes(tool)) {
      for (const value of output.result.match(/https?:\/\/[^\s<>"'\\)]+/g) ?? []) {
        try {
          const url = new URL(value);
          if (!LOCAL.has(url.hostname)) continue;
          if (this.state.origins.includes(url.origin)) continue;
          const claims = (this.state.claimedOrigins ??= []);
          if (!claims.includes(url.origin)) claims.push(url.origin);
        } catch {
          /* incomplete output */
        }
      }
      if (this.state.claimedOrigins)
        this.state.claimedOrigins = this.state.claimedOrigins.slice(-16);
      return false;
    }
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
      // The lead's own re-probe of a child's claim: it asked that origin, from
      // inside the workspace, and got a page. That is first-hand evidence, and
      // it is the only thing that turns a claim into an origin.
      const claimed = (this.state.claimedOrigins ?? []).find((origin) => command.includes(origin));
      if (tool === "bash" && claimed && HTML_DOCUMENT.test(output.result)) {
        if (!this.state.origins.includes(claimed)) this.state.origins.push(claimed);
        this.state.origins = this.state.origins.slice(-16);
        this.state.claimedOrigins = (this.state.claimedOrigins ?? []).filter(
          (origin) => origin !== claimed,
        );
      }
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
    // A browser call that actually produced a receipt still outranks
    // everything — pixels are pixels. Short of that, a browser that proved it
    // cannot launch is not a browser this run has.
    const browser =
      (this.browser && !this.state.browserBroken) || this.state.captures.some((c) => !c.fetched);
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
      const why = this.state.browserBroken
        ? `${this.state.browserBroken} in this run`
        : "no browser is mounted in this run";
      if (!captures.some((c) => c.fetched))
        missing.push(
          `fetch the served page (curl its local URL) and read what it actually returns — ${why}; ` +
            (this.state.browserBroken
              ? "install one (`playwright install chromium`) for screenshot review"
              : "enable one with --browser for screenshot review"),
        );
      missing.push(
        this.state.browserBroken
          ? "visual review is incomplete: this run's browser cannot launch, so layout and interactions were never seen; fetching HTML only checks the served response"
          : "visual review is incomplete: enable --browser to inspect layout and interactions; fetching HTML only checks the served response",
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
 * What a run whose browser it cannot use should be told before it spends
 * anything. Null when the browser WORKS, or the request is not frontend-shaped
 * — a backend fix must not pay one byte for this.
 *
 * The second argument is USABILITY, not mountedness. The pre-flight had two
 * states where the world has three (v7, lane F): a `@playwright/mcp` server
 * registers its tool list on handshake and only fails at launch, so a machine
 * with no downloaded Chromium MOUNTS the tools and then fails every call. That
 * run used to be told nothing, keep `method: "browser"`, and be asked at the
 * finish gate for four receipts no tool in it could produce — the exact
 * expensive discovery this pre-flight was written to abolish, on the branch
 * where the browser is nominally on. The reason is appended so the sentence
 * says which of the two it is.
 */
export function browserPreflightNote(
  frontendShaped: boolean,
  browserUsable: boolean,
  reason?: string,
): string | null {
  if (!frontendShaped || browserUsable) return null;
  return reason ? `${NO_BROWSER_PREFLIGHT} — ${reason}` : NO_BROWSER_PREFLIGHT;
}

/** Whether this run can actually take a screenshot, and why not when it cannot. */
export interface BrowserUsability {
  /** The registry lists `mcp_browser_*` tools. */
  mounted: boolean;
  /** …and the runtime behind them can be expected to launch. */
  usable: boolean;
  /** The half-sentence for the pre-flight note. Absent when usable. */
  reason?: string;
}

/**
 * Registered AND able to run: the question the pre-flight actually needs
 * answered.
 *
 * The probe is `probeBrowserRuntime` — offline, free, and already the thing
 * `rune doctor` reports from. Mounted tools mean the MCP server started and
 * handshook, so the module resolving is no longer in question; what is left is
 * the managed Chromium `--browser chromium` needs, which Rune never installs
 * and whose absence is invisible until the first navigate fails inside a run.
 *
 * Deliberately conservative in one direction: a machine that names a Playwright
 * through `RUNE_TEST_PLAYWRIGHT` / `RUNE_BENCH_PLAYWRIGHT` (this repository's
 * own browser fixtures, and the frontend eval) is taken at its word. Warning a
 * run off a browser that works is worse than the reverse, because the launch
 * failure itself is now caught at the first call (see `browserBroken`).
 */
export function browserUsable(
  mounted: boolean,
  probe: BrowserRuntimeProbe = probeBrowserRuntime(),
): BrowserUsability {
  if (!mounted) return { mounted: false, usable: false };
  if (probe.playwrightModule) return { mounted: true, usable: true };
  if (probe.chromium.length === 0) {
    return {
      mounted: true,
      usable: false,
      reason: "the browser mounted but has no Chromium to launch (`playwright install chromium`)",
    };
  }
  return { mounted: true, usable: true };
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
