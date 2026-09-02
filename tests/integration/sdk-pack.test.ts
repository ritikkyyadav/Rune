/**
 * The tarball, from a consumer's side of it.
 *
 * `npm pack` producing a file proves nothing: the interesting failures all
 * happen after install, on a machine with no workspace, where a leftover
 * `@gear/protocol` specifier or an `exports` entry pointing outside `files`
 * turns the package into a resolution error. So this packs it, unpacks it
 * somewhere with no workspace above it, and both IMPORTS it and TYPECHECKS
 * against it — the two things a consumer actually does.
 *
 * Nothing here reaches the network: `npm pack` is local, and the consumer
 * typecheck runs the repo's own `tsc`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../..");
const sdkRoot = join(repoRoot, "packages", "sdk");
const TSC = join(repoRoot, "node_modules", ".bin", "tsc");

let work: string;
let installed: string;
let packed = false;
let packError = "";
let contents: string[] = [];

function run(cmd: string[], cwd: string): { code: number; out: string } {
  const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  return {
    code: p.exitCode,
    out: `${p.stdout.toString()}${p.stderr.toString()}`,
  };
}

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "gear-sdk-pack-"));
  installed = join(work, "node_modules", "@gear", "sdk");
  mkdirSync(installed, { recursive: true });

  const version = (
    JSON.parse(readFileSync(join(sdkRoot, "package.json"), "utf8")) as { version: string }
  ).version;

  // `prepack` rebuilds dist, so this is the published artifact and not
  // whatever happened to be lying around.
  const pack = run(["npm", "pack", "--pack-destination", work], sdkRoot);
  const tarball = join(work, `gear-sdk-${version}.tgz`);
  if (pack.code !== 0 || !existsSync(tarball)) {
    packError = `npm pack failed (exit ${pack.code}):\n${pack.out}`;
    return;
  }

  const list = run(["tar", "-tzf", tarball], work);
  contents = list.out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.replace(/^package\//, ""));

  const extract = run(["tar", "-xzf", tarball, "-C", installed, "--strip-components", "1"], work);
  if (extract.code !== 0) {
    packError = `tar failed:\n${extract.out}`;
    return;
  }
  packed = true;
});

afterAll(() => {
  if (work) rmSync(work, { recursive: true, force: true });
});

describe("the @gear/sdk tarball", () => {
  test("packs", () => {
    expect(packError, packError).toBe("");
    expect(packed).toBe(true);
  });

  test("contains dist, the README and the manifest — and nothing else", () => {
    const outside = contents.filter(
      (f) => f !== "package.json" && f !== "README.md" && !f.startsWith("dist/"),
    );
    expect(outside).toEqual([]);
    expect(contents).toContain("dist/index.js");
    expect(contents).toContain("dist/index.d.ts");
    expect(contents).toContain("dist/client.js");
  });

  test("carries no unresolvable workspace specifier", () => {
    // The failure this catches happens only after install: `@gear/protocol` is
    // private and unpublished, so any surviving reference is a 404 on someone
    // else's machine.
    const bad: string[] = [];
    for (const rel of contents.filter((f) => f.endsWith(".js") || f.endsWith(".d.ts"))) {
      const body = readFileSync(join(installed, rel), "utf8");
      if (/from\s+["']@gear\//.test(body) || /import\(["']@gear\//.test(body)) bad.push(rel);
    }
    expect(bad).toEqual([]);
  });

  test("imports, with the protocol re-exported through it", async () => {
    const mod = (await import(join(installed, "dist", "index.js"))) as Record<string, unknown>;
    expect(typeof mod.GearClient).toBe("function");
    expect(typeof mod.readServeToken).toBe("function");
    // One package, not two: the whole protocol comes through the SDK, which is
    // the promise `export * from "@gear/protocol"` makes in the source.
    expect(typeof mod.PROTOCOL_VERSION).toBe("string");
    expect(typeof mod.encodeFrame).toBe("function");
    expect(Array.isArray(mod.HOST_COMMANDS)).toBe(true);
  });

  test("typechecks from a consumer with no workspace above it", () => {
    writeFileSync(
      join(work, "consumer.ts"),
      [
        `import { GearClient, PROTOCOL_VERSION } from "@gear/sdk";`,
        `import type { AgentTurnEvent, PermissionPrompt } from "@gear/sdk";`,
        ``,
        `export async function drive(url: string, token: string): Promise<string> {`,
        `  let said = "";`,
        `  const gear = await GearClient.connect(`,
        `    { url, token },`,
        `    {`,
        `      onEvent(event: AgentTurnEvent) {`,
        `        if (event.type === "text_delta") said += event.text;`,
        `      },`,
        `      async onPermission(prompt: PermissionPrompt) {`,
        `        return prompt.toolName === "bash" ? { kind: "deny" } : { kind: "allow_once" };`,
        `      },`,
        `    },`,
        `  );`,
        `  const id = await gear.createSession();`,
        `  await gear.run(id, "hello");`,
        `  gear.close();`,
        `  return said + PROTOCOL_VERSION;`,
        `}`,
      ].join("\n"),
    );
    writeFileSync(
      join(work, "tsconfig.json"),
      JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            module: "ESNext",
            moduleResolution: "bundler",
            lib: ["ESNext", "DOM"],
            strict: true,
            noEmit: true,
            skipLibCheck: true,
          },
          include: ["consumer.ts"],
        },
        null,
        2,
      ),
    );
    const tsc = run([TSC, "-p", join(work, "tsconfig.json")], work);
    expect(tsc.out.trim(), tsc.out).toBe("");
    expect(tsc.code).toBe(0);
  });
});
