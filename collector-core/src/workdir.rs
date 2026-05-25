use crate::crypto::sha256_hex;
use std::path::{Path, PathBuf};

/// Normalize a path for hashing: resolve, forward slashes, trim trailing slash, lowercase.
pub fn normalize_path_for_hash(input_path: &str) -> String {
    let resolved = Path::new(input_path)
        .canonicalize()
        .unwrap_or_else(|_| PathBuf::from(input_path));
    let s = resolved.to_string_lossy();
    let s = s.replace('\\', "/");
    let s = s.trim_end_matches('/');
    s.to_lowercase()
}

/// Detect display name from a path (last component).
pub fn detect_display_name(input_path: &str) -> String {
    let resolved = Path::new(input_path)
        .canonicalize()
        .unwrap_or_else(|_| PathBuf::from(input_path));
    resolved
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "root".to_string())
}

pub struct WorkdirResult {
    pub local_path: String,
    pub workdir_hash: String,
    pub detected_name: String,
    pub display_name: String,
}

/// Compute workdir hash and display name from a candidate path.
pub fn workdir_from_candidate(candidate: &str, participant_id: &str) -> WorkdirResult {
    if candidate.starts_with("virtual:") {
        let display_name = candidate
            .rsplit(':')
            .next()
            .unwrap_or("virtual")
            .to_string();
        return WorkdirResult {
            local_path: String::new(),
            workdir_hash: sha256_hex(&format!("{}:{}", candidate, participant_id)),
            detected_name: display_name.clone(),
            display_name,
        };
    }

    let resolved = if candidate.is_empty() {
        std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
    } else {
        Path::new(candidate)
            .canonicalize()
            .unwrap_or_else(|_| PathBuf::from(candidate))
    };
    let resolved_str = resolved.to_string_lossy().to_string();
    let normalized = normalize_path_for_hash(&resolved_str);
    let name = detect_display_name(&resolved_str);

    WorkdirResult {
        local_path: resolved_str,
        workdir_hash: sha256_hex(&format!("{}:{}", normalized, participant_id)),
        detected_name: name.clone(),
        display_name: name,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_virtual_path() {
        let result = workdir_from_candidate(
            "virtual:cursor-dashboard:Cursor · user@example.com",
            "p_abc123",
        );
        assert!(result.local_path.is_empty());
        assert_eq!(result.display_name, "Cursor · user@example.com");
        assert!(result
            .workdir_hash
            .starts_with(|c: char| c.is_ascii_hexdigit()));
    }

    #[test]
    fn test_virtual_path_segments() {
        let result = workdir_from_candidate("virtual:a:b:c", "p_test");
        assert_eq!(result.display_name, "c");
    }

    #[test]
    fn test_virtual_path_hash_deterministic() {
        let r1 = workdir_from_candidate("virtual:cursor:user@x.com", "p_1");
        let r2 = workdir_from_candidate("virtual:cursor:user@x.com", "p_1");
        assert_eq!(r1.workdir_hash, r2.workdir_hash);
    }

    #[test]
    fn test_virtual_path_different_participants() {
        let r1 = workdir_from_candidate("virtual:cursor:user@x.com", "p_1");
        let r2 = workdir_from_candidate("virtual:cursor:user@x.com", "p_2");
        assert_ne!(r1.workdir_hash, r2.workdir_hash);
    }

    #[test]
    fn test_normalize_path_for_hash_lowercase() {
        // Use a real temp path that exists so canonicalize works
        let dir = std::env::temp_dir().join("AtlWorkdirTest");
        let _ = std::fs::create_dir_all(&dir);
        let normalized = normalize_path_for_hash(&dir.to_string_lossy());
        assert_eq!(normalized, normalized.to_lowercase());
        assert!(!normalized.ends_with('/'));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_normalize_path_for_hash_forward_slashes() {
        let dir = std::env::temp_dir().join("AtlWorkdirSlashTest");
        let _ = std::fs::create_dir_all(&dir);
        let normalized = normalize_path_for_hash(&dir.to_string_lossy());
        assert!(
            !normalized.contains('\\'),
            "backslashes should be converted"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_detect_display_name_extracts_last_component() {
        let dir = std::env::temp_dir().join("my-test-project-xyz");
        let _ = std::fs::create_dir_all(&dir);
        let name = detect_display_name(&dir.to_string_lossy());
        assert_eq!(name, "my-test-project-xyz");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_workdir_from_candidate_real_path() {
        let dir = std::env::temp_dir().join("atl-workdir-real-test");
        let _ = std::fs::create_dir_all(&dir);
        let result = workdir_from_candidate(&dir.to_string_lossy(), "p_test");
        assert!(!result.local_path.is_empty());
        assert_eq!(result.display_name, "atl-workdir-real-test");
        assert_eq!(result.workdir_hash.len(), 64);
        assert!(!result.detected_name.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_workdir_hash_consistency() {
        let dir = std::env::temp_dir().join("atl-hash-consistency");
        let _ = std::fs::create_dir_all(&dir);
        let r1 = workdir_from_candidate(&dir.to_string_lossy(), "p_x");
        let r2 = workdir_from_candidate(&dir.to_string_lossy(), "p_x");
        assert_eq!(
            r1.workdir_hash, r2.workdir_hash,
            "same path+participant must produce same hash"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
