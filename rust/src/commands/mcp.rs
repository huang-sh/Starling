//! `starling mcp` — stdio Model Context Protocol server.

use std::collections::BTreeMap;
use std::fs;
use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use anyhow::{bail, Result};
use base64::Engine;
use serde_json::{json, Value};

use crate::cli::{McpAction, McpCommand, McpProfileAction, McpToolSet};
use crate::core::mcp_config::{load_mcp_config, parse_env_pair, save_mcp_config, McpServerConfig};

const PROTOCOL_VERSION: &str = "2025-06-18";

pub fn handle(cmd: McpCommand) -> Result<()> {
    if let Some(action) = cmd.action {
        return handle_action(action);
    }
    if cmd.transport != "stdio" {
        bail!(
            "unsupported MCP transport: {} (only stdio is supported)",
            cmd.transport
        );
    }
    run_stdio(cmd.tools)
}

fn handle_action(action: McpAction) -> Result<()> {
    match action {
        McpAction::List { json } => list_servers(json),
        McpAction::Add {
            name,
            server_type,
            command,
            url,
            args,
            env,
            headers,
            command_args,
            disabled,
            json,
        } => add_server(
            &name,
            server_type,
            command,
            url,
            args,
            env,
            headers,
            command_args,
            disabled,
            json,
        ),
        McpAction::Get { name, json } => get_server(&name, json),
        McpAction::Remove { name, json } => remove_server(&name, json),
        McpAction::Enable { name, json } => set_server_enabled(&name, true, json),
        McpAction::Disable { name, json } => set_server_enabled(&name, false, json),
        McpAction::Profile(action) => handle_profile_action(action),
    }
}

fn list_servers(json_output: bool) -> Result<()> {
    let config = load_mcp_config();
    if json_output {
        println!("{}", serde_json::to_string_pretty(&config)?);
        return Ok(());
    }
    println!("MCP servers:");
    for (name, server) in &config.mcp_servers {
        let status = if server.enabled {
            "enabled"
        } else {
            "disabled"
        };
        let builtin = if server.builtin { " builtin" } else { "" };
        let target = server_display_target(server);
        println!(
            "  {name:<18} {status:<8}{builtin:<9} {:<6} {}",
            server.r#type, target
        );
    }
    println!();
    println!("Default profile: {}", config.default_profile);
    Ok(())
}

fn get_server(name: &str, json_output: bool) -> Result<()> {
    let config = load_mcp_config();
    let Some(server) = config.mcp_servers.get(name) else {
        bail!("MCP server not found: {name}");
    };
    if json_output {
        println!("{}", serde_json::to_string_pretty(server)?);
        return Ok(());
    }
    let status = if server.enabled {
        "enabled"
    } else {
        "disabled"
    };
    println!("MCP server: {name}");
    println!("  Type: {}", server.r#type);
    println!("  Status: {status}");
    println!("  Builtin: {}", server.builtin);
    match server.r#type.as_str() {
        "http" => {
            println!("  URL: {}", server.url.as_deref().unwrap_or("-"));
            if !server.headers.is_empty() {
                println!("  Headers:");
                for key in server.headers.keys() {
                    println!("    {key}");
                }
            }
        }
        _ => {
            println!("  Command: {}", server.command.as_deref().unwrap_or("-"));
            if !server.args.is_empty() {
                println!("  Args: {}", server.args.join(" "));
            }
            if !server.env.is_empty() {
                println!("  Env:");
                for key in server.env.keys() {
                    println!("    {key}");
                }
            }
        }
    }
    Ok(())
}

fn server_display_target(server: &McpServerConfig) -> String {
    match server.r#type.as_str() {
        "http" => server.url.clone().unwrap_or_else(|| "-".to_string()),
        _ => {
            let command = server.command.clone().unwrap_or_else(|| "-".to_string());
            if server.args.is_empty() {
                command
            } else {
                format!("{} {}", command, server.args.join(" "))
            }
        }
    }
}

fn add_server(
    name: &str,
    server_type: Option<String>,
    command: Option<String>,
    url: Option<String>,
    args: Vec<String>,
    env: Vec<String>,
    headers: Vec<String>,
    command_args: Vec<String>,
    disabled: bool,
    json_output: bool,
) -> Result<()> {
    validate_name(name)?;
    if name == "starling" {
        bail!("builtin MCP server 'starling' cannot be replaced");
    }
    let explicit_type = server_type
        .as_deref()
        .map(|value| value.to_ascii_lowercase());
    let likely_http = explicit_type.as_deref() == Some("http")
        || url.is_some()
        || command_args
            .first()
            .map(|value| value.starts_with("http://") || value.starts_with("https://"))
            .unwrap_or(false);
    let (command_args, trailing_headers) = if likely_http {
        parse_http_trailing_args(command_args)?
    } else {
        (command_args, Vec::new())
    };
    let mut env_map = BTreeMap::new();
    for pair in env {
        let (key, value) = parse_env_pair(&pair)?;
        env_map.insert(key, value);
    }
    let mut header_map = BTreeMap::new();
    for pair in headers.into_iter().chain(trailing_headers) {
        let (key, value) = parse_header_pair(&pair)?;
        header_map.insert(key, value);
    }
    let positional_url = command_args
        .first()
        .filter(|value| value.starts_with("http://") || value.starts_with("https://"))
        .cloned();
    let inferred_type = if url.is_some() || positional_url.is_some() {
        "http"
    } else {
        "stdio"
    };
    let server_type = explicit_type.unwrap_or_else(|| inferred_type.to_string());
    let server = match server_type.as_str() {
        "stdio" => {
            if !command_args.is_empty() && (command.is_some() || !args.is_empty()) {
                bail!("use either --command/--arg or trailing `-- command args...`, not both");
            }
            let (command, args) = if command_args.is_empty() {
                let Some(command) = command.filter(|value| !value.trim().is_empty()) else {
                    bail!("stdio MCP server requires --command or trailing `-- command args...`");
                };
                (command, args)
            } else {
                let mut iter = command_args.into_iter();
                let command = iter.next().unwrap_or_default();
                if command.trim().is_empty() {
                    bail!("stdio MCP server command cannot be empty");
                }
                (command, iter.collect())
            };
            if url.is_some() {
                bail!("stdio MCP server does not accept --url");
            }
            if !header_map.is_empty() {
                bail!("stdio MCP server does not accept --header");
            }
            McpServerConfig {
                r#type: "stdio".to_string(),
                enabled: !disabled,
                builtin: false,
                command: Some(command),
                args,
                env: env_map,
                url: None,
                headers: BTreeMap::new(),
            }
        }
        "http" => {
            let url = url.or(positional_url);
            let Some(url) = url.filter(|value| !value.trim().is_empty()) else {
                bail!("http MCP server requires --url");
            };
            if command.is_some()
                || !args.is_empty()
                || !env_map.is_empty()
                || command_args.len() > 1
            {
                bail!("http MCP server accepts --url and --header, not --command/--arg/--env");
            }
            McpServerConfig {
                r#type: "http".to_string(),
                enabled: !disabled,
                builtin: false,
                command: None,
                args: Vec::new(),
                env: BTreeMap::new(),
                url: Some(url),
                headers: header_map,
            }
        }
        other => bail!("unsupported MCP server type: {other} (expected stdio or http)"),
    };
    let mut config = load_mcp_config();
    config.mcp_servers.insert(name.to_string(), server.clone());
    save_mcp_config(&config)?;
    if json_output {
        return super::print_json_result(
            "mcp.add",
            &format!("Added MCP server: {name}"),
            json!({ "name": name, "server": server }),
        );
    }
    println!("Added MCP server: {name}");
    Ok(())
}

