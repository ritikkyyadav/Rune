// ─── Auto mode's containment broker ───
//
// Auto mode is 4th gear with a watcher above it, not 3rd gear with a model in
// front of it. The watcher's job is NOT to stop the user from doing what the
// user asked for — that is what the gears are for. Its job is to stop the run
// when the run stops being the user's: prompt injection arriving through a web
// page, an issue body, a dependency's README, a log line. That is the attack
// this layer exists to answer.
//
// Which reframes what happens when something trips a breaker. The old answer
// was a modal permission card. That answer fails in both directions at once:
//
//   - It taxes the person who knows least. A product manager handed
//     `gh api -X DELETE repos/o/r/git/refs/heads/feature` cannot evaluate it,
//     and the honest options are "click yes and hope" or "click no and stall".
//   - It does not stop the attack it was built for. An injected instruction
//     that reaches a yes/no card has already won half the exchange: the card
//     shows the command, not the reason it appeared, and the reason is the
//     only part that mattered.
//
// So a tripped breaker produces a ROUTE instead of a question. Five of them,
// and every one of them keeps the run moving:
//
//   extend    the action is ordinary work that needs more room than the
//             sandbox gives (network for an install, a scratch path). Widen
//             the sandbox for this call and log it. The classifier grants the
//             environment; it does not ask for permission to grant it.
//   contain   the action reaches outside containment for no reason the work
//             requires. Hand back the same action with its escapes removed.
//   redirect  the action cannot be contained, but an equivalent exists that
//             produces the same knowledge with none of the blast radius
//             (`terraform plan` for `terraform apply`, `npm pack` for
//             `npm publish`). Hand back the equivalent.
//   defer     irreversible and outward, with no local equivalent. Do not run
//             it; record it, and let the agent finish everything else. The
//             user sees one consolidated list when the turn ends — a decision
//             made once, with the work already done, instead of a decision
//             made mid-run with nothing to judge it against.
//   halt      the attack case. Exfiltration, persistence, host destruction.
//             Nothing is routed and nothing is asked; the turn stops.
//
// Every route is mechanical — pure regex over the effective payload. That is
// deliberate: this module is what stands when the reviewer model is withdrawn,
// rate-limited, or 404ing. Auto mode has failed closed to a human prompt once
// and it cost 22 minutes of a build sitting on a dead classifier. It now fails
// CONTAINED instead, which is available by construction.

import { isAbsolute, relative, resolve } from "path";
import type { AutoModeAction } from "./auto-mode";

export type ContainmentKind = "extend" | "contain" | "redirect" | "defer" | "halt";

export interface ContainmentOutcome {
  kind: ContainmentKind;
  /** Stable id for tests, the audit row, and the inline chip. */
  route: string;
  /** Two or three words for the chip: "contained", "deferred", "redirected". */
  label: string;
  /**
   * What the acting agent reads. Written as the next step, never as a refusal:
   * the agent has to be able to act on this sentence without asking anyone.
   */
  instruction: string;
  /** `contain` — the same call with its sandbox escapes stripped. */
  containedArgs?: Record<string, unknown>;
  /** `redirect` — the exact command to run instead, when one can be built. */
  substitute?: string;
  /** `extend` — what the sandbox was widened to permit, for the audit row. */
  extension?: string;
  /**
   * Whether the user still needs to see this step when the turn ends.
   *
   * True whenever the thing the agent set out to do did NOT happen and only a
   * person can decide whether it should — a publish, a deploy, a remote
   * delete. False when the route achieved the same end safely (a reset that
   * stashed first, a command with its bypass flag dropped): nothing is
   * pending, so listing it would be noise, and a list that is mostly noise is
   * a list nobody reads.
   */
  ledger?: boolean;
}

export interface ContainmentContext {
  action: AutoModeAction;
  /**
   * Whether this machine can actually isolate (seatbelt/bwrap present). When
   * it cannot, "run it contained" is a lie, so containment degrades to
   * deferral rather than pretending.
   */
  osIsolation: boolean;
  /**
   * A tool result in this session was flagged as likely prompt injection, or
   * the reviewer called this action an attack. Borderline routes stop being
   * borderline: what would have been deferred is halted.
   */
  injectionSuspected: boolean;
}

