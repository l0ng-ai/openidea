//! Reference updates for moved files from vtsls, which has no `workspace/willRenameFiles`:
//! it updates imports itself after `didRenameFiles`, behind a prompt the client answers. The
//! IDE asks tsserver for the same edits up front (`getEditsForFileRename`, through
//! `typescript.tsserverRequest`), so they join the move's preview and undo, and the server's
//! own update is off (`updateImportsOnFileMove.enabled = "never"` in `languages/*.toml`).

use ide_core::{FileEdit, Pos, Range, TextEdit, WorkspaceEdit};
use serde::Deserialize;
use serde_json::{Value, json};
use std::path::PathBuf;

pub(crate) const COMMAND: &str = "typescript.tsserverRequest";

/// The `typescript.tsserverRequest` arguments asking for the edits of moving `from` to `to`.
pub(crate) fn request(from: &std::path::Path, to: &std::path::Path) -> Value {
    json!({
        "command": COMMAND,
        "arguments": ["getEditsForFileRename", { "oldFilePath": from, "newFilePath": to }],
    })
}

#[derive(Deserialize)]
struct Location {
    line: u32,
    offset: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Change {
    start: Location,
    end: Location,
    new_text: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileChanges {
    file_name: PathBuf,
    text_changes: Vec<Change>,
}

/// tsserver's `FileCodeEdits[]` (the command's `body`; 1-based lines and UTF-16 offsets) as an edit.
pub(crate) fn edit(result: &Value) -> WorkspaceEdit {
    let body = result.get("body").unwrap_or(result);
    let files: Vec<FileChanges> = serde_json::from_value(body.clone()).unwrap_or_default();
    let pos = |l: &Location| Pos::new(l.line.saturating_sub(1), l.offset.saturating_sub(1));
    WorkspaceEdit {
        files: files
            .into_iter()
            .filter(|f| !f.text_changes.is_empty())
            .map(|f| FileEdit::Edit {
                path: f.file_name.into(),
                edits: f
                    .text_changes
                    .into_iter()
                    .map(|c| TextEdit { range: Range::new(pos(&c.start), pos(&c.end)), new_text: c.new_text })
                    .collect(),
                version: None,
            })
            .collect(),
        preconditions: Vec::new(),
    }
}

#[derive(Deserialize)]
struct FileReference {
    file: PathBuf,
    start: Location,
    end: Location,
}

#[derive(Deserialize)]
struct FileReferences {
    refs: Vec<FileReference>,
}

/// tsserver's `fileReferences` answer (the command's `body`; 1-based lines and UTF-16 offsets): the imports of a file.
pub(crate) fn file_references(result: &Value) -> Vec<ide_core::Location> {
    let body = result.get("body").unwrap_or(result);
    let Ok(found) = serde_json::from_value::<FileReferences>(body.clone()) else { return Vec::new() };
    let pos = |l: &Location| Pos::new(l.line.saturating_sub(1), l.offset.saturating_sub(1));
    found
        .refs
        .into_iter()
        .map(|r| ide_core::Location { path: r.file.into(), range: Range::new(pos(&r.start), pos(&r.end)), uri: None })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_tsserver_file_references() {
        let result = json!({ "success": true, "body": { "symbolName": "\"./Hello.vue\"", "refs": [
            { "file": "/p/src/App.vue", "start": { "line": 2, "offset": 19 }, "end": { "line": 2, "offset": 41 },
              "lineText": "import Hello from './components/Hello.vue'", "isWriteAccess": false }
        ] } });
        let refs = file_references(&result);
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].path, ide_core::IpcPath::from(PathBuf::from("/p/src/App.vue")));
        assert_eq!(refs[0].range, Range::new(Pos::new(1, 18), Pos::new(1, 40)));
        assert!(file_references(&json!({ "success": false })).is_empty());
    }

    #[test]
    fn converts_tsserver_file_code_edits() {
        let result = json!({ "success": true, "body": [
            { "fileName": "/p/src/index.ts", "textChanges": [
                { "start": { "line": 2, "offset": 31 }, "end": { "line": 2, "offset": 41 }, "newText": "./lib/money.ts" }
            ] },
            { "fileName": "/p/src/unchanged.ts", "textChanges": [] }
        ] });
        let edit = edit(&result);
        assert_eq!(edit.files.len(), 1);
        let FileEdit::Edit { path, edits, version } = &edit.files[0] else { panic!("{edit:?}") };
        assert_eq!(**path, *std::path::Path::new("/p/src/index.ts"));
        assert_eq!(
            edits,
            &[TextEdit { range: Range::new(Pos::new(1, 30), Pos::new(1, 40)), new_text: "./lib/money.ts".into() }]
        );
        assert!(version.is_none());
        assert!(super::edit(&json!({ "success": false })).files.is_empty());
    }
}
