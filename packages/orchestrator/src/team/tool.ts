// ─── `team` tool: coordinate with other Rune instances in this repository ───
//
// The bus (bus.ts) is the mechanism; this tool is the model's steering wheel
// for it: see who else is working here, tell them things, lease path scopes
// before a big change, and advertise what this session is doing. Delivery is
// turn-boundary mail, not a live socket — the description says so, so the
// model never waits for an instant reply.

import type { ToolCallInput, ToolCallOutput, ToolHandler, ToolSchema } from "@rune/tool-registry";
import type { TeamBus, TeamPeer } from "./bus";

export interface TeamToolDeps {
  /** Live bus accessor — null when the team layer is disabled/unavailable. */
  getBus: () => TeamBus | null;
}

const ACTIONS = ["status", "send", "claim", "release", "intent"] as const;
type TeamAction = (typeof ACTIONS)[number];

export const TEAM_TOOL_SCHEMA: ToolSchema = {
  name: "team",
  version: "0.1.0",
  description:
    "Coordinate with OTHER Rune instances working in this repository (the user may run " +
    "several sessions at once). Actions: 'status' lists live peers, what each is working on, " +
    "and their path claims; 'send' delivers a message to one peer (`to`) or all (omit `to`) — " +
    "delivered at the peer's next turn boundary, so never wait for an instant reply; 'claim' " +
    "leases workspace paths you are about to change so peers get warned off (end directories " +
    "with '/'); 'release' drops your claims; 'intent' sets the one-line status peers see. " +
    "Use it when a [Team] block shows peers and you are about to touch overlapping areas, " +
    'or to hand off findings ("auth refactor done, session.ts interface changed").',
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: [...ACTIONS],
        description: "What to do: status | send | claim | release | intent",
      },
      message: { type: "string", description: "send: the message body." },
      to: {
        type: "string",
        description: 'send: target instance id (from status, e.g. "g-a1b2c3"). Omit = all peers.',
      },
      paths: {
        type: "array",
        items: { type: "string" },
        description: "claim: workspace-relative files/dirs to lease (dirs end with '/').",
      },
      reason: { type: "string", description: "claim: one line on why (shown to peers)." },
      minutes: { type: "number", description: "claim: lease length in minutes (default 30)." },
      intent: { type: "string", description: "intent: the one-line status to show peers." },
    },
    required: ["action"],
  },
  permissionLevel: "auto",
  // execute keeps it out of the read-parallel pool: claim/send order matters.
  category: "execute",
};

function fmtAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

