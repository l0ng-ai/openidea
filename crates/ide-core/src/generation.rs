//! Generation-bound background results (spec 03/07/08/21, seam S2).
//!
//! A background job (analysis, completion, refactoring, remote replay) computes a
//! result for one *generation* of a document: a `(document, version)` pair. Users
//! keep typing while it runs, so by the time a result is ready the document may
//! have changed. The rule this module enforces at the publish boundary is:
//!
//! > A result is published **only** if the generation it was minted for is still
//! > the current one. Stale or cancelled results are *discarded*, never patched up
//! > or applied partially.
//!
//! [`GenerationClock`] owns the current generation of one document and mints
//! [`Generation`] handles. Every edit or new session calls [`GenerationClock::bump`],
//! which invalidates all previously minted handles and cancels their in-flight
//! work. A job carries its handle, checks [`Generation::cancellation`] to stop
//! early, and calls [`Generation::submit`] right before publishing.

use crate::DocId;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio_util::sync::CancellationToken;

/// Monotone generation counter for a single document.
///
/// Cloning a clock (or minting many handles) shares the same counter, so a bump
/// from any clone supersedes every handle minted from any of them.
#[derive(Clone)]
pub struct GenerationClock {
    doc: DocId,
    revision: Arc<AtomicU64>,
    /// Cancellation tokens of every handle minted in the current generation.
    /// `bump` drains and cancels them; `GenerationInner::drop` removes its own.
    members: Arc<Mutex<Vec<Arc<CancellationToken>>>>,
}

impl GenerationClock {
    /// Starts generation `0` for `doc`.
    pub fn new(doc: DocId) -> Self {
        Self {
            doc,
            revision: Arc::new(AtomicU64::new(0)),
            members: Arc::new(Mutex::new(Vec::new())),
        }
    }

    pub fn doc(&self) -> DocId {
        self.doc
    }

    /// The current revision. Revisions only ever increase.
    pub fn current(&self) -> u64 {
        self.revision.load(Ordering::Acquire)
    }

    /// Ends the current generation: cancels every in-flight job belonging to it
    /// and moves to the next revision. Returns the new revision.
    ///
    /// Cancelling before publishing is deliberate: a job that is already done but
    /// not yet published is still a member of the old generation, so its result
    /// will be rejected by [`Generation::submit`] as well.
    pub fn bump(&self) -> u64 {
        let previous: Vec<_> = std::mem::take(&mut *self.lock_members());
        for token in previous {
            token.cancel();
        }
        self.revision.fetch_add(1, Ordering::AcqRel) + 1
    }

    /// Mints a handle bound to the current generation. The handle stays valid
    /// until [`GenerationClock::bump`] is called or [`Generation::cancel`] runs.
    pub fn mint(&self) -> Generation {
        let token = Arc::new(CancellationToken::new());
        self.lock_members().push(Arc::clone(&token));
        Generation(Arc::new(GenerationInner {
            doc: self.doc,
            revision: self.current(),
            clock: Arc::clone(&self.revision),
            token,
            self_cancelled: AtomicBool::new(false),
            members: Arc::clone(&self.members),
        }))
    }

    fn lock_members(&self) -> std::sync::MutexGuard<'_, Vec<Arc<CancellationToken>>> {
        self.members.lock().unwrap_or_else(|e| e.into_inner())
    }
}

struct GenerationInner {
    doc: DocId,
    revision: u64,
    clock: Arc<AtomicU64>,
    /// Cancelled when the generation is bumped (stops in-flight work) or when
    /// this job is explicitly cancelled.
    token: Arc<CancellationToken>,
    /// Set only by [`Generation::cancel`]; distinguishes a job-level cancel
    /// from a generation-level supersession at the publish boundary.
    self_cancelled: AtomicBool,
    members: Arc<Mutex<Vec<Arc<CancellationToken>>>>,
}

impl Drop for GenerationInner {
    fn drop(&mut self) {
        // Keep the member list bounded to live jobs. `Arc::ptr_eq` identifies
        // this handle's token even though cancellation tokens are not comparable.
        let mut members = self.members.lock().unwrap_or_else(|e| e.into_inner());
        members.retain(|t| !Arc::ptr_eq(t, &self.token));
    }
}

/// A background job's claim to publish into a document generation.
///
/// Cheaply cloneable so one logical job can hand the same claim to several
/// worker tasks; all clones share one cancellation token and one revision.
#[derive(Clone)]
#[must_use = "a result must be checked with `submit` before it is published"]
pub struct Generation(Arc<GenerationInner>);

/// Why a result was refused at the publish boundary.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StaleReason {
    /// A newer generation exists (the document changed or a new session started).
    Superseded,
    /// This job was explicitly cancelled while still in the current generation.
    Cancelled,
}

/// A result rejected by [`Generation::submit`], carrying the unconsumed value so
/// callers can drop it explicitly instead of leaking it into the UI.
#[derive(Debug)]
pub struct Rejected<T> {
    pub reason: StaleReason,
    pub value: T,
}

impl<T> Rejected<T> {
    pub fn into_value(self) -> T {
        self.value
    }
}

impl Generation {
    pub fn doc(&self) -> DocId {
        self.0.doc
    }

    /// Revision this handle was minted at.
    pub fn revision(&self) -> u64 {
        self.0.revision
    }

    /// Whether this handle still names the current generation.
    pub fn is_current(&self) -> bool {
        self.0.clock.load(Ordering::Acquire) == self.0.revision
    }

