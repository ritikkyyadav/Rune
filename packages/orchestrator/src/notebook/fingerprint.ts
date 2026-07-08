// ─── Workspace fingerprinting: repo identity + stack similarity ───
// The stack key is what lets a tactic learned on one project transfer to a
// DIFFERENT project with similar shape ("bun+ts+turbo" behaves like
// "bun+ts+turbo" regardless of what the code does). Fully deterministic,
// filesystem-only, zero tokens.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";

/** Stable identity for scope=repo entries: hash of the canonical workspace path. */
export function repoKey(workspaceRoot: string): string {
  let canonical = workspaceRoot;
  try {
    canonical = realpathSync(workspaceRoot);
  } catch {
    // keep the given path — identity just needs to be stable
  }
  return createHash("sha256").update(canonical).digest("hex").slice(0, 12);
}

/**
 * Stack fingerprint: sorted `+`-joined signals, capped at 6, e.g.
 * "bun+rust+ts+turbo". Similar projects converge on the same key.
 */
export function stackKey(workspaceRoot: string): string {
  const signals = new Set<string>();
  const has = (rel: string) => existsSync(join(workspaceRoot, rel));

  // package manager (mutually exclusive by priority)
  if (has("bun.lock") || has("bun.lockb")) signals.add("bun");
  else if (has("pnpm-lock.yaml")) signals.add("pnpm");
  else if (has("yarn.lock")) signals.add("yarn");
  else if (has("package-lock.json")) signals.add("npm");

  // languages / runtimes
  if (has("tsconfig.json")) signals.add("ts");
  if (has("Cargo.toml")) signals.add("rust");
  if (has("go.mod")) signals.add("go");
  if (has("pyproject.toml") || has("requirements.txt")) signals.add("python");
  if (has("Gemfile")) signals.add("ruby");

  // repo topology / build orchestration
  if (has("turbo.json")) signals.add("turbo");
  if (has("nx.json")) signals.add("nx");
  if (has("lerna.json")) signals.add("lerna");

  // frameworks (cheap package.json scan; malformed json is simply skipped)
  const pkgPath = join(workspaceRoot, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        workspaces?: unknown;
      };
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps.next) signals.add("next");
      else if (deps.react) signals.add("react");
      if (deps.vue || deps.nuxt) signals.add("vue");
      if (deps.svelte) signals.add("svelte");
      if (deps.express || deps.fastify || deps.hono) signals.add("server");
      if (deps["@tauri-apps/api"] || has("src-tauri")) signals.add("tauri");
      if (deps.electron) signals.add("electron");
      if (pkg.workspaces) signals.add("monorepo");
    } catch {
      // unreadable package.json — signals from the filesystem are enough
    }
  }

  if (signals.size === 0) return "unknown";
  return [...signals].sort().slice(0, 6).join("+");
}
