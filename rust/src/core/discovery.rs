//! Session-file discovery — mirrors src/lib/discovery.ts.

use std::path::{Path, PathBuf};
use std::time::SystemTime;

use crate::constants::{claude_session_roots, codex_session_roots, pi_session_roots};
use crate::core::session::{
    extract_claude_session_meta, extract_codex_session_meta, extract_pi_session_meta,
    parse_jsonl_file, parse_jsonl_head, JsonlEntry,
};
use crate::types::SessionMeta;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Provider {
    Claude,
    Codex,
    Pi,
}

#[derive(Debug, Clone)]
pub struct FileEntry {
    pub path: PathBuf,
    pub mtime_ms: u64,
}

fn provider_roots(filter: Option<Provider>) -> Vec<(Provider, PathBuf)> {
    let mut out = Vec::new();
    if filter.map(|f| f == Provider::Claude).unwrap_or(true) {
        for r in claude_session_roots() {
            out.push((Provider::Claude, r));
        }
    }
    if filter.map(|f| f == Provider::Codex).unwrap_or(true) {
        for r in codex_session_roots() {
            out.push((Provider::Codex, r));
        }
    }
    if filter.map(|f| f == Provider::Pi).unwrap_or(true) {
        for r in pi_session_roots() {
            out.push((Provider::Pi, r));
        }
    }
    out
}

fn stat_mtime_ms(path: &Path) -> Option<u64> {
    let md = std::fs::metadata(path).ok()?;
    md.modified()
        .ok()?
        .duration_since(SystemTime::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis() as u64)
}

fn mtime_iso(ms: u64) -> String {
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(ms as i64)
        .map(|dt| {
            dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
                .replace("+00:00", "Z")
        })
        .unwrap_or_else(|| format!("{ms}"))
}

/// Collect `.jsonl` files under `dir` (recursively), sorted newest-first.
/// Walks children newest-first and over-collects by 3x for safety.
fn collect_jsonl_files_sorted(dir: &Path, limit: usize) -> Vec<FileEntry> {
    let rd = match std::fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return vec![],
    };

    let mut children: Vec<(PathBuf, u64, bool)> = Vec::new();
    for entry in rd.flatten() {
        let path = entry.path();
        let md = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let mtime = md
            .modified()
            .ok()
            .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        children.push((path, mtime, md.is_dir()));
    }

    // Newest first
    children.sort_by(|a, b| b.1.cmp(&a.1));

    let mut results: Vec<FileEntry> = Vec::new();
    let collection_limit = limit.saturating_mul(3);
    for (path, mtime, is_dir) in children {
        if results.len() >= collection_limit {
            break;
        }
        if is_dir {
            // Skip "subagents" subtree
            if path.file_name().map(|n| n == "subagents").unwrap_or(false) {
                continue;
            }
            let nested = collect_jsonl_files_sorted(&path, limit);
            results.extend(nested);
        } else if path.extension().map(|e| e == "jsonl").unwrap_or(false) {
            results.push(FileEntry {
                path,
                mtime_ms: mtime,
            });
        }
    }

    // Sort the combined list newest-first
    results.sort_by(|a, b| b.mtime_ms.cmp(&a.mtime_ms));
    results.into_iter().take(collection_limit).collect()
}

fn extract_meta(
    provider: Provider,
    entries: &[JsonlEntry],
    path: &Path,
    modified_at: &str,
) -> SessionMeta {
    match provider {
        Provider::Claude => extract_claude_session_meta(entries, path, modified_at),
        Provider::Codex => extract_codex_session_meta(entries, path, modified_at),
        Provider::Pi => extract_pi_session_meta(entries, path, modified_at),
    }
}

