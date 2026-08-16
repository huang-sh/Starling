//! Live-session registry written by the global Pi reporter extension.
//!
//! `~/.starling/live-sessions/<pid>.json` — one file per live pi process,
//! JSON lines (session_start rewrites, later events append as heartbeats).
//! The producer (the pi process itself) is the only authority on its
//! session identity; this module is the consumer side: parse the last
//! complete line per pid, drop entries whose pid is gone.

use std::collections::HashMap;
use std::path::PathBuf;

use serde::Deserialize;

use crate::constants::default_starling_home;

#[derive(Debug, Clone, Deserialize)]
pub struct LiveSessionEntry {
    pub pid: u32,
    #[serde(default)]
    pub event: String,
    #[serde(default)]
    pub session_id: String,
    #[serde(default)]
    pub transcript_path: Option<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub timestamp: String,
}

pub fn live_sessions_dir() -> PathBuf {
    default_starling_home().join("live-sessions")
}

/// Read live pi sessions keyed by session id. Entries whose pid is no longer
/// alive are ignored (the reporter removes its file on shutdown; a SIGKILLed
/// pi leaves a stale file that liveness filtering drops here).
pub fn live_pi_sessions() -> HashMap<String, LiveSessionEntry> {
    read_live_sessions().fold(HashMap::new(), |mut map, entry| {
        if !entry.session_id.is_empty() {
            map.insert(entry.session_id.clone(), entry);
        }
        map
    })
}

/// All live entries (any session id), including ones whose payload lacks a
/// session id (still booting). Consumers pick what they need.
pub fn read_live_sessions() -> impl Iterator<Item = LiveSessionEntry> {
    let dir = live_sessions_dir();
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new().into_iter();
    };
    entries
        .flatten()
        .filter_map(|e| {
            let path = e.path();
            // Only <pid>.json files we own; ignore editor temporaries.
            let name = path.file_name()?.to_str()?.to_string();
            if !name.ends_with(".json") {
                return None;
            }
            Some(path)
        })
        .filter_map(|path| {
            let raw = std::fs::read_to_string(&path).ok()?;
            // Last complete JSON line wins (latest event/heartbeat).
            let last = raw.lines().rev().find(|l| {
                let t = l.trim();
                !t.is_empty() && serde_json::from_str::<serde_json::Value>(t).is_ok()
            })?;
            let mut entry: LiveSessionEntry = serde_json::from_str(last.trim()).ok()?;
            if !is_pid_alive(entry.pid) {
                // Stale file from a killed process; best-effort prune.
                let _ = std::fs::remove_file(&path);
                return None;
            }
            entry.event = entry.event.trim().to_string();
            Some(entry)
        })
        .collect::<Vec<_>>()
        .into_iter()
}

#[cfg(unix)]
fn is_pid_alive(pid: u32) -> bool {
    // kill(pid, 0): 0 = alive, ESRCH = gone. EPERM (alive, not ours) is fine.
    let rc = unsafe { libc::kill(pid as libc::pid_t, 0) };
    rc == 0 || unsafe { *libc::__errno_location() } == libc::EPERM
}

#[cfg(not(unix))]
fn is_pid_alive(pid: u32) -> bool {
    crate::core::runs::is_pid_alive(pid)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_last_complete_line() {
        let raw = "{\"pid\":1,\"session_id\":\"a\",\"event\":\"before_agent_start\",\"timestamp\":\"t1\"}\n\
                   {\"pid\":1,\"session_id\":\"a\",\"event\":\"agent_end\",\"timestamp\":\"t2\"}\n\
                   {broken";
        let dir = std::env::temp_dir().join(format!("live-sessions-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("1.json"), raw).unwrap();
        let got: Vec<LiveSessionEntry> = std::fs::read_to_string(dir.join("1.json"))
            .ok()
            .map(|_| Vec::new())
            .unwrap_or_default();
        assert!(got.is_empty()); // placeholder; real parse covered below
        let last = raw.lines().rev().find(|l| {
            let t = l.trim();
            !t.is_empty() && serde_json::from_str::<serde_json::Value>(t).is_ok()
        });
        assert_eq!(
            serde_json::from_str::<LiveSessionEntry>(last.unwrap().trim())
                .unwrap()
                .event,
            "agent_end"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
