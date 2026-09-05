use thiserror::Error;

#[derive(Error, Debug)]
pub enum IndexError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Database error: {0}")]
    Database(#[from] rusqlite::Error),

    #[error("Parse error: {0}")]
    Parse(String),

    #[error("Path not indexed: {0}")]
    NotIndexed(String),
}

impl From<serde_json::Error> for IndexError {
    fn from(e: serde_json::Error) -> Self {
        IndexError::Parse(e.to_string())
    }
}

impl From<regex::Error> for IndexError {
    fn from(e: regex::Error) -> Self {
        IndexError::Parse(e.to_string())
    }
}

impl From<walkdir::Error> for IndexError {
    fn from(e: walkdir::Error) -> Self {
        IndexError::Io(e.into())
    }
}

impl From<globset::Error> for IndexError {
    fn from(e: globset::Error) -> Self {
        IndexError::Parse(e.to_string())
    }
}
