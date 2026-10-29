//! The project model that ties documents, settings and history together.

pub mod caches;
pub mod devcontainer;
pub mod documents;
pub mod editorconfig;
pub mod file_defaults;
pub mod file_moves;
pub mod file_refs;
pub mod history;
pub mod memory;
pub mod process;
pub mod recent;
pub mod roots;
pub mod settings;
pub mod text_refs;

pub use documents::{DetectLanguage, DocumentInfo, Documents, TextSnapshot};
pub use editorconfig::{EditorConfig, EditorConfigProps};
pub use file_defaults::FileDefaults;
pub use file_moves::{FileMove, FileMoves, UndoOutcome};
pub use history::{DirectoryHistory, HistoryEntry, HistoryKind, LocalHistory, Retention};
pub use recent::{RecentProject, RecentProjects};
pub use roots::{ProjectRoots, RootKind, SourceFolder};
pub use settings::{SettingsScope, SettingsStore};

#[cfg(test)]
mod assertions {
    fn send_sync<T: Send + Sync>() {}

    #[test]
    fn types_are_thread_safe() {
        send_sync::<super::Documents>();
        send_sync::<super::LocalHistory>();
        send_sync::<super::RecentProjects>();
        send_sync::<super::SettingsStore>();
    }
}
