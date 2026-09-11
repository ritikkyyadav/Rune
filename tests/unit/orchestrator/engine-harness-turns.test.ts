/**
 * A `user_msg` row the HARNESS wrote is not a user turn.
 *
 * P3B I2 (`730fd97`) put an origin on every synthetic re-prompt, and the
 * engine's persistence seam files those as `user_msg` rows carrying
 * `harness: "<kind>:<name>"`. Nothing read the marker, so the rows reached
 * `/rewind` (`listUserTurns`), session replay (`getTranscript`) and the
 * permission check's trusted-intent corpus as if the founder had typed them —
 * which `tests/integration/engine-interject.test.ts` caught by finding 2 KB of
 * just-in-time doctrine sitting in the middle of a two-message conversation.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionManager } from "../../../packages/shared/src/session";
import { Engine } from "../../../packages/orchestrator/src/engine";
import { rmTemp } from "../../helpers/tmp";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmTemp(root);
});

describe("harness-authored user rows", () => {
  test("/rewind offers the user's own turns and not the harness's re-prompts", () => {
    const root = mkdtempSync(join(tmpdir(), "rune-harness-turns-"));
    roots.push(root);
    const dbPath = join(root, "rune.db");

    // Write the log the way the engine's persistence seam does: the user's
    // message, a gate re-prompt, a harness note, another user message.
    const store = new SessionManager(dbPath);
    const session = store.createSession(root, "mock-model", "mock");
    store.appendEvent(session.id, { type: "user_msg", payload: { content: "build the page" } });
    store.appendEvent(session.id, {
      type: "assistant_msg",
      payload: { content: "half done", toolUses: [] },
    });
    store.appendEvent(session.id, {
      type: "user_msg",
      payload: {
        content: "[Harness] you have open steps",
        harness: "gate:open-steps",
      },
    });
    store.appendEvent(session.id, {
      type: "user_msg",
      payload: {
        content: "[Harness note] # Building interfaces\n- ART DIRECTION: …",
        harness: "nudge:harness-notes",
      },
    });
    store.appendEvent(session.id, { type: "user_msg", payload: { content: "add a footer" } });
    store.close();

    const engine = new Engine({
      workspaceRoot: root,
      dbPath,
      sandboxEnabled: true,
      enableMcp: false,
      enableSkills: false,
      enableVerification: false,
    });
    try {
      expect(engine.listUserTurns(session.id).map((t) => t.text)).toEqual([
        "build the page",
        "add a footer",
      ]);
      expect(engine.getTranscript(session.id)).toEqual([
        { role: "user", text: "build the page" },
        { role: "assistant", text: "half done" },
        { role: "user", text: "add a footer" },
      ]);
    } finally {
      engine.close();
    }
  });
});
