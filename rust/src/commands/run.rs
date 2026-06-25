//! `starling run` — agent launch with run-record tracking.

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use anyhow::Result;
use colored::*;
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::cli::*;
use crate::constants::{
    default_claude_settings_dir, default_codex_home, default_codex_settings_dir,
    default_starling_home, now_iso,
};
use crate::core::catalog_resolver::{resolve_catalog_reference, CatalogResolution};
use crate::core::discovery::{
    canonical_session_id, find_session_by_id, find_sessions, Provider as DiscoveryProvider,
};
use crate::core::id::generate_bookmark_id;
use crate::core::mcp_config::{effective_servers, McpServerConfig};
use crate::core::osc_state::{status_from_osc_sequence, upsert_osc_state, OscSessionState};
use crate::core::process_map::map_process_tree_to_session_since;
use crate::core::runs::{
    create_run, finalize_run, find_run, list_runs, mark_run_crashed, remove_run, FinalizePatch,
    RunStatus,
};
use crate::core::session::{
    extract_claude_session_meta, extract_codex_session_meta, parse_jsonl_head,
};
use crate::core::session_display::short_session_id;
use crate::core::store::{add_bookmark, find_bookmark, update_bookmark, BookmarkPatch};
use crate::types::{Bookmark, RunProvider, RunRecord, RunSource, SessionMeta};

pub fn handle(cmd: RunCommand) -> Result<()> {
    match &cmd.command {
        RunSubcommand::Claude { args } => launch(RunProvider::Claude, "claude", &cmd, args),
        RunSubcommand::Codex { args } => launch(RunProvider::Codex, "codex", &cmd, args),
        RunSubcommand::Status { run_id, json } => status(run_id.as_deref(), *json),
        RunSubcommand::Stop { run_id, json } => stop(run_id, *json),
    }
}

const STARLING_RUN_PTY_ENV: &str = "STARLING_RUN_PTY";

struct PreparedLaunch {
    args: Vec<String>,
    envs: Vec<(String, String)>,
    temp_dir: Option<PathBuf>,
    cleanup_files: Vec<PathBuf>,
    hook_file: Option<PathBuf>,
}

fn launch(
    provider: RunProvider,
    bin: &str,
    cmd_args: &RunCommand,
    passthrough_args: &[String],
) -> Result<()> {
    let run_id = uuid::Uuid::new_v4().to_string();
    let start_ms = now_ms();
    let started_at = now_iso();
    let cwd = cmd_args.cwd.as_ref().map(PathBuf::from);
    let project_path = cwd
        .clone()
        .or_else(|| std::env::current_dir().ok())
        .map(|p| p.to_string_lossy().to_string());
    let catalog_id = resolve_catalog_id(cmd_args.catalog.as_deref());
    let prepared = prepare_launch(
        provider,
        &run_id,
        cmd_args.setting.as_deref(),
        passthrough_args,
        true,
        &cmd_args.mcp,
        cmd_args.mcp_profile.as_deref(),
        cmd_args.no_mcp,
    )?;

    // Pre-spawn record (pid unknown yet).
    let record = RunRecord {
        run_id: run_id.clone(),
        session_id: None,
        provider,
        project_path: project_path.clone(),
        catalog_id: catalog_id.clone(),
        setting: cmd_args.setting.clone(),
        pid: None,
        status: RunStatus::Running,
        exit_code: None,
        started_at: started_at.clone(),
        ended_at: None,
        source: RunSource::StarlingRun,
    };
    create_run(record);

    eprintln!("{} run {} ({})", "starling".cyan(), short(&run_id), bin);

    #[cfg(unix)]
    if pty_monitor_enabled(provider) {
        match spawn_pty_child(bin, &prepared.args, &prepared.envs, cwd.as_deref()) {
            Ok(pty_child) => {
                let pid = pty_child.pid as u32;
                update_run_pid(&run_id, pid);
                maybe_start_catalog_assignment_watcher(
                    run_id.clone(),
                    pid,
                    provider,
                    catalog_id.clone(),
                    cmd_args.title.clone(),
                    project_path.clone(),
                    start_ms,
                    prepared.hook_file.clone(),
                );
                install_signal_handler(run_id.clone());

                let status =
                    drive_pty_child(pty_child, provider, &run_id, prepared.hook_file.as_deref());
                assign_recent_session_fallback(
                    &run_id,
                    provider,
                    pid,
                    catalog_id.as_deref(),
                    cmd_args.title.as_deref(),
                    project_path.as_deref(),
                    start_ms,
                );
                match status {
                    Ok(exit) => {
                        finalize_run(
                            &run_id,
                            FinalizePatch {
                                status: if exit.success {
                                    RunStatus::Completed
                                } else {
                                    RunStatus::Errored
                                },
                                exit_code: exit.code,
                                ended_at: Some(now_iso()),
                                session_id: None,
                            },
                        );
                        cleanup_launch_artifacts(&prepared);
                        std::process::exit(exit.code.unwrap_or(if exit.success { 0 } else { 1 }));
                    }
                    Err(e) => {
                        eprintln!("{}: PTY monitor failed: {}", "error".red(), e);
                        mark_run_crashed(&run_id);
                        cleanup_launch_artifacts(&prepared);
                        std::process::exit(1);
                    }
                }
            }
            Err(e) => {
                eprintln!(
                    "{}: PTY monitor unavailable, falling back to inherited terminal: {}",
                    "warning".yellow(),
                    e
                );
            }
        }
    }

    let mut cmd = Command::new(bin);
    cmd.args(&prepared.args);
    for (key, value) in &prepared.envs {
        cmd.env(key, value);
    }
    if let Some(cwd) = &cwd {
        cmd.current_dir(cwd);
    }
    cmd.stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());

    match cmd.spawn() {
        Ok(mut child) => {
            // Update record with pid.
            let pid = child.id();
            update_run_pid(&run_id, pid);
            maybe_start_catalog_assignment_watcher(
                run_id.clone(),
                pid,
                provider,
                catalog_id.clone(),
                cmd_args.title.clone(),
                project_path.clone(),
                start_ms,
                prepared.hook_file.clone(),
            );

            // Install SIGINT/SIGTERM handler so Ctrl-C marks the run crashed.
            install_signal_handler(run_id.clone());

            match child.wait() {
                Ok(status) => {
                    assign_recent_session_fallback(
                        &run_id,
                        provider,
                        pid,
                        catalog_id.as_deref(),
                        cmd_args.title.as_deref(),
                        project_path.as_deref(),
                        start_ms,
                    );
                    let final_status = if status.success() {
                        RunStatus::Completed
                    } else {
                        RunStatus::Errored
                    };
                    finalize_run(
                        &run_id,
                        FinalizePatch {
                            status: final_status,
                            exit_code: status.code(),
                            ended_at: Some(now_iso()),
                            session_id: None,
                        },
                    );
                    cleanup_launch_artifacts(&prepared);
                    std::process::exit(status.code().unwrap_or(0));
                }
                Err(e) => {
                    eprintln!("{}: failed to wait on {}: {}", "error".red(), bin, e);
                    mark_run_crashed(&run_id);
                    cleanup_launch_artifacts(&prepared);
                    std::process::exit(1);
                }
            }
        }
        Err(e) => {
            eprintln!("{}: failed to spawn {}: {}", "error".red(), bin, e);
            // Mark as crashed since we recorded a Running entry.
            mark_run_crashed(&run_id);
            cleanup_launch_artifacts(&prepared);
            std::process::exit(1);
        }
    }
}

#[cfg(unix)]
struct PtyChild {
    pid: libc::pid_t,
    master_fd: libc::c_int,
}

#[cfg(unix)]
struct PtyExit {
    code: Option<i32>,
    success: bool,
}

#[cfg(unix)]
fn pty_monitor_enabled(provider: RunProvider) -> bool {
    if provider != RunProvider::Claude {
        return false;
    }
    if std::env::var(STARLING_RUN_PTY_ENV)
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "0" | "false" | "no" | "off"
            )
        })
        .unwrap_or(false)
    {
        return false;
    }
    unsafe { libc::isatty(libc::STDIN_FILENO) == 1 && libc::isatty(libc::STDOUT_FILENO) == 1 }
}

#[cfg(unix)]
fn spawn_pty_child(
    bin: &str,
    args: &[String],
    envs: &[(String, String)],
    cwd: Option<&Path>,
) -> Result<PtyChild> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let mut master_fd: libc::c_int = -1;
    let mut winsize = current_winsize();
    let winp = if winsize.ws_col > 0 && winsize.ws_row > 0 {
        &mut winsize as *mut libc::winsize
    } else {
        std::ptr::null_mut()
    };

    let pid = unsafe {
        libc::forkpty(
            &mut master_fd as *mut libc::c_int,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            winp,
        )
    };
    if pid < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    if pid == 0 {
        for (key, value) in envs {
            if let (Ok(key), Ok(value)) = (CString::new(key.as_str()), CString::new(value.as_str()))
            {
                unsafe {
                    libc::setenv(key.as_ptr(), value.as_ptr(), 1);
                }
            }
        }
        if let Some(cwd) = cwd {
            if let Ok(path) = CString::new(cwd.as_os_str().as_bytes()) {
                unsafe {
                    libc::chdir(path.as_ptr());
                }
            }
        }

        let c_bin = CString::new(bin).unwrap_or_else(|_| CString::new("false").unwrap());
        let mut c_args = Vec::with_capacity(args.len() + 1);
        c_args.push(c_bin.clone());
        for arg in args {
            match CString::new(arg.as_str()) {
                Ok(value) => c_args.push(value),
                Err(_) => unsafe {
                    libc::_exit(127);
                },
            }
        }
        let mut argv = c_args.iter().map(|s| s.as_ptr()).collect::<Vec<_>>();
        argv.push(std::ptr::null());
        unsafe {
            libc::execvp(c_bin.as_ptr(), argv.as_ptr());
            libc::_exit(127);
        }
    }

    Ok(PtyChild { pid, master_fd })
}

