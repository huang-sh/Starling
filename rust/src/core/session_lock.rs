//! Cross-process locks for sessions that do not provide their own writer lock.

use std::fs::{File, OpenOptions};
use std::io::{self, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};

use anyhow::{anyhow, Context, Result};
use sha2::{Digest, Sha256};

use crate::core::discovery::session_scope_key;

/// An OS-backed exclusive lock for one cwd-scoped Pi session. Keeping this
/// value alive keeps the lock held; the operating system releases it even if
/// Starling exits through `process::exit` or is killed by a signal.
pub struct PiSessionLock {
    _file: File,
    #[cfg(not(any(unix, windows)))]
    path: PathBuf,
}

impl PiSessionLock {
    /// Toggle inheritance only around the managed Pi spawn. This lets the Pi
    /// writer retain the lock if its Starling wrapper dies without leaking
    /// unrelated session locks into children spawned by other threads.
    pub fn set_child_inheritable(&self, inheritable: bool) -> Result<()> {
        set_lock_inheritable(&self._file, inheritable).context(if inheritable {
            "make Pi session lock inheritable for child"
        } else {
            "restore close-on-exec for Pi session lock"
        })
    }
}

pub fn acquire_pi_session_lock(session_id: &str, project_path: &str) -> Result<PiSessionLock> {
    acquire_pi_session_lock_in(&shared_session_lock_dir()?, session_id, project_path)
}

/// The lock namespace must not follow STARLING_HOME: that variable is a
/// supported per-process metadata override, while Pi transcripts can still be
/// shared by those processes. Use one private, stable directory per OS user.
fn shared_session_lock_dir() -> Result<PathBuf> {
    #[cfg(unix)]
    {
        let uid = unsafe { libc::geteuid() };
        let runtime_dir = PathBuf::from(format!("/run/user/{uid}"));
        if let Ok(metadata) = std::fs::symlink_metadata(&runtime_dir) {
            use std::os::unix::fs::MetadataExt;
            if metadata.is_dir()
                && !metadata.file_type().is_symlink()
                && metadata.uid() == uid
                && metadata.mode() & 0o077 == 0
            {
                return Ok(runtime_dir.join("starling").join("pi-session-locks"));
            }
        }
        let home = unix_account_home(uid)
            .ok_or_else(|| anyhow!("cannot resolve a secure account home for Pi session locks"))?;
        return Ok(home
            .join(".cache")
            .join("starling")
            .join("pi-session-locks"));
    }
    #[cfg(windows)]
    {
        dirs::data_local_dir()
            .map(|dir| dir.join("Starling").join("pi-session-locks"))
            .ok_or_else(|| anyhow!("cannot resolve Windows LocalAppData for Pi session locks"))
    }
    #[cfg(not(any(unix, windows)))]
    {
        Err(anyhow!(
            "Pi session locking is unsupported on this operating system"
        ))
    }
}

#[cfg(unix)]
fn unix_account_home(uid: libc::uid_t) -> Option<PathBuf> {
    use std::ffi::CStr;

    let mut passwd = unsafe { std::mem::zeroed::<libc::passwd>() };
    let mut result = std::ptr::null_mut();
    let suggested = unsafe { libc::sysconf(libc::_SC_GETPW_R_SIZE_MAX) };
    let capacity = if suggested > 0 {
        suggested as usize
    } else {
        16 * 1024
    };
    let mut buffer = vec![0_u8; capacity.max(1024)];
    let status = unsafe {
        libc::getpwuid_r(
            uid,
            &mut passwd,
            buffer.as_mut_ptr().cast(),
            buffer.len(),
            &mut result,
        )
    };
    if status != 0 || result.is_null() || passwd.pw_dir.is_null() {
        return None;
    }
    let home = unsafe { CStr::from_ptr(passwd.pw_dir) }
        .to_string_lossy()
        .into_owned();
    (!home.is_empty()).then(|| PathBuf::from(home))
}

