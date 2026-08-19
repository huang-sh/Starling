use super::*;

pub(super) const CODEX_RUNTIME_HOOK_EVENTS: &[&str] = &[
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PermissionRequest",
    "PostToolUse",
    "SubagentStart",
    "SubagentStop",
    "Stop",
];

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
    let mut envs = Vec::new();
    let mut temp_dir = None;
    let mut cleanup_files = Vec::new();
    let mut hook_file = None;

    if let Some(home) = codex_resume_home_from_args(passthrough_args) {
        if let Some(setting) = setting {
            eprintln!(
                "{}: --setting '{}' is ignored when resuming a session that lives in a per-run CODEX_HOME",
                "warning".yellow(),
                setting
            );
        }
        envs.push(("CODEX_HOME".into(), home.to_string_lossy().to_string()));
    } else if (attach_hook || setting.is_some()) && !has_codex_profile_arg(passthrough_args) {
        let base_config = if let Some(profile) = setting {
            let path = default_codex_settings_dir().join(format!("{profile}.toml"));
            ensure_file(&path, "Codex profile")?;
            Some(path)
        } else {
            None
        };
        let hook = create_codex_profile_launch(
            run_id,
            base_config.as_deref(),
            attach_hook,
            mcp_names,
            mcp_profile,
            no_mcp,
        )?;
        if attach_hook {
            args.extend(["--enable".into(), "hooks".into()]);
        }
        args.extend(["--profile".into(), hook.profile_name]);
        hook_file = hook.hook_file;
        cleanup_files.push(hook.profile_path);
    } else if attach_hook || setting.is_some() {
        if let Some(setting) = setting {
            eprintln!(
                "{}: --setting '{}' is merged as the base config; your own --profile argument still applies on top and wins conflicts",
                "warning".yellow(),
                setting
            );
        }
        let base_config = if let Some(profile) = setting {
            let path = default_codex_settings_dir().join(format!("{profile}.toml"));
            ensure_file(&path, "Codex profile")?;
            Some(path)
        } else {
            let path = default_codex_home().join("config.toml");
            path.exists().then_some(path)
        };
        let hook = create_codex_hook_home(
            run_id,
            base_config.as_deref(),
            attach_hook,
            mcp_names,
            mcp_profile,
            no_mcp,
        )?;
        if attach_hook {
            args.extend(["--enable".into(), "hooks".into()]);
        }
        envs.push((
            "CODEX_HOME".into(),
            hook.home_dir.to_string_lossy().to_string(),
        ));
        hook_file = hook.hook_file;
        temp_dir = Some(hook.home_dir);
    }

    args.extend_from_slice(passthrough_args);
    Ok(PreparedLaunch {
        args,
        envs,
        temp_dir,
        cleanup_files,
        hook_file,
        session_id_hint: None,
        session_project_hint: None,
    })
}

pub(super) fn has_codex_profile_arg(args: &[String]) -> bool {
    args.iter()
        .any(|arg| arg == "--profile" || arg == "-p" || arg.strip_prefix("--profile=").is_some())
}

pub(super) fn codex_resume_home_from_args(args: &[String]) -> Option<PathBuf> {
    let session_id = args
        .windows(2)
        .find(|window| window[0] == "resume")
        .map(|window| window[1].as_str())?;
    let meta = find_session_by_id(session_id)?;
    codex_home_from_session_path(&meta.file_path)
}

