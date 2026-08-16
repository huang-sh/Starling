//! Run-record lifecycle — mirrors src/lib/runs.ts.

use std::collections::HashMap;
use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;

use anyhow::{Context, Result};
use colored::Colorize;
use serde::{Deserialize, Serialize};

use crate::constants::{default_runs_path, now_iso, RUNS_VERSION};
use crate::core::fs_utils::{atomic_write_json, read_json};
use crate::core::process_map::map_processes_to_sessions;
use crate::types::{Bookmark, RunRecord, RunsFile};

// Re-export RunStatus so callers don't need crate::types::RunStatus
pub use crate::types::RunStatus;

const MAX_RUN_RECORDS: usize = 500;
const RUNS_LOCK_TIMEOUT: Duration = Duration::from_secs(5);
const RUNS_LOCK_RETRY: Duration = Duration::from_millis(5);
const RUNS_LOCK_STALE: Duration = Duration::from_secs(30);

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
    load_runs_from(&runs_path())
}

fn load_runs_from(path: &Path) -> RunsFile {
    let data: Option<RunsFile> = read_json(path);
    match data {
        Some(d) => RunsFile {
            version: RUNS_VERSION,
            runs: d.runs,
        },
        None => empty_runs(),
    }
}

/// Replace the entire run store while holding the shared writer lock.
///
/// This remains available for snapshot import/test callers, but must not be
/// used to implement read-modify-write updates: a snapshot loaded before the
/// lock was acquired can still be stale. Production lifecycle changes use
/// `mutate_runs` below so the lock covers load, mutation, and atomic rename.
#[allow(dead_code)]
pub fn save_runs(mut data: RunsFile) {
    let path = runs_path();
    if let Err(error) = replace_runs(&path, &mut data) {
        report_runs_error("replace run store", &error);
    }
}

fn replace_runs(path: &Path, data: &mut RunsFile) -> Result<()> {
    crate::core::fs_utils::ensure_parent_dir(path)?;
    let _lock = acquire_runs_lock(path)?;
    save_runs_unlocked(path, data)
}

fn save_runs_unlocked(path: &Path, data: &mut RunsFile) -> Result<()> {
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
    data.version = RUNS_VERSION;
    atomic_write_json(path, data)
}

fn mutate_runs<T>(mutation: impl FnOnce(&mut RunsFile) -> (T, bool)) -> Result<T> {
    mutate_runs_at_path(&runs_path(), mutation)
}

fn mutate_runs_at_path<T>(
    path: &Path,
    mutation: impl FnOnce(&mut RunsFile) -> (T, bool),
) -> Result<T> {
    crate::core::fs_utils::ensure_parent_dir(path)?;
    let _lock = acquire_runs_lock(path)?;
    let mut data = load_runs_from(path);
    let (output, changed) = mutation(&mut data);
    if changed {
        save_runs_unlocked(path, &mut data)?;
    }
    Ok(output)
}

fn report_runs_error(operation: &str, error: &anyhow::Error) {
    eprintln!("{}: could not {operation}: {error:#}", "warning".yellow());
}

pub fn create_run(record: RunRecord) {
    if let Err(error) = mutate_runs(move |data| {
        data.runs.push(record);
        ((), true)
    }) {
        report_runs_error("create run record", &error);
    }
}

pub struct FinalizePatch {
    pub status: RunStatus,
    pub exit_code: Option<i32>,
    pub ended_at: Option<String>,
    pub session_id: Option<String>,
}

pub fn finalize_run(run_id: &str, patch: FinalizePatch) {
    if let Err(error) = mutate_runs(move |data| {
        let idx = match data.runs.iter().position(|r| r.run_id == run_id) {
            Some(i) => i,
            None => return ((), false),
        };
        let existing = data.runs[idx].clone();
        data.runs[idx] = RunRecord {
            status: patch.status,
            exit_code: patch.exit_code.or(existing.exit_code),
            ended_at: Some(patch.ended_at.unwrap_or_else(now_iso)),
            session_id: patch.session_id.or(existing.session_id),
            ..existing
        };
        ((), true)
    }) {
        report_runs_error("finalize run record", &error);
    }
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
    match mutate_runs(|data| {
        let before = data.runs.len();
        data.runs.retain(|r| r.run_id != run_id);
        let removed = data.runs.len() != before;
        (removed, removed)
    }) {
        Ok(removed) => removed,
        Err(error) => {
            report_runs_error("remove run record", &error);
            false
        }
    }
}

pub fn clear_runs(filter: Option<RunFilter>) -> usize {
    match mutate_runs(move |data| {
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
        (removed, removed > 0)
    }) {
        Ok(removed) => removed,
        Err(error) => {
            report_runs_error("clear run records", &error);
            0
        }
    }
}

