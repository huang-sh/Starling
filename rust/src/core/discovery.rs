//! Session-file discovery — mirrors src/lib/discovery.ts.

use std::path::{Path, PathBuf};
use std::time::SystemTime;

use crate::constants::{claude_session_roots, codex_session_roots};
use crate::core::session::{
    extract_claude_session_meta, extract_codex_session_meta, parse_jsonl_head, JsonlEntry,
};
use crate::types::SessionMeta;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Provider {
    Claude,
    Codex,
}

#[derive(Debug, Clone)]
pub struct FileEntry {
    pub path: PathBuf,
    pub mtime_ms: u64,
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

fn stat_mtime_ms(path: &Path) -> Option<u64> {
    let md = std::fs::metadata(path).ok()?;
    md.modified().ok()?
        .duration_since(SystemTime::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis() as u64)
}

fn mtime_iso(ms: u64) -> String {
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(ms as i64)
        .map(|dt| dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true).replace("+00:00", "Z"))
        .unwrap_or_else(|| format!("{ms}"))
}

/// Collect `.jsonl` files under `dir` (recursively), sorted newest-first.
/// Walks children newest-first and over-collects by 3x for safety.
fn collect_jsonl_files_sorted(dir: &Path, limit: usize) -> Vec<FileEntry> {
    let rd = match std::fs::read_dir(dir) { Ok(r) => r, Err(_) => return vec![] };

    let mut children: Vec<(PathBuf, u64, bool)> = Vec::new();
    for entry in rd.flatten() {
        let path = entry.path();
        let md = match entry.metadata() { Ok(m) => m, Err(_) => continue };
        let mtime = md.modified()
            .ok()
            .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        children.push((path, mtime, md.is_dir()));
    }

    // Newest first
    children.sort_by(|a, b| b.1.cmp(&a.1));

    let mut results: Vec<FileEntry> = Vec::new();
    for (path, mtime, is_dir) in children {
        if results.len() >= limit * 3 { break; }
        if is_dir {
            // Skip "subagents" subtree
            if path.file_name().map(|n| n == "subagents").unwrap_or(false) { continue; }
            let nested = collect_jsonl_files_sorted(&path, limit);
            results.extend(nested);
        } else if path.extension().map(|e| e == "jsonl").unwrap_or(false) {
            results.push(FileEntry { path, mtime_ms: mtime });
        }
    }

    // Sort the combined list newest-first
    results.sort_by(|a, b| b.mtime_ms.cmp(&a.mtime_ms));
    results.into_iter().take(limit * 3).collect()
}

fn extract_meta(provider: Provider, entries: &[JsonlEntry], path: &Path, modified_at: &str) -> SessionMeta {
    match provider {
        Provider::Claude => extract_claude_session_meta(entries, path, modified_at),
        Provider::Codex => extract_codex_session_meta(entries, path, modified_at),
    }
}

/// Stream-like: gather up to `limit` sessions (sorted newest-first).
pub fn find_sessions(limit: usize, provider_filter: Option<Provider>) -> Vec<SessionMeta> {
    let mut all_files: Vec<(FileEntry, Provider)> = Vec::new();
    for (provider, root) in provider_roots(provider_filter) {
        for f in collect_jsonl_files_sorted(&root, limit) {
            all_files.push((f, provider));
        }
    }
    all_files.sort_by(|a, b| b.0.mtime_ms.cmp(&a.0.mtime_ms));

    let mut results: Vec<SessionMeta> = Vec::new();
    for (file, provider) in all_files {
        if results.len() >= limit { break; }
        let modified_at = mtime_iso(file.mtime_ms);
        let entries = parse_jsonl_head(&file.path, 500);
        let meta = extract_meta(provider, &entries, &file.path, &modified_at);
        results.push(meta);
    }
    results
}

pub fn match_session_id(candidate: &str, session_id: &str) -> bool {
    if candidate.is_empty() || session_id.is_empty() { return false; }
    let lc = candidate.to_lowercase();
    let ls = session_id.to_lowercase();
    lc == ls
        || lc.starts_with(&ls)
        || lc.contains(&ls)
        || ls.starts_with(&lc)
}

pub fn canonical_session_id(session_id: &str) -> String {
    let lower = session_id.trim().to_lowercase();
    let parts: Vec<&str> = lower.split('-').collect();
    if parts.len() >= 5 {
        let candidate = parts[parts.len() - 5..].join("-");
        if looks_like_uuid(&candidate) {
            return candidate;
        }
    }
    lower
}

fn looks_like_uuid(value: &str) -> bool {
    let mut parts = value.split('-');
    let lens = [8usize, 4, 4, 4, 12];
    for expected in lens {
        let Some(part) = parts.next() else {
            return false;
        };
        if part.len() != expected || !part.chars().all(|c| c.is_ascii_hexdigit()) {
            return false;
        }
    }
    parts.next().is_none()
}

