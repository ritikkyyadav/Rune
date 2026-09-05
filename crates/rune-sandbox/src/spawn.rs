//! Launching a LONG-LIVED process under the OS sandbox.
//!
//! The [`Sandbox`](crate::Sandbox) trait runs a shell command to completion and
//! captures its output. A plugin tool server is the other shape: it starts,
//! advertises its schemas, and then answers call frames on stdio for the life
//! of the session. It cannot be driven through `execute()`, and re-implementing
//! the Seatbelt/bwrap profile on the TypeScript side to work around that is how
//! two sandbox policies drift apart.
//!
//! So this module produces a **plan** instead of running anything: the argv
//! that wraps a program in this machine's sandbox, plus an honest report of
//! what that wrapper actually enforces. The caller (`rune-tools sandbox-plan`,
//! read by `packages/tool-registry/src/tools/plugin-tools.ts`) spawns it and
//! owns the pipes.
//!
//! ## The capability ladder
//!
//! | capability         | reads                              | writes             | network                    |
//! | ------------------ | ---------------------------------- | ------------------ | -------------------------- |
//! | `none`             | system; the plugin's own directory | scratch only       | denied                     |
//! | `workspace-read`   | system + workspace                 | scratch only       | denied                     |
//! | `workspace-write`  | system + workspace                 | scratch, workspace | denied                     |
//! | `network`          | system; the plugin's own directory | scratch only       | declared endpoints only    |
//!
//! Reads of the system are broad in every row for the same reason the bash
//! sandbox makes them broad: an allowlist-only read policy makes `dyld` abort
//! before `main`, so nothing runs at all. Credential stores are carved out by
//! explicit deny in every row.
//!
//! ## What "declared endpoints" means, exactly
//!
//! Seatbelt's `remote ip` filter accepts a **port** and either `*` or
//! `localhost` as the host — it rejects a literal address outright ("host must
//! be \* or localhost"). So on macOS a declared `api.example.com:443` is
//! enforced as "outbound to port 443, denied everywhere else", and a declared
//! `127.0.0.1:8787` is enforced as "loopback port 8787 only". That is real,
//! kernel-enforced, and narrower than the host list reads; it is not per-host,
//! and this module reports `host_enforcement: "port"` rather than letting a
//! caller claim otherwise. On Linux, bubblewrap's network isolation is
//! all-or-nothing (`--unshare-net`), reported as such.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::{credential_deny_paths, escape_sbpl};

/// What a plugin tool declared it needs. One per tool server.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ToolCapability {
    /// No workspace access and no network: a pure function over its arguments.
    None,
    /// May read the workspace.
    WorkspaceRead,
    /// May read and write the workspace.
    WorkspaceWrite,
    /// May reach the declared endpoints. No workspace access.
    Network,
}

impl ToolCapability {
    fn reads_workspace(self) -> bool {
        matches!(self, Self::WorkspaceRead | Self::WorkspaceWrite)
    }
    fn writes_workspace(self) -> bool {
        matches!(self, Self::WorkspaceWrite)
    }
    fn wants_network(self) -> bool {
        matches!(self, Self::Network)
    }
}

/// One program to launch, and the containment it asked for.
#[derive(Debug, Clone, Deserialize)]
pub struct SpawnRequest {
    pub capability: ToolCapability,
    /// `host:port` entries from the manifest. Only meaningful for `network`.
    #[serde(default)]
    pub hosts: Vec<String>,
    /// The plugin's own directory — always readable, or the program could not
    /// read its own source.
    pub plugin_root: PathBuf,
    /// A private scratch directory: the only writable place a non-write
    /// capability gets, and where `TMPDIR` should point. Real runtimes
    /// (Python, Node, compilers) need somewhere to write or they die on
    /// startup, and "somewhere" must not be the user's workspace.
    pub scratch_dir: PathBuf,
    pub program: String,
    #[serde(default)]
    pub args: Vec<String>,
}