/// Atomic patch for fields discovered after a process/session starts.
#[derive(Default)]
pub struct RunPatch {
    pub pid: Option<u32>,
    pub session_id: Option<String>,
    pub session_file: Option<String>,
    pub model: Option<String>,
    pub title: Option<String>,
}

pub fn patch_run(run_id: &str, patch: RunPatch) -> bool {
    match mutate_runs(move |data| {
        let Some(run) = data.runs.iter_mut().find(|run| run.run_id == run_id) else {
            return (false, false);
        };
        let mut changed = false;
        if let Some(pid) = patch.pid {
            changed |= run.pid != Some(pid);
            run.pid = Some(pid);
        }
        if let Some(session_id) = patch.session_id {
            changed |= run.session_id.as_ref() != Some(&session_id);
            run.session_id = Some(session_id);
        }
        if let Some(session_file) = patch.session_file {
            changed |= run.session_file.as_ref() != Some(&session_file);
            run.session_file = Some(session_file);
        }
        if let Some(model) = patch.model {
            changed |= run.model.as_ref() != Some(&model);
            run.model = Some(model);
        }
        if let Some(title) = patch.title {
            changed |= run.title.as_ref() != Some(&title);
            run.title = Some(title);
        }
        (true, changed)
    }) {
        Ok(found) => found,
        Err(error) => {
            report_runs_error("patch run record", &error);
            false
        }
    }
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
                ("pi", crate::types::RunProvider::Pi) => true,
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
    match mutate_runs(|data| {
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
        (changed, changed > 0)
    }) {
        Ok(changed) => changed,
        Err(error) => {
            report_runs_error("reconcile stale run records", &error);
            0
        }
    }
}

// --- Cross-process writer lock ---

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RunsLockOwner {
    token: String,
    pid: u32,
    #[serde(rename = "createdAt")]
    created_at: u64,
}

#[derive(Clone, Copy)]
struct RunsLockTiming {
    timeout: Duration,
    retry: Duration,
    malformed_stale_after: Duration,
}

impl Default for RunsLockTiming {
    fn default() -> Self {
        Self {
            timeout: RUNS_LOCK_TIMEOUT,
            retry: RUNS_LOCK_RETRY,
            malformed_stale_after: RUNS_LOCK_STALE,
        }
    }
}

struct RunsLock {
    path: PathBuf,
    token: String,
    file: Option<File>,
}

impl Drop for RunsLock {
    fn drop(&mut self) {
        // Match the Node implementation: close our descriptor first, then
        // remove the path only if it still names our token.
        self.file.take();
        let current = fs::read_to_string(&self.path)
            .ok()
            .and_then(|raw| parse_lock_owner(&raw));
        if current.as_ref().map(|owner| owner.token.as_str()) == Some(self.token.as_str()) {
            let _ = fs::remove_file(&self.path);
        }
    }
}

fn runs_lock_path(runs_path: &Path) -> PathBuf {
    let mut lock_path: OsString = runs_path.as_os_str().to_os_string();
    lock_path.push(".lock");
    PathBuf::from(lock_path)
}

fn acquire_runs_lock(runs_path: &Path) -> Result<RunsLock> {
    acquire_runs_lock_with_timing(runs_path, RunsLockTiming::default())
}

fn acquire_runs_lock_with_timing(runs_path: &Path, timing: RunsLockTiming) -> Result<RunsLock> {
    crate::core::fs_utils::ensure_parent_dir(runs_path)?;
    let lock_path = runs_lock_path(runs_path);
    let owner = RunsLockOwner {
        token: uuid::Uuid::new_v4().to_string(),
        pid: std::process::id(),
        created_at: unix_time_millis(),
    };
    let deadline = Instant::now() + timing.timeout;

    loop {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o600);
        match options.open(&lock_path) {
            Ok(mut file) => {
                let mut encoded =
                    serde_json::to_vec(&owner).context("serializing Starling run lock owner")?;
                encoded.push(b'\n');
                // The lock coordinates live processes; it does not need crash
                // durability. Avoid fsync here because the descriptor remains
                // open and slow filesystems could otherwise consume the whole
                // shared five-second acquisition timeout.
                if let Err(error) = file.write_all(&encoded) {
                    drop(file);
                    let _ = fs::remove_file(&lock_path);
                    return Err(error).with_context(|| {
                        format!("writing Starling run lock {}", lock_path.display())
                    });
                }
                return Ok(RunsLock {
                    path: lock_path,
                    token: owner.token,
                    file: Some(file),
                });
            }
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {
                remove_stale_runs_lock(&lock_path, timing.malformed_stale_after)?;
                if Instant::now() >= deadline {
                    anyhow::bail!(
                        "timed out waiting for Starling run lock: {}",
                        lock_path.display()
                    );
                }
                thread::sleep(timing.retry);
            }
            Err(error) => {
                return Err(error).with_context(|| {
                    format!("creating Starling run lock {}", lock_path.display())
                });
            }
        }
    }
}

