// The audit's polish rows (2026-10-26), each pinned where it was fixed.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { TurnRenderer, type TurnSink } from "../../../packages/orchestrator/src/bin/ui/turn";
import { stripAnsi } from "../../../packages/orchestrator/src/bin/ui/theme";
import {
  setTermWidthOverride,
  truncateWords,
  visLen,
} from "../../../packages/orchestrator/src/bin/ui/render";
import * as F from "../../../packages/orchestrator/src/bin/ui/flow";
import { renderToolActivity } from "../../../packages/orchestrator/src/bin/ui/activity";
import { statusLine } from "../../../packages/orchestrator/src/bin/ui/composer";
import { INPUT_METHODS } from "../../../packages/orchestrator/src/bin/ui/tui-input";
import { providerChoices } from "../../../packages/orchestrator/src/bin/ui/model-picker";
import { fleetLedger } from "../../../packages/orchestrator/src/bin/ui/agents-panel";
import { glyph } from "../../../packages/orchestrator/src/bin/ui/glyphs";
import { formatCostSummary } from "../../../packages/orchestrator/src/cost-report";

beforeEach(() => {
  fleetLedger.reset();
  setTermWidthOverride(100);
});
afterEach(() => {
  fleetLedger.reset();
  setTermWidthOverride(null);
});

function live() {
  const blocks = new Map<number, string>();
  const order: number[] = [];
  let seq = 0;
  const sink: TurnSink = {
    commit: (block) => {
      const handle = ++seq;
      blocks.set(handle, block);
      order.push(handle);
      return handle;
    },
    amend: (handle, block) => {
      if (block === "") blocks.delete(handle);
      else blocks.set(handle, block);
    },
    preview: () => {},
  };
  const turn = new TurnRenderer(sink, { getCost: () => 0 });
  return {
    turn,
    feed: (...events: object[]) => {
      for (const e of events) turn.onEvent(e as never);
    },
    output: () =>
      stripAnsi(
        order
          .filter((h) => blocks.has(h))
          .map((h) => blocks.get(h)!)
          .join("\n"),
      ),
  };
}

describe("text is cut at a word, not inside one", () => {
  it("keeps whole words when there is a boundary to keep", () => {
    const cut = truncateWords(
      "Connect a subscription, an API key, a local model, or web search",
      52,
    );
    expect(visLen(cut)).toBeLessThanOrEqual(52);
    expect(cut).toBe(`Connect a subscription, an API key, a local model${glyph("elision")}`);
    expect(truncateWords("short", 20)).toBe("short");
  });
});

describe("one separator", () => {
  it("an edit's receipt and the work header use the middot, not a bar", () => {
    const row = stripAnsi(F.editMetric(2, 1, "1 hunk"));
    expect(row).toBe(`+2 -1 ${glyph("observed")} 1 hunk`);
    expect(row).not.toContain("|");
  });

  it("a box footer says what the call produced, not the evidence rung", () => {
    const out = stripAnsi(
      renderToolActivity({
        toolName: "edit_file",
        args: { path: "src/a.ts" },
        result: JSON.stringify({
          path: "src/a.ts",
          diff: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n a\n-b\n+B",
        }),
        success: true,
      }),
    );
    expect(out).not.toContain("observed");
    expect(out).toContain("+1 -1");
  });
});

