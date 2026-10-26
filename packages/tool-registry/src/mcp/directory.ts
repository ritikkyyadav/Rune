// ─── The connector directory: services Rune has checked ───
//
// `/connectors` lists these. The bundled catalog (catalog.ts) is 58 entries
// lifted from the skill packs, written for Claude: five of them point at hosts
// Anthropic runs for Claude alone (`*.mcp.claude.com`, HubSpot's `/anthropic`
// path), and several more sign in only with a client the vendor registered for
// a partner. Offering those in a picker means offering a sign-in that fails.
//
// So the picker is fed from here instead: each entry below was checked on the
// date it carries, from outside and without credentials. Its address answered,
// and for a browser sign-in its published metadata offered what Rune's flow
// needs (RFC 9728 resource metadata or the server-origin fallback, RFC 8414
// authorization-server metadata, RFC 7591 self-registration, PKCE S256). A
// service that fails that check is a ClosedEntry with the reason, so `rune mcp
// add slack` can say why before anything is written.
//
// The bundled catalog and the public registry stay reachable from search.
// They are labelled "not checked", because they were not.

import type { McpServerConfig } from "./discovery";

export type DirectoryCategory = "developer" | "docs" | "work" | "design";

/** How a person signs in, in the order a connect flow asks for it. */
export type DirectoryAuth =
  /** Browser sign-in. The vendor lets a new app register itself (RFC 7591). */
  | { kind: "oauth"; scopes?: string[] }
  /**
   * A token the person creates on the vendor's site and pastes once. It goes
   * to the OS credential store; the config names where it lives, never what it
   * is. `optional` tokens only raise limits: the service works without one.
   */
  | {
      kind: "token";
      header: string;
      scheme: string;
      noun: string;
      createAt: string;
      optional?: boolean;
    }
  /** Nothing to sign in to. */
  | { kind: "none" }
  /** A local program that signs in through its vendor's own CLI. */
  | { kind: "cli"; signIn: string };

/**
 * One setting a connector exposes through its address. Settings live in the
 * URL because that is where these vendors put them, so the config file stays
 * the one record of what a connector does: read it and you know.
 */
export type DirectoryOption =
  | {
      kind: "query-flag";
      id: string;
      label: string;
      hint: string;
      param: string;
      value: string;
    }
  | {
      kind: "query-value";
      id: string;
      label: string;
      hint: string;
      param: string;
      /** The question asked when the person sets it. */
      ask: string;
      /** How the unset state reads ("every project"). */
      unset: string;
    }
  | { kind: "path-suffix"; id: string; label: string; hint: string; suffix: string };

export interface DirectoryEntry {
  /** The config name: `rune mcp add <id>`, the `mcp_<id>_…` tool prefix. */
  id: string;
  label: string;
  category: DirectoryCategory;
  /** What it gives the agent, in a picker row's worth of words. */
  blurb: string;
  url?: string;
  command?: string;
  args?: string[];
  auth: DirectoryAuth;
  /**
   * A vendor-side rule that can stop the sign-in after Rune has done
   * everything right, said before the browser opens rather than after it fails.
   */
  gate?: { note: string; link: string };
  options?: DirectoryOption[];
  /** The vendor's own setup page, where one was found to exist. */
  docs?: string;
  /** The day the address and its sign-in metadata were last checked. */
  checked: string;
}

/** A service Rune cannot connect to today, and why. */
export interface ClosedEntry {
  id: string;
  label: string;
  reason: string;
}

export const CATEGORY_LABELS: Record<DirectoryCategory, string> = {
  developer: "Developer tools",
  docs: "Docs and search",
  work: "Work and planning",
  design: "Design",
};

const CHECKED = "2026-10-26";

/** A token sent as `Authorization: Bearer …`, the shape every token entry here uses. */
const bearer = (noun: string, createAt: string, optional = false): DirectoryAuth => ({
  kind: "token",
  header: "Authorization",
  scheme: "Bearer",
  noun,
  createAt,
  ...(optional ? { optional: true } : {}),
});

const OAUTH: DirectoryAuth = { kind: "oauth" };

const REVIEWED_ONLY = (vendor: string) =>
  `${vendor} only lets AI apps it has reviewed sign in, and Rune is not on its list yet. ` +
  `If ${vendor}'s page refuses the sign-in, that is why; nothing on your side is wrong.`;

