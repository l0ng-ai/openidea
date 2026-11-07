//! Installing the `openidea` command: a symlink on `PATH` to the launcher
//! script in a macOS bundle, or a wrapper in a user's bin directory.

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

const WRAPPER_MARKER: &str = "OpenIDEA command launcher v1";

/// AppImages remount their executable on every launch. Keep the original image path.
pub fn stable_executable(exe: &Path, appimage: Option<&Path>) -> io::Result<PathBuf> {
    let path = appimage.unwrap_or(exe);
    if !path.is_absolute() || !path.is_file() {
        return Err(io::Error::new(io::ErrorKind::NotFound, "the OpenIDEA executable must be in a permanent location"));
    }
    Ok(path.to_path_buf())
}

pub fn wrapper_path(dir: &Path, windows: bool) -> PathBuf {
    dir.join(if windows { "openidea.cmd" } else { COMMAND })
}

fn wrapper(exe: &Path, windows: bool) -> io::Result<String> {
    let exe =
        exe.to_str().ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "the executable path is not UTF-8"))?;
    if exe.contains(['\r', '\n']) || (windows && exe.contains('"')) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "the executable path contains unsupported characters"));
    }
    Ok(if windows {
        format!(
            "@echo off\r\nrem {WRAPPER_MARKER}\r\nsetlocal DisableDelayedExpansion\r\nfor /f \"tokens=2 delims=:\" %%c in ('chcp') do set \"_openidea_codepage=%%c\"\r\nchcp 65001 >nul\r\n\"{}\" --cli %*\r\nset \"_openidea_exit=%errorlevel%\"\r\nchcp %_openidea_codepage% >nul\r\nexit /b %_openidea_exit%\r\n",
            exe.replace('%', "%%")
        )
    } else {
        format!("#!/bin/sh\n# {WRAPPER_MARKER}\nexec {} --cli \"$@\"\n", quote(Path::new(exe)))
    })
}

pub fn is_wrapper(path: &Path, windows: bool) -> bool {
    path.symlink_metadata().is_ok_and(|meta| meta.is_file() && !meta.file_type().is_symlink())
        && std::fs::read_to_string(path).is_ok_and(|text| {
            text.lines().nth(1) == Some(&format!("{} {WRAPPER_MARKER}", if windows { "rem" } else { "#" }))
        })
}

/// Never follows or overwrites a foreign file, even if it has the same command name.
pub fn install_wrapper(exe: &Path, dir: &Path, windows: bool) -> io::Result<PathBuf> {
    use std::io::Write;
    let text = wrapper(exe, windows)?;
    let path = wrapper_path(dir, windows);
    if path.symlink_metadata().is_ok() {
        if !is_wrapper(&path, windows) {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                format!("{} already exists and is not an OpenIDEA command", path.display()),
            ));
        }
        std::fs::remove_file(&path)?;
    }
    std::fs::create_dir_all(dir)?;
    let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o755))?;
    }
    file.write_all(text.as_bytes())?;
    Ok(path)
}

pub fn uninstall_wrapper(dir: &Path, windows: bool) -> io::Result<Vec<PathBuf>> {
    let path = wrapper_path(dir, windows);
    if !is_wrapper(&path, windows) {
        return Ok(vec![]);
    }
    std::fs::remove_file(&path)?;
    Ok(vec![path])
}

/// Preserve every unrelated PATH entry, including expandable environment variables.
pub fn windows_path(current: &str, dir: &str, add: bool) -> Option<String> {
    fn equal(a: &str, b: &str) -> bool {
        a.trim().trim_matches('"').trim_end_matches(['\\', '/']).eq_ignore_ascii_case(b.trim_end_matches(['\\', '/']))
    }
    let found = current.split(';').any(|entry| equal(entry, dir));
    if add {
        if found {
            return None;
        }
        Some(format!("{dir}{}{current}", if current.is_empty() { "" } else { ";" }))
    } else if found {
        Some(current.split(';').filter(|entry| !equal(entry, dir)).collect::<Vec<_>>().join(";"))
    } else {
        None
    }
}

