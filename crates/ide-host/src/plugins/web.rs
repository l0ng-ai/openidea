//! Web views: a view or custom editor whose UI is a web page shipped in the
//! package (`web = "web/index.html"`) instead of content the plugin's code
//! renders.
//!
//! The entry's directory is the page's root. Every file under it is part of
//! the declaration: it is checked when the package is prepared (count, size,
//! no links leaving the package), copied on install and covered by the
//! package digest and signature. The client loads the page in a sandboxed
//! frame (an opaque origin with no network and no IDE API) and fetches its
//! files through [`PluginHost::web_file`] (the desktop's `openidea-plugin`
//! URL scheme); the page talks to the IDE only through the frame bridge.

use super::PluginHost;
use ide_core::{IdeError, IdeResult};
use ide_extension::{Package, check_relative};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::{Component, Path, PathBuf};

/// Most files under one web root.
const MAX_FILES: usize = 4096;
/// Most bytes under one web root.
const MAX_BYTES: u64 = 256 << 20;
/// Deepest directory nesting under a web root.
const MAX_DEPTH: usize = 16;

/// Checks a declaration's `web` entry: an `.html` file inside a directory of
/// the package (the directory is what the page can load, so it can't be the
/// package root), and everything under that directory. Returns those files,
/// package-relative.
pub(super) fn web_files(pkg: &Package, entry: &str, what: &str) -> Result<Vec<PathBuf>, String> {
    let path = Path::new(entry);
    check_relative(path, "web")?;
    if entry.contains('\\') || !entry.to_ascii_lowercase().ends_with(".html") {
        return Err(format!("{what}: `web` names an .html file, `/`-separated ({entry:?})"));
    }
    let dir = path.parent().filter(|d| !d.as_os_str().is_empty()).ok_or_else(|| {
        format!("{what}: put the page in a directory of its own (`web/index.html`): the directory is what it can load")
    })?;
    let real_entry = pkg.resolve(path)?;
    if !real_entry.is_file() {
        return Err(format!("{what}: {entry} is not a file"));
    }
    let root = pkg.resolve(dir)?;
    let mut files = Vec::new();
    let mut total = 0u64;
    let mut stack = vec![(root.clone(), dir.to_path_buf(), 0usize)];
    while let Some((real, rel, depth)) = stack.pop() {
        let mut entries: Vec<_> =
            std::fs::read_dir(&real).map_err(|e| format!("{}: {e}", rel.display()))?.filter_map(Result::ok).collect();
        entries.sort_by_key(|e| e.file_name());
        for e in entries {
            let name = e.file_name();
            let rel = rel.join(&name);
            // Links could point anywhere: only what is really in the package counts.
            let ty = e.file_type().map_err(|err| format!("{}: {err}", rel.display()))?;
            if ty.is_symlink() {
                return Err(format!("{what}: {} is a link; web files must be real files", rel.display()));
            }
            if ty.is_dir() {
                if depth + 1 > MAX_DEPTH {
                    return Err(format!("{what}: {} is nested deeper than {MAX_DEPTH} directories", rel.display()));
                }
                stack.push((e.path(), rel, depth + 1));
                continue;
            }
            if name.to_string_lossy() == ".DS_Store" {
                continue;
            }
            let len = e.metadata().map_err(|err| format!("{}: {err}", rel.display()))?.len();
            if len > ide_extension::MAX_PACKAGE_FILE {
                return Err(format!(
                    "{what}: {} is larger than {} MiB",
                    rel.display(),
                    ide_extension::MAX_PACKAGE_FILE >> 20
                ));
            }
            total += len;
            files.push(rel);
            if files.len() > MAX_FILES || total > MAX_BYTES {
                return Err(format!(
                    "{what}: {} holds more than {MAX_FILES} files or {} MiB",
                    dir.display(),
                    MAX_BYTES >> 20
                ));
            }
        }
    }
    files.sort();
    Ok(files)
}

