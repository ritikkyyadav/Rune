/** Exercise the installed CLI's completion page against a local mock IdP only. */
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startMockOAuthMcpServer } from "../tests/helpers/mock-oauth-mcp-server";

if (process.platform !== "darwin")
  throw new Error("This delivery probe uses the macOS browser launcher.");
const executable = resolve(Bun.argv[2] ?? join(homedir(), ".rune/bin/rune"));
const outdir = resolve(Bun.argv[3] ?? join(tmpdir(), "rune-login-delivery"));
const scratch = mkdtempSync(join(tmpdir(), "rune-login-installed-"));
const workspace = join(scratch, "workspace");
const profile = join(scratch, "profile");
const shim = join(scratch, "bin");
const authorizeFile = join(scratch, "authorize-url");
for (const dir of [join(workspace, ".rune"), profile, shim, outdir])
  mkdirSync(dir, { recursive: true });
// Intercept only the child process's browser launch; no real browser or keychain is touched.
writeFileSync(join(shim, "open"), '#!/bin/sh\nprintf "%s\\n" "$1" > "$RUNE_LOGIN_CAPTURE_URL"\n');
chmodSync(join(shim, "open"), 0o700);
const env = {
  HOME: homedir(),
  PATH: `${shim}:${process.env.PATH ?? "/usr/bin:/bin"}`,
  LANG: "en_US.UTF-8",
  TERM: "xterm-256color",
  NO_COLOR: "1",
  RUNE_HOME: profile,
  RUNE_NO_ENV_FILE: "1",
  RUNE_CREDENTIAL_BACKEND: "file",
  RUNE_MCP_REGISTRY: "off",
  RUNE_LOGIN_CAPTURE_URL: authorizeFile,
};
const mock = await startMockOAuthMcpServer();
let child: ReturnType<typeof Bun.spawn> | undefined;
let timeout: ReturnType<typeof setTimeout> | undefined;
try {
  writeFileSync(
    join(workspace, ".rune/mcp.json"),
    JSON.stringify({
      mcpServers: { "rune-preview": { url: mock.mcpUrl } },
    }),
  );
  child = Bun.spawn([executable, "mcp", "login", "rune-preview"], {
    cwd: workspace,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  timeout = setTimeout(() => child?.kill(), 15_000);
  const deadline = Date.now() + 10_000;
  while (!existsSync(authorizeFile) && Date.now() < deadline) await Bun.sleep(20);
  if (!existsSync(authorizeFile))
    throw new Error("The installed CLI did not start local authorization.");
  const authorize = readFileSync(authorizeFile, "utf8").trim();
  if (new URL(authorize).origin !== mock.origin)
    throw new Error("Refusing a non-mock authorization endpoint.");
  const page = await fetch(authorize, { redirect: "follow" });
  const html = await page.text();
  const exitCode = await child.exited;
  const stdout = await new Response(child.stdout as ReadableStream).text();
  const stderr = await new Response(child.stderr as ReadableStream).text();
  writeFileSync(join(outdir, "cli.txt"), stdout + stderr);
  if (exitCode !== 0 || page.status !== 200)
    throw new Error(`Installed sign-in failed: exit ${exitCode}, HTTP ${page.status}.`);
  if (!html.includes("Logged in<span>successfully.</span>") || html.includes("<svg"))
    throw new Error("Installed binary served the old completion page.");
  const credentials = JSON.parse(readFileSync(join(profile, "credentials.json"), "utf8"));
  const saved = Object.entries(credentials).find(([key]) => key.includes("mcp:rune-preview"));
  const tokens = saved && typeof saved[1] === "string" ? JSON.parse(saved[1]) : saved?.[1];
  if (!mock.issuedAccessTokens.includes(tokens?.accessToken))
    throw new Error("The mock token was not persisted.");
  writeFileSync(join(outdir, "installed-success.html"), html);
  const version = Bun.spawnSync([executable, "--version"], { env, cwd: workspace });
  const manifest = {
    executable,
    version: new TextDecoder().decode(version.stdout).trim(),
    flow: "installed CLI → local mock IdP → PKCE exchange → isolated credential store → completion page",
    cliExitCode: exitCode,
    pageStatus: page.status,
    credentialsSaved: true,
    cacheControl: page.headers.get("cache-control"),
    pageSha256: createHash("sha256").update(html).digest("hex"),
    mockTokensIssued: mock.issuedAccessTokens.length,
    hostedProviderCalls: 0,
  };
  writeFileSync(join(outdir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(JSON.stringify(manifest, null, 2));
} finally {
  if (timeout) clearTimeout(timeout);
  if (child && child.exitCode === null) child.kill();
  await mock.close();
  rmSync(scratch, { recursive: true, force: true });
}