#[cfg(unix)]
fn current_winsize() -> libc::winsize {
    let mut winsize = libc::winsize {
        ws_row: 0,
        ws_col: 0,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    unsafe {
        libc::ioctl(
            libc::STDOUT_FILENO,
            libc::TIOCGWINSZ,
            &mut winsize as *mut libc::winsize,
        );
    }
    winsize
}

#[cfg(unix)]
fn drive_pty_child(
    child: PtyChild,
    provider: RunProvider,
    run_id: &str,
    hook_file: Option<&Path>,
) -> Result<PtyExit> {
    let raw_mode = crossterm::terminal::enable_raw_mode().is_ok();
    let input_fd = unsafe { libc::dup(child.master_fd) };
    if input_fd >= 0 {
        std::thread::spawn(move || {
            let mut stdin = std::io::stdin();
            let mut buf = [0_u8; 8192];
            while let Ok(n) = stdin.read(&mut buf) {
                if n == 0 || write_all_fd(input_fd, &buf[..n]).is_err() {
                    break;
                }
            }
            unsafe {
                libc::close(input_fd);
            }
        });
    }

    let mut osc_buffer = String::new();
    let mut read_buf = [0_u8; 8192];
    let mut last_recorded: Option<(String, String, Option<String>, u64)> = None;

    loop {
        let n = unsafe {
            libc::read(
                child.master_fd,
                read_buf.as_mut_ptr() as *mut libc::c_void,
                read_buf.len(),
            )
        };
        if n > 0 {
            let chunk = &read_buf[..n as usize];
            let _ = std::io::stdout().write_all(chunk);
            let _ = std::io::stdout().flush();
            observe_pty_osc_chunk(
                &mut osc_buffer,
                chunk,
                provider,
                run_id,
                child.pid as u32,
                hook_file,
                &mut last_recorded,
            );
            continue;
        }
        if n == 0 {
            break;
        }
        let err = std::io::Error::last_os_error();
        if err.raw_os_error() == Some(libc::EINTR) {
            continue;
        }
        // Linux returns EIO when the PTY slave closes.
        if err.raw_os_error() == Some(libc::EIO) {
            break;
        }
        unsafe {
            libc::close(child.master_fd);
        }
        if raw_mode {
            let _ = crossterm::terminal::disable_raw_mode();
        }
        return Err(err.into());
    }

    unsafe {
        libc::close(child.master_fd);
    }
    if raw_mode {
        let _ = crossterm::terminal::disable_raw_mode();
    }

    let mut status: libc::c_int = 0;
    loop {
        let waited = unsafe { libc::waitpid(child.pid, &mut status as *mut libc::c_int, 0) };
        if waited >= 0 {
            break;
        }
        let err = std::io::Error::last_os_error();
        if err.raw_os_error() != Some(libc::EINTR) {
            return Err(err.into());
        }
    }

    Ok(pty_exit_from_wait_status(status))
}

#[cfg(unix)]
fn write_all_fd(fd: libc::c_int, mut bytes: &[u8]) -> std::io::Result<()> {
    while !bytes.is_empty() {
        let n = unsafe { libc::write(fd, bytes.as_ptr() as *const libc::c_void, bytes.len()) };
        if n > 0 {
            bytes = &bytes[n as usize..];
            continue;
        }
        if n == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::WriteZero,
                "PTY write returned zero",
            ));
        }
        let err = std::io::Error::last_os_error();
        if err.raw_os_error() != Some(libc::EINTR) {
            return Err(err);
        }
    }
    Ok(())
}

#[cfg(unix)]
fn pty_exit_from_wait_status(status: libc::c_int) -> PtyExit {
    if libc::WIFEXITED(status) {
        let code = libc::WEXITSTATUS(status);
        return PtyExit {
            code: Some(code),
            success: code == 0,
        };
    }
    if libc::WIFSIGNALED(status) {
        let signal = libc::WTERMSIG(status);
        return PtyExit {
            code: Some(128 + signal),
            success: false,
        };
    }
    PtyExit {
        code: None,
        success: false,
    }
}

#[cfg(unix)]
fn observe_pty_osc_chunk(
    buffer: &mut String,
    chunk: &[u8],
    provider: RunProvider,
    run_id: &str,
    pid: u32,
    hook_file: Option<&Path>,
    last_recorded: &mut Option<(String, String, Option<String>, u64)>,
) {
    buffer.push_str(&String::from_utf8_lossy(chunk));
    for sequence in drain_osc_sequences(buffer) {
        let Some((status, source, message)) = status_from_osc_sequence(&sequence) else {
            continue;
        };
        let now = now_ms();
        let key = (status.clone(), source.clone(), message.clone(), now);
        if last_recorded
            .as_ref()
            .map(|(last_status, last_source, last_message, last_ms)| {
                last_status == &status
                    && last_source == &source
                    && last_message == &message
                    && now.saturating_sub(*last_ms) < 250
            })
            .unwrap_or(false)
        {
            continue;
        }

        let Some(session_id) = hook_file.and_then(read_hook_session).map(|h| h.session_id) else {
            continue;
        };
        let state = OscSessionState {
            session_id: canonical_session_id(&session_id),
            pid: Some(pid),
            run_id: Some(run_id.to_string()),
            model: None,
            status,
            message,
            context_used_pct: None,
            context_remaining_pct: None,
            source: format!("{}-pty:{source}", provider_name(provider)),
            updated_at_ms: now,
        };
        let _ = upsert_osc_state(state);
        *last_recorded = Some(key);
    }
}

#[cfg(unix)]
fn drain_osc_sequences(buffer: &mut String) -> Vec<String> {
    let mut sequences = Vec::new();
    loop {
        let Some(start) = buffer.find("\u{1b}]") else {
            if buffer.len() > 4096 {
                buffer.clear();
            }
            break;
        };
        if start > 0 {
            buffer.drain(..start);
        }
        let bel = buffer[2..].find('\u{7}').map(|idx| idx + 3);
        let st = buffer[2..].find("\u{1b}\\").map(|idx| idx + 4);
        let end = match (bel, st) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (Some(a), None) => Some(a),
            (None, Some(b)) => Some(b),
            (None, None) => None,
        };
        let Some(end) = end else {
            if buffer.len() > 8192 {
                buffer.drain(..buffer.len().saturating_sub(8192));
            }
            break;
        };
        sequences.push(buffer[..end].to_string());
        buffer.drain(..end);
    }
    sequences
}

fn maybe_start_catalog_assignment_watcher(
    run_id: String,
    pid: u32,
    provider: RunProvider,
    catalog_id: Option<String>,
    title: Option<String>,
    project_path: Option<String>,
    start_ms: u64,
    hook_file: Option<PathBuf>,
) {
    let Some(catalog_id) = catalog_id else {
        return;
    };
    std::thread::spawn(move || {
        while crate::core::runs::is_pid_alive(pid) {
            if let Some(hook) = hook_file.as_deref().and_then(read_hook_session) {
                let project = hook
                    .cwd
                    .or_else(|| project_path.clone())
                    .unwrap_or_default();
                assign_session_to_catalog(
                    &run_id,
                    provider,
                    &hook.session_id,
                    hook.transcript_path.as_deref(),
                    &project,
                    title.as_deref(),
                    hook.prompt.as_deref(),
                    &catalog_id,
                );
                return;
            }
            if should_try_process_map_assignment(provider, hook_file.is_some()) {
                if let Some(mapped) = map_process_tree_to_session_since(pid, start_ms) {
                    if let Some(session_id) = mapped.session_id {
                        let file_path = mapped.file_path.clone();
                        let project = mapped
                            .project_path
                            .or_else(|| project_path.clone())
                            .unwrap_or_default();
                        assign_session_to_catalog(
                            &run_id,
                            provider,
                            &session_id,
                            file_path.as_deref(),
                            &project,
                            title.as_deref(),
                            None,
                            &catalog_id,
                        );
                        return;
                    }
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(500));
        }
    });
}

fn should_try_process_map_assignment(provider: RunProvider, hook_file_present: bool) -> bool {
    !hook_file_present || provider == RunProvider::Codex
}

struct HookSession {
    session_id: String,
    transcript_path: Option<String>,
    cwd: Option<String>,
    prompt: Option<String>,
}

fn read_hook_session(path: &Path) -> Option<HookSession> {
    let raw = std::fs::read_to_string(path).ok()?;
    for line in raw.lines().rev() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let value: Value = serde_json::from_str(trimmed).ok()?;
        let session_id = value
            .get("session_id")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())?
            .to_string();
        let transcript_path = value
            .get("transcript_path")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(String::from);
        let cwd = value
            .get("cwd")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(String::from);
        let prompt = value
            .get("prompt")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(String::from);
        return Some(HookSession {
            session_id,
            transcript_path,
            cwd,
            prompt,
        });
    }
    None
}

fn assign_recent_session_fallback(
    run_id: &str,
    provider: RunProvider,
    pid: u32,
    catalog_id: Option<&str>,
    title: Option<&str>,
    project_path: Option<&str>,
    start_ms: u64,
) {
    let Some(catalog_id) = catalog_id else {
        return;
    };
    if run_has_session_id(run_id) {
        return;
    }
    if let Some(mapped) = map_process_tree_to_session_since(pid, start_ms) {
        if let Some(session_id) = mapped.session_id {
            let project = mapped
                .project_path
                .as_deref()
                .or(project_path)
                .unwrap_or_default();
            assign_session_to_catalog(
                run_id,
                provider,
                &session_id,
                mapped.file_path.as_deref(),
                project,
                title,
                None,
                catalog_id,
            );
            return;
        }
    }
    if run_has_session_id(run_id) {
        return;
    }
    let sessions = find_sessions(20, Some(discovery_provider(provider)));
    let candidate = sessions.into_iter().find(|session| {
        if let Some(project_path) = project_path {
            if session.project_path != project_path {
                return false;
            }
        }
        session_modified_ms(&session.created_at)
            .map(|ms| ms >= start_ms)
            .unwrap_or(false)
    });
    if let Some(session) = candidate {
        assign_session_to_catalog(
            run_id,
            provider,
            &session.session_id,
            Some(&session.file_path),
            &session.project_path,
            title,
            None,
            catalog_id,
        );
    }
}

