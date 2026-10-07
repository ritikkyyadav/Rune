// ─── Which projects a change selects ───
//
// One directory can host several ecosystems: this repository has
// `package.json` and `Cargo.toml` side by side at its root, so every file in
// the tree is owned by a JS project AND a Rust one. Ownership alone therefore
// ran `cargo check` and `cargo test` for a one-line TypeScript edit.
//
// This file decides which of a directory's co-owners a change actually needs.
// It is deliberately NOT "the file's extension picks the ecosystem": a
// manifest, a lockfile, a shared schema, a build script, CI configuration and
// documentation that a test compiles can all reach an ecosystem whose
// extension they do not carry. So the rule runs the other way round — every
// owner is kept unless there is a positive reason one cannot be affected:
//
//   A change confined to JS/TS or Python sources and manifests does not select
//   a co-located Rust or JVM project, unless that project's own build files
//   call the script toolchain. Everything else keeps every owner.
//
// The drop goes one way only. A script project routinely consumes what a
// compiled one builds — a napi addon, a wasm module, a CLI binary its tests
// drive — and no manifest says so, so an edit to Rust or Java sources keeps
// the JS and Python projects beside it. Go is never dropped: `go:embed` and
// `go:generate` pull other trees in from inside source files, and reading them
// is an import parser this file does not have.
//
// And one more, for prose:
//
//   A change to documentation selects only the projects whose checks read
//   documentation — a README a doctest compiles, a markdown linter in the
//   lint script. With none, no check is bound to the change at all.
//
// Pure: no file system, no process. The verifier supplies the two facts that
// need I/O — whether a project's build files call a toolchain, and what else
// changed in the working tree.

import { isDocumentationPath } from "./task-scope";
import type { DetectedProject, Ecosystem } from "./verifier";

/** Ecosystems whose sources are run or bundled as they stand. */
type ScriptEcosystem = Extract<Ecosystem, "js" | "python">;

const SCRIPT_SOURCE: Record<ScriptEcosystem, RegExp> = {
  js: /\.(?:[cm]?[jt]sx?|vue|svelte|astro)$/i,
  python: /\.pyi?$/i,
};

/** Files that configure one script ecosystem and nothing else. */
const SCRIPT_MANIFEST: Record<ScriptEcosystem, RegExp> = {
  js: /(?:^|\/)(?:package\.json|package-lock\.json|bun\.lockb?|pnpm-lock\.yaml|yarn\.lock|pnpm-workspace\.yaml|tsconfig(?:\.[\w.-]+)?\.json|jsconfig\.json|bunfig\.toml|\.npmrc)$/,
  python:
    /(?:^|\/)(?:pyproject\.toml|setup\.py|setup\.cfg|requirements[\w.-]*\.txt|Pipfile(?:\.lock)?|poetry\.lock|uv\.lock|tox\.ini|pytest\.ini|mypy\.ini|pyrightconfig\.json)$/,
};

const SCRIPT_NAME: Record<ScriptEcosystem, string> = { js: "JS/TS", python: "Python" };

/**
 * Ecosystems that build from their own sources and manifests alone — so a
 * change to another ecosystem's sources cannot reach them, short of their own
 * build files saying otherwise.
 */
const SELF_CONTAINED: ReadonlySet<Ecosystem> = new Set<Ecosystem>(["rust", "jvm"]);

/** The one script ecosystem a path is a source or a manifest of, if any. */
export function scriptEcosystemOf(file: string): ScriptEcosystem | null {
  for (const eco of ["js", "python"] as const) {
    if (SCRIPT_MANIFEST[eco].test(file) || SCRIPT_SOURCE[eco].test(file)) return eco;
  }
  return null;
}

/**
 * Every project that owns `file`: the innermost project directory containing
 * it, and every project in that directory.
 *
 * "Innermost" is a DIRECTORY, not a project. Taking only one project at that
 * depth silently dropped `cargo check` for every Rust edit in a mixed root;
 * taking every containing project grades a nested package twice.
 */
export function ownersOf<P extends Pick<DetectedProject, "dir">>(
  projects: readonly P[],
  file: string,
): P[] {
  const owners = projects.filter((p) => file.startsWith(p.dir === "" ? "" : `${p.dir}/`));
  if (owners.length === 0) return [];
  // Every owner's dir is a prefix of the same path, so the longest is the
  // innermost, and equal lengths are the same directory.
  const innermost = Math.max(...owners.map((p) => p.dir.length));
  return owners.filter((p) => p.dir.length === innermost);
}

/** What the selection needs to know that only the file system can say. */
export interface ScopeFacts {
  /**
   * Whether `project`'s own build files call the `toolchain` ecosystem — a
   * `build.rs` that runs `npm`, a gradle build with a node plugin. Asked only
   * of a project that would otherwise be dropped.
   */
  callsToolchain(project: DetectedProject, toolchain: Ecosystem): boolean;
  /**
   * Whether `project`'s checks read documentation — a README included into a
   * doctest, a markdown linter in the lint script, a docs build. Asked only of
   * a project a documentation change would otherwise leave out, and answered
   * "yes" whenever it cannot be ruled out.
   */
  readsDocumentation(project: DetectedProject): boolean;
  /**
   * Paths that changed in the working tree during this session, beyond the
   * ones the run listed — a `sed -i`, a `mv`, generated code, a deletion. Or
   * `null` when the tree could not be inspected, in which case nothing is
   * dropped. Asked at most once, and only when a drop is on the table.
   */
  changedElsewhere(): readonly string[] | null;
}

