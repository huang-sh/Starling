//! Live per-session metrics — mirrors src/lib/sessionMetrics.ts.
//!
//! Reads JSONL transcripts (full read for small files, tail read for large
//! ones), reducing to a `SessionLive` struct with cumulative tokens, CTX%
//! (context-window pressure), latest tool call, tool/chat tails, etc.

use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

use once_cell::sync::Lazy;
use serde::Serialize;
use serde_json::Value;

use crate::core::model_config::{configured_context_window_for_model, context_window_for_model};
use crate::core::session::{parse_jsonl_text, JsonlEntry};

const FULL_READ_THRESHOLD: u64 = 8 * 1024 * 1024; // 8MB
const TAIL_BYTES: u64 = 65_536;
const MAX_LINES: usize = 100_000;
const MAX_TOKEN_HISTORY: usize = 32;
const MAX_TOOL_TAIL: usize = 12;
const MAX_CHAT_TAIL: usize = 6;
const MAX_TOOL_ARG_LEN: usize = 60;
const MAX_CHAT_TEXT_LEN: usize = 200;
const COMPACTION_DROP_RATIO: f64 = 0.3;

#[derive(Debug, Clone, Default, Serialize)]
pub struct SessionTokens {
    pub input: u64,
    pub output: u64,
    pub cache: u64,
    pub total: u64,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ChatRole {
    User,
    Assistant,
}

#[derive(Debug, Clone, Serialize)]
pub struct ToolCallEntry {
    pub name: String,
    pub arg: String,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ChatMessageEntry {
    pub role: ChatRole,
    pub text: String,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct SessionLive {
    pub model: String,
    pub tokens: SessionTokens,
    /// 0..100+ context-window pressure; -1 when unknown.
    pub ctx_pct: i64,
    pub last_tool: Option<String>,
    pub tool_count: u32,
    pub last_activity_ms: u64,
    pub truncated: bool,
    pub started_at_ms: u64,
    pub pending_since_ms: u64,
    pub thinking_since_ms: u64,
    pub activity_status: Option<String>,
    pub activity_signal: Option<String>,
    pub activity_since_ms: u64,
    pub token_history: Vec<u64>,
    pub context_history: Vec<u64>,
    pub compaction_count: u32,
    pub current_task: String,
    pub tool_calls_tail: Vec<ToolCallEntry>,
    pub chat_tail: Vec<ChatMessageEntry>,
}

pub fn empty_live(last_activity_ms: u64) -> SessionLive {
    SessionLive {
        last_activity_ms,
        ctx_pct: -1,
        ..Default::default()
    }
}

pub fn model_context_window(model: Option<&str>) -> u64 {
    context_window_for_model(model)
}

fn truncate(s: &str, max: usize) -> String {
    let len = s.chars().count();
    if len <= max {
        return s.to_string();
    }
    let prefix: String = s.chars().take(max.saturating_sub(1)).collect();
    format!("{prefix}…")
}

#[derive(Default, Clone, Copy)]
struct AssistantUsage {
    input: u64,
    output: u64,
    cache_creation: u64,
    cache_read: u64,
}

#[derive(Default, Clone, Copy)]
struct CodexTokenCount {
    total: AssistantUsage,
    last: Option<AssistantUsage>,
    context_window: Option<u64>,
}

fn as_num(value: &Value) -> u64 {
    value.as_f64().map(|f| f as u64).unwrap_or(0)
}

fn extract_assistant_usage(entry: &JsonlEntry) -> Option<AssistantUsage> {
    let obj = entry.value().as_object()?;
    let msg = obj.get("message").and_then(|v| v.as_object());
    let usage = msg
        .and_then(|m| m.get("usage"))
        .filter(|v| v.is_object())
        .or_else(|| obj.get("usage"))
        .and_then(|v| v.as_object())?;
    let pick = |keys: &[&str]| -> u64 {
        for k in keys {
            if let Some(v) = usage.get(*k) {
                if v.is_number() {
                    return as_num(v);
                }
            }
        }
        0
    };
    let input = pick(&["input_tokens", "inputTokens"]) + pick(&["prompt_tokens", "promptTokens"]);
    let output = pick(&[
        "output_tokens",
        "outputTokens",
        "completion_tokens",
        "completionTokens",
    ]);
    let cache_creation = pick(&["cache_creation_input_tokens", "cacheCreationInputTokens"]);
    let cache_read = pick(&[
        "cache_read_input_tokens",
        "cacheReadInputTokens",
        "cached_input_tokens",
        "cachedInputTokens",
    ]);
    if input == 0 && output == 0 && cache_creation == 0 && cache_read == 0 {
        return None;
    }
    Some(AssistantUsage {
        input,
        output,
        cache_creation,
        cache_read,
    })
}

fn extract_usage_from_object(usage: &serde_json::Map<String, Value>) -> Option<AssistantUsage> {
    let pick = |keys: &[&str]| -> u64 {
        for k in keys {
            if let Some(v) = usage.get(*k) {
                if v.is_number() {
                    return as_num(v);
                }
            }
        }
        0
    };
    let input = pick(&[
        "input_tokens",
        "inputTokens",
        "prompt_tokens",
        "promptTokens",
    ]);
    let output = pick(&[
        "output_tokens",
        "outputTokens",
        "completion_tokens",
        "completionTokens",
    ]);
    let cache_creation = pick(&["cache_creation_input_tokens", "cacheCreationInputTokens"]);
    let cache_read = pick(&[
        "cache_read_input_tokens",
        "cacheReadInputTokens",
        "cached_input_tokens",
        "cachedInputTokens",
    ]);
    if input == 0 && output == 0 && cache_creation == 0 && cache_read == 0 {
        return None;
    }
    Some(AssistantUsage {
        input,
        output,
        cache_creation,
        cache_read,
    })
}

fn extract_codex_token_count(entry: &JsonlEntry) -> Option<CodexTokenCount> {
    let obj = entry.value().as_object()?;
    if obj.get("type").and_then(|v| v.as_str()) != Some("event_msg") {
        return None;
    }
    let payload = obj.get("payload").and_then(|v| v.as_object())?;
    if payload.get("type").and_then(|v| v.as_str()) != Some("token_count") {
        return None;
    }
    let info = payload.get("info").and_then(|v| v.as_object())?;
    let total = info
        .get("total_token_usage")
        .and_then(|v| v.as_object())
        .and_then(extract_usage_from_object)?;
    let last = info
        .get("last_token_usage")
        .and_then(|v| v.as_object())
        .and_then(extract_usage_from_object);
    let context_window = info.get("model_context_window").and_then(|v| v.as_u64());
    Some(CodexTokenCount {
        total,
        last,
        context_window,
    })
}

fn extract_model(entry: &JsonlEntry) -> Option<String> {
    let obj = entry.value().as_object()?;
    let direct = obj.get("model").and_then(|v| v.as_str());
    if let Some(d) = direct {
        if !d.starts_with('<') && d != "synthetic" {
            return Some(d.to_string());
        }
    }
    let payload_model = obj
        .get("payload")
        .and_then(|p| p.as_object())
        .and_then(|p| p.get("model"))
        .and_then(|v| v.as_str());
    if let Some(m) = payload_model {
        if !m.starts_with('<') && m != "synthetic" {
            return Some(m.to_string());
        }
    }
    let payload_settings_model = obj
        .get("payload")
        .and_then(|p| p.as_object())
        .and_then(|p| p.get("collaboration_mode"))
        .and_then(|v| v.as_object())
        .and_then(|c| c.get("settings"))
        .and_then(|v| v.as_object())
        .and_then(|s| s.get("model"))
        .and_then(|v| v.as_str());
    if let Some(m) = payload_settings_model {
        if !m.starts_with('<') && m != "synthetic" {
            return Some(m.to_string());
        }
    }
    let mm = obj
        .get("message")
        .and_then(|m| m.as_object())
        .and_then(|m| m.get("model"))
        .and_then(|v| v.as_str());
    if let Some(m) = mm {
        if !m.starts_with('<') && m != "synthetic" {
            return Some(m.to_string());
        }
    }
    None
}

fn extract_model_from_entries(entries: &[JsonlEntry]) -> Option<String> {
    entries.iter().find_map(extract_model)
}

fn extract_tool_use_arg(name: &str, input: &Value) -> String {
    let obj = match input.as_object() {
        Some(o) => o,
        None => return String::new(),
    };
    let low = name.to_lowercase();
    if low == "bash" || low == "exec_command" {
        if let Some(c) = obj.get("command").and_then(|v| v.as_str()) {
            return c.to_string();
        }
        if let Some(c) = obj.get("cmd").and_then(|v| v.as_str()) {
            return c.to_string();
        }
    }
    if low == "grep" || low == "glob" {
        if let Some(p) = obj.get("pattern").and_then(|v| v.as_str()) {
            return p.to_string();
        }
    }
    if let Some(fp) = obj.get("file_path").and_then(|v| v.as_str()) {
        return fp.to_string();
    }
    if let Some(sat) = obj.get("subagent_type").and_then(|v| v.as_str()) {
        return sat.to_string();
    }
    if let Some(desc) = obj.get("description").and_then(|v| v.as_str()) {
        return desc.to_string();
    }
    serde_json::to_string(input).unwrap_or_default()
}

fn parse_entry_timestamp(entry: &JsonlEntry) -> u64 {
    let obj = match entry.value().as_object() {
        Some(o) => o,
        None => return 0,
    };
    let ts = match obj.get("timestamp") {
        Some(v) => v,
        None => return 0,
    };
    if let Some(s) = ts.as_str() {
        if let Ok(parsed) = chrono::DateTime::parse_from_rfc3339(s) {
            return parsed.timestamp_millis() as u64;
        }
        return 0;
    }
    if let Some(n) = ts.as_f64() {
        return if n > 1e12 {
            n as u64
        } else {
            (n * 1000.0) as u64
        };
    }
    0
}

fn payload_type(entry: &JsonlEntry) -> Option<&str> {
    entry
        .value()
        .get("payload")
        .and_then(|v| v.get("type"))
        .and_then(|v| v.as_str())
}

fn looks_like_interruption(text: &str) -> bool {
    let lower = text.to_lowercase();
    lower.contains("request interrupted by user")
        || lower.contains("interrupted by user for tool use")
}

struct ContentBlocks {
    text: Vec<String>,
    thinking: bool,
    tool_result: bool,
    tool_result_ids: Vec<String>,
    interrupted: bool,
    tool_use: Vec<(Option<String>, String, Value)>,
}

fn extract_content_blocks(entry: &JsonlEntry) -> ContentBlocks {
    let mut out = ContentBlocks {
        text: vec![],
        thinking: false,
        tool_result: false,
        tool_result_ids: vec![],
        interrupted: false,
        tool_use: vec![],
    };
    let obj = match entry.value().as_object() {
        Some(o) => o,
        None => return out,
    };
    let msg = match obj.get("message").and_then(|v| v.as_object()) {
        Some(m) => m,
        None => return out,
    };
    match msg.get("content") {
        Some(Value::String(s)) => {
            if looks_like_interruption(s) {
                out.interrupted = true;
            }
            out.text.push(s.clone());
        }
        Some(Value::Array(arr)) => {
            for part in arr {
                if let Some(p) = part.as_object() {
                    let t = p.get("type").and_then(|v| v.as_str());
                    if t == Some("text") {
                        if let Some(s) = p.get("text").and_then(|v| v.as_str()) {
                            if looks_like_interruption(s) {
                                out.interrupted = true;
                            }
                            out.text.push(s.to_string());
                        }
                    } else if t == Some("thinking") {
                        out.thinking = true;
                    } else if t == Some("tool_use") {
                        if let Some(name) = p.get("name").and_then(|v| v.as_str()) {
                            let id = p.get("id").and_then(|v| v.as_str()).map(|s| s.to_string());
                            let input = p.get("input").cloned().unwrap_or(Value::Null);
                            out.tool_use.push((id, name.to_string(), input));
                        }
                    } else if t == Some("tool_result") {
                        out.tool_result = true;
                        if let Some(id) = p.get("tool_use_id").and_then(|v| v.as_str()) {
                            out.tool_result_ids.push(id.to_string());
                        }
                        if let Some(s) = p.get("content").and_then(|v| v.as_str()) {
                            if looks_like_interruption(s) {
                                out.interrupted = true;
                            }
                        }
                    }
                }
            }
        }
        _ => {}
    }
    out
}

#[derive(Clone)]
struct PendingTool {
    name: String,
    input: Value,
    since_ms: u64,
}

fn pending_tool_requires_permission(tool: &PendingTool) -> bool {
    tool.input
        .get("sandbox_permissions")
        .and_then(|value| value.as_str())
        .map(|value| value == "require_escalated")
        .unwrap_or(false)
        || tool
            .input
            .get("approval_policy")
            .and_then(|value| value.as_str())
            .map(|value| matches!(value, "require_escalated" | "on-request"))
            .unwrap_or(false)
}

fn pending_tool_requests_user_input(tool: &PendingTool) -> bool {
    let name = tool.name.to_ascii_lowercase();
    name == "askuserquestion"
        || name == "ask_user_question"
        || name == "request_user_input"
        || name == "elicitation"
        || name.contains("request_user_input")
        || name.contains("ask_user_question")
        || (tool.input.get("questions").is_some()
            && serde_json::to_string(&tool.input)
                .map(|input| input.to_ascii_lowercase().contains("\"options\""))
                .unwrap_or(false))
}

fn newest_pending_waiting_signal(
    pending_tools: &HashMap<String, PendingTool>,
) -> Option<(u64, &'static str)> {
    let mut newest: Option<(u64, &'static str)> = None;
    for tool in pending_tools.values() {
        let signal = if pending_tool_requires_permission(tool) {
            Some("codex_pending_permission")
        } else if pending_tool_requests_user_input(tool) {
            Some("claude_pending_user_input")
        } else {
            None
        };
        if let Some(signal) = signal {
            if newest
                .map(|(since_ms, _)| tool.since_ms > since_ms)
                .unwrap_or(true)
            {
                newest = Some((tool.since_ms, signal));
            }
        }
    }
    newest
}

fn apply_pending_waiting_status(
    pending_tools: &HashMap<String, PendingTool>,
    activity_status: &mut Option<String>,
    activity_signal: &mut Option<String>,
    activity_since_ms: &mut u64,
) {
    if activity_status.as_deref() == Some("aborted") {
        return;
    }
    if let Some((since_ms, signal)) = newest_pending_waiting_signal(pending_tools) {
        *activity_status = Some("waiting".to_string());
        *activity_signal = Some(signal.to_string());
        *activity_since_ms = since_ms;
    }
}

fn refresh_pending_state(
    pending_tools: &HashMap<String, PendingTool>,
    pending_since_ms: &mut u64,
    thinking_since_ms: &mut u64,
    current_task: &mut String,
    last_tool: &mut Option<String>,
) {
    if let Some(tool) = pending_tools.values().max_by_key(|tool| tool.since_ms) {
        *pending_since_ms = tool.since_ms;
        *thinking_since_ms = 0;
        *last_tool = Some(tool.name.clone());
        *current_task = truncate(
            &extract_tool_use_arg(&tool.name, &tool.input),
            MAX_TOOL_ARG_LEN,
        );
    } else {
        *pending_since_ms = 0;
        current_task.clear();
    }
}

fn message_stop_reason(entry: &JsonlEntry) -> Option<&str> {
    entry
        .value()
        .get("message")
        .and_then(|v| v.get("stop_reason"))
        .and_then(|v| v.as_str())
}

fn message_has_null_stop_reason(entry: &JsonlEntry) -> bool {
    entry
        .value()
        .get("message")
        .and_then(|v| v.get("stop_reason"))
        .is_some_and(Value::is_null)
}

fn output_tool_call_id(entry: &JsonlEntry, is_codex_function_output: bool) -> Option<String> {
    let obj = entry.value().as_object()?;
    let source = if is_codex_function_output {
        obj.get("payload").and_then(|v| v.as_object())?
    } else {
        obj
    };
    source
        .get("call_id")
        .or_else(|| source.get("id"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

fn clear_completed_tools(
    pending_tools: &mut HashMap<String, PendingTool>,
    ids: &[String],
    has_output: bool,
) {
    for id in ids {
        pending_tools.remove(id);
    }
    if has_output && ids.is_empty() && pending_tools.len() == 1 {
        pending_tools.clear();
    }
}

fn reduce_entries(entries: &[JsonlEntry], last_activity_ms: u64, truncated: bool) -> SessionLive {
    let mut model = String::new();
    let mut tokens = SessionTokens::default();
    let mut last_usage: Option<AssistantUsage> = None;
    let mut last_tool: Option<String> = None;
    let mut tool_count: u32 = 0;
    let mut started_at_ms: u64 = 0;
    let mut pending_since_ms: u64 = 0;
    let mut thinking_since_ms: u64 = 0;
    let mut activity_status: Option<String> = None;
    let mut activity_signal: Option<String> = None;
    let mut activity_since_ms: u64 = 0;
    let mut latest_entry_ms: u64 = 0;
    let mut current_task = String::new();
    let mut context_window_override: Option<u64> = None;
    let mut token_history: Vec<u64> = Vec::new();
    let mut context_history: Vec<u64> = Vec::new();
    let mut tool_calls_tail: Vec<ToolCallEntry> = Vec::new();
    let mut chat_tail: Vec<ChatMessageEntry> = Vec::new();
    let mut pending_tools: HashMap<String, PendingTool> = HashMap::new();
    let mut anonymous_tool_id: u64 = 0;

    for entry in entries {
        if model.is_empty() {
            if let Some(m) = extract_model(entry) {
                model = m;
            }
        }
        let ts = parse_entry_timestamp(entry);
        if started_at_ms == 0 && ts > 0 {
            started_at_ms = ts;
        }
        if ts > latest_entry_ms {
            latest_entry_ms = ts;
        }

        if let Some(usage) = extract_assistant_usage(entry) {
            tokens.input += usage.input;
            tokens.output += usage.output;
            tokens.cache += usage.cache_creation + usage.cache_read;
            last_usage = Some(usage);
        }
        if let Some(token_count) = extract_codex_token_count(entry) {
            tokens.input = token_count.total.input;
            tokens.output = token_count.total.output;
            tokens.cache = token_count.total.cache_creation + token_count.total.cache_read;
            last_usage = token_count.last.or(Some(token_count.total));
            if token_count.context_window.is_some() {
                context_window_override = token_count.context_window;
            }
            token_history.push(tokens.input + tokens.output + tokens.cache);
            if token_history.len() > MAX_TOKEN_HISTORY {
                token_history.remove(0);
            }
            let ctx_usage = token_count.last.unwrap_or(token_count.total);
            let ctx_size = ctx_usage.input + ctx_usage.cache_creation + ctx_usage.cache_read;
            context_history.push(ctx_size);
            if context_history.len() > MAX_TOKEN_HISTORY {
                context_history.remove(0);
            }
        }

        let entry_type = entry.type_str();
        let codex_payload_type = payload_type(entry);
        let is_codex_response_item = entry_type == Some("response_item");
        let is_codex_event = entry_type == Some("event_msg");
        let is_codex_function_call =
            is_codex_response_item && codex_payload_type == Some("function_call");
        let is_codex_function_output =
            is_codex_response_item && codex_payload_type == Some("function_call_output");
        let is_codex_message = is_codex_response_item && codex_payload_type == Some("message");
        let is_codex_reasoning = is_codex_response_item && codex_payload_type == Some("reasoning");
        let is_assistant = entry_type == Some("assistant")
            || entry_type == Some("function_call")
            || is_codex_message;
        let is_user = entry_type == Some("user")
            || entry_type == Some("human")
            || entry_type == Some("function_call_output")
            || is_codex_function_output;

        let mut tool_uses: Vec<(Option<String>, String, Value)> = Vec::new();
        if is_codex_event {
            let activity_ms = if ts > 0 { ts } else { last_activity_ms };
            match codex_payload_type {
                Some("task_started") => {
                    pending_tools.clear();
                    pending_since_ms = 0;
                    current_task.clear();
                    thinking_since_ms = 0;
                    activity_status = Some("running".to_string());
                    activity_signal = Some("codex_task_started".to_string());
                    activity_since_ms = activity_ms;
                }
                Some("task_complete") => {
                    pending_tools.clear();
                    pending_since_ms = 0;
                    thinking_since_ms = 0;
                    current_task.clear();
                    activity_status = Some("idle".to_string());
                    activity_signal = Some("codex_task_complete".to_string());
                    activity_since_ms = activity_ms;
                }
                Some("turn_aborted") => {
                    pending_tools.clear();
                    pending_since_ms = 0;
                    thinking_since_ms = 0;
                    current_task.clear();
                    activity_status = Some("aborted".to_string());
                    activity_signal = Some("codex_turn_aborted".to_string());
                    activity_since_ms = activity_ms;
                }
                Some("exec_approval_request")
                | Some("apply_patch_approval_request")
                | Some("request_user_input")
                | Some("elicitation_request") => {
                    pending_tools.clear();
                    pending_since_ms = activity_ms;
                    thinking_since_ms = 0;
                    activity_status = Some("waiting".to_string());
                    activity_signal = Some(format!("codex_{}", codex_payload_type.unwrap()));
                    activity_since_ms = activity_ms;
                }
                _ => {}
            }
        }
        if is_codex_reasoning {
            thinking_since_ms = if ts > 0 { ts } else { last_activity_ms };
        }
        if is_assistant || is_user {
            let mut blocks = extract_content_blocks(entry);
            if is_codex_function_output || entry_type == Some("function_call_output") {
                blocks.tool_result = true;
                if let Some(id) = output_tool_call_id(entry, is_codex_function_output) {
                    blocks.tool_result_ids.push(id);
                }
            }
            let stop_reason = message_stop_reason(entry);
            let stop_reason_in_progress =
                stop_reason.is_none() && message_has_null_stop_reason(entry);
            if !blocks.tool_use.is_empty() {
                tool_uses = blocks.tool_use;
            }
            if is_assistant {
                thinking_since_ms = 0;
                if !tool_uses.is_empty() {
                    let activity_ms = if ts > 0 { ts } else { last_activity_ms };
                    pending_since_ms = activity_ms;
                    activity_status = Some("running".to_string());
                    activity_signal = Some("claude_tool_use".to_string());
                    activity_since_ms = activity_ms;
                } else if !blocks.text.is_empty() {
                    if pending_tools.is_empty() {
                        pending_since_ms = 0;
                        current_task.clear();
                    }
                    if stop_reason_in_progress {
                        let activity_ms = if ts > 0 { ts } else { last_activity_ms };
                        thinking_since_ms = activity_ms;
                        activity_status = Some("running".to_string());
                        activity_signal = Some("claude_assistant_in_progress".to_string());
                        activity_since_ms = activity_ms;
                    } else if pending_tools.is_empty() {
                        let activity_ms = if ts > 0 { ts } else { last_activity_ms };
                        activity_status = Some("idle".to_string());
                        activity_signal = Some("claude_assistant_message".to_string());
                        activity_since_ms = activity_ms;
                    }
                } else if blocks.thinking {
                    if pending_tools.is_empty() {
                        pending_since_ms = 0;
                        current_task.clear();
                    }
                    let activity_ms = if ts > 0 { ts } else { last_activity_ms };
                    thinking_since_ms = activity_ms;
                    activity_status = Some("running".to_string());
                    activity_signal = Some("claude_thinking".to_string());
                    activity_since_ms = activity_ms;
                }
                for t in blocks.text {
                    let t = t.trim();
                    if !t.is_empty() {
                        chat_tail.push(ChatMessageEntry {
                            role: ChatRole::Assistant,
                            text: truncate(&t, MAX_CHAT_TEXT_LEN),
                        });
                        if chat_tail.len() > MAX_CHAT_TAIL {
                            chat_tail.remove(0);
                        }
                    }
                }
            } else if is_user {
                clear_completed_tools(
                    &mut pending_tools,
                    &blocks.tool_result_ids,
                    blocks.tool_result,
                );
                if blocks.interrupted {
                    pending_tools.clear();
                    activity_status = Some("aborted".to_string());
                    activity_signal = Some("claude_request_interrupted".to_string());
                    activity_since_ms = if ts > 0 { ts } else { last_activity_ms };
                }
                let has_human_prompt = !blocks.tool_result
                    && blocks.text.iter().any(|t| {
                        let t = t.trim();
                        !t.is_empty() && !looks_like_interruption(t)
                    });
                if !pending_tools.is_empty() {
                    refresh_pending_state(
                        &pending_tools,
                        &mut pending_since_ms,
                        &mut thinking_since_ms,
                        &mut current_task,
                        &mut last_tool,
                    );
                    apply_pending_waiting_status(
                        &pending_tools,
                        &mut activity_status,
                        &mut activity_signal,
                        &mut activity_since_ms,
                    );
                } else {
                    pending_since_ms = 0;
                    current_task.clear();
                    thinking_since_ms = if blocks.tool_result && !blocks.interrupted {
                        if ts > 0 {
                            ts
                        } else {
                            last_activity_ms
                        }
                    } else if has_human_prompt {
                        if ts > 0 {
                            ts
                        } else {
                            last_activity_ms
                        }
                    } else {
                        0
                    };
                    if blocks.tool_result
                        && activity_signal.as_deref() == Some("codex_pending_permission")
                    {
                        activity_status = Some("running".to_string());
                        activity_signal = Some("codex_tool_output".to_string());
                        activity_since_ms = if ts > 0 { ts } else { last_activity_ms };
                    } else if blocks.tool_result && !blocks.interrupted {
                        activity_status = Some("running".to_string());
                        activity_signal = Some("claude_tool_result".to_string());
                        activity_since_ms = if ts > 0 { ts } else { last_activity_ms };
                    } else if has_human_prompt {
                        activity_status = Some("running".to_string());
                        activity_signal = Some("claude_user_prompt".to_string());
                        activity_since_ms = if ts > 0 { ts } else { last_activity_ms };
                    }
                }
                if !blocks.tool_result {
                    for t in blocks.text {
                        let t = t.trim();
                        if !t.is_empty() && !looks_like_interruption(t) {
                            chat_tail.push(ChatMessageEntry {
                                role: ChatRole::User,
                                text: truncate(&t, MAX_CHAT_TEXT_LEN),
                            });
                            if chat_tail.len() > MAX_CHAT_TAIL {
                                chat_tail.remove(0);
                            }
                        }
                    }
                }
            }
        }
        if entry_type == Some("function_call") || is_codex_function_call {
            // Codex function_call may appear either at top level or as response_item.payload.
            if let Some(obj) = entry.value().as_object() {
                let call = if is_codex_function_call {
                    obj.get("payload").and_then(|v| v.as_object())
                } else {
                    Some(obj)
                };
                if let Some(call) = call {
                    if let Some(name) = call.get("name").and_then(|v| v.as_str()) {
                        let id = call
                            .get("id")
                            .or_else(|| call.get("call_id"))
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string());
                        let input = match call.get("arguments") {
                            Some(Value::String(s)) => {
                                serde_json::from_str(s).unwrap_or(Value::Null)
                            }
                            Some(other) => other.clone(),
                            None => Value::Null,
                        };
                        tool_uses.push((id, name.to_string(), input));
                    }
                }
            }
        }

        if !tool_uses.is_empty() {
            let since_ms = if ts > 0 { ts } else { last_activity_ms };
            tool_count += tool_uses.len() as u32;
            let last = tool_uses.last().unwrap();
            last_tool = Some(last.1.clone());
            current_task = truncate(&extract_tool_use_arg(&last.1, &last.2), MAX_TOOL_ARG_LEN);
            for (id, name, input) in &tool_uses {
                let arg = truncate(&extract_tool_use_arg(name, input), MAX_TOOL_ARG_LEN);
                tool_calls_tail.push(ToolCallEntry {
                    name: name.clone(),
                    arg,
                    duration_ms: 0,
                });
                if tool_calls_tail.len() > MAX_TOOL_TAIL {
                    tool_calls_tail.remove(0);
                }
                let key = id.clone().unwrap_or_else(|| {
                    anonymous_tool_id += 1;
                    format!("anonymous-tool-{anonymous_tool_id}")
                });
                pending_tools.insert(
                    key,
                    PendingTool {
                        name: name.clone(),
                        input: input.clone(),
                        since_ms,
                    },
                );
            }
            refresh_pending_state(
                &pending_tools,
                &mut pending_since_ms,
                &mut thinking_since_ms,
                &mut current_task,
                &mut last_tool,
            );
            apply_pending_waiting_status(
                &pending_tools,
                &mut activity_status,
                &mut activity_signal,
                &mut activity_since_ms,
            );
        }

        if is_assistant && last_usage.is_some() {
            let usage = last_usage.unwrap();
            let ctx_size = usage.input + usage.cache_creation + usage.cache_read;
            token_history.push(tokens.input + tokens.output + tokens.cache);
            if token_history.len() > MAX_TOKEN_HISTORY {
                token_history.remove(0);
            }
            context_history.push(ctx_size);
            if context_history.len() > MAX_TOKEN_HISTORY {
                context_history.remove(0);
            }
        }
    }

    tokens.total = tokens.input + tokens.output;

    let mut ctx_pct: i64 = -1;
    if let Some(last) = last_usage {
        let ctx_input = last.input + last.cache_creation + last.cache_read;
        let model_name = if model.is_empty() { None } else { Some(&model) };
        let window = configured_context_window_for_model(model_name.map(|m| m.as_str()))
            .or(context_window_override)
            .unwrap_or_else(|| model_context_window(model_name.map(|m| m.as_str())));
        if window > 0 {
            ctx_pct = ((ctx_input as f64 / window as f64) * 100.0) as i64;
        }
    }

    let mut compaction_count: u32 = 0;
    if context_history.len() >= 2 {
        for i in 1..context_history.len() {
            let prev = context_history[i - 1];
            let cur = context_history[i];
            if prev > 0 && (cur as f64) < (prev as f64) * (1.0 - COMPACTION_DROP_RATIO) {
                compaction_count += 1;
            }
        }
    }

    let effective_last_activity_ms = if latest_entry_ms > 0 {
        latest_entry_ms
    } else {
        last_activity_ms
    };

    SessionLive {
        model,
        tokens,
        ctx_pct,
        last_tool,
        tool_count,
        last_activity_ms: effective_last_activity_ms,
        truncated,
        started_at_ms,
        pending_since_ms,
        thinking_since_ms,
        activity_status,
        activity_signal,
        activity_since_ms,
        token_history,
        context_history,
        compaction_count,
        current_task,
        tool_calls_tail,
        chat_tail,
    }
}

fn read_tail_entries(path: &Path, size: u64) -> Vec<JsonlEntry> {
    let mut file = match File::open(path) {
        Ok(f) => f,
        Err(_) => return vec![],
    };
    let start = size.saturating_sub(TAIL_BYTES);
    if start > 0 {
        if file.seek(SeekFrom::Start(start)).is_err() {
            return vec![];
        }
    }
    let len = (size - start) as usize;
    let mut buf = vec![0u8; len];
    if file.read_exact(&mut buf).is_err() {
        // Best-effort — file may have grown since stat
    }
    let text = String::from_utf8_lossy(&buf);
    let text = if start > 0 {
        // drop first (likely partial) line
        match text.find('\n') {
            Some(nl) => &text[nl + 1..],
            None => return vec![],
        }
    } else {
        &text[..]
    };
    parse_jsonl_text(text, MAX_LINES)
}

struct CacheEntry {
    mtime_ms: u64,
    result: SessionLive,
}

static CACHE: Lazy<Mutex<HashMap<PathBuf, CacheEntry>>> = Lazy::new(|| Mutex::new(HashMap::new()));

pub fn clear_session_metrics_cache() {
    if let Ok(mut c) = CACHE.lock() {
        c.clear();
    }
}

fn mtime_ms(path: &Path) -> Option<u64> {
    let md = std::fs::metadata(path).ok()?;
    md.modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis() as u64)
}

pub fn get_session_live_metrics(path: &Path) -> SessionLive {
    let st = match std::fs::metadata(path) {
        Ok(s) => s,
        Err(_) => return empty_live(0),
    };
    let mtime = match mtime_ms(path) {
        Some(m) => m,
        None => return empty_live(0),
    };
    let size = st.len();

    {
        let cache = CACHE.lock().unwrap();
        if let Some(c) = cache.get(path) {
            if c.mtime_ms == mtime {
                return c.result.clone();
            }
        }
    }

    let mut result = if size <= FULL_READ_THRESHOLD {
        let entries = crate::core::session::parse_jsonl_head(path, MAX_LINES);
        reduce_entries(&entries, mtime, false)
    } else {
        let entries = read_tail_entries(path, size);
        reduce_entries(&entries, mtime, true)
    };

    if result.model.is_empty() && size > FULL_READ_THRESHOLD {
        let head_entries = crate::core::session::parse_jsonl_head(path, 1000);
        if let Some(model) = extract_model_from_entries(&head_entries) {
            result.model = model;
            if let (Some(window), Some(ctx_size)) = (
                configured_context_window_for_model(Some(&result.model)),
                result.context_history.last().copied(),
            ) {
                if window > 0 {
                    result.ctx_pct = ((ctx_size as f64 / window as f64) * 100.0) as i64;
                }
            }
        }
    }

    if let Ok(mut c) = CACHE.lock() {
        c.insert(
            path.to_path_buf(),
            CacheEntry {
                mtime_ms: mtime,
                result: result.clone(),
            },
        );
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::time::SystemTime;

    fn write_jsonl(path: &Path, lines: &[&str]) {
        let mut f = std::fs::File::create(path).unwrap();
        for line in lines {
            writeln!(f, "{line}").unwrap();
        }
    }

    #[test]
    fn model_context_window_recognizes_configured_models_as_one_million() {
        use crate::core::model_config::DEFAULT_CONTEXT_WINDOW;

        assert_eq!(model_context_window(Some("glm-5.2")), 1_000_000);
        assert_eq!(model_context_window(Some("GLM-5.2")), 1_000_000);
        assert_eq!(
            model_context_window(Some("glm-5.2 with high effort")),
            1_000_000
        );
        assert_eq!(model_context_window(Some("gpt-5.5")), 1_000_000);
        assert_eq!(model_context_window(Some("gpt-5.4")), 1_000_000);
        assert_eq!(model_context_window(Some("gpt-5.4-mini")), 400_000);
        assert_eq!(model_context_window(Some("glm-5.1")), 200_000);
        assert_eq!(model_context_window(Some("glm-5")), 200_000);
        assert_eq!(
            model_context_window(Some("unknown-model")),
            DEFAULT_CONTEXT_WINDOW
        );
    }

    #[test]
    fn reduces_tokens_and_model() {
        clear_session_metrics_cache();
        let dir = std::env::temp_dir();
        let path = dir.join(format!(
            "starling-metrics-{}.jsonl",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        write_jsonl(
            &path,
            &[
                r#"{"type":"user","timestamp":"2026-01-01T00:00:00Z","message":{"content":"hi"}}"#,
                r#"{"type":"assistant","timestamp":"2026-01-01T00:00:01Z","model":"claude-sonnet","message":{"model":"claude-sonnet","usage":{"input_tokens":100,"output_tokens":50,"cache_read_input_tokens":200}}}"#,
                r#"{"type":"assistant","timestamp":"2026-01-01T00:00:02Z","model":"claude-sonnet","message":{"model":"claude-sonnet","usage":{"input_tokens":120,"output_tokens":60,"cache_read_input_tokens":220}}}"#,
            ],
        );
        let live = get_session_live_metrics(&path);
        assert_eq!(live.model, "claude-sonnet");
        assert_eq!(live.tokens.input, 220); // 100 + 120
        assert_eq!(live.tokens.output, 110);
        assert_eq!(live.tokens.cache, 420);
        assert_eq!(live.tokens.total, 330);
        assert_eq!(live.tool_count, 0);
        assert!(live.ctx_pct >= 0);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn reduces_codex_token_count_events() {
        clear_session_metrics_cache();
        let dir = std::env::temp_dir();
        let path = dir.join(format!(
            "starling-metrics-{}-codex.jsonl",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        write_jsonl(
            &path,
            &[
                r#"{"timestamp":"2026-01-01T00:00:00Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1000,"cached_input_tokens":700,"output_tokens":50,"reasoning_output_tokens":10,"total_tokens":1050},"last_token_usage":{"input_tokens":200,"cached_input_tokens":150,"output_tokens":20,"reasoning_output_tokens":3,"total_tokens":220},"model_context_window":1000}}}"#,
                r#"{"timestamp":"2026-01-01T00:00:01Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1500,"cached_input_tokens":900,"output_tokens":80,"reasoning_output_tokens":13,"total_tokens":1580},"last_token_usage":{"input_tokens":300,"cached_input_tokens":200,"output_tokens":30,"reasoning_output_tokens":3,"total_tokens":330},"model_context_window":1000}}}"#,
            ],
        );
        let live = get_session_live_metrics(&path);
        assert_eq!(live.model, "");
        assert_eq!(live.tokens.input, 1500);
        assert_eq!(live.tokens.output, 80);
        assert_eq!(live.tokens.cache, 900);
        assert_eq!(live.tokens.total, 1580);
        assert_eq!(live.ctx_pct, 50);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn reduces_codex_response_item_tool_calls() {
        clear_session_metrics_cache();
        let dir = std::env::temp_dir();
        let path = dir.join(format!(
            "starling-metrics-{}-codex-response-item.jsonl",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        write_jsonl(
            &path,
            &[
                r#"{"timestamp":"2026-01-01T00:00:00Z","type":"response_item","payload":{"type":"reasoning"}}"#,
                r#"{"timestamp":"2026-01-01T00:00:01Z","type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{\"cmd\":\"cargo test\"}"}}"#,
            ],
        );
        let live = get_session_live_metrics(&path);
        assert_eq!(live.tool_count, 1);
        assert_eq!(live.last_tool.as_deref(), Some("exec_command"));
        assert_eq!(live.current_task, "cargo test");
        assert_eq!(live.pending_since_ms, 1_767_225_601_000);
        assert_eq!(live.thinking_since_ms, 0);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn codex_response_item_tool_output_clears_pending() {
        clear_session_metrics_cache();
        let dir = std::env::temp_dir();
        let path = dir.join(format!(
            "starling-metrics-{}-codex-response-output.jsonl",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        write_jsonl(
            &path,
            &[
                r#"{"timestamp":"2026-01-01T00:00:01Z","type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{\"cmd\":\"cargo test\"}"}}"#,
                r#"{"timestamp":"2026-01-01T00:00:02Z","type":"response_item","payload":{"type":"function_call_output","output":"ok"}}"#,
            ],
        );
        let live = get_session_live_metrics(&path);
        assert_eq!(live.pending_since_ms, 0);
        assert_eq!(live.current_task, "");
        assert_eq!(live.last_tool.as_deref(), Some("exec_command"));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn codex_task_complete_clears_stale_pending_tool() {
        clear_session_metrics_cache();
        let dir = std::env::temp_dir();
        let path = dir.join(format!(
            "starling-metrics-{}-codex-task-complete.jsonl",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        write_jsonl(
            &path,
            &[
                r#"{"timestamp":"2026-01-01T00:00:00Z","type":"event_msg","payload":{"type":"task_started"}}"#,
                r#"{"timestamp":"2026-01-01T00:00:01Z","type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{\"cmd\":\"head -20 results.csv\"}","call_id":"call_1"}}"#,
                r#"{"timestamp":"2026-01-01T00:00:02Z","type":"response_item","payload":{"type":"function_call_output","call_id":"call_1","output":"ok"}}"#,
                r#"{"timestamp":"2026-01-01T00:00:03Z","type":"event_msg","payload":{"type":"task_complete"}}"#,
            ],
        );
        let live = get_session_live_metrics(&path);
        assert_eq!(live.pending_since_ms, 0);
        assert_eq!(live.thinking_since_ms, 0);
        assert_eq!(live.activity_status.as_deref(), Some("idle"));
        assert_eq!(live.activity_signal.as_deref(), Some("codex_task_complete"));
        assert_eq!(live.current_task, "");
        assert_eq!(live.last_tool.as_deref(), Some("exec_command"));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn codex_turn_aborted_marks_aborted() {
        clear_session_metrics_cache();
        let dir = std::env::temp_dir();
        let path = dir.join(format!(
            "starling-metrics-{}-codex-turn-aborted.jsonl",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        write_jsonl(
            &path,
            &[
                r#"{"timestamp":"2026-01-01T00:00:00Z","type":"event_msg","payload":{"type":"task_started"}}"#,
                r#"{"timestamp":"2026-01-01T00:00:01Z","type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{\"cmd\":\"sleep 10\"}","call_id":"call_1"}}"#,
                r#"{"timestamp":"2026-01-01T00:00:02Z","type":"event_msg","payload":{"type":"turn_aborted"}}"#,
            ],
        );
        let live = get_session_live_metrics(&path);
        assert_eq!(live.pending_since_ms, 0);
        assert_eq!(live.thinking_since_ms, 0);
        assert_eq!(live.activity_status.as_deref(), Some("aborted"));
        assert_eq!(live.activity_signal.as_deref(), Some("codex_turn_aborted"));
        assert_eq!(live.current_task, "");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn codex_task_started_marks_running_until_complete() {
        clear_session_metrics_cache();
        let dir = std::env::temp_dir();
        let path = dir.join(format!(
            "starling-metrics-{}-codex-task-started.jsonl",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        write_jsonl(
            &path,
            &[
                r#"{"timestamp":"2026-01-01T00:00:00Z","type":"event_msg","payload":{"type":"task_started"}}"#,
            ],
        );
        let live = get_session_live_metrics(&path);
        assert_eq!(live.pending_since_ms, 0);
        assert_eq!(live.thinking_since_ms, 0);
        assert_eq!(live.activity_status.as_deref(), Some("running"));
        assert_eq!(live.activity_signal.as_deref(), Some("codex_task_started"));
        assert_eq!(live.activity_since_ms, 1_767_225_600_000);
        assert_eq!(live.current_task, "");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn codex_approval_request_marks_waiting() {
        clear_session_metrics_cache();
        let dir = std::env::temp_dir();
        let path = dir.join(format!(
            "starling-metrics-{}-codex-approval.jsonl",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        write_jsonl(
            &path,
            &[
                r#"{"timestamp":"2026-01-01T00:00:00Z","type":"event_msg","payload":{"type":"task_started"}}"#,
                r#"{"timestamp":"2026-01-01T00:00:01Z","type":"event_msg","payload":{"type":"exec_approval_request"}}"#,
            ],
        );
        let live = get_session_live_metrics(&path);
        assert_eq!(live.activity_status.as_deref(), Some("waiting"));
        assert_eq!(
            live.activity_signal.as_deref(),
            Some("codex_exec_approval_request")
        );
        assert_eq!(live.pending_since_ms, 1_767_225_601_000);
        assert_eq!(live.thinking_since_ms, 0);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn codex_pending_escalated_tool_call_marks_waiting() {
        clear_session_metrics_cache();
        let dir = std::env::temp_dir();
        let path = dir.join(format!(
            "starling-metrics-{}-codex-pending-permission.jsonl",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        write_jsonl(
            &path,
            &[
                r#"{"timestamp":"2026-01-01T00:00:00Z","type":"response_item","payload":{"type":"function_call","name":"exec_command","call_id":"call_1","arguments":"{\"cmd\":\"cargo build --release\",\"sandbox_permissions\":\"require_escalated\",\"justification\":\"build release\"}"}}"#,
            ],
        );
        let live = get_session_live_metrics(&path);
        assert_eq!(live.pending_since_ms, 1_767_225_600_000);
        assert_eq!(live.activity_status.as_deref(), Some("waiting"));
        assert_eq!(
            live.activity_signal.as_deref(),
            Some("codex_pending_permission")
        );
        assert_eq!(live.current_task, "cargo build --release");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn codex_permission_tool_output_clears_waiting() {
        clear_session_metrics_cache();
        let dir = std::env::temp_dir();
        let path = dir.join(format!(
            "starling-metrics-{}-codex-permission-output.jsonl",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        write_jsonl(
            &path,
            &[
                r#"{"timestamp":"2026-01-01T00:00:00Z","type":"response_item","payload":{"type":"function_call","name":"exec_command","call_id":"call_1","arguments":"{\"cmd\":\"cargo build --release\",\"sandbox_permissions\":\"require_escalated\"}"}}"#,
                r#"{"timestamp":"2026-01-01T00:00:01Z","type":"response_item","payload":{"type":"function_call_output","call_id":"call_1","output":"done"}}"#,
            ],
        );
        let live = get_session_live_metrics(&path);
        assert_eq!(live.pending_since_ms, 0);
        assert_eq!(live.activity_status.as_deref(), Some("running"));
        assert_eq!(live.activity_signal.as_deref(), Some("codex_tool_output"));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn extracts_codex_payload_model() {
        clear_session_metrics_cache();
        let dir = std::env::temp_dir();
        let path = dir.join(format!(
            "starling-metrics-{}-codex-model.jsonl",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        write_jsonl(
            &path,
            &[
                r#"{"timestamp":"2026-01-01T00:00:00Z","type":"event_msg","payload":{"type":"session_configured","model":"gpt-5.5","collaboration_mode":{"settings":{"model":"gpt-5.5"}}}}"#,
            ],
        );
        let live = get_session_live_metrics(&path);
        assert_eq!(live.model, "gpt-5.5");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn configured_model_window_overrides_codex_token_count_window() {
        clear_session_metrics_cache();
        let dir = std::env::temp_dir();
        let path = dir.join(format!(
            "starling-metrics-{}-codex-model-window.jsonl",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        write_jsonl(
            &path,
            &[
                r#"{"timestamp":"2026-01-01T00:00:00Z","type":"event_msg","payload":{"type":"session_configured","model":"gpt-5.5"}}"#,
                r#"{"timestamp":"2026-01-01T00:00:01Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1500,"cached_input_tokens":900,"output_tokens":80},"last_token_usage":{"input_tokens":300,"cached_input_tokens":200,"output_tokens":30},"model_context_window":1000}}}"#,
            ],
        );
        let live = get_session_live_metrics(&path);
        assert_eq!(live.model, "gpt-5.5");
        assert_eq!(live.ctx_pct, 0);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn fills_codex_model_from_head_when_large_file_tail_has_only_tokens() {
        clear_session_metrics_cache();
        let dir = std::env::temp_dir();
        let path = dir.join(format!(
            "starling-metrics-{}-codex-large-model.jsonl",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        {
            let mut f = std::fs::File::create(&path).unwrap();
            writeln!(f, r#"{{"timestamp":"2026-01-01T00:00:00Z","type":"event_msg","payload":{{"type":"session_configured","model":"gpt-5.5","collaboration_mode":{{"settings":{{"model":"gpt-5.5"}}}}}}}}"#).unwrap();
            writeln!(
                f,
                r#"{{"type":"filler","payload":"{}"}}"#,
                "x".repeat((FULL_READ_THRESHOLD + TAIL_BYTES) as usize)
            )
            .unwrap();
            writeln!(f, r#"{{"timestamp":"2026-01-01T00:00:01Z","type":"event_msg","payload":{{"type":"token_count","info":{{"total_token_usage":{{"input_tokens":1500,"cached_input_tokens":900,"output_tokens":80}},"last_token_usage":{{"input_tokens":300,"cached_input_tokens":200,"output_tokens":30}},"model_context_window":1000}}}}}}"#).unwrap();
        }
        let live = get_session_live_metrics(&path);
        assert_eq!(live.model, "gpt-5.5");
        assert_eq!(live.ctx_pct, 0);
        assert_eq!(live.tokens.input, 1500);
        assert_eq!(live.tokens.output, 80);
        assert_eq!(live.tokens.cache, 900);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn counts_tools_and_tail() {
        clear_session_metrics_cache();
        let dir = std::env::temp_dir();
        let path = dir.join(format!(
            "starling-metrics-{}-b.jsonl",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        write_jsonl(
            &path,
            &[
                r#"{"type":"assistant","timestamp":"2026-01-01T00:00:00Z","message":{"content":[{"type":"text","text":"hello"},{"type":"tool_use","name":"Bash","input":{"command":"ls -la"}}]}}"#,
            ],
        );
        let live = get_session_live_metrics(&path);
        assert_eq!(live.tool_count, 1);
        assert_eq!(live.last_tool.as_deref(), Some("Bash"));
        assert_eq!(live.current_task, "ls -la");
        assert!(!live.chat_tail.is_empty());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn claude_ask_user_question_marks_waiting() {
        clear_session_metrics_cache();
        let dir = std::env::temp_dir();
        let path = dir.join(format!(
            "starling-metrics-{}-claude-ask-user.jsonl",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        write_jsonl(
            &path,
            &[
                r#"{"type":"assistant","timestamp":"2026-01-01T00:00:00Z","message":{"content":[{"type":"tool_use","id":"call_1","name":"AskUserQuestion","input":{"questions":[{"header":"删除范围","options":[{"label":"Only cache"},{"label":"Everything"}]}]}}]}}"#,
            ],
        );
        let live = get_session_live_metrics(&path);
        assert_eq!(live.tool_count, 1);
        assert_eq!(live.last_tool.as_deref(), Some("AskUserQuestion"));
        assert_eq!(live.pending_since_ms, 1_767_225_600_000);
        assert_eq!(live.activity_status.as_deref(), Some("waiting"));
        assert_eq!(
            live.activity_signal.as_deref(),
            Some("claude_pending_user_input")
        );
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn claude_ask_user_question_result_marks_running() {
        clear_session_metrics_cache();
        let dir = std::env::temp_dir();
        let path = dir.join(format!(
            "starling-metrics-{}-claude-ask-user-result.jsonl",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        write_jsonl(
            &path,
            &[
                r#"{"type":"assistant","timestamp":"2026-01-01T00:00:00Z","message":{"content":[{"type":"tool_use","id":"call_1","name":"AskUserQuestion","input":{"questions":[{"header":"删除范围","options":[{"label":"Only cache"},{"label":"Everything"}]}]}}]}}"#,
                r#"{"type":"user","timestamp":"2026-01-01T00:00:01Z","message":{"content":[{"type":"tool_result","tool_use_id":"call_1","content":"Only cache"}]}}"#,
            ],
        );
        let live = get_session_live_metrics(&path);
        assert_eq!(live.pending_since_ms, 0);
        assert_eq!(live.current_task, "");
        assert_eq!(live.activity_status.as_deref(), Some("running"));
        assert_eq!(live.activity_signal.as_deref(), Some("claude_tool_result"));
        assert_eq!(live.activity_since_ms, 1_767_225_601_000);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn last_activity_uses_transcript_timestamp_not_file_mtime() {
        let entries = parse_jsonl_text(
            r#"{"type":"assistant","timestamp":"2026-01-01T00:00:00Z","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"sleep 1"}}]}}
{"type":"custom-title","customTitle":"metadata-only update"}"#,
            MAX_LINES,
        );
        let live = reduce_entries(&entries, 9_999_999_999_999, false);
        assert_eq!(live.pending_since_ms, 1_767_225_600_000);
        assert_eq!(live.last_activity_ms, 1_767_225_600_000);
    }

    #[test]
    fn tool_result_clears_current_task() {
        clear_session_metrics_cache();
        let dir = std::env::temp_dir();
        let path = dir.join(format!(
            "starling-metrics-{}-tool-result.jsonl",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        write_jsonl(
            &path,
            &[
                r#"{"type":"assistant","timestamp":"2026-01-01T00:00:00Z","message":{"content":[{"type":"tool_use","id":"call_1","name":"Read","input":{"file_path":"/tmp/a"}}]}}"#,
                r#"{"type":"user","timestamp":"2026-01-01T00:00:01Z","message":{"content":[{"type":"tool_result","tool_use_id":"call_1","content":"done"}]}}"#,
                r#"{"type":"assistant","timestamp":"2026-01-01T00:00:02Z","message":{"content":[{"type":"text","text":"Done."}]}}"#,
            ],
        );
        let live = get_session_live_metrics(&path);
        assert_eq!(live.pending_since_ms, 0);
        assert_eq!(live.thinking_since_ms, 0);
        assert_eq!(live.current_task, "");
        assert_eq!(live.last_tool.as_deref(), Some("Read"));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn parallel_tool_result_keeps_unfinished_pending_tool() {
        clear_session_metrics_cache();
        let dir = std::env::temp_dir();
        let path = dir.join(format!(
            "starling-metrics-{}-parallel-tool-result.jsonl",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        write_jsonl(
            &path,
            &[
                r#"{"type":"assistant","timestamp":"2026-01-01T00:00:00Z","message":{"content":[{"type":"tool_use","id":"call_read","name":"Read","input":{"file_path":"/tmp/a"}},{"type":"tool_use","id":"call_bash","name":"Bash","input":{"command":"cd /repo && git remote -v"}}]}}"#,
                r#"{"type":"user","timestamp":"2026-01-01T00:00:01Z","message":{"content":[{"type":"tool_result","tool_use_id":"call_read","content":"done"}]}}"#,
            ],
        );
        let live = get_session_live_metrics(&path);
        assert_eq!(live.pending_since_ms, 1_767_225_600_000);
        assert_eq!(live.last_tool.as_deref(), Some("Bash"));
        assert_eq!(live.current_task, "cd /repo && git remote -v");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn interrupted_tool_use_clears_running_state() {
        clear_session_metrics_cache();
        let dir = std::env::temp_dir();
        let path = dir.join(format!(
            "starling-metrics-{}-interrupted.jsonl",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        write_jsonl(
            &path,
            &[
                r#"{"type":"user","timestamp":"2026-01-01T00:00:00Z","message":{"content":"run checks"}}"#,
                r#"{"type":"assistant","timestamp":"2026-01-01T00:00:01Z","message":{"content":[{"type":"tool_use","id":"call_1","name":"Bash","input":{"command":"cargo test"}}]}}"#,
                r#"{"type":"user","timestamp":"2026-01-01T00:00:02Z","message":{"content":[{"type":"tool_result","tool_use_id":"call_1","content":"done"}]}}"#,
                r#"{"type":"user","timestamp":"2026-01-01T00:00:03Z","message":{"content":"[Request interrupted by user for tool use]"}}"#,
            ],
        );
        let live = get_session_live_metrics(&path);
        assert_eq!(live.pending_since_ms, 0);
        assert_eq!(live.thinking_since_ms, 0);
        assert_eq!(live.activity_status.as_deref(), Some("aborted"));
        assert_eq!(
            live.activity_signal.as_deref(),
            Some("claude_request_interrupted")
        );
        assert_eq!(live.current_task, "");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn human_prompt_after_interrupt_marks_running() {
        clear_session_metrics_cache();
        let dir = std::env::temp_dir();
        let path = dir.join(format!(
            "starling-metrics-{}-interrupted-resume.jsonl",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        write_jsonl(
            &path,
            &[
                r#"{"type":"assistant","timestamp":"2026-01-01T00:00:00Z","message":{"content":[{"type":"tool_use","id":"call_1","name":"Bash","input":{"command":"cargo test"}}]}}"#,
                r#"{"type":"user","timestamp":"2026-01-01T00:00:01Z","message":{"content":"[Request interrupted by user]"}}"#,
                r#"{"type":"user","timestamp":"2026-01-01T00:00:02Z","message":{"content":"please resume the benchmark from the next step"}}"#,
            ],
        );
        let live = get_session_live_metrics(&path);
        assert_eq!(live.pending_since_ms, 0);
        assert_eq!(live.thinking_since_ms, 1_767_225_602_000);
        assert_eq!(live.activity_status.as_deref(), Some("running"));
        assert_eq!(live.activity_signal.as_deref(), Some("claude_user_prompt"));
        assert_eq!(live.activity_since_ms, 1_767_225_602_000);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn claude_thinking_block_sets_thinking_state() {
        clear_session_metrics_cache();
        let dir = std::env::temp_dir();
        let path = dir.join(format!(
            "starling-metrics-{}-claude-thinking.jsonl",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        write_jsonl(
            &path,
            &[
                r#"{"type":"assistant","timestamp":"2026-01-01T00:00:00Z","message":{"content":[{"type":"thinking","thinking":"working"}],"stop_reason":null}}"#,
            ],
        );
        let live = get_session_live_metrics(&path);
        assert_eq!(live.pending_since_ms, 0);
        assert_eq!(live.thinking_since_ms, 1_767_225_600_000);
        assert_eq!(live.activity_status.as_deref(), Some("running"));
        assert_eq!(live.activity_signal.as_deref(), Some("claude_thinking"));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn claude_completed_text_clears_thinking_state() {
        clear_session_metrics_cache();
        let dir = std::env::temp_dir();
        let path = dir.join(format!(
            "starling-metrics-{}-claude-complete.jsonl",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        write_jsonl(
            &path,
            &[
                r#"{"type":"assistant","timestamp":"2026-01-01T00:00:00Z","message":{"content":[{"type":"thinking","thinking":"working"}],"stop_reason":null}}"#,
                r#"{"type":"assistant","timestamp":"2026-01-01T00:00:01Z","message":{"content":[{"type":"text","text":"done"}],"stop_reason":"end_turn"}}"#,
            ],
        );
        let live = get_session_live_metrics(&path);
        assert_eq!(live.pending_since_ms, 0);
        assert_eq!(live.thinking_since_ms, 0);
        assert_eq!(live.activity_status.as_deref(), Some("idle"));
        assert_eq!(
            live.activity_signal.as_deref(),
            Some("claude_assistant_message")
        );
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn empty_live_default() {
        let e = empty_live(42);
        assert_eq!(e.last_activity_ms, 42);
        assert_eq!(e.ctx_pct, -1);
        assert!(e.tool_calls_tail.is_empty());
    }
}
