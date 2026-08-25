use std::path::Path;

/// Supported languages for symbol extraction.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Language {
    Rust,
    TypeScript,
    JavaScript,
    Python,
    Go,
    Java,
    C,
    Cpp,
}

impl Language {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Rust => "rust",
            Self::TypeScript => "typescript",
            Self::JavaScript => "javascript",
            Self::Python => "python",
            Self::Go => "go",
            Self::Java => "java",
            Self::C => "c",
            Self::Cpp => "cpp",
        }
    }
}

/// Detect language from a file path based on its extension.
pub fn detect_language(path: &Path) -> Option<Language> {
    let ext = path.extension()?.to_str()?;
    match ext {
        "rs" => Some(Language::Rust),
        "ts" | "tsx" => Some(Language::TypeScript),
        "js" | "jsx" => Some(Language::JavaScript),
        "py" => Some(Language::Python),
        "go" => Some(Language::Go),
        "java" => Some(Language::Java),
        "c" | "h" => Some(Language::C),
        "cpp" | "hpp" | "cc" | "cxx" => Some(Language::Cpp),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_detect_language() {
        assert_eq!(detect_language(Path::new("main.rs")), Some(Language::Rust));
        assert_eq!(
            detect_language(Path::new("app.tsx")),
            Some(Language::TypeScript)
        );
        assert_eq!(
            detect_language(Path::new("index.js")),
            Some(Language::JavaScript)
        );
        assert_eq!(
            detect_language(Path::new("script.py")),
            Some(Language::Python)
        );
        assert_eq!(detect_language(Path::new("main.go")), Some(Language::Go));
        assert_eq!(detect_language(Path::new("App.java")), Some(Language::Java));
        assert_eq!(detect_language(Path::new("utils.c")), Some(Language::C));
        assert_eq!(detect_language(Path::new("utils.h")), Some(Language::C));
        assert_eq!(detect_language(Path::new("utils.cpp")), Some(Language::Cpp));
        assert_eq!(detect_language(Path::new("README.md")), None);
    }
}
