// ─── The five round-trips, over a socket ───
//
// Every human-in-the-loop path the engine has, held by a client that is not
// the terminal. The host wired exactly one of them before this: permission.
// So `ask_user` failed with "No interactive user is available" for every
// desktop and detached run, the read-back could not be corrected off-terminal,
// and held steps were invisible.
//
// Two properties matter more than the plumbing.
//
// A pending promise must not live forever. The permission round-trip had no
// timeout and no rejection on disconnect, so a detached run whose client went
// away held a tool call open until the process died — a wedge with no message
// and no way out.
//
// And what happens when nobody answers must be STATED, not implied. Each kind
// carries its unattended outcome (`@gear/protocol`'s UNATTENDED_POLICY) and the
// host tells every remaining client which one it applied, so a card is never
// left on screen offering a decision that has already been made.

import type {
  Brief,
  BriefDecision,
  PermissionPrompt,
  UnattendedReason,
  UserPermissionDecision,
  UserQuestion,
} from "@gear/protocol";
import { NO_ANSWER_TEXT } from "@gear/protocol";
import type { ResearchPlan } from "../research-types";

export type RoundTripKind = "permission" | "question" | "brief" | "research_plan";

/** Ten minutes. Long enough to walk away from a permission card and come back. */
export const DEFAULT_ROUNDTRIP_TIMEOUT_MS = 10 * 60_000;

export interface RoundTripDeps {
  /** Push a stream frame to every connected client. */
  emit: (stream: string, payload: unknown) => void;
  /** How many clients are attached right now. Zero means unattended. */
  clientCount: () => number;
  /** Per-request ceiling. Override via `GEAR_ROUNDTRIP_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** Injected in tests. */
  now?: () => number;
}

interface Pending {
  requestId: string;
  kind: RoundTripKind;
  sessionId?: string;
  /** Settle with the value a human gave, or the one the policy substitutes. */
  settle: (value: unknown) => void;
  /** What this round-trip is worth when nobody answers. */
  unattended: unknown;
  /** The word the `roundtrip_resolved` frame reports. */
  applied: string;
  timer: ReturnType<typeof setTimeout>;
}

export class RoundTripRegistry {
  private readonly pending = new Map<string, Pending>();
  private seq = 0;
  private readonly deps: Required<Omit<RoundTripDeps, "timeoutMs">> & { timeoutMs: number };

  constructor(deps: RoundTripDeps) {
    this.deps = {
      emit: deps.emit,
      clientCount: deps.clientCount,
      now: deps.now ?? Date.now,
      timeoutMs: deps.timeoutMs ?? readTimeoutFromEnv(),
    };
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  /** Ids of everything still waiting, for `--status` and tests. */
  get pendingIds(): string[] {
    return [...this.pending.keys()];
  }

  // ─── 1. Permission ───

  permission(prompt: PermissionPrompt, sessionId?: string): Promise<UserPermissionDecision> {
    return this.open<UserPermissionDecision>({
      kind: "permission",
      sessionId,
      // Denying is the only safe substitute: the alternative is silently
      // granting whatever a model asked for to a process nobody is watching.
      unattended: { kind: "deny" },
      applied: "deny",
      frame: (requestId) => [
        "permission_request",
        {
          requestId,
          sessionId,
          prompt: {
            toolName: prompt.toolName,
            argsSummary: prompt.argsSummary,
            suggestedScope: prompt.suggestedScope,
            rawArgs: prompt.rawArgs,
            safety: prompt.safety,
            exactSessionGrant: prompt.exactSessionGrant,
            sessionGrantUnavailable: prompt.sessionGrantUnavailable,
            rateLimit: prompt.rateLimit,
          },
        },
      ],
    });
  }

  // ─── 2. ask_user ───

  question(question: UserQuestion, sessionId?: string): Promise<string> {
    return this.open<string>({
      kind: "question",
      sessionId,
      // Not an error and not a stall: the instruction that lets the model
      // proceed on its best judgment and say which assumption it made.
      unattended: NO_ANSWER_TEXT,
      applied: "no-answer",
      frame: (requestId) => ["question_request", { requestId, sessionId, question }],
    });
  }

  // ─── 3. Brief (read-back) ───

  brief(brief: Brief, sessionId?: string): Promise<BriefDecision> {
    return this.open<BriefDecision>({
      kind: "brief",
      sessionId,
      // The read-back is a chance to correct a reading, not a gate. Refusing
      // it unattended would stop work that was never in doubt.
      unattended: { accepted: true },
      applied: "accept",
      frame: (requestId) => ["brief_request", { requestId, sessionId, brief }],
    });
  }

  // ─── 4. Research plan approval (P2.7) ───

  researchPlan(
    plan: ResearchPlan,
    sessionId?: string,
  ): Promise<{ approved: boolean; note?: string }> {
    return this.open<{ approved: boolean; note?: string }>({
      kind: "research_plan",
      sessionId,
      // A research run costs real money in provider calls and web fetches.
      // Unapproved is the honest default when nobody is there to approve it.
      unattended: { approved: false },
      applied: "decline",
      frame: (requestId) => ["research_plan_request", { requestId, sessionId, plan }],
    });
  }

  // ─── Answering ───

  /**
   * Settle a pending round-trip with the client's answer.
   *
   * Returns false for an id that is not pending — a late answer to a request
   * that already timed out, or a client answering twice. The caller reports
   * that honestly rather than silently succeeding.
   */
  answer(requestId: string, value: unknown): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(requestId);
    entry.settle(value);
    return true;
  }

