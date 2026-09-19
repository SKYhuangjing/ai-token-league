// Cross-process advisory locks for the local JSON stores (cli-dev-standard
// §5: write operations hold a lock; a held lock surfaces as "busy" → the CLI
// answers with exit code 3, which callers treat as retry-later, not failure).
//
// Design:
// - one lock file per store under <app_dir>/locks/<name>.lock, held with
//   flock (fs2). The kernel releases it when the owning process dies, so a
//   crashed writer never leaves a stale lock behind.
// - process-wide re-entrancy with a refcount: store write functions take the
//   lock internally, and command-level cycles (read → merge → write) may
//   already hold it. flock conflicts even within one process when opened on
//   separate file handles, so the inner acquire must SKIP the file lock when
//   this process already holds the store — in-process serialization comes
//   from the held-map mutex itself.
// - guards must not be held across await points: a tokio task may resume on
//   another thread, but that is safe here because re-entrancy is
//   process-global, not thread-local. The only discipline required is that
//   guards are dropped on the normal path (they are — they are scope-local).

use fs2::FileExt;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub struct StoreLock {
    /// Some(file) owns the flock; None is a re-entrant reference counted on
    /// the outer guard.
    file: Option<std::fs::File>,
    name: String,
}

static HELD: Mutex<Option<HashMap<String, u64>>> = Mutex::new(None);

fn name_ok(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn note_held(name: &str, delta: i64) {
    let mut guard = HELD.lock().unwrap_or_else(|e| e.into_inner());
    let map = guard.get_or_insert_with(HashMap::new);
    let next = (*map.get(name).unwrap_or(&0) as i64 + delta).max(0) as u64;
    if next == 0 {
        map.remove(name);
    } else {
        map.insert(name.to_string(), next);
    }
}

/// Acquire a store lock, retrying until `wait` elapses (concurrent writers
/// finish in milliseconds; the retry keeps brief overlaps from failing).
/// Err carries "busy:<name>" — map it to exit code 3 at the CLI boundary.
pub fn acquire(name: &str, wait: Duration) -> Result<StoreLock, String> {
    if !name_ok(name) {
        return Err(format!("invalid store name: {}", name));
    }
    // re-entrant: this process already holds the store. The refcount bump
    // happens under the SAME lock guard — note_held() would re-lock the
    // (non-reentrant) mutex and self-deadlock.
    {
        let mut guard = HELD.lock().unwrap_or_else(|e| e.into_inner());
        let map = guard.get_or_insert_with(HashMap::new);
        if let Some(count) = map.get_mut(name) {
            *count += 1;
            return Ok(StoreLock { file: None, name: name.to_string() });
        }
    }
    let dir = crate::config::app_dir().join("locks");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = std::fs::OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .open(dir.join(format!("{}.lock", name)))
        .map_err(|e| e.to_string())?;
    let deadline = Instant::now() + wait;
    loop {
        match file.try_lock_exclusive() {
            Ok(()) => {
                note_held(name, 1);
                return Ok(StoreLock { file: Some(file), name: name.to_string() });
            }
            Err(_) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            Err(_) => return Err(format!("busy:{}", name)),
        }
    }
}

impl Drop for StoreLock {
    fn drop(&mut self) {
        note_held(&self.name, -1);
        // explicit unlock + handle drop release the flock (and the kernel
        // does it even on a crash, which is the whole reason flock was chosen)
        if let Some(file) = self.file.take() {
            let _ = file.unlock();
        }
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
        let dir = std::env::temp_dir().join(format!("atl-store-lock-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn reentrant_acquire_does_not_deadlock_or_double_lock() {
        let dir = sandbox();
        let previous = std::env::var("ATL_HOME").ok();
        std::env::set_var("ATL_HOME", &dir);
        // outer guard owns the flock
        let outer = acquire("modules", WRITE_WAIT).expect("outer lock");
        // inner acquire on the same store must succeed immediately (this is
        // the set_module_state-inside-a-command-cycle case)
        let inner = acquire("modules", WRITE_WAIT).expect("re-entrant lock");
        drop(inner);
        assert!(acquire("modules", Duration::ZERO).is_ok(), "still held by outer");
        drop(outer);
        // released: a fresh acquire takes the file lock again
        assert!(acquire("modules", Duration::ZERO).is_ok());
        match previous {
            Some(value) => std::env::set_var("ATL_HOME", value),
            None => std::env::remove_var("ATL_HOME"),
        }
        let _ = std::fs::remove_dir_all(&dir);
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