/// The page of a web view, for the client to load in its frame.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WebPage {
    /// `<plugin id>/<revision>/<entry>` under the `openidea-plugin` scheme. The
    /// revision changes with the installed package, so a cached file is never
    /// stale; relative URLs in the page resolve to the package's files.
    pub path: String,
}

/// A web frame's API 1.3 PTY request. The frame never supplies an executable path or cwd.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WebPtyCommand {
    pub program: String,
    pub args: Vec<String>,
    pub env: std::collections::BTreeMap<String, String>,
    pub cols: u16,
    pub rows: u16,
}

pub(super) struct WebPtySession {
    id: ide_core::TerminalId,
    host: std::sync::Weak<crate::Host>,
    window: String,
}

/// A file of a web view.
pub struct WebFile {
    pub bytes: Vec<u8>,
    pub mime: &'static str,
}

impl PluginHost {
    /// Uses the normal PTY backend, without user shell fallback or startup commands.
    #[allow(clippy::too_many_arguments)]
    pub fn spawn_web_pty(
        &self,
        host: &std::sync::Arc<crate::Host>,
        plugin_id: &str,
        view: &str,
        window: &str,
        command: WebPtyCommand,
        output: crate::ops::Emit<String>,
    ) -> IdeResult<ide_terminal::TerminalInfo> {
        let _guard = self.lifecycle.lock();
        let mut sessions = self.web_ptys.lock();
        if self.shared.client_closed(window) {
            return Err(IdeError::cancelled());
        }
        let options = self.web_pty_options(plugin_id, view, window, command)?;
        let entries = sessions.entry(plugin_id.to_owned()).or_default();
        entries.retain(|s| s.host.upgrade().is_some_and(|h| h.terminals.contains(s.id)));
        if entries.len() >= 8 {
            return Err(IdeError::invalid("a plugin may own at most 8 PTYs"));
        }
        let cwd = options.cwd.0.clone();
        let info = host.terminals.spawn_program(
            options,
            host.owner_window(window).to_owned(),
            host.window_sink(window),
            Box::new(move |data| output(data)),
        )?;
        if !self
            .shared
            .workspace()
            .is_some_and(|workspace| workspace.project_of(window).as_ref() == Some(&cwd) && workspace.trusted(&cwd))
        {
            let _ = host.terminals.kill(info.id);
            return Err(IdeError::cancelled());
        }
        entries.push(WebPtySession { id: info.id, host: std::sync::Arc::downgrade(host), window: window.to_owned() });
        Ok(info)
    }

    pub(super) fn forget_web_ptys(&self, window: &str) {
        for sessions in self.web_ptys.lock().values_mut() {
            sessions.retain(|session| {
                if session.window != window {
                    return true;
                }
                if let Some(host) = session.host.upgrade() {
                    let _ = host.terminals.kill(session.id);
                }
                false
            });
        }
    }

    pub(super) fn stop_web_ptys(&self, plugin: &str) {
        if let Some(sessions) = self.web_ptys.lock().remove(plugin) {
            for session in sessions {
                if let Some(host) = session.host.upgrade() {
                    let _ = host.terminals.kill(session.id);
                }
            }
        }
    }

