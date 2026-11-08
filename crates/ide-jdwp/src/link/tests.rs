use super::*;
use crate::codec::{FLAG_REPLY, HEADER_LEN, Header, MAX_ADAPTER_PACKET, Writer};
use proptest::collection::vec;
use proptest::prelude::*;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt, DuplexStream};
use tokio::net::{TcpListener, TcpStream};

pub(super) const WAIT: Duration = Duration::from_secs(5);
const HANDSHAKE: &[u8; 14] = b"JDWP-Handshake";
const HELD: LinkOptions = LinkOptions { hold_resumes: true };
pub(super) const OPEN: LinkOptions = LinkOptions { hold_resumes: false };

pub(super) fn command(id: u32, set: u8, cmd: u8, body: &[u8]) -> Vec<u8> {
    let mut out = Header::command_bytes(id, set, cmd, body.len()).to_vec();
    out.extend_from_slice(body);
    out
}

pub(super) fn reply(id: u32, error: u16, body: &[u8]) -> Vec<u8> {
    let mut out = command(id, 0, 0, body);
    out[8] = FLAG_REPLY;
    out[9..11].copy_from_slice(&error.to_be_bytes());
    out
}

/// Composite event with one event of `kind`; `thread` is written with 8 bytes.
pub(super) fn event(policy: u8, kind: u8, thread: u64) -> Vec<u8> {
    let mut w = Writer::new();
    w.u8(policy);
    w.i32(1);
    w.u8(kind);
    w.i32(3);
    w.id(thread, 8);
    command(0x100, 64, 100, &w.into_vec())
}

fn id_sizes_body() -> Vec<u8> {
    let mut w = Writer::new();
    for _ in 0..5 {
        w.i32(8);
    }
    w.into_vec()
}

pub(super) async fn within<T>(what: &str, f: impl Future<Output = T>) -> T {
    tokio::time::timeout(WAIT, f).await.unwrap_or_else(|_| panic!("timed out: {what}"))
}

pub(super) async fn read_packet(stream: &mut (impl AsyncRead + Unpin)) -> Vec<u8> {
    within("packet", async {
        let mut header = [0; HEADER_LEN];
        stream.read_exact(&mut header).await.expect("packet header");
        let len = Header::parse(&header).length as usize;
        let mut out = vec![0; len];
        out[..HEADER_LEN].copy_from_slice(&header);
        stream.read_exact(&mut out[HEADER_LEN..]).await.expect("packet body");
        out
    })
    .await
}

pub(super) async fn assert_eof(stream: &mut (impl AsyncRead + Unpin), side: &str) {
    let mut byte = [0; 1];
    let read = within(side, stream.read(&mut byte)).await;
    assert!(matches!(read, Ok(0) | Err(_)), "{side} still open: {read:?}");
}

pub(super) async fn wait_state(link: &JdwpLink, want: LinkState) {
    let mut rx = link.subscribe();
    let seen = tokio::time::timeout(WAIT, rx.wait_for(|s| *s == want)).await;
    assert!(matches!(seen, Ok(Ok(_))), "state {:?}, wanted {want:?}", link.state());
}

pub(super) struct Pair {
    pub(super) link: JdwpLink,
    pub(super) adapter: DuplexStream,
    pub(super) jvm: DuplexStream,
}

pub(super) fn pair(options: LinkOptions) -> Pair {
    pair_over(options, |jvm| jvm)
}

/// `wrap` turns the link's end of the JVM stream into the one the link uses.
pub(super) fn pair_over<J>(options: LinkOptions, wrap: impl FnOnce(DuplexStream) -> J) -> Pair
where
    J: AsyncRead + tokio::io::AsyncWrite + Send + Unpin + 'static,
{
    let (adapter, link_adapter) = tokio::io::duplex(64 * 1024);
    let (link_jvm, jvm) = tokio::io::duplex(64 * 1024);
    let link = JdwpLink::spawn_over(link_adapter, wrap(link_jvm), options);
    Pair { link, adapter, jvm }
}

