use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tracing::{debug, error};

use crate::error::SandboxError;

/// A single entry in the hash-chained audit log.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditEntry {
    pub timestamp: String,
    pub session_id: String,
    pub tool_name: String,
    pub args_hash: String,
    pub result_hash: String,
    pub duration_ms: u64,
    pub exit_code: i32,
    pub sandboxed: bool,
    pub prev_hash: String,
    pub entry_hash: String,
}

/// Hash-chained JSONL audit log.
///
/// Each entry's `entry_hash` is computed as `SHA-256(prev_hash|fields...)`,
/// forming a tamper-evident chain. The log file lives at `~/.gear/audit.jsonl`
/// by default.
pub struct AuditLog {
    path: PathBuf,
    prev_hash: String,
}

impl AuditLog {
    /// Open or create an audit log at the given path.
    ///
    /// If the file already exists, the last entry's hash is loaded so that new
    /// entries continue the chain.
    pub fn new(path: PathBuf) -> Result<Self, SandboxError> {
        // Ensure parent directory exists.
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(SandboxError::Io)?;
        }

        let prev_hash = Self::read_last_hash(&path);

        debug!(path = %path.display(), "audit log opened");

        Ok(Self { path, prev_hash })
    }

    /// Append a new entry to the audit log.
    #[allow(clippy::too_many_arguments)]
    pub fn append(
        &mut self,
        session_id: &str,
        tool_name: &str,
        args_hash: &str,
        result_hash: &str,
        duration_ms: u64,
        exit_code: i32,
        sandboxed: bool,
    ) -> Result<(), SandboxError> {
        let timestamp = Utc::now().to_rfc3339();

        let entry_hash = Self::compute_hash(
            &self.prev_hash,
            &timestamp,
            session_id,
            tool_name,
            args_hash,
            result_hash,
            duration_ms,
            exit_code,
            sandboxed,
        );

        let entry = AuditEntry {
            timestamp,
            session_id: session_id.to_string(),
            tool_name: tool_name.to_string(),
            args_hash: args_hash.to_string(),
            result_hash: result_hash.to_string(),
            duration_ms,
            exit_code,
            sandboxed,
            prev_hash: self.prev_hash.clone(),
            entry_hash: entry_hash.clone(),
        };

        let mut line =
            serde_json::to_string(&entry).map_err(|e| SandboxError::SpawnFailed(e.to_string()))?;
        line.push('\n');

        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .map_err(SandboxError::Io)?;

        file.write_all(line.as_bytes()).map_err(SandboxError::Io)?;

        self.prev_hash = entry_hash;
        Ok(())
    }

    /// Verify the integrity of the entire audit chain.
    ///
    /// Returns `true` if every entry's hash matches its recomputed value and
    /// the `prev_hash` links are consistent.
    pub fn verify(&self) -> bool {
        let file = match fs::File::open(&self.path) {
            Ok(f) => f,
            Err(_) => return true, // Empty / missing log is trivially valid.
        };

        let reader = BufReader::new(file);
        let mut expected_prev = String::from("genesis");

        for (i, line) in reader.lines().enumerate() {
            let line = match line {
                Ok(l) if l.trim().is_empty() => continue,
                Ok(l) => l,
                Err(e) => {
                    error!(line = i, error = %e, "failed to read audit line");
                    return false;
                }
            };

            let entry: AuditEntry = match serde_json::from_str(&line) {
                Ok(e) => e,
                Err(e) => {
                    error!(line = i, error = %e, "failed to parse audit entry");
                    return false;
                }
            };

            if entry.prev_hash != expected_prev {
                error!(
                    line = i,
                    expected = expected_prev,
                    actual = entry.prev_hash,
                    "prev_hash mismatch"
                );
                return false;
            }

            let recomputed = Self::compute_hash(
                &entry.prev_hash,
                &entry.timestamp,
                &entry.session_id,
                &entry.tool_name,
                &entry.args_hash,
                &entry.result_hash,
                entry.duration_ms,
                entry.exit_code,
                entry.sandboxed,
            );

            if recomputed != entry.entry_hash {
                error!(
                    line = i,
                    expected = recomputed,
                    actual = entry.entry_hash,
                    "entry_hash mismatch — possible tampering"
                );
                return false;
            }

            expected_prev = entry.entry_hash;
        }

        true
    }

    /// Compute the SHA-256 hash for an audit entry.
    #[allow(clippy::too_many_arguments)]
    fn compute_hash(
        prev_hash: &str,
        timestamp: &str,
        session_id: &str,
        tool_name: &str,
        args_hash: &str,
        result_hash: &str,
        duration_ms: u64,
        exit_code: i32,
        sandboxed: bool,
    ) -> String {
        let payload = format!(
            "{prev_hash}|{timestamp}|{session_id}|{tool_name}|{args_hash}|{result_hash}|{duration_ms}|{exit_code}|{sandboxed}"
        );
        let mut hasher = Sha256::new();
        hasher.update(payload.as_bytes());
        hex::encode(hasher.finalize())
    }

    /// Read the last entry_hash from an existing log file, or return "genesis".
    fn read_last_hash(path: &Path) -> String {
        let file = match fs::File::open(path) {
            Ok(f) => f,
            Err(_) => return String::from("genesis"),
        };

        let reader = BufReader::new(file);
        let mut last_hash = String::from("genesis");

        // Skip unreadable lines (rare: only on invalid-UTF8/read errors) and keep
        // scanning — the goal is the hash of the true last entry in the file, not
        // to stop early and silently fork the hash chain from a stale point.
        #[allow(clippy::lines_filter_map_ok)]
        for line in reader.lines().flatten() {
            if line.trim().is_empty() {
                continue;
            }
            if let Ok(entry) = serde_json::from_str::<AuditEntry>(&line) {
                last_hash = entry.entry_hash;
            }
        }

        last_hash
    }
}

/// Compute a SHA-256 hash of arbitrary data (used for hashing command args / results).
pub fn sha256_hash(data: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data.as_bytes());
    hex::encode(hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_chain_round_trip() {
        let dir = std::env::temp_dir().join("gear_audit_test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("audit.jsonl");

        let mut log = AuditLog::new(path.clone()).unwrap();
        log.append("s1", "bash", "ah1", "rh1", 42, 0, false)
            .unwrap();
        log.append("s1", "write", "ah2", "rh2", 10, 0, true)
            .unwrap();

        assert!(log.verify());

        // Clean up.
        let _ = fs::remove_dir_all(&dir);
    }
}