fn parse_http_trailing_args(args: Vec<String>) -> Result<(Vec<String>, Vec<String>)> {
    let mut positional = Vec::new();
    let mut headers = Vec::new();
    let mut iter = args.into_iter();
    while let Some(arg) = iter.next() {
        if arg == "--header" || arg == "-H" {
            let Some(value) = iter.next() else {
                bail!("{arg} requires a header value");
            };
            headers.push(value);
        } else if let Some(value) = arg.strip_prefix("--header=") {
            headers.push(value.to_string());
        } else if let Some(value) = arg.strip_prefix("-H=") {
            headers.push(value.to_string());
        } else {
            positional.push(arg);
        }
    }
    Ok((positional, headers))
}

fn parse_header_pair(value: &str) -> Result<(String, String)> {
    if let Some((key, val)) = value.split_once(':') {
        let key = key.trim();
        if key.is_empty() {
            bail!("header key cannot be empty");
        }
        return Ok((key.to_string(), val.trim_start().to_string()));
    }
    parse_env_pair(value)
}

fn remove_server(name: &str, json_output: bool) -> Result<()> {
    if name == "starling" {
        bail!("builtin MCP server 'starling' cannot be removed");
    }
    let mut config = load_mcp_config();
    let removed = config.mcp_servers.remove(name);
    for servers in config.profiles.values_mut() {
        servers.retain(|server| server != name);
    }
    save_mcp_config(&config)?;
    if json_output {
        return super::print_json_result(
            "mcp.remove",
            &format!("Removed MCP server: {name}"),
            json!({ "name": name, "removed": removed.is_some() }),
        );
    }
    println!("Removed MCP server: {name}");
    Ok(())
}

fn set_server_enabled(name: &str, enabled: bool, json_output: bool) -> Result<()> {
    let mut config = load_mcp_config();
    let Some(server) = config.mcp_servers.get_mut(name) else {
        bail!("MCP server not found: {name}");
    };
    server.enabled = enabled;
    let server = server.clone();
    save_mcp_config(&config)?;
    let action = if enabled { "enabled" } else { "disabled" };
    if json_output {
        return super::print_json_result(
            &format!("mcp.{action}"),
            &format!("{action} MCP server: {name}"),
            json!({ "name": name, "server": server }),
        );
    }
    println!("{action} MCP server: {name}");
    Ok(())
}

fn handle_profile_action(action: McpProfileAction) -> Result<()> {
    match action {
        McpProfileAction::List { json } => list_profiles(json),
        McpProfileAction::Show { name, json } => show_profile(&name, json),
        McpProfileAction::Set {
            name,
            servers,
            default,
            json,
        } => set_profile(&name, servers, default, json),
        McpProfileAction::Remove { name, json } => remove_profile(&name, json),
        McpProfileAction::Default { name, json } => set_default_profile(&name, json),
    }
}

fn list_profiles(json_output: bool) -> Result<()> {
    let config = load_mcp_config();
    if json_output {
        println!(
            "{}",
            serde_json::to_string_pretty(&json!({
                "default_profile": config.default_profile,
                "profiles": config.profiles
            }))?
        );
        return Ok(());
    }
    println!("MCP profiles:");
    for (name, servers) in &config.profiles {
        let marker = if name == &config.default_profile {
            "*"
        } else {
            " "
        };
        let labels = servers
            .iter()
            .map(|server| profile_server_label(&config, server))
            .collect::<Vec<_>>()
            .join(", ");
        println!("  {marker} {name:<18} {labels}");
    }
    Ok(())
}

fn show_profile(name: &str, json_output: bool) -> Result<()> {
    let config = load_mcp_config();
    let Some(servers) = config.profiles.get(name) else {
        bail!("MCP profile not found: {name}");
    };
    if json_output {
        println!(
            "{}",
            serde_json::to_string_pretty(&json!({
                "name": name,
                "default": name == config.default_profile,
                "servers": servers
            }))?
        );
        return Ok(());
    }
    println!("MCP profile: {name}");
    println!("  Default: {}", name == config.default_profile);
    let labels = servers
        .iter()
        .map(|server| profile_server_label(&config, server))
        .collect::<Vec<_>>()
        .join(", ");
    println!("  Servers: {labels}");
    Ok(())
}

fn profile_server_label(config: &crate::core::mcp_config::McpConfig, name: &str) -> String {
    match config.mcp_servers.get(name) {
        Some(server) if server.enabled => name.to_string(),
        Some(_) => format!("{name} (disabled)"),
        None => format!("{name} (missing)"),
    }
}

fn set_profile(
    name: &str,
    servers: Vec<String>,
    make_default: bool,
    json_output: bool,
) -> Result<()> {
    validate_name(name)?;
    if servers.is_empty() {
        bail!("profile requires at least one MCP server");
    }
    let mut config = load_mcp_config();
    for server in &servers {
        if !config.mcp_servers.contains_key(server) {
            bail!("MCP server not found: {server}");
        }
    }
    config.profiles.insert(name.to_string(), servers.clone());
    if make_default {
        config.default_profile = name.to_string();
    }
    save_mcp_config(&config)?;
    if json_output {
        return super::print_json_result(
            "mcp.profile.set",
            &format!("Set MCP profile: {name}"),
            json!({ "name": name, "servers": servers, "default": make_default }),
        );
    }
    println!("Set MCP profile: {name}");
    Ok(())
}

fn remove_profile(name: &str, json_output: bool) -> Result<()> {
    if name == "default" {
        bail!("default MCP profile cannot be removed");
    }
    let mut config = load_mcp_config();
    let removed = config.profiles.remove(name);
    if config.default_profile == name {
        config.default_profile = "default".to_string();
    }
    save_mcp_config(&config)?;
    if json_output {
        return super::print_json_result(
            "mcp.profile.remove",
            &format!("Removed MCP profile: {name}"),
            json!({ "name": name, "removed": removed.is_some() }),
        );
    }
    println!("Removed MCP profile: {name}");
    Ok(())
}

fn set_default_profile(name: &str, json_output: bool) -> Result<()> {
    let mut config = load_mcp_config();
    if !config.profiles.contains_key(name) {
        bail!("MCP profile not found: {name}");
    }
    config.default_profile = name.to_string();
    save_mcp_config(&config)?;
    if json_output {
        return super::print_json_result(
            "mcp.profile.default",
            &format!("Default MCP profile: {name}"),
            json!({ "name": name }),
        );
    }
    println!("Default MCP profile: {name}");
    Ok(())
}

fn validate_name(name: &str) -> Result<()> {
    if name.trim().is_empty() {
        bail!("name cannot be empty");
    }
    if !name
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '.'))
    {
        bail!("name may contain only letters, numbers, '.', '_' and '-'");
    }
    Ok(())
}

