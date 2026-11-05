//! Android devices and their logs, driven through the `adb` CLI (like git is
//! driven through its CLI).
//!
//! The Logcat tool window needs two things from a device: that it is there, and
//! what it prints. Both come from `adb`, which the Android SDK installs — the
//! IDE does not bundle it.
//!
//! Every function blocks; callers run them off the UI / command threads.

mod model;
mod process;

pub use model::*;

use ide_core::{CancellationToken, IdeError, IdeResult};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;
use std::time::Duration;

/// `adb devices` is quick unless it starts the daemon, which can take a moment.
const DEVICES: Duration = Duration::from_secs(20);
/// `adb logcat -c` only truncates the buffers.
const CLEAR: Duration = Duration::from_secs(15);
/// How much of the buffer to show before following, so opening the window is not empty.
const TAIL_LINES: u32 = 200;
/// Logcat can print thousands of lines a second: batches keep the IPC channel sane,
/// while `IDLE` makes sure a quiet stream still shows its last line promptly.
const BATCH_IDLE: Duration = Duration::from_millis(60);
const BATCH_MAX: usize = 300;

fn exe(name: &str) -> String {
    if cfg!(windows) { format!("{name}.exe") } else { name.to_owned() }
}

/// Android SDK locations, most specific first: the environment, then the usual
/// per-platform installs (a GUI app on macOS does not see a shell's `ANDROID_HOME`).
fn sdk_roots() -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = ["ANDROID_HOME", "ANDROID_SDK_ROOT"]
        .iter()
        .filter_map(|key| std::env::var_os(key).map(PathBuf::from))
        .collect();
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from);
    if let Some(home) = home.filter(|_| !cfg!(windows)) {
        roots.push(home.join("Library/Android/sdk"));
        roots.push(home.join("Android/Sdk"));
    }
    if cfg!(windows)
        && let Some(local) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from)
    {
        roots.push(local.join("Android/Sdk"));
    }
    roots
}

/// Locates the adb executable once per process; `OPENIDEA_ADB` overrides.
pub fn adb_executable() -> Option<PathBuf> {
    static ADB: OnceLock<Option<PathBuf>> = OnceLock::new();
    ADB.get_or_init(|| {
        if let Some(explicit) = std::env::var_os("OPENIDEA_ADB").map(PathBuf::from).filter(|p| p.is_file()) {
            return Some(explicit);
        }
        let name = exe("adb");
        if let Some(found) =
            sdk_roots().into_iter().map(|root| root.join("platform-tools").join(&name)).find(|p| p.is_file())
        {
            return Some(found);
        }
        if let Ok(found) = which::which("adb") {
            return Some(found);
        }
        let mut candidates: Vec<PathBuf> = if cfg!(windows) {
            vec![PathBuf::from(r"C:\platform-tools\adb.exe")]
        } else {
            ["/usr/local/bin/adb", "/opt/homebrew/bin/adb", "/usr/bin/adb"].iter().map(PathBuf::from).collect()
        };
        candidates.extend([
            PathBuf::from("/opt/android-sdk/platform-tools/adb"),
            PathBuf::from("/usr/lib/android-sdk/platform-tools/adb"),
        ]);
        candidates.into_iter().find(|p: &PathBuf| p.is_file())
    })
    .clone()
}

fn executable() -> IdeResult<PathBuf> {
    adb_executable().ok_or_else(|| {
        IdeError::unavailable(
            "adb was not found: install the Android SDK platform-tools, or set ANDROID_HOME (or OPENIDEA_ADB)",
        )
    })
}

/// The directory holding adb, for command lines that expect `adb` on `PATH`.
pub fn platform_tools_dir() -> Option<&'static Path> {
    static DIR: OnceLock<Option<PathBuf>> = OnceLock::new();
    DIR.get_or_init(|| adb_executable().as_deref().and_then(Path::parent).map(Path::to_path_buf)).as_deref()
}

