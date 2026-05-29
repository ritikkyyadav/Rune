/**
 * New-feature tasks: create + wire a file, verify presence + test.
 */
import { writeFile, readFile, mkdir } from "fs/promises";
import { join } from "path";
import { spawnSync } from "child_process";
import type { EvalTask } from "./harness";

function runTest(workspace: string, args: string[]): { exitCode: number; output: string } {
  const result = spawnSync("bun", ["test", ...args], {
    cwd: workspace,
    encoding: "utf8",
    timeout: 30000,
  });
  return {
    exitCode: result.status ?? 1,
    output: (result.stdout ?? "") + (result.stderr ?? ""),
  };
}

// ─── New-feature Task 1: add a simple validation utility + test ───

const addValidationUtil: EvalTask = {
  name: "new_feature_validation_util",
  category: "new-feature",
  description: "Agent creates a validate.ts with an isEmail function and a passing test.",
  setup: async ({ workspace }) => {
    // Existing project — just an index to keep it real
    await writeFile(
      join(workspace, "index.ts"),
      `// Main entry point\nexport * from './validate';\n`,
    );
  },
  script: [
    {
      text: "Creating validate.ts with an isEmail function.",
      toolCalls: [
        {
          name: "write_file",
          args: {
            path: "validate.ts",
            content: `export function isEmail(value: string): boolean {
  return /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(value);
}
`,
          },
        },
      ],
    },
    {
      text: "Creating validate.test.ts with tests.",
      toolCalls: [
        {
          name: "write_file",
          args: {
            path: "validate.test.ts",
            content: `import { expect, test } from "bun:test";
import { isEmail } from "./validate";
test("valid email passes", () => {
  expect(isEmail("user@example.com")).toBe(true);
});
test("invalid email fails", () => {
  expect(isEmail("not-an-email")).toBe(false);
});
`,
          },
        },
      ],
    },
    { text: "Created validate.ts and validate.test.ts. The feature is wired and tested." },
  ],
  prompts: [
    "Add a validate.ts module with an isEmail(value: string): boolean function, and create a test file for it.",
  ],
  verify: async ({ workspace, engine }) => {
    // Check validate.ts exists and has isEmail
    let content: string;
    try {
      content = await readFile(join(workspace, "validate.ts"), "utf8");
    } catch {
      return { pass: false, reason: "validate.ts was not created" };
    }
    if (!content.includes("isEmail")) {
      return { pass: false, reason: "isEmail function not found in validate.ts" };
    }

    // Check test file exists
    try {
      await readFile(join(workspace, "validate.test.ts"), "utf8");
    } catch {
      return { pass: false, reason: "validate.test.ts was not created" };
    }

    // Run tests
    const { exitCode, output } = runTest(workspace, ["validate.test.ts"]);
    if (exitCode !== 0) {
      return { pass: false, reason: `tests failed: ${output.slice(0, 300)}` };
    }

    const audit = engine.verifyAuditChain();
    if (!audit.ok) return { pass: false, reason: "audit chain broken" };
    return { pass: true };
  },
};

// ─── New-feature Task 2: add a logger module wired into existing code ───