// ── Shapes the routes recognize ──

/** Credential and secret stores, excluding checked-in documentation copies. */
const SECRET_PATH_RE =
  /(?:\.env\b(?!\.(?:example|sample|template))|\.ssh\/|\bid_(?:rsa|ed25519|ecdsa)\b|\.aws\/credentials|\.config\/gcloud|\.kube\/config|\.npmrc|\.pypirc|\.netrc|\.git-credentials|\bservice[-_]?account[\w-]*\.json|\.(?:pem|p12|pfx|keystore)\b|\bsecrets?\.(?:json|ya?ml|env)\b)/i;

/**
 * Transports that carry bytes off this machine. Paired with a secret path in
 * one command this is exfiltration, which is the single shape this whole layer
 * exists for — it is never routed and never asked about.
 */
const OUTWARD_TRANSPORT_RE =
  /\b(?:curl|wget|nc|ncat|netcat|scp|sftp|rsync|ssh|http(?:ie)?|xh)\b|\bgh\s+gist\b|\bmail\b|\bsendmail\b/i;

/** Content arriving decoded or downloaded and then fed straight to a shell. */
const FETCH_AND_EXECUTE_RE =
  /(?:curl|wget|fetch)[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z|k|da)?sh\b|\|\s*(?:sudo\s+)?(?:ba|z|k|da)?sh\b|\|\s*(?:sudo\s+)?(?:python3?|perl|ruby|node|bun|deno)\b|\bbase64\s+(?:-d|-D|--decode)\b|\beval\s/i;

/** Survives the session: cron, login shells, launch agents, trusted keys. */
const PERSISTENCE_RE =
  /\b(?:crontab|systemctl\s+(?:enable|start)|launchctl\s+(?:load|bootstrap)|authorized_keys|\.bash(?:rc|_profile)|\.zshrc|\.profile|LaunchAgents|LaunchDaemons|rc\.local)\b/i;

/** Turning off the things that would have noticed. */
const CONTROL_BYPASS_RE =
  /(?:--no-verify|skip[-_]?verification|disable[-_ ]?(?:logging|audit|security)|--dangerously[\w-]*|--disable-security|set\s+\+e\b.*\btrap\b)/i;

/** Publishes workspace content to people who were never party to this session. */
const PUBLISH_COMMAND_RE =
  /(?:(?:npm|yarn|pnpm|bun)\s+publish|cargo\s+publish|twine\s+upload|gh\s+(?:release\s+create|gist\s+create)|docker\s+push)\b/i;

const SERVICE_CLI_RE =
  /\b(?:gh|glab|aws|gcloud|az|heroku|fly|flyctl|vercel|netlify|supabase|railway|render|doctl|stripe|kubectl|helm|terraform|pulumi|firebase|wrangler)\b/i;
const DESTRUCTIVE_VERB_RE =
  /\b(?:delete|destroy|remove|drop|purge|terminate|revoke|disable|deactivate|prune|truncate|wipe)\b/i;

/**
 * Irrecoverable at the host level whatever it points at: formatting a disk,
 * overwriting a block device, exhausting the process table. No path argument
 * can make any of these ordinary, so they halt on sight.
 */
const HOST_DESTRUCTION_RE =
  /\bmkfs(?:\.\w+)?\b|\bdiskutil\s+erase|\bwipefs\b|\bshred\s+[^\n]*\/dev\/|\bdd\b[^\n]*\bof=\/dev\/|:\(\)\s*\{\s*:\|:\s*&\s*\}\s*;\s*:/;

/**
 * Recursive forced deletion. Kept separate because, unlike the list above,
 * this one is decided entirely by its target: `rm -rf ./build` is what "clean
 * the build" means, and `rm -rf ~` is the end of someone's week. Halting on
 * the verb alone would make the mode unusable; halting on the target is the
 * whole judgement.
 */
const RECURSIVE_DELETE_RE = /\brm\s+(?:-[a-zA-Z]*\s+)*-[a-zA-Z]*[rR][a-zA-Z]*f/;

