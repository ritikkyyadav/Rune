// The extension is bundled, not shipped as loose modules: VS Code loads one
// CommonJS entry point, and `vscode` is provided by the host at runtime rather
// than installed — marking it external is what keeps it out of the bundle and
// what makes the .vsix a few kilobytes instead of a node_modules tree.
import { build } from "esbuild";

const common = {
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  external: ["vscode"],
  sourcemap: true,
  logLevel: "info",
};

await build({
  ...common,
  entryPoints: ["src/extension.ts"],
  outfile: "out/extension.js",
  minify: process.env.NODE_ENV === "production",
});

// The suite that runs INSIDE the extension host (P10.6). Same treatment for the
// same reason: `--extensionTestsPath` is a single CommonJS module the host
// `require`s, so the TypeScript has to become one file before VS Code ever sees
// it. Never minified — a stack trace from a failing proof should be readable —
// and excluded from the .vsix by `.vscodeignore`.
await build({
  ...common,
  entryPoints: ["test/suite/index.ts"],
  outfile: "out/test/suite/index.js",
});
