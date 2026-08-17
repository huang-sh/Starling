//! /proc-based PID → session resolver (Linux-only; no-op elsewhere).
//! Mirrors src/lib/processMap.ts.

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::Value;

use crate::constants::{expand_home, normalize_pi_path_input};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Claude,
    Codex,
    Pi,
}

#[derive(Debug, Clone, Default)]
pub struct MappedSession {
    pub pid: u32,
    pub provider: Option<Provider>,
    pub project_path: Option<String>,
    pub file_path: Option<String>,
    pub session_id: Option<String>,
    pub home: Option<String>,
    pub confidence: u8,
}

#[derive(Debug, Clone)]
pub struct ProcStat {
    pub pid: u32,
    pub comm: String,
    pub state: String,
    pub ppid: u32,
    pub utime: u64,
    pub stime: u64,
    pub starttime: u64,
}

pub fn parse_proc_environ(raw: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for chunk in raw.split('\0') {
        if chunk.is_empty() {
            continue;
        }
        if let Some(eq) = chunk.find('=') {
            if eq == 0 {
                continue;
            }
            out.insert(chunk[..eq].to_string(), chunk[eq + 1..].to_string());
        }
    }
    out
}

pub fn parse_proc_stat(raw: &str) -> Option<ProcStat> {
    let open = raw.find('(')?;
    let close = raw.rfind(')')?;
    if close <= open {
        return None;
    }
    let pid: u32 = raw[..open].trim().parse().ok()?;
    let comm = raw[open + 1..close].to_string();
    let rest: Vec<&str> = raw[close + 1..].split_whitespace().collect();
    let num = |i: usize| -> u64 { rest.get(i).and_then(|s| s.parse().ok()).unwrap_or(0) };
    Some(ProcStat {
        pid,
        comm,
        state: rest.first().map(|s| s.to_string()).unwrap_or_default(),
        ppid: num(1) as u32,
        utime: num(11),
        stime: num(12),
        starttime: num(19),
    })
}

const AGENT_COMM_PREFIXES: &[&str] = &[
    "claude", "codex", "node", "npm", "npx", "bash", "sh", "deno", "bun",
];

pub fn comm_might_be_agent(comm: &str) -> bool {
    if comm.is_empty() {
        return false;
    }
    // Keep Pi exact: a prefix match would incorrectly classify common
    // processes such as `pip`, `pipewire`, and `picom` as agent candidates.
    if comm == "pi" {
        return true;
    }
    AGENT_COMM_PREFIXES
        .iter()
        .any(|p| comm == *p || comm.starts_with(p))
}

fn is_pi_cli_script(arg: &str) -> bool {
    let normalized = arg.replace('\\', "/").to_ascii_lowercase();
    normalized.ends_with("/pi.js")
        || normalized.contains("/pi-coding-agent/dist/cli.js")
        || normalized.ends_with("/packages/coding-agent/dist/cli.js")
        || normalized.ends_with("/packages/coding-agent/src/cli.ts")
}

fn basename_lower(arg: &str) -> String {
    Path::new(arg)
        .file_name()
        .map(|value| value.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default()
}

fn is_javascript_runtime(arg: &str) -> bool {
    matches!(
        basename_lower(arg).trim_end_matches(".exe"),
        "node" | "nodejs" | "bun" | "deno"
    )
}

/// Inspect a process's cmdline vector and return which provider it launched,
/// if any. Matches the TS heuristic exactly: first 4 args by basename, then
/// any arg by path suffix.
pub fn provider_from_cmdline(args: &[String]) -> Option<Provider> {
    let executable = args.first().map(|arg| basename_lower(arg))?;
    match executable.trim_end_matches(".exe") {
        "claude" | "claude-code" => return Some(Provider::Claude),
        "codex" => return Some(Provider::Codex),
        "pi" => return Some(Provider::Pi),
        // `starling run/chat pi` replaces the child's argv with the starling
        // binary; the process is still a Pi runtime host (its environ carries
        // STARLING_PI_HOOK_FILE / STARLING_SESSION_ID for managed runs).
        "starling" => return Some(Provider::Pi),
        _ => {}
    }

    // npm's `pi` executable is a symlink with a Node shebang, so Linux exposes
    // it as `node /path/to/bin/pi ...` in /proc/<pid>/cmdline. Inspect the
    // runtime's script position before scanning later arguments: prompts such
    // as `codex` or `claude` must not override the real Pi executable.
    if is_javascript_runtime(&args[0]) {
        if let Some(script) = args.get(1) {
            if basename_lower(script).trim_end_matches(".cmd") == "pi" || is_pi_cli_script(script) {
                return Some(Provider::Pi);
            }
        }
    }

    for (index, arg) in args.iter().take(4).enumerate() {
        let base = basename_lower(arg);
        if base == "claude" || base == "claude-code" {
            return Some(Provider::Claude);
        }
        if base == "codex" {
            return Some(Provider::Codex);
        }
        // A bare `pi` argument later in the command line may be ordinary user
        // input. Only treat it as the binary when it is argv[0]. Node/Bun
        // installations are recognized from their CLI script path below.
        if index == 0 && base == "pi" {
            return Some(Provider::Pi);
        }
    }
    for arg in args {
        let lower = arg.to_lowercase();
        if lower.ends_with("/claude")
            || lower.contains("/claude.js")
            || lower.ends_with("/claude-code")
        {
            return Some(Provider::Claude);
        }
        if lower.ends_with("/codex") || lower.contains("/codex.js") {
            return Some(Provider::Codex);
        }
        if is_pi_cli_script(arg) {
            return Some(Provider::Pi);
        }
    }
    None
}

/// Extract `--resume <uuid>` from cmdline args. Matches the TS regex
/// `/\bresume\s+([uuid])\b/i`, which captures `resume` at any word boundary
/// (e.g. inside `--resume` or `-r resume`).
pub fn extract_resume_uuid(args: &[String]) -> Option<String> {
    let joined = args.join(" ");
    let tokens: Vec<&str> = joined.split_whitespace().collect();
    for (i, tok) in tokens.iter().enumerate() {
        // Match `\bresume` — strip leading non-alphanumeric to find the word.
        let lower = tok.to_lowercase();
        let word_starts_at = lower.find("resume");
        let is_resume_token = match word_starts_at {
            Some(idx) => {
                // The char before `resume` must be a non-word char (or start).
                idx == 0 || {
                    let prev = lower.as_bytes().get(idx - 1).copied().unwrap_or(b'_');
                    !char::from(prev).is_ascii_alphanumeric()
                }
            }
            None => false,
        };
        if is_resume_token {
            if let Some(next) = tokens.get(i + 1) {
                if looks_like_uuid(next) {
                    return Some(next.to_lowercase());
                }
            }
        }
    }
    None
}

fn looks_like_uuid(s: &str) -> bool {
    // 8-4-4-4-12 hex
    let parts: Vec<&str> = s.split('-').collect();
    if parts.len() != 5 {
        return false;
    }
    let lens = [8usize, 4, 4, 4, 12];
    parts
        .iter()
        .zip(lens.iter())
        .all(|(p, &expected)| p.len() == expected && p.chars().all(|c| c.is_ascii_hexdigit()))
}

pub fn resolve_agent_home(provider: Provider, environ: &HashMap<String, String>) -> PathBuf {
    match provider {
        Provider::Claude => {
            if let Some(v) = environ
                .get("CLAUDE_CONFIG_DIR")
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
            {
                expand_home(v)
            } else {
                dirs::home_dir().unwrap_or_default().join(".claude")
            }
        }
        Provider::Codex => {
            if let Some(v) = environ
                .get("CODEX_HOME")
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
            {
                expand_home(v)
            } else {
                dirs::home_dir().unwrap_or_default().join(".codex")
            }
        }
        Provider::Pi => {
            if let Some(v) = environ.get("PI_CODING_AGENT_DIR").filter(|s| !s.is_empty()) {
                normalize_pi_path_input(v)
            } else {
                dirs::home_dir()
                    .unwrap_or_default()
                    .join(".pi")
                    .join("agent")
            }
        }
    }
}

pub fn session_root_for_home(provider: Provider, home: &Path) -> PathBuf {
    match provider {
        Provider::Claude => home.join("projects"),
        Provider::Codex => home.join("sessions"),
        Provider::Pi => home.join("sessions"),
    }
}

fn resolve_process_path(value: &str, cwd: Option<&Path>) -> PathBuf {
    let path = expand_home(value.trim());
    if path.is_absolute() {
        path
    } else if let Some(cwd) = cwd {
        cwd.join(path)
    } else {
        path
    }
}

fn resolve_pi_process_path(value: &str, cwd: Option<&Path>) -> PathBuf {
    let path = normalize_pi_path_input(value);
    if path.is_absolute() {
        path
    } else if let Some(cwd) = cwd {
        cwd.join(path)
    } else {
        path
    }
}

#[derive(Debug, Default)]
struct PiProcessArgs<'a> {
    session: Option<&'a str>,
    session_id: Option<&'a str>,
    session_dir: Option<&'a str>,
}

/// Mirror Pi's argv token ownership for the session fields process mapping
/// needs. Native value options consume the next token even when it looks like
/// a different flag; unknown and optional options use Pi's selective rules.
fn parse_pi_process_args(args: &[String]) -> PiProcessArgs<'_> {
    let mut parsed = PiProcessArgs::default();
    let mut index = 0;
    while index < args.len() {
        let arg = args[index].as_str();
        if pi_process_required_value_arg(arg) {
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
            _ if pi_process_native_boolean_arg(arg) => false,
            _ if arg.starts_with("--") && !arg.contains('=') => next
                .map(|value| !value.starts_with('-') && !value.starts_with('@'))
                .unwrap_or(false),
            _ => false,
        };
        index += 1 + usize::from(consumes_optional_value);
    }
    parsed
}