fn run_stdio(tool_set: McpToolSet) -> Result<()> {
    let stdin = io::stdin();
    let mut stdout = io::stdout();
    for line in stdin.lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        match handle_message(&line, tool_set) {
            Some(response) => {
                writeln!(stdout, "{}", serde_json::to_string(&response)?)?;
                stdout.flush()?;
            }
            None => {}
        }
    }
    Ok(())
}

fn handle_message(line: &str, tool_set: McpToolSet) -> Option<Value> {
    let value: Value = match serde_json::from_str(line) {
        Ok(value) => value,
        Err(err) => {
            return Some(error_response(
                Value::Null,
                -32700,
                &format!("parse error: {err}"),
            ));
        }
    };
    let id = value.get("id").cloned();
    let method = value.get("method").and_then(|v| v.as_str()).unwrap_or("");

    if id.is_none() {
        return None;
    }
    let id = id.unwrap_or(Value::Null);
    let params = value.get("params").cloned().unwrap_or(Value::Null);

    let result = match method {
        "initialize" => Ok(initialize_result(tool_set)),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": tool_definitions(tool_set) })),
        "tools/call" => call_tool(params, tool_set),
        "resources/list" => Ok(json!({ "resources": [] })),
        "prompts/list" => Ok(json!({ "prompts": [] })),
        _ => Err((-32601, format!("method not found: {method}"))),
    };

    Some(match result {
        Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        Err((code, message)) => error_response(id, code, &message),
    })
}

fn initialize_result(tool_set: McpToolSet) -> Value {
    let (name, title, instructions) = match tool_set {
        McpToolSet::Agnes => (
            "starling-agnes",
            "Starling Agnes MCP Server",
            "Use Agnes tools to recognize images and generate images or videos. Configure credentials in ~/.starling/mcp.json under mcpServers.agnes.env.",
        ),
        McpToolSet::Starling => (
            "starling",
            "Starling MCP Server",
            "Use Starling MCP tools to inspect local Claude Code and Codex sessions, monitor status, and organize sessions into catalogs.",
        ),
        McpToolSet::All => (
            "starling",
            "Starling MCP Server",
            "Use Starling MCP tools to inspect sessions and Agnes tools to work with images and videos.",
        ),
    };
    json!({
        "protocolVersion": PROTOCOL_VERSION,
        "serverInfo": {
            "name": name,
            "version": env!("CARGO_PKG_VERSION"),
            "title": title
        },
        "capabilities": {
            "tools": {}
        },
        "instructions": instructions
    })
}

fn tool_definitions(tool_set: McpToolSet) -> Vec<Value> {
    let tools = vec![
        tool(
            "starling_top",
            "Return the live Starling top snapshot, including session status and token/context metrics.",
            json!({
                "type": "object",
                "properties": {
                    "recent": { "type": "boolean", "description": "Include unpinned recent sessions." },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 10000 },
                    "catalog": { "type": "string", "description": "Catalog name/path/id filter." }
                }
            }),
        ),
        tool(
            "starling_session_list",
            "List Starling-discovered sessions.",
            json!({
                "type": "object",
                "properties": {
                    "limit": { "type": "integer", "minimum": 1, "maximum": 10000 },
                    "all": { "type": "boolean", "description": "Return all indexed sessions." },
                    "agent": { "type": "string", "enum": ["claude", "codex"] },
                    "catalog": { "type": "string" },
                    "cataloged": { "type": "boolean" }
                }
            }),
        ),
        tool(
            "starling_session_show",
            "Show one session with metadata, catalog assignment, bookmark info, and latest run record.",
            json!({
                "type": "object",
                "required": ["session_id"],
                "properties": {
                    "session_id": { "type": "string" }
                }
            }),
        ),
        tool(
            "starling_session_meta",
            "Update a session bookmark title and/or tags.",
            json!({
                "type": "object",
                "required": ["session_id"],
                "properties": {
                    "session_id": { "type": "string" },
                    "title": { "type": "string" },
                    "tags": { "type": "string", "description": "Comma-separated tag replacement." },
                    "add_tags": { "type": "string", "description": "Comma-separated tags to merge into existing tags." }
                }
            }),
        ),
        tool(
            "starling_catalog_list",
            "List Starling catalogs.",
            json!({
                "type": "object",
                "properties": {
                    "pins": { "type": "boolean", "description": "Include pinned sessions for each catalog." }
                }
            }),
        ),
        tool(
            "starling_catalog_show",
            "Show one catalog and its sessions.",
            json!({
                "type": "object",
                "required": ["catalog"],
                "properties": {
                    "catalog": { "type": "string" }
                }
            }),
        ),
        tool(
            "starling_catalog_add",
            "Add a session to a catalog.",
            json!({
                "type": "object",
                "required": ["catalog", "session_id"],
                "properties": {
                    "catalog": { "type": "string" },
                    "session_id": { "type": "string" },
                    "title": { "type": "string" },
                    "tags": { "type": "string", "description": "Comma-separated tags." }
                }
            }),
        ),
        tool(
            "starling_catalog_create",
            "Create a Starling catalog.",
            json!({
                "type": "object",
                "required": ["name"],
                "properties": {
                    "name": { "type": "string" },
                    "description": { "type": "string" },
                    "tags": { "type": "string", "description": "Comma-separated tags." },
                    "parent": { "type": "string", "description": "Parent catalog name/path/id." }
                }
            }),
        ),
        tool(
            "agnes_image_recognition",
            "Recognize, describe, analyze, and answer questions about images with Agnes. Requires AGNES_API_KEY or AGNES_API_KEYS.",
            json!({
                "type": "object",
                "required": ["image", "prompt"],
                "properties": {
                    "image": { "type": "string", "description": "Image URL, local file path, data URI, or raw base64." },
                    "prompt": { "type": "string", "description": "Question or instruction about the image." },
                    "system": { "type": "string" },
                    "detail": { "type": "string", "enum": ["low", "high", "auto"] }
                }
            }),
        ),
        tool(
            "agnes_generate_image",
            "Generate image URLs with Agnes image generation. Supports text-to-image and image-to-image.",
            json!({
                "type": "object",
                "required": ["prompt"],
                "properties": {
                    "prompt": { "type": "string" },
                    "size": { "type": "string", "default": "1024x768" },
                    "image_urls": { "type": "array", "items": { "type": "string" } },
                    "enhance_prompt": { "type": "boolean", "default": false },
                    "save_to": { "type": "string", "description": "Optional file or directory path to download generated images." }
                }
            }),
        ),
        tool(
            "agnes_generate_video",
            "Submit an asynchronous Agnes video generation task. Poll with agnes_video_status.",
            json!({
                "type": "object",
                "required": ["prompt"],
                "properties": {
                    "prompt": { "type": "string" },
                    "image_urls": { "type": "array", "items": { "type": "string" } },
                    "mode": { "type": "string", "enum": ["ti2vid", "keyframes", "multi-image"] },
                    "width": { "type": "integer", "default": 1152 },
                    "height": { "type": "integer", "default": 768 },
                    "num_frames": { "type": "integer", "default": 121 },
                    "frame_rate": { "type": "number", "default": 24.0 },
                    "negative_prompt": { "type": "string" },
                    "seed": { "type": "integer" },
                    "num_inference_steps": { "type": "integer" },
                    "enhance_prompt": { "type": "boolean", "default": false }
                }
            }),
        ),
        tool(
            "agnes_video_status",
            "Check the status and result URL for an Agnes video task.",
            json!({
                "type": "object",
                "required": ["task_id"],
                "properties": {
                    "task_id": { "type": "string" },
                    "save_to": { "type": "string", "description": "Optional local path to download the video when complete." }
                }
            }),
        ),
    ];
    tools
        .into_iter()
        .filter(|tool| {
            let Some(name) = tool.get("name").and_then(|v| v.as_str()) else {
                return true;
            };
            tool_in_set(name, tool_set) && !agnes_tool_disabled(name)
        })
        .collect()
}

