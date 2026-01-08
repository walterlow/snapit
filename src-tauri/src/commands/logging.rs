//! Unified logging system for SnapIt.
//!
//! Provides persistent file logging for both frontend and backend,
//! with automatic log rotation and cleanup.

use chrono::Local;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{command, AppHandle, Manager};

/// Maximum log file size before rotation (5MB)
const MAX_LOG_SIZE: u64 = 5 * 1024 * 1024;

/// Maximum number of log files to keep
const MAX_LOG_FILES: usize = 5;

lazy_static::lazy_static! {
    /// Global log file handle
    static ref LOG_FILE: Mutex<Option<File>> = Mutex::new(None);
    /// Log directory path
    static ref LOG_DIR: Mutex<Option<PathBuf>> = Mutex::new(None);
}

/// Log levels matching frontend
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogLevel {
    Debug,
    Info,
    Warn,
    Error,
}

impl std::fmt::Display for LogLevel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LogLevel::Debug => write!(f, "DEBUG"),
            LogLevel::Info => write!(f, "INFO"),
            LogLevel::Warn => write!(f, "WARN"),
            LogLevel::Error => write!(f, "ERROR"),
        }
    }
}

/// Initialize the logging system
pub fn init_logging(app: &AppHandle) -> Result<(), String> {
    let log_dir = app
        .path()
        .app_log_dir()
        .map_err(|e| format!("Failed to get log directory: {}", e))?;

    // Create log directory if it doesn't exist
    fs::create_dir_all(&log_dir).map_err(|e| format!("Failed to create log directory: {}", e))?;

    // Store log directory for later use
    {
        let mut dir = LOG_DIR
            .lock()
            .map_err(|e| format!("Failed to acquire log directory lock: {}", e))?;
        *dir = Some(log_dir.clone());
    }

    // Open or create today's log file
    let log_file_path = get_current_log_path(&log_dir);
    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_file_path)
        .map_err(|e| format!("Failed to open log file: {}", e))?;

    {
        let mut log_file = LOG_FILE
            .lock()
            .map_err(|e| format!("Failed to acquire log file lock: {}", e))?;
        *log_file = Some(file);
    }

    // Log startup
    log_internal(LogLevel::Info, "SnapIt", "Logging system initialized");
    log_internal(
        LogLevel::Info,
        "SnapIt",
        &format!("Log directory: {:?}", log_dir),
    );

    // Cleanup old log files
    cleanup_old_logs(&log_dir);

    Ok(())
}

/// Get the path for the current log file (one per day)
fn get_current_log_path(log_dir: &PathBuf) -> PathBuf {
    let date = Local::now().format("%Y-%m-%d");
    log_dir.join(format!("snapit_{}.log", date))
}

/// Clean up old log files, keeping only the most recent MAX_LOG_FILES
fn cleanup_old_logs(log_dir: &PathBuf) {
    if let Ok(entries) = fs::read_dir(log_dir) {
        let mut log_files: Vec<_> = entries
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.path()
                    .extension()
                    .map(|ext| ext == "log")
                    .unwrap_or(false)
            })
            .collect();

        // Sort by modification time (newest first)
        log_files.sort_by(|a, b| {
            let a_time = a.metadata().and_then(|m| m.modified()).ok();
            let b_time = b.metadata().and_then(|m| m.modified()).ok();
            b_time.cmp(&a_time)
        });

        // Remove old files beyond MAX_LOG_FILES
        for file in log_files.into_iter().skip(MAX_LOG_FILES) {
            let _ = fs::remove_file(file.path());
        }
    }
}

/// Check if log rotation is needed and rotate if necessary
fn check_rotation() {
    // Use safe locking - if lock is poisoned, skip rotation rather than panic
    let log_dir = {
        let dir = match LOG_DIR.lock() {
            Ok(guard) => guard,
            Err(_) => return, // Mutex poisoned, skip rotation
        };
        match dir.as_ref() {
            Some(d) => d.clone(),
            None => return,
        }
    };

    let current_path = get_current_log_path(&log_dir);

    // Check file size
    if let Ok(metadata) = fs::metadata(&current_path) {
        if metadata.len() > MAX_LOG_SIZE {
            // Rotate: rename current file with timestamp
            let timestamp = Local::now().format("%Y-%m-%d_%H%M%S");
            let rotated_path = log_dir.join(format!("snapit_{}.log", timestamp));
            let _ = fs::rename(&current_path, &rotated_path);

            // Open new log file
            if let Ok(file) = OpenOptions::new()
                .create(true)
                .append(true)
                .open(&current_path)
            {
                // Safe locking - skip update if mutex is poisoned
                if let Ok(mut log_file) = LOG_FILE.lock() {
                    *log_file = Some(file);
                }
            }

            cleanup_old_logs(&log_dir);
        }
    }
}

