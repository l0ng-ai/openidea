//! Window-owned snapshots. A project close drops every report from that window.
use ide_core::{Diagnostic, IpcPath, Range};
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FileProblems {
    pub path: IpcPath,
    pub items: Vec<Diagnostic>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FocusedEditor {
    pub path: IpcPath,
    /// Zero-based lines and UTF-16 columns, end exclusive.
    pub selection: Range,
    pub selected_text: String,
}

#[derive(Default)]
pub struct Reports(RwLock<State>);
#[derive(Default)]
struct State {
    windows: HashMap<String, Window>,
    focused: Option<String>,
    remote: HashMap<String, PathBuf>,
    libraries: HashMap<String, Vec<PathBuf>>,
}
#[derive(Default)]
struct Window {
    editors: Vec<PathBuf>,
    focused: Option<FocusedEditor>,
    problems: BTreeMap<PathBuf, Vec<Diagnostic>>,
}
impl Reports {
    pub fn set_open_editors(&self, window: &str, paths: Vec<PathBuf>) {
        self.0.write().windows.entry(window.into()).or_default().editors = paths;
    }
    pub fn set_focused_editor(&self, window: &str, editor: Option<FocusedEditor>, focused: bool) {
        let mut state = self.0.write();
        state.windows.entry(window.into()).or_default().focused = editor;
        if focused {
            state.focused = Some(window.into());
        }
    }
    pub fn report_problems(&self, window: &str, reset: bool, files: Vec<FileProblems>) {
        let mut state = self.0.write();
        let problems = &mut state.windows.entry(window.into()).or_default().problems;
        if reset {
            problems.clear();
        }
        for file in files {
            let path = file.path.into();
            if file.items.is_empty() {
                problems.remove(&path);
            } else {
                problems.insert(path, file.items);
            }
        }
    }
    pub fn forget_window(&self, window: &str) {
        let mut state = self.0.write();
        state.windows.remove(window);
        state.remote.remove(window);
        state.libraries.remove(window);
        if state.focused.as_deref() == Some(window) {
            state.focused = None;
        }
    }
    pub fn set_remote(&self, window: &str, root: PathBuf) {
        self.0.write().remote.insert(window.into(), root);
    }
    pub fn remove_remote(&self, window: &str) {
        self.0.write().remote.remove(window);
    }
    pub(crate) fn set_libraries(&self, window: &str, roots: Vec<PathBuf>) {
        self.0.write().libraries.insert(window.into(), roots);
    }
    pub(super) fn libraries(&self, windows: &[String]) -> Vec<PathBuf> {
        let state = self.0.read();
        windows.iter().filter_map(|w| state.libraries.get(w)).flatten().cloned().collect()
    }
    pub(super) fn remote_roots(&self) -> Vec<PathBuf> {
        self.0.read().remote.values().cloned().collect()
    }
    pub(super) fn focused_window(&self) -> Option<String> {
        self.0.read().focused.clone()
    }
    pub(super) fn editors(&self, windows: &[String]) -> Vec<PathBuf> {
        let state = self.0.read();
        let mut paths = Vec::new();
        for window in windows.iter().filter_map(|w| state.windows.get(w)) {
            for path in &window.editors {
                if !paths.contains(path) {
                    paths.push(path.clone());
                }
            }
        }
        paths
    }
    pub(super) fn focused(&self, window: &str) -> Option<FocusedEditor> {
        self.0.read().windows.get(window).and_then(|w| w.focused.clone())
    }
    pub(super) fn problems(&self, windows: &[String]) -> Vec<FileProblems> {
        let state = self.0.read();
        let mut files: BTreeMap<PathBuf, Vec<Diagnostic>> = BTreeMap::new();
        for window in windows.iter().filter_map(|w| state.windows.get(w)) {
            for (path, items) in &window.problems {
                let found = files.entry(path.clone()).or_default();
                for item in items {
                    if !found.contains(item) {
                        found.push(item.clone());
                    }
                }
            }
        }
        files.into_iter().map(|(path, items)| FileProblems { path: path.into(), items }).collect()
    }
}
