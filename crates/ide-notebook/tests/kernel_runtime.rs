//! Opt-in native acceptance tests. Set OPENIDEA_TEST_PYTHON to an absolute
//! ipykernel-enabled interpreter and run this target with --ignored.
//! These tests execute real Python over authenticated native ZeroMQ, no server.

use ide_core::{CancellationToken, IdeResult, error::ErrorKind};
use ide_notebook::kernel::{ExecutionResult, KernelManager, KernelOutput, KernelState};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::oneshot;

type Outputs = Arc<Mutex<Vec<KernelOutput>>>;

fn python() -> PathBuf {
    let path = PathBuf::from(
        std::env::var_os("OPENIDEA_TEST_PYTHON").expect("set OPENIDEA_TEST_PYTHON to a real ipykernel Python"),
    );
    assert!(path.is_absolute());
    path
}

fn manager(root: &Path) -> Arc<KernelManager> {
    Arc::new(KernelManager::new(root.join("runtime"), Arc::new(|_, _, _| {})))
}

async fn run(
    manager: &KernelManager,
    notebook: &Path,
    python: &Path,
    code: &str,
) -> (IdeResult<ExecutionResult>, Vec<KernelOutput>) {
    let outputs: Outputs = Arc::new(Mutex::new(Vec::new()));
    let sink = outputs.clone();
    let result = tokio::time::timeout(
        Duration::from_secs(45),
        manager.execute(
            notebook,
            python,
            code,
            CancellationToken::new(),
            Arc::new(move |output| sink.lock().unwrap().push(output)),
        ),
    )
    .await
    .expect("real kernel request exceeded test deadline");
    let outputs = std::mem::take(&mut *outputs.lock().unwrap());
    (result, outputs)
}

fn json_display(outputs: &[KernelOutput]) -> &Value {
    &outputs
        .iter()
        .find(|output| output.kind == "display_data" && output.content["data"]["application/json"].is_object())
        .expect("expected native JSON display output")
        .content["data"]["application/json"]
}

#[tokio::test]
async fn cancelled_before_admission_cannot_become_an_interpreter_error() {
    let root = tempfile::tempdir().unwrap();
    let manager = manager(root.path());
    let cancel = CancellationToken::new();
    cancel.cancel();
    let result = manager
        .execute(
            &root.path().join("cancelled.ipynb"),
            &root.path().join("does-not-exist"),
            "raise RuntimeError('must never execute')",
            cancel,
            Arc::new(|_| panic!("cancelled code emitted output")),
        )
        .await;
    assert_eq!(result.unwrap_err().kind, ErrorKind::Cancelled);
    manager.shutdown().await;
}

