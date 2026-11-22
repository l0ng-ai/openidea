use std::collections::HashSet;
use std::fs::{self, File};
use std::path::Path;

use gix::bstr::BStr;
use gix::index::entry::{Flags, Mode, Stage};
use ide_core::error::ErrorKind;
use ide_core::{CancellationToken, IdeError, IdeResult, IpcPath};
use serde::{Deserialize, Serialize};
use specta::Type;

use crate::cli::TempIndex;
use crate::diff::{normalize_eol, replace_text};
use crate::repo::{blob_data, gx};
use crate::text_encoding::{TextEncoding, decode, encode, has_bom, is_binary};
use crate::{ApplyCommitReview, HunkKind, Repo, write};

#[derive(Debug, Serialize, Deserialize, Type)]
pub struct StagedText {
    pub text: String,
    /// Identifies the index entry, including its mode, when this text was read.
    pub version: String,
}

#[derive(Debug, Serialize, Deserialize, Type)]
pub struct StagedTextEdit {
    pub path: IpcPath,
    pub version: String,
    pub text: String,
}

#[derive(Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct StagingLineHunk {
    pub kind: HunkKind,
    pub start: u32,
    pub lines: u32,
    pub head_start: u32,
    pub head_lines: u32,
    pub head_text: String,
    pub index_start: u32,
    pub index_lines: u32,
    pub index_text: String,
    pub staged: bool,
    pub unstaged: bool,
}

#[derive(Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct StagingLineHunks {
    pub index_version: String,
    pub hunks: Vec<StagingLineHunk>,
}

struct StagedEntry {
    mode: &'static str,
    id: gix::ObjectId,
}

impl StagedEntry {
    fn version(&self) -> String {
        format!("{}:{}", self.mode, self.id)
    }
}

fn staged_entry(repo: &gix::Repository, rel: &str) -> IdeResult<Option<StagedEntry>> {
    if !repo.index_path().is_file() {
        return Ok(None);
    }
    let index = repo.open_index().map_err(gx)?;
    Ok(staged_entry_at(&index, rel))
}

fn staged_entry_at(index: &gix::index::State, rel: &str) -> Option<StagedEntry> {
    let entry = index.entry_by_path_and_stage(BStr::new(rel.as_bytes()), Stage::Unconflicted)?;
    if entry.flags.contains(Flags::INTENT_TO_ADD) {
        return None;
    }
    let mode = match entry.mode {
        Mode::FILE => "100644",
        Mode::FILE_EXECUTABLE => "100755",
        _ => return None,
    };
    Some(StagedEntry { mode, id: entry.id })
}

fn stale() -> IdeError {
    IdeError::new(ErrorKind::OutOfSync, "The staged version changed on disk")
}

fn updated_text(bytes: &[u8], text: &str, encoding: TextEncoding) -> IdeResult<Option<Vec<u8>>> {
    if is_binary(bytes, encoding) {
        return Err(IdeError::invalid("Binary files cannot be edited in the index"));
    }
    let old = decode(bytes, encoding);
    if normalize_eol(&old) == normalize_eol(text) {
        return Ok(None);
    }
    let updated = replace_text(&old, text);
    Ok(Some(encode(&updated, encoding, has_bom(bytes, encoding))?))
}

fn publish_index(mut lock: gix::lock::File, path: &Path, scratch: &TempIndex) -> IdeResult<()> {
    let permissions = fs::metadata(path)?.permissions();
    let mut result = File::open(scratch.path())?;
    lock.with_mut(|out| {
        std::io::copy(&mut result, out)?;
        out.set_permissions(permissions)?;
        out.sync_all()
    })?;
    lock.commit().map_err(gx)?;
    Ok(())
}

impl Repo {
    pub fn staging_line_hunks(
        &self,
        path: &Path,
        head_path: Option<&Path>,
        working: &str,
        max_bytes: usize,
        encoding: impl Fn(&Path, &[u8]) -> TextEncoding,
    ) -> IdeResult<Option<StagingLineHunks>> {
        if working.len() > max_bytes {
            return Ok(None);
        }
        let Some(index) = self.staged_text(path, max_bytes, |bytes| encoding(path, bytes))? else {
            return Ok(None);
        };
        let head_path = head_path.unwrap_or(path);
        let bytes = self.file_bytes_at(head_path, Some("HEAD"))?.unwrap_or_default();
        let encoding = encoding(head_path, &bytes);
        if bytes.len() > max_bytes || is_binary(&bytes, encoding) {
            return Ok(None);
        }
        let head = decode(&bytes, encoding);
        Ok(Some(StagingLineHunks {
            hunks: crate::diff::staging_line_hunks(&head, &index.text, working),
            index_version: index.version,
        }))
    }

