//! GUI apps launched from Finder/Dock get a minimal PATH. Language servers,
//! git, package managers and run configurations need the user's real one, so
//! on macOS/Linux we take PATH from the login shell at startup.
//!
//! Spawning an interactive login shell costs ~1 s with typical rc files, so the
//! value is cached: a warm start uses the cached PATH immediately and refreshes
//! the cache in the background for the next launch.
//!
//! The rest of the shell's environment (API keys, provider switches, SDK homes)
//! goes to child processes through `ide_core::process::shell_env`. It stays in
//! memory, never in the cache: it may hold secrets.

#[cfg(unix)]
use std::ffi::{OsStr, OsString};

#[cfg(unix)]
/// Returns a refresh to run once the environment is final (it spawns a
/// thread, and `set_var` must not race with other threads).
pub fn inherit_login_shell_path(identifier: &str) -> Option<impl FnOnce() + use<>> {
    use std::time::Duration;

    if std::env::var_os("OPENIDEA_SKIP_SHELL_ENV").is_some() {
        return None;
    }
    let cache = dirs::cache_dir().map(|d| d.join(identifier).join("login-path"));
    let cached = cache.as_ref().and_then(|c| std::fs::read_to_string(c).ok()).filter(|p| !p.trim().is_empty());
    let refresh = cached.is_some();
    let path = match cached {
        Some(path) => path,
        None => {
            // Slow shell rc files must not delay the first start indefinitely.
            let env = read_login_env(Duration::from_secs(3))?;
            let fresh = login_path(&env)?;
            ide_core::process::set_shell_env(env);
            if let Some(cache) = &cache {
                write_cache(cache, &fresh);
            }
            fresh
        }
    };
    // SAFETY: called at startup before any other thread reads the environment.
    unsafe { std::env::set_var("PATH", path.trim()) };
    let cache = cache.filter(|_| refresh)?;
    Some(move || {
        std::thread::spawn(move || {
            let Some(env) = read_login_env(Duration::from_secs(10)) else { return };
            if let Some(fresh) = login_path(&env) {
                write_cache(&cache, &fresh);
            }
            ide_core::process::set_shell_env(env);
        });
    })
}

#[cfg(unix)]
fn write_cache(cache: &std::path::Path, path: &str) {
    if let Some(dir) = cache.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(cache, path);
}

#[cfg(unix)]
fn login_path(env: &[(OsString, OsString)]) -> Option<String> {
    env.iter().find(|(k, _)| k == "PATH").and_then(|(_, v)| v.to_str()).filter(|p| !p.is_empty()).map(str::to_owned)
}

/// Variables the shell sets for itself rather than the user's configuration.
#[cfg(unix)]
const SHELL_OWN: &[&str] = &["PWD", "OLDPWD", "SHLVL", "_"];

/// The login shell's environment; PATH included, the shell's own bookkeeping left out.
#[cfg(unix)]
fn read_login_env(timeout: std::time::Duration) -> Option<Vec<(OsString, OsString)>> {
    use std::io::Read;
    use std::os::unix::ffi::OsStrExt;
    use std::process::{Command, Stdio};
    use std::time::Instant;

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    const MARK: &str = "__OPENIDEA_ENV__";
    let mut child = ide_core::process::prepare(&mut Command::new(&shell))
        .args(["-ilc", &format!("printf '{MARK}'; /usr/bin/env -0; printf '{MARK}'")])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    // Read while waiting: a large environment would fill the pipe and stall the shell.
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut out = Vec::new();
        stdout.read_to_end(&mut out).map(|_| out)
    });
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(std::time::Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                tracing::warn!("timed out reading the environment from {shell}");
                return None;
            }
        }
    }
    let out = reader.join().ok()?.ok()?;
    let mark = MARK.as_bytes();
    let start = out.windows(mark.len()).position(|w| w == mark)? + mark.len();
    let len = out[start..].windows(mark.len()).position(|w| w == mark)?;
    let vars = out[start..start + len]
        .split(|&b| b == 0)
        .filter_map(|entry| {
            let eq = entry.iter().position(|&b| b == b'=')?;
            let (k, v) = (OsStr::from_bytes(&entry[..eq]), OsStr::from_bytes(&entry[eq + 1..]));
            (!k.is_empty() && !SHELL_OWN.iter().any(|s| k == *s)).then(|| (k.to_owned(), v.to_owned()))
        })
        .collect();
    Some(vars)
}

#[cfg(not(unix))]
pub fn inherit_login_shell_path(_identifier: &str) -> Option<fn()> {
    None
}
