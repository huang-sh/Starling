use super::*;
use crate::agents::pi as pi_agent;
use crate::core::session_lock::{acquire_pi_session_lock, PiSessionLock};
use std::io::{BufRead, BufReader, Read, Write};

pub(super) fn guard_session(
    prepared: &PreparedLaunch,
    project_path: Option<&str>,
) -> Result<Option<PiSessionLock>> {
    let lock = match (prepared.session_id_hint.as_deref(), project_path) {
        (Some(session_id), Some(project_path)) => {
            Some(acquire_pi_session_lock(session_id, project_path)?)
        }
        _ => None,
    };
    ensure_pi_session_not_running(prepared.session_id_hint.as_deref(), project_path)?;
    Ok(lock)
}

pub(super) fn pi_chat_passthrough_args(
    session: Option<&str>,
    title: Option<&str>,
) -> Result<Vec<String>> {
    let mut args = Vec::new();
    if let Some(title) = title.map(str::trim).filter(|title| !title.is_empty()) {
        args.push("--name".into());
        args.push(title.to_string());
    }
    if let Some(session) = session {
        let session = normalize_pi_path_input(session);
        if !session.is_absolute() {
            anyhow::bail!("--session must be an absolute Pi transcript path");
        }
        args.push("--session".into());
        args.push(
            pi_node_compatible_path(&session)
                .to_string_lossy()
                .to_string(),
        );
    }
    Ok(args)
}

