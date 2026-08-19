//! Pi transcript conventions.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::agents::basename_lower;
use crate::constants::{normalize_pi_path_input, pi_node_compatible_path, resolve_pi_session_root};
use crate::core::session::{add_token_usage, as_usize_field, basename_no_ext, JsonlEntry};
use crate::types::{SessionMeta, TokenUsage};

pub fn session_roots() -> Vec<PathBuf> {
    vec![resolve_pi_session_root()]
}

pub(crate) fn is_cli_script(arg: &str) -> bool {
    let normalized = arg.replace('\\', "/").to_ascii_lowercase();
    normalized.ends_with("/pi.js")
        || normalized.contains("/pi-coding-agent/dist/cli.js")
        || normalized.ends_with("/packages/coding-agent/dist/cli.js")
        || normalized.ends_with("/packages/coding-agent/src/cli.ts")
}

pub(crate) fn is_node_entry(arg: &str) -> bool {
    basename_lower(arg).trim_end_matches(".cmd") == "pi" || is_cli_script(arg)
}

pub(crate) fn process_home(environ: &HashMap<String, String>) -> PathBuf {
    environ
        .get("PI_CODING_AGENT_DIR")
        .filter(|value| !value.is_empty())
        .map(|value| normalize_pi_path_input(value))
        .unwrap_or_else(|| {
            dirs::home_dir()
                .unwrap_or_default()
                .join(".pi")
                .join("agent")
        })
}

pub(crate) fn process_session_root(home: &Path) -> PathBuf {
    home.join("sessions")
}

#[derive(Debug, Default)]
pub(crate) struct ProcessArgs<'a> {
    pub session: Option<&'a str>,
    pub session_id: Option<&'a str>,
    pub session_dir: Option<&'a str>,
}

#[derive(Debug)]
pub(crate) struct HookSession {
    pub session_id: String,
    pub transcript_path: Option<PathBuf>,
    pub cwd: Option<PathBuf>,
}

fn hook_string<'a>(value: &'a Value, snake: &str, camel: &str) -> Option<&'a str> {
    value
        .get(snake)
        .or_else(|| value.get(camel))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

pub(crate) fn process_hook_session(
    environ: &HashMap<String, String>,
    cwd: Option<&Path>,
) -> Option<HookSession> {
    let hook_path = environ
        .get("STARLING_PI_HOOK_FILE")
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())?;
    let raw = std::fs::read_to_string(resolve_process_path(hook_path, cwd)).ok()?;
    raw.lines().rev().find_map(|line| {
        let value: Value = serde_json::from_str(line.trim()).ok()?;
        let source = value
            .get("payload")
            .filter(|payload| payload.is_object())
            .unwrap_or(&value);
        let session_id = hook_string(source, "session_id", "sessionId")?;
        if !valid_session_id(session_id) {
            return None;
        }
        let event_cwd = source
            .get("cwd")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| resolve_process_path(value, cwd));
        Some(HookSession {
            session_id: session_id.to_string(),
            transcript_path: hook_string(source, "transcript_path", "transcriptPath")
                .map(|path| resolve_process_path(path, event_cwd.as_deref().or(cwd))),
            cwd: event_cwd,
        })
    })
}

pub(crate) fn managed_session_id(environ: &HashMap<String, String>) -> Option<&str> {
    environ
        .get("STARLING_SESSION_ID")
        .map(|value| value.trim())
        .filter(|value| valid_session_id(value))
}

