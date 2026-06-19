//! JSONL parsing and Claude/Codex session-meta extraction.
//! Mirrors src/lib/session.ts.

use std::path::Path;

use serde::Serialize;
use serde_json::Value;

use crate::constants::now_iso;
use crate::types::{SessionMeta, TokenUsage};

#[derive(Debug, Clone, Default, Serialize)]
pub struct JsonlEntry(pub Value);

impl JsonlEntry {
    pub fn value(&self) -> &Value { &self.0 }
    pub fn as_record(&self) -> Option<&serde_json::Map<String, Value>> {
        self.0.as_object()
    }
    pub fn type_str(&self) -> Option<&str> { self.0.get("type").and_then(|v| v.as_str()) }
}

fn as_number(value: &Value) -> Option<f64> {
    match value {
        Value::Number(n) => n.as_f64().filter(|f| f.is_finite()),
        Value::String(s) => s.parse::<f64>().ok().filter(|f| f.is_finite()),
        _ => None,
    }
}

fn as_usize_field(obj: &serde_json::Map<String, Value>, key: &str) -> Option<u64> {
    obj.get(key).and_then(as_number).map(|f| f as u64)
}

fn merge_token_usage(target: &mut TokenUsage, source: &TokenUsage) {
    if let Some(v) = source.input_tokens { target.input_tokens = Some(v); }
    if let Some(v) = source.output_tokens { target.output_tokens = Some(v); }
    if let Some(v) = source.total_tokens { target.total_tokens = Some(v); }
    if let Some(v) = source.cache_tokens { target.cache_tokens = Some(v); }
}

fn has_non_zero(usage: Option<&TokenUsage>) -> bool {
    usage.map(|u| {
        u.input_tokens.unwrap_or(0) > 0
            || u.output_tokens.unwrap_or(0) > 0
            || u.total_tokens.unwrap_or(0) > 0
            || u.cache_tokens.unwrap_or(0) > 0
    }).unwrap_or(false)
}

fn add_token_usage(target: &mut TokenUsage, source: &TokenUsage) {
    if let Some(v) = source.input_tokens {
        target.input_tokens = Some(target.input_tokens.unwrap_or(0) + v);
    }
    if let Some(v) = source.output_tokens {
        target.output_tokens = Some(target.output_tokens.unwrap_or(0) + v);
    }
    if let Some(v) = source.cache_tokens {
        target.cache_tokens = Some(target.cache_tokens.unwrap_or(0) + v);
    }
    let input = target.input_tokens.unwrap_or(0);
    let output = target.output_tokens.unwrap_or(0);
    if target.input_tokens.is_some() || target.output_tokens.is_some() {
        target.total_tokens = Some(input + output);
    } else if let Some(v) = source.total_tokens {
        target.total_tokens = Some(target.total_tokens.unwrap_or(0) + v);
    }
}

fn normalize_cache_tokens(raw: &serde_json::Map<String, Value>) -> Option<u64> {
    let direct = as_usize_field(raw, "cache_tokens")
        .or_else(|| as_usize_field(raw, "cacheTokens"))
        .or_else(|| as_usize_field(raw, "cached_input_tokens"))
        .or_else(|| as_usize_field(raw, "cachedInputTokens"));
    if direct.is_some() { return direct; }

    let from_creation = as_usize_field(raw, "cache_creation_input_tokens")
        .or_else(|| as_usize_field(raw, "cacheCreationInputTokens"));
    let from_read = as_usize_field(raw, "cache_read_input_tokens")
        .or_else(|| as_usize_field(raw, "cacheReadInputTokens"));
    if from_creation.is_some() || from_read.is_some() {
        return Some(from_creation.unwrap_or(0) + from_read.unwrap_or(0));
    }
    None
}

