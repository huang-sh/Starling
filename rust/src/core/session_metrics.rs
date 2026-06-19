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
use std::time::{SystemTime, UNIX_EPOCH};

use once_cell::sync::Lazy;
use serde::Serialize;
use serde_json::Value;

use crate::core::session::{parse_jsonl_text, JsonlEntry};

const FULL_READ_THRESHOLD: u64 = 8 * 1024 * 1024; // 8MB
const TAIL_BYTES: u64 = 65_536;
const MAX_LINES: usize = 100_000;
const DEFAULT_WINDOW: u64 = 200_000;

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
    let m = match model {
        Some(s) if !s.is_empty() => s.to_lowercase(),
        _ => return DEFAULT_WINDOW,
    };
    if m.contains("1m") || m.contains("1000k") { return 1_000_000; }
    DEFAULT_WINDOW
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

fn as_num(value: &Value) -> u64 {
    value.as_f64().map(|f| f as u64).unwrap_or(0)
}

fn extract_assistant_usage(entry: &JsonlEntry) -> Option<AssistantUsage> {
    let obj = entry.value().as_object()?;
    let msg = obj.get("message").and_then(|v| v.as_object());
    let usage = msg.and_then(|m| m.get("usage")).filter(|v| v.is_object())
        .or_else(|| obj.get("usage")).and_then(|v| v.as_object())?;
    let pick = |keys: &[&str]| -> u64 {
        for k in keys {
            if let Some(v) = usage.get(*k) {
                if v.is_number() { return as_num(v); }
            }
        }
        0
    };
    let input = pick(&["input_tokens", "inputTokens"]) + pick(&["prompt_tokens", "promptTokens"]);
    let output = pick(&["output_tokens", "outputTokens", "completion_tokens", "completionTokens"]);
    let cache_creation = pick(&["cache_creation_input_tokens", "cacheCreationInputTokens"]);
    let cache_read = pick(&["cache_read_input_tokens", "cacheReadInputTokens"]);
    if input == 0 && output == 0 && cache_creation == 0 && cache_read == 0 { return None; }
    Some(AssistantUsage { input, output, cache_creation, cache_read })
}

fn extract_model(entry: &JsonlEntry) -> Option<String> {
    let obj = entry.value().as_object()?;
    let direct = obj.get("model").and_then(|v| v.as_str());
    if let Some(d) = direct {
        if !d.starts_with('<') && d != "synthetic" { return Some(d.to_string()); }
    }
    let mm = obj.get("message").and_then(|m| m.as_object())
        .and_then(|m| m.get("model")).and_then(|v| v.as_str());
    if let Some(m) = mm {
        if !m.starts_with('<') && m != "synthetic" { return Some(m.to_string()); }
    }
    None
}

fn extract_tool_use_arg(name: &str, input: &Value) -> String {
    let obj = match input.as_object() { Some(o) => o, None => return String::new() };
    let low = name.to_lowercase();
    if low == "bash" {
        if let Some(c) = obj.get("command").and_then(|v| v.as_str()) { return c.to_string(); }
    }
    if low == "grep" || low == "glob" {
        if let Some(p) = obj.get("pattern").and_then(|v| v.as_str()) { return p.to_string(); }
    }
    if let Some(fp) = obj.get("file_path").and_then(|v| v.as_str()) { return fp.to_string(); }
    if let Some(sat) = obj.get("subagent_type").and_then(|v| v.as_str()) { return sat.to_string(); }
    if let Some(desc) = obj.get("description").and_then(|v| v.as_str()) { return desc.to_string(); }
    serde_json::to_string(input).unwrap_or_default()
}

fn parse_entry_timestamp(entry: &JsonlEntry) -> u64 {
    let obj = match entry.value().as_object() { Some(o) => o, None => return 0 };
    let ts = match obj.get("timestamp") { Some(v) => v, None => return 0 };
    if let Some(s) = ts.as_str() {
        if let Ok(parsed) = chrono::DateTime::parse_from_rfc3339(s) {
            return parsed.timestamp_millis() as u64;
        }
        return 0;
    }
    if let Some(n) = ts.as_f64() {
        return if n > 1e12 { n as u64 } else { (n * 1000.0) as u64 };
    }
    0
}

struct ContentBlocks {
    text: Vec<String>,
    tool_result: bool,
    tool_use: Vec<(String, Value)>,
}

