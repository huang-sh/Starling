//! Run-record lifecycle — mirrors src/lib/runs.ts.

use std::collections::HashMap;
use std::path::PathBuf;

use colored::Colorize;

use crate::constants::{default_runs_path, now_iso, RUNS_VERSION};
use crate::core::fs_utils::{atomic_write_json, read_json};
use crate::core::process_map::map_processes_to_sessions;
use crate::types::{Bookmark, RunRecord, RunsFile};

// Re-export RunStatus so callers don't need crate::types::RunStatus
pub use crate::types::RunStatus;

const MAX_RUN_RECORDS: usize = 500;

pub fn runs_path() -> PathBuf {
    std::env::var("STARLING_RUNS")
        .map(PathBuf::from)
        .unwrap_or_else(|_| default_runs_path())
}

fn empty_runs() -> RunsFile {
    RunsFile {
        version: RUNS_VERSION,
        runs: Vec::new(),
    }
}

pub fn load_runs() -> RunsFile {
    let data: Option<RunsFile> = read_json(&runs_path());
    match data {
        Some(d) => RunsFile {
            version: RUNS_VERSION,
            runs: d.runs,
        },
        None => empty_runs(),
    }
}

pub fn save_runs(mut data: RunsFile) {
    if data.runs.len() > MAX_RUN_RECORDS {
        let mut running: Vec<RunRecord> = data
            .runs
            .iter()
            .filter(|r| r.status == RunStatus::Running)
            .cloned()
            .collect();
        let mut terminal: Vec<RunRecord> = data
            .runs
            .iter()
            .filter(|r| r.status != RunStatus::Running)
            .cloned()
            .collect();
        terminal.sort_by(|a, b| {
            let akey = a.ended_at.as_ref().unwrap_or(&a.started_at);
            let bkey = b.ended_at.as_ref().unwrap_or(&b.started_at);
            bkey.cmp(akey)
        });
        running.extend(terminal.into_iter().take(MAX_RUN_RECORDS));
        data.runs = running.into_iter().take(MAX_RUN_RECORDS).collect();
    }
    let _ = atomic_write_json(&runs_path(), &data);
}

pub fn create_run(record: RunRecord) {
    let mut data = load_runs();
    data.runs.push(record);
    save_runs(data);
}

pub struct FinalizePatch {
    pub status: RunStatus,
    pub exit_code: Option<i32>,
    pub ended_at: Option<String>,
    pub session_id: Option<String>,
}

pub fn finalize_run(run_id: &str, patch: FinalizePatch) {
    let mut data = load_runs();
    let idx = match data.runs.iter().position(|r| r.run_id == run_id) {
        Some(i) => i,
        None => return,
    };
    let existing = data.runs[idx].clone();
    data.runs[idx] = RunRecord {
        status: patch.status,
        exit_code: patch.exit_code.or(existing.exit_code),
        ended_at: Some(patch.ended_at.unwrap_or_else(now_iso)),
        session_id: patch.session_id.or(existing.session_id),
        ..existing
    };
    save_runs(data);
}

pub fn mark_run_crashed(run_id: &str) {
    finalize_run(
        run_id,
        FinalizePatch {
            status: RunStatus::Crashed,
            exit_code: None,
            ended_at: Some(now_iso()),
            session_id: None,
        },
    );
}

pub fn remove_run(run_id: &str) -> bool {
    let mut data = load_runs();
    let before = data.runs.len();
    data.runs.retain(|r| r.run_id != run_id);
    if data.runs.len() == before {
        return false;
    }
    save_runs(data);
    true
}

pub fn clear_runs(filter: Option<RunFilter>) -> usize {
    let mut data = load_runs();
    let before = data.runs.len();
    data.runs.retain(|r| {
        if let Some(f) = &filter {
            if let Some(sid) = &f.session_id {
                if r.session_id.as_ref() != Some(sid) {
                    return true;
                }
            }
            if let Some(s) = &f.status {
                if r.status != *s {
                    return true;
                }
            }
        }
        false
    });
    let removed = before - data.runs.len();
    if removed > 0 {
        save_runs(data);
    }
    removed
}

#[derive(Default, Clone)]
pub struct RunFilter {
    pub session_id: Option<String>,
    pub status: Option<RunStatus>,
}

pub fn find_run(run_id: &str) -> Option<RunRecord> {
    load_runs().runs.into_iter().find(|r| r.run_id == run_id)
}

pub fn find_runs_by_session(session_id: &str) -> Vec<RunRecord> {
    let mut runs: Vec<RunRecord> = load_runs()
        .runs
        .into_iter()
        .filter(|r| r.session_id.as_deref() == Some(session_id))
        .collect();
    runs.sort_by(|a, b| b.started_at.cmp(&a.started_at));
    runs
}

