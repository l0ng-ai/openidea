//! Exception breakpoints on a chosen class. The manager keeps one list; a session given a backend
//! for them at start arms it before `configurationDone`, so a throw in the program's first line
//! stops, and again after each `setExceptionBreakpoints`, which drops them in java-debug.

use crate::session::Session;
use crate::{DebugManager, jvm_memory};
use ide_jvm_inspect::ExceptionClassSpec;
use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ExceptionClassBreakpoint {
    pub id: String,
    /// Fully qualified binary name (`com.acme.Outer$Inner`); its subclasses stop too.
    pub class_name: String,
    pub caught: bool,
    pub uncaught: bool,
    pub enabled: bool,
    /// Patterns (`com.acme.*`, `*Test`, a full name) for the class whose code throws.
    pub class_filters: Vec<String>,
    pub class_exclusion_filters: Vec<String>,
}

/// What a session's exception class breakpoints can do.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ExceptionClassSupport {
    /// Whose class names the session takes: `java`.
    pub family: String,
    pub condition: bool,
    pub class_filters: bool,
    /// Filters on the class whose code catches the exception.
    pub catch_filters: bool,
}

/// The JVM backends stop through java-debug's own exception events, which a condition or a
/// catch-location filter cannot veto.
pub(crate) fn support(s: &Session) -> Option<ExceptionClassSupport> {
    s.exception_classes.is_some().then(|| ExceptionClassSupport {
        family: "java".into(),
        condition: false,
        class_filters: true,
        catch_filters: false,
    })
}

fn spec(b: &ExceptionClassBreakpoint) -> ExceptionClassSpec {
    ExceptionClassSpec {
        id: b.id.clone(),
        class_name: b.class_name.clone(),
        caught: b.caught,
        uncaught: b.uncaught,
        enabled: b.enabled,
        class_filters: b.class_filters.clone(),
        class_exclusion_filters: b.class_exclusion_filters.clone(),
    }
}

impl DebugManager {
    /// Arms the manager's list in `s`; the caller holds `s.exception_turn`. `clear`: also when the
    /// list is empty, to take down what an earlier list armed.
    pub(crate) async fn arm_exception_classes(&self, s: &Session, clear: bool) {
        let Some(backend) = &s.exception_classes else { return };
        let specs: Vec<_> = self.exception_classes.lock().iter().map(spec).collect();
        // Without either, no VM is known yet: `configure` arms once it is.
        let target = jvm_memory::vm_target(s);
        if (specs.is_empty() && !clear) || (target.pid.is_none() && target.attach_port.is_none()) {
            return;
        }
        match backend.set(&target, &specs).await {
            Ok(states) => tracing::debug!("exception class breakpoints of session {}: {states:?}", s.id.0),
            Err(e) => tracing::debug!("exception class breakpoints of session {} failed: {e}", s.id.0),
        }
    }

    /// Stores exception breakpoints on chosen classes (kept without a session, armed on start)
    /// and arms them in every session that takes them. Also in one still starting: one that has
    /// armed already would miss the list, and one that has not answers `vmNotFound` until then.
    pub async fn set_exception_class_breakpoints(&self, list: Vec<ExceptionClassBreakpoint>) {
        *self.exception_classes.lock() = list;
        for s in self.live_sessions() {
            if s.exception_classes.is_none() || s.conn.is_closed() {
                continue;
            }
            let _turn = s.exception_turn.lock().await;
            self.arm_exception_classes(&s, true).await;
        }
    }
}
