/**
 * P10.4 — verifier ecosystems.
 *
 * Before this, `detectVerifyCommands` knew JS/TS, with Rust and Go bolted on as
 * two `existsSync` calls at the workspace root. A Go, Python, Rust or Java
 * repository — and any monorepo whose real project sits one level down —
 * verified as `ran: false`, which means the plan ledger could never close a
 * step on a real check for most of the software in the world.
 *
 * These tests read the committed fixtures under tests/fixtures/verifier/ and
 * assert detection from the LAYOUT. No toolchain runs here: Go is absent on
 * plenty of machines, and a detection test that needs a compiler installed is a
 * detection test that gets deleted. The toolchains are exercised in
 * tests/integration/verifier-ecosystems.test.ts.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  detectChecks,
  detectProjects,
  detectVerifyCommands,
  fastCheckCommands,
  projectForFiles,
  resolveEcosystem,
} from "../../../packages/orchestrator/src/verifier";

const FIXTURES = join(import.meta.dir, "..", "..", "fixtures", "verifier");
const fixture = (name: string) => join(FIXTURES, name);

const commands = (name: string) => detectVerifyCommands(fixture(name));

describe("Go", () => {
  test("go.mod → build, vet, and tests when test files exist", () => {
    expect(commands("go-pass")).toEqual(["go build ./...", "go test ./...", "go vet ./..."]);
  });

  test("no test files → no `go test`", () => {
    expect(commands("go-fail")).toEqual(["go build ./...", "go vet ./..."]);
  });

  test("`go build` is compile-class, `go test` and `go vet` are not", () => {
    expect(fastCheckCommands(commands("go-pass"))).toEqual(["go build ./..."]);
  });
});

describe("Python", () => {
  test("no pytest configured → stdlib unittest, which is always installed", () => {
    expect(commands("python-pass")).toEqual(["python3 -m unittest discover -q"]);
  });

  test("pytest configured → pytest, never guessed", () => {
    expect(commands("python-pytest")).toEqual(["python3 -m pytest -q"]);
  });

  test("mypy and ruff only when the project configured them", () => {
    const cmds = commands("python-typed");
    expect(cmds).toContain("python3 -m mypy .");
    expect(cmds).toContain("python3 -m ruff check .");
    // …and never in a project that configured neither.
    expect(commands("python-pass").some((c) => /mypy|ruff|pyright/.test(c))).toBe(false);
  });

  test("a uv.lock routes every command through `uv run`", () => {
    expect(commands("python-uv")).toEqual(["uv run pytest -q"]);
  });

  test("a virtualenv is preferred over whatever is on PATH", () => {
    const dir = mkdtempSync(join(tmpdir(), "gear-py-venv-"));
    try {
      writeFileSync(join(dir, "pyproject.toml"), '[project]\nname = "x"\nversion = "0"\n');
      mkdirSync(join(dir, ".venv", "bin"), { recursive: true });
      writeFileSync(join(dir, ".venv", "bin", "python"), "#!/bin/sh\n");
      writeFileSync(join(dir, "test_thing.py"), "def test():\n    pass\n");
      expect(detectVerifyCommands(dir)).toEqual([".venv/bin/python -m unittest discover -q"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a venv that has pytest installed uses the venv's own binary", () => {
    const dir = mkdtempSync(join(tmpdir(), "gear-py-venv-"));
    try {
      writeFileSync(
        join(dir, "pyproject.toml"),
        '[project]\nname = "x"\nversion = "0"\n\n[tool.pytest.ini_options]\n',
      );
      mkdirSync(join(dir, ".venv", "bin"), { recursive: true });
      writeFileSync(join(dir, ".venv", "bin", "python"), "#!/bin/sh\n");
      writeFileSync(join(dir, ".venv", "bin", "pytest"), "#!/bin/sh\n");
      expect(detectVerifyCommands(dir)).toEqual([".venv/bin/pytest -q"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Rust", () => {
  test("Cargo.toml → check and test", () => {
    expect(commands("rust-pass")).toEqual(["cargo check --quiet", "cargo test --quiet"]);
  });

  test("clippy only when the manifest configures it", () => {
    expect(commands("rust-pass")).not.toContain("cargo clippy --quiet");
    expect(commands("rust-clippy")).toContain("cargo clippy --quiet");
  });
});

describe("Java and Kotlin", () => {
  test("a gradle wrapper compiles and tests through the wrapper", () => {
    expect(commands("gradle-app")).toEqual(["./gradlew --quiet classes", "./gradlew --quiet test"]);
  });

  test("a maven wrapper compiles and tests through the wrapper", () => {
    expect(commands("maven-app")).toEqual(["./mvnw -q -B compile", "./mvnw -q -B test"]);
  });

  test("no wrapper, no build file → javac into a throwaway directory", () => {
    const cmds = commands("java-pass");
    expect(cmds).toHaveLength(1);
    expect(cmds[0]).toStartWith('javac -d "$(mktemp -d)"');
    expect(fastCheckCommands(cmds)).toEqual(cmds);
  });

  test("`java` and `kotlin` both name the JVM ecosystem in config", () => {
    expect(resolveEcosystem("java")).toBe("jvm");
    expect(resolveEcosystem("Kotlin")).toBe("jvm");
    expect(resolveEcosystem("gradle")).toBe("jvm");
    expect(resolveEcosystem("cobol")).toBeNull();
  });
});

describe("monorepo roots", () => {
  test("one check set per project, each cd-prefixed", () => {
    const projects = detectProjects(fixture("monorepo"));
    const byDir = Object.fromEntries(projects.map((p) => [p.dir, p.ecosystem]));
    expect(byDir).toEqual({
      "services/api": "go",
      "services/web": "js",
      "libs/core": "rust",
    });
    for (const p of projects) {
      for (const c of p.checks) expect(c.command).toStartWith(`cd ${p.dir} && `);
    }
  });

  test("checks are ordered cheapest-signal-first across projects", () => {
    const kinds = detectChecks(fixture("monorepo")).map((c) => c.kind);
    const rank = { typecheck: 0, build: 1, test: 2, lint: 3 } as const;
    for (let i = 1; i < kinds.length; i++) {
      expect(rank[kinds[i]!]).toBeGreaterThanOrEqual(rank[kinds[i - 1]!]);
    }
  });

  test("the files a step touched select the project to check", () => {
    const projects = detectProjects(fixture("monorepo"));
    const hit = projectForFiles(projects, ["services/api/main.go"]);
    expect(hit.map((p) => p.dir)).toEqual(["services/api"]);
    expect(projectForFiles(projects, ["libs/core/src/lib.rs"]).map((p) => p.dir)).toEqual([
      "libs/core",
    ]);
    expect(projectForFiles(projects, ["README.md"])).toEqual([]);
  });

  test("a JS monorepo root still trusts root scripts only", () => {
    const dir = mkdtempSync(join(tmpdir(), "gear-mono-"));
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({
          name: "root",
          workspaces: ["packages/*"],
          scripts: { test: "turbo test" },
        }),
      );
      mkdirSync(join(dir, "packages", "a"), { recursive: true });
      writeFileSync(
        join(dir, "packages", "a", "package.json"),
        JSON.stringify({ name: "a", scripts: { test: "bun test" } }),
      );
      const cmds = detectVerifyCommands(dir);
      expect(cmds).toEqual(["npm test"]);
      expect(cmds.some((c) => c.startsWith("cd "))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a root go.mod claims the module — nested directories are not new projects", () => {
    const dir = mkdtempSync(join(tmpdir(), "gear-go-mono-"));
    try {
      writeFileSync(join(dir, "go.mod"), "module x\n\ngo 1.21\n");
      mkdirSync(join(dir, "cmd", "server"), { recursive: true });
      writeFileSync(join(dir, "cmd", "server", "main.go"), "package main\n");
      const projects = detectProjects(dir);
      expect(projects.filter((p) => p.ecosystem === "go").map((p) => p.dir)).toEqual([""]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the walk is bounded — a project below the depth limit is not found", () => {
    const dir = mkdtempSync(join(tmpdir(), "gear-deep-"));
    try {
      const deep = join(dir, "a", "b", "c", "d");
      mkdirSync(deep, { recursive: true });
      writeFileSync(join(deep, "go.mod"), "module deep\n");
      expect(detectProjects(dir)).toEqual([]);
      expect(detectProjects(dir, { maxDepth: 4 }).map((p) => p.dir)).toEqual(["a/b/c/d"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("directories the walk must never enter", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gear-skip-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  for (const skipped of ["node_modules", "target", "vendor", ".git", ".venv"]) {
    test(`${skipped}/`, () => {
      mkdirSync(join(dir, skipped, "inner"), { recursive: true });
      writeFileSync(join(dir, skipped, "inner", "go.mod"), "module x\n");
      writeFileSync(join(dir, skipped, "inner", "Cargo.toml"), "[package]\n");
      expect(detectProjects(dir)).toEqual([]);
    });
  }
});

describe("[verify.ecosystems]", () => {
  test("an ecosystem can be switched off", () => {
    expect(detectVerifyCommands(fixture("go-pass"), { ecosystems: { go: false } })).toEqual([]);
    expect(
      detectVerifyCommands(fixture("go-pass"), { ecosystems: { go: { enabled: false } } }),
    ).toEqual([]);
  });

  test("switching one ecosystem off leaves the others alone", () => {
    const cmds = detectVerifyCommands(fixture("monorepo"), { ecosystems: { rust: false } });
    expect(cmds.some((c) => c.includes("cargo"))).toBe(false);
    expect(cmds.some((c) => c.includes("go build"))).toBe(true);
  });

  test("a commands override replaces the detected set for that ecosystem only", () => {
    const cmds = detectVerifyCommands(fixture("monorepo"), {
      ecosystems: { go: { commands: ["go build -race ./..."] } },
    });
    expect(cmds).toContain("cd services/api && go build -race ./...");
    expect(cmds.some((c) => c.includes("go vet"))).toBe(false);
    expect(cmds.some((c) => c.includes("cargo check"))).toBe(true);
  });

  test("the alias names reach the same ecosystem", () => {
    expect(detectVerifyCommands(fixture("gradle-app"), { ecosystems: { kotlin: false } })).toEqual(
      [],
    );
  });
});

describe("the shapes that were already working stay working", () => {
  test("a scriptless project with raw test files still runs bun test", () => {
    const dir = mkdtempSync(join(tmpdir(), "gear-raw-"));
    try {
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, "src", "thing.test.ts"), "// t");
      expect(detectVerifyCommands(dir)).toEqual(["bun test"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a greenfield app one directory down is found and cd-prefixed", () => {
    const dir = mkdtempSync(join(tmpdir(), "gear-nested-"));
    try {
      mkdirSync(join(dir, "shop"), { recursive: true });
      writeFileSync(
        join(dir, "shop", "package.json"),
        JSON.stringify({ name: "shop", scripts: { test: "bun test" } }),
      );
      expect(detectVerifyCommands(dir)).toEqual(["cd shop && npm test"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("two nested apps are now TWO check sets, not silence", () => {
    // The old detection called this "ambiguous" and returned nothing, so a
    // workspace holding two apps verified as `ran: false`.
    const dir = mkdtempSync(join(tmpdir(), "gear-two-"));
    try {
      for (const name of ["a", "b"]) {
        mkdirSync(join(dir, name), { recursive: true });
        writeFileSync(
          join(dir, name, "package.json"),
          JSON.stringify({ name, scripts: { test: "bun test" } }),
        );
      }
      expect(detectVerifyCommands(dir).sort()).toEqual(["cd a && npm test", "cd b && npm test"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