function fmtUntil(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function describePeer(p: TeamPeer): string {
  const bits: string[] = [];
  if (p.intent) bits.push(`working on: ${p.intent}`);
  if (!p.sameTree) bits.push(`separate worktree${p.branch ? ` (${p.branch})` : ""}`);
  else if (p.branch) bits.push(`branch ${p.branch}`);
  if (p.model) bits.push(p.model);
  bits.push(`active ${fmtAge(Date.now() - p.lastBeat)}`);
  return `${p.id} — ${bits.join(" · ")}`;
}

/** Render the full team picture (also used by the /team command). */
export function renderTeamStatus(bus: TeamBus): string {
  const peers = bus.peers();
  const claims = bus.liveClaims();
  const lines: string[] = [`You are instance ${bus.instanceId}.`];
  if (peers.length === 0) {
    lines.push("No other Rune instances are active in this repository.");
  } else {
    lines.push(`Live peers (${peers.length}):`);
    for (const p of peers) lines.push(`  ${describePeer(p)}`);
  }
  if (claims.length > 0) {
    lines.push("Active path claims:");
    for (const c of claims) {
      const owner = c.instanceId === bus.instanceId ? "you" : c.instanceId;
      const why = c.reason ? ` — ${c.reason}` : "";
      lines.push(`  [${owner}] ${c.paths.join(", ")} (until ${fmtUntil(c.expiresAt)})${why}`);
    }
  }
  const pending = bus.pendingMessageCount();
  if (pending > 0) {
    lines.push(
      `${pending} unread message${pending === 1 ? "" : "s"} will arrive at the next turn boundary.`,
    );
  }
  return lines.join("\n");
}

export function createTeamTool(deps: TeamToolDeps): ToolHandler {
  return {
    schema: TEAM_TOOL_SCHEMA,

    validate: (args) => {
      const action = args.action;
      if (typeof action !== "string" || !ACTIONS.includes(action as TeamAction)) {
        return { valid: false, error: `action must be one of: ${ACTIONS.join(", ")}` };
      }
      switch (action as TeamAction) {
        case "send":
          if (typeof args.message !== "string" || !args.message.trim()) {
            return { valid: false, error: "send requires a non-empty message" };
          }
          if (args.to !== undefined && typeof args.to !== "string") {
            return { valid: false, error: "to must be an instance id string" };
          }
          break;
        case "claim":
          if (
            !Array.isArray(args.paths) ||
            args.paths.length === 0 ||
            !args.paths.every((p) => typeof p === "string" && p.trim())
          ) {
            return { valid: false, error: "claim requires paths: a non-empty string array" };
          }
          if (
            args.minutes !== undefined &&
            (typeof args.minutes !== "number" || args.minutes <= 0)
          ) {
            return { valid: false, error: "minutes must be a positive number" };
          }
          break;
        case "intent":
          if (typeof args.intent !== "string" || !args.intent.trim()) {
            return { valid: false, error: "intent requires a non-empty intent string" };
          }
          break;
        default:
          break;
      }
      return { valid: true };
    },

    execute: async (input: ToolCallInput): Promise<ToolCallOutput> => {
      const start = performance.now();
      const done = (success: boolean, result: string, error?: string): ToolCallOutput => ({
        callId: input.callId,
        toolName: input.toolName,
        success,
        result,
        ...(error ? { error } : {}),
        durationMs: Math.round(performance.now() - start),
      });

      const bus = deps.getBus();
      if (!bus || !bus.healthy) {
        return done(
          false,
          "",
          "The team layer is not available in this session (disabled or the bus could not open). " +
            "Proceed solo — there is no peer coordination to do.",
        );
      }

      const action = input.args.action as TeamAction;
      switch (action) {
        case "status":
          return done(true, renderTeamStatus(bus));

        case "send": {
          const to = typeof input.args.to === "string" ? input.args.to.trim() : undefined;
          const res = bus.send(String(input.args.message), to || undefined);
          if (!res.ok) return done(false, "", res.error ?? "send failed");
          return done(
            true,
            `Message queued for ${to || "all peers"} — it arrives at their next turn boundary. ` +
              "Do not wait for a reply; continue your work.",
          );
        }

        case "claim": {
          const paths = (input.args.paths as string[]).map((p) => p.trim());
          const minutes = typeof input.args.minutes === "number" ? input.args.minutes : undefined;
          const reason = typeof input.args.reason === "string" ? input.args.reason : undefined;
          const res = bus.claim(paths, {
            ...(reason ? { reason } : {}),
            ...(minutes ? { ttlMs: Math.round(minutes * 60_000) } : {}),
          });
          if (!res.ok) {
            const c = res.conflict;
            const who = c.peer ? describePeer(c.peer) : c.claim.instanceId;
            return done(
              false,
              "",
              `Claim conflict: ${c.claim.paths.join(", ")} is already claimed by ${who}` +
                `${c.claim.reason ? ` (${c.claim.reason})` : ""}, until ${fmtUntil(c.claim.expiresAt)}. ` +
                "Pick non-overlapping paths, message them to coordinate, or wait for the lease to end.",
            );
          }
          if (!res.id) {
            return done(true, "Nothing to lease — those paths are outside this workspace.");
          }
          return done(
            true,
            `Claimed ${paths.join(", ")} until ${fmtUntil(res.expiresAt)} (claim ${res.id}). ` +
              'Release it with {action: "release"} when done.',
          );
        }

        case "release": {
          const n = bus.releaseClaim();
          return done(
            true,
            n === 0 ? "No claims to release." : `Released ${n} claim${n === 1 ? "" : "s"}.`,
          );
        }

        case "intent": {
          bus.setIntent(String(input.args.intent).trim());
          return done(true, "Intent updated — peers now see it in their team status.");
        }
      }
    },
  };
}
