//! `starling run` — agent launch with run-record tracking.

use std::collections::BTreeMap;
use std::io::{BufRead, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
mod claude;
mod codex;
mod pi;

use claude::*;
use codex::*;
use pi::*;

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


fn chat_pi(cmd_args: &ChatCommand, session: Option<&str>) -> Result<()> {
    sweep_stale_launch_artifacts();
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
    sweep_stale_launch_artifacts();
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
            origin: "manual".to_string(),
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

    /// Canonicalize a fixture path the same way the launch pipeline reports
    /// it: Windows `canonicalize()` returns a `\\?\`-prefixed verbatim path,
    /// which the product strips for Pi/Node compatibility.
    fn canon(path: &Path) -> PathBuf {
        crate::constants::pi_node_compatible_path(&std::fs::canonicalize(path).unwrap())
    }

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
    #[test]
    fn claude_model_prefers_anthropic_model_over_tier_aliases() {
        let settings = serde_json::json!({
            "env": {
                "ANTHROPIC_MODEL": "kimi-k2",
                "ANTHROPIC_DEFAULT_SONNET_MODEL": "glm-5.2",
                "ANTHROPIC_DEFAULT_OPUS_MODEL": "glm-5.1"
            }
        });
        assert_eq!(
            claude_model_from_settings(&settings).as_deref(),
            Some("kimi-k2")
        );
    }

    #[test]
    fn sweep_deletes_stale_artifacts_and_keeps_live_runs() {
        let root = std::env::temp_dir().join(format!(
            "starling-sweep-test-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let starling_home = root.join("starling");
        let codex_home = root.join("codex");
        let run_id = "0198c0de-0000-4000-8000-000000000001";
        let live_run_id = "0198c0de-0000-4000-8000-000000000002";
        let stale = std::time::SystemTime::now() - std::time::Duration::from_secs(30 * 24 * 3600);

        let hooks = starling_home.join("run-hooks");
        std::fs::create_dir_all(&hooks).unwrap();
        for name in [format!("{run_id}.jsonl"), format!("{live_run_id}.settings.json")] {
            std::fs::write(hooks.join(&name), "{}").unwrap();
            set_mtime(&hooks.join(&name), stale);
        }
        std::fs::write(hooks.join("unrelated.txt"), "keep").unwrap();

        let run_home = starling_home.join("run-homes").join(format!("codex-{run_id}"));
        std::fs::create_dir_all(run_home.join("sessions")).unwrap();
        std::fs::write(run_home.join("config.toml"), "model = \"x\""
        ).unwrap();
        set_mtime(&run_home, stale);

        let profiles = codex_home;
        std::fs::create_dir_all(&profiles).unwrap();
        let profile_config = profiles.join(format!("starling-{run_id}.config.toml"));
        std::fs::write(&profile_config, "model = \"x\""
        ).unwrap();
        set_mtime(&profile_config, stale);
        let user_config = profiles.join("config.toml");
        std::fs::write(&user_config, "model = \"user\""
        ).unwrap();
        set_mtime(&user_config, stale);

        sweep_stale_launch_artifacts_in(
            &starling_home,
            &profiles,
            std::time::SystemTime::now() - std::time::Duration::from_secs(7 * 24 * 3600),
            &|id| id == live_run_id,
        );

        assert!(!hooks.join(format!("{run_id}.jsonl")).exists());
        assert!(hooks.join(format!("{live_run_id}.settings.json")).exists());
        assert!(hooks.join("unrelated.txt").exists());
        assert!(!run_home.join("config.toml").exists());
        assert!(!profile_config.exists());
        assert!(user_config.exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    fn set_mtime(path: &Path, when: std::time::SystemTime) {
        // Read-only handle: owner may set timestamps without write access, and
        // directories cannot be opened for writing at all.
        #[cfg(not(windows))]
        let file = std::fs::File::open(path).unwrap();
        // Windows SetFileTime needs FILE_WRITE_ATTRIBUTES access; the
        // FILE_FLAG_BACKUP_SEMANTICS flag is what lets the same open cover
        // directories (fixtures set mtimes on both files and dirs).
        #[cfg(windows)]
        let file = {
            use std::os::windows::fs::OpenOptionsExt;
            const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
            std::fs::OpenOptions::new()
                .write(true)
                .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
                .open(path)
                .unwrap()
        };
        file.set_times(std::fs::FileTimes::new().set_modified(when))
            .unwrap();
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
                canon(&session_file)
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
                canon(&sessions.join("2026-07-24T00-00-00-000Z_Continue_ID.jsonl"))
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
                canon(&transcript)
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
            canon(&transcript)
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
        let canonical = canon(&transcript);
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
            canon(&transcript)
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
            canon(&transcript)
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
            canon(&transcript)
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
            canon(&transcript)
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
        let target = crate::agents::pi::exact_or_prefix(&local, "MovedSession").expect("moved session");
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
            canon(&transcript)
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
                canon(&logically_new)
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
            canon(&direct)
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
            canon(&target_path)
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
            canon(&mtime_new)
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

        // An absolute path is platform-specific ("/tmp/…" is not absolute on
        // Windows), so build one from the platform temp dir.
        let session = std::env::temp_dir().join("session.jsonl");
        let session_arg = session.to_string_lossy().to_string();
        let args = pi_chat_passthrough_args(Some(session_arg.as_str()), Some("Chat title")).unwrap();
        assert_eq!(
            args,
            vec!["--name", "Chat title", "--session", session_arg.as_str()]
        );
    }

    #[test]
    fn pi_sdk_host_relay_keeps_stdout_strict_jsonl() {
        let input = format!(
            "{{\"type\":\"agent_start\"}}\r\n{{\"value\":\"{}\"}}\nnot-json\n{{\"type\":\"agent_end\"}}",
            "x".repeat(1024 * 1024),
        );
        let mut output = Vec::new();
        let had_protocol_error = relay_sdk_host_jsonl(input.as_bytes(), &mut output).unwrap();
        assert!(had_protocol_error);
        assert!(
            output.len() < 100,
            "oversized JSONL records must be discarded"
        );
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
    fn pi_chat_disables_discovered_extensions_and_enables_the_node_gate() {
        let mut args = Vec::new();
        append_pi_runtime_extension_args(&mut args, Path::new("/tmp/starling-pi-runtime.js"), true);
        assert_eq!(
            args,
            vec![
                "--no-extensions",
                "--starling-managed",
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
                if let Some(setting) = setting {
                    eprintln!(
                        "{}: --setting '{}' is ignored when resuming a session that lives in a per-run CODEX_HOME",
                        "warning".yellow(),
                        setting
                    );
                }
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
                if let Some(setting) = setting {
                    eprintln!(
                        "{}: --setting '{}' is merged as the base config; your own --profile argument still applies on top and wins conflicts",
                        "warning".yellow(),
                        setting
                    );
                }
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
                let hook = create_pi_runtime_extension(run_id)?;
                // Chat RPC has no native terminal permission UI. Disable all
                // discovered user/project extensions so a custom tool cannot
                // shadow a read-only built-in name and bypass the Node gate.
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


#[derive(Debug)]
struct PiSessionTarget {
    session_id: String,
    project_path: String,
    transcript_path: Option<String>,
}


pub(crate) struct PiRuntimeExtension {
    pub(crate) extension_file: PathBuf,
    pub(crate) hook_file: PathBuf,
}


pub(crate) fn create_pi_runtime_extension(run_id: &str) -> Result<PiRuntimeExtension> {
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
            "__SESSION_GUARD_REGISTRATIONS__",
            pi_session_switch_guard_registration_source(),
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

#[derive(Serialize)]
struct CodexNormalizedHookIdentity {
    event_name: String,
    #[serde(flatten)]
    group: CodexMatcherGroup,
}


const STARLING_MCP_INJECT_ENV: &str = "STARLING_MCP_INJECT";


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

/// Write a launch-artifact file with owner-only permissions. These files can
/// carry provider API keys (mcp.json, codex config.toml) and must not be
/// world-readable.
fn write_private_file(path: &Path, contents: &str) -> Result<()> {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)?;
        file.write_all(contents.as_bytes())?;
    }
    #[cfg(not(unix))]
    {
        std::fs::write(path, contents)?;
    }
    Ok(())
}

/// ponytail: best-effort startup sweep, no retention index. SIGKILLed or
/// rebooted-off runs leak hook files, run-homes (containing auth.json
/// copies), and codex profile configs into user dirs; on-demand cleanup only
/// runs on graceful exit. Upgrade path: a retention table in ~/.starling if
/// artifact volume ever matters.
const STALE_LAUNCH_ARTIFACT_MAX_AGE_SECS: u64 = 7 * 24 * 60 * 60;

fn sweep_stale_launch_artifacts() {
    let cutoff = std::time::SystemTime::now()
        .checked_sub(std::time::Duration::from_secs(STALE_LAUNCH_ARTIFACT_MAX_AGE_SECS))
        .unwrap_or(std::time::UNIX_EPOCH);
    sweep_stale_launch_artifacts_in(
        &default_starling_home(),
        &default_codex_home(),
        cutoff,
        &|run_id| {
            find_run(run_id)
                .map(|run| matches!(run.status, RunStatus::Running))
                .unwrap_or(false)
        },
    );
}

fn sweep_stale_launch_artifacts_in(
    starling_home: &Path,
    codex_home: &Path,
    cutoff: std::time::SystemTime,
    run_is_active: &dyn Fn(&str) -> bool,
) {
    sweep_dir_artifacts(&starling_home.join("run-hooks"), cutoff, run_is_active, hook_artifact_run_id);
    sweep_dir_artifacts(&starling_home.join("run-homes"), cutoff, run_is_active, run_home_run_id);
    sweep_dir_artifacts(codex_home, cutoff, run_is_active, codex_profile_config_run_id);
}

fn sweep_dir_artifacts(
    dir: &Path,
    cutoff: std::time::SystemTime,
    run_is_active: &dyn Fn(&str) -> bool,
    run_id_of: fn(&str) -> Option<String>,
) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Some(name) = entry.file_name().into_string().ok() else {
            continue;
        };
        let Some(run_id) = run_id_of(&name) else {
            continue;
        };
        if run_is_active(&run_id) {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        let stale = metadata
            .modified()
            .map(|mtime| mtime < cutoff)
            .unwrap_or(false);
        if !stale {
            continue;
        }
        if metadata.is_dir() {
            let _ = std::fs::remove_dir_all(entry.path());
        } else {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// `~/.starling/run-hooks/<run_id>.jsonl|.settings.json|.mcp.json`
fn hook_artifact_run_id(name: &str) -> Option<String> {
    let candidate = name.split('.').next()?;
    plausible_run_id(candidate).then(|| candidate.to_string())
}

/// `~/.starling/run-homes/codex-<run_id>/`
fn run_home_run_id(name: &str) -> Option<String> {
    let candidate = name.strip_prefix("codex-")?;
    plausible_run_id(candidate).then(|| candidate.to_string())
}

/// `~/.codex/starling-<run_id>.config.toml`
fn codex_profile_config_run_id(name: &str) -> Option<String> {
    let candidate = name
        .strip_prefix("starling-")?
        .strip_suffix(".config.toml")?;
    plausible_run_id(candidate).then(|| candidate.to_string())
}

fn plausible_run_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && bytes[8] == b'-'
        && bytes[13] == b'-'
        && bytes[18] == b'-'
        && bytes[23] == b'-'
        && bytes
            .iter()
            .all(|b| b.is_ascii_hexdigit() || *b == b'-')
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
