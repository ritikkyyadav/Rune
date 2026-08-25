use serde::Serialize;
use tracing::info;

use crate::noop::NoopSandbox;
use crate::{Sandbox, SandboxConfig};

/// What `create_sandbox()` would actually select on this machine, reportable
/// without constructing (or running) anything. The TS side gates bash
/// auto-approval on `os_isolation` — "the user turned the sandbox on" and
/// "this machine can actually isolate" are different facts, and conflating
/// them is how commands run uncontained while everything claims otherwise.
#[derive(Debug, Clone, Serialize)]
pub struct SandboxProbe {
    /// Backend that would run: "seatbelt", "bwrap", or "none".
    pub mechanism: &'static str,
    /// True only when an OS-level isolation backend is available.
    pub os_isolation: bool,
    pub platform: &'static str,
}

/// Probe which sandbox backend is available without executing a command.
pub fn probe_capability() -> SandboxProbe {
    #[cfg(target_os = "macos")]
    {
        use crate::macos::MacOsSandbox;
        if MacOsSandbox::is_available() {
            SandboxProbe {
                mechanism: "seatbelt",
                os_isolation: true,
                platform: "macos",
            }
        } else {
            SandboxProbe {
                mechanism: "none",
                os_isolation: false,
                platform: "macos",
            }
        }
    }

    #[cfg(target_os = "linux")]
    {
        use crate::linux::LinuxSandbox;
        if LinuxSandbox::is_available() {
            SandboxProbe {
                mechanism: "bwrap",
                os_isolation: true,
                platform: "linux",
            }
        } else {
            SandboxProbe {
                mechanism: "none",
                os_isolation: false,
                platform: "linux",
            }
        }
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        SandboxProbe {
            mechanism: "none",
            os_isolation: false,
            platform: std::env::consts::OS,
        }
    }
}

/// Detect the current platform and return the best available sandbox.
///
/// On macOS: uses `sandbox-exec` (Seatbelt) if available, otherwise falls back
/// to the noop executor.
///
/// On Linux: uses `bwrap` (bubblewrap) if available, otherwise falls back to
/// the noop executor.
///
/// On all other platforms: uses the noop executor (PathGuard + audit only).
pub fn create_sandbox(config: SandboxConfig) -> Box<dyn Sandbox + Send + Sync> {
    #[cfg(target_os = "macos")]
    {
        use crate::macos::MacOsSandbox;
        if MacOsSandbox::is_available() {
            info!("using macOS seatbelt sandbox");
            return Box::new(MacOsSandbox::new(config));
        }
        info!("sandbox-exec not available, falling back to noop");
    }

    #[cfg(target_os = "linux")]
    {
        use crate::linux::LinuxSandbox;
        if LinuxSandbox::is_available() {
            info!("using Linux bubblewrap sandbox");
            return Box::new(LinuxSandbox::new(config));
        }
        info!("bwrap not available, falling back to noop");
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        info!("no native sandbox for this platform, using noop");
    }

    Box::new(NoopSandbox::new(config))
}
