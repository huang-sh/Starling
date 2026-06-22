//! `starling run` — agent launch with run-record tracking.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use anyhow::Result;
use colored::*;
use serde_json::Value;

use crate::cli::*;
use crate::constants::{
    default_claude_settings_dir, default_codex_home, default_codex_settings_dir,
    default_starling_home, now_iso,
};
use crate::core::catalog_resolver::{resolve_catalog_reference, CatalogResolution};
use crate::core::discovery::{canonical_session_id, find_sessions, Provider as DiscoveryProvider};
use crate::core::id::generate_bookmark_id;
use crate::core::process_map::map_process_tree_to_session_since;
use crate::core::runs::{
    create_run, finalize_run, find_run, list_runs, mark_run_crashed, remove_run, FinalizePatch,
    RunStatus,
};
use crate::core::session::{
    extract_claude_session_meta, extract_codex_session_meta, parse_jsonl_head,
};
use crate::core::session_display::short_session_id;
use crate::core::store::{add_bookmark, find_bookmark, update_bookmark, BookmarkPatch};
use crate::types::{Bookmark, RunProvider, RunRecord, RunSource, SessionMeta};

pub fn handle(cmd: RunCommand) -> Result<()> {
    match &cmd.command {
        RunSubcommand::Claude { args } => launch(RunProvider::Claude, "claude", &cmd, args),
        RunSubcommand::Codex { args } => launch(RunProvider::Codex, "codex", &cmd, args),
        RunSubcommand::Status { run_id, json } => status(run_id.as_deref(), *json),
        RunSubcommand::Stop { run_id, json } => stop(run_id, *json),
    }
}

struct PreparedLaunch {
    args: Vec<String>,
    envs: Vec<(String, String)>,
    temp_dir: Option<PathBuf>,
    hook_file: Option<PathBuf>,
}

fn launch(provider: RunProvider, bin: &str, cmd_args: &RunCommand, passthrough_args: &[String]) -> Result<()> {
    let run_id = uuid::Uuid::new_v4().to_string();
    let start_ms = now_ms();
    let started_at = now_iso();
    let cwd = cmd_args.cwd.as_ref().map(PathBuf::from);
    let project_path = cwd.clone()
        .or_else(|| std::env::current_dir().ok())
        .map(|p| p.to_string_lossy().to_string());
    let catalog_id = resolve_catalog_id(cmd_args.catalog.as_deref());
    let prepared = prepare_launch(
        provider,
        &run_id,
        cmd_args.setting.as_deref(),
        passthrough_args,
        catalog_id.is_some(),
    )?;

    // Pre-spawn record (pid unknown yet).
    let record = RunRecord {
        run_id: run_id.clone(),
        session_id: None,
        provider,
        project_path: project_path.clone(),
        catalog_id: catalog_id.clone(),
        pid: None,
        status: RunStatus::Running,
        exit_code: None,
        started_at: started_at.clone(),
        ended_at: None,
        source: RunSource::StarlingRun,
    };
    create_run(record);

    eprintln!("{} run {} ({})", "starling".cyan(), short(&run_id), bin);

    let mut cmd = Command::new(bin);
    cmd.args(&prepared.args);
    for (key, value) in &prepared.envs {
        cmd.env(key, value);
    }
    if let Some(cwd) = &cwd {
        cmd.current_dir(cwd);
    }
    cmd.stdin(Stdio::inherit()).stdout(Stdio::inherit()).stderr(Stdio::inherit());

    match cmd.spawn() {
        Ok(mut child) => {
            // Update record with pid.
            let pid = child.id();
            update_run_pid(&run_id, pid);
            maybe_start_catalog_assignment_watcher(
                run_id.clone(),
                pid,
                provider,
                catalog_id.clone(),
                cmd_args.title.clone(),
                project_path.clone(),
                start_ms,
                prepared.hook_file.clone(),
            );

            // Install SIGINT/SIGTERM handler so Ctrl-C marks the run crashed.
            install_signal_handler(run_id.clone());

            match child.wait() {
                Ok(status) => {
                    assign_recent_session_fallback(
                        &run_id,
                        provider,
                        catalog_id.as_deref(),
                        cmd_args.title.as_deref(),
                        project_path.as_deref(),
                        start_ms,
                    );
                    let final_status = if status.success() {
                        RunStatus::Completed
                    } else {
                        RunStatus::Errored
                    };
                    finalize_run(&run_id, FinalizePatch {
                        status: final_status,
                        exit_code: status.code(),
                        ended_at: Some(now_iso()),
                        session_id: None,
                    });
                    cleanup_temp_dir(prepared.temp_dir.as_deref());
                    std::process::exit(status.code().unwrap_or(0));
                }
                Err(e) => {
                    eprintln!("{}: failed to wait on {}: {}", "error".red(), bin, e);
                    mark_run_crashed(&run_id);
                    cleanup_temp_dir(prepared.temp_dir.as_deref());
                    std::process::exit(1);
                }
            }
        }
        Err(e) => {
            eprintln!("{}: failed to spawn {}: {}", "error".red(), bin, e);
            // Mark as crashed since we recorded a Running entry.
            mark_run_crashed(&run_id);
            cleanup_temp_dir(prepared.temp_dir.as_deref());
            std::process::exit(1);
        }
    }
}