pub(crate) fn parse_process_args(args: &[String]) -> ProcessArgs<'_> {
    let mut parsed = ProcessArgs::default();
    let mut index = 0;
    while index < args.len() {
        let arg = args[index].as_str();
        if required_value_arg(arg) {
            let Some(value) = args.get(index + 1).map(String::as_str) else {
                index += 1;
                continue;
            };
            match arg {
                "--session" => parsed.session = Some(value),
                "--session-id" => parsed.session_id = Some(value),
                "--session-dir" => parsed.session_dir = Some(value),
                _ => {}
            }
            index += 2;
            continue;
        }
        let next = args.get(index + 1).map(String::as_str);
        let consumes_optional_value = match arg {
            "--print" | "-p" => next
                .map(|value| {
                    !value.starts_with('@') && (!value.starts_with('-') || value.starts_with("---"))
                })
                .unwrap_or(false),
            "--list-models" => next
                .map(|value| !value.starts_with('-') && !value.starts_with('@'))
                .unwrap_or(false),
            _ if native_boolean_arg(arg) => false,
            _ if arg.starts_with("--") && !arg.contains('=') => next
                .map(|value| !value.starts_with('-') && !value.starts_with('@'))
                .unwrap_or(false),
            _ => false,
        };
        index += 1 + usize::from(consumes_optional_value);
    }
    parsed
}

pub(crate) fn required_value_arg(arg: &str) -> bool {
    matches!(
        arg,
        "--mode"
            | "--provider"
            | "--model"
            | "--api-key"
            | "--system-prompt"
            | "--append-system-prompt"
            | "--name"
            | "-n"
            | "--session"
            | "--session-id"
            | "--fork"
            | "--session-dir"
            | "--models"
            | "--tools"
            | "-t"
            | "--exclude-tools"
            | "-xt"
            | "--thinking"
            | "--export"
            | "--extension"
            | "-e"
            | "--skill"
            | "--prompt-template"
            | "--theme"
    )
}

pub(crate) fn native_boolean_arg(arg: &str) -> bool {
    matches!(
        arg,
        "--help"
            | "-h"
            | "--version"
            | "-v"
            | "--continue"
            | "-c"
            | "--resume"
            | "-r"
            | "--no-session"
            | "--no-tools"
            | "-nt"
            | "--no-builtin-tools"
            | "-nbt"
            | "--no-extensions"
            | "-ne"
            | "--no-skills"
            | "-ns"
            | "--no-prompt-templates"
            | "-np"
            | "--no-themes"
            | "--no-context-files"
            | "-nc"
            | "--verbose"
            | "--approve"
            | "-a"
            | "--no-approve"
            | "-na"
            | "--offline"
    )
}

fn read_session_dir_setting(path: &Path) -> Option<Option<String>> {
    let raw = std::fs::read_to_string(path).ok()?;
    let settings: Value = serde_json::from_str(&raw).ok()?;
    let value = settings.as_object()?.get("sessionDir")?;
    Some(
        value
            .as_str()
            .filter(|value| !value.is_empty())
            .map(str::to_string),
    )
}

fn configured_session_dir(home: &Path, cwd: Option<&Path>) -> Option<String> {
    if let Some(project) =
        cwd.and_then(|cwd| read_session_dir_setting(&cwd.join(".pi/settings.json")))
    {
        return project;
    }
    read_session_dir_setting(&home.join("settings.json")).flatten()
}

pub(crate) fn resolve_session_root(
    home: &Path,
    environ: &HashMap<String, String>,
    args: &[String],
    cwd: Option<&Path>,
) -> (PathBuf, bool, bool) {
    let configured = parse_process_args(args)
        .session_dir
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| {
            environ
                .get("PI_CODING_AGENT_SESSION_DIR")
                .filter(|value| !value.is_empty())
                .cloned()
        })
        .or_else(|| configured_session_dir(home, cwd));
    match configured {
        Some(value) => {
            let normalized = normalize_pi_path_input(&value);
            let default_local = cwd
                .map(|cwd| process_session_root(home).join(encode_cwd(&cwd.to_string_lossy())))
                .unwrap_or_default();
            let filter_local_cwd = normalized.as_os_str() != default_local.as_os_str();
            (resolve_process_path(&value, cwd), true, filter_local_cwd)
        }
        None => (process_session_root(home), false, false),
    }
}

