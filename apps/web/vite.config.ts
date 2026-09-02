import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import pkg from "./package.json";

// The web product's bundle. `gear serve --web` hands out `dist/` on the same
// port the socket lives on, so there is no dev-server contract to honour here
// beyond "build to dist/" — `bun run dev` exists for working on the UI without
// an engine, and everything else goes through the engine.

export default defineConfig({
  plugins: [react()],

  // Single-source the version from package.json (kept at the product version by
  // the release tooling) so the sidebar footer can never drift.
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },

  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      // `@gear/sdk` is published (P5.4), so its `exports` point at the compiled
      // `dist/` a consumer installs. The bundle wants the workspace source —
      // one build, not two, and no stale dist between them.
      "@gear/sdk/client": path.resolve(__dirname, "../../packages/sdk/src/client.ts"),
      "@gear/sdk": path.resolve(__dirname, "../../packages/sdk/src/index.ts"),
    },
  },

  clearScreen: false,

  server: {
    port: 1420,
    strictPort: false,
  },
});
