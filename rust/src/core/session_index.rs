//! Session index — mirrors src/lib/sessionIndex.ts.
//!
//! Persisted JSON file mapping session IDs to metadata. Supports:
//!   - load/save (read-only fast path for catalog expand)
//!   - rebuild (full walk)
//!   - upsert / remove (single-session mutations)
//!   - aggregation into project summaries
//!   - freshness check (top-level mtime vs built_at)

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde::{Deserialize, Serialize};

use crate::constants::{claude_session_roots, codex_session_roots, default_starling_home, now_iso};
use crate::core::fs_utils::{atomic_write_json, read_json};
use crate::core::session::{extract_claude_session_meta, extract_codex_session_meta, parse_jsonl_head};
use crate::types::SessionMeta;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Claude,
    Codex,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexedSessionFile {
    pub session_id: String,
    pub provider: Provider,
    pub path: String,
    pub mtime_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexedSessionDirectory {
    pub provider: Provider,
    pub path: String,
    pub mtime_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectSummary {
    pub project_path: String,
    pub session_count: u32,
    pub agents: HashMap<String, u32>,
    pub models: HashMap<String, u32>,
    pub first_active: String,
    pub last_active: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectStats {
    pub project_path: String,
    pub session_count: u32,
    pub agents: HashMap<String, u32>,
    pub models: HashMap<String, u32>,
    pub first_active: String,
    pub last_active: String,
    pub sessions: Vec<SessionMeta>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionIndex {
    pub version: u32,
    pub built_at: String,
    pub session_count: u32,
    pub project_count: u32,
    pub sessions: Vec<SessionMeta>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub files: Option<Vec<IndexedSessionFile>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub directories: Option<Vec<IndexedSessionDirectory>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub projects: Option<Vec<ProjectSummary>>,
}

pub fn session_index_path() -> PathBuf {
    default_starling_home().join("session-index.json")
}

pub fn load_session_index() -> Option<SessionIndex> {
    let path = session_index_path();
    let raw = std::fs::read_to_string(&path).ok()?;
    let parsed: SessionIndex = serde_json::from_str(&raw).ok()?;
    if parsed.version != 1 { return None; }
    Some(parsed)
}

fn provider_roots(filter: Option<Provider>) -> Vec<(Provider, PathBuf)> {
    let mut out = Vec::new();
    if filter.map(|f| f == Provider::Claude).unwrap_or(true) {
        for r in claude_session_roots() { out.push((Provider::Claude, r)); }
    }
    if filter.map(|f| f == Provider::Codex).unwrap_or(true) {
        for r in codex_session_roots() { out.push((Provider::Codex, r)); }
    }
    out
}

fn write_session_index(sessions: Vec<SessionMeta>, directories: Vec<IndexedSessionDirectory>) -> SessionIndex {
    let mut sessions = sessions;
    sessions.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));

    let projects = aggregate_project_summaries_from_sessions(&sessions);
    let files: Vec<IndexedSessionFile> = sessions.iter()
        .filter(|s| !s.file_path.is_empty())
        .map(|s| {
            let mtime_ms = chrono::DateTime::parse_from_rfc3339(&s.modified_at)
                .ok()
                .map(|dt| dt.timestamp_millis() as u64)
                .unwrap_or(0);
            let provider = if s.provider == "codex" { Provider::Codex } else { Provider::Claude };
            IndexedSessionFile {
                session_id: s.session_id.clone(),
                provider,
                path: s.file_path.clone(),
                mtime_ms,
            }
        })
        .collect();

    let index = SessionIndex {
        version: 1,
        built_at: now_iso(),
        session_count: sessions.len() as u32,
        project_count: projects.len() as u32,
        sessions,
        files: Some(files),
        directories: Some(directories),
        projects: Some(projects),
    };
    let path = session_index_path();
    let _ = atomic_write_json(&path, &index);
    index
}

fn upsert_session(sessions: &mut Vec<SessionMeta>, session: SessionMeta) {
    if let Some(slot) = sessions.iter_mut().find(|s| s.session_id == session.session_id) {
        *slot = session;
    } else {
        sessions.push(session);
    }
}

pub fn upsert_session_in_index(session: SessionMeta) -> bool {
    let index = match load_session_index() {
        Some(i) => i,
        None => return false,
    };
    let mut sessions = index.sessions.clone();
    upsert_session(&mut sessions, session);
    let dirs = index.directories.unwrap_or_default();
    write_session_index(sessions, dirs);
    true
}

pub fn remove_session_from_index(session_id: &str) -> bool {
    let index = match load_session_index() {
        Some(i) => i,
        None => return false,
    };
    let normalized = session_id.to_lowercase();
    let original_len = index.sessions.len();
    let sessions: Vec<SessionMeta> = index.sessions.into_iter()
        .filter(|s| s.session_id.to_lowercase() != normalized)
        .collect();
    if sessions.len() == original_len { return false; }
    let dirs = index.directories.unwrap_or_default();
    write_session_index(sessions, dirs);
    true
}

pub fn clear_session_index() -> bool {
    let path = session_index_path();
    if path.exists() {
        match std::fs::remove_file(&path) {
            Ok(_) => true,
            Err(_) => false,
        }
    } else {
        false
    }
}

/// Walk all session roots and rebuild the index from scratch.
pub fn rebuild_session_index(provider: Option<Provider>) -> SessionIndex {
    let mut sessions: Vec<SessionMeta> = Vec::new();
    for (p, root) in provider_roots(provider) {
        walk_and_collect(&root, p, &mut sessions);
    }
    let directories = collect_session_directory_entries(provider);
    write_session_index(sessions, directories)
}

fn walk_and_collect(dir: &Path, provider: Provider, out: &mut Vec<SessionMeta>) {
    let rd = match std::fs::read_dir(dir) { Ok(r) => r, Err(_) => return };
    for entry in rd.flatten() {
        let path = entry.path();
        if path.file_name().map(|n| n == "subagents").unwrap_or(false) { continue; }
        let md = match entry.metadata() { Ok(m) => m, Err(_) => continue };
        if md.is_dir() {
            walk_and_collect(&path, provider, out);
        } else if path.extension().map(|e| e == "jsonl").unwrap_or(false) {
            if let Some(meta) = parse_session_file(&path, provider) {
                out.push(meta);
            }
        }
    }
}

fn parse_session_file(path: &Path, provider: Provider) -> Option<SessionMeta> {
    let mtime = std::fs::metadata(path).ok()?.modified().ok()?
        .duration_since(SystemTime::UNIX_EPOCH).ok()?;
    let mtime_iso = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(mtime.as_millis() as i64)
        .map(|dt| dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true).replace("+00:00", "Z"))
        .unwrap_or_default();
    let entries = parse_jsonl_head(path, 500);
    let meta = match provider {
        Provider::Claude => extract_claude_session_meta(&entries, path, &mtime_iso),
        Provider::Codex => extract_codex_session_meta(&entries, path, &mtime_iso),
    };
    Some(meta)
}

fn collect_session_directory_entries(provider: Option<Provider>) -> Vec<IndexedSessionDirectory> {
    let mut dirs = Vec::new();
    for (p, root) in provider_roots(provider) {
        walk_dirs(&root, p, &mut dirs);
    }
    dirs
}

fn walk_dirs(dir: &Path, provider: Provider, out: &mut Vec<IndexedSessionDirectory>) {
    let md = match std::fs::metadata(dir) { Ok(m) => m, Err(_) => return };
    if !md.is_dir() { return; }
    let mtime = md.modified().ok()
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    out.push(IndexedSessionDirectory {
        provider, path: dir.to_string_lossy().to_string(), mtime_ms: mtime,
    });
    let rd = match std::fs::read_dir(dir) { Ok(r) => r, Err(_) => return };
    for entry in rd.flatten() {
        let path = entry.path();
        if path.file_name().map(|n| n == "subagents").unwrap_or(false) { continue; }
        if let Ok(child_md) = entry.metadata() {
            if child_md.is_dir() {
                walk_dirs(&path, provider, out);
            }
        }
    }
}

/// True when the index file doesn't exist or any root is newer than built_at.
pub fn is_session_index_stale(provider: Option<Provider>) -> bool {
    let path = session_index_path();
    let index_mtime = match std::fs::metadata(&path) {
        Ok(md) => md.modified().ok()
            .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0),
        Err(_) => return true,
    };
    let newest = newest_session_root_mtime(provider);
    newest > index_mtime
}

