//! Shared transport for `top --json --watch` on Unix.
//!
//! Windows has no Unix-domain sockets, so the hub is Unix-only; there the
//! watch loop compiles to the direct per-process snapshot path instead.
#![cfg(unix)]

use std::fs::{File, OpenOptions};
use std::io::{self, BufRead, BufReader, Write};
use std::os::fd::AsRawFd;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::*;
use crate::constants::default_starling_home;

const PROTOCOL_VERSION: u32 = 1;
const CLIENT_WRITE_TIMEOUT: Duration = Duration::from_millis(100);

#[derive(Debug, Deserialize, Serialize)]
struct HubHello {
    r#type: String,
    protocol: u32,
    build_id: String,
    pid: u32,
}

pub(super) fn watch_json(
    catalog_filter: Option<&str>,
    include_unpinned: bool,
    session_limit: usize,
    agent_filter: Option<MonitorAgent>,
    sort: MonitorSort,
) -> Result<()> {
    let key = query_key(
        catalog_filter,
        include_unpinned,
        session_limit,
        agent_filter,
        sort,
    );
    let dir = prepare_hub_dir()?;
    let socket_path = dir.join(format!("{key}.sock"));
    let lock_path = dir.join(format!("{key}.lock"));
    if socket_path.as_os_str().as_bytes().len() > 100 {
        return Err(anyhow!("monitor hub socket path is too long"));
    }

    if let Ok(stream) = UnixStream::connect(&socket_path) {
        return relay(stream);
    }

    let Some(lock) = try_acquire_owner_lock(&lock_path)? else {
        for _ in 0..20 {
            std::thread::sleep(Duration::from_millis(50));
            if let Ok(stream) = UnixStream::connect(&socket_path) {
                return relay(stream);
            }
        }
        return Err(anyhow!("monitor hub owner did not publish its socket"));
    };

    let _ = std::fs::remove_file(&socket_path);
    let listener = UnixListener::bind(&socket_path)
        .with_context(|| format!("bind monitor hub socket {}", socket_path.display()))?;
    std::fs::set_permissions(&socket_path, std::fs::Permissions::from_mode(0o600))?;
    listener.set_nonblocking(true)?;
    let _socket = SocketGuard(socket_path);
    run_owner(
        listener,
        lock,
        catalog_filter,
        include_unpinned,
        session_limit,
        agent_filter,
        sort,
    )
}

fn run_owner(
    listener: UnixListener,
    _lock: OwnerLock,
    catalog_filter: Option<&str>,
    include_unpinned: bool,
    session_limit: usize,
    agent_filter: Option<MonitorAgent>,
    sort: MonitorSort,
) -> Result<()> {
    install_ctrlc_handler();
    reset_cpu_sampler();
    let build_id = executable_stamp()?;
    let hello = serde_json::to_string(&HubHello {
        r#type: "hello".into(),
        protocol: PROTOCOL_VERSION,
        build_id: build_id.clone(),
        pid: std::process::id(),
    })?;
    let mut clients = Vec::new();
    let mut latest: Option<String> = None;
    let mut stdout_alive = true;

    while !ctrlc_flag() {
        if executable_stamp().ok().as_deref() != Some(build_id.as_str()) {
            break;
        }
        accept_clients(&listener, &hello, latest.as_deref(), &mut clients)?;
        clear_session_metrics_cache();
        let rows = build_snapshot(
            catalog_filter,
            include_unpinned,
            session_limit,
            agent_filter,
            sort,
        )?;
        let snapshot = serde_json::to_string(&MonitorSnapshot::from_rows(&rows))?;
        if stdout_alive {
            stdout_alive = write_stdout_line(&snapshot)?;
        }
        broadcast(&mut clients, &snapshot);
        latest = Some(snapshot);
        if !stdout_alive && clients.is_empty() {
            break;
        }

        let mut remaining = WATCH_INTERVAL_MS;
        while remaining > 0 && !ctrlc_flag() {
            let step = remaining.min(100);
            std::thread::sleep(Duration::from_millis(step));
            remaining = remaining.saturating_sub(step);
        }
    }
    Ok(())
}

