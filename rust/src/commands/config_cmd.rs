//! `starling config` — manage CLI settings.

use std::path::PathBuf;

use anyhow::Result;
use colored::*;
use serde::Deserialize;

use crate::cli::*;
use crate::constants::{
    cli_config_path, default_claude_settings_dir, default_codex_settings_dir, default_runs_path,
    default_starling_home, default_store_path, starling_home_source, StarlingHomeSource,
};

#[derive(Debug, Default, Deserialize, serde::Serialize)]
struct CliConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    home_path: Option<String>,
}

fn read_cli_config() -> CliConfig {
    let path = cli_config_path();
    if let Ok(raw) = std::fs::read_to_string(&path) {
        if let Ok(cfg) = serde_json::from_str::<CliConfig>(&raw) {
            return cfg;
        }
    }
    CliConfig::default()
}

fn write_cli_config(cfg: &CliConfig) -> Result<()> {
    let path = cli_config_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut options = serde_json::to_string_pretty(cfg)?;
    options.push('\n');
    std::fs::write(path, options)?;
    Ok(())
}

pub fn handle(cmd: ConfigCommand) -> Result<()> {
    match cmd {
        ConfigCommand::Show { json } => show(json),
        ConfigCommand::Set { key, value, json } => set(&key, &value, json),
        ConfigCommand::Unset { key, json } => unset(&key, json),
    }
}

fn source_str(s: StarlingHomeSource) -> &'static str {
    match s {
        StarlingHomeSource::Env => "env",
        StarlingHomeSource::Config => "config",
        StarlingHomeSource::Default => "default",
    }
}

fn show(json: bool) -> Result<()> {
    let cfg = read_cli_config();
    let home_source = starling_home_source();
    let payload = serde_json::json!({
        "configPath": cli_config_path().to_string_lossy(),
        "configuredHomePath": cfg.home_path,
        "effectiveHomePath": default_starling_home().to_string_lossy(),
        "homeSource": source_str(home_source),
        "storePath": default_store_path().to_string_lossy(),
        "runsPath": default_runs_path().to_string_lossy(),
        "settingsClaudePath": default_claude_settings_dir().to_string_lossy(),
        "settingsCodexPath": default_codex_settings_dir().to_string_lossy(),
    });
    if json {
        println!("{}", serde_json::to_string_pretty(&payload)?);
        return Ok(());
    }
    println!("{}", "Starling config".green());
    println!("  Config:   {}", payload["configPath"].as_str().unwrap_or_default());
    println!("  Home:     {}", payload["effectiveHomePath"].as_str().unwrap_or_default());
    println!("  Source:   {}", payload["homeSource"].as_str().unwrap_or_default());
    if let Some(saved) = cfg.home_path.as_deref() {
        println!("  Saved:    {}", saved);
    }
    println!("  Store:    {}", payload["storePath"].as_str().unwrap_or_default());
    println!("  Runs:     {}", payload["runsPath"].as_str().unwrap_or_default());
    Ok(())
}

fn set(key: &str, value: &str, json: bool) -> Result<()> {
    let mut cfg = read_cli_config();
    match key.to_lowercase().as_str() {
        "home" | "homepath" | "home_path" => {
            cfg.home_path = Some(value.to_string());
        }
        other => {
            eprintln!("{}: unknown config key '{}'", "error".red(), other);
            std::process::exit(2);
        }
    }
    write_cli_config(&cfg)?;
    if json {
        return super::print_json_result(
            "config.set",
            &format!("Set {} = {}", key, value),
            serde_json::json!({ "key": key, "value": value, "config": cfg }),
        );
    }
    println!("{}", format!("Set {} = {}", key, value).green());
    Ok(())
}

fn unset(key: &str, json: bool) -> Result<()> {
    let mut cfg = read_cli_config();
    let changed = match key.to_lowercase().as_str() {
        "home" | "homepath" | "home_path" => {
            let had = cfg.home_path.is_some();
            cfg.home_path = None;
            had
        }
        other => {
            eprintln!("{}: unknown config key '{}'", "error".red(), other);
            std::process::exit(2);
        }
    };
    if changed {
        write_cli_config(&cfg)?;
        if json {
            return super::print_json_result(
                "config.unset",
                &format!("Unset {}", key),
                serde_json::json!({ "key": key, "changed": true, "config": cfg }),
            );
        }
        println!("{}", format!("Unset {}", key).green());
    } else {
        if json {
            return super::print_json_result(
                "config.unset",
                &format!("{} was not set", key),
                serde_json::json!({ "key": key, "changed": false, "config": cfg }),
            );
        }
        println!("{}", format!("{} was not set", key).yellow());
    }
    Ok(())
}

// Silence unused
#[allow(dead_code)]
fn _anchor_pb() -> PathBuf { PathBuf::new() }