fn extract_token_usage_from_value(value: &Value, depth: u32) -> Option<TokenUsage> {
    if depth > 16 { return None; }

    if let Some(arr) = value.as_array() {
        let mut merged = TokenUsage {
            input_tokens: None, output_tokens: None,
            total_tokens: None, cache_tokens: None,
        };
        let mut found = false;
        for item in arr {
            if let Some(u) = extract_token_usage_from_value(item, depth + 1) {
                merge_token_usage(&mut merged, &u);
                found = true;
            }
        }
        return if found { Some(merged) } else { None };
    }

    let obj = match value.as_object() {
        Some(o) => o,
        None => return None,
    };

    // total_token_usage wins (typically pre-summarized by Claude Code).
    let total_src = obj.get("total_token_usage").filter(|v| v.is_object())
        .or_else(|| obj.get("totalTokenUsage").filter(|v| v.is_object()));
    if let Some(src) = total_src {
        let total_usage = extract_token_usage_from_value(src, depth + 1);
        if has_non_zero(total_usage.as_ref()) { return total_usage; }

        let last_src = obj.get("last_token_usage").filter(|v| v.is_object())
            .or_else(|| obj.get("lastTokenUsage").filter(|v| v.is_object()));
        if let Some(src) = last_src {
            let last_usage = extract_token_usage_from_value(src, depth + 1);
            if has_non_zero(last_usage.as_ref()) { return last_usage; }
        }
        return total_usage;
    }

    let input = as_usize_field(obj, "input_tokens")
        .or_else(|| as_usize_field(obj, "inputTokens"))
        .or_else(|| as_usize_field(obj, "prompt_tokens"))
        .or_else(|| as_usize_field(obj, "promptTokens"));

    let output = as_usize_field(obj, "output_tokens")
        .or_else(|| as_usize_field(obj, "outputTokens"))
        .or_else(|| as_usize_field(obj, "completion_tokens"))
        .or_else(|| as_usize_field(obj, "completionTokens"));

    let total = as_usize_field(obj, "total_tokens")
        .or_else(|| as_usize_field(obj, "totalTokens"))
        .or_else(|| match (input, output) { (Some(i), Some(o)) => Some(i + o), _ => None });

    let cache = normalize_cache_tokens(obj);

    let mut usage = TokenUsage {
        input_tokens: input, output_tokens: output,
        total_tokens: total, cache_tokens: cache,
    };

    for (_k, candidate) in obj.iter() {
        if let Some(nested) = extract_token_usage_from_value(candidate, 0) {
            merge_token_usage(&mut usage, &nested);
        }
    }

    if usage.input_tokens.is_none()
        && usage.output_tokens.is_none()
        && usage.total_tokens.is_none()
        && usage.cache_tokens.is_none()
    {
        return None;
    }
    Some(usage)
}

pub fn extract_token_usage(entry: &JsonlEntry) -> Option<TokenUsage> {
    extract_token_usage_from_value(entry.value(), 0)
}

fn has_cumulative_token_usage(value: &Value, depth: u32) -> bool {
    if depth > 16 { return false; }
    if let Some(arr) = value.as_array() {
        return arr.iter().any(|v| has_cumulative_token_usage(v, depth + 1));
    }
    let obj = match value.as_object() { Some(o) => o, None => return false };
    if obj.get("total_token_usage").map(|v| v.is_object()).unwrap_or(false)
        || obj.get("totalTokenUsage").map(|v| v.is_object()).unwrap_or(false) { return true; }
    obj.iter().any(|(_, v)| has_cumulative_token_usage(v, depth + 1))
}

/// Parse up to `max_lines` JSONL lines from `path`. Malformed lines are skipped.
pub fn parse_jsonl_head(path: &Path, max_lines: usize) -> Vec<JsonlEntry> {
    let raw = match std::fs::read_to_string(path) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    parse_jsonl_text(&raw, max_lines)
}

pub fn parse_jsonl_text(raw: &str, max_lines: usize) -> Vec<JsonlEntry> {
    let mut out = Vec::new();
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() { continue; }
        if let Ok(v) = serde_json::from_str::<Value>(trimmed) {
            out.push(JsonlEntry(v));
        }
        if max_lines != usize::MAX && out.len() >= max_lines { break; }
    }
    out
}