const addLoggerModule: EvalTask = {
  name: "new_feature_logger_module",
  category: "new-feature",
  description: "Agent creates a logger.ts and wires it into app.ts.",
  setup: async ({ workspace }) => {
    await writeFile(
      join(workspace, "app.ts"),
      `// Application entry point
// TODO: add logging
export function startApp() {
  return { status: 'running' };
}
`,
    );
  },
  script: [
    {
      text: "Reading app.ts to understand what needs to be wired.",
      toolCalls: [{ name: "read_file", args: { path: "app.ts" } }],
    },
    {
      text: "Creating logger.ts.",
      toolCalls: [
        {
          name: "write_file",
          args: {
            path: "logger.ts",
            content: `export type LogLevel = 'info' | 'warn' | 'error';
export function log(level: LogLevel, message: string): void {
  console.log(\`[\${level.toUpperCase()}] \${message}\`);
}
`,
          },
        },
      ],
    },
    {
      text: "Wiring logger into app.ts.",
      toolCalls: [
        {
          name: "write_file",
          args: {
            path: "app.ts",
            content: `// Application entry point
import { log } from './logger';
export function startApp() {
  log('info', 'App started');
  return { status: 'running' };
}
`,
          },
        },
      ],
    },
    {
      text: "Creating app.test.ts.",
      toolCalls: [
        {
          name: "write_file",
          args: {
            path: "app.test.ts",
            content: `import { expect, test } from "bun:test";
import { startApp } from "./app";
test("startApp returns running status", () => {
  expect(startApp().status).toBe('running');
});
`,
          },
        },
      ],
    },
    { text: "logger.ts created and wired into app.ts. Test added." },
  ],
  prompts: [
    "Create a logger.ts module with a log(level, message) function, wire it into app.ts, and add a test.",
  ],
  verify: async ({ workspace, engine }) => {
    // logger.ts must exist with 'log' export
    let loggerContent: string;
    try {
      loggerContent = await readFile(join(workspace, "logger.ts"), "utf8");
    } catch {
      return { pass: false, reason: "logger.ts was not created" };
    }
    if (!loggerContent.includes("export function log")) {
      return { pass: false, reason: "log function not exported from logger.ts" };
    }

    // app.ts must import from logger
    const appContent = await readFile(join(workspace, "app.ts"), "utf8");
    if (!appContent.includes("logger")) {
      return { pass: false, reason: "app.ts does not import from logger" };
    }

    // Tests pass
    const { exitCode, output } = runTest(workspace, ["app.test.ts"]);
    if (exitCode !== 0) {
      return { pass: false, reason: `app test failed: ${output.slice(0, 300)}` };
    }

    const audit = engine.verifyAuditChain();
    if (!audit.ok) return { pass: false, reason: "audit chain broken" };
    return { pass: true };
  },
};

// ─── New-feature Task 3: add a config parser module ───

const addConfigParser: EvalTask = {
  name: "new_feature_config_parser",
  category: "new-feature",
  description: "Agent creates a config-parser.ts that parses KEY=VALUE env files.",
  setup: async ({ workspace }) => {
    await writeFile(
      join(workspace, ".env.example"),
      `DATABASE_URL=postgres://localhost/mydb\nPORT=3000\nDEBUG=true\n`,
    );
  },
  script: [
    {
      text: "Reading .env.example to understand the format.",
      toolCalls: [{ name: "read_file", args: { path: ".env.example" } }],
    },
    {
      text: "Creating config-parser.ts.",
      toolCalls: [
        {
          name: "write_file",
          args: {
            path: "config-parser.ts",
            content: `export function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split('\\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    result[key] = value;
  }
  return result;
}
`,
          },
        },
      ],
    },
    {
      text: "Writing the test.",
      toolCalls: [
        {
          name: "write_file",
          args: {
            path: "config-parser.test.ts",
            content: `import { expect, test } from "bun:test";
import { parseEnvFile } from "./config-parser";
test("parses KEY=VALUE pairs", () => {
  const result = parseEnvFile("FOO=bar\\nBAZ=qux\\n");
  expect(result.FOO).toBe("bar");
  expect(result.BAZ).toBe("qux");
});
test("ignores comments and blanks", () => {
  const result = parseEnvFile("# comment\\n\\nKEY=value\\n");
  expect(Object.keys(result)).toEqual(["KEY"]);
});
`,
          },
        },
      ],
    },
    { text: "config-parser.ts created and tested." },
  ],
  prompts: [
    "Create a config-parser.ts module that parses KEY=VALUE .env files, and add tests for it.",
  ],
  verify: async ({ workspace, engine }) => {
    let content: string;
    try {
      content = await readFile(join(workspace, "config-parser.ts"), "utf8");
    } catch {
      return { pass: false, reason: "config-parser.ts was not created" };
    }
    if (!content.includes("parseEnvFile")) {
      return { pass: false, reason: "parseEnvFile not found in config-parser.ts" };
    }

    try {
      await readFile(join(workspace, "config-parser.test.ts"), "utf8");
    } catch {
      return { pass: false, reason: "config-parser.test.ts was not created" };
    }

    const { exitCode, output } = runTest(workspace, ["config-parser.test.ts"]);
    if (exitCode !== 0) {
      return { pass: false, reason: `tests failed: ${output.slice(0, 300)}` };
    }

    const audit = engine.verifyAuditChain();
    if (!audit.ok) return { pass: false, reason: "audit chain broken" };
    return { pass: true };
  },
};

