use super::ledger::DISPOSE_CHUNK;
use super::tests::{
    OPEN, Pair, WAIT, adapter_marker, command, connected, event, jvm_marker, read_packet, reply, stop, wait_state,
    within,
};
use super::*;
use crate::codec::{HEADER_LEN, Header, Reader, Writer};
use crate::ids::{IdSizes, ReplyIds};
use proptest::collection::vec;
use proptest::prelude::*;
use std::collections::HashMap;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::task::JoinHandle;

pub(super) const THREAD: u64 = 9;
const SUSPENDED: LinkState = LinkState::Suspended { generation: 1, thread: Some(THREAD) };
const QUIET: Duration = Duration::from_millis(200);

pub(super) type Disposal = (u32, Vec<(u64, u32)>);

pub(super) fn header(packet: &[u8]) -> Header {
    Header::parse(packet[..HEADER_LEN].try_into().unwrap())
}

pub(super) fn tagged(ids: &[u64]) -> Vec<u8> {
    let mut w = Writer::new();
    w.i32(ids.len() as i32);
    for &id in ids {
        w.u8(b'L');
        w.id(id, 8);
    }
    w.into_vec()
}

pub(super) fn instances_body() -> Vec<u8> {
    let mut w = Writer::new();
    w.id(0x42, 8);
    w.i32(1000);
    w.into_vec()
}

pub(super) fn spawn_command(link: &JdwpLink, timeout: Duration) -> JoinHandle<Result<Vec<u8>, LinkError>> {
    let link = link.clone();
    tokio::spawn(async move { link.command(2, 16, instances_body(), ReplyIds::TaggedObjects, timeout).await })
}

pub(super) async fn result(task: JoinHandle<Result<Vec<u8>, LinkError>>) -> Result<Vec<u8>, LinkError> {
    within("command result", task).await.unwrap()
}

async fn stopped() -> Pair {
    suspended(connected(OPEN).await).await
}

pub(super) async fn suspended(mut p: Pair) -> Pair {
    stop(&mut p, 2, THREAD).await;
    wait_state(&p.link, SUSPENDED).await;
    p
}

/// The JVM's next packet that is not the link's `SuspendCount` check; each check is answered 1.
pub(super) async fn next_own(p: &mut Pair) -> Vec<u8> {
    loop {
        let packet = read_packet(&mut p.jvm).await;
        let h = header(&packet);
        if !h.is_reply() && h.command() == (11, 12) && OWN_IDS.contains(&h.id) {
            p.jvm.write_all(&reply(h.id, 0, &1i32.to_be_bytes())).await.unwrap();
            continue;
        }
        return packet;
    }
}

/// The link's `Instances` command as the JVM receives it; returns its id.
pub(super) async fn own_instances(p: &mut Pair) -> u32 {
    let packet = next_own(p).await;
    let h = header(&packet);
    assert_eq!((h.command(), h.is_reply()), ((2, 16), false));
    assert!(OWN_IDS.contains(&h.id), "own id {:#x} outside OWN_IDS", h.id);
    assert_eq!(&packet[HEADER_LEN..], instances_body());
    h.id
}

/// Next packet must be the link's `SuspendCount` of the stopped thread; answers `count`.
async fn answer_check(p: &mut Pair, count: i32) {
    let packet = read_packet(&mut p.jvm).await;
    let h = header(&packet);
    assert_eq!((h.command(), h.is_reply()), ((11, 12), false), "expected SuspendCount, got {packet:?}");
    assert!(OWN_IDS.contains(&h.id));
    assert_eq!(&packet[HEADER_LEN..], THREAD.to_be_bytes());
    p.jvm.write_all(&reply(h.id, 0, &count.to_be_bytes())).await.unwrap();
}

async fn assert_jvm_quiet(p: &mut Pair) {
    let mut byte = [0; 1];
    let read = tokio::time::timeout(QUIET, p.jvm.read(&mut byte)).await;
    assert!(read.is_err(), "the JVM received bytes: {read:?}");
}