fn run_has_session_id(run_id: &str) -> bool {
    find_run(run_id)
        .and_then(|run| run.session_id)
        .map(|session_id| !session_id.is_empty())
        .unwrap_or(false)
}

fn assign_session_to_catalog(
    run_id: &str,
    provider: RunProvider,
    session_id: &str,
    file_path: Option<&str>,
    project_path: &str,
    title: Option<&str>,
    first_prompt_hint: Option<&str>,
    catalog_id: &str,
) {
    let canonical_id = canonical_session_id(session_id);
    update_run_session_id(run_id, &canonical_id);

    let meta = file_path.and_then(|path| session_meta_from_path(provider, path));
    let inferred_title = bookmark_title(title.or(first_prompt_hint), meta.as_ref(), &canonical_id);
    let first_prompt = meta
        .as_ref()
        .map(|m| m.first_prompt.clone())
        .or_else(|| first_prompt_hint.map(str::to_string))
        .unwrap_or_default();
    let effective_project_path = meta
        .as_ref()
        .map(|m| m.project_path.as_str())
        .filter(|p| !p.trim().is_empty())
        .unwrap_or(project_path);

    let bookmark = if let Some(existing) = find_bookmark(&canonical_id) {
        maybe_update_placeholder_title(existing, title.or(first_prompt_hint), &inferred_title)
    } else if let Some(existing) = find_bookmark(session_id) {
        update_bookmark(
            &existing.id,
            BookmarkPatch {
                session_id: Some(canonical_id.clone()),
                ..Default::default()
            },
        )
        .map(|updated| {
            maybe_update_placeholder_title(updated, title.or(first_prompt_hint), &inferred_title)
        })
        .unwrap_or(existing)
    } else {
        let store = crate::core::store::load_store();
        let bookmark = Bookmark {
            id: generate_bookmark_id(&store.bookmarks),
            provider: provider_name(provider).into(),
            session_id: canonical_id.clone(),
            title: inferred_title,
            category: String::new(),
            tags: vec![],
            project_path: effective_project_path.into(),
            first_prompt,
            notes: vec![],
            space_ids: vec![],
            created_at: now_iso(),
            updated_at: now_iso(),
        };
        add_bookmark(bookmark)
    };

    let mut ids = bookmark.space_ids.clone();
    if !ids.contains(&catalog_id.to_string()) {
        ids.push(catalog_id.into());
        let _ = update_bookmark(
            &bookmark.id,
            BookmarkPatch {
                space_ids: Some(ids),
                ..Default::default()
            },
        );
        let _ = file_path;
    }
}

fn session_meta_from_path(provider: RunProvider, file_path: &str) -> Option<SessionMeta> {
    let path = Path::new(file_path);
    if !path.exists() {
        return None;
    }
    let entries = parse_jsonl_head(path, 1000);
    let modified_at = now_iso();
    Some(match provider {
        RunProvider::Claude => extract_claude_session_meta(&entries, path, &modified_at),
        RunProvider::Codex => extract_codex_session_meta(&entries, path, &modified_at),
    })
}

fn bookmark_title(
    explicit: Option<&str>,
    meta: Option<&SessionMeta>,
    canonical_id: &str,
) -> String {
    if let Some(title) = explicit.map(str::trim).filter(|t| !t.is_empty()) {
        return title.to_string();
    }
    if let Some(title) = meta
        .and_then(|m| m.custom_title.as_deref())
        .map(str::trim)
        .filter(|t| !t.is_empty())
    {
        return title.to_string();
    }
    if let Some(prompt) = meta
        .map(|m| m.first_prompt.as_str())
        .map(str::trim)
        .filter(|p| !p.is_empty())
    {
        return prompt.chars().take(80).collect();
    }
    short_session_id(canonical_id).to_string()
}

fn maybe_update_placeholder_title(
    bookmark: Bookmark,
    explicit_title: Option<&str>,
    inferred_title: &str,
) -> Bookmark {
    if explicit_title
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .is_some()
        || (bookmark.title.trim() == "running session"
            && inferred_title.trim() != "running session")
    {
        update_bookmark(
            &bookmark.id,
            BookmarkPatch {
                title: Some(inferred_title.to_string()),
                ..Default::default()
            },
        )
        .unwrap_or(bookmark)
    } else {
        bookmark
    }
}

fn provider_name(provider: RunProvider) -> &'static str {
    match provider {
        RunProvider::Claude => "claude",
        RunProvider::Codex => "codex",
    }
}

