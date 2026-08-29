// ─── /team slash command (shared by the classic CLI and the Flow TUI) ───
//
// Plain-string results so each surface applies its own chrome. Everything the
// command can do, the model-facing `team` tool can do too — this is the
// human's direct line to the same bus.

import type { TeamBus } from "./bus";
import { renderTeamStatus } from "./tool";

const USAGE = [
  "Usage:",
  "  /team                     peers, claims, and unread mail in this repository",
  "  /team send <id|all> <msg> message one instance (id from /team) or everyone",
  "  /team claim <path...>     lease paths you're about to change (dirs end with /)",
  "  /team release             drop this session's claims",
  "  /team intent <text>       set the one-line status peers see",
];

export function runTeamCommand(bus: TeamBus | null, arg: string): string[] {
  if (!bus || !bus.healthy) {
    return [
      "Team layer is off — this session is not on the shared bus.",
      "Enable it with [team] enabled = true in config.toml (or unset GEAR_TEAM), then restart.",
    ];
  }
  const parts = arg.trim().split(/\s+/).filter(Boolean);
  const sub = (parts[0] ?? "").toLowerCase();
  switch (sub) {
    case "":
    case "status":
      return renderTeamStatus(bus).split("\n");

    case "send": {
      const target = parts[1];
      const body = parts.slice(2).join(" ").trim();
      if (!target || !body) return ["Usage: /team send <id|all> <message>"];
      const to = target.toLowerCase() === "all" ? undefined : target;
      const res = bus.send(body, to);
      if (!res.ok) return [`Could not send: ${res.error ?? "unknown error"}`];
      return [`Message queued for ${to ?? "all peers"} — it arrives at their next turn boundary.`];
    }

    case "claim": {
      const paths = parts.slice(1);
      if (paths.length === 0) return ["Usage: /team claim <path...>   (end directories with /)"];
      const res = bus.claim(paths, { reason: "claimed via /team" });
      if (!res.ok) {
        const c = res.conflict;
        const who = c.peer
          ? `${c.peer.id}${c.peer.intent ? ` (${c.peer.intent})` : ""}`
          : c.claim.instanceId;
        return [`Conflict: ${c.claim.paths.join(", ")} is already claimed by ${who}.`];
      }
      if (!res.id) return ["Nothing to lease — those paths are outside this workspace."];
      return [`Claimed ${paths.join(", ")} (release with /team release).`];
    }

    case "release": {
      const n = bus.releaseClaim();
      return [n === 0 ? "No claims to release." : `Released ${n} claim${n === 1 ? "" : "s"}.`];
    }

    case "intent": {
      const text = parts.slice(1).join(" ").trim();
      if (!text) return ["Usage: /team intent <text>"];
      bus.setIntent(text);
      return ["Intent updated — peers now see it."];
    }

    default:
      return USAGE;
  }
}