fn pi_process_required_value_arg(arg: &str) -> bool {
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

fn pi_process_native_boolean_arg(arg: &str) -> bool {
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

fn extract_pi_session_dir(args: &[String]) -> Option<&str> {
    parse_pi_process_args(args)
        .session_dir
        .filter(|value| !value.is_empty())
}

fn read_pi_session_dir_setting(path: &Path) -> Option<Option<String>> {
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

fn configured_pi_session_dir(home: &Path, cwd: Option<&Path>) -> Option<String> {
    let project = cwd.and_then(|cwd| read_pi_session_dir_setting(&cwd.join(".pi/settings.json")));
    if let Some(project) = project {
        return project;
    }
    read_pi_session_dir_setting(&home.join("settings.json")).flatten()
}

fn resolve_session_root(
    provider: Provider,
    home: &Path,
    environ: &HashMap<String, String>,
    args: &[String],
    cwd: Option<&Path>,
) -> (PathBuf, bool, bool) {
    if provider != Provider::Pi {
        return (session_root_for_home(provider, home), false, false);
    }

    let configured = extract_pi_session_dir(args)
        .map(str::to_string)
        .or_else(|| {
            environ
                .get("PI_CODING_AGENT_SESSION_DIR")
                .filter(|value| !value.is_empty())
                .cloned()
        })
        .or_else(|| configured_pi_session_dir(home, cwd));
    match configured {
        Some(value) => {
            let normalized_configured = normalize_pi_path_input(&value);
            let default_local_dir = cwd
                .map(|cwd| {
                    session_root_for_home(provider, home)
                        .join(encode_pi_cwd(&cwd.to_string_lossy()))
                })
                .unwrap_or_default();
            let filter_local_cwd =
                normalized_configured.as_os_str() != default_local_dir.as_os_str();
            (resolve_pi_process_path(&value, cwd), true, filter_local_cwd)
        }
        None => (session_root_for_home(provider, home), false, false),
    }
}

/// Claude encodes cwd as `-a-b-c` for `/a/b/c`.
pub fn encode_claude_cwd(cwd: &str) -> String {
    // Claude Code replaces path separators (and Windows drive colons) with
    // dashes without collapsing runs: "/home/u" → "-home-u",
    // "C:\Users\me" → "C--Users-me".
    cwd.replace(['/', '\\', ':'], "-")
}

/// Pi encodes a resolved cwd as `--a-b-c--` for `/a/b/c`.
pub fn encode_pi_cwd(cwd: &str) -> String {
    let without_leading_separator = cwd
        .strip_prefix('/')
        .or_else(|| cwd.strip_prefix('\\'))
        .unwrap_or(cwd);
    let safe = without_leading_separator.replace(['/', '\\', ':'], "-");
    format!("--{safe}--")
}

fn valid_pi_session_id(value: &str) -> bool {
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

fn looks_like_pi_file_timestamp(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 24 {
        return false;
    }
    for (index, byte) in bytes.iter().enumerate() {
        let expected = match index {
            4 | 7 | 13 | 16 | 19 => Some(b'-'),
            10 => Some(b'T'),
            23 => Some(b'Z'),
            _ => None,
        };
        if let Some(expected) = expected {
            if *byte != expected {
                return false;
            }
        } else if !byte.is_ascii_digit() {
            return false;
        }
    }
    true
}

fn pi_session_id_from_file_stem(stem: &str) -> Option<String> {
    let (timestamp, session_id) = stem.split_once('_')?;
    if !looks_like_pi_file_timestamp(timestamp) || !valid_pi_session_id(session_id) {
        return None;
    }
    Some(session_id.to_string())
}

const PI_MAX_SESSION_HEADER_SCAN_BYTES: usize = 1024 * 1024;

fn read_pi_session_header(path: &Path) -> Option<(String, PathBuf)> {
    let file = std::fs::File::open(path).ok()?;
    let mut reader = BufReader::new(file).take((PI_MAX_SESSION_HEADER_SCAN_BYTES + 1) as u64);
    let mut scanned_bytes = 0usize;
    loop {
        let mut physical_line = Vec::new();
        let bytes_read = reader.read_until(b'\n', &mut physical_line).ok()?;
        if bytes_read == 0 {
            return None;
        }
        scanned_bytes = scanned_bytes.saturating_add(bytes_read);
        if scanned_bytes > PI_MAX_SESSION_HEADER_SCAN_BYTES {
            return None;
        }
        let line = String::from_utf8_lossy(&physical_line);
        let Ok(header) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        if header.get("type").and_then(Value::as_str) != Some("session") {
            return None;
        }
        let session_id = header
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| valid_pi_session_id(id))?
            .to_string();
        let cwd = header.get("cwd").and_then(Value::as_str)?;
        if cwd.is_empty() {
            return None;
        }
        return Some((session_id, PathBuf::from(cwd)));
    }
}

fn pi_session_id_from_file(path: &Path) -> Option<String> {
    if let Some((session_id, _)) = read_pi_session_header(path) {
        return Some(session_id);
    }
    if let Some(stem) = path.file_stem().and_then(|value| value.to_str()) {
        if let Some(session_id) = pi_session_id_from_file_stem(stem) {
            return Some(session_id);
        }
    }
    None
}

fn pi_project_path_from_file(path: &Path, fallback: Option<&Path>) -> Option<PathBuf> {
    read_pi_session_header(path)
        .map(|(_, cwd)| resolve_pi_process_path(&cwd.to_string_lossy(), fallback))
        .or_else(|| fallback.map(Path::to_path_buf))
}

pub fn extract_session_id_from_path(file_path: &str) -> Option<String> {
    let name = Path::new(file_path)
        .file_stem()?
        .to_string_lossy()
        .to_string();
    if let Some(session_id) = pi_session_id_from_file_stem(&name) {
        return Some(session_id);
    }
    // Bare UUID match
    let parts: Vec<&str> = name.split('-').collect();
    if parts.len() == 5 {
        let lens = [8usize, 4, 4, 4, 12];
        if parts
            .iter()
            .zip(lens.iter())
            .all(|(p, &expected)| p.len() == expected && p.chars().all(|c| c.is_ascii_hexdigit()))
        {
            return Some(parts.join("-").to_lowercase());
        }
    }
    Some(name.to_lowercase())
}

/// True if the basename is a Claude UUID, Codex `rollout-...`, or Pi
/// `<timestamp>_<session-id>` transcript.
pub fn is_session_file_path(file_path: &str) -> bool {
    let name = match Path::new(file_path).file_name() {
        Some(n) => n.to_string_lossy().to_string(),
        None => return false,
    };
    let lower = name.to_lowercase();
    if !lower.ends_with(".jsonl") {
        return false;
    }
    let original_stem = &name[..name.len() - ".jsonl".len()];
    if pi_session_id_from_file_stem(original_stem).is_some() {
        return true;
    }
    let stem = &lower[..lower.len() - ".jsonl".len()];
    // Bare UUID
    let parts: Vec<&str> = stem.split('-').collect();
    if parts.len() == 5 {
        let lens = [8usize, 4, 4, 4, 12];
        if parts
            .iter()
            .zip(lens.iter())
            .all(|(p, &expected)| p.len() == expected && p.chars().all(|c| c.is_ascii_hexdigit()))
        {
            return true;
        }
    }
    stem.starts_with("rollout-")
}

// --- /proc readers (Linux only) ---

fn is_linux() -> bool {
    cfg!(target_os = "linux")
}

fn read_cmdline(pid: u32) -> Option<Vec<String>> {
    if !is_linux() {
        return None;
    }
    let raw = std::fs::read(format!("/proc/{pid}/cmdline")).ok()?;
    Some(
        raw.split(|b| *b == 0)
            .filter(|s| !s.is_empty())
            .map(|s| String::from_utf8_lossy(s).to_string())
            .collect(),
    )
}

fn read_environ(pid: u32) -> HashMap<String, String> {
    if !is_linux() {
        return HashMap::new();
    }
    let raw = match std::fs::read(format!("/proc/{pid}/environ")) {
        Ok(r) => r,
        Err(_) => return HashMap::new(),
    };
    let s = String::from_utf8_lossy(&raw);
    parse_proc_environ(&s)
}

fn read_cwd(pid: u32) -> Option<PathBuf> {
    if !is_linux() {
        return None;
    }
    std::fs::read_link(format!("/proc/{pid}/cwd")).ok()
}

#[cfg(target_os = "linux")]
fn read_fd_link(pid: u32, fd: u32) -> Option<PathBuf> {
    std::fs::read_link(format!("/proc/{pid}/fd/{fd}")).ok()
}

#[cfg(not(target_os = "linux"))]
fn read_fd_link(_pid: u32, _fd: u32) -> Option<PathBuf> {
    None
}

pub fn is_claude_background_task_process(pid: u32) -> bool {
    let Some(stdin) = read_fd_link(pid, 0) else {
        return false;
    };
    let Some(stdout) = read_fd_link(pid, 1) else {
        return false;
    };
    stdin == Path::new("/dev/null")
        && stdout.to_string_lossy().contains("/tasks/")
        && stdout.extension().and_then(|e| e.to_str()) == Some("output")
}

fn read_open_jsonl_files(pid: u32) -> Vec<PathBuf> {
    if !is_linux() {
        return vec![];
    }
    let mut out = Vec::new();
    let fd_dir = match std::fs::read_dir(format!("/proc/{pid}/fd")) {
        Ok(d) => d,
        Err(_) => return vec![],
    };
    for entry in fd_dir.flatten() {
        if let Ok(link) = std::fs::read_link(entry.path()) {
            if link.extension().and_then(|e| e.to_str()) == Some("jsonl") {
                out.push(link);
            }
        }
    }
    out
}

pub fn is_pid_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    is_pid_alive_platform(pid)
}

pub fn is_pid_runnable(pid: u32) -> bool {
    if !is_pid_alive(pid) {
        return false;
    }
    is_pid_runnable_platform(pid)
}

#[cfg(target_os = "linux")]
fn is_pid_alive_platform(pid: u32) -> bool {
    // kill(pid, 0) returns 0 if process exists, ESRCH if not, EPERM if exists
    // but not ours.
    let rc = unsafe { libc::kill(pid as i32, 0) };
    if rc == 0 {
        return true;
    }
    let errno = unsafe { *libc::__errno_location() };
    // EPERM = 1
    errno == 1
}

#[cfg(all(unix, not(target_os = "linux")))]
fn is_pid_alive_platform(pid: u32) -> bool {
    let rc = unsafe { libc::kill(pid as i32, 0) };
    if rc == 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(windows)]
fn is_pid_alive_platform(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, STILL_ACTIVE, ERROR_ACCESS_DENIED, ERROR_INVALID_PARAMETER,
    };
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    // OpenProcess returns null for a dead pid. A live system pid we cannot
    // open (e.g. services) still proves liveness via ERROR_ACCESS_DENIED, so
    // only ERROR_INVALID_PARAMETER (which also covers stale pids) counts as
    // dead. PIDs are reused on Windows, but every caller treats liveness as a
    // best-effort heuristic.
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if !handle.is_null() {
        // A handle can still be granted for an exited-but-unreaped process
        // (job objects, conhost, WMI keep references). Treat anything with a
        // completed exit code as dead; STILL_ACTIVE(259) collision is the
        // known ceiling of this heuristic.
        let mut exit_code: u32 = 0;
        let got_code = unsafe { GetExitCodeProcess(handle, &mut exit_code) };
        unsafe { CloseHandle(handle) };
        return got_code == 0 || exit_code == STILL_ACTIVE as u32;
    }
    let err = unsafe { GetLastError() };
    err == ERROR_ACCESS_DENIED
}

#[cfg(all(not(unix), not(windows)))]
fn is_pid_alive_platform(_pid: u32) -> bool {
    false
}

#[cfg(target_os = "linux")]
fn is_pid_runnable_platform(pid: u32) -> bool {
    let raw = match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
        Ok(raw) => raw,
        Err(_) => return false,
    };
    let Some(stat) = parse_proc_stat(&raw) else {
        return false;
    };
    !matches!(stat.state.as_str(), "T" | "t" | "Z" | "X" | "x")
}

#[cfg(all(unix, not(target_os = "linux")))]
fn is_pid_runnable_platform(pid: u32) -> bool {
    is_pid_alive(pid)
}

#[cfg(not(unix))]
fn is_pid_runnable_platform(_pid: u32) -> bool {
    false
}

/// ppid → children[] index over /proc.
pub fn build_child_map() -> HashMap<u32, Vec<u32>> {
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    if !is_linux() {
        return children;
    }
    let rd = match std::fs::read_dir("/proc") {
        Ok(r) => r,
        Err(_) => return children,
    };
    for entry in rd.flatten() {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        let pid: u32 = match name_str
            .chars()
            .all(|c| c.is_ascii_digit())
            .then(|| name_str.parse().ok())
            .flatten()
        {
            Some(p) => p,
            None => continue,
        };
        let stat_raw = match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let stat = match parse_proc_stat(&stat_raw) {
            Some(s) => s,
            None => continue,
        };
        children.entry(stat.ppid).or_default().push(stat.pid);
    }
    children
}

#[derive(Default)]
pub struct ResolverCache {
    pub root_dirs: HashMap<PathBuf, Vec<String>>,
    pub recent_jsonl: HashMap<PathBuf, Option<(PathBuf, u64)>>,
    pub recent_jsonl_flat: HashMap<PathBuf, Option<(PathBuf, u64)>>,
    pub recent_pi_jsonl_by_cwd: HashMap<(PathBuf, PathBuf), Option<(PathBuf, u64)>>,
    pub file_index: HashMap<PathBuf, Option<HashMap<String, PathBuf>>>,
    /// Session index parsed once per process scan (outer Option = not yet
    /// loaded, inner = index present). Stops `find_session_file_by_id`'s
    /// fast path from re-parsing the whole index JSON per call.
    pub session_index: Option<Option<crate::core::session_index::SessionIndex>>,
}

