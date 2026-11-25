//! Live-object profiles hold what is alive when the agent writes them at exit; a full
//! collection right before the run stops drops the garbage that has not been swept yet.

use ide_jvm_attach::AttachError;
use std::time::Duration;

pub const GC_TIMEOUT: Duration = Duration::from_secs(5);

/// Runs `GC.run` in every JVM of `pid_tree` with an attach listener, so the live-object
/// profile the agent writes at exit holds only reachable objects. Returns how many JVMs collected.
pub fn gc_before_stop(pid_tree: &[i32]) -> u32 {
    gc_each(pid_tree, ide_jvm_attach::has_listener, |pid| ide_jvm_attach::jcmd(pid, "GC.run", GC_TIMEOUT))
}

fn gc_each(pids: &[i32], has_listener: impl Fn(u32) -> bool, gc: impl Fn(u32) -> Result<String, AttachError>) -> u32 {
    let mut collected = 0;
    for &pid in pids {
        let Ok(pid) = u32::try_from(pid) else { continue };
        if pid == 0 || !has_listener(pid) {
            continue;
        }
        match gc(pid) {
            Ok(_) => collected += 1,
            Err(e) => tracing::debug!("GC.run in JVM {pid} failed: {e}"),
        }
    }
    collected
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[test]
    fn gc_each_skips_pids_without_listener_and_counts_successes() {
        let called = RefCell::new(Vec::new());
        let n = gc_each(
            &[10, 11, 12],
            |pid| pid != 10,
            |pid| {
                called.borrow_mut().push(pid);
                Ok(String::new())
            },
        );
        assert_eq!(n, 2);
        assert_eq!(*called.borrow(), vec![11, 12]);
    }

    #[test]
    fn gc_each_continues_after_failure() {
        let called = RefCell::new(Vec::new());
        let n = gc_each(
            &[11, 12],
            |_| true,
            |pid| {
                called.borrow_mut().push(pid);
                if pid == 11 { Err(AttachError::Timeout) } else { Ok(String::new()) }
            },
        );
        assert_eq!(n, 1);
        assert_eq!(*called.borrow(), vec![11, 12]);
    }

    #[test]
    fn gc_each_ignores_negative_pids() {
        let called = RefCell::new(Vec::new());
        let n = gc_each(
            &[-1, 5],
            |_| true,
            |pid| {
                called.borrow_mut().push(pid);
                Ok(String::new())
            },
        );
        assert_eq!(n, 1);
        assert_eq!(*called.borrow(), vec![5]);
    }
}
