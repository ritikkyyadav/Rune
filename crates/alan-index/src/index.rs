use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use regex::Regex;
use sha2::{Digest, Sha256};
use tracing::{debug, info, instrument, warn};
use walkdir::WalkDir;

use crate::error::IndexError;
use crate::languages::{detect_language, Language};
use crate::query::{Symbol, SymbolKind};
use crate::store::SymbolStore;

/// Holds compiled regex patterns for a single language.
struct LanguagePatterns {
    patterns: Vec<SymbolPattern>,
}

struct SymbolPattern {
    regex: Regex,
    kind: SymbolKind,
    /// Which capture group holds the symbol name.
    name_group: usize,
}

/// The main indexer that walks directories, extracts symbols, and stores them.
pub struct Indexer {
    store: SymbolStore,
    root: PathBuf,
    patterns: HashMap<Language, LanguagePatterns>,
}

/// Directories to skip when walking the file tree.
const SKIP_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "__pycache__",
    ".venv",
    "venv",
    "dist",
    "build",
    ".next",
    "vendor",
];

impl Indexer {
    /// Create a new indexer rooted at the given directory.
    #[instrument(skip_all, fields(root = %root.as_ref().display()))]
    pub fn new(root: impl AsRef<Path>, store: SymbolStore) -> Result<Self, IndexError> {
        let patterns = build_all_patterns()?;
        let root = root.as_ref().to_path_buf();
        info!(root = %root.display(), "indexer created");
        Ok(Self {
            store,
            root,
            patterns,
        })
    }

    /// Index a single file: read it, detect language, extract symbols, store.
    #[instrument(skip(self), fields(path = %path.as_ref().display()))]
    pub fn index_file(&mut self, path: impl AsRef<Path>) -> Result<usize, IndexError> {
        let path = path.as_ref();
        let language = match detect_language(path) {
            Some(lang) => lang,
            None => {
                debug!("unsupported language, skipping");
                return Ok(0);
            }
        };

        let content = fs::read_to_string(path)?;
        let hash = file_hash(&content);

        let canonical = path.to_string_lossy().to_string();

        // Skip if unchanged.
        if !self.store.is_stale(&canonical, &hash)? {
            debug!("file unchanged, skipping");
            return Ok(0);
        }

        let symbols = self.extract_symbols(&content, language);
        let count = symbols.len();

        self.store
            .upsert_file(&canonical, &hash, language.as_str(), &symbols)?;

        debug!(symbols = count, "indexed file");
        Ok(count)
    }

    /// Walk the root directory and index all supported files.
    #[instrument(skip(self))]
    pub fn index_directory(&mut self) -> Result<IndexSummary, IndexError> {
        let root = self.root.clone();
        let mut summary = IndexSummary::default();

        for entry in WalkDir::new(&root).into_iter().filter_entry(|e| {
            // Skip hidden and known non-source directories.
            if e.file_type().is_dir() {
                let name = e.file_name().to_string_lossy();
                return !SKIP_DIRS.contains(&name.as_ref());
            }
            true
        }) {
            let entry = entry?;
            if !entry.file_type().is_file() {
                continue;
            }

            let path = entry.path();
            if detect_language(path).is_none() {
                continue;
            }

            match self.index_file(path) {
                Ok(count) => {
                    summary.files_indexed += 1;
                    summary.symbols_extracted += count;
                }
                Err(e) => {
                    warn!(path = %path.display(), error = %e, "failed to index file");
                    summary.files_failed += 1;
                }
            }
        }

        info!(
            files = summary.files_indexed,
            symbols = summary.symbols_extracted,
            failed = summary.files_failed,
            "directory indexing complete"
        );
        Ok(summary)
    }

