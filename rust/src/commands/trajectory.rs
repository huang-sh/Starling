//! `starling trajectory` — project an agent session transcript into a
//! turn-aware trajectory ledger (turns → steps → records) with timing,
//! token usage, and tool outcomes. Schema mirrors the trajectory-v1 shape
//! used by codex-trajectory (inspired by DeepSeek Harness's event ledger).
//!
//! Provider adapters (pi / claude / codex) translate their transcript
//! vocabularies into one internal event stream; turn/step accounting,
//! tool-call pairing, truncation, stats, and rendering are shared.

use std::collections::HashMap;
use std::path::Path;

use anyhow::Result;
use chrono::{DateTime, Utc};
use colored::*;
use serde_json::{json, Map, Value};

use crate::cli::*;
use crate::core::discovery::{find_session_by_id, find_sessions};
use crate::core::session::parse_jsonl_file;

const DEFAULT_MAX_RECORDS: usize = 500;
const HARD_MAX_RECORDS: usize = 1000;
const HARD_MIN_RECORDS: usize = 50;
const SUMMARY_LIMIT: usize = 100;
const DETAIL_LIMIT: usize = 4_000;

pub fn handle(
    session_id: Option<String>,
    max_records: usize,
    full: bool,
    json: bool,
) -> Result<()> {
    let max_records = max_records.clamp(HARD_MIN_RECORDS, HARD_MAX_RECORDS);
    let meta = resolve_session(session_id.as_deref())?;
    let trajectory = project(Path::new(&meta.file_path), &meta.provider, full, max_records)?;

    if json {
        println!("{}", serde_json::to_string_pretty(&trajectory)?);
        return Ok(());
    }
    render(&trajectory, &meta.session_id);
    Ok(())
}

/// Default to the most recent session of any provider; explicit IDs reuse
/// the normal resolver.
fn resolve_session(session_id: Option<&str>) -> Result<crate::types::SessionMeta> {
    let meta = match session_id {
        Some(id) => find_session_by_id(id),
        None => find_sessions(50, None)
            .into_iter()
            .find(|m| Path::new(&m.file_path).is_file()),
    };
    match meta {
        Some(m) => Ok(m),
        None => anyhow::bail!("session not found"),
    }
}

// ---------------------------------------------------------------------------
// Provider event vocabulary
// ---------------------------------------------------------------------------

enum Block {
    Thinking(String),
    Text(String),
    ToolCall { id: String, name: String, args: String },
}

