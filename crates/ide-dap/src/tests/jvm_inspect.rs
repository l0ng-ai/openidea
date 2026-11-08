//! Instances, fields and referrers through a session's JVM inspector.

use super::*;
use crate::jvm_memory::test_support::FakeInspector;
use ide_core::event::JvmBackendState;
use ide_jvm_inspect::{InspectError, JvmValue, VmTarget};
use tokio::io::AsyncReadExt;

fn debug_events(h: &Harness) -> Vec<DebugEvent> {
    h.events
        .lock()
        .iter()
        .filter_map(|e| match e {
            IdeEvent::Debug { event, .. } => Some(event.clone()),
            _ => None,
        })
        .collect()
}

fn backend_events(h: &Harness) -> Vec<JvmBackendState> {
    debug_events(h)
        .into_iter()
        .filter_map(|e| match e {
            DebugEvent::JvmBackend { state } => Some(state),
            _ => None,
        })
        .collect()
}

/// A java-debug session stopped at its breakpoint, inspected by `fake`.
async fn stopped_with(h: &Harness, config: LaunchConfig, fake: &Arc<FakeInspector>) -> DebugSessionId {
    let id = h.start(config).await.unwrap();
    h.wait_event(|e| matches!(e, DebugEvent::Stopped { .. })).await;
    h.manager.set_jvm_inspector(id, fake.clone()).unwrap();
    id
}

fn object(id: u64) -> JvmValue {
    JvmValue::Object { id, type_name: "A".into() }
}

const NOT_SUSPENDED: JvmInstancesResult =
    JvmInstancesResult::Unavailable { reason: JvmInspectUnavailable::NotSuspended };

#[tokio::test]
async fn instances_need_a_suspended_session() {
    let h = harness(Script { continued_after_stop: true, ..Script::default() });
    let id = h.start(java_config("launch")).await.unwrap();
    h.wait_event(|e| matches!(e, DebugEvent::Continued { .. })).await;
    let fake = Arc::new(FakeInspector::default());
    h.manager.set_jvm_inspector(id, fake.clone()).unwrap();
    assert_eq!(h.manager.jvm_memory_instances(id, "A".into(), 10).await.unwrap(), NOT_SUSPENDED);
    assert_eq!(fake.calls(), 0);
}

#[tokio::test]
async fn instances_without_an_inspector_have_no_backend() {
    let h = harness(Script::default());
    let id = h.start(java_config("launch")).await.unwrap();
    h.wait_event(|e| matches!(e, DebugEvent::Stopped { .. })).await;
    assert_eq!(
        h.manager.jvm_memory_instances(id, "A".into(), 10).await.unwrap(),
        JvmInstancesResult::Unavailable { reason: JvmInspectUnavailable::NoBackend }
    );
}

#[tokio::test]
async fn object_from_previous_stop_is_stale() {
    let h = harness(Script::default());
    let fake = Arc::new(FakeInspector::default());
    fake.instances.lock().push(object(7));
    let id = stopped_with(&h, java_config("launch"), &fake).await;
    let JvmInstancesResult::Ready { generation, instances, truncated } =
        h.manager.jvm_memory_instances(id, "A".into(), 10).await.unwrap()
    else {
        panic!("instances unavailable");
    };
    assert_eq!((generation, instances, truncated), (1, vec![object(7)], false));

    h.manager.session(id).unwrap().suspended.stopped(None, true);
    let stale = JvmObjectRef { generation, id: 7 };
    assert_eq!(
        h.manager.jvm_memory_fields(id, stale).await.unwrap(),
        JvmFieldsResult::Unavailable { reason: JvmInspectUnavailable::Stale }
    );
    assert_eq!(
        h.manager.jvm_memory_referrers(id, stale, 10).await.unwrap(),
        JvmReferrersResult::Unavailable { reason: JvmInspectUnavailable::Stale }
    );
    assert_eq!(fake.calls(), 1, "a stale object never reaches the inspector");
    let current = JvmObjectRef { generation: 2, id: 7 };
    assert_eq!(h.manager.jvm_memory_fields(id, current).await.unwrap(), JvmFieldsResult::Ready { fields: Vec::new() });
}

