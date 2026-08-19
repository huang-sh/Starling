//! Claude transcript conventions.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::agents::basename_lower;
use crate::constants::{expand_home, resolve_claude_config_dir};
use crate::core::session::{
    add_token_usage, basename_no_ext, extract_token_usage, first_prompt_from_message,
    has_cumulative_token_usage, merge_token_usage, JsonlEntry,
};
use crate::types::{SessionMeta, TokenUsage};

pub fn session_roots() -> Vec<PathBuf> {
    vec![resolve_claude_config_dir().join("projects")]
}

pub(crate) fn is_process_arg(arg: &str) -> bool {
    matches!(basename_lower(arg).as_str(), "claude" | "claude-code")
}

pub(crate) fn is_process_path(arg: &str) -> bool {
    let lower = arg.replace('\\', "/").to_ascii_lowercase();
    lower.ends_with("/claude") || lower.contains("/claude.js") || lower.ends_with("/claude-code")
}

#[derive(Debug)]
pub(crate) struct HookSession {
    pub session_id: String,
    pub transcript_path: Option<String>,
    pub cwd: Option<String>,
}

pub(crate) fn settings_path(args: &[String]) -> Option<PathBuf> {
    args.iter().enumerate().find_map(|(index, arg)| {
        if arg == "--settings" {
            args.get(index + 1).map(PathBuf::from)
        } else {
            arg.strip_prefix("--settings=").map(PathBuf::from)
        }
    })
}

pub(crate) fn process_hook_session(args: &[String]) -> Option<HookSession> {
    let settings_path = settings_path(args)?;
    let file_name = settings_path.file_name()?.to_string_lossy();
    let run_id = file_name.strip_suffix(".settings.json")?;
    let raw =
        std::fs::read_to_string(settings_path.with_file_name(format!("{run_id}.jsonl"))).ok()?;
    raw.lines().rev().find_map(|line| {
        let value: Value = serde_json::from_str(line.trim()).ok()?;
        Some(HookSession {
            session_id: value
                .get("session_id")
                .or_else(|| value.get("sessionId"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())?
                .to_ascii_lowercase(),
            transcript_path: value
                .get("transcript_path")
                .or_else(|| value.get("transcriptPath"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string),
            cwd: value
                .get("cwd")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string),
        })
    })
}

pub(crate) fn process_home(environ: &HashMap<String, String>) -> PathBuf {
    environ
        .get("CLAUDE_CONFIG_DIR")
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(expand_home)
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join(".claude"))
}

pub(crate) fn process_session_root(home: &Path) -> PathBuf {
    home.join("projects")
}

pub(crate) fn encode_cwd(cwd: &str) -> String {
    cwd.replace(['/', '\\', ':'], "-")
}

pub(crate) fn is_idle_notification(notification_type: &str, message: &str) -> bool {
    notification_type.eq_ignore_ascii_case("idle_prompt")
        || message.eq_ignore_ascii_case("Claude is waiting for your input")
}

pub(crate) fn is_legacy_idle_notification(source: &str, status: &str, message: &str) -> bool {
    source == "claude-hook:Notification"
        && status == "waiting"
        && (message.eq_ignore_ascii_case("Claude is waiting for your input")
            || message
                .to_ascii_lowercase()
                .starts_with("idle_prompt: claude is waiting for your input"))
}

pub fn extract_session(entries: &[JsonlEntry], file_path: &Path, modified_at: &str) -> SessionMeta {
    let mut session_id = String::new();
    let mut model = String::new();
    let mut project_path = String::new();
    let mut first_prompt = String::new();
    let mut custom_title = String::new();
    let mut token_usage = TokenUsage {
        input_tokens: None,
        output_tokens: None,
        total_tokens: None,
        cache_tokens: None,
    };
    let mut has_token_usage = false;

    for entry in entries {
        if let Some(record) = entry.as_record() {
            if session_id.is_empty() {
                if let Some(value) = record.get("sessionId").and_then(Value::as_str) {
                    session_id = value.to_string();
                }
            }
            if entry.type_str() == Some("custom-title") {
                if let Some(value) = record.get("customTitle").and_then(Value::as_str) {
                    let trimmed = value.trim();
                    if !trimmed.is_empty() {
                        custom_title = trimmed.to_string();
                    }
                }
            }
            if model.is_empty() {
                let candidate = record.get("model").and_then(Value::as_str).or_else(|| {
                    record
                        .get("message")
                        .and_then(|message| message.get("model"))
                        .and_then(Value::as_str)
                });
                if let Some(candidate) = candidate {
                    if !candidate.starts_with('<') && candidate != "synthetic" {
                        model = candidate.to_string();
                    }
                }
            }
            if project_path.is_empty() {
                if let Some(cwd) = record.get("cwd").and_then(Value::as_str) {
                    project_path = cwd.to_string();
                }
            }
            if matches!(entry.type_str(), Some("user" | "human")) && first_prompt.is_empty() {
                if let Some(message) = record.get("message") {
                    let prompt = first_prompt_from_message(message);
                    if !prompt.is_empty() {
                        first_prompt = prompt;
                    }
                }
            }
        }

        if let Some(entry_usage) = extract_token_usage(entry) {
            if has_cumulative_token_usage(entry.value(), 0) {
                merge_token_usage(&mut token_usage, &entry_usage);
            } else {
                add_token_usage(&mut token_usage, &entry_usage);
            }
            has_token_usage = true;
        }
    }

    if session_id.is_empty() {
        session_id = basename_no_ext(file_path);
    }

    SessionMeta {
        session_id,
        provider: "claude".into(),
        model,
        project_path,
        first_prompt: first_prompt.chars().take(200).collect(),
        custom_title: (!custom_title.is_empty()).then_some(custom_title),
        file_path: file_path.to_string_lossy().to_string(),
        created_at: modified_at.to_string(),
        modified_at: modified_at.to_string(),
        token_usage: has_token_usage.then_some(token_usage),
    }
}
