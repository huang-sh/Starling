//! `starling run` — agent launch with run-record tracking.

use std::process::{Command, Stdio};

use anyhow::Result;
use colored::*;

use crate::cli::*;
use crate::constants::now_iso;
use crate::core::runs::{
    create_run, finalize_run, find_run, list_runs, mark_run_crashed, remove_run, FinalizePatch,
    RunStatus,
};
use crate::types::{RunProvider, RunRecord, RunSource};

pub fn handle(cmd: RunCommand) -> Result<()> {
    match cmd {
        RunCommand::Claude { args } => launch(RunProvider::Claude, "claude", &args),
        RunCommand::Codex { args } => launch(RunProvider::Codex, "codex", &args),
        RunCommand::Status { run_id } => status(run_id.as_deref()),
        RunCommand::Stop { run_id } => stop(&run_id),
    }
}

fn launch(provider: RunProvider, bin: &str, args: &[String]) -> Result<()> {
    let run_id = uuid::Uuid::new_v4().to_string();
    let started_at = now_iso();
    let project_path = std::env::current_dir().ok().map(|p| p.to_string_lossy().to_string());

    // Pre-spawn record (pid unknown yet).
    let record = RunRecord {
        run_id: run_id.clone(),
        session_id: None,
        provider,
        project_path: project_path.clone(),
        catalog_id: None,
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
    cmd.args(args);
    cmd.stdin(Stdio::inherit()).stdout(Stdio::inherit()).stderr(Stdio::inherit());

    match cmd.spawn() {
        Ok(mut child) => {
            // Update record with pid.
            let pid = child.id();
            update_run_pid(&run_id, pid);

            // Install SIGINT/SIGTERM handler so Ctrl-C marks the run crashed.
            install_signal_handler(run_id.clone());

            match child.wait() {
                Ok(status) => {
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
                    std::process::exit(status.code().unwrap_or(0));
                }
                Err(e) => {
                    eprintln!("{}: failed to wait on {}: {}", "error".red(), bin, e);
                    mark_run_crashed(&run_id);
                    std::process::exit(1);
                }
            }
        }
        Err(e) => {
            eprintln!("{}: failed to spawn {}: {}", "error".red(), bin, e);
            // Mark as crashed since we recorded a Running entry.
            mark_run_crashed(&run_id);
            std::process::exit(1);
        }
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

fn status(run_id: Option<&str>) -> Result<()> {
    match run_id {
        Some(id) => match find_run(id) {
            Some(r) => {
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

fn stop(run_id: &str) -> Result<()> {
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
    // Send SIGTERM, then wait briefly, then SIGKILL.
    unsafe {
        libc::kill(pid as i32, libc::SIGTERM);
    }
    eprintln!("{}: sent SIGTERM to pid {} (run {})", "starling".cyan(), pid, short(&run.run_id));
    // Brief grace period
    for _ in 0..50 {
        if !crate::core::runs::is_pid_alive(pid) { break; }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    if crate::core::runs::is_pid_alive(pid) {
        unsafe { libc::kill(pid as i32, libc::SIGKILL); }
        eprintln!("{}: escalated to SIGKILL", "starling".cyan());
    }
    finalize_run(run_id, FinalizePatch {
        status: RunStatus::Crashed,
        exit_code: None,
        ended_at: Some(now_iso()),
        session_id: None,
    });
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
