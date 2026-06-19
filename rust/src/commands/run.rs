//! `starling run` — agent launch with run-record tracking.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use anyhow::Result;
use colored::*;

use crate::cli::*;
use crate::constants::{
    default_claude_settings_dir, default_codex_home, default_codex_settings_dir,
    default_starling_home, now_iso,
};
use crate::core::catalog_resolver::{resolve_catalog_reference, CatalogResolution};
use crate::core::discovery::{find_sessions, Provider as DiscoveryProvider};
use crate::core::id::generate_bookmark_id;
use crate::core::process_map::map_process_tree_to_session_since;
use crate::core::runs::{
    create_run, finalize_run, find_run, list_runs, mark_run_crashed, remove_run, FinalizePatch,
    RunStatus,
};
use crate::core::store::{add_bookmark, find_bookmark, update_bookmark, BookmarkPatch};
use crate::types::{Bookmark, RunProvider, RunRecord, RunSource};

pub fn handle(cmd: RunCommand) -> Result<()> {
    match &cmd.command {
        RunSubcommand::Claude { args } => launch(RunProvider::Claude, "claude", &cmd, args),
        RunSubcommand::Codex { args } => launch(RunProvider::Codex, "codex", &cmd, args),
        RunSubcommand::Status { run_id, json } => status(run_id.as_deref(), *json),
        RunSubcommand::Stop { run_id, json } => stop(run_id, *json),
    }
}

struct PreparedLaunch {
    args: Vec<String>,
    envs: Vec<(String, String)>,
    temp_dir: Option<PathBuf>,
}

fn launch(provider: RunProvider, bin: &str, cmd_args: &RunCommand, passthrough_args: &[String]) -> Result<()> {
    let run_id = uuid::Uuid::new_v4().to_string();
    let start_ms = now_ms();
    let started_at = now_iso();
    let cwd = cmd_args.cwd.as_ref().map(PathBuf::from);
    let project_path = cwd.clone()
        .or_else(|| std::env::current_dir().ok())
        .map(|p| p.to_string_lossy().to_string());
    let catalog_id = resolve_catalog_id(cmd_args.catalog.as_deref());
    let prepared = prepare_launch(provider, &run_id, cmd_args.setting.as_deref(), passthrough_args)?;

    // Pre-spawn record (pid unknown yet).
    let record = RunRecord {
        run_id: run_id.clone(),
        session_id: None,
        provider,
        project_path: project_path.clone(),
        catalog_id: catalog_id.clone(),
        pid: None,
        status: RunStatus::Running,
        exit_code: None,
        started_at: started_at.clone(),
        ended_at: None,
        source: RunSource::StarlingRun,
    };
    create_run(record);

    eprintln!("{} run {} ({})", "starling".cyan(), short(&run_id), bin);

    let mut cmd = Command::new(bin);
    cmd.args(&prepared.args);
    for (key, value) in &prepared.envs {
        cmd.env(key, value);
    }
    if let Some(cwd) = &cwd {
        cmd.current_dir(cwd);
    }
    cmd.stdin(Stdio::inherit()).stdout(Stdio::inherit()).stderr(Stdio::inherit());

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
            );

            // Install SIGINT/SIGTERM handler so Ctrl-C marks the run crashed.
            install_signal_handler(run_id.clone());

            match child.wait() {
                Ok(status) => {
                    assign_recent_session_fallback(
                        &run_id,
                        provider,
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
                    finalize_run(&run_id, FinalizePatch {
                        status: final_status,
                        exit_code: status.code(),
                        ended_at: Some(now_iso()),
                        session_id: None,
                    });
                    cleanup_temp_dir(prepared.temp_dir.as_deref());
                    std::process::exit(status.code().unwrap_or(0));
                }
                Err(e) => {
                    eprintln!("{}: failed to wait on {}: {}", "error".red(), bin, e);
                    mark_run_crashed(&run_id);
                    cleanup_temp_dir(prepared.temp_dir.as_deref());
                    std::process::exit(1);
                }
            }
        }
        Err(e) => {
            eprintln!("{}: failed to spawn {}: {}", "error".red(), bin, e);
            // Mark as crashed since we recorded a Running entry.
            mark_run_crashed(&run_id);
            cleanup_temp_dir(prepared.temp_dir.as_deref());
            std::process::exit(1);
        }
    }
}

fn maybe_start_catalog_assignment_watcher(
    run_id: String,
    pid: u32,
    provider: RunProvider,
    catalog_id: Option<String>,
    title: Option<String>,
    project_path: Option<String>,
    start_ms: u64,
) {
    let Some(catalog_id) = catalog_id else { return; };
    std::thread::spawn(move || {
        while crate::core::runs::is_pid_alive(pid) {
            if let Some(mapped) = map_process_tree_to_session_since(pid, start_ms) {
                if let Some(session_id) = mapped.session_id {
                    let file_path = mapped.file_path.clone();
                    let project = mapped.project_path.or_else(|| project_path.clone()).unwrap_or_default();
                    assign_session_to_catalog(
                        &run_id,
                        provider,
                        &session_id,
                        file_path.as_deref(),
                        &project,
                        title.as_deref(),
                        &catalog_id,
                    );
                    return;
                }
            }
            std::thread::sleep(std::time::Duration::from_secs(1));
        }
    });
}