#[tokio::test]
async fn instances_stay_readable_while_another_thread_is_stopped() {
    let h = harness(Script::default());
    let fake = Arc::new(FakeInspector::default());
    fake.instances.lock().push(object(7));
    let id = stopped_with(&h, java_config("launch"), &fake).await;
    let session = h.manager.session(id).unwrap();
    // Threads 20, 21, then 22 stop alone (SUSPEND_EVENT_THREAD).
    session.suspended.continued(Some(1), true);
    for thread in [20, 21, 22] {
        session.suspended.stopped(Some(thread), false);
    }
    let instances = || h.manager.jvm_memory_instances(id, "A".into(), 10);
    let result = instances().await.unwrap();
    let JvmInstancesResult::Ready { generation, .. } = result else { panic!("{result:?}") };
    let read_on_22 = JvmObjectRef { generation, id: 7 };

    // An earlier thread resumes: the stop on 22 goes on, and so does what was read on it.
    session.suspended.continued(Some(20), false);
    assert_eq!(
        h.manager.jvm_memory_fields(id, read_on_22).await.unwrap(),
        JvmFieldsResult::Ready { fields: Vec::new() }
    );

    // The latest one resumes: 21 is still stopped, but what was read on 22 is stale.
    session.suspended.continued(Some(22), false);
    assert_eq!(
        h.manager.jvm_memory_fields(id, read_on_22).await.unwrap(),
        JvmFieldsResult::Unavailable { reason: JvmInspectUnavailable::Stale }
    );
    let result = instances().await.unwrap();
    assert!(matches!(result, JvmInstancesResult::Ready { .. }), "{result:?}");
}

/// Starts `instances` on a held fake inspector; returns once the inspector was entered.
async fn held_request(
    h: &Harness,
    id: DebugSessionId,
    fake: &Arc<FakeInspector>,
) -> tokio::task::JoinHandle<IdeResult<JvmInstancesResult>> {
    let manager = h.manager.clone();
    let request = tokio::spawn(async move { manager.jvm_memory_instances(id, "A".into(), 10).await });
    tokio::time::timeout(Duration::from_secs(2), fake.entered.notified()).await.unwrap();
    request
}

#[tokio::test]
async fn stop_during_request_is_stale() {
    let h = harness(Script::default());
    let fake = Arc::new(FakeInspector { hold: true, ..FakeInspector::default() });
    fake.instances.lock().push(object(7));
    let id = stopped_with(&h, java_config("launch"), &fake).await;
    let request = held_request(&h, id, &fake).await;
    h.manager.session(id).unwrap().suspended.stopped(None, true);
    fake.release.notify_one();
    assert_eq!(
        request.await.unwrap().unwrap(),
        JvmInstancesResult::Unavailable { reason: JvmInspectUnavailable::Stale }
    );
}

#[tokio::test]
async fn resume_during_request_is_stale() {
    let h = harness(Script::default());
    let fake = Arc::new(FakeInspector { hold: true, ..FakeInspector::default() });
    let id = stopped_with(&h, java_config("launch"), &fake).await;
    let request = held_request(&h, id, &fake).await;
    h.manager.session(id).unwrap().suspended.continued(None, true);
    fake.release.notify_one();
    assert_eq!(
        request.await.unwrap().unwrap(),
        JvmInstancesResult::Unavailable { reason: JvmInspectUnavailable::Stale }
    );
}

#[tokio::test]
async fn one_request_at_a_time_per_session() {
    let h = harness(Script::default());
    let fake = Arc::new(FakeInspector { hold: true, ..FakeInspector::default() });
    let id = stopped_with(&h, java_config("launch"), &fake).await;
    let first = held_request(&h, id, &fake).await;
    let manager = h.manager.clone();
    let second = tokio::spawn(async move { manager.jvm_memory_instances(id, "B".into(), 10).await });
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(fake.calls(), 1, "the second request waits for the first");
    fake.release.notify_one();
    first.await.unwrap().unwrap();
    tokio::time::timeout(Duration::from_secs(2), fake.entered.notified()).await.unwrap();
    fake.release.notify_one();
    second.await.unwrap().unwrap();
    assert_eq!(fake.calls(), 2);
}

#[tokio::test]
async fn session_end_lets_go_of_a_waiting_inspector() {
    let h = harness(Script::default());
    let fake = Arc::new(FakeInspector { hold: true, ..FakeInspector::default() });
    let id = stopped_with(&h, java_config("launch"), &fake).await;
    let request = held_request(&h, id, &fake).await;
    h.manager.session(id).unwrap().kill_processes();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(2), request).await.unwrap().unwrap().unwrap(),
        JvmInstancesResult::Unavailable { reason: JvmInspectUnavailable::BackendClosed }
    );
    assert_eq!(Arc::strong_count(&fake), 1, "no clone of the inspector outlives the session");
}

#[tokio::test]
async fn target_carries_pid_for_launch() {
    let h = harness(Script { debuggee_pid: Some(4242), java_process_id: true, ..Script::default() });
    let fake = Arc::new(FakeInspector::default());
    let id = stopped_with(&h, java_config("launch"), &fake).await;
    h.manager.jvm_memory_instances(id, "A".into(), 10).await.unwrap();
    assert_eq!(
        *fake.targets.lock(),
        [VmTarget { pid: Some(4242), attach_host: None, attach_port: None, generation: 1 }]
    );
}