pub(crate) fn resolve_process_path(value: &str, cwd: Option<&Path>) -> PathBuf {
    let path = normalize_pi_path_input(value);
    if path.is_absolute() {
        path
    } else if let Some(cwd) = cwd {
        cwd.join(path)
    } else {
        path
    }
}

pub(crate) fn encode_cwd(cwd: &str) -> String {
    let without_leading_separator = cwd
        .strip_prefix('/')
        .or_else(|| cwd.strip_prefix('\\'))
        .unwrap_or(cwd);
    format!(
        "--{}--",
        without_leading_separator.replace(['/', '\\', ':'], "-")
    )
}

pub(crate) fn valid_session_id(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !first.is_ascii_alphanumeric() {
        return false;
    }
    let mut last = first;
    for ch in chars {
        if !(ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-')) {
            return false;
        }
        last = ch;
    }
    last.is_ascii_alphanumeric()
}

fn looks_like_file_timestamp(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 24
        && bytes.iter().enumerate().all(|(index, byte)| {
            let separator = match index {
                4 | 7 | 13 | 16 | 19 => Some(b'-'),
                10 => Some(b'T'),
                23 => Some(b'Z'),
                _ => None,
            };
            separator
                .map(|expected| *byte == expected)
                .unwrap_or_else(|| byte.is_ascii_digit())
        })
}

pub(crate) fn session_id_from_file_stem(stem: &str) -> Option<String> {
    let (timestamp, session_id) = stem.split_once('_')?;
    (looks_like_file_timestamp(timestamp) && valid_session_id(session_id))
        .then(|| session_id.to_string())
}

pub(crate) const MAX_SESSION_HEADER_SCAN_BYTES: usize = 1024 * 1024;

pub(crate) fn read_session_header(path: &Path) -> Option<(String, PathBuf)> {
    let file = std::fs::File::open(path).ok()?;
    let mut reader = BufReader::new(file).take((MAX_SESSION_HEADER_SCAN_BYTES + 1) as u64);
    let mut scanned_bytes = 0usize;
    loop {
        let mut physical_line = Vec::new();
        let bytes_read = reader.read_until(b'\n', &mut physical_line).ok()?;
        if bytes_read == 0 {
            return None;
        }
        scanned_bytes = scanned_bytes.saturating_add(bytes_read);
        if scanned_bytes > MAX_SESSION_HEADER_SCAN_BYTES {
            return None;
        }
        let Ok(header) = serde_json::from_slice::<Value>(&physical_line) else {
            continue;
        };
        if header.get("type").and_then(Value::as_str) != Some("session") {
            return None;
        }
        let session_id = header
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| valid_session_id(id))?
            .to_string();
        let cwd = header
            .get("cwd")
            .and_then(Value::as_str)
            .filter(|cwd| !cwd.is_empty())?;
        return Some((session_id, PathBuf::from(cwd)));
    }
}

pub(crate) fn session_id_from_file(path: &Path) -> Option<String> {
    read_session_header(path)
        .map(|(session_id, _)| session_id)
        .or_else(|| {
            path.file_stem()
                .and_then(|value| value.to_str())
                .and_then(session_id_from_file_stem)
        })
}

pub(crate) fn project_path_from_file(path: &Path, fallback: Option<&Path>) -> Option<PathBuf> {
    read_session_header(path)
        .map(|(_, cwd)| resolve_process_path(&cwd.to_string_lossy(), fallback))
        .or_else(|| fallback.map(Path::to_path_buf))
}

#[derive(Debug, Clone)]
pub(crate) struct SessionFileInfo {
    pub session_id: String,
    pub project_path: String,
    pub file_path: PathBuf,
    pub file_mtime_ms: i64,
    pub logical_modified_ms: i64,
}

fn file_mtime_ms(path: &Path) -> Option<i64> {
    let modified = std::fs::metadata(path).ok()?.modified().ok()?;
    Some(match modified.duration_since(std::time::UNIX_EPOCH) {
        Ok(elapsed) => elapsed.as_millis().min(i64::MAX as u128) as i64,
        Err(error) => -(error.duration().as_millis().min(i64::MAX as u128) as i64),
    })
}

