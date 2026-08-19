use super::*;

pub(super) fn prepare(
    run_id: &str,
    setting: Option<&str>,
    passthrough_args: &[String],
    attach_hook: bool,
    mcp_names: &[String],
    mcp_profile: Option<&str>,
    no_mcp: bool,
) -> Result<PreparedLaunch> {
    let mut args = Vec::new();
    let mut hook_file = None;

    if attach_hook {
        let base_settings = if let Some(profile) = setting {
            let path = default_claude_settings_dir().join(format!("{profile}.json"));
            ensure_file(&path, "Claude profile")?;
            Some(path)
        } else {
            None
        };
        let hook = create_claude_hook_settings(
            run_id,
            base_settings.as_deref(),
            mcp_names,
            mcp_profile,
            no_mcp,
        )?;
        args.extend([
            "--settings".into(),
            hook.settings_path.to_string_lossy().to_string(),
        ]);
        if let Some(path) = &hook.mcp_config_path {
            args.extend(["--mcp-config".into(), path.to_string_lossy().to_string()]);
        }
        if let Some(model) = hook
            .model
            .as_deref()
            .filter(|_| !has_claude_model_arg(passthrough_args))
        {
            args.extend(["--model".into(), model.to_string()]);
        }
        hook_file = Some(hook.hook_file);
    } else if let Some(profile) = setting {
        let path = default_claude_settings_dir().join(format!("{profile}.json"));
        ensure_file(&path, "Claude profile")?;
        args.extend(["--settings".into(), path.to_string_lossy().to_string()]);
    }

    args.extend_from_slice(passthrough_args);
    Ok(PreparedLaunch {
        args,
        envs: Vec::new(),
        temp_dir: None,
        cleanup_files: Vec::new(),
        hook_file,
        session_id_hint: None,
        session_project_hint: None,
    })
}

pub(super) struct ClaudeHookSettings {
    pub(super) settings_path: PathBuf,
    pub(super) mcp_config_path: Option<PathBuf>,
    pub(super) model: Option<String>,
    pub(super) hook_file: PathBuf,
}

pub(super) fn create_claude_hook_settings(
    run_id: &str,
    base_settings: Option<&Path>,
    mcp_names: &[String],
    mcp_profile: Option<&str>,
    no_mcp: bool,
) -> Result<ClaudeHookSettings> {
    let dir = default_starling_home().join("run-hooks");
    std::fs::create_dir_all(&dir)?;
    let hook_file = dir.join(format!("{run_id}.jsonl"));
    let settings_path = dir.join(format!("{run_id}.settings.json"));
    let mcp_config_path = dir.join(format!("{run_id}.mcp.json"));
    let mut settings = if let Some(path) = base_settings {
        let raw = std::fs::read_to_string(path)?;
        serde_json::from_str::<Value>(&raw).map_err(|error| {
            anyhow::anyhow!("invalid Claude profile {}: {error}", path.display())
        })?
    } else {
        serde_json::json!({})
    };
    let model = claude_model_from_settings(&settings);
    normalize_claude_permission_rules(&mut settings);
    let starling_exe = std::env::current_exe()?;
    let mcp_servers = selected_mcp_servers(mcp_names, mcp_profile, no_mcp, &starling_exe)?;
    install_claude_runtime_hooks(&mut settings, run_id, &hook_file, &starling_exe);
    let mcp_config_path = if mcp_servers.is_empty() {
        None
    } else {
        let config = serde_json::json!({
            "mcpServers": mcp_servers_to_claude_json(&mcp_servers)
        });
        write_private_file(&mcp_config_path, &serde_json::to_string_pretty(&config)?)?;
        Some(mcp_config_path.clone())
    };
    write_private_file(&settings_path, &serde_json::to_string_pretty(&settings)?)?;
    Ok(ClaudeHookSettings {
        settings_path,
        mcp_config_path,
        model,
        hook_file,
    })
}

pub(super) fn has_claude_model_arg(args: &[String]) -> bool {
    args.iter()
        .any(|arg| arg == "--model" || arg.strip_prefix("--model=").is_some())
}

pub(super) fn claude_model_from_settings(settings: &Value) -> Option<String> {
    let env = settings.get("env").and_then(|v| v.as_object())?;
    // ANTHROPIC_MODEL is the user's explicit default-model intent. Check it
    // first so a derived --model cannot silently override it with a tier alias.
    for key in [
        "ANTHROPIC_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    ] {
        if let Some(value) = env
            .get(key)
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            return Some(value.trim().to_string());
        }
    }
    None
}

pub(super) fn normalize_claude_permission_rules(settings: &mut Value) {
    let Some(permissions) = settings
        .get_mut("permissions")
        .and_then(|value| value.as_object_mut())
    else {
        return;
    };
    for key in ["allow", "deny", "ask"] {
        let Some(rules) = permissions
            .get_mut(key)
            .and_then(|value| value.as_array_mut())
        else {
            continue;
        };
        let mut normalized = Vec::new();
        for rule in rules.drain(..) {
            if let Some(text) = rule.as_str() {
                if key == "allow" {
                    normalized.push(Value::String(normalize_claude_allow_rule(text)));
                } else {
                    normalized.push(Value::String(text.to_string()));
                }
            } else {
                normalized.push(rule);
            }
        }
        *rules = normalized;
    }
}

