//! One spelling for one path, on every platform.
//!
//! `std::fs::canonicalize` on Windows returns a VERBATIM (extended-length)
//! path: `\\?\C:\Users\me\project\src\main.rs`. That form is correct, is what
//! the OS wants for paths over 260 characters, and is useless as an identity —
//! nothing else in the system produces it. The harness above this binary keys
//! its read-before-edit ledger on the paths these tools echo, and the first
//! Windows runtime smoke failed at `edit_file` with "You must read smoke.txt
//! (read_file) before editing it" immediately after reading it, because
//! `read_file` echoed `C:\…\smoke.txt` (the workspace root joined) and
//! `edit_file` echoed `\\?\C:\…\smoke.txt` (canonicalized). Two strings, one
//! file, and a ledger miss (P10.2).
//!
//! So every path that leaves this binary goes through `simplified` first. On
//! anything but Windows it is the identity function.

use std::path::{Path, PathBuf};

/// Windows' documented limit for a non-verbatim path.
const MAX_PATH: usize = 260;

/// Drop the `\\?\` prefix when the plain form means the same thing.
///
/// It is kept when dropping it would change the meaning or break the path:
/// a UNC share (`\\?\UNC\server\share` unwraps to `\\server\share`, which is
/// fine), a device path that is not a drive letter, or a path long enough that
/// only the verbatim form can address it.
pub fn simplified(path: &Path) -> PathBuf {
    if !cfg!(windows) {
        return path.to_path_buf();
    }
    let text = path.to_string_lossy();
    let plain = if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = text.strip_prefix(r"\\?\") {
        // Only a drive-letter root is safe to unwrap; `\\?\Volume{…}` and other
        // device paths have no plain equivalent.
        let bytes = rest.as_bytes();
        let drive_rooted = bytes.len() >= 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && (bytes[2] == b'\\' || bytes[2] == b'/');
        if !drive_rooted {
            return path.to_path_buf();
        }
        rest.to_string()
    } else {
        return path.to_path_buf();
    };

    if plain.len() >= MAX_PATH {
        // Long enough that the plain form may not open. Keep what works.
        return path.to_path_buf();
    }
    PathBuf::from(plain)
}

/// `simplified`, rendered for a JSON field.
pub fn display(path: &Path) -> String {
    simplified(path).display().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn leaves_ordinary_paths_alone() {
        // True on every platform: this is the no-op case the tools hit most.
        let p = Path::new("src/main.rs");
        assert_eq!(simplified(p), PathBuf::from("src/main.rs"));
    }

    #[test]
    #[cfg(windows)]
    fn unwraps_a_drive_rooted_verbatim_path() {
        assert_eq!(
            simplified(Path::new(r"\\?\C:\Users\me\smoke.txt")),
            PathBuf::from(r"C:\Users\me\smoke.txt")
        );
    }

    #[test]
    #[cfg(windows)]
    fn unwraps_a_verbatim_unc_path() {
        assert_eq!(
            simplified(Path::new(r"\\?\UNC\server\share\file.txt")),
            PathBuf::from(r"\\server\share\file.txt")
        );
    }

    #[test]
    #[cfg(windows)]
    fn keeps_a_device_path_it_cannot_unwrap() {
        let device = r"\\?\Volume{9c1d4a1e-0000-0000-0000-100000000000}\file.txt";
        assert_eq!(simplified(Path::new(device)), PathBuf::from(device));
    }

    #[test]
    #[cfg(windows)]
    fn keeps_the_prefix_on_a_path_too_long_without_it() {
        let long = format!(r"\\?\C:\{}\file.txt", "d".repeat(300));
        assert_eq!(simplified(Path::new(&long)), PathBuf::from(&long));
    }

    #[test]
    #[cfg(not(windows))]
    fn is_the_identity_off_windows() {
        // A leading `\\?\` is a legal (if strange) POSIX filename, and must not
        // be rewritten there.
        let odd = Path::new(r"\\?\C:\not-a-windows-path");
        assert_eq!(simplified(odd), odd.to_path_buf());
    }

    #[test]
    fn canonicalize_round_trips_through_simplified() {
        // The property that matters: whatever `canonicalize` produces, the
        // simplified form still names the same file. Cheap on every platform,
        // and the only test that would have caught the Windows defect.
        let here = std::fs::canonicalize(".").expect("cwd canonicalizes");
        let simple = simplified(&here);
        assert!(simple.exists(), "{} does not exist", simple.display());
        assert_eq!(
            std::fs::canonicalize(&simple).unwrap(),
            here,
            "simplified path canonicalizes back to the same file"
        );
    }
}
