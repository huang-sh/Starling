//! /proc-based PID → session resolver (Linux-only; no-op elsewhere).
//! Mirrors src/lib/processMap.ts.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::Value;

use crate::constants::expand_home;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Claude,
    Codex,
}

#[derive(Debug, Clone, Default)]
pub struct MappedSession {
    pub pid: u32,
    pub provider: Option<Provider>,
    pub project_path: Option<String>,
    pub file_path: Option<String>,
    pub session_id: Option<String>,
    pub home: Option<String>,
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
        if chunk.is_empty() { continue; }
        if let Some(eq) = chunk.find('=') {
            if eq == 0 { continue; }
            out.insert(chunk[..eq].to_string(), chunk[eq + 1..].to_string());
        }
    }
    out
}

pub fn parse_proc_stat(raw: &str) -> Option<ProcStat> {
    let open = raw.find('(')?;
    let close = raw.rfind(')')?;
    if close <= open { return None; }
    let pid: u32 = raw[..open].trim().parse().ok()?;
    let comm = raw[open + 1..close].to_string();
    let rest: Vec<&str> = raw[close + 1..].split_whitespace().collect();
    let num = |i: usize| -> u64 {
        rest.get(i).and_then(|s| s.parse().ok()).unwrap_or(0)
    };
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
    if comm.is_empty() { return false; }
    AGENT_COMM_PREFIXES.iter().any(|p| comm == *p || comm.starts_with(p))
}