fn newest_session_root_mtime(provider: Option<Provider>) -> u64 {
    let mut newest = 0u64;
    for (_p, root) in provider_roots(provider) {
        newest = newest.max(newest_mtime_in_tree(&root));
    }
    newest
}

fn newest_mtime_in_tree(dir: &Path) -> u64 {
    let mut newest = 0u64;
    let rd = match std::fs::read_dir(dir) { Ok(r) => r, Err(_) => return 0 };
    for entry in rd.flatten() {
        let path = entry.path();
        if path.file_name().map(|n| n == "subagents").unwrap_or(false) { continue; }
        let md = match entry.metadata() { Ok(m) => m, Err(_) => continue };
        let mtime = md.modified().ok()
            .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        if md.is_dir() {
            newest = newest.max(newest_mtime_in_tree(&path));
        } else if path.extension().map(|e| e == "jsonl").unwrap_or(false) {
            newest = newest.max(mtime);
        }
    }
    newest
}

pub fn aggregate_projects_from_sessions(
    sessions: &[SessionMeta],
    provider_filter: Option<Provider>,
) -> Vec<ProjectStats> {
    let mut map: HashMap<String, Vec<SessionMeta>> = HashMap::new();
    for s in sessions {
        if let Some(p) = provider_filter {
            let sp = if s.provider == "codex" { Provider::Codex } else { Provider::Claude };
            if sp != p { continue; }
        }
        map.entry(s.project_path.clone()).or_default().push(s.clone());
    }

    let mut out: Vec<ProjectStats> = map.into_iter().map(|(project_path, mut sessions)| {
        sessions.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));
        let mut agents: HashMap<String, u32> = HashMap::new();
        let mut models: HashMap<String, u32> = HashMap::new();
        let mut first_active = String::new();
        let mut last_active = String::new();
        for s in &sessions {
            *agents.entry(s.provider.clone()).or_default() += 1;
            if !s.model.is_empty() {
                *models.entry(s.model.clone()).or_default() += 1;
            }
            if first_active.is_empty() || s.created_at < first_active { first_active = s.created_at.clone(); }
            if last_active.is_empty() || s.modified_at > last_active { last_active = s.modified_at.clone(); }
        }
        let session_count = sessions.len() as u32;
        ProjectStats { project_path, session_count, agents, models, first_active, last_active, sessions }
    }).collect();
    out.sort_by(|a, b| b.last_active.cmp(&a.last_active));
    out
}

