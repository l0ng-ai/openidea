//! Installing the `openidea` command: a symlink on `PATH` to the launcher
//! script in the app bundle (`Contents/Resources/bin/openidea`). macOS only.

use std::ffi::OsStr;
use std::io;
use std::path::{Path, PathBuf};

pub const COMMAND: &str = "openidea";
const LAUNCHER: &str = "Contents/Resources/bin/openidea";
const SYSTEM_DIR: &str = "/usr/local/bin";

/// The launcher script of the bundle whose executable is `exe`; `None` outside a bundle.
pub fn bundled_launcher(exe: &Path) -> Option<PathBuf> {
    let launcher = exe.parent()?.parent()?.parent()?.join(LAUNCHER);
    launcher.is_file().then_some(launcher)
}

/// macOS runs a quarantined app from a random read-only copy until it is moved:
/// a link there would break on the next launch.
pub fn translocated(path: &Path) -> bool {
    path.to_string_lossy().contains("/AppTranslocation/")
}

/// Where the link goes: `~/.local/bin` when it is on `path_var` (no administrator
/// rights needed), else `/usr/local/bin`.
pub fn link_dir(path_var: Option<&OsStr>, home: Option<&Path>) -> PathBuf {
    let local = home.map(|h| h.join(".local/bin"));
    match (path_var, local) {
        (Some(var), Some(local)) if std::env::split_paths(var).any(|p| p == local) => local,
        _ => PathBuf::from(SYSTEM_DIR),
    }
}

/// Directories an earlier install may have used.
pub fn link_dirs(home: Option<&Path>) -> Vec<PathBuf> {
    home.map(|h| h.join(".local/bin")).into_iter().chain([PathBuf::from(SYSTEM_DIR)]).collect()
}

/// The installed links among `dirs` (any OpenIDEA bundle's launcher).
pub fn installed(dirs: &[PathBuf]) -> Vec<PathBuf> {
    dirs.iter().map(|d| d.join(COMMAND)).filter(|l| is_launcher_link(l)).collect()
}

fn is_launcher_link(link: &Path) -> bool {
    std::fs::read_link(link).is_ok_and(|target| target.ends_with(LAUNCHER))
}

/// Links `dir/openidea` to `launcher`, asking for administrator rights when `dir`
/// is not writable. Refuses to replace an `openidea` that is not ours.
pub fn install(launcher: &Path, dir: &Path) -> io::Result<PathBuf> {
    let link = dir.join(COMMAND);
    if link.symlink_metadata().is_ok() && !is_launcher_link(&link) {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            format!("{} already exists and is not an OpenIDEA command", link.display()),
        ));
    }
    let direct = std::fs::create_dir_all(dir).and_then(|()| {
        if link.symlink_metadata().is_ok() {
            std::fs::remove_file(&link)?;
        }
        symlink(launcher, &link)
    });
    match direct {
        Err(e) if e.kind() == io::ErrorKind::PermissionDenied => {
            privileged(&format!("mkdir -p {} && ln -sfn {} {}", quote(dir), quote(launcher), quote(&link)))?
        }
        result => result?,
    }
    Ok(link)
}

/// Removes `links`, asking for administrator rights where needed.
pub fn uninstall(links: &[PathBuf]) -> io::Result<()> {
    for link in links {
        match std::fs::remove_file(link) {
            Err(e) if e.kind() == io::ErrorKind::PermissionDenied => privileged(&format!("rm -f {}", quote(link)))?,
            result => result?,
        }
    }
    Ok(())
}

#[cfg(unix)]
fn symlink(target: &Path, link: &Path) -> io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

#[cfg(not(unix))]
fn symlink(_target: &Path, _link: &Path) -> io::Result<()> {
    Err(io::Error::new(io::ErrorKind::Unsupported, "not supported on this platform"))
}

/// Runs `command` as root after the system's password prompt. Cancelling it is
/// [`io::ErrorKind::Interrupted`].
fn privileged(command: &str) -> io::Result<()> {
    if !cfg!(target_os = "macos") {
        return Err(io::Error::new(io::ErrorKind::PermissionDenied, "administrator rights required"));
    }
    let script = format!("do shell script \"{}\" with administrator privileges", applescript_escape(command));
    let output = std::process::Command::new("/usr/bin/osascript").arg("-e").arg(script).output()?;
    if output.status.success() {
        return Ok(());
    }
    let message = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    // "User canceled. (-128)"
    let kind = if message.contains("(-128)") { io::ErrorKind::Interrupted } else { io::ErrorKind::PermissionDenied };
    Err(io::Error::new(kind, message))
}

fn quote(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', r"'\''"))
}

fn applescript_escape(s: &str) -> String {
    s.replace('\\', r"\\").replace('"', "\\\"")
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn bundle(root: &Path) -> (PathBuf, PathBuf) {
        let app = root.join("OpenIDEA.app");
        let exe = app.join("Contents/MacOS/openidea");
        let launcher = app.join(LAUNCHER);
        std::fs::create_dir_all(exe.parent().unwrap()).unwrap();
        std::fs::create_dir_all(launcher.parent().unwrap()).unwrap();
        std::fs::write(&exe, "").unwrap();
        std::fs::write(&launcher, "").unwrap();
        (exe, launcher)
    }

    #[test]
    fn finds_the_launcher_of_a_bundle_only() {
        let dir = tempfile::tempdir().unwrap();
        let (exe, launcher) = bundle(dir.path());
        assert_eq!(bundled_launcher(&exe), Some(launcher));
        assert_eq!(bundled_launcher(&dir.path().join("target/debug/openidea")), None);
        assert!(translocated(Path::new("/private/var/folders/x/AppTranslocation/ABC/d/OpenIDEA.app")));
    }

    #[test]
    fn prefers_local_bin_on_path() {
        let home = Path::new("/Users/u");
        let path = std::env::join_paths(["/usr/bin", "/Users/u/.local/bin"]).unwrap();
        assert_eq!(link_dir(Some(&path), Some(home)), home.join(".local/bin"));
        assert_eq!(link_dir(Some(OsStr::new("/usr/bin")), Some(home)), PathBuf::from(SYSTEM_DIR));
        assert_eq!(link_dir(None, Some(home)), PathBuf::from(SYSTEM_DIR));
    }

    #[test]
    fn install_replaces_its_own_link_but_not_other_files() {
        let dir = tempfile::tempdir().unwrap();
        let (_, launcher) = bundle(dir.path());
        let bin = dir.path().join("bin");
        let link = install(&launcher, &bin).unwrap();
        assert_eq!(std::fs::read_link(&link).unwrap(), launcher);
        assert_eq!(install(&launcher, &bin).unwrap(), link);
        assert_eq!(installed(std::slice::from_ref(&bin)), vec![link.clone()]);
        uninstall(&installed(std::slice::from_ref(&bin))).unwrap();
        assert!(installed(std::slice::from_ref(&bin)).is_empty());
        std::fs::write(&link, "someone else's").unwrap();
        assert_eq!(install(&launcher, &bin).unwrap_err().kind(), io::ErrorKind::AlreadyExists);
    }

    #[test]
    fn quoting() {
        assert_eq!(quote(Path::new("/a b/it's")), r"'/a b/it'\''s'");
        assert_eq!(applescript_escape(r#"ln "a\b""#), r#"ln \"a\\b\""#);
    }
}