#[tokio::test]
async fn target_carries_attach_port_and_host() {
    let h = harness(Script::default());
    let project = tempfile::tempdir().unwrap();
    let fake = Arc::new(FakeInspector::default());
    let id = stopped_with(&h, remote_attach("java-debug", project.path()), &fake).await;
    h.manager.jvm_memory_instances(id, "A".into(), 10).await.unwrap();
    assert_eq!(
        *fake.targets.lock(),
        [VmTarget { pid: None, attach_host: Some("10.0.0.5".into()), attach_port: Some(5005), generation: 1 }]
    );
}

#[tokio::test]
async fn unsupported_backend_turns_instances_off() {
    let h = harness(Script::default());
    let fake = Arc::new(FakeInspector::failing(InspectError::Unsupported("x".into())));
    let id = stopped_with(&h, java_config("launch"), &fake).await;
    let before = debug_events(&h).len();
    assert_eq!(
        h.manager.jvm_memory_instances(id, "A".into(), 10).await.unwrap(),
        JvmInstancesResult::Unavailable { reason: JvmInspectUnavailable::Unsupported { detail: "x".into() } }
    );
    let after: Vec<_> = debug_events(&h).split_off(before);
    assert!(
        matches!(
            after.as_slice(),
            [DebugEvent::JvmBackend { state: JvmBackendState::Unsupported { detail } }, DebugEvent::Capabilities]
                if detail == "x"
        ),
        "{after:?}"
    );
    assert!(!h.manager.capabilities(id).unwrap().jvm_instances);
    assert_eq!(
        h.manager.jvm_memory_instances(id, "A".into(), 10).await.unwrap(),
        JvmInstancesResult::Unavailable { reason: JvmInspectUnavailable::NoBackend }
    );
    assert_eq!(fake.calls(), 1);
}

/// `error` is reported but leaves the backend on.
async fn keeps_the_backend(error: InspectError, reason: JvmInspectUnavailable) {
    let h = harness(Script::default());
    let fake = Arc::new(FakeInspector::failing(error));
    let id = stopped_with(&h, java_config("launch"), &fake).await;
    let object = JvmObjectRef { generation: 1, id: 7 };
    assert_eq!(h.manager.jvm_memory_fields(id, object).await.unwrap(), JvmFieldsResult::Unavailable { reason });
    assert!(h.manager.capabilities(id).unwrap().jvm_instances);
    assert!(backend_events(&h).is_empty());
    assert!(h.manager.session(id).unwrap().jvm_inspector.lock().is_some());
}

#[tokio::test]
async fn collected_keeps_the_backend() {
    keeps_the_backend(InspectError::Collected, JvmInspectUnavailable::Collected).await;
}

#[tokio::test]
async fn timed_out_keeps_the_backend() {
    keeps_the_backend(InspectError::TimedOut, JvmInspectUnavailable::TimedOut).await;
}

#[tokio::test]
async fn failed_inspection_is_an_error() {
    let h = harness(Script::default());
    let fake = Arc::new(FakeInspector::failing(InspectError::Failed("boom".into())));
    let id = stopped_with(&h, java_config("launch"), &fake).await;
    let err = h.manager.jvm_memory_instances(id, "A".into(), 10).await.unwrap_err();
    assert!(err.to_string().contains("boom"), "{err}");
    assert!(h.manager.capabilities(id).unwrap().jvm_instances);
}

#[tokio::test]
async fn limits_are_clamped() {
    let h = harness(Script::default());
    let fake = Arc::new(FakeInspector::default());
    let id = stopped_with(&h, java_config("launch"), &fake).await;
    for limit in [5000, 0] {
        h.manager.jvm_memory_instances(id, "A".into(), limit).await.unwrap();
    }
    let object = JvmObjectRef { generation: 1, id: 7 };
    for limit in [0, 900, 20] {
        h.manager.jvm_memory_referrers(id, object, limit).await.unwrap();
    }
    assert_eq!(*fake.limits.lock(), [1000, 1, 50, 200, 20]);
}

#[tokio::test]
async fn a_full_page_is_truncated() {
    let h = harness(Script::default());
    let fake = Arc::new(FakeInspector::default());
    fake.instances.lock().extend([object(1), object(2)]);
    let id = stopped_with(&h, java_config("launch"), &fake).await;
    let truncated = |r: JvmInstancesResult| match r {
        JvmInstancesResult::Ready { truncated, .. } => truncated,
        other => panic!("{other:?}"),
    };
    assert!(truncated(h.manager.jvm_memory_instances(id, "A".into(), 2).await.unwrap()));
    assert!(!truncated(h.manager.jvm_memory_instances(id, "A".into(), 3).await.unwrap()));
}