pub fn list_runs(filter: Option<ListFilter>) -> Vec<RunRecord> {
    let mut runs = load_runs().runs;
    if let Some(f) = filter {
        if let Some(s) = f.status {
            runs.retain(|r| r.status == s);
        }
        if let Some(p) = f.provider {
            runs.retain(|r| match (p.as_str(), &r.provider) {
                ("claude", crate::types::RunProvider::Claude) => true,
                ("codex", crate::types::RunProvider::Codex) => true,
                _ => false,
            });
        }
        if let Some(c) = f.catalog_id {
            runs.retain(|r| r.catalog_id.as_ref() == Some(&c));
        }
    }
    runs.sort_by(|a, b| b.started_at.cmp(&a.started_at));
    runs
}

#[derive(Default, Clone)]
pub struct ListFilter {
    pub status: Option<RunStatus>,
    pub provider: Option<String>,
    pub catalog_id: Option<String>,
}

pub fn get_latest_run_for_session(session_id: &str) -> Option<RunRecord> {
    find_runs_by_session(session_id).into_iter().next()
}

pub fn get_run_status_for_session(session_id: &str) -> RunStatus {
    get_latest_run_for_session(session_id)
        .map(|r| r.status)
        .unwrap_or(RunStatus::Unknown)
}

// --- Glyphs/badges ---

pub fn status_glyph(status: RunStatus) -> &'static str {
    match status {
        RunStatus::Running => "●",
        RunStatus::Completed => "✓",
        RunStatus::Errored => "✗",
        RunStatus::Crashed => "⚡",
        RunStatus::Stale => "~",
        RunStatus::Unknown => "·",
    }
}

pub fn status_badge(status: RunStatus, use_color: bool) -> String {
    let glyph = status_glyph(status);
    if !use_color {
        return glyph.to_string();
    }
    match status {
        RunStatus::Running => glyph.green().to_string(),
        RunStatus::Completed => glyph.normal().to_string(),
        RunStatus::Errored => glyph.red().to_string(),
        RunStatus::Crashed => glyph.magenta().to_string(),
        RunStatus::Stale => glyph.yellow().to_string(),
        RunStatus::Unknown => glyph.normal().to_string(),
    }
}

const RUN_STATUS_ORDER: &[RunStatus] = &[
    RunStatus::Running,
    RunStatus::Errored,
    RunStatus::Crashed,
    RunStatus::Completed,
    RunStatus::Unknown,
];

pub fn summarize_run_status(bookmarks: &[Bookmark], color: bool) -> String {
    let mut counts: HashMap<RunStatus, u32> = HashMap::new();
    for b in bookmarks {
        let status = get_run_status_for_session(&b.session_id);
        *counts.entry(status).or_default() += 1;
    }
    let parts: Vec<String> = RUN_STATUS_ORDER
        .iter()
        .filter_map(|s| {
            counts
                .get(s)
                .map(|n| format!("{}{}", status_badge(*s, color), n))
        })
        .collect();
    if parts.is_empty() {
        status_badge(RunStatus::Unknown, color)
    } else {
        parts.join(" ")
    }
}

// --- Liveness ---

pub fn is_pid_alive(pid: u32) -> bool {
    crate::core::process_map::is_pid_alive(pid)
}

/// Mark "running" records whose pid is dead as "crashed". Returns count changed.
pub fn reconcile_stale_runs() -> usize {
    let mut data = load_runs();
    let mut changed = 0;
    let now = now_iso();
    for run in data.runs.iter_mut() {
        if run.status != RunStatus::Running {
            continue;
        }
        if let Some(pid) = run.pid {
            if !is_pid_alive(pid) {
                run.status = RunStatus::Crashed;
                run.ended_at = Some(now.clone());
                changed += 1;
            }
        }
    }
    if changed > 0 {
        save_runs(data);
    }
    changed
}

// --- Detection (in-memory) ---

#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct DetectedSession {
    pub pid: Option<u32>,
    pub provider: String,
    pub project_path: Option<String>,
    pub file_path: Option<String>,
    pub home: Option<String>,
}