pub(super) fn codex_home_from_session_path(file_path: &str) -> Option<PathBuf> {
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
pub(super) struct CodexHookHome {
    pub(super) home_dir: PathBuf,
    pub(super) hook_file: Option<PathBuf>,
}

pub(super) struct CodexProfileLaunch {
    pub(super) profile_name: String,
    pub(super) profile_path: PathBuf,
    pub(super) hook_file: Option<PathBuf>,
}
pub(super) fn create_codex_hook_home(
    run_id: &str,
    base_config: Option<&Path>,
    attach_hook: bool,
    mcp_names: &[String],
    mcp_profile: Option<&str>,
    no_mcp: bool,
) -> Result<CodexHookHome> {
    let dir = default_starling_home()
        .join("run-homes")
        .join(format!("codex-{run_id}"));
    std::fs::create_dir_all(&dir)?;
    link_codex_persistent_session_dirs(&dir)?;

    let mut config = if let Some(path) = base_config {
        std::fs::read_to_string(path)?
    } else {
        String::new()
    };
    config = normalize_codex_external_provider_auth(&config);
    if attach_hook {
        config = strip_legacy_codex_hooks_bool(&config);
    }
    let needs_starling_exe = attach_hook || mcp_injection_requested(no_mcp);
    let starling_exe = if needs_starling_exe {
        Some(std::env::current_exe()?)
    } else {
        None
    };
    if mcp_injection_requested(no_mcp) {
        let mcp_servers = selected_mcp_servers(
            mcp_names,
            mcp_profile,
            no_mcp,
            starling_exe.as_ref().expect("starling exe for mcp"),
        )?;
        config = upsert_codex_mcp_servers(&config, &mcp_servers)?;
    }
    let hook_file = if attach_hook {
        let hook_dir = default_starling_home().join("run-hooks");
        std::fs::create_dir_all(&hook_dir)?;
        let hook_file = hook_dir.join(format!("{run_id}.jsonl"));
        config = append_codex_hook_trust_state(
            &config,
            &dir.join("hooks.json"),
            run_id,
            &hook_file,
            starling_exe.as_ref().expect("starling exe for hooks"),
        )?;
        install_codex_runtime_hooks(
            &dir,
            run_id,
            &hook_file,
            starling_exe.as_ref().expect("starling exe for hooks"),
        )?;
        Some(hook_file)
    } else {
        None
    };
    write_private_file(&dir.join("config.toml"), &config)?;

    copy_if_exists(
        &default_codex_home().join("auth.json"),
        &dir.join("auth.json"),
    )?;

    Ok(CodexHookHome {
        home_dir: dir,
        hook_file,
    })
}

pub(super) fn create_codex_profile_launch(
    run_id: &str,
    base_config: Option<&Path>,
    attach_hook: bool,
    mcp_names: &[String],
    mcp_profile: Option<&str>,
    no_mcp: bool,
) -> Result<CodexProfileLaunch> {
    let codex_home = default_codex_home();
    std::fs::create_dir_all(&codex_home)?;

    let profile_name = format!("starling-{run_id}");
    let profile_path = codex_home.join(format!("{profile_name}.config.toml"));
    let mut config = if let Some(path) = base_config {
        std::fs::read_to_string(path)?
    } else {
        String::new()
    };
    config = normalize_codex_external_provider_auth(&config);

    let needs_starling_exe = attach_hook || mcp_injection_requested(no_mcp);
    let starling_exe = if needs_starling_exe {
        Some(std::env::current_exe()?)
    } else {
        None
    };
    if mcp_injection_requested(no_mcp) {
        let mcp_servers = selected_mcp_servers(
            mcp_names,
            mcp_profile,
            no_mcp,
            starling_exe.as_ref().expect("starling exe for mcp"),
        )?;
        config = upsert_codex_mcp_servers(&config, &mcp_servers)?;
    }

    let hook_file = if attach_hook {
        config = strip_legacy_codex_hooks_bool(&config);
        let hook_dir = default_starling_home().join("run-hooks");
        std::fs::create_dir_all(&hook_dir)?;
        let hook_file = hook_dir.join(format!("{run_id}.jsonl"));
        config = append_codex_profile_runtime_hooks(
            &config,
            &profile_path,
            run_id,
            &hook_file,
            starling_exe.as_ref().expect("starling exe for hooks"),
        )?;
        Some(hook_file)
    } else {
        None
    };

    write_private_file(&profile_path, &config)?;
    Ok(CodexProfileLaunch {
        profile_name,
        profile_path,
        hook_file,
    })
}

pub(super) fn link_codex_persistent_session_dirs(run_home: &Path) -> Result<()> {
    let codex_home = default_codex_home();
    link_codex_persistent_dir(run_home, &codex_home, "sessions")?;
    link_codex_persistent_dir(run_home, &codex_home, "archived_sessions")?;
    Ok(())
}

pub(super) fn link_codex_persistent_dir(
    run_home: &Path,
    codex_home: &Path,
    name: &str,
) -> Result<()> {
    let target = codex_home.join(name);
    std::fs::create_dir_all(&target)?;
    let link = run_home.join(name);

    if link.exists() || std::fs::symlink_metadata(&link).is_ok() {
        if is_empty_real_dir(&link) {
            std::fs::remove_dir(&link)?;
        } else {
            return Ok(());
        }
    }

    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&target, &link)?;
    }
    #[cfg(windows)]
    {
        std::os::windows::fs::symlink_dir(&target, &link)?;
    }
    Ok(())
}

pub(super) fn is_empty_real_dir(path: &Path) -> bool {
    let Ok(metadata) = std::fs::symlink_metadata(path) else {
        return false;
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return false;
    }
    std::fs::read_dir(path)
        .map(|mut entries| entries.next().is_none())
        .unwrap_or(false)
}

