//! JDWP suspend counts, as the adapter's commands and the JVM's events change them: a thread
//! runs only when its count is 0, and `VirtualMachine.Suspend` / `SUSPEND_ALL` events count for
//! every thread, also ones the link has not seen yet.

use std::collections::HashMap;

#[derive(Default, Debug)]
pub(super) struct Suspends {
    /// VM-wide suspensions.
    all: u32,
    /// Each thread's count minus `all`; negative once the thread alone was resumed under a
    /// VM-wide suspension.
    threads: HashMap<u64, i64>,
}

impl Suspends {
    pub(super) fn count(&self, thread: u64) -> i64 {
        (i64::from(self.all) + self.threads.get(&thread).copied().unwrap_or(0)).max(0)
    }

    /// Whether some thread is suspended.
    pub(super) fn any(&self) -> bool {
        self.all > 0 || self.threads.values().any(|&n| n > 0)
    }

    pub(super) fn suspend_all(&mut self) {
        self.all += 1;
    }

    pub(super) fn suspend(&mut self, thread: u64) {
        *self.threads.entry(thread).or_default() += 1;
    }

    pub(super) fn resume(&mut self, thread: u64) {
        if self.count(thread) > 0 {
            *self.threads.entry(thread).or_default() -= 1;
        }
        self.threads.retain(|_, n| *n != 0);
    }

    /// `VirtualMachine.Resume`: every thread's count goes down by one.
    pub(super) fn resume_all(&mut self) {
        if self.all > 1 {
            self.all -= 1;
            self.floor();
        } else {
            // JDWP leaves a thread's own suspensions above the VM-wide one in place; the link
            // ends them with the last VM-wide one too, so a stop never outlasts the adapter's
            // last VM resume. The link may then think a thread runs that is still suspended,
            // never the reverse (pinned by `kotlin_lsp_stop_lasts_until_vm_resume`).
            self.all = 0;
            self.threads.values_mut().for_each(|n| *n = (*n - 1).max(0));
            self.threads.retain(|_, n| *n != 0);
        }
    }

    /// Takes back a `suspend_all` the JVM refused.
    pub(super) fn unsuspend_all(&mut self) {
        self.all = self.all.saturating_sub(1);
        self.floor();
    }

    /// An event from `thread`: it was running, so counts that say otherwise are stale and
    /// counting starts again from this event. The thread suspensions others hold stay.
    pub(super) fn ran(&mut self, thread: u64) {
        if self.count(thread) > 0 {
            self.all = 0;
            self.threads.retain(|&t, n| t != thread && *n > 0);
        }
    }

    pub(super) fn clear(&mut self) {
        *self = Self::default();
    }

    /// No count below 0 once `all` went down.
    fn floor(&mut self) {
        let floor = -i64::from(self.all);
        self.threads.values_mut().for_each(|n| *n = (*n).max(floor));
        self.threads.retain(|_, n| *n != 0);
    }
}