    pub fn staged_text(
        &self,
        path: &Path,
        max_bytes: usize,
        encoding: impl FnOnce(&[u8]) -> TextEncoding,
    ) -> IdeResult<Option<StagedText>> {
        let _scope = self.execution_scope();
        let repo = self.gix()?;
        let rel = self.rel_path(path)?;
        let Some(entry) = staged_entry(&repo, &rel)? else {
            return Ok(None);
        };
        if repo.try_find_header(entry.id).map_err(gx)?.is_some_and(|header| header.size() > max_bytes as u64) {
            return Ok(None);
        }
        let bytes = blob_data(&repo, entry.id)?;
        if bytes.len() > max_bytes {
            return Ok(None);
        }
        let encoding = encoding(&bytes);
        if is_binary(&bytes, encoding) {
            return Ok(None);
        }
        Ok(Some(StagedText { text: normalize_eol(&decode(&bytes, encoding)).into_owned(), version: entry.version() }))
    }

    /// Replaces one stage-zero blob if the editor still has its current version.
    pub fn save_staged_text(
        &self,
        path: &Path,
        version: &str,
        text: &str,
        encoding: impl FnOnce(&[u8]) -> TextEncoding,
    ) -> IdeResult<String> {
        let _scope = self.execution_scope();
        let repo = self.gix()?;
        let path_to_index = repo.index_path();
        let lock =
            gix::lock::File::acquire_to_update_resource(&path_to_index, gix::lock::acquire::Fail::Immediately, None, 0)
                .map_err(gx)?;
        let rel = self.rel_path(path)?;
        let Some(entry) = staged_entry(&repo, &rel)? else {
            return Err(stale());
        };
        let current = entry.version();
        if version != current {
            return Err(stale());
        }
        let bytes = blob_data(&repo, entry.id)?;
        let encoding = encoding(&bytes);
        let Some(contents) = updated_text(&bytes, text, encoding)? else {
            return Ok(current);
        };

        // Let Git update the complete index, including its extensions, while its usual
        // lock protects the input version and prevents a concurrent writer from losing edits.
        let scratch = TempIndex::new(self);
        fs::copy(&path_to_index, scratch.path())?;
        let id = write::write_index_blob(self, &rel, &contents, &scratch.env())?;
        publish_index(lock, &path_to_index, &scratch)?;
        Ok(format!("{}:{id}", entry.mode))
    }

    /// Publishes formatter output against exactly the Git operation and index the user reviewed.
    pub fn format_reviewed_apply(
        &self,
        checkpoint: &str,
        edits: &[StagedTextEdit],
        cancel: &CancellationToken,
        encoding: impl Fn(&Path, &[u8]) -> TextEncoding,
    ) -> IdeResult<ApplyCommitReview> {
        let _scope = self.execution_scope();
        let repo = self.gix()?;
        let index_path = repo.index_path();
        let lock =
            gix::lock::File::acquire_to_update_resource(&index_path, gix::lock::acquire::Fail::Immediately, None, 0)
                .map_err(gx)?;
        let review = self.require_apply_review(checkpoint, cancel)?;
        let mut paths = review.paths.iter().map(|path| self.rel_path(&path.0)).collect::<IdeResult<HashSet<_>>>()?;
        let index = repo.open_index().map_err(gx)?;
        let scratch = TempIndex::new(self);
        fs::copy(&index_path, scratch.path())?;
        for edit in edits {
            if cancel.is_cancelled() {
                return Err(IdeError::cancelled());
            }
            let path = &edit.path.0;
            let rel = self.rel_path(path)?;
            if !paths.remove(&rel) {
                return Err(stale());
            }
            let entry =
                staged_entry_at(&index, &rel).filter(|entry| entry.version() == edit.version).ok_or_else(stale)?;
            let bytes = blob_data(&repo, entry.id)?;
            if let Some(contents) = updated_text(&bytes, &edit.text, encoding(path, &bytes))? {
                write::write_index_blob(self, &rel, &contents, &scratch.env())?;
            }
        }
        // Leave an existing non-empty resolution intact when formatting would make the step empty.
        let Some(formatted) = self.review_apply_index(cancel, &scratch.env())? else { return Ok(review) };
        if formatted.checkpoint == checkpoint {
            return Ok(review);
        }
        self.require_apply_review(checkpoint, cancel)?;
        if cancel.is_cancelled() {
            return Err(IdeError::cancelled());
        }
        publish_index(lock, &index_path, &scratch)?;
        Ok(formatted)
    }
}
