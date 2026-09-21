// Cross-process file locks, reentrant only within the owning thread.
// The shared file lease lives until the last nested guard drops, including
// out-of-order drops. Other threads must acquire their own OS lock.
// Guards are deliberately !Send: never move them across await/thread boundaries.

use fs2::FileExt;
use std::cell::RefCell;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::rc::{Rc, Weak};
use std::time::{Duration, Instant};

pub struct StoreLock {
    file: Rc<std::fs::File>,
    path: PathBuf,
}

thread_local! {
    static HELD: RefCell<HashMap<PathBuf, Weak<std::fs::File>>> = RefCell::new(HashMap::new());
}

fn name_ok(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Err carries "busy:<name>" — the CLI maps this to retryable exit code 3.
pub fn acquire(name: &str, wait: Duration) -> Result<StoreLock, String> {
    acquire_in(&crate::config::app_dir().join("locks"), name, wait)
}

fn acquire_in(dir: &Path, name: &str, wait: Duration) -> Result<StoreLock, String> {
    if !name_ok(name) {
        return Err(format!("invalid store name: {}", name));
    }
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let path = dir
        .canonicalize()
        .map_err(|e| e.to_string())?
        .join(format!("{}.lock", name));
    if let Some(file) = HELD.with(|held| held.borrow().get(&path).and_then(Weak::upgrade)) {
        return Ok(StoreLock { file, path });
    }
    let file = std::fs::OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    let deadline = Instant::now() + wait;
    loop {
        match file.try_lock_exclusive() {
            Ok(()) => {
                let file = Rc::new(file);
                HELD.with(|held| held.borrow_mut().insert(path.clone(), Rc::downgrade(&file)));
                return Ok(StoreLock { file, path });
            }
            Err(_) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            Err(_) => return Err(format!("busy:{}", name)),
        }
    }
}

impl Drop for StoreLock {
    fn drop(&mut self) {
        if Rc::strong_count(&self.file) == 1 {
            HELD.with(|held| held.borrow_mut().remove(&self.path));
        }
        // Closing the final shared file handle releases the OS lock.
    }
}

/// Standard wait used by store writers: long enough to absorb a concurrent
/// desktop-side save, short enough that a CLI caller fails fast.
pub const WRITE_WAIT: Duration = Duration::from_millis(1500);

// ── busy-aware JSON value helper ────────────────────────────────────────────

/// True when an error string is a lock-busy report ("busy:<store>").
pub fn is_busy_error(error: &str) -> bool {
    error.starts_with("busy:")
}

/// Extract the store name from a busy error, for messages.
pub fn busy_store(error: &str) -> Option<&str> {
    error.strip_prefix("busy:")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sandbox() -> std::path::PathBuf {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        std::env::temp_dir().join(format!(
            "atl-lock-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ))
    }

    #[test]
    fn reentrant_acquire_does_not_deadlock_or_double_lock() {
        let dir = sandbox();
        let outer = acquire_in(&dir, "modules", WRITE_WAIT).unwrap();
        let inner = acquire_in(&dir, "modules", Duration::ZERO).unwrap();
        // Dropping the outer guard first must not unlock the inner lease.
        drop(outer);
        let other = dir.clone();
        assert!(
            std::thread::spawn(move || acquire_in(&other, "modules", Duration::ZERO).is_err())
                .join()
                .unwrap()
        );
        drop(inner);
        let other = dir.clone();
        assert!(
            std::thread::spawn(move || acquire_in(&other, "modules", Duration::ZERO).is_ok())
                .join()
                .unwrap()
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn same_store_name_in_separate_directories_does_not_share_a_lease() {
        let a = sandbox();
        let b = sandbox();
        let one = acquire_in(&a, "modules", Duration::ZERO).unwrap();
        let two = acquire_in(&b, "modules", Duration::ZERO).unwrap();
        let other = b.clone();
        assert!(
            std::thread::spawn(move || acquire_in(&other, "modules", Duration::ZERO).is_err())
                .join()
                .unwrap()
        );
        drop(one);
        drop(two);
        let _ = std::fs::remove_dir_all(a);
        let _ = std::fs::remove_dir_all(b);
    }

    #[test]
    fn other_thread_cannot_enter_a_held_store() {
        let dir = sandbox();
        let outer = acquire_in(&dir, "thread-probe", Duration::ZERO).unwrap();
        let other = dir.clone();
        let blocked =
            std::thread::spawn(move || acquire_in(&other, "thread-probe", Duration::ZERO).is_err())
                .join()
                .unwrap();
        drop(outer);
        let _ = std::fs::remove_dir_all(dir);
        assert!(
            blocked,
            "another thread must not be mistaken for a nested call"
        );
    }

    #[test]
    fn invalid_names_are_rejected() {
        assert!(acquire("../evil", Duration::ZERO).is_err());
        assert!(acquire("", Duration::ZERO).is_err());
    }

    #[test]
    fn busy_helpers() {
        assert!(is_busy_error("busy:modules"));
        assert!(!is_busy_error("backend_unreachable:busy:"));
        assert_eq!(busy_store("busy:sharing-borrow"), Some("sharing-borrow"));
    }
}
