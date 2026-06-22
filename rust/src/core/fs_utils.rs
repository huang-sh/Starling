//! Filesystem helpers — atomic JSON writes, JSON reads. Mirrors src/utils/fs.ts.

use std::fs::{self, Permissions};
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::de::DeserializeOwned;
use serde::Serialize;

/// Ensure the parent directory of `path` exists.
pub fn ensure_parent_dir(path: &Path) -> Result<()> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            fs::create_dir_all(parent)
                .with_context(|| format!("creating directory {}", parent.display()))?;
        }
    }
    Ok(())
}

/// Atomic JSON write: serialize, write to a temp file in the same directory,
/// chmod 0600, then rename. The TS implementation wraps the temp file in a
/// per-invocation `mkdtemp` directory inside `.starling-tmp/`; we use a single
/// hidden sibling tempfile since `tempfile` isn't in our dependency set.
pub fn atomic_write_json<T: Serialize>(path: &Path, data: &T) -> Result<()> {
    ensure_parent_dir(path)?;

    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let tmp_dir = parent.join(".starling-tmp");
    if !tmp_dir.exists() {
        let _ = fs::create_dir_all(&tmp_dir);
    }

    let pid = std::process::id();
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp_path: PathBuf = tmp_dir.join(format!("starling-{pid}-{ts}.json"));

    let serialized = serde_json::to_string_pretty(data)
        .with_context(|| format!("serializing JSON for {}", path.display()))?;

    let mut file = fs::File::create(&tmp_path)
        .with_context(|| format!("creating temp file {}", tmp_path.display()))?;
    file.write_all(serialized.as_bytes())
        .with_context(|| format!("writing temp file {}", tmp_path.display()))?;
    // Append a trailing newline to match Node's JSON.stringify output where
    // some consumers (git diffs) prefer it. The TS impl does not add a
    // newline, so neither do we — but fsync for durability.
    file.sync_all().ok();
    drop(file);

    // chmod 0600 to match the TS implementation
    if let Err(e) = fs::set_permissions(&tmp_path, Permissions::from_mode(0o600)) {
        // Best-effort; not worth failing the write
        let _ = e;
    }

    if let Err(e) = fs::rename(&tmp_path, path) {
        // Cleanup the temp file on rename failure
        let _ = fs::remove_file(&tmp_path);
        return Err(e)
            .with_context(|| format!("renaming {} -> {}", tmp_path.display(), path.display()));
    }
    Ok(())
}

/// Read and parse JSON, returning `None` if the file doesn't exist (mirrors
/// the TS `readJSON` semantics).
pub fn read_json<T: DeserializeOwned>(path: &Path) -> Option<T> {
    if !path.exists() {
        return None;
    }
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Serialize, Deserialize, PartialEq, Debug)]
    struct Data {
        name: String,
        value: i32,
    }

    #[test]
    fn atomic_write_then_read_roundtrip() {
        let dir = tempdir();
        let path = dir.join("store.json");
        let data = Data {
            name: "alpha".into(),
            value: 42,
        };
        atomic_write_json(&path, &data).expect("write");
        let loaded: Data = read_json(&path).expect("should exist");
        assert_eq!(loaded, data);
    }

    #[test]
    fn read_json_missing_file_returns_none() {
        let path = Path::new("/this/does/not/exist/anywhere/at/all.json");
        let res: Option<Data> = read_json(&path);
        assert!(res.is_none());
    }

    fn tempdir() -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!(
            "starling-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        fs::create_dir_all(&p).unwrap();
        p
    }
}

#[cfg(test)]
pub mod test_support {
    //! Shared test helpers — single global mutex serializing any test that
    //! touches the `STARLING_CONFIG` (or other Starling-related) env vars,
    //! which are process-global.

    use std::sync::Mutex;
    use std::sync::OnceLock;

    static STORE_TEST_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

    pub fn env_lock() -> &'static Mutex<()> {
        STORE_TEST_LOCK.get_or_init(|| Mutex::new(()))
    }

    /// Run a closure with exclusive access to Starling env vars. Cleans up the
    /// temp store file on exit.
    pub fn with_temp_store<F: FnOnce()>(f: F) {
        let _guard = env_lock().lock().unwrap_or_else(|p| p.into_inner());
        let mut tmp = std::env::temp_dir();
        tmp.push(format!(
            "starling-test-{}-{}.json",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::env::set_var("STARLING_CONFIG", &tmp);
        let _ = std::fs::remove_file(&tmp);
        // Run the test; if it panics, ignore so cleanup can still happen.
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f));
        let _ = std::fs::remove_file(&tmp);
        std::env::remove_var("STARLING_CONFIG");
        // Re-panic if the test panicked, so cargo records the failure.
        if let Err(payload) = result {
            std::panic::resume_unwind(payload);
        }
    }
}