/// Internal logging function
pub fn log_internal(level: LogLevel, source: &str, message: &str) {
    let timestamp = Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
    let log_line = format!("[{}] [{}] [{}] {}\n", timestamp, level, source, message);

    // Write to file
    if let Ok(mut log_file) = LOG_FILE.lock() {
        if let Some(ref mut file) = *log_file {
            let _ = file.write_all(log_line.as_bytes());
            let _ = file.flush();
        }
    }

    // Also print to console in debug builds
    #[cfg(debug_assertions)]
    {
        match level {
            LogLevel::Error => eprintln!("{}", log_line.trim()),
            _ => println!("{}", log_line.trim()),
        }
    }

    // Check if rotation is needed
    check_rotation();
}

/// Log from Rust code
#[macro_export]
macro_rules! app_log {
    ($level:expr, $source:expr, $($arg:tt)*) => {
        $crate::commands::logging::log_internal($level, $source, &format!($($arg)*))
    };
}

// ============================================================================
// Tauri Commands
// ============================================================================

/// Write a log message from the frontend
#[command]
pub fn write_log(level: String, source: String, message: String) {
    let log_level = match level.to_lowercase().as_str() {
        "debug" => LogLevel::Debug,
        "info" => LogLevel::Info,
        "warn" | "warning" => LogLevel::Warn,
        "error" => LogLevel::Error,
        _ => LogLevel::Info,
    };

    log_internal(log_level, &source, &message);
}

/// Write multiple log messages from the frontend (batch)
#[command]
pub fn write_logs(logs: Vec<(String, String, String)>) {
    for (level, source, message) in logs {
        write_log(level, source, message);
    }
}

/// Get the log directory path
#[command]
pub fn get_log_dir(app: AppHandle) -> Result<String, String> {
    let log_dir = app
        .path()
        .app_log_dir()
        .map_err(|e| format!("Failed to get log directory: {}", e))?;

    Ok(log_dir.to_string_lossy().to_string())
}

/// Open the log directory in file explorer
#[command]
pub async fn open_log_dir(app: AppHandle) -> Result<(), String> {
    let log_dir = app
        .path()
        .app_log_dir()
        .map_err(|e| format!("Failed to get log directory: {}", e))?;

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(log_dir)
            .spawn()
            .map_err(|e| format!("Failed to open explorer: {}", e))?;
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(log_dir)
            .spawn()
            .map_err(|e| format!("Failed to open Finder: {}", e))?;
    }

    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(log_dir)
            .spawn()
            .map_err(|e| format!("Failed to open file manager: {}", e))?;
    }

    Ok(())
}

/// Write debug info to ultradebug.log in the project directory
/// This is a simple file that Claude can read directly
#[command]
pub fn write_ultradebug(content: String) -> Result<String, String> {
    let debug_path = std::path::PathBuf::from("T:\\PersonalProjects\\snapit\\ultradebug.log");

    // Append timestamp
    let timestamp = Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
    let content_with_time = format!("\n=== {} ===\n{}\n", timestamp, content);

    // Append to file (create if doesn't exist)
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&debug_path)
        .map_err(|e| format!("Failed to open ultradebug.log: {}", e))?;

    file.write_all(content_with_time.as_bytes())
        .map_err(|e| format!("Failed to write to ultradebug.log: {}", e))?;

    Ok(debug_path.to_string_lossy().to_string())
}

/// Get recent logs (last N lines) for debugging
#[command]
pub fn get_recent_logs(app: AppHandle, lines: Option<usize>) -> Result<String, String> {
    let log_dir = app
        .path()
        .app_log_dir()
        .map_err(|e| format!("Failed to get log directory: {}", e))?;

    let log_path = get_current_log_path(&log_dir);

    if !log_path.exists() {
        return Ok(String::new());
    }

    let content =
        fs::read_to_string(&log_path).map_err(|e| format!("Failed to read log file: {}", e))?;

    let max_lines = lines.unwrap_or(100);
    let recent: Vec<&str> = content.lines().rev().take(max_lines).collect();

    Ok(recent.into_iter().rev().collect::<Vec<_>>().join("\n"))
}
