//! Apple clangd accepts `.clang-tidy` projects but ships without clang-tidy checks.

use crate::{LspManager, Server};
use ide_core::IdeEvent;
use std::path::Path;

pub(crate) const MESSAGE: &str = "Apple's clangd does not run clang-tidy, so checks from .clang-tidy are not shown. Install clangd (LLVM) to get them.";

fn is_apple_clangd(path: &Path) -> bool {
    if path == Path::new("/usr/bin/clangd") {
        return true;
    }
    if !path.ends_with("usr/bin/clangd") {
        return false;
    }
    path.starts_with("/Library/Developer/CommandLineTools")
        || path.ancestors().any(|ancestor| {
            ancestor.file_name().is_some_and(|name| name == "Toolchains")
                && ancestor.parent().is_some_and(|developer| {
                    developer.ends_with("Contents/Developer")
                        && developer.parent().and_then(Path::parent).and_then(Path::file_name).is_some_and(|name| {
                            let name = name.to_string_lossy();
                            name.starts_with("Xcode") && name.ends_with(".app")
                        })
                })
        })
}

fn has_config(server_root: &Path, project_root: &Path, file: &Path) -> bool {
    server_root.join(".clang-tidy").is_file()
        || file
            .parent()
            .into_iter()
            .flat_map(Path::ancestors)
            .take_while(|dir| dir.starts_with(project_root))
            .any(|dir| dir.join(".clang-tidy").is_file())
}

impl LspManager {
    pub(crate) async fn check_clang_tidy(&self, server: &Server) {
        if server.name != "clangd"
            || !cfg!(target_os = "macos")
            || self.shown_messages.lock().contains(&("clangd".into(), MESSAGE.into()))
        {
            return;
        }
        let binary = server.resolved_binary.read().clone();
        let Some(binary) = binary else { return };
        let files: Vec<_> = self
            .docs
            .lock()
            .values()
            .filter(|doc| {
                matches!(doc.language.as_str(), "c" | "cpp" | "objective-c" | "objective-cpp")
                    && doc.servers.iter().any(|attached| attached.server.id == server.id)
            })
            .map(|doc| doc.path.clone())
            .collect();
        let root = server.root.clone();
        let Some(me) = self.me.upgrade() else { return };
        let _ = tokio::task::spawn_blocking(move || {
            if !is_apple_clangd(&binary) && !std::fs::canonicalize(&binary).is_ok_and(|path| is_apple_clangd(&path)) {
                return;
            }
            if !me.shutting_down.load(std::sync::atomic::Ordering::Acquire)
                && files.iter().any(|file| has_config(&root, &me.project_root_for(file), file))
                && me.first_message("clangd", MESSAGE)
            {
                me.sink.emit(IdeEvent::LanguageServerWarning {
                    name: "clangd".into(),
                    message: MESSAGE.into(),
                    install_tool: "clangd".into(),
                });
            }
        })
        .await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn apple_paths() {
        for path in [
            "/usr/bin/clangd",
            "/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/clangd",
            "/Applications/Xcode-beta.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/clangd",
            "/Library/Developer/CommandLineTools/usr/bin/clangd",
        ] {
            assert!(is_apple_clangd(Path::new(path)), "{path}");
        }
        for path in [
            "/Users/me/Library/Application Support/openidea/tools/clangd/bin/clangd",
            "/opt/homebrew/opt/llvm/bin/clangd",
            "/usr/local/bin/clangd",
            "/usr/bin/clangd-custom",
            "/Library/Developer/CommandLineTools-custom/usr/bin/clangd",
            "/Applications/Other.app/Contents/Developer/Toolchains/LLVM.xctoolchain/usr/bin/clangd",
        ] {
            assert!(!is_apple_clangd(Path::new(path)), "{path}");
        }
    }

    #[test]
    fn config_in_server_root_or_file_ancestors_stays_inside_project() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("project");
        let server = project.join("build");
        let source = project.join("src/nested");
        let file = source.join("main.cpp");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::create_dir_all(&server).unwrap();
        std::fs::write(dir.path().join(".clang-tidy"), "").unwrap();
        assert!(!has_config(&server, &project, &file));
        for root in [&server, &source, &project.join("src"), &project] {
            let config = root.join(".clang-tidy");
            std::fs::write(&config, "Checks: '-*,modernize-use-nullptr'").unwrap();
            assert!(has_config(&server, &project, &file), "{}", root.display());
            std::fs::remove_file(config).unwrap();
        }
        std::fs::create_dir(source.join(".clang-tidy")).unwrap();
        assert!(!has_config(&server, &project, &file));
    }
}