export const CONNECTOR_DIRECTORY: readonly DirectoryEntry[] = [
  // ── Developer tools ──
  {
    id: "github",
    label: "GitHub",
    category: "developer",
    blurb: "repositories, issues, pull requests, Actions",
    url: "https://api.githubcopilot.com/mcp/",
    // GitHub's authorization server offers no self-registration, so a browser
    // sign-in would need a client GitHub issued to Rune. A personal access
    // token is what its own docs show for every other client.
    auth: bearer("personal access token", "https://github.com/settings/personal-access-tokens/new"),
    options: [
      {
        kind: "path-suffix",
        id: "readonly",
        label: "Read-only",
        hint: "only the tools that read",
        suffix: "readonly",
      },
    ],
    docs: "https://github.com/github/github-mcp-server",
    checked: CHECKED,
  },
  {
    id: "vercel",
    label: "Vercel",
    category: "developer",
    blurb: "projects, deployments, build logs, domains",
    url: "https://mcp.vercel.com",
    auth: OAUTH,
    gate: {
      note: REVIEWED_ONLY("Vercel"),
      link: "https://vercel.com/docs/agent-resources/vercel-mcp",
    },
    docs: "https://vercel.com/docs/agent-resources/vercel-mcp",
    checked: CHECKED,
  },
  {
    id: "supabase",
    label: "Supabase",
    category: "developer",
    blurb: "database, migrations, edge functions, logs",
    url: "https://mcp.supabase.com/mcp",
    auth: OAUTH,
    options: [
      {
        kind: "query-flag",
        id: "read_only",
        label: "Read-only",
        hint: "queries run as a read-only Postgres user",
        param: "read_only",
        value: "true",
      },
      {
        kind: "query-value",
        id: "project_ref",
        label: "Project",
        hint: "scope it to one project",
        param: "project_ref",
        ask: "Supabase project ref (the id in your dashboard URL):",
        unset: "every project",
      },
    ],
    docs: "https://supabase.com/docs/guides/getting-started/mcp",
    checked: CHECKED,
  },
  {
    id: "neon",
    label: "Neon",
    category: "developer",
    blurb: "serverless Postgres: projects, branches, SQL",
    url: "https://mcp.neon.tech/mcp",
    auth: OAUTH,
    docs: "https://neon.com/docs/ai/neon-mcp-server",
    checked: CHECKED,
  },
  {
    id: "sentry",
    label: "Sentry",
    category: "developer",
    blurb: "errors, issues, traces, releases",
    url: "https://mcp.sentry.dev/mcp",
    auth: OAUTH,
    docs: "https://mcp.sentry.dev",
    checked: CHECKED,
  },
  {
    id: "cloudflare",
    label: "Cloudflare",
    category: "developer",
    blurb: "the Cloudflare API: Workers, DNS, R2, D1, KV",
    url: "https://mcp.cloudflare.com/mcp",
    auth: OAUTH,
    docs: "https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/",
    checked: CHECKED,
  },
  {
    id: "netlify",
    label: "Netlify",
    category: "developer",
    blurb: "sites, deploys, forms, environment variables",
    url: "https://netlify-mcp.netlify.app/mcp",
    // Its metadata also advertises a scope named for Claude; asking for every
    // advertised scope would ask for that one too.
    auth: { kind: "oauth", scopes: ["offline_access", "read", "write"] },
    docs: "https://docs.netlify.com/build/build-with-ai/netlify-mcp-server/",
    checked: CHECKED,
  },
  {
    id: "railway",
    label: "Railway",
    category: "developer",
    blurb: "projects, services, deployments, logs",
    url: "https://mcp.railway.com",
    auth: OAUTH,
    docs: "https://docs.railway.com/reference/mcp-server",
    checked: CHECKED,
  },
  {
    id: "render",
    label: "Render",
    category: "developer",
    blurb: "services, deploys, logs, Postgres",
    url: "https://mcp.render.com/mcp",
    // Render's authorization server offers no self-registration; an API key
    // from the account settings is its documented route for other clients.
    auth: bearer("API key", "https://dashboard.render.com/u/settings?add-api-key"),
    docs: "https://render.com/docs/mcp-server",
    checked: CHECKED,
  },
  {
    id: "stripe",
    label: "Stripe",
    category: "developer",
    blurb: "payments, customers, subscriptions, docs",
    url: "https://mcp.stripe.com",
    auth: OAUTH,
    docs: "https://docs.stripe.com/mcp",
    checked: CHECKED,
  },
  {
    id: "posthog",
    label: "PostHog",
    category: "developer",
    blurb: "product analytics, feature flags, experiments",
    url: "https://mcp.posthog.com/mcp",
    auth: OAUTH,
    docs: "https://posthog.com/docs/model-context-protocol",
    checked: CHECKED,
  },
  {
    id: "prisma",
    label: "Prisma",
    category: "developer",
    blurb: "Prisma Postgres databases and migrations",
    url: "https://mcp.prisma.io/mcp",
    auth: OAUTH,
    docs: "https://www.prisma.io/docs/postgres/integrations/mcp-server",
    checked: CHECKED,
  },
  {
    id: "planetscale",
    label: "PlanetScale",
    category: "developer",
    blurb: "databases, branches, deploy requests, insights",
    url: "https://mcp.pscale.dev/mcp/planetscale",
    auth: OAUTH,
    docs: "https://planetscale.com/docs/connect/mcp",
    checked: CHECKED,
  },
  {
    id: "gitlab",
    label: "GitLab",
    category: "developer",
    blurb: "projects, issues, merge requests, pipelines (gitlab.com)",
    url: "https://gitlab.com/api/v4/mcp",
    auth: OAUTH,
    docs: "https://docs.gitlab.com/user/model_context_protocol/mcp_server/",
    checked: CHECKED,
  },
  {
    id: "buildkite",
    label: "Buildkite",
    category: "developer",
    blurb: "pipelines, builds, job logs",
    url: "https://mcp.buildkite.com/mcp",
    auth: OAUTH,
    docs: "https://buildkite.com/docs/apis/mcp-server",
    checked: CHECKED,
  },
  {
    id: "expo",
    label: "Expo",
    category: "developer",
    blurb: "EAS builds, submissions, updates",
    url: "https://mcp.expo.dev/mcp",
    auth: OAUTH,
    docs: "https://docs.expo.dev/eas/ai/mcp/",
    checked: CHECKED,
  },
  {
    id: "huggingface",
    label: "Hugging Face",
    category: "developer",
    blurb: "models, datasets, Spaces, papers",
    url: "https://huggingface.co/mcp",
    auth: OAUTH,
    docs: "https://huggingface.co/docs/hub/hf-mcp-server",
    checked: CHECKED,
  },
  {
    id: "postman",
    label: "Postman",
    category: "developer",
    blurb: "collections, APIs, environments, mocks",
    url: "https://mcp.postman.com/mcp",
    auth: OAUTH,
    docs: "https://www.postman.com/product/mcp-server",
    checked: CHECKED,
  },
  {
    id: "chrome-devtools",
    label: "Chrome DevTools",
    category: "developer",
    blurb: "drive and inspect a local Chrome: performance, network, console",
    command: "npx",
    args: ["-y", "chrome-devtools-mcp@latest"],
    auth: { kind: "none" },
    docs: "https://github.com/ChromeDevTools/chrome-devtools-mcp",
    checked: CHECKED,
  },
  {
    id: "firebase",
    label: "Firebase",
    category: "developer",
    blurb: "Firestore, Auth, Hosting, Crashlytics",
    command: "npx",
    args: ["-y", "firebase-tools@latest", "mcp"],
    auth: { kind: "cli", signIn: "npx -y firebase-tools@latest login" },
    docs: "https://firebase.google.com/docs/ai-assistance/mcp-server",
    checked: CHECKED,
  },

  // ── Docs and search ──
  {
    id: "context7",
    label: "Context7",
    category: "docs",
    blurb: "current docs and code examples for libraries",
    url: "https://mcp.context7.com/mcp",
    auth: bearer("API key", "https://context7.com/dashboard", true),
    docs: "https://context7.com/docs/resources/all-clients",
    checked: CHECKED,
  },
  {
    id: "deepwiki",
    label: "DeepWiki",
    category: "docs",
    blurb: "questions about any public GitHub repository",
    url: "https://mcp.deepwiki.com/mcp",
    auth: { kind: "none" },
    docs: "https://docs.devin.ai/work-with-devin/deepwiki-mcp",
    checked: CHECKED,
  },
  {
    id: "microsoft-learn",
    label: "Microsoft Learn",
    category: "docs",
    blurb: "Microsoft and Azure docs and code samples",
    url: "https://learn.microsoft.com/api/mcp",
    auth: { kind: "none" },
    docs: "https://learn.microsoft.com/en-us/training/support/mcp",
    checked: CHECKED,
  },
  {
    id: "aws-knowledge",
    label: "AWS Knowledge",
    category: "docs",
    blurb: "AWS docs, API references, regional availability",
    url: "https://knowledge-mcp.global.api.aws",
    auth: { kind: "none" },
    docs: "https://awslabs.github.io/mcp/servers/aws-knowledge-mcp-server",
    checked: CHECKED,
  },

  // ── Work and planning ──
  {
    id: "linear",
    label: "Linear",
    category: "work",
    blurb: "issues, projects, cycles, comments",
    url: "https://mcp.linear.app/mcp",
    auth: OAUTH,
    docs: "https://linear.app/docs/mcp",
    checked: CHECKED,
  },
  {
    id: "notion",
    label: "Notion",
    category: "work",
    blurb: "pages, databases, search",
    url: "https://mcp.notion.com/mcp",
    auth: OAUTH,
    docs: "https://developers.notion.com/docs/mcp",
    checked: CHECKED,
  },
  {
    id: "atlassian",
    label: "Atlassian",
    category: "work",
    blurb: "Jira issues and Confluence pages",
    // v2: the bundled catalog's /v1 address is the one Atlassian is retiring.
    url: "https://mcp.atlassian.com/v2/mcp",
    auth: OAUTH,
    docs: "https://support.atlassian.com/rovo/docs/getting-started-with-the-atlassian-remote-mcp-server/",
    checked: CHECKED,
  },
  {
    id: "monday",
    label: "monday.com",
    category: "work",
    blurb: "boards, items, updates",
    url: "https://mcp.monday.com/mcp",
    auth: OAUTH,
    checked: CHECKED,
  },
  {
    id: "clickup",
    label: "ClickUp",
    category: "work",
    blurb: "tasks, lists, docs, time tracking",
    url: "https://mcp.clickup.com/mcp",
    auth: OAUTH,
    docs: "https://developer.clickup.com/docs/connect-an-ai-assistant-to-clickups-mcp-server",
    checked: CHECKED,
  },
  {
    id: "intercom",
    label: "Intercom",
    category: "work",
    blurb: "conversations, contacts, help center",
    url: "https://mcp.intercom.com/mcp",
    auth: OAUTH,
    docs: "https://developers.intercom.com/docs/guides/mcp",
    checked: CHECKED,
  },

  // ── Design ──
  {
    id: "figma",
    label: "Figma",
    category: "design",
    blurb: "design context, variables, screenshots",
    url: "https://mcp.figma.com/mcp",
    auth: OAUTH,
    gate: {
      note: REVIEWED_ONLY("Figma"),
      link: "https://help.figma.com/hc/en-us/articles/32132100833559-Guide-to-the-Figma-MCP-server",
    },
    docs: "https://help.figma.com/hc/en-us/articles/32132100833559-Guide-to-the-Figma-MCP-server",
    checked: CHECKED,
  },
  {
    id: "canva",
    label: "Canva",
    category: "design",
    blurb: "designs, brand templates, assets",
    url: "https://mcp.canva.com/mcp",
    auth: OAUTH,
    docs: "https://www.canva.dev/docs/mcp/",
    checked: CHECKED,
  },
];