fn iso_timestamp_ms(value: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|timestamp| timestamp.timestamp_millis())
}

fn json_timestamp_ms(value: &Value) -> Option<i64> {
    let value = value.as_f64()?;
    value
        .is_finite()
        .then(|| value.clamp(i64::MIN as f64, i64::MAX as f64) as i64)
}

/// Read the identity and logical message activity used by Pi's session list.
pub(crate) fn read_session_info(path: &Path) -> Option<SessionFileInfo> {
    let file_mtime_ms = file_mtime_ms(path)?;
    let file = std::fs::File::open(path).ok()?;
    let mut reader = BufReader::new(file);
    let mut session_id = None;
    let mut project_path = String::new();
    let mut header_timestamp_ms = None;
    let mut last_activity_ms: Option<i64> = None;

    loop {
        let mut physical_line = Vec::new();
        if reader.read_until(b'\n', &mut physical_line).ok()? == 0 {
            break;
        }
        let Ok(entry) = serde_json::from_slice::<Value>(&physical_line) else {
            continue;
        };
        if session_id.is_none() {
            if entry.get("type").and_then(Value::as_str) != Some("session") {
                return None;
            }
            session_id = Some(
                entry
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|id| valid_session_id(id))?
                    .to_string(),
            );
            project_path = entry
                .get("cwd")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            header_timestamp_ms = entry
                .get("timestamp")
                .and_then(Value::as_str)
                .and_then(iso_timestamp_ms);
            continue;
        }
        if entry.get("type").and_then(Value::as_str) != Some("message") {
            continue;
        }
        let Some(message) = entry.get("message").and_then(Value::as_object) else {
            continue;
        };
        if !matches!(
            message.get("role").and_then(Value::as_str),
            Some("user" | "assistant")
        ) || !message.contains_key("content")
        {
            continue;
        }
        let activity_ms = message
            .get("timestamp")
            .and_then(json_timestamp_ms)
            .or_else(|| {
                entry
                    .get("timestamp")
                    .and_then(Value::as_str)
                    .and_then(iso_timestamp_ms)
            });
        if let Some(activity_ms) = activity_ms {
            last_activity_ms = Some(last_activity_ms.unwrap_or(0).max(activity_ms));
        }
    }

    Some(SessionFileInfo {
        session_id: session_id?,
        project_path,
        file_path: path.to_path_buf(),
        file_mtime_ms,
        logical_modified_ms: last_activity_ms
            .filter(|timestamp| *timestamp > 0)
            .or(header_timestamp_ms)
            .unwrap_or(file_mtime_ms),
    })
}

pub(crate) fn direct_session_infos(dir: &Path) -> Vec<SessionFileInfo> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("jsonl"))
        .filter_map(|path| read_session_info(&path))
        .collect()
}

pub(crate) fn direct_recent_session_infos(dir: &Path) -> Vec<SessionFileInfo> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("jsonl"))
        .filter_map(|file_path| {
            let file_mtime_ms = file_mtime_ms(&file_path)?;
            let (session_id, project_path) = read_session_header(&file_path)?;
            Some(SessionFileInfo {
                session_id,
                project_path: project_path.to_string_lossy().to_string(),
                file_path,
                file_mtime_ms,
                logical_modified_ms: file_mtime_ms,
            })
        })
        .collect()
}

pub(crate) fn sort_sessions(sessions: &mut [SessionFileInfo]) {
    sessions.sort_by(|left, right| {
        right
            .logical_modified_ms
            .cmp(&left.logical_modified_ms)
            .then_with(|| left.file_path.cmp(&right.file_path))
    });
}

pub(crate) fn resolve_path_lexically(input: &str, base: &Path) -> PathBuf {
    let expanded = pi_node_compatible_path(&normalize_pi_path_input(input));
    let base = pi_node_compatible_path(base);
    let absolute = if expanded.is_absolute() {
        expanded
    } else {
        base.join(expanded)
    };
    let mut normalized = PathBuf::new();
    for component in absolute.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                normalized.pop();
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    normalized
}

