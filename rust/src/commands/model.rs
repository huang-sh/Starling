//! `starling model` — model configuration inspection.

use std::path::PathBuf;

use anyhow::Result;
use colored::*;

use crate::cli::*;
use crate::constants::{
    default_claude_settings_dir, default_codex_home, default_codex_settings_dir,
};

pub fn handle(cmd: ModelCommand) -> Result<()> {
    match cmd {
        ModelCommand::List { json, agent } => list(json, agent),
        ModelCommand::Add { name } => add(&name),
        ModelCommand::Delete { name, agent, json } => delete(&name, agent.as_deref(), json),
        ModelCommand::Use { name } => use_cmd(&name),
    }
}

fn list(json: bool, agent: Option<String>) -> Result<()> {
    let filter = normalize_agent(agent.as_deref());
    let claude_rows = if filter.map(|a| a == "claude").unwrap_or(true) {
        collect_claude_configs()
    } else {
        Vec::new()
    };
    let codex_rows = if filter.map(|a| a == "codex").unwrap_or(true) {
        collect_codex_configs()
    } else {
        Vec::new()
    };

    if json {
        let mut rows = claude_rows.clone();
        rows.extend(codex_rows.clone());
        println!("{}", serde_json::to_string_pretty(&rows)?);
        return Ok(());
    }

    if claude_rows.is_empty() && codex_rows.is_empty() {
        println!("{}", "No model configurations found.".yellow());
        return Ok(());
    }

    if !claude_rows.is_empty() {
        println!("{}", "Claude".bold());
        println!("{}", render_table(&claude_rows));
    }
    if !codex_rows.is_empty() {
        if !claude_rows.is_empty() {
            println!();
        }
        println!("{}", "Codex".bold());
        println!("{}", render_table(&codex_rows));
    }
    Ok(())
}

fn normalize_agent(agent: Option<&str>) -> Option<&str> {
    match agent {
        Some("claude") => Some("claude"),
        Some("codex") => Some("codex"),
        Some(other) => {
            eprintln!("{}: unknown agent '{}'", "error".red(), other);
            std::process::exit(2);
        }
        None => None,
    }
}

#[derive(Clone, Default, serde::Serialize)]
struct ModelRow {
    agent: String,
    name: String,
    scope: String,
    source: String,
    exists: bool,
    model: String,
    auth: String,
}

fn collect_claude_configs() -> Vec<ModelRow> {
    let mut rows = Vec::new();
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"));
    let current = home.join(".claude").join("settings.json");
    rows.push(summarize_claude_json(&current, "current", "current"));
    let dir = default_claude_settings_dir();
    for f in list_profile_files(&dir) {
        let name = f
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        rows.push(summarize_claude_json(&f, "profile", &name));
    }
    rows
}

fn collect_codex_configs() -> Vec<ModelRow> {
    let mut rows = Vec::new();
    let current = default_codex_home().join("config.toml");
    rows.push(summarize_codex_toml(&current, "current", "current"));
    let dir = default_codex_settings_dir();
    for f in list_profile_files(&dir) {
        let name = f
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        rows.push(summarize_codex_toml(&f, "profile", &name));
    }
    rows
}

fn summarize_claude_json(path: &std::path::Path, scope: &str, name: &str) -> ModelRow {
    let exists = path.exists();
    let (model, auth) = if exists {
        match std::fs::read_to_string(path) {
            Ok(s) => {
                let v: serde_json::Value =
                    serde_json::from_str(&s).unwrap_or(serde_json::Value::Null);
                // Try top-level "model" first, then env.ANTHROPIC_DEFAULT_SONNET_MODEL.
                let model = v
                    .get("model")
                    .and_then(|m| m.as_str())
                    .map(String::from)
                    .unwrap_or_else(|| {
                        v.get("env")
                            .and_then(|e| e.get("ANTHROPIC_DEFAULT_SONNET_MODEL"))
                            .and_then(|m| m.as_str())
                            .unwrap_or("")
                            .to_string()
                    });
                let auth = v
                    .get("env")
                    .and_then(|e| e.get("ANTHROPIC_BASE_URL"))
                    .and_then(|u| u.as_str())
                    .unwrap_or("oauth")
                    .to_string();
                (model, auth)
            }
            Err(_) => (String::new(), String::new()),
        }
    } else {
        (String::new(), String::new())
    };
    ModelRow {
        agent: "claude".into(),
        name: name.to_string(),
        scope: scope.to_string(),
        source: path.to_string_lossy().to_string(),
        exists,
        model,
        auth,
    }
}