fn remove_stale_runs_lock(lock_path: &Path, malformed_stale_after: Duration) -> Result<()> {
    let raw = match fs::read_to_string(lock_path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(error)
                .with_context(|| format!("reading Starling run lock {}", lock_path.display()));
        }
    };

    let stale = match parse_lock_owner(&raw) {
        Some(owner) => !is_pid_alive(owner.pid),
        None => match fs::metadata(lock_path) {
            Ok(metadata) => metadata
                .modified()
                .ok()
                .and_then(|modified| SystemTime::now().duration_since(modified).ok())
                .map(|age| age >= malformed_stale_after)
                .unwrap_or(false),
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
            Err(error) => {
                return Err(error).with_context(|| {
                    format!("reading Starling run lock metadata {}", lock_path.display())
                });
            }
        },
    };
    if !stale {
        return Ok(());
    }

    // Re-read before unlinking, matching the Node lock protocol, so a stale
    // contender does not remove a different owner observed after the check.
    match fs::read_to_string(lock_path) {
        Ok(current) if current == raw => match fs::remove_file(lock_path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error)
                .with_context(|| format!("removing stale run lock {}", lock_path.display())),
        },
        Ok(_) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error)
            .with_context(|| format!("re-reading Starling run lock {}", lock_path.display())),
    }
}

fn parse_lock_owner(raw: &str) -> Option<RunsLockOwner> {
    serde_json::from_str(raw).ok()
}

fn unix_time_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| u64::try_from(duration.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
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

fn detected_provider_name(provider: crate::core::process_map::Provider) -> &'static str {
    match provider {
        crate::core::process_map::Provider::Claude => "claude",
        crate::core::process_map::Provider::Codex => "codex",
        crate::core::process_map::Provider::Pi => "pi",
    }
}