fn maybe_start_catalog_assignment_watcher(
    run_id: String,
    pid: u32,
    provider: RunProvider,
    catalog_id: Option<String>,
    title: Option<String>,
    project_path: Option<String>,
    start_ms: u64,
    hook_file: Option<PathBuf>,
) {
    let Some(catalog_id) = catalog_id else { return; };
    std::thread::spawn(move || {
        while crate::core::runs::is_pid_alive(pid) {
            if let Some(hook) = hook_file.as_deref().and_then(read_hook_session) {
                let project = hook.cwd.or_else(|| project_path.clone()).unwrap_or_default();
                assign_session_to_catalog(
                    &run_id,
                    provider,
                    &hook.session_id,
                    hook.transcript_path.as_deref(),
                    &project,
                    title.as_deref(),
                    &catalog_id,
                );
                return;
            }
            if hook_file.is_none() {
                if let Some(mapped) = map_process_tree_to_session_since(pid, start_ms) {
                    if let Some(session_id) = mapped.session_id {
                        let file_path = mapped.file_path.clone();
                        let project = mapped.project_path.or_else(|| project_path.clone()).unwrap_or_default();
                        assign_session_to_catalog(
                            &run_id,
                            provider,
                            &session_id,
                            file_path.as_deref(),
                            &project,
                            title.as_deref(),
                            &catalog_id,
                        );
                        return;
                    }
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(500));
        }
    });
}

struct HookSession {
    session_id: String,
    transcript_path: Option<String>,
    cwd: Option<String>,
}

fn read_hook_session(path: &Path) -> Option<HookSession> {
    let raw = std::fs::read_to_string(path).ok()?;
    for line in raw.lines().rev() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let value: Value = serde_json::from_str(trimmed).ok()?;
        let session_id = value
            .get("session_id")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())?
            .to_string();
        let transcript_path = value
            .get("transcript_path")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(String::from);
        let cwd = value
            .get("cwd")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(String::from);
        return Some(HookSession { session_id, transcript_path, cwd });
    }
    None
}

fn assign_recent_session_fallback(
    run_id: &str,
    provider: RunProvider,
    catalog_id: Option<&str>,
    title: Option<&str>,
    project_path: Option<&str>,
    start_ms: u64,
) {
    let Some(catalog_id) = catalog_id else { return; };
    let sessions = find_sessions(20, Some(discovery_provider(provider)));
    let candidate = sessions.into_iter().find(|session| {
        if let Some(project_path) = project_path {
            if session.project_path != project_path { return false; }
        }
        session_modified_ms(&session.modified_at).map(|ms| ms >= start_ms).unwrap_or(false)
    });
    if let Some(session) = candidate {
        assign_session_to_catalog(
            run_id,
            provider,
            &session.session_id,
            Some(&session.file_path),
            &session.project_path,
            title,
            catalog_id,
        );
    }
}

