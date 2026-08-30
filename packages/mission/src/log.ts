// ─── Gear · the log ───
// The log **is** the mission. Everything else — the state, the stream, every screen —
// is derived and can be thrown away, which is also how crash recovery comes for free:
// a restart replays to the last checkpoint, compares the tree hash, and answers the
// only two questions anyone has afterwards.
//
// Append-only, one JSON object per line, fsync'd at each checkpoint. `seq` and `at`
// are assigned here and never by the emitter, so ordering is a property of the file
// rather than of whoever was writing to it.

import { appendFileSync, closeSync, existsSync, openSync, readFileSync, fsyncSync } from "node:fs";
import { type DraftEvent, type MissionEvent } from "./events";
import { type MissionState, initialState, reduce } from "./reduce";

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export class MissionLog {
  private events: MissionEvent[] = [];
  private state: MissionState = initialState();
  private seq = 0;
  private fd?: number;

  constructor(
    private readonly path?: string,
    private readonly clock: Clock = systemClock,
  ) {
    if (path && existsSync(path)) this.load();
  }

  private load(): void {
    const lines = readFileSync(this.path!, "utf8").split("\n").filter(Boolean);
    for (const line of lines) {
      // A half-written trailing line is what a crash mid-append looks like. Everything
      // before it is still the mission; drop only the torn record.
      let ev: MissionEvent;
      try {
        ev = JSON.parse(line) as MissionEvent;
      } catch {
        continue;
      }
      this.events.push(ev);
      this.state = reduce(this.state, ev);
      this.seq = Math.max(this.seq, ev.seq);
    }
  }

  /** Append one event. The reducer runs synchronously so callers can read state back. */
  append(draft: DraftEvent): MissionEvent {
    const ev = { ...draft, seq: ++this.seq, at: this.clock.now() } as MissionEvent;
    this.events.push(ev);
    this.state = reduce(this.state, ev);
    if (this.path) {
      appendFileSync(this.path, JSON.stringify(ev) + "\n");
      // A checkpoint is the thing a restore trusts, so it is the thing that gets the
      // fsync. Paying for one on every event would make the agent wait on the disk.
      if (ev.type === "CHECKPOINT") this.sync();
    }
    return ev;
  }

  private sync(): void {
    if (!this.path) return;
    const fd = openSync(this.path, "r+");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  get current(): MissionState {
    return this.state;
  }

  get all(): readonly MissionEvent[] {
    return this.events;
  }

  /** Replay any prefix. Used by the tests, and by `/rewind`. */
  at(seq: number): MissionState {
    return this.events.filter((e) => e.seq <= seq).reduce(reduce, initialState());
  }

  /** The checkpoint a restore resumes from, and what it can say was kept. */
  get lastCheckpoint() {
    return this.state.checkpoints[this.state.checkpoints.length - 1];
  }

  /**
   * What the crash cost, in the only two words anyone wants: everything after the last
   * checkpoint is `lost`, everything up to it is `not lost`. Both are counted from the
   * log rather than from a memory of what was running.
   */
  lossReport(): { lost: MissionEvent[]; keptThrough?: number } {
    const cp = this.lastCheckpoint;
    if (!cp) return { lost: [...this.events] };
    return { lost: this.events.filter((e) => e.seq > cp.seq), keptThrough: cp.seq };
  }
}
