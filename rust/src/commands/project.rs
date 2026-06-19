//! `starling project` — list and inspect projects.

use anyhow::Result;
use colored::*;

use crate::cli::*;
use crate::core::discovery::Provider;
use crate::core::session_index::{aggregate_projects_from_sessions, load_session_index, Provider as IdxProvider};

pub fn handle(cmd: ProjectCommand) -> Result<()> {
    match cmd {
        ProjectCommand::List { agent, json } => list(agent, json),
        ProjectCommand::Show { path } => show(&path),
    }
}

fn provider_from_opt(s: Option<&str>) -> Option<Provider> {
    match s {
        Some("claude") => Some(Provider::Claude),
        Some("codex") => Some(Provider::Codex),
        Some(other) => {
            eprintln!("{}: unknown agent '{}'", "error".red(), other);
            std::process::exit(2);
        }
        None => None,
    }
}

fn list(agent: Option<String>, json: bool) -> Result<()> {
    let provider = provider_from_opt(agent.as_deref());
    let idx_provider = provider.map(|p| match p {
        Provider::Claude => IdxProvider::Claude,
        Provider::Codex => IdxProvider::Codex,
    });
    let index = match load_session_index() {
        Some(i) => i,
        None => {
            println!("{}", "No session index found. Run `starling session index rebuild` first.".yellow());
            std::process::exit(0);
        }
    };
    let projects = aggregate_projects_from_sessions(&index.sessions, idx_provider);
    if json {
        println!("{}", serde_json::to_string_pretty(&projects)?);
        return Ok(());
    }
    if projects.is_empty() {
        println!("{}", "No projects found.".yellow());
        return Ok(());
    }
    println!("{}", "PROJECTS".cyan().bold());
    for p in projects {
        let agents: String = p.agents.iter().map(|(k, v)| format!("{k}:{v}")).collect::<Vec<_>>().join(" ");
        let models: String = if p.models.is_empty() {
            "-".into()
        } else {
            p.models.iter().map(|(k, v)| format!("{k}:{v}")).collect::<Vec<_>>().join(" ")
        };
        println!("  {} {} {} {}",
            p.project_path.bold(),
            format!("({} sessions)", p.session_count).normal(),
            format!("[agents: {}]", agents).normal(),
            format!("[models: {}]", models).normal());
        println!("    first: {}  last: {}", p.first_active, p.last_active);
    }
    Ok(())
}

fn show(path: &str) -> Result<()> {
    let index = match load_session_index() {
        Some(i) => i,
        None => {
            eprintln!("{}: no session index", "error".red());
            std::process::exit(1);
        }
    };
    let sessions: Vec<_> = index.sessions.into_iter().filter(|s| s.project_path == path).collect();
    if sessions.is_empty() {
        println!("{}", format!("No sessions for project: {}", path).yellow());
        return Ok(());
    }
    println!("{}", format!("Project: {}", path).cyan().bold());
    println!("  Sessions: {}", sessions.len());
    for s in &sessions {
        let date = s.modified_at.chars().take(16).collect::<String>().replace('T', " ");
        println!("    {} {} {} {}",
            crate::core::session_display::short_session_id(&s.session_id).cyan(),
            s.provider.normal(),
            s.model.normal(),
            date);
    }
    Ok(())
}
