//! Diagnostics for the memory indicator / performance overlay.

use crate::commands::doc::blocking;
use crate::state::AppState;
use ide_core::IdeResult;
use ide_core::event::ServerStatus;
use ide_language::SyntaxCacheStats;
use ide_workspace::memory::{self, MemoryCategory, MemoryRoot, ProcessMemory, ProcessTable};
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, State, Window};

#[derive(Clone, Debug, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct StartupMetrics {
    /// Process start → `main`: exec, code-signature scan (seconds for a freshly
    /// linked debug binary on macOS) and dynamic loading; `null` when unknown.
    pub process_to_main_ms: Option<f64>,
    /// Process start → backend set-up (Tauri / WebView boot); `null` when unknown.
    pub process_to_setup_ms: Option<f64>,
    /// Backend set-up (`AppState::new`).
    pub setup_ms: f64,
    /// Process start → first IPC call from the UI.
    pub first_ipc_ms: Option<f64>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AppMetrics {
    /// Resident memory of the backend process (the WebView runs in its own processes).
    pub rss_bytes: Option<u64>,
    /// Bytes allocated through malloc in the backend process (macOS only; there
    /// is no garbage-collected heap).
    pub heap_bytes: Option<u64>,
    /// Physical memory of the machine.
    pub total_memory_bytes: Option<u64>,
    pub uptime_ms: f64,
    pub startup: StartupMetrics,
    /// Open projects (windows with a project).
    pub projects: u32,
    pub open_documents: u32,
    pub index_files: u32,
    pub index_symbols: u32,
    pub indexing: bool,
    /// Language server processes that are starting or running.
    pub language_servers: u32,
    pub syntax: SyntaxCacheStats,
    /// Footprint per process group: the backend and its WebView processes,
    /// each language server (with its child processes), debug adapters, Run
    /// processes and terminals.
    pub memory: Vec<ProcessMemory>,
}

fn ms(d: std::time::Duration) -> f64 {
    d.as_secs_f64() * 1000.0
}

/// Snapshot of process memory and subsystem sizes, summed over all projects.
/// Async: the process walk runs on the blocking pool, not the main thread.
#[tauri::command]
#[specta::specta]
pub async fn app_metrics(app: AppHandle, state: State<'_, AppState>) -> IdeResult<AppMetrics> {
    state.note_ipc();
    let webviews = webview_processes(&app, &state).await;
    let mut m = AppMetrics {
        rss_bytes: ide_workspace::process::resident_bytes(),
        heap_bytes: ide_workspace::process::heap_bytes(),
        total_memory_bytes: ide_workspace::process::total_memory_bytes(),
        uptime_ms: ms(ide_workspace::process::process_age().unwrap_or_else(ide_workspace::process::uptime)),
        startup: StartupMetrics {
            process_to_main_ms: state.startup.process_to_main.map(ms),
            process_to_setup_ms: state.startup.process_to_setup.map(ms),
            setup_ms: ms(state.startup.setup),
            first_ipc_ms: state.startup.first_ipc.get().copied().map(ms),
        },
        ..Default::default()
    };
    let mut roots = webviews;
    for p in state.projects() {
        m.projects += 1;
        m.open_documents += p.documents.open_documents().len() as u32;
        let status = p.index.status();
        m.index_files += status.files;
        m.index_symbols += status.symbols;
        m.indexing |= status.indexing;
        for s in p.lsp.servers() {
            if matches!(s.status, ServerStatus::Starting | ServerStatus::Ready | ServerStatus::Busy) {
                m.language_servers += 1;
            }
            if let Some(pid) = s.pid {
                roots.push(MemoryRoot {
                    pid,
                    category: MemoryCategory::LanguageServer,
                    label: s.name,
                    // A project can attach several roots (additional content
                    // roots); name the server's own workspace root, not the
                    // project folder, so rows of one name don't collide.
                    detail: Some(project_name(s.root.as_ref())),
                    with_children: true,
                });
            }
        }
        let s = p.syntax.stats();
        m.syntax.documents += s.documents;
        m.syntax.trees += s.trees;
        m.syntax.tree_text_bytes += s.tree_text_bytes;
        m.syntax.hits += s.hits;
        m.syntax.incremental_parses += s.incremental_parses;
        m.syntax.full_parses += s.full_parses;
    }
    for r in state.processes.list().into_iter().filter(|r| r.running) {
        if let Some(pid) = r.pid {
            roots.push(process_root(pid, r.name, "Run"));
        }
    }
    for t in state.terminals.list() {
        if let Some(pid) = t.pid {
            roots.push(process_root(pid, t.title, "Terminal"));
        }
    }
    m.memory = blocking(move || {
        let table = ProcessTable::snapshot();
        let me = std::process::id();
        if !roots.iter().any(|r| r.category == MemoryCategory::App) {
            roots.splice(
                0..0,
                memory::responsible_webkit_helpers(&table, me)
                    .into_iter()
                    .map(|(pid, label)| openidea_root(pid, label.into(), None)),
            );
        }
        Ok(memory::attribute(&table, me, &roots, memory::footprint_bytes))
    })
    .await?;
    Ok(m)
}

