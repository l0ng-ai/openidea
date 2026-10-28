//! Child-process helpers shared by every crate that spawns tools.

use std::ffi::{OsStr, OsString};
use std::process::Command;
use std::sync::OnceLock;

/// Windows `CREATE_NO_WINDOW` creation flag, for call sites that combine it
/// with other flags (and then call [`host_env`] themselves). Prefer [`prepare`] otherwise.
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Readies `cmd` for spawning any child (java, node, curl, git, a language server, ...).
/// For a `tokio::process::Command`, pass `cmd.as_std_mut()`.
///
/// - Windows: release builds use the GUI subsystem, so without `CREATE_NO_WINDOW` every
///   console child flashes a `cmd` window.
/// - Linux AppImage: see [`host_env`].
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
/// (WebKit and GTK still need it). Variables the call site has already set are kept.
/// A no-op outside an AppImage.
pub fn host_env(cmd: &mut Command) -> &mut Command {
    let fixes = appimage_fixes();
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
/// site's own variables. Empty outside an AppImage.
pub fn host_env_fixes() -> Vec<(OsString, Option<OsString>)> {
    appimage_fixes()
}

/// This process's environment as a child should inherit it (see [`host_env`]), for call
/// sites that build a child's environment from the IDE's own instead of inheriting it.
pub fn host_vars() -> impl Iterator<Item = (OsString, OsString)> {
    let fixes = appimage_fixes();
    std::env::vars_os().filter_map(move |(k, v)| match fixes.iter().find(|(f, _)| *f == k) {
        Some((_, fixed)) => fixed.clone().map(|v| (k, v)),
        None => Some((k, v)),
    })
}

/// [`std::env::var_os`] as a child should see it (see [`host_env`]).
pub fn host_var_os(key: impl AsRef<OsStr>) -> Option<OsString> {
    let key = key.as_ref();
    match appimage_fixes().into_iter().find(|(k, _)| k == key) {
        Some((_, fixed)) => fixed,
        None => std::env::var_os(key),
    }
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

static SHELL_ENV: OnceLock<Vec<(OsString, OsString)>> = OnceLock::new();

/// Records the login shell's environment, read once at startup off the main thread.
pub fn set_shell_env(vars: Vec<(OsString, OsString)>) {
    let _ = SHELL_ENV.set(vars);
}

/// The login shell's variables this process lacks: an app started from Finder/Dock gets only
/// PATH from the shell, not what rc files export (API keys and provider switches, SDK homes...).
/// Apply before a call site's own variables so those win. Empty until the shell has been read.
pub fn shell_env() -> impl Iterator<Item = (&'static OsStr, &'static OsStr)> {
    SHELL_ENV
        .get()
        .into_iter()
        .flatten()
        .filter(|(k, _)| std::env::var_os(k).is_none())
        .map(|(k, v)| (k.as_os_str(), v.as_os_str()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_env_adds_only_what_the_process_lacks() {
        set_shell_env(vec![("OPENIDEA_SHELL_ONLY_VAR".into(), "1".into()), ("PATH".into(), "/from/shell".into())]);
        let vars: Vec<_> = shell_env().collect();
        assert_eq!(vars, [(OsStr::new("OPENIDEA_SHELL_ONLY_VAR"), OsStr::new("1"))]);
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
}
