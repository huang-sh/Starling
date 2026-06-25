//! Starling-managed MCP server registry.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};

use crate::constants::{default_mcp_config_path, MCP_CONFIG_VERSION};
use crate::core::fs_utils::{atomic_write_json, read_json};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpConfig {
    #[serde(
        default = "default_config_version",
        skip_serializing_if = "is_current_config_version"
    )]
    pub version: u32,
    #[serde(default, rename = "mcpServers")]
    pub mcp_servers: BTreeMap<String, McpServerConfig>,
    #[serde(default, skip_serializing_if = "is_default_profiles")]
    pub profiles: BTreeMap<String, Vec<String>>,
    #[serde(
        default = "default_profile_name",
        skip_serializing_if = "is_default_profile"
    )]
    pub default_profile: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpServerConfig {
    #[serde(default = "default_stdio_type")]
    pub r#type: String,
    #[serde(default = "default_true", skip_serializing_if = "is_true")]
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub builtin: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub headers: BTreeMap<String, String>,
}

impl Default for McpConfig {
    fn default() -> Self {
        let mut mcp_servers = BTreeMap::new();
        mcp_servers.insert("starling".to_string(), builtin_starling_server("starling"));
        mcp_servers.insert("agnes".to_string(), builtin_agnes_server("starling"));
        let mut profiles = BTreeMap::new();
        profiles.insert(
            "default".to_string(),
            vec!["starling".to_string(), "agnes".to_string()],
        );
        Self {
            version: MCP_CONFIG_VERSION,
            mcp_servers,
            profiles,
            default_profile: "default".to_string(),
        }
    }
}

pub fn load_mcp_config() -> McpConfig {
    let mut config: McpConfig = read_json(&default_mcp_config_path()).unwrap_or_default();
    migrate_mcp_config(&mut config);
    config
}

pub fn save_mcp_config(config: &McpConfig) -> Result<()> {
    let mut config = config.clone();
    migrate_mcp_config(&mut config);
    config.version = MCP_CONFIG_VERSION;
    atomic_write_json(&default_mcp_config_path(), &config)
}

pub fn builtin_starling_server(command: impl Into<String>) -> McpServerConfig {
    McpServerConfig {
        r#type: "stdio".to_string(),
        enabled: true,
        builtin: true,
        command: Some(command.into()),
        args: vec![
            "mcp".to_string(),
            "--tools".to_string(),
            "starling".to_string(),
        ],
        env: BTreeMap::new(),
        url: None,
        headers: BTreeMap::new(),
    }
}

pub fn builtin_agnes_server(command: impl Into<String>) -> McpServerConfig {
    let mut env = BTreeMap::new();
    env.insert("AGNES_API_KEY".to_string(), "${AGNES_API_KEY}".to_string());
    env.insert(
        "AGNES_API_KEYS".to_string(),
        "${AGNES_API_KEYS}".to_string(),
    );
    env.insert("AGNES_TOKEN".to_string(), "${AGNES_TOKEN}".to_string());
    env.insert(
        "AGNES_BASE_URL".to_string(),
        "${AGNES_BASE_URL}".to_string(),
    );
    env.insert(
        "AGNES_MODEL_TEXT".to_string(),
        "${AGNES_MODEL_TEXT}".to_string(),
    );
    env.insert(
        "AGNES_MODEL_IMAGE".to_string(),
        "${AGNES_MODEL_IMAGE}".to_string(),
    );
    env.insert(
        "AGNES_MODEL_VIDEO".to_string(),
        "${AGNES_MODEL_VIDEO}".to_string(),
    );
    McpServerConfig {
        r#type: "stdio".to_string(),
        enabled: true,
        builtin: true,
        command: Some(command.into()),
        args: vec![
            "mcp".to_string(),
            "--tools".to_string(),
            "agnes".to_string(),
        ],
        env,
        url: None,
        headers: BTreeMap::new(),
    }
}

pub fn effective_servers(
    requested: &[String],
    profile: Option<&str>,
    no_mcp: bool,
    starling_exe: &Path,
) -> Result<BTreeMap<String, McpServerConfig>> {
    effective_servers_from_config(load_mcp_config(), requested, profile, no_mcp, starling_exe)
}