/// Scan running claude/codex processes and map each to its session. In-memory —
/// does not write runs.json. Linux-only (empty elsewhere).
pub fn detect_running_sessions() -> HashMap<String, DetectedSession> {
    let mapped = map_processes_to_sessions();
    let mut detected = HashMap::new();
    for (session_id, info) in mapped {
        detected.insert(
            session_id,
            DetectedSession {
                pid: if info.pid > 0 { Some(info.pid) } else { None },
                provider: info
                    .provider
                    .map(|p| match p {
                        crate::core::process_map::Provider::Claude => "claude",
                        crate::core::process_map::Provider::Codex => "codex",
                    })
                    .unwrap_or_default()
                    .to_string(),
                project_path: info.project_path,
                file_path: info.file_path,
                home: info.home,
            },
        );
    }
    detected
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::fs_utils::test_support::with_temp_store;

    fn mk_run(
        run_id: &str,
        session_id: Option<&str>,
        status: RunStatus,
        started: &str,
    ) -> RunRecord {
        RunRecord {
            run_id: run_id.into(),
            session_id: session_id.map(String::from),
            provider: crate::types::RunProvider::Claude,
            project_path: None,
            catalog_id: None,
            setting: None,
            pid: None,
            status,
            exit_code: None,
            started_at: started.into(),
            ended_at: None,
            source: crate::types::RunSource::StarlingRun,
        }
    }

    #[test]
    fn lifecycle_create_finalize_remove() {
        with_temp_store(|| {
            let path = test_runs_path("starling-runs-test-does-not-exist-yet.json");
            std::env::set_var("STARLING_RUNS", &path);
            let _ = std::fs::remove_file(&path);

            let run = mk_run("r1", Some("s1"), RunStatus::Running, "2026-01-01T00:00:00Z");
            create_run(run);

            assert!(find_run("r1").is_some());
            let found = find_runs_by_session("s1");
            assert_eq!(found.len(), 1);

            finalize_run(
                "r1",
                FinalizePatch {
                    status: RunStatus::Completed,
                    exit_code: Some(0),
                    ended_at: Some("2026-01-01T00:01:00Z".into()),
                    session_id: None,
                },
            );
            let r = find_run("r1").unwrap();
            assert_eq!(r.status, RunStatus::Completed);
            assert_eq!(r.exit_code, Some(0));
            assert_eq!(r.ended_at.as_deref(), Some("2026-01-01T00:01:00Z"));

            assert!(remove_run("r1"));
            assert!(find_run("r1").is_none());

            let _ = std::fs::remove_file(&path);
            std::env::remove_var("STARLING_RUNS");
        });
    }

    #[test]
    fn list_runs_sorts_newest_first() {
        with_temp_store(|| {
            let path = test_runs_path("starling-runs-list-test.json");
            std::env::set_var("STARLING_RUNS", &path);
            let _ = std::fs::remove_file(&path);

            create_run(mk_run(
                "old",
                Some("s1"),
                RunStatus::Completed,
                "2026-01-01T00:00:00Z",
            ));
            create_run(mk_run(
                "new",
                Some("s1"),
                RunStatus::Completed,
                "2026-02-01T00:00:00Z",
            ));
            let runs = list_runs(None);
            assert_eq!(runs[0].run_id, "new");
            assert_eq!(runs[1].run_id, "old");

            let _ = std::fs::remove_file(&path);
            std::env::remove_var("STARLING_RUNS");
        });
    }

    fn test_runs_path(name: &str) -> PathBuf {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/test-data");
        let _ = std::fs::create_dir_all(&dir);
        dir.join(name)
    }

    #[test]
    fn status_glyph_mapping() {
        assert_eq!(status_glyph(RunStatus::Running), "●");
        assert_eq!(status_glyph(RunStatus::Completed), "✓");
        assert_eq!(status_glyph(RunStatus::Errored), "✗");
        assert_eq!(status_glyph(RunStatus::Crashed), "⚡");
        assert_eq!(status_glyph(RunStatus::Stale), "~");
        assert_eq!(status_glyph(RunStatus::Unknown), "·");
    }

    #[test]
    fn summarize_handles_empty() {
        let s = summarize_run_status(&[], false);
        assert_eq!(s, "·");
    }

    #[test]
    fn summarize_counts_bookmarks() {
        let b = vec![Bookmark {
            id: "starling_0001".into(),
            provider: "claude".into(),
            session_id: "s1".into(),
            title: "t".into(),
            category: "c".into(),
            tags: vec![],
            project_path: "/p".into(),
            first_prompt: "".into(),
            notes: vec![],
            space_ids: vec![],
            created_at: "t".into(),
            updated_at: "t".into(),
        }];
        // No runs file → unknown status for s1
        std::env::set_var("STARLING_RUNS", "/tmp/does-not-exist-summary.json");
        let _ = std::fs::remove_file("/tmp/does-not-exist-summary.json");
        let s = summarize_run_status(&b, false);
        assert!(s.contains("·1") || s == "·", "got: {s}");
        std::env::remove_var("STARLING_RUNS");
    }
}