/// Resolve an explicit Pi transcript path. Pi accepts legacy v1/v2 headers and
/// migrates them on open, so validation follows `loadEntriesFromFile()`: after
/// blank/malformed lines are skipped, the first decoded entry must be a
/// session header with a string ID.
pub fn find_pi_session_by_path(input: &str) -> Option<SessionMeta> {
    let path = Path::new(input);
    if !path.is_file() {
        return None;
    }
    let absolute = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let entries = parse_jsonl_file(&absolute);
    let valid_pi_header = entries.first().map(|entry| {
        entry.type_str() == Some("session")
            && entry
                .value()
                .get("id")
                .and_then(|value| value.as_str())
                .is_some()
    }) == Some(true);
    if !valid_pi_header {
        return None;
    }
    let modified_at = stat_mtime_ms(&absolute).map(mtime_iso).unwrap_or_default();
    Some(extract_pi_session_meta(&entries, &absolute, &modified_at))
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
        if results.len() >= limit {
            break;
        }
        let modified_at = mtime_iso(file.mtime_ms);
        let entries = parse_jsonl_head(&file.path, 500);
        let meta = extract_meta(provider, &entries, &file.path, &modified_at);
        results.push(meta);
    }
    results
}

pub fn match_session_id(candidate: &str, session_id: &str, provider: Option<Provider>) -> bool {
    if candidate.is_empty() || session_id.is_empty() {
        return false;
    }
    let candidate = candidate.trim();
    let session_id = session_id.trim();
    let case_insensitive = match provider {
        // Pi custom IDs are case-sensitive, including values that happen to
        // start with `rollout-`. UUID-shaped Pi IDs retain UUID semantics.
        Some(Provider::Pi) => is_uuidish(candidate) && is_uuidish(session_id),
        _ => {
            is_case_insensitive_session_id(candidate) && is_case_insensitive_session_id(session_id)
        }
    };
    if case_insensitive {
        let lc = candidate.to_ascii_lowercase();
        let ls = session_id.to_ascii_lowercase();
        return lc == ls || lc.starts_with(&ls) || lc.contains(&ls) || ls.starts_with(&lc);
    }
    candidate == session_id
        || candidate.starts_with(session_id)
        || candidate.contains(session_id)
        || session_id.starts_with(candidate)
}

pub fn canonical_session_id(session_id: &str, provider: Option<&str>) -> String {
    let trimmed = session_id.trim();
    if provider
        .map(|name| name.eq_ignore_ascii_case("pi"))
        .unwrap_or(false)
    {
        // Unlike Claude/Codex rollout filenames, every Pi ID is user-visible
        // and may legally look like a rollout name or end in a UUID.
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
        // Pi permits case-sensitive custom IDs. Never fold those: two valid Pi
        // sessions can differ only by case.
        trimmed.to_string()
    }
}

/// Stable cross-layer identity for a logical session. Pi scopes IDs to a cwd;
/// Claude and Codex retain their historical provider + canonical-ID identity.
pub fn session_scope_key(provider: &str, session_id: &str, project_path: &str) -> String {
    let provider = provider.trim().to_ascii_lowercase();
    let canonical = canonical_session_id(session_id, Some(&provider));
    if provider == "pi" {
        format!(
            "pi\0{}\0{}",
            canonical,
            project_path.trim_end_matches(['/', '\\'])
        )
    } else {
        format!("{provider}\0{canonical}")
    }
}

fn is_case_insensitive_session_id(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    looks_like_uuid(&lower)
        || lower.starts_with("rollout-")
        || (!lower.is_empty()
            && lower.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
            && lower.chars().filter(|c| *c != '-').count() >= 8)
}

fn is_uuidish(value: &str) -> bool {
    let trimmed = value.trim();
    !trimmed.is_empty()
        && trimmed.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
        && trimmed.chars().filter(|c| *c != '-').count() >= 8
        && trimmed.chars().filter(|c| *c != '-').count() <= 32
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
    let normalized = input.trim();
    if normalized.is_empty() {
        return false;
    }
    // Pi custom IDs are case-sensitive and may also begin with `rollout-`;
    // validate the shared safe character set without inferring a provider.
    normalized
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        && normalized
            .chars()
            .next()
            .map(|c| c.is_ascii_alphanumeric())
            .unwrap_or(false)
        && normalized
            .chars()
            .last()
            .map(|c| c.is_ascii_alphanumeric())
            .unwrap_or(false)
}