fn accept_clients(
    listener: &UnixListener,
    hello: &str,
    latest: Option<&str>,
    clients: &mut Vec<UnixStream>,
) -> Result<()> {
    loop {
        match listener.accept() {
            Ok((mut stream, _)) => {
                stream.set_write_timeout(Some(CLIENT_WRITE_TIMEOUT))?;
                writeln!(stream, "{hello}")?;
                if let Some(snapshot) = latest {
                    writeln!(stream, "{snapshot}")?;
                }
                clients.push(stream);
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => return Ok(()),
            Err(error) => return Err(error.into()),
        }
    }
}

fn broadcast(clients: &mut Vec<UnixStream>, snapshot: &str) {
    clients.retain_mut(|client| writeln!(client, "{snapshot}").is_ok());
}

fn relay(stream: UnixStream) -> Result<()> {
    let stdout = io::stdout();
    relay_to(BufReader::new(stream), &mut stdout.lock())
}

fn relay_to(mut reader: impl BufRead, output: &mut impl Write) -> Result<()> {
    let mut line = String::new();
    if reader.read_line(&mut line)? == 0 {
        return Err(anyhow!("monitor hub closed before hello"));
    }
    let hello: HubHello = serde_json::from_str(line.trim())?;
    if hello.r#type != "hello" || hello.protocol != PROTOCOL_VERSION {
        return Err(anyhow!("unsupported monitor hub protocol"));
    }

    loop {
        line.clear();
        if reader.read_line(&mut line)? == 0 {
            return Ok(());
        }
        match output.write_all(line.as_bytes()) {
            Ok(()) => output.flush()?,
            Err(error) if error.kind() == io::ErrorKind::BrokenPipe => return Ok(()),
            Err(error) => return Err(error.into()),
        }
    }
}

fn query_key(
    catalog_filter: Option<&str>,
    include_unpinned: bool,
    session_limit: usize,
    agent_filter: Option<MonitorAgent>,
    sort: MonitorSort,
) -> String {
    let input = format!(
        "v{PROTOCOL_VERSION}|{}|{include_unpinned}|{session_limit}|{agent_filter:?}|{sort:?}",
        catalog_filter.unwrap_or_default()
    );
    let digest = Sha256::digest(input.as_bytes());
    format!("monitor-{}", hex_prefix(&digest, 16))
}

fn hex_prefix(bytes: &[u8], count: usize) -> String {
    bytes
        .iter()
        .take(count)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn prepare_hub_dir() -> Result<PathBuf> {
    let dir = default_starling_home().join("monitor-hubs");
    std::fs::create_dir_all(&dir)?;
    let metadata = std::fs::symlink_metadata(&dir)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(anyhow!("monitor hub path is not a directory"));
    }
    if metadata.uid() != unsafe { libc::geteuid() } {
        return Err(anyhow!("monitor hub directory is owned by another user"));
    }
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
    Ok(dir)
}

fn try_acquire_owner_lock(path: &Path) -> Result<Option<OwnerLock>> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .mode(0o600)
        .open(path)?;
    let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    if result == 0 {
        Ok(Some(OwnerLock { _file: file }))
    } else {
        let error = io::Error::last_os_error();
        let code = error.raw_os_error();
        if code == Some(libc::EWOULDBLOCK) || code == Some(libc::EAGAIN) {
            Ok(None)
        } else {
            Err(error.into())
        }
    }
}

fn executable_stamp() -> Result<String> {
    let metadata = std::fs::metadata(std::env::current_exe()?)?;
    let modified = metadata
        .modified()?
        .duration_since(std::time::UNIX_EPOCH)?
        .as_nanos();
    Ok(format!(
        "{}:{}:{modified}:{}",
        metadata.dev(),
        metadata.ino(),
        metadata.len()
    ))
}

struct OwnerLock {
    _file: File,
}

struct SocketGuard(PathBuf);

impl Drop for SocketGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relay_hides_handshake_and_forwards_snapshots() {
        let hello = serde_json::to_string(&HubHello {
            r#type: "hello".into(),
            protocol: PROTOCOL_VERSION,
            build_id: "test".into(),
            pid: 1,
        })
        .unwrap();
        let input = format!("{hello}\n{{\"active\":1}}\n");
        let mut output = Vec::new();

        relay_to(io::Cursor::new(input), &mut output).unwrap();

        assert_eq!(String::from_utf8(output).unwrap(), "{\"active\":1}\n");
    }

    #[test]
    fn query_key_changes_with_query() {
        let activity = query_key(None, true, 20, None, MonitorSort::Activity);
        let cpu = query_key(None, true, 20, None, MonitorSort::Cpu);
        assert_ne!(activity, cpu);
        assert_eq!(
            activity,
            query_key(None, true, 20, None, MonitorSort::Activity)
        );
    }
}
