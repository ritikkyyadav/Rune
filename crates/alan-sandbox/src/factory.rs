use tracing::info;

use crate::noop::NoopSandbox;
use crate::{Sandbox, SandboxConfig};

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
