//! BM25 full-text code search over symbol-shaped chunks (SQLite FTS5).
//!
//! Grep answers "where does this exact string appear"; this answers "where do
//! we handle stripe webhook retries" — ranked relevance over tokenized code,
//! not literal matching. Chunks are the tree-sitter declarations the repo map
//! already extracts (a function/class body is the natural retrieval unit);
//! files with no parsed declarations fall back to one whole-file chunk so
//! configs and scripts stay findable.
//!
//! Local-first by construction: the index is a plain SQLite file under
//! `.gear/`, built and refreshed incrementally by (mtime, size) — no daemon,
//! no embeddings, no network.

use std::fs;
use std::path::Path;
use std::time::UNIX_EPOCH;

use rusqlite::Connection;
use serde::Serialize;

use crate::error::IndexError;
use crate::languages::detect_language;
use crate::repo_map::{collect_source_files, parse_source};

/// Hard bound on files swept per refresh (same spirit as the repo map bound).
const MAX_FILES: usize = 5_000;
/// A single chunk is capped so one giant function can't dominate the index.
const MAX_CHUNK_BYTES: usize = 4_096;
/// Whole-file fallback chunks get a slightly larger cap.
const MAX_FILE_CHUNK_BYTES: usize = 8_192;

#[derive(Debug, Clone, Serialize)]
pub struct SearchHit {
    pub path: String,
    pub symbol: String,
    pub kind: String,
    pub start_line: u32,
    /// Lower is better (SQLite bm25 convention, with boosts applied).
    pub score: f64,
    pub snippet: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct RefreshSummary {
    pub files_seen: usize,
    pub files_indexed: usize,
    pub files_removed: usize,
    pub chunks: usize,
}

pub struct CodeSearch {
    conn: Connection,
}

impl CodeSearch {
    pub fn open(db_path: &Path) -> Result<Self, IndexError> {
        if let Some(parent) = db_path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let conn = Connection::open(db_path)?;
        conn.execute_batch(
            r#"
            PRAGMA journal_mode = WAL;
            CREATE TABLE IF NOT EXISTS search_files (
                path TEXT PRIMARY KEY,
                mtime_ms INTEGER NOT NULL,
                size INTEGER NOT NULL
            );
            CREATE VIRTUAL TABLE IF NOT EXISTS search_chunks USING fts5(
                path UNINDEXED,
                symbol,
                kind UNINDEXED,
                start_line UNINDEXED,
                content,
                tokenize = 'porter unicode61 tokenchars ''_'''
            );
            "#,
        )?;
        Ok(Self { conn })
    }

