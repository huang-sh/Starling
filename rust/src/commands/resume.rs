//! Resume an agent session. Mirrors src/index.ts resume + session.resume.

use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{anyhow, Result};
use colored::*;

use crate::constants::pi_node_compatible_path;
use crate::core::discovery::{find_pi_session_by_path, find_session_candidates};
use crate::core::runs::{is_pid_alive, list_runs, reconcile_stale_runs, RunStatus};
use crate::core::session_display::short_session_id;
use crate::core::session_lock::acquire_pi_session_lock;
use crate::types::{RunProvider, SessionMeta};

use super::run::{create_pi_runtime_extension, PiRuntimeExtension};

pub fn run(session_id: &str) -> Result<()> {
    let meta = if let Some(meta) = pi_session_from_path(session_id)? {
        meta
    } else {
        let candidates = find_session_candidates(session_id);
        match select_resume_candidate(session_id, candidates)? {
            Some(meta) => meta,
            None => {
                eprintln!("{}: session not found: {}", "error".red(), session_id);
                std::process::exit(1);
            }
        }
    };
    launch_resume(
        &meta.provider,
        &meta.session_id,
        &meta.file_path,
        &meta.project_path,
    )
}

fn pi_session_from_path(input: &str) -> Result<Option<SessionMeta>> {
    let path = Path::new(input);
    if !path.is_file() {
        return Ok(None);
    }
    find_pi_session_by_path(input)
        .map(Some)
        .ok_or_else(|| anyhow!("{} is not a valid Pi session transcript", path.display()))
}

fn select_resume_candidate(
    session_id: &str,
    candidates: Vec<SessionMeta>,
) -> Result<Option<SessionMeta>> {
    let exact_pi: Vec<&SessionMeta> = candidates
        .iter()
        .filter(|meta| meta.provider == "pi" && meta.session_id == session_id)
        .collect();
    if exact_pi.len() > 1 {
        return Err(ambiguous_pi_session_error(session_id, &exact_pi));
    }
    if let Some(exact) = candidates.iter().find(|meta| meta.session_id == session_id) {
        return Ok(Some(exact.clone()));
    }
    let pi_candidates: Vec<&SessionMeta> = candidates
        .iter()
        .filter(|meta| meta.provider == "pi")
        .collect();
    if pi_candidates.len() > 1 && pi_candidates.len() == candidates.len() {
        return Err(ambiguous_pi_session_error(session_id, &pi_candidates));
    }
    Ok(candidates.into_iter().next())
}

fn ambiguous_pi_session_error(session_id: &str, candidates: &[&SessionMeta]) -> anyhow::Error {
    let choices = candidates
        .iter()
        .map(|meta| format!("{} ({})", meta.file_path, meta.project_path))
        .collect::<Vec<_>>()
        .join(", ");
    anyhow!(
        "Pi session ID '{session_id}' is ambiguous across projects: {choices}. Resume with an absolute transcript path"
    )
}

fn launch_resume(
    provider: &str,
    session_id: &str,
    file_path: &str,
    project_path: &str,
) -> Result<()> {
    // Acquire before consulting runs.json so two simultaneous Starling
    // processes cannot both pass the pre-spawn check (TOCTOU). The OS releases
    // the inherited handle when the actual Pi writer exits.
    let pi_session_lock = if provider == "pi" {
        Some(acquire_pi_session_lock(session_id, project_path)?)
    } else {
        None
    };

    eprintln!(
        "{}: resuming {} {}",
        "starling".cyan(),
        provider,
        short_session_id(session_id)
    );

    let mut pi_runtime_extension: Option<PiRuntimeExtension> = None;
    let mut cmd = match provider {
        "codex" => {
            let mut c = Command::new("codex");
            c.arg("resume").arg(session_id);
            if let Some(home) = codex_home_from_session_path(file_path) {
                c.env("CODEX_HOME", home);
            }
            c
        }
        "claude" => {
            let mut c = Command::new("claude");
            c.arg("--resume").arg(session_id);
            c
        }
        "pi" => {
            ensure_pi_resume_is_exclusive(session_id, project_path)?;
            // Pi's IDs are scoped to a cwd. An absolute transcript path is the
            // only unambiguous resume contract when two projects reuse an ID.
            let mut c = Command::new("pi");
            let absolute =
                std::fs::canonicalize(file_path).unwrap_or_else(|_| PathBuf::from(file_path));
            let absolute = pi_node_compatible_path(&absolute);
            let extension = create_pi_runtime_extension(&uuid::Uuid::new_v4().to_string())?;
            c.arg("--extension")
                .arg(&extension.extension_file)
                .arg("--session")
                .arg(absolute);
            pi_runtime_extension = Some(extension);
            if !project_path.is_empty() && Path::new(project_path).is_dir() {
                c.current_dir(project_path);
            }
            c
        }
        other => return Err(anyhow!("unsupported session provider: {other}")),
    };
    cmd.stdin(std::process::Stdio::inherit())
        .stdout(std::process::Stdio::inherit())
        .stderr(std::process::Stdio::inherit());
    if let Some(lock) = pi_session_lock.as_ref() {
        if let Err(error) = lock.set_child_inheritable(true) {
            if let Some(extension) = pi_runtime_extension {
                let _ = std::fs::remove_file(extension.extension_file);
            }
            return Err(error);
        }
    }
    let spawn_result = cmd.spawn();
    if let Some(lock) = pi_session_lock.as_ref() {
        if let Err(error) = lock.set_child_inheritable(false) {
            eprintln!(
                "{}: could not restore Pi lock close-on-exec: {}",
                "warning".yellow(),
                error
            );
        }
    }
    let status_result = match spawn_result {
        Ok(mut child) => child.wait(),
        Err(error) => Err(error),
    };
    if let Some(extension) = pi_runtime_extension {
        let _ = std::fs::remove_file(extension.extension_file);
    }
    let status = status_result.map_err(|e| anyhow!("spawn {provider}: {e}"))?;
    if !status.success() {
        std::process::exit(status.code().unwrap_or(1));
    }
    Ok(())
}

