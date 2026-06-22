//! `starling top` — live monitor.

use std::collections::HashSet;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use anyhow::{bail, Result};
use colored::*;
use serde_json::Value;

use crate::cli::{MonitorCommand, TopAction, TopCommand};
use crate::core::catalog_resolver::{catalog_path, resolve_catalog_reference};
use crate::core::discovery::{canonical_session_id, match_session_id};
use crate::core::osc_state::{
    clear_osc_state, normalize_status, prune_stale_osc_state, recent_osc_state,
    status_from_osc0_title, status_from_osc94_progress, status_from_osc_sequence, upsert_osc_state,
    OscSessionState,
};
use crate::core::process_metrics::{get_process_tree_metrics, reset_cpu_sampler};
use crate::core::runs::{detect_running_sessions, reconcile_stale_runs};
use crate::core::session_display::short_session_id;
use crate::core::session_index::load_session_index;
use crate::core::session_metrics::{
    clear_session_metrics_cache, get_session_live_metrics, SessionLive,
};
use crate::core::store::{list_bookmarks, list_spaces, BookmarkFilter};
use crate::types::{Bookmark, SessionMeta};

const WATCH_INTERVAL_MS: u64 = 1000;
const EDGE_RUNNING_LEASE_MS: u64 = 15 * 1000;
const HOOK_RUNNING_STALE_MS: u64 = 30 * 60 * 1000;
const LIVE_RUNNING_STALE_MS: u64 = 30 * 60 * 1000;
pub fn handle(cmd: TopCommand) -> Result<()> {
    match cmd.action {
        Some(TopAction::Record {
            session_id,
            status,
            title,
            sequence,
            progress,
            pid,
            run_id,
            message,
            source,
            json,
        }) => record_runtime_state(
            session_id, status, title, sequence, progress, pid, run_id, message, source, json,
        ),
        Some(TopAction::Clear {
            session_id,
            pid,
            json,
        }) => clear_runtime_state(session_id, pid, json),
        Some(TopAction::Hook {
            provider,
            event,
            run_id,
            hook_file,
            pid,
            json,
        }) => record_agent_hook_event(provider, event, run_id, hook_file, pid, json),
        None => render_monitor(cmd.monitor),
    }
}

fn render_monitor(cmd: MonitorCommand) -> Result<()> {
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
        println!(
            "{}",
            "Tip: use --unpin to include unpinned sessions.".normal()
        );
        return Ok(());
    }

    println!("{}", render_table(&rows));
    Ok(())
}

fn record_runtime_state(
    session_id: String,
    status: Option<String>,
    title: Option<String>,
    sequence: Option<String>,
    progress: Option<u8>,
    pid: Option<u32>,
    run_id: Option<String>,
    mut message: Option<String>,
    source: String,
    json: bool,
) -> Result<()> {
    let (resolved_status, parsed_source, parsed_message) = resolve_recorded_status(
        status.as_deref(),
        title.as_deref(),
        sequence.as_deref(),
        progress,
    )?;
    if message.is_none() {
        message = parsed_message;
    }
    let state = OscSessionState {
        session_id,
        pid,
        run_id,
        status: resolved_status,
        message,
        source: if source == "manual" {
            parsed_source
        } else {
            source
        },
        updated_at_ms: now_ms(),
    };
    let store = upsert_osc_state(state.clone())?;
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "ok": true,
                "action": "top.record",
                "data": {
                    "state": state,
                    "count": store.sessions.len(),
                }
            }))?
        );
    } else {
        println!(
            "{} {} {}",
            "recorded".green(),
            state.session_id.cyan(),
            state.status.bold()
        );
    }
    Ok(())
}

fn clear_runtime_state(session_id: String, pid: Option<u32>, json: bool) -> Result<()> {
    let store = clear_osc_state(&session_id, pid)?;
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "ok": true,
                "action": "top.clear",
                "data": {
                    "session_id": session_id,
                    "pid": pid,
                    "count": store.sessions.len(),
                }
            }))?
        );
    } else {
        println!("{} {}", "cleared".green(), session_id.cyan());
    }
    Ok(())
}

fn record_agent_hook_event(
    provider: String,
    event: Option<String>,
    run_id: Option<String>,
    hook_file: Option<String>,
    pid: Option<u32>,
    json: bool,
) -> Result<()> {
    let mut raw = String::new();
    io::stdin().read_to_string(&mut raw)?;
    if let Some(path) = hook_file.as_deref().filter(|p| !p.trim().is_empty()) {
        append_hook_event(path, &raw)?;
    }
    let value: Value = serde_json::from_str(raw.trim()).unwrap_or(Value::Null);
    let Some(session_id) = hook_session_id(&value) else {
        return Ok(());
    };
    let event = value
        .get("hook_event_name")
        .and_then(|v| v.as_str())
        .or_else(|| value.get("hookEventName").and_then(|v| v.as_str()))
        .or(event.as_deref())
        .unwrap_or("AgentHook");
    let Some(status) = status_from_agent_hook_event(event, &value) else {
        return Ok(());
    };
    let message = hook_message(event, &value);
    let state = OscSessionState {
        session_id,
        pid,
        run_id,
        status: status.to_string(),
        message,
        source: format!("{}-hook:{event}", provider.trim().to_lowercase()),
        updated_at_ms: now_ms(),
    };
    let store = upsert_osc_state(state.clone())?;
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "ok": true,
                "action": "top.hook",
                "data": {
                    "state": state,
                    "count": store.sessions.len(),
                }
            }))?
        );
    }
    Ok(())
}