fn parse_dispose(body: &[u8]) -> Vec<(u64, u32)> {
    let mut r = Reader::new(body);
    let entries = (0..r.count().unwrap()).map(|_| (r.id(8).unwrap(), r.i32().unwrap() as u32)).collect();
    assert_eq!(r.remaining(), 0);
    entries
}

/// Adapter `1/9` then a marker; the JVM must see the resume first, then only the link's
/// `DisposeObjects` packets before the marker.
pub(super) async fn resume(p: &mut Pair) -> Vec<Disposal> {
    let resume = command(50, 1, 9, &[]);
    let marker = command(0x99, 1, 1, &[]);
    p.adapter.write_all(&resume).await.unwrap();
    p.adapter.write_all(&marker).await.unwrap();
    assert_eq!(read_packet(&mut p.jvm).await, resume);
    let mut out = Vec::new();
    loop {
        let packet = read_packet(&mut p.jvm).await;
        if packet == marker {
            return out;
        }
        let h = header(&packet);
        assert_eq!((h.command(), h.is_reply()), ((1, 14), false), "unexpected packet {packet:?}");
        assert!(OWN_IDS.contains(&h.id));
        out.push((h.id, parse_dispose(&packet[HEADER_LEN..])));
    }
}

pub(super) fn entries(disposals: &[Disposal]) -> Vec<Vec<(u64, u32)>> {
    disposals.iter().map(|(_, entries)| entries.clone()).collect()
}

fn ledger_is_empty(link: &JdwpLink) -> bool {
    link.inner.shared.update(|core| core.ledger.is_empty())
}

#[tokio::test]
async fn refuses_when_not_suspended() {
    let mut p = connected(OPEN).await;
    let refused = p.link.command(2, 16, instances_body(), ReplyIds::TaggedObjects, WAIT).await;
    assert_eq!(refused, Err(LinkError::NotSuspended));

    // a suspending event without a thread (CLASS_UNLOAD) cannot be checked with SuspendCount
    let unload = event(2, 9, 0);
    p.jvm.write_all(&unload).await.unwrap();
    assert_eq!(read_packet(&mut p.adapter).await, unload);
    wait_state(&p.link, LinkState::Suspended { generation: 1, thread: None }).await;
    let refused = p.link.command(2, 16, instances_body(), ReplyIds::TaggedObjects, WAIT).await;
    assert_eq!(refused, Err(LinkError::NotSuspended));
    adapter_marker(&mut p).await;

    let mut p = stopped().await;
    let reserved = command(OWN_IDS.start + 3, 1, 1, &[]);
    p.adapter.write_all(&reserved).await.unwrap();
    assert_eq!(read_packet(&mut p.jvm).await, reserved);
    wait_state(&p.link, LinkState::Degraded(RESERVED_ID.into())).await;
    let refused = p.link.command(2, 16, instances_body(), ReplyIds::TaggedObjects, WAIT).await;
    assert_eq!(refused, Err(LinkError::Degraded));
    adapter_marker(&mut p).await;

    let mut p = stopped().await;
    let dispose = command(60, 1, 6, &[]);
    p.adapter.write_all(&dispose).await.unwrap();
    assert_eq!(read_packet(&mut p.jvm).await, dispose);
    wait_state(&p.link, LinkState::Closed).await;
    let refused = p.link.command(2, 16, instances_body(), ReplyIds::TaggedObjects, WAIT).await;
    assert_eq!(refused, Err(LinkError::Closed));
    adapter_marker(&mut p).await;
}

#[tokio::test]
async fn one_internal_command_at_a_time() {
    let mut p = stopped().await;
    let first = spawn_command(&p.link, WAIT);
    let second = spawn_command(&p.link, WAIT);
    let id = own_instances(&mut p).await;
    // not even the second command's SuspendCount goes out before the first reply
    assert_jvm_quiet(&mut p).await;
    p.jvm.write_all(&reply(id, 0, &tagged(&[1]))).await.unwrap();
    let next = own_instances(&mut p).await;
    p.jvm.write_all(&reply(next, 0, &tagged(&[2]))).await.unwrap();
    let mut answers = vec![result(first).await.unwrap(), result(second).await.unwrap()];
    answers.sort();
    assert_eq!(answers, vec![tagged(&[1]), tagged(&[2])]);
}

