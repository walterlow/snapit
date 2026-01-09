//! Fragment manifest for crash recovery.
//!
//! Tracks completed and in-progress segments to enable recovery
//! if recording is interrupted (crash, power loss, etc.).

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Current manifest format version.
pub const CURRENT_MANIFEST_VERSION: u32 = 1;

/// Manifest describing all recording fragments.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FragmentManifest {
    /// Manifest format version.
    pub version: u32,
    /// List of recorded fragments.
    pub fragments: Vec<FragmentInfo>,
    /// Total recording duration (None if recording incomplete).
    pub total_duration: Option<Duration>,
    /// Whether the recording completed normally.
    pub is_complete: bool,
}

/// Information about a single fragment.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FragmentInfo {
    /// Path to the fragment file (relative to manifest).
    pub path: PathBuf,
    /// Fragment index (0-based).
    pub index: u32,
    /// Duration of this fragment (None if incomplete).
    pub duration: Option<Duration>,
    /// Whether this fragment was completed (trailer written).
    pub is_complete: bool,
    /// File size in bytes (None if incomplete).
    pub file_size: Option<u64>,
}

impl FragmentManifest {
    /// Create a new empty manifest.
    pub fn new() -> Self {
        Self {
            version: CURRENT_MANIFEST_VERSION,
            fragments: Vec::new(),
            total_duration: None,
            is_complete: false,
        }
    }

    /// Add a completed fragment.
    pub fn add_completed_fragment(&mut self, path: PathBuf, index: u32, duration: Duration) {
        let file_size = std::fs::metadata(&path).ok().map(|m| m.len());

        self.fragments.push(FragmentInfo {
            path,
            index,
            duration: Some(duration),
            is_complete: true,
            file_size,
        });
    }

    /// Add an in-progress fragment (not yet complete).
    pub fn add_in_progress_fragment(&mut self, path: PathBuf, index: u32) {
        self.fragments.push(FragmentInfo {
            path,
            index,
            duration: None,
            is_complete: false,
            file_size: None,
        });
    }

    /// Mark recording as complete and calculate total duration.
    pub fn finalize(&mut self) {
        self.is_complete = true;
        let total: Duration = self.fragments.iter().filter_map(|f| f.duration).sum();
        self.total_duration = Some(total);
    }

    /// Get the total duration of completed fragments.
    pub fn completed_duration(&self) -> Duration {
        self.fragments
            .iter()
            .filter(|f| f.is_complete)
            .filter_map(|f| f.duration)
            .sum()
    }

    /// Get paths of all completed fragments.
    pub fn completed_fragment_paths(&self) -> Vec<&Path> {
        self.fragments
            .iter()
            .filter(|f| f.is_complete)
            .map(|f| f.path.as_path())
            .collect()
    }
}

impl Default for FragmentManifest {
    fn default() -> Self {
        Self::new()
    }
}

/// Atomically write JSON data to a file.
///
/// Uses a temp file + rename pattern for crash safety:
/// 1. Write to temp file
/// 2. Sync temp file
/// 3. Rename temp to target (atomic on most filesystems)
/// 4. Sync parent directory
pub fn atomic_write_json<T: Serialize>(path: &Path, data: &T) -> std::io::Result<()> {
    use std::io::Write;

    let temp_path = path.with_extension("json.tmp");

    // Write to temp file
    let json = serde_json::to_string_pretty(data)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;

    let mut file = std::fs::File::create(&temp_path)?;
    file.write_all(json.as_bytes())?;
    file.sync_all()?;
    drop(file);

    // Atomic rename
    std::fs::rename(&temp_path, path)?;

    // Sync parent directory for durability
    if let Some(parent) = path.parent() {
        if let Ok(dir) = std::fs::File::open(parent) {
            let _ = dir.sync_all();
        }
    }

    Ok(())
}

/// Read manifest from file.
pub fn read_manifest(path: &Path) -> std::io::Result<FragmentManifest> {
    let contents = std::fs::read_to_string(path)?;
    serde_json::from_str(&contents)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
}

/// Sync a file to disk (flush + fsync).
pub fn sync_file(path: &Path) -> std::io::Result<()> {
    let file = std::fs::File::open(path)?;
    file.sync_all()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_manifest_new() {
        let manifest = FragmentManifest::new();
        assert_eq!(manifest.version, CURRENT_MANIFEST_VERSION);
        assert!(manifest.fragments.is_empty());
        assert!(!manifest.is_complete);
    }

    #[test]
    fn test_manifest_add_fragments() {
        let mut manifest = FragmentManifest::new();

        manifest.add_completed_fragment(
            PathBuf::from("fragment_000.mp4"),
            0,
            Duration::from_secs(3),
        );
        manifest.add_completed_fragment(
            PathBuf::from("fragment_001.mp4"),
            1,
            Duration::from_secs(3),
        );

        assert_eq!(manifest.fragments.len(), 2);
        assert_eq!(manifest.completed_duration(), Duration::from_secs(6));
    }

    #[test]
    fn test_manifest_finalize() {
        let mut manifest = FragmentManifest::new();
        manifest.add_completed_fragment(
            PathBuf::from("fragment_000.mp4"),
            0,
            Duration::from_secs(3),
        );

        manifest.finalize();

        assert!(manifest.is_complete);
        assert_eq!(manifest.total_duration, Some(Duration::from_secs(3)));
    }
}
