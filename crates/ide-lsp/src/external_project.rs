//! Give tsserver a project for unopened sources, without creating a config file.
use crate::LspManager;
use crate::server::{Running, Server};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

pub type ExcludesFn = dyn Fn() -> Vec<String> + Send + Sync;
const COMMAND: &str = "typescript.tsserverRequest";
const LIMIT: usize = 10_000;
const SCAN_LIMIT: usize = 100_000;
/// tsserver turns its language service off past 20 MiB of JavaScript in a project.
const SCRIPT_BYTES_LIMIT: u64 = 16 << 20;
const REFRESH_DELAY: Duration = Duration::from_millis(300);
const TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Default)]
pub(crate) struct State {
    generation: u64,
    files: Vec<PathBuf>,
}

fn supported(server: &Server, run: &Running) -> bool {
    server.config.tsserver_project
        && run
            .caps
            .read()
            .raw
            .pointer("/executeCommandProvider/commands")
            .and_then(Value::as_array)
            .is_some_and(|commands| commands.iter().any(|c| c.as_str() == Some(COMMAND)))
}

fn configured(dir: &Path) -> bool {
    ["tsconfig.json", "jsconfig.json"].iter().any(|name| dir.join(name).is_file())
}

fn is_script(ext: &str) -> bool {
    matches!(ext, "js" | "jsx" | "mjs" | "cjs")
}

fn is_source(ext: &str) -> bool {
    is_script(ext) || matches!(ext, "ts" | "tsx" | "mts" | "cts")
}

/// All-or-nothing at the caps: a partial project could displace an inferred
/// project while omitting some of its files. Configured trees stay with tsserver.
fn source_files(root: &Path, exclude_root: &Path, excludes: Vec<String>, limit: usize) -> Vec<PathBuf> {
    if root.ancestors().any(configured) {
        return Vec::new();
    }
    let mut ignores = ignore::gitignore::GitignoreBuilder::new(exclude_root);
    for pattern in excludes {
        if ignores.add_line(None, &pattern).is_err() {
            return Vec::new();
        }
    }
    let Ok(ignores) = ignores.build() else { return Vec::new() };
    let mut walk = ignore::WalkBuilder::new(root);
    walk.require_git(false).follow_links(false).filter_entry(move |entry| {
        if entry.depth() == 0 {
            return true;
        }
        let path = entry.path();
        let name = entry.file_name().to_string_lossy();
        !matches!(name.as_ref(), "node_modules" | "dist" | "build" | "out" | "coverage" | "target" | ".git")
            && !ignores.matched_path_or_any_parents(path, entry.file_type().is_some_and(|t| t.is_dir())).is_ignore()
    });
    let mut files = Vec::new();
    let mut script_bytes = 0;
    for (visited, entry) in walk.build().enumerate() {
        // Do not claim a tree is config-less if we could not inspect it fully.
        let Ok(entry) = entry else { return Vec::new() };
        if visited >= SCAN_LIMIT {
            return Vec::new();
        }
        if entry.file_type().is_some_and(|t| t.is_dir()) && configured(entry.path()) {
            return Vec::new();
        }
        let ext = entry.path().extension().and_then(|s| s.to_str()).unwrap_or_default();
        if entry.file_type().is_some_and(|t| t.is_file()) && is_source(ext) {
            if is_script(ext) {
                script_bytes += entry.metadata().map_or(0, |m| m.len());
                if script_bytes > SCRIPT_BYTES_LIMIT {
                    tracing::debug!("external TypeScript project exceeds its script size; retaining inferred projects");
                    return Vec::new();
                }
            }
            files.push(entry.into_path());
            if files.len() > limit {
                tracing::debug!("external TypeScript project exceeds {limit} files; retaining inferred projects");
                return Vec::new();
            }
        }
    }
    files.sort();
    files
}

fn project_name(server: &Server) -> PathBuf {
    server.root.join(".openidea-external-project")
}

async fn request(run: &Running, command: &str, args: Value) -> bool {
    let request = run.peer.request::<_, Value>(
        "workspace/executeCommand",
        json!({
            "command": COMMAND,
            "arguments": [command, args, { "isAsync": false, "expectsResult": true }]
        }),
        None,
    );
    match tokio::time::timeout(TIMEOUT, request).await {
        Ok(Ok(result)) if result.get("success").and_then(Value::as_bool) == Some(true) => true,
        result => {
            tracing::debug!("tsserver {command}: {result:?}");
            false
        }
    }
}

impl LspManager {
    pub fn set_project_excludes_hook(&self, hook: Box<ExcludesFn>) {
        *self.excludes_hook.write() = Some(Arc::from(hook));
    }