pub(super) fn append_codex_hook_trust_state(
    config: &str,
    hooks_json_path: &Path,
    run_id: &str,
    hook_file: &Path,
    starling_exe: &Path,
) -> Result<String> {
    let starling_exe = starling_exe.to_string_lossy().to_string();
    let hook_file = hook_file.to_string_lossy().to_string();
    let hooks_json_path = hooks_json_path.to_string_lossy().to_string();
    let mut rendered = config.trim_end().to_string();
    if !rendered.is_empty() {
        rendered.push_str("\n\n");
    }
    for event in CODEX_RUNTIME_HOOK_EVENTS {
        let event_key = codex_hook_event_key(event);
        let command = codex_runtime_hook_command(&starling_exe, run_id, &hook_file, event);
        let hash = codex_command_hook_hash(event_key, &command, 5)?;
        rendered.push_str(&format!(
            "[hooks.state.\"{}:{}:0:0\"]\ntrusted_hash = \"{}\"\n\n",
            hooks_json_path.replace('\\', "\\\\").replace('"', "\\\""),
            event_key,
            hash
        ));
    }
    Ok(rendered)
}

pub(super) fn append_codex_profile_runtime_hooks(
    config: &str,
    profile_path: &Path,
    run_id: &str,
    hook_file: &Path,
    starling_exe: &Path,
) -> Result<String> {
    let starling_exe = starling_exe.to_string_lossy().to_string();
    let hook_file = hook_file.to_string_lossy().to_string();
    let profile_path = profile_path.to_string_lossy().to_string();
    let mut rendered = config.trim_end().to_string();
    if !rendered.is_empty() {
        rendered.push_str("\n\n");
    }

    for event in CODEX_RUNTIME_HOOK_EVENTS {
        let event_key = codex_hook_event_key(event);
        let command = codex_runtime_hook_command(&starling_exe, run_id, &hook_file, event);
        let hash = codex_command_hook_hash(event_key, &command, 5)?;
        rendered.push_str(&format!(
            "[hooks.state.\"{}:{}:0:0\"]\ntrusted_hash = \"{}\"\n\n",
            profile_path.replace('\\', "\\\\").replace('"', "\\\""),
            event_key,
            hash
        ));
    }

    for event in CODEX_RUNTIME_HOOK_EVENTS {
        let command = codex_runtime_hook_command(&starling_exe, run_id, &hook_file, event);
        rendered.push_str(&format!(
            "[[hooks.{event}]]\n\n[[hooks.{event}.hooks]]\ntype = \"command\"\ncommand = \"{}\"\ntimeout = 5\n\n",
            toml_escape_basic(&command)
        ));
    }

    Ok(rendered)
}

pub(super) fn normalize_codex_external_provider_auth(config: &str) -> String {
    let Ok(mut value) = config.parse::<toml::Value>() else {
        return config.to_string();
    };
    let Some(provider_id) = value
        .get("model_provider")
        .and_then(|provider| provider.as_str())
        .map(str::to_string)
    else {
        return config.to_string();
    };
    if provider_id == "openai" {
        return config.to_string();
    }

    let Some(provider) = value
        .get_mut("model_providers")
        .and_then(|providers| providers.as_table_mut())
        .and_then(|providers| providers.get_mut(&provider_id))
        .and_then(|provider| provider.as_table_mut())
    else {
        return config.to_string();
    };

    provider.insert(
        "requires_openai_auth".to_string(),
        toml::Value::Boolean(false),
    );
    toml::to_string_pretty(&value).unwrap_or_else(|_| config.to_string())
}

pub(super) fn upsert_codex_mcp_servers(
    config: &str,
    servers: &BTreeMap<String, McpServerConfig>,
) -> Result<String> {
    if servers.is_empty() {
        return Ok(config.to_string());
    }
    let parsed = if config.trim().is_empty() {
        Ok(toml::Value::Table(toml::map::Map::new()))
    } else {
        config.parse::<toml::Value>()
    };
    let Ok(mut value) = parsed else {
        return Ok(append_codex_mcp_server_blocks(config, servers));
    };
    let Some(root) = value.as_table_mut() else {
        return Ok(append_codex_mcp_server_blocks(config, servers));
    };
    let mcp_servers = root
        .entry("mcp_servers".to_string())
        .or_insert_with(|| toml::Value::Table(toml::map::Map::new()));
    let Some(mcp_servers) = mcp_servers.as_table_mut() else {
        return Ok(append_codex_mcp_server_blocks(config, servers));
    };
    for (name, server) in servers {
        let table = codex_mcp_server_table(server);
        mcp_servers.insert(name.clone(), toml::Value::Table(table));
    }
    toml::to_string_pretty(&value).map_err(Into::into)
}