/// How to launch it, and what the launch actually enforces.
#[derive(Debug, Clone, Serialize)]
pub struct SpawnPlan {
    /// Full argv: the sandbox wrapper (if any) followed by the program.
    pub argv: Vec<String>,
    /// "seatbelt", "bwrap", or "none".
    pub mechanism: &'static str,
    /// True only when an OS-level isolation backend is actually wrapping it.
    pub os_isolation: bool,
    /// "port" (macOS), "all-or-nothing" (Linux), "none" (unsandboxed).
    pub host_enforcement: &'static str,
    /// Anything the caller must say out loud — e.g. an unparseable host entry.
    pub notes: Vec<String>,
}

/// Best-effort real path. The profile matches on RESOLVED paths: on macOS
/// `/tmp` is a symlink to `/private/tmp`, so a rule written against the
/// unresolved path silently matches nothing — a deny that denies nothing is
/// worse than no deny at all.
fn real(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// A declared `host:port`, split. A bare host means "any port on that host",
/// which Seatbelt cannot express as anything narrower than `*:*`.
struct Endpoint {
    loopback: bool,
    port: Option<u16>,
}

fn parse_endpoint(raw: &str) -> Option<Endpoint> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    // Strip a scheme if someone wrote one, and any path after the authority.
    let without_scheme = trimmed.split_once("://").map_or(trimmed, |(_, rest)| rest);
    let authority = without_scheme.split('/').next().unwrap_or(without_scheme);
    let (host, port) = match authority.rsplit_once(':') {
        Some((h, p)) if !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()) => {
            (h, p.parse::<u16>().ok())
        }
        _ => (authority, None),
    };
    let host = host.trim_matches(|c| c == '[' || c == ']');
    Some(Endpoint {
        loopback: matches!(host, "localhost" | "127.0.0.1" | "::1"),
        port,
    })
}

#[cfg(target_os = "macos")]
fn seatbelt_profile(workspace: &Path, req: &SpawnRequest, notes: &mut Vec<String>) -> String {
    let workspace = real(workspace);
    let plugin_root = real(&req.plugin_root);
    let scratch = real(&req.scratch_dir);

    let ws = escape_sbpl(&workspace.display().to_string());
    let plug = escape_sbpl(&plugin_root.display().to_string());
    let scratch_s = escape_sbpl(&scratch.display().to_string());

    let deny_reads = credential_deny_paths()
        .iter()
        .map(|p| {
            format!(
                "    (subpath \"{}\")",
                escape_sbpl(&p.display().to_string())
            )
        })
        .collect::<Vec<_>>()
        .join("\n");

    // Reads. Broad, minus the credential stores, minus the workspace when the
    // capability does not include reading it — with the plugin's own directory
    // carved back out so the program can read itself. `require-all` +
    // `require-not` is one rule with one meaning; two rules that contradict
    // each other would depend on SBPL evaluation order.
    let workspace_read_rule = if req.capability.reads_workspace() {
        String::new()
    } else if plugin_root.starts_with(&workspace) {
        format!(
            "(deny file-read*\n  (require-all\n    (subpath \"{ws}\")\n    (require-not (subpath \"{plug}\"))))\n"
        )
    } else {
        format!("(deny file-read* (subpath \"{ws}\"))\n")
    };

    // Writes. The scratch directory always; the workspace only when declared.
    let mut writable = vec![format!("    (subpath \"{scratch_s}\")")];
    if req.capability.writes_workspace() {
        writable.push(format!("    (subpath \"{ws}\")"));
    }
    let writable = writable.join("\n");

    // Network.
    let mut network = String::from("(deny network*)\n");
    if req.capability.wants_network() {
        if req.hosts.is_empty() {
            notes.push(
                "capability is `network` but the manifest declares no hosts — everything outbound is denied"
                    .to_string(),
            );
        }
        for raw in &req.hosts {
            let Some(endpoint) = parse_endpoint(raw) else {
                notes.push(format!("could not parse declared host \"{raw}\" — ignored"));
                continue;
            };
            let host = if endpoint.loopback { "localhost" } else { "*" };
            match endpoint.port {
                Some(port) => {
                    network.push_str(&format!(
                        "(allow network-outbound (remote ip \"{host}:{port}\"))\n"
                    ));
                    if !endpoint.loopback {
                        // Names have to resolve before the connect can happen.
                        network.push_str("(allow network-outbound (remote ip \"*:53\"))\n");
                    }
                }
                None => {
                    notes.push(format!(
                        "declared host \"{raw}\" has no port — Seatbelt filters by port, so this allows every port",
                    ));
                    network.push_str(&format!(
                        "(allow network-outbound (remote ip \"{host}:*\"))\n"
                    ));
                }
            }
        }
    }

    format!(
        r#"(version 1)
(deny default)
(allow process-exec*)
(allow process-fork)
(allow sysctl-read)
(allow mach-lookup)
(allow signal)
(allow process-info*)

;; Broad reads so dyld and real runtimes start at all.
(allow file-read*)

;; ...but never the credential stores.
(deny file-read*
{deny_reads}
)

{workspace_read_rule}
;; Writes: a private scratch directory, plus the workspace when declared.
(allow file-read* file-write*
{writable}
)
(allow file-write* (subpath "/dev"))

{network}"#
    )
}

