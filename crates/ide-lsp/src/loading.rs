//! Requests answered while a server is still loading the project.
//!
//! rust-analyzer answers navigation with nothing until it has read the project's
//! files, misses macro-generated items until build scripts and proc macros are
//! built, and withdraws answers (`ContentModified`) when loading changes its
//! data. Such an answer is not final: the request runs again as loading
//! progresses, so ⌘B right after opening a project lands once the server can
//! answer instead of reporting "not found".

use crate::server::Server;
use ide_core::error::ErrorKind;
use ide_core::{CancellationToken, IdeError, IdeResult};
use std::future::Future;
use std::time::Duration;

/// How long an explicit request waits for a server that is still loading.
pub(crate) const LOADING_WAIT: Duration = Duration::from_secs(30);
/// Retry interval while it loads, for phases that end without a notification.
const POLL: Duration = Duration::from_secs(3);

/// Runs `query` on `server`. While the server is loading, an empty answer or a
/// withdrawn one (`ContentModified`; not a cancellation of `cancel`) runs again
/// whenever a loading phase ends, until it answers, loading ends, or `wait`
/// passes; then a still-loading server yields a `TimedOut` error saying so.
pub(crate) async fn while_loading<R, F, Fut>(
    server: &Server,
    cancel: Option<&CancellationToken>,
    wait: Duration,
    is_empty: impl Fn(&R) -> bool,
    query: F,
) -> IdeResult<R>
where
    F: Fn() -> Fut,
    Fut: Future<Output = IdeResult<R>>,
{
    let cancelled = || cancel.is_some_and(CancellationToken::is_cancelled);
    let deadline = tokio::time::Instant::now() + wait;
    loop {
        let phase = server.phase_notified();
        tokio::pin!(phase);
        phase.as_mut().enable();
        let result = query().await;
        let retry = match &result {
            Ok(r) => is_empty(r),
            Err(e) => e.kind == ErrorKind::Cancelled && !cancelled(),
        };
        if !retry || cancelled() || !server.is_loading() || server.running().is_none() {
            return result;
        }
        let now = tokio::time::Instant::now();
        if now >= deadline {
            return Err(IdeError::new(ErrorKind::TimedOut, format!("{} is still loading the project", server.name)));
        }
        let until = deadline.min(now + POLL);
        let stop = async {
            match cancel {
                Some(c) => c.cancelled().await,
                None => std::future::pending().await,
            }
        };
        tokio::select! {
            () = phase => {}
            () = tokio::time::sleep_until(until) => {}
            () = stop => return Err(IdeError::cancelled()),
        }
    }
}