pub(super) fn codex_mcp_server_table(
    server: &McpServerConfig,
) -> toml::map::Map<String, toml::Value> {
    let mut table = toml::map::Map::new();
    match server.r#type.as_str() {
        "http" => {
            table.insert("type".to_string(), toml::Value::String("http".to_string()));
            if let Some(url) = &server.url {
                table.insert("url".to_string(), toml::Value::String(url.clone()));
            }
            if !server.headers.is_empty() {
                table.insert(
                    "headers".to_string(),
                    toml::Value::Table(
                        server
                            .headers
                            .iter()
                            .map(|(key, value)| (key.clone(), toml::Value::String(value.clone())))
                            .collect(),
                    ),
                );
            }
        }
        _ => {
            table.insert(
                "command".to_string(),
                toml::Value::String(server.command.clone().unwrap_or_default()),
            );
            table.insert(
                "args".to_string(),
                toml::Value::Array(
                    server
                        .args
                        .iter()
                        .cloned()
                        .map(toml::Value::String)
                        .collect(),
                ),
            );
            if !server.env.is_empty() {
                table.insert(
                    "env".to_string(),
                    toml::Value::Table(
                        server
                            .env
                            .iter()
                            .map(|(key, value)| (key.clone(), toml::Value::String(value.clone())))
                            .collect(),
                    ),
                );
            }
        }
    }
    table
}

pub(super) fn append_codex_mcp_server_blocks(
    config: &str,
    servers: &BTreeMap<String, McpServerConfig>,
) -> String {
    let mut rendered = config.trim_end().to_string();
    if !rendered.is_empty() {
        rendered.push_str("\n\n");
    }
    for (name, server) in servers {
        rendered.push_str(&format!("[mcp_servers.{}]\n", toml_escape_basic_key(name)));
        match server.r#type.as_str() {
            "http" => {
                rendered.push_str("type = \"http\"\n");
                if let Some(url) = &server.url {
                    rendered.push_str(&format!("url = \"{}\"\n", toml_escape_basic(url)));
                }
                if !server.headers.is_empty() {
                    rendered.push_str(&format!(
                        "[mcp_servers.{}.headers]\n",
                        toml_escape_basic_key(name)
                    ));
                    for (key, value) in &server.headers {
                        rendered.push_str(&format!(
                            "{} = \"{}\"\n",
                            toml_escape_basic_key(key),
                            toml_escape_basic(value)
                        ));
                    }
                }
            }
            _ => {
                rendered.push_str(&format!(
                    "command = \"{}\"\n",
                    toml_escape_basic(server.command.as_deref().unwrap_or(""))
                ));
                let args = server
                    .args
                    .iter()
                    .map(|arg| format!("\"{}\"", toml_escape_basic(arg)))
                    .collect::<Vec<_>>()
                    .join(", ");
                rendered.push_str(&format!("args = [{args}]\n"));
                if !server.env.is_empty() {
                    rendered.push_str(&format!(
                        "[mcp_servers.{}.env]\n",
                        toml_escape_basic_key(name)
                    ));
                    for (key, value) in &server.env {
                        rendered.push_str(&format!(
                            "{} = \"{}\"\n",
                            toml_escape_basic_key(key),
                            toml_escape_basic(value)
                        ));
                    }
                }
            }
        }
        rendered.push('\n');
    }
    rendered
}

pub(super) fn toml_escape_basic_key(value: &str) -> String {
    if value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'))
    {
        value.to_string()
    } else {
        format!("\"{}\"", toml_escape_basic(value))
    }
}

pub(super) fn toml_escape_basic(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '\\' => escaped.push_str("\\\\"),
            '"' => escaped.push_str("\\\""),
            '\n' => escaped.push_str("\\n"),
            '\r' => escaped.push_str("\\r"),
            '\t' => escaped.push_str("\\t"),
            c => escaped.push(c),
        }
    }
    escaped
}

pub(super) fn strip_legacy_codex_hooks_bool(config: &str) -> String {
    let mut in_table = false;
    let mut out = Vec::new();
    for line in config.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') {
            in_table = true;
        }
        let is_legacy_hooks_bool = !in_table
            && trimmed
                .strip_prefix("hooks")
                .and_then(|rest| rest.trim_start().strip_prefix('='))
                .map(|value| matches!(value.trim(), "true" | "false"))
                .unwrap_or(false);
        if !is_legacy_hooks_bool {
            out.push(line.to_string());
        }
    }
    let mut rendered = out.join("\n");
    if config.ends_with('\n') && !rendered.is_empty() {
        rendered.push('\n');
    }
    rendered
}