fn own_footprint() -> Option<u64> {
    memory::footprint_bytes(std::process::id()).or_else(ide_workspace::process::resident_bytes)
}

fn project_name(root: &std::path::Path) -> String {
    root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| root.display().to_string())
}

fn process_root(pid: u32, label: String, kind: &str) -> MemoryRoot {
    MemoryRoot { pid, category: MemoryCategory::Process, label, detail: Some(kind.into()), with_children: true }
}

fn openidea_root(pid: u32, label: String, detail: Option<String>) -> MemoryRoot {
    MemoryRoot { pid, category: MemoryCategory::App, label, detail, with_children: false }
}

/// WebKit WebContent processes per window, then the shared GPU and Networking
/// processes, asked from each `WKWebView` on the main thread. A window that
/// does not answer within the deadline is skipped for this sample.
#[cfg(target_os = "macos")]
async fn webview_processes(app: &AppHandle, state: &AppState) -> Vec<MemoryRoot> {
    use std::collections::BTreeMap;
    use std::time::Duration;
    use tauri::Manager;
    let mut pending = Vec::new();
    for (label, w) in app.webview_windows() {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let sent = w.with_webview(move |pv| {
            // SAFETY: `with_webview` runs on the main thread with the live WKWebView.
            let _ = tx.send(unsafe { memory::webkit_process_ids(pv.inner()) });
        });
        if sent.is_ok() {
            pending.push((label, rx));
        }
    }
    let mut content: BTreeMap<u32, Vec<String>> = BTreeMap::new();
    let mut shared: BTreeMap<u32, &'static str> = BTreeMap::new();
    for (label, rx) in pending {
        let Ok(Ok(pids)) = tokio::time::timeout(Duration::from_millis(500), rx).await else { continue };
        let window = if label.starts_with("settings") {
            "Settings".to_owned()
        } else {
            state.project(&label).map(|p| project_name(&p.root)).unwrap_or_else(|_| "Welcome".to_owned())
        };
        if pids.web_content != 0 {
            content.entry(pids.web_content).or_default().push(window);
        }
        if pids.gpu != 0 {
            shared.insert(pids.gpu, "GPU");
        }
        if pids.networking != 0 {
            shared.insert(pids.networking, "Networking");
        }
    }
    let mut roots: Vec<MemoryRoot> = content
        .into_iter()
        .map(|(pid, mut windows)| {
            windows.sort();
            openidea_root(pid, "Web content".into(), Some(windows.join(", ")))
        })
        .collect();
    let mut shared: Vec<(u32, &str)> = shared.into_iter().collect();
    shared.sort_by_key(|(_, label)| *label);
    roots.extend(shared.into_iter().map(|(pid, label)| openidea_root(pid, label.into(), None)));
    roots
}

/// WebKitGTK / WebView2 helpers are our children; `attribute` finds them.
#[cfg(not(target_os = "macos"))]
async fn webview_processes(_app: &AppHandle, _state: &AppState) -> Vec<MemoryRoot> {
    Vec::new()
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClearCachesResult {
    /// Syntax trees dropped (they are rebuilt on demand).
    pub syntax_trees: u32,
    pub rss_before_bytes: Option<u64>,
    pub rss_after_bytes: Option<u64>,
}

/// "Clear caches": drops syntax trees and EditorConfig files of the window's
/// project, shrinks the in-memory index and compacts its on-disk cache.
#[tauri::command]
#[specta::specta]
pub async fn clear_caches(window: Window, state: State<'_, AppState>) -> IdeResult<ClearCachesResult> {
    let project = state.project(window.label()).ok();
    blocking(move || {
        let rss_before_bytes = own_footprint();
        let mut syntax_trees = 0;
        if let Some(p) = project {
            syntax_trees = p.syntax.clear() as u32;
            p.documents.editorconfig().clear();
            p.index.compact();
        }
        Ok(ClearCachesResult { syntax_trees, rss_before_bytes, rss_after_bytes: own_footprint() })
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Language server rows are named by the server's own workspace root, not
    /// the project folder: one project window can attach additional content
    /// roots, and a server per root would otherwise show up as rows with the
    /// same label and detail (e.g. "pyrefly MindSpeed" twice for MindSpeed +
    /// Megatron-LM).
    #[test]
    fn server_row_detail_is_the_server_root_folder() {
        let project = std::path::Path::new("B:/Program/Project/Ascend/MindSpeed");
        let megatron = std::path::PathBuf::from("B:/Program/Project/Source/Megatron-LM");
        assert_eq!(project_name(project), "MindSpeed");
        assert_ne!(project_name(&megatron), project_name(project));
        // IPC paths are `/`-separated on every OS, so `file_name` sees the
        // folder without a Windows special case.
        assert_eq!(project_name(&megatron), "Megatron-LM");
    }
}