fn tool(name: &str, description: &str, input_schema: Value) -> Value {
    json!({
        "name": name,
        "description": description,
        "inputSchema": input_schema,
    })
}

fn call_tool(params: Value, tool_set: McpToolSet) -> std::result::Result<Value, (i64, String)> {
    let name = params
        .get("name")
        .and_then(|v| v.as_str())
        .ok_or_else(|| (-32602, "tools/call requires params.name".to_string()))?;
    if !tool_in_set(name, tool_set) {
        return Err((
            -32602,
            format!("tool is not available in this MCP server: {name}"),
        ));
    }
    let args = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    if name.starts_with("agnes_") {
        if agnes_tool_disabled(name) {
            return Ok(tool_result(format!("Agnes tool disabled: {name}"), true));
        }
        return match call_agnes_tool(name, &args) {
            Ok(output) => Ok(tool_result(output, false)),
            Err(message) => Ok(tool_result(message, true)),
        };
    }
    let cli_args = tool_cli_args(name, &args)?;
    let result = run_starling_json(&cli_args);
    match result {
        Ok(output) => Ok(tool_result(output, false)),
        Err(message) => Ok(tool_result(message, true)),
    }
}

fn tool_cli_args(name: &str, args: &Value) -> std::result::Result<Vec<String>, (i64, String)> {
    let mut out = Vec::new();
    match name {
        "starling_top" => {
            out.extend(["top".to_string(), "--json".to_string()]);
            if bool_arg(args, "recent") {
                out.push("--recent".to_string());
            }
            if let Some(limit) = usize_arg(args, "limit") {
                out.extend(["--limit".to_string(), limit.to_string()]);
            }
            if let Some(catalog) = string_arg(args, "catalog") {
                out.extend(["--catalog".to_string(), catalog]);
            }
        }
        "starling_session_list" => {
            out.extend([
                "session".to_string(),
                "list".to_string(),
                "--json".to_string(),
            ]);
            if bool_arg(args, "all") {
                out.push("--all".to_string());
            } else if let Some(limit) = usize_arg(args, "limit") {
                out.extend(["--limit".to_string(), limit.to_string()]);
            }
            if let Some(agent) = string_arg(args, "agent") {
                out.extend(["--agent".to_string(), agent]);
            }
            if bool_arg(args, "cataloged") {
                out.push("--cataloged".to_string());
            }
            if let Some(catalog) = string_arg(args, "catalog") {
                out.extend(["--catalog".to_string(), catalog]);
            }
        }
        "starling_session_show" => {
            out.extend(["session".to_string(), "show".to_string()]);
            out.push(required_string_arg(args, "session_id")?);
            out.push("--json".to_string());
        }
        "starling_session_meta" => {
            out.extend(["session".to_string(), "meta".to_string()]);
            out.push(required_string_arg(args, "session_id")?);
            if let Some(title) = string_arg(args, "title") {
                out.extend(["--title".to_string(), title]);
            }
            if let Some(tags) = string_arg(args, "tags") {
                out.extend(["--tags".to_string(), tags]);
            }
            if let Some(tags) = string_arg(args, "add_tags") {
                out.extend(["--add-tags".to_string(), tags]);
            }
            out.push("--json".to_string());
        }
        "starling_catalog_list" => {
            out.extend([
                "catalog".to_string(),
                "list".to_string(),
                "--json".to_string(),
            ]);
            if bool_arg(args, "pins") {
                out.push("--pins".to_string());
            }
        }
        "starling_catalog_show" => {
            out.extend(["catalog".to_string(), "show".to_string()]);
            out.push(required_string_arg(args, "catalog")?);
            out.push("--json".to_string());
        }
        "starling_catalog_add" => {
            out.extend(["catalog".to_string(), "add".to_string()]);
            out.push(required_string_arg(args, "catalog")?);
            out.push(required_string_arg(args, "session_id")?);
            if let Some(title) = string_arg(args, "title") {
                out.extend(["--title".to_string(), title]);
            }
            if let Some(tags) = string_arg(args, "tags") {
                out.extend(["--tags".to_string(), tags]);
            }
            out.push("--json".to_string());
        }
        "starling_catalog_create" => {
            out.extend(["catalog".to_string(), "create".to_string()]);
            out.push(required_string_arg(args, "name")?);
            if let Some(description) = string_arg(args, "description") {
                out.extend(["--description".to_string(), description]);
            }
            if let Some(tags) = string_arg(args, "tags") {
                out.extend(["--tags".to_string(), tags]);
            }
            if let Some(parent) = string_arg(args, "parent") {
                out.extend(["--parent".to_string(), parent]);
            }
            out.push("--json".to_string());
        }
        _ => return Err((-32602, format!("unknown tool: {name}"))),
    }
    Ok(out)
}

fn tool_in_set(name: &str, tool_set: McpToolSet) -> bool {
    match tool_set {
        McpToolSet::All => true,
        McpToolSet::Starling => !is_agnes_tool(name),
        McpToolSet::Agnes => is_agnes_tool(name),
    }
}

fn is_agnes_tool(name: &str) -> bool {
    name.starts_with("agnes_")
}

fn run_starling_json(args: &[String]) -> std::result::Result<String, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let output = Command::new(exe)
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !output.status.success() {
        let detail = if stderr.is_empty() { stdout } else { stderr };
        return Err(detail);
    }
    if let Ok(value) = serde_json::from_str::<Value>(&stdout) {
        serde_json::to_string_pretty(&value).map_err(|e| e.to_string())
    } else {
        Ok(stdout)
    }
}

struct AgnesConfig {
    base_url: String,
    api_key: String,
    model_text: String,
    model_image: String,
    model_video: String,
}

fn call_agnes_tool(name: &str, args: &Value) -> std::result::Result<String, String> {
    let config = AgnesConfig::from_env()?;
    match name {
        "agnes_image_recognition" => agnes_image_recognition(&config, args),
        "agnes_generate_image" => agnes_generate_image(&config, args),
        "agnes_generate_video" => agnes_generate_video(&config, args),
        "agnes_video_status" => agnes_video_status(&config, args),
        _ => Err(format!("unknown Agnes tool: {name}")),
    }
}