pub(super) fn install_codex_runtime_hooks(
    home_dir: &Path,
    run_id: &str,
    hook_file: &Path,
    starling_exe: &Path,
) -> Result<()> {
    let hook_file = hook_file.to_string_lossy().to_string();
    let starling_exe = starling_exe.to_string_lossy().to_string();
    let mut hooks = serde_json::Map::new();
    for event in CODEX_RUNTIME_HOOK_EVENTS {
        hooks.insert(
            (*event).to_string(),
            serde_json::json!([{
                "hooks": [{
                    "type": "command",
                    "command": codex_runtime_hook_command(&starling_exe, run_id, &hook_file, event),
                    "timeout": 5
                }]
            }]),
        );
    }
    let value = serde_json::json!({ "hooks": hooks });
    std::fs::write(
        home_dir.join("hooks.json"),
        serde_json::to_string_pretty(&value)?,
    )?;
    Ok(())
}

pub(super) fn codex_runtime_hook_command(
    starling_exe: &str,
    run_id: &str,
    hook_file: &str,
    event: &str,
) -> String {
    [
        shell_quote(starling_exe),
        "top".to_string(),
        "hook".to_string(),
        "--provider".to_string(),
        "codex".to_string(),
        "--event".to_string(),
        shell_quote(event),
        "--run-id".to_string(),
        shell_quote(run_id),
        "--hook-file".to_string(),
        shell_quote(hook_file),
    ]
    .join(" ")
}
#[derive(Serialize)]
struct CodexNormalizedHookIdentity {
    event_name: String,
    #[serde(flatten)]
    group: CodexMatcherGroup,
}

#[derive(Serialize)]
struct CodexMatcherGroup {
    #[serde(skip_serializing_if = "Option::is_none")]
    matcher: Option<String>,
    hooks: Vec<CodexHookHandlerConfig>,
}

#[derive(Serialize)]
#[serde(tag = "type")]
enum CodexHookHandlerConfig {
    #[serde(rename = "command")]
    Command {
        command: String,
        #[serde(rename = "commandWindows", skip_serializing_if = "Option::is_none")]
        command_windows: Option<String>,
        #[serde(rename = "timeout")]
        timeout_sec: Option<u64>,
        r#async: bool,
        #[serde(rename = "statusMessage", skip_serializing_if = "Option::is_none")]
        status_message: Option<String>,
    },
}

pub(super) fn codex_command_hook_hash(
    event_key: &str,
    command: &str,
    timeout_sec: u64,
) -> Result<String> {
    let identity = CodexNormalizedHookIdentity {
        event_name: event_key.to_string(),
        group: CodexMatcherGroup {
            matcher: None,
            hooks: vec![CodexHookHandlerConfig::Command {
                command: command.to_string(),
                command_windows: None,
                timeout_sec: Some(timeout_sec),
                r#async: false,
                status_message: None,
            }],
        },
    };
    let value = toml::Value::try_from(identity)?;
    Ok(version_for_toml_value(&value))
}

pub(super) fn version_for_toml_value(value: &toml::Value) -> String {
    let json = serde_json::to_value(value).unwrap_or(Value::Null);
    let canonical = canonical_json(&json);
    let serialized = serde_json::to_vec(&canonical).unwrap_or_default();
    let mut hasher = Sha256::new();
    hasher.update(serialized);
    let hash = hasher.finalize();
    let hex = hash
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("sha256:{hex}")
}

pub(super) fn canonical_json(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut sorted = serde_json::Map::new();
            let mut keys = map.keys().cloned().collect::<Vec<_>>();
            keys.sort();
            for key in keys {
                if let Some(val) = map.get(&key) {
                    sorted.insert(key, canonical_json(val));
                }
            }
            Value::Object(sorted)
        }
        Value::Array(items) => Value::Array(items.iter().map(canonical_json).collect()),
        other => other.clone(),
    }
}

pub(super) fn codex_hook_event_key(event: &str) -> &'static str {
    match event {
        "SessionStart" => "session_start",
        "UserPromptSubmit" => "user_prompt_submit",
        "PreToolUse" => "pre_tool_use",
        "PermissionRequest" => "permission_request",
        "PostToolUse" => "post_tool_use",
        "SubagentStart" => "subagent_start",
        "SubagentStop" => "subagent_stop",
        "Stop" => "stop",
        _ => "unknown",
    }
}