    /// Authorizes a PTY immediately before spawning through the existing terminal backend.
    pub fn web_pty_options(
        &self,
        plugin_id: &str,
        view: &str,
        window: &str,
        command: WebPtyCommand,
    ) -> IdeResult<ide_terminal::TerminalOptions> {
        self.web_page(plugin_id, view)?;
        let plugin = self.get(plugin_id)?;
        plugin.pkg.manifest.needs_api("web view PTYs", 3).map_err(IdeError::invalid)?;
        let cap = ide_extension::Capability::Process(command.program.clone());
        if !plugin.meta.lock().granted.contains(&cap) {
            return Err(IdeError::new(
                ide_core::error::ErrorKind::PermissionDenied,
                format!("{cap} capability not granted"),
            ));
        }
        if command.program.is_empty()
            || command.program.len() > 256
            || command.program.trim() != command.program
            || command.program.contains(['\0', '\r', '\n'])
            || command.args.len() > 256
            || command.args.iter().any(|a| a.len() > 4096 || a.contains('\0'))
            || !(2..=500).contains(&command.cols)
            || !(1..=500).contains(&command.rows)
        {
            return Err(IdeError::invalid("invalid PTY program, arguments or dimensions"));
        }
        if command.env.len() > 64
            || command.env.iter().any(|(k, v)| {
                k.is_empty()
                    || k.len() > 256
                    || k.contains(['=', '\0'])
                    || v.len() > 4096
                    || v.contains('\0')
                    || std::env::vars_os().any(|(inherited, _)| {
                        if cfg!(windows) {
                            inherited.to_string_lossy().eq_ignore_ascii_case(k)
                        } else {
                            inherited == k.as_str()
                        }
                    })
            })
        {
            return Err(IdeError::invalid("PTY environment may only add variables, within the size limits"));
        }
        let workspace = self.shared.workspace().ok_or_else(|| IdeError::unavailable("no workspace"))?;
        let cwd = workspace.project_of(window).ok_or_else(|| IdeError::invalid("no project in this window"))?;
        if !cwd.is_absolute() || !cwd.is_dir() {
            return Err(IdeError::invalid("the project directory no longer exists"));
        }
        if !workspace.trusted(&cwd) {
            return Err(IdeError::new(ide_core::error::ErrorKind::PermissionDenied, "project is not trusted"));
        }
        let program = self.program_for(plugin_id, &command.program)?;
        Ok(ide_terminal::TerminalOptions {
            cwd: cwd.into(),
            shell: Some(program.to_string_lossy().into_owned()),
            args: command.args,
            env: command.env,
            cols: command.cols,
            rows: command.rows,
            shell_integration: false,
        })
    }

    /// The web roots `plugin` declares (entry directories, package-relative, `/`-terminated).
    fn web_dirs(&self, plugin: &str) -> Vec<String> {
        [super::ui_points::VIEWS, super::ui_points::CUSTOM_EDITORS]
            .iter()
            .flat_map(|point| self.ui.items(point, Some(plugin)))
            .filter_map(|item| item.decl.get("web").and_then(|w| w.as_str()).map(str::to_owned))
            .filter_map(|entry| entry.rsplit_once('/').map(|(dir, _)| format!("{dir}/")))
            .collect()
    }

    /// Changes whenever the installed package does (cache key of its web files).
    fn web_revision(&self, plugin: &super::LoadedPlugin) -> String {
        let digest = plugin.pkg.digest.as_deref().unwrap_or_default();
        let short: String = digest.chars().filter(char::is_ascii_alphanumeric).take(16).collect();
        if short.is_empty() { format!("v{}", plugin.pkg.manifest.version) } else { short }
    }

    /// The page of `plugin`'s view or custom editor `view`.
    pub fn web_page(&self, plugin_id: &str, view: &str) -> IdeResult<WebPage> {
        let plugin = self.get(plugin_id)?;
        if !plugin.status().is_live() {
            return Err(IdeError::unavailable(format!("plugin {plugin_id:?} is not enabled")));
        }
        let entry = [super::ui_points::VIEWS, super::ui_points::CUSTOM_EDITORS]
            .iter()
            .flat_map(|point| self.ui.items(point, Some(plugin_id)))
            .find(|item| item.key == view)
            .and_then(|item| item.decl.get("web").and_then(|w| w.as_str()).map(str::to_owned))
            .ok_or_else(|| IdeError::not_found(format!("plugin {plugin_id:?} has no web view {view:?}")))?;
        Ok(WebPage { path: format!("{plugin_id}/{}/{entry}", self.web_revision(&plugin)) })
    }

