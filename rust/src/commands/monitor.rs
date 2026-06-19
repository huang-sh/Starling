//! `starling top` — live monitor.

use std::collections::HashSet;
use std::io::{self, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use anyhow::Result;
use colored::*;

use crate::cli::MonitorCommand;
use crate::core::catalog_resolver::{catalog_path, resolve_catalog_reference};
use crate::core::discovery::match_session_id;
use crate::core::process_metrics::{get_process_tree_metrics, reset_cpu_sampler};
use crate::core::runs::{detect_running_sessions, reconcile_stale_runs};
use crate::core::session_display::short_session_id;
use crate::core::session_index::load_session_index;
use crate::core::session_metrics::{clear_session_metrics_cache, get_session_live_metrics, ChatRole, SessionLive};
use crate::core::store::{list_bookmarks, list_spaces, BookmarkFilter};
use crate::types::{Bookmark, SessionMeta};

pub fn handle(cmd: MonitorCommand) -> Result<()> {
    let catalog_filter = cmd.catalog_filter.or(cmd.catalog);
    let limit = cmd.limit.unwrap_or(30);

    if cmd.json && cmd.watch {
        return watch_json(catalog_filter.as_deref(), cmd.recent, limit);
    }

    let rows = build_snapshot(catalog_filter.as_deref(), cmd.recent, limit)?;
    if cmd.json {
        let json = serde_json::to_string_pretty(&MonitorSnapshot::from_rows(&rows))?;
        let _ = write_stdout_line(&json)?;
        return Ok(());
    }

    if cmd.watch {
        return watch(catalog_filter.as_deref(), cmd.recent, limit);
    }

    if rows.is_empty() {
        println!("{}", "No agent sessions to display.".yellow());
        println!("{}", "Tip: use --unpin to include unpinned sessions.".normal());
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
    model: String,
    project: String,
    title: String,
    pinned: bool,
    catalog: Option<String>,
    file_path: Option<String>,
    pid: Option<u32>,
}

#[derive(Clone, serde::Serialize)]
struct RowJson {
    session_id: String,
    pinned: bool,
    catalog: Option<String>,
    title: String,
    provider: String,
    model: String,
    status: String,
    pid: Option<u32>,
    cpu_pct: f64,
    mem_kb: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    rss_kb: Option<u64>,
    ctx_pct: i64,
    tokens_in: u64,
    tokens_out: u64,
    tokens_cache: u64,
    last_tool: Option<String>,
    tool_count: u32,
    project_path: String,
    project: String,
    file_path: Option<String>,
    last_activity_ms: u64,
    started_at_ms: u64,
    elapsed_secs: u64,
    pending_since_ms: u64,
    thinking_since_ms: u64,
    token_history: Vec<u64>,
    context_history: Vec<u64>,
    compaction_count: u32,
    current_task: String,
    tool_calls_tail: Vec<crate::core::session_metrics::ToolCallEntry>,
    chat_tail: Vec<crate::core::session_metrics::ChatMessageEntry>,
}

#[derive(serde::Serialize)]
struct MonitorSnapshot {
    schema_version: u32,
    generated_at_ms: u64,
    pinned_total: usize,
    recent_total: usize,
    active: usize,
    pinned: Vec<RowJson>,
    recent: Vec<RowJson>,
}

impl From<&Row> for RowJson {
    fn from(r: &Row) -> Self {
        let live = live_for(&r.file_path);
        let (cpu, mem_kb) = process_for(r.pid);
        let status = infer_status(r.pid.is_some(), &live, &r.title);
        let now_ms = now_ms();
        let started_at_ms = live.started_at_ms;
        let elapsed_secs = if started_at_ms > 0 && now_ms > started_at_ms {
            (now_ms - started_at_ms) / 1000
        } else {
            0
        };
        RowJson {
            session_id: r.session_id.clone(),
            pinned: r.pinned,
            catalog: r.catalog.clone(),
            title: r.title.clone(),
            provider: r.provider.clone(),
            model: if live.model.is_empty() { r.model.clone() } else { live.model.clone() },
            status,
            pid: r.pid,
            cpu_pct: cpu,
            mem_kb,
            rss_kb: Some(mem_kb),
            ctx_pct: live.ctx_pct,
            tokens_in: live.tokens.input,
            tokens_out: live.tokens.output,
            tokens_cache: live.tokens.cache,
            last_tool: live.last_tool.clone(),
            tool_count: live.tool_count,
            project_path: r.project.clone(),
            project: r.project.clone(),
            file_path: r.file_path.clone(),
            last_activity_ms: live.last_activity_ms,
            started_at_ms,
            elapsed_secs,
            pending_since_ms: live.pending_since_ms,
            thinking_since_ms: live.thinking_since_ms,
            token_history: live.token_history.clone(),
            context_history: live.context_history.clone(),
            compaction_count: live.compaction_count,
            current_task: live.current_task.clone(),
            tool_calls_tail: live.tool_calls_tail.clone(),
            chat_tail: live.chat_tail.clone(),
        }
    }
}

impl MonitorSnapshot {
    fn from_rows(rows: &[Row]) -> Self {
        let all: Vec<RowJson> = rows.iter().map(RowJson::from).collect();
        let active = all.iter().filter(|r| is_active_status(&r.status)).count();
        let pinned: Vec<RowJson> = all.iter().filter(|r| r.pinned).cloned().collect();
        let recent: Vec<RowJson> = all.into_iter().filter(|r| !r.pinned).collect();
        MonitorSnapshot {
            schema_version: 1,
            generated_at_ms: now_ms(),
            pinned_total: pinned.len(),
            recent_total: recent.len(),
            active,
            pinned,
            recent,
        }
    }
}

fn process_for(pid: Option<u32>) -> (f64, u64) {
    if let Some(p) = pid.filter(|&p| p > 0) {
        let m = get_process_tree_metrics(p);
        (m.cpu_pct, m.mem_kb)
    } else {
        (0.0, 0)
    }
}

fn live_for(file_path: &Option<String>) -> SessionLive {
    match file_path.as_deref() {
        Some(path) => get_session_live_metrics(Path::new(path)),
        None => SessionLive { ctx_pct: -1, ..Default::default() },
    }
}

fn now_ms() -> u64 {
    chrono::Utc::now().timestamp_millis().max(0) as u64
}

fn infer_status(running: bool, live: &SessionLive, title: &str) -> String {
    if !running {
        return "stopped".to_string();
    }
    if looks_like_permission(title)
        || looks_like_permission(&live.current_task)
        || live.chat_tail.iter().any(|m| looks_like_permission(&m.text))
    {
        return "permission".to_string();
    }
    let last_role = live.chat_tail.last().map(|m| m.role);
    if live.current_task.is_empty()
        && live.pending_since_ms == 0
        && matches!(last_role, Some(ChatRole::Assistant))
    {
        return "waiting".to_string();
    }
    if live.pending_since_ms > 0 || live.thinking_since_ms > 0 || !live.current_task.is_empty() {
        return "busy".to_string();
    }
    "idle".to_string()
}

fn is_active_status(status: &str) -> bool {
    matches!(status, "permission" | "waiting" | "busy" | "running" | "idle")
}

fn looks_like_permission(s: &str) -> bool {
    let s = s.to_lowercase();
    s.contains("permission")
        || s.contains("approval")
        || s.contains("needs your")
        || s.contains("wants to enter")
}

fn render_table(rows: &[Row]) -> String {
    let width = terminal_width().max(72);
    let mut lines = Vec::new();
    lines.push(format!(
        "{} {}",
        "starling top".cyan().bold(),
        render_summary(rows).normal()
    ));
    lines.push(format!("{}", "─".repeat(width.min(110)).bright_black()));

    for row in rows {
        lines.extend(render_compact_row(row, width));
    }

    lines.join("\n")
}

fn render_compact_row(row: &Row, width: usize) -> Vec<String> {
    let live = live_for(&row.file_path);
    let (cpu, mem_kb) = process_for(row.pid);
    let status = infer_status(row.pid.is_some(), &live, &row.title);
    let status_padding = " ".repeat(10usize.saturating_sub(status.chars().count()));
    let status_cell = format!("{} {}{}", status_symbol(&status), style_status(&status), status_padding);
    let agent = if row.provider.is_empty() { "-" } else { row.provider.as_str() };
    let model = if !live.model.is_empty() {
        live.model.as_str()
    } else if !row.model.is_empty() {
        row.model.as_str()
    } else {
        "-"
    };
    let session = short_session_id(&row.session_id);
    let title = if row.title.trim().is_empty() { "-" } else { row.title.trim() };

    let fixed = format!(
        "{} {:<7} {:<15} {:<14} ",
        status_cell,
        truncate_chars(agent, 7),
        truncate_chars(model, 15),
        session,
    );
    let title_width = width.saturating_sub(54).max(18);
    let line1 = format!("{}{}", fixed, truncate_chars(title, title_width));

    let metrics = render_metrics(&status, &live, cpu, mem_kb, row);
    if metrics.is_empty() {
        vec![line1]
    } else {
        let line2 = format!("  {}", truncate_chars(&metrics, width.saturating_sub(2))).bright_black().to_string();
        vec![line1, line2]
    }
}

fn render_metrics(_status: &str, live: &SessionLive, cpu: f64, mem_kb: u64, row: &Row) -> String {
    let mut parts = Vec::new();
    if !row.pinned {
        parts.push("unpinned".to_string());
    }
    if cpu > 0.0 {
        parts.push(format!("cpu {:.1}%", cpu));
    }
    if mem_kb > 0 {
        parts.push(format!("mem {:.0}M", mem_kb as f64 / 1024.0));
    }
    if live.ctx_pct >= 0 {
        parts.push(format!("ctx {}%", live.ctx_pct));
    }
    if live.tool_count > 0 {
        parts.push(format!("tools {}", live.tool_count));
    }
    if let Some(last_tool) = live.last_tool.as_deref().filter(|s| !s.is_empty()) {
        parts.push(format!("last {last_tool}"));
    }
    if let Some(pid) = row.pid {
        parts.push(format!("pid {pid}"));
    }
    if let Some(catalog) = row.catalog.as_deref().filter(|s| !s.is_empty()) {
        parts.push(format!("catalog {}", truncate_left(catalog, 34)));
    }
    parts.join("  ")
}

fn render_summary(rows: &[Row]) -> String {
    let pinned = rows.iter().filter(|r| r.pinned).count();
    let unpinned = rows.len().saturating_sub(pinned);
    let active = rows
        .iter()
        .filter(|row| {
            let live = live_for(&row.file_path);
            let status = infer_status(row.pid.is_some(), &live, &row.title);
            is_active_status(&status)
        })
        .count();
    if unpinned > 0 {
        format!("{pinned} pinned · {unpinned} unpinned · {active} active")
    } else {
        format!("{pinned} pinned · {active} active")
    }
}

fn terminal_width() -> usize {
    crossterm::terminal::size()
        .map(|(w, _)| w as usize)
        .unwrap_or(100)
}

fn truncate_chars(value: &str, max: usize) -> String {
    if max == 0 {
        return String::new();
    }
    let count = value.chars().count();
    if count <= max {
        return value.to_string();
    }
    let prefix: String = value.chars().take(max.saturating_sub(1)).collect();
    format!("{prefix}…")
}

fn truncate_left(value: &str, max: usize) -> String {
    if max == 0 {
        return String::new();
    }
    let count = value.chars().count();
    if count <= max {
        return value.to_string();
    }
    let suffix: String = value.chars().skip(count.saturating_sub(max.saturating_sub(1))).collect();
    format!("…{suffix}")
}

fn status_symbol(status: &str) -> ColoredString {
    match status {
        "busy" => "●".yellow().bold(),
        "permission" => "!".red().bold(),
        "waiting" => "○".blue().bold(),
        "idle" => "●".green().bold(),
        "running" => "●".cyan().bold(),
        "stopped" => "·".bright_black(),
        _ => "?".bright_black(),
    }
}

fn style_status(status: &str) -> ColoredString {
    match status {
        "busy" => status.yellow().bold(),
        "permission" => status.red().bold(),
        "waiting" => status.blue().bold(),
        "idle" => status.green(),
        "running" => status.cyan(),
        "stopped" => status.bright_black(),
        _ => status.bright_black(),
    }
}

/// Build the snapshot: pinned sessions first (filtered by catalog), then
/// optionally unpinned sessions, finally merge with running-agent
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
                model: String::new(),
                project: b.project_path.clone(),
                title: if b.title.is_empty() { b.first_prompt.clone() } else { b.title.clone() },
                pinned: true,
                catalog,
                file_path: None, // resolved via index below
                pid: None,
            }
        })
        .collect();

    let indexed_sessions = load_session_index()
        .map(|idx| idx.sessions)
        .unwrap_or_default();

    enrich_rows_from_index(&mut pinned_rows, &indexed_sessions);
    dedupe_rows_by_session_id(&mut pinned_rows);

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
                    provider: s.provider.clone(),
                    model: s.model.clone(),
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

    if include_recent {
        // Include running sessions that are not pinned and not in the recent
        // slice only when unpinned sessions were explicitly requested.
        let mut seen: HashSet<String> = rows.iter().map(|r| r.session_id.clone()).collect();
        for (sid, info) in detected {
            if seen.contains(&sid) {
                continue;
            }
            seen.insert(sid.clone());
            rows.push(Row {
                session_id: sid,
                provider: info.provider,
                model: String::new(),
                project: info.project_path.unwrap_or_default(),
                title: "running session".to_string(),
                pinned: false,
                catalog: None,
                file_path: info.file_path,
                pid: info.pid,
            });
        }
    }

    Ok(rows)
}

