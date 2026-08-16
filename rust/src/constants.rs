//! Runtime path resolution — mirrors src/constants.ts.
//!
//! All path getters are functions (not `static`s) so they pick up env-var
//! changes observed at call time. The original TS module evaluated these at
//! module load; we mirror the same precedence (env > config > default).

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Deserialize;

fn home_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"))
}

/// Expand a leading `~/` to the user's home directory. Plain `~` becomes the
/// home dir verbatim. Bare paths are returned as-is.
pub fn expand_home(value: &str) -> PathBuf {
    expand_home_from(value, &home_dir(), cfg!(windows))
}

fn expand_home_from(value: &str, home: &Path, windows: bool) -> PathBuf {
    if value == "~" {
        return home.to_path_buf();
    }
    if let Some(rest) = value.strip_prefix("~/") {
        return home.join(rest);
    }
    if windows {
        if let Some(rest) = value.strip_prefix("~\\") {
            return home.join(rest);
        }
    }
    PathBuf::from(value)
}

fn percent_decode_file_url_path(value: &str, windows: bool) -> Option<String> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'%' {
            decoded.push(bytes[index]);
            index += 1;
            continue;
        }
        let high = *bytes.get(index + 1)?;
        let low = *bytes.get(index + 2)?;
        let hex = |byte: u8| match byte {
            b'0'..=b'9' => Some(byte - b'0'),
            b'a'..=b'f' => Some(byte - b'a' + 10),
            b'A'..=b'F' => Some(byte - b'A' + 10),
            _ => None,
        };
        let byte = hex(high)? * 16 + hex(low)?;
        // Node rejects encoded `/` on every platform and encoded `\\` only
        // when it is a Windows path separator. On POSIX a backslash is an
        // ordinary filename character.
        if byte == b'/' || (windows && byte == b'\\') {
            return None;
        }
        decoded.push(byte);
        index += 3;
    }
    String::from_utf8(decoded).ok()
}

