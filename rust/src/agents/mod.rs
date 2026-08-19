//! Agent identity shared by commands, storage, discovery, and runtime code.
// Process-mapping callers (core/process_map.rs) still use their local copies;
// these helpers are the migration target. All are unit-tested in-module.
#![allow(dead_code)]

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::core::session::JsonlEntry;
use crate::types::SessionMeta;

pub mod claude;
pub mod codex;
pub mod pi;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentKind {
    Claude,
    Codex,
    Pi,
}

// Dispatch surface for callers migrating onto the agents module.
// ponytail: dead until session_index/discovery route through it.
#[allow(dead_code)]
impl AgentKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Pi => "pi",
        }
    }

    pub fn from_name(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "claude" => Some(Self::Claude),
            "codex" => Some(Self::Codex),
            "pi" => Some(Self::Pi),
            _ => None,
        }
    }

    pub fn session_roots(self) -> Vec<PathBuf> {
        match self {
            Self::Claude => claude::session_roots(),
            Self::Codex => codex::session_roots(),
            Self::Pi => pi::session_roots(),
        }
    }

    pub fn extract_session(
        self,
        entries: &[JsonlEntry],
        file_path: &Path,
        modified_at: &str,
    ) -> Option<SessionMeta> {
        match self {
            Self::Claude => Some(claude::extract_session(entries, file_path, modified_at)),
            Self::Codex if codex::is_subagent_session(entries) => None,
            Self::Codex => Some(codex::extract_session(entries, file_path, modified_at)),
            Self::Pi => Some(pi::extract_session(entries, file_path, modified_at)),
        }
    }

    pub fn canonical_session_id(self, session_id: &str) -> String {
        let trimmed = session_id.trim();
        if self == Self::Pi {
            return trimmed.to_string();
        }
        let lower = trimmed.to_ascii_lowercase();
        let parts: Vec<&str> = lower.split('-').collect();
        if parts.len() >= 5 {
            let candidate = parts[parts.len() - 5..].join("-");
            if looks_like_uuid(&candidate) {
                return candidate;
            }
        }
        if looks_like_uuid(&lower) || lower.starts_with("rollout-") {
            lower
        } else {
            trimmed.to_string()
        }
    }

    pub fn session_ids_are_case_sensitive(self, left: &str, right: &str) -> bool {
        self == Self::Pi && !(is_uuidish(left) && is_uuidish(right))
    }

    pub fn should_auto_archive(self, event: &str) -> bool {
        match self {
            Self::Pi => matches!(event, "Stop" | "StopFailure"),
            Self::Claude => event == "SessionStart",
            Self::Codex => matches!(event, "SessionStart" | "UserPromptSubmit"),
        }
    }

    pub fn from_cmdline(args: &[String]) -> Option<Self> {
        let executable = args.first().map(|arg| basename_lower(arg))?;
        match executable.trim_end_matches(".exe") {
            "claude" | "claude-code" => return Some(Self::Claude),
            "codex" => return Some(Self::Codex),
            "pi" | "starling" => return Some(Self::Pi),
            _ => {}
        }
        if is_javascript_runtime(&args[0]) && args.get(1).is_some_and(|arg| pi::is_node_entry(arg))
        {
            return Some(Self::Pi);
        }
        for arg in args.iter().take(4) {
            if claude::is_process_arg(arg) {
                return Some(Self::Claude);
            }
            if codex::is_process_arg(arg) {
                return Some(Self::Codex);
            }
        }
        for arg in args {
            if claude::is_process_path(arg) {
                return Some(Self::Claude);
            }
            if codex::is_process_path(arg) {
                return Some(Self::Codex);
            }
            if pi::is_cli_script(arg) {
                return Some(Self::Pi);
            }
        }
        None
    }

    pub fn process_home(self, environ: &HashMap<String, String>) -> PathBuf {
        match self {
            Self::Claude => claude::process_home(environ),
            Self::Codex => codex::process_home(environ),
            Self::Pi => pi::process_home(environ),
        }
    }

    pub fn process_session_root(self, home: &Path) -> PathBuf {
        match self {
            Self::Claude => claude::process_session_root(home),
            Self::Codex => codex::process_session_root(home),
            Self::Pi => pi::process_session_root(home),
        }
    }

    pub(crate) fn session_id_from_file(self, path: &Path) -> Option<String> {
        match self {
            Self::Pi => pi::session_id_from_file(path),
            Self::Claude | Self::Codex => is_session_file(path)
                .then(|| session_id_from_path(path))
                .flatten(),
        }
    }

    pub(crate) fn project_path_from_file(
        self,
        path: &Path,
        fallback: Option<&Path>,
    ) -> Option<PathBuf> {
        match self {
            Self::Pi => pi::project_path_from_file(path, fallback),
            Self::Claude | Self::Codex => fallback.map(Path::to_path_buf),
        }
    }
}