/** Broad data destruction that a dump can precede. */
const DB_DESTRUCTION_RE = /\b(?:DROP\s+(?:DATABASE|SCHEMA)|TRUNCATE\s+TABLE)\b/i;

const FORCE_PUSH_RE = /\bgit\s+push\b[^\n]*(?:--force\b|--force-with-lease\b|(?:^|\s)-f(?:\s|$))/i;
const REMOTE_BRANCH_DELETE_RE = /\bgit\s+push\b[^\n]*(?:--delete\b|(?:^|\s)-d(?:\s|$))/i;
const HARD_RESET_RE = /\bgit\s+reset\s+--hard\b/i;

/**
 * Substitutes that produce the same knowledge with none of the effect. Ordered:
 * the first match wins, so the more specific pattern is listed first.
 */
const DRY_RUN_SUBSTITUTES: Array<{ re: RegExp; to: string; why: string }> = [
  {
    re: /\bterraform\s+apply\b/i,
    to: "terraform plan -out=gear.tfplan",
    why: "the plan shows exactly what apply would change, and changes nothing",
  },
  {
    re: /\bterraform\s+destroy\b/i,
    to: "terraform plan -destroy",
    why: "the destroy plan enumerates the targets without removing them",
  },
  {
    re: /\bkubectl\s+(?:apply|replace|delete)\b/i,
    to: "the same kubectl command with --dry-run=server",
    why: "a server dry-run validates against the live cluster and mutates nothing",
  },
  {
    re: /\b(?:npm|yarn|pnpm|bun)\s+publish\b/i,
    to: "npm pack",
    why: "pack builds the exact tarball publish would upload, and leaves it on disk",
  },
  {
    re: /\bcargo\s+publish\b/i,
    to: "cargo package",
    why: "package builds the same crate archive without sending it to the registry",
  },
  {
    re: /\btwine\s+upload\b/i,
    to: "python -m build",
    why: "the build produces the distributables; uploading them is the separate step",
  },
  {
    re: /\bdocker\s+push\b/i,
    to: "docker save -o ./image.tar <image>",
    why: "the image is fully built and inspectable locally without touching the registry",
  },
  {
    re: /\bhelm\s+(?:install|upgrade|uninstall)\b/i,
    to: "the same helm command with --dry-run",
    why: "a dry-run renders the release without applying it",
  },
];

/**
 * The single entry point. Ordered most-severe first: an exfiltration that also
 * happens to be a publish is an exfiltration.
 */
