//! `starling trajectory` — project a Pi session transcript into a
//! turn-aware trajectory ledger (turns → steps → records) with timing,
//! token usage, and tool outcomes. Schema mirrors the trajectory-v1 shape
//! used by codex-trajectory (inspired by DeepSeek Harness's event ledger).

use std::collections::HashMap;
use std::path::Path;

use anyhow::Result;
use chrono::{DateTime, Utc};
use colored::*;
use serde_json::{json, Map, Value};

use crate::cli::*;
use crate::core::discovery::{find_session_by_id, find_sessions, Provider as DiscoveryProvider};
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
    let trajectory = project(Path::new(&meta.file_path), full, max_records)?;

    if json {
        println!("{}", serde_json::to_string_pretty(&trajectory)?);
        return Ok(());
    }
    render(&trajectory, &meta.session_id);
    Ok(())
}

/// Default to the most recent Pi session; explicit IDs reuse the normal
/// resolver. Trajectory speaks the Pi transcript vocabulary only.
fn resolve_session(session_id: Option<&str>) -> Result<crate::types::SessionMeta> {
    let meta = match session_id {
        Some(id) => find_session_by_id(id),
        None => find_sessions(50, Some(DiscoveryProvider::Pi))
            .into_iter()
            .find(|m| Path::new(&m.file_path).is_file()),
    };
    match meta {
        Some(m) if m.provider == "pi" => Ok(m),
        Some(m) => anyhow::bail!(
            "trajectory supports Pi sessions; {} session {} uses a different transcript format",
            m.provider,
            m.session_id
        ),
        None => anyhow::bail!("Pi session not found"),
    }
}

fn parse_ts(value: Option<&str>) -> Option<DateTime<Utc>> {
    value.and_then(|s| DateTime::parse_from_rfc3339(s).ok()).map(|d| d.with_timezone(&Utc))
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
    let flat: String = text
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let flat = flat.replace('\n', " ");
    if flat.chars().count() <= limit {
        flat
    } else {
        let cut: String = flat.chars().take(limit).collect();
        format!("{}…", cut.trim_end())
    }
}

fn content_text(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter_map(|b| b.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n")
            .trim()
            .to_string(),
        _ => String::new(),
    }
}

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