pub(super) fn chat(cmd_args: &ChatCommand, session: Option<&str>) -> Result<()> {
    sweep_stale_launch_artifacts();
    // Validate caller-controlled selectors before resolving runtime
    // dependencies, while this path is still side-effect free.
    let passthrough_args = pi_chat_passthrough_args(session, cmd_args.title.as_deref())?;
    // Chat is a normal Pi SDK integration. Resolve the Starling-owned Node
    // host before creating run state or temporary launch artifacts, and never
    // fall back to the Pi CLI/RPC executable resolver used by `starling run`.
    let sdk_host = resolve_pi_sdk_host()?;
    let run_id = uuid::Uuid::new_v4().to_string();
    let start_ms = now_ms();
    let started_at = now_iso();
    let cwd = cmd_args.cwd.as_ref().map(PathBuf::from);
    let project_path = cwd
        .clone()
        .or_else(|| std::env::current_dir().ok())
        .map(|path| pi::normalize_project_path(&path));
    let catalog_id = resolve_catalog_id(cmd_args.catalog.as_deref());
    let prepared = prepare_launch_with_pi_permissions(
        RunProvider::Pi,
        &run_id,
        cmd_args.setting.as_deref(),
        &passthrough_args,
        true,
        &[],
        None,
        true,
        project_path.as_deref(),
        true,
    )?;
    let effective_project_path = prepared
        .session_project_hint
        .clone()
        .or_else(|| project_path.clone());
    let sdk_host_cwd = effective_project_path.as_deref().map(Path::new);

    let pi_session_lock = guard_session(&prepared, effective_project_path.as_deref())
        .inspect_err(|_| cleanup_launch_artifacts(&prepared))?;

    create_run(RunRecord {
        run_id: run_id.clone(),
        session_id: prepared.session_id_hint.clone(),
        session_file: None,
        model: None,
        title: cmd_args.title.clone(),
        provider: RunProvider::Pi,
        project_path: effective_project_path.clone(),
        catalog_id: catalog_id.clone(),
        setting: cmd_args.setting.clone(),
        pid: None,
        status: RunStatus::Running,
        exit_code: None,
        started_at,
        ended_at: None,
        source: RunSource::StarlingRun,
    });

    eprintln!(
        "{} chat {} (Pi SDK host: {})",
        "starling".cyan(),
        short(&run_id),
        sdk_host.host_path.display()
    );
    let mut child_command = sdk_host.command();
    child_command.args(&prepared.args);
    for (key, value) in &prepared.envs {
        child_command.env(key, value);
    }
    if let Some(cwd) = sdk_host_cwd {
        child_command.current_dir(cwd);
    }
    child_command
        .stdin(Stdio::inherit())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());

    if let Some(lock) = pi_session_lock.as_ref() {
        if let Err(error) = lock.set_child_inheritable(true) {
            mark_run_crashed(&run_id);
            cleanup_launch_artifacts(&prepared);
            return Err(error);
        }
    }
    let spawn_result = child_command.spawn();
    if let Some(lock) = pi_session_lock.as_ref() {
        if let Err(error) = lock.set_child_inheritable(false) {
            eprintln!(
                "{}: could not restore Pi lock close-on-exec: {}",
                "warning".yellow(),
                error
            );
        }
    }
    let mut child = match spawn_result {
        Ok(child) => child,
        Err(error) => {
            mark_run_crashed(&run_id);
            cleanup_launch_artifacts(&prepared);
            anyhow::bail!(
                "failed to spawn Pi SDK host {} with {}: {}",
                sdk_host.host_path.display(),
                sdk_host.node.display(),
                error
            );
        }
    };

    let pid = child.id();
    update_run_pid(&run_id, pid);
    let assignment_watcher = maybe_start_catalog_assignment_watcher(
        run_id.clone(),
        pid,
        RunProvider::Pi,
        catalog_id.clone(),
        cmd_args.title.clone(),
        effective_project_path.clone(),
        start_ms,
        prepared.hook_file.clone(),
    );
    install_chat_signal_handler(run_id.clone(), pid);

    let child_stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            let _ = assignment_watcher.join();
            ACTIVE_CHILD_PID.store(0, Ordering::SeqCst);
            mark_run_crashed(&run_id);
            cleanup_launch_artifacts(&prepared);
            anyhow::bail!("Pi SDK host stdout was not captured");
        }
    };
    let stdout = std::io::stdout();
    let mut stdout = std::io::BufWriter::new(stdout.lock());
    let started_write = write_chat_json_line(
        &mut stdout,
        &serde_json::json!({
            "type": "starling_started",
            "schema": "starling.chat",
            "schemaVersion": 1,
            "agent": "pi",
            "runId": run_id,
            "pid": pid,
            "cwd": effective_project_path,
            "sessionId": prepared.session_id_hint,
        }),
    );
    if let Err(error) = started_write {
        let _ = child.kill();
        let _ = child.wait();
        ACTIVE_CHILD_PID.store(0, Ordering::SeqCst);
        mark_run_crashed(&run_id);
        cleanup_launch_artifacts(&prepared);
        return Err(error);
    }

    let protocol_error = match relay_sdk_host_jsonl(child_stdout, &mut stdout) {
        Ok(protocol_error) => protocol_error,
        Err(error) => {
            eprintln!("{}: Pi SDK host relay failed: {}", "error".red(), error);
            let _ = child.kill();
            true
        }
    };
    let wait_result = child.wait();
    ACTIVE_CHILD_PID.store(0, Ordering::SeqCst);
    // Serialize the watcher's final run-record patch with completion so a
    // late session-id update cannot overwrite the terminal run status.
    let _ = assignment_watcher.join();
    let (child_code, child_success, wait_error) = match wait_result {
        Ok(status) => (child_exit_code(&status), status.success(), None),
        Err(error) => (1, false, Some(error.to_string())),
    };
    let effective_success = child_success && !protocol_error && wait_error.is_none();
    let exit_code = if protocol_error && child_success {
        1
    } else {
        child_code
    };

    // The async signal hook records the parent signal before its background
    // worker forwards it to the SDK host. Do all recoverable cleanup here,
    // then let that worker restore/replay the original signal. In particular,
    // never race it with process::exit(1) just because the child wait status
    // has no code.
    if pending_parent_signal().is_some() {
        cleanup_launch_artifacts(&prepared);
        let _ = stdout.flush();
        CHAT_SIGNAL_CLEANUP_DONE.store(true, Ordering::SeqCst);
        loop {
            std::thread::park();
        }
    }

    // A fresh Pi session has an SDK identity before its transcript file is
    // materialized (Pi writes that file with the first message). Consume the
    // runtime hook synchronously so even an immediately closed chat retains
    // its real session ID in the run record and final lifecycle event.
    if let Some(hook) = prepared.hook_file.as_deref().and_then(read_hook_session) {
        update_run_session_id(
            &run_id,
            &canonical_session_id(&hook.session_id, Some(provider_name(RunProvider::Pi))),
        );
    }

    assign_recent_session_fallback(
        &run_id,
        RunProvider::Pi,
        pid,
        catalog_id.as_deref(),
        cmd_args.title.as_deref(),
        effective_project_path.as_deref(),
        start_ms,
    );
    finalize_run(
        &run_id,
        FinalizePatch {
            status: if effective_success {
                RunStatus::Completed
            } else {
                RunStatus::Errored
            },
            exit_code: Some(exit_code),
            ended_at: Some(now_iso()),
            session_id: None,
        },
    );
    let final_session_id = find_run(&run_id).and_then(|run| run.session_id);
    let exited_write = write_chat_json_line(
        &mut stdout,
        &serde_json::json!({
            "type": "starling_exited",
            "schema": "starling.chat",
            "schemaVersion": 1,
            "agent": "pi",
            "runId": run_id,
            "sessionId": final_session_id,
            "exitCode": exit_code,
            "success": effective_success,
            "protocolError": protocol_error,
            "error": wait_error,
        }),
    );
    cleanup_launch_artifacts(&prepared);
    exited_write?;
    stdout.flush()?;
    std::process::exit(exit_code);
}

fn write_chat_json_line(writer: &mut impl Write, value: &Value) -> Result<()> {
    serde_json::to_writer(&mut *writer, value)?;
    writer.write_all(b"\n")?;
    writer.flush()?;
    Ok(())
}

const MAX_CHAT_JSONL_LINE_BYTES: usize = 1024 * 1024;

pub(super) fn relay_sdk_host_jsonl(reader: impl Read, writer: &mut impl Write) -> Result<bool> {
    let mut reader = BufReader::new(reader);
    let mut line = Vec::new();
    let mut protocol_error = false;
    loop {
        let Some(oversized) = read_bounded_jsonl_line(&mut reader, &mut line)? else {
            break;
        };
        if oversized {
            protocol_error = true;
            eprintln!(
                "{}: discarded oversized output from Pi SDK host stdout",
                "warning".yellow()
            );
            continue;
        }
        while matches!(line.last(), Some(b'\r')) {
            line.pop();
        }
        if line.is_empty() || serde_json::from_slice::<Value>(&line).is_err() {
            protocol_error = true;
            eprintln!(
                "{}: discarded non-JSON output from Pi SDK host stdout",
                "warning".yellow()
            );
            continue;
        }
        writer.write_all(&line)?;
        writer.write_all(b"\n")?;
        writer.flush()?;
    }
    Ok(protocol_error)
}