    pub(crate) async fn refresh_external_project(&self, server: &Server, run: &Running) {
        if !supported(server, run) {
            return;
        }
        let mut state = server.external_project.lock().await;
        if state.generation != run.generation {
            *state = State { generation: run.generation, files: Vec::new() };
            server.external_diagnostics.store(false, Ordering::Release);
        }
        let root = server.root.clone();
        let exclude_root = self.project_root_for(&root);
        let hook = self.excludes_hook.read().clone();
        let files = tokio::task::spawn_blocking(move || {
            source_files(&root, &exclude_root, hook.map(|h| h()).unwrap_or_default(), LIMIT)
        })
        .await
        .unwrap_or_default();
        if state.files == files {
            return;
        }
        if files.is_empty() {
            if request(run, "closeExternalProject", json!({ "projectFileName": project_name(server) })).await {
                state.files.clear();
                // Keep suppressing delayed diagnostics for unopened files from this instance.
            }
            return;
        }
        server.external_diagnostics.store(true, Ordering::Release);
        let roots: Vec<_> = files.iter().map(|p| json!({ "fileName": p })).collect();
        if request(
            run,
            "openExternalProject",
            json!({
                "projectFileName": project_name(server), "rootFiles": roots,
                // What an inferred project assumes, so sharing a project changes no diagnostics.
                "options": { "allowJs": true, "target": "ES2022", "module": "ESNext",
                    "moduleResolution": "Node", "allowNonTsExtensions": true, "jsx": "preserve",
                    "allowSyntheticDefaultImports": true, "strictNullChecks": true,
                    "strictFunctionTypes": true, "moduleDetection": "force" }
            }),
        )
        .await
        {
            tracing::debug!(
                "{}: registered {} external project files at {}",
                server.name,
                files.len(),
                server.root.display()
            );
            state.files = files;
        }
    }

    /// Re-registers config-less projects after sources or configurations changed on disk.
    pub fn project_files_changed<'a>(&self, paths: impl IntoIterator<Item = &'a PathBuf>) {
        let relevant = paths.into_iter().any(|p| {
            p.extension().and_then(|s| s.to_str()).is_some_and(is_source)
                || p.file_name().is_some_and(|n| n == "tsconfig.json" || n == "jsconfig.json")
        });
        if !relevant {
            return;
        }
        for server in self.servers.lock().iter().filter(|s| s.config.tsserver_project) {
            if server.external_refresh_queued.swap(true, Ordering::AcqRel) {
                continue;
            }
            let (me, server) = (self.me.clone(), server.clone());
            self.runtime.spawn(async move {
                tokio::time::sleep(REFRESH_DELAY).await;
                server.external_refresh_queued.store(false, Ordering::Release);
                if let (Some(me), Some(run)) = (me.upgrade(), server.running()) {
                    me.refresh_external_project(&server, &run).await;
                }
            });
        }
    }

    pub(crate) async fn close_external_project(&self, server: &Server, run: &Running) {
        let mut state = server.external_project.lock().await;
        if state.generation == run.generation && !state.files.is_empty() {
            request(run, "closeExternalProject", json!({ "projectFileName": project_name(server) })).await;
            state.files.clear();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(root: &Path, path: &str) {
        let path = root.join(path);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, "").unwrap();
    }

    #[test]
    fn selects_sources_honouring_ignores_exclusions_and_roots() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        for path in [
            "a.ts",
            "src/b.js",
            "src/c.tsx",
            "readme.md",
            "node_modules/n.ts",
            "dist/d.js",
            "excluded/e.ts",
            "ignored/i.ts",
            "other/f.py",
        ] {
            write(root, path);
        }
        std::fs::write(root.join(".gitignore"), "ignored/\n").unwrap();
        assert_eq!(
            source_files(root, root, vec!["excluded".into()], LIMIT),
            vec![root.join("a.ts"), root.join("src/b.js"), root.join("src/c.tsx")]
        );
        assert!(source_files(root, root, vec![], 1).is_empty());
        std::fs::File::create(root.join("large.js")).unwrap().set_len(SCRIPT_BYTES_LIMIT + 1).unwrap();
        assert!(source_files(root, root, vec![], LIMIT).is_empty());
        std::fs::remove_file(root.join("large.js")).unwrap();
        std::fs::File::create(root.join("large.ts")).unwrap().set_len(SCRIPT_BYTES_LIMIT + 1).unwrap();
        assert_eq!(source_files(root, root, vec!["excluded".into()], LIMIT).len(), 4);
        std::fs::remove_file(root.join("large.ts")).unwrap();
        assert_eq!(source_files(&root.join("src"), root, vec![], LIMIT).len(), 2);
    }

    #[test]
    fn root_ancestor_and_nested_configs_keep_existing_projects() {
        for name in ["tsconfig.json", "jsconfig.json"] {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path();
            write(root, "a.ts");
            write(root, "pkg/b.js");
            assert_eq!(source_files(root, root, vec![], LIMIT).len(), 2);
            write(root, &format!("pkg/{name}"));
            assert!(source_files(root, root, vec![], LIMIT).is_empty());
            std::fs::remove_file(root.join("pkg").join(name)).unwrap();
            write(root, name);
            assert!(source_files(root, root, vec![], LIMIT).is_empty());
            assert!(source_files(&root.join("pkg"), root, vec![], LIMIT).is_empty());
        }
    }

    #[test]
    fn additions_deletions_and_renames_change_membership() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "a.js");
        let first = source_files(dir.path(), dir.path(), vec![], LIMIT);
        write(dir.path(), "b.ts");
        assert_eq!(source_files(dir.path(), dir.path(), vec![], LIMIT).len(), 2);
        std::fs::rename(dir.path().join("b.ts"), dir.path().join("b.txt")).unwrap();
        assert_eq!(source_files(dir.path(), dir.path(), vec![], LIMIT), first);
        std::fs::remove_file(dir.path().join("a.js")).unwrap();
        assert!(source_files(dir.path(), dir.path(), vec![], LIMIT).is_empty());
    }
}