fn acquire_pi_session_lock_in(
    lock_dir: &Path,
    session_id: &str,
    project_path: &str,
) -> Result<PiSessionLock> {
    let session_id = session_id.trim();
    if session_id.is_empty() {
        return Err(anyhow!("cannot lock an empty Pi session ID"));
    }

    create_private_lock_dir(lock_dir)?;
    let project_path = normalize_project_path(project_path);
    let identity = session_scope_key("pi", session_id, &project_path);
    let digest = Sha256::digest(identity.as_bytes());
    let digest = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let path = lock_dir.join(format!("pi-{}.lock", &digest[..32]));

    let mut file = match try_open_locked(&path) {
        Ok(file) => file,
        Err(TryLockError::Contended) => {
            return Err(anyhow!(
                "Pi session '{session_id}' is already open in another Starling-managed process"
            ));
        }
        Err(TryLockError::Io(error)) => {
            return Err(error)
                .with_context(|| format!("acquire Pi session lock {}", path.display()));
        }
    };

    // Diagnostic content only; exclusivity comes from the open file handle.
    file.set_len(0)?;
    file.seek(SeekFrom::Start(0))?;
    writeln!(file, "pid={}", std::process::id())?;
    writeln!(file, "session_id={session_id}")?;
    writeln!(file, "project_path={project_path}")?;
    file.flush()?;

    Ok(PiSessionLock {
        _file: file,
        #[cfg(not(any(unix, windows)))]
        path,
    })
}

enum TryLockError {
    Contended,
    Io(io::Error),
}

#[cfg(unix)]
fn try_open_locked(path: &Path) -> std::result::Result<File, TryLockError> {
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::OpenOptionsExt;

    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .mode(0o600)
        .open(path)
        .map_err(TryLockError::Io)?;
    let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    if result == 0 {
        return Ok(file);
    }
    let error = io::Error::last_os_error();
    let code = error.raw_os_error();
    if code == Some(libc::EWOULDBLOCK) || code == Some(libc::EAGAIN) {
        Err(TryLockError::Contended)
    } else {
        Err(TryLockError::Io(error))
    }
}

#[cfg(windows)]
fn try_open_locked(path: &Path) -> std::result::Result<File, TryLockError> {
    use std::os::windows::fs::OpenOptionsExt;

    OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        // A zero sharing mode makes the file handle itself the lock. Windows
        // releases it automatically on normal exit, signal, or process death.
        .share_mode(0)
        .open(path)
        .map_err(|error| match error.raw_os_error() {
            // ERROR_SHARING_VIOLATION / ERROR_LOCK_VIOLATION
            Some(32 | 33) => TryLockError::Contended,
            _ => TryLockError::Io(error),
        })
}

#[cfg(unix)]
fn set_lock_inheritable(file: &File, inheritable: bool) -> io::Result<()> {
    use std::os::fd::AsRawFd;

    let flags = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETFD) };
    if flags < 0 {
        return Err(io::Error::last_os_error());
    }
    let next = if inheritable {
        flags & !libc::FD_CLOEXEC
    } else {
        flags | libc::FD_CLOEXEC
    };
    if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_SETFD, next) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(windows)]
fn set_lock_inheritable(file: &File, inheritable: bool) -> io::Result<()> {
    use std::os::windows::io::AsRawHandle;

    type Handle = *mut std::ffi::c_void;
    extern "system" {
        fn SetHandleInformation(object: Handle, mask: u32, flags: u32) -> i32;
    }
    const HANDLE_FLAG_INHERIT: u32 = 0x0000_0001;
    let flags = if inheritable { HANDLE_FLAG_INHERIT } else { 0 };
    let changed =
        unsafe { SetHandleInformation(file.as_raw_handle() as Handle, HANDLE_FLAG_INHERIT, flags) };
    if changed == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(not(any(unix, windows)))]
fn set_lock_inheritable(_file: &File, _inheritable: bool) -> io::Result<()> {
    Ok(())
}

#[cfg(not(any(unix, windows)))]
fn try_open_locked(path: &Path) -> std::result::Result<File, TryLockError> {
    OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| {
            if error.kind() == io::ErrorKind::AlreadyExists {
                TryLockError::Contended
            } else {
                TryLockError::Io(error)
            }
        })
}

#[cfg(not(any(unix, windows)))]
impl Drop for PiSessionLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