pub fn effective_servers_from_config(
    mut config: McpConfig,
    requested: &[String],
    profile: Option<&str>,
    no_mcp: bool,
    starling_exe: &Path,
) -> Result<BTreeMap<String, McpServerConfig>> {
    if no_mcp {
        return Ok(BTreeMap::new());
    }
    migrate_mcp_config(&mut config);
    config.mcp_servers.insert(
        "starling".to_string(),
        builtin_starling_server(starling_exe.to_string_lossy().to_string()),
    );
    let mut agnes = config
        .mcp_servers
        .get("agnes")
        .cloned()
        .unwrap_or_else(|| builtin_agnes_server(starling_exe.to_string_lossy().to_string()));
    if agnes.builtin {
        agnes.command = Some(starling_exe.to_string_lossy().to_string());
        agnes.r#type = "stdio".to_string();
        agnes.args = vec![
            "mcp".to_string(),
            "--tools".to_string(),
            "agnes".to_string(),
        ];
        ensure_agnes_env_placeholders(&mut agnes);
    }
    config.mcp_servers.insert("agnes".to_string(), agnes);

    let names = if !requested.is_empty() {
        requested.to_vec()
    } else {
        let profile_name = profile.unwrap_or(config.default_profile.as_str());
        config
            .profiles
            .get(profile_name)
            .cloned()
            .unwrap_or_else(|| vec!["starling".to_string()])
    };

    let mut selected = BTreeMap::new();
    let mut seen = BTreeSet::new();
    for name in names {
        let name = name.trim();
        if name.is_empty() || !seen.insert(name.to_string()) {
            continue;
        }
        let Some(server) = config.mcp_servers.get(name) else {
            bail!("MCP server not found: {name}");
        };
        if server.enabled {
            validate_server(name, server)?;
            selected.insert(name.to_string(), resolve_env_placeholders(server));
        }
    }
    Ok(selected)
}

pub fn parse_env_pair(value: &str) -> Result<(String, String)> {
    let Some((key, val)) = value.split_once('=') else {
        bail!("env must be KEY=VALUE: {value}");
    };
    let key = key.trim();
    if key.is_empty() {
        bail!("env key cannot be empty");
    }
    Ok((key.to_string(), val.to_string()))
}

fn validate_server(name: &str, server: &McpServerConfig) -> Result<()> {
    match server.r#type.as_str() {
        "stdio" => {
            if server.command.as_deref().unwrap_or("").trim().is_empty() {
                bail!("stdio MCP server '{name}' requires command");
            }
        }
        "http" => {
            if server.url.as_deref().unwrap_or("").trim().is_empty() {
                bail!("http MCP server '{name}' requires url");
            }
        }
        other => bail!("unsupported MCP server type for '{name}': {other}"),
    }
    Ok(())
}

fn migrate_mcp_config(config: &mut McpConfig) {
    config.version = MCP_CONFIG_VERSION;
    config
        .mcp_servers
        .entry("starling".to_string())
        .or_insert_with(|| builtin_starling_server("starling"));
    config
        .mcp_servers
        .entry("agnes".to_string())
        .or_insert_with(|| builtin_agnes_server("starling"));
    for server in config.mcp_servers.values_mut() {
        if server.r#type.trim().is_empty() {
            server.r#type = if server.url.is_some() {
                "http".to_string()
            } else {
                "stdio".to_string()
            };
        }
    }
    if let Some(starling) = config.mcp_servers.get_mut("starling") {
        starling.builtin = true;
        starling.r#type = "stdio".to_string();
        if starling.command.as_deref().unwrap_or("").trim().is_empty() {
            starling.command = Some("starling".to_string());
        }
        starling.args = vec![
            "mcp".to_string(),
            "--tools".to_string(),
            "starling".to_string(),
        ];
        starling.env.clear();
    }
    if let Some(agnes) = config.mcp_servers.get_mut("agnes") {
        agnes.builtin = true;
        agnes.r#type = "stdio".to_string();
        if agnes.command.as_deref().unwrap_or("").trim().is_empty() {
            agnes.command = Some("starling".to_string());
        }
        agnes.args = vec![
            "mcp".to_string(),
            "--tools".to_string(),
            "agnes".to_string(),
        ];
        ensure_agnes_env_placeholders(agnes);
    }
    config
        .profiles
        .entry("default".to_string())
        .or_insert_with(|| vec!["starling".to_string(), "agnes".to_string()]);
    if let Some(default) = config.profiles.get_mut("default") {
        if !default.iter().any(|name| name == "starling") {
            default.insert(0, "starling".to_string());
        }
        if !default.iter().any(|name| name == "agnes") {
            default.push("agnes".to_string());
        }
    }
    if config.default_profile.trim().is_empty() {
        config.default_profile = "default".to_string();
    }
}

