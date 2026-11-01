//! Child-process helpers shared by every crate that spawns tools.

use std::ffi::{OsStr, OsString};
use std::process::Command;
use std::sync::{Arc, RwLock};

/// Windows `CREATE_NO_WINDOW` creation flag, for call sites that combine it
/// with other flags (and then call [`host_env`] themselves). Prefer [`prepare`] otherwise.
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Readies `cmd` for spawning any child (java, node, curl, git, a language server, ...).
/// For a `tokio::process::Command`, pass `cmd.as_std_mut()`.
///
/// - Windows: release builds use the GUI subsystem, so without `CREATE_NO_WINDOW` every
///   console child flashes a `cmd` window.
/// - Linux AppImage, reloaded and project variables: see [`host_env`].
///
/// Variables the call site has already set are kept; call it before `env_clear`.
pub fn prepare(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    host_env(cmd)
}

/// Gives `cmd` the host's environment back when the IDE runs from an AppImage. `AppRun` and
/// its hooks point `LD_LIBRARY_PATH`, `PATH`, `XDG_DATA_DIRS`, `GIO_MODULE_DIR`, `GTK_PATH`,
/// `GST_PLUGIN_*`, ... into the mounted image for the IDE itself; a host program that
/// inherits them loads the image's (older) libraries and plugins next to its own, e.g.
/// `curl: symbol lookup error ... nghttp2_...`. The IDE process keeps its environment
/// (WebKit and GTK still need it). Then applies the [`set_env_overlay`] variables and
/// those of a manual HTTP proxy ([`crate::proxy_settings::ProxySettings::child_env`]).
/// Variables the call site has already set are kept. A no-op outside an AppImage
/// without an overlay.
pub fn host_env(cmd: &mut Command) -> &mut Command {
    let fixes = child_env_changes();
    if fixes.is_empty() {
        return cmd;
    }
    let explicit: Vec<OsString> = cmd.get_envs().map(|(k, _)| k.to_owned()).collect();
    for (key, value) in fixes.into_iter().filter(|(k, _)| !explicit.contains(k)) {
        match value {
            Some(v) => cmd.env(key, v),
            None => cmd.env_remove(key),
        };
    }
    cmd
}

/// The [`host_env`] changes as `(name, value)` pairs, `None` meaning "remove", for spawners
/// that are not a `std::process::Command` (a PTY `CommandBuilder`). Apply before the call
/// site's own variables. Empty outside an AppImage without an overlay.
pub fn host_env_fixes() -> Vec<(OsString, Option<OsString>)> {
    child_env_changes()
}

/// This process's environment as a child should inherit it (see [`host_env`]), for call
/// sites that build a child's environment from the IDE's own instead of inheriting it.
pub fn host_vars() -> impl Iterator<Item = (OsString, OsString)> {
    apply_changes(std::env::vars_os().collect(), &child_env_changes()).into_iter()
}

/// [`std::env::var_os`] as a child should see it (see [`host_env`]).
pub fn host_var_os(key: impl AsRef<OsStr>) -> Option<OsString> {
    let key = key.as_ref();
    match child_env_changes().into_iter().find(|(k, _)| k == key) {
        Some((_, fixed)) => fixed,
        None => std::env::var_os(key),
    }
}

/// `vars` with `changes` applied (`None` removes), new names appended.
fn apply_changes(
    mut vars: Vec<(OsString, OsString)>,
    changes: &[(OsString, Option<OsString>)],
) -> Vec<(OsString, OsString)> {
    for (key, value) in changes {
        let at = vars.iter().position(|(k, _)| k == key);
        match (at, value) {
            (Some(i), Some(v)) => vars[i].1 = v.clone(),
            (Some(i), None) => {
                vars.remove(i);
            }
            (None, Some(v)) => vars.push((key.clone(), v.clone())),
            (None, None) => {}
        }
    }
    vars
}