pub(crate) fn session_cwd_matches(session_cwd: &str, launch_project: &Path) -> bool {
    if session_cwd.is_empty() {
        return false;
    }
    let session_path = resolve_path_lexically(session_cwd, launch_project);
    let launch_path = resolve_path_lexically(&launch_project.to_string_lossy(), launch_project);
    if session_path == launch_path {
        return true;
    }
    match (
        std::fs::canonicalize(&session_path),
        std::fs::canonicalize(&launch_path),
    ) {
        (Ok(session), Ok(launch)) => {
            pi_node_compatible_path(&session) == pi_node_compatible_path(&launch)
        }
        _ => false,
    }
}

pub(crate) fn exact_or_prefix<'a>(
    sessions: &'a [SessionFileInfo],
    selector: &str,
) -> Option<&'a SessionFileInfo> {
    sessions
        .iter()
        .find(|session| session.session_id == selector)
        .or_else(|| {
            sessions
                .iter()
                .find(|session| session.session_id.starts_with(selector))
        })
}

pub(crate) fn process_sessions(
    root: &Path,
    cwd: Option<&Path>,
    root_is_custom: bool,
    filter_local_cwd: bool,
) -> Vec<SessionFileInfo> {
    let Some(cwd) = cwd else {
        return Vec::new();
    };
    let mut sessions = if root_is_custom {
        direct_session_infos(root)
    } else {
        direct_session_infos(&root.join(encode_cwd(&cwd.to_string_lossy())))
    };
    if root_is_custom && filter_local_cwd {
        sessions.retain(|session| session_cwd_matches(&session.project_path, cwd));
    }
    sort_sessions(&mut sessions);
    sessions
}

pub(crate) fn find_process_session(
    root: &Path,
    cwd: Option<&Path>,
    root_is_custom: bool,
    filter_local_cwd: bool,
    selector: &str,
    allow_prefix: bool,
) -> Option<SessionFileInfo> {
    let sessions = process_sessions(root, cwd, root_is_custom, filter_local_cwd);
    let index = sessions.iter().position(|session| {
        session.session_id == selector || (allow_prefix && session.session_id.starts_with(selector))
    })?;
    sessions.into_iter().nth(index)
}

pub(crate) fn most_recent_for_cwd(dir: &Path, cwd: &Path) -> Option<(PathBuf, u64)> {
    direct_recent_session_infos(dir)
        .into_iter()
        .filter(|session| session_cwd_matches(&session.project_path, cwd))
        .max_by_key(|session| session.file_mtime_ms)
        .map(|session| (session.file_path, session.file_mtime_ms.max(0) as u64))
}

fn session_id_from_filename(path: &Path) -> String {
    let stem = basename_no_ext(path);
    if let Some((timestamp, id)) = stem.split_once('_') {
        let bytes = timestamp.as_bytes();
        let valid_timestamp = bytes.len() == 24
            && bytes.iter().enumerate().all(|(index, byte)| {
                let separator = match index {
                    4 | 7 | 13 | 16 | 19 => Some(b'-'),
                    10 => Some(b'T'),
                    23 => Some(b'Z'),
                    _ => None,
                };
                separator
                    .map(|expected| *byte == expected)
                    .unwrap_or_else(|| byte.is_ascii_digit())
            });
        if valid_timestamp && !id.is_empty() {
            return id.to_string();
        }
    }
    stem
}