#[tokio::test]
async fn capability_follows_the_inspector() {
    let h = harness(Script::default());
    let id = h.start(java_config("launch")).await.unwrap();
    assert!(!h.manager.capabilities(id).unwrap().jvm_instances);
    let before = debug_events(&h).len();
    h.manager.set_jvm_inspector(id, Arc::new(FakeInspector::default())).unwrap();
    assert!(h.manager.capabilities(id).unwrap().jvm_instances);
    assert!(matches!(debug_events(&h).split_off(before).as_slice(), [DebugEvent::Capabilities]));
}

#[tokio::test]
async fn remote_attach_counts_classes_through_the_debugger() {
    let h = harness(Script::default());
    let project = tempfile::tempdir().unwrap();
    let fake = Arc::new(FakeInspector::default());
    fake.counts.lock().push(ide_jvm_inspect::ClassCount { name: "A".into(), instances: 3 });
    let id = stopped_with(&h, remote_attach("java-debug", project.path()), &fake).await;
    let result = h.manager.jvm_memory_classes(id).await.unwrap();
    assert!(
        matches!(&result, JvmMemoryResult::Ready { snapshot }
            if snapshot.source == JvmMemorySource::Debugger && snapshot.rows.len() == 1),
        "{result:?}"
    );
    assert_eq!(fake.targets.lock()[0].attach_port, Some(5005));
}

const HANDSHAKE: &[u8; 14] = b"JDWP-Handshake";

/// A Kotlin attach whose link reaches a fake JVM: (adapter end, JVM end) after both handshakes.
async fn linked_kotlin(h: &Harness) -> (DebugSessionId, tokio::net::TcpStream, tokio::net::TcpStream) {
    let jvm = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let project = tempfile::tempdir().unwrap();
    let id = h.start(kotlin_attach(project.path(), "127.0.0.1", jvm.local_addr().unwrap().port())).await.unwrap();
    let link_port = h.request("attach")["arguments"]["port"].as_u64().unwrap() as u16;
    let mut adapter = tokio::net::TcpStream::connect(("127.0.0.1", link_port)).await.unwrap();
    adapter.write_all(HANDSHAKE).await.unwrap();
    let (mut jvm, _) = tokio::time::timeout(Duration::from_secs(2), jvm.accept()).await.unwrap().unwrap();
    let mut buf = [0; 14];
    jvm.read_exact(&mut buf).await.unwrap();
    jvm.write_all(HANDSHAKE).await.unwrap();
    adapter.read_exact(&mut buf).await.unwrap();
    (id, adapter, jvm)
}

/// A command the adapter sends with an id from the link's own range: the link then only forwards.
async fn degrade(adapter: &mut tokio::net::TcpStream) {
    let mut packet = 11u32.to_be_bytes().to_vec();
    packet.extend(ide_jdwp::OWN_IDS.start.to_be_bytes());
    packet.extend([0, 1, 1]);
    adapter.write_all(&packet).await.unwrap();
}

async fn wait_backend(h: &Harness, want: impl Fn(&JvmBackendState) -> bool) {
    h.wait_event(|e| matches!(e, DebugEvent::JvmBackend { state } if want(state))).await;
}

#[tokio::test]
async fn kotlin_link_reports_degraded_then_closed() {
    let h = harness(Script::default());
    let (id, mut adapter, jvm) = linked_kotlin(&h).await;
    degrade(&mut adapter).await;
    wait_backend(&h, |s| matches!(s, JvmBackendState::Degraded { .. })).await;
    drop(jvm);
    wait_backend(&h, |s| *s == JvmBackendState::Closed).await;
    assert_eq!(backend_events(&h).len(), 2, "{:?}", backend_events(&h));
    let session = h.manager.session(id).unwrap();
    assert!(session.jdwp_link.lock().is_some(), "a closed link is kept until the session ends");
}

#[tokio::test]
async fn kotlin_link_is_quiet_once_the_program_ended() {
    let h = harness(Script::default());
    let (id, _adapter, jvm) = linked_kotlin(&h).await;
    let session = h.manager.session(id).unwrap();
    // The adapter reported the end; the session keeps its link until it shuts down.
    session.terminated.store(true, Ordering::Release);
    drop(jvm);
    for _ in 0..100 {
        if session.jdwp_link.lock().as_ref().is_some_and(|l| l.state() == ide_jdwp::LinkState::Closed) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(backend_events(&h).is_empty(), "{:?}", backend_events(&h));
}