enum Evt {
    Session { id: String, cwd: Option<String> },
    User { id: String, text: String },
    Assistant { id: String, model: Option<String>, blocks: Vec<Block>, usage: Option<Value> },
    ToolResult { call_id: String, name: String, error: bool, output: String },
    Compaction { id: String, summary: String, tokens_before: Option<i64> },
    System { id: String, event: &'static str, summary: String, model: Option<String> },
    /// Explicit turn terminator (codex task_complete / turn_aborted).
    TurnEnd { aborted: bool },
    /// Cumulative usage snapshot (codex token_count); replaces stats totals.
    UsageTotals(Value),
}

/// Pi sessions: entries keyed by `type` with `message` payloads
/// (roles user/assistant/toolResult) plus lifecycle entries.
fn evt_pi(obj: &Map<String, Value>) -> Vec<Evt> {
    let id = obj.get("id").and_then(Value::as_str).unwrap_or("").to_string();
    let msg = obj.get("message");
    let text_of = |v: Option<&Value>| -> String {
        v.and_then(|c| match c {
            Value::String(s) => Some(s.clone()),
            Value::Array(blocks) => blocks
                .iter()
                .filter_map(|b| b.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n")
                .trim()
                .to_string()
                .into(),
            _ => None,
        })
        .unwrap_or_default()
    };
    match obj.get("type").and_then(Value::as_str) {
        Some("session") => vec![Evt::Session {
            id: obj.get("id").and_then(Value::as_str).unwrap_or_default().to_string(),
            cwd: obj.get("cwd").and_then(Value::as_str).map(str::to_string),
        }],
        Some("message") => {
            let role = msg.and_then(|m| m.get("role")).and_then(Value::as_str).unwrap_or("");
            match role {
                "user" => vec![Evt::User {
                    id,
                    text: text_of(msg.and_then(|m| m.get("content"))),
                }],
                "assistant" => {
                    let mut blocks = Vec::new();
                    if let Some(arr) = msg.and_then(|m| m.get("content")).and_then(Value::as_array) {
                        for b in arr {
                            match b.get("type").and_then(Value::as_str).unwrap_or("") {
                                "thinking" => blocks.push(Block::Thinking(
                                    b.get("thinking").and_then(Value::as_str).unwrap_or("").into(),
                                )),
                                "text" => blocks.push(Block::Text(
                                    b.get("text").and_then(Value::as_str).unwrap_or("").into(),
                                )),
                                "toolCall" => blocks.push(Block::ToolCall {
                                    id: b.get("id").and_then(Value::as_str).unwrap_or("").into(),
                                    name: b.get("name").and_then(Value::as_str).unwrap_or("tool").into(),
                                    args: b
                                        .get("arguments")
                                        .map(|a| serde_json::to_string(a).unwrap_or_default())
                                        .unwrap_or_default(),
                                }),
                                _ => {}
                            }
                        }
                    }
                    vec![Evt::Assistant {
                        id,
                        model: msg
                            .and_then(|m| m.get("model"))
                            .and_then(Value::as_str)
                            .map(str::to_string),
                        blocks,
                        usage: msg.as_ref().and_then(|m| m.get("usage")).cloned().filter(|u| u.is_object()),
                    }]
                }
                "toolResult" => vec![Evt::ToolResult {
                    call_id: msg
                        .and_then(|m| m.get("toolCallId"))
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .into(),
                    name: msg
                        .and_then(|m| m.get("toolName"))
                        .and_then(Value::as_str)
                        .unwrap_or("tool")
                        .into(),
                    error: msg
                        .and_then(|m| m.get("isError"))
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                    output: text_of(msg.and_then(|m| m.get("content"))),
                }],
                _ => Vec::new(),
            }
        }
        Some("compaction") => vec![Evt::Compaction {
            id,
            summary: obj.get("summary").and_then(Value::as_str).unwrap_or("").into(),
            tokens_before: obj.get("tokensBefore").and_then(Value::as_i64),
        }],
        Some("model_change") => vec![Evt::System {
            id,
            event: "model_change",
            summary: format!(
                "{}/{}",
                obj.get("provider").and_then(Value::as_str).unwrap_or(""),
                obj.get("modelId").and_then(Value::as_str).unwrap_or("")
            ),
            model: Some(format!(
                "{}/{}",
                obj.get("provider").and_then(Value::as_str).unwrap_or(""),
                obj.get("modelId").and_then(Value::as_str).unwrap_or("")
            )),
        }],
        Some("thinking_level_change") => vec![Evt::System {
            id,
            event: "thinking_level",
            summary: obj.get("thinkingLevel").and_then(Value::as_str).unwrap_or("").into(),
            model: None,
        }],
        Some("branch_summary") => vec![Evt::System {
            id,
            event: "branch_summary",
            summary: obj.get("summary").and_then(Value::as_str).unwrap_or("").into(),
            model: None,
        }],
        _ => Vec::new(),
    }
}

/// Claude Code sessions: flat entries with `type` user/assistant; tool
/// results ride inside user-type messages; usage on assistant messages.
fn evt_claude(obj: &Map<String, Value>) -> Vec<Evt> {
    let id = obj.get("uuid").and_then(Value::as_str).unwrap_or("").to_string();
    let msg = obj.get("message").cloned().unwrap_or(Value::Null);
    match obj.get("type").and_then(Value::as_str) {
        _ if obj.get("isSidechain").and_then(Value::as_bool) == Some(true) => Vec::new(),
        Some("user") => {
            let content = msg.get("content");
            let mut out = Vec::new();
            if let Some(blocks) = content.and_then(Value::as_array) {
                for b in blocks {
                    if b.get("type").and_then(Value::as_str) == Some("tool_result") {
                        let text = match b.get("content") {
                            Some(Value::String(s)) => s.clone(),
                            Some(Value::Array(parts)) => parts
                                .iter()
                                .filter_map(|p| p.get("text").and_then(Value::as_str))
                                .collect::<Vec<_>>()
                                .join("\n"),
                            _ => String::new(),
                        };
                        out.push(Evt::ToolResult {
                            call_id: b
                                .get("tool_use_id")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .into(),
                            name: String::new(), // paired via tool_use id
                            error: b.get("is_error").and_then(Value::as_bool).unwrap_or(false),
                            output: text,
                        });
                    } else if b.get("type").and_then(Value::as_str) == Some("text") {
                        out.push(Evt::User {
                            id: id.clone(),
                            text: b.get("text").and_then(Value::as_str).unwrap_or("").into(),
                        });
                    }
                }
                // Tool-result carriers are not new turns: keep only ToolResults
                // when the message has no user-authored text.
                let has_user = out.iter().any(|e| matches!(e, Evt::User { .. }));
                if !has_user {
                    out.retain(|e| matches!(e, Evt::ToolResult { .. }));
                }
                out
            } else if obj.get("isMeta").and_then(Value::as_bool) == Some(true) {
                Vec::new()
            } else {
                let text = content.and_then(Value::as_str).unwrap_or("").to_string();
                if text.is_empty() {
                    Vec::new()
                } else {
                    vec![Evt::User { id, text }]
                }
            }
        }
        Some("assistant") => {
            let mut blocks = Vec::new();
            if let Some(arr) = msg.get("content").and_then(Value::as_array) {
                for b in arr {
                    match b.get("type").and_then(Value::as_str).unwrap_or("") {
                        "thinking" => blocks.push(Block::Thinking(
                            b.get("thinking").and_then(Value::as_str).unwrap_or("").into(),
                        )),
                        "text" => blocks.push(Block::Text(
                            b.get("text").and_then(Value::as_str).unwrap_or("").into(),
                        )),
                        "tool_use" => blocks.push(Block::ToolCall {
                            id: b.get("id").and_then(Value::as_str).unwrap_or("").into(),
                            name: b.get("name").and_then(Value::as_str).unwrap_or("tool").into(),
                            args: b
                                .get("input")
                                .map(|a| serde_json::to_string(a).unwrap_or_default())
                                .unwrap_or_default(),
                        }),
                        _ => {}
                    }
                }
            }
            // Normalize Claude usage keys to the shared shape.
            let usage = msg.get("usage").and_then(|u| {
                let g = |k: &str| u.get(k).and_then(Value::as_i64).unwrap_or(0);
                if u.as_object().map(|m| m.is_empty()).unwrap_or(true) {
                    None
                } else {
                    Some(json!({
                        "input": g("input_tokens"),
                        "output": g("output_tokens"),
                        "cacheRead": g("cache_read_input_tokens"),
                        "cacheWrite": g("cache_creation_input_tokens"),
                    }))
                }
            });
            vec![Evt::Assistant {
                id,
                model: msg.get("model").and_then(Value::as_str).map(str::to_string),
                blocks,
                usage,
            }]
        }
        _ => Vec::new(),
    }
}

/// Codex rollouts: `{type, payload, timestamp}` envelopes with
/// session_meta / turn_context / event_msg / response_item payloads.
fn evt_codex(obj: &Map<String, Value>) -> Vec<Evt> {
    let Some(payload) = obj.get("payload").and_then(Value::as_object) else {
        return Vec::new();
    };
    let ptype = payload.get("type").and_then(Value::as_str).unwrap_or("");
    let texts = |parts: Option<&Value>| -> String {
        parts
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter_map(|p| p.get("text").and_then(Value::as_str))
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default()
    };
    match (obj.get("type").and_then(Value::as_str).unwrap_or(""), ptype) {
        ("session_meta", _) => vec![Evt::Session {
            id: payload
                .get("session_id")
                .or_else(|| payload.get("id"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .into(),
            cwd: payload.get("cwd").and_then(Value::as_str).map(str::to_string),
        }],
        ("turn_context", _) => {
            let model = payload.get("model").and_then(Value::as_str).unwrap_or("");
            let effort = payload.get("effort").and_then(Value::as_str).unwrap_or("");
            let summary = [model, effort].iter().filter(|s| !s.is_empty()).cloned().collect::<Vec<_>>().join(" · ");
            if summary.is_empty() {
                Vec::new()
            } else {
                vec![Evt::System {
                    id: String::new(),
                    event: "turn_context",
                    summary,
                    model: Some(model.to_string()),
                }]
            }
        }
        ("event_msg", "user_message") => vec![Evt::User {
            id: String::new(),
            text: payload.get("message").and_then(Value::as_str).unwrap_or("").into(),
        }],
        ("event_msg", "task_complete") => vec![Evt::TurnEnd { aborted: false }],
        ("event_msg", "turn_aborted") => vec![Evt::TurnEnd { aborted: true }],
        ("event_msg", "context_compacted") | ("compacted", _) => vec![Evt::Compaction {
            id: String::new(),
            summary: payload
                .get("message")
                .or_else(|| payload.get("summary"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .into(),
            tokens_before: None,
        }],
        ("event_msg", "token_count") => {
            let usage = payload
                .get("info")
                .and_then(|i| i.get("total_token_usage"))
                .and_then(|u| {
                    let g = |k: &str| u.get(k).and_then(Value::as_i64).unwrap_or(0);
                    Some(json!({
                        "input": g("input_tokens"),
                        "output": g("output_tokens"),
                        "cacheRead": g("cached_input_tokens"),
                        "cacheWrite": 0,
                    }))
                });
            match usage {
                Some(u) => vec![Evt::UsageTotals(u)],
                None => Vec::new(),
            }
        }
        ("response_item", "message") => vec![Evt::Assistant {
            id: String::new(),
            model: None,
            blocks: vec![Block::Text(texts(payload.get("content")))],
            usage: None,
        }],
        ("response_item", "reasoning") => vec![Evt::Assistant {
            id: String::new(),
            model: None,
            blocks: vec![Block::Thinking(texts(payload.get("summary")))],
            usage: None,
        }],
        ("response_item", "function_call") | ("response_item", "custom_tool_call") => vec![
            Evt::Assistant {
                id: String::new(),
                model: None,
                blocks: vec![Block::ToolCall {
                    id: payload
                        .get("call_id")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .into(),
                    name: payload.get("name").and_then(Value::as_str).unwrap_or("tool").into(),
                    args: payload
                        .get("arguments")
                        .or_else(|| payload.get("input"))
                        .map(|a| serde_json::to_string(a).unwrap_or_default())
                        .unwrap_or_default(),
                }],
                usage: None,
            },
        ],
        ("response_item", "function_call_output") | ("response_item", "custom_tool_call_output") => {
            let output = payload
                .get("output")
                .map(|o| match o {
                    Value::String(s) => s.clone(),
                    other => serde_json::to_string(other).unwrap_or_default(),
                })
                .unwrap_or_default();
            // Codex marks failures inside the output payload (best effort).
            let error = match serde_json::from_str::<Value>(&output) {
                Ok(Value::Object(map)) => {
                    map.get("isError").and_then(Value::as_bool) == Some(true)
                        || map.get("success").and_then(Value::as_bool) == Some(false)
                }
                _ => false,
            };
            vec![Evt::ToolResult {
                call_id: payload
                    .get("call_id")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .into(),
                name: String::new(),
                error,
                output,
            }]
        }
        _ => Vec::new(),
    }
}

// ---------------------------------------------------------------------------
// Shared projection core
// ---------------------------------------------------------------------------

struct RecordDraft {
    kind: &'static str,
    event: String,
    summary: String,
    started_at: Option<DateTime<Utc>>,
    completed_at: Option<DateTime<Utc>>,
    status: &'static str,
    input: Option<String>,
    output: Option<String>,
    usage: Option<Value>,
    metadata: Map<String, Value>,
    turn: usize,
    step: Option<usize>,
    id: String,
}

pub fn project(path: &Path, provider: &str, full: bool, max_records: usize) -> Result<Value> {
    let entries = parse_jsonl_file(path);
    if entries.is_empty() {
        anyhow::bail!("no readable JSONL entries in {}", path.display());
    }
    let adapter: fn(&Map<String, Value>) -> Vec<Evt> = match provider {
        "claude" => evt_claude,
        "codex" => evt_codex,
        _ => evt_pi,
    };

    let mut session_id = String::new();
    let mut cwd: Option<String> = None;
    let mut first_user = String::new();
    let mut model: Option<String> = None;
    let mut models_seen: Vec<String> = Vec::new();
    let mut first_ts: Option<DateTime<Utc>> = None;
    let mut last_ts: Option<DateTime<Utc>> = None;

    let mut drafts: Vec<RecordDraft> = Vec::new();
    let mut turns: Vec<Value> = Vec::new();
    let mut warnings: Vec<Value> = Vec::new();
    // toolCallId → record position
    let mut pending_tools: HashMap<String, usize> = HashMap::new();

    let mut current_turn: usize = 0;
    let mut current_step: usize = 0;
    let mut turn_active = false;
    let mut after_tool_result = false;
    let mut turn_tokens = json!({"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "cost": 0.0});
    let mut totals = turn_tokens.clone();
    let mut tool_calls = 0usize;
    let mut tool_errors = 0usize;
    let mut ignored = 0usize;

    macro_rules! close_turn {
        ($completed:expr, $status:expr) => {
            if turn_active {
                if let Some(t) = turns.last_mut() {
                    t["completedAt"] = json!(iso($completed));
                    t["durationMs"] = json!(ms_between(
                        parse_ts(t.get("startedAt").and_then(Value::as_str)),
                        $completed
                    ));
                    t["status"] = json!($status);
                    t["tokens"] = turn_tokens.clone();
                }
                turn_active = false;
                turn_tokens = json!({"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "cost": 0.0});
            }
        };
    }

    macro_rules! ensure_turn {
        ($ts:expr) => {{
            if !turn_active {
                current_turn += 1;
                current_step = 0;
                turn_active = true;
                turns.push(json!({
                    "index": current_turn,
                    "id": Value::Null,
                    "startedAt": iso($ts),
                    "completedAt": Value::Null,
                    "durationMs": Value::Null,
                    "status": "running",
                    "records": 0,
                    "steps": 0,
                    "tokens": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "cost": 0.0},
                }));
            }
        }};
    }

    for entry in &entries {
        let Some(obj) = entry.as_record() else { continue };
        let ts = parse_ts(obj.get("timestamp").and_then(Value::as_str));
        if ts.is_some() {
            first_ts = first_ts.or(ts);
            last_ts = Some(ts.unwrap());
        }
        let events = adapter(obj);
        if events.is_empty() {
            ignored += 1;
            continue;
        }
        for evt in events {
            match evt {
                Evt::Session { id, cwd: c } => {
                    if session_id.is_empty() && !id.is_empty() {
                        session_id = id;
                    }
                    if cwd.is_none() {
                        cwd = c;
                    }
                }
                Evt::User { id, text } => {
                    close_turn!(ts, "complete");
                    ensure_turn!(ts);
                    after_tool_result = false;
                    if first_user.is_empty() {
                        first_user = text.clone();
                    }
                    drafts.push(RecordDraft {
                        kind: "user",
                        event: "user".into(),
                        summary: shorten(&text, SUMMARY_LIMIT),
                        started_at: ts,
                        completed_at: ts,
                        status: "complete",
                        input: if full { Some(detail_text(&text, DETAIL_LIMIT)) } else { None },
                        output: None,
                        usage: None,
                        metadata: Map::new(),
                        turn: current_turn,
                        step: Some(1),
                        id,
                    });
                }
                Evt::Assistant { id, model: m, blocks, usage } => {
                    ensure_turn!(ts);
                    if after_tool_result {
                        current_step += 1;
                        after_tool_result = false;
                    }
                    if model.is_none() {
                        if let Some(mv) = &m {
                            model = Some(mv.clone());
                        }
                    }
                    for key in ["input", "output", "cacheRead", "cacheWrite"] {
                        let v = usage
                            .as_ref()
                            .and_then(|u| u.get(key))
                            .and_then(Value::as_i64)
                            .unwrap_or(0);
                        turn_tokens[key] = json!(turn_tokens[key].as_i64().unwrap_or(0) + v);
                        totals[key] = json!(totals[key].as_i64().unwrap_or(0) + v);
                    }
                    let cost = usage
                        .as_ref()
                        .and_then(|u| u.get("cost"))
                        .and_then(|c| c.get("total"))
                        .and_then(Value::as_f64)
                        .unwrap_or(0.0);
                    turn_tokens["cost"] = json!(turn_tokens["cost"].as_f64().unwrap_or(0.0) + cost);
                    totals["cost"] = json!(totals["cost"].as_f64().unwrap_or(0.0) + cost);

                    for block in blocks {
                        let (kind, event, summary, detail, call_id) = match block {
                            Block::Thinking(t) => {
                                let summary = if t.trim().is_empty() {
                                    "(encrypted reasoning)".to_string()
                                } else {
                                    shorten(&t, SUMMARY_LIMIT)
                                };
                                ("reasoning", "thinking", summary, Some(detail_text(&t, DETAIL_LIMIT)), None)
                            }
                            Block::Text(t) => {
                                ("assistant", "message", shorten(&t, SUMMARY_LIMIT), Some(detail_text(&t, DETAIL_LIMIT)), None)
                            }
                            Block::ToolCall { id: cid, name, args } => {
                                tool_calls += 1;
                                let summary = format!("{} {}", name, shorten(&args, 60));
                                ("tool", "", shorten(summary.trim(), SUMMARY_LIMIT), Some(detail_text(&args, DETAIL_LIMIT)), Some((cid, name)))
                            }
                        };
                        current_step = current_step.max(1);
                        let step = current_step;
                        if let Some(t) = turns.last_mut() {
                            t["steps"] = json!(t["steps"].as_i64().unwrap_or(0).max(step as i64));
                        }
                        let pos = drafts.len();
                        let (event, id) = match &call_id {
                            Some((_, name)) => (name.clone(), call_id.as_ref().map(|(c, _)| c.clone()).unwrap_or_default()),
                            None => (event.to_string(), id.clone()),
                        };
                        drafts.push(RecordDraft {
                            kind,
                            event,
                            summary,
                            started_at: ts,
                            completed_at: if kind == "tool" { None } else { ts },
                            status: if kind == "tool" { "running" } else { "complete" },
                            input: if full { detail } else { None },
                            output: None,
                            usage: usage.clone(),
                            metadata: Map::new(),
                            turn: current_turn,
                            step: Some(step),
                            id,
                        });
                        if let Some((cid, _)) = call_id {
                            if !cid.is_empty() {
                                pending_tools.insert(cid, pos);
                            }
                        }
                    }
                }
                Evt::ToolResult { call_id, name, error, output } => {
                    if let Some(pos) = pending_tools.remove(&call_id) {
                        // Completes an existing tool record; never reopens a
                        // turn that was explicitly ended (codex turn_aborted).
                        after_tool_result = true;
                        if error {
                            tool_errors += 1;
                        }
                        if let Some(record) = drafts.get_mut(pos) {
                            record.completed_at = ts;
                            record.status = if error { "error" } else { "complete" };
                            record.output = if full { Some(detail_text(&output, DETAIL_LIMIT)) } else { None };
                            if error {
                                record.summary = shorten(&format!("{} · error", record.summary), SUMMARY_LIMIT);
                            }
                        }
                    } else if !call_id.is_empty() {
                        // Orphan result (call predates the record window).
                        ensure_turn!(ts);
                        after_tool_result = true;
                        tool_calls += 1;
                        if error {
                            tool_errors += 1;
                        }
                        drafts.push(RecordDraft {
                            kind: "tool",
                            event: if name.is_empty() { "tool".into() } else { name.clone() },
                            summary: shorten(&name, SUMMARY_LIMIT),
                            started_at: ts,
                            completed_at: ts,
                            status: if error { "error" } else { "complete" },
                            input: None,
                            output: if full { Some(detail_text(&output, DETAIL_LIMIT)) } else { None },
                            usage: None,
                            metadata: Map::new(),
                            turn: current_turn,
                            step: Some(current_step.max(1)),
                            id: call_id.clone(),
                        });
                    }
                }
                Evt::Compaction { id, summary, tokens_before } => {
                    ensure_turn!(ts);
                    let mut metadata = Map::new();
                    if let Some(t) = tokens_before {
                        metadata.insert("tokensBefore".into(), json!(t));
                    }
                    drafts.push(RecordDraft {
                        kind: "compaction",
                        event: "compaction".into(),
                        summary: shorten(&summary, SUMMARY_LIMIT),
                        started_at: ts,
                        completed_at: ts,
                        status: "complete",
                        input: if full { Some(detail_text(&summary, DETAIL_LIMIT)) } else { None },
                        output: None,
                        usage: None,
                        metadata,
                        turn: current_turn,
                        step: Some(current_step.max(1)),
                        id,
                    });
                }
                Evt::System { id, event, summary, model: m } => {
                    if let Some(mv) = &m {
                        if !mv.is_empty() && !models_seen.contains(mv) {
                            models_seen.push(mv.clone());
                        }
                        if !mv.is_empty() {
                            model = Some(mv.clone());
                        }
                    }
                    ensure_turn!(ts);
                    drafts.push(RecordDraft {
                        kind: "system",
                        event: event.into(),
                        summary: shorten(&summary, SUMMARY_LIMIT),
                        started_at: ts,
                        completed_at: ts,
                        status: "complete",
                        input: None,
                        output: None,
                        usage: None,
                        metadata: Map::new(),
                        turn: current_turn,
                        step: Some(current_step.max(1)),
                        id,
                    });
                }
                Evt::TurnEnd { aborted } => {
                    close_turn!(ts, if aborted { "aborted" } else { "complete" });
                }
                Evt::UsageTotals(snapshot) => {
                    for key in ["input", "output", "cacheRead", "cacheWrite"] {
                        if let Some(v) = snapshot.get(key).and_then(Value::as_i64) {
                            totals[key] = json!(v);
                        }
                    }
                }
            }
        }
    }
    close_turn!(last_ts, "complete");

    let truncated = drafts.len().saturating_sub(max_records);
    if truncated > 0 {
        warnings.push(json!({
            "type": "truncated",
            "message": format!("{} older records omitted; raise --max-records (max {})", truncated, HARD_MAX_RECORDS),
        }));
    }
    let window: Vec<RecordDraft> = drafts.into_iter().skip(truncated).collect();

    let records: Vec<Value> = window
        .iter()
        .enumerate()
        .map(|(i, d)| {
            json!({
                "index": i + 1,
                "id": d.id,
                "turn": d.turn,
                "step": d.step,
                "kind": d.kind,
                "event": d.event,
                "summary": d.summary,
                "startedAt": iso(d.started_at),
                "completedAt": iso(d.completed_at),
                "durationMs": ms_between(d.started_at, d.completed_at),
                "status": d.status,
                "input": d.input,
                "output": d.output,
                "usage": d.usage,
                "metadata": d.metadata,
            })
        })
        .collect();

    // Per-turn visible record counts from the returned window.
    let mut visible_counts: Vec<i64> = vec![0; turns.len()];
    for r in &records {
        let t = r["turn"].as_i64().unwrap_or(1) as usize;
        if (1..=turns.len()).contains(&t) {
            visible_counts[t - 1] += 1;
        }
    }
    for (i, t) in turns.iter_mut().enumerate() {
        t["records"] = json!(visible_counts[i]);
    }

    let stats = json!({
        "turns": turns.len(),
        "records": records.len() + truncated,
        "returnedRecords": records.len(),
        "truncated": truncated,
        "steps": turns.iter().filter_map(|t| t.get("steps")).filter_map(Value::as_i64).sum::<i64>(),
        "toolCalls": tool_calls,
        "toolErrors": tool_errors,
        "ignoredEntries": ignored,
        "tokens": totals,
        "durationMs": ms_between(first_ts, last_ts),
    });

    Ok(json!({
        "schemaVersion": 1,
        "detailLevel": if full { "full" } else { "summary" },
        "generatedAt": crate::constants::now_iso(),
        "session": {
            "id": effective_session_id(&session_id, path),
            "parentSessionId": if session_id.is_empty() || effective_session_id(&session_id, path) == session_id { Value::Null } else { json!(session_id) },
            "title": shorten(if first_user.is_empty() { "Untitled session" } else { &first_user }, 100),
            "cwd": cwd,
            "provider": provider,
            "model": model,
            "models": models_seen,
            "startedAt": iso(first_ts),
            "updatedAt": iso(last_ts),
        },
        "stats": stats,
        "turns": turns,
        "records": records,
        "warnings": warnings,
    }))
}

fn parse_ts(value: Option<&str>) -> Option<DateTime<Utc>> {
    value
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .map(|d| d.with_timezone(&Utc))
}

/// Preferred display id: a trailing UUID in the file name (how Starling and
/// `starling session ls` index sessions) when it disagrees with the id embedded
/// in the transcript (e.g. Codex nested review rollouts carry the parent's
/// session id in session_meta). Falls back to the embedded id, then the stem.
fn effective_session_id(embedded: &str, path: &Path) -> String {
    let stem = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    // Last five '-'-separated segments of the stem, i.e. a trailing UUID.
    let tail: Vec<&str> = stem.rsplit('-').take(5).collect();
    if tail.len() == 5 {
        let candidate = tail.iter().rev().copied().collect::<Vec<_>>().join("-");
        let is_uuid = candidate.len() == 36
            && candidate.bytes().enumerate().all(|(i, b)| {
                if matches!(i, 8 | 13 | 18 | 23) {
                    b == b'-'
                } else {
                    b.is_ascii_hexdigit()
                }
            });
        if is_uuid && !candidate.eq_ignore_ascii_case(embedded) {
            return candidate;
        }
    }
    if embedded.is_empty() {
        stem
    } else {
        embedded.to_string()
    }
}

fn iso(ts: Option<DateTime<Utc>>) -> Option<String> {
    ts.map(|t| t.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}

fn ms_between(start: Option<DateTime<Utc>>, end: Option<DateTime<Utc>>) -> Option<i64> {
    match (start, end) {
        (Some(a), Some(b)) if b >= a => Some((b - a).num_milliseconds()),
        _ => None,
    }
}

/// First line of text, whitespace-normalized, bounded.
fn shorten(text: &str, limit: usize) -> String {
    let flat: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let flat = flat.replace('\n', " ");
    if flat.chars().count() <= limit {
        flat
    } else {
        let cut: String = flat.chars().take(limit).collect();
        format!("{}…", cut.trim_end())
    }
}

/// Detail text (input/output) keeps its structure — newlines are what makes
/// markdown renderable downstream; only truncate, never flatten. The webview
/// inspector renders this with the same marked pipeline as pi's TUI export.
fn detail_text(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        text.to_string()
    } else {
        let cut: String = text.chars().take(limit).collect();
        format!("{}…", cut.trim_end())
    }
}

fn fmt_duration(ms: Option<i64>) -> String {
    match ms {
        None => "—".into(),
        Some(ms) if ms < 1_000 => format!("{}ms", ms),
        Some(ms) if ms < 60_000 => format!("{:.1}s", ms as f64 / 1_000.0),
        Some(ms) if ms < 3_600_000 => format!("{}m{}s", ms / 60_000, (ms % 60_000) / 1_000),
        Some(ms) => format!("{}h{}m", ms / 3_600_000, (ms % 3_600_000) / 60_000),
    }
}

fn fmt_tokens(n: i64) -> String {
    if n.abs() >= 1_000_000 {
        format!("{:.1}M", n as f64 / 1_000_000.0)
    } else if n.abs() >= 1_000 {
        format!("{:.1}k", n as f64 / 1_000.0)
    } else {
        n.to_string()
    }
}

fn render(t: &Value, fallback_id: &str) {
    let session = &t["session"];
    let stats = &t["stats"];
    println!(
        "{}",
        format!(
            "Trajectory: {}",
            shorten(session["id"].as_str().unwrap_or(fallback_id), 40)
        )
        .cyan()
        .bold()
    );
    println!("  {} {}", "Title:".dimmed(), session["title"].as_str().unwrap_or("Untitled"));
    if let Some(parent) = session["parentSessionId"].as_str() {
        println!("  {} {} (nested rollout)", "Parent:".dimmed(), parent);
    }
    let mut meta_bits = vec![
        format!("Provider: {}", session["provider"].as_str().unwrap_or("—")),
        format!("Model: {}", session["model"].as_str().unwrap_or("—")),
        format!("Turns: {}", stats["turns"]),
        format!("Records: {}", stats["records"]),
        format!("Tools: {} ({} errors)", stats["toolCalls"], stats["toolErrors"]),
    ];
    if stats["truncated"].as_i64().unwrap_or(0) > 0 {
        meta_bits.push(format!("{} truncated", stats["truncated"]));
    }
    meta_bits.push(format!("Duration: {}", fmt_duration(stats["durationMs"].as_i64())));
    println!("  {}", meta_bits.join(" · ").dimmed());
    let tokens = &stats["tokens"];
    println!(
        "  {} ↑{} ↓{} R{} W{} · ${:.4}",
        "Tokens:".dimmed(),
        fmt_tokens(tokens["input"].as_i64().unwrap_or(0)),
        fmt_tokens(tokens["output"].as_i64().unwrap_or(0)),
        fmt_tokens(tokens["cacheRead"].as_i64().unwrap_or(0)),
        fmt_tokens(tokens["cacheWrite"].as_i64().unwrap_or(0)),
        tokens["cost"].as_f64().unwrap_or(0.0),
    );
    println!();

    let empty = Vec::new();
    let turns = t["turns"].as_array().unwrap_or(&empty);
    let records = t["records"].as_array().unwrap_or(&empty);
    let by_turn: std::collections::BTreeMap<i64, Vec<&Value>> =
        records.iter().fold(std::collections::BTreeMap::new(), |mut acc, r| {
            if let Some(turn) = r["turn"].as_i64() {
                acc.entry(turn).or_default().push(r);
            }
            acc
        });

    for turn in turns {
        let idx = turn["index"].as_i64().unwrap_or(0);
        let time = turn["startedAt"].as_str().and_then(|s| s.get(11..19)).unwrap_or("—");
        println!(
            "{}",
            format!(
                "── Turn {} · {} · {} · {} steps{}",
                idx,
                time,
                fmt_duration(turn["durationMs"].as_i64()),
                turn["steps"].as_i64().unwrap_or(0),
                if turn["status"].as_str() == Some("aborted") { " · aborted" } else { "" },
            )
            .yellow()
        );
        if let Some(rows) = by_turn.get(&idx) {
            for r in rows {
                let kind = r["kind"].as_str().unwrap_or("?");
                let event = r["event"].as_str().unwrap_or("");
                let status_mark = match r["status"].as_str().unwrap_or("complete") {
                    "error" => "✗".red().to_string(),
                    "running" => "…".dimmed().to_string(),
                    _ => "·".dimmed().to_string(),
                };
                let step = r["step"].as_i64().unwrap_or(0);
                let summary = r["summary"].as_str().unwrap_or("");
                println!(
                    "  {:>3} {} {:<9} {:<14} {:<50} {}",
                    format!("#{}", r["index"].as_i64().unwrap_or(0)),
                    format!("s{}", step).dimmed(),
                    kind,
                    shorten(event, 14),
                    shorten(summary, 50),
                    status_mark,
                );
            }
        } else {
            println!("  {}", "(records truncated)".dimmed());
        }
    }

    for w in t["warnings"].as_array().unwrap_or(&empty) {
        println!("{}", format!("warning: {}", w["message"].as_str().unwrap_or("")).yellow());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_session(lines: &[Value]) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("starling-traj-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("s.jsonl");
        let raw: String = lines
            .iter()
            .map(|v| serde_json::to_string(v).unwrap())
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(&file, raw).unwrap();
        file
    }

    #[test]
    fn projects_pi_turns_steps_and_tool_results() {
        let file = write_session(&[
            json!({"type":"session","id":"abc","cwd":"/tmp/p","timestamp":"2026-01-01T00:00:00Z","version":3}),
            json!({"type":"message","id":"e1","parentId":null,"timestamp":"2026-01-01T00:00:01Z",
                   "message":{"role":"user","content":[{"type":"text","text":"list files"}]}}),
            json!({"type":"message","id":"e2","parentId":"e1","timestamp":"2026-01-01T00:00:02Z",
                   "message":{"role":"assistant","model":"m1","content":[
                       {"type":"thinking","thinking":"need ls"},
                       {"type":"toolCall","id":"c1","name":"bash","arguments":{"command":"ls"}}],
                       "usage":{"input":10,"output":5,"cacheRead":0,"cacheWrite":0,"cost":{"total":0.01}}}}),
            json!({"type":"message","id":"e3","parentId":"e2","timestamp":"2026-01-01T00:00:04Z",
                   "message":{"role":"toolResult","toolCallId":"c1","toolName":"bash","isError":false,
                              "content":[{"type":"text","text":"a.txt"}]}}),
            json!({"type":"message","id":"e4","parentId":"e3","timestamp":"2026-01-01T00:00:06Z",
                   "message":{"role":"assistant","model":"m1","content":[{"type":"text","text":"here is a.txt"}],
                              "usage":{"input":20,"output":7,"cacheRead":0,"cacheWrite":0,"cost":{"total":0.02}}}}),
            json!({"type":"model_change","id":"e5","parentId":"e4","timestamp":"2026-01-01T00:00:07Z","provider":"x","modelId":"m2"}),
        ]);
        let t = project(&file, "pi", true, 500).unwrap();
        assert_eq!(t["session"]["id"], "abc");
        assert_eq!(t["session"]["model"], "x/m2");
        assert_eq!(t["stats"]["turns"], 1);
        assert_eq!(t["stats"]["toolCalls"], 1);
        assert_eq!(t["stats"]["steps"], 2);
        let records = t["records"].as_array().unwrap();
        let tool = records.iter().find(|r| r["kind"] == "tool").unwrap();
        assert_eq!(tool["status"], "complete");
        assert_eq!(tool["durationMs"], 2000);
        assert_eq!(tool["output"], "a.txt");
        assert!(records.iter().any(|r| r["kind"] == "reasoning"));
        assert!(records.iter().any(|r| r["kind"] == "system" && r["event"] == "model_change"));
        assert_eq!(t["stats"]["tokens"]["input"], 30);
        assert_eq!(t["stats"]["tokens"]["cost"], 0.03);
    }

    #[test]
    fn projects_claude_tool_use_pairs() {
        let file = write_session(&[
            json!({"type":"user","uuid":"u1","sessionId":"s1","cwd":"/tmp/c","timestamp":"2026-01-01T00:00:00Z",
                   "message":{"role":"user","content":"run tests"}}),
            json!({"type":"assistant","uuid":"a1","sessionId":"s1","timestamp":"2026-01-01T00:00:01Z",
                   "message":{"role":"assistant","model":"claude-x","content":[
                       {"type":"thinking","thinking":"plan"},
                       {"type":"tool_use","id":"t1","name":"Bash","input":{"command":"pytest"}}],
                       "usage":{"input_tokens":100,"output_tokens":10,"cache_read_input_tokens":50,"cache_creation_input_tokens":5}}}),
            json!({"type":"user","uuid":"u2","sessionId":"s1","timestamp":"2026-01-01T00:00:03Z","toolUseResult":{},
                   "message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","is_error":false,"content":"3 passed"}]}}),
            json!({"type":"assistant","uuid":"a2","sessionId":"s1","timestamp":"2026-01-01T00:00:05Z",
                   "message":{"role":"assistant","model":"claude-x","content":[{"type":"text","text":"all green"}],
                       "usage":{"input_tokens":200,"output_tokens":20,"cache_read_input_tokens":80,"cache_creation_input_tokens":0}}}),
        ]);
        let t = project(&file, "claude", true, 500).unwrap();
        assert_eq!(t["session"]["provider"], "claude");
        assert_eq!(t["session"]["model"], "claude-x");
        assert_eq!(t["stats"]["turns"], 1, "tool-result carrier must not open a new turn");
        let records = t["records"].as_array().unwrap();
        let tool = records.iter().find(|r| r["kind"] == "tool").unwrap();
        assert_eq!(tool["event"], "Bash");
        assert_eq!(tool["output"], "3 passed");
        assert_eq!(tool["durationMs"], 2000);
        assert_eq!(t["stats"]["tokens"]["input"], 300);
        assert_eq!(t["stats"]["tokens"]["cacheRead"], 130);
    }

    #[test]
    fn projects_codex_rollout() {
        let file = write_session(&[
            json!({"type":"session_meta","timestamp":"2026-01-01T00:00:00Z","payload":{"session_id":"cx1","cwd":"/tmp/x"}}),
            json!({"type":"event_msg","timestamp":"2026-01-01T00:00:01Z","payload":{"type":"user_message","message":"refactor"}}),
            json!({"type":"turn_context","timestamp":"2026-01-01T00:00:01Z","payload":{"type":"turn_context","model":"gpt-x","effort":"high"}}),
            json!({"type":"response_item","timestamp":"2026-01-01T00:00:02Z","payload":{"type":"reasoning","summary":[{"type":"summary_text","text":"think"}]}}),
            json!({"type":"response_item","timestamp":"2026-01-01T00:00:02Z","payload":{"type":"function_call","name":"shell","call_id":"f1","arguments":"{\"cmd\":\"cargo test\"}"}}),
            json!({"type":"response_item","timestamp":"2026-01-01T00:00:04Z","payload":{"type":"function_call_output","call_id":"f1","output":"ok"}}),
            json!({"type":"event_msg","timestamp":"2026-01-01T00:00:06Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":500,"output_tokens":50,"cached_input_tokens":900}}}}),
            json!({"type":"response_item","timestamp":"2026-01-01T00:00:07Z","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"done"}]}}),
            json!({"type":"event_msg","timestamp":"2026-01-01T00:00:08Z","payload":{"type":"turn_aborted"}}),
        ]);
        let t = project(&file, "codex", true, 500).unwrap();
        assert_eq!(t["session"]["provider"], "codex");
        assert_eq!(t["session"]["model"], "gpt-x");
        assert_eq!(t["stats"]["turns"], 1);
        let records = t["records"].as_array().unwrap();
        let tool = records.iter().find(|r| r["kind"] == "tool").unwrap();
        assert_eq!(tool["event"], "shell");
        assert_eq!(tool["output"], "ok");
        assert!(records.iter().any(|r| r["kind"] == "reasoning"));
        assert!(records.iter().any(|r| r["kind"] == "assistant" && r["summary"] == "done"));
        // token_count is a cumulative snapshot: totals reflect it directly.
        assert_eq!(t["stats"]["tokens"]["input"], 500);
        assert_eq!(t["stats"]["tokens"]["cacheRead"], 900);
        // turn_aborted marks the turn aborted.
        assert_eq!(t["turns"][0]["status"], "aborted");
        // Empty (encrypted) reasoning summary gets an explicit label.
        assert!(records
            .iter()
            .any(|r| r["kind"] == "reasoning" && r["summary"] == "think"));
    }

    #[test]
    fn marks_tool_errors_and_truncates() {
        let mut lines = vec![json!({"type":"session","id":"t2","cwd":"/tmp","timestamp":"2026-01-01T00:00:00Z"})];
        for i in 0..60 {
            lines.push(json!({"type":"message","id":format!("u{i}"),"timestamp":"2026-01-01T00:00:01Z",
                "message":{"role":"user","content":[{"type":"text","text":format!("q{i}")}]}}));
            lines.push(json!({"type":"message","id":format!("a{i}"),"timestamp":"2026-01-01T00:00:02Z",
                "message":{"role":"assistant","model":"m","content":[{"type":"toolCall","id":format!("c{i}"),"name":"bash","arguments":{}}]}}));
            lines.push(json!({"type":"message","id":format!("r{i}"),"timestamp":"2026-01-01T00:00:03Z",
                "message":{"role":"toolResult","toolCallId":format!("c{i}"),"toolName":"bash","isError":true,
                    "content":[{"type":"text","text":"boom"}]}}));
        }
        let file = write_session(&lines);
        let t = project(&file, "pi", false, 50).unwrap();
        assert_eq!(t["stats"]["toolErrors"], 60);
        assert_eq!(t["stats"]["toolCalls"], 60);
        assert_eq!(t["stats"]["truncated"], 70); // 120 total records - 50
        assert_eq!(t["records"].as_array().unwrap().len(), 50);
        assert!(!t["warnings"].as_array().unwrap().is_empty());
        let errored = t["records"].as_array().unwrap().iter().any(|r| r["status"] == "error");
        assert!(errored, "visible window contains error tool records");
    }
}