fn collect_session_files_for_id(
    dir: &Path,
    session_id: &str,
    accumulator: &mut Vec<(PathBuf, Provider)>,
    provider: Provider,
) {
    if accumulator.len() > 5000 {
        return;
    }
    let rd = match std::fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return,
    };
    for entry in rd.flatten() {
        let path = entry.path();
        if path.file_name().map(|n| n == "subagents").unwrap_or(false) {
            continue;
        }
        let md = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if md.is_dir() {
            collect_session_files_for_id(&path, session_id, accumulator, provider);
            continue;
        }
        if path.extension().map(|e| e == "jsonl").unwrap_or(false) {
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            let filename_matches = match provider {
                Provider::Pi => name.contains(session_id),
                Provider::Claude | Provider::Codex => name
                    .to_ascii_lowercase()
                    .contains(&session_id.to_ascii_lowercase()),
            };
            if filename_matches {
                accumulator.push((path, provider));
                if accumulator.len() > 5000 {
                    return;
                }
            }
        }
    }
}

fn collect_session_candidates_by_filename(session_id: &str) -> Vec<SessionMeta> {
    let normalized_id = session_id.trim();
    let mut matched: Vec<(PathBuf, Provider)> = Vec::new();
    for (provider, root) in provider_roots(None) {
        collect_session_files_for_id(&root, normalized_id, &mut matched, provider);
    }

    let mut matches: std::collections::HashMap<String, SessionMeta> =
        std::collections::HashMap::new();
    for (path, provider) in matched {
        let mtime = match stat_mtime_ms(&path) {
            Some(m) => m,
            None => continue,
        };
        let modified_at = mtime_iso(mtime);
        let entries = parse_jsonl_head(&path, 500);
        let meta = extract_meta(provider, &entries, &path, &modified_at);
        let by_id = meta.session_id.clone();
        let by_file_stem = path
            .file_stem()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        if match_session_id(&by_id, normalized_id, Some(provider))
            || match_session_id(&by_file_stem, normalized_id, Some(provider))
        {
            let match_key = transcript_identity_key(&meta);
            match matches.get(&match_key) {
                Some(existing) if existing.modified_at >= meta.modified_at => {}
                _ => {
                    matches.insert(match_key, meta);
                }
            }
        }
    }

    let mut out: Vec<SessionMeta> = matches.into_values().collect();
    out.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));
    out
}

pub fn find_session_candidates(session_id: &str) -> Vec<SessionMeta> {
    if !looks_like_session_id_query(session_id) {
        return vec![];
    }

    let filename_matches = collect_session_candidates_by_filename(session_id);
    if !filename_matches.is_empty() {
        return filename_matches;
    }

    // Fallback: scan latest sessions
    let limit = 2500;
    let mut matches: std::collections::HashMap<String, SessionMeta> =
        std::collections::HashMap::new();
    for meta in find_sessions(limit, None) {
        let provider = match meta.provider.as_str() {
            "claude" => Some(Provider::Claude),
            "codex" => Some(Provider::Codex),
            "pi" => Some(Provider::Pi),
            _ => None,
        };
        if !match_session_id(&meta.session_id, session_id, provider) {
            continue;
        }
        let match_key = transcript_identity_key(&meta);
        match matches.get(&match_key) {
            Some(existing) if existing.modified_at >= meta.modified_at => {}
            _ => {
                matches.insert(match_key, meta);
            }
        }
    }
    let mut out: Vec<SessionMeta> = matches.into_values().collect();
    out.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));
    out
}

pub fn find_session_by_id(session_id: &str) -> Option<SessionMeta> {
    let matches = find_session_candidates(session_id);
    let exact: Vec<&SessionMeta> = matches
        .iter()
        .filter(|m| m.session_id == session_id)
        .collect();
    if exact.len() == 1 {
        return exact.first().map(|m| (*m).clone());
    }
    // Pi IDs are cwd-scoped. Never silently choose one project when the same
    // exact ID is present in multiple transcripts.
    if exact.iter().filter(|m| m.provider == "pi").count() > 1 {
        return None;
    }
    matches.into_iter().next()
}