fn pi_file_url_to_path(value: &str, windows: bool) -> Option<PathBuf> {
    let remainder = value.strip_prefix("file://")?;
    let end = remainder.find(['?', '#']).unwrap_or(remainder.len());
    let remainder = &remainder[..end];
    let (authority, url_path) = if remainder.starts_with('/') {
        ("", remainder)
    } else {
        let slash = remainder.find('/')?;
        (&remainder[..slash], &remainder[slash..])
    };
    let decoded = percent_decode_file_url_path(url_path, windows)?;

    if windows {
        if !authority.is_empty() && !authority.eq_ignore_ascii_case("localhost") {
            return Some(PathBuf::from(format!(
                r"\\{}\{}",
                authority,
                decoded.trim_start_matches('/').replace('/', r"\")
            )));
        }
        let drive_path = decoded
            .strip_prefix('/')
            .filter(|path| path.as_bytes().get(1) == Some(&b':'))
            .unwrap_or(&decoded);
        return Some(PathBuf::from(drive_path.replace('/', r"\")));
    }

    if !authority.is_empty() && !authority.eq_ignore_ascii_case("localhost") {
        return None;
    }
    Some(PathBuf::from(decoded))
}

/// Pi's `normalizePath()` expands home-relative paths and converts `file://`
/// URLs with Node's `fileURLToPath()` semantics.
pub fn normalize_pi_path_input(value: &str) -> PathBuf {
    if value.starts_with("file://") {
        if let Some(path) = pi_file_url_to_path(value, cfg!(windows)) {
            return path;
        }
    }
    expand_home(value)
}

#[cfg(any(windows, test))]
fn strip_windows_verbatim_prefix(value: &str) -> String {
    if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    value.strip_prefix(r"\\?\").unwrap_or(value).to_string()
}

/// Convert Rust's Windows `canonicalize()` representation to the ordinary
/// drive/UNC spelling returned by Node's `process.cwd()` and `path.resolve()`.
/// Other platforms are unchanged.
pub fn pi_node_compatible_path(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        return PathBuf::from(strip_windows_verbatim_prefix(&path.to_string_lossy()));
    }
    #[cfg(not(windows))]
    {
        path.to_path_buf()
    }
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
    #[serde(default, rename = "piPath", alias = "pi_path")]
    pi_path: Option<String>,
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

fn read_configured_pi_path() -> Option<String> {
    let raw = std::fs::read_to_string(cli_config_path()).ok()?;
    let parsed: CliConfigFile = serde_json::from_str(&raw).ok()?;
    parsed.pi_path.and_then(non_empty_owned)
}

fn non_empty_owned(value: String) -> Option<String> {
    let trimmed = value.trim().to_string();
    (!trimmed.is_empty()).then_some(trimmed)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PiExecutableSource {
    ExplicitEnv,
    Config,
    BundledEnv,
    Path,
}

/// Complete process specification for invoking Pi.
///
/// External Pi installations are normal executables and therefore have no
/// prefix arguments. The npm-bundled Pi is a JavaScript entry point, so it is
/// always launched as `node <cli.js> ...`. Keeping the two pieces structured
/// avoids relying on platform-specific shebang handling (notably on Windows).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PiExecutable {
    pub program: PathBuf,
    pub prefix_args: Vec<String>,
    /// User-facing Pi CLI path. For a bundled runtime this is `cli.js`, not the
    /// Node executable used to launch it.
    pub cli_path: PathBuf,
}

impl PiExecutable {
    fn external(path: PathBuf) -> Self {
        Self {
            program: path.clone(),
            prefix_args: Vec::new(),
            cli_path: path,
        }
    }

    fn bundled(node: PathBuf, cli_path: PathBuf) -> Self {
        Self {
            program: node,
            prefix_args: vec![cli_path.to_string_lossy().to_string()],
            cli_path,
        }
    }

    /// Create a command with the runtime prefix already applied. Callers add
    /// only Pi's own CLI arguments after this point.
    pub fn command(&self) -> std::process::Command {
        let mut command = std::process::Command::new(&self.program);
        command.args(&self.prefix_args);
        command
    }
}

fn resolve_pi_executable_from_sources(
    explicit: Option<&str>,
    configured: Option<&str>,
    bundled: Option<&str>,
    bundled_node: Option<&str>,
) -> (PiExecutable, PiExecutableSource) {
    let candidate = |value: Option<&str>| {
        value
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(expand_home)
    };
    if let Some(path) = candidate(explicit) {
        return (
            PiExecutable::external(path),
            PiExecutableSource::ExplicitEnv,
        );
    }
    if let Some(path) = candidate(configured) {
        return (PiExecutable::external(path), PiExecutableSource::Config);
    }
    if let Some(path) = candidate(bundled) {
        let executable = if let Some(node) = candidate(bundled_node) {
            PiExecutable::bundled(node, path)
        } else {
            // Compatibility with npm launchers from before the structured
            // Node + entry-point contract was introduced.
            PiExecutable::external(path)
        };
        return (executable, PiExecutableSource::BundledEnv);
    }
    (
        PiExecutable::external(PathBuf::from("pi")),
        PiExecutableSource::Path,
    )
}

/// Resolve the Pi executable used by every Starling-managed Pi invocation.
/// Explicit user configuration always wins over the npm wrapper's bundled Pi.
pub fn resolve_pi_executable_with_source() -> (PiExecutable, PiExecutableSource) {
    let explicit = env_trim("STARLING_PI_BIN");
    let configured = read_configured_pi_path();
    let bundled = env_trim("STARLING_BUNDLED_PI_BIN");
    let bundled_node = env_trim("STARLING_BUNDLED_PI_NODE");
    resolve_pi_executable_from_sources(
        explicit.as_deref(),
        configured.as_deref(),
        bundled.as_deref(),
        bundled_node.as_deref(),
    )
}

pub fn resolve_pi_executable() -> PiExecutable {
    resolve_pi_executable_with_source().0
}

/// Complete process specification for Starling's Pi SDK host.
///
/// Unlike [`PiExecutable`], this is not a Pi CLI fallback. The host is
/// Starling-owned JavaScript which imports the Pi SDK directly, and it must
/// always be launched by the explicitly configured Node executable.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PiSdkHost {
    pub node: PathBuf,
    pub host_path: PathBuf,
}

impl PiSdkHost {
    /// Create a command with the Starling SDK host entry point already added.
    /// Callers append only the host's own arguments after this point.
    pub fn command(&self) -> std::process::Command {
        let mut command = std::process::Command::new(&self.node);
        command.arg(&self.host_path);
        command
    }
}

fn resolve_pi_sdk_host_from_sources(
    host: Option<&str>,
    node: Option<&str>,
) -> anyhow::Result<PiSdkHost> {
    let host = host
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            anyhow::anyhow!(
                "Pi SDK unavailable: STARLING_PI_SDK_HOST is not set; install or configure Starling's Pi SDK host"
            )
        })?;
    let node = node
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            anyhow::anyhow!(
                "Pi SDK unavailable: STARLING_PI_SDK_NODE is not set; configure a Node >=22.19 executable"
            )
        })?;

    let host_path = expand_home(host);
    if !host_path.is_absolute() {
        anyhow::bail!(
            "Pi SDK unavailable: STARLING_PI_SDK_HOST must be an absolute path (got {})",
            host_path.display()
        );
    }
    if !host_path.is_file() {
        anyhow::bail!(
            "Pi SDK unavailable: STARLING_PI_SDK_HOST does not point to a file: {}",
            host_path.display()
        );
    }

    let node = expand_home(node);
    if node.is_absolute() && !node.is_file() {
        anyhow::bail!(
            "Pi SDK unavailable: STARLING_PI_SDK_NODE does not point to an executable file: {}",
            node.display()
        );
    }

    Ok(PiSdkHost { node, host_path })
}