pub fn aggregate_project_summaries_from_sessions(sessions: &[SessionMeta]) -> Vec<ProjectSummary> {
    let projects = aggregate_projects_from_sessions(sessions, None);
    projects.into_iter().map(|p| ProjectSummary {
        project_path: p.project_path,
        session_count: p.session_count,
        agents: p.agents,
        models: p.models,
        first_active: p.first_active,
        last_active: p.last_active,
    }).collect()
}

/// Cheap freshness check: if built_at is within 60s, trust it; otherwise compare
/// top-level root mtimes against built_at.
pub fn is_session_index_fresh(provider: Option<Provider>, now_ms: u64) -> bool {
    let index = match load_session_index() { Some(i) => i, None => return false };
    let built_at = chrono::DateTime::parse_from_rfc3339(&index.built_at).ok()
        .map(|dt| dt.timestamp_millis() as u64).unwrap_or(0);
    if built_at == 0 { return false; }
    if now_ms.saturating_sub(built_at) < 60_000 { return true; }

    let roots: Vec<PathBuf> = provider_roots(provider).into_iter().map(|(_, r)| r).collect();
    for root in roots {
        match std::fs::metadata(&root) {
            Ok(md) => {
                let mtime = md.modified().ok()
                    .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0);
                if mtime > built_at { return false; }
            }
            Err(_) => return false,
        }
    }
    true
}