fn discovery_provider(provider: RunProvider) -> DiscoveryProvider {
    match provider {
        RunProvider::Claude => DiscoveryProvider::Claude,
        RunProvider::Codex => DiscoveryProvider::Codex,
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn session_modified_ms(value: &str) -> Option<u64> {
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|dt| dt.timestamp_millis().max(0) as u64)
}

fn resolve_catalog_id(catalog: Option<&str>) -> Option<String> {
    let catalog = catalog?;
    match resolve_catalog_reference(catalog) {
        CatalogResolution::Found(space) => Some(space.id),
        CatalogResolution::Ambiguous(matches) => {
            eprintln!(
                "{}: ambiguous catalog '{}': {}",
                "error".red(),
                catalog,
                matches
                    .iter()
                    .map(|s| s.name.clone())
                    .collect::<Vec<_>>()
                    .join(", ")
            );
            std::process::exit(2);
        }
        CatalogResolution::NotFound => {
            eprintln!("{}: catalog not found: {}", "error".red(), catalog);
            std::process::exit(2);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::TokenUsage;
    use std::io::Write;

    fn meta(first_prompt: &str, custom_title: Option<&str>) -> SessionMeta {
        SessionMeta {
            session_id: "019edf66-d8f0-71d0-9283-e75d6da02af4".into(),
            provider: "codex".into(),
            model: "gpt-5.5".into(),
            project_path: "/tmp/project".into(),
            first_prompt: first_prompt.into(),
            custom_title: custom_title.map(String::from),
            file_path: "/tmp/session.jsonl".into(),
            created_at: "now".into(),
            modified_at: "now".into(),
            token_usage: Some(TokenUsage {
                input_tokens: Some(1),
                output_tokens: Some(2),
                total_tokens: Some(3),
                cache_tokens: None,
            }),
        }
    }

    #[test]
    fn bookmark_title_prefers_explicit_title() {
        let m = meta("first prompt", Some("custom"));
        assert_eq!(
            bookmark_title(Some("manual"), Some(&m), &m.session_id),
            "manual"
        );
    }

    #[test]
    fn bookmark_title_uses_custom_title_then_prompt() {
        let with_custom = meta("first prompt", Some("custom"));
        assert_eq!(
            bookmark_title(None, Some(&with_custom), &with_custom.session_id),
            "custom"
        );

        let without_custom = meta("first prompt", None);
        assert_eq!(
            bookmark_title(None, Some(&without_custom), &without_custom.session_id),
            "first prompt"
        );
    }

    #[test]
    fn bookmark_title_falls_back_to_short_session_id() {
        let m = meta("", None);
        assert_eq!(
            bookmark_title(None, Some(&m), &m.session_id),
            "019edf66-d8f0"
        );
        assert_eq!(bookmark_title(None, None, &m.session_id), "019edf66-d8f0");
    }

    #[test]
    fn reads_session_from_run_hook_file() {
        let path = std::env::temp_dir().join(format!(
            "starling-run-hook-{}.jsonl",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        {
            let mut f = std::fs::File::create(&path).unwrap();
            writeln!(f, "{{\"hook_event_name\":\"SessionStart\"}}").unwrap();
            writeln!(
                f,
                "{}",
                serde_json::json!({
                    "session_id": "73f64f49-9fa0-4bbe-b434-2ec7d0c670a9",
                    "transcript_path": "/tmp/session.jsonl",
                    "cwd": "/tmp/project",
                    "prompt": "hello from hook"
                })
            )
            .unwrap();
        }
        let hook = read_hook_session(&path).expect("hook session");
        assert_eq!(hook.session_id, "73f64f49-9fa0-4bbe-b434-2ec7d0c670a9");
        assert_eq!(hook.transcript_path.as_deref(), Some("/tmp/session.jsonl"));
        assert_eq!(hook.cwd.as_deref(), Some("/tmp/project"));
        assert_eq!(hook.prompt.as_deref(), Some("hello from hook"));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn codex_catalog_watcher_keeps_process_map_fallback_with_hooks() {
        assert!(should_try_process_map_assignment(RunProvider::Codex, true));
        assert!(should_try_process_map_assignment(RunProvider::Codex, false));
        assert!(!should_try_process_map_assignment(
            RunProvider::Claude,
            true
        ));
        assert!(should_try_process_map_assignment(
            RunProvider::Claude,
            false
        ));
    }

    #[cfg(unix)]
    #[test]
    fn drains_complete_osc_sequences_and_keeps_partial_tail() {
        let mut buffer =
            format!("noise\u{1b}]0;\u{2801} running\u{7}middle\u{1b}]9;Claude is waiting");
        let sequences = drain_osc_sequences(&mut buffer);

        assert_eq!(sequences.len(), 1);
        assert_eq!(sequences[0], format!("\u{1b}]0;\u{2801} running\u{7}"));
        assert_eq!(buffer, "\u{1b}]9;Claude is waiting");

        buffer.push_str(" for your input\u{7}");
        let sequences = drain_osc_sequences(&mut buffer);
        assert_eq!(sequences.len(), 1);
        assert_eq!(
            sequences[0],
            "\u{1b}]9;Claude is waiting for your input\u{7}"
        );
        assert!(buffer.is_empty());
    }

    #[test]
    fn installs_runtime_hooks_for_claude_launches() {
        let mut settings = serde_json::json!({});
        let hook_file = PathBuf::from("/tmp/starling-hook.jsonl");
        let starling_exe = PathBuf::from("/tmp/starling");

        install_claude_runtime_hooks(&mut settings, "run-1", &hook_file, &starling_exe);

        let hooks = settings
            .get("hooks")
            .and_then(|v| v.as_object())
            .expect("hooks object");
        for event in CLAUDE_RUNTIME_HOOK_EVENTS {
            let arr = hooks
                .get(*event)
                .and_then(|v| v.as_array())
                .expect("event hook");
            let handler = &arr[0]["hooks"][0];
            assert_eq!(handler["type"], "command");
            let command = handler["command"].as_str().expect("command");
            assert!(command.contains("/tmp/starling top hook"));
            assert!(command.contains("--provider claude"));
            assert!(command.contains("--run-id run-1"));
            assert!(command.contains("--hook-file /tmp/starling-hook.jsonl"));
        }
        let status_line = settings
            .get("statusLine")
            .and_then(|v| v.as_object())
            .expect("statusLine object");
        assert_eq!(
            status_line.get("type").and_then(|v| v.as_str()),
            Some("command")
        );
        let command = status_line
            .get("command")
            .and_then(|v| v.as_str())
            .expect("statusLine command");
        assert!(command.contains("/tmp/starling top hook"));
        assert!(command.contains("--provider claude"));
        assert!(command.contains("--event StatusLine"));
        assert!(command.contains("--run-id run-1"));
        assert!(command.contains("--hook-file /tmp/starling-hook.jsonl"));
        assert!(settings.get("mcpServers").is_none());
    }

    #[test]
    fn claude_mcp_servers_render_as_mcp_config_json() {
        let mut servers = BTreeMap::new();
        servers.insert(
            "starling".to_string(),
            McpServerConfig {
                r#type: "stdio".to_string(),
                enabled: true,
                builtin: true,
                command: Some("/tmp/starling".to_string()),
                args: vec![
                    "mcp".to_string(),
                    "--tools".to_string(),
                    "starling".to_string(),
                ],
                env: BTreeMap::new(),
                url: None,
                headers: BTreeMap::new(),
            },
        );

        let mcp = mcp_servers_to_claude_json(&servers);
        assert_eq!(mcp["starling"]["type"], "stdio");
        assert_eq!(mcp["starling"]["command"], "/tmp/starling");
        assert_eq!(
            mcp["starling"]["args"].as_array().cloned(),
            Some(vec![
                serde_json::json!("mcp"),
                serde_json::json!("--tools"),
                serde_json::json!("starling")
            ])
        );
    }

    #[test]
    fn claude_user_prompt_hook_is_enabled_by_default() {
        assert_eq!(
            claude_runtime_hook_events(false),
            vec![
                "SessionStart",
                "PreToolUse",
                "PermissionRequest",
                "Notification",
                "Stop",
                "StopFailure",
                "SessionEnd",
            ]
        );
        assert_eq!(
            claude_runtime_hook_events(true),
            vec![
                "UserPromptSubmit",
                "SessionStart",
                "PreToolUse",
                "PermissionRequest",
                "Notification",
                "Stop",
                "StopFailure",
                "SessionEnd",
            ]
        );
    }

    #[test]
    fn claude_model_is_derived_from_profile_settings() {
        let settings = serde_json::json!({
            "env": {
                "ANTHROPIC_DEFAULT_HAIKU_MODEL": "glm-5",
                "ANTHROPIC_DEFAULT_SONNET_MODEL": "glm-5.2"
            },
            "permissions": {
                "defaultMode": "plan"
            }
        });

        assert_eq!(
            claude_model_from_settings(&settings).as_deref(),
            Some("glm-5.2")
        );
        assert_eq!(settings["permissions"]["defaultMode"], "plan");
        assert!(has_claude_model_arg(&["--model=custom".to_string()]));
        assert!(has_claude_model_arg(&[
            "--model".to_string(),
            "custom".to_string()
        ]));
    }

    #[test]
    fn claude_permission_allow_rules_are_normalized_for_current_claude() {
        let mut settings = serde_json::json!({
            "permissions": {
                "allow": [
                    "Edit:*",
                    "Write:*",
                    "MultiEdit:*",
                    "NotebookEdit:*",
                    "Bash:*",
                    "Read"
                ],
                "ask": [
                    "Edit:*"
                ],
                "deny": [
                    "Bash:*"
                ]
            }
        });

        normalize_claude_permission_rules(&mut settings);

        assert_eq!(
            settings["permissions"]["allow"],
            serde_json::json!(["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash", "Read"])
        );
        assert_eq!(
            settings["permissions"]["ask"],
            serde_json::json!(["Edit:*"])
        );
        assert_eq!(
            settings["permissions"]["deny"],
            serde_json::json!(["Bash:*"])
        );
    }

    #[test]
    fn codex_hook_trust_state_preserves_existing_config() {
        let config = "model = \"gpt-5.5\"\n";
        let rendered = append_codex_hook_trust_state(
            config,
            Path::new("/tmp/hooks.json"),
            "run-1",
            Path::new("/tmp/hook.jsonl"),
            Path::new("/tmp/starling"),
        )
        .unwrap();
        assert!(rendered.contains("model = \"gpt-5.5\""));
        assert!(rendered.contains("[hooks.state.\"/tmp/hooks.json:session_start:0:0\"]"));
        assert!(rendered.contains("trusted_hash = \"sha256:"));
    }

    #[test]
    fn codex_hook_setup_strips_legacy_top_level_hooks_bool() {
        let rendered = strip_legacy_codex_hooks_bool(
            "model = \"gpt-5.5\"\nhooks = true\n[features]\nfoo = true\n",
        );
        assert!(rendered.contains("model = \"gpt-5.5\""));
        assert!(!rendered.contains("\nhooks = true\n"));
        assert!(rendered.contains("[features]"));
    }

    #[test]
    fn installs_runtime_hooks_for_codex_launches() {
        let dir = std::env::temp_dir().join(format!(
            "starling-codex-hooks-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let hook_file = dir.join("hook.jsonl");
        let starling_exe = PathBuf::from("/tmp/starling");

        install_codex_runtime_hooks(&dir, "run-1", &hook_file, &starling_exe).unwrap();

        let raw = std::fs::read_to_string(dir.join("hooks.json")).unwrap();
        let value: Value = serde_json::from_str(&raw).unwrap();
        let hooks = value
            .get("hooks")
            .and_then(|v| v.as_object())
            .expect("hooks object");
        for event in CODEX_RUNTIME_HOOK_EVENTS {
            let arr = hooks
                .get(*event)
                .and_then(|v| v.as_array())
                .expect("event hook");
            let command = arr[0]["hooks"][0]["command"].as_str().expect("command");
            assert!(command.contains("/tmp/starling top hook"));
            assert!(command.contains("--provider codex"));
            assert!(command.contains(&format!("--event {event}")));
            assert!(command.contains("--run-id run-1"));
            assert!(command.contains("hook.jsonl"));
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn codex_profile_arg_detection_handles_common_forms() {
        assert!(has_codex_profile_arg(&["--profile".into(), "work".into()]));
        assert!(has_codex_profile_arg(&["--profile=work".into()]));
        assert!(has_codex_profile_arg(&["-p".into(), "work".into()]));
        assert!(!has_codex_profile_arg(&["resume".into(), "abc".into()]));
    }

    #[test]
    fn codex_profile_runtime_hooks_are_inline_and_trusted() {
        let rendered = append_codex_profile_runtime_hooks(
            "model = \"gpt-5.5\"\n",
            Path::new("/home/u/.codex/starling-run-1.config.toml"),
            "run-1",
            Path::new("/tmp/hook.jsonl"),
            Path::new("/tmp/starling"),
        )
        .unwrap();

        assert!(rendered.contains("model = \"gpt-5.5\""));
        assert!(rendered.contains(
            "[hooks.state.\"/home/u/.codex/starling-run-1.config.toml:session_start:0:0\"]"
        ));
        assert!(rendered.contains("[[hooks.SessionStart]]"));
        assert!(rendered.contains("[[hooks.SessionStart.hooks]]"));
        assert!(rendered.contains("command = \"/tmp/starling top hook"));
        assert!(rendered.contains("trusted_hash = \"sha256:"));
    }

    #[test]
    fn codex_mcp_server_is_injected_into_config() {
        let mut servers = BTreeMap::new();
        servers.insert(
            "starling".to_string(),
            McpServerConfig {
                r#type: "stdio".to_string(),
                enabled: true,
                builtin: true,
                command: Some("/tmp/starling".to_string()),
                args: vec!["mcp".to_string()],
                env: BTreeMap::new(),
                url: None,
                headers: BTreeMap::new(),
            },
        );
        let rendered = upsert_codex_mcp_servers("model = \"gpt-5.5\"\n", &servers).unwrap();

        assert!(rendered.contains("[mcp_servers.starling]"));
        assert!(rendered.contains("command = \"/tmp/starling\""));
        assert!(rendered.contains("args = [\"mcp\"]"));
    }

    #[test]
    fn codex_external_provider_does_not_require_openai_auth() {
        let rendered = normalize_codex_external_provider_auth(
            r#"
model_provider = "deepseek"
model = "deepseek-v4-pro"

[model_providers.deepseek]
name = "deepseek"
base_url = "https://api.deepseek.com"
wire_api = "responses"
requires_openai_auth = true
experimental_bearer_token = "secret"
"#,
        );

        assert!(rendered.contains("model_provider = \"deepseek\""));
        assert!(rendered.contains("requires_openai_auth = false"));
    }

    #[test]
    fn codex_openai_provider_keeps_openai_auth_setting() {
        let rendered = normalize_codex_external_provider_auth(
            r#"
model_provider = "openai"

[model_providers.openai]
name = "OpenAI"
requires_openai_auth = true
"#,
        );

        assert!(rendered.contains("requires_openai_auth = true"));
    }
}

fn prepare_launch(
    provider: RunProvider,
    run_id: &str,
    setting: Option<&str>,
    passthrough_args: &[String],
    attach_hook: bool,
    mcp_names: &[String],
    mcp_profile: Option<&str>,
    no_mcp: bool,
) -> Result<PreparedLaunch> {
    let mut args = Vec::new();
    let mut envs = Vec::new();
    let mut temp_dir = None;
    let mut cleanup_files = Vec::new();
    let mut hook_file = None;

    match provider {
        RunProvider::Claude => {
            if attach_hook {
                let base_settings = if let Some(profile) = setting {
                    let path = default_claude_settings_dir().join(format!("{profile}.json"));
                    ensure_file(&path, "Claude profile")?;
                    Some(path)
                } else {
                    None
                };
                let hook = create_claude_hook_settings(
                    run_id,
                    base_settings.as_deref(),
                    mcp_names,
                    mcp_profile,
                    no_mcp,
                )?;
                args.push("--settings".into());
                args.push(hook.settings_path.to_string_lossy().to_string());
                if let Some(path) = &hook.mcp_config_path {
                    args.push("--mcp-config".into());
                    args.push(path.to_string_lossy().to_string());
                }
                if let Some(model) = hook
                    .model
                    .as_deref()
                    .filter(|_| !has_claude_model_arg(passthrough_args))
                {
                    args.push("--model".into());
                    args.push(model.to_string());
                }
                hook_file = Some(hook.hook_file);
            } else if let Some(profile) = setting {
                let path = default_claude_settings_dir().join(format!("{profile}.json"));
                ensure_file(&path, "Claude profile")?;
                args.push("--settings".into());
                args.push(path.to_string_lossy().to_string());
            }
        }
        RunProvider::Codex => {
            if let Some(home) = codex_resume_home_from_args(passthrough_args) {
                envs.push(("CODEX_HOME".into(), home.to_string_lossy().to_string()));
            } else if (attach_hook || setting.is_some()) && !has_codex_profile_arg(passthrough_args)
            {
                let base_config = if let Some(profile) = setting {
                    let path = default_codex_settings_dir().join(format!("{profile}.toml"));
                    ensure_file(&path, "Codex profile")?;
                    Some(path)
                } else {
                    None
                };
                let hook = create_codex_profile_launch(
                    run_id,
                    base_config.as_deref(),
                    attach_hook,
                    mcp_names,
                    mcp_profile,
                    no_mcp,
                )?;
                if attach_hook {
                    args.push("--enable".into());
                    args.push("hooks".into());
                }
                args.push("--profile".into());
                args.push(hook.profile_name);
                hook_file = hook.hook_file;
                cleanup_files.push(hook.profile_path);
            } else if attach_hook || setting.is_some() {
                let base_config = if let Some(profile) = setting {
                    let path = default_codex_settings_dir().join(format!("{profile}.toml"));
                    ensure_file(&path, "Codex profile")?;
                    Some(path)
                } else {
                    let path = default_codex_home().join("config.toml");
                    path.exists().then_some(path)
                };
                let hook = create_codex_hook_home(
                    run_id,
                    base_config.as_deref(),
                    attach_hook,
                    mcp_names,
                    mcp_profile,
                    no_mcp,
                )?;
                if attach_hook {
                    args.push("--enable".into());
                    args.push("hooks".into());
                }
                envs.push((
                    "CODEX_HOME".into(),
                    hook.home_dir.to_string_lossy().to_string(),
                ));
                hook_file = hook.hook_file;
                temp_dir = Some(hook.home_dir);
            }
        }
    }

    args.extend(passthrough_args.iter().cloned());
    Ok(PreparedLaunch {
        args,
        envs,
        temp_dir,
        cleanup_files,
        hook_file,
    })
}

fn has_codex_profile_arg(args: &[String]) -> bool {
    args.iter()
        .any(|arg| arg == "--profile" || arg == "-p" || arg.strip_prefix("--profile=").is_some())
}

fn codex_resume_home_from_args(args: &[String]) -> Option<PathBuf> {
    let session_id = args
        .windows(2)
        .find(|window| window[0] == "resume")
        .map(|window| window[1].as_str())?;
    let meta = find_session_by_id(session_id)?;
    codex_home_from_session_path(&meta.file_path)
}

fn codex_home_from_session_path(file_path: &str) -> Option<PathBuf> {
    let path = Path::new(file_path);
    let mut cursor = path.parent();
    while let Some(dir) = cursor {
        let name = dir.file_name().and_then(|s| s.to_str()).unwrap_or_default();
        if name == "sessions" || name == "archived_sessions" {
            let home = dir.parent()?;
            let home_name = home
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or_default();
            if home_name.starts_with("codex-") {
                return Some(home.to_path_buf());
            }
            return None;
        }
        cursor = dir.parent();
    }
    None
}

struct ClaudeHookSettings {
    settings_path: PathBuf,
    mcp_config_path: Option<PathBuf>,
    model: Option<String>,
    hook_file: PathBuf,
}

struct CodexHookHome {
    home_dir: PathBuf,
    hook_file: Option<PathBuf>,
}

struct CodexProfileLaunch {
    profile_name: String,
    profile_path: PathBuf,
    hook_file: Option<PathBuf>,
}

fn create_claude_hook_settings(
    run_id: &str,
    base_settings: Option<&Path>,
    mcp_names: &[String],
    mcp_profile: Option<&str>,
    no_mcp: bool,
) -> Result<ClaudeHookSettings> {
    let dir = default_starling_home().join("run-hooks");
    std::fs::create_dir_all(&dir)?;
    let hook_file = dir.join(format!("{run_id}.jsonl"));
    let settings_path = dir.join(format!("{run_id}.settings.json"));
    let mcp_config_path = dir.join(format!("{run_id}.mcp.json"));
    let mut settings = if let Some(path) = base_settings {
        let raw = std::fs::read_to_string(path)?;
        serde_json::from_str::<Value>(&raw).unwrap_or_else(|_| serde_json::json!({}))
    } else {
        serde_json::json!({})
    };
    let model = claude_model_from_settings(&settings);
    normalize_claude_permission_rules(&mut settings);
    let starling_exe = std::env::current_exe()?;
    let mcp_servers = selected_mcp_servers(mcp_names, mcp_profile, no_mcp, &starling_exe)?;
    install_claude_runtime_hooks(&mut settings, run_id, &hook_file, &starling_exe);
    let mcp_config_path = if mcp_servers.is_empty() {
        None
    } else {
        let config = serde_json::json!({
            "mcpServers": mcp_servers_to_claude_json(&mcp_servers)
        });
        std::fs::write(&mcp_config_path, serde_json::to_string_pretty(&config)?)?;
        Some(mcp_config_path)
    };
    std::fs::write(&settings_path, serde_json::to_string_pretty(&settings)?)?;
    Ok(ClaudeHookSettings {
        settings_path,
        mcp_config_path,
        model,
        hook_file,
    })
}

fn has_claude_model_arg(args: &[String]) -> bool {
    args.iter()
        .any(|arg| arg == "--model" || arg.strip_prefix("--model=").is_some())
}

fn claude_model_from_settings(settings: &Value) -> Option<String> {
    let env = settings.get("env").and_then(|v| v.as_object())?;
    for key in [
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    ] {
        if let Some(value) = env
            .get(key)
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            return Some(value.trim().to_string());
        }
    }
    None
}

fn normalize_claude_permission_rules(settings: &mut Value) {
    let Some(permissions) = settings
        .get_mut("permissions")
        .and_then(|value| value.as_object_mut())
    else {
        return;
    };
    for key in ["allow", "deny", "ask"] {
        let Some(rules) = permissions
            .get_mut(key)
            .and_then(|value| value.as_array_mut())
        else {
            continue;
        };
        let mut normalized = Vec::new();
        for rule in rules.drain(..) {
            if let Some(text) = rule.as_str() {
                if key == "allow" {
                    normalized.push(Value::String(normalize_claude_allow_rule(text)));
                } else {
                    normalized.push(Value::String(text.to_string()));
                }
            } else {
                normalized.push(rule);
            }
        }
        *rules = normalized;
    }
}

fn normalize_claude_allow_rule(rule: &str) -> String {
    match rule {
        "Edit:*" => "Edit",
        "Write:*" => "Write",
        "MultiEdit:*" => "MultiEdit",
        "NotebookEdit:*" => "NotebookEdit",
        "Bash:*" => "Bash",
        _ => rule,
    }
    .to_string()
}

fn create_codex_hook_home(
    run_id: &str,
    base_config: Option<&Path>,
    attach_hook: bool,
    mcp_names: &[String],
    mcp_profile: Option<&str>,
    no_mcp: bool,
) -> Result<CodexHookHome> {
    let dir = default_starling_home()
        .join("run-homes")
        .join(format!("codex-{run_id}"));
    std::fs::create_dir_all(&dir)?;
    link_codex_persistent_session_dirs(&dir)?;

    let mut config = if let Some(path) = base_config {
        std::fs::read_to_string(path)?
    } else {
        String::new()
    };
    config = normalize_codex_external_provider_auth(&config);
    if attach_hook {
        config = strip_legacy_codex_hooks_bool(&config);
    }
    let needs_starling_exe = attach_hook || mcp_injection_requested(no_mcp);
    let starling_exe = if needs_starling_exe {
        Some(std::env::current_exe()?)
    } else {
        None
    };
    if mcp_injection_requested(no_mcp) {
        let mcp_servers = selected_mcp_servers(
            mcp_names,
            mcp_profile,
            no_mcp,
            starling_exe.as_ref().expect("starling exe for mcp"),
        )?;
        config = upsert_codex_mcp_servers(&config, &mcp_servers)?;
    }
    let hook_file = if attach_hook {
        let hook_dir = default_starling_home().join("run-hooks");
        std::fs::create_dir_all(&hook_dir)?;
        let hook_file = hook_dir.join(format!("{run_id}.jsonl"));
        config = append_codex_hook_trust_state(
            &config,
            &dir.join("hooks.json"),
            run_id,
            &hook_file,
            starling_exe.as_ref().expect("starling exe for hooks"),
        )?;
        install_codex_runtime_hooks(
            &dir,
            run_id,
            &hook_file,
            starling_exe.as_ref().expect("starling exe for hooks"),
        )?;
        Some(hook_file)
    } else {
        None
    };
    std::fs::write(dir.join("config.toml"), config)?;

    copy_if_exists(
        &default_codex_home().join("auth.json"),
        &dir.join("auth.json"),
    )?;

    Ok(CodexHookHome {
        home_dir: dir,
        hook_file,
    })
}

fn create_codex_profile_launch(
    run_id: &str,
    base_config: Option<&Path>,
    attach_hook: bool,
    mcp_names: &[String],
    mcp_profile: Option<&str>,
    no_mcp: bool,
) -> Result<CodexProfileLaunch> {
    let codex_home = default_codex_home();
    std::fs::create_dir_all(&codex_home)?;

    let profile_name = format!("starling-{run_id}");
    let profile_path = codex_home.join(format!("{profile_name}.config.toml"));
    let mut config = if let Some(path) = base_config {
        std::fs::read_to_string(path)?
    } else {
        String::new()
    };
    config = normalize_codex_external_provider_auth(&config);

    let needs_starling_exe = attach_hook || mcp_injection_requested(no_mcp);
    let starling_exe = if needs_starling_exe {
        Some(std::env::current_exe()?)
    } else {
        None
    };
    if mcp_injection_requested(no_mcp) {
        let mcp_servers = selected_mcp_servers(
            mcp_names,
            mcp_profile,
            no_mcp,
            starling_exe.as_ref().expect("starling exe for mcp"),
        )?;
        config = upsert_codex_mcp_servers(&config, &mcp_servers)?;
    }

    let hook_file = if attach_hook {
        config = strip_legacy_codex_hooks_bool(&config);
        let hook_dir = default_starling_home().join("run-hooks");
        std::fs::create_dir_all(&hook_dir)?;
        let hook_file = hook_dir.join(format!("{run_id}.jsonl"));
        config = append_codex_profile_runtime_hooks(
            &config,
            &profile_path,
            run_id,
            &hook_file,
            starling_exe.as_ref().expect("starling exe for hooks"),
        )?;
        Some(hook_file)
    } else {
        None
    };

    std::fs::write(&profile_path, config)?;
    Ok(CodexProfileLaunch {
        profile_name,
        profile_path,
        hook_file,
    })
}

fn link_codex_persistent_session_dirs(run_home: &Path) -> Result<()> {
    let codex_home = default_codex_home();
    link_codex_persistent_dir(run_home, &codex_home, "sessions")?;
    link_codex_persistent_dir(run_home, &codex_home, "archived_sessions")?;
    Ok(())
}

fn link_codex_persistent_dir(run_home: &Path, codex_home: &Path, name: &str) -> Result<()> {
    let target = codex_home.join(name);
    std::fs::create_dir_all(&target)?;
    let link = run_home.join(name);

    if link.exists() || std::fs::symlink_metadata(&link).is_ok() {
        if is_empty_real_dir(&link) {
            std::fs::remove_dir(&link)?;
        } else {
            return Ok(());
        }
    }

    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&target, &link)?;
    }
    #[cfg(windows)]
    {
        std::os::windows::fs::symlink_dir(&target, &link)?;
    }
    Ok(())
}

fn is_empty_real_dir(path: &Path) -> bool {
    let Ok(metadata) = std::fs::symlink_metadata(path) else {
        return false;
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return false;
    }
    std::fs::read_dir(path)
        .map(|mut entries| entries.next().is_none())
        .unwrap_or(false)
}

fn append_codex_hook_trust_state(
    config: &str,
    hooks_json_path: &Path,
    run_id: &str,
    hook_file: &Path,
    starling_exe: &Path,
) -> Result<String> {
    let starling_exe = starling_exe.to_string_lossy().to_string();
    let hook_file = hook_file.to_string_lossy().to_string();
    let hooks_json_path = hooks_json_path.to_string_lossy().to_string();
    let mut rendered = config.trim_end().to_string();
    if !rendered.is_empty() {
        rendered.push_str("\n\n");
    }
    for event in CODEX_RUNTIME_HOOK_EVENTS {
        let event_key = codex_hook_event_key(event);
        let command = codex_runtime_hook_command(&starling_exe, run_id, &hook_file, event);
        let hash = codex_command_hook_hash(event_key, &command, 5)?;
        rendered.push_str(&format!(
            "[hooks.state.\"{}:{}:0:0\"]\ntrusted_hash = \"{}\"\n\n",
            hooks_json_path.replace('\\', "\\\\").replace('"', "\\\""),
            event_key,
            hash
        ));
    }
    Ok(rendered)
}

fn append_codex_profile_runtime_hooks(
    config: &str,
    profile_path: &Path,
    run_id: &str,
    hook_file: &Path,
    starling_exe: &Path,
) -> Result<String> {
    let starling_exe = starling_exe.to_string_lossy().to_string();
    let hook_file = hook_file.to_string_lossy().to_string();
    let profile_path = profile_path.to_string_lossy().to_string();
    let mut rendered = config.trim_end().to_string();
    if !rendered.is_empty() {
        rendered.push_str("\n\n");
    }

    for event in CODEX_RUNTIME_HOOK_EVENTS {
        let event_key = codex_hook_event_key(event);
        let command = codex_runtime_hook_command(&starling_exe, run_id, &hook_file, event);
        let hash = codex_command_hook_hash(event_key, &command, 5)?;
        rendered.push_str(&format!(
            "[hooks.state.\"{}:{}:0:0\"]\ntrusted_hash = \"{}\"\n\n",
            profile_path.replace('\\', "\\\\").replace('"', "\\\""),
            event_key,
            hash
        ));
    }

    for event in CODEX_RUNTIME_HOOK_EVENTS {
        let command = codex_runtime_hook_command(&starling_exe, run_id, &hook_file, event);
        rendered.push_str(&format!(
            "[[hooks.{event}]]\n\n[[hooks.{event}.hooks]]\ntype = \"command\"\ncommand = \"{}\"\ntimeout = 5\n\n",
            toml_escape_basic(&command)
        ));
    }

    Ok(rendered)
}

fn normalize_codex_external_provider_auth(config: &str) -> String {
    let Ok(mut value) = config.parse::<toml::Value>() else {
        return config.to_string();
    };
    let Some(provider_id) = value
        .get("model_provider")
        .and_then(|provider| provider.as_str())
        .map(str::to_string)
    else {
        return config.to_string();
    };
    if provider_id == "openai" {
        return config.to_string();
    }

    let Some(provider) = value
        .get_mut("model_providers")
        .and_then(|providers| providers.as_table_mut())
        .and_then(|providers| providers.get_mut(&provider_id))
        .and_then(|provider| provider.as_table_mut())
    else {
        return config.to_string();
    };

    provider.insert(
        "requires_openai_auth".to_string(),
        toml::Value::Boolean(false),
    );
    toml::to_string_pretty(&value).unwrap_or_else(|_| config.to_string())
}

fn upsert_codex_mcp_servers(
    config: &str,
    servers: &BTreeMap<String, McpServerConfig>,
) -> Result<String> {
    if servers.is_empty() {
        return Ok(config.to_string());
    }
    let parsed = if config.trim().is_empty() {
        Ok(toml::Value::Table(toml::map::Map::new()))
    } else {
        config.parse::<toml::Value>()
    };
    let Ok(mut value) = parsed else {
        return Ok(append_codex_mcp_server_blocks(config, servers));
    };
    let Some(root) = value.as_table_mut() else {
        return Ok(append_codex_mcp_server_blocks(config, servers));
    };
    let mcp_servers = root
        .entry("mcp_servers".to_string())
        .or_insert_with(|| toml::Value::Table(toml::map::Map::new()));
    let Some(mcp_servers) = mcp_servers.as_table_mut() else {
        return Ok(append_codex_mcp_server_blocks(config, servers));
    };
    for (name, server) in servers {
        let table = codex_mcp_server_table(server);
        mcp_servers.insert(name.clone(), toml::Value::Table(table));
    }
    toml::to_string_pretty(&value).map_err(Into::into)
}

fn codex_mcp_server_table(server: &McpServerConfig) -> toml::map::Map<String, toml::Value> {
    let mut table = toml::map::Map::new();
    match server.r#type.as_str() {
        "http" => {
            table.insert("type".to_string(), toml::Value::String("http".to_string()));
            if let Some(url) = &server.url {
                table.insert("url".to_string(), toml::Value::String(url.clone()));
            }
            if !server.headers.is_empty() {
                table.insert(
                    "headers".to_string(),
                    toml::Value::Table(
                        server
                            .headers
                            .iter()
                            .map(|(key, value)| (key.clone(), toml::Value::String(value.clone())))
                            .collect(),
                    ),
                );
            }
        }
        _ => {
            table.insert(
                "command".to_string(),
                toml::Value::String(server.command.clone().unwrap_or_default()),
            );
            table.insert(
                "args".to_string(),
                toml::Value::Array(
                    server
                        .args
                        .iter()
                        .cloned()
                        .map(toml::Value::String)
                        .collect(),
                ),
            );
            if !server.env.is_empty() {
                table.insert(
                    "env".to_string(),
                    toml::Value::Table(
                        server
                            .env
                            .iter()
                            .map(|(key, value)| (key.clone(), toml::Value::String(value.clone())))
                            .collect(),
                    ),
                );
            }
        }
    }
    table
}

fn append_codex_mcp_server_blocks(
    config: &str,
    servers: &BTreeMap<String, McpServerConfig>,
) -> String {
    let mut rendered = config.trim_end().to_string();
    if !rendered.is_empty() {
        rendered.push_str("\n\n");
    }
    for (name, server) in servers {
        rendered.push_str(&format!("[mcp_servers.{}]\n", toml_escape_basic_key(name)));
        match server.r#type.as_str() {
            "http" => {
                rendered.push_str("type = \"http\"\n");
                if let Some(url) = &server.url {
                    rendered.push_str(&format!("url = \"{}\"\n", toml_escape_basic(url)));
                }
                if !server.headers.is_empty() {
                    rendered.push_str(&format!(
                        "[mcp_servers.{}.headers]\n",
                        toml_escape_basic_key(name)
                    ));
                    for (key, value) in &server.headers {
                        rendered.push_str(&format!(
                            "{} = \"{}\"\n",
                            toml_escape_basic_key(key),
                            toml_escape_basic(value)
                        ));
                    }
                }
            }
            _ => {
                rendered.push_str(&format!(
                    "command = \"{}\"\n",
                    toml_escape_basic(server.command.as_deref().unwrap_or(""))
                ));
                let args = server
                    .args
                    .iter()
                    .map(|arg| format!("\"{}\"", toml_escape_basic(arg)))
                    .collect::<Vec<_>>()
                    .join(", ");
                rendered.push_str(&format!("args = [{args}]\n"));
                if !server.env.is_empty() {
                    rendered.push_str(&format!(
                        "[mcp_servers.{}.env]\n",
                        toml_escape_basic_key(name)
                    ));
                    for (key, value) in &server.env {
                        rendered.push_str(&format!(
                            "{} = \"{}\"\n",
                            toml_escape_basic_key(key),
                            toml_escape_basic(value)
                        ));
                    }
                }
            }
        }
        rendered.push('\n');
    }
    rendered
}

fn toml_escape_basic_key(value: &str) -> String {
    if value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'))
    {
        value.to_string()
    } else {
        format!("\"{}\"", toml_escape_basic(value))
    }
}

fn toml_escape_basic(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '\\' => escaped.push_str("\\\\"),
            '"' => escaped.push_str("\\\""),
            '\n' => escaped.push_str("\\n"),
            '\r' => escaped.push_str("\\r"),
            '\t' => escaped.push_str("\\t"),
            c => escaped.push(c),
        }
    }
    escaped
}

fn strip_legacy_codex_hooks_bool(config: &str) -> String {
    let mut in_table = false;
    let mut out = Vec::new();
    for line in config.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') {
            in_table = true;
        }
        let is_legacy_hooks_bool = !in_table
            && trimmed
                .strip_prefix("hooks")
                .and_then(|rest| rest.trim_start().strip_prefix('='))
                .map(|value| matches!(value.trim(), "true" | "false"))
                .unwrap_or(false);
        if !is_legacy_hooks_bool {
            out.push(line.to_string());
        }
    }
    let mut rendered = out.join("\n");
    if config.ends_with('\n') && !rendered.is_empty() {
        rendered.push('\n');
    }
    rendered
}

fn install_codex_runtime_hooks(
    home_dir: &Path,
    run_id: &str,
    hook_file: &Path,
    starling_exe: &Path,
) -> Result<()> {
    let hook_file = hook_file.to_string_lossy().to_string();
    let starling_exe = starling_exe.to_string_lossy().to_string();
    let mut hooks = serde_json::Map::new();
    for event in CODEX_RUNTIME_HOOK_EVENTS {
        hooks.insert(
            (*event).to_string(),
            serde_json::json!([{
                "hooks": [{
                    "type": "command",
                    "command": codex_runtime_hook_command(&starling_exe, run_id, &hook_file, event),
                    "timeout": 5
                }]
            }]),
        );
    }
    let value = serde_json::json!({ "hooks": hooks });
    std::fs::write(
        home_dir.join("hooks.json"),
        serde_json::to_string_pretty(&value)?,
    )?;
    Ok(())
}

fn codex_runtime_hook_command(
    starling_exe: &str,
    run_id: &str,
    hook_file: &str,
    event: &str,
) -> String {
    [
        shell_quote(starling_exe),
        "top".to_string(),
        "hook".to_string(),
        "--provider".to_string(),
        "codex".to_string(),
        "--event".to_string(),
        shell_quote(event),
        "--run-id".to_string(),
        shell_quote(run_id),
        "--hook-file".to_string(),
        shell_quote(hook_file),
    ]
    .join(" ")
}

fn shell_quote(value: &str) -> String {
    if value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '.' | '_' | '-' | ':' | '+'))
    {
        return value.to_string();
    }
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[derive(Serialize)]
struct CodexNormalizedHookIdentity {
    event_name: String,
    #[serde(flatten)]
    group: CodexMatcherGroup,
}