export interface ProjectDecision {
  /** Project directory relative to the workspace root; "" for the root. */
  project: string;
  ecosystem: Ecosystem;
  selected: boolean;
  /** Why, in a sentence a person can check. */
  reason: string;
}

export interface ProjectSelection {
  /** The projects to grade, in detection order. */
  projects: DetectedProject[];
  /** One entry per project that owns a changed file — selected or not. */
  decisions: ProjectDecision[];
  /**
   * No check is required: every changed file is documentation, it sits in a
   * project, and no project's checks read it. A DECISION, distinct from
   * "nothing here is a project" — and never a pass.
   */
  documentationOnly: boolean;
}

/** Which of a file's co-owners it needs, and why any other is not needed. */
function needs(
  owners: readonly DetectedProject[],
  file: string,
  facts: ScopeFacts,
): { keep: DetectedProject[]; drop: Array<[DetectedProject, string]> } {
  // Prose first, and for a single owner too: a README is not the project's
  // code, whoever owns the directory it sits in.
  if (isDocumentationPath(file)) {
    const keep: DetectedProject[] = [];
    const drop: Array<[DetectedProject, string]> = [];
    for (const p of owners) {
      if (facts.readsDocumentation(p)) keep.push(p);
      else {
        drop.push([
          p,
          "only documentation changed here, and none of this project's checks read it",
        ]);
      }
    }
    return { keep, drop };
  }
  if (owners.length <= 1) return { keep: [...owners], drop: [] };
  const script = scriptEcosystemOf(file);
  // Not a script source or manifest — or one, but of an ecosystem that does
  // not own this directory. Nothing positive is known, so every owner stays.
  if (!script || !owners.some((p) => p.ecosystem === script)) {
    return { keep: [...owners], drop: [] };
  }
  const keep: DetectedProject[] = [];
  const drop: Array<[DetectedProject, string]> = [];
  for (const p of owners) {
    if (
      p.ecosystem === script ||
      !SELF_CONTAINED.has(p.ecosystem) ||
      facts.callsToolchain(p, script)
    ) {
      keep.push(p);
    } else {
      drop.push([
        p,
        `only ${SCRIPT_NAME[script]} sources or manifests changed here, and this project's ` +
          `build files do not call the ${SCRIPT_NAME[script]} toolchain`,
      ]);
    }
  }
  return { keep, drop };
}

const at = (dir: string): string => (dir === "" ? "the workspace root" : dir);

/**
 * The projects a run's changes select.
 *
 * Always a subset of the files' owners, and never a narrower one without a
 * stated reason: a project is left out only when every changed file it owns is
 * a script source or manifest that cannot reach it, AND the working tree shows
 * no other change that could.
 */
export function selectProjects(
  projects: readonly DetectedProject[],
  touched: readonly string[],
  facts: ScopeFacts,
): ProjectSelection {
  const kept = new Map<DetectedProject, string>();
  const dropped = new Map<DetectedProject, string>();

  for (const file of touched) {
    const { keep, drop } = needs(ownersOf(projects, file), file, facts);
    for (const p of keep) {
      if (!kept.has(p)) kept.set(p, `owns ${file}`);
    }
    for (const [p, why] of drop) {
      if (!dropped.has(p)) dropped.set(p, why);
    }
  }
  // A project one file does not need and another does is needed.
  for (const p of kept.keys()) dropped.delete(p);

  if (dropped.size > 0) {
    // The list the run handed over is what its edit tools wrote. A shell
    // command that rewrote, moved, generated or removed a file is not on it,
    // so before leaving a project out the tree itself is asked.
    const elsewhere = facts.changedElsewhere();
    if (elsewhere === null) {
      for (const p of dropped.keys()) {
        kept.set(p, "kept: the working tree could not be inspected, so nothing was assumed");
      }
      dropped.clear();
    } else {
      const listed = new Set(touched);
      for (const file of elsewhere) {
        if (dropped.size === 0) break;
        if (listed.has(file)) continue;
        const owners = ownersOf(projects, file);
        if (!owners.some((p) => dropped.has(p))) continue;
        for (const p of needs(owners, file, facts).keep) {
          if (!dropped.has(p)) continue;
          dropped.delete(p);
          kept.set(p, `kept: ${file} also changed in the working tree`);
        }
      }
    }
  }

  const decisions: ProjectDecision[] = [];
  for (const p of projects) {
    const selected = kept.get(p);
    const skipped = dropped.get(p);
    if (selected !== undefined) {
      decisions.push({ project: p.dir, ecosystem: p.ecosystem, selected: true, reason: selected });
    } else if (skipped !== undefined) {
      decisions.push({
        project: p.dir,
        ecosystem: p.ecosystem,
        selected: false,
        reason: `${p.ecosystem} at ${at(p.dir)} not run: ${skipped}`,
      });
    }
  }
  return {
    projects: projects.filter((p) => kept.has(p)),
    decisions,
    documentationOnly:
      kept.size === 0 &&
      dropped.size > 0 &&
      touched.length > 0 &&
      touched.every(isDocumentationPath),
  };
}