/// Inspect a process's cmdline vector and return which provider it launched,
/// if any. Matches the TS heuristic exactly: first 4 args by basename, then
/// any arg by path suffix.
pub fn provider_from_cmdline(args: &[String]) -> Option<Provider> {
    for arg in args.iter().take(4) {
        let base = Path::new(arg).file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        if base == "claude" || base == "claude-code" { return Some(Provider::Claude); }
        if base == "codex" { return Some(Provider::Codex); }
    }
    for arg in args {
        let lower = arg.to_lowercase();
        if lower.ends_with("/claude") || lower.contains("/claude.js") || lower.ends_with("/claude-code") {
            return Some(Provider::Claude);
        }
        if lower.ends_with("/codex") || lower.contains("/codex.js") {
            return Some(Provider::Codex);
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
    if parts.len() != 5 { return false; }
    let lens = [8usize, 4, 4, 4, 12];
    parts.iter().zip(lens.iter()).all(|(p, &expected)| {
        p.len() == expected && p.chars().all(|c| c.is_ascii_hexdigit())
    })
}

pub fn resolve_agent_home(provider: Provider, environ: &HashMap<String, String>) -> PathBuf {
    match provider {
        Provider::Claude => {
            if let Some(v) = environ.get("CLAUDE_CONFIG_DIR").map(|s| s.trim()).filter(|s| !s.is_empty()) {
                expand_home(v)
            } else {
                dirs::home_dir().unwrap_or_default().join(".claude")
            }
        }
        Provider::Codex => {
            if let Some(v) = environ.get("CODEX_HOME").map(|s| s.trim()).filter(|s| !s.is_empty()) {
                expand_home(v)
            } else {
                dirs::home_dir().unwrap_or_default().join(".codex")
            }
        }
    }
}

pub fn session_root_for_home(provider: Provider, home: &Path) -> PathBuf {
    match provider {
        Provider::Claude => home.join("projects"),
        Provider::Codex => home.join("sessions"),
    }
}

/// Claude encodes cwd as `-a-b-c` for `/a/b/c`.
pub fn encode_claude_cwd(cwd: &str) -> String {
    let parts: Vec<&str> = cwd.split('/').filter(|s| !s.is_empty()).collect();
    format!("-{}", parts.join("-"))
}

pub fn extract_session_id_from_path(file_path: &str) -> Option<String> {
    let name = Path::new(file_path).file_stem()?.to_string_lossy().to_string();
    // Bare UUID match
    let parts: Vec<&str> = name.split('-').collect();
    if parts.len() == 5 {
        let lens = [8usize, 4, 4, 4, 12];
        if parts.iter().zip(lens.iter()).all(|(p, &expected)| {
            p.len() == expected && p.chars().all(|c| c.is_ascii_hexdigit())
        }) {
            return Some(parts.join("-").to_lowercase());
        }
    }
    Some(name.to_lowercase())
}

/// True if file's basename is a bare UUID (Claude) or `rollout-...` (Codex).
pub fn is_session_file_path(file_path: &str) -> bool {
    let name = match Path::new(file_path).file_name() {
        Some(n) => n.to_string_lossy().to_string(),
        None => return false,
    };
    let lower = name.to_lowercase();
    if !lower.ends_with(".jsonl") { return false; }
    let stem = &lower[..lower.len() - ".jsonl".len()];
    // Bare UUID
    let parts: Vec<&str> = stem.split('-').collect();
    if parts.len() == 5 {
        let lens = [8usize, 4, 4, 4, 12];
        if parts.iter().zip(lens.iter()).all(|(p, &expected)| {
            p.len() == expected && p.chars().all(|c| c.is_ascii_hexdigit())
        }) { return true; }
    }
    stem.starts_with("rollout-")
}

// --- /proc readers (Linux only) ---

fn is_linux() -> bool {
    cfg!(target_os = "linux")
}

fn read_cmdline(pid: u32) -> Option<Vec<String>> {
    if !is_linux() { return None; }
    let raw = std::fs::read(format!("/proc/{pid}/cmdline")).ok()?;
    Some(
        raw.split(|b| *b == 0)
            .filter(|s| !s.is_empty())
            .map(|s| String::from_utf8_lossy(s).to_string())
            .collect(),
    )
}

fn read_environ(pid: u32) -> HashMap<String, String> {
    if !is_linux() { return HashMap::new(); }
    let raw = match std::fs::read(format!("/proc/{pid}/environ")) {
        Ok(r) => r,
        Err(_) => return HashMap::new(),
    };
    let s = String::from_utf8_lossy(&raw);
    parse_proc_environ(&s)
}

fn read_cwd(pid: u32) -> Option<PathBuf> {
    if !is_linux() { return None; }
    std::fs::read_link(format!("/proc/{pid}/cwd")).ok()
}

fn read_open_jsonl_files(pid: u32) -> Vec<PathBuf> {
    if !is_linux() { return vec![]; }
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
    if pid == 0 { return false; }
    // kill(pid, 0) returns 0 if process exists, ESRCH if not, EPERM if exists
    // but not ours.
    let rc = unsafe { libc::kill(pid as i32, 0) };
    if rc == 0 { return true; }
    let errno = unsafe { *libc::__errno_location() };
    // EPERM = 1
    errno == 1
}

/// ppid → children[] index over /proc.
pub fn build_child_map() -> HashMap<u32, Vec<u32>> {
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    if !is_linux() { return children; }
    let rd = match std::fs::read_dir("/proc") {
        Ok(r) => r,
        Err(_) => return children,
    };
    for entry in rd.flatten() {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        let pid: u32 = match name_str.chars().all(|c| c.is_ascii_digit()).then(|| name_str.parse().ok()).flatten() {
            Some(p) => p,
            None => continue,
        };
        let stat_raw = match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let stat = match parse_proc_stat(&stat_raw) { Some(s) => s, None => continue };
        children.entry(stat.ppid).or_default().push(stat.pid);
    }
    children
}

#[derive(Default)]
pub struct ResolverCache {
    pub root_dirs: HashMap<PathBuf, Vec<String>>,
    pub recent_jsonl: HashMap<PathBuf, Option<(PathBuf, u64)>>,
    pub recent_jsonl_flat: HashMap<PathBuf, Option<(PathBuf, u64)>>,
    pub file_index: HashMap<PathBuf, Option<HashMap<String, PathBuf>>>,
}

/// Walk /proc once and produce (agent candidates, child map).
pub struct ProcScan {
    pub agents: Vec<(u32, Provider, Vec<String>)>,
    pub child_map: HashMap<u32, Vec<u32>>,
}

pub fn scan_proc_once() -> ProcScan {
    let mut agents: Vec<(u32, Provider, Vec<String>)> = Vec::new();
    let mut child_map: HashMap<u32, Vec<u32>> = HashMap::new();
    if !is_linux() { return ProcScan { agents, child_map }; }
    let rd = match std::fs::read_dir("/proc") {
        Ok(r) => r,
        Err(_) => return ProcScan { agents, child_map },
    };
    for entry in rd.flatten() {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        let pid: u32 = match name_str.chars().all(|c| c.is_ascii_digit()).then(|| name_str.parse().ok()).flatten() {
            Some(p) => p,
            None => continue,
        };
        let stat_raw = match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let stat = match parse_proc_stat(&stat_raw) { Some(s) => s, None => continue };
        child_map.entry(stat.ppid).or_default().push(stat.pid);
        if !comm_might_be_agent(&stat.comm) { continue; }
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
                let name = entry.file_name().to_string_lossy().to_lowercase();
                index.insert(name, path);
            }
        }
    }
    // Claude: one subdir per cwd
    for d in dirs {
        if d == "subagents" { continue; }
        let subdir = root.join(d);
        let rd = match std::fs::read_dir(&subdir) { Ok(r) => r, Err(_) => continue };
        for entry in rd.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
                let name = entry.file_name().to_string_lossy().to_lowercase();
                index.insert(name, path);
            }
        }
    }
    Some(index)
}

