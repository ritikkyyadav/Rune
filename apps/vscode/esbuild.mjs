// The extension is bundled, not shipped as loose modules: VS Code loads one
// CommonJS entry point, and `vscode` is provided by the host at runtime rather
// than installed — marking it external is what keeps it out of the bundle and
// what makes the .vsix a few kilobytes instead of a node_modules tree.
import { build } from "esbuild";

await build({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "out/extension.js",
  platform: "node",
  target: "node20",
  format: "cjs",
  external: ["vscode"],
  sourcemap: true,
  minify: process.env.NODE_ENV === "production",
  logLevel: "info",
});