    /// Find files whose content has changed since last index and re-index them.
    #[instrument(skip(self))]
    pub fn reindex_stale(&mut self) -> Result<IndexSummary, IndexError> {
        let root = self.root.clone();
        let mut summary = IndexSummary::default();

        for entry in WalkDir::new(&root).into_iter().filter_entry(|e| {
            if e.file_type().is_dir() {
                let name = e.file_name().to_string_lossy();
                return !SKIP_DIRS.contains(&name.as_ref());
            }
            true
        }) {
            let entry = entry?;
            if !entry.file_type().is_file() {
                continue;
            }

            let path = entry.path();
            if detect_language(path).is_none() {
                continue;
            }

            // Read content and check hash.
            let content = match fs::read_to_string(path) {
                Ok(c) => c,
                Err(e) => {
                    warn!(path = %path.display(), error = %e, "failed to read file");
                    summary.files_failed += 1;
                    continue;
                }
            };
            let hash = file_hash(&content);
            let canonical = path.to_string_lossy().to_string();

            if !self.store.is_stale(&canonical, &hash)? {
                continue;
            }

            match self.index_file(path) {
                Ok(count) => {
                    summary.files_indexed += 1;
                    summary.symbols_extracted += count;
                }
                Err(e) => {
                    warn!(path = %path.display(), error = %e, "failed to reindex file");
                    summary.files_failed += 1;
                }
            }
        }

        info!(
            files = summary.files_indexed,
            symbols = summary.symbols_extracted,
            "stale reindex complete"
        );
        Ok(summary)
    }

    /// Get a reference to the underlying symbol store.
    pub fn store(&self) -> &SymbolStore {
        &self.store
    }

    /// Get a mutable reference to the underlying symbol store.
    pub fn store_mut(&mut self) -> &mut SymbolStore {
        &mut self.store
    }

    /// Extract symbols from source text using regex patterns for the given language.
    fn extract_symbols(&self, content: &str, language: Language) -> Vec<Symbol> {
        let lang_patterns = match self.patterns.get(&language) {
            Some(p) => p,
            None => return Vec::new(),
        };

        let lines: Vec<&str> = content.lines().collect();
        let mut symbols = Vec::new();

        for (line_idx, line) in lines.iter().enumerate() {
            let line_num = (line_idx + 1) as u32;

            for pattern in &lang_patterns.patterns {
                if let Some(captures) = pattern.regex.captures(line) {
                    let name = match captures.get(pattern.name_group) {
                        Some(m) => m.as_str().to_string(),
                        None => continue,
                    };

                    // Skip obviously invalid names.
                    if name.is_empty() || name == "_" {
                        continue;
                    }

                    // Collect preceding doc comment.
                    let doc_comment = collect_doc_comment(&lines, line_idx, language);

                    // Estimate end line (simple heuristic: look for matching brace depth
                    // or use same line for single-line items).
                    let end_line = estimate_end_line(&lines, line_idx);

                    let signature = line.trim().to_string();

                    symbols.push(Symbol {
                        id: None,
                        file_id: 0, // Will be set by store.
                        name,
                        kind: pattern.kind,
                        start_line: line_num,
                        end_line,
                        signature: Some(signature),
                        doc_comment,
                        parent_id: None,
                    });

                    // Only match the first pattern per line.
                    break;
                }
            }
        }

        symbols
    }
}

/// Summary of an indexing operation.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct IndexSummary {
    pub files_indexed: usize,
    pub symbols_extracted: usize,
    pub files_failed: usize,
}

/// Compute a SHA-256 hash of the file content.
fn file_hash(content: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    hex::encode(hasher.finalize())
}

/// Collect doc comments preceding a symbol definition.
fn collect_doc_comment(lines: &[&str], symbol_line: usize, language: Language) -> Option<String> {
    if symbol_line == 0 {
        return None;
    }

    let mut doc_lines = Vec::new();
    let mut i = symbol_line;

    loop {
        if i == 0 {
            break;
        }
        i -= 1;

        let trimmed = lines[i].trim();
        let is_doc = match language {
            Language::Rust => trimmed.starts_with("///") || trimmed.starts_with("//!"),
            Language::Python => trimmed.starts_with('#'),
            Language::Go => trimmed.starts_with("//"),
            Language::Java => {
                trimmed.starts_with("//")
                    || trimmed.starts_with('*')
                    || trimmed.starts_with("/**")
                    || trimmed.starts_with("*/")
            }
            Language::TypeScript | Language::JavaScript => {
                trimmed.starts_with("//")
                    || trimmed.starts_with('*')
                    || trimmed.starts_with("/**")
                    || trimmed.starts_with("*/")
            }
            Language::C | Language::Cpp => {
                trimmed.starts_with("//")
                    || trimmed.starts_with('*')
                    || trimmed.starts_with("/**")
                    || trimmed.starts_with("*/")
            }
        };

        if is_doc {
            doc_lines.push(trimmed.to_string());
        } else if trimmed.is_empty() {
            // Allow one blank line in doc comments.
            if i > 0 {
                let prev = lines[i - 1].trim();
                let prev_is_doc = match language {
                    Language::Rust => prev.starts_with("///") || prev.starts_with("//!"),
                    _ => prev.starts_with("//") || prev.starts_with('*'),
                };
                if !prev_is_doc {
                    break;
                }
            } else {
                break;
            }
        } else {
            break;
        }
    }

    if doc_lines.is_empty() {
        return None;
    }

    doc_lines.reverse();
    Some(doc_lines.join("\n"))
}