impl AgnesConfig {
    fn from_env() -> std::result::Result<Self, String> {
        let api_key = std::env::var("AGNES_API_KEYS")
            .ok()
            .and_then(|keys| {
                keys.split(',')
                    .map(str::trim)
                    .find(|key| !key.is_empty())
                    .map(String::from)
            })
            .or_else(|| std::env::var("AGNES_API_KEY").ok())
            .or_else(|| std::env::var("AGNES_TOKEN").ok())
            .map(|key| key.trim().to_string())
            .filter(|key| !key.is_empty())
            .ok_or_else(|| {
                "AGNES_API_KEY is not set. Export AGNES_API_KEY or AGNES_API_KEYS before using Agnes MCP tools.".to_string()
            })?;
        Ok(Self {
            base_url: std::env::var("AGNES_BASE_URL")
                .unwrap_or_else(|_| "https://apihub.agnes-ai.com".to_string())
                .trim_end_matches('/')
                .to_string(),
            api_key,
            model_text: std::env::var("AGNES_MODEL_TEXT")
                .unwrap_or_else(|_| "agnes-2.0-flash".to_string()),
            model_image: std::env::var("AGNES_MODEL_IMAGE")
                .unwrap_or_else(|_| "agnes-image-2.1-flash".to_string()),
            model_video: std::env::var("AGNES_MODEL_VIDEO")
                .unwrap_or_else(|_| "agnes-video-v2.0".to_string()),
        })
    }
}

fn agnes_image_recognition(
    config: &AgnesConfig,
    args: &Value,
) -> std::result::Result<String, String> {
    let image = required_string_arg(args, "image").map_err(|(_, msg)| msg)?;
    let prompt = required_string_arg(args, "prompt").map_err(|(_, msg)| msg)?;
    let image_url = resolve_agnes_image_input(&image)?;
    let detail = string_arg(args, "detail");
    if let Some(detail) = detail.as_deref() {
        if !matches!(detail, "low" | "high" | "auto") {
            return Err("detail must be one of: low, high, auto".to_string());
        }
    }

    let mut messages = Vec::new();
    if let Some(system) = string_arg(args, "system") {
        messages.push(json!({ "role": "system", "content": system }));
    }
    let mut image_obj = serde_json::Map::new();
    image_obj.insert("url".to_string(), Value::String(image_url));
    if let Some(detail) = detail {
        image_obj.insert("detail".to_string(), Value::String(detail));
    }
    messages.push(json!({
        "role": "user",
        "content": [
            { "type": "text", "text": prompt },
            { "type": "image_url", "image_url": Value::Object(image_obj) }
        ]
    }));
    let body = json!({
        "model": config.model_text,
        "messages": messages
    });
    let response = agnes_request_json(config, "POST", "/v1/chat/completions", Some(&body))?;
    Ok(extract_chat_text(&response)
        .unwrap_or_else(|| serde_json::to_string_pretty(&response).unwrap_or_default()))
}

fn agnes_generate_image(config: &AgnesConfig, args: &Value) -> std::result::Result<String, String> {
    let original_prompt = required_string_arg(args, "prompt").map_err(|(_, msg)| msg)?;
    let (prompt, prompt_note) = maybe_enhance_agnes_prompt(
        config,
        &original_prompt,
        "image",
        bool_arg(args, "enhance_prompt"),
    )?;
    let size = string_arg(args, "size").unwrap_or_else(|| "1024x768".to_string());
    validate_size(&size)?;
    let image_urls = string_array_arg(args, "image_urls")?
        .into_iter()
        .map(|image| resolve_agnes_image_input(&image))
        .collect::<std::result::Result<Vec<_>, _>>()?;

    let save_to = string_arg(args, "save_to");
    let response_format = if save_to.is_some() { "b64_json" } else { "url" };
    let mut extra_body = serde_json::Map::new();
    extra_body.insert(
        "response_format".to_string(),
        Value::String(response_format.to_string()),
    );
    if !image_urls.is_empty() {
        extra_body.insert(
            "image".to_string(),
            Value::Array(image_urls.iter().cloned().map(Value::String).collect()),
        );
    }
    let body = json!({
        "model": config.model_image,
        "prompt": prompt,
        "size": size,
        "extra_body": Value::Object(extra_body)
    });
    let response = agnes_request_json(config, "POST", "/v1/images/generations", Some(&body))?;
    let urls = collect_urls(&response);
    let b64_images = collect_b64_json_values(&response);
    let mut notes = Vec::new();
    if let Some(note) = prompt_note {
        notes.push(note);
    }
    if urls.is_empty() && b64_images.is_empty() {
        let mut out = format!(
            "Image generation returned no image URL or b64_json payload.\n\n{}",
            serde_json::to_string_pretty(&response).unwrap_or_default()
        );
        append_notes(&mut out, &notes);
        return Ok(out);
    }
    let mut out = if urls.is_empty() {
        format!(
            "Image generated as b64_json ({} image(s)).",
            b64_images.len()
        )
    } else {
        format!(
            "Image generated:\n{}",
            urls.iter()
                .map(|url| format!("- {url}"))
                .collect::<Vec<_>>()
                .join("\n")
        )
    };
    if let Some(save_to) = save_to {
        if b64_images.is_empty() {
            notes.push(save_urls(&urls, &save_to, "image", "png"));
        } else {
            notes.push(save_b64_images(&b64_images, &save_to, "image", "png"));
        }
    }
    append_notes(&mut out, &notes);
    Ok(out)
}

fn agnes_generate_video(config: &AgnesConfig, args: &Value) -> std::result::Result<String, String> {
    let original_prompt = required_string_arg(args, "prompt").map_err(|(_, msg)| msg)?;
    let (prompt, prompt_note) = maybe_enhance_agnes_prompt(
        config,
        &original_prompt,
        "video",
        bool_arg(args, "enhance_prompt"),
    )?;
    let image_urls = string_array_arg(args, "image_urls")?;
    let mode = string_arg(args, "mode");
    if let Some(mode) = mode.as_deref() {
        if !matches!(mode, "ti2vid" | "keyframes" | "multi-image") {
            return Err("mode must be one of: ti2vid, keyframes, multi-image".to_string());
        }
    }
    let num_frames = i64_arg(args, "num_frames").unwrap_or(121);
    validate_num_frames(num_frames)?;
    let mut body = json!({
        "model": config.model_video,
        "prompt": prompt,
        "width": u64_arg(args, "width").unwrap_or(1152),
        "height": u64_arg(args, "height").unwrap_or(768),
        "num_frames": num_frames,
        "frame_rate": f64_arg(args, "frame_rate").unwrap_or(24.0)
    });
    if let Some(negative_prompt) = string_arg(args, "negative_prompt") {
        body["negative_prompt"] = Value::String(negative_prompt);
    }
    if let Some(seed) = i64_arg(args, "seed") {
        body["seed"] = json!(seed);
    }
    if let Some(steps) = i64_arg(args, "num_inference_steps") {
        body["num_inference_steps"] = json!(steps);
    }
    if image_urls.len() == 1 && !matches!(mode.as_deref(), Some("keyframes" | "multi-image")) {
        body["image"] = Value::String(image_urls[0].clone());
    } else if !image_urls.is_empty() {
        let mut extra = serde_json::Map::new();
        extra.insert(
            "image".to_string(),
            Value::Array(image_urls.iter().cloned().map(Value::String).collect()),
        );
        if mode.as_deref() == Some("keyframes") {
            extra.insert("mode".to_string(), Value::String("keyframes".to_string()));
        }
        body["extra_body"] = Value::Object(extra);
    }
    if let Some(mode) = mode.filter(|mode| !matches!(mode.as_str(), "keyframes" | "multi-image")) {
        body["mode"] = Value::String(mode);
    }

    let response = agnes_request_json(config, "POST", "/v1/videos", Some(&body))?;
    let mut notes = Vec::new();
    if let Some(note) = prompt_note {
        notes.push(note);
    }
    let Some(task_id) = extract_task_id(&response) else {
        let mut out = format!(
            "Video task submitted, but no task id was found.\n\n{}",
            serde_json::to_string_pretty(&response).unwrap_or_default()
        );
        append_notes(&mut out, &notes);
        return Ok(out);
    };
    let mut out = format!(
        "Video task created.\nTask ID: {task_id}\n\nUse agnes_video_status with this task_id to check progress."
    );
    append_notes(&mut out, &notes);
    Ok(out)
}