fn read_bounded_jsonl_line(
    reader: &mut impl BufRead,
    line: &mut Vec<u8>,
) -> std::io::Result<Option<bool>> {
    line.clear();
    let mut oversized = false;
    let mut saw_data = false;
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return Ok(saw_data.then_some(oversized));
        }
        saw_data = true;
        let newline = available.iter().position(|byte| *byte == b'\n');
        let content_len = newline.unwrap_or(available.len());
        if !oversized {
            let remaining = MAX_CHAT_JSONL_LINE_BYTES.saturating_sub(line.len());
            line.extend_from_slice(&available[..content_len.min(remaining)]);
            oversized = content_len > remaining;
        }
        let consumed = content_len + usize::from(newline.is_some());
        reader.consume(consumed);
        if newline.is_some() {
            return Ok(Some(oversized));
        }
    }
}

pub(super) fn prepare(
    run_id: &str,
    setting: Option<&str>,
    passthrough_args: &[String],
    attach_hook: bool,
    mcp_names: &[String],
    mcp_profile: Option<&str>,
    no_mcp: bool,
    launch_project_path: Option<&str>,
    enforce_permissions: bool,
) -> Result<PreparedLaunch> {
    let mut passthrough_args = normalize_pi_passthrough_args(passthrough_args)?;
    validate_pi_selector_combinations(&passthrough_args)?;
    if !no_mcp && (!mcp_names.is_empty() || mcp_profile.is_some()) {
        anyhow::bail!(
            "Pi does not expose native MCP configuration; remove --mcp/--mcp-profile or pass --no-mcp"
        );
    }

    let mut args = Vec::new();
    let mut envs = Vec::new();
    let mut cleanup_files = Vec::new();
    let mut hook_file = None;
    let mut session_id_hint = None;
    let mut session_project_hint = None;

    if let Some(profile) = setting {
        let path = default_pi_settings_dir().join(format!("{profile}.json"));
        ensure_file(&path, "Pi profile")?;
        args.extend(pi_profile_args(&path)?);
    }

    if pi_has_no_session_arg(&passthrough_args) {
        envs.push(("STARLING_PI_NO_SESSION".into(), "1".into()));
    } else {
        if attach_hook && pi_has_resume_picker_arg(&passthrough_args) {
            anyhow::bail!(
                "managed Pi runs cannot safely lock the interactive --resume picker; use `starling resume <session-id-or-path>` or run `pi --resume` directly"
            );
        }
        if let Some(target) = resolve_pi_session_target(&passthrough_args, launch_project_path)? {
            if let Some(transcript_path) = target.transcript_path.as_deref() {
                pin_pi_session_selector(&mut passthrough_args, transcript_path);
            }
            session_id_hint = Some(target.session_id);
            session_project_hint = Some(target.project_path);
        } else if pi_has_continue_arg(&passthrough_args) {
            // A dynamic `-c` without a transcript must be locked before spawn.
            neutralize_pi_continue_selector(&mut passthrough_args);
        }
    }
    if session_id_hint.is_none() && pi_launch_needs_managed_id(&passthrough_args) {
        let session_id = uuid::Uuid::new_v4().to_string();
        args.push("--session-id".into());
        args.push(session_id.clone());
        session_id_hint = Some(session_id);
        session_project_hint = launch_project_path.map(normalize_project_path_str);
    }

    if attach_hook {
        let hook = create_pi_runtime_extension(run_id)?;
        append_pi_runtime_extension_args(&mut args, &hook.extension_file, enforce_permissions);
        envs.push((
            "STARLING_PI_HOOK_FILE".into(),
            hook.hook_file.to_string_lossy().to_string(),
        ));
        cleanup_files.push(hook.extension_file);
        hook_file = Some(hook.hook_file);
    }
    if let Some(session_id) = session_id_hint.as_deref() {
        envs.push(("STARLING_SESSION_ID".into(), session_id.to_string()));
    }

    args.extend(passthrough_args);
    Ok(PreparedLaunch {
        args,
        envs,
        temp_dir: None,
        cleanup_files,
        hook_file,
        session_id_hint,
        session_project_hint,
    })
}

pub(super) fn append_pi_runtime_extension_args(
    args: &mut Vec<String>,
    extension_file: &Path,
    enforce_pi_permissions: bool,
) {
    if enforce_pi_permissions {
        args.push("--no-extensions".into());
        args.push("--starling-managed".into());
    }
    args.push("--extension".into());
    args.push(extension_file.to_string_lossy().to_string());
}

