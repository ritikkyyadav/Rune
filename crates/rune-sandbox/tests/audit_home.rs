//! `RUNE_HOME` relocates the sandbox audit log.
//!
//! Every rig, capture script and test harness in this repo sets `RUNE_HOME` to
//! a scratch profile and then reports that the founder's `~/.rune` was not
//! touched. The crate ignored the variable, so every sandboxed `bash` call ever
//! made by a test run appended to the founder's real `~/.rune/audit.jsonl`.
//!
//! One test function, deliberately: environment variables are process-global
//! and the test harness runs a file's tests on parallel threads.

use std::path::PathBuf;

use rune_sandbox::{SandboxConfig, rune_home};

/// Set an environment variable for the duration of the closure, then restore
/// whatever was there before. `unsafe` because edition 2024 says so: the
/// process environment is shared, which is exactly why this file holds one test.
fn with_env<T>(pairs: &[(&str, Option<&str>)], body: impl FnOnce() -> T) -> T {
    let saved: Vec<(String, Option<String>)> = pairs
        .iter()
        .map(|(k, _)| ((*k).to_string(), std::env::var(k).ok()))
        .collect();
    for (key, value) in pairs {
        match value {
            Some(v) => unsafe { std::env::set_var(key, v) },
            None => unsafe { std::env::remove_var(key) },
        }
    }
    let out = body();
    for (key, value) in &saved {
        match value {
            Some(v) => unsafe { std::env::set_var(key, v) },
            None => unsafe { std::env::remove_var(key) },
        }
    }
    out
}

#[test]
fn the_audit_log_follows_rune_home() {
    let scratch = std::env::temp_dir().join("rune-sandbox-audit-home");
    let scratch_str = scratch.to_str().unwrap().to_string();

    // RUNE_HOME names the directory itself, not its parent.
    with_env(
        &[("RUNE_HOME", Some(&scratch_str)), ("GEAR_HOME", None)],
        || {
            assert_eq!(rune_home(), scratch);
            assert_eq!(
                SandboxConfig::default().audit_log_path,
                scratch.join("audit.jsonl"),
                "a scratch RUNE_HOME must move the audit log off the real profile"
            );
        },
    );

    // The previous name still works, and RUNE_HOME wins when both are set.
    with_env(
        &[("RUNE_HOME", None), ("GEAR_HOME", Some(&scratch_str))],
        || {
            assert_eq!(rune_home(), scratch);
        },
    );
    let other = std::env::temp_dir().join("rune-sandbox-audit-home-legacy");
    with_env(
        &[
            ("RUNE_HOME", Some(&scratch_str)),
            ("GEAR_HOME", Some(other.to_str().unwrap())),
        ],
        || assert_eq!(rune_home(), scratch),
    );

    // An empty or whitespace-only override is not a relocation to the current
    // directory: it reads as unset.
    let real = with_env(&[("RUNE_HOME", None), ("GEAR_HOME", None)], rune_home);
    // The DEFAULT still points at the real profile, which is what a real
    // invocation wants — and is why no test in this crate may use it (V8 #15).
    assert_eq!(
        with_env(&[("RUNE_HOME", None), ("GEAR_HOME", None)], || {
            SandboxConfig::default().audit_log_path
        }),
        real.join("audit.jsonl"),
        "the default is the real profile; a test that wants one must say so"
    );
    assert_eq!(
        real,
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("/tmp"))
            .join(".rune"),
        "with no override the home is still ~/.rune"
    );
    for blank in ["", "   "] {
        with_env(&[("RUNE_HOME", Some(blank)), ("GEAR_HOME", None)], || {
            assert_eq!(rune_home(), real, "a blank override is not a path");
        });
    }
}

/// No test in this crate may build a config that writes to a real profile.
///
/// V8 finding 15: `cargo test --locked --workspace` — gate #8 of the thirteen —
/// appended seven lines to the founder's `~/.rune/audit.jsonl` on every run,
/// deterministically, including the closing gate run that certified the
/// release. `bunfig.toml`'s `[test] preload` cannot reach cargo, and three
/// verifiers in a row mis-attributed those lines rather than suspecting the one
/// gate nobody fingerprints. The five macOS tests that actually execute a
/// command took their `audit_log_path` from `SandboxConfig::default()`, which
/// resolves through `rune_home()`, which with no `RUNE_HOME` set is the real
/// home. They take it from `crate::test_audit_path()` now.
///
/// Read off the source, so it needs no environment of its own — this file runs
/// its tests on parallel threads and the env is process-global, which is why
/// exactly one test here may touch it.
#[test]
fn no_test_config_in_this_crate_inherits_the_default_audit_path() {
    let source = include_str!("../src/macos.rs");
    assert!(
        source.contains("audit_log_path: crate::test_audit_path()"),
        "macos.rs's test config must not inherit the default audit path"
    );
    let linux = include_str!("../src/linux.rs");
    assert!(
        linux.contains("audit_log_path: crate::test_audit_path()"),
        "linux.rs's test config must not inherit the default audit path"
    );
}