/// Both handshakes; returns the id of the link's own `IDSizes` command without answering it.
async fn handshake(p: &mut Pair) -> u32 {
    p.adapter.write_all(HANDSHAKE).await.unwrap();
    let mut buf = [0; 14];
    within("adapter handshake", p.jvm.read_exact(&mut buf)).await.unwrap();
    assert_eq!(&buf, HANDSHAKE);
    p.jvm.write_all(HANDSHAKE).await.unwrap();
    within("jvm handshake", p.adapter.read_exact(&mut buf)).await.unwrap();
    assert_eq!(&buf, HANDSHAKE);
    let own = read_packet(&mut p.jvm).await;
    let h = Header::parse(own[..HEADER_LEN].try_into().unwrap());
    assert_eq!((h.command(), h.length, h.is_reply()), ((1, 7), 11, false));
    assert!(OWN_IDS.contains(&h.id), "IDSizes id {:#x} outside OWN_IDS", h.id);
    h.id
}

/// Handshake and answer the link's `IDSizes` with 8-byte ids.
pub(super) async fn connected(options: LinkOptions) -> Pair {
    connect(pair(options)).await
}

pub(super) async fn connect(mut p: Pair) -> Pair {
    let own = handshake(&mut p).await;
    p.jvm.write_all(&reply(own, 0, &id_sizes_body())).await.unwrap();
    p
}

/// A packet the JVM sends after the bytes under test; the adapter must see it next.
pub(super) async fn jvm_marker(p: &mut Pair) {
    let marker = event(0, 8, 0x55);
    p.jvm.write_all(&marker).await.unwrap();
    assert_eq!(read_packet(&mut p.adapter).await, marker);
}

/// A packet the adapter sends after the bytes under test; the JVM must see it next.
pub(super) async fn adapter_marker(p: &mut Pair) {
    let marker = command(0x99, 1, 1, &[]);
    p.adapter.write_all(&marker).await.unwrap();
    assert_eq!(read_packet(&mut p.jvm).await, marker);
}

pub(super) async fn stop(p: &mut Pair, policy: u8, thread: u64) {
    let bp = event(policy, 2, thread);
    p.jvm.write_all(&bp).await.unwrap();
    assert_eq!(read_packet(&mut p.adapter).await, bp);
}

#[tokio::test]
async fn holds_resumes_but_allows_setup_and_preserves_partial_reads() {
    let mut p = pair(HELD);
    let own = handshake(&mut p).await;
    wait_state(&p.link, LinkState::Held).await;
    let resume = command(1, 1, 9, &[]);
    let thread_resume = command(2, 11, 3, &[0; 8]);
    let setup = command(3, 1, 4, &[]);
    p.adapter.write_all(&resume).await.unwrap();
    p.adapter.write_all(&thread_resume).await.unwrap();
    p.adapter.write_all(&setup).await.unwrap();
    // the link's IDSizes came first and the adapter's packets keep their own order
    assert_eq!(read_packet(&mut p.jvm).await, setup);
    p.jvm.write_all(&reply(own, 0, &id_sizes_body())).await.unwrap();
    let next = command(4, 1, 9, &[]);
    p.adapter.write_all(&next[..6]).await.unwrap();
    // give the link time to start reading the partial packet before it is released
    tokio::time::sleep(Duration::from_millis(50)).await;
    p.link.release();
    assert_eq!(read_packet(&mut p.jvm).await, resume);
    assert_eq!(read_packet(&mut p.jvm).await, thread_resume);
    p.adapter.write_all(&next[6..]).await.unwrap();
    assert_eq!(read_packet(&mut p.jvm).await, next);
    wait_state(&p.link, LinkState::Ready).await;
}

#[tokio::test]
async fn resumes_pass_through_without_hold() {
    let mut p = pair(OPEN);
    handshake(&mut p).await;
    wait_state(&p.link, LinkState::Ready).await;
    let resume = command(1, 1, 9, &[]);
    p.adapter.write_all(&resume).await.unwrap();
    assert_eq!(read_packet(&mut p.jvm).await, resume);
    assert_eq!(p.link.state(), LinkState::Ready);
}

#[tokio::test]
async fn dropping_link_closes_both_sockets() {
    for options in [HELD, OPEN] {
        let mut p = connected(options).await;
        // the assignment drops the original handle; the clone must keep the link alive
        p.link = p.link.clone();
        adapter_marker(&mut p).await;
        let Pair { link, mut adapter, mut jvm } = p;
        drop(link);
        assert_eof(&mut adapter, "adapter").await;
        assert_eof(&mut jvm, "jvm").await;
    }
}