#[tokio::test]
async fn disposes_exact_counts_after_forwarded_resume() {
    let mut p = stopped().await;
    let task = spawn_command(&p.link, WAIT);
    let id = own_instances(&mut p).await;
    let body = tagged(&[0x11, 0x11, 0x22]);
    p.jvm.write_all(&reply(id, 0, &body)).await.unwrap();
    assert_eq!(result(task).await, Ok(body));
    let disposals = resume(&mut p).await;
    assert_eq!(entries(&disposals), vec![vec![(0x11, 2), (0x22, 1)]]);
    // the JVM's answer to DisposeObjects is the link's, not the adapter's
    p.jvm.write_all(&reply(disposals[0].0, 0, &[])).await.unwrap();
    jvm_marker(&mut p).await;
    // released once: the next stop has nothing to release
    stop(&mut p, 2, THREAD).await;
    assert_eq!(resume(&mut p).await, vec![]);
}

#[tokio::test]
async fn late_reply_after_resume_is_disposed_once() {
    let mut p = stopped().await;
    let task = spawn_command(&p.link, WAIT);
    let id = own_instances(&mut p).await;
    assert_eq!(resume(&mut p).await, vec![]);
    assert_eq!(result(task).await, Err(LinkError::Stale));
    p.jvm.write_all(&reply(id, 0, &tagged(&[0x33]))).await.unwrap();
    jvm_marker(&mut p).await;
    stop(&mut p, 2, THREAD).await;
    assert_eq!(entries(&resume(&mut p).await), vec![vec![(0x33, 1)]]);
    stop(&mut p, 2, THREAD).await;
    assert_eq!(resume(&mut p).await, vec![]);
}

#[tokio::test]
async fn queued_command_is_stale_once_its_stop_ends() {
    let mut p = stopped().await;
    let first = spawn_command(&p.link, WAIT);
    let id = own_instances(&mut p).await;
    let queued = spawn_command(&p.link, WAIT);
    assert_jvm_quiet(&mut p).await;
    assert_eq!(resume(&mut p).await, vec![]);
    assert_eq!(result(first).await, Err(LinkError::Stale));
    // the resume cancels it at once, though the first command still holds the turn
    assert_eq!(result(queued).await, Err(LinkError::Stale));
    p.jvm.write_all(&reply(id, 0, &tagged(&[0x33]))).await.unwrap();
    jvm_marker(&mut p).await;
    assert_jvm_quiet(&mut p).await;
    stop(&mut p, 2, THREAD).await;
    assert_eq!(entries(&resume(&mut p).await), vec![vec![(0x33, 1)]]);
}

#[tokio::test]
async fn queued_command_never_runs_in_the_next_stop() {
    let mut p = stopped().await;
    let first = spawn_command(&p.link, WAIT);
    let id = own_instances(&mut p).await;
    let queued = spawn_command(&p.link, WAIT);
    assert_jvm_quiet(&mut p).await;
    assert_eq!(resume(&mut p).await, vec![]);
    assert_eq!(result(first).await, Err(LinkError::Stale));
    stop(&mut p, 2, THREAD).await;
    wait_state(&p.link, LinkState::Suspended { generation: 2, thread: Some(THREAD) }).await;
    // the turn comes free only in stop 2
    p.jvm.write_all(&reply(id, 0, &tagged(&[0x33]))).await.unwrap();
    jvm_marker(&mut p).await;
    // neither a SuspendCount check nor a second Instances
    assert_jvm_quiet(&mut p).await;
    assert_eq!(result(queued).await, Err(LinkError::Stale));
    assert_eq!(entries(&resume(&mut p).await), vec![vec![(0x33, 1)]]);
}

