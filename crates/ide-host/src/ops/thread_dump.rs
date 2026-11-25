use crate::Host;
use ide_command::command;
use ide_core::{IdeResult, RunId};
use ide_dap::{JvmMemoryUnavailable, JvmThreadsResult, JvmThreadsUnavailable};
use ide_jvm_attach::{ProcEntry, is_hotspot, process_table, select_run_jvm};
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// A `Thread.print -l` of the JVM a run started: the deepest HotSpot JVM of the run's process
/// tree, else the one carrying `token` (the run's marker property).
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
    let selected = host.blocking(move || Ok(run_jvm(remote, root, token.as_deref(), process_table, is_hotspot)));
    let pid = match selected.await? {
        Ok(pid) => pid,
        Err(refused) => return Ok(refused),
    };
    let heap_root = host.heap.root().to_path_buf();
    let dir = host.blocking(move || Ok(json_dir(&heap_root))).await?;
    // A debugger attached to this run or JVM (Debug of a build tool's run, Attach to Process)
    // may hold it suspended, which only its session knows.
    let result = match host.debugger.debugged_jvm_thread_dump(id, pid, dir.clone()).await {
        Some(dump) => dump,
        None => {
            let json = dir.clone();
            // The attach handshake blocks for seconds.
            host.blocking(move || Ok(ide_dap::run_jvm_thread_dump(pid, json.as_deref()))).await
        }
    };
    let _ = host
        .blocking(move || {
            discard_json_dir(dir);
            Ok(())
        })
        .await;
    result
}

/// A fresh owner-only directory for the JVM's JSON dump under the heap snapshot root, whose
/// stale-directory sweep also removes a file a JVM writes after its request timed out. `None`
/// when it cannot be created: the dump then goes without virtual threads.
pub(crate) fn json_dir(heap_root: &Path) -> Option<PathBuf> {
    ide_heap::create_snapshot_dir(heap_root)
        .inspect_err(|e| tracing::warn!("no directory for the JSON thread dump under {}: {e}", heap_root.display()))
        .ok()
}

pub(crate) fn discard_json_dir(dir: Option<PathBuf>) {
    if let Some(dir) = dir
        && let Err(e) = std::fs::remove_dir_all(&dir)
        && e.kind() != std::io::ErrorKind::NotFound
    {
        tracing::warn!("could not delete thread dump directory {}: {e}", dir.display());
    }
}

fn unavailable(reason: JvmThreadsUnavailable) -> JvmThreadsResult {
    JvmThreadsResult::Unavailable { reason }
}

fn jvm(reason: JvmMemoryUnavailable) -> JvmThreadsResult {
    unavailable(JvmThreadsUnavailable::Jvm { reason })
}

/// The run's JVM, or why none can be dumped. `root` is the run's process while it runs; the
/// process table is read only once the cheaper reasons to refuse are ruled out.
fn run_jvm(
    remote: bool,
    root: Option<u32>,
    token: Option<&str>,
    table: impl FnOnce() -> Vec<ProcEntry>,
    is_hotspot: impl Fn(u32) -> bool,
) -> Result<u32, JvmThreadsResult> {
    if remote {
        return Err(unavailable(JvmThreadsUnavailable::RemoteRun));
    }
    let Some(root) = root else { return Err(jvm(JvmMemoryUnavailable::ProgramExited)) };
    if !cfg!(unix) {
        return Err(jvm(JvmMemoryUnavailable::UnsupportedPlatform));
    }
    select_run_jvm(&table(), root, token, is_hotspot).ok_or_else(|| jvm(JvmMemoryUnavailable::NoJvmProcess))
}

ide_command::domain!(thread_dump: run_jvm_thread_dump);

#[cfg(test)]
mod tests {
    use super::*;

    fn never_called<T>() -> T {
        panic!("not reached")
    }

    #[cfg(unix)]
    fn proc(pid: u32, ppid: u32, command: &str) -> ProcEntry {
        ProcEntry { pid, ppid, command: command.into() }
    }

    #[test]
    fn remote_run_is_refused() {
        let result = run_jvm(true, Some(10), None, never_called, |_| never_called());
        assert_eq!(result, Err(unavailable(JvmThreadsUnavailable::RemoteRun)));
    }

    #[test]
    fn exited_run_reports_program_exited() {
        let result = run_jvm(false, None, None, never_called, |_| never_called());
        assert_eq!(result, Err(jvm(JvmMemoryUnavailable::ProgramExited)));
    }

    #[cfg(unix)]
    #[test]
    fn no_jvm_in_tree() {
        let table = || vec![proc(10, 1, "sh -c run"), proc(11, 10, "sleep 100")];
        let result = run_jvm(false, Some(10), None, table, |_| false);
        assert_eq!(result, Err(jvm(JvmMemoryUnavailable::NoJvmProcess)));
    }

    #[cfg(unix)]
    #[test]
    fn finds_the_jvm_below_the_run() {
        let table = || vec![proc(10, 1, "sh -c run"), proc(11, 10, "java -jar app.jar")];
        assert_eq!(run_jvm(false, Some(10), None, table, |pid| pid == 11), Ok(11));
    }

    #[cfg(unix)]
    #[test]
    fn json_dir_is_private_and_removed_afterwards() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let heap_root = root.path().join("heap-snapshots");
        let dir = json_dir(&heap_root).expect("a directory");
        assert_eq!(dir.parent(), Some(heap_root.as_path()));
        assert_eq!(std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700);
        // A file the JVM wrote after its request timed out goes with the directory.
        std::fs::write(dir.join("threads-1-2.json"), "{}").unwrap();
        discard_json_dir(Some(dir.clone()));
        assert!(!dir.exists());
        discard_json_dir(None);
    }

    #[test]
    fn json_dir_is_none_when_it_cannot_be_created() {
        let root = tempfile::tempdir().unwrap();
        let blocked = root.path().join("file");
        std::fs::write(&blocked, "").unwrap();
        assert_eq!(json_dir(&blocked), None);
    }

    #[cfg(not(unix))]
    #[test]
    fn unsupported_without_reading_the_process_table() {
        let result = run_jvm(false, Some(10), None, never_called, |_| never_called());
        assert_eq!(result, Err(jvm(JvmMemoryUnavailable::UnsupportedPlatform)));
    }
}
