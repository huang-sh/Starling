//! `starling monitor` — live monitor.

use std::io::{self, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use anyhow::Result;
use colored::*;

use crate::cli::MonitorCommand;
use crate::core::catalog_resolver::{catalog_path, resolve_catalog_reference};
use crate::core::process_metrics::{get_process_tree_metrics, reset_cpu_sampler};
use crate::core::runs::{detect_running_sessions, reconcile_stale_runs};
use crate::core::session_display::short_session_id;
use crate::core::session_index::{load_session_index, Provider as IdxProvider};
use crate::core::session_metrics::{clear_session_metrics_cache, get_session_live_metrics};
use crate::core::store::{list_bookmarks, list_spaces, BookmarkFilter};
use crate::types::Bookmark;

pub fn handle(cmd: MonitorCommand) -> Result<()> {
    let catalog_filter = cmd.catalog_filter.or(cmd.catalog);
    let limit = cmd.limit.unwrap_or(30);

    if cmd.watch {
        return watch(catalog_filter.as_deref(), cmd.recent, limit);
    }

    let rows = build_snapshot(catalog_filter.as_deref(), cmd.recent, limit)?;
    if cmd.json {
        let json = serde_json::to_string_pretty(&rows.iter().map(|r| RowJson::from(r)).collect::<Vec<_>>())?;
        println!("{}", json);
        return Ok(());
    }

    if rows.is_empty() {
        println!("{}", "No agent sessions to display.".yellow());
        println!("{}", "Tip: use --recent to include recent unpinned sessions.".normal());
        return Ok(());
    }

    println!("{}", render_table(&rows));
    Ok(())
}

/// A single row in the monitor table — combines a bookmark (pinned session)
/// or a discovered session with live runtime metrics.
#[derive(Clone)]
struct Row {
    session_id: String,
    provider: String,
    project: String,
    title: String,
    pinned: bool,
    catalog: Option<String>,
    file_path: Option<String>,
    pid: Option<u32>,
}

#[derive(serde::Serialize)]
struct RowJson {
    session_id: String,
    provider: String,
    project: String,
    title: String,
    pinned: bool,
    catalog: Option<String>,
    cpu_pct: f64,
    rss_kb: u64,
    model: String,
    ctx_pct: i64,
    tool_count: u32,
    last_tool: String,
    pid: Option<u32>,
}

impl From<&Row> for RowJson {
    fn from(r: &Row) -> Self {
        let (cpu, rss, model, ctx, tools, last_tool) = live_for(&r.file_path, &r.session_id, r.pid);
        RowJson {
            session_id: r.session_id.clone(),
            provider: r.provider.clone(),
            project: r.project.clone(),
            title: r.title.clone(),
            pinned: r.pinned,
            catalog: r.catalog.clone(),
            cpu_pct: cpu,
            rss_kb: rss,
            model,
            ctx_pct: ctx,
            tool_count: tools,
            last_tool,
            pid: r.pid,
        }
    }
}

fn live_for(file_path: &Option<String>, session_id: &str, pid: Option<u32>) -> (f64, u64, String, i64, u32, String) {
    let (cpu, rss) = if let Some(p) = pid.filter(|&p| p > 0) {
        let m = get_process_tree_metrics(p);
        (m.cpu_pct, m.mem_kb)
    } else {
        (0.0, 0)
    };
    let (model, ctx, tools, last_tool) = match file_path.as_deref() {
        Some(path) => {
            let live = get_session_live_metrics(Path::new(path));
            (
                live.model.clone(),
                live.ctx_pct,
                live.tool_count,
                live.last_tool.unwrap_or_default(),
            )
        }
        None => (String::new(), -1, 0, String::new()),
    };
    let _ = session_id;
    (cpu, rss, model, ctx, tools, last_tool)
}

fn render_table(rows: &[Row]) -> String {
    use comfy_table::{Cell, Color, ContentArrangement, Table, presets::UTF8_FULL};
    let mut table = Table::new();
    table.load_preset(UTF8_FULL).set_content_arrangement(ContentArrangement::Disabled);
    table.set_header(vec![
        Cell::new("Session").fg(Color::Cyan),
        Cell::new("P").fg(Color::Cyan),
        Cell::new("Agent").fg(Color::Cyan),
        Cell::new("Model").fg(Color::Cyan),
        Cell::new("CPU%").fg(Color::Cyan),
        Cell::new("RSS(MB)").fg(Color::Cyan),
        Cell::new("CTX%").fg(Color::Cyan),
        Cell::new("Tools").fg(Color::Cyan),
        Cell::new("Last tool").fg(Color::Cyan),
        Cell::new("Title").fg(Color::Cyan),
        Cell::new("PID").fg(Color::Cyan),
    ]);
    for r in rows {
        let (cpu, rss, model, ctx, tools, last_tool) = live_for(&r.file_path, &r.session_id, r.pid);
        let title_short = if r.title.chars().count() > 60 {
            let mut s: String = r.title.chars().take(57).collect();
            s.push('…');
            s
        } else if r.title.is_empty() {
            "-".to_string()
        } else {
            r.title.clone()
        };
        table.add_row(vec![
            Cell::new(short_session_id(&r.session_id)),
            Cell::new(if r.pinned { "*" } else { " " }),
            Cell::new(if r.provider.is_empty() { "-" } else { &r.provider }),
            Cell::new(if model.is_empty() { "-" } else { &model }),
            Cell::new(if cpu > 0.0 { format!("{:.1}", cpu) } else { "-".into() }),
            Cell::new(if rss > 0 { format!("{:.0}", rss as f64 / 1024.0) } else { "-".into() }),
            Cell::new(if ctx >= 0 { ctx.to_string() } else { "-".into() }),
            Cell::new(if tools > 0 { tools.to_string() } else { "-".into() }),
            Cell::new(if last_tool.is_empty() { "-" } else { &last_tool }),
            Cell::new(&title_short),
            Cell::new(r.pid.map(|p| p.to_string()).unwrap_or_else(|| "-".into())),
        ]);
    }
    table.to_string()
}

/// Build the snapshot: pinned sessions first (filtered by catalog), then
/// optionally recent unpinned sessions, finally merge with running-agent
/// detection to attach pid + live metrics where available.
fn build_snapshot(catalog_filter: Option<&str>, include_recent: bool, pinned_limit: usize) -> Result<Vec<Row>> {
    reconcile_stale_runs();

    // Resolve catalog filter (if any) → space id
    let target_space_id = if let Some(c) = catalog_filter {
        match resolve_catalog_reference(c) {
            crate::core::catalog_resolver::CatalogResolution::Found(s) => Some(s.id),
            crate::core::catalog_resolver::CatalogResolution::Ambiguous(matches) => {
                eprintln!("{}: ambiguous catalog '{}': {}", "error".red(), c,
                    matches.iter().map(|s| s.name.clone()).collect::<Vec<_>>().join(", "));
                std::process::exit(2);
            }
            crate::core::catalog_resolver::CatalogResolution::NotFound => {
                eprintln!("{}: catalog not found: {}", "error".red(), c);
                std::process::exit(2);
            }
        }
    } else {
        None
    };

    // 1) Pinned bookmarks
    let bookmarks: Vec<Bookmark> = list_bookmarks(BookmarkFilter::default());
    let spaces = list_spaces();
    let mut pinned_rows: Vec<Row> = bookmarks.iter()
        .filter(|b| {
            target_space_id.as_ref()
                .map(|id| b.space_ids.contains(id))
                .unwrap_or(true)
        })
        .take(pinned_limit)
        .map(|b| {
            let catalog = b.space_ids.iter()
                .filter_map(|sid| spaces.iter().find(|s| &s.id == sid))
                .map(|s| catalog_path(s, Some(&spaces)))
                .next();
            Row {
                session_id: b.session_id.clone(),
                provider: b.provider.clone(),
                project: b.project_path.clone(),
                title: if b.title.is_empty() { b.first_prompt.clone() } else { b.title.clone() },
                pinned: true,
                catalog,
                file_path: None, // resolved via index below
                pid: None,
            }
        })
        .collect();

    // Attach file_path from session index for live metrics
    if let Some(idx) = load_session_index() {
        for row in pinned_rows.iter_mut() {
            if let Some(s) = idx.sessions.iter().find(|s| s.session_id == row.session_id) {
                row.file_path = Some(s.file_path.clone());
            }
        }
    }

    // 2) Recent unpinned sessions (from index, newest first)
    let mut rows: Vec<Row> = pinned_rows;
    if include_recent {
        if let Some(idx) = load_session_index() {
            let pinned_ids: std::collections::HashSet<String> = rows.iter()
                .map(|r| r.session_id.clone()).collect();
            let mut recent: Vec<Row> = idx.sessions.iter()
                .filter(|s| !pinned_ids.contains(&s.session_id))
                .take(50)
                .map(|s| Row {
                    session_id: s.session_id.clone(),
                    provider: format!("{:?}", s.provider).to_lowercase(),
                    project: s.project_path.clone(),
                    title: if s.first_prompt.is_empty() { "-".into() } else { s.first_prompt.clone() },
                    pinned: false,
                    catalog: None,
                    file_path: Some(s.file_path.clone()),
                    pid: None,
                })
                .collect();
            rows.append(&mut recent);
        }
    }

    // 3) Attach pid from running-agent detection
    let detected = detect_running_sessions();
    for row in rows.iter_mut() {
        if let Some(info) = detected.get(&row.session_id) {
            row.pid = info.pid;
            if row.file_path.is_none() {
                row.file_path = info.file_path.clone();
            }
            if row.provider.is_empty() {
                row.provider = info.provider.clone();
            }
        }
    }

    Ok(rows)
}

fn watch(catalog_filter: Option<&str>, include_recent: bool, pinned_limit: usize) -> Result<()> {
    let interval_ms: u64 = 3000;
    install_ctrlc_handler();
    reset_cpu_sampler();

    while !ctrlc_flag() {
        clear_session_metrics_cache();
        let rows = match build_snapshot(catalog_filter, include_recent, pinned_limit) {
            Ok(r) => r,
            Err(e) => {
                eprintln!("{}: snapshot error: {}", "error".red(), e);
                break;
            }
        };

        // Clear screen + render
        print!("\x1b[2J\x1b[H");
        let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S");
        let _ = io::stdout().write_all(format!(
            "{} {}  ({} sessions · refresh 3.0s · Ctrl-C to exit)\n\n",
            "starling monitor".cyan().bold(),
            now.to_string().normal(),
            rows.len(),
        ).as_bytes());
        let _ = io::stdout().flush();
        if rows.is_empty() {
            println!("{}", "No agent sessions to display.".yellow());
        } else {
            println!("{}", render_table(&rows));
        }
        let _ = io::stdout().flush();

        // Sleep in 100ms slices so Ctrl-C is responsive
        let mut remaining = interval_ms;
        while remaining > 0 && !ctrlc_flag() {
            let step = remaining.min(100);
            std::thread::sleep(Duration::from_millis(step));
            remaining = remaining.saturating_sub(step);
        }
    }
    println!("{}", "\nexited.".normal());
    Ok(())
}

/// Module-level Ctrl-C flag flipped by the SIGINT handler.
static CTRL_C: AtomicBool = AtomicBool::new(false);

pub fn ctrlc_flag() -> bool {
    CTRL_C.load(Ordering::SeqCst)
}

/// Install a SIGINT handler that flips the module-level flag.
pub fn install_ctrlc_handler() {
    CTRL_C.store(false, Ordering::SeqCst);
    #[cfg(unix)]
    unsafe {
        extern "C" {
            fn signal(signum: i32, handler: usize) -> usize;
        }
        extern "C" fn handle_sigint(_sig: i32) {
            CTRL_C.store(true, Ordering::SeqCst);
        }
        signal(2 /* SIGINT */, handle_sigint as usize);
    }
}

// Silence unused-import warning for IdxProvider (kept for symmetry with TS).
#[allow(dead_code)]
fn _idx_provider_marker() -> Option<IdxProvider> { None }