/// The AppImage fixes, the overlay, then the manual proxy's (a later one wins); one entry per name.
fn child_env_changes() -> Vec<(OsString, Option<OsString>)> {
    let mut changes = appimage_fixes();
    let overlay = env_overlay();
    changes.retain(|(k, _)| !overlay.iter().any(|(o, _)| o == k));
    changes.extend(overlay.iter().cloned());
    // A manual HTTP proxy reaches tools that read `HTTP_PROXY` (language servers, git, curl).
    let proxy = crate::proxy_settings::proxy().child_env();
    changes.retain(|(k, _)| !proxy.iter().any(|(p, _)| p == k));
    changes.extend(proxy);
    changes
}

/// Read on every call, not cached: startup rewrites `PATH` (login shell, managed tools).
fn appimage_fixes() -> Vec<(OsString, Option<OsString>)> {
    if !cfg!(target_os = "linux") || std::env::var_os("APPDIR").is_none() {
        return Vec::new();
    }
    appimage_env_fixes(&std::env::vars_os().collect::<Vec<_>>())
}

/// Variables the AppImage runtime sets to describe the IDE's own launch.
const APPIMAGE_LAUNCH_VARS: [&str; 4] = ["APPDIR", "APPIMAGE", "ARGV0", "OWD"];

/// What to change in `vars` (an environment) so a child sees the host's environment rather
/// than the AppImage's: every `:`-separated entry inside `$APPDIR` is dropped (a saved
/// `<NAME>_ORIG` wins when present), variables left empty are removed, and so are the
/// runtime's own launch variables. Nothing changes when `APPDIR` is not set.
fn appimage_env_fixes(vars: &[(OsString, OsString)]) -> Vec<(OsString, Option<OsString>)> {
    let get = |name: &str| vars.iter().find(|(k, _)| k == name).map(|(_, v)| v);
    let Some(appdir) =
        get("APPDIR").and_then(|v| v.to_str()).map(|v| v.trim_end_matches('/')).filter(|v| !v.is_empty())
    else {
        return Vec::new();
    };
    let inside = |entry: &str| entry.strip_prefix(appdir).is_some_and(|rest| rest.is_empty() || rest.starts_with('/'));
    let mut fixes = Vec::new();
    for (key, value) in vars {
        let (Some(name), Some(value)) = (key.to_str(), value.to_str()) else { continue };
        let fixed = if APPIMAGE_LAUNCH_VARS.contains(&name) {
            None
        } else if value.split(':').any(inside) {
            match get(&format!("{name}_ORIG")) {
                Some(orig) => Some(orig.clone()),
                None => {
                    let kept: Vec<&str> = value.split(':').filter(|e| !e.is_empty() && !inside(e)).collect();
                    Some(OsString::from(kept.join(":")))
                }
            }
        } else if name == "GTK_THEME" && value.is_empty() {
            // linuxdeploy-plugin-gtk exports `GTK_THEME="$APPIMAGE_GTK_THEME"`, usually empty.
            None
        } else {
            continue;
        };
        fixes.push((key.clone(), fixed.filter(|v| !v.is_empty())));
    }
    fixes
}

type Vars = Arc<Vec<(OsString, OsString)>>;
type Changes = Arc<Vec<(OsString, Option<OsString>)>>;

static SHELL_ENV: RwLock<Option<Vars>> = RwLock::new(None);
static OVERLAY: RwLock<Option<Changes>> = RwLock::new(None);

/// Records the login shell's environment: read at startup off the main thread, and again
/// by Reload Environment.
pub fn set_shell_env(vars: Vec<(OsString, OsString)>) {
    *SHELL_ENV.write().unwrap_or_else(|e| e.into_inner()) = Some(Arc::new(vars));
}

/// The login shell's environment as last read, all of it (`None` until it has been read).
pub fn login_env() -> Option<Vars> {
    SHELL_ENV.read().unwrap_or_else(|e| e.into_inner()).clone()
}