/// Walk /proc once and produce (agent candidates, child map).
pub struct ProcScan {
    pub agents: Vec<(u32, Provider, Vec<String>)>,
    pub child_map: HashMap<u32, Vec<u32>>,
}

pub fn scan_proc_once() -> ProcScan {
    let mut agents: Vec<(u32, Provider, Vec<String>)> = Vec::new();
    let mut child_map: HashMap<u32, Vec<u32>> = HashMap::new();
    if !is_linux() {
        return ProcScan { agents, child_map };
    }
    let rd = match std::fs::read_dir("/proc") {
        Ok(r) => r,
        Err(_) => return ProcScan { agents, child_map },
    };
    for entry in rd.flatten() {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        let pid: u32 = match name_str
            .chars()
            .all(|c| c.is_ascii_digit())
            .then(|| name_str.parse().ok())
            .flatten()
        {
            Some(p) => p,
            None => continue,
        };
        let stat_raw = match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let stat = match parse_proc_stat(&stat_raw) {
            Some(s) => s,
            None => continue,
        };
        child_map.entry(stat.ppid).or_default().push(stat.pid);
        if !comm_might_be_agent(&stat.comm) {
            continue;
        }
        let args = match read_cmdline(pid) {
            Some(a) if !a.is_empty() => a,
            _ => continue,
        };
        let provider = match provider_from_cmdline(&args) {
            Some(p) => p,
            None => continue,
        };
        agents.push((pid, provider, args));
    }
    ProcScan { agents, child_map }
}

fn build_file_index(root: &Path, dirs: &[String]) -> Option<HashMap<String, PathBuf>> {
    let mut index: HashMap<String, PathBuf> = HashMap::new();
    // Codex: sessions directly under root
    if let Ok(rd) = std::fs::read_dir(root) {
        for entry in rd.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
                index_session_file(&mut index, &path);
            }
        }
    }
    // Claude: one subdir per cwd
    for d in dirs {
        if d == "subagents" {
            continue;
        }
        let subdir = root.join(d);
        let rd = match std::fs::read_dir(&subdir) {
            Ok(r) => r,
            Err(_) => continue,
        };
        for entry in rd.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
                index_session_file(&mut index, &path);
            }
        }
    }
    Some(index)
}

fn index_session_file(index: &mut HashMap<String, PathBuf>, path: &Path) {
    let name = path
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_default();
    index.insert(name.to_ascii_lowercase(), path.to_path_buf());
    if let Some(stem) = path.file_stem().and_then(|value| value.to_str()) {
        if let Some(session_id) = pi_session_id_from_file_stem(stem) {
            index.insert(format!("pi:{session_id}"), path.to_path_buf());
        }
    }
}

fn session_file_matches_id(path: &Path, target: &str) -> bool {
    let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
        return false;
    };
    if name == format!("{target}.jsonl") {
        return true;
    }
    if looks_like_uuid(target) && name.eq_ignore_ascii_case(&format!("{target}.jsonl")) {
        return true;
    }
    pi_session_id_from_file(path).as_deref() == Some(target)
}

fn find_file_recursive(dir: &Path, target: &str, depth: u32) -> Option<PathBuf> {
    if depth > 3 {
        return None;
    }
    let rd = match std::fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return None,
    };
    for entry in rd.flatten() {
        let path = entry.path();
        if path.file_name().map(|n| n == "subagents").unwrap_or(false) {
            continue;
        }
        let md = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if md.is_dir() {
            if let Some(found) = find_file_recursive(&path, target, depth + 1) {
                return Some(found);
            }
        } else if path.extension().and_then(|value| value.to_str()) == Some("jsonl")
            && session_file_matches_id(&path, target)
        {
            return Some(path);
        }
    }
    None
}

/// Locate `<root>/<...>/<sessionId>.jsonl`. Uses cache when provided.
pub fn find_session_file_by_id(
    root: &Path,
    session_id: &str,
    mut cache: Option<&mut ResolverCache>,
) -> Option<PathBuf> {
    let target = session_id.trim();
    if target.is_empty() {
        return None;
    }
    let target_file = format!("{}.jsonl", target.to_ascii_lowercase());

    // Fast path: the session index already knows every transcript path
    // (codex nests sessions 3 levels deep; directory recursion cost ~0.5s
    // per unresolved codex process on large homes). The parsed index is
    // memoized in the cache for the scan's lifetime. Path must live under
    // the requested root so provider homes stay disjoint.
    let indexed_hit = cache.as_deref_mut().and_then(|c| {
        let slot = c
            .session_index
            .get_or_insert_with(crate::core::session_index::load_session_index);
        slot.as_ref().and_then(|index| {
            index
                .sessions
                .iter()
                .find(|s| s.session_id.eq_ignore_ascii_case(target))
                .map(|s| PathBuf::from(&s.file_path))
        })
    });
    if let Some(hit) = indexed_hit {
        if hit.starts_with(root) {
            return Some(hit);
        }
    }

    if let Some(c) = cache {
        let needs_build = !c.file_index.contains_key(root);
        if needs_build {
            let dirs = match c.root_dirs.get(root).cloned() {
                Some(d) => d,
                None => {
                    let mut d = Vec::new();
                    if let Ok(rd) = std::fs::read_dir(root) {
                        for entry in rd.flatten() {
                            d.push(entry.file_name().to_string_lossy().to_string());
                        }
                    }
                    c.root_dirs.insert(root.to_path_buf(), d.clone());
                    d
                }
            };
            let idx = build_file_index(root, &dirs);
            c.file_index.insert(root.to_path_buf(), idx);
        }
        if let Some(Some(idx)) = c.file_index.get(root) {
            if let Some(hit) = idx.get(&format!("pi:{target}")) {
                return Some(hit.clone());
            }
            if let Some(hit) = idx.get(&target_file) {
                return Some(hit.clone());
            }
            return find_file_recursive(root, target, 0);
        }
        return None;
    }

    // No cache: stat each immediate subdir
    let rd = match std::fs::read_dir(root) {
        Ok(r) => r,
        Err(_) => return None,
    };
    for entry in rd.flatten() {
        if entry.file_name() == "subagents" {
            continue;
        }
        let candidate = entry.path().join(format!("{target}.jsonl"));
        if candidate.is_file() {
            return Some(candidate);
        }
        let lower_candidate = entry.path().join(&target_file);
        if lower_candidate.is_file() {
            return Some(lower_candidate);
        }
    }
    let direct = root.join(format!("{target}.jsonl"));
    if direct.is_file() {
        return Some(direct);
    }
    let lower_direct = root.join(&target_file);
    if lower_direct.is_file() {
        return Some(lower_direct);
    }
    find_file_recursive(root, target, 0)
}

fn most_recent_jsonl(dir: &Path) -> Option<(PathBuf, u64)> {
    let rd = match std::fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return None,
    };
    let mut best: Option<(PathBuf, u64)> = None;
    for entry in rd.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let mtime = entry
            .metadata()
            .ok()?
            .modified()
            .ok()?
            .duration_since(std::time::UNIX_EPOCH)
            .ok()?
            .as_millis() as u64;
        best = match best {
            Some((_, bm)) if bm >= mtime => best,
            _ => Some((path, mtime)),
        };
    }
    best
}

fn most_recent_pi_jsonl_for_cwd(dir: &Path, cwd: &Path) -> Option<(PathBuf, u64)> {
    let rd = std::fs::read_dir(dir).ok()?;
    let mut best: Option<(PathBuf, u64)> = None;
    for entry in rd.flatten() {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
            continue;
        }
        let Some((_, session_cwd)) = read_pi_session_header(&path) else {
            continue;
        };
        if session_cwd != cwd {
            continue;
        }
        let mtime = entry
            .metadata()
            .ok()
            .and_then(|metadata| metadata.modified().ok())
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis() as u64)
            .unwrap_or(0);
        best = match best {
            Some((_, best_mtime)) if best_mtime >= mtime => best,
            _ => Some((path, mtime)),
        };
    }
    best
}

fn most_recent_jsonl_recursive(dir: &Path, depth: u32) -> Option<(PathBuf, u64)> {
    if depth > 2 {
        return None;
    }
    let rd = match std::fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return None,
    };
    let mut best: Option<(PathBuf, u64)> = None;
    for entry in rd.flatten() {
        let path = entry.path();
        if path.file_name().map(|n| n == "subagents").unwrap_or(false) {
            continue;
        }
        let md = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if md.is_dir() {
            if let Some(nested) = most_recent_jsonl_recursive(&path, depth + 1) {
                best = match best {
                    Some((_, bm)) if bm >= nested.1 => best,
                    _ => Some(nested),
                };
            }
        } else if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
            let mtime = md
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            best = match best {
                Some((_, bm)) if bm >= mtime => best,
                _ => Some((path, mtime)),
            };
        }
    }
    best
}

fn cached_most_recent_jsonl(dir: &Path, cache: &mut ResolverCache) -> Option<(PathBuf, u64)> {
    if let Some(hit) = cache.recent_jsonl_flat.get(dir) {
        return hit.clone();
    }
    let result = most_recent_jsonl(dir);
    cache
        .recent_jsonl_flat
        .insert(dir.to_path_buf(), result.clone());
    result
}

fn cached_most_recent_pi_jsonl_for_cwd(
    dir: &Path,
    cwd: &Path,
    cache: &mut ResolverCache,
) -> Option<(PathBuf, u64)> {
    let key = (dir.to_path_buf(), cwd.to_path_buf());
    if let Some(hit) = cache.recent_pi_jsonl_by_cwd.get(&key) {
        return hit.clone();
    }
    let result = most_recent_pi_jsonl_for_cwd(dir, cwd);
    cache.recent_pi_jsonl_by_cwd.insert(key, result.clone());
    result
}

fn cached_most_recent_jsonl_recursive(
    root: &Path,
    cache: &mut ResolverCache,
) -> Option<(PathBuf, u64)> {
    if let Some(hit) = cache.recent_jsonl.get(root) {
        return hit.clone();
    }
    let result = most_recent_jsonl_recursive(root, 0);
    cache
        .recent_jsonl
        .insert(root.to_path_buf(), result.clone());
    result
}

struct ResolveContext<'a> {
    environ: HashMap<String, String>,
    home: PathBuf,
    root: PathBuf,
    session_root_is_custom: bool,
    pi_filter_local_cwd: bool,
    cwd: Option<PathBuf>,
    cache: &'a mut ResolverCache,
}

fn session_id_from_open_file(provider: Provider, path: &Path) -> Option<String> {
    match provider {
        Provider::Pi => pi_session_id_from_file(path),
        Provider::Claude | Provider::Codex => {
            let raw = path.to_string_lossy();
            is_session_file_path(&raw)
                .then(|| extract_session_id_from_path(&raw))
                .flatten()
        }
    }
}

#[derive(Debug)]
struct PiProcessSessionInfo {
    session_id: String,
    project_path: PathBuf,
    file_path: PathBuf,
    logical_modified_ms: i64,
}

fn pi_process_file_mtime_ms(path: &Path) -> Option<i64> {
    let modified = std::fs::metadata(path).ok()?.modified().ok()?;
    Some(match modified.duration_since(std::time::UNIX_EPOCH) {
        Ok(elapsed) => elapsed.as_millis().min(i64::MAX as u128) as i64,
        Err(error) => -(error.duration().as_millis().min(i64::MAX as u128) as i64),
    })
}

fn pi_process_iso_timestamp_ms(value: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|timestamp| timestamp.timestamp_millis())
}

fn pi_process_json_timestamp_ms(value: &Value) -> Option<i64> {
    let value = value.as_f64()?;
    value
        .is_finite()
        .then(|| value.clamp(i64::MIN as f64, i64::MAX as f64) as i64)
}