#[tokio::test]
async fn timed_out_or_cancelled_reply_is_still_counted() {
    let mut p = stopped().await;
    let timed_out = spawn_command(&p.link, Duration::from_millis(100));
    let id = own_instances(&mut p).await;
    assert_eq!(result(timed_out).await, Err(LinkError::TimedOut));
    // the abandoned command still holds the turn until its reply
    let cancelled = spawn_command(&p.link, WAIT);
    assert_jvm_quiet(&mut p).await;
    p.jvm.write_all(&reply(id, 0, &tagged(&[0x44]))).await.unwrap();

    let id = own_instances(&mut p).await;
    cancelled.abort();
    assert!(within("abort", cancelled).await.unwrap_err().is_cancelled());
    p.jvm.write_all(&reply(id, 0, &tagged(&[0x55]))).await.unwrap();
    jvm_marker(&mut p).await;
    assert_eq!(entries(&resume(&mut p).await), vec![vec![(0x44, 1), (0x55, 1)]]);
}

#[tokio::test]
async fn malformed_reply_is_leaked_not_disposed() {
    let mut p = stopped().await;
    let task = spawn_command(&p.link, WAIT);
    let id = own_instances(&mut p).await;
    let mut cut = tagged(&[0x11, 0x22]);
    cut.truncate(cut.len() - 3);
    p.jvm.write_all(&reply(id, 0, &cut)).await.unwrap();
    assert!(matches!(result(task).await, Err(LinkError::Protocol(_))));
    assert_eq!(resume(&mut p).await, vec![]);
}

#[tokio::test]
async fn jdwp_error_reply_counts_nothing() {
    let mut p = stopped().await;
    let task = spawn_command(&p.link, WAIT);
    let id = own_instances(&mut p).await;
    // a body the link must not read, though it would parse
    p.jvm.write_all(&reply(id, 20, &tagged(&[0x11]))).await.unwrap();
    assert_eq!(result(task).await, Err(LinkError::Jdwp(20)));
    assert!(ledger_is_empty(&p.link));
    assert_eq!(resume(&mut p).await, vec![]);
}

#[tokio::test]
async fn invalid_object_keeps_link_healthy() {
    let mut p = stopped().await;
    let task = spawn_command(&p.link, WAIT);
    let id = own_instances(&mut p).await;
    p.jvm.write_all(&reply(id, 20, &[])).await.unwrap();
    assert_eq!(result(task).await, Err(LinkError::Jdwp(20)));
    assert_eq!(p.link.state(), SUSPENDED);
    let task = spawn_command(&p.link, WAIT);
    let id = own_instances(&mut p).await;
    p.jvm.write_all(&reply(id, 0, &tagged(&[0x11]))).await.unwrap();
    assert_eq!(result(task).await, Ok(tagged(&[0x11])));
}

#[tokio::test]
async fn no_dispose_after_vm_dispose_or_close() {
    let mut p = stopped().await;
    let task = spawn_command(&p.link, WAIT);
    let id = own_instances(&mut p).await;
    p.jvm.write_all(&reply(id, 0, &tagged(&[0x11]))).await.unwrap();
    assert!(result(task).await.is_ok());
    let dispose = command(60, 1, 6, &[]);
    p.adapter.write_all(&dispose).await.unwrap();
    assert_eq!(read_packet(&mut p.jvm).await, dispose);
    wait_state(&p.link, LinkState::Closed).await;
    assert_jvm_quiet(&mut p).await;
    // forwarding continues, but the ledger is gone
    assert_eq!(resume(&mut p).await, vec![]);

    let mut p = stopped().await;
    let task = spawn_command(&p.link, WAIT);
    let id = own_instances(&mut p).await;
    p.jvm.write_all(&reply(id, 0, &tagged(&[0x11]))).await.unwrap();
    assert!(result(task).await.is_ok());
    let Pair { link, adapter, mut jvm } = p;
    drop(adapter);
    wait_state(&link, LinkState::Closed).await;
    let mut rest = Vec::new();
    within("jvm eof", jvm.read_to_end(&mut rest)).await.unwrap();
    assert_eq!(rest, Vec::<u8>::new(), "the JVM received bytes after the adapter left");
}