#[cfg(windows)]
pub fn update_user_path(dir: &Path, add: bool) -> io::Result<()> {
    use winreg::{
        RegKey,
        enums::{HKEY_CURRENT_USER, REG_EXPAND_SZ},
        types::{FromRegValue, ToRegValue},
    };
    let (environment, _) = RegKey::predef(HKEY_CURRENT_USER).create_subkey("Environment")?;
    let raw = match environment.get_raw_value("Path") {
        Ok(raw) => Some(raw),
        Err(e) if e.kind() == io::ErrorKind::NotFound => None,
        Err(e) => return Err(e),
    };
    let current = raw.as_ref().map(String::from_reg_value).transpose()?.unwrap_or_default();
    let Some(updated) = windows_path(&current, &dir.to_string_lossy(), add) else { return Ok(()) };
    let mut value = updated.to_reg_value();
    value.vtype = raw.as_ref().map_or(REG_EXPAND_SZ, |raw| raw.vtype.clone());
    environment.set_raw_value("Path", &value)?;
    let message: Vec<u16> = "Environment\0".encode_utf16().collect();
    // SAFETY: the terminated string stays alive for this bounded synchronous broadcast.
    unsafe {
        windows_sys::Win32::UI::WindowsAndMessaging::SendMessageTimeoutW(
            windows_sys::Win32::UI::WindowsAndMessaging::HWND_BROADCAST,
            windows_sys::Win32::UI::WindowsAndMessaging::WM_SETTINGCHANGE,
            0,
            message.as_ptr() as isize,
            windows_sys::Win32::UI::WindowsAndMessaging::SMTO_ABORTIFHUNG,
            1000,
            std::ptr::null_mut(),
        );
    }
    Ok(())
}

pub struct Installation {
    pub path: PathBuf,
    /// Some when the user needs to add this directory to their shell's PATH.
    pub path_directory: Option<PathBuf>,
}

fn resolves_to(path_var: Option<&OsStr>, command: &Path) -> bool {
    path_var
        .and_then(|path| std::env::split_paths(path).map(|dir| dir.join(COMMAND)).find(|candidate| candidate.is_file()))
        .is_some_and(|candidate| candidate == command)
}

fn user_bin() -> io::Result<PathBuf> {
    if cfg!(windows) {
        dirs::data_local_dir().map(|dir| dir.join("OpenIDEA/bin"))
    } else {
        dirs::home_dir().map(|dir| dir.join(".local/bin"))
    }
    .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "no user directory for the openidea command"))
}

pub fn install_current() -> io::Result<Installation> {
    let exe = std::env::current_exe()?;
    if cfg!(target_os = "macos") {
        let launcher = bundled_launcher(&exe).ok_or_else(|| {
            io::Error::new(io::ErrorKind::NotFound, "install the command from the packaged OpenIDEA app")
        })?;
        if translocated(&launcher) {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "move OpenIDEA to the Applications folder first",
            ));
        }
        let dir = link_dir(std::env::var_os("PATH").as_deref(), dirs::home_dir().as_deref());
        return Ok(Installation { path: install(&launcher, &dir)?, path_directory: None });
    }
    let image = if cfg!(target_os = "linux") { std::env::var_os("APPIMAGE").map(PathBuf::from) } else { None };
    let exe = stable_executable(&exe, image.as_deref())?;
    let dir = user_bin()?;
    let path = install_wrapper(&exe, &dir, cfg!(windows))?;
    #[cfg(windows)]
    update_user_path(&dir, true)?;
    let on_path = cfg!(windows) || resolves_to(std::env::var_os("PATH").as_deref(), &path);
    Ok(Installation { path, path_directory: (!on_path).then_some(dir) })
}

pub fn uninstall_current() -> io::Result<Vec<PathBuf>> {
    if cfg!(target_os = "macos") {
        let links = installed(&link_dirs(dirs::home_dir().as_deref()));
        uninstall(&links)?;
        return Ok(links);
    }
    let dir = user_bin()?;
    let path = wrapper_path(&dir, cfg!(windows));
    if is_wrapper(&path, cfg!(windows)) {
        #[cfg(windows)]
        update_user_path(&dir, false)?;
        return uninstall_wrapper(&dir, cfg!(windows));
    }
    Ok(vec![])
}

#[cfg(test)]
mod wrapper_tests {
    use super::*;