#[derive(Serialize)]
struct CodexMatcherGroup {
    #[serde(skip_serializing_if = "Option::is_none")]
    matcher: Option<String>,
    hooks: Vec<CodexHookHandlerConfig>,
}

#[derive(Serialize)]
#[serde(tag = "type")]
enum CodexHookHandlerConfig {
    #[serde(rename = "command")]
    Command {
        command: String,
        #[serde(rename = "commandWindows", skip_serializing_if = "Option::is_none")]
        command_windows: Option<String>,
        #[serde(rename = "timeout")]
        timeout_sec: Option<u64>,
        r#async: bool,
        #[serde(rename = "statusMessage", skip_serializing_if = "Option::is_none")]
        status_message: Option<String>,
    },
}

fn codex_command_hook_hash(event_key: &str, command: &str, timeout_sec: u64) -> Result<String> {
    let identity = CodexNormalizedHookIdentity {
        event_name: event_key.to_string(),
        group: CodexMatcherGroup {
            matcher: None,
            hooks: vec![CodexHookHandlerConfig::Command {
                command: command.to_string(),
                command_windows: None,
                timeout_sec: Some(timeout_sec),
                r#async: false,
                status_message: None,
            }],
        },
    };
    let value = toml::Value::try_from(identity)?;
    Ok(version_for_toml_value(&value))
}