#[tokio::test]
async fn one_side_closing_closes_the_other() {
    let p = connected(OPEN).await;
    let Pair { link, mut adapter, jvm } = p;
    drop(jvm);
    wait_state(&link, LinkState::Closed).await;
    assert_eof(&mut adapter, "adapter").await;

    let p = connected(OPEN).await;
    let Pair { link, adapter, mut jvm } = p;
    drop(adapter);
    wait_state(&link, LinkState::Closed).await;
    assert_eof(&mut jvm, "jvm").await;
}

#[tokio::test]
async fn start_relays_over_tcp_and_drop_closes_both() {
    let jvm_listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let jvm_port = jvm_listener.local_addr().unwrap().port();
    let (link, port) = JdwpLink::start("127.0.0.1".into(), jvm_port, OPEN).await.unwrap();
    assert_eq!(link.state(), LinkState::Connecting);
    let mut adapter = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let (mut jvm, _) = within("jvm accept", jvm_listener.accept()).await.unwrap();
    adapter.write_all(HANDSHAKE).await.unwrap();
    let mut buf = [0; 14];
    within("handshake", jvm.read_exact(&mut buf)).await.unwrap();
    jvm.write_all(HANDSHAKE).await.unwrap();
    within("handshake", adapter.read_exact(&mut buf)).await.unwrap();
    wait_state(&link, LinkState::Ready).await;
    drop(link);
    assert_eof(&mut adapter, "adapter").await;
    read_packet(&mut jvm).await; // the link's IDSizes
    assert_eof(&mut jvm, "jvm").await;
}

#[tokio::test]
async fn rejects_invalid_adapter_packet_lengths() {
    for len in [0_u32, 10, MAX_ADAPTER_PACKET as u32 + 1] {
        let mut p = connected(HELD).await;
        let mut bytes = command(1, 1, 9, &[]);
        bytes[..4].copy_from_slice(&len.to_be_bytes());
        p.adapter.write_all(&bytes).await.unwrap();
        wait_state(&p.link, LinkState::Closed).await;
        assert_eof(&mut p.adapter, "adapter").await;
        assert_eof(&mut p.jvm, "jvm").await;
    }
    // the upper bound itself is accepted
    let Pair { link, mut adapter, mut jvm } = connected(OPEN).await;
    let largest = command(1, 1, 1, &vec![7; MAX_ADAPTER_PACKET - HEADER_LEN]);
    let sent = largest.clone();
    let writer = tokio::spawn(async move { adapter.write_all(&sent).await.map(|()| adapter) });
    assert!(read_packet(&mut jvm).await == largest);
    writer.await.unwrap().unwrap();
    assert_eq!(link.state(), LinkState::Ready);
}

#[tokio::test]
async fn too_many_held_resumes_close_the_link() {
    let mut p = connected(HELD).await;
    for id in 0..1024 {
        p.adapter.write_all(&command(id, 11, 3, &[0; 8])).await.unwrap();
    }
    adapter_marker(&mut p).await;
    p.adapter.write_all(&command(1024, 11, 3, &[0; 8])).await.unwrap();
    wait_state(&p.link, LinkState::Closed).await;
    assert_eof(&mut p.jvm, "jvm").await;
}

#[tokio::test]
async fn forwards_large_jvm_packet_unchanged() {
    let mut p = connected(OPEN).await;
    let request = command(5, 13, 2, &[0; 16]);
    p.adapter.write_all(&request).await.unwrap();
    assert_eq!(read_packet(&mut p.jvm).await, request);
    let body: Vec<u8> = (0..20 * 1024 * 1024u32).map(|i| (i.wrapping_mul(2_654_435_761) >> 13) as u8).collect();
    let big = reply(5, 0, &body);
    let mut jvm = p.jvm;
    let sent = big.clone();
    let writer = tokio::spawn(async move {
        jvm.write_all(&sent).await.unwrap();
        jvm
    });
    let mut got = vec![0; big.len()];
    within("20 MiB reply", p.adapter.read_exact(&mut got)).await.unwrap();
    p.jvm = writer.await.unwrap();
    assert!(got == big, "reply changed on the way");
    jvm_marker(&mut p).await;
}

#[tokio::test]
async fn own_reply_never_reaches_adapter() {
    let mut p = pair(OPEN);
    let own = handshake(&mut p).await;
    p.jvm.write_all(&reply(own, 0, &id_sizes_body())).await.unwrap();
    jvm_marker(&mut p).await;
}