/// Scan running Claude, Codex, and Pi processes and map each to its session. In-memory —
/// does not write runs.json. Linux-only (empty elsewhere).
pub fn detect_running_sessions() -> HashMap<String, Vec<DetectedSession>> {
    let mapped = map_processes_to_sessions();
    let mut detected = HashMap::new();
    for (session_id, infos) in mapped {
        detected.insert(
            session_id,
            infos
                .into_iter()
                .map(|info| DetectedSession {
                    pid: if info.pid > 0 { Some(info.pid) } else { None },
                    provider: info
                        .provider
                        .map(detected_provider_name)
                        .unwrap_or_default()
                        .to_string(),
                    project_path: info.project_path,
                    file_path: info.file_path,
                    home: info.home,
                })
                .collect(),
        );
    }
    detected
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::fs_utils::test_support::with_temp_store;
    use std::process::{Command, Stdio};

    fn mk_run(
        run_id: &str,
        session_id: Option<&str>,
        status: RunStatus,
        started: &str,
    ) -> RunRecord {
        RunRecord {
            run_id: run_id.into(),
            session_id: session_id.map(String::from),
            session_file: None,
            model: None,
            title: None,
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
    fn run_metadata_is_additive_and_omitted_when_absent() {
        let legacy = serde_json::json!({
            "run_id": "legacy-run",
            "session_id": "legacy-session",
            "provider": "pi",
            "project_path": "/work/project",
            "pid": 42,
            "status": "running",
            "started_at": "2026-01-01T00:00:00Z",
            "source": "starling-run"
        });
        let mut record: RunRecord =
            serde_json::from_value(legacy).expect("legacy run record remains readable");
        assert_eq!(record.session_file, None);
        assert_eq!(record.model, None);
        assert_eq!(record.title, None);

        let sparse = serde_json::to_value(&record).expect("serialize sparse run record");
        assert!(sparse.get("session_file").is_none());
        assert!(sparse.get("model").is_none());
        assert!(sparse.get("title").is_none());

        record.session_file = Some("/sessions/pi.jsonl".into());
        record.model = Some("anthropic/claude".into());
        record.title = Some("SDK session".into());
        let enriched = serde_json::to_value(record).expect("serialize enriched run record");
        assert_eq!(enriched["session_file"], "/sessions/pi.jsonl");
        assert_eq!(enriched["model"], "anthropic/claude");
        assert_eq!(enriched["title"], "SDK session");
    }

    #[test]
    fn lock_file_matches_node_protocol_and_release_checks_token() {
        let path = unique_test_runs_path("lock-shape");
        let lock_path = runs_lock_path(&path);
        let lock = acquire_runs_lock(&path).expect("acquire run lock");

        let raw = fs::read_to_string(&lock_path).expect("read run lock");
        let owner: serde_json::Value = serde_json::from_str(&raw).expect("parse run lock");
        let object = owner.as_object().expect("lock owner object");
        let mut keys: Vec<&str> = object.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, vec!["createdAt", "pid", "token"]);
        assert_eq!(owner["pid"].as_u64(), Some(u64::from(std::process::id())));
        assert!(owner["createdAt"].as_u64().is_some());
        assert_eq!(owner["token"].as_str(), Some(lock.token.as_str()));

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&lock_path)
                    .expect("lock metadata")
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }

        let replacement = serde_json::json!({
            "token": "replacement-owner",
            "pid": std::process::id(),
            "createdAt": unix_time_millis()
        });
        fs::write(
            &lock_path,
            format!("{}\n", serde_json::to_string(&replacement).unwrap()),
        )
        .expect("replace owner for release check");
        drop(lock);
        assert!(
            lock_path.exists(),
            "release must not remove another owner's token"
        );

        let _ = fs::remove_file(lock_path);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn live_node_shaped_lock_is_not_removed_and_acquisition_times_out() {
        let path = unique_test_runs_path("live-node-lock");
        crate::core::fs_utils::ensure_parent_dir(&path).expect("create test parent");
        let lock_path = runs_lock_path(&path);
        let owner = serde_json::json!({
            "token": "node-live-owner",
            "pid": std::process::id(),
            "createdAt": unix_time_millis()
        });
        let raw = format!("{}\n", serde_json::to_string(&owner).unwrap());
        fs::write(&lock_path, &raw).expect("write Node-shaped lock");

        let result = acquire_runs_lock_with_timing(
            &path,
            RunsLockTiming {
                timeout: Duration::from_millis(25),
                retry: Duration::from_millis(1),
                // Even an age of zero must not make a valid live owner stale.
                malformed_stale_after: Duration::ZERO,
            },
        );
        let error = match result {
            Ok(_) => panic!("live Node-shaped lock must block Rust"),
            Err(error) => error,
        };
        assert!(error.to_string().contains("timed out waiting"));
        assert_eq!(fs::read_to_string(&lock_path).unwrap(), raw);

        let _ = fs::remove_file(lock_path);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn dead_pid_node_shaped_lock_is_recovered() {
        let path = unique_test_runs_path("dead-node-lock");
        crate::core::fs_utils::ensure_parent_dir(&path).expect("create test parent");
        let lock_path = runs_lock_path(&path);
        // `sh` may not exist on Windows (and MSYS sh pids can linger as
        // openable handles after exit), so spawn the platform shell instead.
        let mut child = if cfg!(windows) {
            Command::new("cmd").arg("/C").arg("exit 0").spawn()
        } else {
            Command::new("sh").arg("-c").arg("exit 0").spawn()
        }
        .expect("spawn short-lived owner");
        let dead_pid = child.id();
        assert!(child.wait().expect("wait for owner").success());
        // On Windows the process object lives while any handle is open:
        // `wait()` returns but the Child still owns the handle, so drop it to
        // complete the "reap" before asserting the pid is dead.
        drop(child);
        assert!(!is_pid_alive(dead_pid));
        let owner = serde_json::json!({
            "token": "node-dead-owner",
            "pid": dead_pid,
            "createdAt": unix_time_millis()
        });
        fs::write(
            &lock_path,
            format!("{}\n", serde_json::to_string(&owner).unwrap()),
        )
        .expect("write stale Node-shaped lock");

        let lock = acquire_runs_lock_with_timing(
            &path,
            RunsLockTiming {
                timeout: Duration::from_millis(250),
                retry: Duration::from_millis(1),
                malformed_stale_after: RUNS_LOCK_STALE,
            },
        )
        .expect("recover dead owner lock");
        let current = parse_lock_owner(&fs::read_to_string(&lock_path).unwrap()).unwrap();
        assert_eq!(current.token, lock.token);
        assert_ne!(current.token, "node-dead-owner");
        drop(lock);
        assert!(!lock_path.exists());

        let _ = fs::remove_file(path);
    }

    #[test]
    fn concurrent_process_writers_do_not_lose_run_records() {
        let path = unique_test_runs_path("process-writers");
        let executable = std::env::current_exe().expect("current Rust test executable");
        let mut children = Vec::new();
        for index in 0..4 {
            children.push(
                Command::new(&executable)
                    .arg("--exact")
                    .arg("core::runs::tests::cross_process_run_writer_worker")
                    .arg("--nocapture")
                    .env("STARLING_RUNS_LOCK_TEST_PATH", &path)
                    .env("STARLING_RUNS_LOCK_TEST_ID", format!("writer-{index}"))
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
                    .expect("spawn concurrent run writer"),
            );
        }
        for mut child in children {
            assert!(
                child.wait().expect("wait for run writer").success(),
                "run writer child failed"
            );
        }

        let data = load_runs_from(&path);
        assert_eq!(data.runs.len(), 4);
        for index in 0..4 {
            let run_id = format!("writer-{index}");
            let run = data
                .runs
                .iter()
                .find(|run| run.run_id == run_id)
                .expect("all concurrent creates are retained");
            assert_eq!(run.session_id.as_deref(), Some("patched-session"));
        }

        let _ = fs::remove_file(runs_lock_path(&path));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn cross_process_run_writer_worker() {
        let Ok(path) = std::env::var("STARLING_RUNS_LOCK_TEST_PATH") else {
            return;
        };
        let run_id = std::env::var("STARLING_RUNS_LOCK_TEST_ID").expect("worker run id");
        let path = PathBuf::from(path);
        let mut record = mk_run(
            &run_id,
            Some("patched-session"),
            RunStatus::Running,
            "2026-07-28T00:00:00Z",
        );
        record.pid = Some(std::process::id());
        mutate_runs_at_path(&path, move |data| {
            data.runs.push(record);
            ((), true)
        })
        .expect("worker create transaction");
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

            assert!(patch_run(
                "r1",
                RunPatch {
                    pid: Some(4242),
                    session_file: Some("/sessions/r1.jsonl".into()),
                    model: Some("anthropic/sdk-model".into()),
                    title: Some("SDK title".into()),
                    ..Default::default()
                }
            ));

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
            assert_eq!(r.pid, Some(4242));
            assert_eq!(r.session_file.as_deref(), Some("/sessions/r1.jsonl"));
            assert_eq!(r.model.as_deref(), Some("anthropic/sdk-model"));
            assert_eq!(r.title.as_deref(), Some("SDK title"));

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

    #[test]
    fn list_runs_filters_pi_provider() {
        with_temp_store(|| {
            let path = test_runs_path("starling-runs-pi-filter-test.json");
            std::env::set_var("STARLING_RUNS", &path);
            let _ = std::fs::remove_file(&path);

            let mut pi_run = mk_run(
                "pi-run",
                Some("PiSession_01"),
                RunStatus::Running,
                "2026-03-01T00:00:00Z",
            );
            pi_run.provider = crate::types::RunProvider::Pi;
            create_run(pi_run);
            create_run(mk_run(
                "claude-run",
                Some("claude-session"),
                RunStatus::Running,
                "2026-03-02T00:00:00Z",
            ));

            let runs = list_runs(Some(ListFilter {
                provider: Some("pi".into()),
                ..Default::default()
            }));
            assert_eq!(runs.len(), 1);
            assert_eq!(runs[0].run_id, "pi-run");
            assert_eq!(runs[0].provider, crate::types::RunProvider::Pi);

            let _ = std::fs::remove_file(&path);
            std::env::remove_var("STARLING_RUNS");
        });
    }

    #[test]
    fn detected_provider_name_includes_pi() {
        assert_eq!(
            detected_provider_name(crate::core::process_map::Provider::Claude),
            "claude"
        );
        assert_eq!(
            detected_provider_name(crate::core::process_map::Provider::Codex),
            "codex"
        );
        assert_eq!(
            detected_provider_name(crate::core::process_map::Provider::Pi),
            "pi"
        );
    }

    fn test_runs_path(name: &str) -> PathBuf {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/test-data");
        let _ = std::fs::create_dir_all(&dir);
        dir.join(name)
    }

    fn unique_test_runs_path(label: &str) -> PathBuf {
        PathBuf::from("/tmp").join(format!(
            "starling-runs-{label}-{}-{}.json",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or(0)
        ))
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
        with_temp_store(|| {
            let path = test_runs_path("starling-runs-summary-test.json");
            std::env::set_var("STARLING_RUNS", &path);
            let _ = std::fs::remove_file(&path);

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
            let s = summarize_run_status(&b, false);
            assert!(s.contains("·1") || s == "·", "got: {s}");

            let _ = std::fs::remove_file(&path);
            std::env::remove_var("STARLING_RUNS");
        });
    }
}