fn extract_content_blocks(entry: &JsonlEntry) -> ContentBlocks {
    let mut out = ContentBlocks { text: vec![], tool_result: false, tool_use: vec![] };
    let obj = match entry.value().as_object() { Some(o) => o, None => return out };
    let msg = match obj.get("message").and_then(|v| v.as_object()) { Some(m) => m, None => return out };
    match msg.get("content") {
        Some(Value::String(s)) => out.text.push(s.clone()),
        Some(Value::Array(arr)) => {
            for part in arr {
                if let Some(p) = part.as_object() {
                    let t = p.get("type").and_then(|v| v.as_str());
                    if t == Some("text") {
                        if let Some(s) = p.get("text").and_then(|v| v.as_str()) {
                            out.text.push(s.to_string());
                        }
                    } else if t == Some("tool_use") {
                        if let Some(name) = p.get("name").and_then(|v| v.as_str()) {
                            let input = p.get("input").cloned().unwrap_or(Value::Null);
                            out.tool_use.push((name.to_string(), input));
                        }
                    } else if t == Some("tool_result") {
                        out.tool_result = true;
                    }
                }
            }
        }
        _ => {}
    }
    out
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
    let mut current_task = String::new();
    let mut token_history: Vec<u64> = Vec::new();
    let mut context_history: Vec<u64> = Vec::new();
    let mut tool_calls_tail: Vec<ToolCallEntry> = Vec::new();
    let mut chat_tail: Vec<ChatMessageEntry> = Vec::new();

    for entry in entries {
        if model.is_empty() {
            if let Some(m) = extract_model(entry) { model = m; }
        }
        let ts = parse_entry_timestamp(entry);
        if started_at_ms == 0 && ts > 0 { started_at_ms = ts; }

        if let Some(usage) = extract_assistant_usage(entry) {
            tokens.input += usage.input;
            tokens.output += usage.output;
            tokens.cache += usage.cache_creation + usage.cache_read;
            last_usage = Some(usage);
        }

        let entry_type = entry.type_str();
        let is_assistant = entry_type == Some("assistant") || entry_type == Some("function_call");
        let is_user = entry_type == Some("user") || entry_type == Some("human")
            || entry_type == Some("function_call_output");

        let mut tool_uses: Vec<(String, Value)> = Vec::new();
        if is_assistant || is_user {
            let blocks = extract_content_blocks(entry);
            if !blocks.tool_use.is_empty() {
                tool_uses = blocks.tool_use;
            }
            if is_assistant {
                thinking_since_ms = 0;
                if !tool_uses.is_empty() {
                    pending_since_ms = if ts > 0 { ts } else { last_activity_ms };
                }
                for t in blocks.text {
                    let t = t.trim();
                    if !t.is_empty() {
                        chat_tail.push(ChatMessageEntry { role: ChatRole::Assistant, text: truncate(&t, MAX_CHAT_TEXT_LEN) });
                        if chat_tail.len() > MAX_CHAT_TAIL { chat_tail.remove(0); }
                    }
                }
            } else if is_user {
                pending_since_ms = 0;
                thinking_since_ms = if ts > 0 { ts } else { last_activity_ms };
                if !blocks.tool_result {
                    for t in blocks.text {
                        let t = t.trim();
                        if !t.is_empty() {
                            chat_tail.push(ChatMessageEntry { role: ChatRole::User, text: truncate(&t, MAX_CHAT_TEXT_LEN) });
                            if chat_tail.len() > MAX_CHAT_TAIL { chat_tail.remove(0); }
                        }
                    }
                }
            }
        } else if entry_type == Some("function_call") {
            // Codex function_call has .name + .arguments at the top level
            if let Some(obj) = entry.value().as_object() {
                if let Some(name) = obj.get("name").and_then(|v| v.as_str()) {
                    let input = match obj.get("arguments") {
                        Some(Value::String(s)) => serde_json::from_str(s).unwrap_or(Value::Null),
                        Some(other) => other.clone(),
                        None => Value::Null,
                    };
                    tool_uses.push((name.to_string(), input));
                }
            }
        }

        if !tool_uses.is_empty() {
            tool_count += tool_uses.len() as u32;
            let last = tool_uses.last().unwrap();
            last_tool = Some(last.0.clone());
            current_task = truncate(&extract_tool_use_arg(&last.0, &last.1), MAX_TOOL_ARG_LEN);
            for (name, input) in &tool_uses {
                let arg = truncate(&extract_tool_use_arg(name, input), MAX_TOOL_ARG_LEN);
                tool_calls_tail.push(ToolCallEntry { name: name.clone(), arg, duration_ms: 0 });
                if tool_calls_tail.len() > MAX_TOOL_TAIL { tool_calls_tail.remove(0); }
            }
        }

        if is_assistant && last_usage.is_some() {
            let usage = last_usage.unwrap();
            let ctx_size = usage.input + usage.cache_creation + usage.cache_read;
            token_history.push(tokens.input + tokens.output + tokens.cache);
            if token_history.len() > MAX_TOKEN_HISTORY { token_history.remove(0); }
            context_history.push(ctx_size);
            if context_history.len() > MAX_TOKEN_HISTORY { context_history.remove(0); }
        }
    }

    tokens.total = tokens.input + tokens.output;

    let mut ctx_pct: i64 = -1;
    if let Some(last) = last_usage {
        let ctx_input = last.input + last.cache_creation + last.cache_read;
        let window = model_context_window(if model.is_empty() { None } else { Some(&model) });
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

    SessionLive {
        model,
        tokens,
        ctx_pct,
        last_tool,
        tool_count,
        last_activity_ms,
        truncated,
        started_at_ms,
        pending_since_ms,
        thinking_since_ms,
        token_history,
        context_history,
        compaction_count,
        current_task,
        tool_calls_tail,
        chat_tail,
    }
}

fn read_tail_entries(path: &Path, size: u64) -> Vec<JsonlEntry> {
    let mut file = match File::open(path) { Ok(f) => f, Err(_) => return vec![] };
    let start = size.saturating_sub(TAIL_BYTES);
    if start > 0 {
        if file.seek(SeekFrom::Start(start)).is_err() { return vec![]; }
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
    if let Ok(mut c) = CACHE.lock() { c.clear(); }
}

fn mtime_ms(path: &Path) -> Option<u64> {
    let md = std::fs::metadata(path).ok()?;
    md.modified().ok()?
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

    let result = if size <= FULL_READ_THRESHOLD {
        let entries = crate::core::session::parse_jsonl_head(path, MAX_LINES);
        reduce_entries(&entries, mtime, false)
    } else {
        let entries = read_tail_entries(path, size);
        reduce_entries(&entries, mtime, true)
    };

    if let Ok(mut c) = CACHE.lock() {
        c.insert(path.to_path_buf(), CacheEntry { mtime_ms: mtime, result: result.clone() });
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_jsonl(path: &Path, lines: &[&str]) {
        let mut f = std::fs::File::create(path).unwrap();
        for line in lines {
            writeln!(f, "{line}").unwrap();
        }
    }

    #[test]
    fn reduces_tokens_and_model() {
        clear_session_metrics_cache();
        let dir = std::env::temp_dir();
        let path = dir.join(format!("starling-metrics-{}.jsonl",
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
        write_jsonl(&path, &[
            r#"{"type":"user","timestamp":"2026-01-01T00:00:00Z","message":{"content":"hi"}}"#,
            r#"{"type":"assistant","timestamp":"2026-01-01T00:00:01Z","model":"claude-sonnet","message":{"model":"claude-sonnet","usage":{"input_tokens":100,"output_tokens":50,"cache_read_input_tokens":200}}}"#,
            r#"{"type":"assistant","timestamp":"2026-01-01T00:00:02Z","model":"claude-sonnet","message":{"model":"claude-sonnet","usage":{"input_tokens":120,"output_tokens":60,"cache_read_input_tokens":220}}}"#,
        ]);
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
    fn counts_tools_and_tail() {
        clear_session_metrics_cache();
        let dir = std::env::temp_dir();
        let path = dir.join(format!("starling-metrics-{}-b.jsonl",
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
        write_jsonl(&path, &[
            r#"{"type":"assistant","timestamp":"2026-01-01T00:00:00Z","message":{"content":[{"type":"text","text":"hello"},{"type":"tool_use","name":"Bash","input":{"command":"ls -la"}}]}}"#,
        ]);
        let live = get_session_live_metrics(&path);
        assert_eq!(live.tool_count, 1);
        assert_eq!(live.last_tool.as_deref(), Some("Bash"));
        assert_eq!(live.current_task, "ls -la");
        assert!(!live.chat_tail.is_empty());
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
