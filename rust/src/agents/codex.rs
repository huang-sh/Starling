//! Codex transcript conventions.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::agents::basename_lower;
use crate::agents::is_session_file;
use crate::constants::{default_starling_home, expand_home, resolve_codex_home};
use crate::core::session::{
    basename_no_ext, extract_token_usage, merge_token_usage, parse_jsonl_head, JsonlEntry,
};
use crate::types::{SessionMeta, TokenUsage};

pub fn session_roots() -> Vec<PathBuf> {
    let home = resolve_codex_home();
    let mut roots = vec![home.join("sessions"), home.join("archived_sessions")];
    let run_homes = default_starling_home().join("run-homes");
    if let Ok(entries) = std::fs::read_dir(run_homes) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir()
                || !path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .map(|name| name.starts_with("codex-"))
                    .unwrap_or(false)
            {
                continue;
            }
            for session_dir in [path.join("sessions"), path.join("archived_sessions")] {
                let is_symlink = std::fs::symlink_metadata(&session_dir)
                    .map(|metadata| metadata.file_type().is_symlink())
                    .unwrap_or(false);
                if !is_symlink {
                    roots.push(session_dir);
                }
            }
        }
    }
    roots
}

pub(crate) fn is_process_arg(arg: &str) -> bool {
    basename_lower(arg) == "codex"
}

pub(crate) fn is_process_path(arg: &str) -> bool {
    let lower = arg.replace('\\', "/").to_ascii_lowercase();
    lower.ends_with("/codex") || lower.contains("/codex.js")
}

pub(crate) fn process_home(environ: &HashMap<String, String>) -> PathBuf {
    environ
        .get("CODEX_HOME")
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(expand_home)
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join(".codex"))
}

pub(crate) fn process_session_root(home: &Path) -> PathBuf {
    home.join("sessions")
}

pub(crate) fn open_session_files(files: Vec<PathBuf>, home: Option<&Path>) -> Vec<PathBuf> {
    let root = home.map(process_session_root);
    let has_in_root = root
        .as_deref()
        .is_some_and(|root| files.iter().any(|file| file.starts_with(root)));
    files
        .into_iter()
        .filter(|file| is_session_file(file))
        .filter(|file| !has_in_root || root.as_deref().is_some_and(|root| file.starts_with(root)))
        .filter(|file| !is_subagent_session(&parse_jsonl_head(file, 20)))
        .collect()
}

pub(crate) fn is_abort_signal(signal: Option<&str>) -> bool {
    signal == Some("codex_turn_aborted")
}

pub(crate) fn is_complete_signal(signal: Option<&str>) -> bool {
    signal == Some("codex_task_complete")
}

pub(crate) fn is_subagent_session(entries: &[JsonlEntry]) -> bool {
    entries.iter().any(|entry| {
        entry.type_str() == Some("session_meta")
            && entry
                .value()
                .pointer("/payload/source/subagent")
                .is_some_and(Value::is_object)
    })
}

pub fn extract_session(entries: &[JsonlEntry], file_path: &Path, modified_at: &str) -> SessionMeta {
    let mut session_id = String::new();
    let mut model = String::new();
    let mut project_path = String::new();
    let mut first_prompt = String::new();
    let mut token_usage = TokenUsage {
        input_tokens: None,
        output_tokens: None,
        total_tokens: None,
        cache_tokens: None,
    };
    let mut has_token_usage = false;

    for entry in entries {
        if let Some(record) = entry.as_record() {
            if entry.type_str() == Some("session_meta") {
                if let Some(payload) = record.get("payload").and_then(Value::as_object) {
                    if session_id.is_empty() {
                        if let Some(id) = payload.get("id").and_then(Value::as_str) {
                            session_id = id.to_string();
                        }
                    }
                    if project_path.is_empty() {
                        if let Some(cwd) = payload.get("cwd").and_then(Value::as_str) {
                            project_path = cwd.to_string();
                        }
                    }
                    if model.is_empty() {
                        if let Some(provider) =
                            payload.get("model_provider").and_then(Value::as_str)
                        {
                            model = provider.to_string();
                        }
                    }
                }
            }
            if entry.type_str() == Some("event_msg") {
                if let Some(payload) = record.get("payload").and_then(Value::as_object) {
                    if payload.get("type").and_then(Value::as_str) == Some("user_message")
                        && first_prompt.is_empty()
                    {
                        if let Some(content) = payload
                            .get("content")
                            .and_then(Value::as_str)
                            .or_else(|| payload.get("message").and_then(Value::as_str))
                        {
                            first_prompt = content.to_string();
                        }
                    }
                }
            }
            if entry.type_str() == Some("turn_context") {
                if let Some(payload) = record.get("payload").and_then(Value::as_object) {
                    if model == "openai" {
                        if let Some(value) = payload.get("model").and_then(Value::as_str) {
                            model = value.to_string();
                        }
                    }
                }
            }
        }

        if let Some(entry_usage) = extract_token_usage(entry) {
            merge_token_usage(&mut token_usage, &entry_usage);
            has_token_usage = true;
        }
    }

    if session_id.is_empty() {
        session_id = basename_no_ext(file_path);
    }

    SessionMeta {
        session_id,
        provider: "codex".into(),
        model,
        project_path,
        first_prompt: first_prompt.chars().take(200).collect(),
        custom_title: None,
        file_path: file_path.to_string_lossy().to_string(),
        created_at: modified_at.to_string(),
        modified_at: modified_at.to_string(),
        token_usage: has_token_usage.then_some(token_usage),
    }
}
