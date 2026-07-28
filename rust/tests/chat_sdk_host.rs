use std::process::{Command, Stdio};

fn test_root(label: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "starling-chat-sdk-{label}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ))
}

#[test]
fn chat_fails_clearly_when_the_sdk_host_is_unavailable() {
    let root = test_root("missing");
    let home = root.join("starling-home");
    let project = root.join("project");
    std::fs::create_dir_all(&project).unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_starling"))
        .args(["chat", "--cwd"])
        .arg(&project)
        .arg("pi")
        .env("STARLING_HOME", &home)
        .env("STARLING_CLI_CONFIG", root.join("config.json"))
        .env_remove("STARLING_PI_SDK_HOST")
        .env_remove("STARLING_PI_SDK_NODE")
        .stdin(Stdio::null())
        .output()
        .unwrap();

    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("Pi SDK unavailable"), "stderr: {stderr}");
    assert!(stderr.contains("STARLING_PI_SDK_HOST"), "stderr: {stderr}");
    assert!(
        !home.join("runs.json").exists(),
        "an unavailable SDK host must fail before recording a run"
    );

    std::fs::remove_dir_all(root).ok();
}

#[cfg(unix)]
#[test]
fn chat_launches_only_the_node_sdk_host_and_relays_strict_jsonl() {
    use std::os::unix::fs::PermissionsExt;

    let root = test_root("launch");
    let home = root.join("starling-home");
    let project = root.join("project");
    let args_file = root.join("sdk-host-args.txt");
    let pi_marker = root.join("pi-cli-was-called");
    std::fs::create_dir_all(&project).unwrap();

    let sdk_host = root.join("sdk-host.js");
    std::fs::write(
        &sdk_host,
        "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$STARLING_TEST_SDK_ARGS\"\nprevious=''\nfor argument in \"$@\"; do\n  if [ \"$previous\" = '--extension' ]; then\n    hook_file=${argument%.pi-extension.mjs}.pi.jsonl\n    printf '%s\\n' '{\"session_id\":\"sdk-host-session\",\"cwd\":\"/work\"}' > \"$hook_file\"\n  fi\n  previous=$argument\ndone\nprintf '%s\\n' '{\"type\":\"sdk_host_event\",\"source\":\"sdk\"}'\n",
    )
    .unwrap();

    let fake_pi = root.join("pi");
    std::fs::write(
        &fake_pi,
        "#!/bin/sh\nprintf called > \"$STARLING_TEST_PI_MARKER\"\nexit 91\n",
    )
    .unwrap();
    let mut permissions = std::fs::metadata(&fake_pi).unwrap().permissions();
    permissions.set_mode(0o755);
    std::fs::set_permissions(&fake_pi, permissions).unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_starling"))
        .args(["chat", "--cwd"])
        .arg(&project)
        .args(["--title", "SDK title", "pi"])
        .env("STARLING_HOME", &home)
        .env("STARLING_CLI_CONFIG", root.join("config.json"))
        .env("STARLING_PI_SDK_HOST", &sdk_host)
        .env("STARLING_PI_SDK_NODE", "/bin/sh")
        .env("STARLING_PI_BIN", &fake_pi)
        .env("STARLING_TEST_SDK_ARGS", &args_file)
        .env("STARLING_TEST_PI_MARKER", &pi_marker)
        .env_remove("STARLING_BUNDLED_PI_BIN")
        .env_remove("STARLING_BUNDLED_PI_NODE")
        .stdin(Stdio::null())
        .output()
        .unwrap();

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        !pi_marker.exists(),
        "chat unexpectedly fell back to the Pi CLI"
    );

    let host_args = std::fs::read_to_string(&args_file).unwrap();
    let host_args: Vec<_> = host_args.lines().collect();
    assert!(!host_args.contains(&"--mode"));
    assert!(!host_args.contains(&"rpc"));
    assert!(!host_args.contains(&"--session-id"));
    assert!(!host_args.contains(&"--session"));
    assert!(host_args
        .windows(2)
        .any(|pair| pair == ["--name", "SDK title"]));

    let records: Vec<serde_json::Value> = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(records.len(), 3, "records: {records:?}");
    assert_eq!(records[0]["type"], "starling_started");
    assert_eq!(records[0]["sessionId"], serde_json::Value::Null);
    assert_eq!(records[1]["type"], "sdk_host_event");
    assert_eq!(records[2]["type"], "starling_exited");
    assert_eq!(records[2]["sessionId"], "sdk-host-session");
    assert_eq!(records[2]["success"], true);

    std::fs::remove_dir_all(root).ok();
}

#[cfg(unix)]
#[test]
fn chat_resume_passes_only_the_absolute_transcript_selector_to_the_sdk_host() {
    let root = test_root("resume");
    let home = root.join("starling-home");
    let transcript_project = root.join("transcript-project");
    let requested_project = root.join("requested-project");
    let args_file = root.join("sdk-host-args.txt");
    let cwd_file = root.join("sdk-host-cwd.txt");
    std::fs::create_dir_all(&transcript_project).unwrap();
    std::fs::create_dir_all(&requested_project).unwrap();

    let transcript = root.join("resume.jsonl");
    std::fs::write(
        &transcript,
        format!(
            "{{\"type\":\"session\",\"version\":3,\"id\":\"sdk-resume-session\",\"timestamp\":\"2026-07-28T00:00:00.000Z\",\"cwd\":{}}}\n",
            serde_json::to_string(transcript_project.to_string_lossy().as_ref()).unwrap()
        ),
    )
    .unwrap();

    let sdk_host = root.join("sdk-host.js");
    std::fs::write(
        &sdk_host,
        "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$STARLING_TEST_SDK_ARGS\"\npwd > \"$STARLING_TEST_SDK_CWD\"\nprintf '%s\\n' '{\"type\":\"sdk_resume_ready\"}'\n",
    )
    .unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_starling"))
        .args(["chat", "--cwd"])
        .arg(&requested_project)
        .arg("pi")
        .arg("--session")
        .arg(&transcript)
        .env("STARLING_HOME", &home)
        .env("STARLING_CLI_CONFIG", root.join("config.json"))
        .env("STARLING_PI_SDK_HOST", &sdk_host)
        .env("STARLING_PI_SDK_NODE", "/bin/sh")
        .env("STARLING_TEST_SDK_ARGS", &args_file)
        .env("STARLING_TEST_SDK_CWD", &cwd_file)
        .stdin(Stdio::null())
        .output()
        .unwrap();

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let host_args = std::fs::read_to_string(&args_file).unwrap();
    let host_args: Vec<_> = host_args.lines().collect();
    assert!(!host_args.contains(&"--mode"));
    assert!(!host_args.contains(&"--session-id"));
    let session_index = host_args
        .iter()
        .position(|arg| *arg == "--session")
        .expect("resume selector");
    assert_eq!(
        std::path::Path::new(host_args[session_index + 1]),
        std::fs::canonicalize(&transcript).unwrap()
    );
    assert_eq!(
        std::fs::canonicalize(std::fs::read_to_string(&cwd_file).unwrap().trim()).unwrap(),
        std::fs::canonicalize(&transcript_project).unwrap(),
        "the transcript project must override an unrelated caller --cwd"
    );

    let runs: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(home.join("runs.json")).unwrap()).unwrap();
    assert_eq!(runs["runs"][0]["session_id"], "sdk-resume-session");

    std::fs::remove_dir_all(root).ok();
}