pub(super) fn pi_profile_args(path: &Path) -> Result<Vec<String>> {
    let raw = std::fs::read_to_string(path)?;
    let value: Value = serde_json::from_str(&raw)?;
    let string_field = |primary: &str, alias: &str| {
        value
            .get(primary)
            .or_else(|| value.get(alias))
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(str::to_string)
    };
    let provider = string_field("defaultProvider", "provider");
    let model = string_field("defaultModel", "model");
    let thinking = string_field("defaultThinkingLevel", "thinking");
    if provider.is_some() && model.is_none() {
        anyhow::bail!(
            "Pi profile {} sets a provider but no model; add model/defaultModel",
            path.display()
        );
    }
    let mut args = Vec::new();
    if let Some(provider) = provider {
        args.extend(["--provider".into(), provider]);
    }
    if let Some(model) = model {
        args.extend(["--model".into(), model]);
    }
    if let Some(thinking) = thinking {
        args.extend(["--thinking".into(), thinking]);
    }
    Ok(args)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum PiArgKind {
    Session,
    SessionId,
    SessionDir,
    Fork,
    Continue,
    Resume,
    NoSession,
    Other,
}

#[derive(Debug, Clone, Copy)]
pub(super) enum PiArgValueSource {
    Next(usize),
    Inline,
}

#[derive(Debug, Clone, Copy)]
pub(super) struct PiArgSpan {
    kind: PiArgKind,
    pub(super) start: usize,
    end: usize,
    pub(super) value: Option<PiArgValueSource>,
}

#[derive(Debug)]
pub(super) struct PiParsedArgs<'a> {
    args: &'a [String],
    pub(super) spans: Vec<PiArgSpan>,
}

impl<'a> PiParsedArgs<'a> {
    /// Scan Pi's argv exactly once and record which option owns each token.
    /// Native Pi value options consume the next token even when it looks like
    /// another flag. Unknown/optional options use Pi's more selective rules.
    pub(super) fn parse(args: &'a [String]) -> Self {
        let mut spans = Vec::with_capacity(args.len());
        let mut index = 0;
        while index < args.len() {
            let arg = args[index].as_str();

            if let Some(kind) = pi_inline_session_arg_kind(arg) {
                spans.push(PiArgSpan {
                    kind,
                    start: index,
                    end: index + 1,
                    value: Some(PiArgValueSource::Inline),
                });
                index += 1;
                continue;
            }

            if let Some(kind) = pi_required_value_arg_kind(arg) {
                let value_index = index + 1;
                let has_value = value_index < args.len();
                spans.push(PiArgSpan {
                    kind,
                    start: index,
                    end: index + 1 + usize::from(has_value),
                    value: has_value.then_some(PiArgValueSource::Next(value_index)),
                });
                index += 1 + usize::from(has_value);
                continue;
            }

            let kind = match arg {
                "--continue" | "-c" => PiArgKind::Continue,
                "--resume" | "-r" => PiArgKind::Resume,
                "--no-session" => PiArgKind::NoSession,
                _ => PiArgKind::Other,
            };
            let next = args.get(index + 1).map(String::as_str);
            let consumes_optional_value = match arg {
                "--print" | "-p" => next
                    .map(|value| {
                        !value.starts_with('@')
                            && (!value.starts_with('-') || value.starts_with("---"))
                    })
                    .unwrap_or(false),
                "--list-models" => next
                    .map(|value| !value.starts_with('-') && !value.starts_with('@'))
                    .unwrap_or(false),
                _ if pi_agent::native_boolean_arg(arg) => false,
                _ if arg.starts_with("--") && !arg.contains('=') => next
                    .map(|value| !value.starts_with('-') && !value.starts_with('@'))
                    .unwrap_or(false),
                _ => false,
            };
            spans.push(PiArgSpan {
                kind,
                start: index,
                end: index + 1 + usize::from(consumes_optional_value),
                value: consumes_optional_value.then_some(PiArgValueSource::Next(index + 1)),
            });
            index += 1 + usize::from(consumes_optional_value);
        }
        Self { args, spans }
    }

    fn span_value(&self, span: &PiArgSpan) -> Option<&'a str> {
        match span.value? {
            PiArgValueSource::Next(index) => self.args.get(index).map(String::as_str),
            PiArgValueSource::Inline => self.args[span.start]
                .split_once('=')
                .map(|(_, value)| value),
        }
    }

    /// Pi overwrites singular value options as it scans, so the last
    /// occurrence that actually owns a value is effective. A final missing
    /// value does not clear an earlier assignment, while an owned empty token
    /// does.
    pub(super) fn value(&self, kind: PiArgKind) -> Option<&'a str> {
        self.spans
            .iter()
            .rev()
            .find_map(|span| (span.kind == kind).then(|| self.span_value(span)).flatten())
    }

    pub(super) fn has(&self, kind: PiArgKind) -> bool {
        self.spans.iter().any(|span| span.kind == kind)
    }
}

pub(super) fn pi_inline_session_arg_kind(arg: &str) -> Option<PiArgKind> {
    if arg.starts_with("--session-id=") {
        Some(PiArgKind::SessionId)
    } else if arg.starts_with("--session-dir=") {
        Some(PiArgKind::SessionDir)
    } else if arg.starts_with("--session=") {
        Some(PiArgKind::Session)
    } else {
        None
    }
}

pub(super) fn pi_required_value_arg_kind(arg: &str) -> Option<PiArgKind> {
    Some(match arg {
        "--session" => PiArgKind::Session,
        "--session-id" => PiArgKind::SessionId,
        "--session-dir" => PiArgKind::SessionDir,
        "--fork" => PiArgKind::Fork,
        other if pi_agent::required_value_arg(other) => PiArgKind::Other,
        _ => return None,
    })
}

