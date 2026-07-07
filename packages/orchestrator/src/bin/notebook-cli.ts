// ─── `alan notebook`: inspect and manage the tactics notebook ───
// Auditability is the contract: everything Alan has learned is listable,
// explainable (provenance), and deletable. No Engine boot needed.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAlanHome } from "@alan/shared";
import { NotebookStore } from "../notebook/store";
import type { NotebookEntry } from "../notebook/store";
import { accent, dim, faint, info, ok, text, warn } from "./ui/theme";

function openStore(): NotebookStore | null {
  try {
    return new NotebookStore(join(getAlanHome(), "notebook.db"));
  } catch {
    return null;
  }
}

function scopeLabel(e: NotebookEntry): string {
  if (e.scope === "repo") return `repo:${(e.repoKey ?? "").slice(0, 6)}`;
  if (e.scope === "stack") return `stack:${e.stackKey ?? "?"}`;
  return "global";
}

export function runNotebook(positionals: string[], values: Record<string, unknown>): void {
  const store = openStore();
  if (!store) {
    console.log(dim("  Could not open ~/.alan/notebook.db"));
    return;
  }
  const sub = positionals[1] ?? "list";

  if (sub === "list") {
    const entries = store.list({ includeRetired: !!values.all, limit: 50 });
    if (entries.length === 0) {
      console.log(
        dim("  Notebook is empty — Berne fills it as it verifies things about your codebases."),
      );
    } else {
      console.log(`\n  ${dim("§ TACTICS NOTEBOOK")} ${faint(`(${store.count()} active)`)}\n`);
      for (const e of entries) {
        const record =
          e.uses > 0 ? faint(` · used ${e.uses}× · ${Math.round((e.wins / e.uses) * 100)}% wins`) : "";
        console.log(
          `  ${info(e.id.slice(-8))} ${warn(e.kind.padEnd(7))} ${dim(scopeLabel(e).padEnd(22))}` +
            `${e.retired ? accent(" retired") : ""}${record}\n           ${text(e.body.slice(0, 100))}`,
        );
      }
      console.log(
        `\n  ${dim("manage:")} ${info("alan notebook show <id>")} ${dim("·")} ${info("alan notebook rm <id>")}\n`,
      );
    }
  } else if (sub === "show") {
    const e = positionals[2] ? store.getByPrefix(positionals[2]) : null;
    if (!e) {
      console.log(dim("  Usage: alan notebook show <id-prefix> (no unique match)"));
    } else {
      console.log(`\n  ${dim("§ ENTRY")} ${info(e.id)}\n`);
      console.log(`  ${text(e.body)}\n`);
      console.log(`  ${dim("kind")}     ${e.kind} ${dim("·")} ${scopeLabel(e)}`);
      console.log(
        `  ${dim("record")}   used ${e.uses}× · ${e.wins} wins${e.retired ? ` · ${accent("retired")}` : ""}`,
      );
      console.log(`  ${dim("learned")}  ${e.createdAt.slice(0, 10)} · updated ${e.updatedAt.slice(0, 10)}`);
      console.log(
        `  ${dim("from")}     ${e.provenance.sessions.length > 0 ? e.provenance.sessions.map((s) => s.slice(0, 8)).join(", ") : "manual"}\n`,
      );
    }
  } else if (sub === "rm") {
    const e = positionals[2] ? store.getByPrefix(positionals[2]) : null;
    if (!e) {
      console.log(dim("  Usage: alan notebook rm <id-prefix> (no unique match)"));
    } else {
      store.remove(e.id);
      console.log(`  ${ok("✓")} removed: ${faint(e.body.slice(0, 70))}`);
    }
  } else if (sub === "export") {
    const out =
      (values.out as string | undefined) ?? join(process.cwd(), "alan-notebook-export.jsonl");
    const entries = store.list({ includeRetired: true, limit: 10_000 });
    writeFileSync(out, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
    console.log(`  ${ok("✓")} exported ${entries.length} entries → ${info(out)}`);
  } else {
    console.log(dim("  Usage: alan notebook [list [--all]|show <id>|rm <id>|export [--out <path>]]"));
  }
  store.close();
}
