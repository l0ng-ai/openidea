//! Before-commit checks (world `plugin-commit-checks`): declare each under
//! `[[contributes.commitChecks]]` and register the export with
//! `register_plugin!(MyPlugin, commit_checks)`. They run when the user commits
//! (after the IDE's own checks, for the ones turned on in Commit Options);
//! problems stop the commit until the user changes it or chooses Commit Anyway.
//! Needs `vcs.read`.
//!
//! To read or set the message of the commit being prepared from a command, see
//! [`crate::host::pending_commit`] and [`crate::host::set_commit_message`].

use crate::{CommitDraft, Error, Invocation, Location};

/// Something the user should look at before committing.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommitProblem {
    /// One sentence, shown after the check's title.
    pub message: String,
    /// Where it is, opened from the problem; `None` for the commit as a whole.
    pub location: Option<Location>,
}

impl CommitProblem {
    pub fn new(message: impl Into<String>) -> Self {
        Self { message: message.into(), location: None }
    }

    pub fn at(mut self, location: Location) -> Self {
        self.location = Some(location);
        self
    }
}

/// The plugin's before-commit checks.
pub trait CommitChecks {
    /// Runs the declared check `check` on `draft`: no problems lets the commit
    /// go on. An error is reported as a problem of the check.
    fn check(&mut self, check: &str, draft: &CommitDraft, ctx: &Invocation) -> Result<Vec<CommitProblem>, Error>;
}