pub fn parse_jsonl_file(path: &Path) -> Vec<JsonlEntry> {
    parse_jsonl_head(path, usize::MAX)
}

fn first_prompt_from_message(msg: &Value) -> String {
    let content = match msg.get("content") {
        Some(c) => c,
        None => return String::new(),
    };
    if let Some(s) = content.as_str() {
        return s.to_string();
    }
    if let Some(arr) = content.as_array() {
        for part in arr {
            if let Some(obj) = part.as_object() {
                if obj.get("type").and_then(|v| v.as_str()) == Some("text") {
                    if let Some(t) = obj.get("text").and_then(|v| v.as_str()) {
                        return t.to_string();
                    }
                }
            }
        }
    }
    String::new()
}

fn basename_no_ext(path: &Path) -> String {
    path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default()
}

pub fn extract_claude_session_meta(entries: &[JsonlEntry], file_path: &Path, modified_at: &str) -> SessionMeta {
    let mut session_id = String::new();
    let mut model = String::new();
    let mut project_path = String::new();
    let mut first_prompt = String::new();
    let mut custom_title = String::new();
    let mut token_usage = TokenUsage {
        input_tokens: None, output_tokens: None,
        total_tokens: None, cache_tokens: None,
    };
    let mut has_token_usage = false;

    for entry in entries {
        let obj = entry.as_record();
        if let Some(o) = obj {
            if session_id.is_empty() {
                if let Some(s) = o.get("sessionId").and_then(|v| v.as_str()) {
                    session_id = s.to_string();
                }
            }
            if entry.type_str() == Some("custom-title") {
                if let Some(t) = o.get("customTitle").and_then(|v| v.as_str()) {
                    let trimmed = t.trim();
                    if !trimmed.is_empty() { custom_title = trimmed.to_string(); }
                }
            }
            if model.is_empty() {
                let candidate = o.get("model").and_then(|v| v.as_str())
                    .or_else(|| o.get("message").and_then(|m| m.get("model")).and_then(|v| v.as_str()));
                if let Some(c) = candidate {
                    if !c.starts_with('<') && c != "synthetic" {
                        model = c.to_string();
                    }
                }
            }
            if project_path.is_empty() {
                if let Some(cwd) = o.get("cwd").and_then(|v| v.as_str()) {
                    project_path = cwd.to_string();
                }
            }
            let t = entry.type_str();
            if (t == Some("user") || t == Some("human")) && first_prompt.is_empty() {
                if let Some(msg) = o.get("message") {
                    let p = first_prompt_from_message(msg);
                    if !p.is_empty() { first_prompt = p; }
                }
            }
        }

        if let Some(entry_usage) = extract_token_usage(entry) {
            if has_cumulative_token_usage(entry.value(), 0) {
                merge_token_usage(&mut token_usage, &entry_usage);
            } else {
                add_token_usage(&mut token_usage, &entry_usage);
            }
            has_token_usage = true;
        }
    }

    if session_id.is_empty() {
        session_id = basename_no_ext(file_path);
    }

    let truncated = first_prompt.chars().take(200).collect();
    SessionMeta {
        session_id,
        provider: "claude".into(),
        model,
        project_path,
        first_prompt: truncated,
        custom_title: if custom_title.is_empty() { None } else { Some(custom_title) },
        file_path: file_path.to_string_lossy().to_string(),
        created_at: modified_at.to_string(),
        modified_at: modified_at.to_string(),
        token_usage: if has_token_usage { Some(token_usage) } else { None },
    }
}