/// The login shell's variables this process lacks: an app started from Finder/Dock gets only
/// PATH from the shell, not what rc files export (API keys and provider switches, SDK homes...).
/// Apply before a call site's own variables so those win. Empty until the shell has been read.
/// Names the overlay sets are left out: [`host_env`] gives them their value.
pub fn shell_env() -> impl Iterator<Item = (OsString, OsString)> {
    let overlay = env_overlay();
    let vars = login_env().unwrap_or_default();
    let lacking: Vec<_> = vars
        .iter()
        .filter(|(k, _)| std::env::var_os(k).is_none() && !overlay.iter().any(|(o, _)| o == k))
        .cloned()
        .collect();
    lacking.into_iter()
}

/// Variables every child process gets on top of this process's environment (`None`: removed)
/// unless its call site sets them: an environment re-read after startup (this process's own
/// can't change safely once threads run) and the project's (`remoteEnv`). Replaces the
/// previous overlay; children already running keep what they started with.
pub fn set_env_overlay(changes: Vec<(OsString, Option<OsString>)>) {
    *OVERLAY.write().unwrap_or_else(|e| e.into_inner()) = Some(Arc::new(changes));
}

/// The current [`set_env_overlay`] variables.
pub fn env_overlay() -> Changes {
    OVERLAY.read().unwrap_or_else(|e| e.into_inner()).clone().unwrap_or_default()
}

const DEFAULT_PATHEXT: &str = ".COM;.EXE;.BAT;.CMD";

/// File names an executable `name` may have on disk. Unix: the name itself. Windows: the
/// name when it already ends in a `PATHEXT` extension, else the name with each
/// extension (an extensionless file is not executable there).
pub fn executable_names(name: &str, windows: bool, pathext: Option<&str>) -> Vec<String> {
    if !windows {
        return vec![name.to_owned()];
    }
    let exts: Vec<&str> = pathext
        .filter(|p| !p.trim().is_empty())
        .unwrap_or(DEFAULT_PATHEXT)
        .split(';')
        .map(str::trim)
        .filter(|e| e.starts_with('.') && e.len() > 1)
        .collect();
    let lower = name.to_ascii_lowercase();
    if exts.iter().any(|e| lower.ends_with(&e.to_ascii_lowercase())) {
        return vec![name.to_owned()];
    }
    exts.iter().map(|e| format!("{name}{}", e.to_ascii_lowercase())).collect()
}

/// First `search` directory holding `name` (see [`executable_names`]).
pub fn find_executable_in(
    name: &str,
    search: &OsStr,
    windows: bool,
    pathext: Option<&str>,
) -> Option<std::path::PathBuf> {
    let names = executable_names(name, windows, pathext);
    std::env::split_paths(search)
        .filter(|d| !d.as_os_str().is_empty())
        .find_map(|dir| names.iter().map(|n| dir.join(n)).find(|p| p.is_file()))
}

/// [`find_executable_in`] for this platform (`PATHEXT` from the environment).
pub fn find_executable(name: &str, search: &OsStr) -> Option<std::path::PathBuf> {
    let pathext = host_var_os("PATHEXT");
    find_executable_in(name, search, cfg!(windows), pathext.as_deref().and_then(|p| p.to_str()))
}

/// The user's own `PATH` entries on Windows (`HKCU\Environment`), the part of the
/// merged `PATH` a process may not inherit — an IDE started before the variable was
/// edited, or as a different user, sees only the machine entries. `%VAR%` references
/// (`REG_EXPAND_SZ`) are expanded against the current environment. `None` elsewhere:
/// there a login shell already supplies the user's whole `PATH`.
#[cfg(windows)]
pub fn user_path() -> Option<OsString> {
    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::System::Registry::{HKEY, HKEY_CURRENT_USER, KEY_READ, RegCloseKey, RegOpenKeyExW};

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    unsafe {
        let mut key: HKEY = std::ptr::null_mut();
        if RegOpenKeyExW(HKEY_CURRENT_USER, wide("Environment").as_ptr(), 0, KEY_READ, &mut key) != ERROR_SUCCESS {
            return None;
        }
        let value = read_registry_string(key, &wide("Path"));
        RegCloseKey(key);
        value.filter(|v| !v.trim().is_empty()).map(OsString::from)
    }
}