#[cfg(target_os = "linux")]
fn bwrap_args(workspace: &Path, req: &SpawnRequest, notes: &mut Vec<String>) -> Vec<String> {
    let workspace = real(workspace);
    let plugin_root = real(&req.plugin_root);
    let scratch = real(&req.scratch_dir);
    let mut args: Vec<String> = Vec::new();

    for dir in &["/usr", "/lib", "/lib64", "/bin", "/sbin", "/etc"] {
        if Path::new(dir).exists() {
            args.extend_from_slice(&["--ro-bind".to_string(), dir.to_string(), dir.to_string()]);
        }
    }

    let ws = workspace.display().to_string();
    if req.capability.writes_workspace() {
        args.extend_from_slice(&["--bind".to_string(), ws.clone(), ws.clone()]);
    } else if req.capability.reads_workspace() {
        args.extend_from_slice(&["--ro-bind".to_string(), ws.clone(), ws.clone()]);
    } else {
        // No workspace at all — but the program still has to read itself.
        let plug = plugin_root.display().to_string();
        args.extend_from_slice(&["--ro-bind".to_string(), plug.clone(), plug]);
    }

    let scratch_s = scratch.display().to_string();
    args.extend_from_slice(&["--bind".to_string(), scratch_s.clone(), scratch_s.clone()]);
    args.extend_from_slice(&["--setenv".to_string(), "TMPDIR".to_string(), scratch_s]);
    args.extend_from_slice(&[
        "--proc".to_string(),
        "/proc".to_string(),
        "--dev".to_string(),
        "/dev".to_string(),
    ]);

    if req.capability.wants_network() {
        notes.push(
            "bubblewrap's network isolation is all-or-nothing: the declared hosts are disclosure on Linux, not a filter"
                .to_string(),
        );
    } else {
        args.push("--unshare-net".to_string());
    }
    args.push("--die-with-parent".to_string());

    let cwd = if req.capability.reads_workspace() {
        workspace.display().to_string()
    } else {
        plugin_root.display().to_string()
    };
    args.extend_from_slice(&["--chdir".to_string(), cwd]);
    args.push("--".to_string());
    args.push(req.program.clone());
    args.extend(req.args.iter().cloned());
    args
}