fn usage_from_object(obj: &serde_json::Map<String, Value>) -> Option<TokenUsage> {
    if !["input", "output", "cacheRead", "cacheWrite", "totalTokens"]
        .iter()
        .any(|key| obj.contains_key(*key))
    {
        return None;
    }
    let input = as_usize_field(obj, "input");
    let output = as_usize_field(obj, "output");
    let cache_read = as_usize_field(obj, "cacheRead");
    let cache_write = as_usize_field(obj, "cacheWrite");
    let cache = (cache_read.is_some() || cache_write.is_some())
        .then(|| cache_read.unwrap_or(0) + cache_write.unwrap_or(0));
    let total = if input.is_some() || output.is_some() {
        Some(input.unwrap_or(0) + output.unwrap_or(0))
    } else {
        as_usize_field(obj, "totalTokens")
    };
    Some(TokenUsage {
        input_tokens: input,
        output_tokens: output,
        total_tokens: total,
        cache_tokens: cache,
    })
}

fn message_text(message: &serde_json::Map<String, Value>) -> String {
    match message.get("content") {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(Value::as_object)
            .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join(" "),
        _ => String::new(),
    }
}

fn entry_usage(entry: &JsonlEntry) -> Option<TokenUsage> {
    let record = entry.as_record()?;
    let usage = record
        .get("message")
        .and_then(Value::as_object)
        .and_then(|message| message.get("usage"))
        .and_then(Value::as_object)
        .or_else(|| record.get("usage").and_then(Value::as_object))?;
    usage_from_object(usage)
}

pub fn extract_session(entries: &[JsonlEntry], file_path: &Path, modified_at: &str) -> SessionMeta {
    let mut session_id = String::new();
    let mut model = String::new();
    let mut project_path = String::new();
    let mut first_prompt = String::new();
    let mut custom_title = None;
    let mut created_at = String::new();
    let mut token_usage = TokenUsage {
        input_tokens: None,
        output_tokens: None,
        total_tokens: None,
        cache_tokens: None,
    };
    let mut has_token_usage = false;

    for entry in entries {
        let Some(record) = entry.as_record() else {
            continue;
        };
        match entry.type_str() {
            Some("session") => {
                if session_id.is_empty() {
                    session_id = record
                        .get("id")
                        .and_then(Value::as_str)
                        .filter(|id| !id.is_empty())
                        .unwrap_or_default()
                        .to_string();
                }
                if project_path.is_empty() {
                    project_path = record
                        .get("cwd")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                }
                if created_at.is_empty() {
                    created_at = record
                        .get("timestamp")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                }
            }
            Some("session_info") => match record.get("name") {
                Some(Value::String(name)) => {
                    let name = name.trim();
                    custom_title = (!name.is_empty()).then(|| name.to_string());
                }
                Some(Value::Null) | None => custom_title = None,
                _ => {}
            },
            Some("model_change") => {
                if let Some(candidate) = record.get("modelId").and_then(Value::as_str) {
                    if !candidate.is_empty()
                        && !candidate.starts_with('<')
                        && candidate != "synthetic"
                    {
                        model = candidate.to_string();
                    }
                }
            }
            Some("message") => {
                if let Some(message) = record.get("message").and_then(Value::as_object) {
                    let role = message.get("role").and_then(Value::as_str);
                    if role == Some("user") && first_prompt.is_empty() {
                        first_prompt = message_text(message);
                    }
                    if role == Some("assistant") {
                        if let Some(candidate) = message.get("model").and_then(Value::as_str) {
                            if !candidate.is_empty()
                                && !candidate.starts_with('<')
                                && candidate != "synthetic"
                            {
                                model = candidate.to_string();
                            }
                        }
                    }
                }
            }
            _ => {}
        }
        if let Some(usage) = entry_usage(entry) {
            add_token_usage(&mut token_usage, &usage);
            has_token_usage = true;
        }
    }

    if session_id.is_empty() {
        session_id = session_id_from_filename(file_path);
    }
    if created_at.is_empty() {
        created_at = modified_at.to_string();
    }
    SessionMeta {
        session_id,
        provider: "pi".into(),
        model,
        project_path,
        first_prompt: first_prompt.chars().take(200).collect(),
        custom_title,
        file_path: file_path.to_string_lossy().to_string(),
        created_at,
        modified_at: modified_at.to_string(),
        token_usage: has_token_usage.then_some(token_usage),
    }
}