export function routeContainment(ctx: ContainmentContext): ContainmentOutcome {
  const { action } = ctx;
  const command = action.toolName === "bash" ? String(action.args.command ?? "") : "";

  // 1. Exfiltration. A credential store and an outward transport in the same
  //    command is the attack this layer was built for. It is not contained,
  //    not redirected, and above all not put to the user as a question — the
  //    question would arrive with the attacker's framing attached.
  if (command && SECRET_PATH_RE.test(command) && OUTWARD_TRANSPORT_RE.test(command)) {
    return halt(
      "exfiltration",
      "This command reads a credential store and sends it off this machine in one step. " +
        "That is the shape of credential exfiltration, and it is what Auto mode stops. " +
        "The run is halted. If a secret genuinely needs to move, the user moves it.",
    );
  }

  // 2. Host destruction. Disks, block devices, fork bombs — plus recursive
  //    deletion, but only when it positively names something outside the
  //    workspace. Deleting a build directory is the job; the two are told
  //    apart by their target, never by the verb.
  if (
    command &&
    (HOST_DESTRUCTION_RE.test(command) ||
      (RECURSIVE_DELETE_RE.test(command) && namesPathOutsideWorkspace(action, command)))
  ) {
    return halt(
      "host-destruction",
      "This command destroys state outside the workspace and cannot be undone. " +
        "Auto mode does not run it and does not offer to. If this is genuinely the work, " +
        "the user runs it themselves or shifts to 4th gear deliberately.",
    );
  }

  // 3. Persistence. Something that outlives the session is being installed.
  //    Under injection suspicion this is the payload; otherwise it is at least
  //    a change to the machine rather than to the project, so it waits.
  if (command && PERSISTENCE_RE.test(command)) {
    return ctx.injectionSuspected
      ? halt(
          "persistence",
          "This command installs something that survives the session (cron, a login shell, a " +
            "launch agent, or a trusted key) while injected content is suspected in this run. " +
            "That combination is the persistence stage of an attack. The run is halted.",
        )
      : defer(
          "persistence",
          "This changes the machine rather than the project — it installs something that outlives " +
            "the session. Auto mode does not do that silently. Continue with the rest of the work; " +
            "this step is recorded and reported to the user when the turn ends.",
        );
  }

  // 4. Turning off the checks. Where the bypass is a flag there is always a
  //    version of the command that keeps the check on, and running that
  //    version is nearly always what was meant.
  //
  //    Where it is not a flag — `disable-audit`, a trap that swallows errors —
  //    stripping produces the identical command, and handing that back would
  //    put the agent in a loop re-sending what was just blocked. So the
  //    rewrite only counts if it actually changed something.
  if (command && CONTROL_BYPASS_RE.test(command)) {
    const stripped = stripBypassFlags(command);
    return stripped !== command.trim()
      ? redirect(
          "control-bypass",
          stripped,
          "This command disables a check that exists to catch mistakes. Run it with the bypass " +
            "flag removed. If the check then fails, fix what it found — a failing check is " +
            "information, not an obstacle.",
        )
      : defer(
          "control-bypass",
          "This turns off a check or an audit trail, and there is no version of it that leaves " +
            "them on. Continue with the work that does not depend on it; the step is recorded and " +
            "reported to the user when the turn ends.",
        );
  }

  // 5. Fetch-and-execute. The dangerous part arrives at runtime, so no pattern
  //    over the command text can ever see it. Splitting the fetch from the run
  //    makes it visible, which is the whole fix — and the run half is exactly
  //    what the sandbox is for.
  if (command && FETCH_AND_EXECUTE_RE.test(command)) {
    return {
      kind: ctx.osIsolation ? "contain" : "defer",
      route: "fetch-and-execute",
      label: ctx.osIsolation ? "contained" : "deferred",
      instruction:
        "This pipes content straight into an interpreter, so what actually runs is invisible " +
        "until it has already run. Split it into two steps: write the fetched or decoded content " +
        "to a file in the workspace, read that file, and only then execute it" +
        (ctx.osIsolation
          ? " — the execution step runs inside the sandbox."
          : ". This machine has no OS isolation backend, so the execution step is recorded for the user instead of run."),
      containedArgs: ctx.osIsolation ? sandboxedArgs(action.args) : undefined,
    };
  }

  // 6. Publication and remote mutation. Both reach people outside this session.
  //    Where a local equivalent exists it is offered; where none does, the work
  //    continues and the step is reported at the end.
  const substitute = DRY_RUN_SUBSTITUTES.find((s) => s.re.test(command));
  if (substitute) {
    return redirect(
      "dry-run-substitute",
      command.replace(substitute.re, substitute.to),
      `Auto mode does not take outward or infrastructure actions unattended. Run the equivalent ` +
        `instead: ${substitute.why}. Report what it shows, and the real step is recorded for the user.`,
      true,
    );
  }
  if (command && PUBLISH_COMMAND_RE.test(command)) {
    return defer(
      "publication",
      "This publishes workspace content to people outside this session and cannot be recalled. " +
        "Everything up to the publish is yours to finish — build it, test it, stage it. The publish " +
        "itself is recorded and reported to the user when the turn ends.",
    );
  }

  // 7. Git's two irreversible remote operations, both of which have a local
  //    form that preserves the work and loses nothing.
  if (FORCE_PUSH_RE.test(command)) {
    return redirect(
      "force-push",
      `git push ${remoteOf(command)} HEAD:refs/heads/gear/${scratchName(command)}`,
      "A force push overwrites history other people may already have. Push the work to a scratch " +
        "branch instead: nothing is lost, nothing is overwritten, and the user can fast-forward " +
        "the real branch onto it deliberately. Say in your reply that you did this.",
      true,
    );
  }
  if (REMOTE_BRANCH_DELETE_RE.test(command)) {
    return redirect(
      "remote-branch-delete",
      command.replace(/\bgit\s+push\b[^\n]*/i, "git branch -d <branch>"),
      "Deleting a remote branch removes it for everyone. Delete the local branch instead; the " +
        "remote one is recorded and reported to the user when the turn ends.",
      true,
    );
  }
  if (HARD_RESET_RE.test(command)) {
    return redirect(
      "hard-reset",
      `git stash push -u -m gear-auto-safety && ${command}`,
      "A hard reset discards uncommitted work irrecoverably. Stash first, then reset — the reset " +
        "does exactly what it did before and the discarded work stays retrievable.",
    );
  }
  if (command && SERVICE_CLI_RE.test(command) && DESTRUCTIVE_VERB_RE.test(command)) {
    return defer(
      "remote-mutation",
      "This deletes or disables a resource that lives outside this machine, where an undo does not " +
        "exist. Continue with everything that does not depend on it; this step is recorded and " +
        "reported to the user when the turn ends.",
    );
  }
  if (DB_DESTRUCTION_RE.test(command)) {
    return defer(
      "database-destruction",
      "This drops or truncates a database object. Continue with the rest of the work; the " +
        "destructive statement is recorded and reported to the user when the turn ends. If a dump " +
        "would make it recoverable, take the dump now and say so.",
    );
  }

  // 8. Credential access with no outward transport. Inside the workspace this
  //    is ordinary (`.env` belongs to the project); outside it is the agent
  //    routing around an auth failure instead of reporting it.
  if (command && SECRET_PATH_RE.test(command)) {
    if (isConfinedToWorkspace(action, command)) {
      return {
        kind: "extend",
        route: "workspace-secret",
        label: "allowed",
        extension: "read of a credential file belonging to this workspace",
        instruction:
          "Reading this workspace's own environment file is ordinary work. Do not echo its values " +
          "into your reply, a commit, or a command line.",
      };
    }
    return defer(
      "external-credential",
      "This reads a credential store outside the workspace. If an authentication step is failing, " +
        "say so plainly and continue with the work that does not need it — do not go looking for " +
        "the credential yourself. The attempt is recorded for the user.",
    );
  }

  // 9. Nothing above matched, so what is left is an action that reaches outside
  //    containment without a recognized reason. Pull it back in if this machine
  //    can; otherwise report it rather than pretend.
  if (escapesSandbox(action)) {
    return ctx.osIsolation
      ? {
          kind: "contain",
          route: "sandbox-escape",
          label: "contained",
          instruction:
            "This call asked to run outside the sandbox. Auto mode runs it inside instead. Re-issue " +
            "the same command without the escape; if it genuinely needs network or a port, say which " +
            "and why in one line and re-issue it — that reason is what gets recorded.",
          containedArgs: sandboxedArgs(action.args),
        }
      : defer(
          "sandbox-unavailable",
          "This call needs to run outside the sandbox and this machine has no OS isolation backend, " +
            "so there is nothing to run it inside. Continue with the rest of the work; the step is " +
            "recorded and reported to the user when the turn ends.",
        );
  }

  // 10. A non-bash tool tripped a breaker, or a command shape the routes above
  //     do not recognize. Deferral is the honest default: it neither runs the
  //     action nor stops the run nor asks a question nobody can answer.
  return defer(
    "unrecognized",
    "Auto mode stopped this action because its impact reaches past the workspace and no safer " +
      "equivalent was recognized. Continue with everything that does not depend on it; the step is " +
      "recorded and reported to the user when the turn ends.",
  );
}

