//! `starling monitor` — live monitor (Phase 6).

use anyhow::Result;
use colored::*;

use crate::cli::*;
use crate::core::runs::{detect_running_sessions, reconcile_stale_runs};
use crate::core::session_metrics::get_session_live_metrics;
use crate::core::session_display::short_session_id;
use std::path::Path;

pub fn handle(cmd: MonitorCommand) -> Result<()> {
    match cmd {
        MonitorCommand::Snapshot { recent, agent, json } => snapshot(recent, agent, json),
        MonitorCommand::Live { agent } => live(agent),
        MonitorCommand::Watch { interval } => watch(interval),
    }
}

fn snapshot(recent: bool, agent: Option<String>, json: bool) -> Result<()> {
    let _ = agent;
    let _ = recent;
    reconcile_stale_runs();
    let detected = detect_running_sessions();
    if json {
        let entries: Vec<_> = detected.iter().collect();
        println!("{}", serde_json::to_string_pretty(&entries)?);
        return Ok(());
    }
    if detected.is_empty() {
        println!("{}", "No running agent sessions detected.".yellow());
        return Ok(());
    }
    use comfy_table::{Cell, Color, ContentArrangement, Table, presets::UTF8_FULL};
    let mut table = Table::new();
    table.load_preset(UTF8_FULL).set_content_arrangement(ContentArrangement::Disabled);
    table.set_header(vec![
        Cell::new("Session").fg(Color::Cyan),
        Cell::new("Agent").fg(Color::Cyan),
        Cell::new("Model").fg(Color::Cyan),
        Cell::new("CPU%").fg(Color::Cyan),
        Cell::new("RSS(MB)").fg(Color::Cyan),
        Cell::new("CTX%").fg(Color::Cyan),
        Cell::new("Last tool").fg(Color::Cyan),
        Cell::new("Project").fg(Color::Cyan),
        Cell::new("PID").fg(Color::Cyan),
    ]);
    for (sid, info) in &detected {
        let provider = if info.provider.is_empty() { "-" } else { &info.provider };
        let pid = info.pid.unwrap_or(0);
        let cpu_mem = if pid > 0 {
            let m = crate::core::process_metrics::get_process_tree_metrics(pid);
            (format!("{:.1}", m.cpu_pct), format!("{:.0}", m.mem_kb as f64 / 1024.0))
        } else {
            ("-".to_string(), "-".to_string())
        };
        let mut model = String::new();
        let mut ctx = String::new();
        let mut last_tool = String::new();
        if let Some(path) = info.file_path.as_deref() {
            let live = get_session_live_metrics(Path::new(path));
            if !live.model.is_empty() { model = live.model; }
            if live.ctx_pct >= 0 { ctx = format!("{}", live.ctx_pct); }
            if let Some(t) = live.last_tool { last_tool = t; }
        }
        table.add_row(vec![
            Cell::new(short_session_id(sid)),
            Cell::new(provider),
            Cell::new(if model.is_empty() { "-" } else { &model }),
            Cell::new(&cpu_mem.0),
            Cell::new(&cpu_mem.1),
            Cell::new(if ctx.is_empty() { "-" } else { &ctx }),
            Cell::new(if last_tool.is_empty() { "-" } else { &last_tool }),
            Cell::new(info.project_path.as_deref().unwrap_or("-")),
            Cell::new(if pid > 0 { pid.to_string() } else { "-".to_string() }),
        ]);
    }
    println!("{table}");
    Ok(())
}

fn live(_agent: Option<String>) -> Result<()> {
    eprintln!("{}", "monitor live is not yet implemented in the Rust version; use `monitor snapshot` for a one-off view.".yellow());
    snapshot(false, _agent, false)
}

fn watch(interval: f64) -> Result<()> {
    let _ = interval;
    eprintln!("{}", "monitor watch is not yet implemented in the Rust version.".yellow());
    Ok(())
}