const PARTNER_ONLY = (vendor: string) =>
  `${vendor}'s sign-in accepts only apps ${vendor} registered itself (it offers no ` +
  `self-registration), and Rune has none yet. With your own ${vendor} app, add it by URL ` +
  `and set "oauth": { "clientId": "…" } in mcp.json.`;

export const CLAUDE_ONLY_REASON =
  "This address is run by Anthropic for Claude's own connectors; other apps cannot sign in to it.";
const CLAUDE_ONLY = CLAUDE_ONLY_REASON;

/** Services checked on {@link CHECKED} that Rune cannot connect to, with the reason. */
export const CLOSED_CONNECTORS: readonly ClosedEntry[] = [
  { id: "slack", label: "Slack", reason: PARTNER_ONLY("Slack") },
  { id: "asana", label: "Asana", reason: PARTNER_ONLY("Asana") },
  { id: "pagerduty", label: "PagerDuty", reason: PARTNER_ONLY("PagerDuty") },
  { id: "hubspot", label: "HubSpot", reason: PARTNER_ONLY("HubSpot") },
  { id: "gmail", label: "Gmail", reason: CLAUDE_ONLY },
  { id: "google-calendar", label: "Google Calendar", reason: CLAUDE_ONLY },
  { id: "microsoft-365", label: "Microsoft 365", reason: CLAUDE_ONLY },
  { id: "ms365", label: "Microsoft 365", reason: CLAUDE_ONLY },
  { id: "pubmed", label: "PubMed", reason: CLAUDE_ONLY },
];