fn version_for_toml_value(value: &toml::Value) -> String {
    let json = serde_json::to_value(value).unwrap_or(Value::Null);
    let canonical = canonical_json(&json);
    let serialized = serde_json::to_vec(&canonical).unwrap_or_default();
    let mut hasher = Sha256::new();
    hasher.update(serialized);
    let hash = hasher.finalize();
    let hex = hash
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("sha256:{hex}")
}

fn canonical_json(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut sorted = serde_json::Map::new();
            let mut keys = map.keys().cloned().collect::<Vec<_>>();
            keys.sort();
            for key in keys {
                if let Some(val) = map.get(&key) {
                    sorted.insert(key, canonical_json(val));
                }
            }
            Value::Object(sorted)
        }
        Value::Array(items) => Value::Array(items.iter().map(canonical_json).collect()),
        other => other.clone(),
    }
}

fn codex_hook_event_key(event: &str) -> &'static str {
    match event {
        "SessionStart" => "session_start",
        "UserPromptSubmit" => "user_prompt_submit",
        "PreToolUse" => "pre_tool_use",
        "PermissionRequest" => "permission_request",
        "PostToolUse" => "post_tool_use",
        "SubagentStart" => "subagent_start",
        "SubagentStop" => "subagent_stop",
        "Stop" => "stop",
        _ => "unknown",
    }
}

