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
    status_from_osc0_title, status_from_osc94_progress, status_from_osc_sequence,
    upsert_osc_state, OscSessionState,
};
use crate::core::process_metrics::{get_process_tree_metrics, reset_cpu_sampler};
use crate::core::runs::{detect_running_sessions, reconcile_stale_runs};
use crate::core::session_display::short_session_id;
use crate::core::session_index::load_session_index;
use crate::core::session_metrics::{
    clear_session_metrics_cache, get_session_live_metrics, ChatRole, SessionLive,
};
use crate::core::store::{list_bookmarks, list_spaces, BookmarkFilter};
use crate::types::{Bookmark, SessionMeta};

const WATCH_INTERVAL_MS: u64 = 1000;
const STALE_PENDING_MS: u64 = 5 * 60 * 1000;
const STALE_PENDING_IDLE_MS: u64 = 24 * 60 * 60 * 1000;
const REALTIME_SUPERSEDE_GRACE_MS: u64 = 500;
const CODEX_ACTIVE_CPU_PCT: f64 = 1.0;
const CODEX_TASK_COMPLETE_HOLD_MS: u64 = 30 * 1000;
const CLAUDE_ACTIVE_CPU_PCT: f64 = 0.5;
/// Upper bound on "how long since the transcript last moved before we no longer
/// consider the session running". Must comfortably exceed the longest expected
/// single LLM generation / tool call (~minute-scale) so we don't flap during
/// long API responses, but be short enough that a mis-bound stale session
/// (transcript untouched for hours) is recognised as not-running.
const RUNNING_TRANSCRIPT_FRESH_MS: u64 = 5 * 60 * 1000;
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
            run_id,
            hook_file,
            pid,
            json,
        }) => record_claude_hook_event(run_id, hook_file, pid, json),
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
        println!("{}", "Tip: use --unpin to include unpinned sessions.".normal());
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
    let (resolved_status, parsed_source, parsed_message) =
        resolve_recorded_status(status.as_deref(), title.as_deref(), sequence.as_deref(), progress)?;
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