/**
 * Hosts that serve Claude alone. A bundled entry pointing at one is closed,
 * whatever it is called: the skill packs were written for Claude, and a new
 * one added later should not need a line here to be refused.
 */
export function claudeOnlyAddress(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    if (u.hostname === "mcp.claude.com" || u.hostname.endsWith(".mcp.claude.com")) return true;
    return u.hostname === "mcp.hubspot.com" && u.pathname.replace(/\/+$/, "") === "/anthropic";
  } catch {
    return false;
  }
}

export function directoryEntry(id: string): DirectoryEntry | undefined {
  const key = id.trim().toLowerCase();
  return CONNECTOR_DIRECTORY.find((e) => e.id === key);
}

export function closedConnector(id: string): ClosedEntry | undefined {
  const key = id.trim().toLowerCase();
  return CLOSED_CONNECTORS.find((e) => e.id === key);
}

// ─── Options: read from an address, written back to one ───

/** The value each option has, by id: `true`/absent for flags, a string for values. */
export type OptionValues = Record<string, string | boolean | undefined>;

/**
 * An address with these settings applied. `base` is the address on file (the
 * entry's own when omitted); only the options named in `values` change, so a
 * parameter a person added by hand (`features=database`) survives a toggle.
 * Turning every setting off on the entry's own address gives back exactly the
 * address the vendor documents, trailing slash and all.
 */