#[tokio::test]
async fn stop_event_starts_generation_and_resume_ends_it() {
    let mut p = connected(OPEN).await;
    assert_eq!(p.link.generation(), 0);
    stop(&mut p, 2, 9).await;
    wait_state(&p.link, LinkState::Suspended { generation: 1, thread: Some(9) }).await;
    let resume = command(10, 1, 9, &[]);
    p.adapter.write_all(&resume).await.unwrap();
    assert_eq!(read_packet(&mut p.jvm).await, resume);
    wait_state(&p.link, LinkState::Ready).await;

    // policy NONE suspends nothing
    stop(&mut p, 0, 4).await;
    jvm_marker(&mut p).await;
    assert_eq!(p.link.state(), LinkState::Ready);

    stop(&mut p, 1, 7).await;
    wait_state(&p.link, LinkState::Suspended { generation: 2, thread: Some(7) }).await;
    let thread_resume = command(11, 11, 3, &7u64.to_be_bytes());
    p.adapter.write_all(&thread_resume).await.unwrap();
    assert_eq!(read_packet(&mut p.jvm).await, thread_resume);
    wait_state(&p.link, LinkState::Ready).await;
    assert_eq!(p.link.generation(), 2);
}

#[tokio::test]
async fn adapter_invoke_keeps_the_stop() {
    let mut p = connected(OPEN).await;
    stop(&mut p, 2, 9).await;
    let stopped = LinkState::Suspended { generation: 1, thread: Some(9) };
    wait_state(&p.link, stopped.clone()).await;
    for (id, set, cmd) in [(20, 9, 6), (21, 3, 3), (22, 3, 4), (23, 5, 1)] {
        let invoke = command(id, set, cmd, &[0; 24]);
        p.adapter.write_all(&invoke).await.unwrap();
        assert_eq!(read_packet(&mut p.jvm).await, invoke);
        assert!(p.link.adapter_invoking(), "invoke {set}/{cmd} not tracked");
        let answer = reply(id, 0, &[b'I', 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
        p.jvm.write_all(&answer).await.unwrap();
        assert_eq!(read_packet(&mut p.adapter).await, answer);
        assert!(!p.link.adapter_invoking());
        assert_eq!(p.link.state(), stopped);
    }
    // the link sent nothing of its own while the invokes ran
    adapter_marker(&mut p).await;
    assert_eq!(p.link.generation(), 1);
}

#[tokio::test]
async fn held_resume_ends_generation_only_when_released() {
    let mut p = connected(HELD).await;
    wait_state(&p.link, LinkState::Held).await;
    stop(&mut p, 2, 1).await;
    let stopped = LinkState::Suspended { generation: 1, thread: Some(1) };
    wait_state(&p.link, stopped.clone()).await;
    let resume = command(30, 1, 9, &[]);
    p.adapter.write_all(&resume).await.unwrap();
    adapter_marker(&mut p).await;
    assert_eq!(p.link.state(), stopped);
    p.link.release();
    assert_eq!(read_packet(&mut p.jvm).await, resume);
    wait_state(&p.link, LinkState::Ready).await;
    assert_eq!(p.link.generation(), 1);
}

#[tokio::test]
async fn release_while_running_is_ready() {
    let p = connected(HELD).await;
    wait_state(&p.link, LinkState::Held).await;
    p.link.release();
    wait_state(&p.link, LinkState::Ready).await;
}

#[tokio::test]
async fn stop_before_id_sizes_learns_its_thread_from_the_reply() {
    let mut p = pair(OPEN);
    let own = handshake(&mut p).await;
    stop(&mut p, 2, 9).await;
    wait_state(&p.link, LinkState::Suspended { generation: 1, thread: None }).await;
    p.jvm.write_all(&reply(own, 0, &id_sizes_body())).await.unwrap();
    wait_state(&p.link, LinkState::Suspended { generation: 1, thread: Some(9) }).await;
}

/// `ThreadReference.Resume` of `thread`, through to the JVM.
async fn resume_thread(p: &mut Pair, thread: u64) {
    let resume = command(40, 11, 3, &thread.to_be_bytes());
    p.adapter.write_all(&resume).await.unwrap();
    assert_eq!(read_packet(&mut p.jvm).await, resume);
}

/// fwcd's breakpoints and steps suspend only their thread (`SUSPEND_EVENT_THREAD`): 7 stops, then 8.
async fn two_threads_stopped() -> Pair {
    let mut p = connected(OPEN).await;
    stop(&mut p, 1, 7).await;
    stop(&mut p, 1, 8).await;
    wait_state(&p.link, LinkState::Suspended { generation: 2, thread: Some(8) }).await;
    p
}

#[tokio::test]
async fn resuming_an_earlier_stopped_thread_keeps_the_latest_stop() {
    let mut p = two_threads_stopped().await;
    resume_thread(&mut p, 7).await;
    adapter_marker(&mut p).await;
    assert_eq!(p.link.state(), LinkState::Suspended { generation: 2, thread: Some(8) });
}

#[tokio::test]
async fn resuming_the_latest_stopped_thread_moves_to_the_one_still_stopped() {
    let mut p = two_threads_stopped().await;
    resume_thread(&mut p, 8).await;
    adapter_marker(&mut p).await;
    // A new generation: ids read on thread 8 are stale.
    assert_eq!(p.link.state(), LinkState::Suspended { generation: 3, thread: Some(7) });
    resume_thread(&mut p, 7).await;
    wait_state(&p.link, LinkState::Ready).await;
}

#[tokio::test]
async fn resuming_a_thread_that_did_not_stop_changes_nothing() {
    let mut p = connected(OPEN).await;
    stop(&mut p, 1, 7).await;
    let stopped = LinkState::Suspended { generation: 1, thread: Some(7) };
    wait_state(&p.link, stopped.clone()).await;
    resume_thread(&mut p, 5).await;
    adapter_marker(&mut p).await;
    assert_eq!(p.link.state(), stopped);
}

#[tokio::test]
async fn vm_resume_ends_the_stop_of_every_thread() {
    let mut p = two_threads_stopped().await;
    let resume = command(41, 1, 9, &[]);
    p.adapter.write_all(&resume).await.unwrap();
    assert_eq!(read_packet(&mut p.jvm).await, resume);
    wait_state(&p.link, LinkState::Ready).await;
    // 7 and 8 are forgotten: resuming 7 leaves the next stop alone.
    stop(&mut p, 1, 9).await;
    let stopped = LinkState::Suspended { generation: 3, thread: Some(9) };
    wait_state(&p.link, stopped.clone()).await;
    resume_thread(&mut p, 7).await;
    adapter_marker(&mut p).await;
    assert_eq!(p.link.state(), stopped);
}

#[tokio::test]
async fn thread_resume_ends_a_stop_whose_thread_is_unknown() {
    // Before the id sizes, the resumed thread cannot be read.
    let mut p = pair(OPEN);
    handshake(&mut p).await;
    stop(&mut p, 1, 9).await;
    wait_state(&p.link, LinkState::Suspended { generation: 1, thread: None }).await;
    resume_thread(&mut p, 5).await;
    wait_state(&p.link, LinkState::Ready).await;

    // A suspending event without a thread (CLASS_UNLOAD).
    let mut p = connected(OPEN).await;
    stop(&mut p, 1, 7).await;
    let unload = event(2, 9, 0);
    p.jvm.write_all(&unload).await.unwrap();
    assert_eq!(read_packet(&mut p.adapter).await, unload);
    wait_state(&p.link, LinkState::Suspended { generation: 2, thread: None }).await;
    resume_thread(&mut p, 7).await;
    wait_state(&p.link, LinkState::Ready).await;
}

#[tokio::test]
async fn a_stop_before_id_sizes_is_tracked_once_its_thread_is_read() {
    let mut p = pair(OPEN);
    let own = handshake(&mut p).await;
    stop(&mut p, 1, 7).await;
    p.jvm.write_all(&reply(own, 0, &id_sizes_body())).await.unwrap();
    wait_state(&p.link, LinkState::Suspended { generation: 1, thread: Some(7) }).await;
    stop(&mut p, 1, 8).await;
    resume_thread(&mut p, 8).await;
    adapter_marker(&mut p).await;
    assert_eq!(p.link.state(), LinkState::Suspended { generation: 3, thread: Some(7) });
}

/// kotlin-lsp's stop: a breakpoint suspending its thread, then the adapter's `VM.Suspend` and
/// method invokes; the link reads one object meanwhile.
async fn kotlin_lsp_stop() -> Pair {
    use super::command_tests::{THREAD, own_instances, result, spawn_command, tagged};
    let mut p = connected(OPEN).await;
    stop(&mut p, 1, THREAD).await;
    let stopped = LinkState::Suspended { generation: 1, thread: Some(THREAD) };
    wait_state(&p.link, stopped.clone()).await;
    let suspend = command(70, 1, 8, &[]);
    p.adapter.write_all(&suspend).await.unwrap();
    assert_eq!(read_packet(&mut p.jvm).await, suspend);
    assert_eq!(p.link.state(), stopped);
    let invoke = command(71, 9, 6, &[0; 24]);
    p.adapter.write_all(&invoke).await.unwrap();
    assert_eq!(read_packet(&mut p.jvm).await, invoke);
    let answer = reply(71, 0, &[b'I', 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    p.jvm.write_all(&answer).await.unwrap();
    assert_eq!(read_packet(&mut p.adapter).await, answer);
    assert_eq!(p.link.state(), stopped);
    let task = spawn_command(&p.link, WAIT);
    let id = own_instances(&mut p).await;
    p.jvm.write_all(&reply(id, 0, &tagged(&[0x11]))).await.unwrap();
    assert_eq!(result(task).await, Ok(tagged(&[0x11])));
    assert_eq!(p.link.state(), stopped);
    p
}

/// Sends `packets` and a marker; returns what the JVM got before the marker.
async fn through_to_jvm(p: &mut Pair, packets: &[Vec<u8>]) -> Vec<Vec<u8>> {
    let marker = command(0x99, 1, 1, &[]);
    for packet in packets.iter().chain([&marker]) {
        p.adapter.write_all(packet).await.unwrap();
    }
    let mut seen = Vec::new();
    loop {
        let packet = read_packet(&mut p.jvm).await;
        if packet == marker {
            return seen;
        }
        seen.push(packet);
    }
}

/// The link's `DisposeObjects` of the one object `kotlin_lsp_stop` read.
fn is_dispose_of_the_read_object(packet: &[u8]) -> bool {
    let h = Header::parse(packet[..HEADER_LEN].try_into().unwrap());
    let mut body = Writer::new();
    body.i32(1);
    body.id(0x11, 8);
    body.i32(1);
    h.command() == (1, 14) && !h.is_reply() && OWN_IDS.contains(&h.id) && packet[HEADER_LEN..] == body.into_vec()
}

#[tokio::test]
async fn kotlin_lsp_stop_lasts_until_vm_resume() {
    let mut p = kotlin_lsp_stop().await;
    let resume = command(72, 1, 9, &[]);
    let seen = through_to_jvm(&mut p, std::slice::from_ref(&resume)).await;
    assert_eq!(seen.len(), 2, "{seen:?}");
    assert_eq!(seen[0], resume);
    assert!(is_dispose_of_the_read_object(&seen[1]), "{seen:?}");
    wait_state(&p.link, LinkState::Ready).await;
    assert_eq!(p.link.generation(), 1);
}

#[tokio::test]
async fn kotlin_lsp_thread_resume_before_vm_resume_ends_the_stop_once() {
    let mut p = kotlin_lsp_stop().await;
    let thread_resume = command(72, 11, 3, &super::command_tests::THREAD.to_be_bytes());
    let resume = command(73, 1, 9, &[]);
    let seen = through_to_jvm(&mut p, &[thread_resume.clone(), resume.clone()]).await;
    let (own, adapter): (Vec<_>, Vec<_>) = seen.iter().partition(|packet| is_dispose_of_the_read_object(packet));
    assert_eq!(adapter, [&thread_resume, &resume], "{seen:?}");
    assert_eq!(own.len(), 1, "{seen:?}");
    assert_eq!(seen[0], thread_resume, "the disposal follows the resume that ends the stop");
    wait_state(&p.link, LinkState::Ready).await;
    assert_eq!(p.link.generation(), 1);
}

#[tokio::test]
async fn adapter_id_in_reserved_range_degrades() {
    let mut p = connected(OPEN).await;
    let packet = command(0x7000_0005, 1, 1, &[]);
    p.adapter.write_all(&packet).await.unwrap();
    assert_eq!(read_packet(&mut p.jvm).await, packet);
    wait_state(&p.link, LinkState::Degraded("adapter packet id in the reserved range".into())).await;
    // the link never sent that id, so its reply is the adapter's
    let answer = reply(0x7000_0005, 0, &[1, 2, 3]);
    p.jvm.write_all(&answer).await.unwrap();
    assert_eq!(read_packet(&mut p.adapter).await, answer);
}

#[tokio::test]
async fn untracked_reserved_reply_never_reaches_adapter() {
    let mut p = pair(OPEN);
    let own = handshake(&mut p).await;
    let id_sizes = reply(own, 0, &id_sizes_body());
    p.jvm.write_all(&id_sizes).await.unwrap();
    // A late duplicate of a reply the link already took, and an id nobody sent.
    p.jvm.write_all(&id_sizes).await.unwrap();
    p.jvm.write_all(&reply(own + 7, 0, &[0xEE; 64])).await.unwrap();
    jvm_marker(&mut p).await;
}

#[tokio::test]
async fn adapter_reserved_reply_reaches_adapter_once() {
    let mut p = connected(OPEN).await;
    let id = OWN_IDS.start + 5;
    let invoke = command(id, 9, 6, &[0; 24]);
    p.adapter.write_all(&invoke).await.unwrap();
    assert_eq!(read_packet(&mut p.jvm).await, invoke);
    wait_state(&p.link, LinkState::Degraded(RESERVED_ID.into())).await;
    assert!(p.link.adapter_invoking());
    let answer = reply(id, 0, &[b'I', 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    p.jvm.write_all(&answer).await.unwrap();
    assert_eq!(read_packet(&mut p.adapter).await, answer);
    assert!(!p.link.adapter_invoking());
    // The adapter got its one answer; a second reply for the id is no longer its.
    p.jvm.write_all(&answer).await.unwrap();
    jvm_marker(&mut p).await;
}

#[tokio::test]
async fn adapter_command_reusing_a_pending_own_id_waits_for_the_own_reply() {
    let mut p = pair(OPEN);
    let own = handshake(&mut p).await;
    let colliding = command(own, 1, 1, &[]);
    p.adapter.write_all(&colliding).await.unwrap();
    wait_state(&p.link, LinkState::Degraded(RESERVED_ID.into())).await;
    let mut byte = [0; 1];
    let early = tokio::time::timeout(Duration::from_millis(200), p.jvm.read(&mut byte)).await;
    assert!(early.is_err(), "adapter packet reached the JVM while the link's {own:#x} was pending: {early:?}");
    p.jvm.write_all(&reply(own, 0, &id_sizes_body())).await.unwrap();
    assert_eq!(read_packet(&mut p.jvm).await, colliding);
    let answer = reply(own, 0, b"adapter");
    p.jvm.write_all(&answer).await.unwrap();
    // The adapter's first packet is its own answer, and the link took the IDSizes reply.
    assert_eq!(read_packet(&mut p.adapter).await, answer);
    assert!(p.link.inner.shared.update(|core| core.sizes.is_some()));
}

#[test]
fn own_ids_skip_ids_still_pending() {
    let mut core = Core { next_own: OWN_IDS.start, ..Core::default() };
    core.adapter_reserved.insert(OWN_IDS.start, 1);
    core.own.insert(OWN_IDS.start + 1, OwnCommand::IdSizes);
    assert_eq!(core.register_own(OwnCommand::IdSizes), OWN_IDS.start + 2);
}

#[tokio::test]
async fn vm_dispose_closes_link() {
    for (set, cmd) in [(1, 6), (1, 10)] {
        let mut p = connected(OPEN).await;
        stop(&mut p, 2, 9).await;
        let exit_code: &[u8] = if cmd == 10 { &[0; 4] } else { &[] };
        let packet = command(40, set, cmd, exit_code);
        p.adapter.write_all(&packet).await.unwrap();
        assert_eq!(read_packet(&mut p.jvm).await, packet);
        wait_state(&p.link, LinkState::Closed).await;
        // the adapter still gets its answer, then the JVM hangs up
        let answer = reply(40, 0, &[]);
        p.jvm.write_all(&answer).await.unwrap();
        assert_eq!(read_packet(&mut p.adapter).await, answer);
        stop(&mut p, 2, 9).await;
        assert_eq!(p.link.state(), LinkState::Closed);
        drop(p.jvm);
        assert_eof(&mut p.adapter, "adapter").await;
    }
}

#[derive(Debug, Clone)]
enum JvmPacket {
    Reply { id: u32, error: u16, body: Vec<u8> },
    Event { policy: u8, kind: u8, thread: u64 },
    RawEvent(Vec<u8>),
    OwnReply,
}

fn adapter_packets() -> impl Strategy<Value = Vec<Vec<u8>>> {
    let cmd = prop_oneof![
        Just((1u8, 9u8)),
        Just((11, 3)),
        Just((9, 6)),
        Just((3, 3)),
        Just((1, 7)),
        (any::<u8>(), any::<u8>()),
    ];
    let packet = (1u32..OWN_IDS.start, cmd, any::<bool>(), vec(any::<u8>(), 0..48)).prop_map(
        |(id, (set, cmd), is_reply, body)| {
            let mut p = command(id, set, cmd, &body);
            if is_reply {
                p[8] = FLAG_REPLY;
            }
            p
        },
    );
    vec(packet, 0..24)
}

fn jvm_packets() -> impl Strategy<Value = (Vec<JvmPacket>, usize)> {
    let packet =
        prop_oneof![
            (1u32..OWN_IDS.start, any::<u16>(), vec(any::<u8>(), 0..48))
                .prop_map(|(id, error, body)| JvmPacket::Reply { id, error, body }),
            (0u8..3, any::<u8>(), any::<u64>()).prop_map(|(policy, kind, thread)| JvmPacket::Event {
                policy,
                kind,
                thread
            }),
            vec(any::<u8>(), 0..32).prop_map(JvmPacket::RawEvent),
        ];
    (vec(packet, 0..24), any::<usize>())
}

fn adapter_and_jvm_packets() -> impl Strategy<Value = (Vec<Vec<u8>>, Vec<JvmPacket>)> {
    (adapter_packets(), jvm_packets()).prop_map(|(adapter, (mut jvm, at))| {
        let at = at % (jvm.len() + 1);
        jvm.insert(at, JvmPacket::OwnReply);
        (adapter, jvm)
    })
}

fn jvm_bytes(packet: &JvmPacket, own: u32) -> Vec<u8> {
    match packet {
        JvmPacket::Reply { id, error, body } => reply(*id, *error, body),
        JvmPacket::Event { policy, kind, thread } => {
            let mut e = event(*policy, *kind, *thread);
            e[4..8].copy_from_slice(&0x200u32.to_be_bytes());
            e
        }
        JvmPacket::RawEvent(body) => command(0x300, 64, 100, body),
        JvmPacket::OwnReply => reply(own, 0, &id_sizes_body()),
    }
}

async fn passthrough(adapter_sent: Vec<Vec<u8>>, jvm_script: Vec<JvmPacket>) {
    let Pair { link, adapter, jvm } = pair(OPEN);
    let (mut adapter_rx, mut adapter_tx) = tokio::io::split(adapter);
    let (mut jvm_rx, mut jvm_tx) = tokio::io::split(jvm);
    let upstream: Vec<u8> = adapter_sent.concat();
    let upstream_len = upstream.len();
    let adapter_writer = tokio::spawn(async move {
        adapter_tx.write_all(HANDSHAKE).await.unwrap();
        adapter_tx.write_all(&upstream).await.unwrap();
        adapter_tx
    });
    let mut buf = [0; 14];
    within("handshake", jvm_rx.read_exact(&mut buf)).await.unwrap();
    let own_packet = read_packet(&mut jvm_rx).await;
    let own = Header::parse(own_packet[..HEADER_LEN].try_into().unwrap()).id;
    let mut expected_down = HANDSHAKE.to_vec();
    let mut downstream = HANDSHAKE.to_vec();
    for p in &jvm_script {
        let bytes = jvm_bytes(p, own);
        if !matches!(p, JvmPacket::OwnReply) {
            expected_down.extend_from_slice(&bytes);
        }
        downstream.extend_from_slice(&bytes);
    }
    let jvm_writer = tokio::spawn(async move {
        jvm_tx.write_all(&downstream).await.unwrap();
        jvm_tx
    });
    let mut got_up = vec![0; upstream_len];
    within("upstream bytes", jvm_rx.read_exact(&mut got_up)).await.unwrap();
    let mut got_down = vec![0; expected_down.len()];
    within("downstream bytes", adapter_rx.read_exact(&mut got_down)).await.unwrap();
    let _open = (adapter_writer.await.unwrap(), jvm_writer.await.unwrap(), link);
    assert_eq!(got_up, adapter_sent.concat());
    assert_eq!(got_down, expected_down);
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]

    #[test]
    fn passthrough_is_byte_exact((adapter, jvm) in adapter_and_jvm_packets()) {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(passthrough(adapter, jvm));
    }
}