/// Estimate the end line of a symbol by tracking brace depth.
fn estimate_end_line(lines: &[&str], start: usize) -> u32 {
    let start_line = lines[start];
    let mut depth: i32 = 0;
    let mut found_open = false;

    for (i, line) in lines.iter().enumerate().skip(start) {
        for ch in line.chars() {
            match ch {
                '{' => {
                    depth += 1;
                    found_open = true;
                }
                '}' => {
                    depth -= 1;
                    if found_open && depth == 0 {
                        return (i + 1) as u32;
                    }
                }
                _ => {}
            }
        }
    }

    // If no braces found (e.g., Python, single-line const), scan for next blank line
    // or next definition.
    if !found_open {
        // For languages with indentation-based scoping, look for de-indent.
        let base_indent = start_line.len() - start_line.trim_start().len();
        for (i, line) in lines.iter().enumerate().skip(start + 1) {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let indent = line.len() - trimmed.len();
            if indent <= base_indent {
                return i as u32; // End is the line before the de-indented line.
            }
        }
    }

    // Fallback: same line.
    (start + 1) as u32
}

/// Build compiled regex patterns for all supported languages.
fn build_all_patterns() -> Result<HashMap<Language, LanguagePatterns>, IndexError> {
    let mut map = HashMap::new();

    map.insert(Language::Rust, build_rust_patterns()?);
    map.insert(Language::TypeScript, build_typescript_patterns()?);
    map.insert(Language::JavaScript, build_javascript_patterns()?);
    map.insert(Language::Python, build_python_patterns()?);
    map.insert(Language::Go, build_go_patterns()?);
    map.insert(Language::Java, build_java_patterns()?);
    map.insert(Language::C, build_c_patterns()?);
    map.insert(Language::Cpp, build_cpp_patterns()?);

    Ok(map)
}

fn build_rust_patterns() -> Result<LanguagePatterns, IndexError> {
    Ok(LanguagePatterns {
        patterns: vec![
            SymbolPattern {
                regex: Regex::new(r"(?:pub\s+)?(?:async\s+)?fn\s+(\w+)")?,
                kind: SymbolKind::Function,
                name_group: 1,
            },
            SymbolPattern {
                regex: Regex::new(r"(?:pub\s+)?struct\s+(\w+)")?,
                kind: SymbolKind::Struct,
                name_group: 1,
            },
            SymbolPattern {
                regex: Regex::new(r"(?:pub\s+)?enum\s+(\w+)")?,
                kind: SymbolKind::Enum,
                name_group: 1,
            },
            SymbolPattern {
                regex: Regex::new(r"(?:pub\s+)?trait\s+(\w+)")?,
                kind: SymbolKind::Trait,
                name_group: 1,
            },
            SymbolPattern {
                regex: Regex::new(r"impl\s+(\w+)")?,
                kind: SymbolKind::Impl,
                name_group: 1,
            },
        ],
    })
}

fn build_typescript_patterns() -> Result<LanguagePatterns, IndexError> {
    Ok(LanguagePatterns {
        patterns: vec![
            SymbolPattern {
                regex: Regex::new(r"(?:export\s+)?(?:async\s+)?function\s+(\w+)")?,
                kind: SymbolKind::Function,
                name_group: 1,
            },
            SymbolPattern {
                regex: Regex::new(r"(?:export\s+)?class\s+(\w+)")?,
                kind: SymbolKind::Class,
                name_group: 1,
            },
            SymbolPattern {
                regex: Regex::new(r"(?:export\s+)?interface\s+(\w+)")?,
                kind: SymbolKind::Interface,
                name_group: 1,
            },
            SymbolPattern {
                regex: Regex::new(r"(?:export\s+)?type\s+(\w+)")?,
                kind: SymbolKind::Type,
                name_group: 1,
            },
            SymbolPattern {
                regex: Regex::new(r"(?:export\s+)?const\s+(\w+)\s*=")?,
                kind: SymbolKind::Constant,
                name_group: 1,
            },
        ],
    })
}