fn assign_session_to_catalog(
    run_id: &str,
    provider: RunProvider,
    session_id: &str,
    file_path: Option<&str>,
    project_path: &str,
    title: Option<&str>,
    catalog_id: &str,
) {
    let canonical_id = canonical_session_id(session_id);
    update_run_session_id(run_id, &canonical_id);

    let meta = file_path.and_then(|path| session_meta_from_path(provider, path));
    let inferred_title = bookmark_title(title, meta.as_ref(), &canonical_id);
    let first_prompt = meta
        .as_ref()
        .map(|m| m.first_prompt.clone())
        .unwrap_or_default();
    let effective_project_path = meta
        .as_ref()
        .map(|m| m.project_path.as_str())
        .filter(|p| !p.trim().is_empty())
        .unwrap_or(project_path);

    let bookmark = if let Some(existing) = find_bookmark(&canonical_id) {
        maybe_update_placeholder_title(existing, title, &inferred_title)
    } else if let Some(existing) = find_bookmark(session_id) {
        update_bookmark(&existing.id, BookmarkPatch {
            session_id: Some(canonical_id.clone()),
            ..Default::default()
        })
        .map(|updated| maybe_update_placeholder_title(updated, title, &inferred_title))
        .unwrap_or(existing)
    } else {
        let store = crate::core::store::load_store();
        let bookmark = Bookmark {
            id: generate_bookmark_id(&store.bookmarks),
            provider: provider_name(provider).into(),
            session_id: canonical_id.clone(),
            title: inferred_title,
            category: String::new(),
            tags: vec![],
            project_path: effective_project_path.into(),
            first_prompt,
            notes: vec![],
            space_ids: vec![],
            created_at: now_iso(),
            updated_at: now_iso(),
        };
        add_bookmark(bookmark)
    };

    let mut ids = bookmark.space_ids.clone();
    if !ids.contains(&catalog_id.to_string()) {
        ids.push(catalog_id.into());
        let _ = update_bookmark(&bookmark.id, BookmarkPatch {
            space_ids: Some(ids),
            ..Default::default()
        });
        let _ = file_path;
    }
}

fn session_meta_from_path(provider: RunProvider, file_path: &str) -> Option<SessionMeta> {
    let path = Path::new(file_path);
    if !path.exists() {
        return None;
    }
    let entries = parse_jsonl_head(path, 1000);
    let modified_at = now_iso();
    Some(match provider {
        RunProvider::Claude => extract_claude_session_meta(&entries, path, &modified_at),
        RunProvider::Codex => extract_codex_session_meta(&entries, path, &modified_at),
    })
}

fn bookmark_title(explicit: Option<&str>, meta: Option<&SessionMeta>, canonical_id: &str) -> String {
    if let Some(title) = explicit.map(str::trim).filter(|t| !t.is_empty()) {
        return title.to_string();
    }
    if let Some(title) = meta
        .and_then(|m| m.custom_title.as_deref())
        .map(str::trim)
        .filter(|t| !t.is_empty())
    {
        return title.to_string();
    }
    if let Some(prompt) = meta
        .map(|m| m.first_prompt.as_str())
        .map(str::trim)
        .filter(|p| !p.is_empty())
    {
        return prompt.chars().take(80).collect();
    }
    short_session_id(canonical_id).to_string()
}

fn maybe_update_placeholder_title(bookmark: Bookmark, explicit_title: Option<&str>, inferred_title: &str) -> Bookmark {
    if explicit_title.map(str::trim).filter(|t| !t.is_empty()).is_some()
        || (bookmark.title.trim() == "running session" && inferred_title.trim() != "running session")
    {
        update_bookmark(&bookmark.id, BookmarkPatch {
            title: Some(inferred_title.to_string()),
            ..Default::default()
        })
        .unwrap_or(bookmark)
    } else {
        bookmark
    }
}

fn provider_name(provider: RunProvider) -> &'static str {
    match provider {
        RunProvider::Claude => "claude",
        RunProvider::Codex => "codex",
    }
}