export function addressWith(entry: DirectoryEntry, values: OptionValues, base?: string): string {
  const start = base ?? entry.url;
  if (!start) throw new Error(`${entry.id} has no address`);
  const touched = (entry.options ?? []).filter((opt) => opt.id in values);
  if (touched.length === 0) return start;
  const u = new URL(start);
  const trim = (p: string) => p.replace(/\/+$/, "");
  for (const opt of touched) {
    const v = values[opt.id];
    if (opt.kind === "path-suffix") {
      const path = trim(u.pathname);
      const has = path.endsWith(`/${opt.suffix}`);
      if (v === true && !has) u.pathname = `${path}/${opt.suffix}`;
      if (v !== true && has) {
        const without = path.slice(0, -opt.suffix.length - 1);
        // Back to the entry's own spelling when that is where it came from.
        const own = entry.url ? new URL(entry.url).pathname : "";
        u.pathname = trim(own) === without ? own : without || "/";
      }
    } else if (opt.kind === "query-flag") {
      if (v === true) u.searchParams.set(opt.param, opt.value);
      else u.searchParams.delete(opt.param);
    } else if (typeof v === "string" && v.trim()) {
      u.searchParams.set(opt.param, v.trim());
    } else {
      u.searchParams.delete(opt.param);
    }
  }
  const out = u.toString();
  // `URL` adds a slash to a bare origin; keep the base's own spelling there.
  return !start.endsWith("/") && out === `${start}/` ? start : out;
}

/**
 * The settings an address carries, for an entry. Unknown query parameters a
 * person added by hand are not settings this knows, and are not touched.
 */
export function optionsIn(entry: DirectoryEntry, url: string): OptionValues {
  const out: OptionValues = {};
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return out;
  }
  for (const opt of entry.options ?? []) {
    if (opt.kind === "path-suffix") {
      out[opt.id] = u.pathname.replace(/\/+$/, "").endsWith(`/${opt.suffix}`);
    } else if (opt.kind === "query-flag") {
      out[opt.id] = u.searchParams.get(opt.param) === opt.value;
    } else {
      const v = u.searchParams.get(opt.param);
      out[opt.id] = v ? v : undefined;
    }
  }
  return out;
}

/**
 * Whether an address is this entry's, settings aside. A connector added by
 * hand under another name, or pointed elsewhere, is not offered the entry's
 * settings: rewriting it from the entry's address would lose what it is.
 */