pub(super) fn pi_arg_kind(flag: &str) -> Option<PiArgKind> {
    Some(match flag {
        "--session" => PiArgKind::Session,
        "--session-id" => PiArgKind::SessionId,
        "--session-dir" => PiArgKind::SessionDir,
        "--fork" => PiArgKind::Fork,
        _ => return None,
    })
}

pub(super) fn pi_arg_value(args: &[String], flag: &str) -> Option<String> {
    let kind = pi_arg_kind(flag)?;
    PiParsedArgs::parse(args).value(kind).map(str::to_string)
}

pub(super) fn normalize_pi_passthrough_args(args: &[String]) -> Result<Vec<String>> {
    let mut normalized = Vec::with_capacity(args.len());
    let parsed = PiParsedArgs::parse(args);
    for span in &parsed.spans {
        if matches!(span.value, Some(PiArgValueSource::Inline)) {
            let flag = match span.kind {
                PiArgKind::Session => "--session",
                PiArgKind::SessionId => "--session-id",
                PiArgKind::SessionDir => "--session-dir",
                _ => unreachable!("only managed Pi value flags support inline normalization"),
            };
            let value = parsed.span_value(span).unwrap_or_default();
            if value.is_empty() {
                anyhow::bail!("Pi argument '{flag}' requires a value");
            }
            normalized.push(flag.to_string());
            normalized.push(value.to_string());
        } else {
            normalized.extend(args[span.start..span.end].iter().cloned());
        }
    }
    Ok(normalized)
}

pub(super) fn validate_pi_session_id_value(session_id: &str) -> Result<()> {
    let bytes = session_id.as_bytes();
    let valid_edge = |byte: u8| byte.is_ascii_alphanumeric();
    let valid = bytes.first().copied().map(valid_edge).unwrap_or(false)
        && bytes.last().copied().map(valid_edge).unwrap_or(false)
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'));
    if !valid {
        anyhow::bail!(
            "Session id must be non-empty, contain only alphanumeric characters, '-', '_', and '.', and start and end with an alphanumeric character"
        );
    }
    Ok(())
}

pub(super) fn validate_pi_selector_combinations(args: &[String]) -> Result<()> {
    if pi_truthy_arg_value(args, "--fork").is_some() {
        let mut conflicts = Vec::new();
        if pi_truthy_arg_value(args, "--session").is_some() {
            conflicts.push("--session");
        }
        if pi_has_continue_arg(args) {
            conflicts.push("--continue");
        }
        if pi_has_resume_picker_arg(args) {
            conflicts.push("--resume");
        }
        if pi_has_no_session_arg(args) {
            conflicts.push("--no-session");
        }
        if !conflicts.is_empty() {
            anyhow::bail!("--fork cannot be combined with {}", conflicts.join(", "));
        }
    }

    if let Some(session_id) = pi_arg_value(args, "--session-id") {
        let mut conflicts = Vec::new();
        if pi_truthy_arg_value(args, "--session").is_some() {
            conflicts.push("--session");
        }
        if pi_has_continue_arg(args) {
            conflicts.push("--continue");
        }
        if pi_has_resume_picker_arg(args) {
            conflicts.push("--resume");
        }
        if !conflicts.is_empty() {
            anyhow::bail!(
                "--session-id cannot be combined with {}",
                conflicts.join(", ")
            );
        }
        validate_pi_session_id_value(&session_id)?;
    }
    Ok(())
}

#[derive(Debug)]
pub(super) struct PiSessionTarget {
    pub(super) session_id: String,
    pub(super) project_path: String,
    pub(super) transcript_path: Option<String>,
}

pub(super) fn pi_local_session_infos(
    layout: &PiLaunchSessionLayout,
    launch_project: &Path,
) -> Vec<pi_agent::SessionFileInfo> {
    let mut sessions = pi_agent::direct_session_infos(&layout.local_dir);
    if layout.filter_local_cwd {
        sessions
            .retain(|session| pi_agent::session_cwd_matches(&session.project_path, launch_project));
    }
    pi_agent::sort_sessions(&mut sessions);
    sessions
}

pub(super) fn pi_all_session_infos(
    layout: &PiLaunchSessionLayout,
) -> Vec<pi_agent::SessionFileInfo> {
    let mut sessions = if layout.configured {
        pi_agent::direct_session_infos(&layout.session_root)
    } else {
        let Ok(entries) = std::fs::read_dir(&layout.session_root) else {
            return Vec::new();
        };
        entries
            .flatten()
            .filter(|entry| entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false))
            .flat_map(|entry| pi_agent::direct_session_infos(&entry.path()))
            .collect()
    };
    pi_agent::sort_sessions(&mut sessions);
    sessions
}

/// Pi's `continueRecent()` only validates direct-file headers and then sorts by
/// filesystem mtime. It deliberately does not use the logical message activity
/// ordering used by `list()` and `listAll()`.
pub(super) fn pi_most_recent_session(
    layout: &PiLaunchSessionLayout,
    launch_project: &Path,
) -> Option<pi_agent::SessionFileInfo> {
    let mut sessions = pi_agent::direct_recent_session_infos(&layout.local_dir);
    if layout.filter_local_cwd {
        sessions
            .retain(|session| pi_agent::session_cwd_matches(&session.project_path, launch_project));
    }
    sessions.sort_by(|left, right| right.file_mtime_ms.cmp(&left.file_mtime_ms));
    sessions.into_iter().next()
}

