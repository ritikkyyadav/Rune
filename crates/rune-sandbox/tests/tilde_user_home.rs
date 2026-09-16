//! `~<username>` does not consult `$HOME`, so neither may the deny list.
//!
//! V10 critical 5. Every rig, test, eval and CI job in this repo establishes
//! isolation by pointing `$HOME`/`RUNE_HOME` at a scratch directory — that is
//! the entire isolation mechanism the verification programme rests on. Bash's
//! `~<username>` form resolves through the user database and ignores the
//! override completely, so a session that believed itself confined to a scratch
//! profile reached the real `~/.rune/memory/.key`: the deny list was built from
//! `dirs::home_dir()`, which honours `$HOME`, and therefore never named the
//! path the shell actually opened.
//!
//! One test function, deliberately: environment variables are process-global
//! and the test harness runs a file's tests on parallel threads.

use std::path::PathBuf;

use rune_sandbox::{PathGuard, credential_deny_paths, credential_path_named, passwd_home};

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
fn the_real_home_stays_denied_from_a_scratch_profile() {
    let scratch = tempfile::tempdir().expect("tempdir");
    let scratch_home = scratch.path().join("home");
    std::fs::create_dir_all(&scratch_home).expect("scratch home");
    let real_home = passwd_home().expect("a passwd home on this machine");
    let user = rune_sandbox::passwd_user().expect("a passwd account name");
    let workspace = scratch.path().join("workspace");
    std::fs::create_dir_all(&workspace).expect("workspace");

    with_env(
        &[
            ("HOME", Some(scratch_home.to_str().expect("utf-8"))),
            (
                "RUNE_HOME",
                Some(scratch_home.join(".rune").to_str().expect("utf-8")),
            ),
            ("GEAR_HOME", None),
            ("ALAN_HOME", None),
        ],
        || {
            // The override really is in force — otherwise the rest proves nothing.
            assert_eq!(dirs::home_dir(), Some(scratch_home.clone()));
            assert_ne!(real_home, scratch_home);

            // The deny list names BOTH homes: the scratch one it is running
            // under and the real one `~<user>` reaches past it.
            let deny = credential_deny_paths();
            for root in [&scratch_home, &real_home] {
                for leaf in ["memory", "secrets.json", ".env"] {
                    let entry = root.join(".rune").join(leaf);
                    assert!(
                        deny.contains(&entry),
                        "deny list is missing {}",
                        entry.display()
                    );
                }
            }
            assert!(deny.contains(&real_home.join(".ssh")));

            // `~<user>/…` expands through the user database, not `$HOME`.
            let named = credential_path_named(&format!("cat ~{user}/.rune/memory/.key"));
            assert_eq!(
                named,
                Some(real_home.join(".rune").join("memory").join(".key")),
                "~{user} must resolve to the passwd home"
            );
            // …and quoting does not hide it, nor does a different verb.
            assert!(credential_path_named(&format!("wc -c \"~{user}/.rune/.env\"")).is_some());
            assert!(credential_path_named(&format!("tar cf /tmp/x.tar ~{user}/.ssh")).is_some());

            // The guard refuses it before anything spawns, on every executor —
            // including the PathGuard-only fallback, where no OS profile exists.
            let guard = PathGuard::new(workspace.clone());
            let refusal = guard
                .validate_command(&format!("cat ~{user}/.rune/memory/.key"))
                .expect_err("a credential read must be refused");
            assert!(
                refusal.to_string().contains("credential store"),
                "unexpected refusal: {refusal}"
            );
            assert!(
                guard
                    .validate_command(&format!("cat ~{user}/.rune/secrets.json"))
                    .is_err()
            );
            // The scratch profile's own store is refused by the same rule.
            assert!(
                guard
                    .validate_command("cat $RUNE_HOME/memory/.key")
                    .is_err()
            );
            assert!(guard.validate_command("cat ~/.rune/.env").is_err());

            // Ordinary work is untouched.
            guard
                .validate_command("cargo test --workspace")
                .expect("a benign command must pass");
            guard
                .validate_command("cat src/lib.rs && ls docs/")
                .expect("workspace paths must pass");
            guard
                .validate_command(&format!("ls {}", workspace.display()))
                .expect("the workspace itself must pass");
        },
    );

    // Nothing here ever touched the real home.
    assert!(PathBuf::from(&real_home).exists());
}