fn find_file_recursive(dir: &Path, target: &str, depth: u32) -> Option<PathBuf> {
    if depth > 3 { return None; }
    let rd = match std::fs::read_dir(dir) { Ok(r) => r, Err(_) => return None };
    let target_file = format!("{target}.jsonl");
    for entry in rd.flatten() {
        let path = entry.path();
        if path.file_name().map(|n| n == "subagents").unwrap_or(false) { continue; }
        let md = match entry.metadata() { Ok(m) => m, Err(_) => continue };
        if md.is_dir() {
            if let Some(found) = find_file_recursive(&path, target, depth + 1) {
                return Some(found);
            }
        } else {
            let name = entry.file_name().to_string_lossy().to_lowercase();
            if name == target_file { return Some(path); }
        }
    }
    None
}

/// Locate `<root>/<...>/<sessionId>.jsonl`. Uses cache when provided.
pub fn find_session_file_by_id(root: &Path, session_id: &str, cache: Option<&mut ResolverCache>) -> Option<PathBuf> {
    let target = session_id.to_lowercase();
    let target_file = format!("{target}.jsonl");

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
            if let Some(hit) = idx.get(&target_file) {
                return Some(hit.clone());
            }
            return find_file_recursive(root, &target, 0);
        }
        return None;
    }

    // No cache: stat each immediate subdir
    let rd = match std::fs::read_dir(root) { Ok(r) => r, Err(_) => return None };
    for entry in rd.flatten() {
        if entry.file_name() == "subagents" { continue; }
        let candidate = entry.path().join(format!("{target}.jsonl"));
        if candidate.is_file() { return Some(candidate); }
    }
    let direct = root.join(format!("{target}.jsonl"));
    if direct.is_file() { return Some(direct); }
    find_file_recursive(root, &target, 0)
}

fn most_recent_jsonl(dir: &Path) -> Option<(PathBuf, u64)> {
    let rd = match std::fs::read_dir(dir) { Ok(r) => r, Err(_) => return None };
    let mut best: Option<(PathBuf, u64)> = None;
    for entry in rd.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") { continue; }
        let mtime = entry.metadata().ok()?
            .modified().ok()?
            .duration_since(std::time::UNIX_EPOCH).ok()?
            .as_millis() as u64;
        best = match best {
            Some((_, bm)) if bm >= mtime => best,
            _ => Some((path, mtime)),
        };
    }
    best
}

fn most_recent_jsonl_recursive(dir: &Path, depth: u32) -> Option<(PathBuf, u64)> {
    if depth > 2 { return None; }
    let rd = match std::fs::read_dir(dir) { Ok(r) => r, Err(_) => return None };
    let mut best: Option<(PathBuf, u64)> = None;
    for entry in rd.flatten() {
        let path = entry.path();
        if path.file_name().map(|n| n == "subagents").unwrap_or(false) { continue; }
        let md = match entry.metadata() { Ok(m) => m, Err(_) => continue };
        if md.is_dir() {
            if let Some(nested) = most_recent_jsonl_recursive(&path, depth + 1) {
                best = match best {
                    Some((_, bm)) if bm >= nested.1 => best,
                    _ => Some(nested),
                };
            }
        } else if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
            let mtime = md.modified().ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64).unwrap_or(0);
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
    cache.recent_jsonl_flat.insert(dir.to_path_buf(), result.clone());
    result
}

fn cached_most_recent_jsonl_recursive(root: &Path, cache: &mut ResolverCache) -> Option<(PathBuf, u64)> {
    if let Some(hit) = cache.recent_jsonl.get(root) {
        return hit.clone();
    }
    let result = most_recent_jsonl_recursive(root, 0);
    cache.recent_jsonl.insert(root.to_path_buf(), result.clone());
    result
}