fn install_claude_runtime_hooks(
    settings: &mut Value,
    run_id: &str,
    hook_file: &Path,
    starling_exe: &Path,
) {
    if !settings.is_object() {
        *settings = serde_json::json!({});
    }
    let hook_file = hook_file.to_string_lossy().to_string();
    let starling_exe = starling_exe.to_string_lossy().to_string();

    let root = settings.as_object_mut().expect("settings object");
    let hooks = root.entry("hooks").or_insert_with(|| serde_json::json!({}));
    if !hooks.is_object() {
        *hooks = serde_json::json!({});
    }
    let hooks_obj = hooks.as_object_mut().expect("hooks object");

    for event in claude_runtime_hook_events(claude_user_prompt_hook_enabled()) {
        let hook = claude_runtime_hook(&starling_exe, run_id, &hook_file);
        let entry = hooks_obj
            .entry(event)
            .or_insert_with(|| serde_json::json!([]));
        if let Some(arr) = entry.as_array_mut() {
            arr.push(hook);
        } else {
            *entry = serde_json::json!([hook]);
        }
    }

    root.entry("statusLine")
        .or_insert_with(|| claude_runtime_status_line(&starling_exe, run_id, &hook_file));
}

fn mcp_servers_to_claude_json(servers: &BTreeMap<String, McpServerConfig>) -> Value {
    let mut mcp_servers = serde_json::Map::new();
    for (name, server) in servers {
        mcp_servers.insert(name.clone(), claude_mcp_server_entry(server));
    }
    Value::Object(mcp_servers)
}

fn claude_mcp_server_entry(server: &McpServerConfig) -> Value {
    match server.r#type.as_str() {
        "http" => {
            let mut entry = serde_json::json!({
                "type": "http",
                "url": server.url
            });
            if !server.headers.is_empty() {
                entry["headers"] =
                    serde_json::to_value(&server.headers).unwrap_or_else(|_| serde_json::json!({}));
            }
            entry
        }
        _ => {
            let mut entry = serde_json::json!({
                "type": "stdio",
                "command": server.command,
                "args": server.args
            });
            if !server.env.is_empty() {
                entry["env"] =
                    serde_json::to_value(&server.env).unwrap_or_else(|_| serde_json::json!({}));
            }
            entry
        }
    }
}

const CLAUDE_RUNTIME_HOOK_EVENTS: &[&str] = &[
    "UserPromptSubmit",
    "SessionStart",
    "PreToolUse",
    "PermissionRequest",
    "Notification",
    "Stop",
    "StopFailure",
    "SessionEnd",
];
const CLAUDE_USER_PROMPT_HOOK_ENV: &str = "STARLING_CLAUDE_USER_PROMPT_HOOK";
const STARLING_MCP_INJECT_ENV: &str = "STARLING_MCP_INJECT";

fn claude_runtime_hook_events(include_user_prompt: bool) -> Vec<&'static str> {
    let mut events = CLAUDE_RUNTIME_HOOK_EVENTS.to_vec();
    if !include_user_prompt {
        events.retain(|event| *event != "UserPromptSubmit");
    }
    events
}

fn claude_user_prompt_hook_enabled() -> bool {
    match std::env::var(CLAUDE_USER_PROMPT_HOOK_ENV) {
        Ok(value) => !matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "0" | "false" | "no" | "off"
        ),
        Err(_) => true,
    }
}

fn mcp_injection_requested(no_mcp: bool) -> bool {
    !no_mcp && starling_mcp_injection_enabled()
}

fn starling_mcp_injection_enabled() -> bool {
    match std::env::var(STARLING_MCP_INJECT_ENV) {
        Ok(value) => !matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "0" | "false" | "no" | "off"
        ),
        Err(_) => true,
    }
}

