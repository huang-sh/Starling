//! `starling status` — show pinned sessions and their run status.

use std::collections::HashMap;

use anyhow::Result;
use colored::*;

use crate::cli::*;
use crate::core::catalog_resolver::{catalog_path, resolve_catalog_reference, CatalogResolution};
use crate::core::runs::{
    clear_runs, detect_running_sessions, get_latest_run_for_session, reconcile_stale_runs, status_badge,
    ListFilter, RunFilter, RunStatus,
};
use crate::core::session_display::short_session_id;
use crate::core::store::{list_bookmarks, list_spaces, BookmarkFilter};
use crate::core::process_metrics::get_process_tree_metrics;
use crate::types::Bookmark;

#[derive(Debug, serde::Serialize)]
struct StatusRow {
    catalog: String,
    session_id: String,
    title: String,
    status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    started_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ended_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    source: Option<String>,
}

pub fn handle(cmd: StatusCommand) -> Result<()> {
    match cmd {
        StatusCommand::Show { catalog, live, json } => show(catalog, live, json),
        StatusCommand::Prune { json } => prune(json),
        StatusCommand::Clear { yes, json } => clear_cmd(yes, json),
    }
}

fn collect_catalog_bookmarks(catalog_filter: Option<&str>) -> (Vec<Bookmark>, Option<String>) {
    let mut all: Vec<Bookmark> = list_bookmarks(BookmarkFilter::default()).into_iter()
        .filter(|b| !b.space_ids.is_empty())
        .collect();
    let Some(filter) = catalog_filter else { return (all, None); };
    match resolve_catalog_reference(filter) {
        CatalogResolution::Found(space) => {
            all.retain(|b| b.space_ids.contains(&space.id));
            (all, None)
        }
        CatalogResolution::Ambiguous(matches) => {
            (vec![], Some(format!("Ambiguous catalog \"{}\": {}", filter,
                matches.iter().map(|s| s.name.clone()).collect::<Vec<_>>().join(", "))))
        }
        CatalogResolution::NotFound => (vec![], Some(format!("Catalog not found: {}", filter))),
    }
}

fn build_snapshot(catalog_filter: Option<&str>, with_detection: bool) -> (Vec<StatusRow>, Option<String>) {
    reconcile_stale_runs();
    let (bookmarks, error) = collect_catalog_bookmarks(catalog_filter);
    if let Some(err) = error { return (vec![], Some(err)); }

    let detected = if with_detection {
        detect_running_sessions()
    } else {
        HashMap::new()
    };
    let spaces = list_spaces();
    let rows: Vec<StatusRow> = bookmarks.iter().map(|b| {
        let latest = get_latest_run_for_session(&b.session_id);
        let first_space_id = b.space_ids.first();
        let space = first_space_id.and_then(|sid| spaces.iter().find(|s| &s.id == sid));
        let catalog = space.map(|s| catalog_path(s, Some(&spaces)))
            .unwrap_or_else(|| b.space_ids.join(","));
        let status = if detected.contains_key(&b.session_id) {
            "running".to_string()
        } else if latest.as_ref().map(|r| r.status == RunStatus::Running).unwrap_or(false) {
            "running".to_string()
        } else {
            latest.as_ref().map(|r| format!("{:?}", r.status).to_lowercase()).unwrap_or_else(|| "unknown".to_string())
        };
        StatusRow {
            catalog,
            session_id: b.session_id.clone(),
            title: b.title.clone(),
            status,
            started_at: latest.as_ref().map(|r| r.started_at.clone()),
            ended_at: latest.as_ref().and_then(|r| r.ended_at.clone()),
            exit_code: latest.as_ref().and_then(|r| r.exit_code),
            pid: latest.as_ref().and_then(|r| r.pid),
            source: latest.as_ref().map(|r| format!("{:?}", r.source).to_lowercase()),
        }
    }).collect();
    (rows, None)
}

fn show(catalog_filter: Option<String>, live: bool, json: bool) -> Result<()> {
    let (rows, error) = build_snapshot(catalog_filter.as_deref(), live);
    if let Some(err) = error {
        eprintln!("{}: {}", "error".red(), err);
        std::process::exit(2);
    }
    if json {
        println!("{}", serde_json::to_string_pretty(&rows)?);
        return Ok(());
    }
    if rows.is_empty() {
        println!("{}", "No cataloged sessions found.".yellow());
        return Ok(());
    }
    use comfy_table::{Cell, Color, ContentArrangement, Table, presets::UTF8_FULL};
    let mut table = Table::new();
    table.load_preset(UTF8_FULL).set_content_arrangement(ContentArrangement::Disabled);
    table.set_header(vec![
        Cell::new("ST").fg(Color::Cyan),
        Cell::new("Session").fg(Color::Cyan),
        Cell::new("Catalog").fg(Color::Cyan),
        Cell::new("Title").fg(Color::Cyan),
        Cell::new("Started").fg(Color::Cyan),
        Cell::new("CPU%").fg(Color::Cyan),
        Cell::new("RSS(MB)").fg(Color::Cyan),
        Cell::new("PID").fg(Color::Cyan),
    ]);
    for r in &rows {
        let st = parse_status(&r.status);
        let mut cpu = String::new();
        let mut rss_mb = String::new();
        let mut pid_str = String::new();
        if let Some(pid) = r.pid {
            pid_str = pid.to_string();
            let m = get_process_tree_metrics(pid);
            cpu = format!("{:.1}", m.cpu_pct);
            rss_mb = format!("{:.0}", m.mem_kb as f64 / 1024.0);
        }
        table.add_row(vec![
            Cell::new(status_badge(st, false)),
            Cell::new(short_session_id(&r.session_id)),
            Cell::new(&r.catalog),
            Cell::new(&r.title),
            Cell::new(r.started_at.as_deref().unwrap_or("-")),
            Cell::new(cpu),
            Cell::new(rss_mb),
            Cell::new(pid_str),
        ]);
    }
    println!("{table}");
    Ok(())
}

fn parse_status(s: &str) -> RunStatus {
    match s {
        "running" => RunStatus::Running,
        "completed" => RunStatus::Completed,
        "errored" => RunStatus::Errored,
        "crashed" => RunStatus::Crashed,
        "stale" => RunStatus::Stale,
        _ => RunStatus::Unknown,
    }
}

fn prune(json: bool) -> Result<()> {
    let n = reconcile_stale_runs();
    if json {
        return super::print_json_result(
            "status.prune",
            &format!("Reconciled {} stale run(s).", n),
            serde_json::json!({ "reconciled": n }),
        );
    }
    println!("{}", format!("Reconciled {} stale run(s).", n).green());
    Ok(())
}

fn clear_cmd(yes: bool, json: bool) -> Result<()> {
    if !yes {
        eprintln!("{}: clearing all run records requires --yes", "error".red());
        std::process::exit(2);
    }
    let removed = clear_runs(None);
    let _ = ListFilter::default();
    let _ = RunFilter::default();
    if json {
        return super::print_json_result(
            "status.clear",
            &format!("Cleared {} run record(s).", removed),
            serde_json::json!({ "removed": removed }),
        );
    }
    println!("{}", format!("Cleared {} run record(s).", removed).green());
    Ok(())
}