fn read_pi_process_session_info(path: &Path) -> Option<PiProcessSessionInfo> {
    let file_mtime_ms = pi_process_file_mtime_ms(path)?;
    let file = std::fs::File::open(path).ok()?;
    let mut header_reader =
        BufReader::new(file).take((PI_MAX_SESSION_HEADER_SCAN_BYTES + 1) as u64);
    let mut scanned_header_bytes = 0usize;
    let (session_id, project_path, header_timestamp_ms) = loop {
        let mut physical_line = Vec::new();
        let bytes_read = header_reader.read_until(b'\n', &mut physical_line).ok()?;
        if bytes_read == 0 {
            return None;
        }
        scanned_header_bytes = scanned_header_bytes.saturating_add(bytes_read);
        if scanned_header_bytes > PI_MAX_SESSION_HEADER_SCAN_BYTES {
            return None;
        }
        let line = String::from_utf8_lossy(&physical_line);
        let Ok(entry) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        if entry.get("type").and_then(Value::as_str) != Some("session") {
            return None;
        }
        let id = entry
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| valid_pi_session_id(id))?;
        let cwd = entry
            .get("cwd")
            .and_then(Value::as_str)
            .filter(|cwd| !cwd.is_empty())?;
        let header_timestamp_ms = entry
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(pi_process_iso_timestamp_ms);
        break (id.to_string(), PathBuf::from(cwd), header_timestamp_ms);
    };

    // Cost control: this used to parse the ENTIRE transcript line by line
    // only to derive last-activity for recency ordering. The session-header
    // timestamp, falling back to the file mtime, carries the same
    // wall-clock signal for zero parsing; large transcripts made `starling
    // top` spend seconds per process here (O(bytes × processes)).
    Some(PiProcessSessionInfo {
        session_id,
        project_path,
        file_path: path.to_path_buf(),
        logical_modified_ms: header_timestamp_ms.unwrap_or(file_mtime_ms),
    })
}

fn normalize_process_path_lexically(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
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

fn pi_process_cwd_matches(session_cwd: &Path, launch_cwd: &Path) -> bool {
    let resolved = resolve_pi_process_path(&session_cwd.to_string_lossy(), Some(launch_cwd));
    normalize_process_path_lexically(&resolved) == normalize_process_path_lexically(launch_cwd)
}

fn pi_process_sessions_in_dir(dir: &Path) -> Vec<PiProcessSessionInfo> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut sessions: Vec<_> = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
                return None;
            }
            read_pi_process_session_info(&path)
        })
        .collect();
    sessions.sort_by(|left, right| {
        right
            .logical_modified_ms
            .cmp(&left.logical_modified_ms)
            .then_with(|| left.file_path.cmp(&right.file_path))
    });
    sessions
}

fn pi_process_local_sessions(ctx: &ResolveContext<'_>) -> Vec<PiProcessSessionInfo> {
    let Some(cwd) = ctx.cwd.as_deref() else {
        return Vec::new();
    };
    if ctx.session_root_is_custom {
        let mut sessions = pi_process_sessions_in_dir(&ctx.root);
        if ctx.pi_filter_local_cwd {
            sessions.retain(|session| pi_process_cwd_matches(&session.project_path, cwd));
        }
        sessions
    } else {
        pi_process_sessions_in_dir(&ctx.root.join(encode_pi_cwd(&cwd.to_string_lossy())))
    }
}

fn pi_exact_or_prefix_process_session<'a>(
    sessions: &'a [PiProcessSessionInfo],
    selector: &str,
) -> Option<&'a PiProcessSessionInfo> {
    sessions
        .iter()
        .find(|session| session.session_id == selector)
        .or_else(|| {
            sessions
                .iter()
                .find(|session| session.session_id.starts_with(selector))
        })
}

fn resolve_pi_process_selector(
    ctx: &ResolveContext<'_>,
    selector: &str,
) -> Option<PiProcessSessionInfo> {
    let local = pi_process_local_sessions(ctx);
    let index = pi_exact_or_prefix_process_session(&local, selector).and_then(|target| {
        local
            .iter()
            .position(|candidate| candidate.file_path == target.file_path)
    })?;
    local.into_iter().nth(index)
}

fn resolve_pi_process_local_exact(
    ctx: &ResolveContext<'_>,
    session_id: &str,
) -> Option<PiProcessSessionInfo> {
    pi_process_local_sessions(ctx)
        .into_iter()
        .find(|session| session.session_id == session_id)
}

fn resolve_from_open_files(
    ctx: &mut ResolveContext,
    provider: Provider,
    pid: u32,
) -> Option<MappedSession> {
    let files: Vec<PathBuf> = read_open_jsonl_files(pid)
        .into_iter()
        .filter(|path| session_id_from_open_file(provider, path).is_some())
        .collect();
    if files.is_empty() {
        return None;
    }
    let in_root = files.iter().find(|f| f.starts_with(&ctx.root));
    let chosen = in_root.cloned().or_else(|| files.first().cloned())?;
    let sid = session_id_from_open_file(provider, &chosen)?;
    let project_path = if provider == Provider::Pi {
        pi_project_path_from_file(&chosen, ctx.cwd.as_deref())
    } else {
        ctx.cwd.clone()
    };
    Some(MappedSession {
        pid,
        provider: Some(provider),
        session_id: Some(sid),
        file_path: Some(chosen.to_string_lossy().to_string()),
        home: Some(ctx.home.to_string_lossy().to_string()),
        project_path: project_path.map(|path| path.to_string_lossy().to_string()),
        confidence: 100,
    })
}

fn pi_session_arg(args: &[String]) -> Option<(&str, bool)> {
    let parsed = parse_pi_process_args(args);
    parsed
        .session
        .filter(|value| !value.is_empty())
        .map(|value| (value, false))
        .or_else(|| {
            parsed
                .session_id
                .filter(|value| !value.is_empty())
                .map(|value| (value, true))
        })
}

fn resolve_from_pi_session_arg(
    ctx: &mut ResolveContext,
    args: &[String],
    pid: u32,
) -> Option<MappedSession> {
    let (value, preallocated) = pi_session_arg(args)?;
    let looks_like_path = value.contains('/') || value.contains('\\') || value.ends_with(".jsonl");
    if looks_like_path {
        let path = resolve_pi_process_path(value, ctx.cwd.as_deref());
        let header = read_pi_session_header(&path);
        let session_id = header
            .as_ref()
            .map(|(session_id, _)| session_id.clone())
            .or_else(|| pi_session_id_from_file(&path))?;
        let project_path = header
            .map(|(_, session_cwd)| {
                resolve_pi_process_path(&session_cwd.to_string_lossy(), ctx.cwd.as_deref())
            })
            .or_else(|| ctx.cwd.clone());
        return Some(MappedSession {
            pid,
            provider: Some(Provider::Pi),
            session_id: Some(session_id),
            file_path: Some(path.to_string_lossy().to_string()),
            home: Some(ctx.home.to_string_lossy().to_string()),
            project_path: project_path.map(|path| path.to_string_lossy().to_string()),
            confidence: 100,
        });
    }
    if preallocated && !valid_pi_session_id(value) {
        return None;
    }
    let target = if preallocated {
        resolve_pi_process_local_exact(ctx, value)
    } else {
        resolve_pi_process_selector(ctx, value)
    };
    if let Some(target) = target {
        return Some(MappedSession {
            pid,
            provider: Some(Provider::Pi),
            session_id: Some(target.session_id),
            file_path: Some(target.file_path.to_string_lossy().to_string()),
            home: Some(ctx.home.to_string_lossy().to_string()),
            project_path: Some(
                resolve_pi_process_path(&target.project_path.to_string_lossy(), ctx.cwd.as_deref())
                    .to_string_lossy()
                    .to_string(),
            ),
            confidence: 100,
        });
    }
    preallocated.then(|| MappedSession {
        pid,
        provider: Some(Provider::Pi),
        session_id: Some(value.to_string()),
        file_path: None,
        home: Some(ctx.home.to_string_lossy().to_string()),
        project_path: ctx
            .cwd
            .as_ref()
            .map(|path| path.to_string_lossy().to_string()),
        confidence: 95,
    })
}

fn hook_string<'a>(value: &'a Value, snake: &str, camel: &str) -> Option<&'a str> {
    value
        .get(snake)
        .or_else(|| value.get(camel))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn resolve_from_starling_pi_env(
    ctx: &mut ResolveContext,
    args: &[String],
    pid: u32,
) -> Option<MappedSession> {
    if let Some(hook_path) = ctx
        .environ
        .get("STARLING_PI_HOOK_FILE")
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        let hook_path = resolve_process_path(hook_path, ctx.cwd.as_deref());
        if let Ok(raw) = std::fs::read_to_string(hook_path) {
            for line in raw.lines().rev() {
                let Ok(value) = serde_json::from_str::<Value>(line.trim()) else {
                    continue;
                };
                let source = value
                    .get("payload")
                    .filter(|payload| payload.is_object())
                    .unwrap_or(&value);
                let Some(session_id) = hook_string(source, "session_id", "sessionId") else {
                    continue;
                };
                if !valid_pi_session_id(session_id) {
                    continue;
                }
                let event_cwd = source
                    .get("cwd")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(|value| resolve_process_path(value, ctx.cwd.as_deref()));
                let transcript = hook_string(source, "transcript_path", "transcriptPath")
                    .map(|path| {
                        resolve_pi_process_path(path, event_cwd.as_deref().or(ctx.cwd.as_deref()))
                    })
                    .or_else(|| find_session_file_by_id(&ctx.root, session_id, Some(ctx.cache)));
                let project_path = transcript
                    .as_deref()
                    .and_then(|path| {
                        pi_project_path_from_file(path, event_cwd.as_deref().or(ctx.cwd.as_deref()))
                    })
                    .or(event_cwd)
                    .or_else(|| ctx.cwd.clone());
                return Some(MappedSession {
                    pid,
                    provider: Some(Provider::Pi),
                    project_path: project_path.map(|path| path.to_string_lossy().to_string()),
                    file_path: transcript.map(|path| path.to_string_lossy().to_string()),
                    session_id: Some(session_id.to_string()),
                    home: Some(ctx.home.to_string_lossy().to_string()),
                    confidence: 110,
                });
            }
        }
    }

    let session_id = ctx
        .environ
        .get("STARLING_SESSION_ID")
        .map(|value| value.trim())
        .filter(|value| valid_pi_session_id(value))?;
    let transcript_from_arg = pi_session_arg(args).and_then(|(value, _)| {
        let looks_like_path =
            value.contains('/') || value.contains('\\') || value.ends_with(".jsonl");
        if !looks_like_path {
            return None;
        }
        let path = resolve_pi_process_path(value, ctx.cwd.as_deref());
        read_pi_session_header(&path)
            .filter(|(header_id, _)| header_id == session_id)
            .map(|_| path)
    });
    let transcript = transcript_from_arg
        .or_else(|| resolve_pi_process_local_exact(ctx, session_id).map(|target| target.file_path))
        .or_else(|| find_session_file_by_id(&ctx.root, session_id, Some(ctx.cache)));
    let project_path = transcript
        .as_deref()
        .and_then(|path| pi_project_path_from_file(path, ctx.cwd.as_deref()))
        .or_else(|| ctx.cwd.clone());
    Some(MappedSession {
        pid,
        provider: Some(Provider::Pi),
        project_path: project_path.map(|path| path.to_string_lossy().to_string()),
        file_path: transcript.map(|path| path.to_string_lossy().to_string()),
        session_id: Some(session_id.to_string()),
        home: Some(ctx.home.to_string_lossy().to_string()),
        confidence: 105,
    })
}