/// The string of value `name` under open `key`: `REG_SZ` as-is, `REG_EXPAND_SZ` expanded
/// against the current environment. `None` when the value is missing or unreadable.
///
/// A `REG_EXPAND_SZ` value's first size query reports the unexpanded size, so a value
/// that grows when expanded is re-read at the size the failed call reports. And the
/// terminating NUL can leak into the read buffer with a stray UTF-16 unit behind it —
/// seen with a `REG_EXPAND_SZ` user `Path`, where it made `env::set_var("PATH", …)`
/// panic with "strings passed to WinAPI cannot contain NULs" — so the text is cut at
/// the first NUL, not just stripped of trailing ones.
#[cfg(windows)]
fn read_registry_string(key: windows_sys::Win32::System::Registry::HKEY, name: &[u16]) -> Option<String> {
    use windows_sys::Win32::Foundation::{ERROR_MORE_DATA, ERROR_SUCCESS};
    use windows_sys::Win32::System::Registry::{RRF_RT_REG_EXPAND_SZ, RRF_RT_REG_SZ, RegGetValueW};

    const FLAGS: u32 = RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ;
    let mut kind = 0u32;
    let mut len = 0u32;
    // SAFETY: `name` is NUL-terminated and the size query writes only `kind` and `len`.
    let status =
        unsafe { RegGetValueW(key, std::ptr::null(), name.as_ptr(), FLAGS, &mut kind, std::ptr::null_mut(), &mut len) };
    if status != ERROR_SUCCESS || len == 0 {
        return None;
    }
    let buf = loop {
        let mut buf = vec![0u16; len as usize / 2 + 1];
        // SAFETY: as above; the buffer holds at least the `len` bytes the call may write.
        let status = unsafe {
            RegGetValueW(key, std::ptr::null(), name.as_ptr(), FLAGS, &mut kind, buf.as_mut_ptr() as *mut _, &mut len)
        };
        if status == ERROR_SUCCESS {
            break buf;
        }
        if status != ERROR_MORE_DATA || len == 0 {
            return None;
        }
    };
    let text = String::from_utf16_lossy(&buf);
    let end = text.find('\0').unwrap_or(text.len());
    Some(text[..end].to_owned())
}

/// The user's own `PATH` entries; `None` outside Windows (see the Windows impl).
#[cfg(not(windows))]
pub fn user_path() -> Option<OsString> {
    None
}

/// `path` followed by the [`user_path`] entries it lacks.
pub fn with_user_path(path: &OsStr) -> OsString {
    user_path().map_or_else(|| path.to_owned(), |user| append_path_entries(path, &user))
}

