//! Restarting the app on macOS once this process has exited.
//!
//! `tauri::process::restart` launches the new instance while this one is still running.
//! After an update has replaced the app bundle, the Dock then gives the new instance a
//! tile of its own instead of the pinned one. A detached shell waits for this process
//! to exit and only then opens the bundle.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

const WAIT_THEN_OPEN: &str = r#"pid=$1; opener=$2; app=$3; shift 3; while kill -0 "$pid" 2>/dev/null; do sleep 0.1; done; exec "$opener" -n "$app" --args "$@""#;

/// Restarts the app; never returns.
pub fn restart(env: &tauri::Env) -> ! {
    if let Some(bundle) = tauri::process::current_binary(env).ok().and_then(|bin| app_bundle(&bin)) {
        let args = env.args_os.iter().skip(1).cloned().collect::<Vec<_>>();
        match wait_then_open(std::process::id(), Path::new("/usr/bin/open"), &bundle, &args).spawn() {
            Ok(_) => std::process::exit(0),
            Err(e) => tracing::error!("failed to schedule the restart: {e}"),
        }
    }
    tauri::process::restart(env)
}

/// The `.app` bundle holding `binary`, when it sits at `<bundle>/Contents/MacOS/<name>`.
fn app_bundle(binary: &Path) -> Option<PathBuf> {
    let macos = binary.parent()?;
    let contents = macos.parent()?;
    if macos.file_name()? != "MacOS" || contents.file_name()? != "Contents" {
        return None;
    }
    contents.parent().map(Path::to_path_buf)
}

fn wait_then_open(pid: u32, opener: &Path, bundle: &Path, args: &[OsString]) -> Command {
    use std::os::unix::process::CommandExt;
    let mut command = Command::new("/bin/sh");
    command
        .arg("-c")
        .arg(WAIT_THEN_OPEN)
        .arg("openidea-restart")
        .arg(pid.to_string())
        .arg(opener)
        .arg(bundle)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0);
    command
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    #[test]
    fn finds_the_bundle_of_its_binary() {
        assert_eq!(
            app_bundle(Path::new("/Applications/OpenIDEA.app/Contents/MacOS/openidea")),
            Some(PathBuf::from("/Applications/OpenIDEA.app"))
        );
        assert_eq!(app_bundle(Path::new("/repo/target/debug/openidea")), None);
        assert_eq!(app_bundle(Path::new("/x/MacOS/openidea")), None);
    }

    #[test]
    fn opens_the_bundle_only_after_the_process_exits() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("opened");
        let opener = dir.path().join("opener");
        std::fs::write(&opener, format!("#!/bin/sh\nprintf '%s|' \"$@\" > '{}'\n", log.display())).unwrap();
        std::fs::set_permissions(&opener, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();

        let mut running = Command::new("/bin/sleep").arg("1").spawn().unwrap();
        let pid = running.id();
        let reaper = std::thread::spawn(move || running.wait());
        let args = [OsString::from("--flag"), OsString::from("a b")];
        let started = Instant::now();
        wait_then_open(pid, &opener, Path::new("/Apps/X.app"), &args).status().unwrap();

        assert!(started.elapsed() >= Duration::from_millis(700), "opened before the process exited");
        assert!(reaper.join().unwrap().unwrap().success());
        assert_eq!(std::fs::read_to_string(&log).unwrap(), "-n|/Apps/X.app|--args|--flag|a b|");
    }
}