fn agnes_video_status(config: &AgnesConfig, args: &Value) -> std::result::Result<String, String> {
    let task_id = required_string_arg(args, "task_id").map_err(|(_, msg)| msg)?;
    let path = format!("/v1/videos/{}", url_encode_path_segment(&task_id));
    let response = agnes_request_json(config, "GET", &path, None)?;
    let status = extract_task_status(&response).unwrap_or_else(|| "unknown".to_string());
    let video_url = extract_video_url(&response);
    let mut out = format!("Video task status: {status}\nTask ID: {task_id}");
    if let Some(url) = video_url {
        out.push_str("\nVideo URL: ");
        out.push_str(&url);
        if is_completed_status(&status) {
            if let Some(save_to) = string_arg(args, "save_to") {
                out.push('\n');
                out.push_str(&save_urls(&[url], &save_to, "video", "mp4"));
            }
        }
    } else {
        out.push_str("\n\nRaw response:\n");
        out.push_str(&serde_json::to_string_pretty(&response).unwrap_or_default());
    }
    Ok(out)
}

fn maybe_enhance_agnes_prompt(
    config: &AgnesConfig,
    prompt: &str,
    target: &str,
    requested: bool,
) -> std::result::Result<(String, Option<String>), String> {
    let env_enabled = std::env::var("AGNES_ENHANCE_PROMPT")
        .ok()
        .as_deref()
        .map(is_truthy)
        .unwrap_or(false);
    if requested || env_enabled {
        return enhance_agnes_prompt(config, prompt, target)
            .map(|enhanced| {
                (
                    enhanced.clone(),
                    Some(format!(
                        "Enhanced prompt: {}",
                        truncate_text(&enhanced, 600)
                    )),
                )
            })
            .or_else(|err| {
                Ok((
                    prompt.to_string(),
                    Some(format!(
                        "[prompt enhancement failed: {err}], using original prompt"
                    )),
                ))
            });
    }
    Ok((prompt.to_string(), None))
}

fn enhance_agnes_prompt(
    config: &AgnesConfig,
    prompt: &str,
    target: &str,
) -> std::result::Result<String, String> {
    let system = match target {
        "video" => {
            "You are an expert AI video-generation prompt engineer. Given a simple idea, produce one vivid, detailed video prompt covering subject, action, scene, camera movement, lighting, mood, and style. Keep it under 120 words. Output only the prompt."
        }
        _ => {
            "You are an expert AI image-generation prompt engineer. Given a simple idea, produce one vivid, detailed image prompt covering subject, scene, style, lighting, composition, and quality. Keep it under 100 words. Output only the prompt."
        }
    };
    let body = json!({
        "model": config.model_text,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": format!("Expand this {target} prompt into a single rich, detailed generation prompt. Output ONLY the prompt text, no preamble:\n\n{prompt}") }
        ],
        "temperature": 0.8,
        "max_tokens": 512
    });
    let response = agnes_request_json(config, "POST", "/v1/chat/completions", Some(&body))?;
    extract_chat_text(&response)
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())
        .ok_or_else(|| "prompt enhancement returned no text".to_string())
}

fn agnes_request_json(
    config: &AgnesConfig,
    method: &str,
    path: &str,
    body: Option<&Value>,
) -> std::result::Result<Value, String> {
    let url = format!("{}{}", config.base_url, path);
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(
            std::env::var("AGNES_REQUEST_TIMEOUT_SECS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(180),
        ))
        .user_agent("starling-agnes-mcp")
        .build();
    let request = match method {
        "GET" => agent.get(&url),
        "POST" => agent.post(&url),
        other => return Err(format!("unsupported Agnes method: {other}")),
    }
    .set("Authorization", &format!("Bearer {}", config.api_key));
    let response = if let Some(body) = body {
        request.send_json(body.clone())
    } else {
        request.call()
    };
    match response {
        Ok(response) => response
            .into_json::<Value>()
            .map_err(|e| format!("failed to parse Agnes JSON response: {e}")),
        Err(ureq::Error::Status(status, response)) => {
            let text = response.into_string().unwrap_or_default();
            Err(format!(
                "Agnes API returned HTTP {status}: {}",
                extract_error_text(&text)
            ))
        }
        Err(err) => Err(format!("Agnes request failed: {err}")),
    }
}

fn extract_error_text(text: &str) -> String {
    serde_json::from_str::<Value>(text)
        .ok()
        .and_then(|value| {
            value
                .pointer("/error/message")
                .or_else(|| value.get("message"))
                .and_then(|v| v.as_str())
                .map(String::from)
        })
        .unwrap_or_else(|| truncate_text(text, 300))
}

fn resolve_agnes_image_input(input: &str) -> std::result::Result<String, String> {
    let trimmed = input.trim();
    if trimmed.starts_with("http://")
        || trimmed.starts_with("https://")
        || trimmed.starts_with("data:")
    {
        return Ok(trimmed.to_string());
    }
    let path = Path::new(trimmed);
    if path.exists() {
        let bytes =
            fs::read(path).map_err(|e| format!("failed to read image {}: {e}", path.display()))?;
        let mime = match path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str()
        {
            "jpg" | "jpeg" => "image/jpeg",
            "webp" => "image/webp",
            "gif" => "image/gif",
            _ => "image/png",
        };
        let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
        return Ok(format!("data:{mime};base64,{encoded}"));
    }
    if looks_like_base64(trimmed) {
        return Ok(format!("data:image/png;base64,{trimmed}"));
    }
    Err(format!(
        "image input must be URL, data URI, existing local file, or raw base64: {trimmed}"
    ))
}

fn looks_like_base64(value: &str) -> bool {
    value.len() > 64
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '/' | '='))
}

fn extract_chat_text(response: &Value) -> Option<String> {
    let choice = response.get("choices")?.as_array()?.first()?;
    let message = choice.get("message")?;
    message
        .get("content")
        .and_then(|v| v.as_str())
        .map(String::from)
        .or_else(|| {
            choice
                .get("text")
                .and_then(|v| v.as_str())
                .map(String::from)
        })
}