fn hook_session_id(value: &Value) -> Option<String> {
    for key in ["session_id", "sessionId", "thread_id", "threadId"] {
        if let Some(session_id) = value
            .get(key)
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            return Some(session_id.to_string());
        }
    }
    value
        .pointer("/session/id")
        .or_else(|| value.pointer("/payload/session_id"))
        .or_else(|| value.pointer("/payload/sessionId"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
}

fn append_hook_event(path: &str, raw: &str) -> Result<()> {
    let path = Path::new(path);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(());
    }
    file.write_all(trimmed.as_bytes())?;
    file.write_all(b"\n")?;
    Ok(())
}

fn status_from_agent_hook_event<'a>(event: &str, value: &Value) -> Option<&'a str> {
    match event {
        "SessionStart" => Some("idle"),
        "UserPromptSubmit" => Some("running"),
        "PreToolUse" => Some("running"),
        "PermissionRequest" => Some("waiting"),
        "Notification" if is_idle_notification(value) => Some("idle"),
        "Notification" => Some("waiting"),
        "Elicitation" => Some("waiting"),
        "ElicitationResult" => Some("running"),
        "PostToolUse" | "PostToolUseFailure" | "PostToolBatch" => Some("running"),
        "SubagentStart" => Some("running"),
        "SubagentStop" => Some("running"),
        "TaskCreated" => Some("running"),
        "TaskCompleted" => Some("running"),
        "Stop" if has_running_background_task(value) => Some("running"),
        "Stop" | "TeammateIdle" => Some("idle"),
        "StopFailure" => Some("failure"),
        "SessionEnd" => Some("stopped"),
        _ => {
            let message = value.get("message").and_then(|v| v.as_str()).unwrap_or("");
            if text_looks_like_waiting_prompt(message)
                || message.to_lowercase().contains("permission")
                || message.to_lowercase().contains("waiting")
            {
                Some("waiting")
            } else {
                None
            }
        }
    }
}