pub(crate) fn basename_lower(arg: &str) -> String {
    Path::new(arg)
        .file_name()
        .map(|value| value.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default()
}

fn is_javascript_runtime(arg: &str) -> bool {
    matches!(
        basename_lower(arg).trim_end_matches(".exe"),
        "node" | "nodejs" | "bun" | "deno"
    )
}

pub(crate) fn is_uuidish(value: &str) -> bool {
    let trimmed = value.trim();
    !trimmed.is_empty()
        && trimmed.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
        && trimmed.chars().filter(|c| *c != '-').count() >= 8
        && trimmed.chars().filter(|c| *c != '-').count() <= 32
}

pub(crate) fn looks_like_uuid(value: &str) -> bool {
    let mut parts = value.split('-');
    for expected in [8usize, 4, 4, 4, 12] {
        let Some(part) = parts.next() else {
            return false;
        };
        if part.len() != expected || !part.chars().all(|c| c.is_ascii_hexdigit()) {
            return false;
        }
    }
    parts.next().is_none()
}

pub(crate) fn session_id_from_path(path: impl AsRef<Path>) -> Option<String> {
    let path = path.as_ref();
    let name = path.file_stem()?.to_string_lossy();
    if let Some(session_id) = pi::session_id_from_file_stem(&name) {
        return Some(session_id);
    }
    Some(name.to_ascii_lowercase())
}

pub(crate) fn is_session_file(path: impl AsRef<Path>) -> bool {
    let path = path.as_ref();
    if !path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("jsonl"))
    {
        return false;
    }
    let Some(stem) = path.file_stem().and_then(|value| value.to_str()) else {
        return false;
    };
    pi::session_id_from_file_stem(stem).is_some()
        || looks_like_uuid(&stem.to_ascii_lowercase())
        || stem.to_ascii_lowercase().starts_with("rollout-")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::session::parse_jsonl_text;

    #[test]
    fn agent_names_round_trip() {
        for agent in [AgentKind::Claude, AgentKind::Codex, AgentKind::Pi] {
            assert_eq!(AgentKind::from_name(agent.as_str()), Some(agent));
            assert_eq!(
                serde_json::to_string(&agent).unwrap(),
                format!("\"{}\"", agent.as_str())
            );
        }
    }

    #[test]
    fn archive_event_follows_agent_transcript_lifecycle() {
        assert!(!AgentKind::Pi.should_auto_archive("SessionStart"));
        assert!(AgentKind::Pi.should_auto_archive("Stop"));
        assert!(AgentKind::Pi.should_auto_archive("StopFailure"));
        assert!(AgentKind::Claude.should_auto_archive("SessionStart"));
        assert!(AgentKind::Codex.should_auto_archive("SessionStart"));
        assert!(AgentKind::Codex.should_auto_archive("UserPromptSubmit"));
    }

    #[test]
    fn codex_subagent_rollout_is_not_a_top_level_session() {
        let child = parse_jsonl_text(
            r#"{"type":"session_meta","payload":{"id":"child","cwd":"/work","source":{"subagent":{"thread_spawn":{"parent_thread_id":"parent"}}}}}"#,
            10,
        );
        let guardian = parse_jsonl_text(
            r#"{"type":"session_meta","payload":{"id":"guardian","cwd":"/work","source":{"subagent":{"other":"guardian"}}}}"#,
            10,
        );
        let parent = parse_jsonl_text(
            r#"{"type":"session_meta","payload":{"id":"parent","cwd":"/work","source":"vscode"}}"#,
            10,
        );

        assert!(AgentKind::Codex
            .extract_session(&child, Path::new("/tmp/child.jsonl"), "now")
            .is_none());
        assert!(AgentKind::Codex
            .extract_session(&guardian, Path::new("/tmp/guardian.jsonl"), "now")
            .is_none());
        assert!(AgentKind::Codex
            .extract_session(&parent, Path::new("/tmp/parent.jsonl"), "now")
            .is_some());
    }

    #[test]
    fn codex_open_files_exclude_subagents() {
        let dir = std::env::temp_dir().join(format!(
            "starling-codex-open-files-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let parent = dir.join("11111111-1111-4111-8111-111111111111.jsonl");
        let guardian = dir.join("22222222-2222-4222-8222-222222222222.jsonl");
        std::fs::write(
            &parent,
            r#"{"type":"session_meta","payload":{"id":"parent","source":"vscode"}}"#,
        )
        .unwrap();
        std::fs::write(
            &guardian,
            r#"{"type":"session_meta","payload":{"id":"guardian","source":{"subagent":{"other":"guardian"}}}}"#,
        )
        .unwrap();

        let files = codex::open_session_files(vec![parent.clone(), guardian], None);

        assert_eq!(files, vec![parent]);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