struct ResolveContext<'a> {
    environ: HashMap<String, String>,
    home: PathBuf,
    root: PathBuf,
    cwd: Option<PathBuf>,
    cache: &'a mut ResolverCache,
}

fn resolve_from_open_files(ctx: &mut ResolveContext, provider: Provider, pid: u32) -> Option<MappedSession> {
    let files: Vec<PathBuf> = read_open_jsonl_files(pid).into_iter()
        .filter(|f| is_session_file_path(&f.to_string_lossy()))
        .collect();
    if files.is_empty() { return None; }
    let in_root = files.iter().find(|f| f.starts_with(&ctx.root));
    let chosen = in_root.cloned().or_else(|| files.first().cloned())?;
    let sid = extract_session_id_from_path(&chosen.to_string_lossy())?;
    Some(MappedSession {
        pid,
        provider: Some(provider),
        session_id: Some(sid),
        file_path: Some(chosen.to_string_lossy().to_string()),
        home: Some(ctx.home.to_string_lossy().to_string()),
        project_path: ctx.cwd.as_ref().map(|p| p.to_string_lossy().to_string()),
    })
}

fn resolve_from_resume(ctx: &mut ResolveContext, uuid: &str, pid: u32, provider: Provider) -> Option<MappedSession> {
    let file = find_session_file_by_id(&ctx.root, uuid, Some(ctx.cache))?;
    Some(MappedSession {
        pid,
        provider: Some(provider),
        session_id: Some(uuid.to_lowercase()),
        file_path: Some(file.to_string_lossy().to_string()),
        home: Some(ctx.home.to_string_lossy().to_string()),
        project_path: ctx.cwd.as_ref().map(|p| p.to_string_lossy().to_string()),
    })
}

fn resolve_from_cwd_mtime(ctx: &mut ResolveContext, provider: Provider, pid: u32) -> Option<MappedSession> {
    let cwd = ctx.cwd.as_ref()?;
    let encoded = encode_claude_cwd(&cwd.to_string_lossy());
    let dir = ctx.root.join(encoded);
    let flat_best = cached_most_recent_jsonl(&dir, ctx.cache);
    let best = flat_best.or_else(|| cached_most_recent_jsonl_recursive(&ctx.root, ctx.cache))?;
    let sid = extract_session_id_from_path(&best.0.to_string_lossy())?;
    Some(MappedSession {
        pid,
        provider: Some(provider),
        session_id: Some(sid),
        file_path: Some(best.0.to_string_lossy().to_string()),
        home: Some(ctx.home.to_string_lossy().to_string()),
        project_path: Some(cwd.to_string_lossy().to_string()),
    })
}

fn resolve_process(
    proc_pid: u32,
    proc_provider: Provider,
    proc_args: &[String],
    child_map: &HashMap<u32, Vec<u32>>,
    visited: &mut HashSet<u32>,
    cache: &mut ResolverCache,
) -> Option<MappedSession> {
    if visited.contains(&proc_pid) { return None; }
    visited.insert(proc_pid);

    let environ = read_environ(proc_pid);
    let home = resolve_agent_home(proc_provider, &environ);
    let root = session_root_for_home(proc_provider, &home);
    let cwd = read_cwd(proc_pid);

    let mut ctx = ResolveContext { environ, home, root, cwd, cache };

    // 1. fd scan first (cheap, almost always works)
    if let Some(m) = resolve_from_open_files(&mut ctx, proc_provider, proc_pid) {
        return Some(m);
    }
    // 2. --resume <uuid>
    if let Some(uuid) = extract_resume_uuid(proc_args) {
        if let Some(m) = resolve_from_resume(&mut ctx, &uuid, proc_pid, proc_provider) {
            return Some(m);
        }
    }
    // 3. process-tree BFS
    if let Some(children) = child_map.get(&proc_pid).cloned() {
        for child_pid in children {
            if visited.contains(&child_pid) { continue; }
            let child_args = match read_cmdline(child_pid) { Some(a) => a, None => continue };
            if let Some(m) = resolve_process(child_pid, proc_provider, &child_args, child_map, visited, ctx.cache) {
                return Some(m);
            }
        }
    }
    // 4. cwd + most recent jsonl
    resolve_from_cwd_mtime(&mut ctx, proc_provider, proc_pid)
}

