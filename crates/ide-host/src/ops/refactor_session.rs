//! Refactoring session: impact set, conflict classification and one atomic
//! application (spec 10).
//!
//! A rename/restructure first collects usages (LSP references, with a textual
//! fallback for comments and strings). Before anything is written, each usage
//! is classified against the current workspace state: a usage in a file that is
//! not loaded, binary, or modified since the search cannot be safely rewritten.
//! Conflicts are reported, not silently skipped.
//!
//! When the plan is clean, [`RefactoringPlan::into_workspace_edit`] yields the
//! **single** [`WorkspaceEdit`] the host applies as one undoable transaction.
//! The session is bound to a [`Generation`]: a new session (or an edit)
//! supersedes a stale plan, so a slow search can never apply to a changed
//! document.

use ide_core::generation::{Generation, StaleReason};
use ide_core::{DocId, FileEdit, IpcPath, Pos, Range, TextEdit, WorkspaceEdit};
use std::collections::BTreeMap;
use std::path::PathBuf;

/// Where a usage was found. Textual occurrences need an explicit opt-in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UsageKind {
    Code,
    Comment,
    String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Usage {
    pub file: PathBuf,
    pub range: Range,
    pub kind: UsageKind,
    pub replacement: String,
}

/// Why a usage cannot be rewritten safely.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ConflictReason {
    /// The file is not open/loaded; its text may differ from the searched snapshot.
    NotLoaded,
    /// The file is binary; text edits are meaningless.
    Binary,
    /// The buffer changed after the impact set was computed.
    Modified,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Conflict {
    pub file: PathBuf,
    pub reason: ConflictReason,
}

/// The state of a file at application time, supplied by the host.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FileState {
    pub loaded: bool,
    pub binary: bool,
    /// Version at which the impact set was computed.
    pub searched_version: u32,
    /// Current version of the buffer.
    pub current_version: u32,
    pub doc: DocId,
}

impl FileState {
    fn conflict(&self) -> Option<ConflictReason> {
        if !self.loaded {
            Some(ConflictReason::NotLoaded)
        } else if self.binary {
            Some(ConflictReason::Binary)
        } else if self.searched_version != self.current_version {
            Some(ConflictReason::Modified)
        } else {
            None
        }
    }
}

/// The plan produced by `beginRefactoring`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RefactoringPlan {
    /// Usages that can be rewritten as-is.
    pub applicable: Vec<Usage>,
    /// Usages blocked by a classified conflict.
    pub conflicts: Vec<Conflict>,
    /// Whether textual (comment/string) usages were included.
    pub include_textual: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PlanError {
    /// The plan is stale: a new session or an edit superseded it.
    Stale(StaleReason),
    /// One or more conflicts must be resolved before applying.
    HasConflicts(usize),
}

impl std::fmt::Display for PlanError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Stale(r) => write!(f, "refactoring plan is stale ({r:?})"),
            Self::HasConflicts(n) => write!(f, "{n} conflicting usage(s) must be resolved first"),
        }
    }
}

/// Builds the impact plan. `state(usage)` is queried by the host for each
/// candidate; a `None` state is treated as `NotLoaded`.
pub fn build_plan<F>(usages: Vec<Usage>, include_textual: bool, mut state: F) -> RefactoringPlan
where
    F: FnMut(&Usage) -> Option<FileState>,
{
    let mut applicable = Vec::new();
    let mut conflicts = Vec::new();
    for usage in usages {
        if usage.kind != UsageKind::Code && !include_textual {
            continue;
        }
        match state(&usage) {
            Some(s) => match s.conflict() {
                Some(reason) => conflicts.push(Conflict { file: usage.file.clone(), reason }),
                None => applicable.push(usage),
            },
            None => conflicts.push(Conflict { file: usage.file.clone(), reason: ConflictReason::NotLoaded }),
        }
    }
    RefactoringPlan { applicable, conflicts, include_textual }
}

impl RefactoringPlan {
    pub fn is_applicable(&self) -> bool {
        self.conflicts.is_empty() && !self.applicable.is_empty()
    }

    /// The single edit for the host to apply as one undoable transaction.
    /// Rejects stale plans and plans with unresolved conflicts.
    pub fn into_workspace_edit(self, generation: &Generation) -> Result<WorkspaceEdit, PlanError> {
        if !generation.is_current() {
            return Err(PlanError::Stale(StaleReason::Superseded));
        }
        if generation.is_cancelled() {
            return Err(PlanError::Stale(StaleReason::Cancelled));
        }
        if !self.conflicts.is_empty() {
            return Err(PlanError::HasConflicts(self.conflicts.len()));
        }
        // Group usages by file; every replacement becomes one TextEdit.
        let mut by_file: BTreeMap<PathBuf, Vec<TextEdit>> = BTreeMap::new();
        for usage in self.applicable {
            by_file
                .entry(usage.file)
                .or_default()
                .push(TextEdit { range: usage.range, new_text: usage.replacement });
        }
        let files = by_file
            .into_iter()
            .map(|(path, edits)| FileEdit::Edit { path: IpcPath::from(path), edits, version: None })
            .collect();
        Ok(WorkspaceEdit { files, ..Default::default() })
    }
}