fn ensure_agnes_env_placeholders(server: &mut McpServerConfig) {
    for key in [
        "AGNES_API_KEY",
        "AGNES_API_KEYS",
        "AGNES_TOKEN",
        "AGNES_BASE_URL",
        "AGNES_MODEL_TEXT",
        "AGNES_MODEL_IMAGE",
        "AGNES_MODEL_VIDEO",
    ] {
        server
            .env
            .entry(key.to_string())
            .or_insert_with(|| format!("${{{key}}}"));
    }
}

fn resolve_env_placeholders(server: &McpServerConfig) -> McpServerConfig {
    let mut server = server.clone();
    server.env = server
        .env
        .iter()
        .filter_map(|(key, value)| {
            resolve_env_value(value)
                .filter(|resolved| !resolved.trim().is_empty())
                .map(|resolved| (key.clone(), resolved))
        })
        .collect();
    server
}

fn resolve_env_value(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Some(name) = trimmed
        .strip_prefix("${")
        .and_then(|rest| rest.strip_suffix('}'))
    {
        return std::env::var(name)
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
    }
    if let Some(name) = trimmed.strip_prefix('$') {
        if !name.is_empty()
            && name
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
        {
            return std::env::var(name)
                .ok()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty());
        }
    }
    Some(value.to_string())
}

fn default_true() -> bool {
    true
}

fn default_config_version() -> u32 {
    MCP_CONFIG_VERSION
}

fn default_stdio_type() -> String {
    "stdio".to_string()
}

fn default_profile_name() -> String {
    "default".to_string()
}

fn is_true(value: &bool) -> bool {
    *value
}

fn is_false(value: &bool) -> bool {
    !*value
}

fn is_current_config_version(value: &u32) -> bool {
    *value == MCP_CONFIG_VERSION
}

fn is_default_profile(value: &str) -> bool {
    value == "default"
}