fn append_path_entries(path: &OsStr, extra: &OsStr) -> OsString {
    let mut dirs: Vec<std::path::PathBuf> = std::env::split_paths(path).filter(|d| !d.as_os_str().is_empty()).collect();
    for dir in std::env::split_paths(extra).filter(|d| !d.as_os_str().is_empty()) {
        if !dirs.contains(&dir) {
            dirs.push(dir);
        }
    }
    std::env::join_paths(dirs).unwrap_or_else(|_| path.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn user_path_reads_the_current_users_path() {
        // This host has a user `Path` only when the test account set one; either way the call
        // must not fail, and a present value is a non-empty `;`-joined list of directories.
        if let Some(path) = user_path() {
            let dirs: Vec<_> = std::env::split_paths(&path).collect();
            assert!(!dirs.is_empty(), "user PATH should hold at least one directory");
        }
    }

    #[cfg(windows)]
    #[test]
    fn registry_strings_expand_and_stay_terminator_free() {
        use windows_sys::Win32::Foundation::ERROR_SUCCESS;
        use windows_sys::Win32::System::Registry::{
            HKEY, HKEY_CURRENT_USER, KEY_READ, KEY_WRITE, REG_EXPAND_SZ, REG_SZ, RegCloseKey, RegCreateKeyExW,
            RegDeleteTreeW, RegSetValueExW,
        };

        fn wide(s: &str) -> Vec<u16> {
            s.encode_utf16().chain(std::iter::once(0)).collect()
        }

        struct TestState {
            key: HKEY,
            name: String,
            variable: String,
            previous: Option<OsString>,
        }
        impl Drop for TestState {
            fn drop(&mut self) {
                // SAFETY: the key belongs to this test; Windows environment mutation is safe.
                unsafe {
                    RegCloseKey(self.key);
                    RegDeleteTreeW(HKEY_CURRENT_USER, wide(&self.name).as_ptr());
                    match &self.previous {
                        Some(value) => std::env::set_var(&self.variable, value),
                        None => std::env::remove_var(&self.variable),
                    }
                }
            }
        }
        let name = format!("Software\\ai.l0ng.openidea.registry-read-test-{}", std::process::id());
        let variable = format!("OPENIDEA_TEST_REGVAR_{}", std::process::id());
        let long = "x".repeat(600);
        let mut key: HKEY = std::ptr::null_mut();
        let opened = unsafe {
            RegCreateKeyExW(
                HKEY_CURRENT_USER,
                wide(&name).as_ptr(),
                0,
                std::ptr::null(),
                0,
                KEY_READ | KEY_WRITE,
                std::ptr::null(),
                &mut key,
                std::ptr::null_mut(),
            )
        };
        assert_eq!(opened, ERROR_SUCCESS, "the test key must be creatable under HKCU\\Software");
        let _cleanup = TestState { key, name, previous: std::env::var_os(&variable), variable: variable.clone() };
        // SAFETY: Windows permits environment mutation. No other test uses this process-specific name.
        unsafe { std::env::set_var(&variable, &long) };
        let set = |value: &str, kind: u32, data: &[u16]| {
            // SAFETY: `key` is open for writing and `data` holds `data.len() * 2` bytes.
            assert_eq!(
                unsafe {
                    RegSetValueExW(
                        key,
                        wide(value).as_ptr(),
                        0,
                        kind,
                        data.as_ptr() as *const _,
                        (data.len() * 2) as u32,
                    )
                },
                ERROR_SUCCESS
            );
        };
        let read = |value: &str| read_registry_string(key, &wide(value));
        set("Plain", REG_SZ, &wide("plain"));
        set("Expand", REG_EXPAND_SZ, &wide(&format!("%{variable}%\\bin")));
        set("ExpandLong", REG_EXPAND_SZ, &wide(&format!("%{variable}%")));
        // Reproduce the reported interior terminator followed by a stale UTF-16 unit.
        set("TrailingGarbage", REG_SZ, &wide("C:\\Zed\\bin\0n"));
        set("ExpandTrailingGarbage", REG_EXPAND_SZ, &wide(&format!("%{variable}%\\bin\0n")));
        set("Empty", REG_SZ, &wide(""));
        let plain = read("Plain");
        let expand = read("Expand");
        let expand_long = read("ExpandLong");
        assert_eq!(plain.as_deref(), Some("plain"));
        assert_eq!(expand.as_deref(), Some(format!("{long}\\bin")).as_deref());
        // Longer than its unexpanded form: needs the re-read at the expanded size.
        assert_eq!(expand_long.as_deref(), Some(long.as_str()));
        assert_eq!(read("TrailingGarbage").as_deref(), Some("C:\\Zed\\bin"));
        assert_eq!(read("ExpandTrailingGarbage").as_deref(), Some(format!("{long}\\bin")).as_deref());
        assert_eq!(read("Empty").as_deref(), Some(""));
        assert_eq!(read("Missing"), None);
    }

    #[test]
    fn append_path_entries_keeps_the_order_and_adds_what_is_missing() {
        let join = |dirs: &[&str]| std::env::join_paths(dirs).unwrap();
        assert_eq!(append_path_entries(&join(&["a", "b"]), &join(&["b", "c"])), join(&["a", "b", "c"]));
        assert_eq!(append_path_entries(OsStr::new(""), &join(&["c"])), join(&["c"]));
    }

    #[test]
    fn shell_env_adds_only_what_the_process_lacks_and_the_overlay_wins() {
        set_shell_env(vec![("OPENIDEA_SHELL_ONLY_VAR".into(), "1".into()), ("PATH".into(), "/from/shell".into())]);
        let vars: Vec<_> = shell_env().collect();
        assert_eq!(vars, [(OsString::from("OPENIDEA_SHELL_ONLY_VAR"), OsString::from("1"))]);

        // The overlay (process-wide too, hence the same test).
        set_shell_env(vec![("OPENIDEA_OVERLAY_A".into(), "shell".into()), ("OPENIDEA_OVERLAY_B".into(), "b".into())]);
        set_env_overlay(vec![
            ("OPENIDEA_OVERLAY_A".into(), Some("project".into())),
            ("PATH".into(), Some("/reloaded".into())),
            ("HOME".into(), None),
        ]);
        let mut cmd = Command::new("true");
        cmd.env("PATH", "/custom");
        host_env(&mut cmd);
        let get = |k: &str| cmd.get_envs().find(|(n, _)| *n == k).map(|(_, v)| v.map(OsStr::to_owned));
        assert_eq!(get("OPENIDEA_OVERLAY_A"), Some(Some("project".into())));
        assert_eq!(get("PATH"), Some(Some("/custom".into())), "the call site's value wins");
        assert_eq!(get("HOME"), Some(None));
        let shell: Vec<_> = shell_env().map(|(k, _)| k).collect();
        assert_eq!(shell, [OsString::from("OPENIDEA_OVERLAY_B")]);
        assert_eq!(host_var_os("PATH"), Some("/reloaded".into()));
        assert!(host_vars().all(|(k, _)| k != "HOME"));
        assert!(host_vars().any(|(k, v)| k == "OPENIDEA_OVERLAY_A" && v == "project"));
        assert_eq!(host_env_fixes().len(), env_overlay().len());
        set_env_overlay(Vec::new());
    }

    #[test]
    fn changes_apply_in_order() {
        let vars = apply_changes(
            env(&[("A", "1"), ("B", "2")]),
            &[("A".into(), Some("3".into())), ("B".into(), None), ("C".into(), Some("4".into())), ("D".into(), None)],
        );
        assert_eq!(vars, env(&[("A", "3"), ("C", "4")]));
    }

    fn env(pairs: &[(&str, &str)]) -> Vec<(OsString, OsString)> {
        pairs.iter().map(|(k, v)| (OsString::from(k), OsString::from(v))).collect()
    }

    fn fixes(pairs: &[(&str, &str)]) -> Vec<(String, Option<String>)> {
        appimage_env_fixes(&env(pairs))
            .into_iter()
            .map(|(k, v)| (k.into_string().unwrap(), v.map(|v| v.into_string().unwrap())))
            .collect()
    }

    fn fix(name: &str, value: Option<&str>) -> (String, Option<String>) {
        (name.to_owned(), value.map(str::to_owned))
    }

    #[test]
    fn appimage_entries_are_dropped_and_host_entries_kept() {
        let got = fixes(&[
            ("APPDIR", "/tmp/.mount_OpenIDabc"),
            (
                "LD_LIBRARY_PATH",
                "/tmp/.mount_OpenIDabc/usr/lib/:/tmp/.mount_OpenIDabc/usr/lib/x86_64-linux-gnu/:/opt/cuda/lib64:/usr/local/lib",
            ),
            ("PATH", "/tmp/.mount_OpenIDabc/usr/bin/:/tmp/.mount_OpenIDabc/usr/sbin/:/usr/local/bin:/usr/bin"),
            ("XDG_DATA_DIRS", "/tmp/.mount_OpenIDabc/usr/share:/usr/share:/usr/local/share:/usr/share"),
            ("HOME", "/home/me"),
            ("JAVA_HOME", "/tmp/.mount_OpenIDabcdef/jdk"),
        ]);
        assert_eq!(
            got,
            [
                fix("APPDIR", None),
                fix("LD_LIBRARY_PATH", Some("/opt/cuda/lib64:/usr/local/lib")),
                fix("PATH", Some("/usr/local/bin:/usr/bin")),
                fix("XDG_DATA_DIRS", Some("/usr/share:/usr/local/share:/usr/share")),
            ]
        );
    }

    #[test]
    fn variables_left_empty_are_removed() {
        // AppRun prepends to an unset variable, leaving a trailing `:`; hooks set single paths.
        let got = fixes(&[
            ("APPIMAGE", "/opt/openidea/OpenIDEA.AppImage"),
            ("APPDIR", "/tmp/.mount_x/"),
            ("ARGV0", "/opt/openidea/OpenIDEA.AppImage"),
            ("OWD", "/home/me"),
            ("LD_LIBRARY_PATH", "/tmp/.mount_x/usr/lib/:/tmp/.mount_x/lib/:"),
            ("GIO_MODULE_DIR", "/tmp/.mount_x/usr/lib/gio/modules"),
            ("GTK_DATA_PREFIX", "/tmp/.mount_x"),
            ("GDK_PIXBUF_MODULE_FILE", "/tmp/.mount_x/usr/lib/gdk-pixbuf-2.0/2.10.0/loaders.cache"),
            ("GST_PLUGIN_SYSTEM_PATH_1_0", "/tmp/.mount_x/usr/lib/gstreamer-1.0"),
            ("GTK_THEME", ""),
        ]);
        let names: Vec<_> = got.iter().filter(|(_, v)| v.is_none()).map(|(k, _)| k.as_str()).collect();
        assert_eq!(
            names,
            [
                "APPIMAGE",
                "APPDIR",
                "ARGV0",
                "OWD",
                "LD_LIBRARY_PATH",
                "GIO_MODULE_DIR",
                "GTK_DATA_PREFIX",
                "GDK_PIXBUF_MODULE_FILE",
                "GST_PLUGIN_SYSTEM_PATH_1_0",
                "GTK_THEME",
            ]
        );
        assert_eq!(names.len(), got.len());
    }

    #[test]
    fn a_saved_original_value_wins() {
        let got = fixes(&[
            ("APPDIR", "/tmp/.mount_x"),
            ("LD_LIBRARY_PATH", "/tmp/.mount_x/usr/lib:/opt/lib"),
            ("LD_LIBRARY_PATH_ORIG", "/opt/lib:/home/me/lib"),
            ("PYTHONHOME", "/tmp/.mount_x/usr"),
            ("PYTHONHOME_ORIG", ""),
        ]);
        assert_eq!(
            got,
            [fix("APPDIR", None), fix("LD_LIBRARY_PATH", Some("/opt/lib:/home/me/lib")), fix("PYTHONHOME", None)]
        );
    }

    #[test]
    fn outside_an_appimage_nothing_changes() {
        let plain = [("LD_LIBRARY_PATH", "/opt/lib:"), ("PATH", "/usr/bin"), ("GTK_THEME", "")];
        assert!(fixes(&plain).is_empty());
        assert!(fixes(&[("APPDIR", ""), ("PATH", "/usr/bin")]).is_empty());
        assert!(fixes(&[("APPDIR", "/"), ("PATH", "/usr/bin")]).is_empty());
    }

    #[test]
    fn host_env_keeps_what_the_call_site_set() {
        let mut cmd = Command::new("true");
        cmd.env("PATH", "/custom");
        prepare(&mut cmd);
        assert_eq!(cmd.get_envs().find(|(k, _)| *k == "PATH").and_then(|(_, v)| v), Some(OsStr::new("/custom")));
    }

    #[test]
    fn find_executable_finds_bare_names_on_the_given_path() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a");
        let b = dir.path().join("b");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        std::fs::write(a.join("agent"), "#!/bin/sh\n").unwrap();
        std::fs::write(b.join("agent.cmd"), "@echo off\n").unwrap();
        let search = std::env::join_paths([&a, &b]).unwrap();
        if cfg!(windows) {
            // The `.cmd` shim wins over a POSIX script `Command` can't start.
            assert_eq!(find_executable("agent", &search), Some(b.join("agent.cmd")));
        } else {
            assert_eq!(find_executable("agent", &search), Some(a.join("agent")));
        }
        assert_eq!(find_executable("nope", &search), None);
    }
}