fn ensure_pi_resume_is_exclusive(session_id: &str, project_path: &str) -> Result<()> {
    reconcile_stale_runs();
    let conflict = list_runs(None).into_iter().any(|run| {
        run.provider == RunProvider::Pi
            && run.status == RunStatus::Running
            && run.session_id.as_deref() == Some(session_id)
            && match run.project_path.as_deref() {
                Some(run_project) if !project_path.is_empty() => {
                    normalized_project_path(run_project) == normalized_project_path(project_path)
                }
                _ => true,
            }
            && run.pid.map(is_pid_alive).unwrap_or(false)
    });
    if conflict {
        return Err(anyhow!(
            "Pi session '{session_id}' is already open in a live Starling-managed run"
        ));
    }
    Ok(())
}

fn normalized_project_path(path: &str) -> PathBuf {
    let path = Path::new(path);
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map(|cwd| cwd.join(path))
            .unwrap_or_else(|_| path.to_path_buf())
    };
    std::fs::canonicalize(&absolute).unwrap_or_else(|_| {
        let mut normalized = PathBuf::new();
        for component in absolute.components() {
            match component {
                std::path::Component::CurDir => {}
                std::path::Component::ParentDir => {
                    normalized.pop();
                }
                other => normalized.push(other.as_os_str()),
            }
        }
        normalized
    })
}

fn codex_home_from_session_path(file_path: &str) -> Option<PathBuf> {
    let path = Path::new(file_path);
    let mut cursor = path.parent();
    while let Some(dir) = cursor {
        let name = dir.file_name().and_then(|s| s.to_str()).unwrap_or_default();
        if name == "sessions" || name == "archived_sessions" {
            let home = dir.parent()?;
            let home_name = home
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or_default();
            if home_name.starts_with("codex-") {
                return Some(home.to_path_buf());
            }
            return None;
        }
        cursor = dir.parent();
    }
    None
}

#[cfg(test)]
mod tests {
    use super::{codex_home_from_session_path, select_resume_candidate};
    use std::path::PathBuf;

    use crate::types::SessionMeta;

    #[test]
    fn derives_codex_home_from_starling_run_home_session() {
        let path = "/home/u/.starling/run-homes/codex-run-1/sessions/2026/06/22/rollout.jsonl";
        assert_eq!(
            codex_home_from_session_path(path),
            Some(PathBuf::from("/home/u/.starling/run-homes/codex-run-1"))
        );
    }

    #[test]
    fn leaves_default_codex_sessions_alone() {
        let path = "/home/u/.codex/sessions/2026/06/22/rollout.jsonl";
        assert_eq!(codex_home_from_session_path(path), None);
    }

    fn pi_session(id: &str, project: &str, path: &str) -> SessionMeta {
        SessionMeta {
            session_id: id.into(),
            provider: "pi".into(),
            model: String::new(),
            project_path: project.into(),
            first_prompt: String::new(),
            custom_title: None,
            file_path: path.into(),
            created_at: String::new(),
            modified_at: String::new(),
            token_usage: None,
        }
    }

    #[test]
    fn rejects_ambiguous_cwd_scoped_pi_id() {
        let candidates = vec![
            pi_session("SharedID", "/work/a", "/sessions/a/one_SharedID.jsonl"),
            pi_session("SharedID", "/work/b", "/sessions/b/two_SharedID.jsonl"),
        ];

        let err = select_resume_candidate("SharedID", candidates).unwrap_err();

        assert!(err.to_string().contains("ambiguous across projects"));
        assert!(err.to_string().contains("absolute transcript path"));
    }
}
