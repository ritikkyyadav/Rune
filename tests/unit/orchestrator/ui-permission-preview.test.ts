import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { buildPermissionPreview } from "../../../packages/orchestrator/src/bin/ui/permission-preview";

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "rune-permission-preview-"));
}

describe("ui/permission-preview", () => {
  it("locates edit_file replacements in the real source and reports exact line numbers", async () => {
    const root = await workspace();
    try {
      await writeFile(
        join(root, "palette.ts"),
        ["const delay = 42;", "filterSoon(query);", "return results;", ""].join("\n"),
      );
      const preview = await buildPermissionPreview({
        toolName: "edit_file",
        argsSummary: "edit_file palette.ts",
        rawArgs: {
          path: "palette.ts",
          old_text: "filterSoon(query);",
          new_text: "filterNow(query);",
        },
        workspaceRoot: root,
      });

      expect(preview.question).toBe("Apply this edit to palette.ts?");
      expect(preview.scope).toContain("reversible");
      expect(preview.lines.find((line) => line.kind === "remove")).toMatchObject({
        oldLine: 2,
        text: "filterSoon(query);",
      });
      expect(preview.lines.find((line) => line.kind === "add")).toMatchObject({
        newLine: 2,
        text: "filterNow(query);",
      });
      expect(preview.guard).toContain("Working tree unchanged");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reduces a full rewrite to the changed middle instead of dumping the whole file", async () => {
    const root = await workspace();
    try {
      await writeFile(join(root, "config.ts"), "header\nold value\nfooter\n");
      const preview = await buildPermissionPreview({
        toolName: "write_file",
        argsSummary: "write_file config.ts",
        rawArgs: { path: "config.ts", content: "header\nnew value\nfooter\n" },
        workspaceRoot: root,
      });

      expect(preview.question).toContain("Replace the contents");
      expect(preview.added).toBe(1);
      expect(preview.removed).toBe(1);
      expect(preview.lines.map((line) => line.text)).toEqual([
        "header",
        "old value",
        "new value",
        "footer",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("makes network escalation and exact-session scope explicit for commands", async () => {
    const preview = await buildPermissionPreview({
      toolName: "bash",
      argsSummary: "bash: git push origin main",
      rawArgs: { command: "git push origin main", network: true },
      workspaceRoot: "/workspace",
      exactSessionGrant: true,
      safety: { reason: "Remote write needs a human decision", tier: "classifier" },
    });

    expect(preview.scope).toBe("host command | network access");
    expect(preview.detail).toBe("git push origin main");
    expect(preview.choices[1]).toContain("exact action");
    expect(preview.reason).toContain("Remote write");
    expect(preview.guard).toContain("has not run");
  });

  it("never calls an existing but unreadable target a new file", async () => {
    const root = await workspace();
    try {
      await mkdir(join(root, "existing-target"));
      const preview = await buildPermissionPreview({
        toolName: "write_file",
        argsSummary: "write_file existing-target",
        rawArgs: { path: "existing-target", content: "replacement" },
        workspaceRoot: root,
      });

      expect(preview.question).toContain("Replace the contents");
      expect(preview.question).not.toContain("Create");
      expect(preview.summary).toContain("existing target not loaded");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("drops the session choice entirely on a circuit-breaker ask", async () => {
    const preview = await buildPermissionPreview({
      toolName: "bash",
      argsSummary: "bash: rm -rf /",
      rawArgs: { command: "rm -rf /" },
      workspaceRoot: "/workspace",
      exactSessionGrant: true,
      sessionGrantUnavailable: true,
      safety: { reason: "Catastrophic blast radius", tier: "classifier" },
    });

    expect(preview.choices).toHaveLength(2);
    expect(preview.choices[0]).toContain("Yes");
    expect(preview.choices[1]).toContain("No");
    for (const choice of preview.choices) expect(choice).not.toContain("session");
  });

  it("never fabricates a line-1 anchor for an empty old_text edit", async () => {
    const root = await workspace();
    try {
      await writeFile(join(root, "config.ts"), "first line\nsecond line\n");
      const preview = await buildPermissionPreview({
        toolName: "edit_file",
        argsSummary: "edit_file config.ts",
        rawArgs: { path: "config.ts", old_text: "", new_text: "injected\n" },
        workspaceRoot: root,
      });

      // No stolen context row from the top of the file, no line numbers…
      expect(preview.lines.some((line) => line.text === "first line")).toBe(false);
      expect(preview.lines.every((line) => line.oldLine === undefined)).toBe(true);
      // …and the card says outright that the editor rejects this call.
      expect(preview.lines.some((line) => line.text.includes("editor rejects"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