#[tokio::test]
async fn disposes_in_chunks_of_1000() {
    let mut p = stopped().await;
    let task = spawn_command(&p.link, WAIT);
    let id = own_instances(&mut p).await;
    let ids: Vec<u64> = (1..=2500).collect();
    p.jvm.write_all(&reply(id, 0, &tagged(&ids))).await.unwrap();
    assert!(result(task).await.is_ok());
    let chunks = entries(&resume(&mut p).await);
    assert_eq!(chunks.iter().map(Vec::len).collect::<Vec<_>>(), vec![DISPOSE_CHUNK, DISPOSE_CHUNK, 500]);
    let mut all: Vec<_> = chunks.concat();
    all.sort_unstable();
    assert_eq!(all, ids.iter().map(|&id| (id, 1)).collect::<Vec<_>>());
}

#[tokio::test]
async fn suspend_count_zero_retries_then_runs() {
    let mut p = stopped().await;
    let task = spawn_command(&p.link, WAIT);
    answer_check(&mut p, 0).await;
    answer_check(&mut p, 1).await;
    let id = own_instances(&mut p).await;
    p.jvm.write_all(&reply(id, 0, &tagged(&[0x11]))).await.unwrap();
    assert_eq!(result(task).await, Ok(tagged(&[0x11])));

    // never suspended: five checks, then Busy, and nothing else reaches the JVM
    let task = spawn_command(&p.link, WAIT);
    for _ in 0..5 {
        answer_check(&mut p, 0).await;
    }
    assert_eq!(result(task).await, Err(LinkError::Busy));
    adapter_marker(&mut p).await;
}

