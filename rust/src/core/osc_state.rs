//! Runtime OSC state cache.
//!
//! Terminal OSC events are an output stream, not something Starling can recover
//! from `/proc` after the fact. This cache is the shared handoff point for any
//! Starling launcher, extension terminal, or bridge that can observe those OSC
//! events in real time.

use anyhow::Result;
use serde::{Deserialize, Serialize};

use crate::constants::{default_osc_state_path, OSC_STATE_VERSION};
use crate::core::fs_utils::{atomic_write_json, read_json};

const DEFAULT_STALE_MS: u64 = 10 * 60 * 1000;
const BUSY_STALE_MS: u64 = 30 * 1000;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OscStateStore {
    pub version: u32,
    #[serde(default)]
    pub sessions: Vec<OscSessionState>,
}

impl Default for OscStateStore {
    fn default() -> Self {
        Self {
            version: OSC_STATE_VERSION,
            sessions: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OscSessionState {
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    pub source: String,
    pub updated_at_ms: u64,
}

pub fn load_osc_state() -> OscStateStore {
    read_json(&default_osc_state_path()).unwrap_or_default()
}

pub fn save_osc_state(mut store: OscStateStore) -> Result<()> {
    store.version = OSC_STATE_VERSION;
    atomic_write_json(&default_osc_state_path(), &store)
}

pub fn upsert_osc_state(state: OscSessionState) -> Result<OscStateStore> {
    let mut store = load_osc_state();
    if let Some(existing) = store.sessions.iter_mut().find(|s| same_entry(s, &state)) {
        *existing = state;
    } else {
        store.sessions.push(state);
    }
    save_osc_state(store.clone())?;
    Ok(store)
}

pub fn clear_osc_state(session_id: &str, pid: Option<u32>) -> Result<OscStateStore> {
    let mut store = load_osc_state();
    store.sessions.retain(|s| {
        if !session_matches(&s.session_id, session_id) {
            return true;
        }
        match pid {
            Some(pid) => s.pid != Some(pid),
            None => false,
        }
    });
    save_osc_state(store.clone())?;
    Ok(store)
}

pub fn prune_stale_osc_state(now_ms: u64) -> Result<OscStateStore> {
    let mut store = load_osc_state();
    store.sessions.retain(|s| is_fresh_at(s, now_ms));
    save_osc_state(store.clone())?;
    Ok(store)
}

pub fn recent_osc_state(
    session_id: &str,
    pid: Option<u32>,
    now_ms: u64,
) -> Option<OscSessionState> {
    load_osc_state()
        .sessions
        .into_iter()
        .filter(|s| session_matches(&s.session_id, session_id))
        .filter(|s| pid_match(s.pid, pid))
        .filter(|s| is_fresh_at(s, now_ms))
        .max_by_key(|s| s.updated_at_ms)
}

pub fn normalize_status(value: &str) -> Option<String> {
    let normalized = value.trim().to_ascii_lowercase().replace('_', "-");
    let status = match normalized.as_str() {
        "busy" | "executing" | "running" | "thinking" | "generating" => "running",
        "idle" => "idle",
        "wait" | "waiting" | "waiting-input" | "waiting-for-input" => "waiting",
        "permission" | "approval" | "needs-attention" | "attention" => "waiting",
        "stopped" => "stopped",
        _ => return None,
    };
    Some(status.to_string())
}

pub fn status_from_osc0_title(title: &str) -> Option<String> {
    let first = title.chars().next()?;
    let code = first as u32;
    if (0x2800..=0x28ff).contains(&code) {
        return Some("running".to_string());
    }
    if first == '\u{2733}' {
        return Some("idle".to_string());
    }
    None
}

pub fn status_from_osc_sequence(sequence: &str) -> Option<(String, String, Option<String>)> {
    let payload = osc_payload(sequence)?;
    if let Some(title) = payload
        .strip_prefix("0;")
        .or_else(|| payload.strip_prefix("2;"))
    {
        let status = status_from_osc0_title(title)?;
        return Some((status, "osc0".to_string(), Some(title.to_string())));
    }

    if let Some(rest) = payload.strip_prefix("9;4;") {
        let level = rest.split(';').next()?.parse::<u8>().ok()?;
        let status = status_from_osc94_progress(level)?;
        return Some((status, "osc9;4".to_string(), None));
    }

    if let Some(message) = payload.strip_prefix("9;") {
        let lower = message.to_ascii_lowercase();
        if lower.contains("permission")
            || lower.contains("approval")
            || lower.contains("attention")
            || lower.contains("needs your")
        {
            return Some((
                "waiting".to_string(),
                "osc9".to_string(),
                Some(message.to_string()),
            ));
        }
        if lower.contains("waiting for your input") {
            return Some((
                "waiting".to_string(),
                "osc9".to_string(),
                Some(message.to_string()),
            ));
        }
    }

    None
}

pub fn status_from_osc94_progress(level: u8) -> Option<String> {
    match level {
        1 | 2 | 3 => Some("running".to_string()),
        0 => Some("idle".to_string()),
        _ => None,
    }
}

fn osc_payload(sequence: &str) -> Option<&str> {
    let raw = sequence
        .strip_prefix("\u{1b}]")
        .or_else(|| sequence.strip_prefix("OSC "))
        .unwrap_or(sequence);
    raw.strip_suffix('\u{7}')
        .or_else(|| raw.strip_suffix("\u{1b}\\"))
        .or(Some(raw))
}

fn same_entry(a: &OscSessionState, b: &OscSessionState) -> bool {
    session_matches(&a.session_id, &b.session_id)
        && match (a.pid, b.pid) {
            (Some(a), Some(b)) => a == b,
            _ => true,
        }
}

fn session_matches(left: &str, right: &str) -> bool {
    left.eq_ignore_ascii_case(right)
        || left.to_ascii_lowercase().starts_with(&right.to_ascii_lowercase())
        || right.to_ascii_lowercase().starts_with(&left.to_ascii_lowercase())
}

fn pid_match(state_pid: Option<u32>, live_pid: Option<u32>) -> bool {
    match (state_pid, live_pid) {
        (Some(a), Some(b)) => a == b,
        (Some(_), None) => false,
        _ => true,
    }
}

fn is_fresh_at(state: &OscSessionState, now_ms: u64) -> bool {
    if state.updated_at_ms == 0 || state.updated_at_ms > now_ms.saturating_add(1000) {
        return false;
    }
    let ttl = match state.status.as_str() {
        "running" => BUSY_STALE_MS,
        _ => DEFAULT_STALE_MS,
    };
    now_ms.saturating_sub(state.updated_at_ms) <= ttl
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_switchboard_osc0_running_and_waiting() {
        assert_eq!(
            status_from_osc0_title("\u{2801} working").as_deref(),
            Some("running")
        );
        assert_eq!(
            status_from_osc0_title("\u{2733} ready").as_deref(),
            Some("idle")
        );
        assert_eq!(status_from_osc0_title("plain"), None);
    }

    #[test]
    fn normalizes_attention_aliases() {
        assert_eq!(
            normalize_status("needs_attention").as_deref(),
            Some("waiting")
        );
        assert_eq!(
            normalize_status("waiting-for-input").as_deref(),
            Some("waiting")
        );
        assert_eq!(normalize_status("unknown"), None);
    }

    #[test]
    fn parses_raw_osc_sequences() {
        assert_eq!(
            status_from_osc_sequence("\u{1b}]0;\u{2801} running\u{7}")
                .map(|s| s.0)
                .as_deref(),
            Some("running")
        );
        assert_eq!(
            status_from_osc_sequence("\u{1b}]9;4;1;0\u{7}")
                .map(|s| s.0)
                .as_deref(),
            Some("running")
        );
    }
}