/// Resolve the Starling-owned Node host which embeds the Pi SDK.
///
/// Both variables are deliberately required. `starling chat pi` must never
/// silently fall back to spawning the Pi CLI or `pi --mode rpc`.
pub fn resolve_pi_sdk_host() -> anyhow::Result<PiSdkHost> {
    let host = env_trim("STARLING_PI_SDK_HOST");
    let node = env_trim("STARLING_PI_SDK_NODE");
    resolve_pi_sdk_host_from_sources(host.as_deref(), node.as_deref())
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

pub fn default_mcp_config_path() -> PathBuf {
    default_starling_home().join("mcp.json")
}

pub const STORE_VERSION: u32 = 1;
pub const RUNS_VERSION: u32 = 1;
pub const OSC_STATE_VERSION: u32 = 1;
pub const MCP_CONFIG_VERSION: u32 = 1;

pub fn default_starling_settings_dir() -> PathBuf {
    default_starling_home().join("settings")
}

pub fn default_claude_settings_dir() -> PathBuf {
    default_starling_settings_dir().join("claude")
}

pub fn default_codex_settings_dir() -> PathBuf {
    default_starling_settings_dir().join("codex")
}

pub fn default_pi_settings_dir() -> PathBuf {
    default_starling_settings_dir().join("pi")
}

pub fn default_codex_home() -> PathBuf {
    // Delegate so CODEX_HOME is honored everywhere; the previous hard-coded
    // ~/.codex made runs ignore a customized Codex home entirely.
    resolve_codex_home()
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

/// `PI_CODING_AGENT_DIR` if set, else `~/.pi/agent`.
pub fn resolve_pi_agent_dir() -> PathBuf {
    match std::env::var("PI_CODING_AGENT_DIR")
        .ok()
        .filter(|value| !value.is_empty())
    {
        Some(val) => normalize_pi_path_input(&val),
        None => home_dir().join(".pi").join("agent"),
    }
}

#[derive(Debug, Deserialize)]
struct PiSettingsFile {
    #[serde(rename = "sessionDir")]
    session_dir: Option<String>,
}

/// Pi's effective session root. Mirrors Pi's precedence for process-wide
/// settings: `PI_CODING_AGENT_SESSION_DIR`, then `settings.json#sessionDir`,
/// then `<PI_CODING_AGENT_DIR>/sessions`.
///
/// Pi also accepts a per-launch `--session-dir`; Starling accounts for that
/// while preparing/observing a managed launch rather than treating it as a
/// global discovery root.
pub fn resolve_pi_session_root() -> PathBuf {
    if let Some(val) = std::env::var("PI_CODING_AGENT_SESSION_DIR")
        .ok()
        .filter(|value| !value.is_empty())
    {
        return normalize_pi_path_input(&val);
    }

    let agent_dir = resolve_pi_agent_dir();
    let settings_path = agent_dir.join("settings.json");
    if let Ok(raw) = std::fs::read_to_string(settings_path) {
        if let Ok(settings) = serde_json::from_str::<PiSettingsFile>(&raw) {
            if let Some(value) = settings.session_dir.filter(|value| !value.is_empty()) {
                return normalize_pi_path_input(&value);
            }
        }
    }
    agent_dir.join("sessions")
}

/// The directories and cwd-filtering rules Pi uses for a concrete launch.
///
/// With no configured `sessionDir`, Pi stores the current project's sessions
/// in an encoded child of `<agent-dir>/sessions` and `listAll()` scans each
/// immediate project child. With any configured `sessionDir`, both local and
/// all-project listing scan that directory directly. Pi only filters local
/// results by header cwd when the configured directory string differs from the
/// default encoded directory.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PiLaunchSessionLayout {
    pub session_root: PathBuf,
    pub local_dir: PathBuf,
    pub configured: bool,
    pub filter_local_cwd: bool,
}

pub fn resolve_pi_session_layout_for_launch(
    cwd: &Path,
    cli_session_dir: Option<&str>,
) -> PiLaunchSessionLayout {
    let agent_dir = resolve_pi_agent_dir();
    let env_session_dir = std::env::var("PI_CODING_AGENT_SESSION_DIR")
        .ok()
        .filter(|value| !value.is_empty());
    resolve_pi_session_layout_from_sources(
        cwd,
        cli_session_dir,
        env_session_dir.as_deref(),
        &agent_dir,
    )
}

fn pi_encoded_cwd(cwd: &Path) -> String {
    let value = cwd.to_string_lossy();
    let without_leading_separator = value
        .strip_prefix('/')
        .or_else(|| value.strip_prefix('\\'))
        .unwrap_or(&value);
    let safe = without_leading_separator.replace(['/', '\\', ':'], "-");
    format!("--{safe}--")
}

fn normalize_path_components(path: &Path) -> PathBuf {
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

fn resolve_pi_session_layout_from_sources(
    cwd: &Path,
    cli_session_dir: Option<&str>,
    env_session_dir: Option<&str>,
    agent_dir: &Path,
) -> PiLaunchSessionLayout {
    let launch_cwd = if cwd.is_absolute() {
        cwd.to_path_buf()
    } else {
        std::env::current_dir()
            .map(|current| current.join(cwd))
            .unwrap_or_else(|_| cwd.to_path_buf())
    };
    let launch_cwd = normalize_path_components(&pi_node_compatible_path(&launch_cwd));
    let resolved_agent_dir = if agent_dir.is_absolute() {
        agent_dir.to_path_buf()
    } else {
        launch_cwd.join(agent_dir)
    };
    let resolved_agent_dir = normalize_path_components(&resolved_agent_dir);
    let default_root = resolved_agent_dir.join("sessions");
    let default_local_dir = default_root.join(pi_encoded_cwd(&launch_cwd));

    let configured_value = resolve_pi_session_value_from_sources(
        &launch_cwd,
        cli_session_dir,
        env_session_dir,
        &resolved_agent_dir,
    );
    let Some(configured_value) = configured_value else {
        return PiLaunchSessionLayout {
            session_root: default_root,
            local_dir: default_local_dir,
            configured: false,
            filter_local_cwd: false,
        };
    };

    // `normalizePath()` expands `~` but does not make a relative path absolute.
    // Preserve that representation for Pi's filterCwd comparison, while using
    // the launch cwd to obtain the physical directory Starling must scan.
    let normalized_configured = normalize_pi_path_input(&configured_value);
    // Pi compares these as JavaScript strings, not as normalized filesystem
    // paths. Preserve spelling differences such as a trailing separator: they
    // intentionally enable header-cwd filtering in Pi.
    let filter_local_cwd = normalized_configured.as_os_str() != default_local_dir.as_os_str();
    let session_root = if normalized_configured.is_absolute() {
        normalized_configured
    } else {
        launch_cwd.join(normalized_configured)
    };
    PiLaunchSessionLayout {
        local_dir: session_root.clone(),
        session_root,
        configured: true,
        filter_local_cwd,
    }
}

fn resolve_pi_session_value_from_sources(
    cwd: &Path,
    cli_session_dir: Option<&str>,
    env_session_dir: Option<&str>,
    agent_dir: &Path,
) -> Option<String> {
    // `Some(None)` means the file explicitly clears sessionDir with an empty
    // or non-string value. Pi deep-merges project settings over global settings,
    // so that must not fall through to the global value.
    let setting_at = |path: &Path| -> Option<Option<String>> {
        let raw = std::fs::read_to_string(path).ok()?;
        let settings = serde_json::from_str::<serde_json::Value>(&raw).ok()?;
        let object = settings.as_object()?;
        let value = object.get("sessionDir")?;
        Some(
            value
                .as_str()
                .filter(|value| !value.is_empty())
                .map(str::to_string),
        )
    };
    if let Some(value) = cli_session_dir.filter(|value| !value.is_empty()) {
        return Some(value.to_string());
    }
    if let Some(value) = env_session_dir.filter(|value| !value.is_empty()) {
        return Some(value.to_string());
    }
    if let Some(project_value) = setting_at(&cwd.join(".pi/settings.json")) {
        return project_value;
    }
    setting_at(&agent_dir.join("settings.json")).flatten()
}

/// `<CLAUDE_CONFIG_DIR>/projects`.
pub fn claude_session_roots() -> Vec<PathBuf> {
    vec![resolve_claude_config_dir().join("projects")]
}

/// `<CODEX_HOME>/sessions` (live) and `<CODEX_HOME>/archived_sessions`.
pub fn codex_session_roots() -> Vec<PathBuf> {
    let home = resolve_codex_home();
    let mut roots = vec![home.join("sessions"), home.join("archived_sessions")];

    // Older `starling run codex` versions launched Codex with a fully isolated
    // CODEX_HOME under Starling's run-homes directory. Those sessions remain
    // discoverable; new run-homes symlink their session dirs back to ~/.codex.
    let run_homes = default_starling_home().join("run-homes");
    if let Ok(entries) = std::fs::read_dir(run_homes) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let Some(name) = path.file_name().and_then(|s| s.to_str()) else {
                continue;
            };
            if !name.starts_with("codex-") {
                continue;
            }
            for session_dir in [path.join("sessions"), path.join("archived_sessions")] {
                let is_symlink = std::fs::symlink_metadata(&session_dir)
                    .map(|metadata| metadata.file_type().is_symlink())
                    .unwrap_or(false);
                if !is_symlink {
                    roots.push(session_dir);
                }
            }
        }
    }

    roots
}

