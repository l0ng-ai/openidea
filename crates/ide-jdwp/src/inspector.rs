//! [`JvmInspector`] over a [`JdwpLink`]: reads instances, fields and referrers with JDWP commands
//! injected while the VM is stopped. Nothing here runs code in the VM.
//!
//! The link orders the commands and releases the object ids they return. `target` is not
//! looked at: the caller (ide-dap) checks that an object belongs to the current stop.

use crate::ids::{IdSizes, ReplyIds};
use crate::link::{JdwpLink, LinkError};
use cache::Caches;
use ide_jvm_inspect::{
    ClassCount, InspectError, InspectFuture, JvmField, JvmInspector, JvmReferrer, JvmValue, ObjectId, VmTarget,
};
use std::sync::Mutex;
use std::time::Duration;

mod cache;
mod classes;
mod fields;
mod lookup;
mod preview;
mod referrers;
mod wire;

#[cfg(test)]
mod fake;
#[cfg(test)]
mod tests;

/// `ReferringObjects` walks the whole heap, so it is the slowest command after `InstanceCounts`.
const COMMAND_TIMEOUT: Duration = Duration::from_secs(30);
/// `InstanceCounts` takes seconds on a heap of millions of objects (JDK 21: 5-8 s for 10M).
const COUNTS_TIMEOUT: Duration = Duration::from_secs(120);

pub struct LinkInspector {
    link: JdwpLink,
    caches: Mutex<Caches>,
}

impl LinkInspector {
    pub fn new(link: JdwpLink) -> Self {
        LinkInspector { link, caches: Mutex::default() }
    }

    fn sizes(&self) -> Result<IdSizes, InspectError> {
        // The link learns the sizes right after the handshake, before it can see a stop.
        self.link.id_sizes().ok_or(InspectError::NotSuspended)
    }

    async fn call(&self, set: u8, cmd: u8, body: Vec<u8>, ids: ReplyIds) -> Result<Vec<u8>, InspectError> {
        self.call_within(set, cmd, body, ids, COMMAND_TIMEOUT).await
    }

    async fn call_within(
        &self,
        set: u8,
        cmd: u8,
        body: Vec<u8>,
        ids: ReplyIds,
        timeout: Duration,
    ) -> Result<Vec<u8>, InspectError> {
        self.link.command(set, cmd, body, ids, timeout).await.map_err(map_link_error)
    }
}

fn map_link_error(error: LinkError) -> InspectError {
    match error {
        LinkError::NotSuspended => InspectError::NotSuspended,
        LinkError::Stale => InspectError::Stale,
        LinkError::Degraded => InspectError::Unsupported("the JDWP link stopped inspecting".into()),
        LinkError::Closed => InspectError::Closed,
        // The stopped thread was running the adapter's code through every retry: ask again later.
        LinkError::TimedOut | LinkError::Busy => InspectError::TimedOut,
        // INVALID_OBJECT
        LinkError::Jdwp(20) => InspectError::Collected,
        // INVALID_CLASS
        LinkError::Jdwp(21) => InspectError::ClassNotLoaded,
        LinkError::Jdwp(code) => InspectError::Failed(format!("JDWP error {code}")),
        LinkError::Protocol(message) => InspectError::Failed(format!("malformed JDWP reply: {message}")),
    }
}

impl JvmInspector for LinkInspector {
    fn class_counts<'a>(&'a self, _target: &'a VmTarget) -> InspectFuture<'a, Vec<ClassCount>> {
        Box::pin(self.counts())
    }

    fn instances<'a>(
        &'a self,
        _target: &'a VmTarget,
        class_name: &'a str,
        limit: u32,
    ) -> InspectFuture<'a, Vec<JvmValue>> {
        Box::pin(self.list_instances(class_name, limit))
    }

    fn fields<'a>(&'a self, _target: &'a VmTarget, object: ObjectId) -> InspectFuture<'a, Vec<JvmField>> {
        Box::pin(self.list_fields(object))
    }

    fn referrers<'a>(
        &'a self,
        _target: &'a VmTarget,
        object: ObjectId,
        limit: u32,
    ) -> InspectFuture<'a, Vec<JvmReferrer>> {
        Box::pin(self.list_referrers(object, limit))
    }
}