fn build_javascript_patterns() -> Result<LanguagePatterns, IndexError> {
    // JavaScript shares patterns with TypeScript minus type/interface.
    Ok(LanguagePatterns {
        patterns: vec![
            SymbolPattern {
                regex: Regex::new(r"(?:export\s+)?(?:async\s+)?function\s+(\w+)")?,
                kind: SymbolKind::Function,
                name_group: 1,
            },
            SymbolPattern {
                regex: Regex::new(r"(?:export\s+)?class\s+(\w+)")?,
                kind: SymbolKind::Class,
                name_group: 1,
            },
            SymbolPattern {
                regex: Regex::new(r"(?:export\s+)?const\s+(\w+)\s*=")?,
                kind: SymbolKind::Constant,
                name_group: 1,
            },
        ],
    })
}

fn build_python_patterns() -> Result<LanguagePatterns, IndexError> {
    Ok(LanguagePatterns {
        patterns: vec![
            SymbolPattern {
                regex: Regex::new(r"^\s*def\s+(\w+)")?,
                kind: SymbolKind::Function,
                name_group: 1,
            },
            SymbolPattern {
                regex: Regex::new(r"^\s*class\s+(\w+)")?,
                kind: SymbolKind::Class,
                name_group: 1,
            },
        ],
    })
}

fn build_go_patterns() -> Result<LanguagePatterns, IndexError> {
    Ok(LanguagePatterns {
        patterns: vec![
            // Method: func (receiver) Name(...)
            SymbolPattern {
                regex: Regex::new(r"^func\s+\([^)]*\)\s+(\w+)")?,
                kind: SymbolKind::Method,
                name_group: 1,
            },
            // Function: func Name(...)
            SymbolPattern {
                regex: Regex::new(r"^func\s+(\w+)")?,
                kind: SymbolKind::Function,
                name_group: 1,
            },
            SymbolPattern {
                regex: Regex::new(r"^type\s+(\w+)\s+struct")?,
                kind: SymbolKind::Struct,
                name_group: 1,
            },
            SymbolPattern {
                regex: Regex::new(r"^type\s+(\w+)\s+interface")?,
                kind: SymbolKind::Interface,
                name_group: 1,
            },
        ],
    })
}

fn build_java_patterns() -> Result<LanguagePatterns, IndexError> {
    Ok(LanguagePatterns {
        patterns: vec![
            SymbolPattern {
                regex: Regex::new(r"(?:public|private|protected)?\s*class\s+(\w+)")?,
                kind: SymbolKind::Class,
                name_group: 1,
            },
            SymbolPattern {
                regex: Regex::new(r"(?:public|private|protected)?\s*interface\s+(\w+)")?,
                kind: SymbolKind::Interface,
                name_group: 1,
            },
            SymbolPattern {
                regex: Regex::new(r"(?:public|private|protected)?\s*enum\s+(\w+)")?,
                kind: SymbolKind::Enum,
                name_group: 1,
            },
            // Method: access modifier + optional static + return type + name(
            SymbolPattern {
                regex: Regex::new(
                    r"(?:public|private|protected)\s+(?:static\s+)?(?:[\w<>\[\],\s]+)\s+(\w+)\s*\(",
                )?,
                kind: SymbolKind::Method,
                name_group: 1,
            },
        ],
    })
}

fn build_c_patterns() -> Result<LanguagePatterns, IndexError> {
    Ok(LanguagePatterns {
        patterns: vec![
            // Function: return_type name(
            SymbolPattern {
                regex: Regex::new(r"^(?:static\s+)?(?:inline\s+)?(?:\w+[\s*]+)(\w+)\s*\(")?,
                kind: SymbolKind::Function,
                name_group: 1,
            },
            SymbolPattern {
                regex: Regex::new(r"(?:typedef\s+)?struct\s+(\w+)")?,
                kind: SymbolKind::Struct,
                name_group: 1,
            },
            SymbolPattern {
                regex: Regex::new(r"(?:typedef\s+)?enum\s+(\w+)")?,
                kind: SymbolKind::Enum,
                name_group: 1,
            },
        ],
    })
}