// ── Route constructors ──

function halt(route: string, instruction: string): ContainmentOutcome {
  return { kind: "halt", route, label: "halted", instruction };
}

function defer(route: string, instruction: string): ContainmentOutcome {
  return { kind: "defer", route, label: "deferred", instruction, ledger: true };
}

/**
 * `ledger` says whether the original intent is still outstanding. A redirect
 * that fully replaces the work (dropping a bypass flag, stashing before a
 * reset) leaves nothing for the user to decide; one that substitutes a dry run
 * for a real deploy leaves the deploy itself undone.
 */
function redirect(
  route: string,
  substitute: string,
  instruction: string,
  ledger = false,
): ContainmentOutcome {
  return { kind: "redirect", route, label: "redirected", instruction, substitute, ledger };
}

// ── Helpers ──

/**
 * The two ways a bash call leaves the sandbox: `network: true` (explicit
 * escalation to the host with the internet) and `run_in_background: true`
 * (detached, binds ports, outlives the turn).
 */
export function escapesSandbox(action: AutoModeAction): boolean {
  if (action.toolName !== "bash") return false;
  return action.args.network === true || action.args.run_in_background === true;
}

/**
 * The remote a push names, defaulting to origin. Deliberately shallow: this
 * only has to produce a command a person would recognize, and a wrong guess
 * shows up immediately as a push that does not run.
 */