fn matches_session_id(wanted_ids: &std::collections::HashSet<String>, session_id: &str) -> bool {
    let normalized = session_id.to_lowercase();
    if wanted_ids.contains(&normalized) { return true; }
    for w in wanted_ids {
        if !w.is_empty() && normalized.starts_with(w) { return true; }
    }
    false
}

/// Find indexed sessions by ID/prefix. Uses the fast path when the index is
/// fresh; otherwise rebuilds.
pub fn lookup_indexed_sessions(session_ids: &[String], provider: Option<Provider>) -> HashMap<String, SessionMeta> {
    let mut result: HashMap<String, SessionMeta> = HashMap::new();
    if session_ids.is_empty() { return result; }
    let wanted: std::collections::HashSet<String> = session_ids.iter().map(|s| s.to_lowercase()).collect();

    let now_ms = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    let index = if is_session_index_fresh(provider, now_ms) {
        load_session_index()
    } else {
        Some(rebuild_session_index(provider))
    };
    let index = match index { Some(i) => i, None => return result };

    for session in index.sessions {
        if let Some(p) = provider {
            let sp = if session.provider == "codex" { Provider::Codex } else { Provider::Claude };
            if sp != p { continue; }
        }
        if !matches_session_id(&wanted, &session.session_id) { continue; }
        // exact id wins over prefix
        if result.contains_key(&session.session_id) { continue; }
        result.insert(session.session_id.clone(), session);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mk_session(id: &str, project: &str, provider: &str, modified: &str) -> SessionMeta {
        SessionMeta {
            session_id: id.into(), provider: provider.into(), model: "m".into(),
            project_path: project.into(), first_prompt: "".into(),
            file_path: format!("/p/{id}.jsonl"),
            created_at: modified.into(), modified_at: modified.into(),
            custom_title: None, token_usage: None,
        }
    }

    #[test]
    fn aggregate_groups_by_project() {
        let sessions = vec![
            mk_session("s1", "/a", "claude", "2026-01-01T00:00:00Z"),
            mk_session("s2", "/a", "claude", "2026-02-01T00:00:00Z"),
            mk_session("s3", "/b", "codex", "2026-03-01T00:00:00Z"),
        ];
        let projects = aggregate_projects_from_sessions(&sessions, None);
        assert_eq!(projects.len(), 2);
        let project_a = projects.iter().find(|p| p.project_path == "/a").unwrap();
        assert_eq!(project_a.session_count, 2);
        assert_eq!(project_a.last_active, "2026-02-01T00:00:00Z");
        assert_eq!(project_a.first_active, "2026-01-01T00:00:00Z");
    }

    #[test]
    fn matches_session_id_prefix_works() {
        let mut wanted = std::collections::HashSet::new();
        wanted.insert("abc123".into());
        assert!(matches_session_id(&wanted, "abc123def456"));
        assert!(matches_session_id(&wanted, "ABC123"));
        assert!(!matches_session_id(&wanted, "xyz789"));
    }

    #[test]
    fn upsert_session_replaces_existing() {
        let mut sessions = vec![mk_session("s1", "/a", "claude", "old")];
        let updated = mk_session("s1", "/a", "claude", "new");
        upsert_session(&mut sessions, updated);
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].modified_at, "new");
    }

    #[test]
    fn upsert_session_appends_new() {
        let mut sessions = vec![mk_session("s1", "/a", "claude", "x")];
        let new = mk_session("s2", "/b", "codex", "y");
        upsert_session(&mut sessions, new);
        assert_eq!(sessions.len(), 2);
    }
}