pub(super) fn pi_truthy_arg_value(args: &[String], flag: &str) -> Option<String> {
    pi_arg_value(args, flag).filter(|value| !value.is_empty())
}

pub(super) fn pi_effective_open_project_path(session_cwd: &str, launch_project: &str) -> String {
    if session_cwd.is_empty() {
        return launch_project.to_string();
    }
    let resolved = pi_agent::resolve_path_lexically(session_cwd, Path::new(launch_project));
    normalize_project_path(&resolved)
}

pub(super) fn pi_continue_target(
    layout: &PiLaunchSessionLayout,
    launch_project: &str,
) -> Option<PiSessionTarget> {
    let meta = pi_most_recent_session(layout, Path::new(launch_project))?;
    Some(PiSessionTarget {
        session_id: meta.session_id,
        // Starling pins -c to --session <absolute path>. The spawned Pi thus
        // goes through SessionManager.open(), whose runtime cwd comes from the
        // transcript header rather than continueRecent()'s launch cwd.
        project_path: pi_effective_open_project_path(&meta.project_path, launch_project),
        transcript_path: Some(canonical_transcript_path(&meta.file_path.to_string_lossy())),
    })
}

pub(super) fn pi_selector_looks_like_path(selector: &str) -> bool {
    selector.contains('/') || selector.contains('\\') || selector.ends_with(".jsonl")
}

pub(super) fn resolve_pi_session_target(
    args: &[String],
    launch_project_path: Option<&str>,
) -> Result<Option<PiSessionTarget>> {
    let launch_project = launch_project_path
        .map(normalize_project_path_str)
        .or_else(|| {
            std::env::current_dir()
                .ok()
                .map(|path| normalize_project_path(&path))
        })
        .unwrap_or_default();

    // `createSessionManager()` handles --fork before every other persistent
    // selector. Its optional --session-id names the new fork, not the source.
    if pi_truthy_arg_value(args, "--fork").is_some() {
        return Ok(
            pi_arg_value(args, "--session-id").map(|session_id| PiSessionTarget {
                session_id,
                project_path: launch_project,
                transcript_path: None,
            }),
        );
    }

    // Pi treats an empty --session value as false and proceeds to the next
    // selector branch. Repeated value options are last-wins (pi_arg_value).
    if let Some(selector) = pi_truthy_arg_value(args, "--session") {
        let selector_path = resolve_pi_launch_path(&selector, &launch_project);
        if pi_selector_looks_like_path(&selector) {
            if !selector_path.exists() {
                anyhow::bail!(
                    "managed Pi runs cannot initialize a new explicit transcript path before acquiring its writer lock: {}; create it once with `pi --session {}` and then resume it with Starling",
                    selector_path.display(),
                    selector_path.display()
                );
            }
            if !selector_path.is_file() {
                anyhow::bail!(
                    "Pi session transcript is not a file: {}",
                    selector_path.display()
                );
            }
            if std::fs::metadata(&selector_path)
                .map(|metadata| metadata.len() == 0)
                .unwrap_or(false)
            {
                anyhow::bail!(
                    "managed Pi runs cannot initialize an empty explicit transcript before acquiring its writer lock: {}; initialize it once with `pi --session {}` and then resume it with Starling",
                    selector_path.display(),
                    selector_path.display()
                );
            }
            let target =
                find_pi_session_by_path(&selector_path.to_string_lossy()).ok_or_else(|| {
                    anyhow::anyhow!(
                        "{} is not a valid Pi session transcript",
                        selector_path.display()
                    )
                })?;
            return Ok(Some(PiSessionTarget {
                session_id: target.session_id,
                project_path: pi_effective_open_project_path(&target.project_path, &launch_project),
                transcript_path: Some(canonical_transcript_path(&target.file_path)),
            }));
        }

        // Mirror Pi's effective SessionManager.list/listAll directories,
        // logical-activity ordering, and exact-then-prefix selection. Global
        // Starling discovery cannot see every project-local or one-shot
        // --session-dir.
        let cli_session_dir = pi_arg_value(args, "--session-dir");
        let launch_project_path = Path::new(&launch_project);
        let layout = resolve_pi_session_layout_for_launch(
            Path::new(&launch_project),
            cli_session_dir.as_deref(),
        );
        let local = pi_local_session_infos(&layout, launch_project_path);
        if let Some(target) = pi_agent::exact_or_prefix(&local, &selector) {
            return Ok(Some(PiSessionTarget {
                session_id: target.session_id.clone(),
                project_path: pi_effective_open_project_path(&target.project_path, &launch_project),
                transcript_path: Some(canonical_transcript_path(
                    &target.file_path.to_string_lossy(),
                )),
            }));
        }
        let all_sessions = pi_all_session_infos(&layout);
        if let Some(target) = pi_agent::exact_or_prefix(&all_sessions, &selector) {
            anyhow::bail!(
                "managed Pi run cannot predict whether cross-project selector '{selector}' ({}) will be opened or forked; use an absolute transcript path",
                target.file_path.display()
            );
        }
        anyhow::bail!("Pi session not found: {selector}");
    }

    // The interactive picker precedes --continue and --session-id. Managed
    // launches reject it before this resolver; retaining the branch keeps
    // non-spawning unit/profile preparation aligned with Pi as well.
    if pi_has_resume_picker_arg(args) {
        return Ok(None);
    }

    if pi_has_continue_arg(args) {
        let cli_session_dir = pi_arg_value(args, "--session-dir");
        let layout = resolve_pi_session_layout_for_launch(
            Path::new(&launch_project),
            cli_session_dir.as_deref(),
        );
        if let Some(target) = pi_continue_target(&layout, &launch_project) {
            return Ok(Some(target));
        }
        return Ok(None);
    }

    if let Some(session_id) = pi_arg_value(args, "--session-id") {
        if !session_id.is_empty() {
            let cli_session_dir = pi_arg_value(args, "--session-dir");
            let layout = resolve_pi_session_layout_for_launch(
                Path::new(&launch_project),
                cli_session_dir.as_deref(),
            );
            let local = pi_local_session_infos(&layout, Path::new(&launch_project));
            if let Some(target) = local.iter().find(|target| target.session_id == session_id) {
                return Ok(Some(PiSessionTarget {
                    session_id: target.session_id.clone(),
                    project_path: pi_effective_open_project_path(
                        &target.project_path,
                        &launch_project,
                    ),
                    transcript_path: Some(canonical_transcript_path(
                        &target.file_path.to_string_lossy(),
                    )),
                }));
            }
        }
        return Ok(Some(PiSessionTarget {
            session_id,
            project_path: launch_project,
            transcript_path: None,
        }));
    }

    Ok(None)
}