fn discovery_provider(provider: RunProvider) -> DiscoveryProvider {
    match provider {
        RunProvider::Claude => DiscoveryProvider::Claude,
        RunProvider::Codex => DiscoveryProvider::Codex,
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn session_modified_ms(value: &str) -> Option<u64> {
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|dt| dt.timestamp_millis().max(0) as u64)
}

fn resolve_catalog_id(catalog: Option<&str>) -> Option<String> {
    let catalog = catalog?;
    match resolve_catalog_reference(catalog) {
        CatalogResolution::Found(space) => Some(space.id),
        CatalogResolution::Ambiguous(matches) => {
            eprintln!("{}: ambiguous catalog '{}': {}", "error".red(), catalog,
                matches.iter().map(|s| s.name.clone()).collect::<Vec<_>>().join(", "));
            std::process::exit(2);
        }
        CatalogResolution::NotFound => {
            eprintln!("{}: catalog not found: {}", "error".red(), catalog);
            std::process::exit(2);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use crate::types::TokenUsage;

    fn meta(first_prompt: &str, custom_title: Option<&str>) -> SessionMeta {
        SessionMeta {
            session_id: "019edf66-d8f0-71d0-9283-e75d6da02af4".into(),
            provider: "codex".into(),
            model: "gpt-5.5".into(),
            project_path: "/tmp/project".into(),
            first_prompt: first_prompt.into(),
            custom_title: custom_title.map(String::from),
            file_path: "/tmp/session.jsonl".into(),
            created_at: "now".into(),
            modified_at: "now".into(),
            token_usage: Some(TokenUsage {
                input_tokens: Some(1),
                output_tokens: Some(2),
                total_tokens: Some(3),
                cache_tokens: None,
            }),
        }
    }

    #[test]
    fn bookmark_title_prefers_explicit_title() {
        let m = meta("first prompt", Some("custom"));
        assert_eq!(bookmark_title(Some("manual"), Some(&m), &m.session_id), "manual");
    }

    #[test]
    fn bookmark_title_uses_custom_title_then_prompt() {
        let with_custom = meta("first prompt", Some("custom"));
        assert_eq!(bookmark_title(None, Some(&with_custom), &with_custom.session_id), "custom");

        let without_custom = meta("first prompt", None);
        assert_eq!(bookmark_title(None, Some(&without_custom), &without_custom.session_id), "first prompt");
    }

    #[test]
    fn bookmark_title_falls_back_to_short_session_id() {
        let m = meta("", None);
        assert_eq!(bookmark_title(None, Some(&m), &m.session_id), "019edf66-d8f0");
        assert_eq!(bookmark_title(None, None, &m.session_id), "019edf66-d8f0");
    }

    #[test]
    fn reads_session_from_run_hook_file() {
        let path = std::env::temp_dir().join(format!(
            "starling-run-hook-{}.jsonl",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        {
            let mut f = std::fs::File::create(&path).unwrap();
            writeln!(f, "{{\"hook_event_name\":\"SessionStart\"}}").unwrap();
            writeln!(
                f,
                "{}",
                serde_json::json!({
                    "session_id": "73f64f49-9fa0-4bbe-b434-2ec7d0c670a9",
                    "transcript_path": "/tmp/session.jsonl",
                    "cwd": "/tmp/project"
                })
            )
            .unwrap();
        }
        let hook = read_hook_session(&path).expect("hook session");
        assert_eq!(hook.session_id, "73f64f49-9fa0-4bbe-b434-2ec7d0c670a9");
        assert_eq!(hook.transcript_path.as_deref(), Some("/tmp/session.jsonl"));
        assert_eq!(hook.cwd.as_deref(), Some("/tmp/project"));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn installs_runtime_hooks_for_claude_launches() {
        let mut settings = serde_json::json!({});
        let hook_file = PathBuf::from("/tmp/starling-hook.jsonl");
        let starling_exe = PathBuf::from("/tmp/starling");

        install_claude_runtime_hooks(&mut settings, "run-1", &hook_file, &starling_exe);

        let hooks = settings.get("hooks").and_then(|v| v.as_object()).expect("hooks object");
        for event in CLAUDE_RUNTIME_HOOK_EVENTS {
            let arr = hooks.get(*event).and_then(|v| v.as_array()).expect("event hook");
            let handler = &arr[0]["hooks"][0];
            assert_eq!(handler["type"], "command");
            assert_eq!(handler["command"], "/tmp/starling");
            assert_eq!(handler["args"][0], "top");
            assert_eq!(handler["args"][1], "hook");
            assert_eq!(handler["args"][3], "run-1");
            assert_eq!(handler["args"][5], "/tmp/starling-hook.jsonl");
        }
    }
}

fn prepare_launch(
    provider: RunProvider,
    run_id: &str,
    setting: Option<&str>,
    passthrough_args: &[String],
    attach_hook: bool,
) -> Result<PreparedLaunch> {
    let mut args = Vec::new();
    let mut envs = Vec::new();
    let mut temp_dir = None;
    let mut hook_file = None;

    match provider {
        RunProvider::Claude => {
            if attach_hook {
                let base_settings = if let Some(profile) = setting {
                    let path = default_claude_settings_dir().join(format!("{profile}.json"));
                    ensure_file(&path, "Claude profile")?;
                    Some(path)
                } else {
                    None
                };
                let hook = create_claude_hook_settings(run_id, base_settings.as_deref())?;
                args.push("--settings".into());
                args.push(hook.settings_path.to_string_lossy().to_string());
                hook_file = Some(hook.hook_file);
            } else if let Some(profile) = setting {
                let path = default_claude_settings_dir().join(format!("{profile}.json"));
                ensure_file(&path, "Claude profile")?;
                args.push("--settings".into());
                args.push(path.to_string_lossy().to_string());
            }
        }
        RunProvider::Codex => {
            if let Some(profile) = setting {
                let path = default_codex_settings_dir().join(format!("{profile}.toml"));
                ensure_file(&path, "Codex profile")?;
                let dir = default_starling_home()
                    .join("run-homes")
                    .join(format!("codex-{run_id}"));
                std::fs::create_dir_all(&dir)?;
                std::fs::copy(&path, dir.join("config.toml"))?;
                copy_if_exists(&default_codex_home().join("auth.json"), &dir.join("auth.json"))?;
                envs.push(("CODEX_HOME".into(), dir.to_string_lossy().to_string()));
                temp_dir = Some(dir);
            }
        }
    }

    args.extend(passthrough_args.iter().cloned());
    Ok(PreparedLaunch { args, envs, temp_dir, hook_file })
}

struct ClaudeHookSettings {
    settings_path: PathBuf,
    hook_file: PathBuf,
}

fn create_claude_hook_settings(run_id: &str, base_settings: Option<&Path>) -> Result<ClaudeHookSettings> {
    let dir = default_starling_home().join("run-hooks");
    std::fs::create_dir_all(&dir)?;
    let hook_file = dir.join(format!("{run_id}.jsonl"));
    let settings_path = dir.join(format!("{run_id}.settings.json"));
    let mut settings = if let Some(path) = base_settings {
        let raw = std::fs::read_to_string(path)?;
        serde_json::from_str::<Value>(&raw).unwrap_or_else(|_| serde_json::json!({}))
    } else {
        serde_json::json!({})
    };
    let starling_exe = std::env::current_exe()?;
    install_claude_runtime_hooks(&mut settings, run_id, &hook_file, &starling_exe);
    std::fs::write(&settings_path, serde_json::to_string_pretty(&settings)?)?;
    Ok(ClaudeHookSettings { settings_path, hook_file })
}

fn install_claude_runtime_hooks(settings: &mut Value, run_id: &str, hook_file: &Path, starling_exe: &Path) {
    if !settings.is_object() {
        *settings = serde_json::json!({});
    }
    let hook_file = hook_file.to_string_lossy().to_string();
    let starling_exe = starling_exe.to_string_lossy().to_string();

    let root = settings.as_object_mut().expect("settings object");
    let hooks = root
        .entry("hooks")
        .or_insert_with(|| serde_json::json!({}));
    if !hooks.is_object() {
        *hooks = serde_json::json!({});
    }
    let hooks_obj = hooks.as_object_mut().expect("hooks object");

    for event in CLAUDE_RUNTIME_HOOK_EVENTS {
        let hook = claude_runtime_hook(&starling_exe, run_id, &hook_file);
        let entry = hooks_obj
            .entry(*event)
            .or_insert_with(|| serde_json::json!([]));
        if let Some(arr) = entry.as_array_mut() {
            arr.push(hook);
        } else {
            *entry = serde_json::json!([hook]);
        }
    }
}

const CLAUDE_RUNTIME_HOOK_EVENTS: &[&str] = &[
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PermissionRequest",
    "PostToolUse",
    "PostToolUseFailure",
    "PostToolBatch",
    "Notification",
    "SubagentStart",
    "SubagentStop",
    "TaskCreated",
    "TaskCompleted",
    "Elicitation",
    "ElicitationResult",
    "Stop",
    "StopFailure",
    "TeammateIdle",
    "SessionEnd",
];

fn claude_runtime_hook(starling_exe: &str, run_id: &str, hook_file: &str) -> Value {
    serde_json::json!({
        "hooks": [
            {
                "type": "command",
                "command": starling_exe,
                "args": [
                    "top",
                    "hook",
                    "--run-id",
                    run_id,
                    "--hook-file",
                    hook_file
                ],
                "timeout": 5
            }
        ]
    })
}

fn ensure_file(path: &Path, label: &str) -> Result<()> {
    if path.exists() {
        return Ok(());
    }
    eprintln!("{}: {} not found: {}", "error".red(), label, path.display());
    std::process::exit(2);
}

fn copy_if_exists(from: &Path, to: &Path) -> Result<()> {
    if from.exists() {
        std::fs::copy(from, to)?;
    }
    Ok(())
}

fn cleanup_temp_dir(path: Option<&Path>) {
    if let Some(path) = path {
        let _ = std::fs::remove_dir_all(path);
    }
}

fn update_run_pid(run_id: &str, pid: u32) {
    // Load → patch → save to inject pid into the existing record.
    let mut data = crate::core::runs::load_runs();
    for run in data.runs.iter_mut() {
        if run.run_id == run_id {
            run.pid = Some(pid);
            break;
        }
    }
    crate::core::runs::save_runs(data);
}

fn update_run_session_id(run_id: &str, session_id: &str) {
    let mut data = crate::core::runs::load_runs();
    for run in data.runs.iter_mut() {
        if run.run_id == run_id {
            run.session_id = Some(session_id.to_string());
            break;
        }
    }
    crate::core::runs::save_runs(data);
}

fn status(run_id: Option<&str>, json: bool) -> Result<()> {
    match run_id {
        Some(id) => match find_run(id) {
            Some(r) => {
                if json {
                    println!("{}", serde_json::to_string_pretty(&r)?);
                    return Ok(());
                }
                println!("{}", format!("Run: {}", short(&r.run_id)).cyan().bold());
                println!("  Provider: {:?}", r.provider);
                println!("  Status:   {:?}", r.status);
                println!("  Started:  {}", r.started_at);
                if let Some(end) = &r.ended_at { println!("  Ended:    {}", end); }
                if let Some(pid) = r.pid { println!("  PID:      {}", pid); }
                if let Some(code) = r.exit_code { println!("  Exit:     {}", code); }
                if let Some(p) = &r.project_path { println!("  Project:  {}", p); }
                Ok(())
            }
            None => {
                eprintln!("{}: run not found: {}", "error".red(), id);
                std::process::exit(1);
            }
        },
        None => {
            let runs = list_runs(None);
            if json {
                let recent: Vec<_> = runs.into_iter().take(20).collect();
                println!("{}", serde_json::to_string_pretty(&recent)?);
                return Ok(());
            }
            if runs.is_empty() {
                println!("{}", "No runs recorded.".yellow());
                return Ok(());
            }
            let recent: Vec<_> = runs.into_iter().take(20).collect();
            use comfy_table::{Cell, Color, ContentArrangement, Table, presets::UTF8_FULL};
            let mut table = Table::new();
            table.load_preset(UTF8_FULL).set_content_arrangement(ContentArrangement::Disabled);
            table.set_header(vec![
                Cell::new("Run").fg(Color::Cyan),
                Cell::new("Provider").fg(Color::Cyan),
                Cell::new("Status").fg(Color::Cyan),
                Cell::new("Started").fg(Color::Cyan),
                Cell::new("PID").fg(Color::Cyan),
                Cell::new("Project").fg(Color::Cyan),
            ]);
            for r in recent {
                table.add_row(vec![
                    Cell::new(short(&r.run_id)),
                    Cell::new(format!("{:?}", r.provider)),
                    Cell::new(format!("{:?}", r.status)),
                    Cell::new(&r.started_at),
                    Cell::new(r.pid.map(|p| p.to_string()).unwrap_or_else(|| "-".into())),
                    Cell::new(r.project_path.as_deref().unwrap_or("-")),
                ]);
            }
            println!("{}", table.to_string());
            Ok(())
        }
    }
}

fn stop(run_id: &str, json: bool) -> Result<()> {
    let run = match find_run(run_id) {
        Some(r) => r,
        None => {
            eprintln!("{}: run not found: {}", "error".red(), run_id);
            std::process::exit(1);
        }
    };
    if run.status != RunStatus::Running {
        eprintln!("{}: run {} is not running (status: {:?})",
            "error".red(), short(&run.run_id), run.status);
        std::process::exit(1);
    }
    let pid = match run.pid {
        Some(p) if p > 0 => p,
        _ => {
            eprintln!("{}: run {} has no pid; cannot stop", "error".red(), short(&run.run_id));
            std::process::exit(1);
        }
    };
    terminate_pid(pid, false);
    eprintln!("{}: sent stop signal to pid {} (run {})", "starling".cyan(), pid, short(&run.run_id));
    // Brief grace period
    for _ in 0..50 {
        if !crate::core::runs::is_pid_alive(pid) { break; }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    if crate::core::runs::is_pid_alive(pid) {
        terminate_pid(pid, true);
        eprintln!("{}: escalated stop signal", "starling".cyan());
    }
    finalize_run(run_id, FinalizePatch {
        status: RunStatus::Crashed,
        exit_code: None,
        ended_at: Some(now_iso()),
        session_id: None,
    });
    if json {
        return super::print_json_result(
            "run.stop",
            &format!("Stopped run {}", short(&run.run_id)),
            serde_json::json!({ "run": run, "stopped": true }),
        );
    }
    println!("{}", format!("Stopped run {}", short(&run.run_id)).green());
    Ok(())
}

// Suppress unused-import warning: remove_run is part of the API surface but
// not currently wired through the CLI stop path (we keep the record).
#[allow(dead_code)]
fn _anchor_remove(run_id: &str) -> bool { remove_run(run_id) }

fn short(id: &str) -> String {
    if id.len() > 8 { id[..8].to_string() } else { id.to_string() }
}

#[cfg(unix)]
fn terminate_pid(pid: u32, force: bool) {
    let signal = if force { libc::SIGKILL } else { libc::SIGTERM };
    unsafe {
        libc::kill(pid as i32, signal);
    }
}

#[cfg(windows)]
fn terminate_pid(pid: u32, force: bool) {
    let mut cmd = std::process::Command::new("taskkill");
    cmd.arg("/PID").arg(pid.to_string()).arg("/T");
    if force {
        cmd.arg("/F");
    }
    let _ = cmd.status();
}

#[cfg(not(any(unix, windows)))]
fn terminate_pid(_pid: u32, _force: bool) {}

// --- Signal handler ---
//
// Install a SIGINT/SIGTERM handler that marks the given run as crashed so the
// user's runs.json reflects reality even when starling is killed mid-run. We
// use a static to remember the active run_id (single-run-per-process model).

use std::sync::Mutex;
use once_cell::sync::Lazy;

static ACTIVE_RUN: Lazy<Mutex<Option<String>>> = Lazy::new(|| Mutex::new(None));

fn install_signal_handler(run_id: String) {
    *ACTIVE_RUN.lock().unwrap() = Some(run_id);
    #[cfg(unix)]
    unsafe {
        extern "C" {
            fn signal(signum: i32, handler: usize) -> usize;
        }
        extern "C" fn handle_sig(_sig: i32) {
            if let Ok(g) = ACTIVE_RUN.lock() {
                if let Some(id) = g.as_ref() {
                    mark_run_crashed(id);
                }
            }
            // Re-raise default to terminate.
            unsafe {
                libc::signal(libc::SIGINT, libc::SIG_DFL as usize);
                libc::raise(libc::SIGINT);
            }
        }
        signal(libc::SIGINT, handle_sig as usize);
        signal(libc::SIGTERM, handle_sig as usize);
    }
}