pub fn project(path: &Path, full: bool, max_records: usize) -> Result<Value> {
    let entries = parse_jsonl_file(path);
    if entries.is_empty() {
        anyhow::bail!("no readable JSONL entries in {}", path.display());
    }

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
    // toolCallId → (record position, started timestamp)
    let mut pending_tools: HashMap<String, (usize, Option<DateTime<Utc>>)> = HashMap::new();

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
        ($completed:expr) => {
            if turn_active {
                if let Some(t) = turns.last_mut() {
                    t["completedAt"] = json!(iso($completed));
                    t["durationMs"] = json!(ms_between(
                        parse_ts(t.get("startedAt").and_then(Value::as_str)),
                        $completed
                    ));
                    t["status"] = json!("complete");
                    t["tokens"] = turn_tokens.clone();
                }
                turn_active = false;
                turn_tokens = json!({"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "cost": 0.0});
            }
        };
    }

    macro_rules! ensure_turn {
        ($ts:expr, $id:expr) => {{
            if !turn_active {
                current_turn += 1;
                current_step = 0;
                turn_active = true;
                turns.push(json!({
                    "index": current_turn,
                    "id": $id,
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
        match obj.get("type").and_then(Value::as_str) {
            Some("session") => {
                session_id = obj
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                cwd = obj.get("cwd").and_then(Value::as_str).map(str::to_string);
            }
            Some("message") => {
                let msg = obj.get("message").cloned().unwrap_or(Value::Null);
                let role = msg.get("role").and_then(Value::as_str).unwrap_or("");
                let id = obj.get("id").and_then(Value::as_str).unwrap_or("").to_string();
                match role {
                    "user" => {
                        close_turn!(ts);
                        ensure_turn!(ts, Value::Null);
                        after_tool_result = false;
                        let text = content_text(msg.get("content").unwrap_or(&Value::Null));
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
                            input: if full { Some(shorten(&text, DETAIL_LIMIT)) } else { None },
                            output: None,
                            usage: None,
                            metadata: Map::new(),
                            turn: current_turn,
                            step: Some(1),
                            id,
                        });
                    }
                    "assistant" => {
                        ensure_turn!(ts, Value::Null);
                        if after_tool_result {
                            current_step += 1;
                            after_tool_result = false;
                        }
                        let usage = msg.get("usage").cloned().filter(|u| u.is_object());
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

                        if model.is_none() {
                            if let Some(m) = msg.get("model").and_then(Value::as_str) {
                                model = Some(m.to_string());
                            }
                        }
                        if let Some(blocks) = msg.get("content").and_then(Value::as_array) {
                            for block in blocks {
                                let btype = block.get("type").and_then(Value::as_str).unwrap_or("");
                                let (kind, event, summary, detail) = match btype {
                                    "thinking" => {
                                        let t = block.get("thinking").and_then(Value::as_str).unwrap_or("");
                                        ("reasoning", "thinking", shorten(t, SUMMARY_LIMIT), Some(shorten(t, DETAIL_LIMIT)))
                                    }
                                    "text" => {
                                        let t = block.get("text").and_then(Value::as_str).unwrap_or("");
                                        ("assistant", "message", shorten(t, SUMMARY_LIMIT), Some(shorten(t, DETAIL_LIMIT)))
                                    }
                                    "toolCall" => {
                                        let name = block.get("name").and_then(Value::as_str).unwrap_or("tool");
                                        let args = block
                                            .get("arguments")
                                            .map(|a| serde_json::to_string(a).unwrap_or_default())
                                            .unwrap_or_default();
                                        tool_calls += 1;
                                        let summary = format!("{} {}", name, shorten(&args, 60));
                                        ("tool", name, shorten(summary.trim(), SUMMARY_LIMIT), Some(shorten(&args, DETAIL_LIMIT)))
                                    }
                                    _ => continue,
                                };
                                if kind == "tool" {
                                    current_step = current_step.max(1);
                                }
                                let step = if current_step == 0 { 1 } else { current_step };
                                if let Some(t) = turns.last_mut() {
                                    t["steps"] = json!(t["steps"].as_i64().unwrap_or(0).max(step as i64));
                                }
                                let pos = drafts.len();
                                let mut call_id = String::new();
                                drafts.push(RecordDraft {
                                    kind,
                                    event: event.to_string(),
                                    summary,
                                    started_at: ts,
                                    completed_at: if kind == "tool" { None } else { Some(ts.unwrap_or_default()) },
                                    status: if kind == "tool" { "running" } else { "complete" },
                                    input: if full { detail } else { None },
                                    output: None,
                                    usage: usage.clone(),
                                    metadata: Map::new(),
                                    turn: current_turn,
                                    step: Some(step),
                                    id: {
                                        if kind == "tool" {
                                            call_id = block.get("id").and_then(Value::as_str).unwrap_or("").to_string();
                                            call_id.clone()
                                        } else {
                                            id.clone()
                                        }
                                    },
                                });
                                if kind == "tool" && !call_id.is_empty() {
                                    pending_tools.insert(call_id, (pos, ts));
                                }
                            }
                        }
                    }
                    "toolResult" => {
                        ensure_turn!(ts, Value::Null);
                        after_tool_result = true;
                        let call_id = msg.get("toolCallId").and_then(Value::as_str).unwrap_or("");
                        let is_error = msg.get("isError").and_then(Value::as_bool).unwrap_or(false);
                        let name = msg.get("toolName").and_then(Value::as_str).unwrap_or("tool");
                        if let Some((pos, started)) = pending_tools.remove(call_id) {
                            if is_error {
                                tool_errors += 1;
                            }
                            if let Some(record) = drafts.get_mut(pos) {
                                record.completed_at = ts;
                                record.status = if is_error { "error" } else { "complete" };
                                let out = content_text(msg.get("content").unwrap_or(&Value::Null));
                                record.output = if full { Some(shorten(&out, DETAIL_LIMIT)) } else { None };
                                if is_error {
                                    record.summary = shorten(&format!("{} · error", record.summary), SUMMARY_LIMIT);
                                }
                            }
                            let _ = started;
                        } else {
                            // Orphan result (call predates the record window).
                            drafts.push(RecordDraft {
                                kind: "tool",
                                event: name.to_string(),
                                summary: shorten(name, SUMMARY_LIMIT),
                                started_at: ts,
                                completed_at: ts,
                                status: if is_error { "error" } else { "complete" },
                                input: None,
                                output: None,
                                usage: None,
                                metadata: Map::new(),
                                turn: current_turn,
                                step: Some(current_step.max(1)),
                                id: call_id.to_string(),
                            });
                            if is_error {
                                tool_errors += 1;
                            }
                            tool_calls += 1;
                        }
                    }
                    _ => {
                        ignored += 1;
                    }
                }
            }
            Some("compaction") => {
                let tokens_before = obj.get("tokensBefore").and_then(Value::as_i64);
                let summary_text = obj.get("summary").and_then(Value::as_str).unwrap_or("");
                ensure_turn!(ts, Value::Null);
                let mut metadata = Map::new();
                if let Some(t) = tokens_before {
                    metadata.insert("tokensBefore".into(), json!(t));
                }
                drafts.push(RecordDraft {
                    kind: "compaction",
                    event: "compaction".into(),
                    summary: shorten(summary_text, SUMMARY_LIMIT),
                    started_at: ts,
                    completed_at: ts,
                    status: "complete",
                    input: if full { Some(shorten(summary_text, DETAIL_LIMIT)) } else { None },
                    output: None,
                    usage: obj.get("usage").cloned(),
                    metadata,
                    turn: current_turn,
                    step: Some(current_step.max(1)),
                    id: obj.get("id").and_then(Value::as_str).unwrap_or("").to_string(),
                });
            }
            Some("model_change") => {
                let provider = obj.get("provider").and_then(Value::as_str).unwrap_or("");
                let model_id = obj.get("modelId").and_then(Value::as_str).unwrap_or("");
                let label = format!("{}/{}", provider, model_id);
                if !models_seen.contains(&label) {
                    models_seen.push(label.clone());
                }
                model = Some(label.clone());
                ensure_turn!(ts, Value::Null);
                drafts.push(RecordDraft {
                    kind: "system",
                    event: "model_change".into(),
                    summary: shorten(&label, SUMMARY_LIMIT),
                    started_at: ts,
                    completed_at: ts,
                    status: "complete",
                    input: None,
                    output: None,
                    usage: None,
                    metadata: Map::new(),
                    turn: current_turn,
                    step: Some(current_step.max(1)),
                    id: obj.get("id").and_then(Value::as_str).unwrap_or("").to_string(),
                });
            }
            Some("thinking_level_change") => {
                let level = obj.get("thinkingLevel").and_then(Value::as_str).unwrap_or("");
                ensure_turn!(ts, Value::Null);
                drafts.push(RecordDraft {
                    kind: "system",
                    event: "thinking_level".into(),
                    summary: level.to_string(),
                    started_at: ts,
                    completed_at: ts,
                    status: "complete",
                    input: None,
                    output: None,
                    usage: None,
                    metadata: Map::new(),
                    turn: current_turn,
                    step: Some(current_step.max(1)),
                    id: obj.get("id").and_then(Value::as_str).unwrap_or("").to_string(),
                });
            }
            Some("branch_summary") => {
                let summary_text = obj.get("summary").and_then(Value::as_str).unwrap_or("");
                ensure_turn!(ts, Value::Null);
                drafts.push(RecordDraft {
                    kind: "system",
                    event: "branch_summary".into(),
                    summary: shorten(summary_text, SUMMARY_LIMIT),
                    started_at: ts,
                    completed_at: ts,
                    status: "complete",
                    input: if full { Some(shorten(summary_text, DETAIL_LIMIT)) } else { None },
                    output: None,
                    usage: None,
                    metadata: Map::new(),
                    turn: current_turn,
                    step: Some(current_step.max(1)),
                    id: obj.get("id").and_then(Value::as_str).unwrap_or("").to_string(),
                });
            }
            _ => {
                ignored += 1;
            }
        }
    }
    close_turn!(last_ts);

    // Any tool call still pending at EOF stays "running" only if the session
    // is live; a finished file marks it aborted. Keep it simple: leave as-is.
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
            "id": if session_id.is_empty() { path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default() } else { session_id },
            "title": shorten(if first_user.is_empty() { "Untitled session" } else { &first_user }, 100),
            "cwd": cwd,
            "provider": "pi",
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

fn fmt_duration(ms: Option<i64>) -> String {
    match ms {
        None => "—".into(),
        Some(ms) if ms < 1_000 => format!("{}ms", ms),
        Some(ms) if ms < 60_000 => format!("{:.1}s", ms as f64 / 1_000.0),
        Some(ms) if ms < 3_600_000 => {
            let m = ms / 60_000;
            let s = (ms % 60_000) / 1_000;
            format!("{}m{}s", m, s)
        }
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
    println!(
        "  {} {}",
        "Title:".dimmed(),
        session["title"].as_str().unwrap_or("Untitled")
    );
    let mut meta_bits = vec![
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
        let time = turn["startedAt"]
            .as_str()
            .and_then(|s| s.get(11..19))
            .unwrap_or("—");
        let status = turn["status"].as_str().unwrap_or("complete");
        println!(
            "{}",
            format!(
                "── Turn {} · {} · {} · {} steps",
                idx,
                time,
                fmt_duration(turn["durationMs"].as_i64()),
                turn["steps"].as_i64().unwrap_or(0),
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
            let _ = status;
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
    fn projects_turns_steps_and_tool_results() {
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
        let t = project(&file, true, 500).unwrap();
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
        let t = project(&file, false, 50).unwrap();
        assert_eq!(t["stats"]["toolErrors"], 60);
        assert_eq!(t["stats"]["toolCalls"], 60);
        assert_eq!(t["stats"]["truncated"], 70); // 120 total records - 50
        assert_eq!(t["records"].as_array().unwrap().len(), 50);
        assert!(!t["warnings"].as_array().unwrap().is_empty());
        let errored = t["records"].as_array().unwrap().iter().any(|r| r["status"] == "error");
        assert!(errored, "visible window contains error tool records");
    }
}