pub(super) fn canonical_transcript_path(path: &str) -> String {
    let canonical = std::fs::canonicalize(path).unwrap_or_else(|_| PathBuf::from(path));
    pi_node_compatible_path(&canonical)
        .to_string_lossy()
        .to_string()
}

/// Replace dynamic Pi selectors with the exact transcript Starling locked.
pub(super) fn pin_pi_session_selector(args: &mut Vec<String>, transcript_path: &str) {
    let parsed = PiParsedArgs::parse(args);
    let mut pinned = Vec::with_capacity(args.len() + 2);
    for span in &parsed.spans {
        if matches!(
            span.kind,
            PiArgKind::Session | PiArgKind::SessionId | PiArgKind::Continue
        ) {
            // Replace each real selector in place. Its flag-shaped replacement
            // remains a barrier for a preceding unknown option, and its owned
            // path keeps a following message separate. Replacing every
            // assignment also preserves Pi's last-wins behavior while making
            // every surviving selector point at the transcript we locked.
            pinned.push("--session".into());
            pinned.push(transcript_path.into());
            continue;
        }
        pinned.extend(args[span.start..span.end].iter().cloned());
    }
    *args = pinned;
}

pub(super) fn neutralize_pi_continue_selector(args: &mut Vec<String>) {
    let parsed = PiParsedArgs::parse(args);
    let mut filtered = Vec::with_capacity(args.len() + 1);
    for span in &parsed.spans {
        if span.kind == PiArgKind::Continue {
            // An empty session assignment is falsey in Pi, so the managed
            // --session-id still creates the preallocated session. Keeping a
            // two-token placeholder at the original position prevents an
            // unknown flag before `-c` from consuming a message after it.
            filtered.push("--session".into());
            filtered.push(String::new());
        } else {
            filtered.extend(args[span.start..span.end].iter().cloned());
        }
    }
    *args = filtered;
}

pub(super) fn pi_launch_needs_managed_id(args: &[String]) -> bool {
    let parsed = PiParsedArgs::parse(args);
    if parsed
        .value(PiArgKind::Fork)
        .filter(|value| !value.is_empty())
        .is_some()
    {
        return parsed.value(PiArgKind::SessionId).is_none();
    }
    if parsed.value(PiArgKind::SessionId).is_some() {
        return false;
    }
    // A managed --continue with no existing transcript is rewritten to an
    // empty --session barrier before reaching this helper. It still needs a
    // stable ID so Starling can preserve the requested continuation contract.
    // Plain launches have no selector at all: let Pi create their ID natively.
    parsed.value(PiArgKind::Session) == Some("")
}

pub(super) fn pi_has_no_session_arg(args: &[String]) -> bool {
    PiParsedArgs::parse(args).has(PiArgKind::NoSession)
}

pub(super) fn pi_has_continue_arg(args: &[String]) -> bool {
    PiParsedArgs::parse(args).has(PiArgKind::Continue)
}

pub(super) fn pi_has_resume_picker_arg(args: &[String]) -> bool {
    PiParsedArgs::parse(args).has(PiArgKind::Resume)
}

pub(super) fn resolve_pi_launch_path(value: &str, launch_project: &str) -> PathBuf {
    let path = normalize_pi_path_input(value);
    if path.is_absolute() {
        path
    } else if launch_project.is_empty() {
        path
    } else {
        Path::new(launch_project).join(path)
    }
}

pub(super) fn normalize_project_path_str(path: &str) -> String {
    normalize_project_path(Path::new(path))
}

pub(super) fn normalize_project_path(path: &Path) -> String {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map(|cwd| cwd.join(path))
            .unwrap_or_else(|_| path.to_path_buf())
    };
    if let Ok(canonical) = std::fs::canonicalize(&absolute) {
        // Windows canonicalize() yields a \\?\-prefixed verbatim path, which
        // would never equal a session-header cwd (plain drive spelling) and
        // made every local session look cross-project. Node-compatible
        // spelling keeps the comparison (and hints) consistent.
        return pi_node_compatible_path(&canonical)
            .to_string_lossy()
            .to_string();
    }

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
    normalized.to_string_lossy().to_string()
}

