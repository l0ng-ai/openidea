//! The stop follows the JVM's suspend counts: `VirtualMachine.Suspend` / `ThreadReference.Suspend`
//! keep it going through resumes that leave the VM suspended.

use super::command_tests::{THREAD, entries, own_instances, result, resume, spawn_command, tagged};
use super::tests::{OPEN, Pair, WAIT, adapter_marker, command, connected, read_packet, reply, stop, wait_state};
use super::*;
use tokio::io::AsyncWriteExt;

const STOPPED: LinkState = LinkState::Suspended { generation: 1, thread: Some(THREAD) };

/// Sends `packet` from the adapter; the JVM must get it unchanged.
async fn forward(p: &mut Pair, packet: &[u8]) {
    p.adapter.write_all(packet).await.unwrap();
    assert_eq!(read_packet(&mut p.jvm).await, packet);
}

/// One link command in the current stop, answered with `id`.
async fn read_object(p: &mut Pair, id: u64) {
    let task = spawn_command(&p.link, WAIT);
    let own = own_instances(p).await;
    p.jvm.write_all(&reply(own, 0, &tagged(&[id]))).await.unwrap();
    assert_eq!(result(task).await, Ok(tagged(&[id])));
}

fn vm_suspend(id: u32) -> Vec<u8> {
    command(id, 1, 8, &[])
}

fn thread_suspend(id: u32, thread: u64) -> Vec<u8> {
    command(id, 11, 2, &thread.to_be_bytes())
}

fn thread_resume(id: u32, thread: u64) -> Vec<u8> {
    command(id, 11, 3, &thread.to_be_bytes())
}

/// kotlin-lsp 263.7084.0 against a real JVM: the breakpoint suspends its thread, then the
/// adapter suspends the VM and resumes the thread, which stays suspended by the VM.
#[tokio::test]
async fn kotlin_lsp_thread_resume_under_vm_suspend_keeps_the_stop() {
    let mut p = connected(OPEN).await;
    stop(&mut p, 1, THREAD).await;
    wait_state(&p.link, STOPPED).await;
    forward(&mut p, &vm_suspend(70)).await;
    read_object(&mut p, 0x11).await;
    forward(&mut p, &thread_resume(71, THREAD)).await;
    // no disposal went out with the thread resume
    adapter_marker(&mut p).await;
    assert_eq!(p.link.state(), STOPPED);
    read_object(&mut p, 0x22).await;
    assert_eq!(entries(&resume(&mut p).await), vec![vec![(0x11, 1), (0x22, 1)]]);
    wait_state(&p.link, LinkState::Ready).await;
    assert_eq!(p.link.generation(), 1);
}

#[tokio::test]
async fn each_vm_suspend_needs_its_vm_resume() {
    let mut p = connected(OPEN).await;
    stop(&mut p, 2, THREAD).await;
    wait_state(&p.link, STOPPED).await;
    forward(&mut p, &vm_suspend(70)).await;
    forward(&mut p, &vm_suspend(71)).await;
    read_object(&mut p, 0x11).await;
    for _ in 0..2 {
        assert_eq!(resume(&mut p).await, vec![]);
        assert_eq!(p.link.state(), STOPPED);
    }
    assert_eq!(entries(&resume(&mut p).await), vec![vec![(0x11, 1)]]);
    wait_state(&p.link, LinkState::Ready).await;
}

#[tokio::test]
async fn a_suspended_thread_stays_stopped_until_resumed_as_often() {
    let mut p = connected(OPEN).await;
    stop(&mut p, 1, THREAD).await;
    wait_state(&p.link, STOPPED).await;
    forward(&mut p, &thread_suspend(70, THREAD)).await;
    read_object(&mut p, 0x11).await;
    forward(&mut p, &thread_resume(71, THREAD)).await;
    adapter_marker(&mut p).await;
    assert_eq!(p.link.state(), STOPPED);
    let last = thread_resume(72, THREAD);
    p.adapter.write_all(&last).await.unwrap();
    assert_eq!(read_packet(&mut p.jvm).await, last);
    let dispose = read_packet(&mut p.jvm).await;
    assert_eq!(super::command_tests::header(&dispose).command(), (1, 14), "{dispose:?}");
    wait_state(&p.link, LinkState::Ready).await;
}

#[tokio::test]
async fn a_suspend_all_event_ends_with_one_vm_resume() {
    let mut p = connected(OPEN).await;
    stop(&mut p, 2, THREAD).await;
    wait_state(&p.link, STOPPED).await;
    read_object(&mut p, 0x11).await;
    assert_eq!(entries(&resume(&mut p).await), vec![vec![(0x11, 1)]]);
    wait_state(&p.link, LinkState::Ready).await;
}

#[tokio::test]
async fn a_refused_suspend_is_not_counted() {
    let mut p = connected(OPEN).await;
    stop(&mut p, 1, THREAD).await;
    wait_state(&p.link, STOPPED).await;
    for refused in [vm_suspend(70), thread_suspend(71, 5)] {
        let id = super::command_tests::header(&refused).id;
        forward(&mut p, &refused).await;
        // VM_DEAD, INVALID_THREAD
        let error = reply(id, if id == 70 { 112 } else { 10 }, &[]);
        p.jvm.write_all(&error).await.unwrap();
        assert_eq!(read_packet(&mut p.adapter).await, error);
    }
    forward(&mut p, &thread_resume(72, 5)).await;
    forward(&mut p, &thread_resume(73, THREAD)).await;
    wait_state(&p.link, LinkState::Ready).await;
}