fn transcript_identity_key(meta: &SessionMeta) -> String {
    if meta.provider == "pi" {
        format!(
            "{}\0{}\0{}",
            meta.provider,
            meta.session_id,
            if meta.file_path.is_empty() {
                &meta.project_path
            } else {
                &meta.file_path
            }
        )
    } else {
        format!("{}\0{}", meta.provider, meta.session_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_pi_path_accepts_legacy_header_after_malformed_lines() {
        let root =
            std::env::temp_dir().join(format!("starling-pi-legacy-path-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let transcript = root.join("legacy-v1.jsonl");
        std::fs::write(
            &transcript,
            "not json\n{\"type\":\"session\",\"id\":\"LegacyPi\",\"timestamp\":\"2024-01-01T00:00:00.000Z\",\"cwd\":\"/tmp/legacy\"}\n",
        )
        .unwrap();

        let meta = find_pi_session_by_path(&transcript.to_string_lossy())
            .expect("Pi should accept and later migrate a v1 transcript");

        assert_eq!(meta.session_id, "LegacyPi");
        assert_eq!(meta.project_path, "/tmp/legacy");
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn looks_like_session_id_min_length() {
        assert!(looks_like_session_id_query("abc"));
        assert!(looks_like_session_id_query("a1b2c3d4e5f6"));
        assert!(looks_like_session_id_query(
            "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
        ));
        assert!(looks_like_session_id_query(
            "rollout-2026-06-21t06-53-27-019ee8f4-a336-7f63-8f7e-ce2b308efcc2"
        ));
        assert!(!looks_like_session_id_query("not a session id"));
        assert!(looks_like_session_id_query("Case.Sensitive_Pi-7"));
        assert!(looks_like_session_id_query("Rollout-Custom_ID"));
    }

    #[test]
    fn match_session_id_prefix() {
        assert!(match_session_id("abcdef0123456789", "abcdef", None));
        assert!(match_session_id("abcdef", "abcdef0123456789", None));
        assert!(match_session_id(
            "rollout-2026-06-21t06-53-27-019ee8f4-a336-7f63-8f7e-ce2b308efcc2",
            "rollout-2026-06-21T06-53-27-019ee8f4-a336-7f63-8f7e-ce2b308efcc2",
            Some(Provider::Codex),
        ));
        assert_eq!(
            canonical_session_id(
                "rollout-2026-06-21T06-53-27-019ee8f4-a336-7f63-8f7e-ce2b308efcc2",
                Some("codex"),
            ),
            "019ee8f4-a336-7f63-8f7e-ce2b308efcc2",
        );
        assert!(!match_session_id("", "abc", None));
        assert!(!match_session_id("abc", "", None));
        assert!(!match_session_id("PiCase", "picase", Some(Provider::Pi)));
        assert_eq!(canonical_session_id("PiCase", Some("pi")), "PiCase");
        assert_eq!(
            canonical_session_id("Build-550e8400-e29b-41d4-a716-446655440000", Some("pi")),
            "Build-550e8400-e29b-41d4-a716-446655440000"
        );
        assert_eq!(
            canonical_session_id("Rollout-Custom_ID", Some("pi")),
            "Rollout-Custom_ID"
        );
        assert!(!match_session_id(
            "Rollout-Custom_ID",
            "rollout-custom_id",
            Some(Provider::Pi)
        ));
        assert_ne!(
            session_scope_key("pi", "SharedID", "/work/a"),
            session_scope_key("pi", "SharedID", "/work/b")
        );
        assert_eq!(
            session_scope_key("pi", "Rollout-Custom_ID", "/work/a/"),
            session_scope_key("pi", "Rollout-Custom_ID", "/work/a")
        );
    }
}