/// Map every running claude/codex process to its session. Linux-only.
pub fn map_processes_to_sessions() -> HashMap<String, MappedSession> {
    let mut result: HashMap<String, MappedSession> = HashMap::new();
    if !is_linux() { return result; }

    let scan = scan_proc_once();
    if scan.agents.is_empty() { return result; }

    let mut cache = ResolverCache::default();
    for (pid, provider, args) in scan.agents {
        if !is_pid_alive(pid) { continue; }
        let mut visited = HashSet::new();
        if let Some(mut m) = resolve_process(pid, provider, &args, &scan.child_map, &mut visited, &mut cache) {
            if m.session_id.is_none() { continue; }
            let sid = m.session_id.clone().unwrap();
            // Fill provider/pid if not set
            if m.provider.is_none() { m.provider = Some(provider); }
            if m.pid == 0 { m.pid = pid; }
            result.entry(sid).or_insert(m);
        }
    }
    result
}

/// Resolve one launched agent process (and its descendants) to the session it
/// has opened. This is useful for wrappers like `starling run`, where we know
/// the child PID and want to annotate the session while it is still running.
pub fn map_process_tree_to_session(root_pid: u32) -> Option<MappedSession> {
    if !is_linux() || !is_pid_alive(root_pid) { return None; }
    let args = read_cmdline(root_pid)?;
    let provider = provider_from_cmdline(&args)?;
    let scan = scan_proc_once();
    let mut visited = HashSet::new();
    let mut cache = ResolverCache::default();
    resolve_process(root_pid, provider, &args, &scan.child_map, &mut visited, &mut cache)
}

pub fn map_process_tree_to_session_since(root_pid: u32, since_ms: u64) -> Option<MappedSession> {
    let mapped = map_process_tree_to_session(root_pid)?;
    let file_path = mapped.file_path.as_deref()?;
    let mtime = std::fs::metadata(file_path).ok()?
        .modified().ok()?
        .duration_since(std::time::UNIX_EPOCH).ok()?
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
        assert_eq!(env.get("CLAUDE_CONFIG_DIR").map(|s| s.as_str()), Some("/tmp/.claude"));
    }

    #[test]
    fn provider_from_cmdline_basename() {
        assert_eq!(provider_from_cmdline(&["/usr/bin/claude".into()]), Some(Provider::Claude));
        assert_eq!(provider_from_cmdline(&["/usr/bin/codex".into()]), Some(Provider::Codex));
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
    }

    #[test]
    fn extract_resume_uuid_from_cmdline() {
        let args: Vec<String> = ["claude", "--resume", "a1b2c3d4-e5f6-7890-abcd-ef1234567890"]
            .iter().map(|s| s.to_string()).collect();
        let uuid = extract_resume_uuid(&args).unwrap();
        assert_eq!(uuid, "a1b2c3d4-e5f6-7890-abcd-ef1234567890");
    }

    #[test]
    fn extract_resume_uuid_uppercase_normalized() {
        let args: Vec<String> = ["--resume", "A1B2C3D4-E5F6-7890-ABCD-EF1234567890"]
            .iter().map(|s| s.to_string()).collect();
        let uuid = extract_resume_uuid(&args).unwrap();
        assert_eq!(uuid, "a1b2c3d4-e5f6-7890-abcd-ef1234567890");
    }

    #[test]
    fn encode_claude_cwd_round_trip() {
        assert_eq!(encode_claude_cwd("/home/user/project"), "-home-user-project");
        assert_eq!(encode_claude_cwd("/"), "-");
        assert_eq!(encode_claude_cwd("/a/b/c"), "-a-b-c");
    }

    #[test]
    fn session_file_path_basics() {
        assert!(is_session_file_path("/x/y/a1b2c3d4-e5f6-7890-abcd-ef1234567890.jsonl"));
        assert!(is_session_file_path("/x/y/rollout-2026-01-01-abc.jsonl"));
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
    }

    #[test]
    fn comm_filter() {
        assert!(comm_might_be_agent("claude"));
        assert!(comm_might_be_agent("node"));
        assert!(comm_might_be_agent("bash"));
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
    }
}

// Silence unused warning when only tests use Value
#[allow(dead_code)]
fn _anchor_value() -> Value { Value::Null }
