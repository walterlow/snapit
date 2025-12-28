//! Central error types for SnapIt.
//!
//! This module provides typed errors for better error handling across the codebase.
//! All errors implement `Serialize` for Tauri IPC compatibility.

use serde::Serialize;
use thiserror::Error;

/// Main error type for SnapIt operations.
#[derive(Error, Debug)]
pub enum SnapItError {
    /// Screen capture failed
    #[error("Capture failed: {0}")]
    CaptureError(String),

    /// Storage operation failed
    #[error("Storage error: {0}")]
    StorageError(#[from] std::io::Error),

    /// Image encoding/decoding failed
    #[error("Encoding error: {0}")]
    EncodingError(String),

    /// FFmpeg binary not found
    #[error("FFmpeg not found. Please ensure FFmpeg is installed or bundled.")]
    FfmpegNotFound,

    /// Video/GIF recording failed
    #[error("Recording error: {0}")]
    RecordingError(String),

    /// Monitor not found by index
    #[error("Monitor not found at index {index}")]
    MonitorNotFound { index: usize },

    /// Window not found by ID
    #[error("Window not found with ID {id}")]
    WindowNotFound { id: u32 },

    /// Window management error
    #[error("Window error: {0}")]
    WindowError(String),

    /// JSON serialization/deserialization failed
    #[error("JSON error: {0}")]
    JsonError(#[from] serde_json::Error),

    /// Image processing error
    #[error("Image error: {0}")]
    ImageError(String),

    /// Lock poisoned (mutex/rwlock)
    #[error("Lock poisoned: {context}")]
    LockPoisoned { context: String },

    /// Generic error with message
    #[error("{0}")]
    Other(String),
}

/// Implement Serialize for Tauri IPC compatibility.
/// Tauri requires errors to be serializable to send to the frontend.
impl Serialize for SnapItError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        // Serialize as the error message string
        serializer.serialize_str(&self.to_string())
    }
}

impl From<image::ImageError> for SnapItError {
    fn from(err: image::ImageError) -> Self {
        SnapItError::ImageError(err.to_string())
    }
}

impl From<String> for SnapItError {
    fn from(msg: String) -> Self {
        SnapItError::Other(msg)
    }
}

impl From<&str> for SnapItError {
    fn from(msg: &str) -> Self {
        SnapItError::Other(msg.to_string())
    }
}

/// Helper trait for converting mutex lock errors to SnapItError.
pub trait LockResultExt<T> {
    /// Convert a poisoned lock error to SnapItError with context.
    fn map_lock_err(self, context: &str) -> Result<T, SnapItError>;
}

impl<T> LockResultExt<T> for Result<T, std::sync::PoisonError<T>> {
    fn map_lock_err(self, context: &str) -> Result<T, SnapItError> {
        self.map_err(|_| SnapItError::LockPoisoned {
            context: context.to_string(),
        })
    }
}

/// Type alias for Results using SnapItError.
pub type SnapItResult<T> = Result<T, SnapItError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_error_display() {
        let err = SnapItError::CaptureError("test".to_string());
        assert_eq!(err.to_string(), "Capture failed: test");
    }

    #[test]
    fn test_error_serialization() {
        let err = SnapItError::FfmpegNotFound;
        let json = serde_json::to_string(&err).unwrap();
        assert!(json.contains("FFmpeg not found"));
    }

    #[test]
    fn test_from_io_error() {
        let io_err = std::io::Error::new(std::io::ErrorKind::NotFound, "file not found");
        let err: SnapItError = io_err.into();
        assert!(matches!(err, SnapItError::StorageError(_)));
    }

    #[test]
    fn test_from_string() {
        let err: SnapItError = "test error".into();
        assert!(matches!(err, SnapItError::Other(_)));
    }

    #[test]
    fn test_lock_poisoning_recovery() {
        use std::sync::Mutex;

        let mutex = Mutex::new(42);

        // Poison the mutex by panicking while holding the lock
        let _ = std::panic::catch_unwind(|| {
            let _guard = mutex.lock().unwrap();
            panic!("intentional panic to poison mutex");
        });

        // Verify the mutex is poisoned
        assert!(mutex.lock().is_err());

        // Verify LockResultExt properly converts the error
        let result = mutex.lock().map_lock_err("test_mutex");
        assert!(matches!(result, Err(SnapItError::LockPoisoned { .. })));

        // Verify the context is preserved
        if let Err(SnapItError::LockPoisoned { context }) = result {
            assert_eq!(context, "test_mutex");
        }
    }
}
