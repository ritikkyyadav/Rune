use std::path::Path;

use rusqlite::{params, Connection};
use tracing::{debug, instrument};

use crate::error::IndexError;
use crate::query::{IndexStats, IndexedFile, Symbol, SymbolKind, SymbolQuery};

/// SQLite-backed store for indexed symbols and file metadata.
pub struct SymbolStore {
    conn: Connection,
}

impl SymbolStore {
    /// Open (or create) the symbol store at the given database path.
    #[instrument(skip_all, fields(db_path = %db_path.as_ref().display()))]
    pub fn open(db_path: impl AsRef<Path>) -> Result<Self, IndexError> {
        let conn = Connection::open(db_path.as_ref())?;
        let store = Self { conn };
        store.initialize_schema()?;
        debug!("symbol store opened");
        Ok(store)
    }

    /// Open an in-memory symbol store (useful for testing).
    pub fn open_in_memory() -> Result<Self, IndexError> {
        let conn = Connection::open_in_memory()?;
        let store = Self { conn };
        store.initialize_schema()?;
        Ok(store)
    }

    fn initialize_schema(&self) -> Result<(), IndexError> {
        self.conn.execute_batch(Self::SCHEMA)?;
        Ok(())
    }

    const SCHEMA: &str = r#"
        PRAGMA journal_mode = WAL;
        PRAGMA foreign_keys = ON;
        PRAGMA busy_timeout = 5000;

        CREATE TABLE IF NOT EXISTS indexed_files (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            path            TEXT NOT NULL UNIQUE,
            hash            TEXT NOT NULL,
            language        TEXT NOT NULL,
            indexed_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            symbol_count    INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS symbols (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            file_id         INTEGER NOT NULL REFERENCES indexed_files(id) ON DELETE CASCADE,
            name            TEXT NOT NULL,
            kind            TEXT NOT NULL,
            start_line      INTEGER NOT NULL,
            end_line        INTEGER NOT NULL,
            signature       TEXT,
            doc_comment     TEXT,
            parent_id       INTEGER REFERENCES symbols(id) ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
        CREATE INDEX IF NOT EXISTS idx_symbols_kind ON symbols(kind);
        CREATE INDEX IF NOT EXISTS idx_symbols_file_id ON symbols(file_id);
        CREATE INDEX IF NOT EXISTS idx_indexed_files_path ON indexed_files(path);
    "#;

    /// Insert or update a file and its symbols. Deletes old symbols in a transaction,
    /// then inserts the new set.
    #[instrument(skip_all, fields(path = %path, symbol_count = symbols.len()))]
    pub fn upsert_file(
        &mut self,
        path: &str,
        hash: &str,
        language: &str,
        symbols: &[Symbol],
    ) -> Result<i64, IndexError> {
        let tx = self.conn.transaction()?;

        // Delete old symbols if file already exists.
        let existing_id: Option<i64> = tx
            .query_row(
                "SELECT id FROM indexed_files WHERE path = ?1",
                params![path],
                |row| row.get(0),
            )
            .ok();

        if let Some(fid) = existing_id {
            tx.execute("DELETE FROM symbols WHERE file_id = ?1", params![fid])?;
            tx.execute(
                "UPDATE indexed_files SET hash = ?1, language = ?2, symbol_count = ?3,
                 indexed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                 WHERE id = ?4",
                params![hash, language, symbols.len() as u32, fid],
            )?;

            // Insert new symbols.
            for sym in symbols {
                tx.execute(
                    "INSERT INTO symbols (file_id, name, kind, start_line, end_line, signature, doc_comment, parent_id)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                    params![
                        fid,
                        sym.name,
                        sym.kind.as_str(),
                        sym.start_line,
                        sym.end_line,
                        sym.signature,
                        sym.doc_comment,
                        sym.parent_id,
                    ],
                )?;
            }

            tx.commit()?;
            debug!(file_id = fid, "updated existing file");
            Ok(fid)
        } else {
            tx.execute(
                "INSERT INTO indexed_files (path, hash, language, symbol_count)
                 VALUES (?1, ?2, ?3, ?4)",
                params![path, hash, language, symbols.len() as u32],
            )?;
            let file_id = tx.last_insert_rowid();

            for sym in symbols {
                tx.execute(
                    "INSERT INTO symbols (file_id, name, kind, start_line, end_line, signature, doc_comment, parent_id)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                    params![
                        file_id,
                        sym.name,
                        sym.kind.as_str(),
                        sym.start_line,
                        sym.end_line,
                        sym.signature,
                        sym.doc_comment,
                        sym.parent_id,
                    ],
                )?;
            }

            tx.commit()?;
            debug!(file_id, "indexed new file");
            Ok(file_id)
        }
    }