/// Post-apply verification (spec 10): a successful application advances the
/// versions of every touched buffer by exactly one. A mismatch means the edit
/// was not applied as a single transaction and the caller must roll back.
pub fn post_apply_ok(before: &[(DocId, u32)], after: &[(DocId, u32)]) -> bool {
    if before.len() != after.len() {
        return false;
    }
    before.iter().all(|(doc, version)| {
        after
            .iter()
            .find(|(d, _)| d == doc)
            .is_some_and(|(_, v)| *v == version.saturating_add(1))
    })
}

/// A convenience range for tests and textual fallbacks.
pub fn range(line: u32, column: u32, end_column: u32) -> Range {
    Range { start: Pos { line, col: column }, end: Pos { line, col: end_column } }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ide_core::generation::GenerationClock;

    fn usage(file: &str, kind: UsageKind) -> Usage {
        Usage { file: PathBuf::from(file), range: range(1, 0, 3), kind, replacement: "Renamed".into() }
    }

    fn clean(doc: DocId) -> FileState {
        FileState { loaded: true, binary: false, searched_version: 3, current_version: 3, doc }
    }

    #[test]
    fn a_clean_plan_produces_one_edit_grouped_by_file() {
        let doc = DocId::next();
        let plan = build_plan(
            vec![usage("/a.rs", UsageKind::Code), usage("/a.rs", UsageKind::Code), usage("/b.rs", UsageKind::Code)],
            false,
            |_| Some(clean(doc)),
        );
        assert!(plan.is_applicable());
        let clock = GenerationClock::new(DocId::next());
        let edit = plan.into_workspace_edit(&clock.mint()).unwrap();
        assert_eq!(edit.files.len(), 2, "one entry per file");
        assert!(
            matches!(&edit.files[0], FileEdit::Edit { edits, .. } if edits.len() == 2),
            "both usages of /a.rs in one group"
        );
    }

    #[test]
    fn conflicts_are_classified_and_block_application() {
        let doc = DocId::next();
        let plan = build_plan(
            vec![
                usage("/good.rs", UsageKind::Code),
                usage("/binary", UsageKind::Code),
                usage("/dirty.rs", UsageKind::Code),
            ],
            false,
            |u| {
                let mut s = clean(doc);
                if u.file.ends_with("binary") {
                    s.binary = true;
                }
                if u.file.ends_with("dirty.rs") {
                    s.current_version = 4;
                }
                Some(s)
            },
        );
        assert_eq!(plan.conflicts.len(), 2);
        assert!(plan.conflicts.iter().any(|c| c.reason == ConflictReason::Binary));
        assert!(plan.conflicts.iter().any(|c| c.reason == ConflictReason::Modified));
        let clock = GenerationClock::new(doc);
        assert!(matches!(
            plan.clone().into_workspace_edit(&clock.mint()),
            Err(PlanError::HasConflicts(2))
        ));
    }

    #[test]
    fn unloaded_files_are_conflicts_not_silent_skips() {
        let plan = build_plan(vec![usage("/never-opened.rs", UsageKind::Code)], false, |_| None);
        assert_eq!(plan.conflicts[0].reason, ConflictReason::NotLoaded);
        assert!(!plan.is_applicable());
    }

    #[test]
    fn textual_usages_require_an_explicit_opt_in() {
        let doc = DocId::next();
        let usages = vec![usage("/a.rs", UsageKind::Comment), usage("/a.rs", UsageKind::String)];
        let excluded = build_plan(usages.clone(), false, |_| Some(clean(doc)));
        assert!(excluded.applicable.is_empty());
        let included = build_plan(usages, true, |_| Some(clean(doc)));
        assert_eq!(included.applicable.len(), 2);
    }

    #[test]
    fn a_stale_or_cancelled_session_never_applies() {
        let doc = DocId::next();
        let plan = build_plan(vec![usage("/a.rs", UsageKind::Code)], false, |_| Some(clean(doc)));
        let clock = GenerationClock::new(doc);
        let stale = clock.mint();
        clock.bump();
        assert!(matches!(
            plan.clone().into_workspace_edit(&stale),
            Err(PlanError::Stale(StaleReason::Superseded))
        ));

        let cancelled = clock.mint();
        cancelled.cancel();
        assert!(matches!(
            plan.into_workspace_edit(&cancelled),
            Err(PlanError::Stale(StaleReason::Cancelled))
        ));
    }

    #[test]
    fn post_apply_requires_every_touched_buffer_to_advance_by_one() {
        let a = DocId::next();
        let b = DocId::next();
        assert!(post_apply_ok(&[(a, 3), (b, 7)], &[(a, 4), (b, 8)]));
        assert!(!post_apply_ok(&[(a, 3), (b, 7)], &[(a, 4), (b, 7)]), "one buffer did not change");
        assert!(!post_apply_ok(&[(a, 3)], &[(a, 4), (b, 8)]), "unexpected extra buffer");
    }
}
