// The pinned header names the product version a person is using and the
// session they are in -- founder, 2026-09-16: "simply v0.1.1", and "the session
// id … maybe the last some digits, by which they can find the chat later".

import { describe, expect, test } from "bun:test";
import { displayVersion } from "../../../packages/orchestrator/src/bin/ui/brand";
import {
  farewell,
  header,
  sessionTail,
  versionTag,
} from "../../../packages/orchestrator/src/bin/ui/flow";
import { matchSessionIdish } from "../../../packages/orchestrator/src/session-idish";

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("the header's version is the product number, not the build marker", () => {
  test("displayVersion drops -dev and -dev+sha, keeps a release number", () => {
    expect(displayVersion("0.1.1-dev+6b9afcf")).toBe("0.1.1");
    expect(displayVersion("0.1.1-dev")).toBe("0.1.1");
    expect(displayVersion("0.1.1")).toBe("0.1.1");
    expect(displayVersion("0.2.0-rc.1")).toBe("0.2.0-rc.1");
  });

  test("the pinned header reads v0.1.1 for a dev build", () => {
    const row = strip(header({ name: "Rune", version: "0.1.1-dev+6b9afcf", workspace: "~/x" }));
    expect(row).toContain("v0.1.1");
    expect(row).not.toContain("dev");
    expect(row).not.toContain("6b9afcf");
    expect(strip(versionTag("0.1.1-dev+6b9afcf"))).toBe("v0.1.1");
  });
});

describe("the session's tail: off the header, on the way out", () => {
  const id = "0192a7b3-4c5d-7e6f-8a9b-0c1d2e3f4a5b";

  test("the header carries the version and nothing after it (2026-09-26)", () => {
    const block = strip(header({ name: "Rune", version: "0.1.1", workspace: "~/x", session: id }));
    const row = block.split("\n").filter((line) => line.trim())[0]!;
    expect(sessionTail(id)).toBe("2e3f4a5b");
    expect(block).not.toContain("2e3f4a5b");
    expect(row.trimEnd().endsWith("v0.1.1")).toBe(true);
  });

  test("the exit line offers the session back by its tail, never the head", () => {
    const line = strip(farewell(id));
    expect(line).toContain("Goodbye.");
    expect(line).toContain("rune resume 2e3f4a5b");
    // Never the head: two sessions opened in the same minute share it.
    expect(line).not.toContain("0192a7b3");
    // A discarded session is not offered back.
    expect(strip(farewell()).trim()).toBe("Goodbye.");
  });

  test("that tail resolves the session, as does the head or the whole id", () => {
    const sessions = [{ id }, { id: "0192a7b3-4c5d-7e6f-8a9b-ffffffffffff" }];
    expect(matchSessionIdish(sessions, "2e3f4a5b")?.id).toBe(id);
    expect(matchSessionIdish(sessions, "…2e3f4a5b")?.id).toBe(id);
    expect(matchSessionIdish(sessions, id)?.id).toBe(id);
    expect(matchSessionIdish(sessions, "0192a7b3")?.id).toBe(id);
    expect(matchSessionIdish(sessions, "ffffffff")?.id).toBe(sessions[1].id);
    expect(matchSessionIdish(sessions, "zzz")).toBeUndefined();
    expect(matchSessionIdish(sessions, "")).toBeUndefined();
  });
});
