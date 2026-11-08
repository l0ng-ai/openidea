//! A scripted [`JvmInspector`] and a session without an adapter behind it.

use crate::SessionOwner;
use crate::adapter::{AdapterSpec, Transport};
use crate::connection::Connection;
use crate::session::Session;
use ide_core::{DebugSessionId, IdeEvent, SharedSink};
use ide_jvm_inspect::{
    ClassCount, InspectError, InspectFuture, JvmField, JvmInspector, JvmReferrer, JvmValue, ObjectId, VmTarget,
};
use parking_lot::Mutex;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::sync::Notify;

#[derive(Default)]
pub(crate) struct FakeInspector {
    pub targets: Mutex<Vec<VmTarget>>,
    /// The `limit` of each `instances` / `referrers` call.
    pub limits: Mutex<Vec<u32>>,
    pub calls: AtomicUsize,
    /// Returned by every call when set.
    pub error: Mutex<Option<InspectError>>,
    pub counts: Mutex<Vec<ClassCount>>,
    pub instances: Mutex<Vec<JvmValue>>,
    /// Every call signals `entered`, then waits for `release`.
    pub hold: bool,
    pub entered: Notify,
    pub release: Notify,
}

impl FakeInspector {
    pub fn failing(error: InspectError) -> Self {
        Self { error: Mutex::new(Some(error)), ..Self::default() }
    }

    pub fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }

    async fn answer<T: Send>(&self, target: &VmTarget, limit: Option<u32>, ok: T) -> Result<T, InspectError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.targets.lock().push(target.clone());
        self.limits.lock().extend(limit);
        if self.hold {
            self.entered.notify_one();
            self.release.notified().await;
        }
        match self.error.lock().clone() {
            Some(e) => Err(e),
            None => Ok(ok),
        }
    }
}

impl JvmInspector for FakeInspector {
    fn class_counts<'a>(&'a self, target: &'a VmTarget) -> InspectFuture<'a, Vec<ClassCount>> {
        Box::pin(self.answer(target, None, self.counts.lock().clone()))
    }

    fn instances<'a>(&'a self, target: &'a VmTarget, _: &'a str, limit: u32) -> InspectFuture<'a, Vec<JvmValue>> {
        Box::pin(self.answer(target, Some(limit), self.instances.lock().clone()))
    }

    fn fields<'a>(&'a self, target: &'a VmTarget, _: ObjectId) -> InspectFuture<'a, Vec<JvmField>> {
        Box::pin(self.answer(target, None, Vec::new()))
    }

    fn referrers<'a>(&'a self, target: &'a VmTarget, _: ObjectId, limit: u32) -> InspectFuture<'a, Vec<JvmReferrer>> {
        Box::pin(self.answer(target, Some(limit), Vec::new()))
    }
}

pub(crate) struct BareSession {
    pub session: Arc<Session>,
    pub events: Arc<Mutex<Vec<IdeEvent>>>,
    /// The adapter's end of the connection, kept open.
    _adapter: tokio::io::DuplexStream,
}

/// A java-debug session that no adapter answers; must be called inside a Tokio runtime.
pub(crate) fn bare_session(request: &str) -> BareSession {
    let events: Arc<Mutex<Vec<IdeEvent>>> = Arc::default();
    let sink_events = events.clone();
    let sink: SharedSink = Arc::new(move |e: IdeEvent| sink_events.lock().push(e));
    let (client, adapter) = tokio::io::duplex(1 << 10);
    let (reader, writer) = tokio::io::split(client);
    let (conn, _) = Connection::start(reader, writer);
    let spec = AdapterSpec {
        adapter: "java-debug".into(),
        command: String::new(),
        args: Vec::new(),
        transport: Transport::Stdio,
        install_hint: None,
        cwd: std::env::temp_dir(),
        env: Vec::new(),
        server_host: None,
        connect: None,
        pinned: None,
    };
    let session = Session::new(
        DebugSessionId(1),
        SessionOwner::new("test", sink),
        "test".into(),
        "java-debug".into(),
        None,
        request.into(),
        conn,
        spec,
        None,
        None,
    );
    BareSession { session: Arc::new(session), events, _adapter: adapter }
}