fn assign_recent_session_fallback(
    run_id: &str,
    provider: RunProvider,
    catalog_id: Option<&str>,
    title: Option<&str>,
    project_path: Option<&str>,
    start_ms: u64,
) {
    let Some(catalog_id) = catalog_id else { return; };
    let sessions = find_sessions(20, Some(discovery_provider(provider)));
    let candidate = sessions.into_iter().find(|session| {
        if let Some(project_path) = project_path {
            if session.project_path != project_path { return false; }
        }
        session_modified_ms(&session.modified_at).map(|ms| ms >= start_ms).unwrap_or(false)
    });
    if let Some(session) = candidate {
        assign_session_to_catalog(
            run_id,
            provider,
            &session.session_id,
            Some(&session.file_path),
            &session.project_path,
            title,
            catalog_id,
        );
    }
}

fn assign_session_to_catalog(
    run_id: &str,
    provider: RunProvider,
    session_id: &str,
    file_path: Option<&str>,
    project_path: &str,
    title: Option<&str>,
    catalog_id: &str,
) {
    update_run_session_id(run_id, session_id);

    let bookmark = if let Some(existing) = find_bookmark(session_id) {
        existing
    } else {
        let store = crate::core::store::load_store();
        let bookmark = Bookmark {
            id: generate_bookmark_id(&store.bookmarks),
            provider: provider_name(provider).into(),
            session_id: session_id.into(),
            title: title.filter(|t| !t.trim().is_empty())
                .map(String::from)
                .unwrap_or_else(|| "running session".into()),
            category: String::new(),
            tags: vec![],
            project_path: project_path.into(),
            first_prompt: String::new(),
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
        let _ = update_bookmark(&bookmark.id, BookmarkPatch {
            space_ids: Some(ids),
            ..Default::default()
        });
        let _ = file_path;
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
            eprintln!("{}: ambiguous catalog '{}': {}", "error".red(), catalog,
                matches.iter().map(|s| s.name.clone()).collect::<Vec<_>>().join(", "));
            std::process::exit(2);
        }
        CatalogResolution::NotFound => {
            eprintln!("{}: catalog not found: {}", "error".red(), catalog);
            std::process::exit(2);
        }
    }
}

fn prepare_launch(
    provider: RunProvider,
    run_id: &str,
    setting: Option<&str>,
    passthrough_args: &[String],
) -> Result<PreparedLaunch> {
    let mut args = Vec::new();
    let mut envs = Vec::new();
    let mut temp_dir = None;

    if let Some(profile) = setting {
        match provider {
            RunProvider::Claude => {
                let path = default_claude_settings_dir().join(format!("{profile}.json"));
                ensure_file(&path, "Claude profile")?;
                args.push("--settings".into());
                args.push(path.to_string_lossy().to_string());
            }
            RunProvider::Codex => {
                let path = default_codex_settings_dir().join(format!("{profile}.toml"));
                ensure_file(&path, "Codex profile")?;
                let dir = default_starling_home()
                    .join("run-homes")
                    .join(format!("codex-{run_id}"));
                std::fs::create_dir_all(&dir)?;
                std::fs::copy(&path, dir.join("config.toml"))?;
                copy_if_exists(&default_codex_home().join("auth.json"), &dir.join("auth.json"))?;
                envs.push(("CODEX_HOME".into(), dir.to_string_lossy().to_string()));
                temp_dir = Some(dir);
            }
        }
    }

    args.extend(passthrough_args.iter().cloned());
    Ok(PreparedLaunch { args, envs, temp_dir })
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
                if let Some(end) = &r.ended_at { println!("  Ended:    {}", end); }
                if let Some(pid) = r.pid { println!("  PID:      {}", pid); }
                if let Some(code) = r.exit_code { println!("  Exit:     {}", code); }
                if let Some(p) = &r.project_path { println!("  Project:  {}", p); }
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
            use comfy_table::{Cell, Color, ContentArrangement, Table, presets::UTF8_FULL};
            let mut table = Table::new();
            table.load_preset(UTF8_FULL).set_content_arrangement(ContentArrangement::Disabled);
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
        eprintln!("{}: run {} is not running (status: {:?})",
            "error".red(), short(&run.run_id), run.status);
        std::process::exit(1);
    }
    let pid = match run.pid {
        Some(p) if p > 0 => p,
        _ => {
            eprintln!("{}: run {} has no pid; cannot stop", "error".red(), short(&run.run_id));
            std::process::exit(1);
        }
    };
    terminate_pid(pid, false);
    eprintln!("{}: sent stop signal to pid {} (run {})", "starling".cyan(), pid, short(&run.run_id));
    // Brief grace period
    for _ in 0..50 {
        if !crate::core::runs::is_pid_alive(pid) { break; }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    if crate::core::runs::is_pid_alive(pid) {
        terminate_pid(pid, true);
        eprintln!("{}: escalated stop signal", "starling".cyan());
    }
    finalize_run(run_id, FinalizePatch {
        status: RunStatus::Crashed,
        exit_code: None,
        ended_at: Some(now_iso()),
        session_id: None,
    });
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
fn _anchor_remove(run_id: &str) -> bool { remove_run(run_id) }

fn short(id: &str) -> String {
    if id.len() > 8 { id[..8].to_string() } else { id.to_string() }
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

use std::sync::Mutex;
use once_cell::sync::Lazy;

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
