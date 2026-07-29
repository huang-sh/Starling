//! `starling run` — agent launch with run-record tracking.

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
use std::time::UNIX_EPOCH;

use anyhow::Result;
use colored::*;
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::cli::*;
use crate::constants::{
    default_claude_settings_dir, default_codex_home, default_codex_settings_dir,
    default_pi_settings_dir, default_starling_home, normalize_pi_path_input, now_iso,
    pi_node_compatible_path, resolve_pi_executable, resolve_pi_sdk_host,
    resolve_pi_session_layout_for_launch, PiLaunchSessionLayout,
};
use crate::core::catalog_resolver::{resolve_catalog_reference, CatalogResolution};
use crate::core::discovery::{
    canonical_session_id, find_pi_session_by_path, find_session_by_id, find_sessions,
    Provider as DiscoveryProvider,
};
use crate::core::id::generate_bookmark_id;
use crate::core::mcp_config::{effective_servers, McpServerConfig};
use crate::core::osc_state::{status_from_osc_sequence, upsert_osc_state, OscSessionState};
use crate::core::process_map::map_process_tree_to_session_since;
use crate::core::runs::{
    create_run, finalize_run, find_run, list_runs, mark_run_crashed, patch_run,
    reconcile_stale_runs, remove_run, FinalizePatch, RunPatch, RunStatus,
};
use crate::core::session::{
    extract_claude_session_meta, extract_codex_session_meta, extract_pi_session_meta,
    parse_jsonl_head,
};
use crate::core::session_display::short_session_id;
use crate::core::session_lock::acquire_pi_session_lock;
use crate::core::store::{add_bookmark, find_bookmark_for_session, update_bookmark, BookmarkPatch};
use crate::types::{Bookmark, RunProvider, RunRecord, RunSource, SessionMeta};

pub fn handle(cmd: RunCommand) -> Result<()> {
    match &cmd.command {
        RunSubcommand::Claude { args } => launch(
            RunProvider::Claude,
            Path::new("claude"),
            &[],
            "claude",
            &cmd,
            args,
        ),
        RunSubcommand::Codex { args } => launch(
            RunProvider::Codex,
            Path::new("codex"),
            &[],
            "codex",
            &cmd,
            args,
        ),
        RunSubcommand::Pi { args } => {
            let pi = resolve_pi_executable();
            launch(
                RunProvider::Pi,
                &pi.program,
                &pi.prefix_args,
                &pi.cli_path.to_string_lossy(),
                &cmd,
                args,
            )
        }
        RunSubcommand::Status { run_id, json } => status(run_id.as_deref(), *json),
        RunSubcommand::Stop { run_id, json } => stop(run_id, *json),
    }
}

pub fn handle_chat(cmd: ChatCommand) -> Result<()> {
    match &cmd.command {
        ChatSubcommand::Pi { session } => chat_pi(&cmd, session.as_deref()),
    }
}

fn pi_chat_passthrough_args(session: Option<&str>, title: Option<&str>) -> Result<Vec<String>> {
    let mut args = Vec::new();
    if let Some(title) = title.map(str::trim).filter(|title| !title.is_empty()) {
        args.push("--name".into());
        args.push(title.to_string());
    }
    if let Some(session) = session {
        let session = normalize_pi_path_input(session);
        if !session.is_absolute() {
            anyhow::bail!("--session must be an absolute Pi transcript path");
        }
        args.push("--session".into());
        args.push(
            pi_node_compatible_path(&session)
                .to_string_lossy()
                .to_string(),
        );
    }
    Ok(args)
}

fn chat_pi(cmd_args: &ChatCommand, session: Option<&str>) -> Result<()> {
    // Validate caller-controlled selectors before resolving runtime
    // dependencies, while this path is still side-effect free.
    let passthrough_args = pi_chat_passthrough_args(session, cmd_args.title.as_deref())?;
    // Chat is a normal Pi SDK integration. Resolve the Starling-owned Node
    // host before creating run state or temporary launch artifacts, and never
    // fall back to the Pi CLI/RPC executable resolver used by `starling run`.
    let sdk_host = resolve_pi_sdk_host()?;
    let run_id = uuid::Uuid::new_v4().to_string();
    let start_ms = now_ms();
    let started_at = now_iso();
    let cwd = cmd_args.cwd.as_ref().map(PathBuf::from);
    let project_path = cwd
        .clone()
        .or_else(|| std::env::current_dir().ok())
        .map(|path| normalize_project_path(&path));
    let catalog_id = resolve_catalog_id(cmd_args.catalog.as_deref());
    let prepared = prepare_launch_with_pi_permissions(
        RunProvider::Pi,
        &run_id,
        cmd_args.setting.as_deref(),
        &passthrough_args,
        true,
        &[],
        None,
        true,
        project_path.as_deref(),
        true,
    )?;
    let effective_project_path = prepared
        .session_project_hint
        .clone()
        .or_else(|| project_path.clone());
    let sdk_host_cwd = effective_project_path.as_deref().map(Path::new);

    let pi_session_lock = match (
        prepared.session_id_hint.as_deref(),
        effective_project_path.as_deref(),
    ) {
        (Some(session_id), Some(project_path)) => {
            match acquire_pi_session_lock(session_id, project_path) {
                Ok(lock) => Some(lock),
                Err(error) => {
                    cleanup_launch_artifacts(&prepared);
                    return Err(error);
                }
            }
        }
        _ => None,
    };
    if let Err(error) = ensure_pi_session_not_running(
        prepared.session_id_hint.as_deref(),
        effective_project_path.as_deref(),
    ) {
        cleanup_launch_artifacts(&prepared);
        return Err(error);
    }

    create_run(RunRecord {
        run_id: run_id.clone(),
        session_id: prepared.session_id_hint.clone(),
        session_file: None,
        model: None,
        title: cmd_args.title.clone(),
        provider: RunProvider::Pi,
        project_path: effective_project_path.clone(),
        catalog_id: catalog_id.clone(),
        setting: cmd_args.setting.clone(),
        pid: None,
        status: RunStatus::Running,
        exit_code: None,
        started_at,
        ended_at: None,
        source: RunSource::StarlingRun,
    });

    eprintln!(
        "{} chat {} (Pi SDK host: {})",
        "starling".cyan(),
        short(&run_id),
        sdk_host.host_path.display()
    );
    let mut child_command = sdk_host.command();
    child_command.args(&prepared.args);
    for (key, value) in &prepared.envs {
        child_command.env(key, value);
    }
    if let Some(cwd) = sdk_host_cwd {
        child_command.current_dir(cwd);
    }
    child_command
        .stdin(Stdio::inherit())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());

    if let Some(lock) = pi_session_lock.as_ref() {
        if let Err(error) = lock.set_child_inheritable(true) {
            mark_run_crashed(&run_id);
            cleanup_launch_artifacts(&prepared);
            return Err(error);
        }
    }
    let spawn_result = child_command.spawn();
    if let Some(lock) = pi_session_lock.as_ref() {
        if let Err(error) = lock.set_child_inheritable(false) {
            eprintln!(
                "{}: could not restore Pi lock close-on-exec: {}",
                "warning".yellow(),
                error
            );
        }
    }
    let mut child = match spawn_result {
        Ok(child) => child,
        Err(error) => {
            mark_run_crashed(&run_id);
            cleanup_launch_artifacts(&prepared);
            anyhow::bail!(
                "failed to spawn Pi SDK host {} with {}: {}",
                sdk_host.host_path.display(),
                sdk_host.node.display(),
                error
            );
        }
    };

    let pid = child.id();
    update_run_pid(&run_id, pid);
    let assignment_watcher = maybe_start_catalog_assignment_watcher(
        run_id.clone(),
        pid,
        RunProvider::Pi,
        catalog_id.clone(),
        cmd_args.title.clone(),
        effective_project_path.clone(),
        start_ms,
        prepared.hook_file.clone(),
    );
    install_chat_signal_handler(run_id.clone(), pid);

    let child_stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            let _ = assignment_watcher.join();
            ACTIVE_CHILD_PID.store(0, Ordering::SeqCst);
            mark_run_crashed(&run_id);
            cleanup_launch_artifacts(&prepared);
            anyhow::bail!("Pi SDK host stdout was not captured");
        }
    };
    let stdout = std::io::stdout();
    let mut stdout = std::io::BufWriter::new(stdout.lock());
    let started_write = write_chat_json_line(
        &mut stdout,
        &serde_json::json!({
            "type": "starling_started",
            "schema": "starling.chat",
            "schemaVersion": 1,
            "agent": "pi",
            "runId": run_id,
            "pid": pid,
            "cwd": effective_project_path,
            "sessionId": prepared.session_id_hint,
        }),
    );
    if let Err(error) = started_write {
        let _ = child.kill();
        let _ = child.wait();
        ACTIVE_CHILD_PID.store(0, Ordering::SeqCst);
        mark_run_crashed(&run_id);
        cleanup_launch_artifacts(&prepared);
        return Err(error);
    }

    let protocol_error = match relay_sdk_host_jsonl(child_stdout, &mut stdout) {
        Ok(protocol_error) => protocol_error,
        Err(error) => {
            eprintln!("{}: Pi SDK host relay failed: {}", "error".red(), error);
            let _ = child.kill();
            true
        }
    };
    let wait_result = child.wait();
    ACTIVE_CHILD_PID.store(0, Ordering::SeqCst);
    // Serialize the watcher's final run-record patch with completion so a
    // late session-id update cannot overwrite the terminal run status.
    let _ = assignment_watcher.join();
    let (child_code, child_success, wait_error) = match wait_result {
        Ok(status) => (child_exit_code(&status), status.success(), None),
        Err(error) => (1, false, Some(error.to_string())),
    };
    let effective_success = child_success && !protocol_error && wait_error.is_none();
    let exit_code = if protocol_error && child_success {
        1
    } else {
        child_code
    };

    // The async signal hook records the parent signal before its background
    // worker forwards it to the SDK host. Do all recoverable cleanup here,
    // then let that worker restore/replay the original signal. In particular,
    // never race it with process::exit(1) just because the child wait status
    // has no code.
    if pending_parent_signal().is_some() {
        cleanup_launch_artifacts(&prepared);
        let _ = stdout.flush();
        CHAT_SIGNAL_CLEANUP_DONE.store(true, Ordering::SeqCst);
        loop {
            std::thread::park();
        }
    }

    // A fresh Pi session has an SDK identity before its transcript file is
    // materialized (Pi writes that file with the first message). Consume the
    // runtime hook synchronously so even an immediately closed chat retains
    // its real session ID in the run record and final lifecycle event.
    if let Some(hook) = prepared.hook_file.as_deref().and_then(read_hook_session) {
        update_run_session_id(
            &run_id,
            &canonical_session_id(&hook.session_id, Some(provider_name(RunProvider::Pi))),
        );
    }

    assign_recent_session_fallback(
        &run_id,
        RunProvider::Pi,
        pid,
        catalog_id.as_deref(),
        cmd_args.title.as_deref(),
        effective_project_path.as_deref(),
        start_ms,
    );
    finalize_run(
        &run_id,
        FinalizePatch {
            status: if effective_success {
                RunStatus::Completed
            } else {
                RunStatus::Errored
            },
            exit_code: Some(exit_code),
            ended_at: Some(now_iso()),
            session_id: None,
        },
    );
    let final_session_id = find_run(&run_id).and_then(|run| run.session_id);
    let exited_write = write_chat_json_line(
        &mut stdout,
        &serde_json::json!({
            "type": "starling_exited",
            "schema": "starling.chat",
            "schemaVersion": 1,
            "agent": "pi",
            "runId": run_id,
            "sessionId": final_session_id,
            "exitCode": exit_code,
            "success": effective_success,
            "protocolError": protocol_error,
            "error": wait_error,
        }),
    );
    cleanup_launch_artifacts(&prepared);
    exited_write?;
    stdout.flush()?;
    std::process::exit(exit_code);
}

fn write_chat_json_line(writer: &mut impl Write, value: &Value) -> Result<()> {
    serde_json::to_writer(&mut *writer, value)?;
    writer.write_all(b"\n")?;
    writer.flush()?;
    Ok(())
}

fn child_exit_code(status: &std::process::ExitStatus) -> i32 {
    if let Some(code) = status.code() {
        return code;
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(signal) = status.signal() {
            // A child-only signal is represented as a normal Starling exit
            // code. Only PENDING_PARENT_SIGNAL authorizes signal replay.
            return 128 + signal;
        }
    }
    if status.success() {
        0
    } else {
        1
    }
}

/// Relay only valid SDK host records. Starling guarantees that every forwarded
/// record remains one LF-terminated JSON value.
fn relay_sdk_host_jsonl(reader: impl Read, writer: &mut impl Write) -> Result<bool> {
    let mut reader = BufReader::new(reader);
    let mut line = Vec::new();
    let mut protocol_error = false;
    loop {
        line.clear();
        if reader.read_until(b'\n', &mut line)? == 0 {
            break;
        }
        while matches!(line.last(), Some(b'\n' | b'\r')) {
            line.pop();
        }
        if line.is_empty() || serde_json::from_slice::<Value>(&line).is_err() {
            protocol_error = true;
            eprintln!(
                "{}: discarded non-JSON output from Pi SDK host stdout",
                "warning".yellow()
            );
            continue;
        }
        writer.write_all(&line)?;
        writer.write_all(b"\n")?;
        writer.flush()?;
    }
    Ok(protocol_error)
}

const STARLING_RUN_PTY_ENV: &str = "STARLING_RUN_PTY";

struct PreparedLaunch {
    args: Vec<String>,
    envs: Vec<(String, String)>,
    temp_dir: Option<PathBuf>,
    cleanup_files: Vec<PathBuf>,
    hook_file: Option<PathBuf>,
    session_id_hint: Option<String>,
    session_project_hint: Option<String>,
}