    #[test]
    fn wrappers_install_update_and_remove_only_their_own_files() {
        for windows in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let exe = dir.path().join("App folder/程序 & it's 100%.exe");
            let path = install_wrapper(&exe, dir.path(), windows).unwrap();
            assert!(is_wrapper(&path, windows));
            assert_eq!(install_wrapper(&exe, dir.path(), windows).unwrap(), path);
            assert_eq!(uninstall_wrapper(dir.path(), windows).unwrap(), vec![path.clone()]);
            assert!(uninstall_wrapper(dir.path(), windows).unwrap().is_empty());
            std::fs::write(&path, "foreign command").unwrap();
            assert_eq!(install_wrapper(&exe, dir.path(), windows).unwrap_err().kind(), io::ErrorKind::AlreadyExists);
            assert!(uninstall_wrapper(dir.path(), windows).unwrap().is_empty());
            assert_eq!(std::fs::read_to_string(&path).unwrap(), "foreign command");
        }
    }

    #[test]
    fn path_changes_keep_other_entries_and_do_not_duplicate_the_command_dir() {
        let dir = r"C:\Users\用户\OpenIDEA\bin";
        let initial = r"%USERPROFILE%\tools;C:\other";
        let updated = windows_path(initial, dir, true).unwrap();
        assert_eq!(updated, format!("{dir};{initial}"));
        assert_eq!(windows_path(&updated, dir, true), None);
        assert_eq!(windows_path(&updated, dir, false).as_deref(), Some(initial));
        assert_eq!(
            windows_path(&format!("\"{dir}\\\";C:\\other"), &dir.to_uppercase(), false).as_deref(),
            Some(r"C:\other")
        );
        assert_eq!(windows_path(initial, dir, false), None);
    }

    #[test]
    fn appimage_uses_the_persistent_image_not_the_mounted_binary() {
        let dir = tempfile::tempdir().unwrap();
        let image = dir.path().join("OpenIDEA.AppImage");
        std::fs::write(&image, "image").unwrap();
        assert_eq!(stable_executable(Path::new("/tmp/.mount_App/usr/bin/openidea"), Some(&image)).unwrap(), image);
        assert_eq!(stable_executable(&image, None).unwrap(), image);
        assert!(stable_executable(Path::new("missing"), None).is_err());
    }

    #[test]
    fn detects_a_system_binary_shadowing_the_linux_wrapper() {
        let dir = tempfile::tempdir().unwrap();
        let system = dir.path().join("system");
        let user = dir.path().join("user");
        for bin in [&system, &user] {
            std::fs::create_dir_all(bin).unwrap();
            std::fs::write(bin.join(COMMAND), "command").unwrap();
        }
        let path = std::env::join_paths([&system, &user]).unwrap();
        assert!(!resolves_to(Some(&path), &user.join(COMMAND)));
        let path = std::env::join_paths([&user, &system]).unwrap();
        assert!(resolves_to(Some(&path), &user.join(COMMAND)));
    }

    #[cfg(unix)]
    #[test]
    fn posix_wrapper_preserves_arguments_and_exit_status() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join("app & it's $dollar `quoted` \"double\"");
        std::fs::write(&exe, "#!/bin/sh\nprintf '%s\\n' \"$@\"\nexit 7\n").unwrap();
        std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).unwrap();
        let path = install_wrapper(&exe, &dir.path().join("bin"), false).unwrap();
        let output = std::process::Command::new(path).args(["a b", "中文", "x'$`&"]).output().unwrap();
        assert_eq!(output.status.code(), Some(7));
        assert_eq!(String::from_utf8(output.stdout).unwrap(), "--cli\na b\n中文\nx'$`&\n");
    }

    #[cfg(windows)]
    #[test]
    fn cmd_wrapper_preserves_arguments_and_exit_status() {
        use std::os::windows::process::CommandExt;
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join("程序 & 100% !special!.exe");
        let source = dir.path().join("helper.rs");
        std::fs::write(
            &source,
            r#"fn main() { for arg in std::env::args().skip(1) { println!("{arg}"); } std::process::exit(7); }"#,
        )
        .unwrap();
        let compiled = std::process::Command::new("rustc")
            .args(["--crate-name", "launcher_test"])
            .arg(&source)
            .arg("-o")
            .arg(&exe)
            .output()
            .unwrap();
        assert!(compiled.status.success(), "{}", String::from_utf8_lossy(&compiled.stderr));
        let path = install_wrapper(&exe, &dir.path().join("bin"), true).unwrap();
        let output = std::process::Command::new("cmd.exe")
            .args(["/d", "/c"])
            .arg(&path)
            .args(["a b", "中文"])
            .raw_arg("\"x&y\"")
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(7));
        assert_eq!(String::from_utf8(output.stdout).unwrap().replace("\r\n", "\n"), "--cli\na b\n中文\nx&y\n");
        let check = dir.path().join("check.cmd");
        std::fs::write(&check, "@echo off\r\nfor /f \"tokens=2 delims=:\" %%c in ('chcp') do set \"before=%%c\"\r\ncall \"%~dp0bin\\openidea.cmd\" example\r\nset \"code=%errorlevel%\"\r\nfor /f \"tokens=2 delims=:\" %%c in ('chcp') do set \"after=%%c\"\r\nif not \"%before%\"==\"%after%\" exit /b 99\r\nexit /b %code%\r\n").unwrap();
        let output = std::process::Command::new("cmd.exe").args(["/d", "/c"]).arg(check).output().unwrap();
        assert_eq!(output.status.code(), Some(7));
    }
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