pub fn extract_codex_session_meta(entries: &[JsonlEntry], file_path: &Path, modified_at: &str) -> SessionMeta {
    let mut session_id = String::new();
    let mut model = String::new();
    let mut project_path = String::new();
    let mut first_prompt = String::new();
    let mut token_usage = TokenUsage {
        input_tokens: None, output_tokens: None,
        total_tokens: None, cache_tokens: None,
    };
    let mut has_token_usage = false;

    for entry in entries {
        if let Some(o) = entry.as_record() {
            if entry.type_str() == Some("session_meta") {
                if let Some(p) = o.get("payload").and_then(|v| v.as_object()) {
                    if session_id.is_empty() {
                        if let Some(id) = p.get("id").and_then(|v| v.as_str()) {
                            session_id = id.to_string();
                        }
                    }
                    if project_path.is_empty() {
                        if let Some(cwd) = p.get("cwd").and_then(|v| v.as_str()) {
                            project_path = cwd.to_string();
                        }
                    }
                    if model.is_empty() {
                        if let Some(mp) = p.get("model_provider").and_then(|v| v.as_str()) {
                            model = mp.to_string();
                        }
                    }
                }
            }
            if entry.type_str() == Some("event_msg") {
                if let Some(p) = o.get("payload").and_then(|v| v.as_object()) {
                    if p.get("type").and_then(|v| v.as_str()) == Some("user_message") {
                        if first_prompt.is_empty() {
                            if let Some(c) = p.get("content").and_then(|v| v.as_str()) {
                                first_prompt = c.to_string();
                            }
                        }
                    }
                }
            }
            if entry.type_str() == Some("turn_context") {
                if let Some(p) = o.get("payload").and_then(|v| v.as_object()) {
                    if model == "openai" {
                        if let Some(m) = p.get("model").and_then(|v| v.as_str()) {
                            model = m.to_string();
                        }
                    }
                }
            }
        }

        if let Some(entry_usage) = extract_token_usage(entry) {
            merge_token_usage(&mut token_usage, &entry_usage);
            has_token_usage = true;
        }
    }

    if session_id.is_empty() {
        session_id = basename_no_ext(file_path);
    }

    let truncated = first_prompt.chars().take(200).collect();
    SessionMeta {
        session_id,
        provider: "codex".into(),
        model,
        project_path,
        first_prompt: truncated,
        custom_title: None,
        file_path: file_path.to_string_lossy().to_string(),
        created_at: modified_at.to_string(),
        modified_at: modified_at.to_string(),
        token_usage: if has_token_usage { Some(token_usage) } else { None },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(s: &str) -> JsonlEntry {
        JsonlEntry(serde_json::from_str(s).unwrap())
    }

    #[test]
    fn parses_simple_jsonl() {
        let raw = "{\"type\":\"user\",\"message\":{\"content\":\"hi\"}}\n{\"type\":\"assistant\",\"model\":\"claude-3\"}\n";
        let entries = parse_jsonl_text(raw, usize::MAX);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].type_str(), Some("user"));
    }

    #[test]
    fn parse_skips_malformed_lines() {
        let raw = "{\"valid\":true}\nNOT JSON\n{\"also\":true}";
        let entries = parse_jsonl_text(raw, usize::MAX);
        assert_eq!(entries.len(), 2);
    }

    #[test]
    fn claude_meta_extracts_basics() {
        let path = Path::new("/tmp/abc-123.jsonl");
        let entries = vec![
            entry(r#"{"sessionId":"abc-123","cwd":"/home/user/proj"}"#),
            entry(r#"{"type":"user","message":{"content":"hello world"}}"#),
            entry(r#"{"type":"assistant","message":{"model":"claude-sonnet-4-5"}}"#),
        ];
        let meta = extract_claude_session_meta(&entries, path, "2026-01-01T00:00:00Z");
        assert_eq!(meta.session_id, "abc-123");
        assert_eq!(meta.provider, "claude");
        assert_eq!(meta.project_path, "/home/user/proj");
        assert_eq!(meta.first_prompt, "hello world");
        assert_eq!(meta.model, "claude-sonnet-4-5");
    }

    #[test]
    fn claude_meta_skips_synthetic_model() {
        let path = Path::new("/tmp/abc.jsonl");
        let entries = vec![
            entry(r#"{"model":"<synthetic>"}"#),
            entry(r#"{"type":"assistant","message":{"model":"claude-3-opus"}}"#),
        ];
        let meta = extract_claude_session_meta(&entries, path, "now");
        assert_eq!(meta.model, "claude-3-opus");
    }

    #[test]
    fn claude_meta_uses_filename_when_no_session_id() {
        let path = Path::new("/home/u/.claude/projects/foo/def-456.jsonl");
        let meta = extract_claude_session_meta(&[], path, "now");
        assert_eq!(meta.session_id, "def-456");
    }

    #[test]
    fn claude_meta_extracts_custom_title() {
        let path = Path::new("/tmp/abc.jsonl");
        let entries = vec![
            entry(r#"{"type":"custom-title","customTitle":"  my topic  "}"#),
        ];
        let meta = extract_claude_session_meta(&entries, path, "now");
        assert_eq!(meta.custom_title.as_deref(), Some("my topic"));
    }

    #[test]
    fn claude_meta_extracts_total_token_usage() {
        let path = Path::new("/tmp/abc.jsonl");
        let entries = vec![
            entry(r#"{"message":{"usage":{"input_tokens":100,"output_tokens":50,"cache_read_input_tokens":200}}}"#),
        ];
        let meta = extract_claude_session_meta(&entries, path, "now");
        let usage = meta.token_usage.expect("should have token usage");
        assert_eq!(usage.input_tokens, Some(100));
        assert_eq!(usage.output_tokens, Some(50));
        assert_eq!(usage.cache_tokens, Some(200));
        assert_eq!(usage.total_tokens, Some(150));
    }

    #[test]
    fn claude_meta_handles_total_token_usage_block() {
        let path = Path::new("/tmp/abc.jsonl");
        // total_token_usage overrides per-turn usage
        let entries = vec![
            entry(r#"{"message":{"usage":{"input_tokens":100}}}"#),
            entry(r#"{"total_token_usage":{"input_tokens":5000,"output_tokens":1000,"cache_read_input_tokens":3000}}"#),
        ];
        let meta = extract_claude_session_meta(&entries, path, "now");
        let usage = meta.token_usage.expect("should have token usage");
        assert_eq!(usage.input_tokens, Some(5000));
        assert_eq!(usage.output_tokens, Some(1000));
    }

    #[test]
    fn codex_meta_extracts_session_meta_payload() {
        let path = Path::new("/tmp/codex-abc.jsonl");
        let entries = vec![
            entry(r#"{"type":"session_meta","payload":{"id":"codex-abc","cwd":"/home/u/proj","model_provider":"openai"}}"#),
            entry(r#"{"type":"event_msg","payload":{"type":"user_message","content":"hi there"}}"#),
            entry(r#"{"type":"turn_context","payload":{"model":"gpt-5"}}"#),
        ];
        let meta = extract_codex_session_meta(&entries, path, "now");
        assert_eq!(meta.session_id, "codex-abc");
        assert_eq!(meta.provider, "codex");
        assert_eq!(meta.project_path, "/home/u/proj");
        assert_eq!(meta.first_prompt, "hi there");
        assert_eq!(meta.model, "gpt-5");
    }

    #[test]
    fn codex_meta_uses_filename_when_no_session_meta() {
        let path = Path::new("/home/u/.codex/sessions/2026/01/xyz-789.jsonl");
        let meta = extract_codex_session_meta(&[], path, "now");
        assert_eq!(meta.session_id, "xyz-789");
    }

    #[test]
    fn first_prompt_truncated_at_200_chars() {
        let long = "a".repeat(500);
        let path = Path::new("/tmp/x.jsonl");
        let entries = vec![
            entry(&format!(r#"{{"type":"user","message":{{"content":"{}"}}}}"#, long)),
        ];
        let meta = extract_claude_session_meta(&entries, path, "now");
        assert_eq!(meta.first_prompt.chars().count(), 200);
    }
}

// Silence unused warning when only tests use now_iso
#[allow(dead_code)]
fn _anchor_now_iso() -> String { now_iso() }