export function isEntryAddress(entry: DirectoryEntry, url: string | undefined): boolean {
  if (!entry.url || !url) return false;
  try {
    const want = new URL(addressWith(entry, {}));
    const have = new URL(url);
    if (want.origin !== have.origin) return false;
    const trim = (p: string) => p.replace(/\/+$/, "");
    let path = trim(have.pathname);
    for (const opt of entry.options ?? []) {
      if (opt.kind === "path-suffix" && path.endsWith(`/${opt.suffix}`)) {
        path = path.slice(0, -opt.suffix.length - 1);
      }
    }
    return path === trim(want.pathname);
  } catch {
    return false;
  }
}

// ─── Tokens: where a pasted one lives, and how config points at it ───

/** The credential-store account a connector's pasted token lives under. */
export function mcpTokenAccount(serverName: string): string {
  return `mcp-token:${serverName}`;
}

/** The placeholder a config uses in place of a stored secret. */
export function keychainRef(account: string): string {
  return `\${keychain:${account}}`;
}

/** Every `${keychain:<account>}` placeholder in a string, by account. */
const KEYCHAIN_REF = /\$\{keychain:([A-Za-z0-9_.:@/-]+)\}/g;

export function keychainAccountsIn(value: unknown): string[] {
  const found = new Set<string>();
  const walk = (v: unknown): void => {
    if (typeof v === "string") {
      for (const m of v.matchAll(KEYCHAIN_REF)) found.add(m[1]!);
    } else if (Array.isArray(v)) {
      v.forEach(walk);
    } else if (v && typeof v === "object") {
      Object.values(v).forEach(walk);
    }
  };
  walk(value);
  return [...found];
}

/**
 * Replace every `${keychain:<account>}` with the stored secret. Accounts with
 * nothing stored are reported in `missing` and replaced with "", the same way
 * an unset `${VAR}` is: a connector sent an empty token fails loudly at the
 * vendor, which is better than one sent the placeholder text.
 */
export function fillKeychainRefs<T>(
  value: T,
  secrets: ReadonlyMap<string, string>,
  missing: Set<string>,
): T {
  if (typeof value === "string") {
    return value.replace(KEYCHAIN_REF, (_, account: string) => {
      const secret = secrets.get(account);
      if (secret === undefined) missing.add(account);
      return secret ?? "";
    }) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => fillKeychainRefs(v, secrets, missing)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = fillKeychainRefs(v, secrets, missing);
    return out as unknown as T;
  }
  return value;
}

/**
 * The config an entry is written as. A token entry names the keychain account
 * its header comes from; the token itself is stored separately, by the caller,
 * under {@link mcpTokenAccount}.
 */
export function directoryConfig(
  entry: DirectoryEntry,
  opts: { name?: string; values?: OptionValues; withToken?: boolean } = {},
): McpServerConfig {
  const name = opts.name ?? entry.id;
  if (entry.command) {
    return { command: entry.command, ...(entry.args ? { args: [...entry.args] } : {}) };
  }
  const config: McpServerConfig = { type: "http", url: addressWith(entry, opts.values ?? {}) };
  const auth = entry.auth;
  if (auth.kind === "token" && opts.withToken !== false) {
    config.headers = {
      [auth.header]: `${auth.scheme} ${keychainRef(mcpTokenAccount(name))}`,
    };
  }
  if (auth.kind === "oauth" && auth.scopes) config.oauth = { scopes: [...auth.scopes] };
  // No sign-in exists for these; a 401 from one is an outage, not a login to start.
  if (auth.kind === "none" || (auth.kind === "token" && opts.withToken === false)) {
    config.oauth = { enabled: false };
  }
  return config;
}

/** A noun with its article, for the sentences these entries appear in. */
export function withArticle(noun: string): string {
  return `${/^[aeiou]/i.test(noun) ? "an" : "a"} ${noun}`;
}

/** Case-insensitive match of a typed query against the directory. */
export function searchDirectory(query: string): DirectoryEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...CONNECTOR_DIRECTORY];
  const score = (e: DirectoryEntry): number => {
    const label = e.label.toLowerCase();
    if (e.id === q || label === q) return 0;
    if (e.id.startsWith(q) || label.startsWith(q)) return 1;
    if (label.includes(q) || e.id.includes(q)) return 2;
    if (e.blurb.toLowerCase().includes(q)) return 3;
    return -1;
  };
  return CONNECTOR_DIRECTORY.map((e) => [e, score(e)] as const)
    .filter(([, s]) => s >= 0)
    .sort((a, b) => a[1] - b[1])
    .map(([e]) => e);
}