fn normalize_project_path(path: &str) -> String {
    let raw = Path::new(path);
    let absolute = if raw.is_absolute() {
        raw.to_path_buf()
    } else {
        std::env::current_dir()
            .map(|cwd| cwd.join(raw))
            .unwrap_or_else(|_| raw.to_path_buf())
    };
    if let Ok(canonical) = std::fs::canonicalize(&absolute) {
        return canonical.to_string_lossy().to_string();
    }

    let mut normalized = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    normalized.to_string_lossy().to_string()
}

fn create_private_lock_dir(lock_dir: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};

        let mut builder = std::fs::DirBuilder::new();
        builder.recursive(true).mode(0o700);
        builder
            .create(lock_dir)
            .with_context(|| format!("create Pi session lock directory {}", lock_dir.display()))?;
        let metadata = std::fs::symlink_metadata(lock_dir)?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(anyhow!(
                "Pi session lock path is not a private directory: {}",
                lock_dir.display()
            ));
        }
        if metadata.uid() != unsafe { libc::geteuid() } {
            return Err(anyhow!(
                "Pi session lock directory is owned by another user: {}",
                lock_dir.display()
            ));
        }
        std::fs::set_permissions(lock_dir, std::fs::Permissions::from_mode(0o700))?;
        return Ok(());
    }
    #[cfg(not(unix))]
    {
        std::fs::create_dir_all(lock_dir)
            .with_context(|| format!("create Pi session lock directory {}", lock_dir.display()))
    }
}

#[cfg(test)]
mod tests {
    use super::{acquire_pi_session_lock_in, shared_session_lock_dir};

    static LOCK_TEST_MUTEX: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn serialize_lock_test() -> std::sync::MutexGuard<'static, ()> {
        LOCK_TEST_MUTEX
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn temp_lock_dir(label: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "starling-pi-lock-{label}-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ))
    }

    #[test]
    fn rejects_a_second_writer_until_the_first_lock_is_released() {
        let _serial = serialize_lock_test();
        let dir = temp_lock_dir("exclusive");
        let first = acquire_pi_session_lock_in(&dir, "SharedCaseID", "/work/a/./project")
            .expect("first lock");
        let error = acquire_pi_session_lock_in(&dir, "SharedCaseID", "/work/a/project")
            .err()
            .expect("second lock must fail");
        assert!(error.to_string().contains("already open"));

        drop(first);
        acquire_pi_session_lock_in(&dir, "SharedCaseID", "/work/a/project")
            .expect("lock should be reusable after release");
    }

    #[test]
    fn keeps_pi_id_case_and_project_in_the_lock_scope() {
        let _serial = serialize_lock_test();
        let dir = temp_lock_dir("scope");
        let _first = acquire_pi_session_lock_in(&dir, "CaseID", "/work/a").expect("first");
        let _different_case =
            acquire_pi_session_lock_in(&dir, "caseid", "/work/a").expect("case differs");
        let _different_project =
            acquire_pi_session_lock_in(&dir, "CaseID", "/work/b").expect("project differs");
    }

    #[test]
    fn shared_lock_namespace_does_not_depend_on_starling_home() {
        let _serial = serialize_lock_test();
        let expected = shared_session_lock_dir().expect("shared lock directory");
        assert!(!expected.to_string_lossy().contains("STARLING_HOME"));
        assert!(!expected.starts_with(std::env::temp_dir()));
    }

    #[cfg(unix)]
    #[test]
    fn inherited_lock_survives_wrapper_handle_drop_until_child_exits() {
        let _serial = serialize_lock_test();
        let dir = temp_lock_dir("inherit");
        let first = acquire_pi_session_lock_in(&dir, "InheritedID", "/work/a").expect("first");
        first.set_child_inheritable(true).expect("inherit lock");
        let mut child = std::process::Command::new("sh")
            .args(["-c", "sleep 0.4"])
            .spawn()
            .expect("spawn lock inheritor");
        first
            .set_child_inheritable(false)
            .expect("restore close-on-exec");
        drop(first);

        let error = acquire_pi_session_lock_in(&dir, "InheritedID", "/work/a")
            .err()
            .expect("child must retain inherited lock");
        assert!(error.to_string().contains("already open"));
        child.wait().expect("wait child");
        acquire_pi_session_lock_in(&dir, "InheritedID", "/work/a")
            .expect("child exit releases inherited lock");
    }
}