fn has_running_background_task(value: &Value) -> bool {
    value
        .get("background_tasks")
        .and_then(|v| v.as_array())
        .map(|tasks| {
            tasks.iter().any(|task| {
                task.get("status")
                    .and_then(|v| v.as_str())
                    .map(|status| status.eq_ignore_ascii_case("running"))
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

fn is_idle_notification(value: &Value) -> bool {
    let notification_type = value
        .get("notification_type")
        .or_else(|| value.get("notificationType"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if notification_type.eq_ignore_ascii_case("idle_prompt") {
        return true;
    }
    value
        .get("message")
        .and_then(|v| v.as_str())
        .map(|message| message.eq_ignore_ascii_case("Claude is waiting for your input"))
        .unwrap_or(false)
}

fn hook_message(event: &str, value: &Value) -> Option<String> {
    let tool = value.get("tool_name").and_then(|v| v.as_str());
    let message = value.get("message").and_then(|v| v.as_str());
    let notification_type = value
        .get("notification_type")
        .or_else(|| value.get("notificationType"))
        .and_then(|v| v.as_str());
    let agent = value.get("agent_type").and_then(|v| v.as_str());
    let text = match (tool, message, notification_type, agent) {
        (Some(tool), _, _, _) => format!("{event} {tool}"),
        (_, Some(message), Some(kind), _) if !message.trim().is_empty() => {
            format!("{kind}: {}", message.trim())
        }
        (_, Some(message), _, _) if !message.trim().is_empty() => message.trim().to_string(),
        (_, _, _, Some(agent)) => format!("{event} {agent}"),
        _ => event.to_string(),
    };
    Some(text)
}

fn resolve_recorded_status(
    status: Option<&str>,
    title: Option<&str>,
    sequence: Option<&str>,
    progress: Option<u8>,
) -> Result<(String, String, Option<String>)> {
    if let Some(status) = status.and_then(normalize_status) {
        return Ok((status, "manual".to_string(), None));
    }
    if let Some((status, source, message)) = sequence.and_then(status_from_osc_sequence) {
        return Ok((status, source, message));
    }
    if let Some(status) = title.and_then(status_from_osc0_title) {
        return Ok((status, "osc0".to_string(), title.map(|s| s.to_string())));
    }
    if let Some(status) = progress.and_then(status_from_osc94_progress) {
        return Ok((status, "osc9;4".to_string(), None));
    }
    bail!("status is required unless --sequence, --title, or --progress contains a known OSC state")
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
    canonical_session_id: String,
    pinned: bool,
    catalog: Option<String>,
    title: String,
    provider: String,
    model: String,
    status: String,
    status_source: String,
    status_realtime: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    status_signal: Option<String>,
    status_updated_at_ms: u64,
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
    activity_status: Option<String>,
    activity_signal: Option<String>,
    activity_since_ms: u64,
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
        let (cpu, mem_kb, process_count, background_task_count) = process_for(r.pid);
        let now_ms = now_ms();
        let osc = recent_osc_state(&r.session_id, r.pid, now_ms);
        let effective_hook = effective_hook_state(osc.as_ref());
        let inferred = infer_status_with_runtime(
            r.pid.is_some(),
            &live,
            &r.title,
            &r.provider,
            effective_hook,
            now_ms,
            process_count,
            cpu,
            background_task_count,
        );
        let status_realtime = inferred.realtime;
        let status_source = if status_realtime {
            "realtime".to_string()
        } else {
            "process".to_string()
        };
        let status_updated_at_ms = effective_hook.map(|s| s.updated_at_ms).unwrap_or(0);
        let started_at_ms = live.started_at_ms;
        let elapsed_secs = if started_at_ms > 0 && now_ms > started_at_ms {
            (now_ms - started_at_ms) / 1000
        } else {
            0
        };
        RowJson {
            session_id: r.session_id.clone(),
            canonical_session_id: canonical_session_id(&r.session_id),
            pinned: r.pinned,
            catalog: r.catalog.clone(),
            title: r.title.clone(),
            provider: r.provider.clone(),
            model: if live.model.is_empty() {
                r.model.clone()
            } else {
                live.model.clone()
            },
            status: inferred.status,
            status_source,
            status_realtime,
            status_signal: inferred.signal,
            status_updated_at_ms,
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
            activity_status: live.activity_status.clone(),
            activity_signal: live.activity_signal.clone(),
            activity_since_ms: live.activity_since_ms,
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

fn process_for(pid: Option<u32>) -> (f64, u64, usize, usize) {
    if let Some(p) = pid.filter(|&p| p > 0) {
        let m = get_process_tree_metrics(p);
        (m.cpu_pct, m.mem_kb, m.pids.len(), m.background_task_count)
    } else {
        (0.0, 0, 0, 0)
    }
}

fn live_for(file_path: &Option<String>) -> SessionLive {
    match file_path.as_deref() {
        Some(path) => {
            let path = Path::new(path);
            let mut live = get_session_live_metrics(path);
            merge_latest_subagent_live(path, &mut live);
            live
        }
        None => SessionLive {
            ctx_pct: -1,
            ..Default::default()
        },
    }
}

fn merge_latest_subagent_live(parent_path: &Path, live: &mut SessionLive) {
    let Some(subagent_path) = latest_subagent_jsonl(parent_path) else {
        return;
    };
    let sub_live = get_session_live_metrics(&subagent_path);
    if sub_live.last_activity_ms <= live.last_activity_ms {
        return;
    }

    if live.model.is_empty() && !sub_live.model.is_empty() {
        live.model = sub_live.model.clone();
    }
    let parent_active =
        live.pending_since_ms > 0 || live.thinking_since_ms > 0 || !live.current_task.is_empty();
    let sub_active = sub_live.pending_since_ms > 0
        || sub_live.thinking_since_ms > 0
        || !sub_live.current_task.is_empty();
    live.last_activity_ms = sub_live.last_activity_ms;
    if sub_active || !parent_active {
        live.pending_since_ms = sub_live.pending_since_ms;
        live.thinking_since_ms = sub_live.thinking_since_ms;
        live.current_task = sub_live.current_task.clone();
        live.last_tool = sub_live
            .last_tool
            .clone()
            .or_else(|| live.last_tool.clone());
    }
    live.tool_count = live.tool_count.saturating_add(sub_live.tool_count);
    if sub_active || live.tool_calls_tail.is_empty() {
        live.tool_calls_tail = sub_live.tool_calls_tail.clone();
    }
    if sub_active || live.chat_tail.is_empty() {
        live.chat_tail = sub_live.chat_tail.clone();
    }
}

fn latest_subagent_jsonl(parent_path: &Path) -> Option<PathBuf> {
    let subagents_dir = parent_path.with_extension("").join("subagents");
    let entries = std::fs::read_dir(subagents_dir).ok()?;
    entries
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                return None;
            }
            let mtime = entry.metadata().ok()?.modified().ok()?;
            let ms = mtime
                .duration_since(std::time::UNIX_EPOCH)
                .ok()?
                .as_millis() as u64;
            Some((ms, path))
        })
        .max_by_key(|(ms, _)| *ms)
        .map(|(_, path)| path)
}

fn now_ms() -> u64 {
    chrono::Utc::now().timestamp_millis().max(0) as u64
}

fn effective_hook_state(osc: Option<&OscSessionState>) -> Option<&OscSessionState> {
    let state = osc?;
    if is_runtime_state_source(&state.source) {
        Some(state)
    } else {
        None
    }
}

fn is_runtime_state_source(source: &str) -> bool {
    source.contains("-hook:") || source.contains("-pty:")
}

#[derive(Clone)]
struct StatusGuess {
    status: String,
    signal: Option<String>,
    realtime: bool,
}

#[cfg(test)]
fn infer_status(
    process_alive: bool,
    _live: &SessionLive,
    _title: &str,
    hook: Option<&OscSessionState>,
    now_ms: u64,
    _process_count: usize,
) -> StatusGuess {
    infer_status_from_hook(process_alive, hook, now_ms)
}

fn infer_status_from_hook(
    process_alive: bool,
    hook: Option<&OscSessionState>,
    now_ms: u64,
) -> StatusGuess {
    if let Some(state) = hook {
        if !process_alive && matches!(state.status.as_str(), "running" | "waiting") {
            return status_guess("stopped", Some("process_missing"), false);
        }
        if is_legacy_idle_notification_state(state) {
            return status_guess("idle", Some(&state.source), true);
        }
        if state.status == "running"
            && now_ms.saturating_sub(state.updated_at_ms) > HOOK_RUNNING_STALE_MS
        {
            return status_guess("stale_running", Some(&state.source), true);
        }
        return status_guess(&state.status, Some(&state.source), true);
    }
    if process_alive {
        status_guess("idle", Some("process_alive"), false)
    } else {
        status_guess("stopped", None, false)
    }
}

fn is_legacy_idle_notification_state(state: &OscSessionState) -> bool {
    state.source == "claude-hook:Notification"
        && state.status == "waiting"
        && state
            .message
            .as_deref()
            .map(|message| {
                message.eq_ignore_ascii_case("Claude is waiting for your input")
                    || message
                        .to_ascii_lowercase()
                        .starts_with("idle_prompt: claude is waiting for your input")
            })
            .unwrap_or(false)
}

fn infer_status_with_runtime(
    process_alive: bool,
    live: &SessionLive,
    _title: &str,
    _provider: &str,
    hook: Option<&OscSessionState>,
    now_ms: u64,
    _process_count: usize,
    _cpu_pct: f64,
    background_task_count: usize,
) -> StatusGuess {
    if let Some(state) = hook {
        if !process_alive && matches!(state.status.as_str(), "running" | "waiting") {
            return status_guess("stopped", Some("process_missing"), false);
        }
        if is_expired_edge_running(state, live, now_ms, background_task_count) {
            return status_guess("idle", Some(&state.source), true);
        }
        if state.status != "running" {
            return infer_status_from_hook(process_alive, hook, now_ms);
        }
    }
    if is_live_aborted(live) {
        if !process_alive {
            return status_guess("stopped", Some("process_missing"), false);
        }
        return status_guess(
            "aborted",
            live.activity_signal
                .as_deref()
                .or(Some("codex_turn_aborted")),
            true,
        );
    }
    if process_alive && is_fresh_live_running(live, now_ms) {
        return status_guess(
            "running",
            live.activity_signal.as_deref().or(Some("live_activity")),
            true,
        );
    }
    infer_status_from_hook(process_alive, hook, now_ms)
}

fn is_live_aborted(live: &SessionLive) -> bool {
    live.activity_status.as_deref() == Some("aborted")
        || live.activity_signal.as_deref() == Some("codex_turn_aborted")
}

fn is_live_running(live: &SessionLive) -> bool {
    live.activity_status.as_deref() == Some("running")
}

fn is_fresh_live_running(live: &SessionLive, now_ms: u64) -> bool {
    is_live_running(live)
        && live.activity_since_ms > 0
        && now_ms.saturating_sub(live.activity_since_ms) <= LIVE_RUNNING_STALE_MS
}

fn is_expired_edge_running(
    state: &OscSessionState,
    live: &SessionLive,
    now_ms: u64,
    background_task_count: usize,
) -> bool {
    state.status == "running"
        && is_edge_running_source(&state.source)
        && now_ms.saturating_sub(state.updated_at_ms) > EDGE_RUNNING_LEASE_MS
        && background_task_count == 0
        && live.pending_since_ms == 0
        && live.current_task.trim().is_empty()
}

fn is_edge_running_source(source: &str) -> bool {
    source.ends_with(":UserPromptSubmit")
        || source.ends_with(":PreToolUse")
        || source.ends_with(":PostToolUse")
}

fn text_looks_like_waiting_prompt(text: &str) -> bool {
    let lower = text.to_lowercase();
    if lower.trim().is_empty() {
        return false;
    }
    lower.contains("do you want to proceed")
        || lower.contains("would you like to proceed")
        || lower.contains("do you want to continue")
        || lower.contains("would you like to continue")
        || lower.contains("waiting for input")
        || lower.contains("waiting for approval")
        || lower.contains("permission approval")
        || lower.contains("requires approval")
        || lower.contains("requires your approval")
        || lower.contains("needs your approval")
        || lower.contains("approve this")
        || lower.contains("1. yes")
        || lower.contains("2. no")
        || lower.contains("是否继续")
        || lower.contains("等待用户")
        || lower.contains("等待确认")
        || lower.contains("需要确认")
        || lower.contains("需要批准")
}

fn status_guess(status: &str, signal: Option<&str>, realtime: bool) -> StatusGuess {
    StatusGuess {
        status: status.to_string(),
        signal: signal.map(|s| s.to_string()),
        realtime,
    }
}

fn is_active_status(status: &str) -> bool {
    matches!(status, "waiting" | "running")
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
    let (cpu, mem_kb, process_count, background_task_count) = process_for(row.pid);
    let now_ms = now_ms();
    let osc = recent_osc_state(&row.session_id, row.pid, now_ms);
    let effective_hook = effective_hook_state(osc.as_ref());
    let inferred = infer_status_with_runtime(
        row.pid.is_some(),
        &live,
        &row.title,
        &row.provider,
        effective_hook,
        now_ms,
        process_count,
        cpu,
        background_task_count,
    );
    let status = inferred.status;
    let status_padding = " ".repeat(10usize.saturating_sub(status.chars().count()));
    let status_cell = format!(
        "{} {}{}",
        status_symbol(&status),
        style_status(&status),
        status_padding
    );
    let agent = if row.provider.is_empty() {
        "-"
    } else {
        row.provider.as_str()
    };
    let model = if !live.model.is_empty() {
        live.model.as_str()
    } else if !row.model.is_empty() {
        row.model.as_str()
    } else {
        "-"
    };
    let session = short_session_id(&row.session_id);
    let title = if row.title.trim().is_empty() {
        "-"
    } else {
        row.title.trim()
    };

    let fixed = format!(
        "{} {:<7} {:<15} {:<14} ",
        status_cell,
        truncate_chars(agent, 7),
        truncate_chars(model, 15),
        session,
    );
    let title_width = width.saturating_sub(54).max(18);
    let line1 = format!("{}{}", fixed, truncate_chars(title, title_width));

    let metrics = render_metrics(
        &status,
        &live,
        cpu,
        mem_kb,
        row,
        effective_hook,
        inferred.signal.as_deref(),
    );
    if metrics.is_empty() {
        vec![line1]
    } else {
        let line2 = format!("  {}", truncate_chars(&metrics, width.saturating_sub(2)))
            .bright_black()
            .to_string();
        vec![line1, line2]
    }
}

fn render_metrics(
    _status: &str,
    live: &SessionLive,
    cpu: f64,
    mem_kb: u64,
    row: &Row,
    osc: Option<&OscSessionState>,
    signal: Option<&str>,
) -> String {
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
    if let Some(state) = osc {
        parts.push(format!("osc {}", state.source));
    } else if let Some(signal) = signal {
        parts.push(format!("signal {signal}"));
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
            let now_ms = now_ms();
            let osc = recent_osc_state(&row.session_id, row.pid, now_ms);
            let effective_hook = effective_hook_state(osc.as_ref());
            let (cpu, _mem_kb, process_count, background_task_count) = process_for(row.pid);
            let inferred = infer_status_with_runtime(
                row.pid.is_some(),
                &live,
                &row.title,
                &row.provider,
                effective_hook,
                now_ms,
                process_count,
                cpu,
                background_task_count,
            );
            is_active_status(&inferred.status)
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
    let suffix: String = value
        .chars()
        .skip(count.saturating_sub(max.saturating_sub(1)))
        .collect();
    format!("…{suffix}")
}

fn status_symbol(status: &str) -> ColoredString {
    match status {
        "waiting" => "○".blue().bold(),
        "idle" => "●".green().bold(),
        "running" => "●".cyan().bold(),
        "stale_running" => "◐".yellow().bold(),
        "aborted" => "×".yellow().bold(),
        "failure" => "×".red().bold(),
        "stopped" => "·".bright_black(),
        _ => "?".bright_black(),
    }
}

fn style_status(status: &str) -> ColoredString {
    match status {
        "waiting" => status.blue().bold(),
        "idle" => status.green(),
        "running" => status.cyan(),
        "stale_running" => status.yellow(),
        "aborted" => status.yellow().bold(),
        "failure" => status.red().bold(),
        "stopped" => status.bright_black(),
        _ => status.bright_black(),
    }
}

/// Build the snapshot: pinned sessions first (filtered by catalog), then
/// optionally unpinned sessions, finally merge with running-agent
/// detection to attach pid + live metrics where available.
fn build_snapshot(
    catalog_filter: Option<&str>,
    include_recent: bool,
    pinned_limit: usize,
) -> Result<Vec<Row>> {
    reconcile_stale_runs();
    let _ = prune_stale_osc_state(now_ms());

    // Resolve catalog filter (if any) → space id
    let target_space_id = if let Some(c) = catalog_filter {
        match resolve_catalog_reference(c) {
            crate::core::catalog_resolver::CatalogResolution::Found(s) => Some(s.id),
            crate::core::catalog_resolver::CatalogResolution::Ambiguous(matches) => {
                eprintln!(
                    "{}: ambiguous catalog '{}': {}",
                    "error".red(),
                    c,
                    matches
                        .iter()
                        .map(|s| s.name.clone())
                        .collect::<Vec<_>>()
                        .join(", ")
                );
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
    let spaces = list_spaces();
    let mut bookmarks: Vec<Bookmark> = list_bookmarks(BookmarkFilter::default())
        .into_iter()
        .filter(|b| {
            target_space_id
                .as_ref()
                .map(|id| b.space_ids.contains(id))
                .unwrap_or(true)
        })
        .collect();
    bookmarks.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    let mut pinned_rows: Vec<Row> = bookmarks
        .iter()
        .take(pinned_limit)
        .map(|b| {
            let catalog = b
                .space_ids
                .iter()
                .filter_map(|sid| spaces.iter().find(|s| &s.id == sid))
                .map(|s| catalog_path(s, Some(&spaces)))
                .next();
            Row {
                session_id: b.session_id.clone(),
                provider: b.provider.clone(),
                model: String::new(),
                project: b.project_path.clone(),
                title: if b.title.is_empty() {
                    b.first_prompt.clone()
                } else {
                    b.title.clone()
                },
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
            let pinned_ids: std::collections::HashSet<String> = rows
                .iter()
                .map(|r| canonical_session_id(&r.session_id))
                .collect();
            let mut recent: Vec<Row> = idx
                .sessions
                .iter()
                .filter(|s| !pinned_ids.contains(&canonical_session_id(&s.session_id)))
                .take(50)
                .map(|s| Row {
                    session_id: s.session_id.clone(),
                    provider: s.provider.clone(),
                    model: s.model.clone(),
                    project: s.project_path.clone(),
                    title: if s.first_prompt.is_empty() {
                        "-".into()
                    } else {
                        s.first_prompt.clone()
                    },
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
        let row_key = canonical_session_id(&row.session_id);
        let info = detected.get(&row.session_id).or_else(|| {
            detected
                .iter()
                .find(|(sid, _)| canonical_session_id(sid) == row_key)
                .map(|(_, info)| info)
        });
        if let Some(info) = info {
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
        let mut seen: HashSet<String> = rows
            .iter()
            .map(|r| canonical_session_id(&r.session_id))
            .collect();
        for (sid, info) in detected {
            let sid_key = canonical_session_id(&sid);
            if seen.contains(&sid_key) {
                continue;
            }
            seen.insert(sid_key);
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
            row.title = meta
                .custom_title
                .clone()
                .filter(|t| !t.trim().is_empty())
                .unwrap_or_else(|| meta.first_prompt.clone());
        }
        if row.file_path.is_none() && !meta.file_path.is_empty() {
            row.file_path = Some(meta.file_path.clone());
        }
    }
}

fn find_indexed_session<'a>(
    sessions: &'a [SessionMeta],
    session_id: &str,
) -> Option<&'a SessionMeta> {
    sessions
        .iter()
        .find(|s| s.session_id == session_id)
        .or_else(|| {
            sessions
                .iter()
                .find(|s| match_session_id(&s.session_id, session_id))
        })
}

fn dedupe_rows_by_session_id(rows: &mut Vec<Row>) {
    let mut seen = HashSet::new();
    rows.retain(|row| seen.insert(row.session_id.to_lowercase()));
}

fn watch_json(
    catalog_filter: Option<&str>,
    include_recent: bool,
    pinned_limit: usize,
) -> Result<()> {
    let interval_ms: u64 = WATCH_INTERVAL_MS;
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
    let interval_ms: u64 = WATCH_INTERVAL_MS;
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
        let refresh_secs = interval_ms as f64 / 1000.0;
        let _ = io::stdout().write_all(
            format!(
                "{} {}  ({} sessions · refresh {:.1}s · Ctrl-C to exit)\n\n",
                "starling top".cyan().bold(),
                now.to_string().normal(),
                rows.len(),
                refresh_secs,
            )
            .as_bytes(),
        );
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

#[cfg(test)]
mod hook_status_tests {
    use super::*;

    fn hook_state(status: &str, source: &str) -> OscSessionState {
        OscSessionState {
            session_id: "s".to_string(),
            pid: None,
            run_id: None,
            status: status.to_string(),
            message: None,
            source: source.to_string(),
            updated_at_ms: 1_000,
        }
    }

    #[test]
    fn claude_hook_events_map_to_session_states() {
        let empty = serde_json::json!({});
        assert_eq!(
            status_from_agent_hook_event("UserPromptSubmit", &empty),
            Some("running")
        );
        assert_eq!(
            status_from_agent_hook_event("PreToolUse", &empty),
            Some("running")
        );
        assert_eq!(
            status_from_agent_hook_event("PermissionRequest", &empty),
            Some("waiting")
        );
        assert_eq!(
            status_from_agent_hook_event("Notification", &empty),
            Some("waiting")
        );
        assert_eq!(
            status_from_agent_hook_event(
                "Notification",
                &serde_json::json!({
                    "notification_type": "idle_prompt",
                    "message": "Claude is waiting for your input"
                })
            ),
            Some("idle")
        );
        assert_eq!(
            status_from_agent_hook_event("SessionStart", &empty),
            Some("idle")
        );
        assert_eq!(status_from_agent_hook_event("Stop", &empty), Some("idle"));
        assert_eq!(
            status_from_agent_hook_event("StopFailure", &empty),
            Some("failure")
        );
        assert_eq!(
            status_from_agent_hook_event("SessionEnd", &empty),
            Some("stopped")
        );
    }

    #[test]
    fn stop_with_running_background_task_stays_running() {
        let value = serde_json::json!({
            "background_tasks": [
                { "status": "finished" },
                { "status": "running" }
            ]
        });
        assert_eq!(
            status_from_agent_hook_event("Stop", &value),
            Some("running")
        );
    }

    #[test]
    fn hook_state_is_authoritative_over_transcript_runtime_and_cpu() {
        let live = SessionLive {
            pending_since_ms: 1_000,
            thinking_since_ms: 1_000,
            current_task: "Do you want to proceed?\n1. Yes\n2. No".to_string(),
            ..Default::default()
        };
        let state = hook_state("idle", "claude-hook:SessionStart");

        let guess =
            infer_status_with_runtime(true, &live, "", "claude", Some(&state), 10_000, 99, 50.0, 2);

        assert_eq!(guess.status, "idle");
        assert_eq!(guess.signal.as_deref(), Some("claude-hook:SessionStart"));
        assert!(guess.realtime);
    }

    #[test]
    fn explicit_realtime_non_running_overrides_fresh_transcript_running() {
        let live = SessionLive {
            activity_status: Some("running".to_string()),
            activity_signal: Some("claude_tool_use".to_string()),
            activity_since_ms: 10_000,
            pending_since_ms: 10_000,
            current_task: "Bash ls -la".to_string(),
            ..Default::default()
        };
        let state = OscSessionState {
            session_id: "s".to_string(),
            pid: None,
            run_id: None,
            status: "idle".to_string(),
            message: Some("ready".to_string()),
            source: "claude-pty:osc0".to_string(),
            updated_at_ms: 10_500,
        };

        let guess =
            infer_status_with_runtime(true, &live, "", "claude", Some(&state), 11_000, 1, 0.0, 0);

        assert_eq!(guess.status, "idle");
        assert_eq!(guess.signal.as_deref(), Some("claude-pty:osc0"));
        assert!(guess.realtime);
    }

    #[test]
    fn fresh_running_hook_stays_running_even_without_new_runtime_signals() {
        let live = SessionLive::default();
        let state = OscSessionState {
            session_id: "s".to_string(),
            pid: None,
            run_id: None,
            status: "running".to_string(),
            message: None,
            source: "codex-hook:SubagentStart".to_string(),
            updated_at_ms: 10_000,
        };

        let guess = infer_status_with_runtime(
            true,
            &live,
            "",
            "codex",
            Some(&state),
            10_000 + HOOK_RUNNING_STALE_MS,
            1,
            0.0,
            0,
        );

        assert_eq!(guess.status, "running");
        assert_eq!(guess.signal.as_deref(), Some("codex-hook:SubagentStart"));
    }

    #[test]
    fn old_running_hook_becomes_stale_running_not_idle() {
        let live = SessionLive::default();
        let state = OscSessionState {
            session_id: "s".to_string(),
            pid: None,
            run_id: None,
            status: "running".to_string(),
            message: None,
            source: "codex-hook:SubagentStart".to_string(),
            updated_at_ms: 10_000,
        };

        let guess = infer_status_with_runtime(
            true,
            &live,
            "",
            "codex",
            Some(&state),
            10_000 + HOOK_RUNNING_STALE_MS + 1,
            1,
            0.0,
            0,
        );

        assert_eq!(guess.status, "stale_running");
        assert_eq!(guess.signal.as_deref(), Some("codex-hook:SubagentStart"));
        assert!(guess.realtime);
    }

    #[test]
    fn expired_user_prompt_submit_without_runtime_activity_becomes_idle() {
        let live = SessionLive {
            thinking_since_ms: 10_000,
            ..Default::default()
        };
        let state = OscSessionState {
            session_id: "s".to_string(),
            pid: None,
            run_id: None,
            status: "running".to_string(),
            message: None,
            source: "claude-hook:UserPromptSubmit".to_string(),
            updated_at_ms: 10_000,
        };

        let guess = infer_status_with_runtime(
            true,
            &live,
            "",
            "claude",
            Some(&state),
            10_000 + EDGE_RUNNING_LEASE_MS + 1,
            1,
            0.0,
            0,
        );

        assert_eq!(guess.status, "idle");
        assert_eq!(
            guess.signal.as_deref(),
            Some("claude-hook:UserPromptSubmit")
        );
    }

    #[test]
    fn expired_pre_tool_use_without_runtime_activity_becomes_idle() {
        let live = SessionLive::default();
        let state = OscSessionState {
            session_id: "s".to_string(),
            pid: None,
            run_id: None,
            status: "running".to_string(),
            message: Some("PreToolUse Bash".to_string()),
            source: "claude-hook:PreToolUse".to_string(),
            updated_at_ms: 10_000,
        };

        let guess = infer_status_with_runtime(
            true,
            &live,
            "",
            "claude",
            Some(&state),
            10_000 + EDGE_RUNNING_LEASE_MS + 1,
            1,
            0.0,
            0,
        );

        assert_eq!(guess.status, "idle");
        assert_eq!(guess.signal.as_deref(), Some("claude-hook:PreToolUse"));
    }

    #[test]
    fn expired_post_tool_use_without_runtime_activity_becomes_idle() {
        let live = SessionLive::default();
        let state = OscSessionState {
            session_id: "s".to_string(),
            pid: None,
            run_id: None,
            status: "running".to_string(),
            message: Some("PostToolUse Bash".to_string()),
            source: "codex-hook:PostToolUse".to_string(),
            updated_at_ms: 10_000,
        };

        let guess = infer_status_with_runtime(
            true,
            &live,
            "",
            "codex",
            Some(&state),
            10_000 + EDGE_RUNNING_LEASE_MS + 1,
            1,
            0.0,
            0,
        );

        assert_eq!(guess.status, "idle");
        assert_eq!(guess.signal.as_deref(), Some("codex-hook:PostToolUse"));
    }

    #[test]
    fn codex_turn_aborted_overrides_edge_running_hook() {
        let live = SessionLive {
            activity_status: Some("aborted".to_string()),
            activity_signal: Some("codex_turn_aborted".to_string()),
            ..Default::default()
        };
        let state = OscSessionState {
            session_id: "s".to_string(),
            pid: None,
            run_id: None,
            status: "running".to_string(),
            message: Some("PostToolUse Bash".to_string()),
            source: "codex-hook:PostToolUse".to_string(),
            updated_at_ms: 10_000,
        };

        let guess =
            infer_status_with_runtime(true, &live, "", "codex", Some(&state), 10_000, 1, 0.0, 0);

        assert_eq!(guess.status, "aborted");
        assert_eq!(guess.signal.as_deref(), Some("codex_turn_aborted"));
        assert!(guess.realtime);
    }

    #[test]
    fn live_running_activity_marks_process_running_without_hook() {
        let live = SessionLive {
            activity_status: Some("running".to_string()),
            activity_signal: Some("claude_thinking".to_string()),
            activity_since_ms: 20_000,
            thinking_since_ms: 20_000,
            ..Default::default()
        };

        let guess = infer_status_with_runtime(true, &live, "", "claude", None, 20_000, 1, 0.0, 0);

        assert_eq!(guess.status, "running");
        assert_eq!(guess.signal.as_deref(), Some("claude_thinking"));
        assert!(guess.realtime);
    }

    #[test]
    fn stale_live_running_activity_without_hook_is_idle() {
        let live = SessionLive {
            activity_status: Some("running".to_string()),
            activity_signal: Some("claude_tool_use".to_string()),
            activity_since_ms: 10_000,
            pending_since_ms: 10_000,
            current_task: "ls -la old-output".to_string(),
            ..Default::default()
        };

        let guess = infer_status_with_runtime(
            true,
            &live,
            "",
            "claude",
            None,
            10_000 + LIVE_RUNNING_STALE_MS + 1,
            1,
            0.0,
            0,
        );

        assert_eq!(guess.status, "idle");
        assert_eq!(guess.signal.as_deref(), Some("process_alive"));
        assert!(!guess.realtime);
    }

    #[test]
    fn edge_running_hook_stays_running_while_runtime_activity_exists() {
        let live = SessionLive {
            current_task: "Bash grep recap".to_string(),
            ..Default::default()
        };
        let state = OscSessionState {
            session_id: "s".to_string(),
            pid: None,
            run_id: None,
            status: "running".to_string(),
            message: Some("PreToolUse Bash".to_string()),
            source: "claude-hook:PreToolUse".to_string(),
            updated_at_ms: 10_000,
        };

        let guess = infer_status_with_runtime(
            true,
            &live,
            "",
            "claude",
            Some(&state),
            10_000 + EDGE_RUNNING_LEASE_MS + 1,
            1,
            0.0,
            0,
        );

        assert_eq!(guess.status, "running");
    }

    #[test]
    fn legacy_claude_idle_prompt_notification_is_idle() {
        let live = SessionLive::default();
        let state = OscSessionState {
            session_id: "s".to_string(),
            pid: None,
            run_id: None,
            status: "waiting".to_string(),
            message: Some("Claude is waiting for your input".to_string()),
            source: "claude-hook:Notification".to_string(),
            updated_at_ms: 10_000,
        };

        let guess =
            infer_status_with_runtime(true, &live, "", "claude", Some(&state), 10_000, 1, 0.0, 0);

        assert_eq!(guess.status, "idle");
        assert_eq!(guess.signal.as_deref(), Some("claude-hook:Notification"));
        assert!(guess.realtime);
    }

    #[test]
    fn no_hook_with_live_process_is_idle_even_if_transcript_looks_busy() {
        let live = SessionLive {
            pending_since_ms: 1_000,
            thinking_since_ms: 1_000,
            current_task: "Do you want to proceed?\n1. Yes\n2. No".to_string(),
            ..Default::default()
        };

        let guess = infer_status_with_runtime(true, &live, "", "claude", None, 10_000, 99, 50.0, 2);

        assert_eq!(guess.status, "idle");
        assert_eq!(guess.signal.as_deref(), Some("process_alive"));
        assert!(!guess.realtime);
    }

    #[test]
    fn no_hook_and_no_process_is_stopped() {
        let live = SessionLive::default();

        let guess = infer_status(false, &live, "", None, 10_000, 0);

        assert_eq!(guess.status, "stopped");
        assert_eq!(guess.signal, None);
        assert!(!guess.realtime);
    }

    #[test]
    fn non_hook_realtime_state_is_ignored_for_status() {
        let state = hook_state("running", "osc0");

        assert!(effective_hook_state(Some(&state)).is_none());
    }

    #[test]
    fn starling_pty_realtime_state_is_trusted_for_status() {
        let state = hook_state("running", "claude-pty:osc0");

        let effective = effective_hook_state(Some(&state)).expect("trusted pty state");
        assert_eq!(effective.status, "running");
        assert_eq!(effective.source, "claude-pty:osc0");
    }

    #[test]
    fn hook_session_id_accepts_codex_thread_id_aliases() {
        let value = serde_json::json!({ "thread_id": "019edf66-d8f0-71d0-9283-e75d6da02af4" });
        assert_eq!(
            hook_session_id(&value).as_deref(),
            Some("019edf66-d8f0-71d0-9283-e75d6da02af4")
        );
    }
}
