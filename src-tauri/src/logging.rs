//! Logging: stdout (as before) plus a daily-rotated file in the app log dir
//! (`~/Library/Logs/<identifier>` on macOS, `<local data>/<identifier>/logs`
//! elsewhere — the same place as Tauri's `app_log_dir`).

use std::fmt::Write as _;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::fmt::format::Writer;
use tracing_subscriber::fmt::time::{FormatTime, SystemTime};
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::{EnvFilter, Layer};

const PREFIX: &str = "openidea";
const SUFFIX: &str = "log";

static LOG_DIR: OnceLock<PathBuf> = OnceLock::new();
static GUARD: OnceLock<WorkerGuard> = OnceLock::new();

pub fn log_dir_for(identifier: &str) -> Option<PathBuf> {
    if cfg!(target_os = "macos") {
        dirs::home_dir().map(|h| h.join("Library/Logs").join(identifier))
    } else {
        dirs::data_local_dir().map(|d| d.join(identifier).join("logs"))
    }
}

fn filter() -> EnvFilter {
    EnvFilter::try_from_default_env().unwrap_or_else(|_| "info,openidea_lib=debug".into())
}

pub fn init(identifier: &str) {
    let stdout = tracing_subscriber::fmt::layer().with_filter(filter());
    let file = log_dir_for(identifier).and_then(|dir| {
        std::fs::create_dir_all(&dir).ok()?;
        let appender = tracing_appender::rolling::Builder::new()
            .rotation(tracing_appender::rolling::Rotation::DAILY)
            .filename_prefix(PREFIX)
            .filename_suffix(SUFFIX)
            .max_log_files(7)
            .build(&dir)
            .ok()?;
        let (writer, guard) = tracing_appender::non_blocking(appender);
        let _ = GUARD.set(guard);
        log_panics(dir.clone());
        let _ = LOG_DIR.set(dir);
        Some(tracing_subscriber::fmt::layer().with_ansi(false).with_writer(writer).with_filter(filter()))
    });
    let _ = tracing_subscriber::registry().with(stdout).with(file).try_init();
}

/// Panics go to the log file synchronously: the non-blocking writer may not
/// get to them before a panic that aborts ends the process.
fn log_panics(dir: PathBuf) {
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let _ = append(&dir, &panic_record(info));
        default(info);
    }));
}

fn panic_record(info: &std::panic::PanicHookInfo) -> String {
    let mut record = String::new();
    let _ = SystemTime.format_time(&mut Writer::new(&mut record));
    let thread = std::thread::current();
    let _ = write!(
        record,
        " ERROR panic: thread '{}' {info}\n{}\n",
        thread.name().unwrap_or("<unnamed>"),
        std::backtrace::Backtrace::force_capture()
    );
    record
}

fn append(dir: &Path, record: &str) -> std::io::Result<()> {
    let path = latest_log(dir).unwrap_or_else(|| dir.join(format!("{PREFIX}.panic.{SUFFIX}")));
    std::fs::OpenOptions::new().create(true).append(true).open(path)?.write_all(record.as_bytes())
}

pub fn log_dir() -> Option<&'static Path> {
    LOG_DIR.get().map(PathBuf::as_path)
}

/// The most recently modified log file in `dir`.
pub fn latest_log(dir: &Path) -> Option<PathBuf> {
    std::fs::read_dir(dir)
        .ok()?
        .filter_map(Result::ok)
        .filter(|e| e.file_name().to_string_lossy().starts_with(PREFIX))
        .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
        .max_by_key(|(t, _)| *t)
        .map(|(_, p)| p)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn latest_log_picks_newest_matching_file() {
        let dir = std::env::temp_dir().join(format!("openidea-log-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("other.txt"), "x").unwrap();
        assert_eq!(latest_log(&dir), None);
        std::fs::write(dir.join("openidea.2026-01-01.log"), "x").unwrap();
        assert_eq!(latest_log(&dir), Some(dir.join("openidea.2026-01-01.log")));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn panic_record_names_thread_location_and_message() {
        let dir = std::env::temp_dir().join(format!("openidea-panic-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("openidea.2026-01-01.log"), "earlier\n").unwrap();
        let record = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
        let sink = record.clone();
        let default = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| *sink.lock().unwrap() = panic_record(info)));
        let _ = std::thread::Builder::new().name("worker".into()).spawn(|| panic!("boom")).unwrap().join();
        std::panic::set_hook(default);
        let record = record.lock().unwrap().clone();
        let location = format!("ERROR panic: thread 'worker' panicked at {}:", file!());
        assert!(record.contains(&location), "{record}");
        assert!(record.contains("boom"), "{record}");
        append(&dir, &record).unwrap();
        let log = std::fs::read_to_string(dir.join("openidea.2026-01-01.log")).unwrap();
        assert!(log.starts_with("earlier\n") && log.ends_with(&record));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn log_dir_is_per_identifier() {
        let d = log_dir_for("com.example.x").unwrap();
        assert!(d.to_string_lossy().contains("com.example.x"));
    }
}