pub(super) fn normalize_claude_allow_rule(rule: &str) -> String {
    match rule {
        "Edit:*" => "Edit",
        "Write:*" => "Write",
        "MultiEdit:*" => "MultiEdit",
        "NotebookEdit:*" => "NotebookEdit",
        "Bash:*" => "Bash",
        _ => rule,
    }
    .to_string()
}
pub(super) fn install_claude_runtime_hooks(
    settings: &mut Value,
    run_id: &str,
    hook_file: &Path,
    starling_exe: &Path,
) {
    if !settings.is_object() {
        *settings = serde_json::json!({});
    }
    let hook_file = hook_file.to_string_lossy().to_string();
    let starling_exe = starling_exe.to_string_lossy().to_string();

    let root = settings.as_object_mut().expect("settings object");
    let hooks = root.entry("hooks").or_insert_with(|| serde_json::json!({}));
    if !hooks.is_object() {
        *hooks = serde_json::json!({});
    }
    let hooks_obj = hooks.as_object_mut().expect("hooks object");

    for event in claude_runtime_hook_events(claude_user_prompt_hook_enabled()) {
        let hook = claude_runtime_hook(&starling_exe, run_id, &hook_file);
        let entry = hooks_obj
            .entry(event)
            .or_insert_with(|| serde_json::json!([]));
        if let Some(arr) = entry.as_array_mut() {
            arr.push(hook);
        } else {
            *entry = serde_json::json!([hook]);
        }
    }

    root.entry("statusLine")
        .or_insert_with(|| claude_runtime_status_line(&starling_exe, run_id, &hook_file));
}

pub(super) fn mcp_servers_to_claude_json(servers: &BTreeMap<String, McpServerConfig>) -> Value {
    let mut mcp_servers = serde_json::Map::new();
    for (name, server) in servers {
        mcp_servers.insert(name.clone(), claude_mcp_server_entry(server));
    }
    Value::Object(mcp_servers)
}

pub(super) fn claude_mcp_server_entry(server: &McpServerConfig) -> Value {
    match server.r#type.as_str() {
        "http" => {
            let mut entry = serde_json::json!({
                "type": "http",
                "url": server.url
            });
            if !server.headers.is_empty() {
                entry["headers"] =
                    serde_json::to_value(&server.headers).unwrap_or_else(|_| serde_json::json!({}));
            }
            entry
        }
        _ => {
            let mut entry = serde_json::json!({
                "type": "stdio",
                "command": server.command,
                "args": server.args
            });
            if !server.env.is_empty() {
                entry["env"] =
                    serde_json::to_value(&server.env).unwrap_or_else(|_| serde_json::json!({}));
            }
            entry
        }
    }
}

pub(super) const CLAUDE_RUNTIME_HOOK_EVENTS: &[&str] = &[
    "UserPromptSubmit",
    "SessionStart",
    "PreToolUse",
    "PermissionRequest",
    "Notification",
    "Stop",
    "StopFailure",
    "SessionEnd",
];
const CLAUDE_USER_PROMPT_HOOK_ENV: &str = "STARLING_CLAUDE_USER_PROMPT_HOOK";

pub(super) fn claude_runtime_hook_events(include_user_prompt: bool) -> Vec<&'static str> {
    let mut events = CLAUDE_RUNTIME_HOOK_EVENTS.to_vec();
    if !include_user_prompt {
        events.retain(|event| *event != "UserPromptSubmit");
    }
    events
}

pub(super) fn claude_user_prompt_hook_enabled() -> bool {
    match std::env::var(CLAUDE_USER_PROMPT_HOOK_ENV) {
        Ok(value) => !matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "0" | "false" | "no" | "off"
        ),
        Err(_) => true,
    }
}
pub(super) fn claude_runtime_hook(starling_exe: &str, run_id: &str, hook_file: &str) -> Value {
    serde_json::json!({
        "hooks": [
            {
                "type": "command",
                "command": claude_runtime_hook_command(starling_exe, run_id, hook_file),
                "timeout": 5
            }
        ]
    })
}

pub(super) fn claude_runtime_hook_command(
    starling_exe: &str,
    run_id: &str,
    hook_file: &str,
) -> String {
    [
        shell_quote(starling_exe),
        "top".to_string(),
        "hook".to_string(),
        "--provider".to_string(),
        "claude".to_string(),
        "--run-id".to_string(),
        shell_quote(run_id),
        "--hook-file".to_string(),
        shell_quote(hook_file),
    ]
    .join(" ")
}

pub(super) fn claude_runtime_status_line(
    starling_exe: &str,
    run_id: &str,
    hook_file: &str,
) -> Value {
    serde_json::json!({
        "type": "command",
        "command": claude_runtime_status_line_command(starling_exe, run_id, hook_file),
        "padding": 0
    })
}

pub(super) fn claude_runtime_status_line_command(
    starling_exe: &str,
    run_id: &str,
    hook_file: &str,
) -> String {
    [
        shell_quote(starling_exe),
        "top".to_string(),
        "hook".to_string(),
        "--provider".to_string(),
        "claude".to_string(),
        "--event".to_string(),
        "StatusLine".to_string(),
        "--run-id".to_string(),
        shell_quote(run_id),
        "--hook-file".to_string(),
        shell_quote(hook_file),
    ]
    .join(" ")
}