fn selected_mcp_servers(
    mcp_names: &[String],
    mcp_profile: Option<&str>,
    no_mcp: bool,
    starling_exe: &Path,
) -> Result<BTreeMap<String, McpServerConfig>> {
    effective_servers(
        mcp_names,
        mcp_profile,
        !mcp_injection_requested(no_mcp),
        starling_exe,
    )
}

const CODEX_RUNTIME_HOOK_EVENTS: &[&str] = &[
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PermissionRequest",
    "PostToolUse",
    "SubagentStart",
    "SubagentStop",
    "Stop",
];

fn claude_runtime_hook(starling_exe: &str, run_id: &str, hook_file: &str) -> Value {
    serde_json::json!({
        "hooks": [
            {
                "type": "command",
                "command": claude_runtime_hook_command(starling_exe, run_id, hook_file),
                "timeout": 5
            }
        ]
    })
}

fn claude_runtime_hook_command(starling_exe: &str, run_id: &str, hook_file: &str) -> String {
    [
        shell_quote(starling_exe),
        "top".to_string(),
        "hook".to_string(),
        "--provider".to_string(),
        "claude".to_string(),
        "--run-id".to_string(),
        shell_quote(run_id),
        "--hook-file".to_string(),
        shell_quote(hook_file),
    ]
    .join(" ")
}

fn claude_runtime_status_line(starling_exe: &str, run_id: &str, hook_file: &str) -> Value {
    serde_json::json!({
        "type": "command",
        "command": claude_runtime_status_line_command(starling_exe, run_id, hook_file),
        "padding": 0
    })
}

fn claude_runtime_status_line_command(starling_exe: &str, run_id: &str, hook_file: &str) -> String {
    [
        shell_quote(starling_exe),
        "top".to_string(),
        "hook".to_string(),
        "--provider".to_string(),
        "claude".to_string(),
        "--event".to_string(),
        "StatusLine".to_string(),
        "--run-id".to_string(),
        shell_quote(run_id),
        "--hook-file".to_string(),
        shell_quote(hook_file),
    ]
    .join(" ")
}

fn ensure_file(path: &Path, label: &str) -> Result<()> {
    if path.exists() {
        return Ok(());
    }
    eprintln!("{}: {} not found: {}", "error".red(), label, path.display());
    std::process::exit(2);
}

fn copy_if_exists(from: &Path, to: &Path) -> Result<()> {
    if from.exists() {
        std::fs::copy(from, to)?;
    }
    Ok(())
}

fn cleanup_temp_dir(path: Option<&Path>) {
    if let Some(path) = path {
        let _ = std::fs::remove_dir_all(path);
    }
}

fn cleanup_files(paths: &[PathBuf]) {
    for path in paths {
        let _ = std::fs::remove_file(path);
    }
}

fn cleanup_launch_artifacts(prepared: &PreparedLaunch) {
    cleanup_temp_dir(prepared.temp_dir.as_deref());
    cleanup_files(&prepared.cleanup_files);
}

fn update_run_pid(run_id: &str, pid: u32) {
    // Load → patch → save to inject pid into the existing record.
    let mut data = crate::core::runs::load_runs();
    for run in data.runs.iter_mut() {
        if run.run_id == run_id {
            run.pid = Some(pid);
            break;
        }
    }
    crate::core::runs::save_runs(data);
}

fn update_run_session_id(run_id: &str, session_id: &str) {
    let mut data = crate::core::runs::load_runs();
    for run in data.runs.iter_mut() {
        if run.run_id == run_id {
            run.session_id = Some(session_id.to_string());
            break;
        }
    }
    crate::core::runs::save_runs(data);
}

fn status(run_id: Option<&str>, json: bool) -> Result<()> {
    match run_id {
        Some(id) => match find_run(id) {
            Some(r) => {
                if json {
                    println!("{}", serde_json::to_string_pretty(&r)?);
                    return Ok(());
                }
                println!("{}", format!("Run: {}", short(&r.run_id)).cyan().bold());
                println!("  Provider: {:?}", r.provider);
                println!("  Status:   {:?}", r.status);
                println!("  Started:  {}", r.started_at);
                if let Some(end) = &r.ended_at {
                    println!("  Ended:    {}", end);
                }
                if let Some(pid) = r.pid {
                    println!("  PID:      {}", pid);
                }
                if let Some(code) = r.exit_code {
                    println!("  Exit:     {}", code);
                }
                if let Some(p) = &r.project_path {
                    println!("  Project:  {}", p);
                }
                if let Some(setting) = &r.setting {
                    println!("  Setting:  {}", setting);
                }
                Ok(())
            }
            None => {
                eprintln!("{}: run not found: {}", "error".red(), id);
                std::process::exit(1);
            }
        },
        None => {
            let runs = list_runs(None);
            if json {
                let recent: Vec<_> = runs.into_iter().take(20).collect();
                println!("{}", serde_json::to_string_pretty(&recent)?);
                return Ok(());
            }
            if runs.is_empty() {
                println!("{}", "No runs recorded.".yellow());
                return Ok(());
            }
            let recent: Vec<_> = runs.into_iter().take(20).collect();
            use comfy_table::{presets::UTF8_FULL, Cell, Color, ContentArrangement, Table};
            let mut table = Table::new();
            table
                .load_preset(UTF8_FULL)
                .set_content_arrangement(ContentArrangement::Disabled);
            table.set_header(vec![
                Cell::new("Run").fg(Color::Cyan),
                Cell::new("Provider").fg(Color::Cyan),
                Cell::new("Status").fg(Color::Cyan),
                Cell::new("Started").fg(Color::Cyan),
                Cell::new("PID").fg(Color::Cyan),
                Cell::new("Project").fg(Color::Cyan),
            ]);
            for r in recent {
                table.add_row(vec![
                    Cell::new(short(&r.run_id)),
                    Cell::new(format!("{:?}", r.provider)),
                    Cell::new(format!("{:?}", r.status)),
                    Cell::new(&r.started_at),
                    Cell::new(r.pid.map(|p| p.to_string()).unwrap_or_else(|| "-".into())),
                    Cell::new(r.project_path.as_deref().unwrap_or("-")),
                ]);
            }
            println!("{}", table.to_string());
            Ok(())
        }
    }
}

fn stop(run_id: &str, json: bool) -> Result<()> {
    let run = match find_run(run_id) {
        Some(r) => r,
        None => {
            eprintln!("{}: run not found: {}", "error".red(), run_id);
            std::process::exit(1);
        }
    };
    if run.status != RunStatus::Running {
        eprintln!(
            "{}: run {} is not running (status: {:?})",
            "error".red(),
            short(&run.run_id),
            run.status
        );
        std::process::exit(1);
    }
    let pid = match run.pid {
        Some(p) if p > 0 => p,
        _ => {
            eprintln!(
                "{}: run {} has no pid; cannot stop",
                "error".red(),
                short(&run.run_id)
            );
            std::process::exit(1);
        }
    };
    terminate_pid(pid, false);
    eprintln!(
        "{}: sent stop signal to pid {} (run {})",
        "starling".cyan(),
        pid,
        short(&run.run_id)
    );
    // Brief grace period
    for _ in 0..50 {
        if !crate::core::runs::is_pid_alive(pid) {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    if crate::core::runs::is_pid_alive(pid) {
        terminate_pid(pid, true);
        eprintln!("{}: escalated stop signal", "starling".cyan());
    }
    finalize_run(
        run_id,
        FinalizePatch {
            status: RunStatus::Crashed,
            exit_code: None,
            ended_at: Some(now_iso()),
            session_id: None,
        },
    );
    if json {
        return super::print_json_result(
            "run.stop",
            &format!("Stopped run {}", short(&run.run_id)),
            serde_json::json!({ "run": run, "stopped": true }),
        );
    }
    println!("{}", format!("Stopped run {}", short(&run.run_id)).green());
    Ok(())
}

// Suppress unused-import warning: remove_run is part of the API surface but
// not currently wired through the CLI stop path (we keep the record).
#[allow(dead_code)]
fn _anchor_remove(run_id: &str) -> bool {
    remove_run(run_id)
}

fn short(id: &str) -> String {
    if id.len() > 8 {
        id[..8].to_string()
    } else {
        id.to_string()
    }
}

#[cfg(unix)]
fn terminate_pid(pid: u32, force: bool) {
    let signal = if force { libc::SIGKILL } else { libc::SIGTERM };
    unsafe {
        libc::kill(pid as i32, signal);
    }
}

#[cfg(windows)]
fn terminate_pid(pid: u32, force: bool) {
    let mut cmd = std::process::Command::new("taskkill");
    cmd.arg("/PID").arg(pid.to_string()).arg("/T");
    if force {
        cmd.arg("/F");
    }
    let _ = cmd.status();
}

#[cfg(not(any(unix, windows)))]
fn terminate_pid(_pid: u32, _force: bool) {}

// --- Signal handler ---
//
// Install a SIGINT/SIGTERM handler that marks the given run as crashed so the
// user's runs.json reflects reality even when starling is killed mid-run. We
// use a static to remember the active run_id (single-run-per-process model).

use once_cell::sync::Lazy;
use std::sync::Mutex;

static ACTIVE_RUN: Lazy<Mutex<Option<String>>> = Lazy::new(|| Mutex::new(None));

fn install_signal_handler(run_id: String) {
    *ACTIVE_RUN.lock().unwrap() = Some(run_id);
    #[cfg(unix)]
    unsafe {
        extern "C" {
            fn signal(signum: i32, handler: usize) -> usize;
        }
        extern "C" fn handle_sig(_sig: i32) {
            if let Ok(g) = ACTIVE_RUN.lock() {
                if let Some(id) = g.as_ref() {
                    mark_run_crashed(id);
                }
            }
            // Re-raise default to terminate.
            unsafe {
                libc::signal(libc::SIGINT, libc::SIG_DFL as usize);
                libc::raise(libc::SIGINT);
            }
        }
        signal(libc::SIGINT, handle_sig as usize);
        signal(libc::SIGTERM, handle_sig as usize);
    }
}
