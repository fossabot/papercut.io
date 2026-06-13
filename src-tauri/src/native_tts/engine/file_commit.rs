//! Same-directory staged file commits used by native audiobook storage.
//!
//! Writers create and validate a complete temporary file first, then call
//! [`commit_staged_file`] to replace the destination in one filesystem rename.
//! Keeping both paths in the same directory avoids cross-filesystem rename
//! failures and prevents readers from observing partially written contents.

use std::fs;
use std::path::Path;

/// Replace `destination` with a completed same-directory `staged_path`.
///
/// `std::fs::rename` replaces an existing file on supported filesystems. We do
/// not delete the destination first: if replacement fails, the previous valid
/// file remains available. The staged file is removed after a failed commit.
pub(super) fn commit_staged_file(
    staged_path: &Path,
    destination: &Path,
    label: &str,
) -> Result<(), String> {
    fs::rename(staged_path, destination).map_err(|err| {
        let _ = fs::remove_file(staged_path);
        format!("Failed to commit {label} {}: {err}", destination.display())
    })
}

#[cfg(test)]
mod tests {
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;

    #[test]
    fn replaces_existing_destination_without_predeleting_it() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("papercut-file-commit-{nonce}"));
        fs::create_dir_all(&dir).expect("create test dir");
        let destination = dir.join("manifest.json");
        let staged = dir.join("manifest.tmp");
        fs::write(&destination, b"old").expect("write destination");
        fs::write(&staged, b"new").expect("write staged");

        commit_staged_file(&staged, &destination, "test file").expect("commit staged file");

        assert_eq!(fs::read(&destination).expect("read destination"), b"new");
        assert!(!staged.exists());
        let _ = fs::remove_dir_all(dir);
    }
}
