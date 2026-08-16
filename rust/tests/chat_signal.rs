#![cfg(unix)]

use std::io::{BufRead, BufReader};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[test]
fn chat_replays_parent_term_after_reaping_child_and_cleaning_runtime_extension() {
    let root = std::env::temp_dir().join(format!(
        "starling-chat-signal-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let home = root.join("starling-home");
    let project = root.join("project");
    std::fs::create_dir_all(&project).unwrap();

    let sdk_host = root.join("sdk-host.js");
    std::fs::write(&sdk_host, "exec sleep 30\n").unwrap();
    let mut permissions = std::fs::metadata(&sdk_host).unwrap().permissions();
    permissions.set_mode(0o755);
    std::fs::set_permissions(&sdk_host, permissions).unwrap();

    let mut command = Command::new(env!("CARGO_BIN_EXE_starling"));
    command
        .args(["chat", "--cwd"])
        .arg(&project)
        .arg("pi")
        .env("STARLING_HOME", &home)
        .env("STARLING_CLI_CONFIG", root.join("config.json"))
        .env_remove("STARLING_CONFIG")
        .env_remove("STARLING_RUNS")
        .env("STARLING_PI_SDK_HOST", &sdk_host)
        .env("STARLING_PI_SDK_NODE", "/bin/sh")
        .env_remove("STARLING_PI_BIN")
        .env_remove("STARLING_BUNDLED_PI_BIN")
        .env_remove("STARLING_BUNDLED_PI_NODE")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // libtest may run with a non-default thread signal mask. Restore the
    // shell-like unblocked mask that the real CLI process starts with.
    unsafe {
        command.pre_exec(|| {
            let mut mask = std::mem::zeroed();
            libc::sigemptyset(&mut mask);
            if libc::pthread_sigmask(libc::SIG_SETMASK, &mask, std::ptr::null_mut()) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut starling = command.spawn().unwrap();

    let stdout = starling.stdout.take().unwrap();
    let mut stdout = BufReader::new(stdout);
    let mut started = String::new();
    stdout.read_line(&mut started).unwrap();
    let started: serde_json::Value = serde_json::from_str(started.trim()).unwrap();
    assert_eq!(started["type"], "starling_started");
    let host_pid = started["pid"].as_u64().unwrap() as libc::pid_t;

    assert_eq!(
        unsafe { libc::kill(starling.id() as libc::pid_t, libc::SIGTERM) },
        0
    );

    let deadline = Instant::now() + Duration::from_secs(10);
    let status = loop {
        if let Some(status) = starling.try_wait().unwrap() {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = starling.kill();
            let _ = unsafe { libc::kill(host_pid, libc::SIGKILL) };
            panic!("starling chat did not terminate after SIGTERM");
        }
        std::thread::sleep(Duration::from_millis(20));
    };

    assert!(
        status.signal() == Some(libc::SIGTERM) || status.code() == Some(128 + libc::SIGTERM),
        "expected SIGTERM/143, got {status:?}"
    );
    assert_eq!(
        unsafe { libc::kill(host_pid, 0) },
        -1,
        "managed Pi SDK host survived Starling termination"
    );

    let runs: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(home.join("runs.json")).unwrap()).unwrap();
    assert_eq!(runs["runs"][0]["status"], "crashed");

    let hooks = home.join("run-hooks");
    let leaked_extension = std::fs::read_dir(&hooks)
        .unwrap()
        .filter_map(Result::ok)
        .any(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .ends_with(".pi-extension.mjs")
        });
    assert!(!leaked_extension, "generated Pi runtime extension leaked");

    let _ = std::fs::remove_dir_all(root);
}
