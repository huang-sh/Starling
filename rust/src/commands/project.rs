//! `starling project` — list and inspect projects.

use anyhow::Result;
use colored::*;

use crate::cli::*;
use crate::core::session_index::{
    aggregate_projects_from_sessions, load_session_index, rebuild_session_index, ProjectSummary,
    Provider as IdxProvider, SessionIndex,
};

pub fn handle(cmd: ProjectCommand) -> Result<()> {
    match cmd {
        ProjectCommand::List {
            agent,
            limit,
            all,
            refresh_index,
            no_index,
            json,
        } => list(agent, limit, all, refresh_index, no_index, json),
        ProjectCommand::Show { path, agent, json } => show(&path, agent, json),
    }
}

fn provider_from_opt(s: Option<&str>) -> Option<IdxProvider> {
    match s {
        Some("claude") => Some(IdxProvider::Claude),
        Some("codex") => Some(IdxProvider::Codex),
        Some(other) => {
            eprintln!("{}: unknown agent '{}'", "error".red(), other);
            std::process::exit(2);
        }
        None => None,
    }
}

fn load_or_rebuild_index(
    provider: Option<IdxProvider>,
    refresh_index: bool,
    no_index: bool,
) -> SessionIndex {
    if refresh_index || no_index {
        return rebuild_session_index(provider);
    }
    load_session_index().unwrap_or_else(|| rebuild_session_index(provider))
}

fn list(
    agent: Option<String>,
    limit: Option<usize>,
    all: bool,
    refresh_index: bool,
    no_index: bool,
    json: bool,
) -> Result<()> {
    let provider = provider_from_opt(agent.as_deref());
    let index = load_or_rebuild_index(provider, refresh_index, no_index);
    let mut projects = aggregate_projects_from_sessions(&index.sessions, provider);
    if !all {
        projects.truncate(limit.unwrap_or(100));
    }
    if json {
        let summaries: Vec<ProjectSummary> = projects
            .into_iter()
            .map(|p| ProjectSummary {
                project_path: p.project_path,
                session_count: p.session_count,
                agents: p.agents,
                models: p.models,
                first_active: p.first_active,
                last_active: p.last_active,
            })
            .collect();
        println!("{}", serde_json::to_string_pretty(&summaries)?);
        return Ok(());
    }
    if projects.is_empty() {
        println!("{}", "No projects found.".yellow());
        return Ok(());
    }
    println!("{}", "PROJECTS".cyan().bold());
    for p in projects {
        let agents: String = p
            .agents
            .iter()
            .map(|(k, v)| format!("{k}:{v}"))
            .collect::<Vec<_>>()
            .join(" ");
        let models: String = if p.models.is_empty() {
            "-".into()
        } else {
            p.models
                .iter()
                .map(|(k, v)| format!("{k}:{v}"))
                .collect::<Vec<_>>()
                .join(" ")
        };
        println!(
            "  {} {} {} {}",
            p.project_path.bold(),
            format!("({} sessions)", p.session_count).normal(),
            format!("[agents: {}]", agents).normal(),
            format!("[models: {}]", models).normal()
        );
        println!("    first: {}  last: {}", p.first_active, p.last_active);
    }
    Ok(())
}

fn show(path: &str, agent: Option<String>, json: bool) -> Result<()> {
    let provider = provider_from_opt(agent.as_deref());
    let index = load_or_rebuild_index(provider, false, false);
    let projects = aggregate_projects_from_sessions(&index.sessions, provider);
    let project = projects.into_iter().find(|p| p.project_path == path);
    let Some(project) = project else {
        if json {
            println!(
                "{}",
                serde_json::json!({
                    "project_path": path,
                    "session_count": 0,
                    "agents": {},
                    "models": {},
                    "first_active": "",
                    "last_active": "",
                    "sessions": [],
                })
            );
        } else {
            println!("{}", format!("No sessions for project: {}", path).yellow());
        }
        return Ok(());
    };

    if json {
        println!("{}", serde_json::to_string_pretty(&project)?);
        return Ok(());
    }
    println!("{}", format!("Project: {}", path).cyan().bold());
    println!("  Sessions: {}", project.sessions.len());
    for s in &project.sessions {
        let date = s
            .modified_at
            .chars()
            .take(16)
            .collect::<String>()
            .replace('T', " ");
        println!(
            "    {} {} {} {}",
            crate::core::session_display::short_session_id(&s.session_id).cyan(),
            s.provider.normal(),
            s.model.normal(),
            date
        );
    }
    Ok(())
}