/// Build the launch plan for this machine.
///
/// Never fails: a platform with no backend returns `os_isolation: false` and
/// the bare argv, and it is the CALLER's job to refuse that unless the user
/// opted in. Deciding here would hide the refusal from the person who has to
/// explain it.
pub fn plan_spawn(workspace_root: &Path, req: &SpawnRequest) -> SpawnPlan {
    let mut notes: Vec<String> = Vec::new();

    #[cfg(target_os = "macos")]
    {
        use crate::macos::MacOsSandbox;
        if MacOsSandbox::is_available() {
            let profile = seatbelt_profile(workspace_root, req, &mut notes);
            let mut argv = vec![
                "sandbox-exec".to_string(),
                "-p".to_string(),
                profile,
                req.program.clone(),
            ];
            argv.extend(req.args.iter().cloned());
            return SpawnPlan {
                argv,
                mechanism: "seatbelt",
                os_isolation: true,
                host_enforcement: "port",
                notes,
            };
        }
        notes.push("sandbox-exec is not available on this machine".to_string());
    }

    #[cfg(target_os = "linux")]
    {
        use crate::linux::LinuxSandbox;
        if LinuxSandbox::is_available() {
            let mut argv = vec!["bwrap".to_string()];
            argv.extend(bwrap_args(workspace_root, req, &mut notes));
            return SpawnPlan {
                argv,
                mechanism: "bwrap",
                os_isolation: true,
                host_enforcement: "all-or-nothing",
                notes,
            };
        }
        notes.push("bwrap is not available on this machine".to_string());
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = workspace_root;
        notes.push(format!(
            "no OS sandbox backend exists for {}",
            std::env::consts::OS
        ));
    }

    let mut argv = vec![req.program.clone()];
    argv.extend(req.args.iter().cloned());
    SpawnPlan {
        argv,
        mechanism: "none",
        os_isolation: false,
        host_enforcement: "none",
        notes,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(capability: ToolCapability) -> SpawnRequest {
        SpawnRequest {
            capability,
            hosts: vec![
                "127.0.0.1:8787".to_string(),
                "api.example.com:443".to_string(),
            ],
            plugin_root: PathBuf::from("/ws/.rune/plugins/demo"),
            scratch_dir: PathBuf::from("/tmp/scratch"),
            program: "python3".to_string(),
            args: vec!["tool.py".to_string()],
        }
    }

    #[test]
    fn endpoints_parse_host_and_port() {
        let local = parse_endpoint("127.0.0.1:8787").unwrap();
        assert!(local.loopback);
        assert_eq!(local.port, Some(8787));
        let remote = parse_endpoint("https://api.example.com:443/v1").unwrap();
        assert!(!remote.loopback);
        assert_eq!(remote.port, Some(443));
        let bare = parse_endpoint("api.example.com").unwrap();
        assert_eq!(bare.port, None);
        assert!(parse_endpoint("   ").is_none());
    }

    #[test]
    fn the_program_is_always_the_tail_of_the_argv() {
        let req = request(ToolCapability::None);
        let plan = plan_spawn(Path::new("/ws"), &req);
        assert_eq!(plan.argv.last().unwrap(), "tool.py");
        assert!(plan.argv.contains(&"python3".to_string()));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_profile_matches_the_declared_capability() {
        let mut notes = Vec::new();
        let read = seatbelt_profile(
            Path::new("/ws"),
            &request(ToolCapability::WorkspaceRead),
            &mut notes,
        );
        assert!(read.contains("(deny network*)"));
        assert!(!read.contains("network-outbound"));
        // A read capability may not write the workspace.
        assert!(!read.contains("(subpath \"/ws\")\n)"));

        let write = seatbelt_profile(
            Path::new("/ws"),
            &request(ToolCapability::WorkspaceWrite),
            &mut notes,
        );
        assert!(write.contains("/ws"));
        assert!(write.contains("(deny network*)"));

        let net = seatbelt_profile(
            Path::new("/ws"),
            &request(ToolCapability::Network),
            &mut notes,
        );
        assert!(net.contains("(allow network-outbound (remote ip \"localhost:8787\"))"));
        assert!(net.contains("(allow network-outbound (remote ip \"*:443\"))"));
        // A network tool does not get to read the workspace.
        assert!(net.contains("require-not"));

        let none = seatbelt_profile(Path::new("/ws"), &request(ToolCapability::None), &mut notes);
        assert!(none.contains("require-not"));
        assert!(!none.contains("network-outbound"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_host_without_a_port_is_reported_rather_than_silently_widened() {
        let mut notes = Vec::new();
        let mut req = request(ToolCapability::Network);
        req.hosts = vec!["api.example.com".to_string()];
        let profile = seatbelt_profile(Path::new("/ws"), &req, &mut notes);
        assert!(profile.contains("(remote ip \"*:*\")"));
        assert!(notes.iter().any(|n| n.contains("no port")));
    }
}