    /// A file of one of `plugin`'s web views: `path` is `<revision>/<package path>`
    /// as [`WebPage::path`] makes them. Only files under a declared web root
    /// of a live plugin are served; the revision must be the installed one.
    pub fn web_file(&self, plugin_id: &str, path: &str) -> IdeResult<WebFile> {
        let plugin = self.get(plugin_id)?;
        if !plugin.status().is_live() {
            return Err(IdeError::unavailable(format!("plugin {plugin_id:?} is not enabled")));
        }
        let (revision, rel) = path.split_once('/').ok_or_else(|| IdeError::not_found(path.to_owned()))?;
        if revision != self.web_revision(&plugin) {
            return Err(IdeError::not_found(format!("{path}: not the installed version")));
        }
        let rel_path = Path::new(rel);
        if !rel_path.components().all(|c| matches!(c, Component::Normal(_))) {
            return Err(IdeError::invalid(format!("{rel}: not a plain relative path")));
        }
        if !self.web_dirs(plugin_id).iter().any(|dir| rel.starts_with(dir.as_str())) {
            return Err(IdeError::not_found(format!("{rel}: not part of a web view")));
        }
        let bytes = plugin.pkg.read_bytes(rel_path).map_err(IdeError::not_found)?;
        Ok(WebFile { bytes, mime: mime(rel) })
    }
}

/// Content type by extension; unknown files are opaque bytes (never sniffed as script).
pub fn mime(path: &str) -> &'static str {
    let ext = path.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default();
    match ext.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" | "cjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json",
        "wasm" => "application/wasm",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "txt" | "md" => "text/plain; charset=utf-8",
        "mp3" => "audio/mpeg",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ide_extension::Manifest;

    fn pkg(dir: &Path) -> Package {
        let src = "id = \"p\"\nname = \"P\"\nversion = \"1.0.0\"\nengines.openidea = \"^1.0\"\n";
        Package::new(Manifest::parse(src).unwrap(), dir.to_path_buf())
    }

    #[test]
    fn a_web_root_is_its_directory_and_nothing_else() {
        let tmp = tempfile::tempdir().unwrap();
        let d = tmp.path();
        std::fs::create_dir_all(d.join("web/assets/fonts")).unwrap();
        std::fs::write(d.join("web/index.html"), "<p>hi</p>").unwrap();
        std::fs::write(d.join("web/assets/app.js"), "1").unwrap();
        std::fs::write(d.join("web/assets/fonts/a.woff2"), "f").unwrap();
        std::fs::write(d.join("web/.DS_Store"), "x").unwrap();
        std::fs::write(d.join("secret.txt"), "no").unwrap();
        let files = web_files(&pkg(d), "web/index.html", "v").unwrap();
        let files: Vec<String> = files.iter().map(|f| f.to_string_lossy().replace('\\', "/")).collect();
        assert_eq!(files, ["web/assets/app.js", "web/assets/fonts/a.woff2", "web/index.html"]);

        std::fs::write(d.join("index.html"), "x").unwrap();
        let err = |entry: &str| web_files(&pkg(d), entry, "v").err().unwrap_or_default();
        assert!(err("index.html").contains("directory of its own"), "{}", err("index.html"));
        assert!(err("web/app.js").contains(".html"));
        assert!(err("../web/index.html").contains("relative"));
        assert!(err("web/missing.html").contains("no such file"));
    }

    #[cfg(unix)]
    #[test]
    fn links_out_of_a_web_root_are_refused() {
        let tmp = tempfile::tempdir().unwrap();
        let d = tmp.path();
        std::fs::create_dir_all(d.join("web")).unwrap();
        std::fs::write(d.join("web/index.html"), "x").unwrap();
        std::os::unix::fs::symlink("/etc/hosts", d.join("web/hosts")).unwrap();
        assert!(web_files(&pkg(d), "web/index.html", "v").unwrap_err().contains("is a link"));
    }

    #[test]
    fn content_types_never_make_unknown_files_scripts() {
        assert_eq!(mime("a/b.JS"), "text/javascript; charset=utf-8");
        assert_eq!(mime("x.woff2"), "font/woff2");
        assert_eq!(mime("x.wasm"), "application/wasm");
        assert_eq!(mime("x.bin"), "application/octet-stream");
        assert_eq!(mime("noext"), "application/octet-stream");
    }
}