// ─── New-feature Task 4: add a rate-limiter utility ───

const addRateLimiter: EvalTask = {
  name: "new_feature_rate_limiter",
  category: "new-feature",
  description: "Agent creates a rate-limiter.ts and a test verifying it throttles calls.",
  setup: async ({ workspace }) => {
    await writeFile(
      join(workspace, "README.md"),
      `# My App\nNeeds: a rate limiter that allows N calls per window.\n`,
    );
  },
  script: [
    {
      text: "Reading README.md for context.",
      toolCalls: [{ name: "read_file", args: { path: "README.md" } }],
    },
    {
      text: "Creating rate-limiter.ts.",
      toolCalls: [
        {
          name: "write_file",
          args: {
            path: "rate-limiter.ts",
            content: `export class RateLimiter {
  private calls: number[] = [];
  constructor(private readonly maxCalls: number, private readonly windowMs: number) {}
  isAllowed(): boolean {
    const now = Date.now();
    this.calls = this.calls.filter(t => now - t < this.windowMs);
    if (this.calls.length >= this.maxCalls) return false;
    this.calls.push(now);
    return true;
  }
}
`,
          },
        },
      ],
    },
    {
      text: "Writing rate-limiter.test.ts.",
      toolCalls: [
        {
          name: "write_file",
          args: {
            path: "rate-limiter.test.ts",
            content: `import { expect, test } from "bun:test";
import { RateLimiter } from "./rate-limiter";
test("allows calls within limit", () => {
  const rl = new RateLimiter(3, 1000);
  expect(rl.isAllowed()).toBe(true);
  expect(rl.isAllowed()).toBe(true);
  expect(rl.isAllowed()).toBe(true);
});
test("blocks calls over limit", () => {
  const rl = new RateLimiter(2, 1000);
  rl.isAllowed();
  rl.isAllowed();
  expect(rl.isAllowed()).toBe(false);
});
`,
          },
        },
      ],
    },
    { text: "RateLimiter created and tested." },
  ],
  prompts: [
    "Create a rate-limiter.ts with a RateLimiter class that takes maxCalls and windowMs, and add tests.",
  ],
  verify: async ({ workspace, engine }) => {
    let content: string;
    try {
      content = await readFile(join(workspace, "rate-limiter.ts"), "utf8");
    } catch {
      return { pass: false, reason: "rate-limiter.ts was not created" };
    }
    if (!content.includes("RateLimiter")) {
      return { pass: false, reason: "RateLimiter class not found" };
    }
    if (!content.includes("isAllowed")) {
      return { pass: false, reason: "isAllowed method not found" };
    }

    const { exitCode, output } = runTest(workspace, ["rate-limiter.test.ts"]);
    if (exitCode !== 0) {
      return { pass: false, reason: `tests failed: ${output.slice(0, 300)}` };
    }

    const audit = engine.verifyAuditChain();
    if (!audit.ok) return { pass: false, reason: "audit chain broken" };
    return { pass: true };
  },
};

export const NEW_FEATURE_TASKS: EvalTask[] = [
  addValidationUtil,
  addLoggerModule,
  addConfigParser,
  addRateLimiter,
];
