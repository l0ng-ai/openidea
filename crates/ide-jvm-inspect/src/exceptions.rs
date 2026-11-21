//! Exception breakpoints on a chosen class, armed inside the debuggee's VM by the debugger's own
//! connection. The adapter stops on them as on its own exception filters.

use crate::{InspectFuture, VmTarget};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExceptionClassSpec {
    /// Echoed back with the breakpoint's state.
    pub id: String,
    /// Binary name (`com.acme.Outer$Inner`); subclasses stop too.
    pub class_name: String,
    pub caught: bool,
    pub uncaught: bool,
    pub enabled: bool,
    /// JDI class patterns (`com.acme.*`, `*Test`) matched against the class whose code throws.
    pub class_filters: Vec<String>,
    pub class_exclusion_filters: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ExceptionArmState {
    Armed,
    /// No class of that name is loaded yet; it is armed when one is.
    Pending,
    Disabled,
    /// A stream trace silences the VM's breakpoints; applied when it ends.
    Deferred,
}

pub trait ExceptionClassBreakpoints: Send + Sync {
    /// Replaces the VM's whole list; `(id, state)` per breakpoint, in order. The adapter can drop
    /// these whenever it sets its own exception filters, so set them again after each time.
    fn set<'a>(
        &'a self,
        target: &'a VmTarget,
        breakpoints: &'a [ExceptionClassSpec],
    ) -> InspectFuture<'a, Vec<(String, ExceptionArmState)>>;
}
