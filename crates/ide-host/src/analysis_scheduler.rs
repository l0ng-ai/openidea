//! Debounced, generation-bound analysis scheduler (spec 08/21, seam S2).
//!
//! Every keystroke re-runs analysis, but only the result for the *current*
//! generation of a document may be published. A new edit bumps the generation,
//! which cancels the in-flight work and discards its result. Work is debounced
//! so a burst of keystrokes collapses into one analysis pass.
//!
//! The scheduler is generic over the work and the publish callback, so the same
//! primitive drives LSP diagnostics, duplicate detection and structural search.

use ide_core::generation::{Generation, GenerationClock};
use ide_core::DocId;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::RwLock;
use tokio::time;

#[derive(Clone)]
pub struct AnalysisScheduler {
    debounce: Duration,
    clocks: Arc<RwLock<std::collections::HashMap<DocId, GenerationClock>>>,
}

impl AnalysisScheduler {
    pub fn new(debounce: Duration) -> Self {
        Self { debounce, clocks: Arc::new(RwLock::new(std::collections::HashMap::new())) }
    }

    /// Schedules `work` for `doc`. The returned [`Generation`] is the publish
    /// boundary: `publish` runs only if the generation is still current when
    /// `work` finishes. Older generations are cancelled and their results
    /// dropped.
    pub async fn schedule<W, T, P>(&self, doc: DocId, work: W, publish: P) -> Generation
    where
        W: FnOnce() -> T + Send + 'static,
        T: Send + 'static,
        P: FnOnce(T) + Send + 'static,
    {
        let clock = {
            let mut clocks = self.clocks.write().await;
            clocks.entry(doc).or_insert_with(|| GenerationClock::new(doc)).clone()
        };
        let generation = {
            clock.bump();
            clock.mint()
        };
        let gen_for_return = generation.clone();
        let cancel = generation.cancellation();
        let debounce = self.debounce;

        tokio::spawn(async move {
            time::sleep(debounce).await;
            if cancel.is_cancelled() {
                return;
            }
            let result = tokio::task::spawn_blocking(work).await;
            if cancel.is_cancelled() {
                return;
            }
            let Ok(value) = result else { return };
            // Re-check cancellation before publishing.
            if cancel.is_cancelled() {
                return;
            }
            if let Ok(value) = generation.submit(value) {
                publish(value);
            }
        });
        // The above publish needs the value; restructure below instead.
        gen_for_return
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    #[tokio::test]
    async fn a_new_schedule_cancels_the_previous_one() {
        let sched = AnalysisScheduler::new(Duration::from_millis(1));
        let doc = DocId::next();
        let hits = Arc::new(AtomicUsize::new(0));
        let h = hits.clone();
        let g1 = sched.schedule(doc, move || 1u32, move |_v| { h.fetch_add(1, Ordering::SeqCst); }).await;
        // Second schedule bumps the generation, cancelling g1's work.
        let h2 = hits.clone();
        let _g2 = sched.schedule(doc, move || 2u32, move |_v| { h2.fetch_add(1, Ordering::SeqCst); }).await;
        // g1 is no longer current.
        assert!(!g1.is_current());
    }

    #[tokio::test]
    async fn generation_binding_is_exposed() {
        let sched = AnalysisScheduler::new(Duration::from_millis(1));
        let doc = DocId::next();
        let g = sched.schedule(doc, || 42u32, |_| {}).await;
        assert!(g.is_current());
    }
}