/// Pi stores one encoded-cwd directory beneath this root by default. A custom
/// `sessionDir` is itself the root and may contain session files directly, so
/// consumers must scan recursively and also accept flat JSONL files.
pub fn pi_session_roots() -> Vec<PathBuf> {
    vec![resolve_pi_session_root()]
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
        assert_eq!(
            expand_home_from(r"~\foo", Path::new(r"C:\Users\tester"), true),
            PathBuf::from(r"C:\Users\tester").join("foo")
        );
        assert_eq!(
            expand_home_from(r"~\foo", Path::new("/home/tester"), false),
            PathBuf::from(r"~\foo")
        );
    }

    #[test]
    fn pi_executable_sources_follow_documented_precedence() {
        let resolved = resolve_pi_executable_from_sources(
            Some(" /explicit/pi "),
            Some("/configured/pi"),
            Some("/bundled/pi"),
            Some("/node"),
        );
        assert_eq!(resolved.0.program, PathBuf::from("/explicit/pi"));
        assert!(resolved.0.prefix_args.is_empty());
        assert_eq!(resolved.0.cli_path, PathBuf::from("/explicit/pi"));
        assert_eq!(resolved.1, PiExecutableSource::ExplicitEnv);

        let resolved = resolve_pi_executable_from_sources(
            Some("  "),
            Some("/configured/pi"),
            Some("/bundled/pi"),
            Some("/node"),
        );
        assert_eq!(resolved.0.program, PathBuf::from("/configured/pi"));
        assert!(resolved.0.prefix_args.is_empty());
        assert_eq!(resolved.1, PiExecutableSource::Config);

        let resolved = resolve_pi_executable_from_sources(
            None,
            None,
            Some("/bundled/dist/cli.js"),
            Some("/runtime/node"),
        );
        assert_eq!(resolved.0.program, PathBuf::from("/runtime/node"));
        assert_eq!(
            resolved.0.prefix_args,
            vec!["/bundled/dist/cli.js".to_string()]
        );
        assert_eq!(resolved.0.cli_path, PathBuf::from("/bundled/dist/cli.js"));
        let command = resolved.0.command();
        assert_eq!(command.get_program(), std::ffi::OsStr::new("/runtime/node"));
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            vec![std::ffi::OsStr::new("/bundled/dist/cli.js")]
        );
        assert_eq!(resolved.1, PiExecutableSource::BundledEnv);

        let resolved = resolve_pi_executable_from_sources(None, None, Some("/legacy/pi"), None);
        assert_eq!(resolved.0.program, PathBuf::from("/legacy/pi"));
        assert!(resolved.0.prefix_args.is_empty());
        assert_eq!(resolved.1, PiExecutableSource::BundledEnv);

        let resolved = resolve_pi_executable_from_sources(None, None, None, Some("/node"));
        assert_eq!(resolved.0.program, PathBuf::from("pi"));
        assert!(resolved.0.prefix_args.is_empty());
        assert_eq!(resolved.1, PiExecutableSource::Path);
    }

    #[test]
    fn pi_sdk_host_requires_explicit_host_and_node_without_cli_fallback() {
        let missing_host = resolve_pi_sdk_host_from_sources(None, Some("node")).unwrap_err();
        assert!(missing_host.to_string().contains("Pi SDK unavailable"));
        assert!(missing_host.to_string().contains("STARLING_PI_SDK_HOST"));

        let missing_node =
            resolve_pi_sdk_host_from_sources(Some("/tmp/starling-sdk-host.js"), None).unwrap_err();
        assert!(missing_node.to_string().contains("Pi SDK unavailable"));
        assert!(missing_node.to_string().contains("STARLING_PI_SDK_NODE"));
    }

    #[test]
    fn pi_sdk_host_command_is_node_followed_by_the_absolute_host() {
        let root = std::env::temp_dir().join(format!(
            "starling-sdk-host-constants-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let host_path = root.join("host.js");
        std::fs::write(&host_path, "// test host\n").unwrap();

        let resolved = resolve_pi_sdk_host_from_sources(
            Some(host_path.to_string_lossy().as_ref()),
            Some("node"),
        )
        .unwrap();
        let command = resolved.command();
        assert_eq!(command.get_program(), std::ffi::OsStr::new("node"));
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            vec![host_path.as_os_str()]
        );

        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn strips_windows_verbatim_paths_for_pi_node_compatibility() {
        assert_eq!(
            strip_windows_verbatim_prefix(r"\\?\C:\work\project"),
            r"C:\work\project"
        );
        assert_eq!(
            strip_windows_verbatim_prefix(r"\\?\UNC\server\share\project"),
            r"\\server\share\project"
        );
    }

    #[test]
    fn converts_pi_file_urls_for_unix_and_windows() {
        assert_eq!(
            pi_file_url_to_path("file:///tmp/pi%20sessions/a.jsonl", false),
            Some(PathBuf::from("/tmp/pi sessions/a.jsonl"))
        );
        assert_eq!(
            pi_file_url_to_path("file:///C:/Users/test/pi%20sessions", true),
            Some(PathBuf::from(r"C:\Users\test\pi sessions"))
        );
        assert_eq!(
            pi_file_url_to_path("file://server/share/pi.jsonl", true),
            Some(PathBuf::from(r"\\server\share\pi.jsonl"))
        );
        assert_eq!(
            pi_file_url_to_path("file:///tmp/pi%5Csessions", false),
            Some(PathBuf::from(r"/tmp/pi\sessions"))
        );
        assert_eq!(
            pi_file_url_to_path("file:///tmp/pi%2Fsessions", false),
            None
        );
        assert_eq!(pi_file_url_to_path("file:///C:/pi%5Csessions", true), None);
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
        assert!(roots.len() >= 2);
        assert!(roots[0].ends_with("sessions"));
        assert!(roots[1].ends_with("archived_sessions"));
    }

    #[test]
    fn pi_root_is_a_sessions_directory_by_default() {
        if std::env::var_os("PI_CODING_AGENT_DIR").is_none()
            && std::env::var_os("PI_CODING_AGENT_SESSION_DIR").is_none()
            && !home_dir().join(".pi/agent/settings.json").exists()
        {
            assert!(resolve_pi_session_root().ends_with(".pi/agent/sessions"));
        }
    }

    #[test]
    fn pi_launch_root_prefers_project_local_session_dir() {
        let root = std::env::temp_dir().join(format!(
            "starling-pi-project-settings-{}",
            uuid::Uuid::new_v4()
        ));
        let project = root.join("project");
        let agent = root.join("agent");
        std::fs::create_dir_all(project.join(".pi")).unwrap();
        std::fs::create_dir_all(&agent).unwrap();
        std::fs::write(
            project.join(".pi/settings.json"),
            r#"{"sessionDir":"project-sessions"}"#,
        )
        .unwrap();
        std::fs::write(
            agent.join("settings.json"),
            r#"{"sessionDir":"global-sessions"}"#,
        )
        .unwrap();

        let resolved = resolve_pi_session_layout_from_sources(&project, None, None, &agent);

        assert_eq!(resolved.session_root, project.join("project-sessions"));
        assert_eq!(resolved.local_dir, project.join("project-sessions"));
        assert!(resolved.configured);
        assert!(resolved.filter_local_cwd);
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn pi_default_launch_layout_uses_only_the_encoded_project_child() {
        let root = std::env::temp_dir().join(format!(
            "starling-pi-default-layout-{}",
            uuid::Uuid::new_v4()
        ));
        let project = root.join("project");
        let agent = root.join("agent");
        std::fs::create_dir_all(&project).unwrap();

        let resolved = resolve_pi_session_layout_from_sources(&project, None, None, &agent);

        assert_eq!(resolved.session_root, agent.join("sessions"));
        assert_eq!(
            resolved.local_dir,
            agent.join("sessions").join(pi_encoded_cwd(&project))
        );
        assert!(!resolved.configured);
        assert!(!resolved.filter_local_cwd);
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn pi_empty_project_session_dir_clears_the_global_override() {
        let root = std::env::temp_dir().join(format!(
            "starling-pi-cleared-layout-{}",
            uuid::Uuid::new_v4()
        ));
        let project = root.join("project");
        let agent = root.join("agent");
        std::fs::create_dir_all(project.join(".pi")).unwrap();
        std::fs::create_dir_all(&agent).unwrap();
        std::fs::write(project.join(".pi/settings.json"), r#"{"sessionDir":""}"#).unwrap();
        std::fs::write(
            agent.join("settings.json"),
            r#"{"sessionDir":"global-sessions"}"#,
        )
        .unwrap();

        let resolved = resolve_pi_session_layout_from_sources(&project, None, None, &agent);

        assert_eq!(resolved.session_root, agent.join("sessions"));
        assert_eq!(
            resolved.local_dir,
            agent.join("sessions").join(pi_encoded_cwd(&project))
        );
        assert!(!resolved.configured);
        assert!(!resolved.filter_local_cwd);
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn pi_configured_default_dir_with_trailing_separator_still_filters_cwd() {
        let root = std::env::temp_dir().join(format!(
            "starling-pi-spelled-layout-{}",
            uuid::Uuid::new_v4()
        ));
        let project = root.join("project");
        let agent = root.join("agent");
        std::fs::create_dir_all(&project).unwrap();
        let default_local = agent.join("sessions").join(pi_encoded_cwd(&project));
        let configured = format!(
            "{}{sep}",
            default_local.display(),
            sep = std::path::MAIN_SEPARATOR
        );

        let resolved =
            resolve_pi_session_layout_from_sources(&project, Some(&configured), None, &agent);

        assert!(resolved.configured);
        assert!(resolved.filter_local_cwd);
        std::fs::remove_dir_all(root).ok();
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
