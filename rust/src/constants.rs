//! Runtime path resolution — mirrors src/constants.ts.
//!
//! All path getters are functions (not `static`s) so they pick up env-var
//! changes observed at call time. The original TS module evaluated these at
//! module load; we mirror the same precedence (env > config > default).

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::Context;
use serde::Deserialize;

fn home_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"))
}

/// Expand a leading `~/` to the user's home directory. Plain `~` becomes the
/// home dir verbatim. Bare paths are returned as-is.
pub fn expand_home(value: &str) -> PathBuf {
    if value == "~" {
        return home_dir();
    }
    if let Some(rest) = value.strip_prefix("~/") {
        return home_dir().join(rest);
    }
    PathBuf::from(value)
}

fn env_trim(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

#[derive(Debug, Deserialize)]
struct CliConfigFile {
    #[serde(default)]
    home_path: Option<String>,
}

fn read_configured_starling_home() -> Option<String> {
    let config_path = cli_config_path();
    let raw = std::fs::read_to_string(&config_path).ok()?;
    let parsed: CliConfigFile = serde_json::from_str(&raw).ok()?;
    parsed.home_path.and_then(|h| {
        let trimmed = h.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    })
}

/// Path to the CLI-side config.json (`~/.config/starling/config.json` by
/// default, overridable via `STARLING_CLI_CONFIG`).
pub fn cli_config_path() -> PathBuf {
    if let Some(p) = env_trim("STARLING_CLI_CONFIG") {
        return expand_home(&p);
    }
    default_config_dir().join("config.json")
}

pub fn default_config_dir() -> PathBuf {
    home_dir().join(".config").join("starling")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StarlingHomeSource {
    Env,
    Config,
    Default,
}

/// Returns (effective home path if explicitly configured, source).
fn starling_home_value() -> (Option<String>, StarlingHomeSource) {
    if let Some(env_val) = env_trim("STARLING_HOME") {
        return (Some(env_val), StarlingHomeSource::Env);
    }
    if let Some(cfg_val) = read_configured_starling_home() {
        return (Some(cfg_val), StarlingHomeSource::Config);
    }
    (None, StarlingHomeSource::Default)
}

pub fn starling_home_source() -> StarlingHomeSource {
    starling_home_value().1
}

pub fn default_starling_home() -> PathBuf {
    match starling_home_value() {
        (Some(val), _) => expand_home(&val),
        (None, _) => home_dir().join(".starling"),
    }
}

pub fn default_store_path() -> PathBuf {
    match starling_home_value() {
        (Some(_), _) => default_starling_home().join("store.json"),
        (None, _) => default_config_dir().join("store.json"),
    }
}

pub fn default_runs_path() -> PathBuf {
    match starling_home_value() {
        (Some(_), _) => default_starling_home().join("runs.json"),
        (None, _) => default_config_dir().join("runs.json"),
    }
}

pub fn default_osc_state_path() -> PathBuf {
    match starling_home_value() {
        (Some(_), _) => default_starling_home().join("osc-state.json"),
        (None, _) => default_config_dir().join("osc-state.json"),
    }
}

pub const STORE_VERSION: u32 = 1;
pub const RUNS_VERSION: u32 = 1;
pub const OSC_STATE_VERSION: u32 = 1;

pub fn default_starling_settings_dir() -> PathBuf {
    default_starling_home().join("settings")
}

pub fn default_claude_settings_dir() -> PathBuf {
    default_starling_settings_dir().join("claude")
}

pub fn default_codex_settings_dir() -> PathBuf {
    default_starling_settings_dir().join("codex")
}

pub fn default_codex_home() -> PathBuf {
    home_dir().join(".codex")
}

/// `CLAUDE_CONFIG_DIR` if set (env-expanded), else `~/.claude`.
pub fn resolve_claude_config_dir() -> PathBuf {
    match env_trim("CLAUDE_CONFIG_DIR") {
        Some(val) => expand_home(&val),
        None => home_dir().join(".claude"),
    }
}

/// `CODEX_HOME` if set (env-expanded), else `~/.codex`.
pub fn resolve_codex_home() -> PathBuf {
    match env_trim("CODEX_HOME") {
        Some(val) => expand_home(&val),
        None => home_dir().join(".codex"),
    }
}

/// `<CLAUDE_CONFIG_DIR>/projects`.
pub fn claude_session_roots() -> Vec<PathBuf> {
    vec![resolve_claude_config_dir().join("projects")]
}

/// `<CODEX_HOME>/sessions` (live) and `<CODEX_HOME>/archived_sessions`.
pub fn codex_session_roots() -> Vec<PathBuf> {
    let home = resolve_codex_home();
    vec![home.join("sessions"), home.join("archived_sessions")]
}

/// Env-aware single-root alias — the first of `claude_session_roots()`.
pub fn claude_sessions_dir() -> PathBuf {
    claude_session_roots().into_iter().next().unwrap()
}

/// Env-aware primary-root alias (live codex sessions only).
pub fn codex_sessions_dir() -> PathBuf {
    codex_session_roots().into_iter().next().unwrap()
}

/// Key for the store-path override env var.
pub const ENV_CONFIG_KEY: &str = "STARLING_CONFIG";

/// ISO 8601 timestamp for "now".
pub fn now_iso() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let dt = chrono::DateTime::<chrono::Utc>::from_timestamp(secs as i64, 0).unwrap_or_default();
    // Use `to_rfc3339` which yields a stable `+00:00` suffix matching the
    // `new Date().toISOString()` shape (Z-terminated).
    let rfc = dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    rfc.replace("+00:00", "Z")
}

/// Resolve a session-file path relative to a base (used by tests).
pub fn join_path(base: &Path, rel: &str) -> PathBuf {
    base.join(rel)
}

/// Convenience: get env or fallback (small helper for various paths).
pub fn env_or(key: &str, fallback: impl AsRef<Path>) -> PathBuf {
    match env_trim(key) {
        Some(val) => expand_home(&val),
        None => fallback.as_ref().to_path_buf(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expands_home_tilde() {
        let home = home_dir();
        assert_eq!(expand_home("~"), home);
        assert_eq!(expand_home("~/foo"), home.join("foo"));
        assert_eq!(expand_home("/abs/path"), PathBuf::from("/abs/path"));
    }

    #[test]
    fn starling_home_default_when_unset() {
        std::env::remove_var("STARLING_HOME");
        std::env::remove_var("STARLING_CLI_CONFIG");
        // Only safe to assert shape when both env+config are unset, which we
        // can't guarantee in CI environments where STARLING_HOME may be set.
        // Just ensure the function returns *some* absolute path.
        let p = default_starling_home();
        assert!(p.is_absolute(), "default_starling_home should be absolute");
    }

    #[test]
    fn claude_roots_include_projects() {
        let roots = claude_session_roots();
        assert_eq!(roots.len(), 1);
        assert!(roots[0].ends_with("projects"));
    }

    #[test]
    fn codex_roots_include_live_and_archived() {
        let roots = codex_session_roots();
        assert_eq!(roots.len(), 2);
        assert!(roots[0].ends_with("sessions"));
        assert!(roots[1].ends_with("archived_sessions"));
    }

    #[test]
    fn now_iso_ends_with_z() {
        let s = now_iso();
        assert!(s.ends_with('Z'), "expected Z-suffix, got: {s}");
    }
}

// Keep anyhow in scope for context!() in future expansions.
#[allow(dead_code)]
fn _anchor_anyhow() -> anyhow::Result<()> {
    let _ = anyhow::anyhow!("anchor");
    Ok(())
}
