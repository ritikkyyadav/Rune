use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use crate::error::AlanError;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EngineConfig {
    pub socket_path: PathBuf,
    pub log_dir: PathBuf,
    pub db_path: PathBuf,
    pub max_sessions: usize,
}

impl Default for EngineConfig {
    fn default() -> Self {
        let home = dirs::home_dir().expect("Cannot determine home directory");
        let alan_dir = home.join(".alan");
        Self {
            socket_path: alan_dir.join("alan.sock"),
            log_dir: alan_dir.join("logs"),
            db_path: alan_dir.join("alan.db"),
            max_sessions: 100,
        }
    }
}

impl EngineConfig {
    pub fn load(path: Option<&Path>) -> Result<Self, AlanError> {
        match path {
            Some(p) => {
                let content = std::fs::read_to_string(p)
                    .map_err(|e| AlanError::Config(format!("Cannot read config: {e}")))?;
                toml::from_str(&content)
                    .map_err(|e| AlanError::Config(format!("Invalid config: {e}")))
            }
            None => Ok(Self::default()),
        }
    }

    pub fn ensure_dirs(&self) -> Result<(), AlanError> {
        std::fs::create_dir_all(&self.log_dir)?;
        if let Some(parent) = self.db_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        if let Some(parent) = self.socket_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        Ok(())
    }
}