fn launch(
    provider: RunProvider,
    program: &Path,
    prefix_args: &[String],
    display_bin: &str,
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
        .map(|path| normalize_project_path(&path));
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
        project_path.as_deref(),
    )?;
    let launch_args = prefix_args
        .iter()
        .chain(prepared.args.iter())
        .cloned()
        .collect::<Vec<_>>();
    let effective_project_path = prepared
        .session_project_hint
        .clone()
        .or_else(|| project_path.clone());

    // This OS-backed lock closes the check/create race between independent
    // Starling processes and remains held until the managed Pi process exits.
    let pi_session_lock = if provider == RunProvider::Pi {
        match (
            prepared.session_id_hint.as_deref(),
            effective_project_path.as_deref(),
        ) {
            (Some(session_id), Some(project_path)) => {
                match acquire_pi_session_lock(session_id, project_path) {
                    Ok(lock) => Some(lock),
                    Err(error) => {
                        cleanup_launch_artifacts(&prepared);
                        return Err(error);
                    }
                }
            }
            _ => None,
        }
    } else {
        None
    };

    if provider == RunProvider::Pi {
        if let Err(error) = ensure_pi_session_not_running(
            prepared.session_id_hint.as_deref(),
            effective_project_path.as_deref(),
        ) {
            cleanup_launch_artifacts(&prepared);
            return Err(error);
        }
    }

    // Pre-spawn record (pid unknown yet).
    let record = RunRecord {
        run_id: run_id.clone(),
        session_id: prepared.session_id_hint.clone(),
        session_file: None,
        model: None,
        title: cmd_args.title.clone(),
        provider,
        project_path: effective_project_path.clone(),
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

    eprintln!(
        "{} run {} ({})",
        "starling".cyan(),
        short(&run_id),
        display_bin
    );

    #[cfg(unix)]
    if pty_monitor_enabled(provider) {
        if let Some(lock) = pi_session_lock.as_ref() {
            if let Err(error) = lock.set_child_inheritable(true) {
                mark_run_crashed(&run_id);
                cleanup_launch_artifacts(&prepared);
                return Err(error);
            }
        }
        let pty_spawn = spawn_pty_child(program, &launch_args, &prepared.envs, cwd.as_deref());
        if let Some(lock) = pi_session_lock.as_ref() {
            if let Err(error) = lock.set_child_inheritable(false) {
                eprintln!(
                    "{}: could not restore Pi lock close-on-exec: {}",
                    "warning".yellow(),
                    error
                );
            }
        }
        match pty_spawn {
            Ok(pty_child) => {
                let pid = pty_child.pid as u32;
                install_run_signal_handler(run_id.clone(), pid);
                update_run_pid(&run_id, pid);
                let _ = maybe_start_catalog_assignment_watcher(
                    run_id.clone(),
                    pid,
                    provider,
                    catalog_id.clone(),
                    cmd_args.title.clone(),
                    effective_project_path.clone(),
                    start_ms,
                    prepared.hook_file.clone(),
                );
                let status =
                    drive_pty_child(pty_child, provider, &run_id, prepared.hook_file.as_deref());
                ACTIVE_CHILD_PID.store(0, Ordering::SeqCst);
                await_run_parent_signal_replay(&prepared);
                assign_recent_session_fallback(
                    &run_id,
                    provider,
                    pid,
                    catalog_id.as_deref(),
                    cmd_args.title.as_deref(),
                    effective_project_path.as_deref(),
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

    let mut cmd = Command::new(program);
    cmd.args(&launch_args);
    for (key, value) in &prepared.envs {
        cmd.env(key, value);
    }
    if let Some(cwd) = &cwd {
        cmd.current_dir(cwd);
    }
    cmd.stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());

    if let Some(lock) = pi_session_lock.as_ref() {
        if let Err(error) = lock.set_child_inheritable(true) {
            mark_run_crashed(&run_id);
            cleanup_launch_artifacts(&prepared);
            return Err(error);
        }
    }
    let spawn_result = cmd.spawn();
    if let Some(lock) = pi_session_lock.as_ref() {
        if let Err(error) = lock.set_child_inheritable(false) {
            eprintln!(
                "{}: could not restore Pi lock close-on-exec: {}",
                "warning".yellow(),
                error
            );
        }
    }

    match spawn_result {
        Ok(mut child) => {
            // Update record with pid.
            let pid = child.id();
            install_run_signal_handler(run_id.clone(), pid);
            update_run_pid(&run_id, pid);
            let _ = maybe_start_catalog_assignment_watcher(
                run_id.clone(),
                pid,
                provider,
                catalog_id.clone(),
                cmd_args.title.clone(),
                effective_project_path.clone(),
                start_ms,
                prepared.hook_file.clone(),
            );

            match child.wait() {
                Ok(status) => {
                    ACTIVE_CHILD_PID.store(0, Ordering::SeqCst);
                    await_run_parent_signal_replay(&prepared);
                    assign_recent_session_fallback(
                        &run_id,
                        provider,
                        pid,
                        catalog_id.as_deref(),
                        cmd_args.title.as_deref(),
                        effective_project_path.as_deref(),
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
                            exit_code: Some(child_exit_code(&status)),
                            ended_at: Some(now_iso()),
                            session_id: None,
                        },
                    );
                    cleanup_launch_artifacts(&prepared);
                    std::process::exit(child_exit_code(&status));
                }
                Err(e) => {
                    ACTIVE_CHILD_PID.store(0, Ordering::SeqCst);
                    await_run_parent_signal_replay(&prepared);
                    eprintln!(
                        "{}: failed to wait on {}: {}",
                        "error".red(),
                        display_bin,
                        e
                    );
                    mark_run_crashed(&run_id);
                    cleanup_launch_artifacts(&prepared);
                    std::process::exit(1);
                }
            }
        }
        Err(e) => {
            eprintln!("{}: failed to spawn {}: {}", "error".red(), display_bin, e);
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
    bin: &Path,
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

        let c_bin = CString::new(bin.as_os_str().as_bytes())
            .unwrap_or_else(|_| CString::new("false").unwrap());
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
            session_id: canonical_session_id(&session_id, Some(provider_name(provider))),
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
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        loop {
            if let Some(hook) = hook_file.as_deref().and_then(read_hook_session) {
                // Session identity is valid immediately, even though Pi may
                // defer creating the transcript until the first message.
                update_run_session_id(
                    &run_id,
                    &canonical_session_id(&hook.session_id, Some(provider_name(provider))),
                );
                let transcript_is_ready = hook
                    .transcript_path
                    .as_deref()
                    .map(|path| Path::new(path).is_file())
                    .unwrap_or(false);
                // Pi announces its in-memory transcript path at session_start,
                // but does not create the JSONL until the first assistant
                // message. Wait for persistence before creating a bookmark.
                if provider == RunProvider::Pi && !transcript_is_ready {
                    if catalog_id.is_none() && run_has_session_id(&run_id) {
                        return;
                    }
                    if !crate::core::runs::is_pid_alive(pid) {
                        return;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(250));
                    continue;
                }
                if catalog_id.is_none() {
                    return;
                }
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
                    catalog_id.as_deref().expect("catalog checked"),
                );
                return;
            }
            if should_try_process_map_assignment(provider, hook_file.is_some()) {
                if let Some(mapped) = map_process_tree_to_session_since(pid, start_ms) {
                    if let Some(session_id) = mapped.session_id {
                        let file_path = mapped.file_path.clone();
                        if provider == RunProvider::Pi
                            && !file_path
                                .as_deref()
                                .map(|path| Path::new(path).is_file())
                                .unwrap_or(false)
                        {
                            if catalog_id.is_none() && run_has_session_id(&run_id) {
                                return;
                            }
                            if !crate::core::runs::is_pid_alive(pid) {
                                return;
                            }
                            std::thread::sleep(std::time::Duration::from_millis(250));
                            continue;
                        }
                        update_run_session_id(
                            &run_id,
                            &canonical_session_id(&session_id, Some(provider_name(provider))),
                        );
                        let Some(catalog_id) = catalog_id.as_deref() else {
                            return;
                        };
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
                            catalog_id,
                        );
                        return;
                    }
                }
            }
            if !crate::core::runs::is_pid_alive(pid) {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(500));
        }
    })
}

fn should_try_process_map_assignment(provider: RunProvider, hook_file_present: bool) -> bool {
    !hook_file_present || matches!(provider, RunProvider::Codex | RunProvider::Pi)
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
        let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        let session_id = value
            .get("session_id")
            .or_else(|| value.get("sessionId"))
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())?
            .to_string();
        let transcript_path = value
            .get("transcript_path")
            .or_else(|| value.get("transcriptPath"))
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
    if let Some(session_id) = find_run(run_id).and_then(|run| run.session_id) {
        if let Some(meta) =
            find_session_by_id(&session_id).filter(|meta| meta.provider == provider_name(provider))
        {
            assign_session_to_catalog(
                run_id,
                provider,
                &meta.session_id,
                Some(&meta.file_path),
                &meta.project_path,
                title,
                None,
                catalog_id,
            );
            return;
        }
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
    let canonical_id = canonical_session_id(session_id, Some(provider_name(provider)));
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

    let bookmark = if let Some(existing) = find_bookmark_for_session(
        provider_name(provider),
        &canonical_id,
        effective_project_path,
    ) {
        maybe_update_placeholder_title(existing, title.or(first_prompt_hint), &inferred_title)
    } else if let Some(existing) = (canonical_id != session_id)
        .then(|| {
            find_bookmark_for_session(provider_name(provider), session_id, effective_project_path)
        })
        .flatten()
    {
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
        RunProvider::Pi => extract_pi_session_meta(&entries, path, &modified_at),
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
        RunProvider::Pi => "pi",
    }
}

