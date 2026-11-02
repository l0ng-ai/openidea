//! Starting server processes: binary resolution and the [`Launcher`] seam.

use ide_core::CancellationToken;
use ide_core::tool_path::search_path;
use ide_jsonrpc::{Handler, Peer};
use ide_language::LanguageServerConfig;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Arc;

#[derive(Debug)]
pub enum LaunchError {
    /// The server binary is not installed / not on `PATH`.
    Missing,
    /// The configuration can't be launched (`LanguageServerConfig::launch_error`).
    Config(String),
    Failed(String),
}

/// Starts a language server and returns a connected peer. The default
/// [`ProcessLauncher`] spawns the configured command; tests substitute
/// in-memory servers.
pub trait Launcher: Send + Sync + 'static {
    fn launch(
        &self,
        config: &LanguageServerConfig,
        root: &Path,
        handler: Arc<dyn Handler>,
        on_stderr: Box<dyn Fn(String) + Send + Sync>,
    ) -> Result<Peer, LaunchError>;

    /// [`Launcher::launch`] that gives up once `cancel` fires (the server was stopped
    /// while still starting). Launchers that return at once need not override it.
    fn launch_cancellable(
        &self,
        config: &LanguageServerConfig,
        root: &Path,
        handler: Arc<dyn Handler>,
        on_stderr: Box<dyn Fn(String) + Send + Sync>,
        cancel: &CancellationToken,
    ) -> Result<Peer, LaunchError> {
        let _ = cancel;
        self.launch(config, root, handler, on_stderr)
    }

    /// Whether `config` could start without a `Missing` error.
    fn available(&self, _config: &LanguageServerConfig, _root: &Path) -> bool {
        true
    }
}

/// Resolves `command` on an augmented `PATH` and spawns it with stdio transport,
/// or for a `connect` server reaches it over TCP (see [`crate::tcp`]).
pub struct ProcessLauncher;

impl Launcher for ProcessLauncher {
    fn launch(
        &self,
        config: &LanguageServerConfig,
        root: &Path,
        handler: Arc<dyn Handler>,
        on_stderr: Box<dyn Fn(String) + Send + Sync>,
    ) -> Result<Peer, LaunchError> {
        self.launch_cancellable(config, root, handler, on_stderr, &CancellationToken::new())
    }

    fn launch_cancellable(
        &self,
        config: &LanguageServerConfig,
        root: &Path,
        handler: Arc<dyn Handler>,
        on_stderr: Box<dyn Fn(String) + Send + Sync>,
        cancel: &CancellationToken,
    ) -> Result<Peer, LaunchError> {
        let search = server_search_path(config);
        let binary = ide_core::tool_path::find_command(&config.command, &search, root)
            .and_then(|b| resolve_rustup_proxy(&config.command, b));
        let mut env: Vec<(String, String)> = vec![("PATH".into(), search.to_string_lossy().into_owned())];
        env.extend(config.env.iter().filter(|(k, _)| *k != "PATH").map(|(k, v)| (k.clone(), v.clone())));
        if let Some(addr) = &config.connect {
            return crate::tcp::connect_or_start(
                config,
                addr,
                binary.as_deref(),
                &env,
                root,
                handler,
                on_stderr,
                cancel,
            );
        }
        let binary = binary.ok_or(LaunchError::Missing)?;
        Peer::spawn(&binary.to_string_lossy(), &config.args, root, &env, handler, on_stderr)
            .map_err(|e| LaunchError::Failed(format!("failed to start {}: {e}", binary.display())))
    }

    fn available(&self, config: &LanguageServerConfig, root: &Path) -> bool {
        ide_core::tool_path::find_command(&config.command, &server_search_path(config), root).is_some()
    }
}

/// A configured `PATH` (e.g. a selected toolchain prepended) also resolves the binary.
fn server_search_path(config: &LanguageServerConfig) -> OsString {
    config.env.get("PATH").map(OsString::from).unwrap_or_else(search_path)
}

