//! Quick fixes that create, rename or delete files: implement
//! [`FileActions`] and register with `register_plugin!(T, file_actions)` (or
//! `register_plugin!(T, providers, file_actions)`). Declare the `code-actions`
//! kind in `[[contributes.providers]]`; the actions are listed with those of
//! [`crate::providers::Providers::code_actions`] and have the same budget.

use crate::providers::Document;
use crate::types::{Range, TextEdit};

/// A file change a [`FileAction`] makes. Paths are absolute or relative to the
/// project root, and stay inside it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FileOperation {
    /// Fails when the file exists, unless `overwrite`.
    Create {
        path: String,
        text: String,
        overwrite: bool,
    },
    Rename {
        from: String,
        to: String,
    },
    /// Deletes the file; undoing the action restores it.
    Delete {
        path: String,
    },
}

/// Applied as one workspace edit: `operations` in order, then `edits`. If any
/// step fails nothing changes, and one undo reverses all of it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct FileAction {
    pub title: String,
    /// `quickfix`, `refactor`, …
    pub kind: Option<String>,
    pub preferred: bool,
    pub operations: Vec<FileOperation>,
    /// (path, edits) per file; may target files the operations create.
    pub edits: Vec<(String, Vec<TextEdit>)>,
    /// Opened once the action is applied.
    pub open: Option<String>,
}

pub trait FileActions {
    fn file_actions(&mut self, doc: &Document, selection: Range) -> Vec<FileAction>;
}