fn discovery_provider(provider: RunProvider) -> DiscoveryProvider {
    match provider {
        RunProvider::Claude => DiscoveryProvider::Claude,
        RunProvider::Codex => DiscoveryProvider::Codex,
        RunProvider::Pi => DiscoveryProvider::Pi,
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

    fn write_pi_test_session(
        path: &Path,
        project: &Path,
        session_id: &str,
        header_timestamp: &str,
        message_timestamp: Option<&str>,
    ) {
        let mut lines = vec![serde_json::json!({
            "type": "session",
            "version": 3,
            "id": session_id,
            "timestamp": header_timestamp,
            "cwd": project.to_string_lossy(),
        })
        .to_string()];
        if let Some(message_timestamp) = message_timestamp {
            lines.push(
                serde_json::json!({
                    "type": "message",
                    "id": "message-1",
                    "parentId": null,
                    "timestamp": message_timestamp,
                    "message": {
                        "role": "user",
                        "content": "test",
                    },
                })
                .to_string(),
            );
        }
        std::fs::write(path, format!("{}\n", lines.join("\n"))).unwrap();
    }

    fn set_pi_test_file_mtime(path: &Path, seconds_since_epoch: u64) {
        let file = std::fs::OpenOptions::new().write(true).open(path).unwrap();
        let modified = std::time::UNIX_EPOCH + std::time::Duration::from_secs(seconds_since_epoch);
        file.set_times(std::fs::FileTimes::new().set_modified(modified))
            .unwrap();
    }

    fn assert_pi_unknown_flag_and_prompt_remain_separate(args: &[String]) {
        let parsed = PiParsedArgs::parse(args);
        let extension = parsed
            .spans
            .iter()
            .find(|span| args[span.start] == "--ext-boolean")
            .expect("extension flag span");
        assert!(extension.value.is_none());
        assert!(parsed
            .spans
            .iter()
            .any(|span| args[span.start] == "prompt" && span.value.is_none()));
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
        assert!(should_try_process_map_assignment(RunProvider::Pi, true));
        assert!(should_try_process_map_assignment(RunProvider::Pi, false));
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

    #[test]
    fn pi_managed_launch_without_selector_lets_pi_create_the_session() {
        let prepared = prepare_launch(
            RunProvider::Pi,
            "run-pi",
            None,
            &[],
            false,
            &[],
            None,
            false,
            None,
        )
        .unwrap();
        assert!(!prepared.args.iter().any(|arg| arg == "--session-id"));
        assert!(prepared.session_id_hint.is_none());
        assert!(!prepared
            .envs
            .iter()
            .any(|(key, _)| key == "STARLING_SESSION_ID"));
    }

    #[test]
    fn pi_explicit_session_id_is_preserved_case_sensitively() {
        let passthrough = vec!["--session-id".into(), "Pi.Custom_ID-7".into()];
        let prepared = prepare_launch(
            RunProvider::Pi,
            "run-pi",
            None,
            &passthrough,
            false,
            &[],
            None,
            false,
            None,
        )
        .unwrap();
        assert_eq!(prepared.session_id_hint.as_deref(), Some("Pi.Custom_ID-7"));
        assert_eq!(prepared.args, passthrough);
    }

    #[test]
    fn pi_equals_session_arguments_are_normalized_before_launch() {
        let passthrough = vec![
            "--session-id=Pi.Custom_ID-7".into(),
            "--session-dir=/tmp/pi-sessions".into(),
        ];
        let prepared = prepare_launch(
            RunProvider::Pi,
            "run-pi",
            None,
            &passthrough,
            false,
            &[],
            None,
            false,
            None,
        )
        .unwrap();

        assert_eq!(prepared.session_id_hint.as_deref(), Some("Pi.Custom_ID-7"));
        assert_eq!(
            prepared.args,
            vec![
                "--session-id",
                "Pi.Custom_ID-7",
                "--session-dir",
                "/tmp/pi-sessions"
            ]
        );
    }

    #[test]
    fn pi_repeated_value_arguments_are_last_wins() {
        let normalized = normalize_pi_passthrough_args(&[
            "--session-id=First".into(),
            "--session-id".into(),
            "Second".into(),
            "--session-dir=/tmp/first".into(),
            "--session-dir".into(),
            "/tmp/second".into(),
        ])
        .unwrap();

        assert_eq!(
            pi_arg_value(&normalized, "--session-id").as_deref(),
            Some("Second")
        );
        assert_eq!(
            pi_arg_value(&normalized, "--session-dir").as_deref(),
            Some("/tmp/second")
        );
    }

    #[test]
    fn pi_inline_normalization_respects_value_token_ownership() {
        let normalized = normalize_pi_passthrough_args(&[
            "--session-dir".into(),
            "--session=ConsumedAsDirectory".into(),
            "--session=ActualSelector".into(),
        ])
        .unwrap();

        assert_eq!(
            normalized,
            vec![
                "--session-dir",
                "--session=ConsumedAsDirectory",
                "--session",
                "ActualSelector"
            ]
        );
        assert_eq!(
            pi_arg_value(&normalized, "--session-dir").as_deref(),
            Some("--session=ConsumedAsDirectory")
        );
        assert_eq!(
            pi_arg_value(&normalized, "--session").as_deref(),
            Some("ActualSelector")
        );
    }

    #[test]
    fn pi_native_value_flags_own_selector_looking_tokens() {
        let args = vec![
            "--system-prompt".into(),
            "--session".into(),
            "message".into(),
            "--model".into(),
            "-c".into(),
        ];

        assert!(pi_arg_value(&args, "--session").is_none());
        assert!(!pi_has_continue_arg(&args));
        assert!(!pi_launch_needs_managed_id(&args));
    }

    #[test]
    fn pi_session_id_validation_matches_pi_before_selector_rewrites() {
        validate_pi_session_id_value("Pi.Custom_ID-7").unwrap();
        assert!(validate_pi_session_id_value("").is_err());
        assert!(validate_pi_session_id_value("-bad").is_err());
        assert!(validate_pi_session_id_value("bad/").is_err());

        let conflict = vec![
            "--session-id".into(),
            "Existing".into(),
            "--continue".into(),
        ];
        assert!(validate_pi_selector_combinations(&conflict)
            .unwrap_err()
            .to_string()
            .contains("--session-id cannot be combined with --continue"));
    }

    #[test]
    fn pi_empty_last_session_value_does_not_resume_an_earlier_selector() {
        let args = vec![
            "--session".into(),
            "Earlier".into(),
            "--session".into(),
            "".into(),
        ];

        assert!(pi_truthy_arg_value(&args, "--session").is_none());
        assert!(pi_launch_needs_managed_id(&args));
    }

    #[test]
    fn pi_fork_uses_the_new_session_id_and_rejects_conflicting_selectors() {
        let valid = vec![
            "--session-id".into(),
            "ForkTarget".into(),
            "--fork".into(),
            "ForkSource".into(),
        ];
        validate_pi_selector_combinations(&valid).unwrap();
        let target = resolve_pi_session_target(&valid, Some("/tmp"))
            .unwrap()
            .expect("fork target ID");

        assert_eq!(target.session_id, "ForkTarget");
        assert!(target.transcript_path.is_none());

        let conflicting = vec![
            "--fork".into(),
            "ForkSource".into(),
            "--session".into(),
            "Existing".into(),
        ];
        assert!(validate_pi_selector_combinations(&conflicting)
            .unwrap_err()
            .to_string()
            .contains("--fork cannot be combined with --session"));
    }

    #[test]
    fn pi_session_path_uses_transcript_header_project_scope() {
        let root =
            std::env::temp_dir().join(format!("starling-pi-target-scope-{}", uuid::Uuid::new_v4()));
        let startup = root.join("startup");
        let session_project = root.join("session-project");
        let session_file = root.join("session.jsonl");
        let path_alias_dir = root.join("path-alias");
        std::fs::create_dir_all(&startup).unwrap();
        std::fs::create_dir_all(&session_project).unwrap();
        std::fs::create_dir_all(&path_alias_dir).unwrap();
        std::fs::write(
            &session_file,
            format!(
                "{{\"type\":\"session\",\"version\":3,\"id\":\"Scoped_ID\",\"timestamp\":\"2026-07-24T00:00:00.000Z\",\"cwd\":{}}}\n",
                serde_json::to_string(&session_project.to_string_lossy()).unwrap()
            ),
        )
        .unwrap();
        let passthrough = vec![
            "--session".into(),
            path_alias_dir
                .join("..")
                .join("session.jsonl")
                .to_string_lossy()
                .to_string(),
        ];

        let prepared = prepare_launch(
            RunProvider::Pi,
            "run-pi",
            None,
            &passthrough,
            false,
            &[],
            None,
            false,
            Some(startup.to_string_lossy().as_ref()),
        )
        .unwrap();

        assert_eq!(prepared.session_id_hint.as_deref(), Some("Scoped_ID"));
        assert_eq!(
            prepared.session_project_hint.as_deref(),
            Some(normalize_project_path(&session_project).as_str())
        );
        assert_eq!(
            prepared.args,
            vec![
                "--session".to_string(),
                std::fs::canonicalize(&session_file)
                    .unwrap()
                    .to_string_lossy()
                    .to_string()
            ]
        );
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn pi_managed_explicit_path_rejects_unidentifiable_new_or_empty_transcripts() {
        let root = std::env::temp_dir().join(format!(
            "starling-pi-explicit-path-limit-{}",
            uuid::Uuid::new_v4()
        ));
        let project = root.join("project");
        std::fs::create_dir_all(&project).unwrap();
        let missing = root.join("missing.jsonl");
        let missing_error = resolve_pi_session_target(
            &["--session".into(), missing.to_string_lossy().to_string()],
            Some(project.to_string_lossy().as_ref()),
        )
        .unwrap_err()
        .to_string();
        assert!(missing_error.contains("managed Pi runs cannot initialize a new explicit"));
        assert!(!missing.exists());

        let empty = root.join("empty.jsonl");
        std::fs::write(&empty, []).unwrap();
        let empty_error = resolve_pi_session_target(
            &["--session".into(), empty.to_string_lossy().to_string()],
            Some(project.to_string_lossy().as_ref()),
        )
        .unwrap_err()
        .to_string();
        assert!(empty_error.contains("managed Pi runs cannot initialize an empty explicit"));
        assert_eq!(std::fs::read(&empty).unwrap(), Vec::<u8>::new());
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn pi_continue_resolves_recent_session_before_locking() {
        if std::env::var_os("PI_CODING_AGENT_SESSION_DIR").is_some() {
            return;
        }
        let root = std::env::temp_dir().join(format!(
            "starling-pi-continue-scope-{}",
            uuid::Uuid::new_v4()
        ));
        let project = root.join("project");
        let sessions = project.join("project-sessions");
        std::fs::create_dir_all(project.join(".pi")).unwrap();
        std::fs::create_dir_all(&sessions).unwrap();
        std::fs::write(
            project.join(".pi/settings.json"),
            r#"{"sessionDir":"project-sessions"}"#,
        )
        .unwrap();
        std::fs::write(
            sessions.join("2026-07-24T00-00-00-000Z_Continue_ID.jsonl"),
            format!(
                "{{\"type\":\"session\",\"version\":3,\"id\":\"Continue_ID\",\"timestamp\":\"2026-07-24T00:00:00.000Z\",\"cwd\":{}}}\n",
                serde_json::to_string(&project.to_string_lossy()).unwrap()
            ),
        )
        .unwrap();
        let passthrough = vec!["--continue".into()];

        let prepared = prepare_launch(
            RunProvider::Pi,
            "run-pi",
            None,
            &passthrough,
            false,
            &[],
            None,
            false,
            Some(project.to_string_lossy().as_ref()),
        )
        .unwrap();

        assert_eq!(prepared.session_id_hint.as_deref(), Some("Continue_ID"));
        assert_eq!(
            prepared.session_project_hint.as_deref(),
            Some(normalize_project_path(&project).as_str())
        );
        assert_eq!(
            prepared.args,
            vec![
                "--session".to_string(),
                std::fs::canonicalize(sessions.join("2026-07-24T00-00-00-000Z_Continue_ID.jsonl"))
                    .unwrap()
                    .to_string_lossy()
                    .to_string()
            ]
        );
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn pi_continue_without_a_transcript_becomes_a_locked_new_session() {
        if std::env::var_os("PI_CODING_AGENT_SESSION_DIR").is_some() {
            return;
        }
        let root = std::env::temp_dir().join(format!(
            "starling-pi-empty-continue-{}",
            uuid::Uuid::new_v4()
        ));
        let project = root.join("project");
        std::fs::create_dir_all(project.join(".pi")).unwrap();
        std::fs::write(
            project.join(".pi/settings.json"),
            r#"{"sessionDir":"empty-sessions"}"#,
        )
        .unwrap();

        let prepared = prepare_launch(
            RunProvider::Pi,
            "run-pi",
            None,
            &["-c".into()],
            false,
            &[],
            None,
            false,
            Some(project.to_string_lossy().as_ref()),
        )
        .unwrap();

        let session_id = prepared.session_id_hint.expect("managed Pi ID");
        assert_eq!(
            prepared.args,
            vec![
                "--session-id".to_string(),
                session_id.clone(),
                "--session".to_string(),
                String::new()
            ]
        );
        assert!(!prepared
            .args
            .iter()
            .any(|arg| matches!(arg.as_str(), "-c" | "--continue")));
        assert_eq!(
            prepared.session_project_hint.as_deref(),
            Some(normalize_project_path(&project).as_str())
        );
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn pi_session_prefix_uses_effective_project_session_dir_and_is_pinned() {
        if std::env::var_os("PI_CODING_AGENT_SESSION_DIR").is_some() {
            return;
        }
        let root = std::env::temp_dir().join(format!(
            "starling-pi-project-selector-{}",
            uuid::Uuid::new_v4()
        ));
        let project = root.join("project");
        let sessions = project.join("custom-sessions");
        std::fs::create_dir_all(project.join(".pi")).unwrap();
        std::fs::create_dir_all(&sessions).unwrap();
        std::fs::write(
            project.join(".pi/settings.json"),
            r#"{"sessionDir":"custom-sessions"}"#,
        )
        .unwrap();
        let transcript = sessions.join("2026-07-24T00-00-00-000Z_ProjectLocalAlpha.jsonl");
        std::fs::write(
            &transcript,
            format!(
                "{{\"type\":\"session\",\"version\":3,\"id\":\"ProjectLocalAlpha\",\"timestamp\":\"2026-07-24T00:00:00.000Z\",\"cwd\":{}}}\n",
                serde_json::to_string(&project.to_string_lossy()).unwrap()
            ),
        )
        .unwrap();

        let prepared = prepare_launch(
            RunProvider::Pi,
            "run-pi",
            None,
            &["--session".into(), "ProjectLocal".into()],
            false,
            &[],
            None,
            false,
            Some(project.to_string_lossy().as_ref()),
        )
        .unwrap();

        assert_eq!(
            prepared.session_id_hint.as_deref(),
            Some("ProjectLocalAlpha")
        );
        assert_eq!(
            prepared.args,
            vec![
                "--session".to_string(),
                std::fs::canonicalize(transcript)
                    .unwrap()
                    .to_string_lossy()
                    .to_string()
            ]
        );
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn pi_existing_session_id_is_resolved_pinned_and_scoped_before_spawn() {
        let root =
            std::env::temp_dir().join(format!("starling-pi-existing-id-{}", uuid::Uuid::new_v4()));
        let project = root.join("project");
        let sessions = root.join("sessions");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::create_dir_all(&sessions).unwrap();
        let transcript = sessions.join("ExistingExact.jsonl");
        write_pi_test_session(
            &transcript,
            &project,
            "ExistingExact",
            "2026-07-24T00:00:00.000Z",
            None,
        );

        let prepared = prepare_launch(
            RunProvider::Pi,
            "run-pi",
            None,
            &[
                "--session-id".into(),
                "ExistingExact".into(),
                "--session-dir".into(),
                sessions.to_string_lossy().to_string(),
            ],
            false,
            &[],
            None,
            false,
            Some(project.to_string_lossy().as_ref()),
        )
        .unwrap();

        assert_eq!(prepared.session_id_hint.as_deref(), Some("ExistingExact"));
        assert_eq!(
            prepared.session_project_hint.as_deref(),
            Some(normalize_project_path(&project).as_str())
        );
        assert_eq!(&prepared.args[0], "--session");
        assert_eq!(
            Path::new(&prepared.args[1]),
            std::fs::canonicalize(&transcript).unwrap()
        );
        assert!(!prepared.args.iter().any(|arg| arg == "--session-id"));
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn pi_empty_session_plus_continue_pins_only_the_continue_target() {
        let root = std::env::temp_dir().join(format!(
            "starling-pi-empty-session-continue-{}",
            uuid::Uuid::new_v4()
        ));
        let project = root.join("project");
        let sessions = root.join("sessions");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::create_dir_all(&sessions).unwrap();
        let transcript = sessions.join("ContinueAfterEmpty.jsonl");
        write_pi_test_session(
            &transcript,
            &project,
            "ContinueAfterEmpty",
            "2026-07-24T00:00:00.000Z",
            None,
        );

        let prepared = prepare_launch(
            RunProvider::Pi,
            "run-pi",
            None,
            &[
                "--session".into(),
                "".into(),
                "--continue".into(),
                "--session-dir".into(),
                sessions.to_string_lossy().to_string(),
            ],
            false,
            &[],
            None,
            false,
            Some(project.to_string_lossy().as_ref()),
        )
        .unwrap();

        assert_eq!(
            prepared.session_id_hint.as_deref(),
            Some("ContinueAfterEmpty")
        );
        assert_eq!(
            prepared
                .args
                .iter()
                .filter(|arg| arg.as_str() == "--session")
                .count(),
            2
        );
        assert!(!prepared
            .args
            .iter()
            .any(|arg| matches!(arg.as_str(), "--continue" | "-c")));
        let canonical = std::fs::canonicalize(&transcript).unwrap();
        assert_eq!(Path::new(&prepared.args[1]), canonical);
        assert_eq!(Path::new(&prepared.args[3]), canonical);
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn pi_consumed_session_token_is_preserved_when_continue_is_pinned() {
        let root = std::env::temp_dir().join(format!(
            "starling-pi-consumed-session-{}",
            uuid::Uuid::new_v4()
        ));
        let project = root.join("project");
        // Pi parses `--session-dir --session` as a directory assignment, even
        // though the value token looks like a selector flag.
        let sessions = project.join("--session");
        std::fs::create_dir_all(&sessions).unwrap();
        let transcript = sessions.join("OwnedTokens.jsonl");
        write_pi_test_session(
            &transcript,
            &project,
            "OwnedTokens",
            "2026-07-24T00:00:00.000Z",
            None,
        );

        let prepared = prepare_launch(
            RunProvider::Pi,
            "run-pi",
            None,
            &[
                "--session-dir".into(),
                "--session".into(),
                "".into(),
                "-c".into(),
            ],
            false,
            &[],
            None,
            false,
            Some(project.to_string_lossy().as_ref()),
        )
        .unwrap();

        assert_eq!(prepared.session_id_hint.as_deref(), Some("OwnedTokens"));
        assert_eq!(&prepared.args[0..3], &["--session-dir", "--session", ""]);
        assert_eq!(&prepared.args[3], "--session");
        assert_eq!(
            Path::new(&prepared.args[4]),
            std::fs::canonicalize(&transcript).unwrap()
        );
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn pi_consumed_session_dir_does_not_override_continue_layout() {
        if std::env::var_os("PI_CODING_AGENT_SESSION_DIR").is_some() {
            return;
        }
        let root = std::env::temp_dir().join(format!(
            "starling-pi-consumed-session-dir-{}",
            uuid::Uuid::new_v4()
        ));
        let project = root.join("project");
        let sessions = project.join("project-sessions");
        std::fs::create_dir_all(project.join(".pi")).unwrap();
        std::fs::create_dir_all(&sessions).unwrap();
        std::fs::write(
            project.join(".pi/settings.json"),
            r#"{"sessionDir":"project-sessions"}"#,
        )
        .unwrap();
        let transcript = sessions.join("ConsumedDirectory.jsonl");
        write_pi_test_session(
            &transcript,
            &project,
            "ConsumedDirectory",
            "2026-07-24T00:00:00.000Z",
            None,
        );

        let prepared = prepare_launch(
            RunProvider::Pi,
            "run-pi",
            None,
            &[
                "--system-prompt".into(),
                "--session-dir".into(),
                "-c".into(),
            ],
            false,
            &[],
            None,
            false,
            Some(project.to_string_lossy().as_ref()),
        )
        .unwrap();

        assert_eq!(
            prepared.session_id_hint.as_deref(),
            Some("ConsumedDirectory")
        );
        assert_eq!(&prepared.args[0..2], &["--system-prompt", "--session-dir"]);
        assert_eq!(&prepared.args[2], "--session");
        assert_eq!(
            Path::new(&prepared.args[3]),
            std::fs::canonicalize(&transcript).unwrap()
        );
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn pi_pinned_selector_precedes_a_dangling_value_option() {
        let root = std::env::temp_dir().join(format!(
            "starling-pi-dangling-value-{}",
            uuid::Uuid::new_v4()
        ));
        let project = root.join("project");
        let sessions = root.join("sessions");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::create_dir_all(&sessions).unwrap();
        let transcript = sessions.join("PinnedBeforeDangling.jsonl");
        write_pi_test_session(
            &transcript,
            &project,
            "PinnedBeforeDangling",
            "2026-07-24T00:00:00.000Z",
            None,
        );

        let prepared = prepare_launch(
            RunProvider::Pi,
            "run-pi",
            None,
            &[
                "-c".into(),
                "--session-dir".into(),
                sessions.to_string_lossy().to_string(),
                "--model".into(),
            ],
            false,
            &[],
            None,
            false,
            Some(project.to_string_lossy().as_ref()),
        )
        .unwrap();

        assert_eq!(
            prepared.session_id_hint.as_deref(),
            Some("PinnedBeforeDangling")
        );
        assert_eq!(&prepared.args[0], "--session");
        assert_eq!(
            Path::new(&prepared.args[1]),
            std::fs::canonicalize(&transcript).unwrap()
        );
        assert_eq!(prepared.args.last().map(String::as_str), Some("--model"));
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn pi_pinned_continue_keeps_unknown_flag_and_trailing_prompt_separate() {
        let root = std::env::temp_dir().join(format!(
            "starling-pi-pinned-token-barrier-{}",
            uuid::Uuid::new_v4()
        ));
        let project = root.join("project");
        let sessions = root.join("sessions");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::create_dir_all(&sessions).unwrap();
        let transcript = sessions.join("PinnedBarrier.jsonl");
        write_pi_test_session(
            &transcript,
            &project,
            "PinnedBarrier",
            "2026-07-24T00:00:00.000Z",
            None,
        );

        let prepared = prepare_launch(
            RunProvider::Pi,
            "run-pi",
            None,
            &[
                "--ext-boolean".into(),
                "-c".into(),
                "prompt".into(),
                "--session-dir".into(),
                sessions.to_string_lossy().to_string(),
            ],
            false,
            &[],
            None,
            false,
            Some(project.to_string_lossy().as_ref()),
        )
        .unwrap();

        assert_eq!(prepared.session_id_hint.as_deref(), Some("PinnedBarrier"));
        assert_pi_unknown_flag_and_prompt_remain_separate(&prepared.args);
        assert_eq!(&prepared.args[1], "--session");
        assert_eq!(
            Path::new(&prepared.args[2]),
            std::fs::canonicalize(&transcript).unwrap()
        );
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn pi_empty_continue_keeps_unknown_flag_and_trailing_prompt_separate() {
        let root = std::env::temp_dir().join(format!(
            "starling-pi-empty-token-barrier-{}",
            uuid::Uuid::new_v4()
        ));
        let project = root.join("project");
        let sessions = root.join("empty-sessions");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::create_dir_all(&sessions).unwrap();

        let prepared = prepare_launch(
            RunProvider::Pi,
            "run-pi",
            None,
            &[
                "--ext-boolean".into(),
                "-c".into(),
                "prompt".into(),
                "--session-dir".into(),
                sessions.to_string_lossy().to_string(),
            ],
            false,
            &[],
            None,
            false,
            Some(project.to_string_lossy().as_ref()),
        )
        .unwrap();

        assert!(prepared.session_id_hint.is_some());
        assert_pi_unknown_flag_and_prompt_remain_separate(&prepared.args);
        let parsed = PiParsedArgs::parse(&prepared.args);
        assert_eq!(parsed.value(PiArgKind::Session), Some(""));
        assert!(parsed.value(PiArgKind::SessionId).is_some());
        assert!(!parsed.has(PiArgKind::Continue));
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn pi_open_scope_uses_header_cwd_when_default_layout_does_not_filter() {
        let root = std::env::temp_dir().join(format!(
            "starling-pi-moved-session-{}",
            uuid::Uuid::new_v4()
        ));
        let launch_project = root.join("launch-project");
        let header_project = root.join("header-project");
        let sessions = root.join("sessions");
        std::fs::create_dir_all(&launch_project).unwrap();
        std::fs::create_dir_all(&header_project).unwrap();
        std::fs::create_dir_all(&sessions).unwrap();
        write_pi_test_session(
            &sessions.join("MovedSession.jsonl"),
            &header_project,
            "MovedSession",
            "2026-07-24T00:00:00.000Z",
            None,
        );
        let layout = PiLaunchSessionLayout {
            session_root: root.clone(),
            local_dir: sessions,
            configured: false,
            filter_local_cwd: false,
        };

        let local = pi_local_session_infos(&layout, &launch_project);
        let target = pi_exact_or_prefix(&local, "MovedSession").expect("moved session");
        let scope = pi_effective_open_project_path(
            &target.project_path,
            launch_project.to_string_lossy().as_ref(),
        );

        assert_eq!(scope, normalize_project_path(&header_project));
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn pi_pinned_continue_uses_moved_transcript_header_cwd_for_its_lock_scope() {
        let root = std::env::temp_dir().join(format!(
            "starling-pi-moved-continue-{}",
            uuid::Uuid::new_v4()
        ));
        let launch_project = root.join("launch-project");
        let header_project = root.join("header-project");
        let sessions = root.join("sessions");
        std::fs::create_dir_all(&launch_project).unwrap();
        std::fs::create_dir_all(&header_project).unwrap();
        std::fs::create_dir_all(&sessions).unwrap();
        let transcript = sessions.join("MovedContinue.jsonl");
        write_pi_test_session(
            &transcript,
            &header_project,
            "MovedContinue",
            "2026-07-24T00:00:00.000Z",
            None,
        );
        let layout = PiLaunchSessionLayout {
            session_root: root.clone(),
            local_dir: sessions,
            configured: false,
            filter_local_cwd: false,
        };

        let target = pi_continue_target(&layout, launch_project.to_string_lossy().as_ref())
            .expect("moved continue target");

        assert_eq!(target.session_id, "MovedContinue");
        assert_eq!(target.project_path, normalize_project_path(&header_project));
        assert_eq!(
            Path::new(target.transcript_path.as_deref().unwrap()),
            std::fs::canonicalize(&transcript).unwrap()
        );
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn pi_session_prefix_uses_message_activity_instead_of_file_mtime() {
        if std::env::var_os("PI_CODING_AGENT_SESSION_DIR").is_some() {
            return;
        }
        let root = std::env::temp_dir().join(format!(
            "starling-pi-logical-selector-{}",
            uuid::Uuid::new_v4()
        ));
        let project = root.join("project");
        let sessions = project.join("custom-sessions");
        std::fs::create_dir_all(project.join(".pi")).unwrap();
        std::fs::create_dir_all(&sessions).unwrap();
        std::fs::write(
            project.join(".pi/settings.json"),
            r#"{"sessionDir":"custom-sessions"}"#,
        )
        .unwrap();

        let logically_new = sessions.join("LogicActive.jsonl");
        let file_new = sessions.join("LogicFileNew.jsonl");
        write_pi_test_session(
            &logically_new,
            &project,
            "LogicActive",
            "2026-07-20T00:00:00.000Z",
            Some("2026-07-25T00:00:00.000Z"),
        );
        write_pi_test_session(
            &file_new,
            &project,
            "LogicFileNew",
            "2026-07-24T00:00:00.000Z",
            None,
        );
        set_pi_test_file_mtime(&logically_new, 100);
        set_pi_test_file_mtime(&file_new, 200);

        let target = resolve_pi_session_target(
            &["--session".into(), "Logic".into()],
            Some(project.to_string_lossy().as_ref()),
        )
        .unwrap()
        .expect("Pi selector target");

        assert_eq!(target.session_id, "LogicActive");
        assert_eq!(
            target.transcript_path.as_deref(),
            Some(
                std::fs::canonicalize(&logically_new)
                    .unwrap()
                    .to_string_lossy()
                    .as_ref()
            )
        );
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn pi_session_selector_ignores_nested_backup_transcripts() {
        if std::env::var_os("PI_CODING_AGENT_SESSION_DIR").is_some() {
            return;
        }
        let root = std::env::temp_dir().join(format!(
            "starling-pi-direct-selector-{}",
            uuid::Uuid::new_v4()
        ));
        let project = root.join("project");
        let sessions = project.join("custom-sessions");
        let backup = sessions.join("backup");
        std::fs::create_dir_all(project.join(".pi")).unwrap();
        std::fs::create_dir_all(&backup).unwrap();
        std::fs::write(
            project.join(".pi/settings.json"),
            r#"{"sessionDir":"custom-sessions"}"#,
        )
        .unwrap();

        let direct = sessions.join("NestedDirect.jsonl");
        let nested = backup.join("NestedBackup.jsonl");
        write_pi_test_session(
            &direct,
            &project,
            "NestedDirect",
            "2026-07-20T00:00:00.000Z",
            None,
        );
        write_pi_test_session(
            &nested,
            &project,
            "NestedBackup",
            "2026-07-25T00:00:00.000Z",
            None,
        );
        set_pi_test_file_mtime(&direct, 100);
        set_pi_test_file_mtime(&nested, 200);

        let target = resolve_pi_session_target(
            &["--session".into(), "Nested".into()],
            Some(project.to_string_lossy().as_ref()),
        )
        .unwrap()
        .expect("direct Pi selector target");

        assert_eq!(target.session_id, "NestedDirect");
        assert_eq!(
            Path::new(target.transcript_path.as_deref().unwrap()),
            std::fs::canonicalize(&direct).unwrap()
        );
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn pi_exact_selector_has_no_legacy_2500_session_cap() {
        if std::env::var_os("PI_CODING_AGENT_SESSION_DIR").is_some() {
            return;
        }
        let root = std::env::temp_dir().join(format!(
            "starling-pi-unlimited-selector-{}",
            uuid::Uuid::new_v4()
        ));
        let project = root.join("project");
        let sessions = project.join("custom-sessions");
        std::fs::create_dir_all(project.join(".pi")).unwrap();
        std::fs::create_dir_all(&sessions).unwrap();
        std::fs::write(
            project.join(".pi/settings.json"),
            r#"{"sessionDir":"custom-sessions"}"#,
        )
        .unwrap();

        let target_path = sessions.join("TargetBeyondLegacyCap.jsonl");
        write_pi_test_session(
            &target_path,
            &project,
            "TargetBeyondLegacyCap",
            "2026-07-20T00:00:00.000Z",
            None,
        );
        set_pi_test_file_mtime(&target_path, 1);
        for index in 0..2500 {
            let session_id = format!("Bulk{index:04}");
            write_pi_test_session(
                &sessions.join(format!("{session_id}.jsonl")),
                &project,
                &session_id,
                "2026-07-24T00:00:00.000Z",
                None,
            );
        }

        let target = resolve_pi_session_target(
            &["--session".into(), "TargetBeyondLegacyCap".into()],
            Some(project.to_string_lossy().as_ref()),
        )
        .unwrap()
        .expect("uncapped exact Pi selector target");

        assert_eq!(target.session_id, "TargetBeyondLegacyCap");
        assert_eq!(
            Path::new(target.transcript_path.as_deref().unwrap()),
            std::fs::canonicalize(&target_path).unwrap()
        );
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn pi_continue_uses_direct_file_mtime_and_ignores_nested_backups() {
        if std::env::var_os("PI_CODING_AGENT_SESSION_DIR").is_some() {
            return;
        }
        let root = std::env::temp_dir().join(format!(
            "starling-pi-continue-mtime-{}",
            uuid::Uuid::new_v4()
        ));
        let project = root.join("project");
        let sessions = project.join("custom-sessions");
        let backup = sessions.join("backup");
        std::fs::create_dir_all(project.join(".pi")).unwrap();
        std::fs::create_dir_all(&backup).unwrap();
        std::fs::write(
            project.join(".pi/settings.json"),
            r#"{"sessionDir":"custom-sessions"}"#,
        )
        .unwrap();

        let logical_new = sessions.join("ContinueLogicalNew.jsonl");
        let mtime_new = sessions.join("ContinueMtimeNew.jsonl");
        let nested_newest = backup.join("ContinueNestedNewest.jsonl");
        write_pi_test_session(
            &logical_new,
            &project,
            "ContinueLogicalNew",
            "2026-07-25T00:00:00.000Z",
            None,
        );
        write_pi_test_session(
            &mtime_new,
            &project,
            "ContinueMtimeNew",
            "2026-07-20T00:00:00.000Z",
            None,
        );
        write_pi_test_session(
            &nested_newest,
            &project,
            "ContinueNestedNewest",
            "2026-07-26T00:00:00.000Z",
            None,
        );
        set_pi_test_file_mtime(&logical_new, 100);
        set_pi_test_file_mtime(&mtime_new, 200);
        set_pi_test_file_mtime(&nested_newest, 300);

        let target = resolve_pi_session_target(
            &["--continue".into()],
            Some(project.to_string_lossy().as_ref()),
        )
        .unwrap()
        .expect("recent direct Pi session");

        assert_eq!(target.session_id, "ContinueMtimeNew");
        assert_eq!(
            Path::new(target.transcript_path.as_deref().unwrap()),
            std::fs::canonicalize(&mtime_new).unwrap()
        );
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn pi_managed_resume_picker_is_rejected_before_spawn() {
        let passthrough = vec!["--resume".into()];
        let result = prepare_launch(
            RunProvider::Pi,
            "run-pi",
            None,
            &passthrough,
            true,
            &[],
            None,
            false,
            Some("/tmp"),
        );

        assert!(result
            .err()
            .expect("managed resume picker should fail")
            .to_string()
            .contains("cannot safely lock the interactive --resume picker"));
    }

    #[test]
    fn pi_no_session_does_not_inject_a_managed_id() {
        let passthrough = vec!["--no-session".into(), "-p".into(), "hello".into()];
        let prepared = prepare_launch(
            RunProvider::Pi,
            "run-pi",
            None,
            &passthrough,
            false,
            &[],
            None,
            false,
            None,
        )
        .unwrap();
        assert!(prepared.session_id_hint.is_none());
        assert_eq!(prepared.args, passthrough);
        assert!(prepared
            .envs
            .iter()
            .any(|(key, value)| key == "STARLING_PI_NO_SESSION" && value == "1"));
    }

    #[test]
    fn pi_profile_maps_model_provider_and_thinking_without_credentials() {
        let path =
            std::env::temp_dir().join(format!("starling-pi-profile-{}.json", uuid::Uuid::new_v4()));
        std::fs::write(
            &path,
            r#"{"provider":"anthropic","model":"claude-sonnet","thinking":"medium","apiKey":"do-not-copy"}"#,
        )
        .unwrap();
        let args = pi_profile_args(&path).unwrap();
        let _ = std::fs::remove_file(path);
        assert_eq!(
            args,
            vec![
                "--provider",
                "anthropic",
                "--model",
                "claude-sonnet",
                "--thinking",
                "medium"
            ]
        );
        assert!(!args.iter().any(|arg| arg.contains("do-not-copy")));
    }

    #[test]
    fn pi_rejects_starling_mcp_injection() {
        let result = prepare_launch(
            RunProvider::Pi,
            "run-pi",
            None,
            &[],
            false,
            &["server".into()],
            None,
            false,
            None,
        );
        assert!(result
            .err()
            .expect("Pi MCP injection should fail")
            .to_string()
            .contains("does not expose native MCP"));
    }

    #[test]
    fn pi_runtime_extension_cancels_in_process_transcript_switches() {
        let guard = super::pi_session_switch_guard_source();
        let registrations = super::pi_session_switch_guard_registration_source();
        assert!(guard.contains("return { cancel: true }"));
        assert!(guard.contains("starling resume"));
        assert!(registrations.contains("session_before_switch"));
        assert!(registrations.contains("session_before_fork"));
    }

    #[test]
    fn pi_chat_new_session_uses_sdk_host_without_cli_mode_or_session_selector() {
        let args = pi_chat_passthrough_args(None, None).unwrap();
        assert!(args.is_empty());
        assert!(!args.iter().any(|arg| arg == "--mode"));
        assert!(!args.iter().any(|arg| matches!(
            arg.as_str(),
            "--session" | "--session-id" | "--continue" | "--resume" | "--fork"
        )));
        assert!(!pi_launch_needs_managed_id(&args));
    }

    #[test]
    fn pi_chat_requires_an_absolute_resume_transcript() {
        let error = pi_chat_passthrough_args(Some("relative/session.jsonl"), None).unwrap_err();
        assert!(error.to_string().contains("absolute Pi transcript path"));

        let args =
            pi_chat_passthrough_args(Some("/tmp/session.jsonl"), Some("Chat title")).unwrap();
        assert_eq!(
            args,
            vec!["--name", "Chat title", "--session", "/tmp/session.jsonl"]
        );
    }

    #[test]
    fn pi_sdk_host_relay_keeps_stdout_strict_jsonl() {
        let input = b"{\"type\":\"agent_start\"}\r\nnot-json\n{\"type\":\"agent_end\"}";
        let mut output = Vec::new();
        let had_protocol_error = relay_sdk_host_jsonl(&input[..], &mut output).unwrap();
        assert!(had_protocol_error);
        assert_eq!(
            String::from_utf8(output).unwrap(),
            "{\"type\":\"agent_start\"}\n{\"type\":\"agent_end\"}\n"
        );
    }

    #[cfg(unix)]
    #[test]
    fn child_only_signal_maps_to_exit_code_without_parent_signal_replay() {
        use std::os::unix::process::ExitStatusExt;

        PENDING_PARENT_SIGNAL.store(0, Ordering::SeqCst);
        let status = std::process::ExitStatus::from_raw(libc::SIGTERM);
        assert_eq!(child_exit_code(&status), 128 + libc::SIGTERM);
        assert_eq!(pending_parent_signal(), None);
    }

    #[test]
    fn pi_chat_permission_gate_is_bounded_and_fail_closed() {
        let gate = pi_chat_permission_gate_source();
        assert!(gate.contains("read\", \"grep\", \"find\", \"ls"));
        assert!(gate.contains("input.length > 4000"));
        assert!(gate.contains("STARLING_PERMISSION_TIMEOUT_MS = 30000"));
        assert!(gate.contains("ctx.ui?.confirm"));
        assert!(gate.contains("approved = false"));
        assert!(gate.contains("block: true"));
        assert!(pi_chat_permission_gate_registration_source().contains("tool_call"));
    }

    #[test]
    fn pi_chat_disables_discovered_extensions_but_loads_starling_gate() {
        let mut args = Vec::new();
        append_pi_runtime_extension_args(&mut args, Path::new("/tmp/starling-pi-runtime.js"), true);
        assert_eq!(
            args,
            vec![
                "--no-extensions",
                "--extension",
                "/tmp/starling-pi-runtime.js"
            ]
        );

        let mut regular_run_args = Vec::new();
        append_pi_runtime_extension_args(
            &mut regular_run_args,
            Path::new("/tmp/starling-pi-runtime.js"),
            false,
        );
        assert_eq!(
            regular_run_args,
            vec!["--extension", "/tmp/starling-pi-runtime.js"]
        );
    }
}

fn append_pi_runtime_extension_args(
    args: &mut Vec<String>,
    extension_file: &Path,
    enforce_pi_permissions: bool,
) {
    if enforce_pi_permissions {
        args.push("--no-extensions".into());
    }
    args.push("--extension".into());
    args.push(extension_file.to_string_lossy().to_string());
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
    launch_project_path: Option<&str>,
) -> Result<PreparedLaunch> {
    prepare_launch_with_pi_permissions(
        provider,
        run_id,
        setting,
        passthrough_args,
        attach_hook,
        mcp_names,
        mcp_profile,
        no_mcp,
        launch_project_path,
        false,
    )
}

fn prepare_launch_with_pi_permissions(
    provider: RunProvider,
    run_id: &str,
    setting: Option<&str>,
    passthrough_args: &[String],
    attach_hook: bool,
    mcp_names: &[String],
    mcp_profile: Option<&str>,
    no_mcp: bool,
    launch_project_path: Option<&str>,
    enforce_pi_permissions: bool,
) -> Result<PreparedLaunch> {
    let mut passthrough_args = if provider == RunProvider::Pi {
        normalize_pi_passthrough_args(passthrough_args)?
    } else {
        passthrough_args.to_vec()
    };
    let mut args = Vec::new();
    let mut envs = Vec::new();
    let mut temp_dir = None;
    let mut cleanup_files = Vec::new();
    let mut hook_file = None;
    let mut session_id_hint = None;
    let mut session_project_hint = None;

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
                    .filter(|_| !has_claude_model_arg(&passthrough_args))
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
            if let Some(home) = codex_resume_home_from_args(&passthrough_args) {
                envs.push(("CODEX_HOME".into(), home.to_string_lossy().to_string()));
            } else if (attach_hook || setting.is_some())
                && !has_codex_profile_arg(&passthrough_args)
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
        RunProvider::Pi => {
            validate_pi_selector_combinations(&passthrough_args)?;
            if !no_mcp && (!mcp_names.is_empty() || mcp_profile.is_some()) {
                anyhow::bail!(
                    "Pi does not expose native MCP configuration; remove --mcp/--mcp-profile or pass --no-mcp"
                );
            }

            if let Some(profile) = setting {
                let path = default_pi_settings_dir().join(format!("{profile}.json"));
                ensure_file(&path, "Pi profile")?;
                args.extend(pi_profile_args(&path)?);
            }

            if pi_has_no_session_arg(&passthrough_args) {
                envs.push(("STARLING_PI_NO_SESSION".into(), "1".into()));
            } else {
                if attach_hook && pi_has_resume_picker_arg(&passthrough_args) {
                    anyhow::bail!(
                        "managed Pi runs cannot safely lock the interactive --resume picker; use `starling resume <session-id-or-path>` or run `pi --resume` directly"
                    );
                }
                if let Some(target) =
                    resolve_pi_session_target(&passthrough_args, launch_project_path)?
                {
                    if let Some(transcript_path) = target.transcript_path.as_deref() {
                        pin_pi_session_selector(&mut passthrough_args, transcript_path);
                    }
                    session_id_hint = Some(target.session_id);
                    session_project_hint = Some(target.project_path);
                } else if pi_has_continue_arg(&passthrough_args) {
                    // Pi's `-c` is dynamic. If no transcript exists yet, turn
                    // it into an explicitly-IDed new session so this launch is
                    // locked from before spawn instead of racing a later `-c`.
                    neutralize_pi_continue_selector(&mut passthrough_args);
                }
            }
            if session_id_hint.is_none() && pi_launch_needs_managed_id(&passthrough_args) {
                let session_id = uuid::Uuid::new_v4().to_string();
                args.push("--session-id".into());
                args.push(session_id.clone());
                session_id_hint = Some(session_id);
                session_project_hint = launch_project_path.map(normalize_project_path_str);
            }

            if attach_hook {
                let hook =
                    create_pi_runtime_extension_with_permissions(run_id, enforce_pi_permissions)?;
                // Chat RPC has no native terminal permission UI. Disable all
                // discovered user/project extensions so a custom tool cannot
                // shadow a read-only built-in name and bypass this gate.
                // Pi still loads the explicit Starling runtime extension.
                append_pi_runtime_extension_args(
                    &mut args,
                    &hook.extension_file,
                    enforce_pi_permissions,
                );
                envs.push((
                    "STARLING_PI_HOOK_FILE".into(),
                    hook.hook_file.to_string_lossy().to_string(),
                ));
                cleanup_files.push(hook.extension_file);
                hook_file = Some(hook.hook_file);
            }
            if let Some(session_id) = session_id_hint.as_deref() {
                envs.push(("STARLING_SESSION_ID".into(), session_id.to_string()));
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
        session_id_hint,
        session_project_hint,
    })
}

fn pi_profile_args(path: &Path) -> Result<Vec<String>> {
    let raw = std::fs::read_to_string(path)?;
    let value: Value = serde_json::from_str(&raw)?;
    let string_field = |primary: &str, alias: &str| {
        value
            .get(primary)
            .or_else(|| value.get(alias))
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(str::to_string)
    };
    let provider = string_field("defaultProvider", "provider");
    let model = string_field("defaultModel", "model");
    let thinking = string_field("defaultThinkingLevel", "thinking");
    if provider.is_some() && model.is_none() {
        anyhow::bail!(
            "Pi profile {} sets a provider but no model; add model/defaultModel",
            path.display()
        );
    }
    let mut args = Vec::new();
    if let Some(provider) = provider {
        args.extend(["--provider".into(), provider]);
    }
    if let Some(model) = model {
        args.extend(["--model".into(), model]);
    }
    if let Some(thinking) = thinking {
        args.extend(["--thinking".into(), thinking]);
    }
    Ok(args)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PiArgKind {
    Session,
    SessionId,
    SessionDir,
    Fork,
    Continue,
    Resume,
    NoSession,
    Other,
}

#[derive(Debug, Clone, Copy)]
enum PiArgValueSource {
    Next(usize),
    Inline,
}

#[derive(Debug, Clone, Copy)]
struct PiArgSpan {
    kind: PiArgKind,
    start: usize,
    end: usize,
    value: Option<PiArgValueSource>,
}

#[derive(Debug)]
struct PiParsedArgs<'a> {
    args: &'a [String],
    spans: Vec<PiArgSpan>,
}

impl<'a> PiParsedArgs<'a> {
    /// Scan Pi's argv exactly once and record which option owns each token.
    /// Native Pi value options consume the next token even when it looks like
    /// another flag. Unknown/optional options use Pi's more selective rules.
    fn parse(args: &'a [String]) -> Self {
        let mut spans = Vec::with_capacity(args.len());
        let mut index = 0;
        while index < args.len() {
            let arg = args[index].as_str();

            if let Some(kind) = pi_inline_session_arg_kind(arg) {
                spans.push(PiArgSpan {
                    kind,
                    start: index,
                    end: index + 1,
                    value: Some(PiArgValueSource::Inline),
                });
                index += 1;
                continue;
            }

            if let Some(kind) = pi_required_value_arg_kind(arg) {
                let value_index = index + 1;
                let has_value = value_index < args.len();
                spans.push(PiArgSpan {
                    kind,
                    start: index,
                    end: index + 1 + usize::from(has_value),
                    value: has_value.then_some(PiArgValueSource::Next(value_index)),
                });
                index += 1 + usize::from(has_value);
                continue;
            }

            let kind = match arg {
                "--continue" | "-c" => PiArgKind::Continue,
                "--resume" | "-r" => PiArgKind::Resume,
                "--no-session" => PiArgKind::NoSession,
                _ => PiArgKind::Other,
            };
            let next = args.get(index + 1).map(String::as_str);
            let consumes_optional_value = match arg {
                "--print" | "-p" => next
                    .map(|value| {
                        !value.starts_with('@')
                            && (!value.starts_with('-') || value.starts_with("---"))
                    })
                    .unwrap_or(false),
                "--list-models" => next
                    .map(|value| !value.starts_with('-') && !value.starts_with('@'))
                    .unwrap_or(false),
                _ if pi_native_boolean_arg(arg) => false,
                _ if arg.starts_with("--") && !arg.contains('=') => next
                    .map(|value| !value.starts_with('-') && !value.starts_with('@'))
                    .unwrap_or(false),
                _ => false,
            };
            spans.push(PiArgSpan {
                kind,
                start: index,
                end: index + 1 + usize::from(consumes_optional_value),
                value: consumes_optional_value.then_some(PiArgValueSource::Next(index + 1)),
            });
            index += 1 + usize::from(consumes_optional_value);
        }
        Self { args, spans }
    }

    fn span_value(&self, span: &PiArgSpan) -> Option<&'a str> {
        match span.value? {
            PiArgValueSource::Next(index) => self.args.get(index).map(String::as_str),
            PiArgValueSource::Inline => self.args[span.start]
                .split_once('=')
                .map(|(_, value)| value),
        }
    }

    /// Pi overwrites singular value options as it scans, so the last
    /// occurrence that actually owns a value is effective. A final missing
    /// value does not clear an earlier assignment, while an owned empty token
    /// does.
    fn value(&self, kind: PiArgKind) -> Option<&'a str> {
        self.spans
            .iter()
            .rev()
            .find_map(|span| (span.kind == kind).then(|| self.span_value(span)).flatten())
    }

    fn has(&self, kind: PiArgKind) -> bool {
        self.spans.iter().any(|span| span.kind == kind)
    }
}

fn pi_inline_session_arg_kind(arg: &str) -> Option<PiArgKind> {
    if arg.starts_with("--session-id=") {
        Some(PiArgKind::SessionId)
    } else if arg.starts_with("--session-dir=") {
        Some(PiArgKind::SessionDir)
    } else if arg.starts_with("--session=") {
        Some(PiArgKind::Session)
    } else {
        None
    }
}

fn pi_required_value_arg_kind(arg: &str) -> Option<PiArgKind> {
    Some(match arg {
        "--session" => PiArgKind::Session,
        "--session-id" => PiArgKind::SessionId,
        "--session-dir" => PiArgKind::SessionDir,
        "--fork" => PiArgKind::Fork,
        // Keep this list aligned with Pi's native parseArgs(). Each of these
        // consumes argv[i + 1] without checking whether it starts with '-'.
        "--mode"
        | "--provider"
        | "--model"
        | "--api-key"
        | "--system-prompt"
        | "--append-system-prompt"
        | "--name"
        | "-n"
        | "--models"
        | "--tools"
        | "-t"
        | "--exclude-tools"
        | "-xt"
        | "--thinking"
        | "--export"
        | "--extension"
        | "-e"
        | "--skill"
        | "--prompt-template"
        | "--theme" => PiArgKind::Other,
        _ => return None,
    })
}

fn pi_native_boolean_arg(arg: &str) -> bool {
    matches!(
        arg,
        "--help"
            | "-h"
            | "--version"
            | "-v"
            | "--continue"
            | "-c"
            | "--resume"
            | "-r"
            | "--no-session"
            | "--no-tools"
            | "-nt"
            | "--no-builtin-tools"
            | "-nbt"
            | "--no-extensions"
            | "-ne"
            | "--no-skills"
            | "-ns"
            | "--no-prompt-templates"
            | "-np"
            | "--no-themes"
            | "--no-context-files"
            | "-nc"
            | "--verbose"
            | "--approve"
            | "-a"
            | "--no-approve"
            | "-na"
            | "--offline"
    )
}

fn pi_arg_kind(flag: &str) -> Option<PiArgKind> {
    Some(match flag {
        "--session" => PiArgKind::Session,
        "--session-id" => PiArgKind::SessionId,
        "--session-dir" => PiArgKind::SessionDir,
        "--fork" => PiArgKind::Fork,
        _ => return None,
    })
}

fn pi_arg_value(args: &[String], flag: &str) -> Option<String> {
    let kind = pi_arg_kind(flag)?;
    PiParsedArgs::parse(args).value(kind).map(str::to_string)
}

fn normalize_pi_passthrough_args(args: &[String]) -> Result<Vec<String>> {
    let mut normalized = Vec::with_capacity(args.len());
    let parsed = PiParsedArgs::parse(args);
    for span in &parsed.spans {
        if matches!(span.value, Some(PiArgValueSource::Inline)) {
            let flag = match span.kind {
                PiArgKind::Session => "--session",
                PiArgKind::SessionId => "--session-id",
                PiArgKind::SessionDir => "--session-dir",
                _ => unreachable!("only managed Pi value flags support inline normalization"),
            };
            let value = parsed.span_value(span).unwrap_or_default();
            if value.is_empty() {
                anyhow::bail!("Pi argument '{flag}' requires a value");
            }
            normalized.push(flag.to_string());
            normalized.push(value.to_string());
        } else {
            normalized.extend(args[span.start..span.end].iter().cloned());
        }
    }
    Ok(normalized)
}

fn validate_pi_session_id_value(session_id: &str) -> Result<()> {
    let bytes = session_id.as_bytes();
    let valid_edge = |byte: u8| byte.is_ascii_alphanumeric();
    let valid = bytes.first().copied().map(valid_edge).unwrap_or(false)
        && bytes.last().copied().map(valid_edge).unwrap_or(false)
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'));
    if !valid {
        anyhow::bail!(
            "Session id must be non-empty, contain only alphanumeric characters, '-', '_', and '.', and start and end with an alphanumeric character"
        );
    }
    Ok(())
}

fn validate_pi_selector_combinations(args: &[String]) -> Result<()> {
    if pi_truthy_arg_value(args, "--fork").is_some() {
        let mut conflicts = Vec::new();
        if pi_truthy_arg_value(args, "--session").is_some() {
            conflicts.push("--session");
        }
        if pi_has_continue_arg(args) {
            conflicts.push("--continue");
        }
        if pi_has_resume_picker_arg(args) {
            conflicts.push("--resume");
        }
        if pi_has_no_session_arg(args) {
            conflicts.push("--no-session");
        }
        if !conflicts.is_empty() {
            anyhow::bail!("--fork cannot be combined with {}", conflicts.join(", "));
        }
    }

    if let Some(session_id) = pi_arg_value(args, "--session-id") {
        let mut conflicts = Vec::new();
        if pi_truthy_arg_value(args, "--session").is_some() {
            conflicts.push("--session");
        }
        if pi_has_continue_arg(args) {
            conflicts.push("--continue");
        }
        if pi_has_resume_picker_arg(args) {
            conflicts.push("--resume");
        }
        if !conflicts.is_empty() {
            anyhow::bail!(
                "--session-id cannot be combined with {}",
                conflicts.join(", ")
            );
        }
        validate_pi_session_id_value(&session_id)?;
    }
    Ok(())
}

#[derive(Debug)]
struct PiSessionTarget {
    session_id: String,
    project_path: String,
    transcript_path: Option<String>,
}

#[derive(Debug)]
struct PiLaunchSessionInfo {
    session_id: String,
    project_path: String,
    file_path: PathBuf,
    file_mtime_ms: i64,
    logical_modified_ms: i64,
}

fn pi_file_mtime_ms(path: &Path) -> Option<i64> {
    let modified = std::fs::metadata(path).ok()?.modified().ok()?;
    Some(match modified.duration_since(UNIX_EPOCH) {
        Ok(elapsed) => elapsed.as_millis().min(i64::MAX as u128) as i64,
        Err(error) => -(error.duration().as_millis().min(i64::MAX as u128) as i64),
    })
}

fn pi_iso_timestamp_ms(value: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|timestamp| timestamp.timestamp_millis())
}

fn pi_json_timestamp_ms(value: &Value) -> Option<i64> {
    let value = value.as_f64()?;
    if !value.is_finite() {
        return None;
    }
    Some(value.clamp(i64::MIN as f64, i64::MAX as f64) as i64)
}

/// Parse the same fields and logical activity timestamp used by Pi's
/// `buildSessionInfo()`. The first successfully decoded JSON entry must be the
/// session header; malformed and blank physical lines before it are ignored.
fn read_pi_launch_session_info(path: &Path) -> Option<PiLaunchSessionInfo> {
    let file_mtime_ms = pi_file_mtime_ms(path)?;
    let file = std::fs::File::open(path).ok()?;
    let mut reader = BufReader::new(file);
    let mut session_id: Option<String> = None;
    let mut project_path = String::new();
    let mut header_timestamp_ms = None;
    let mut last_activity_ms: Option<i64> = None;

    loop {
        let mut physical_line = Vec::new();
        let bytes_read = reader.read_until(b'\n', &mut physical_line).ok()?;
        if bytes_read == 0 {
            break;
        }
        let line = String::from_utf8_lossy(&physical_line);
        let Ok(entry) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };

        if session_id.is_none() {
            if entry.get("type").and_then(Value::as_str) != Some("session") {
                return None;
            }
            let id = entry.get("id").and_then(Value::as_str)?;
            session_id = Some(id.to_string());
            project_path = entry
                .get("cwd")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            header_timestamp_ms = entry
                .get("timestamp")
                .and_then(Value::as_str)
                .and_then(pi_iso_timestamp_ms);
            continue;
        }

        if entry.get("type").and_then(Value::as_str) != Some("message") {
            continue;
        }
        let Some(message) = entry.get("message").and_then(Value::as_object) else {
            continue;
        };
        let role = message.get("role").and_then(Value::as_str);
        if !matches!(role, Some("user" | "assistant")) || !message.contains_key("content") {
            continue;
        }
        let activity_ms = message
            .get("timestamp")
            .and_then(pi_json_timestamp_ms)
            .or_else(|| {
                entry
                    .get("timestamp")
                    .and_then(Value::as_str)
                    .and_then(pi_iso_timestamp_ms)
            });
        if let Some(activity_ms) = activity_ms {
            last_activity_ms = Some(last_activity_ms.unwrap_or(0).max(activity_ms));
        }
    }

    let session_id = session_id?;
    let logical_modified_ms = last_activity_ms
        .filter(|timestamp| *timestamp > 0)
        .or(header_timestamp_ms)
        .unwrap_or(file_mtime_ms);
    Some(PiLaunchSessionInfo {
        session_id,
        project_path,
        file_path: path.to_path_buf(),
        file_mtime_ms,
        logical_modified_ms,
    })
}

fn pi_direct_session_infos(dir: &Path) -> Vec<PiLaunchSessionInfo> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter(|entry| {
            entry
                .file_name()
                .to_str()
                .map(|name| name.ends_with(".jsonl"))
                .unwrap_or(false)
        })
        .filter_map(|entry| read_pi_launch_session_info(&entry.path()))
        .collect()
}

const PI_MAX_SESSION_HEADER_SCAN_BYTES: usize = 1024 * 1024;

fn read_pi_session_header_for_continue(path: &Path) -> Option<(String, String)> {
    let file = std::fs::File::open(path).ok()?;
    let mut reader = BufReader::new(file).take((PI_MAX_SESSION_HEADER_SCAN_BYTES + 1) as u64);
    let mut scanned_bytes = 0usize;
    loop {
        let mut physical_line = Vec::new();
        let bytes_read = reader.read_until(b'\n', &mut physical_line).ok()?;
        if bytes_read == 0 {
            return None;
        }
        scanned_bytes = scanned_bytes.saturating_add(bytes_read);
        if scanned_bytes > PI_MAX_SESSION_HEADER_SCAN_BYTES {
            return None;
        }
        let line = String::from_utf8_lossy(&physical_line);
        let Ok(entry) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        if entry.get("type").and_then(Value::as_str) != Some("session") {
            return None;
        }
        let session_id = entry.get("id").and_then(Value::as_str)?.to_string();
        let project_path = entry
            .get("cwd")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        return Some((session_id, project_path));
    }
}

fn pi_direct_recent_session_infos(dir: &Path) -> Vec<PiLaunchSessionInfo> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter(|entry| {
            entry
                .file_name()
                .to_str()
                .map(|name| name.ends_with(".jsonl"))
                .unwrap_or(false)
        })
        .filter_map(|entry| {
            let file_path = entry.path();
            let file_mtime_ms = pi_file_mtime_ms(&file_path)?;
            let (session_id, project_path) = read_pi_session_header_for_continue(&file_path)?;
            Some(PiLaunchSessionInfo {
                session_id,
                project_path,
                file_path,
                file_mtime_ms,
                logical_modified_ms: file_mtime_ms,
            })
        })
        .collect()
}

fn sort_pi_sessions_by_logical_modified(sessions: &mut [PiLaunchSessionInfo]) {
    sessions.sort_by(|left, right| right.logical_modified_ms.cmp(&left.logical_modified_ms));
}

fn resolve_pi_path_lexically(input: &str, base: &Path) -> PathBuf {
    let expanded = pi_node_compatible_path(&normalize_pi_path_input(input));
    let base = pi_node_compatible_path(base);
    let absolute = if expanded.is_absolute() {
        expanded
    } else {
        base.join(expanded)
    };
    let mut normalized = PathBuf::new();
    for component in absolute.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                normalized.pop();
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    normalized
}

fn pi_session_cwd_matches(session_cwd: &str, launch_project: &Path) -> bool {
    !session_cwd.is_empty()
        && resolve_pi_path_lexically(session_cwd, launch_project)
            == resolve_pi_path_lexically(&launch_project.to_string_lossy(), launch_project)
}

fn pi_local_session_infos(
    layout: &PiLaunchSessionLayout,
    launch_project: &Path,
) -> Vec<PiLaunchSessionInfo> {
    let mut sessions = pi_direct_session_infos(&layout.local_dir);
    if layout.filter_local_cwd {
        sessions.retain(|session| pi_session_cwd_matches(&session.project_path, launch_project));
    }
    sort_pi_sessions_by_logical_modified(&mut sessions);
    sessions
}

fn pi_all_session_infos(layout: &PiLaunchSessionLayout) -> Vec<PiLaunchSessionInfo> {
    let mut sessions = if layout.configured {
        pi_direct_session_infos(&layout.session_root)
    } else {
        let Ok(entries) = std::fs::read_dir(&layout.session_root) else {
            return Vec::new();
        };
        entries
            .flatten()
            .filter(|entry| entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false))
            .flat_map(|entry| pi_direct_session_infos(&entry.path()))
            .collect()
    };
    sort_pi_sessions_by_logical_modified(&mut sessions);
    sessions
}

fn pi_exact_or_prefix<'a>(
    sessions: &'a [PiLaunchSessionInfo],
    selector: &str,
) -> Option<&'a PiLaunchSessionInfo> {
    sessions
        .iter()
        .find(|session| session.session_id == selector)
        .or_else(|| {
            sessions
                .iter()
                .find(|session| session.session_id.starts_with(selector))
        })
}

/// Pi's `continueRecent()` only validates direct-file headers and then sorts by
/// filesystem mtime. It deliberately does not use the logical message activity
/// ordering used by `list()` and `listAll()`.
fn pi_most_recent_session(
    layout: &PiLaunchSessionLayout,
    launch_project: &Path,
) -> Option<PiLaunchSessionInfo> {
    let mut sessions = pi_direct_recent_session_infos(&layout.local_dir);
    if layout.filter_local_cwd {
        sessions.retain(|session| pi_session_cwd_matches(&session.project_path, launch_project));
    }
    sessions.sort_by(|left, right| right.file_mtime_ms.cmp(&left.file_mtime_ms));
    sessions.into_iter().next()
}

fn pi_truthy_arg_value(args: &[String], flag: &str) -> Option<String> {
    pi_arg_value(args, flag).filter(|value| !value.is_empty())
}

fn pi_effective_open_project_path(session_cwd: &str, launch_project: &str) -> String {
    if session_cwd.is_empty() {
        return launch_project.to_string();
    }
    let resolved = resolve_pi_path_lexically(session_cwd, Path::new(launch_project));
    normalize_project_path(&resolved)
}

fn pi_continue_target(
    layout: &PiLaunchSessionLayout,
    launch_project: &str,
) -> Option<PiSessionTarget> {
    let meta = pi_most_recent_session(layout, Path::new(launch_project))?;
    Some(PiSessionTarget {
        session_id: meta.session_id,
        // Starling pins -c to --session <absolute path>. The spawned Pi thus
        // goes through SessionManager.open(), whose runtime cwd comes from the
        // transcript header rather than continueRecent()'s launch cwd.
        project_path: pi_effective_open_project_path(&meta.project_path, launch_project),
        transcript_path: Some(canonical_transcript_path(&meta.file_path.to_string_lossy())),
    })
}

fn pi_selector_looks_like_path(selector: &str) -> bool {
    selector.contains('/') || selector.contains('\\') || selector.ends_with(".jsonl")
}

fn resolve_pi_session_target(
    args: &[String],
    launch_project_path: Option<&str>,
) -> Result<Option<PiSessionTarget>> {
    let launch_project = launch_project_path
        .map(normalize_project_path_str)
        .or_else(|| {
            std::env::current_dir()
                .ok()
                .map(|path| normalize_project_path(&path))
        })
        .unwrap_or_default();

    // `createSessionManager()` handles --fork before every other persistent
    // selector. Its optional --session-id names the new fork, not the source.
    if pi_truthy_arg_value(args, "--fork").is_some() {
        return Ok(
            pi_arg_value(args, "--session-id").map(|session_id| PiSessionTarget {
                session_id,
                project_path: launch_project,
                transcript_path: None,
            }),
        );
    }

    // Pi treats an empty --session value as false and proceeds to the next
    // selector branch. Repeated value options are last-wins (pi_arg_value).
    if let Some(selector) = pi_truthy_arg_value(args, "--session") {
        let selector_path = resolve_pi_launch_path(&selector, &launch_project);
        if pi_selector_looks_like_path(&selector) {
            if !selector_path.exists() {
                anyhow::bail!(
                    "managed Pi runs cannot initialize a new explicit transcript path before acquiring its writer lock: {}; create it once with `pi --session {}` and then resume it with Starling",
                    selector_path.display(),
                    selector_path.display()
                );
            }
            if !selector_path.is_file() {
                anyhow::bail!(
                    "Pi session transcript is not a file: {}",
                    selector_path.display()
                );
            }
            if std::fs::metadata(&selector_path)
                .map(|metadata| metadata.len() == 0)
                .unwrap_or(false)
            {
                anyhow::bail!(
                    "managed Pi runs cannot initialize an empty explicit transcript before acquiring its writer lock: {}; initialize it once with `pi --session {}` and then resume it with Starling",
                    selector_path.display(),
                    selector_path.display()
                );
            }
            let target =
                find_pi_session_by_path(&selector_path.to_string_lossy()).ok_or_else(|| {
                    anyhow::anyhow!(
                        "{} is not a valid Pi session transcript",
                        selector_path.display()
                    )
                })?;
            return Ok(Some(PiSessionTarget {
                session_id: target.session_id,
                project_path: pi_effective_open_project_path(&target.project_path, &launch_project),
                transcript_path: Some(canonical_transcript_path(&target.file_path)),
            }));
        }

        // Mirror Pi's effective SessionManager.list/listAll directories,
        // logical-activity ordering, and exact-then-prefix selection. Global
        // Starling discovery cannot see every project-local or one-shot
        // --session-dir.
        let cli_session_dir = pi_arg_value(args, "--session-dir");
        let launch_project_path = Path::new(&launch_project);
        let layout = resolve_pi_session_layout_for_launch(
            Path::new(&launch_project),
            cli_session_dir.as_deref(),
        );
        let local = pi_local_session_infos(&layout, launch_project_path);
        if let Some(target) = pi_exact_or_prefix(&local, &selector) {
            return Ok(Some(PiSessionTarget {
                session_id: target.session_id.clone(),
                project_path: pi_effective_open_project_path(&target.project_path, &launch_project),
                transcript_path: Some(canonical_transcript_path(
                    &target.file_path.to_string_lossy(),
                )),
            }));
        }
        let all_sessions = pi_all_session_infos(&layout);
        if let Some(target) = pi_exact_or_prefix(&all_sessions, &selector) {
            anyhow::bail!(
                "managed Pi run cannot predict whether cross-project selector '{selector}' ({}) will be opened or forked; use an absolute transcript path",
                target.file_path.display()
            );
        }
        anyhow::bail!("Pi session not found: {selector}");
    }

    // The interactive picker precedes --continue and --session-id. Managed
    // launches reject it before this resolver; retaining the branch keeps
    // non-spawning unit/profile preparation aligned with Pi as well.
    if pi_has_resume_picker_arg(args) {
        return Ok(None);
    }

    if pi_has_continue_arg(args) {
        let cli_session_dir = pi_arg_value(args, "--session-dir");
        let layout = resolve_pi_session_layout_for_launch(
            Path::new(&launch_project),
            cli_session_dir.as_deref(),
        );
        if let Some(target) = pi_continue_target(&layout, &launch_project) {
            return Ok(Some(target));
        }
        return Ok(None);
    }

    if let Some(session_id) = pi_arg_value(args, "--session-id") {
        if !session_id.is_empty() {
            let cli_session_dir = pi_arg_value(args, "--session-dir");
            let layout = resolve_pi_session_layout_for_launch(
                Path::new(&launch_project),
                cli_session_dir.as_deref(),
            );
            let local = pi_local_session_infos(&layout, Path::new(&launch_project));
            if let Some(target) = local.iter().find(|target| target.session_id == session_id) {
                return Ok(Some(PiSessionTarget {
                    session_id: target.session_id.clone(),
                    project_path: pi_effective_open_project_path(
                        &target.project_path,
                        &launch_project,
                    ),
                    transcript_path: Some(canonical_transcript_path(
                        &target.file_path.to_string_lossy(),
                    )),
                }));
            }
        }
        return Ok(Some(PiSessionTarget {
            session_id,
            project_path: launch_project,
            transcript_path: None,
        }));
    }

    Ok(None)
}

fn canonical_transcript_path(path: &str) -> String {
    let canonical = std::fs::canonicalize(path).unwrap_or_else(|_| PathBuf::from(path));
    pi_node_compatible_path(&canonical)
        .to_string_lossy()
        .to_string()
}

/// Replace dynamic Pi selectors with the exact transcript Starling locked.
fn pin_pi_session_selector(args: &mut Vec<String>, transcript_path: &str) {
    let parsed = PiParsedArgs::parse(args);
    let mut pinned = Vec::with_capacity(args.len() + 2);
    for span in &parsed.spans {
        if matches!(
            span.kind,
            PiArgKind::Session | PiArgKind::SessionId | PiArgKind::Continue
        ) {
            // Replace each real selector in place. Its flag-shaped replacement
            // remains a barrier for a preceding unknown option, and its owned
            // path keeps a following message separate. Replacing every
            // assignment also preserves Pi's last-wins behavior while making
            // every surviving selector point at the transcript we locked.
            pinned.push("--session".into());
            pinned.push(transcript_path.into());
            continue;
        }
        pinned.extend(args[span.start..span.end].iter().cloned());
    }
    *args = pinned;
}

fn neutralize_pi_continue_selector(args: &mut Vec<String>) {
    let parsed = PiParsedArgs::parse(args);
    let mut filtered = Vec::with_capacity(args.len() + 1);
    for span in &parsed.spans {
        if span.kind == PiArgKind::Continue {
            // An empty session assignment is falsey in Pi, so the managed
            // --session-id still creates the preallocated session. Keeping a
            // two-token placeholder at the original position prevents an
            // unknown flag before `-c` from consuming a message after it.
            filtered.push("--session".into());
            filtered.push(String::new());
        } else {
            filtered.extend(args[span.start..span.end].iter().cloned());
        }
    }
    *args = filtered;
}

fn pi_launch_needs_managed_id(args: &[String]) -> bool {
    let parsed = PiParsedArgs::parse(args);
    if parsed
        .value(PiArgKind::Fork)
        .filter(|value| !value.is_empty())
        .is_some()
    {
        return parsed.value(PiArgKind::SessionId).is_none();
    }
    if parsed.value(PiArgKind::SessionId).is_some() {
        return false;
    }
    // A managed --continue with no existing transcript is rewritten to an
    // empty --session barrier before reaching this helper. It still needs a
    // stable ID so Starling can preserve the requested continuation contract.
    // Plain launches have no selector at all: let Pi create their ID natively.
    parsed.value(PiArgKind::Session) == Some("")
}

fn pi_has_no_session_arg(args: &[String]) -> bool {
    PiParsedArgs::parse(args).has(PiArgKind::NoSession)
}

fn pi_has_continue_arg(args: &[String]) -> bool {
    PiParsedArgs::parse(args).has(PiArgKind::Continue)
}

fn pi_has_resume_picker_arg(args: &[String]) -> bool {
    PiParsedArgs::parse(args).has(PiArgKind::Resume)
}

fn resolve_pi_launch_path(value: &str, launch_project: &str) -> PathBuf {
    let path = normalize_pi_path_input(value);
    if path.is_absolute() {
        path
    } else if launch_project.is_empty() {
        path
    } else {
        Path::new(launch_project).join(path)
    }
}

fn normalize_project_path_str(path: &str) -> String {
    normalize_project_path(Path::new(path))
}

fn normalize_project_path(path: &Path) -> String {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map(|cwd| cwd.join(path))
            .unwrap_or_else(|_| path.to_path_buf())
    };
    if let Ok(canonical) = std::fs::canonicalize(&absolute) {
        return canonical.to_string_lossy().to_string();
    }

    let mut normalized = PathBuf::new();
    for component in absolute.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                normalized.pop();
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    normalized.to_string_lossy().to_string()
}

pub(crate) struct PiRuntimeExtension {
    pub(crate) extension_file: PathBuf,
    pub(crate) hook_file: PathBuf,
}

fn pi_session_switch_guard_source() -> &'static str {
    r#"function blockManagedSessionChange(_event, ctx) {
  ctx.ui?.notify?.(
    "Starling has locked this Pi transcript. Exit Pi, then use `starling resume` or a new `starling run pi` instead of switching sessions in place.",
    "warning",
  );
  return { cancel: true };
}"#
}

fn pi_session_switch_guard_registration_source() -> &'static str {
    r#"  pi.on("session_before_switch", blockManagedSessionChange);
  pi.on("session_before_fork", blockManagedSessionChange);"#
}

fn pi_chat_permission_gate_source() -> &'static str {
    r#"// Pi-style risk-based permission gate: only intercept genuinely destructive
// operations, auto-allow everything else. Mirrors pi's official
// examples/extensions/permission-gate.ts and protected-paths.ts.
const STARLING_PERMISSION_TIMEOUT_MS = 30000;
const STARLING_DANGEROUS_BASH_PATTERNS = [
  /\brm\b\s+(-[a-z]*r|--recursive)/i,
  /\brm\b\s+(-[a-z]*f|--force)\b/i,
  /\bsudo\b/i,
  /\b(chmod|chown)\b[^|\n]*\b777\b/i,
  /\bgit\b\s+push\b.*--force(?!-)/i,
  /\bdd\b[^|\n]*\bof=/i,
  /\bmkfs\b/i,
  /\b(shutdown|reboot|halt|poweroff)\b/i,
];
const STARLING_PROTECTED_WRITE_PATHS = [".env", ".git/", "node_modules/"];

async function enforceStarlingToolPermission(event, ctx) {
  const toolName = String(event?.toolName ?? "").trim().toLowerCase();
  const input = (event && typeof event.input === "object" && event.input) ? event.input : {};

  if (toolName === "bash") {
    const command = String(input.command ?? "");
    if (STARLING_DANGEROUS_BASH_PATTERNS.some((p) => p.test(command))) {
      let approved = false;
      try {
        approved = (await ctx.ui?.confirm?.(
          `⚠️ Dangerous command:\n\n  ${command}\n\nAllow?`,
          command,
          { timeout: STARLING_PERMISSION_TIMEOUT_MS },
        )) === true;
      } catch (_) {
        approved = false;
      }
      if (!approved) {
        return { block: true, reason: `Starling blocked destructive bash: ${command}` };
      }
    }
    return;
  }

  if (toolName === "write" || toolName === "edit") {
    const target = String(input.path ?? "");
    if (STARLING_PROTECTED_WRITE_PATHS.some((p) => target.includes(p))) {
      ctx.ui?.notify?.(`Blocked write to protected path: ${target}`, "warning");
      return { block: true, reason: `Path "${target}" is protected by Starling` };
    }
  }
}"#
}

fn pi_chat_permission_gate_registration_source() -> &'static str {
    r#"  pi.on("tool_call", enforceStarlingToolPermission);"#
}

pub(crate) fn create_pi_runtime_extension(run_id: &str) -> Result<PiRuntimeExtension> {
    create_pi_runtime_extension_with_permissions(run_id, false)
}

fn create_pi_runtime_extension_with_permissions(
    run_id: &str,
    enforce_permissions: bool,
) -> Result<PiRuntimeExtension> {
    let dir = default_starling_home().join("run-hooks");
    std::fs::create_dir_all(&dir)?;
    let extension_file = dir.join(format!("{run_id}.pi-extension.mjs"));
    let hook_file = dir.join(format!("{run_id}.pi.jsonl"));
    let starling_exe = std::env::current_exe()?.to_string_lossy().to_string();
    let template = r#"import { spawnSync } from "node:child_process";

const STARLING_EXE = __STARLING_EXE__;
const RUN_ID = __RUN_ID__;
const HOOK_FILE = __HOOK_FILE__;

__SESSION_GUARD__
__PERMISSION_GATE__

function emit(eventName, event, ctx) {
  try {
    const usage = ctx.getContextUsage?.();
    const percent = typeof usage?.percent === "number" ? usage.percent : undefined;
    const payload = {
      session_id: ctx.sessionManager?.getSessionId?.(),
      transcript_path: ctx.sessionManager?.getSessionFile?.(),
      cwd: ctx.cwd,
      model: ctx.model?.id,
      provider: ctx.model?.provider,
      prompt: event?.prompt,
      tool_name: event?.toolName,
      message: event?.isError ? "tool execution failed" : undefined,
      context_window: percent === undefined ? undefined : {
        used_percentage: percent,
        remaining_percentage: Math.max(0, 100 - percent),
      },
    };
    spawnSync(STARLING_EXE, ["top", "hook", "--provider", "pi", "--event", eventName,
      "--run-id", RUN_ID, "--hook-file", HOOK_FILE, "--pid", String(process.pid)], {
      input: JSON.stringify(payload),
      stdio: ["pipe", "ignore", "ignore"],
      timeout: 5000,
    });
  } catch (_) {}
}

export default function (pi) {
  // The inherited OS lock protects exactly one transcript. Prevent Pi's
  // in-process /new, /resume, and /fork flows from changing that identity.
__SESSION_GUARD_REGISTRATIONS__
__PERMISSION_GATE_REGISTRATION__
  pi.on("session_start", (event, ctx) => emit("SessionStart", event, ctx));
  pi.on("before_agent_start", (event, ctx) => emit("UserPromptSubmit", event, ctx));
  pi.on("tool_execution_start", (event, ctx) => emit("PreToolUse", event, ctx));
  pi.on("tool_execution_end", (event, ctx) => emit(event?.isError ? "PostToolUseFailure" : "PostToolUse", event, ctx));
  pi.on("agent_end", (event, ctx) => {
    const failed = event?.messages?.some?.((message) => message?.stopReason === "error");
    emit(failed ? "StopFailure" : "Stop", event, ctx);
  });
  pi.on("session_shutdown", (event, ctx) => emit("SessionEnd", event, ctx));
}
"#;
    let rendered = template
        .replace("__STARLING_EXE__", &serde_json::to_string(&starling_exe)?)
        .replace("__RUN_ID__", &serde_json::to_string(run_id)?)
        .replace("__SESSION_GUARD__", pi_session_switch_guard_source())
        .replace(
            "__PERMISSION_GATE__",
            if enforce_permissions {
                pi_chat_permission_gate_source()
            } else {
                ""
            },
        )
        .replace(
            "__SESSION_GUARD_REGISTRATIONS__",
            pi_session_switch_guard_registration_source(),
        )
        .replace(
            "__PERMISSION_GATE_REGISTRATION__",
            if enforce_permissions {
                pi_chat_permission_gate_registration_source()
            } else {
                ""
            },
        )
        .replace(
            "__HOOK_FILE__",
            &serde_json::to_string(&hook_file.to_string_lossy().to_string())?,
        );
    std::fs::write(&extension_file, rendered)?;
    Ok(PiRuntimeExtension {
        extension_file,
        hook_file,
    })
}

fn ensure_pi_session_not_running(
    session_id: Option<&str>,
    project_path: Option<&str>,
) -> Result<()> {
    let Some(session_id) = session_id.map(str::trim).filter(|id| !id.is_empty()) else {
        return Ok(());
    };
    reconcile_stale_runs();
    let conflict = list_runs(None).into_iter().any(|run| {
        run.provider == RunProvider::Pi
            && run.status == RunStatus::Running
            && run.session_id.as_deref() == Some(session_id)
            && match (project_path, run.project_path.as_deref()) {
                (Some(project), Some(run_project)) => {
                    normalize_project_path_str(project) == normalize_project_path_str(run_project)
                }
                // If either side lacks cwd information, retain the conservative
                // global-ID guard instead of risking a duplicate transcript.
                _ => true,
            }
            && run
                .pid
                .map(crate::core::runs::is_pid_alive)
                .unwrap_or(false)
    });
    if conflict {
        anyhow::bail!("Pi session '{session_id}' is already open in a live Starling-managed run");
    }
    Ok(())
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
    patch_run(
        run_id,
        RunPatch {
            pid: Some(pid),
            ..Default::default()
        },
    );
}

fn update_run_session_id(run_id: &str, session_id: &str) {
    patch_run(
        run_id,
        RunPatch {
            session_id: Some(session_id.to_string()),
            ..Default::default()
        },
    );
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

// --- Signal handling ---
//
// `signal-hook`'s low-level handler only notifies a self-pipe. All allocation,
// locking, filesystem I/O, child signalling, and default-signal emulation run
// on the ordinary background thread below, outside signal-handler context.

static ACTIVE_CHILD_PID: AtomicU32 = AtomicU32::new(0);
static PENDING_PARENT_SIGNAL: once_cell::sync::Lazy<std::sync::Arc<AtomicUsize>> =
    once_cell::sync::Lazy::new(|| std::sync::Arc::new(AtomicUsize::new(0)));
static RUN_SIGNAL_CLEANUP_DONE: AtomicBool = AtomicBool::new(false);
static CHAT_SIGNAL_CLEANUP_DONE: AtomicBool = AtomicBool::new(false);

fn install_run_signal_handler(run_id: String, child_pid: u32) {
    ACTIVE_CHILD_PID.store(child_pid, Ordering::SeqCst);
    RUN_SIGNAL_CLEANUP_DONE.store(false, Ordering::SeqCst);
    install_signal_handler_inner(run_id, false);
}

fn install_chat_signal_handler(run_id: String, child_pid: u32) {
    ACTIVE_CHILD_PID.store(child_pid, Ordering::SeqCst);
    CHAT_SIGNAL_CLEANUP_DONE.store(false, Ordering::SeqCst);
    install_signal_handler_inner(run_id, true);
}

fn await_run_parent_signal_replay(prepared: &PreparedLaunch) {
    if pending_parent_signal().is_none() {
        return;
    }
    cleanup_launch_artifacts(prepared);
    RUN_SIGNAL_CLEANUP_DONE.store(true, Ordering::SeqCst);
    loop {
        std::thread::park();
    }
}

fn pending_parent_signal() -> Option<i32> {
    #[cfg(unix)]
    {
        let signal = PENDING_PARENT_SIGNAL.load(Ordering::SeqCst) as i32;
        return (signal > 0).then_some(signal);
    }
    #[cfg(not(unix))]
    {
        None
    }
}

#[cfg(unix)]
struct PendingSignalRegistrations(Vec<signal_hook::SigId>);

#[cfg(unix)]
impl Drop for PendingSignalRegistrations {
    fn drop(&mut self) {
        for id in self.0.drain(..) {
            signal_hook::low_level::unregister(id);
        }
    }
}

#[cfg(unix)]
fn register_pending_parent_signal_flags(
    signals: &[libc::c_int],
) -> std::io::Result<PendingSignalRegistrations> {
    let mut registrations = Vec::with_capacity(signals.len());
    for &signal in signals {
        match signal_hook::flag::register_usize(
            signal,
            std::sync::Arc::clone(&PENDING_PARENT_SIGNAL),
            signal as usize,
        ) {
            Ok(id) => registrations.push(id),
            Err(error) => {
                for id in registrations.drain(..) {
                    signal_hook::low_level::unregister(id);
                }
                return Err(error);
            }
        }
    }
    Ok(PendingSignalRegistrations(registrations))
}

fn install_signal_handler_inner(run_id: String, chat_child: bool) {
    #[cfg(unix)]
    {
        use signal_hook::consts::signal::{SIGHUP, SIGINT, SIGTERM};
        use signal_hook::iterator::Signals;

        const TERMINATION_SIGNALS: &[libc::c_int] = &[SIGINT, SIGTERM, SIGHUP];
        PENDING_PARENT_SIGNAL.store(0, Ordering::SeqCst);
        // These signal-hook actions perform only a SeqCst atomic store inside
        // signal context. Consequently the main thread can distinguish a
        // parent signal from a child-only signal before child.wait() returns.
        // Register them before the iterator so the pending value is visible
        // regardless of which registered action wakes first.
        let pending_registrations = match register_pending_parent_signal_flags(TERMINATION_SIGNALS)
        {
            Ok(registrations) => registrations,
            Err(error) => {
                eprintln!(
                    "{}: could not install parent signal flags: {}",
                    "warning".yellow(),
                    error
                );
                return;
            }
        };
        let mut signals = match Signals::new(TERMINATION_SIGNALS) {
            Ok(signals) => signals,
            Err(error) => {
                eprintln!(
                    "{}: could not install run signal listener: {}",
                    "warning".yellow(),
                    error
                );
                return;
            }
        };
        let thread_result = std::thread::Builder::new()
            .name("starling-run-signals".into())
            .spawn(move || {
                let _pending_registrations = pending_registrations;
                let sig = loop {
                    let pending = PENDING_PARENT_SIGNAL.load(Ordering::SeqCst) as i32;
                    if pending > 0 {
                        break pending;
                    }
                    if let Some(signal) = signals.pending().next() {
                        PENDING_PARENT_SIGNAL.store(signal as usize, Ordering::SeqCst);
                        break signal;
                    }
                    // The atomic flag is also a fallback on restricted
                    // environments where the iterator's self-pipe wakeup is
                    // unavailable inside signal context.
                    std::thread::park_timeout(std::time::Duration::from_millis(10));
                };
                let child_pid = ACTIVE_CHILD_PID.load(Ordering::SeqCst);
                if child_pid > 0 {
                    unsafe {
                        libc::kill(child_pid as libc::pid_t, sig);
                    }
                }
                mark_run_crashed(&run_id);
                // Give the main thread time to reap the child and remove its
                // generated runtime extension before terminating Starling.
                // Escalate an uncooperative child so it cannot survive its
                // wrapper. Chat retains its existing cleanup flag; ordinary
                // runs use the same ordering to avoid racing process::exit(0).
                let cleanup_done = if chat_child {
                    &CHAT_SIGNAL_CLEANUP_DONE
                } else {
                    &RUN_SIGNAL_CLEANUP_DONE
                };
                let started = std::time::Instant::now();
                let mut escalated = false;
                while !cleanup_done.load(Ordering::SeqCst) {
                    if !escalated && started.elapsed() >= std::time::Duration::from_secs(2) {
                        if child_pid > 0 && ACTIVE_CHILD_PID.load(Ordering::SeqCst) == child_pid {
                            unsafe {
                                libc::kill(child_pid as libc::pid_t, libc::SIGKILL);
                            }
                        }
                        escalated = true;
                    }
                    std::thread::park_timeout(std::time::Duration::from_millis(10));
                }
                // Restore and emulate the original disposition so callers see
                // termination by the same signal rather than a synthetic code.
                if let Err(error) = signal_hook::low_level::emulate_default_handler(sig) {
                    eprintln!(
                        "{}: could not restore signal {} disposition: {}",
                        "warning".yellow(),
                        sig,
                        error
                    );
                    std::process::exit(128 + sig);
                }
            });
        if let Err(error) = thread_result {
            eprintln!(
                "{}: could not start run signal listener: {}",
                "warning".yellow(),
                error
            );
        }
    }
    #[cfg(not(unix))]
    let _ = (run_id, chat_child);
}