pub(crate) struct PiRuntimeExtension {
    pub(crate) extension_file: PathBuf,
    pub(crate) hook_file: PathBuf,
}

pub(super) fn pi_session_switch_guard_source() -> &'static str {
    r#"function blockManagedSessionChange(_event, ctx) {
  ctx.ui?.notify?.(
    "Starling has locked this Pi transcript. Exit Pi, then use `starling resume` or a new `starling run pi` instead of switching sessions in place.",
    "warning",
  );
  return { cancel: true };
}"#
}

pub(super) fn pi_session_switch_guard_registration_source() -> &'static str {
    r#"  pi.on("session_before_switch", blockManagedSessionChange);
  pi.on("session_before_fork", blockManagedSessionChange);"#
}

pub(crate) fn create_pi_runtime_extension(run_id: &str) -> Result<PiRuntimeExtension> {
    let dir = default_starling_home().join("run-hooks");
    std::fs::create_dir_all(&dir)?;
    let extension_file = dir.join(format!("{run_id}.pi-extension.mjs"));
    let hook_file = dir.join(format!("{run_id}.pi.jsonl"));
    let starling_exe = std::env::current_exe()?.to_string_lossy().to_string();
    let template = r#"import { spawnSync } from "node:child_process";

const STARLING_EXE = __STARLING_EXE__;
const RUN_ID = __RUN_ID__;
const HOOK_FILE = __HOOK_FILE__;

__SESSION_GUARD__

function emit(eventName, event, ctx) {
  try {
    const usage = ctx.getContextUsage?.();
    const percent = typeof usage?.percent === "number" ? usage.percent : undefined;
    const payload = {
      session_id: ctx.sessionManager?.getSessionId?.(),
      transcript_path: ctx.sessionManager?.getSessionFile?.(),
      cwd: ctx.cwd,
      model: ctx.model?.id,
      provider: ctx.model?.provider,
      prompt: event?.prompt,
      tool_name: event?.toolName,
      message: event?.isError ? "tool execution failed" : undefined,
      context_window: percent === undefined ? undefined : {
        used_percentage: percent,
        remaining_percentage: Math.max(0, 100 - percent),
      },
    };
    spawnSync(STARLING_EXE, ["top", "hook", "--provider", "pi", "--event", eventName,
      "--run-id", RUN_ID, "--hook-file", HOOK_FILE, "--pid", String(process.pid)], {
      input: JSON.stringify(payload),
      stdio: ["pipe", "ignore", "ignore"],
      timeout: 5000,
    });
  } catch (_) {}
}

export default function (pi) {
  // The inherited OS lock protects exactly one transcript. Prevent Pi's
  // in-process /new, /resume, and /fork flows from changing that identity.
__SESSION_GUARD_REGISTRATIONS__
  pi.on("session_start", (event, ctx) => emit("SessionStart", event, ctx));
  pi.on("before_agent_start", (event, ctx) => emit("UserPromptSubmit", event, ctx));
  pi.on("tool_execution_start", (event, ctx) => emit("PreToolUse", event, ctx));
  pi.on("tool_execution_end", (event, ctx) => emit(event?.isError ? "PostToolUseFailure" : "PostToolUse", event, ctx));
  pi.on("agent_end", (event, ctx) => {
    const failed = event?.messages?.some?.((message) => message?.stopReason === "error");
    emit(failed ? "StopFailure" : "Stop", event, ctx);
  });
  pi.on("session_shutdown", (event, ctx) => emit("SessionEnd", event, ctx));
}
"#;
    let rendered = template
        .replace("__STARLING_EXE__", &serde_json::to_string(&starling_exe)?)
        .replace("__RUN_ID__", &serde_json::to_string(run_id)?)
        .replace("__SESSION_GUARD__", pi_session_switch_guard_source())
        .replace(
            "__SESSION_GUARD_REGISTRATIONS__",
            pi_session_switch_guard_registration_source(),
        )
        .replace(
            "__HOOK_FILE__",
            &serde_json::to_string(&hook_file.to_string_lossy().to_string())?,
        );
    std::fs::write(&extension_file, rendered)?;
    Ok(PiRuntimeExtension {
        extension_file,
        hook_file,
    })
}

pub(super) fn ensure_pi_session_not_running(
    session_id: Option<&str>,
    project_path: Option<&str>,
) -> Result<()> {
    let Some(session_id) = session_id.map(str::trim).filter(|id| !id.is_empty()) else {
        return Ok(());
    };
    reconcile_stale_runs();
    let conflict = list_runs(None).into_iter().any(|run| {
        run.provider == RunProvider::Pi
            && run.status == RunStatus::Running
            && run.session_id.as_deref() == Some(session_id)
            && match (project_path, run.project_path.as_deref()) {
                (Some(project), Some(run_project)) => {
                    normalize_project_path_str(project) == normalize_project_path_str(run_project)
                }
                // If either side lacks cwd information, retain the conservative
                // global-ID guard instead of risking a duplicate transcript.
                _ => true,
            }
            && run
                .pid
                .map(crate::core::runs::is_pid_alive)
                .unwrap_or(false)
    });
    if conflict {
        anyhow::bail!("Pi session '{session_id}' is already open in a live Starling-managed run");
    }
    Ok(())
}