pub fn looks_like_session_id_query(input: &str) -> bool {
    let normalized = input.trim().to_lowercase();
    if normalized.len() < 8 { return false; }
    if normalized.starts_with("rollout-") {
        return normalized
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-');
    }
    if !normalized.chars().all(|c| c.is_ascii_hexdigit() || c == '-') { return false; }
    let compact: String = normalized.chars().filter(|c| *c != '-').collect();
    if compact.len() < 8 || compact.len() > 32 { return false; }
    compact.chars().all(|c| c.is_ascii_hexdigit())
}

fn collect_session_files_for_id(
    dir: &Path,
    session_id_lower: &str,
    accumulator: &mut Vec<(PathBuf, Provider)>,
    provider: Provider,
) {
    if accumulator.len() > 5000 { return; }
    let rd = match std::fs::read_dir(dir) { Ok(r) => r, Err(_) => return };
    for entry in rd.flatten() {
        let path = entry.path();
        if path.file_name().map(|n| n == "subagents").unwrap_or(false) { continue; }
        let md = match entry.metadata() { Ok(m) => m, Err(_) => continue };
        if md.is_dir() {
            collect_session_files_for_id(&path, session_id_lower, accumulator, provider);
            continue;
        }
        if path.extension().map(|e| e == "jsonl").unwrap_or(false) {
            let name = path.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
            if name.contains(session_id_lower) {
                accumulator.push((path, provider));
                if accumulator.len() > 5000 { return; }
            }
        }
    }
}

fn collect_session_candidates_by_filename(session_id: &str) -> Vec<SessionMeta> {
    let normalized_id = session_id.to_lowercase();
    let mut matched: Vec<(PathBuf, Provider)> = Vec::new();
    for (provider, root) in provider_roots(None) {
        collect_session_files_for_id(&root, &normalized_id, &mut matched, provider);
    }

    let mut matches: std::collections::HashMap<String, SessionMeta> = std::collections::HashMap::new();
    for (path, provider) in matched {
        let mtime = match stat_mtime_ms(&path) { Some(m) => m, None => continue };
        let modified_at = mtime_iso(mtime);
        let entries = parse_jsonl_head(&path, 500);
        let meta = extract_meta(provider, &entries, &path, &modified_at);
        let by_id = meta.session_id.to_lowercase();
        let by_file_stem = path
            .file_stem()
            .map(|n| n.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        if match_session_id(&by_id, &normalized_id) || match_session_id(&by_file_stem, &normalized_id) {
            match matches.get(&meta.session_id) {
                Some(existing) if existing.modified_at >= meta.modified_at => {}
                _ => { matches.insert(meta.session_id.clone(), meta); }
            }
        }
    }

    let mut out: Vec<SessionMeta> = matches.into_values().collect();
    out.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));
    out
}

pub fn find_session_candidates(session_id: &str) -> Vec<SessionMeta> {
    if !looks_like_session_id_query(session_id) { return vec![]; }

    let filename_matches = collect_session_candidates_by_filename(session_id);
    if !filename_matches.is_empty() {
        return filename_matches;
    }

    // Fallback: scan latest sessions
    let limit = 2500;
    let mut matches: std::collections::HashMap<String, SessionMeta> = std::collections::HashMap::new();
    for meta in find_sessions(limit, None) {
        if !match_session_id(&meta.session_id, session_id) { continue; }
        match matches.get(&meta.session_id) {
            Some(existing) if existing.modified_at >= meta.modified_at => {}
            _ => { matches.insert(meta.session_id.clone(), meta); }
        }
    }
    let mut out: Vec<SessionMeta> = matches.into_values().collect();
    out.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));
    out
}

pub fn find_session_by_id(session_id: &str) -> Option<SessionMeta> {
    let matches = find_session_candidates(session_id);
    matches.iter()
        .find(|m| m.session_id == session_id)
        .cloned()
        .or_else(|| matches.into_iter().next())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn looks_like_session_id_min_length() {
        assert!(!looks_like_session_id_query("abc"));
        assert!(looks_like_session_id_query("a1b2c3d4e5f6"));
        assert!(looks_like_session_id_query("a1b2c3d4-e5f6-7890-abcd-ef1234567890"));
        assert!(looks_like_session_id_query("rollout-2026-06-21t06-53-27-019ee8f4-a336-7f63-8f7e-ce2b308efcc2"));
        assert!(!looks_like_session_id_query("not a session id"));
    }

    #[test]
    fn match_session_id_prefix() {
        assert!(match_session_id("abcdef0123456789", "abcdef"));
        assert!(match_session_id("abcdef", "abcdef0123456789"));
        assert!(match_session_id(
            "rollout-2026-06-21t06-53-27-019ee8f4-a336-7f63-8f7e-ce2b308efcc2",
            "rollout-2026-06-21T06-53-27-019ee8f4-a336-7f63-8f7e-ce2b308efcc2",
        ));
        assert_eq!(
            canonical_session_id("rollout-2026-06-21T06-53-27-019ee8f4-a336-7f63-8f7e-ce2b308efcc2"),
            "019ee8f4-a336-7f63-8f7e-ce2b308efcc2",
        );
        assert!(!match_session_id("", "abc"));
        assert!(!match_session_id("abc", ""));
    }
}