    pub fn open_in_memory() -> Result<Self, IndexError> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS search_files (
                path TEXT PRIMARY KEY,
                mtime_ms INTEGER NOT NULL,
                size INTEGER NOT NULL
            );
            CREATE VIRTUAL TABLE IF NOT EXISTS search_chunks USING fts5(
                path UNINDEXED,
                symbol,
                kind UNINDEXED,
                start_line UNINDEXED,
                content,
                tokenize = 'porter unicode61 tokenchars ''_'''
            );
            "#,
        )?;
        Ok(Self { conn })
    }

    /// Incremental refresh: files whose (mtime, size) match the recorded row
    /// are skipped; changed/new files are re-chunked; vanished files are
    /// dropped. First build on a cold index sweeps everything once.
    pub fn refresh(&mut self, root: &Path) -> Result<RefreshSummary, IndexError> {
        let root = fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
        let files = collect_source_files(&root, MAX_FILES);
        let mut summary = RefreshSummary {
            files_seen: files.len(),
            files_indexed: 0,
            files_removed: 0,
            chunks: 0,
        };

        let tx = self.conn.transaction()?;

        let mut live_paths: Vec<String> = Vec::with_capacity(files.len());
        for path in &files {
            let relative = path
                .strip_prefix(&root)
                .unwrap_or(path)
                .to_string_lossy()
                .replace('\\', "/");
            live_paths.push(relative.clone());

            let Ok(meta) = fs::metadata(path) else {
                continue;
            };
            let mtime_ms = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            let size = meta.len() as i64;

            let unchanged: bool = tx
                .query_row(
                    "SELECT 1 FROM search_files WHERE path = ?1 AND mtime_ms = ?2 AND size = ?3",
                    rusqlite::params![relative, mtime_ms, size],
                    |_| Ok(true),
                )
                .unwrap_or(false);
            if unchanged {
                continue;
            }

            let Ok(content) = fs::read_to_string(path) else {
                continue;
            };
            let Some(language) = detect_language(path) else {
                continue;
            };

            tx.execute(
                "DELETE FROM search_chunks WHERE path = ?1",
                rusqlite::params![relative],
            )?;

            let (declarations, _references, _ts, _fb) = parse_source(&content, language, path);
            let mut inserted = 0usize;
            for decl in &declarations {
                let end = decl.end_byte.min(content.len());
                let start = decl.start_byte.min(end);
                let body = safe_slice(&content, start, end, MAX_CHUNK_BYTES);
                if body.trim().is_empty() {
                    continue;
                }
                tx.execute(
                    "INSERT INTO search_chunks (path, symbol, kind, start_line, content)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    rusqlite::params![
                        relative,
                        decl.name,
                        format!("{:?}", decl.kind).to_lowercase(),
                        decl.start_line,
                        format!("{}\n{}", decl.signature, body),
                    ],
                )?;
                inserted += 1;
            }
            if inserted == 0 {
                // No declarations parsed — index the file head as one chunk so
                // the file is still discoverable by content.
                let body = safe_slice(&content, 0, content.len(), MAX_FILE_CHUNK_BYTES);
                tx.execute(
                    "INSERT INTO search_chunks (path, symbol, kind, start_line, content)
                     VALUES (?1, '', 'file', 1, ?2)",
                    rusqlite::params![relative, body],
                )?;
                inserted = 1;
            }
            summary.chunks += inserted;

            tx.execute(
                "INSERT INTO search_files (path, mtime_ms, size) VALUES (?1, ?2, ?3)
                 ON CONFLICT(path) DO UPDATE SET mtime_ms = ?2, size = ?3",
                rusqlite::params![relative, mtime_ms, size],
            )?;
            summary.files_indexed += 1;
        }

        // Drop rows for files that no longer exist on disk.
        {
            let mut stmt = tx.prepare("SELECT path FROM search_files")?;
            let known: Vec<String> = stmt
                .query_map([], |row| row.get(0))?
                .filter_map(Result::ok)
                .collect();
            for path in known {
                if !live_paths.contains(&path) {
                    tx.execute(
                        "DELETE FROM search_chunks WHERE path = ?1",
                        rusqlite::params![path],
                    )?;
                    tx.execute(
                        "DELETE FROM search_files WHERE path = ?1",
                        rusqlite::params![path],
                    )?;
                    summary.files_removed += 1;
                }
            }
        }

        tx.commit()?;
        Ok(summary)
    }

    /// Ranked search. Tries an AND query first (precision), falls back to OR
    /// (recall) when nothing matches. Ranking is bm25 with two boosts: hits
    /// whose SYMBOL matches a query term, and hits whose PATH does.
    pub fn search(&self, query: &str, limit: usize) -> Result<Vec<SearchHit>, IndexError> {
        let terms = tokenize(query);
        if terms.is_empty() {
            return Ok(Vec::new());
        }
        let and_expr = terms.join(" AND ");
        let or_expr = terms.join(" OR ");

        let mut hits = self.run_match(&and_expr, limit)?;
        if hits.is_empty() && terms.len() > 1 {
            hits = self.run_match(&or_expr, limit)?;
        }

        // Boosts: bm25 is "lower = better", so boosts subtract.
        for hit in &mut hits {
            let symbol_lower = hit.symbol.to_lowercase();
            let path_lower = hit.path.to_lowercase();
            for term in &terms {
                if symbol_lower.contains(term.as_str()) {
                    hit.score -= 2.0;
                }
                if path_lower.contains(term.as_str()) {
                    hit.score -= 0.5;
                }
            }
        }
        hits.sort_by(|a, b| {
            a.score
                .partial_cmp(&b.score)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        hits.truncate(limit);
        Ok(hits)
    }

    fn run_match(&self, expr: &str, limit: usize) -> Result<Vec<SearchHit>, IndexError> {
        let mut stmt = self.conn.prepare(
            "SELECT path, symbol, kind, start_line,
                        bm25(search_chunks, 0.0, 2.0, 0.0, 0.0, 1.0),
                        snippet(search_chunks, 4, '', '', ' … ', 16)
                 FROM search_chunks
                 WHERE search_chunks MATCH ?1
                 ORDER BY bm25(search_chunks, 0.0, 2.0, 0.0, 0.0, 1.0)
                 LIMIT ?2",
        )?;
        let rows = stmt.query_map(rusqlite::params![expr, (limit * 3) as i64], |row| {
            Ok(SearchHit {
                path: row.get(0)?,
                symbol: row.get(1)?,
                kind: row.get(2)?,
                start_line: row.get::<_, i64>(3)? as u32,
                score: row.get(4)?,
                snippet: row.get::<_, String>(5)?.replace('\n', " "),
            })
        })?;
        Ok(rows.filter_map(Result::ok).collect())
    }
}

/// FTS5 MATCH has operator syntax ("-", ":", NEAR…); a natural-language query
/// must be reduced to bare terms or SQLite rejects it. Keep identifier-ish
/// tokens, lowercase them, drop trivial stopwords.
fn tokenize(query: &str) -> Vec<String> {
    const STOP: &[&str] = &[
        "a", "an", "and", "are", "at", "be", "by", "do", "does", "for", "how", "in", "is", "it",
        "of", "on", "or", "the", "to", "we", "where", "which", "who", "why", "with",
    ];
    let mut out = Vec::new();
    for token in query.split(|c: char| !(c.is_alphanumeric() || c == '_')) {
        let t = token.trim().to_lowercase();
        if t.len() < 2 || STOP.contains(&t.as_str()) {
            continue;
        }
        if !out.contains(&t) {
            out.push(t);
        }
    }
    out.truncate(12);
    out
}

/// Byte-safe, char-boundary-safe slice capped at `max` bytes.
fn safe_slice(content: &str, start: usize, end: usize, max: usize) -> String {
    let end = end.min(start.saturating_add(max)).min(content.len());
    let mut s = start.min(end);
    while s > 0 && !content.is_char_boundary(s) {
        s -= 1;
    }
    let mut e = end;
    while e < content.len() && !content.is_char_boundary(e) {
        e += 1;
    }
    let capped = e.min(s.saturating_add(max + 4));
    let mut c = capped;
    while c > s && !content.is_char_boundary(c) {
        c -= 1;
    }
    content[s..c].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn fixture_repo() -> TempDir {
        let dir = TempDir::new().unwrap();
        fs::create_dir_all(dir.path().join("src")).unwrap();
        fs::write(
            dir.path().join("src/webhooks.ts"),
            r#"export async function handleStripeWebhookRetry(event: WebhookEvent): Promise<void> {
  // exponential backoff for failed stripe webhook deliveries
  const delay = backoffMs(event.attempt);
  await schedule(event, delay);
}

export function backoffMs(attempt: number): number {
  return Math.min(60_000, 100 * 2 ** attempt);
}
"#,
        )
        .unwrap();
        fs::write(
            dir.path().join("src/users.ts"),
            r#"export function createUser(name: string): User {
  return { name, id: nextId() };
}
"#,
        )
        .unwrap();
        fs::write(dir.path().join("README.md"), "# demo\n").unwrap();
        dir
    }

    #[test]
    fn natural_language_query_ranks_the_right_symbol_first() {
        let repo = fixture_repo();
        let mut search = CodeSearch::open_in_memory().unwrap();
        let summary = search.refresh(repo.path()).unwrap();
        assert!(summary.files_indexed >= 2);
        assert!(summary.chunks >= 3);

        let hits = search
            .search("where are stripe webhook retries handled", 5)
            .unwrap();
        assert!(!hits.is_empty(), "expected hits for the webhook query");
        assert_eq!(hits[0].symbol, "handleStripeWebhookRetry");
        assert!(hits[0].path.ends_with("webhooks.ts"));
        assert!(hits[0].start_line >= 1);
    }

    #[test]
    fn refresh_is_incremental_and_handles_deletes() {
        let repo = fixture_repo();
        let db = repo.path().join("search.db");
        let mut search = CodeSearch::open(&db).unwrap();
        let first = search.refresh(repo.path()).unwrap();
        assert!(first.files_indexed >= 2);

        // Unchanged tree → zero files re-indexed.
        let second = search.refresh(repo.path()).unwrap();
        assert_eq!(second.files_indexed, 0);
        assert_eq!(second.files_removed, 0);

        // Touch one file with new content → exactly that file re-indexes and
        // its OLD chunks are replaced (no duplicate hits).
        std::thread::sleep(std::time::Duration::from_millis(5));
        fs::write(
            repo.path().join("src/users.ts"),
            "export function createAccount(name: string) { return name; }\n",
        )
        .unwrap();
        let third = search.refresh(repo.path()).unwrap();
        assert_eq!(third.files_indexed, 1);
        let stale = search.search("createUser", 5).unwrap();
        assert!(stale.is_empty(), "stale chunk survived re-index: {stale:?}");
        let fresh = search.search("createAccount", 5).unwrap();
        assert_eq!(fresh.len(), 1);

        // Delete a file → its chunks vanish from results.
        fs::remove_file(repo.path().join("src/webhooks.ts")).unwrap();
        let fourth = search.refresh(repo.path()).unwrap();
        assert_eq!(fourth.files_removed, 1);
        assert!(search.search("stripe webhook", 5).unwrap().is_empty());
    }

    #[test]
    fn operator_characters_in_queries_never_break_match_syntax() {
        let repo = fixture_repo();
        let mut search = CodeSearch::open_in_memory().unwrap();
        search.refresh(repo.path()).unwrap();
        // Raw FTS5 would reject all of these.
        for q in [
            "stripe-webhook:retry",
            "\"unbalanced",
            "NEAR(",
            "user -admin",
        ] {
            let _ = search.search(q, 5).unwrap(); // must not error
        }
        assert!(search.search("", 5).unwrap().is_empty());
    }
}