/// Connected devices, online ones first; starting the adb daemon when needed.
pub fn devices() -> IdeResult<Vec<AndroidDevice>> {
    let adb = executable()?;
    let mut cmd = Command::new(adb);
    cmd.args(["devices", "-l"]);
    let out = process::run(cmd, DEVICES, None)?;
    if !out.success {
        let message = out.stderr.trim();
        return Err(IdeError::unavailable(if message.is_empty() {
            "adb devices failed".to_owned()
        } else {
            format!("adb devices failed: {message}")
        }));
    }
    Ok(parse_devices(&out.stdout))
}

/// Empties the device's log buffers (`adb logcat -c`).
pub fn clear_log(serial: &str, cancel: &CancellationToken) -> IdeResult<()> {
    let adb = executable()?;
    let mut cmd = Command::new(adb);
    cmd.args(["-s", serial, "logcat", "-c"]);
    let out = process::run(cmd, CLEAR, Some(cancel))?;
    if out.success {
        Ok(())
    } else {
        Err(IdeError::unavailable(format!("adb logcat -c failed: {}", out.stderr.trim())))
    }
}

fn command(adb: &Path, serial: &str, tail: Option<u32>) -> Command {
    let mut cmd = Command::new(adb);
    cmd.args(["-s", serial, "logcat", "-v", "threadtime"]);
    if let Some(lines) = tail {
        // Recent history first, then follow: `-T <count>` is lines, not an exit.
        cmd.arg("-T").arg(lines.to_string());
    }
    cmd
}

/// Follows `serial`'s log until `cancel` fires, handing lines over in batches.
/// With `clear`, the buffers are emptied first so the window starts clean.
pub fn logcat(
    serial: &str,
    clear: bool,
    cancel: &CancellationToken,
    on_batch: &mut dyn FnMut(Vec<LogcatLine>),
) -> IdeResult<()> {
    let adb = executable()?;
    if clear {
        clear_log(serial, cancel)?;
    }
    let mut parse = |line: &str| Some(parse_line(line));
    let (ok, stderr) = match process::stream_batched(
        command(&adb, serial, Some(TAIL_LINES)),
        cancel,
        BATCH_IDLE,
        BATCH_MAX,
        &mut parse,
        on_batch,
    ) {
        Ok(result) => result,
        // The window closed or switched devices: stopping is the expected end.
        Err(e) if e.kind == ide_core::error::ErrorKind::Cancelled => return Ok(()),
        Err(e) => return Err(e),
    };
    if ok || cancel.is_cancelled() {
        return Ok(());
    }
    // `-T` is old (API 21) but adb forwards logcat options it does not know on
    // very old devices; retry without the history rather than showing nothing.
    let unsupported = stderr.iter().any(|line| {
        line.contains("Unrecognized option") || line.contains("unknown option") || line.contains("Invalid option")
    });
    if unsupported {
        let (ok, stderr) = match process::stream_batched(
            command(&adb, serial, None),
            cancel,
            BATCH_IDLE,
            BATCH_MAX,
            &mut parse,
            on_batch,
        ) {
            Ok(result) => result,
            Err(e) if e.kind == ide_core::error::ErrorKind::Cancelled => return Ok(()),
            Err(e) => return Err(e),
        };
        if ok || cancel.is_cancelled() {
            return Ok(());
        }
        return Err(failure(serial, &stderr));
    }
    Err(failure(serial, &stderr))
}

fn failure(serial: &str, stderr: &[String]) -> IdeError {
    let message = stderr.join("\n");
    IdeError::unavailable(if message.trim().is_empty() {
        format!("adb logcat on {serial} stopped")
    } else {
        format!("adb logcat on {serial} stopped: {message}")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adb_candidates_are_absolute() {
        for root in sdk_roots() {
            assert!(root.is_absolute(), "{root:?}");
        }
    }

    #[test]
    fn executable_is_absolute_when_found() {
        if let Some(adb) = adb_executable() {
            assert!(adb.is_absolute());
            assert!(adb.is_file());
        }
    }
}
