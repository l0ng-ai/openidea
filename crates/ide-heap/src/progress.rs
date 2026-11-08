//! Phases of a heap analysis and the progress/cancellation checks every long pass makes.

use ide_core::CancellationToken;
use serde::{Deserialize, Serialize};

use crate::error::HeapError;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum HeapPhase {
    Reading,
    Linking,
    Dominators,
    Retained,
    Paths,
    Saving,
}

/// Longest stretch of work between two progress reports (and looks at the cancellation token).
pub(crate) const CHECK_EVERY: u64 = 1 << 20;

/// The caller's progress callback plus the token, looked at right after every report so a callback
/// that cancels stops the work before the next step.
pub(crate) struct Progress<'a> {
    report: &'a dyn Fn(HeapPhase, u64, u64) -> Result<(), HeapError>,
    cancel: &'a CancellationToken,
}

impl<'a> Progress<'a> {
    pub(crate) fn new(
        report: &'a dyn Fn(HeapPhase, u64, u64) -> Result<(), HeapError>,
        cancel: &'a CancellationToken,
    ) -> Self {
        Self { report, cancel }
    }

    pub(crate) fn report(&self, phase: HeapPhase, done: u64, total: u64) -> Result<(), HeapError> {
        (self.report)(phase, done, total)?;
        if self.cancel.is_cancelled() { Err(HeapError::Cancelled) } else { Ok(()) }
    }

    /// Looks at the token at step 0 and reports every [`CHECK_EVERY`] steps after it. Step 0 does
    /// not report: a loop starts right after its phase's own report.
    pub(crate) fn step(&self, step: u64, phase: HeapPhase, done: u64, total: u64) -> Result<(), HeapError> {
        if step == 0 {
            if self.cancel.is_cancelled() { Err(HeapError::Cancelled) } else { Ok(()) }
        } else if step.is_multiple_of(CHECK_EVERY) {
            self.report(phase, done, total)
        } else {
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use super::*;

    #[test]
    fn steps_check_at_zero_and_report_every_check_interval() {
        let calls = RefCell::new(Vec::new());
        let report = |phase, done, total| {
            calls.borrow_mut().push((phase, done, total));
            Ok(())
        };
        let cancel = CancellationToken::new();
        let progress = Progress::new(&report, &cancel);
        for step in [0, 1, CHECK_EVERY - 1, CHECK_EVERY, CHECK_EVERY + 1, 3 * CHECK_EVERY] {
            progress.step(step, HeapPhase::Linking, step, 9).unwrap();
        }
        assert_eq!(*calls.borrow(), [(HeapPhase::Linking, CHECK_EVERY, 9), (HeapPhase::Linking, 3 * CHECK_EVERY, 9)]);

        cancel.cancel();
        assert!(matches!(progress.step(0, HeapPhase::Linking, 0, 9), Err(HeapError::Cancelled)));
        assert!(matches!(progress.report(HeapPhase::Saving, 1, 1), Err(HeapError::Cancelled)));
        assert_eq!(calls.borrow().last(), Some(&(HeapPhase::Saving, 1, 1)), "reports before it looks at the token");
    }

    #[test]
    fn report_errors_pass_through() {
        let report = |_, _, _| Err(HeapError::NotEnoughDiskSpace { needed: 2, available: 1 });
        let cancel = CancellationToken::new();
        let progress = Progress::new(&report, &cancel);
        assert!(matches!(progress.report(HeapPhase::Linking, 0, 1), Err(HeapError::NotEnoughDiskSpace { .. })));
    }

    #[test]
    fn phases_serialize_in_camel_case() {
        assert_eq!(serde_json::to_string(&HeapPhase::Dominators).unwrap(), "\"dominators\"");
        assert_eq!(serde_json::from_str::<HeapPhase>("\"saving\"").unwrap(), HeapPhase::Saving);
    }
}
