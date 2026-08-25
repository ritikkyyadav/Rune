import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: [
        "packages/orchestrator/src/**/*.ts",
        "packages/llm-gateway/src/**/*.ts",
        "packages/tool-registry/src/**/*.ts",
        "packages/shared/src/**/*.ts",
      ],
      exclude: ["**/*.d.ts", "**/dist/**", "**/bin/**", "**/index.ts"],
      thresholds: {
        lines: 40,
        functions: 40,
        branches: 30,
      },
    },
  },
});
