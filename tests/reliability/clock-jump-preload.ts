/**
 * Loaded into a spawned `rune` with `bun --preload`, for the transport suite's
 * clock jump (R0.1 of docs/program/rune-reliability-plan-20261014.md).
 *
 * When the file named by `RUNE_TEST_CLOCK_JUMP` appears, the process's wall
 * clock moves by the milliseconds written in it, as an NTP correction or a
 * person setting the time would move it, and `<file>.done` is written back.
 * The monotonic clock does not move. Only `Date.now` is shifted: it is what
 * Rune's deadlines and its sleep check read.
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

const trigger = process.env.RUNE_TEST_CLOCK_JUMP;
if (trigger) {
  const realNow = Date.now.bind(Date);
  let offset = 0;
  Date.now = () => realNow() + offset;
  const poll = setInterval(() => {
    if (!existsSync(trigger)) return;
    const ms = Number(readFileSync(trigger, "utf8").trim()) || 0;
    try {
      unlinkSync(trigger);
    } catch {
      // Gone already: the jump below still lands once.
    }
    offset += ms;
    writeFileSync(`${trigger}.done`, String(offset));
  }, 25);
  poll.unref?.();
}