#[tokio::test]
async fn busy_while_adapter_invokes() {
    let mut p = stopped().await;
    let invoke = command(20, 9, 6, &[0; 24]);
    p.adapter.write_all(&invoke).await.unwrap();
    assert_eq!(read_packet(&mut p.jvm).await, invoke);
    let task = spawn_command(&p.link, WAIT);
    // SuspendCount still says 1: the pending invoke alone keeps the command out
    for _ in 0..5 {
        answer_check(&mut p, 1).await;
    }
    assert_eq!(result(task).await, Err(LinkError::Busy));
    adapter_marker(&mut p).await;
    assert!(ledger_is_empty(&p.link));
    let answer = reply(20, 0, &[b'I', 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    p.jvm.write_all(&answer).await.unwrap();
    assert_eq!(read_packet(&mut p.adapter).await, answer);
    let task = spawn_command(&p.link, WAIT);
    let id = own_instances(&mut p).await;
    p.jvm.write_all(&reply(id, 0, &tagged(&[]))).await.unwrap();
    assert_eq!(result(task).await, Ok(tagged(&[])));
}

#[tokio::test]
async fn id_sizes_come_from_the_link_reply() {
    let p = stopped().await;
    assert_eq!(p.link.id_sizes(), Some(IdSizes { field: 8, method: 8, object: 8, reference_type: 8, frame: 8 }));
}

#[tokio::test]
async fn ids_outlive_the_resume_of_another_stopped_thread() {
    let mut p = connected(OPEN).await;
    stop(&mut p, 1, 7).await;
    stop(&mut p, 1, THREAD).await;
    wait_state(&p.link, LinkState::Suspended { generation: 2, thread: Some(THREAD) }).await;
    let task = spawn_command(&p.link, WAIT);
    let id = own_instances(&mut p).await;
    p.jvm.write_all(&reply(id, 0, &tagged(&[0x66]))).await.unwrap();
    assert_eq!(result(task).await, Ok(tagged(&[0x66])));
    // The stop on THREAD goes on, so do the ids read during it.
    let resume_other = command(51, 11, 3, &7u64.to_be_bytes());
    p.adapter.write_all(&resume_other).await.unwrap();
    assert_eq!(read_packet(&mut p.jvm).await, resume_other);
    adapter_marker(&mut p).await;
    assert_eq!(entries(&resume(&mut p).await), vec![vec![(0x66, 1)]]);
}

#[derive(Debug, Clone)]
enum Step {
    Stop,
    Command,
    Reply { ids: Vec<u64>, error: bool },
    Resume,
    Close,
}

fn steps() -> impl Strategy<Value = Vec<Step>> {
    let step = prop_oneof![
        3 => Just(Step::Stop),
        4 => Just(Step::Command),
        4 => (vec(1u64..6, 0..5), proptest::bool::weighted(0.2)).prop_map(|(ids, error)| Step::Reply { ids, error }),
        3 => Just(Step::Resume),
        1 => Just(Step::Close),
    ];
    vec(step, 0..24)
}

fn add(counts: &mut HashMap<u64, u32>, entries: impl IntoIterator<Item = (u64, u32)>) {
    for (id, n) in entries {
        *counts.entry(id).or_default() += n;
    }
}

fn assert_within(disposed: &HashMap<u64, u32>, received: &HashMap<u64, u32>) {
    for (id, &n) in disposed {
        let got = received.get(id).copied().unwrap_or(0);
        assert!(n <= got, "disposed {id:#x} {n} times, received it {got} times");
    }
}

/// Resumes, answers each `DisposeObjects` and adds its entries to `disposed`.
async fn release(p: &mut Pair, disposed: &mut HashMap<u64, u32>) {
    for (id, entries) in resume(p).await {
        p.jvm.write_all(&reply(id, 0, &[])).await.unwrap();
        add(disposed, entries);
    }
}

/// Plays `steps` against the link; checks that no id is ever disposed more often than the
/// JVM handed it to the link, and that a last stop and resume release every one of them.
async fn interleave(steps: Vec<Step>) {
    let mut p = connected(OPEN).await;
    let (mut stopped, mut closed) = (false, false);
    let mut pending: Option<u32> = None;
    let mut tasks = Vec::new();
    let (mut received, mut disposed) = (HashMap::new(), HashMap::new());
    for step in steps {
        match step {
            Step::Stop if !closed => {
                stop(&mut p, 2, THREAD).await;
                stopped = true;
            }
            Step::Command if stopped && !closed && pending.is_none() => {
                tasks.push(spawn_command(&p.link, WAIT));
                pending = Some(own_instances(&mut p).await);
            }
            Step::Reply { ids, error } if pending.is_some() => {
                let id = pending.take().unwrap();
                p.jvm.write_all(&reply(id, if error { 20 } else { 0 }, &tagged(&ids))).await.unwrap();
                if !error {
                    add(&mut received, ids.iter().map(|&id| (id, 1)));
                }
            }
            Step::Resume => {
                release(&mut p, &mut disposed).await;
                stopped = false;
            }
            Step::Close if !closed => {
                let dispose = command(60, 1, 6, &[]);
                p.adapter.write_all(&dispose).await.unwrap();
                assert_eq!(read_packet(&mut p.jvm).await, dispose);
                closed = true;
            }
            _ => {}
        }
        assert_within(&disposed, &received);
    }
    if let Some(id) = pending.take() {
        p.jvm.write_all(&reply(id, 0, &tagged(&[1]))).await.unwrap();
        add(&mut received, [(1, 1)]);
    }
    if !closed {
        stop(&mut p, 2, THREAD).await;
    }
    release(&mut p, &mut disposed).await;
    assert_within(&disposed, &received);
    if !closed {
        assert_eq!(disposed, received);
    }
    // nothing the JVM sent the link reached the adapter
    jvm_marker(&mut p).await;
    for task in tasks {
        let result = result(task).await;
        assert!(
            matches!(result, Ok(_) | Err(LinkError::Stale | LinkError::Closed | LinkError::Jdwp(20))),
            "{result:?}"
        );
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]

    #[test]
    fn never_disposes_more_than_received(steps in steps()) {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(interleave(steps));
    }
}