fn resolve_from_resume(
    ctx: &mut ResolveContext,
    uuid: &str,
    pid: u32,
    provider: Provider,
) -> Option<MappedSession> {
    let file = find_session_file_by_id(&ctx.root, uuid, Some(ctx.cache))?;
    let session_id = if provider == Provider::Pi {
        uuid.to_string()
    } else {
        uuid.to_lowercase()
    };
    let project_path = if provider == Provider::Pi {
        pi_project_path_from_file(&file, ctx.cwd.as_deref())
    } else {
        ctx.cwd.clone()
    };
    Some(MappedSession {
        pid,
        provider: Some(provider),
        session_id: Some(session_id),
        file_path: Some(file.to_string_lossy().to_string()),
        home: Some(ctx.home.to_string_lossy().to_string()),
        project_path: project_path.map(|path| path.to_string_lossy().to_string()),
        confidence: 100,
    })
}

fn resolve_from_cwd_mtime(
    ctx: &mut ResolveContext,
    provider: Provider,
    pid: u32,
) -> Option<MappedSession> {
    let cwd = ctx.cwd.as_ref()?;
    let best = match provider {
        Provider::Claude => {
            let dir = ctx.root.join(encode_claude_cwd(&cwd.to_string_lossy()));
            cached_most_recent_jsonl(&dir, ctx.cache)
        }
        Provider::Codex => cached_most_recent_jsonl_recursive(&ctx.root, ctx.cache),
        Provider::Pi if ctx.session_root_is_custom && ctx.pi_filter_local_cwd => {
            cached_most_recent_pi_jsonl_for_cwd(&ctx.root, cwd, ctx.cache)
        }
        Provider::Pi if ctx.session_root_is_custom => {
            cached_most_recent_jsonl(&ctx.root, ctx.cache)
        }
        Provider::Pi => {
            let dir = ctx.root.join(encode_pi_cwd(&cwd.to_string_lossy()));
            cached_most_recent_jsonl(&dir, ctx.cache)
        }
    }?;
    let sid = match provider {
        Provider::Pi => pi_session_id_from_file(&best.0),
        Provider::Claude | Provider::Codex => {
            extract_session_id_from_path(&best.0.to_string_lossy())
        }
    }?;
    Some(MappedSession {
        pid,
        provider: Some(provider),
        session_id: Some(sid),
        file_path: Some(best.0.to_string_lossy().to_string()),
        home: Some(ctx.home.to_string_lossy().to_string()),
        project_path: Some(cwd.to_string_lossy().to_string()),
        confidence: 10,
    })
}

fn resolve_from_starling_claude_hook(
    ctx: &mut ResolveContext,
    proc_args: &[String],
    pid: u32,
) -> Option<MappedSession> {
    let settings_path = extract_settings_path(proc_args)?;
    let file_name = settings_path.file_name()?.to_string_lossy();
    let run_id = file_name.strip_suffix(".settings.json")?;
    let hook_file = settings_path.with_file_name(format!("{run_id}.jsonl"));
    let raw = std::fs::read_to_string(hook_file).ok()?;

    for line in raw.lines().rev() {
        let value: Value = serde_json::from_str(line.trim()).ok()?;
        let session_id = value
            .get("session_id")
            .or_else(|| value.get("sessionId"))
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())?
            .to_lowercase();
        let file_path = value
            .get("transcript_path")
            .or_else(|| value.get("transcriptPath"))
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(String::from)
            .or_else(|| {
                find_session_file_by_id(&ctx.root, &session_id, Some(ctx.cache))
                    .map(|p| p.to_string_lossy().to_string())
            });
        let project_path = value
            .get("cwd")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(String::from)
            .or_else(|| ctx.cwd.as_ref().map(|p| p.to_string_lossy().to_string()));
        return Some(MappedSession {
            pid,
            provider: Some(Provider::Claude),
            project_path,
            file_path,
            session_id: Some(session_id),
            home: Some(ctx.home.to_string_lossy().to_string()),
            confidence: 110,
        });
    }

    None
}

fn extract_settings_path(args: &[String]) -> Option<PathBuf> {
    for (index, arg) in args.iter().enumerate() {
        if arg == "--settings" {
            return args.get(index + 1).map(PathBuf::from);
        }
        if let Some(path) = arg.strip_prefix("--settings=") {
            return Some(PathBuf::from(path));
        }
    }
    None
}

fn should_replace_mapping(existing: &MappedSession, candidate: &MappedSession) -> bool {
    candidate.confidence > existing.confidence
}

fn same_mapping_identity(existing: &MappedSession, candidate: &MappedSession) -> bool {
    if existing.provider != Some(Provider::Pi) || candidate.provider != Some(Provider::Pi) {
        return existing.provider == candidate.provider;
    }
    if let (Some(existing_path), Some(candidate_path)) = (
        existing.file_path.as_deref(),
        candidate.file_path.as_deref(),
    ) {
        return existing_path == candidate_path;
    }
    if let (Some(existing_project), Some(candidate_project)) = (
        existing.project_path.as_deref(),
        candidate.project_path.as_deref(),
    ) {
        return existing_project == candidate_project;
    }
    existing.pid == candidate.pid
}

fn insert_session_mapping(
    result: &mut HashMap<String, Vec<MappedSession>>,
    session_id: String,
    candidate: MappedSession,
) {
    let bucket = result.entry(session_id).or_default();
    if let Some(index) = bucket
        .iter()
        .position(|existing| same_mapping_identity(existing, &candidate))
    {
        if should_replace_mapping(&bucket[index], &candidate) {
            bucket[index] = candidate;
        }
    } else {
        bucket.push(candidate);
    }
}

fn resolve_process(
    proc_pid: u32,
    proc_provider: Provider,
    proc_args: &[String],
    child_map: &HashMap<u32, Vec<u32>>,
    visited: &mut HashSet<u32>,
    cache: &mut ResolverCache,
) -> Option<MappedSession> {
    if visited.contains(&proc_pid) {
        return None;
    }
    visited.insert(proc_pid);

    let environ = read_environ(proc_pid);
    let cwd = read_cwd(proc_pid);
    let mut home = resolve_agent_home(proc_provider, &environ);
    if proc_provider == Provider::Pi && !home.is_absolute() {
        if let Some(cwd) = cwd.as_deref() {
            home = cwd.join(home);
        }
    }
    let (root, session_root_is_custom, pi_filter_local_cwd) =
        resolve_session_root(proc_provider, &home, &environ, proc_args, cwd.as_deref());

    let mut ctx = ResolveContext {
        environ,
        home,
        root,
        session_root_is_custom,
        pi_filter_local_cwd,
        cwd,
        cache,
    };

    // 1. Starling's Claude hook file is the most precise signal for
    // wrapped launches: it records Claude's real session_id immediately
    // after SessionStart/StatusLine events.
    if proc_provider == Provider::Claude {
        if let Some(m) = resolve_from_starling_claude_hook(&mut ctx, proc_args, proc_pid) {
            return Some(m);
        }
    }
    // Managed Pi launches expose a hook stream and preallocated session ID in
    // their environment. These are more precise than fd/mtime heuristics.
    if proc_provider == Provider::Pi {
        if ctx
            .environ
            .get("STARLING_PI_NO_SESSION")
            .map(|value| matches!(value.trim(), "1" | "true" | "yes" | "on"))
            .unwrap_or(false)
        {
            return None;
        }
        if let Some(m) = resolve_from_starling_pi_env(&mut ctx, proc_args, proc_pid) {
            return Some(m);
        }
    }

    // 1. fd scan first (cheap, almost always works)
    if let Some(m) = resolve_from_open_files(&mut ctx, proc_provider, proc_pid) {
        return Some(m);
    }
    // 2. Explicit resume/session arguments.
    if proc_provider == Provider::Pi {
        if let Some(m) = resolve_from_pi_session_arg(&mut ctx, proc_args, proc_pid) {
            return Some(m);
        }
    } else if let Some(uuid) = extract_resume_uuid(proc_args) {
        if let Some(m) = resolve_from_resume(&mut ctx, &uuid, proc_pid, proc_provider) {
            return Some(m);
        }
    }
    // 3. process-tree BFS
    if let Some(children) = child_map.get(&proc_pid).cloned() {
        for child_pid in children {
            if visited.contains(&child_pid) {
                continue;
            }
            if is_claude_background_task_process(child_pid) {
                continue;
            }
            let child_args = match read_cmdline(child_pid) {
                Some(a) => a,
                None => continue,
            };
            if let Some(m) = resolve_process(
                child_pid,
                proc_provider,
                &child_args,
                child_map,
                visited,
                ctx.cache,
            ) {
                return Some(m);
            }
        }
    }
    // 4. cwd + most recent jsonl
    resolve_from_cwd_mtime(&mut ctx, proc_provider, proc_pid)
}

/// Map every running Claude, Codex, or Pi process to its session. Linux-only.
pub fn map_processes_to_sessions() -> HashMap<String, Vec<MappedSession>> {
    let mut result: HashMap<String, Vec<MappedSession>> = HashMap::new();
    if !is_linux() {
        return result;
    }

    let scan = scan_proc_once();
    if scan.agents.is_empty() {
        return result;
    }

    let mut cache = ResolverCache::default();
    for (pid, provider, args) in scan.agents {
        if !is_pid_runnable(pid) {
            continue;
        }
        let mut visited = HashSet::new();
        if let Some(mut m) = resolve_process(
            pid,
            provider,
            &args,
            &scan.child_map,
            &mut visited,
            &mut cache,
        ) {
            if m.session_id.is_none() {
                continue;
            }
            let sid = m.session_id.clone().unwrap();
            // Fill provider/pid if not set
            if m.provider.is_none() {
                m.provider = Some(provider);
            }
            if m.pid == 0 {
                m.pid = pid;
            }
            insert_session_mapping(&mut result, sid, m);
        }
    }
    result
}

/// Resolve one launched agent process (and its descendants) to the session it
/// has opened. This is useful for wrappers like `starling run`, where we know
/// the child PID and want to annotate the session while it is still running.
pub fn map_process_tree_to_session(root_pid: u32) -> Option<MappedSession> {
    if !is_linux() || !is_pid_runnable(root_pid) {
        return None;
    }
    let args = read_cmdline(root_pid)?;
    let provider = provider_from_cmdline(&args)?;
    let scan = scan_proc_once();
    let mut visited = HashSet::new();
    let mut cache = ResolverCache::default();
    resolve_process(
        root_pid,
        provider,
        &args,
        &scan.child_map,
        &mut visited,
        &mut cache,
    )
}

