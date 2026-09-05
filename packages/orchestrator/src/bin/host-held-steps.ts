// ─── The held-step ledger, over a socket ───
//
// Auto mode's end-of-turn list: the outward, irreversible steps it declined to
// take unattended. On the terminal these become a panel you approve from. Off
// the terminal they were invisible — `setAutoDeferralNotifier` was never wired
// on the host, so a desktop or detached run silently dropped every deferral
// and the work simply did not happen with nothing on screen to say so.
//
// The one rule that shapes this file: a client refers to a held step by ID,
// never by its arguments. `AutoModeDeferral.args` is raw and unredacted by
// design — it is the exact payload the agent asked for, held verbatim so
// "run exactly this" runs precisely that and never a paraphrase. It stays
// in-process. What crosses the wire is `summary`, which is bounded and
// secret-scrubbed, plus an id the host can look the real arguments up by.

import type { HeldStep } from "@rune/protocol";
import type { AutoModeDeferral } from "../auto-mode";

export class HeldStepLedger {
  /** sessionId → (wire id → the in-process deferral, args and all). */
  private readonly bySession = new Map<string, Map<string, AutoModeDeferral>>();
  private seq = 0;

  /**
   * Record the deferrals a turn produced and return their wire form.
   *
   * Replaces the session's list rather than appending: the notifier fires once
   * per turn with that turn's complete set, and appending would show a user
   * steps they already dismissed two turns ago.
   */
  record(sessionId: string, deferrals: readonly AutoModeDeferral[]): HeldStep[] {
    const map = new Map<string, AutoModeDeferral>();
    const wire: HeldStep[] = [];
    for (const d of deferrals) {
      const id = `held-${++this.seq}`;
      map.set(id, d);
      wire.push(toWire(id, d));
    }
    this.bySession.set(sessionId, map);
    return wire;
  }

  /** The wire list for a session. Empty when a turn held nothing. */
  list(sessionId: string): HeldStep[] {
    const map = this.bySession.get(sessionId);
    if (!map) return [];
    return [...map.entries()].map(([id, d]) => toWire(id, d));
  }

  /** The real deferral behind an id — the only thing that may reach the broker. */
  get(sessionId: string, stepId: string): AutoModeDeferral | undefined {
    return this.bySession.get(sessionId)?.get(stepId);
  }

  /** Forget one step: it ran, or the user declined it. */
  remove(sessionId: string, stepId: string): boolean {
    return this.bySession.get(sessionId)?.delete(stepId) ?? false;
  }

  /**
   * Drop a set of steps (all of them when `stepIds` is absent) and return what
   * was actually dropped, so the engine is told about exactly those.
   */
  take(sessionId: string, stepIds?: string[]): AutoModeDeferral[] {
    const map = this.bySession.get(sessionId);
    if (!map) return [];
    const ids = stepIds ?? [...map.keys()];
    const taken: AutoModeDeferral[] = [];
    for (const id of ids) {
      const d = map.get(id);
      if (d) {
        taken.push(d);
        map.delete(id);
      }
    }
    return taken;
  }

  clear(sessionId: string): void {
    this.bySession.delete(sessionId);
  }
}

function toWire(id: string, d: AutoModeDeferral): HeldStep {
  return {
    id,
    toolName: d.toolName,
    summary: d.summary,
    route: d.route,
    reason: d.reason,
    // JSON has no Date. A client that received `{}` for a timestamp could not
    // sort the ledger, which is the first thing a ledger has to do.
    at: d.at instanceof Date ? d.at.toISOString() : new Date(d.at).toISOString(),
    kind: d.kind,
    substitute: d.substitute,
  };
}
