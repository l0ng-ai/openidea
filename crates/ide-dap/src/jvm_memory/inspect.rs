//! A suspended JVM's instances, fields and referrers, read through the session's
//! [`JvmInspector`]. An object is only valid within the stop it was read in.

use super::launch_pid;
use crate::session::Session;
use ide_core::event::{DebugEvent, JvmBackendState};
use ide_core::{IdeError, IdeResult};
use ide_jvm_inspect::{
    DEFAULT_REFERRERS, InspectError, InspectFuture, JvmField, JvmInspector, JvmReferrer, JvmValue, MAX_INSTANCES,
    MAX_REFERRERS, ObjectId, VmTarget,
};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::sync::Arc;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct JvmObjectRef {
    /// The `generation` of the [`JvmInstancesResult`] the object came from.
    pub generation: u64,
    pub id: ObjectId,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum JvmInspectUnavailable {
    /// The session has no inspector: not a JVM session, not ready yet, or turned off.
    NoBackend,
    /// The debug adapter lacks what the inspector needs; turned off for the session.
    Unsupported {
        detail: String,
    },
    NotSuspended,
    /// The object is from an earlier stop, or the program stopped or resumed meanwhile.
    Stale,
    Collected,
    ClassNotLoaded,
    VmNotFound,
    /// Transient: ask again.
    TimedOut,
    BackendClosed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "status", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum JvmInstancesResult {
    Ready {
        /// Goes into the [`JvmObjectRef`] of each instance.
        generation: u64,
        instances: Vec<JvmValue>,
        /// The limit was reached; there may be more.
        truncated: bool,
    },
    Unavailable {
        reason: JvmInspectUnavailable,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "status", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum JvmFieldsResult {
    Ready { fields: Vec<JvmField> },
    Unavailable { reason: JvmInspectUnavailable },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "status", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum JvmReferrersResult {
    Ready { referrers: Vec<JvmReferrer>, truncated: bool },
    Unavailable { reason: JvmInspectUnavailable },
}

/// The session's JVM for the inspector: java-debug's VM is found by the launched program's pid
/// or by the port of an attach (the thread lists of two JVMs can be identical).
pub(crate) fn vm_target(s: &Session) -> VmTarget {
    let (pid, attach) = if s.request == "launch" {
        (u32::try_from(launch_pid(s)).ok().filter(|&p| p > 0), None)
    } else {
        (None, s.attach_target.get())
    };
    VmTarget {
        pid,
        attach_host: attach.map(|(host, _)| host.clone()).filter(|h| !h.is_empty()),
        attach_port: attach.map(|&(_, port)| port),
        generation: s.suspended.ticket(),
    }
}

pub(crate) fn set_inspector(s: &Session, inspector: Arc<dyn JvmInspector>) {
    *s.jvm_inspector.lock() = Some(inspector);
    s.emit(DebugEvent::Capabilities);
}

pub(crate) async fn instances(s: &Session, class_name: &str, limit: u32) -> IdeResult<JvmInstancesResult> {
    let limit = limit.clamp(1, MAX_INSTANCES);
    let call = match Call::begin(s, None).await {
        Ok(call) => call,
        Err(reason) => return Ok(JvmInstancesResult::Unavailable { reason }),
    };
    let generation = call.target.generation;
    let result = call.run(call.inspector.instances(&call.target, class_name, limit)).await;
    Ok(match settle(call.finish(result))? {
        Ok(instances) => {
            JvmInstancesResult::Ready { generation, truncated: instances.len() >= limit as usize, instances }
        }
        Err(reason) => JvmInstancesResult::Unavailable { reason },
    })
}

pub(crate) async fn fields(s: &Session, object: JvmObjectRef) -> IdeResult<JvmFieldsResult> {
    let call = match Call::begin(s, Some(object.generation)).await {
        Ok(call) => call,
        Err(reason) => return Ok(JvmFieldsResult::Unavailable { reason }),
    };
    let result = call.run(call.inspector.fields(&call.target, object.id)).await;
    Ok(match settle(call.finish(result))? {
        Ok(fields) => JvmFieldsResult::Ready { fields },
        Err(reason) => JvmFieldsResult::Unavailable { reason },
    })
}

pub(crate) async fn referrers(s: &Session, object: JvmObjectRef, limit: u32) -> IdeResult<JvmReferrersResult> {
    let limit = if limit == 0 { DEFAULT_REFERRERS } else { limit.min(MAX_REFERRERS) };
    let call = match Call::begin(s, Some(object.generation)).await {
        Ok(call) => call,
        Err(reason) => return Ok(JvmReferrersResult::Unavailable { reason }),
    };
    let result = call.run(call.inspector.referrers(&call.target, object.id, limit)).await;
    Ok(match settle(call.finish(result))? {
        Ok(referrers) => JvmReferrersResult::Ready { truncated: referrers.len() >= limit as usize, referrers },
        Err(reason) => JvmReferrersResult::Unavailable { reason },
    })
}

/// One inspector request. Holds the session's inspect lock and a clone of its inspector, which
/// [`Call::run`] lets go of when the session ends.
pub(super) struct Call<'s> {
    session: &'s Session,
    pub(super) inspector: Arc<dyn JvmInspector>,
    pub(super) target: VmTarget,
    _turn: tokio::sync::MutexGuard<'s, ()>,
}

impl<'s> Call<'s> {
    /// `object_generation`: the stop the request's object was read in.
    pub(super) async fn begin(
        s: &'s Session,
        object_generation: Option<u64>,
    ) -> Result<Call<'s>, JvmInspectUnavailable> {
        // Checked under the lock: a request queued behind another must see the state it runs in.
        let turn = s.inspect_lock.lock().await;
        let Some(inspector) = s.jvm_inspector.lock().clone() else {
            return Err(JvmInspectUnavailable::NoBackend);
        };
        if !s.suspended.get() {
            return Err(JvmInspectUnavailable::NotSuspended);
        }
        let target = vm_target(s);
        if object_generation.is_some_and(|g| g != target.generation) {
            return Err(JvmInspectUnavailable::Stale);
        }
        Ok(Call { session: s, inspector, target, _turn: turn })
    }

    pub(super) async fn run<T>(&self, request: InspectFuture<'_, T>) -> Result<T, InspectError> {
        tokio::select! {
            result = request => result,
            () = self.session.ended.cancelled() => Err(InspectError::Closed),
        }
    }

    /// The result unless the program stopped or resumed while it was read: a request of several
    /// commands can straddle a stop. `Unsupported` turns the backend off.
    pub(super) fn finish<T>(self, result: Result<T, InspectError>) -> Result<T, InspectError> {
        let s = self.session;
        match result {
            Err(InspectError::Unsupported(detail)) => {
                turn_off(s, &self.inspector, &detail);
                Err(InspectError::Unsupported(detail))
            }
            _ if !s.suspended.get() || s.suspended.ticket() != self.target.generation => Err(InspectError::Stale),
            result => result,
        }
    }
}

/// An adapter that lacks what the inspector needs will not gain it during the session.
fn turn_off(s: &Session, inspector: &Arc<dyn JvmInspector>, detail: &str) {
    let removed = {
        let mut slot = s.jvm_inspector.lock();
        // Not one installed since this request began.
        let current = slot.as_ref().is_some_and(|i| std::ptr::addr_eq(Arc::as_ptr(i), Arc::as_ptr(inspector)));
        current && slot.take().is_some()
    };
    if removed {
        s.emit(DebugEvent::JvmBackend { state: JvmBackendState::Unsupported { detail: detail.to_owned() } });
        s.emit(DebugEvent::Capabilities);
    }
}

/// A failure the inspector could not classify is an error, not a reason shown to the user.
fn settle<T>(result: Result<T, InspectError>) -> IdeResult<Result<T, JvmInspectUnavailable>> {
    use JvmInspectUnavailable as U;
    let error = match result {
        Ok(value) => return Ok(Ok(value)),
        Err(error) => error,
    };
    Ok(Err(match error {
        InspectError::NotSuspended => U::NotSuspended,
        InspectError::Stale => U::Stale,
        InspectError::Collected => U::Collected,
        InspectError::ClassNotLoaded => U::ClassNotLoaded,
        InspectError::VmNotFound => U::VmNotFound,
        InspectError::Unsupported(detail) => U::Unsupported { detail },
        // Also the Kotlin link's `Busy`: the backend stays.
        InspectError::TimedOut => U::TimedOut,
        InspectError::Closed => U::BackendClosed,
        InspectError::Failed(message) => return Err(IdeError::internal(format!("JVM inspector: {message}"))),
    }))
}

/// Reports a Kotlin link that stops inspecting or closes. Holds neither the link nor the
/// session: it ends once the session drops the link, and never drops it itself (after
/// `VirtualMachine.Dispose` the link is closed but still forwarding the reply).
pub(crate) fn watch_link(s: &Arc<Session>, link: &ide_jdwp::JdwpLink) {
    let mut states = link.subscribe();
    let session = Arc::downgrade(s);
    tokio::spawn(async move {
        let mut reported = None;
        loop {
            let state = match &*states.borrow_and_update() {
                ide_jdwp::LinkState::Degraded(detail) => Some(JvmBackendState::Degraded { detail: detail.clone() }),
                ide_jdwp::LinkState::Closed => Some(JvmBackendState::Closed),
                _ => None,
            };
            if let Some(state) = state
                && reported.as_ref() != Some(&state)
            {
                let Some(s) = session.upgrade() else { return };
                if s.ended.is_cancelled() || s.terminated.load(std::sync::atomic::Ordering::Acquire) {
                    return;
                }
                s.emit(DebugEvent::JvmBackend { state: state.clone() });
                reported = Some(state);
            }
            if states.changed().await.is_err() {
                return;
            }
        }
    });
}