pub fn map_process_tree_to_session_since(root_pid: u32, since_ms: u64) -> Option<MappedSession> {
    let mapped = map_process_tree_to_session(root_pid)?;
    let file_path = mapped.file_path.as_deref()?;
    let mtime = std::fs::metadata(file_path)
        .ok()?
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_millis() as u64;
    if mtime >= since_ms {
        Some(mapped)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_test_dir(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "starling-process-map-{label}-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ))
    }

    /// Embed a filesystem path inside a JSON string literal. Windows paths
    /// contain backslashes, which must be escaped to stay valid JSON.
    fn json_path(path: &Path) -> String {
        path.to_string_lossy().replace('\\', "\\\\")
    }

    fn write_pi_session(path: &Path, session_id: &str, cwd: &Path) {
        std::fs::write(
            path,
            format!(
                "{{\"type\":\"session\",\"version\":3,\"id\":\"{session_id}\",\"timestamp\":\"2026-07-24T12:34:56.789Z\",\"cwd\":\"{}\"}}\n",
                json_path(cwd)
            ),
        )
        .unwrap();
    }

    #[test]
    fn parses_proc_stat_basic() {
        let raw = "1234 (bash) S 1 1234 1234 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 10000000 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0\n";
        let stat = parse_proc_stat(raw).unwrap();
        assert_eq!(stat.pid, 1234);
        assert_eq!(stat.comm, "bash");
        assert_eq!(stat.state, "S");
        assert_eq!(stat.ppid, 1);
    }

    #[test]
    fn parses_proc_stat_stopped_state() {
        let raw = "41229 (claude) T 1 40903 40903 0 -1 4194304 0 0 0 0 0 0 0 0 20 0 7 0 10000000 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0\n";
        let stat = parse_proc_stat(raw).unwrap();
        assert_eq!(stat.pid, 41229);
        assert_eq!(stat.comm, "claude");
        assert_eq!(stat.state, "T");
    }

    #[test]
    fn parses_proc_stat_with_spaces_in_comm() {
        let raw = "5 (foo bar baz) R 0 5 5 0 0 0 0 0 0 0 100 50 0 0 20 0 1 0 20000\n";
        let stat = parse_proc_stat(raw).unwrap();
        assert_eq!(stat.comm, "foo bar baz");
        assert_eq!(stat.utime, 100);
        assert_eq!(stat.stime, 50);
    }

    #[test]
    fn parses_proc_environ_chunks() {
        let raw = "HOME=/home/u\0USER=u\0CLAUDE_CONFIG_DIR=/tmp/.claude\0\0";
        let env = parse_proc_environ(raw);
        assert_eq!(env.get("HOME").map(|s| s.as_str()), Some("/home/u"));
        assert_eq!(env.get("USER").map(|s| s.as_str()), Some("u"));
        assert_eq!(
            env.get("CLAUDE_CONFIG_DIR").map(|s| s.as_str()),
            Some("/tmp/.claude")
        );
    }

    #[test]
    fn provider_from_cmdline_basename() {
        assert_eq!(
            provider_from_cmdline(&["/usr/bin/claude".into()]),
            Some(Provider::Claude)
        );
        assert_eq!(
            provider_from_cmdline(&["/usr/bin/codex".into()]),
            Some(Provider::Codex)
        );
        assert_eq!(
            provider_from_cmdline(&["/usr/local/bin/pi".into()]),
            Some(Provider::Pi)
        );
        assert_eq!(provider_from_cmdline(&["/usr/bin/ls".into()]), None);
    }

    #[test]
    fn provider_from_cmdline_node_wrapper() {
        assert_eq!(
            provider_from_cmdline(&["/usr/bin/node".into(), "/path/to/claude.js".into()]),
            Some(Provider::Claude)
        );
        assert_eq!(
            provider_from_cmdline(&["node".into(), "/x/y/z/codex.js".into(), "--foo".into()]),
            Some(Provider::Codex)
        );
        assert_eq!(
            provider_from_cmdline(&[
                "node".into(),
                "/opt/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js".into(),
            ]),
            Some(Provider::Pi)
        );
        assert_eq!(
            provider_from_cmdline(&[
                "bun".into(),
                "/data/dev/pi/packages/coding-agent/dist/cli.js".into(),
            ]),
            Some(Provider::Pi)
        );
        assert_eq!(
            provider_from_cmdline(&[
                "/usr/bin/node".into(),
                "/opt/lib/node_modules/@earendil-works/pi-coding-agent/bin/pi".into(),
                "--mode".into(),
                "rpc".into(),
            ]),
            Some(Provider::Pi)
        );
        assert_eq!(
            provider_from_cmdline(&[
                "node".into(),
                "/opt/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js".into(),
                "-p".into(),
                "codex".into(),
            ]),
            Some(Provider::Pi)
        );
        assert_eq!(
            provider_from_cmdline(&[
                "node".into(),
                "/opt/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js".into(),
                "-p".into(),
                "claude".into(),
            ]),
            Some(Provider::Pi)
        );
        assert_eq!(
            provider_from_cmdline(&["python".into(), "script.py".into(), "pi".into()]),
            None
        );
    }

    #[test]
    fn extracts_settings_path_from_claude_args() {
        assert_eq!(
            extract_settings_path(&["claude".into(), "--settings".into(), "/tmp/a.json".into()]),
            Some(PathBuf::from("/tmp/a.json"))
        );
        assert_eq!(
            extract_settings_path(&["claude".into(), "--settings=/tmp/b.json".into()]),
            Some(PathBuf::from("/tmp/b.json"))
        );
    }

    #[test]
    fn resolves_starling_claude_hook_session_from_settings_arg() {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "starling-process-map-hook-test-{}-{unique}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let settings = dir.join("run-1.settings.json");
        let hook_file = dir.join("run-1.jsonl");
        let transcript = dir.join("5735a325-4a0e-4bf8-8358-f664a645c194.jsonl");
        std::fs::write(
            &hook_file,
            format!(
                "{{\"session_id\":\"5735a325-4a0e-4bf8-8358-f664a645c194\",\"transcript_path\":\"{}\",\"cwd\":\"/work/project\"}}\n",
                json_path(&transcript)
            ),
        )
        .unwrap();
        let mut cache = ResolverCache::default();
        let mut ctx = ResolveContext {
            environ: HashMap::new(),
            home: dir.clone(),
            root: dir.clone(),
            session_root_is_custom: false,
            pi_filter_local_cwd: false,
            cwd: Some(PathBuf::from("/fallback")),
            cache: &mut cache,
        };
        let args = vec![
            "claude".to_string(),
            "--settings".to_string(),
            settings.to_string_lossy().to_string(),
        ];

        let mapped = resolve_from_starling_claude_hook(&mut ctx, &args, 1234).unwrap();

        assert_eq!(
            mapped.session_id.as_deref(),
            Some("5735a325-4a0e-4bf8-8358-f664a645c194")
        );
        assert_eq!(mapped.pid, 1234);
        assert_eq!(mapped.provider, Some(Provider::Claude));
        assert_eq!(mapped.project_path.as_deref(), Some("/work/project"));
        assert_eq!(
            mapped.file_path.as_deref(),
            Some(transcript.to_string_lossy().as_ref())
        );
        assert_eq!(mapped.confidence, 110);
    }

    #[test]
    fn extract_resume_uuid_from_cmdline() {
        let args: Vec<String> = ["claude", "--resume", "a1b2c3d4-e5f6-7890-abcd-ef1234567890"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let uuid = extract_resume_uuid(&args).unwrap();
        assert_eq!(uuid, "a1b2c3d4-e5f6-7890-abcd-ef1234567890");
    }

    #[test]
    fn extract_resume_uuid_uppercase_normalized() {
        let args: Vec<String> = ["--resume", "A1B2C3D4-E5F6-7890-ABCD-EF1234567890"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let uuid = extract_resume_uuid(&args).unwrap();
        assert_eq!(uuid, "a1b2c3d4-e5f6-7890-abcd-ef1234567890");
    }

    #[test]
    fn encode_claude_cwd_round_trip() {
        assert_eq!(
            encode_claude_cwd("/home/user/project"),
            "-home-user-project"
        );
        assert_eq!(encode_claude_cwd("/"), "-");
        assert_eq!(encode_claude_cwd("/a/b/c"), "-a-b-c");
    }

    #[test]
    fn encode_pi_cwd_matches_pi_layout() {
        assert_eq!(encode_pi_cwd("/home/user/project"), "--home-user-project--");
        assert_eq!(encode_pi_cwd("/"), "----");
        assert_eq!(
            encode_pi_cwd(r"C:\Users\me\project"),
            "--C--Users-me-project--"
        );
    }

    #[test]
    fn session_file_path_basics() {
        assert!(is_session_file_path(
            "/x/y/a1b2c3d4-e5f6-7890-abcd-ef1234567890.jsonl"
        ));
        assert!(is_session_file_path("/x/y/rollout-2026-01-01-abc.jsonl"));
        assert!(is_session_file_path(
            "/x/y/2026-07-24T12-34-56-789Z_PiSession_01.jsonl"
        ));
        assert!(!is_session_file_path(
            "/x/y/not-a-pi-timestamp_PiSession_01.jsonl"
        ));
        assert!(!is_session_file_path("/x/y/history.jsonl"));
        assert!(!is_session_file_path("/x/y/todos.jsonl"));
        assert!(!is_session_file_path("/x/y/abc.txt"));
    }

    #[test]
    fn extract_session_id_uuid_and_rollout() {
        assert_eq!(
            extract_session_id_from_path("/p/a1b2c3d4-e5f6-7890-abcd-ef1234567890.jsonl"),
            Some("a1b2c3d4-e5f6-7890-abcd-ef1234567890".into())
        );
        assert_eq!(
            extract_session_id_from_path("/p/rollout-abc.jsonl"),
            Some("rollout-abc".into())
        );
        assert_eq!(
            extract_session_id_from_path("/p/2026-07-24T12-34-56-789Z_CaseSensitive_ID.1.jsonl"),
            Some("CaseSensitive_ID.1".into())
        );
    }

    #[test]
    fn precise_mapping_replaces_cwd_mtime_fallback() {
        let fallback = MappedSession {
            pid: 1,
            provider: Some(Provider::Claude),
            project_path: None,
            file_path: None,
            session_id: Some("s".into()),
            home: None,
            confidence: 10,
        };
        let precise = MappedSession {
            pid: 2,
            provider: Some(Provider::Claude),
            project_path: None,
            file_path: None,
            session_id: Some("s".into()),
            home: None,
            confidence: 100,
        };

        assert!(should_replace_mapping(&fallback, &precise));
        assert!(!should_replace_mapping(&precise, &fallback));
    }

    #[test]
    fn claude_cwd_fallback_does_not_use_unrelated_recent_session() {
        let root =
            std::env::temp_dir().join(format!("starling-process-map-{}", uuid::Uuid::new_v4()));
        let unrelated_dir = root.join("-data20T-dev-nichescape");
        std::fs::create_dir_all(&unrelated_dir).unwrap();
        std::fs::write(
            unrelated_dir.join("73f64f49-9fa0-4bbe-b434-2ec7d0c670a9.jsonl"),
            "{}\n",
        )
        .unwrap();

        let cwd = root.join("other-project");
        std::fs::create_dir_all(&cwd).unwrap();
        let mut cache = ResolverCache::default();
        let mut ctx = ResolveContext {
            environ: HashMap::new(),
            home: root.clone(),
            root: root.clone(),
            session_root_is_custom: false,
            pi_filter_local_cwd: false,
            cwd: Some(cwd),
            cache: &mut cache,
        };

        let mapped = resolve_from_cwd_mtime(&mut ctx, Provider::Claude, 1234);
        std::fs::remove_dir_all(&root).ok();
        assert!(mapped.is_none());
    }

    #[test]
    fn claude_cwd_fallback_uses_exact_project_dir() {
        let root =
            std::env::temp_dir().join(format!("starling-process-map-{}", uuid::Uuid::new_v4()));
        let cwd = root.join("workspace");
        let exact_dir = root.join(encode_claude_cwd(&cwd.to_string_lossy()));
        std::fs::create_dir_all(&exact_dir).unwrap();
        std::fs::write(
            exact_dir.join("31d834d6-235b-4642-ae47-ca6e7c0b7235.jsonl"),
            "{}\n",
        )
        .unwrap();
        std::fs::create_dir_all(&cwd).unwrap();

        let mut cache = ResolverCache::default();
        let mut ctx = ResolveContext {
            environ: HashMap::new(),
            home: root.clone(),
            root: root.clone(),
            session_root_is_custom: false,
            pi_filter_local_cwd: false,
            cwd: Some(cwd),
            cache: &mut cache,
        };

        let mapped = resolve_from_cwd_mtime(&mut ctx, Provider::Claude, 1234).unwrap();
        std::fs::remove_dir_all(&root).ok();
        assert_eq!(
            mapped.session_id.as_deref(),
            Some("31d834d6-235b-4642-ae47-ca6e7c0b7235")
        );
        assert_eq!(mapped.confidence, 10);
    }

    #[test]
    fn resolves_pi_session_root_precedence_and_project_setting() {
        let dir = temp_test_dir("pi-roots");
        let home = dir.join("agent");
        let cwd = dir.join("workspace");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(cwd.join(".pi")).unwrap();

        let empty_env = HashMap::new();
        let (root, custom, filter_cwd) =
            resolve_session_root(Provider::Pi, &home, &empty_env, &[], Some(&cwd));
        assert_eq!(root, home.join("sessions"));
        assert!(!custom);
        assert!(!filter_cwd);

        std::fs::write(
            home.join("settings.json"),
            r#"{"sessionDir":"global-sessions"}"#,
        )
        .unwrap();
        std::fs::write(
            cwd.join(".pi/settings.json"),
            r#"{"sessionDir":"project-sessions"}"#,
        )
        .unwrap();
        let (root, custom, filter_cwd) =
            resolve_session_root(Provider::Pi, &home, &empty_env, &[], Some(&cwd));
        assert_eq!(root, cwd.join("project-sessions"));
        assert!(custom);
        assert!(filter_cwd);

        let mut env = HashMap::new();
        // An absolute path is platform-specific ("/tmp/…" resolves against
        // the current drive on Windows), so build one from the temp dir.
        let env_sessions = std::env::temp_dir().join("pi-env-sessions");
        env.insert(
            "PI_CODING_AGENT_SESSION_DIR".into(),
            env_sessions.to_string_lossy().to_string(),
        );
        let (root, custom, filter_cwd) =
            resolve_session_root(Provider::Pi, &home, &env, &[], Some(&cwd));
        assert_eq!(root, env_sessions);
        assert!(custom);
        assert!(filter_cwd);

        let args = vec!["pi".into(), "--session-dir".into(), "cli-sessions".into()];
        let (root, custom, filter_cwd) =
            resolve_session_root(Provider::Pi, &home, &env, &args, Some(&cwd));
        assert_eq!(root, cwd.join("cli-sessions"));
        assert!(custom);
        assert!(filter_cwd);

        let repeated_args = vec![
            "pi".into(),
            "--session-dir".into(),
            "first".into(),
            "--session-dir".into(),
            "second".into(),
        ];
        let (root, custom, filter_cwd) =
            resolve_session_root(Provider::Pi, &home, &env, &repeated_args, Some(&cwd));
        assert_eq!(root, cwd.join("second"));
        assert!(custom);
        assert!(filter_cwd);

        let consumed_session_dir = vec![
            "pi".into(),
            "--system-prompt".into(),
            "--session-dir".into(),
        ];
        let (root, custom, filter_cwd) =
            resolve_session_root(Provider::Pi, &home, &env, &consumed_session_dir, Some(&cwd));
        assert_eq!(root, env_sessions);
        assert!(custom);
        assert!(filter_cwd);

        // Pi's parser does not support the `--flag=value` form. Do not map a
        // process to a directory Pi itself ignored.
        let invalid_args = vec!["pi".into(), "--session-dir=ignored".into()];
        let (root, custom, filter_cwd) =
            resolve_session_root(Provider::Pi, &home, &env, &invalid_args, Some(&cwd));
        assert_eq!(root, env_sessions);
        assert!(custom);
        assert!(filter_cwd);

        std::fs::write(cwd.join(".pi/settings.json"), r#"{"sessionDir":""}"#).unwrap();
        let (root, custom, filter_cwd) =
            resolve_session_root(Provider::Pi, &home, &empty_env, &[], Some(&cwd));
        assert_eq!(root, home.join("sessions"));
        assert!(!custom);
        assert!(!filter_cwd);

        let default_local = home
            .join("sessions")
            .join(encode_pi_cwd(&cwd.to_string_lossy()));
        let explicit_default = vec![
            "pi".into(),
            "--session-dir".into(),
            default_local.to_string_lossy().to_string(),
        ];
        let (root, custom, filter_cwd) = resolve_session_root(
            Provider::Pi,
            &home,
            &empty_env,
            &explicit_default,
            Some(&cwd),
        );
        assert_eq!(root, default_local);
        assert!(custom);
        assert!(!filter_cwd);

        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn pi_default_cwd_fallback_uses_encoded_project_dir_and_preserves_id_case() {
        let dir = temp_test_dir("pi-default-cwd");
        let home = dir.join("agent");
        let root = home.join("sessions");
        let cwd = dir.join("workspace");
        let project_sessions = root.join(encode_pi_cwd(&cwd.to_string_lossy()));
        std::fs::create_dir_all(&project_sessions).unwrap();
        std::fs::create_dir_all(&cwd).unwrap();
        let transcript = project_sessions.join("2026-07-24T12-34-56-789Z_CaseSensitive_01.jsonl");
        write_pi_session(&transcript, "CaseSensitive_01", &cwd);

        let mut cache = ResolverCache::default();
        let mut ctx = ResolveContext {
            environ: HashMap::new(),
            home,
            root,
            session_root_is_custom: false,
            pi_filter_local_cwd: false,
            cwd: Some(cwd),
            cache: &mut cache,
        };
        let mapped = resolve_from_cwd_mtime(&mut ctx, Provider::Pi, 1234).unwrap();
        assert_eq!(mapped.session_id.as_deref(), Some("CaseSensitive_01"));
        assert_eq!(
            mapped.file_path.as_deref(),
            Some(transcript.to_string_lossy().as_ref())
        );

        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn pi_custom_session_root_is_scanned_directly() {
        let dir = temp_test_dir("pi-custom-root");
        let home = dir.join("agent");
        let root = dir.join("custom-sessions");
        let cwd = dir.join("workspace");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&cwd).unwrap();
        let transcript = root.join("2026-07-24T12-34-56-789Z_CustomRoot_ID.jsonl");
        write_pi_session(&transcript, "CustomRoot_ID", &cwd);
        let unrelated = root.join("2026-07-24T12-35-56-789Z_Unrelated_ID.jsonl");
        write_pi_session(&unrelated, "Unrelated_ID", Path::new("/other/project"));

        let mut cache = ResolverCache::default();
        let mut ctx = ResolveContext {
            environ: HashMap::new(),
            home,
            root,
            session_root_is_custom: true,
            pi_filter_local_cwd: true,
            cwd: Some(cwd),
            cache: &mut cache,
        };
        let mapped = resolve_from_cwd_mtime(&mut ctx, Provider::Pi, 4321).unwrap();
        assert_eq!(mapped.session_id.as_deref(), Some("CustomRoot_ID"));
        assert_eq!(
            mapped.file_path.as_deref(),
            Some(transcript.to_string_lossy().as_ref())
        );

        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn pi_explicit_default_session_dir_does_not_filter_header_cwd() {
        let dir = temp_test_dir("pi-explicit-default-root");
        let home = dir.join("agent");
        let cwd = dir.join("workspace");
        let root = home
            .join("sessions")
            .join(encode_pi_cwd(&cwd.to_string_lossy()));
        std::fs::create_dir_all(&root).unwrap();
        let transcript = root.join("moved.jsonl");
        write_pi_session(&transcript, "MovedSession_ID", Path::new("/former/project"));

        let mut cache = ResolverCache::default();
        let mut ctx = ResolveContext {
            environ: HashMap::new(),
            home,
            root,
            session_root_is_custom: true,
            pi_filter_local_cwd: false,
            cwd: Some(cwd),
            cache: &mut cache,
        };
        let mapped = resolve_from_cwd_mtime(&mut ctx, Provider::Pi, 4322).unwrap();
        assert_eq!(mapped.session_id.as_deref(), Some("MovedSession_ID"));
        assert_eq!(
            mapped.file_path.as_deref(),
            Some(transcript.to_string_lossy().as_ref())
        );

        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn finds_pi_timestamp_session_by_exact_case_sensitive_id() {
        let dir = temp_test_dir("pi-id-lookup");
        let root = dir.join("sessions");
        let project = root.join("--work-project--");
        std::fs::create_dir_all(&project).unwrap();
        let transcript = project.join("2026-07-24T12-34-56-789Z_MixedCase_01.jsonl");
        write_pi_session(&transcript, "MixedCase_01", Path::new("/work/project"));

        let mut cache = ResolverCache::default();
        assert_eq!(
            find_session_file_by_id(&root, "MixedCase_01", Some(&mut cache)),
            Some(transcript)
        );
        assert_eq!(
            find_session_file_by_id(&root, "mixedcase_01", Some(&mut cache)),
            None
        );

        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn pi_header_reader_rejects_an_oversized_first_record() {
        let dir = temp_test_dir("pi-large-header");
        std::fs::create_dir_all(&dir).unwrap();
        let transcript = dir.join("oversized.jsonl");
        std::fs::write(
            &transcript,
            vec![b'x'; PI_MAX_SESSION_HEADER_SCAN_BYTES + 1],
        )
        .unwrap();

        assert!(read_pi_session_header(&transcript).is_none());
        assert!(read_pi_process_session_info(&transcript).is_none());
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn resolves_managed_pi_hook_and_skips_malformed_tail_line() {
        let dir = temp_test_dir("pi-hook");
        let home = dir.join("agent");
        let root = home.join("sessions");
        let cwd = dir.join("workspace");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&cwd).unwrap();
        let transcript = root.join("2026-07-24T12-34-56-789Z_HookedSession_01.jsonl");
        write_pi_session(&transcript, "HookedSession_01", &cwd);
        let hook = dir.join("pi-hook.jsonl");
        std::fs::write(
            &hook,
            format!(
                "{{\"event\":\"session_start\",\"payload\":{{\"sessionId\":\"HookedSession_01\",\"transcriptPath\":\"{}\",\"cwd\":\"{}\"}}}}\nnot-json\n",
                json_path(&transcript),
                json_path(&cwd)
            ),
        )
        .unwrap();

        let mut environ = HashMap::new();
        environ.insert(
            "STARLING_PI_HOOK_FILE".into(),
            hook.to_string_lossy().to_string(),
        );
        environ.insert("STARLING_SESSION_ID".into(), "FallbackSession_01".into());
        let mut cache = ResolverCache::default();
        let mut ctx = ResolveContext {
            environ,
            home,
            root,
            session_root_is_custom: false,
            pi_filter_local_cwd: false,
            cwd: Some(cwd.clone()),
            cache: &mut cache,
        };
        let mapped = resolve_from_starling_pi_env(&mut ctx, &[], 2468).unwrap();
        assert_eq!(mapped.session_id.as_deref(), Some("HookedSession_01"));
        assert_eq!(mapped.provider, Some(Provider::Pi));
        assert_eq!(
            mapped.project_path.as_deref(),
            Some(cwd.to_string_lossy().as_ref())
        );
        assert_eq!(
            mapped.file_path.as_deref(),
            Some(transcript.to_string_lossy().as_ref())
        );
        assert_eq!(mapped.confidence, 110);

        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn resolves_pi_preallocated_session_id_without_lowercasing() {
        let dir = temp_test_dir("pi-session-hint");
        let home = dir.join("agent");
        let root = home.join("sessions");
        let project = root.join("--work-project--");
        std::fs::create_dir_all(&project).unwrap();
        let transcript = project.join("2026-07-24T12-34-56-789Z_PreAllocated_ID.jsonl");
        write_pi_session(&transcript, "PreAllocated_ID", Path::new("/work/project"));

        let mut environ = HashMap::new();
        environ.insert("STARLING_SESSION_ID".into(), "PreAllocated_ID".into());
        let mut cache = ResolverCache::default();
        let launch_cwd = PathBuf::from("/different/launch/project");
        let mut ctx = ResolveContext {
            environ,
            home,
            root,
            session_root_is_custom: false,
            pi_filter_local_cwd: false,
            cwd: Some(launch_cwd),
            cache: &mut cache,
        };
        let mapped = resolve_from_starling_pi_env(&mut ctx, &[], 1357).unwrap();
        assert_eq!(mapped.session_id.as_deref(), Some("PreAllocated_ID"));
        assert_eq!(mapped.project_path.as_deref(), Some("/work/project"));
        assert_eq!(
            mapped.file_path.as_deref(),
            Some(transcript.to_string_lossy().as_ref())
        );
        assert_eq!(mapped.confidence, 105);

        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn resolves_pi_explicit_session_path_from_header() {
        let dir = temp_test_dir("pi-explicit-session");
        let home = dir.join("agent");
        let root = home.join("sessions");
        let cwd = dir.join("workspace");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&cwd).unwrap();
        let transcript = cwd.join("named-session.jsonl");
        write_pi_session(&transcript, "NamedSession_ID", &cwd);

        let args = vec![
            "pi".into(),
            "--session".into(),
            transcript.to_string_lossy().to_string(),
        ];
        let mut cache = ResolverCache::default();
        let mut ctx = ResolveContext {
            environ: HashMap::new(),
            home,
            root,
            session_root_is_custom: false,
            pi_filter_local_cwd: false,
            cwd: Some(cwd),
            cache: &mut cache,
        };
        let mapped = resolve_from_pi_session_arg(&mut ctx, &args, 9753).unwrap();
        assert_eq!(mapped.session_id.as_deref(), Some("NamedSession_ID"));
        assert_eq!(
            mapped.file_path.as_deref(),
            Some(transcript.to_string_lossy().as_ref())
        );

        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn pi_process_args_respect_native_value_token_ownership() {
        let consumed_session = vec![
            "pi".into(),
            "--system-prompt".into(),
            "--session".into(),
            "prompt".into(),
        ];
        assert!(pi_session_arg(&consumed_session).is_none());

        let consumed_path = vec![
            "pi".into(),
            "--model".into(),
            "--session".into(),
            "path.jsonl".into(),
        ];
        assert!(pi_session_arg(&consumed_path).is_none());

        let consumed_session_dir = vec![
            "pi".into(),
            "--model".into(),
            "--session-dir".into(),
            "--session-id".into(),
            "Owned_ID".into(),
        ];
        assert!(extract_pi_session_dir(&consumed_session_dir).is_none());
        assert_eq!(
            pi_session_arg(&consumed_session_dir),
            Some(("Owned_ID", true))
        );

        let empty_last_wins = vec![
            "pi".into(),
            "--session".into(),
            "Earlier".into(),
            "--session".into(),
            "".into(),
            "--session-id".into(),
            "Fallback_ID".into(),
        ];
        assert_eq!(
            pi_session_arg(&empty_last_wins),
            Some(("Fallback_ID", true))
        );
    }

    #[test]
    fn pi_process_selector_prefers_current_project_before_global_matches() {
        let dir = temp_test_dir("pi-local-selector");
        let home = dir.join("agent");
        let root = home.join("sessions");
        let current_cwd = dir.join("current-project");
        let other_cwd = dir.join("other-project");
        let current_dir = root.join(encode_pi_cwd(&current_cwd.to_string_lossy()));
        let other_dir = root.join(encode_pi_cwd(&other_cwd.to_string_lossy()));
        std::fs::create_dir_all(&current_dir).unwrap();
        std::fs::create_dir_all(&other_dir).unwrap();
        let current = current_dir.join("current.jsonl");
        let other = other_dir.join("other.jsonl");
        write_pi_session(&current, "SharedPrefix_Current", &current_cwd);
        write_pi_session(&other, "SharedPrefix_Other", &other_cwd);

        let args = vec!["pi".into(), "--session".into(), "SharedPrefix".into()];
        let mut cache = ResolverCache::default();
        let mut ctx = ResolveContext {
            environ: HashMap::new(),
            home,
            root,
            session_root_is_custom: false,
            pi_filter_local_cwd: false,
            cwd: Some(current_cwd.clone()),
            cache: &mut cache,
        };
        let mapped = resolve_from_pi_session_arg(&mut ctx, &args, 9755).unwrap();

        assert_eq!(mapped.session_id.as_deref(), Some("SharedPrefix_Current"));
        assert_eq!(
            mapped.file_path.as_deref(),
            Some(current.to_string_lossy().as_ref())
        );
        assert_eq!(
            mapped.project_path.as_deref(),
            Some(current_cwd.to_string_lossy().as_ref())
        );
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn pi_process_prefix_uses_message_activity_instead_of_file_mtime() {
        let dir = temp_test_dir("pi-logical-selector");
        let home = dir.join("agent");
        let root = home.join("sessions");
        let cwd = dir.join("project");
        let local = root.join(encode_pi_cwd(&cwd.to_string_lossy()));
        std::fs::create_dir_all(&local).unwrap();
        let logically_newer = local.join("newer-activity.jsonl");
        let newer_header = format!(
            "{{\"type\":\"session\",\"version\":3,\"id\":\"Activity_Newer\",\"timestamp\":\"2026-01-01T00:00:00Z\",\"cwd\":\"{}\"}}\n",
            json_path(&cwd)
        );
        std::fs::write(
            &logically_newer,
            format!(
                "{newer_header}{{\"type\":\"message\",\"message\":{{\"role\":\"user\",\"content\":\"new\",\"timestamp\":2000}}}}\n"
            ),
        )
        .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        let newer_mtime = local.join("newer-mtime.jsonl");
        let older_header = format!(
            "{{\"type\":\"session\",\"version\":3,\"id\":\"Activity_Older\",\"timestamp\":\"2026-01-01T00:00:00Z\",\"cwd\":\"{}\"}}\n",
            json_path(&cwd)
        );
        std::fs::write(
            &newer_mtime,
            format!(
                "{older_header}{{\"type\":\"message\",\"message\":{{\"role\":\"assistant\",\"content\":[],\"timestamp\":1000}}}}\n"
            ),
        )
        .unwrap();
        assert!(
            pi_process_file_mtime_ms(&newer_mtime) >= pi_process_file_mtime_ms(&logically_newer)
        );

        let args = vec!["pi".into(), "--session".into(), "Activity_".into()];
        let mut cache = ResolverCache::default();
        let mut ctx = ResolveContext {
            environ: HashMap::new(),
            home,
            root,
            session_root_is_custom: false,
            pi_filter_local_cwd: false,
            cwd: Some(cwd),
            cache: &mut cache,
        };
        let mapped = resolve_from_pi_session_arg(&mut ctx, &args, 9756).unwrap();

        assert_eq!(mapped.session_id.as_deref(), Some("Activity_Newer"));
        assert_eq!(
            mapped.file_path.as_deref(),
            Some(logically_newer.to_string_lossy().as_ref())
        );
        std::fs::remove_dir_all(dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn pi_process_map_uses_last_file_url_selector_and_header_project() {
        let dir = temp_test_dir("pi-file-url-session");
        let home = dir.join("agent");
        let root = home.join("sessions");
        let launch_cwd = dir.join("launch-workspace");
        let header_cwd = dir.join("header-workspace");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&launch_cwd).unwrap();
        std::fs::create_dir_all(&header_cwd).unwrap();
        let transcript = dir.join("named session.jsonl");
        write_pi_session(&transcript, "FileUrlSession_ID", &header_cwd);
        let file_url = format!("file://{}", transcript.to_string_lossy()).replace(' ', "%20");
        let args = vec![
            "pi".into(),
            "--session".into(),
            "ignored.jsonl".into(),
            "--session".into(),
            file_url,
        ];

        let mut cache = ResolverCache::default();
        let mut ctx = ResolveContext {
            environ: HashMap::new(),
            home,
            root,
            session_root_is_custom: false,
            pi_filter_local_cwd: false,
            cwd: Some(launch_cwd),
            cache: &mut cache,
        };
        let mapped = resolve_from_pi_session_arg(&mut ctx, &args, 9754).unwrap();

        assert_eq!(mapped.session_id.as_deref(), Some("FileUrlSession_ID"));
        assert_eq!(
            mapped.file_path.as_deref(),
            Some(transcript.to_string_lossy().as_ref())
        );
        assert_eq!(
            mapped.project_path.as_deref(),
            Some(header_cwd.to_string_lossy().as_ref())
        );
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn resolves_pi_session_id_before_transcript_exists() {
        let dir = temp_test_dir("pi-new-session-id");
        let home = dir.join("agent");
        let root = home.join("sessions");
        let cwd = dir.join("workspace");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&cwd).unwrap();
        let args = vec!["pi".into(), "--session-id".into(), "NewSession_ID".into()];

        let mut cache = ResolverCache::default();
        let mut ctx = ResolveContext {
            environ: HashMap::new(),
            home,
            root,
            session_root_is_custom: false,
            pi_filter_local_cwd: false,
            cwd: Some(cwd),
            cache: &mut cache,
        };
        let mapped = resolve_from_pi_session_arg(&mut ctx, &args, 8642).unwrap();
        assert_eq!(mapped.session_id.as_deref(), Some("NewSession_ID"));
        assert!(mapped.file_path.is_none());
        assert_eq!(mapped.confidence, 95);

        let invalid_equals = vec!["pi".into(), "--session-id=Ignored_ID".into()];
        assert!(resolve_from_pi_session_arg(&mut ctx, &invalid_equals, 8642).is_none());

        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn pi_process_map_keeps_same_id_in_distinct_projects() {
        let mapped = |pid, project: &str, file: &str, confidence| MappedSession {
            pid,
            provider: Some(Provider::Pi),
            project_path: Some(project.into()),
            file_path: Some(file.into()),
            session_id: Some("SharedID".into()),
            home: None,
            confidence,
        };
        let mut sessions = HashMap::new();
        insert_session_mapping(
            &mut sessions,
            "SharedID".into(),
            mapped(10, "/work/a", "/sessions/a.jsonl", 80),
        );
        insert_session_mapping(
            &mut sessions,
            "SharedID".into(),
            mapped(20, "/work/b", "/sessions/b.jsonl", 90),
        );
        insert_session_mapping(
            &mut sessions,
            "SharedID".into(),
            mapped(30, "/work/a", "/sessions/a.jsonl", 110),
        );

        let bucket = sessions.get("SharedID").unwrap();
        assert_eq!(bucket.len(), 2);
        assert!(bucket.iter().any(|entry| entry.pid == 20));
        assert!(bucket.iter().any(|entry| entry.pid == 30));
        assert!(!bucket.iter().any(|entry| entry.pid == 10));
    }

    #[test]
    fn comm_filter() {
        assert!(comm_might_be_agent("claude"));
        assert!(comm_might_be_agent("pi"));
        assert!(comm_might_be_agent("node"));
        assert!(comm_might_be_agent("bash"));
        assert!(!comm_might_be_agent("pip"));
        assert!(!comm_might_be_agent("pipewire"));
        assert!(!comm_might_be_agent("chrome"));
        assert!(!comm_might_be_agent(""));
    }

    #[test]
    fn resolve_agent_home_env_overrides() {
        let mut env = HashMap::new();
        env.insert("CLAUDE_CONFIG_DIR".into(), "/tmp/.claude_xyz".into());
        let home = resolve_agent_home(Provider::Claude, &env);
        assert_eq!(home, PathBuf::from("/tmp/.claude_xyz"));

        let mut env = HashMap::new();
        env.insert("CODEX_HOME".into(), "~/.codex_xyz".into());
        let home = resolve_agent_home(Provider::Codex, &env);
        assert!(home.to_string_lossy().ends_with(".codex_xyz"));

        let mut env = HashMap::new();
        env.insert("PI_CODING_AGENT_DIR".into(), "/tmp/.pi-agent-xyz".into());
        let home = resolve_agent_home(Provider::Pi, &env);
        assert_eq!(home, PathBuf::from("/tmp/.pi-agent-xyz"));
    }
}

// Silence unused warning when only tests use Value
#[allow(dead_code)]
fn _anchor_value() -> Value {
    Value::Null
}