fn enrich_rows_from_index(rows: &mut [Row], sessions: &[SessionMeta]) {
    for row in rows {
        let Some(meta) = find_indexed_session(sessions, &row.session_id) else {
            continue;
        };
        row.session_id = meta.session_id.clone();
        if row.provider.is_empty() {
            row.provider = meta.provider.clone();
        }
        if row.model.is_empty() {
            row.model = meta.model.clone();
        }
        if row.project.is_empty() {
            row.project = meta.project_path.clone();
        }
        if row.title.is_empty() || row.title == "-" {
            row.title = meta.custom_title.clone()
                .filter(|t| !t.trim().is_empty())
                .unwrap_or_else(|| meta.first_prompt.clone());
        }
        if row.file_path.is_none() && !meta.file_path.is_empty() {
            row.file_path = Some(meta.file_path.clone());
        }
    }
}

fn find_indexed_session<'a>(sessions: &'a [SessionMeta], session_id: &str) -> Option<&'a SessionMeta> {
    sessions.iter()
        .find(|s| s.session_id == session_id)
        .or_else(|| sessions.iter().find(|s| match_session_id(&s.session_id, session_id)))
}

fn dedupe_rows_by_session_id(rows: &mut Vec<Row>) {
    let mut seen = HashSet::new();
    rows.retain(|row| seen.insert(row.session_id.to_lowercase()));
}

fn watch_json(catalog_filter: Option<&str>, include_recent: bool, pinned_limit: usize) -> Result<()> {
    let interval_ms: u64 = 3000;
    install_ctrlc_handler();
    reset_cpu_sampler();

    while !ctrlc_flag() {
        clear_session_metrics_cache();
        let rows = build_snapshot(catalog_filter, include_recent, pinned_limit)?;
        let json = serde_json::to_string(&MonitorSnapshot::from_rows(&rows))?;
        if !write_stdout_line(&json)? {
            break;
        }

        let mut remaining = interval_ms;
        while remaining > 0 && !ctrlc_flag() {
            let step = remaining.min(100);
            std::thread::sleep(Duration::from_millis(step));
            remaining = remaining.saturating_sub(step);
        }
    }

    Ok(())
}

fn write_stdout_line(line: &str) -> Result<bool> {
    let mut stdout = io::stdout();
    match writeln!(stdout, "{line}") {
        Ok(()) => Ok(true),
        Err(err) if err.kind() == io::ErrorKind::BrokenPipe => Ok(false),
        Err(err) => Err(err.into()),
    }
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
            "starling top".cyan().bold(),
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
