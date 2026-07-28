#![cfg(unix)]

use std::ffi::OsString;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

fn test_root(label: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "starling-run-signal-{label}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ))
}

fn write_executable(path: &std::path::Path, source: &str) {
    std::fs::write(path, source).unwrap();
    let mut permissions = std::fs::metadata(path).unwrap().permissions();
    permissions.set_mode(0o755);
    std::fs::set_permissions(path, permissions).unwrap();
}

fn spawn_starling(root: &std::path::Path, child_pid_file: Option<&std::path::Path>) -> Child {
    let project = root.join("project");
    std::fs::create_dir_all(&project).unwrap();
    let search_path = std::env::join_paths(std::iter::once(root.to_path_buf()).chain(
        std::env::split_paths(&std::env::var_os("PATH").unwrap_or_else(OsString::new)),
    ))
    .unwrap();

    let mut command = Command::new(env!("CARGO_BIN_EXE_starling"));
    command
        .args(["run", "--cwd"])
        .arg(&project)
        .arg("--no-mcp")
        .arg("claude")
        .env("PATH", search_path)
        .env("STARLING_HOME", root.join("starling-home"))
        .env("STARLING_CLI_CONFIG", root.join("config.json"))
        .env("CLAUDE_CONFIG_DIR", root.join("claude-home"))
        .env("STARLING_RUN_PTY", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some(path) = child_pid_file {
        command.env("STARLING_TEST_CHILD_PID", path);
    }
    // libtest may inherit a non-default signal mask. Match a normal shell.
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
    command.spawn().unwrap()
}

fn wait_for_file(path: &std::path::Path, timeout: Duration) {
    let deadline = Instant::now() + timeout;
    while std::fs::metadata(path)
        .map(|metadata| metadata.len() == 0)
        .unwrap_or(true)
    {
        assert!(
            Instant::now() < deadline,
            "timed out waiting for {}",
            path.display()
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn wait_for_child(child: &mut Child, timeout: Duration) -> std::process::ExitStatus {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            return status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            panic!("starling run did not terminate before the timeout");
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn run_replays_parent_term_after_forwarding_it_to_the_managed_child() {
    let root = test_root("parent");
    std::fs::create_dir_all(&root).unwrap();
    let child_pid_file = root.join("child.pid");
    write_executable(
        &root.join("claude"),
        "#!/bin/sh\nprintf '%s\\n' \"$$\" > \"$STARLING_TEST_CHILD_PID\"\ntrap 'exit 143' TERM\nwhile :; do sleep 1; done\n",
    );

    let mut starling = spawn_starling(&root, Some(&child_pid_file));
    wait_for_file(&child_pid_file, Duration::from_secs(5));
    let child_pid: libc::pid_t = std::fs::read_to_string(&child_pid_file)
        .unwrap()
        .trim()
        .parse()
        .unwrap();

    assert_eq!(
        unsafe { libc::kill(starling.id() as libc::pid_t, libc::SIGTERM) },
        0
    );
    let status = wait_for_child(&mut starling, Duration::from_secs(10));
    let child_alive = unsafe { libc::kill(child_pid, 0) } == 0;
    if child_alive {
        let _ = unsafe { libc::kill(child_pid, libc::SIGKILL) };
    }

    assert!(
        !status.success(),
        "parent SIGTERM must not become a successful exit"
    );
    assert!(
        status.signal() == Some(libc::SIGTERM) || status.code() == Some(128 + libc::SIGTERM),
        "expected SIGTERM/143, got {status:?}"
    );
    assert!(!child_alive, "managed child survived the parent signal");

    let runs: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(root.join("starling-home/runs.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(runs["runs"][0]["status"], "crashed");
    std::fs::remove_dir_all(root).ok();
}

#[test]
fn run_maps_a_child_only_signal_to_128_plus_signal() {
    let root = test_root("child-only");
    std::fs::create_dir_all(&root).unwrap();
    write_executable(&root.join("claude"), "#!/bin/sh\nkill -TERM \"$$\"\n");

    let mut starling = spawn_starling(&root, None);
    let status = wait_for_child(&mut starling, Duration::from_secs(10));
    assert_eq!(
        status.code(),
        Some(128 + libc::SIGTERM),
        "status: {status:?}"
    );

    let runs: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(root.join("starling-home/runs.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(runs["runs"][0]["status"], "errored");
    assert_eq!(runs["runs"][0]["exit_code"], 128 + libc::SIGTERM);
    std::fs::remove_dir_all(root).ok();
}