/// `~/.cargo/bin/<tool>` is usually a rustup proxy that fails when the active
/// toolchain lacks the component (common for rust-analyzer). In that case use
/// the newest installed toolchain that ships the binary; with none, the tool is
/// missing (an install hint, not a server that crashes on every restart).
fn resolve_rustup_proxy(command: &str, binary: PathBuf) -> Option<PathBuf> {
    let is_proxy = binary.parent().is_some_and(|d| d.ends_with(".cargo/bin"));
    if !is_proxy || command.contains('/') {
        return Some(binary);
    }
    let works = ide_core::process::prepare(&mut std::process::Command::new(&binary))
        .arg("--version")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|s| s.success());
    if works {
        return Some(binary);
    }
    let toolchains = std::env::var_os("RUSTUP_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".rustup")))
        .map(|h| h.join("toolchains"));
    let mut candidates: Vec<(std::time::SystemTime, PathBuf)> = toolchains
        .and_then(|dir| std::fs::read_dir(dir).ok())
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path().join("bin").join(command))
        .filter(|p| p.is_file())
        .filter_map(|p| Some((p.metadata().ok()?.modified().ok()?, p)))
        .collect();
    // Prefer stable-looking toolchains, then the most recently installed.
    candidates.sort_by_key(|(mtime, p)| (!p.to_string_lossy().contains("nightly"), *mtime));
    match candidates.pop() {
        Some((_, path)) => {
            tracing::info!("using {} instead of the rustup proxy", path.display());
            Some(path)
        }
        None => {
            tracing::info!("{} is a rustup proxy without the component", binary.display());
            None
        }
    }
}

/// Workspace root for `file`: the outermost ancestor within `project_root`
/// containing a root marker (so a Cargo/npm workspace gets one server, not one
/// per member), else `project_root`. `None` when `file` is outside the project.
pub fn find_root(project_root: &Path, file: &Path, markers: &[String]) -> Option<PathBuf> {
    if !file.starts_with(project_root) {
        return None;
    }
    Some(marked_root(project_root, file, markers).unwrap_or_else(|| project_root.to_path_buf()))
}

/// The outermost ancestor of `file` within `project_root` containing a root
/// marker (the same lookup as `framework-ui-modes`).
pub fn marked_root(project_root: &Path, file: &Path, markers: &[String]) -> Option<PathBuf> {
    ide_language::marked_root(Some(project_root), file, markers)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn root_detection() {
        let tmp = std::env::temp_dir().join(format!("openidea-lsp-root-{}", std::process::id()));
        let member = tmp.join("crates/a/src");
        std::fs::create_dir_all(&member).unwrap();
        std::fs::write(tmp.join("crates/a/Cargo.toml"), "").unwrap();
        let markers = vec!["Cargo.toml".to_string()];
        let file = member.join("lib.rs");
        assert_eq!(find_root(&tmp, &file, &markers), Some(tmp.join("crates/a")));
        std::fs::write(tmp.join("Cargo.toml"), "").unwrap();
        assert_eq!(find_root(&tmp, &file, &markers), Some(tmp.clone()));
        assert_eq!(find_root(&tmp.join("crates"), &file, &["*.toml".into()]), Some(tmp.join("crates/a")));
        assert_eq!(find_root(&tmp, Path::new("/elsewhere/x.rs"), &markers), None);
        assert_eq!(find_root(&tmp.join("crates"), &tmp.join("crates/b.rs"), &markers), Some(tmp.join("crates")));
        std::fs::remove_dir_all(&tmp).unwrap();
    }

    #[test]
    fn marked_root_needs_a_marker() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let file = root.join("apps/web/src/app.ts");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        let markers = vec!["angular.json".to_string(), "node_modules/@angular/core".to_string()];
        assert_eq!(marked_root(root, &file, &markers), None);
        std::fs::create_dir_all(root.join("apps/web/node_modules/@angular/core")).unwrap();
        assert_eq!(marked_root(root, &file, &markers), Some(root.join("apps/web")));
        assert_eq!(marked_root(root, &root.join("apps/api/main.ts"), &markers), None);
    }

    #[test]
    fn search_path_contains_env_path() {
        let p = search_path();
        let dirs: Vec<PathBuf> = std::env::split_paths(&p).collect();
        // The process's own `PATH` starts the search, then per-user and system dirs.
        let first_env = std::env::split_paths(&std::env::var_os("PATH").unwrap()).find(|d| d.is_absolute()).unwrap();
        assert_eq!(dirs.first(), Some(&first_env), "{dirs:?}");
    }
}

#[cfg(test)]
mod proxy_tests {
    use super::*;

    #[test]
    fn non_proxy_binaries_are_kept() {
        let p = PathBuf::from("/usr/bin/true");
        assert_eq!(resolve_rustup_proxy("true", p.clone()), Some(p));
    }

    /// Exercises the real machine setup when a broken rustup proxy is present.
    #[test]
    #[ignore]
    fn broken_rustup_proxy_falls_back_to_a_toolchain() {
        let home = PathBuf::from(std::env::var_os("HOME").unwrap());
        let proxy = home.join(".cargo/bin/rust-analyzer");
        let resolved = resolve_rustup_proxy("rust-analyzer", proxy.clone()).unwrap();
        eprintln!("resolved: {}", resolved.display());
        assert_ne!(resolved, proxy);
    }
}