fn summarize_codex_toml(path: &std::path::Path, scope: &str, name: &str) -> ModelRow {
    let exists = path.exists();
    let (model, auth) = if exists {
        match std::fs::read_to_string(path) {
            Ok(s) => {
                // Minimal TOML parsing: look for model = "..." and auth = "..." or provider
                let model = extract_toml_string(&s, "model").unwrap_or_default();
                let auth = extract_toml_string(&s, "auth")
                    .or_else(|| extract_toml_string(&s, "provider"))
                    .unwrap_or_default();
                (model, auth)
            }
            Err(_) => (String::new(), String::new()),
        }
    } else {
        (String::new(), String::new())
    };
    ModelRow {
        agent: "codex".into(),
        name: name.to_string(),
        scope: scope.to_string(),
        source: path.to_string_lossy().to_string(),
        exists,
        model,
        auth,
    }
}

fn extract_toml_string(s: &str, key: &str) -> Option<String> {
    for line in s.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed
            .strip_prefix(&format!("{} =", key))
            .or_else(|| trimmed.strip_prefix(&format!("{}=", key)))
        {
            let v = rest.trim().trim_end_matches(',');
            let v = v.trim().trim_matches('"').trim_matches('\'');
            if !v.is_empty() {
                return Some(v.to_string());
            }
        }
    }
    None
}

fn list_profile_files(dir: &PathBuf) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return out,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if let Some(ext) = path.extension().and_then(|s| s.to_str()) {
            if matches!(ext, "json" | "jsonc" | "toml") {
                out.push(path);
            }
        }
    }
    out.sort();
    out
}

fn render_table(rows: &[ModelRow]) -> String {
    use comfy_table::{presets::UTF8_FULL, Cell, Color, ContentArrangement, Table};
    let mut table = Table::new();
    table
        .load_preset(UTF8_FULL)
        .set_content_arrangement(ContentArrangement::Disabled);
    table.set_header(vec![
        Cell::new("Name").fg(Color::Cyan),
        Cell::new("Scope").fg(Color::Cyan),
        Cell::new("Model").fg(Color::Cyan),
        Cell::new("Auth").fg(Color::Cyan),
        Cell::new("Source").fg(Color::Cyan),
    ]);
    for r in rows {
        table.add_row(vec![
            Cell::new(if r.exists {
                &r.name
            } else {
                return_dash(&r.name)
            }),
            Cell::new(&r.scope),
            Cell::new(if r.model.is_empty() { "-" } else { &r.model }),
            Cell::new(if r.auth.is_empty() { "-" } else { &r.auth }),
            Cell::new(if r.exists {
                r.source.as_str()
            } else {
                return_dash(&r.source)
            }),
        ]);
    }
    table.to_string()
}

fn return_dash(s: &str) -> &str {
    if s.is_empty() {
        "-"
    } else {
        s
    }
}

fn add(_name: &str) -> Result<()> {
    eprintln!(
        "{}",
        "model add: not yet implemented in the Rust version (Phase 7).".yellow()
    );
    eprintln!(
        "{}",
        "  Use the TypeScript build or edit profile files directly.".normal()
    );
    Ok(())
}

fn delete(name: &str, agent: Option<&str>, json: bool) -> Result<()> {
    let agent = normalize_agent(agent);
    let mut matches = Vec::new();

    if agent.map(|a| a == "claude").unwrap_or(true) {
        for path in profile_paths_for_name(&default_claude_settings_dir(), name) {
            matches.push(("claude", path));
        }
    }
    if agent.map(|a| a == "codex").unwrap_or(true) {
        for path in profile_paths_for_name(&default_codex_settings_dir(), name) {
            matches.push(("codex", path));
        }
    }

    if matches.is_empty() {
        eprintln!("{}: model profile not found: {}", "error".red(), name);
        std::process::exit(2);
    }
    if matches.len() > 1 {
        eprintln!(
            "{}: model profile name is ambiguous; pass --agent claude or --agent codex",
            "error".red()
        );
        std::process::exit(2);
    }

    let (agent, path) = matches.remove(0);
    std::fs::remove_file(&path)?;
    if json {
        return super::print_json_result(
            "model.delete",
            &format!("Deleted {} model profile: {}", agent, name),
            serde_json::json!({
                "agent": agent,
                "name": name,
                "path": path.to_string_lossy(),
                "deleted": true,
            }),
        );
    }
    println!(
        "{}",
        format!("Deleted {} model profile: {}", agent, name).green()
    );
    Ok(())
}

fn profile_paths_for_name(dir: &PathBuf, name: &str) -> Vec<PathBuf> {
    list_profile_files(dir)
        .into_iter()
        .filter(|path| {
            path.file_stem()
                .and_then(|s| s.to_str())
                .map(|s| s == name)
                .unwrap_or(false)
        })
        .collect()
}

fn use_cmd(_name: &str) -> Result<()> {
    eprintln!(
        "{}",
        "model use: not yet implemented in the Rust version (Phase 7).".yellow()
    );
    Ok(())
}