    /// Whether this job (or its whole generation) has been cancelled.
    pub fn is_cancelled(&self) -> bool {
        self.0.self_cancelled.load(Ordering::Acquire) || self.0.token.is_cancelled()
    }

    /// Cancels just this job. Publishing from a cancelled handle always fails.
    pub fn cancel(&self) {
        self.0.self_cancelled.store(true, Ordering::Release);
        self.0.token.cancel();
    }

    /// Cancellation token for the async work itself: a long computation should
    /// select on this and stop early instead of running to completion only to be
    /// discarded at `submit`.
    pub fn cancellation(&self) -> CancellationToken {
        (*self.0.token).clone()
    }

    /// Publish boundary. Returns `Ok(value)` only when the generation is still
    /// current and the job was not cancelled; otherwise returns the value back
    /// inside [`Rejected`] so it can be dropped.
    ///
    /// Supersession takes precedence: a [`GenerationClock::bump`] also cancels
    /// the generation's in-flight work, so a result minted for an older revision
    /// is reported as [`StaleReason::Superseded`] even though its token fired.
    pub fn submit<T>(&self, value: T) -> Result<T, Rejected<T>> {
        if !self.is_current() {
            return Err(Rejected { reason: StaleReason::Superseded, value });
        }
        if self.is_cancelled() {
            return Err(Rejected { reason: StaleReason::Cancelled, value });
        }
        Ok(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    fn clock() -> GenerationClock {
        GenerationClock::new(DocId::next())
    }

    #[test]
    fn a_fresh_generation_publishes() {
        let c = clock();
        let g = c.mint();
        assert!(g.is_current());
        assert_eq!(g.submit(vec![1, 2, 3]).unwrap(), vec![1, 2, 3]);
    }

    #[test]
    fn an_edit_supersedes_the_previous_generation() {
        let c = clock();
        let g = c.mint();
        let new_revision = c.bump();
        assert_eq!(new_revision, 1);
        assert!(!g.is_current());

        let rejected = g.submit("stale diagnostics").unwrap_err();
        assert_eq!(rejected.reason, StaleReason::Superseded);
        assert_eq!(rejected.into_value(), "stale diagnostics");

        // A handle minted after the bump is unaffected.
        assert_eq!(c.mint().submit("fresh diagnostics").unwrap(), "fresh diagnostics");
    }

    #[test]
    fn bump_cancels_in_flight_work_of_the_previous_generation() {
        let c = clock();
        let g = c.mint();
        let token = g.cancellation();
        assert!(!token.is_cancelled());
        c.bump();
        assert!(token.is_cancelled(), "bump must stop old in-flight work");
        assert!(g.is_cancelled());
    }

    #[test]
    fn cancelling_one_job_does_not_cancel_its_sibling() {
        let c = clock();
        let a = c.mint();
        let b = c.mint();
        a.cancel();
        assert_eq!(a.submit("a").unwrap_err().reason, StaleReason::Cancelled);
        assert_eq!(b.submit("b").unwrap(), "b", "siblings share the generation, not the cancellation");
    }

    #[test]
    fn several_submissions_within_one_generation_are_all_visible_in_order() {
        let c = clock();
        let g = c.mint();
        let mut published = Vec::new();
        for wave in ["parsed", "analysed", "diagnostics"] {
            published.push(g.submit(wave).unwrap());
        }
        assert_eq!(published, ["parsed", "analysed", "diagnostics"]);
    }

    #[test]
    fn clocks_share_the_generation_across_clones() {
        let c = clock();
        let g1 = c.mint();
        let g2 = c.clone().mint();
        c.clone().bump();
        assert_eq!(g1.submit(()).unwrap_err().reason, StaleReason::Superseded);
        assert_eq!(g2.submit(()).unwrap_err().reason, StaleReason::Superseded);
    }

    #[test]
    fn dropping_the_last_clone_unregisters_the_job() {
        let c = clock();
        let g = c.mint();
        let clone = g.clone();
        assert_eq!(c.members.lock().unwrap().len(), 1);
        drop(g);
        assert_eq!(c.members.lock().unwrap().len(), 1, "one clone still alive");
        drop(clone);
        assert_eq!(c.members.lock().unwrap().len(), 0);
    }

    // State-machine invariant: a `submit` succeeds iff no bump happened since
    // the handle was minted and the handle itself was never cancelled.
    proptest! {
        #[test]
        fn only_the_current_uncancelled_generation_publishes(ops in prop::collection::vec(any::<u8>(), 0..250)) {
            let c = clock();
            // (handle, minted_at_revision, cancelled)
            let mut handles: Vec<(Generation, u64, bool)> = Vec::new();
            let mut current = c.current();

            for op in ops {
                match op % 4 {
                    0 => { current = c.bump(); }
                    1 => handles.push((c.mint(), current, false)),
                    2 => {
                        if !handles.is_empty() {
                            let i = (op as usize / 4) % handles.len();
                            handles[i].0.cancel();
                            handles[i].2 = true;
                        }
                    }
                    _ => {
                        if !handles.is_empty() {
                            let i = (op as usize / 4) % handles.len();
                            let (h, minted_at, cancelled) = &handles[i];
                            let expect_ok = *minted_at == current && !*cancelled;
                            let ok = h.submit(()).is_ok();
                            prop_assert_eq!(ok, expect_ok,
                                "revision minted={} current={} cancelled={}", minted_at, current, cancelled);
                        }
                    }
                }
            }
        }
    }
}
