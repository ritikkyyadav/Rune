// ─── Building a tarball somebody else can install ───
//
// `@gear/sdk` re-exports the whole of `@gear/protocol`, and `@gear/protocol` is
// a private workspace package. A consumer running `npm i @gear/sdk` has no
// workspace, so a `dist` that still says `from "@gear/protocol"` resolves to
// nothing on their machine and the package is broken on install — the failure
// mode that makes "we published an SDK" untrue in the only place it counts.
//
// So the protocol is VENDORED into the tarball rather than depended on. It is
// pure TypeScript with no runtime dependencies of its own, which is what makes
// this honest instead of a bundling trick: the published `dist/protocol/**` is
// the same source the engine compiles, copied, with the one bare specifier
// rewritten to a relative path.
//
// The alternative — publishing `@gear/protocol` too — is a second package to
// version, and the protocol is not a thing anyone should install on its own:
// it is a contract, and the SDK is how you hold it.
//
// The output is dependency-free ESM plus declarations. `npm pack` ships
// `dist/`, the README and the manifest, and nothing else.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const here = import.meta.dir;
const pkgRoot = join(here, "..");
const protocolSrc = join(pkgRoot, "..", "protocol", "src");
const staging = join(pkgRoot, ".build");
const dist = join(pkgRoot, "dist");

/** Every `.ts` under a directory, relative to it. */
function walk(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(join(dir, entry.name), rel));
    else if (entry.name.endsWith(".ts")) out.push(rel);
  }
  return out;
}

function copyRewritten(from: string, to: string, rewrite: (s: string) => string): void {
  mkdirSync(dirname(to), { recursive: true });
  writeFileSync(to, rewrite(readFileSync(from, "utf8")));
}

/**
 * `@gear/protocol` → `./protocol/index`.
 *
 * Every SDK source file sits at the staging root, so the relative path is the
 * same from all of them. Both `import`/`export ... from` and the `import(...)`
 * form are covered; the SDK uses the first and this guards the second.
 */
const PROTOCOL_SPECIFIER = /(["'])@gear\/protocol\1/g;
const toRelative = (src: string): string => src.replace(PROTOCOL_SPECIFIER, '"./protocol/index"');

function build(): void {
  rmSync(staging, { recursive: true, force: true });
  rmSync(dist, { recursive: true, force: true });

  if (!existsSync(protocolSrc)) {
    throw new Error(`no protocol source at ${protocolSrc} — is this a full checkout?`);
  }

  for (const rel of walk(protocolSrc)) {
    copyRewritten(join(protocolSrc, rel), join(staging, "protocol", rel), (s) => s);
  }
  for (const rel of walk(join(pkgRoot, "src"))) {
    copyRewritten(join(pkgRoot, "src", rel), join(staging, rel), toRelative);
  }

  // A leftover bare specifier would only surface on someone else's machine,
  // after install, as a resolution error with no obvious cause. Catch it here.
  for (const rel of walk(staging)) {
    const body = readFileSync(join(staging, rel), "utf8");
    if (/["']@gear\//.test(body)) {
      throw new Error(`${rel} still imports a workspace package after rewriting`);
    }
  }

  const tsconfig = {
    compilerOptions: {
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "bundler",
      lib: ["ESNext", "DOM"],
      strict: true,
      skipLibCheck: true,
      declaration: true,
      declarationMap: false,
      sourceMap: false,
      outDir: "../dist",
      rootDir: ".",
      isolatedModules: true,
    },
    include: ["**/*.ts"],
  };
  writeFileSync(join(staging, "tsconfig.json"), JSON.stringify(tsconfig, null, 2));

  const tsc = Bun.spawnSync(["bun", "x", "tsc", "-p", join(staging, "tsconfig.json")], {
    cwd: staging,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (tsc.exitCode !== 0) throw new Error(`tsc failed (exit ${tsc.exitCode})`);

  rmSync(staging, { recursive: true, force: true });

  // The two entry points the manifest promises, and their declarations. A
  // silent partial emit would ship a tarball whose `exports` point at nothing.
  const required = ["index.js", "index.d.ts", "client.js", "client.d.ts", "protocol/index.js"];
  const missing = required.filter((f) => !existsSync(join(dist, f)));
  if (missing.length > 0) throw new Error(`tsc did not emit: ${missing.join(", ")}`);

  const emitted = (readdirSync(dist, { recursive: true }) as unknown as string[]).filter((f) =>
    String(f).endsWith(".js"),
  ).length;
  console.log(`@gear/sdk → dist/ (${emitted} modules, protocol vendored)`);
}

build();