fn collect_urls(value: &Value) -> Vec<String> {
    let mut urls = Vec::new();
    collect_urls_inner(value, &mut urls);
    urls
}

fn collect_urls_inner(value: &Value, urls: &mut Vec<String>) {
    match value {
        Value::Object(map) => {
            for (key, val) in map {
                let is_url_key = key == "url" || key == "image_url" || key == "video_url";
                if let Some(url) = val.as_str().filter(|s| {
                    is_url_key && (s.starts_with("http://") || s.starts_with("https://"))
                }) {
                    urls.push(url.to_string());
                } else {
                    collect_urls_inner(val, urls);
                }
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_urls_inner(item, urls);
            }
        }
        _ => {}
    }
}

fn collect_b64_json_values(value: &Value) -> Vec<String> {
    let mut values = Vec::new();
    collect_b64_json_values_inner(value, &mut values);
    values
}

fn collect_b64_json_values_inner(value: &Value, values: &mut Vec<String>) {
    match value {
        Value::Object(map) => {
            for (key, val) in map {
                if key == "b64_json" {
                    if let Some(encoded) = val.as_str().filter(|s| !s.trim().is_empty()) {
                        values.push(encoded.to_string());
                    }
                } else {
                    collect_b64_json_values_inner(val, values);
                }
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_b64_json_values_inner(item, values);
            }
        }
        _ => {}
    }
}

fn extract_task_id(response: &Value) -> Option<String> {
    ["id", "task_id"]
        .iter()
        .find_map(|key| {
            response
                .get(*key)
                .and_then(|v| v.as_str())
                .map(String::from)
        })
        .or_else(|| {
            response.get("data").and_then(|data| {
                ["id", "task_id"]
                    .iter()
                    .find_map(|key| data.get(*key).and_then(|v| v.as_str()).map(String::from))
            })
        })
}

fn extract_task_status(response: &Value) -> Option<String> {
    response
        .get("status")
        .and_then(|v| v.as_str())
        .or_else(|| response.pointer("/data/status").and_then(|v| v.as_str()))
        .map(String::from)
}

fn extract_video_url(response: &Value) -> Option<String> {
    for key in ["video_url", "url", "remixed_from_video_id"] {
        if let Some(url) = response
            .get(key)
            .and_then(|v| v.as_str())
            .filter(|s| s.starts_with("http://") || s.starts_with("https://"))
        {
            return Some(url.to_string());
        }
    }
    response.get("data").and_then(extract_video_url)
}

fn string_array_arg(args: &Value, key: &str) -> std::result::Result<Vec<String>, String> {
    let Some(value) = args.get(key) else {
        return Ok(Vec::new());
    };
    let Some(items) = value.as_array() else {
        return Err(format!("{key} must be an array of strings"));
    };
    items
        .iter()
        .map(|item| {
            item.as_str()
                .map(String::from)
                .ok_or_else(|| format!("{key} must contain only strings"))
        })
        .collect()
}

fn u64_arg(args: &Value, key: &str) -> Option<u64> {
    args.get(key).and_then(|v| v.as_u64())
}

fn i64_arg(args: &Value, key: &str) -> Option<i64> {
    args.get(key).and_then(|v| v.as_i64())
}

fn f64_arg(args: &Value, key: &str) -> Option<f64> {
    args.get(key).and_then(|v| v.as_f64())
}

fn validate_size(size: &str) -> std::result::Result<(), String> {
    let Some((w, h)) = size.split_once('x') else {
        return Err("size must be WIDTHxHEIGHT, e.g. 1024x768".to_string());
    };
    let width = w
        .parse::<u64>()
        .map_err(|_| "size width must be a number".to_string())?;
    let height = h
        .parse::<u64>()
        .map_err(|_| "size height must be a number".to_string())?;
    if width == 0 || height == 0 {
        return Err("size width and height must be positive".to_string());
    }
    Ok(())
}

fn validate_num_frames(num_frames: i64) -> std::result::Result<(), String> {
    if num_frames <= 0 || num_frames > 441 {
        return Err("num_frames must be between 1 and 441".to_string());
    }
    if (num_frames - 1) % 8 != 0 {
        return Err("num_frames must satisfy 8n+1, e.g. 81, 121, 161, 241, 441".to_string());
    }
    Ok(())
}

fn save_urls(urls: &[String], save_to: &str, stem: &str, default_ext: &str) -> String {
    if urls.is_empty() {
        return String::new();
    }
    let dest = PathBuf::from(save_to);
    let is_dir = urls.len() > 1 || save_to.ends_with('/') || dest.is_dir();
    if is_dir {
        if let Err(err) = fs::create_dir_all(&dest) {
            return format!(
                "[download failed: could not create {}: {err}]",
                dest.display()
            );
        }
    } else if let Some(parent) = dest.parent().filter(|path| !path.as_os_str().is_empty()) {
        if let Err(err) = fs::create_dir_all(parent) {
            return format!(
                "[download failed: could not create {}: {err}]",
                parent.display()
            );
        }
    }

    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(
            std::env::var("AGNES_DOWNLOAD_TIMEOUT_SECS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(300),
        ))
        .user_agent("starling-agnes-mcp")
        .build();
    let mut saved = Vec::new();
    let mut errors = Vec::new();
    for (idx, url) in urls.iter().enumerate() {
        let target = if is_dir {
            dest.join(derive_download_filename(url, idx, stem, default_ext))
        } else {
            dest.clone()
        };
        match download_url(&agent, url, &target) {
            Ok(()) => saved.push(target.display().to_string()),
            Err(err) => errors.push(format!("{url}: {err}")),
        }
    }
    if saved.is_empty() && !errors.is_empty() {
        format!("[download failed: {}]", errors.join("; "))
    } else if errors.is_empty() {
        format!("Saved to: {}", saved.join(", "))
    } else {
        format!(
            "Saved to: {}; [partial failures: {}]",
            saved.join(", "),
            errors.join("; ")
        )
    }
}

fn save_b64_images(images: &[String], save_to: &str, stem: &str, default_ext: &str) -> String {
    if images.is_empty() {
        return String::new();
    }
    let dest = PathBuf::from(save_to);
    let is_dir = images.len() > 1 || save_to.ends_with('/') || dest.is_dir();
    if is_dir {
        if let Err(err) = fs::create_dir_all(&dest) {
            return format!("[save failed: could not create {}: {err}]", dest.display());
        }
    } else if let Some(parent) = dest.parent().filter(|path| !path.as_os_str().is_empty()) {
        if let Err(err) = fs::create_dir_all(parent) {
            return format!(
                "[save failed: could not create {}: {err}]",
                parent.display()
            );
        }
    }

    let mut saved = Vec::new();
    let mut errors = Vec::new();
    for (idx, image) in images.iter().enumerate() {
        let target = if is_dir {
            dest.join(format!("{stem}-{}.{}", idx + 1, default_ext))
        } else {
            dest.clone()
        };
        match save_b64_image(image, &target) {
            Ok(()) => saved.push(target.display().to_string()),
            Err(err) => errors.push(format!("{}: {err}", target.display())),
        }
    }
    if saved.is_empty() && !errors.is_empty() {
        format!("[save failed: {}]", errors.join("; "))
    } else if errors.is_empty() {
        format!("Saved to: {}", saved.join(", "))
    } else {
        format!(
            "Saved to: {}; [partial failures: {}]",
            saved.join(", "),
            errors.join("; ")
        )
    }
}