describe("one event, one row", () => {
  it("a steer is the message with its receipt on the same row", () => {
    const block = stripAnsi(F.asked("also say which node version", "folded into the running task"));
    const rows = block.split("\n").filter((r) => r.trim());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("also say which node version");
    expect(rows[0]).toContain("folded into the running task");
  });

  it("the loop's notice repeating a re-plan is not a second row", () => {
    const h = live();
    h.feed(
      {
        type: "replanning",
        reason: "checks still failing after repeated fixes",
        trigger: "verification",
      },
      { type: "notice", message: "Repeated fixes failed — asking the agent to re-plan." },
    );
    const out = h.output();
    expect(out).toContain(`re-planning ${glyph("observed")} checks still failing`);
    expect(out).not.toContain("Repeated fixes failed");
  });

  it("the loop's confirmation of a steer is not a second row", () => {
    const h = live();
    h.feed({ type: "notice", message: "New message from you folded into the running task." });
    expect(h.output()).not.toContain("New message from you");
  });

  it("a plan update does not leave a row under the plan", () => {
    const h = live();
    const items = [
      { content: "Map the CLI", status: "in_progress" },
      { content: "Add the flag", status: "pending" },
    ];
    h.feed(
      { type: "tool_call_start", callId: "p1", toolName: "todo_write" },
      { type: "todo_updated", items },
      {
        type: "tool_call_end",
        callId: "p1",
        args: { items },
        output: { callId: "p1", toolName: "todo_write", success: true, result: "ok" },
      },
    );
    const out = h.output();
    expect(out).toContain("Map the CLI");
    expect(out).not.toMatch(/plan\s+updated/);
  });
});

describe("words a person would use", () => {
  it("one line is a line", () => {
    const out = stripAnsi(
      renderToolActivity({
        toolName: "read_file",
        args: { path: "a.ts" },
        result: JSON.stringify({ path: "a.ts", total_lines: 1, content: "1\tx" }),
        success: true,
      }),
    );
    expect(out).toContain("1 line");
    expect(out).not.toContain("1 lines");
  });

  it("an answer is set down with the question it answers", () => {
    const rows = stripAnsi(
      F.answered(0, "Yes, keep a backup table", "Keep a backup of the old rows?"),
    )
      .split("\n")
      .filter((r) => r.trim());
    expect(rows).toEqual([
      `${F.MARK}Keep a backup of the old rows?`,
      `${F.MARK}${glyph("selection")} 1   Yes, keep a backup table`,
    ]);
  });

  it("spend says what it is: nothing yet, or what it would cost at list prices", () => {
    const empty = {
      totalCostUsd: 0,
      totalListCostUsd: 0,
      hasEstimatedRates: false,
      cacheHitRate: null,
    };
    expect(formatCostSummary(empty as never)).toBe("nothing spent yet");
    const sub = { ...empty, totalListCostUsd: 1.35, hasEstimatedRates: true };
    expect(formatCostSummary(sub as never)).toBe("~$1.35 at list prices");
  });

  it("the model picker marks the row in use once", () => {
    const rows = [
      {
        id: "ollama",
        label: "Ollama (local)",
        local: true,
        active: true,
        hasKey: false,
        disabled: false,
        keyCount: 0,
        endpoint: "http://127.0.0.1:11434",
      },
    ];
    const [tui] = providerChoices(rows as never, undefined, {}, () => undefined, {
      markActive: false,
    });
    expect(stripAnsi(tui!.hint)).not.toContain("active");
    const [cli] = providerChoices(rows as never, undefined, {}, () => undefined);
    expect(stripAnsi(cli!.hint)).toContain("active");
  });

  it("ctrl+c's second-press hint lives on the status line while it is true", () => {
    const line = stripAnsi(
      statusLine({ model: "m", mode: "gear-2", workspace: "/tmp/ws", exitArmed: true }, 100),
    );
    expect(line).toContain("ctrl+c again to exit");
  });
});

describe("the work review agrees with the frame about its size", () => {
  it("draws in the rows the frame gives it, and pages by them", () => {
    const log = ["  Work details", ...Array.from({ length: 60 }, (_, i) => `  row ${i + 1}`)].join(
      "\n",
    );
    const t: any = {
      mode: "review",
      reviewLog: log,
      reviewTop: 0,
      liveTurn: null,
      contentCols: () => 100,
      reviewRows: null,
    };
    const block = INPUT_METHODS.composerBlock.call(t, 20);
    expect(t.reviewRows).toBe(20);
    // Title, a page, and the key line: never more rows than it was given, so
    // the frame never has to cut it and add a counter of its own.
    expect(block.lines.length).toBeLessThanOrEqual(20);
    expect(stripAnsi(block.lines[0]!)).toContain(" of 60");
  });
});