fn build_cpp_patterns() -> Result<LanguagePatterns, IndexError> {
    Ok(LanguagePatterns {
        patterns: vec![
            SymbolPattern {
                regex: Regex::new(r"class\s+(\w+)")?,
                kind: SymbolKind::Class,
                name_group: 1,
            },
            SymbolPattern {
                regex: Regex::new(r"struct\s+(\w+)")?,
                kind: SymbolKind::Struct,
                name_group: 1,
            },
            SymbolPattern {
                regex: Regex::new(r"enum\s+(?:class\s+)?(\w+)")?,
                kind: SymbolKind::Enum,
                name_group: 1,
            },
            // Function/method.
            SymbolPattern {
                regex: Regex::new(
                    r"^(?:virtual\s+)?(?:static\s+)?(?:inline\s+)?(?:\w+[\s*&]+)(\w+)\s*\(",
                )?,
                kind: SymbolKind::Function,
                name_group: 1,
            },
        ],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_indexer() -> Indexer {
        let store = SymbolStore::open_in_memory().unwrap();
        let tmp = std::env::temp_dir();
        Indexer::new(tmp, store).unwrap()
    }

    #[test]
    fn test_extract_rust_symbols() {
        let indexer = make_indexer();
        let code = r#"
/// Docs for main.
pub fn main() {
    println!("hello");
}

pub struct Config {
    name: String,
}

pub enum Status {
    Active,
    Inactive,
}

pub trait Handler {
    fn handle(&self);
}

impl Config {
    pub fn new() -> Self {
        Config { name: String::new() }
    }
}
"#;
        let symbols = indexer.extract_symbols(code, Language::Rust);
        let names: Vec<&str> = symbols.iter().map(|s| s.name.as_str()).collect();
        assert!(names.contains(&"main"));
        assert!(names.contains(&"Config"));
        assert!(names.contains(&"Status"));
        assert!(names.contains(&"Handler"));

        // Check doc comment was captured for main.
        let main_sym = symbols.iter().find(|s| s.name == "main").unwrap();
        assert!(main_sym.doc_comment.is_some());
        assert!(main_sym.doc_comment.as_ref().unwrap().contains("Docs for main"));
    }

    #[test]
    fn test_extract_python_symbols() {
        let indexer = make_indexer();
        let code = r#"
class MyClass:
    def __init__(self):
        pass

    def method(self):
        pass

def standalone():
    pass
"#;
        let symbols = indexer.extract_symbols(code, Language::Python);
        let names: Vec<&str> = symbols.iter().map(|s| s.name.as_str()).collect();
        assert!(names.contains(&"MyClass"));
        assert!(names.contains(&"__init__"));
        assert!(names.contains(&"method"));
        assert!(names.contains(&"standalone"));
    }

    #[test]
    fn test_extract_typescript_symbols() {
        let indexer = make_indexer();
        let code = r#"
export function greet(name: string): void {}
export class App {}
export interface Config {}
export type ID = string;
export const VERSION = "1.0";
"#;
        let symbols = indexer.extract_symbols(code, Language::TypeScript);
        let names: Vec<&str> = symbols.iter().map(|s| s.name.as_str()).collect();
        assert!(names.contains(&"greet"));
        assert!(names.contains(&"App"));
        assert!(names.contains(&"Config"));
        assert!(names.contains(&"ID"));
        assert!(names.contains(&"VERSION"));
    }

    #[test]
    fn test_extract_go_symbols() {
        let indexer = make_indexer();
        let code = r#"
func main() {}
func (s *Server) Start() error {}
type Config struct {}
type Handler interface {}
"#;
        let symbols = indexer.extract_symbols(code, Language::Go);
        let names: Vec<&str> = symbols.iter().map(|s| s.name.as_str()).collect();
        assert!(names.contains(&"main"));
        assert!(names.contains(&"Start"));
        assert!(names.contains(&"Config"));
        assert!(names.contains(&"Handler"));
    }

    #[test]
    fn test_file_hash() {
        let h1 = file_hash("hello");
        let h2 = file_hash("hello");
        let h3 = file_hash("world");
        assert_eq!(h1, h2);
        assert_ne!(h1, h3);
    }
}