fn save_b64_image(encoded: &str, target: &Path) -> std::result::Result<(), String> {
    let payload = encoded
        .split_once(',')
        .map(|(_, payload)| payload)
        .unwrap_or(encoded)
        .trim();
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload)
        .map_err(|err| format!("decode b64_json: {err}"))?;
    fs::write(target, bytes).map_err(|err| format!("write {}: {err}", target.display()))
}

fn download_url(agent: &ureq::Agent, url: &str, target: &Path) -> std::result::Result<(), String> {
    let response = agent
        .get(url)
        .call()
        .map_err(|err| format!("request failed: {err}"))?;
    let mut reader = response.into_reader();
    let mut file =
        fs::File::create(target).map_err(|err| format!("create {}: {err}", target.display()))?;
    io::copy(&mut reader, &mut file).map_err(|err| format!("write {}: {err}", target.display()))?;
    Ok(())
}

fn derive_download_filename(url: &str, idx: usize, stem: &str, default_ext: &str) -> String {
    let raw = url
        .split('?')
        .next()
        .and_then(|value| value.rsplit('/').next())
        .unwrap_or("");
    let clean = raw
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_'))
        .collect::<String>();
    if clean.contains('.') && !clean.starts_with('.') {
        clean
    } else {
        format!("{stem}-{}.{}", idx + 1, default_ext)
    }
}

fn is_completed_status(status: &str) -> bool {
    matches!(
        status.to_ascii_lowercase().as_str(),
        "completed" | "complete" | "done" | "success" | "succeeded"
    )
}

fn url_encode_path_segment(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        let ch = byte as char;
        if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | '~') {
            out.push(ch);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

fn truncate_text(value: &str, max: usize) -> String {
    if value.len() <= max {
        value.to_string()
    } else {
        let end = value
            .char_indices()
            .map(|(idx, _)| idx)
            .take_while(|idx| *idx <= max)
            .last()
            .unwrap_or(0);
        format!("{}...", &value[..end])
    }
}

fn agnes_tool_disabled(name: &str) -> bool {
    if !name.starts_with("agnes_") {
        return false;
    }
    std::env::var("AGNES_DISABLED_TOOLS")
        .ok()
        .map(|list| {
            list.split(',')
                .map(str::trim)
                .any(|tool| !tool.is_empty() && tool == name)
        })
        .unwrap_or(false)
}

fn is_truthy(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "on"
    )
}

fn append_notes(out: &mut String, notes: &[String]) {
    for note in notes.iter().filter(|note| !note.is_empty()) {
        out.push('\n');
        out.push_str(note);
    }
}

fn tool_result(text: String, is_error: bool) -> Value {
    json!({
        "content": [{
            "type": "text",
            "text": text
        }],
        "isError": is_error
    })
}

fn string_arg(args: &Value, key: &str) -> Option<String> {
    args.get(key)
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
}

fn required_string_arg(args: &Value, key: &str) -> std::result::Result<String, (i64, String)> {
    string_arg(args, key).ok_or_else(|| (-32602, format!("missing required argument: {key}")))
}

fn bool_arg(args: &Value, key: &str) -> bool {
    args.get(key).and_then(|v| v.as_bool()).unwrap_or(false)
}

fn usize_arg(args: &Value, key: &str) -> Option<usize> {
    args.get(key)
        .and_then(|v| v.as_u64())
        .and_then(|n| usize::try_from(n).ok())
}

fn error_response(id: Value, code: i64, message: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {
            "code": code,
            "message": message
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tools_list_contains_core_starling_tools() {
        let names: Vec<String> = tool_definitions(McpToolSet::All)
            .into_iter()
            .filter_map(|tool| tool.get("name").and_then(|v| v.as_str()).map(String::from))
            .collect();
        assert!(names.contains(&"starling_top".to_string()));
        assert!(names.contains(&"starling_session_show".to_string()));
        assert!(names.contains(&"starling_catalog_add".to_string()));
    }

    #[test]
    fn tools_list_contains_agnes_tools() {
        let names: Vec<String> = tool_definitions(McpToolSet::All)
            .into_iter()
            .filter_map(|tool| tool.get("name").and_then(|v| v.as_str()).map(String::from))
            .collect();
        assert!(names.contains(&"agnes_image_recognition".to_string()));
        assert!(names.contains(&"agnes_generate_image".to_string()));
        assert!(names.contains(&"agnes_generate_video".to_string()));
        assert!(names.contains(&"agnes_video_status".to_string()));
    }

    #[test]
    fn agnes_tool_set_exposes_only_agnes_tools() {
        let names: Vec<String> = tool_definitions(McpToolSet::Agnes)
            .into_iter()
            .filter_map(|tool| tool.get("name").and_then(|v| v.as_str()).map(String::from))
            .collect();
        assert!(names.contains(&"agnes_generate_image".to_string()));
        assert!(!names.contains(&"starling_top".to_string()));
    }

    #[test]
    fn starling_tool_set_exposes_only_starling_tools() {
        let names: Vec<String> = tool_definitions(McpToolSet::Starling)
            .into_iter()
            .filter_map(|tool| tool.get("name").and_then(|v| v.as_str()).map(String::from))
            .collect();
        assert!(names.contains(&"starling_top".to_string()));
        assert!(!names.contains(&"agnes_generate_image".to_string()));
    }

    #[test]
    fn maps_session_show_to_json_cli_args() {
        let args = tool_cli_args("starling_session_show", &json!({ "session_id": "abc" })).unwrap();
        assert_eq!(args, vec!["session", "show", "abc", "--json"]);
    }

    #[test]
    fn initialize_request_returns_server_info() {
        let response = handle_message(
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize"}"#,
            McpToolSet::All,
        )
        .expect("response");
        assert_eq!(response["result"]["serverInfo"]["name"], "starling");
        assert_eq!(response["result"]["capabilities"]["tools"], json!({}));
    }

    #[test]
    fn agnes_initialize_uses_agnes_server_name() {
        let response = handle_message(
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize"}"#,
            McpToolSet::Agnes,
        )
        .expect("response");
        assert_eq!(response["result"]["serverInfo"]["name"], "starling-agnes");
    }

    #[test]
    fn agnes_image_input_passes_through_urls_and_data_uris() {
        assert_eq!(
            resolve_agnes_image_input("https://example.com/a.png").unwrap(),
            "https://example.com/a.png"
        );
        assert_eq!(
            resolve_agnes_image_input("data:image/png;base64,AAAA").unwrap(),
            "data:image/png;base64,AAAA"
        );
    }

    #[test]
    fn agnes_video_frame_validation_matches_eight_n_plus_one() {
        assert!(validate_num_frames(121).is_ok());
        assert!(validate_num_frames(120).is_err());
        assert!(validate_num_frames(0).is_err());
        assert!(validate_num_frames(449).is_err());
    }

    #[test]
    fn agnes_path_segment_encoding_is_url_safe() {
        assert_eq!(url_encode_path_segment("task/a b"), "task%2Fa%20b");
    }
}