fn record_claude_hook_event(
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
    let Some(session_id) = value.get("session_id").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) else {
        return Ok(());
    };
    let event = value
        .get("hook_event_name")
        .and_then(|v| v.as_str())
        .unwrap_or("ClaudeHook");
    let Some(status) = status_from_claude_hook_event(event, &value) else {
        return Ok(());
    };
    let message = hook_message(event, &value);
    let state = OscSessionState {
        session_id: session_id.to_string(),
        pid,
        run_id,
        status: status.to_string(),
        message,
        source: format!("claude-hook:{event}"),
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

fn status_from_claude_hook_event<'a>(event: &str, value: &Value) -> Option<&'a str> {
    match event {
        "SessionStart" => Some("idle"),
        "UserPromptSubmit" => Some("running"),
        "PreToolUse" => Some("running"),
        "PermissionRequest" => Some("waiting"),
        "Notification" => Some("waiting"),
        "Elicitation" => Some("waiting"),
        "ElicitationResult" => Some("running"),
        "PostToolUse" | "PostToolUseFailure" | "PostToolBatch" => Some("running"),
        "SubagentStart" => Some("running"),
        "SubagentStop" => Some("running"),
        "TaskCreated" => Some("running"),
        "TaskCompleted" => Some("running"),
        "Stop" | "StopFailure" | "TeammateIdle" => Some("idle"),
        "SessionEnd" => Some("stopped"),
        _ => {
            let message = value
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("");
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

fn hook_message(event: &str, value: &Value) -> Option<String> {
    let tool = value.get("tool_name").and_then(|v| v.as_str());
    let message = value.get("message").and_then(|v| v.as_str());
    let agent = value.get("agent_type").and_then(|v| v.as_str());
    let text = match (tool, message, agent) {
        (Some(tool), _, _) => format!("{event} {tool}"),
        (_, Some(message), _) if !message.trim().is_empty() => message.trim().to_string(),
        (_, _, Some(agent)) => format!("{event} {agent}"),
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
        let effective_osc = effective_realtime_state(osc.as_ref(), &live);
        let running = is_actively_running(
            r.pid,
            &live,
            effective_osc,
            now_ms,
            cpu,
            process_count,
        );
        let inferred = infer_status_with_runtime(
            running,
            &live,
            &r.title,
            &r.provider,
            effective_osc,
            now_ms,
            process_count,
            cpu,
            background_task_count,
        );
        let status_realtime = inferred.realtime;
        let status_source = if status_realtime {
            "realtime".to_string()
        } else {
            "transcript".to_string()
        };
        let status_updated_at_ms = effective_osc
            .map(|s| s.updated_at_ms)
            .unwrap_or_else(|| {
                if live.activity_since_ms > 0 {
                    live.activity_since_ms
                } else {
                    live.last_activity_ms
                }
            });
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
        None => SessionLive { ctx_pct: -1, ..Default::default() },
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
    let parent_active = live.pending_since_ms > 0
        || live.thinking_since_ms > 0
        || !live.current_task.is_empty();
    let sub_active = sub_live.pending_since_ms > 0
        || sub_live.thinking_since_ms > 0
        || !sub_live.current_task.is_empty();
    live.last_activity_ms = sub_live.last_activity_ms;
    if sub_active || !parent_active {
        live.pending_since_ms = sub_live.pending_since_ms;
        live.thinking_since_ms = sub_live.thinking_since_ms;
        live.current_task = sub_live.current_task.clone();
        live.last_tool = sub_live.last_tool.clone().or_else(|| live.last_tool.clone());
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

fn effective_realtime_state<'a>(
    osc: Option<&'a OscSessionState>,
    live: &SessionLive,
) -> Option<&'a OscSessionState> {
    let state = osc?;
    if state.source.starts_with("claude-hook:") {
        return Some(state);
    }
    if live.last_activity_ms > state.updated_at_ms.saturating_add(REALTIME_SUPERSEDE_GRACE_MS) {
        return None;
    }
    Some(state)
}

/// Decide whether a session should be considered "running" for status-inference
/// purposes. This is stricter than mere PID liveness: a PID attached via the
/// cwd+mtime fallback (`process_map::resolve_from_cwd_mtime`) can easily be a
/// different live codex/claude process that happens to share the project
/// directory. We require positive evidence that *this* session is currently
/// being driven before letting the downstream decision tree label it
/// running/waiting — otherwise we fall through to "stopped".
///
/// Accepted evidence (any one suffices):
/// 1. A still-effective OSC state for this session (strongest: OSC events are
///    emitted by the agent itself and carry the session id).
/// 2. Transcript was modified within `RUNNING_TRANSCRIPT_FRESH_MS`.
/// 3. Process is consuming CPU above the active threshold.
/// 4. A child process is present (tool subprocess actively running).
fn is_actively_running(
    pid: Option<u32>,
    live: &SessionLive,
    effective_osc: Option<&OscSessionState>,
    now_ms: u64,
    cpu_pct: f64,
    process_count: usize,
) -> bool {
    if pid.is_none() {
        return false;
    }
    if effective_osc.is_some() {
        return true;
    }
    if now_ms.saturating_sub(live.last_activity_ms) <= RUNNING_TRANSCRIPT_FRESH_MS {
        return true;
    }
    if cpu_pct >= CODEX_ACTIVE_CPU_PCT {
        return true;
    }
    process_count > 1
}

#[derive(Clone)]
struct StatusGuess {
    status: String,
    signal: Option<String>,
    realtime: bool,
}

fn infer_status(
    running: bool,
    live: &SessionLive,
    _title: &str,
    osc: Option<&OscSessionState>,
    now_ms: u64,
    process_count: usize,
) -> StatusGuess {
    infer_status_with_runtime(running, live, _title, "", osc, now_ms, process_count, 0.0, 0)
}

fn infer_status_with_runtime(
    running: bool,
    live: &SessionLive,
    _title: &str,
    provider: &str,
    osc: Option<&OscSessionState>,
    now_ms: u64,
    process_count: usize,
    cpu_pct: f64,
    background_task_count: usize,
) -> StatusGuess {
    if !running {
        return status_guess("stopped", None, false);
    }
    if let Some(state) = osc {
        return status_guess(&state.status, Some(&state.source), true);
    }

    let activity_signal = live.activity_signal.as_deref().unwrap_or("codex_activity");
    if matches!(live.activity_status.as_deref(), Some("waiting" | "running")) {
        return status_guess(live.activity_status.as_deref().unwrap(), Some(activity_signal), false);
    }
    if live.pending_since_ms > 0 {
        let last_signal_ms = live.last_activity_ms.max(live.pending_since_ms);
        let pending_age_ms = now_ms.saturating_sub(last_signal_ms);
        if pending_age_ms >= STALE_PENDING_IDLE_MS {
            return status_guess("idle", Some("stale_pending_tool"), false);
        }
        if background_task_count > 0
            && is_claude_provider(provider)
            && claude_pending_tool_waits_for_approval(live.last_tool.as_deref())
        {
            return status_guess("waiting", Some("background_task_waiting"), false);
        }
        if process_count > 1 {
            return status_guess("running", Some("pending_tool_process"), false);
        }
        if is_claude_provider(provider) && cpu_pct >= CLAUDE_ACTIVE_CPU_PCT {
            return status_guess("running", Some("claude_pending_tool_active"), false);
        }
        if live_has_waiting_prompt(live) {
            return status_guess("waiting", Some("waiting_prompt_text"), false);
        }
        if matches!(live.last_tool.as_deref(), Some("Agent")) {
            return status_guess("waiting", Some("pending_agent"), false);
        }
        if is_claude_provider(provider) && claude_pending_tool_waits_for_approval(live.last_tool.as_deref()) {
            return status_guess("waiting", Some("pending_tool_approval"), false);
        }
        return status_guess("idle", Some("pending_tool_no_process"), false);
    }
    if live_has_waiting_prompt(live) {
        return status_guess("waiting", Some("waiting_prompt_text"), false);
    }
    if live.thinking_since_ms > 0 {
        return status_guess("running", Some("thinking"), false);
    }
    if background_task_count > 0 && is_claude_provider(provider) {
        return status_guess("idle", Some("background_task_idle"), false);
    }
    if is_codex_provider(provider) && cpu_pct >= CODEX_ACTIVE_CPU_PCT {
        return status_guess("running", Some("codex_process_active"), false);
    }
    if is_codex_provider(provider) && is_codex_task_complete_hint(live) {
        let last_signal_ms = live.last_activity_ms.max(live.activity_since_ms);
        if now_ms.saturating_sub(last_signal_ms) <= CODEX_TASK_COMPLETE_HOLD_MS {
            return status_guess("running", Some("codex_task_complete_hold"), false);
        }
    }
    if matches!(live.activity_status.as_deref(), Some("idle")) {
        return status_guess("idle", Some(activity_signal), false);
    }
    let last_role = live.chat_tail.last().map(|m| m.role);
    if live.pending_since_ms == 0 && matches!(last_role, Some(ChatRole::Assistant)) {
        return status_guess("idle", Some("assistant_ready"), false);
    }
    if !live.current_task.is_empty() {
        let last_signal_ms = live.last_activity_ms.max(live.thinking_since_ms);
        if now_ms.saturating_sub(last_signal_ms) > STALE_PENDING_MS {
            return status_guess("idle", Some("stale_task"), false);
        }
        return status_guess("idle", Some("current_task_no_process"), false);
    }
    status_guess("idle", Some("process_alive"), false)
}

fn is_codex_provider(provider: &str) -> bool {
    provider.eq_ignore_ascii_case("codex")
}

fn is_claude_provider(provider: &str) -> bool {
    provider.eq_ignore_ascii_case("claude")
}

fn claude_pending_tool_waits_for_approval(tool: Option<&str>) -> bool {
    matches!(
        tool,
        Some("Bash" | "Edit" | "Write" | "MultiEdit" | "NotebookEdit")
    )
}

fn is_codex_task_complete_hint(live: &SessionLive) -> bool {
    live.activity_status.as_deref() == Some("idle")
        && live.activity_signal.as_deref() == Some("codex_task_complete")
}

fn live_has_waiting_prompt(live: &SessionLive) -> bool {
    if text_looks_like_waiting_prompt(&live.current_task) {
        return true;
    }
    live.chat_tail
        .iter()
        .rev()
        .take(3)
        .any(|message| text_looks_like_waiting_prompt(&message.text))
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
    let effective_osc = effective_realtime_state(osc.as_ref(), &live);
    let inferred = infer_status_with_runtime(
        row.pid.is_some(),
        &live,
        &row.title,
        &row.provider,
        effective_osc,
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
        effective_osc,
        inferred.signal.as_deref(),
    );
    if metrics.is_empty() {
        vec![line1]
    } else {
        let line2 = format!("  {}", truncate_chars(&metrics, width.saturating_sub(2))).bright_black().to_string();
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
            let effective_osc = effective_realtime_state(osc.as_ref(), &live);
            let (cpu, _mem_kb, process_count, background_task_count) = process_for(row.pid);
            let inferred = infer_status_with_runtime(
                row.pid.is_some(),
                &live,
                &row.title,
                &row.provider,
                effective_osc,
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
    let suffix: String = value.chars().skip(count.saturating_sub(max.saturating_sub(1))).collect();
    format!("…{suffix}")
}

fn status_symbol(status: &str) -> ColoredString {
    match status {
        "waiting" => "○".blue().bold(),
        "idle" => "●".green().bold(),
        "running" => "●".cyan().bold(),
        "stopped" => "·".bright_black(),
        _ => "?".bright_black(),
    }
}

fn style_status(status: &str) -> ColoredString {
    match status {
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
    let _ = prune_stale_osc_state(now_ms());

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
    let spaces = list_spaces();
    let mut bookmarks: Vec<Bookmark> = list_bookmarks(BookmarkFilter::default()).into_iter()
        .filter(|b| {
            target_space_id.as_ref()
                .map(|id| b.space_ids.contains(id))
                .unwrap_or(true)
        })
        .collect();
    bookmarks.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    let mut pinned_rows: Vec<Row> = bookmarks.iter()
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
                .map(|r| canonical_session_id(&r.session_id)).collect();
            let mut recent: Vec<Row> = idx.sessions.iter()
                .filter(|s| !pinned_ids.contains(&canonical_session_id(&s.session_id)))
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
        let row_key = canonical_session_id(&row.session_id);
        let info = detected
            .get(&row.session_id)
            .or_else(|| {
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
        let mut seen: HashSet<String> = rows.iter().map(|r| canonical_session_id(&r.session_id)).collect();
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
        let _ = io::stdout().write_all(format!(
            "{} {}  ({} sessions · refresh {:.1}s · Ctrl-C to exit)\n\n",
            "starling top".cyan().bold(),
            now.to_string().normal(),
            rows.len(),
            refresh_secs,
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

#[cfg(test)]
mod tests {
    use super::*;

    fn pending_live(now_ms: u64, age_ms: u64) -> SessionLive {
        let at = now_ms.saturating_sub(age_ms);
        SessionLive {
            last_activity_ms: at,
            pending_since_ms: at,
            ..Default::default()
        }
    }

    #[test]
    fn pending_tool_without_child_is_idle_without_runtime_activity() {
        let now_ms = STALE_PENDING_MS + 10_000;
        let live = pending_live(now_ms, STALE_PENDING_MS - 1);

        let guess = infer_status(true, &live, "", None, now_ms, 1);

        assert_eq!(guess.status, "idle");
        assert_eq!(guess.signal.as_deref(), Some("pending_tool_no_process"));
    }

    #[test]
    fn stale_pending_tool_without_child_stays_idle() {
        let now_ms = STALE_PENDING_MS + 10_000;
        let live = pending_live(now_ms, STALE_PENDING_MS);

        let guess = infer_status(true, &live, "", None, now_ms, 1);

        assert_eq!(guess.status, "idle");
        assert_eq!(guess.signal.as_deref(), Some("pending_tool_no_process"));
    }

    #[test]
    fn pending_shell_without_child_is_idle_without_runtime_activity() {
        let now_ms = 10_000;
        let mut live = pending_live(now_ms, 2_000);
        live.last_tool = Some("Bash".to_string());

        let guess = infer_status(true, &live, "", None, now_ms, 1);

        assert_eq!(guess.status, "idle");
        assert_eq!(guess.signal.as_deref(), Some("pending_tool_no_process"));
    }

    #[test]
    fn pending_claude_shell_without_child_is_waiting_for_approval() {
        let now_ms = 10_000;
        let mut live = pending_live(now_ms, 2_000);
        live.last_tool = Some("Bash".to_string());

        let guess = infer_status_with_runtime(true, &live, "", "claude", None, now_ms, 1, 0.0, 0);

        assert_eq!(guess.status, "waiting");
        assert_eq!(guess.signal.as_deref(), Some("pending_tool_approval"));
    }

    #[test]
    fn very_old_pending_shell_without_child_becomes_idle() {
        let now_ms = STALE_PENDING_IDLE_MS + 10_000;
        let mut live = pending_live(now_ms, STALE_PENDING_IDLE_MS);
        live.last_tool = Some("Bash".to_string());

        let guess = infer_status(true, &live, "", None, now_ms, 1);

        assert_eq!(guess.status, "idle");
        assert_eq!(guess.signal.as_deref(), Some("stale_pending_tool"));
    }

    #[test]
    fn stale_claude_shell_pending_does_not_stay_waiting() {
        let now_ms = STALE_PENDING_IDLE_MS + 10_000;
        let mut live = pending_live(now_ms, STALE_PENDING_IDLE_MS);
        live.last_tool = Some("Bash".to_string());

        let guess = infer_status_with_runtime(true, &live, "", "claude", None, now_ms, 1, 5.0, 0);

        assert_eq!(guess.status, "idle");
        assert_eq!(guess.signal.as_deref(), Some("stale_pending_tool"));
    }

    #[test]
    fn pending_tool_with_child_process_stays_running() {
        let now_ms = 10_000 + STALE_PENDING_MS;
        let live = pending_live(now_ms, STALE_PENDING_MS + 1);

        let guess = infer_status(true, &live, "", None, now_ms, 2);

        assert_eq!(guess.status, "running");
        assert_eq!(guess.signal.as_deref(), Some("pending_tool_process"));
    }

    #[test]
    fn pending_claude_agent_tool_without_child_is_waiting() {
        let now_ms = 10_000;
        let mut live = pending_live(now_ms, 2_000);
        live.last_tool = Some("Agent".to_string());

        let guess = infer_status(true, &live, "", None, now_ms, 1);

        assert_eq!(guess.status, "waiting");
        assert_eq!(guess.signal.as_deref(), Some("pending_agent"));
    }

    #[test]
    fn pending_claude_tool_with_cpu_activity_is_running() {
        let now_ms = 10_000;
        let live = pending_live(now_ms, 2_000);

        let guess = infer_status_with_runtime(true, &live, "", "claude", None, now_ms, 1, 5.0, 0);

        assert_eq!(guess.status, "running");
        assert_eq!(guess.signal.as_deref(), Some("claude_pending_tool_active"));
    }

    #[test]
    fn pending_claude_background_task_stays_waiting_despite_cpu() {
        let now_ms = 10_000;
        let mut live = pending_live(now_ms, 2_000);
        live.last_tool = Some("Bash".to_string());

        let guess = infer_status_with_runtime(true, &live, "", "claude", None, now_ms, 1, 10.0, 1);

        assert_eq!(guess.status, "waiting");
        assert_eq!(guess.signal.as_deref(), Some("background_task_waiting"));
    }

    #[test]
    fn pending_claude_tool_without_cpu_activity_stays_idle() {
        let now_ms = 10_000;
        let live = pending_live(now_ms, 2_000);

        let guess = infer_status_with_runtime(true, &live, "", "claude", None, now_ms, 1, 0.0, 0);

        assert_eq!(guess.status, "idle");
        assert_eq!(guess.signal.as_deref(), Some("pending_tool_no_process"));
    }

    #[test]
    fn claude_permission_prompt_text_is_waiting() {
        let now_ms = 10_000;
        let live = SessionLive {
            last_activity_ms: now_ms - 1_000,
            current_task: "Do you want to proceed?\n1. Yes\n2. No".to_string(),
            ..Default::default()
        };

        let guess = infer_status_with_runtime(true, &live, "", "claude", None, now_ms, 1, 0.0, 0);

        assert_eq!(guess.status, "waiting");
        assert_eq!(guess.signal.as_deref(), Some("waiting_prompt_text"));
    }

    #[test]
    fn claude_permission_prompt_without_runtime_evidence_is_waiting() {
        let now_ms = 10_000;
        let mut live = pending_live(now_ms, 1_000);
        live.last_tool = Some("Bash".to_string());
        live.current_task = "Do you want to proceed?\n1. Yes\n2. No".to_string();

        let guess = infer_status_with_runtime(true, &live, "", "claude", None, now_ms, 1, 0.0, 0);

        assert_eq!(guess.status, "waiting");
        assert_eq!(guess.signal.as_deref(), Some("waiting_prompt_text"));
    }

    #[test]
    fn claude_permission_prompt_with_child_process_turns_running() {
        let now_ms = 10_000;
        let mut live = pending_live(now_ms, 1_000);
        live.last_tool = Some("Bash".to_string());
        live.current_task = "Do you want to proceed?\n1. Yes\n2. No".to_string();

        let guess = infer_status_with_runtime(true, &live, "", "claude", None, now_ms, 3, 20.0, 0);

        assert_eq!(guess.status, "running");
        assert_eq!(guess.signal.as_deref(), Some("pending_tool_process"));
    }

    #[test]
    fn claude_active_process_without_task_signal_is_idle() {
        let now_ms = STALE_PENDING_MS * 3;
        let live = SessionLive {
            last_activity_ms: 1_000,
            ..Default::default()
        };

        let guess = infer_status_with_runtime(true, &live, "", "claude", None, now_ms, 1, 0.8, 0);

        assert_eq!(guess.status, "idle");
        assert_eq!(guess.signal.as_deref(), Some("process_alive"));
    }

    #[test]
    fn claude_background_task_without_frontend_activity_is_idle() {
        let now_ms = STALE_PENDING_MS * 3;
        let live = SessionLive {
            last_activity_ms: 1_000,
            ..Default::default()
        };

        let guess = infer_status_with_runtime(true, &live, "", "claude", None, now_ms, 1, 10.0, 1);

        assert_eq!(guess.status, "idle");
        assert_eq!(guess.signal.as_deref(), Some("background_task_idle"));
    }

    #[test]
    fn claude_hook_events_map_to_session_states() {
        let empty = serde_json::json!({});
        assert_eq!(status_from_claude_hook_event("UserPromptSubmit", &empty), Some("running"));
        assert_eq!(status_from_claude_hook_event("PermissionRequest", &empty), Some("waiting"));
        assert_eq!(status_from_claude_hook_event("Notification", &empty), Some("waiting"));
        assert_eq!(status_from_claude_hook_event("Stop", &empty), Some("idle"));
        assert_eq!(status_from_claude_hook_event("SessionEnd", &empty), Some("stopped"));
    }

    #[test]
    fn claude_hook_state_survives_newer_transcript_activity() {
        let live = SessionLive {
            last_activity_ms: 10_000,
            ..Default::default()
        };
        let state = OscSessionState {
            session_id: "s".to_string(),
            pid: None,
            run_id: None,
            status: "waiting".to_string(),
            message: None,
            source: "claude-hook:PermissionRequest".to_string(),
            updated_at_ms: 1_000,
        };

        assert!(effective_realtime_state(Some(&state), &live).is_some());
    }

    #[test]
    fn actively_running_requires_pid() {
        let live = SessionLive { last_activity_ms: 100, ..Default::default() };
        // Even with CPU, child processes, and OSC, no PID means not running.
        let state = OscSessionState {
            session_id: "s".to_string(), pid: None, run_id: None,
            status: "running".to_string(), message: None,
            source: "claude-hook:UserPromptSubmit".to_string(),
            updated_at_ms: 100,
        };
        assert!(!is_actively_running(None, &live, Some(&state), 1_000, 5.0, 3));
    }

    #[test]
    fn actively_running_accepts_fresh_transcript() {
        // Recent transcript write is enough on its own.
        let live = SessionLive { last_activity_ms: 5_000, ..Default::default() };
        assert!(is_actively_running(Some(42), &live, None, 10_000, 0.0, 1));
    }

    #[test]
    fn actively_running_transcript_freshness_is_inclusive_at_boundary() {
        let now_ms = 1_000_000;
        let live = SessionLive {
            last_activity_ms: now_ms - RUNNING_TRANSCRIPT_FRESH_MS,
            ..Default::default()
        };
        assert!(is_actively_running(Some(42), &live, None, now_ms, 0.0, 1));
    }

    #[test]
    fn actively_running_accepts_effective_osc() {
        // OSC carries the session id and is emitted by the agent itself —
        // strongest single signal that the bound PID really belongs to this
        // session.
        let live = SessionLive { last_activity_ms: 1_000, ..Default::default() };
        let state = OscSessionState {
            session_id: "s".to_string(), pid: None, run_id: None,
            status: "running".to_string(), message: None,
            source: "claude-hook:UserPromptSubmit".to_string(),
            updated_at_ms: 1_000,
        };
        assert!(is_actively_running(Some(42), &live, Some(&state), 10_000, 0.0, 1));
    }

    #[test]
    fn actively_running_accepts_cpu_activity() {
        // Long LLM generation: transcript may be quiet but the process is
        // burning CPU.
        let live = SessionLive { last_activity_ms: 1_000, ..Default::default() };
        assert!(is_actively_running(Some(42), &live, None, 10_000, 5.0, 1));
    }

    #[test]
    fn actively_running_accepts_child_process() {
        // Tool subprocess spinning under the agent PID.
        let live = SessionLive { last_activity_ms: 1_000, ..Default::default() };
        assert!(is_actively_running(Some(42), &live, None, 10_000, 0.0, 3));
    }

    #[test]
    fn actively_running_rejects_mis_bound_stale_session() {
        // Reproduces the reported codex bug: a live codex/claude process got
        // bound to this session via the cwd+mtime fallback, but the
        // transcript hasn't moved in hours and there's no corroborating
        // signal. Should NOT be considered running.
        let now_ms = 10_000_000;
        let stale_ms = RUNNING_TRANSCRIPT_FRESH_MS + 60_000;
        let live = SessionLive {
            last_activity_ms: now_ms.saturating_sub(stale_ms),
            ..Default::default()
        };
        assert!(!is_actively_running(Some(42), &live, None, now_ms, 0.0, 1));
    }

    #[test]
    fn assistant_thinking_stays_running_without_new_transcript_chunks() {
        let now_ms = STALE_PENDING_MS * 3;
        let live = SessionLive {
            last_activity_ms: 1_000,
            thinking_since_ms: 1_000,
            ..Default::default()
        };

        let guess = infer_status(true, &live, "", None, now_ms, 1);

        assert_eq!(guess.status, "running");
        assert_eq!(guess.signal.as_deref(), Some("thinking"));
    }

    #[test]
    fn codex_idle_activity_does_not_override_pending_tool_process() {
        let now_ms = 10_000;
        let mut live = pending_live(now_ms, 2_000);
        live.last_tool = Some("exec_command".to_string());
        live.activity_status = Some("idle".to_string());
        live.activity_signal = Some("codex_task_complete".to_string());
        live.activity_since_ms = now_ms - 1_000;

        let guess = infer_status_with_runtime(true, &live, "", "codex", None, now_ms, 2, 0.0, 0);

        assert_eq!(guess.status, "running");
        assert_eq!(guess.signal.as_deref(), Some("pending_tool_process"));
    }

    #[test]
    fn codex_active_process_stays_running_after_task_complete_hint() {
        let now_ms = 10_000;
        let live = SessionLive {
            last_activity_ms: now_ms - 1_000,
            activity_status: Some("idle".to_string()),
            activity_signal: Some("codex_task_complete".to_string()),
            activity_since_ms: now_ms - 1_000,
            ..Default::default()
        };

        let guess = infer_status_with_runtime(true, &live, "", "codex", None, now_ms, 1, 4.0, 0);

        assert_eq!(guess.status, "running");
        assert_eq!(guess.signal.as_deref(), Some("codex_process_active"));
    }

    #[test]
    fn codex_task_complete_hint_is_idle_without_runtime_activity() {
        let now_ms = CODEX_TASK_COMPLETE_HOLD_MS + 10_000;
        let live = SessionLive {
            last_activity_ms: 1_000,
            activity_status: Some("idle".to_string()),
            activity_signal: Some("codex_task_complete".to_string()),
            activity_since_ms: 1_000,
            ..Default::default()
        };

        let guess = infer_status_with_runtime(true, &live, "", "codex", None, now_ms, 1, 0.0, 0);

        assert_eq!(guess.status, "idle");
        assert_eq!(guess.signal.as_deref(), Some("codex_task_complete"));
    }

    #[test]
    fn codex_task_complete_holds_running_briefly_between_tasks() {
        let now_ms = 10_000;
        let live = SessionLive {
            last_activity_ms: now_ms - 1_000,
            activity_status: Some("idle".to_string()),
            activity_signal: Some("codex_task_complete".to_string()),
            activity_since_ms: now_ms - 1_000,
            ..Default::default()
        };

        let guess = infer_status_with_runtime(true, &live, "", "codex", None, now_ms, 1, 0.0, 0);

        assert_eq!(guess.status, "running");
        assert_eq!(guess.signal.as_deref(), Some("codex_task_complete_hold"));
    }

    #[test]
    fn codex_activity_running_takes_priority_over_stale_permission_text() {
        let now_ms = 10_000;
        let live = SessionLive {
            last_activity_ms: now_ms,
            activity_status: Some("running".to_string()),
            activity_signal: Some("codex_task_started".to_string()),
            current_task: "Would you like to run the following command?".to_string(),
            ..Default::default()
        };

        let guess = infer_status(true, &live, "", None, now_ms, 1);

        assert_eq!(guess.status, "running");
        assert_eq!(guess.signal.as_deref(), Some("codex_task_started"));
    }

    #[test]
    fn very_old_pending_tool_becomes_idle() {
        let now_ms = STALE_PENDING_IDLE_MS + 10_000;
        let live = pending_live(now_ms, STALE_PENDING_IDLE_MS);

        let guess = infer_status(true, &live, "", None, now_ms, 1);

        assert_eq!(guess.status, "idle");
        assert_eq!(guess.signal.as_deref(), Some("stale_pending_tool"));
    }
}