  /**
   * The last client disconnected: settle everything by policy.
   *
   * Deliberately not "reject". A rejection here would surface to the model as
   * a tool error, which reads as a broken harness. Applying the policy is the
   * honest outcome — the run continues, contained.
   */
  clientsGone(): void {
    this.settleAll("no_clients");
  }

  /** Shutdown: same treatment, so nothing is left hanging on a dying process. */
  drain(): void {
    this.settleAll("no_clients");
  }

  private settleAll(reason: UnattendedReason): void {
    for (const entry of [...this.pending.values()]) {
      clearTimeout(entry.timer);
      this.pending.delete(entry.requestId);
      this.deps.emit("roundtrip_resolved", {
        requestId: entry.requestId,
        kind: entry.kind,
        reason,
        applied: entry.applied,
      });
      entry.settle(entry.unattended);
    }
  }

  private open<T>(spec: {
    kind: RoundTripKind;
    sessionId?: string;
    unattended: unknown;
    applied: string;
    frame: (requestId: string) => [string, unknown];
  }): Promise<T> {
    return new Promise<T>((resolve) => {
      const requestId = `${spec.kind}-${++this.seq}`;
      const timer = setTimeout(() => {
        if (!this.pending.has(requestId)) return;
        this.pending.delete(requestId);
        this.deps.emit("roundtrip_resolved", {
          requestId,
          kind: spec.kind,
          reason: "timeout" satisfies UnattendedReason,
          applied: spec.applied,
        });
        resolve(spec.unattended as T);
      }, this.deps.timeoutMs);
      // Never hold the process open for a card nobody is looking at.
      (timer as unknown as { unref?: () => void }).unref?.();

      this.pending.set(requestId, {
        requestId,
        kind: spec.kind,
        sessionId: spec.sessionId,
        settle: resolve as (v: unknown) => void,
        unattended: spec.unattended,
        applied: spec.applied,
        timer,
      });

      const [stream, payload] = spec.frame(requestId);
      this.deps.emit(stream, payload);

      // The race the naive version loses: a run that reaches a permission gate
      // with nobody attached would otherwise wait the full timeout for an
      // answer that cannot arrive. Check AFTER emitting, so a client that
      // connected between the two still gets its frame.
      if (this.deps.clientCount() === 0) this.clientsGone();
    });
  }
}

function readTimeoutFromEnv(): number {
  const raw = process.env.GEAR_ROUNDTRIP_TIMEOUT_MS;
  if (!raw) return DEFAULT_ROUNDTRIP_TIMEOUT_MS;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_ROUNDTRIP_TIMEOUT_MS;
}
