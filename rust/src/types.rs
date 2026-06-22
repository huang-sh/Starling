//! Core data types — mirrors src/types.ts.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Note {
    pub id: String,
    pub content: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Bookmark {
    pub id: String,
    pub provider: String,
    pub session_id: String,
    pub title: String,
    pub category: String,
    pub tags: Vec<String>,
    pub project_path: String,
    pub first_prompt: String,
    pub notes: Vec<Note>,
    pub space_ids: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Space {
    pub id: String,
    pub name: String,
    pub description: String,
    pub tags: Vec<String>,
    pub parent_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Store {
    pub version: u32,
    pub bookmarks: Vec<Bookmark>,
    pub spaces: Vec<Space>,
    pub categories: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenUsage {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub total_tokens: Option<u64>,
    pub cache_tokens: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionMeta {
    pub session_id: String,
    pub provider: String,
    pub model: String,
    pub project_path: String,
    pub first_prompt: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub custom_title: Option<String>,
    pub file_path: String,
    pub created_at: String,
    pub modified_at: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub token_usage: Option<TokenUsage>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RunStatus {
    Running,
    Completed,
    Errored,
    Crashed,
    Stale,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum RunSource {
    #[serde(rename = "starling-run")]
    StarlingRun,
    #[serde(rename = "detected")]
    Detected,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunRecord {
    pub run_id: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub session_id: Option<String>,
    pub provider: RunProvider,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub project_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub catalog_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub setting: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub pid: Option<u32>,
    pub status: RunStatus,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub exit_code: Option<i32>,
    pub started_at: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub ended_at: Option<String>,
    pub source: RunSource,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RunProvider {
    Claude,
    Codex,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunsFile {
    pub version: u32,
    pub runs: Vec<RunRecord>,
}
