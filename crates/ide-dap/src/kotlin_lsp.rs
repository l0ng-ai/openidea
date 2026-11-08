//! JetBrains kotlin-lsp's debugger: a DAP server inside the language server, reached through
//! the `debugServer` port it opens once the project is imported.
//!
//! Known limits, with no guard here: an evaluate that calls a function with a breakpoint, right
//! after a step over a suspension point, loses every later stop at that breakpoint; while
//! stepping, breakpoints hit by other coroutines are skipped.

use ide_core::{IdeError, IdeResult};
use parking_lot::Mutex;
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

pub const ADAPTER: &str = "kotlin-lsp";
/// The `adapterID` its debug server expects in `initialize`.
pub const DAP_ADAPTER_ID: &str = "intellij_jvm";

/// The path of a `file:` URI, as kotlin-lsp reports some sources (percent-encoded); `None` for
/// anything else, including a URI naming another host.
pub(crate) fn source_path(path: &str) -> Option<PathBuf> {
    let rest = path.strip_prefix("file:")?;
    let path = match rest.strip_prefix("//") {
        Some(authority) => {
            let slash = authority.find('/')?;
            if !matches!(&authority[..slash], "" | "localhost") {
                return None;
            }
            &authority[slash..]
        }
        None => rest,
    };
    let decoded = percent_encoding::percent_decode_str(path).decode_utf8().ok()?;
    // `/C:/p/App.kt` on Windows.
    let decoded = match decoded.strip_prefix('/') {
        Some(drive) if cfg!(windows) && drive.as_bytes().get(1) == Some(&b':') => drive,
        _ => &decoded,
    };
    Some(PathBuf::from(decoded))
}

pub(crate) fn frame_name(name: &str) -> &str {
    name.strip_prefix("at ").unwrap_or(name)
}

/// What kotlin-lsp's DAP server does unlike other adapters.
///
/// It never answers a request that carries a thread id from an earlier stop (K1 G4), so such a
/// request would wait out `REQUEST_TIMEOUT`: [`Self::check_thread`] refuses it first. Only thread
/// ids were measured; a stale `frameId` or `variablesReference` may wait the same way. A step
/// ends with `reason: "breakpoint"`; a real breakpoint hit during a step is then reported as a
/// step too, since the stop carries neither `hitBreakpointIds` nor a description.
#[derive(Default)]
pub(crate) struct Quirks {
    step_pending: AtomicBool,
    /// The stop (a `Suspension` ticket) and the thread ids seen in it.
    threads: Mutex<(u64, HashSet<i64>)>,
}

impl Quirks {
    /// Before `next`, `stepIn`, `stepOut` or a forced step.
    pub fn step_sent(&self) {
        self.step_pending.store(true, Ordering::Release);
    }

    /// Before `continue` or run to cursor.
    pub fn resume_sent(&self) {
        self.step_pending.store(false, Ordering::Release);
    }

    /// The reason to report for a `stopped` event.
    pub fn stop_reason(&self, reason: String) -> String {
        let stepped = self.step_pending.swap(false, Ordering::AcqRel);
        if stepped && reason == "breakpoint" { "step".into() } else { reason }
    }

    /// Thread ids seen in stop `stop`: a `stopped` event's, or a `threads` reply to a request sent
    /// during that stop. A reply from an older stop changes nothing.
    pub fn saw_threads(&self, stop: u64, ids: impl IntoIterator<Item = i64>) {
        let mut threads = self.threads.lock();
        if stop > threads.0 {
            *threads = (stop, ids.into_iter().collect());
        } else if stop == threads.0 {
            threads.1.extend(ids);
        }
    }

    /// Refuses a thread id that is not one of current stop `stop`'s, once some are known.
    pub fn check_thread(&self, stop: u64, suspended: bool, id: i64) -> IdeResult<()> {
        let threads = self.threads.lock();
        if suspended && threads.0 == stop && !threads.1.is_empty() && !threads.1.contains(&id) {
            return Err(IdeError::invalid(format!("thread {id} belongs to an earlier stop")));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn file_uris_become_paths() {
        assert_eq!(source_path("file:///p/a%20b/App.kt").as_deref(), Some(Path::new("/p/a b/App.kt")));
        assert_eq!(source_path("file://localhost/p/x.kt").as_deref(), Some(Path::new("/p/x.kt")));
        assert_eq!(source_path("/p/x.kt"), None);
    }

    #[test]
    fn frame_names_lose_the_at_prefix() {
        assert_eq!(frame_name("at com.x.AppKt.main(App.kt:13)"), "com.x.AppKt.main(App.kt:13)");
        assert_eq!(frame_name("main"), "main");
    }

    #[test]
    fn only_a_pending_step_turns_a_breakpoint_into_a_step() {
        let quirks = Quirks::default();
        quirks.step_sent();
        assert_eq!(quirks.stop_reason("breakpoint".into()), "step");
        assert_eq!(quirks.stop_reason("breakpoint".into()), "breakpoint");
        quirks.step_sent();
        quirks.resume_sent();
        assert_eq!(quirks.stop_reason("breakpoint".into()), "breakpoint");
    }

    #[test]
    fn threads_are_checked_against_the_current_stop() {
        let quirks = Quirks::default();
        quirks.saw_threads(3, [18]);
        assert!(quirks.check_thread(3, true, 18).is_ok());
        assert!(quirks.check_thread(3, true, 6).is_err());
        assert!(quirks.check_thread(4, true, 6).is_ok(), "nothing known about stop 4 yet");
        assert!(quirks.check_thread(3, false, 6).is_ok());
    }

    #[test]
    fn an_older_threads_reply_does_not_change_a_newer_stop() {
        let quirks = Quirks::default();
        quirks.saw_threads(4, [2]);
        quirks.saw_threads(3, [1]);
        assert!(quirks.check_thread(4, true, 1).is_err());
        quirks.saw_threads(4, [7]);
        assert!(quirks.check_thread(4, true, 2).is_ok() && quirks.check_thread(4, true, 7).is_ok());
        quirks.saw_threads(5, [9]);
        assert!(quirks.check_thread(5, true, 2).is_err());
    }
}
