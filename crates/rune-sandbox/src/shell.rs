//! Which shell a command string is run through.
//!
//! Everything above this crate hands down ONE string — `bun test`,
//! `cargo build && ./run.sh`, `printf smoke-ok` — and something has to decide
//! what interprets it. On macOS and Linux the answer has never been in doubt:
//! `/bin/sh -c`. On Windows there is no `/bin/sh`, and until P10.2 that was the
//! whole story: `Command::new("/bin/sh")` failed with "The system cannot find
//! the path specified. (os error 3)", so the `bash` tool — and therefore hooks,
//! the verifier, worker checks and the packaged smoke — simply did not work.
//!
//! The answer here is "a real shell if this machine has one, `cmd.exe` if not".
//! Git for Windows ships `bash.exe` and is installed on essentially every
//! machine that has git, which is every machine that runs an agent on a
//! repository; when it is there, the POSIX-shaped commands models actually
//! write (`&&`, pipes, `[ -f x ]`, quoting) mean what they say. When it is not,
//! `cmd.exe /C` at least runs — a wrong-dialect error the model can read and
//! correct beats a spawn failure it cannot.
//!
//! `RUNE_SHELL` overrides the choice on any platform, because someone will have
//! a reason we did not think of.

use std::path::PathBuf;
use std::sync::OnceLock;

/// The program and its leading arguments; the command string is appended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Shell {
    pub program: PathBuf,
    pub args: Vec<String>,
    /// Whether this shell interprets POSIX syntax. False for `cmd.exe`.
    pub posix: bool,
}

static RESOLVED: OnceLock<Shell> = OnceLock::new();

/// The shell for this process, resolved once.
pub fn command_shell() -> &'static Shell {
    RESOLVED.get_or_init(resolve)
}

fn from_override() -> Option<Shell> {
    let raw = std::env::var("RUNE_SHELL").ok()?;
    let path = PathBuf::from(raw.trim());
    if path.as_os_str().is_empty() {
        return None;
    }
    let is_cmd = path
        .file_stem()
        .map(|s| s.eq_ignore_ascii_case("cmd"))
        .unwrap_or(false);
    Some(Shell {
        args: vec![if is_cmd { "/C" } else { "-c" }.to_string()],
        posix: !is_cmd,
        program: path,
    })
}

#[cfg(not(windows))]
fn resolve() -> Shell {
    from_override().unwrap_or(Shell {
        program: PathBuf::from("/bin/sh"),
        args: vec!["-c".to_string()],
        posix: true,
    })
}

#[cfg(windows)]
fn resolve() -> Shell {
    if let Some(s) = from_override() {
        return s;
    }
    if let Some(bash) = find_bash() {
        return Shell {
            program: bash,
            args: vec!["-c".to_string()],
            posix: true,
        };
    }
    // `ComSpec` is how Windows names its own command processor; it is set on
    // every installation, and honouring it costs nothing.
    let comspec = std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_string());
    Shell {
        program: PathBuf::from(comspec),
        args: vec!["/C".to_string()],
        posix: false,
    }
}

/// A real `bash.exe` — Git for Windows first, then PATH.
///
/// Git's own location is checked BEFORE PATH on purpose. The one `bash.exe`
/// that must never win is `C:\Windows\System32\bash.exe`, the WSL launcher: it
/// runs inside a Linux filesystem namespace where `D:\a\repo` is not a path,
/// so every command would run in the wrong place and most would fail to find
/// their own files. It is excluded by name below rather than trusted to be
/// absent.
#[cfg(windows)]
fn find_bash() -> Option<PathBuf> {
    for base in [
        r"C:\Program Files\Git\bin\bash.exe",
        r"C:\Program Files (x86)\Git\bin\bash.exe",
        r"C:\Program Files\Git\usr\bin\bash.exe",
    ] {
        let candidate = PathBuf::from(base);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".to_string());
    let wsl = PathBuf::from(&system_root)
        .join("System32")
        .join("bash.exe");
    if let Ok(path) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path) {
            let candidate = dir.join("bash.exe");
            if candidate.is_file() && !paths_equal(&candidate, &wsl) {
                return Some(candidate);
            }
        }
    }
    None
}

/// Windows paths compare case-insensitively; these are both machine-generated,
/// so a fold is enough without touching the filesystem.
#[cfg(windows)]
fn paths_equal(a: &std::path::Path, b: &std::path::Path) -> bool {
    a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_to_something_runnable() {
        let sh = command_shell();
        assert!(!sh.args.is_empty(), "a shell needs its -c/-C flag");
        assert!(!sh.program.as_os_str().is_empty());
    }

    #[test]
    #[cfg(not(windows))]
    fn posix_is_bin_sh() {
        // Only meaningful without an override; CI never sets one.
        if std::env::var("RUNE_SHELL").is_err() {
            let sh = command_shell();
            assert_eq!(sh.program, PathBuf::from("/bin/sh"));
            assert_eq!(sh.args, vec!["-c".to_string()]);
            assert!(sh.posix);
        }
    }

    #[test]
    #[cfg(windows)]
    fn windows_never_resolves_to_bin_sh() {
        // The defect: `/bin/sh` does not exist on Windows, and spawning it
        // failed with os error 3 for every command Rune tried to run.
        let sh = command_shell();
        assert_ne!(sh.program, PathBuf::from("/bin/sh"));
        assert!(
            sh.program.is_file(),
            "{} is not a file",
            sh.program.display()
        );
    }
}
