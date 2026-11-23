use crate::Host;
use ide_command::command;
use ide_core::{IdeResult, RunId};
use ide_dap::{JvmMemoryUnavailable, JvmThreadsResult, JvmThreadsUnavailable};
use ide_jvm_attach::{ProcEntry, is_hotspot, process_table, select_run_jvm};
use std::sync::Arc;

/// A `Thread.print -l` of the JVM a run started: the one carrying `token` (the run's marker
/// property) when any does, else the deepest HotSpot JVM of the run's process tree.
#[command(trust = trusted)]
pub async fn run_jvm_thread_dump(
    host: &Arc<Host>,
    window: &str,
    id: RunId,
    token: Option<String>,
) -> IdeResult<JvmThreadsResult> {
    host.require_trust(window)?;
    let remote = host.remote.runs.contains(id);
    let root = if remote { None } else { host.processes.pid(id) };
    // The attach handshake and `ps` block for seconds.
    host.blocking(move || {
        Ok(dump_run(remote, root, token.as_deref(), process_table, is_hotspot, ide_dap::run_jvm_thread_dump))
    })
    .await
}

fn unavailable(reason: JvmThreadsUnavailable) -> JvmThreadsResult {
    JvmThreadsResult::Unavailable { reason }
}

fn jvm(reason: JvmMemoryUnavailable) -> JvmThreadsResult {
    unavailable(JvmThreadsUnavailable::Jvm { reason })
}

/// `root` is the run's process while it runs. The table and the dump are taken only once the
/// cheaper reasons to refuse are ruled out.
fn dump_run(
    remote: bool,
    root: Option<u32>,
    token: Option<&str>,
    table: impl FnOnce() -> Vec<ProcEntry>,
    is_hotspot: impl Fn(u32) -> bool,
    dump: impl FnOnce(u32) -> JvmThreadsResult,
) -> JvmThreadsResult {
    if remote {
        return unavailable(JvmThreadsUnavailable::RemoteRun);
    }
    let Some(root) = root else { return jvm(JvmMemoryUnavailable::ProgramExited) };
    if !cfg!(unix) {
        return jvm(JvmMemoryUnavailable::UnsupportedPlatform);
    }
    match select_run_jvm(&table(), root, token, is_hotspot) {
        Some(pid) => dump(pid),
        None => jvm(JvmMemoryUnavailable::NoJvmProcess),
    }
}

ide_command::domain!(thread_dump: run_jvm_thread_dump);

#[cfg(test)]
mod tests {
    use super::*;

    fn never_called<T>() -> T {
        panic!("not reached")
    }

    fn proc(pid: u32, ppid: u32, command: &str) -> ProcEntry {
        ProcEntry { pid, ppid, command: command.into() }
    }

    #[test]
    fn remote_run_is_refused() {
        let result = dump_run(true, Some(10), None, never_called, |_| never_called(), |_| never_called());
        assert_eq!(result, unavailable(JvmThreadsUnavailable::RemoteRun));
    }

    #[test]
    fn exited_run_reports_program_exited() {
        let result = dump_run(false, None, None, never_called, |_| never_called(), |_| never_called());
        assert_eq!(result, jvm(JvmMemoryUnavailable::ProgramExited));
    }

    #[cfg(unix)]
    #[test]
    fn no_jvm_in_tree() {
        let table = || vec![proc(10, 1, "sh -c run"), proc(11, 10, "sleep 100")];
        let result = dump_run(false, Some(10), None, table, |_| false, |_| never_called());
        assert_eq!(result, jvm(JvmMemoryUnavailable::NoJvmProcess));
    }

    #[cfg(unix)]
    #[test]
    fn dumps_the_jvm_below_the_run() {
        let table = || vec![proc(10, 1, "sh -c run"), proc(11, 10, "java -jar app.jar")];
        let dumped = std::cell::Cell::new(0);
        let result = dump_run(
            false,
            Some(10),
            None,
            table,
            |pid| pid == 11,
            |pid| {
                dumped.set(pid);
                jvm(JvmMemoryUnavailable::ProgramExited)
            },
        );
        assert_eq!(dumped.get(), 11);
        assert_eq!(result, jvm(JvmMemoryUnavailable::ProgramExited));
    }

    #[cfg(not(unix))]
    #[test]
    fn unsupported_without_reading_the_process_table() {
        let result = dump_run(false, Some(10), None, never_called, |_| never_called(), |_| never_called());
        assert_eq!(result, jvm(JvmMemoryUnavailable::UnsupportedPlatform));
    }
}