fn is_default_profiles(value: &BTreeMap<String, Vec<String>>) -> bool {
    value.len() == 1
        && value
            .get("default")
            .map(|servers| servers == &vec!["starling".to_string(), "agnes".to_string()])
            .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_config_contains_builtin_starling() {
        let config = McpConfig::default();
        assert!(config.mcp_servers["starling"].builtin);
        assert!(config.mcp_servers["agnes"].builtin);
        assert_eq!(
            config.mcp_servers["starling"].command.as_deref(),
            Some("starling")
        );
        assert_eq!(config.profiles["default"], vec!["starling", "agnes"]);
        assert_eq!(
            config.mcp_servers["agnes"].env["AGNES_API_KEY"],
            "${AGNES_API_KEY}"
        );
    }

    #[test]
    fn serializes_using_mcp_servers_shape() {
        let rendered = serde_json::to_string(&McpConfig::default()).unwrap();
        assert!(rendered.contains("\"mcpServers\""));
        assert!(!rendered.contains("\"servers\""));
    }

    #[test]
    fn accepts_claude_style_http_server_config() {
        let mut config: McpConfig = serde_json::from_str(
            r#"{
              "mcpServers": {
                "claude-code-docs": {
                  "type": "http",
                  "url": "https://code.claude.com/docs/mcp"
                }
              }
            }"#,
        )
        .unwrap();
        migrate_mcp_config(&mut config);

        let docs = &config.mcp_servers["claude-code-docs"];
        assert_eq!(docs.r#type, "http");
        assert_eq!(
            docs.url.as_deref(),
            Some("https://code.claude.com/docs/mcp")
        );
        assert!(config.mcp_servers["starling"].builtin);
        assert!(config.mcp_servers["agnes"].builtin);
    }

    #[test]
    fn does_not_read_legacy_servers_key() {
        let mut config: McpConfig = serde_json::from_str(
            r#"{
              "servers": {
                "legacy": {
                  "type": "stdio",
                  "command": "legacy-mcp"
                }
              }
            }"#,
        )
        .unwrap();
        migrate_mcp_config(&mut config);

        assert!(!config.mcp_servers.contains_key("legacy"));
        assert!(config.mcp_servers["starling"].builtin);
        assert!(config.mcp_servers["agnes"].builtin);
    }

    #[test]
    fn parses_env_pairs() {
        assert_eq!(
            parse_env_pair("A=B").unwrap(),
            ("A".to_string(), "B".to_string())
        );
        assert!(parse_env_pair("bad").is_err());
    }

    #[test]
    fn effective_servers_selects_profile_and_skips_disabled() {
        let mut config = McpConfig::default();
        config.mcp_servers.insert(
            "images".to_string(),
            McpServerConfig {
                r#type: "stdio".to_string(),
                enabled: true,
                builtin: false,
                command: Some("/tmp/agnes".to_string()),
                args: vec!["serve".to_string()],
                env: BTreeMap::new(),
                url: None,
                headers: BTreeMap::new(),
            },
        );
        config.mcp_servers.insert(
            "off".to_string(),
            McpServerConfig {
                r#type: "stdio".to_string(),
                enabled: false,
                builtin: false,
                command: Some("/tmp/off".to_string()),
                args: Vec::new(),
                env: BTreeMap::new(),
                url: None,
                headers: BTreeMap::new(),
            },
        );
        config.profiles.insert(
            "lab".to_string(),
            vec![
                "starling".to_string(),
                "images".to_string(),
                "off".to_string(),
            ],
        );

        let selected = effective_servers_from_config(
            config,
            &[],
            Some("lab"),
            false,
            Path::new("/bin/starling"),
        )
        .unwrap();

        assert_eq!(selected.len(), 2);
        assert_eq!(
            selected["starling"].command.as_deref(),
            Some("/bin/starling")
        );
        assert_eq!(selected["images"].command.as_deref(), Some("/tmp/agnes"));
        assert!(!selected.contains_key("off"));
    }

    #[test]
    fn builtin_agnes_env_placeholders_are_omitted_when_unset() {
        std::env::remove_var("STARLING_TEST_MISSING_ENV");
        let mut config = McpConfig::default();
        let mut env = BTreeMap::new();
        env.insert(
            "TOKEN".to_string(),
            "${STARLING_TEST_MISSING_ENV}".to_string(),
        );
        config.mcp_servers.insert(
            "custom".to_string(),
            McpServerConfig {
                r#type: "stdio".to_string(),
                enabled: true,
                builtin: false,
                command: Some("/tmp/custom".to_string()),
                args: Vec::new(),
                env,
                url: None,
                headers: BTreeMap::new(),
            },
        );
        let selected = effective_servers_from_config(
            config,
            &["custom".to_string()],
            None,
            false,
            Path::new("/bin/starling"),
        )
        .unwrap();
        assert!(selected["custom"].env.get("TOKEN").is_none());
    }

    #[test]
    fn builtin_agnes_env_placeholders_expand_from_environment() {
        std::env::set_var("STARLING_TEST_MCP_TOKEN", "sk-test");
        let mut config = McpConfig::default();
        let mut env = BTreeMap::new();
        env.insert(
            "TOKEN".to_string(),
            "${STARLING_TEST_MCP_TOKEN}".to_string(),
        );
        config.mcp_servers.insert(
            "custom".to_string(),
            McpServerConfig {
                r#type: "stdio".to_string(),
                enabled: true,
                builtin: false,
                command: Some("/tmp/custom".to_string()),
                args: Vec::new(),
                env,
                url: None,
                headers: BTreeMap::new(),
            },
        );
        let selected = effective_servers_from_config(
            config,
            &["custom".to_string()],
            None,
            false,
            Path::new("/bin/starling"),
        )
        .unwrap();
        assert_eq!(selected["custom"].env["TOKEN"], "sk-test");
        std::env::remove_var("STARLING_TEST_MCP_TOKEN");
    }
}