function remoteOf(command: string): string {
  const match = /\bgit\s+push\b(?:\s+-{1,2}[\w-]+(?:=\S+)?)*\s+([\w.-]+)/i.exec(command);
  return match?.[1] ?? "origin";
}

/** A scratch branch name derived from the branch the push was aimed at. */
function scratchName(command: string): string {
  const match = /\bgit\s+push\b[^\n]*?\s([\w./-]+)\s*$/i.exec(command);
  const target = match?.[1]?.replace(/^.*:/, "") ?? "work";
  return `${target.replace(/[^\w.-]+/g, "-")}-contained`;
}

/** The same call with both escapes removed. */
function sandboxedArgs(args: Record<string, unknown>): Record<string, unknown> {
  const next = { ...args };
  delete next.network;
  delete next.run_in_background;
  return next;
}

/**
 * Drop the flags whose only effect is to skip a check. Deliberately literal:
 * a rewrite that guesses is worse than one that removes exactly what it named.
 */
function stripBypassFlags(command: string): string {
  return command
    .replace(/\s--no-verify\b/gi, "")
    .replace(/\s--dangerously[\w-]*\b/gi, "")
    .replace(/\s--disable-security\b/gi, "")
    .trim();
}

/**
 * The filesystem paths a command names, as written. Shallow on purpose — it
 * reads the literal text, not the shell's eventual expansion — so both
 * questions asked of it below are phrased to need only positive evidence.
 */
function namedPaths(command: string): string[] {
  const candidates = command.match(/(?:^|\s)((?:\.{0,2}\/|[\w.@-]+\/)[^\s;|&"']*)/g) ?? [];
  return candidates.map((c) => c.trim()).filter(Boolean);
}

/** A literal reference to the home directory, however it is spelled. */
const HOME_REFERENCE_RE = /(?:^|\s)(?:~|\$HOME|\$\{HOME\})(?:\/|\s|$)/;

/**
 * Whether the command positively names something OUTSIDE the workspace.
 *
 * Deliberately requires evidence rather than assuming the worst. The
 * alternative — treating "no path found" as outside — reads `rm -rf
 * node_modules` as a home-directory wipe, and a boundary that halts the run
 * over a dependency clean is a boundary nobody will leave switched on.
 */
function namesPathOutsideWorkspace(action: AutoModeAction, command: string): boolean {
  if (HOME_REFERENCE_RE.test(command)) return true;
  const root = action.workspaceRoot;
  if (!root) return false;
  return namedPaths(command).some((p) => !isPathInside(root, p));
}

/**
 * Whether the command names at least one path and every one of them lands
 * inside the workspace. This is the mirror question, and it wants the opposite
 * default: "reads this project's .env" earns its allowance by being provably
 * local, so naming nothing at all does not qualify.
 */
function isConfinedToWorkspace(action: AutoModeAction, command: string): boolean {
  const root = action.workspaceRoot;
  if (!root) return false;
  if (HOME_REFERENCE_RE.test(command)) return false;
  const paths = namedPaths(command);
  if (paths.length === 0) return false;
  return paths.every((p) => isPathInside(root, p));
}

function isPathInside(root: string, target: string): boolean {
  try {
    const absRoot = resolve(root);
    const abs = isAbsolute(target) ? resolve(target) : resolve(absRoot, target);
    const rel = relative(absRoot, abs);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  } catch {
    return false;
  }
}