#[tokio::test]
#[ignore = "requires OPENIDEA_TEST_PYTHON with real ipykernel"]
async fn real_kernel_preserves_state_interpreter_mime_and_request_identity() {
    let root = tempfile::tempdir().unwrap();
    let statuses = Arc::new(Mutex::new(Vec::new()));
    let sink = statuses.clone();
    let manager =
        KernelManager::new(root.path().join("runtime"), Arc::new(move |_, state, _| sink.lock().unwrap().push(state)));
    let notebook = root.path().join("native.ipynb");
    let python = python();
    let (result, outputs) = run(&manager, &notebook, &python, r#"
import os, sys
from IPython.display import display, update_display, clear_output
persisted_value = 41
print('native stdout', flush=True)
print('native stderr', file=sys.stderr, flush=True)
display({'application/x-openidea-test': {'opaque': [1, {'unknown': 'kept'}]}, 'text/plain': 'custom'}, raw=True, display_id='stable-display')
update_display({'text/plain': 'updated'}, raw=True, display_id='stable-display')
clear_output(wait=True)
display({'text/html': '<table><tr><td>42</td></tr></table>', 'image/svg+xml': '<svg xmlns="http://www.w3.org/2000/svg"/>'}, raw=True)
persisted_value + 1
"#).await;
    let result = result.unwrap();
    assert_eq!(result.status, "ok");
    let request = &outputs.iter().find(|o| o.kind == "execute_input").unwrap().msg_id;
    assert!(!request.is_empty(), "Jupyter must supply a real parent request ID");
    assert!(outputs.iter().all(|o| &o.msg_id == request && o.kind != "status"));
    assert!(outputs.iter().any(|o| o.kind == "stream"
        && o.content["name"] == "stdout"
        && o.content["text"].as_str().unwrap().contains("native stdout")));
    assert!(outputs.iter().any(|o| o.kind == "stream"
        && o.content["name"] == "stderr"
        && o.content["text"].as_str().unwrap().contains("native stderr")));
    assert!(outputs.iter().any(|o| o.content["data"]["application/x-openidea-test"]["opaque"][1]["unknown"] == "kept"));
    assert!(
        outputs
            .iter()
            .any(|o| o.kind == "update_display_data" && o.content["transient"]["display_id"] == "stable-display")
    );
    assert!(outputs.iter().any(|o| o.kind == "clear_output" && o.content["wait"] == true));
    assert!(outputs.iter().any(|o| o.kind == "execute_result" && o.content["data"]["text/plain"] == "42"));
    let (result, next) = run(&manager, &notebook, &python,
        "display({'application/json': {'value': persisted_value, 'executable': sys.executable, 'cwd': os.getcwd()}}, raw=True)").await;
    assert_eq!(result.unwrap().status, "ok");
    let value = json_display(&next);
    assert_eq!(value["value"], 41);
    assert_eq!(
        std::fs::canonicalize(value["executable"].as_str().unwrap()).unwrap(),
        std::fs::canonicalize(&python).unwrap()
    );
    assert_eq!(
        std::fs::canonicalize(value["cwd"].as_str().unwrap()).unwrap(),
        std::fs::canonicalize(root.path()).unwrap()
    );
    assert!(next.iter().all(|o| o.msg_id != *request));
    let (result, errors) = run(&manager, &notebook, &python, "input('must not hang')").await;
    assert_eq!(result.unwrap().status, "error");
    assert!(errors.iter().any(|o| o.kind == "error" && o.content["ename"] == "StdinNotImplementedError"));
    let states = statuses.lock().unwrap().clone();
    assert_eq!(states.first(), Some(&KernelState::Starting));
    assert!(states.windows(2).any(|pair| pair == [KernelState::Busy, KernelState::Idle]));
    manager.shutdown().await;
}

async fn long_run(
    manager: Arc<KernelManager>,
    notebook: PathBuf,
    python: PathBuf,
    cancel: CancellationToken,
    catches_interrupt: bool,
) -> (tokio::task::JoinHandle<IdeResult<ExecutionResult>>, oneshot::Receiver<()>) {
    let (ready, received) = oneshot::channel();
    let ready = Mutex::new(Some(ready));
    let code = if catches_interrupt {
        "import time, os\nkept_after_interrupt = 123\ntry:\n print('INTERRUPT-READY', flush=True)\n while True: time.sleep(0.01)\nexcept KeyboardInterrupt:\n caught_interrupt = True\n"
    } else {
        "import time, os\nkept_after_interrupt = 123\nprint('INTERRUPT-READY', flush=True)\nwhile True: time.sleep(0.01)\n"
    };
    let task = tokio::spawn(async move {
        manager
            .execute(
                &notebook,
                &python,
                code,
                cancel,
                Arc::new(move |output| {
                    if output.kind == "stream"
                        && output.content["text"].as_str().is_some_and(|s| s.contains("INTERRUPT-READY"))
                        && let Some(ready) = ready.lock().unwrap().take()
                    {
                        let _ = ready.send(());
                    }
                }),
            )
            .await
    });
    (task, received)
}

#[tokio::test]
#[ignore = "requires real ipykernel; Windows must exercise JPY_INTERRUPT_EVENT"]
async fn real_interrupt_drains_and_keeps_interpreter_state() {
    let root = tempfile::tempdir().unwrap();
    let manager = manager(root.path());
    let notebook = root.path().join("interrupt.ipynb");
    let python = python();
    let (task, ready) =
        long_run(manager.clone(), notebook.clone(), python.clone(), CancellationToken::new(), false).await;
    tokio::time::timeout(Duration::from_secs(45), ready).await.unwrap().unwrap();
    tokio::time::timeout(Duration::from_secs(10), manager.interrupt(&notebook)).await.unwrap().unwrap();
    assert_eq!(task.await.unwrap().unwrap_err().kind, ErrorKind::Cancelled);
    let (result, outputs) = run(
        &manager,
        &notebook,
        &python,
        "from IPython.display import display\ndisplay({'application/json': {'kept': kept_after_interrupt}}, raw=True)",
    )
    .await;
    assert_eq!(result.unwrap().status, "ok");
    assert_eq!(json_display(&outputs)["kept"], 123, "interrupt must not emulate success by restarting Python");
    manager.shutdown().await;
}

#[tokio::test]
#[ignore = "requires OPENIDEA_TEST_PYTHON with real ipykernel"]
async fn token_cancellation_is_not_success_when_python_catches_keyboard_interrupt() {
    let root = tempfile::tempdir().unwrap();
    let manager = manager(root.path());
    let notebook = root.path().join("catch.ipynb");
    let python = python();
    let cancel = CancellationToken::new();
    let (task, ready) = long_run(manager.clone(), notebook.clone(), python.clone(), cancel.clone(), true).await;
    tokio::time::timeout(Duration::from_secs(45), ready).await.unwrap().unwrap();
    cancel.cancel();
    let error = tokio::time::timeout(Duration::from_secs(10), task).await.unwrap().unwrap().unwrap_err();
    assert_eq!(error.kind, ErrorKind::Cancelled);
    let (result, outputs) = run(&manager, &notebook, &python,
        "from IPython.display import display\ndisplay({'application/json': {'caught': caught_interrupt, 'kept': kept_after_interrupt}}, raw=True)").await;
    assert_eq!(result.unwrap().status, "ok");
    assert_eq!(json_display(&outputs)["caught"], true);
    assert_eq!(json_display(&outputs)["kept"], 123);
    manager.shutdown().await;
}

#[tokio::test]
#[ignore = "requires OPENIDEA_TEST_PYTHON with real ipykernel"]
async fn stale_parent_output_is_dropped_and_restart_invalidates_state() {
    let root = tempfile::tempdir().unwrap();
    let manager = manager(root.path());
    let notebook = root.path().join("generation.ipynb");
    let python = python();
    let (result, _) = run(
        &manager,
        &notebook,
        &python,
        r#"
import threading, os
from IPython.display import display
kernel = get_ipython().kernel
old_parent = kernel.get_parent()
old_release = threading.Event()
old_done = threading.Event()
old_state = 99
def old_worker():
    old_release.wait()
    kernel.session.send(kernel.iopub_socket, 'stream',
                        {'name': 'stdout', 'text': 'OLD-GENERATION\n'},
                        parent=old_parent)
    old_done.set()
threading.Thread(target=old_worker, daemon=True).start()
"#,
    )
    .await;
    assert_eq!(result.unwrap().status, "ok");
    // Send an explicitly old protocol parent during the next execution.
    // Ordinary thread print() can inherit ipykernel's current global parent.
    let (result, outputs) = run(&manager, &notebook, &python,
        "old_release.set()\nassert old_done.wait(5)\nprint('CURRENT-GENERATION', flush=True)\ndisplay({'application/json': {'pid': os.getpid()}}, raw=True)").await;
    assert_eq!(result.unwrap().status, "ok");
    assert!(!outputs.iter().any(|o| o.content["text"].as_str().is_some_and(|s| s.contains("OLD-GENERATION"))));
    assert!(outputs.iter().any(|o| o.content["text"].as_str().is_some_and(|s| s.contains("CURRENT-GENERATION"))));
    let old_pid = json_display(&outputs)["pid"].as_u64().unwrap();
    manager.restart(&notebook).await.unwrap();
    let (result, outputs) = run(&manager, &notebook, &python,
        "import os\nfrom IPython.display import display\ndisplay({'application/json': {'pid': os.getpid(), 'old': 'old_state' in globals()}}, raw=True)").await;
    assert_eq!(result.unwrap().status, "ok");
    assert_ne!(json_display(&outputs)["pid"], old_pid);
    assert_eq!(json_display(&outputs)["old"], false);
    manager.shutdown().await;
}

#[tokio::test]
#[ignore = "requires OPENIDEA_TEST_PYTHON with real ipykernel"]
async fn process_death_and_output_overflow_fail_explicitly_and_can_restart() {
    let root = tempfile::tempdir().unwrap();
    let manager = manager(root.path());
    let notebook = root.path().join("death.ipynb");
    let python = python();
    let (result, _) = run(&manager, &notebook, &python, "import os\nos._exit(23)").await;
    assert!(result.is_err(), "owned process death cannot report execute success");
    manager.restart(&notebook).await.unwrap();
    let (result, _) = run(
        &manager,
        &notebook,
        &python,
        "from IPython.display import display\ndisplay({'text/plain': 'x' * (9 * 1024 * 1024)}, raw=True)",
    )
    .await;
    let error = result.unwrap_err();
    assert_eq!(error.kind, ErrorKind::Unavailable);
    assert!(error.message.contains("limit") || error.message.contains("overflow") || error.message.contains("exceed"));
    manager.restart(&notebook).await.unwrap();
    let (result, outputs) = run(&manager, &notebook, &python, "print('RECOVERED', flush=True)").await;
    assert_eq!(result.unwrap().status, "ok");
    assert!(outputs.iter().any(|o| o.content["text"].as_str().is_some_and(|s| s.contains("RECOVERED"))));
    manager.shutdown().await;
}

#[tokio::test]
#[ignore = "requires OPENIDEA_TEST_PYTHON and OPENIDEA_TEST_PYTHON_SECOND"]
async fn changing_selected_python_recreates_kernel_instead_of_reusing_old_environment() {
    let root = tempfile::tempdir().unwrap();
    let manager = manager(root.path());
    let notebook = root.path().join("selection.ipynb");
    let first = python();
    let second = PathBuf::from(
        std::env::var_os("OPENIDEA_TEST_PYTHON_SECOND").expect("set a second absolute ipykernel interpreter path"),
    );
    assert_ne!(first, second);
    let (result, outputs) = run(&manager, &notebook, &first,
        "import os\nfrom IPython.display import display\nold_environment_state = 1\ndisplay({'application/json': {'pid': os.getpid()}}, raw=True)").await;
    assert_eq!(result.unwrap().status, "ok");
    let first_pid = json_display(&outputs)["pid"].as_u64().unwrap();
    let (result, outputs) = run(&manager, &notebook, &second,
        "import os, sys\nfrom IPython.display import display\ndisplay({'application/json': {'pid': os.getpid(), 'executable': sys.executable, 'old': 'old_environment_state' in globals()}}, raw=True)").await;
    assert_eq!(result.unwrap().status, "ok");
    let data = json_display(&outputs);
    assert_ne!(data["pid"], first_pid);
    assert_eq!(data["old"], false);
    assert_eq!(
        std::fs::canonicalize(data["executable"].as_str().unwrap()).unwrap(),
        std::fs::canonicalize(second).unwrap()
    );
    manager.shutdown().await;
}