    /// Find symbols matching the given query.
    pub fn find_symbols(&self, query: &SymbolQuery) -> Result<Vec<Symbol>, IndexError> {
        let mut sql = String::from(
            "SELECT s.id, s.file_id, s.name, s.kind, s.start_line, s.end_line,
                    s.signature, s.doc_comment, s.parent_id
             FROM symbols s
             JOIN indexed_files f ON s.file_id = f.id
             WHERE 1=1",
        );
        let mut param_values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
        let mut param_idx = 1u32;

        if let Some(ref name) = query.name {
            sql.push_str(&format!(" AND s.name LIKE ?{param_idx}"));
            param_values.push(Box::new(format!("%{name}%")));
            param_idx += 1;
        }

        if let Some(ref kind) = query.kind {
            sql.push_str(&format!(" AND s.kind = ?{param_idx}"));
            param_values.push(Box::new(kind.as_str().to_string()));
            param_idx += 1;
        }

        if let Some(ref glob) = query.file_glob {
            // Use SQLite GLOB for file path filtering.
            sql.push_str(&format!(" AND f.path GLOB ?{param_idx}"));
            param_values.push(Box::new(glob.clone()));
            param_idx += 1;
        }

        let limit = query.limit.unwrap_or(100);
        sql.push_str(&format!(" ORDER BY s.name ASC LIMIT ?{param_idx}"));
        param_values.push(Box::new(limit));

        let param_refs: Vec<&dyn rusqlite::types::ToSql> =
            param_values.iter().map(|p| p.as_ref()).collect();

        let mut stmt = self.conn.prepare(&sql)?;
        let symbols = stmt
            .query_map(param_refs.as_slice(), |row| {
                let kind_str: String = row.get(3)?;
                Ok(Symbol {
                    id: Some(row.get(0)?),
                    file_id: row.get(1)?,
                    name: row.get(2)?,
                    kind: SymbolKind::from_str_lossy(&kind_str).unwrap_or(SymbolKind::Function),
                    start_line: row.get(4)?,
                    end_line: row.get(5)?,
                    signature: row.get(6)?,
                    doc_comment: row.get(7)?,
                    parent_id: row.get(8)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(symbols)
    }

    /// Get all symbols for a specific file by its path.
    pub fn get_file_symbols(&self, path: &str) -> Result<Vec<Symbol>, IndexError> {
        let file_id: i64 = self
            .conn
            .query_row(
                "SELECT id FROM indexed_files WHERE path = ?1",
                params![path],
                |row| row.get(0),
            )
            .map_err(|_| IndexError::NotIndexed(path.to_string()))?;

        let mut stmt = self.conn.prepare(
            "SELECT id, file_id, name, kind, start_line, end_line, signature, doc_comment, parent_id
             FROM symbols WHERE file_id = ?1 ORDER BY start_line ASC",
        )?;

        let symbols = stmt
            .query_map(params![file_id], |row| {
                let kind_str: String = row.get(3)?;
                Ok(Symbol {
                    id: Some(row.get(0)?),
                    file_id: row.get(1)?,
                    name: row.get(2)?,
                    kind: SymbolKind::from_str_lossy(&kind_str).unwrap_or(SymbolKind::Function),
                    start_line: row.get(4)?,
                    end_line: row.get(5)?,
                    signature: row.get(6)?,
                    doc_comment: row.get(7)?,
                    parent_id: row.get(8)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(symbols)
    }

    /// Check if a file is stale (hash differs from what was indexed).
    /// Returns true if the file needs re-indexing.
    pub fn is_stale(&self, path: &str, current_hash: &str) -> Result<bool, IndexError> {
        let stored_hash: Result<String, _> = self.conn.query_row(
            "SELECT hash FROM indexed_files WHERE path = ?1",
            params![path],
            |row| row.get(0),
        );

        match stored_hash {
            Ok(hash) => Ok(hash != current_hash),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(true), // Not indexed yet.
            Err(e) => Err(IndexError::Database(e)),
        }
    }

    /// Return aggregate stats about the index.
    pub fn stats(&self) -> Result<IndexStats, IndexError> {
        let total_files: u64 = self.conn.query_row(
            "SELECT COUNT(*) FROM indexed_files",
            [],
            |row| row.get(0),
        )?;

        let total_symbols: u64 = self.conn.query_row(
            "SELECT COUNT(*) FROM symbols",
            [],
            |row| row.get(0),
        )?;

        let mut stmt = self.conn.prepare(
            "SELECT language, COUNT(*) FROM indexed_files GROUP BY language ORDER BY COUNT(*) DESC",
        )?;
        let languages = stmt
            .query_map([], |row| {
                let lang: String = row.get(0)?;
                let count: u64 = row.get(1)?;
                Ok((lang, count))
            })?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(IndexStats {
            total_files,
            total_symbols,
            languages,
        })
    }

    /// Get the indexed file record for a path, if it exists.
    pub fn get_indexed_file(&self, path: &str) -> Result<Option<IndexedFile>, IndexError> {
        let result = self.conn.query_row(
            "SELECT id, path, hash, language, indexed_at, symbol_count
             FROM indexed_files WHERE path = ?1",
            params![path],
            |row| {
                Ok(IndexedFile {
                    id: row.get(0)?,
                    path: row.get(1)?,
                    hash: row.get(2)?,
                    language: row.get(3)?,
                    indexed_at: row.get(4)?,
                    symbol_count: row.get(5)?,
                })
            },
        );

        match result {
            Ok(f) => Ok(Some(f)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(IndexError::Database(e)),
        }
    }

    /// List all indexed file paths.
    pub fn list_indexed_files(&self) -> Result<Vec<IndexedFile>, IndexError> {
        let mut stmt = self.conn.prepare(
            "SELECT id, path, hash, language, indexed_at, symbol_count
             FROM indexed_files ORDER BY path ASC",
        )?;

        let files = stmt
            .query_map([], |row| {
                Ok(IndexedFile {
                    id: row.get(0)?,
                    path: row.get(1)?,
                    hash: row.get(2)?,
                    language: row.get(3)?,
                    indexed_at: row.get(4)?,
                    symbol_count: row.get(5)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(files)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_open_in_memory() {
        let store = SymbolStore::open_in_memory().unwrap();
        let stats = store.stats().unwrap();
        assert_eq!(stats.total_files, 0);
        assert_eq!(stats.total_symbols, 0);
    }

    #[test]
    fn test_upsert_and_query() {
        let mut store = SymbolStore::open_in_memory().unwrap();

        let symbols = vec![Symbol {
            id: None,
            file_id: 0,
            name: "main".to_string(),
            kind: SymbolKind::Function,
            start_line: 1,
            end_line: 10,
            signature: Some("fn main()".to_string()),
            doc_comment: None,
            parent_id: None,
        }];

        let file_id = store
            .upsert_file("src/main.rs", "abc123", "rust", &symbols)
            .unwrap();
        assert!(file_id > 0);

        let found = store
            .find_symbols(&SymbolQuery {
                name: Some("main".to_string()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].name, "main");

        let stats = store.stats().unwrap();
        assert_eq!(stats.total_files, 1);
        assert_eq!(stats.total_symbols, 1);
    }

    #[test]
    fn test_is_stale() {
        let mut store = SymbolStore::open_in_memory().unwrap();
        assert!(store.is_stale("foo.rs", "hash1").unwrap());

        store.upsert_file("foo.rs", "hash1", "rust", &[]).unwrap();
        assert!(!store.is_stale("foo.rs", "hash1").unwrap());
        assert!(store.is_stale("foo.rs", "hash2").unwrap());
    }
}
