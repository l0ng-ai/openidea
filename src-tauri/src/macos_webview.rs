//! On macOS systems whose WebKit predates Safari 15.4, WKWebView keeps using
//! that old engine even after Safari itself is updated. Apple stages the newer
//! WebKit next to the Safari app; Safari.app points dyld at it, and we do the
//! same before Tauri creates a webview.
//!
//! dyld reads framework search paths at process start, so switching engines
//! means setting `DYLD_FRAMEWORK_PATH` and re-executing. The second process
//! clears the variable again: the new engine stays loaded (verified on macOS
//! 11.7.11 by dlopen'ing WebKit after unsetenv), while children such as
//! language servers and git helpers keep using the system frameworks.
//!
//! Only a system WebKit older than Safari 15.4 with a staged copy present
//! takes this path. macOS 12.3+ already ships Safari 15.4's engine, and
//! macOS 13+ ships an even newer one; neither restarts the process.

use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::Command;

const STAGED_FRAMEWORKS: &str = "/Library/Apple/System/Library/StagedFrameworks/Safari";
const STAGED_WEBKIT: &str = "/Library/Apple/System/Library/StagedFrameworks/Safari/WebKit.framework";
const SYSTEM_WEBKIT_PLIST: &str = "/System/Library/Frameworks/WebKit.framework/Resources/Info.plist";
const DYLD_FRAMEWORK_PATH: &str = "DYLD_FRAMEWORK_PATH";
/// Set on the re-exec so we never loop, and so the second process knows to
/// drop the dyld variable before spawning children.
const REEXEC_MARKER: &str = "OPENIDEA_WEBKIT_REEXEC";
const DISABLE: &str = "OPENIDEA_DISABLE_STAGED_WEBKIT";

/// WebKit's CFBundleVersion starts with `166NN`, where NN is the engine
/// generation: 16611 = Safari 14.1 / WebKit 611, 16613 = Safari 15.4 / WebKit
/// 613, 16615 = Safari 16 / WebKit 615. Anything below 16613 cannot parse the
/// Safari 15.4 bundle (`vite.config.ts`).
const MIN_SYSTEM_WEBKIT_BUNDLE: u32 = 16613;

/// Call at the very start of `main`, before Tauri creates a webview.
pub fn ensure_modern_webkit() {
    if std::env::var_os(REEXEC_MARKER).is_some() {
        // dyld snapshots DYLD_* at process start, so removing it here keeps
        // the engine we loaded without passing the override to children.
        clear_dyld_framework_path();
        return;
    }
    // The `openidea` CLI wrapper runs this binary too, but never opens a
    // webview; don't pay for a re-exec on every git hook invocation.
    if std::env::args_os().any(|arg| arg.as_os_str() == std::ffi::OsStr::new("--cli")) {
        return;
    }
    if std::env::var_os(DISABLE).is_some() {
        return;
    }
    // Check for the staged copy first: it is a stat, while reading the system
    // version spawns `defaults`, which every launch on a current macOS would pay.
    if !Path::new(STAGED_WEBKIT).is_dir() || !needs_staged_webkit(system_webkit_bundle_version(), true) {
        return;
    }
    relaunch();
}

fn needs_staged_webkit(system_bundle: Option<u32>, staged_present: bool) -> bool {
    // If we cannot read the system version, keep the system engine: an
    // unverifiable switch is worse than showing the startup failure page.
    staged_present && matches!(system_bundle, Some(version) if version < MIN_SYSTEM_WEBKIT_BUNDLE)
}

fn relaunch() {
    let Ok(exe) = std::env::current_exe() else { return };
    let error = Command::new(exe)
        .args(std::env::args_os().skip(1))
        .env(DYLD_FRAMEWORK_PATH, STAGED_FRAMEWORKS)
        .env(REEXEC_MARKER, "1")
        .exec();
    // `exec` returns only on failure. Continue on the system engine so the
    // startup failure page can tell the user to install the Safari update.
    eprintln!("OpenIDEA: could not relaunch with Safari's WebKit: {error}");
}

fn system_webkit_bundle_version() -> Option<u32> {
    let out =
        Command::new("/usr/bin/defaults").arg("read").arg(SYSTEM_WEBKIT_PLIST).arg("CFBundleVersion").output().ok()?;
    if !out.status.success() {
        return None;
    }
    bundle_prefix(&String::from_utf8_lossy(&out.stdout))
}

fn bundle_prefix(version: &str) -> Option<u32> {
    let version = version.trim();
    let end = version.find(|c: char| !c.is_ascii_digit()).unwrap_or(version.len());
    version[..end].parse().ok()
}

// `remove_var` is unsafe from edition 2024 on. This runs single-threaded at
// the start of main, before Tauri starts any workers.
#[allow(unused_unsafe)]
fn clear_dyld_framework_path() {
    unsafe { std::env::remove_var(DYLD_FRAMEWORK_PATH) };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_webkit_bundle_versions() {
        assert_eq!(bundle_prefix("16611.3.10.1.19\n"), Some(16611));
        assert_eq!(bundle_prefix("16613.4.9.1.12"), Some(16613));
        assert_eq!(bundle_prefix("16615"), Some(16615));
        assert_eq!(bundle_prefix(""), None);
        assert_eq!(bundle_prefix("unknown"), None);
    }

    #[test]
    fn only_switches_when_system_webkit_predates_safari_15_4() {
        // Big Sur and Monterey before 12.3: staged WebKit is needed.
        assert!(needs_staged_webkit(Some(16611), true));
        assert!(needs_staged_webkit(Some(16612), true));
        // Monterey 12.3+ and Ventura+: system WebKit is already new enough.
        assert!(!needs_staged_webkit(Some(16613), true));
        assert!(!needs_staged_webkit(Some(16615), true));
        // No staged copy, or an unreadable system version: leave it alone.
        assert!(!needs_staged_webkit(Some(16611), false));
        assert!(!needs_staged_webkit(None, true));
    }
}
