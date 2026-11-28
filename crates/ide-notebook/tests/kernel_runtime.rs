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
    target: impl Into<ide_notebook::kernel::KernelTarget>,
    code: &str,
) -> (IdeResult<ExecutionResult>, Vec<KernelOutput>) {
    let outputs: Outputs = Arc::new(Mutex::new(Vec::new()));
    let sink = outputs.clone();
    let result = tokio::time::timeout(
        Duration::from_secs(45),
        manager.execute(
            notebook,
            target,
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

#[tokio::test]
#[ignore = "requires OPENIDEA_TEST_PYTHON with real ipykernel"]
async fn inspection_is_silent_and_never_starts_a_kernel() {
    let root = tempfile::tempdir().unwrap();
    let notebook = root.path().join("inspect.ipynb");
    let python = python();
    let manager = manager(root.path());
    let expressions = || std::collections::HashMap::from([("v".to_owned(), "answer * 2".to_owned())]);
    assert!(manager.inspect(&notebook, "", expressions()).await.unwrap().is_none());
    let (result, _) = run(&manager, &notebook, &python, "answer = 21").await;
    assert_eq!(result.unwrap().execution_count, Some(1));
    let reply = manager.inspect(&notebook, "print('hidden')", expressions()).await.unwrap().unwrap();
    assert_eq!(reply["v"]["status"], "ok");
    assert_eq!(reply["v"]["data"]["text/plain"], "42");
    let (result, outputs) = run(&manager, &notebook, &python, "answer").await;
    assert_eq!(result.unwrap().execution_count, Some(2), "a silent request must not take an execution count");
    assert!(outputs.iter().all(|o| o.content["text"].as_str().is_none_or(|text| !text.contains("hidden"))));
    manager.shutdown().await;
}

#[tokio::test]
#[ignore = "requires OPENIDEA_TEST_PYTHON with real ipykernel"]
async fn a_run_waits_for_a_slow_inspection_and_keeps_the_kernel() {
    let root = tempfile::tempdir().unwrap();
    let notebook = root.path().join("slow.ipynb");
    let python = python();
    let manager = manager(root.path());
    let (result, _) = run(&manager, &notebook, &python,
        "import time\nclass Slow:\n    def __repr__(self):\n        time.sleep(2)\n        return 'slow'\nslow = Slow()\nkept = 1").await;
    assert_eq!(result.unwrap().status, "ok");
    let expressions = std::collections::HashMap::from([("v".to_owned(), "repr(slow)".to_owned())]);
    let inspecting = {
        let (manager, notebook) = (manager.clone(), notebook.clone());
        tokio::spawn(async move { manager.inspect(&notebook, "", expressions).await })
    };
    tokio::time::sleep(Duration::from_millis(500)).await;
    // Arrives during the inspection: waits for it instead of failing as busy.
    let (result, outputs) = run(&manager, &notebook, &python, "kept + 1").await;
    assert_eq!(result.unwrap().status, "ok");
    assert!(outputs.iter().any(|o| o.kind == "execute_result" && o.content["data"]["text/plain"] == "2"));
    assert_eq!(inspecting.await.unwrap().unwrap().unwrap()["v"]["data"]["text/plain"], "'slow'");
    manager.shutdown().await;
}

#[tokio::test]
#[ignore = "requires OPENIDEA_TEST_PYTHON with real ipykernel"]
async fn a_stuck_inspection_is_interrupted_at_its_limit_and_the_waiting_run_goes_on() {
    let root = tempfile::tempdir().unwrap();
    let notebook = root.path().join("hung.ipynb");
    let python = python();
    let manager = manager(root.path());
    let (result, _) = run(
        &manager,
        &notebook,
        &python,
        "import time\nclass Hung:\n    def __repr__(self):\n        time.sleep(600)\nhung = Hung()\nkept = 1",
    )
    .await;
    assert_eq!(result.unwrap().status, "ok");
    let expressions = std::collections::HashMap::from([("v".to_owned(), "repr(hung)".to_owned())]);
    let inspecting = {
        let (manager, notebook) = (manager.clone(), notebook.clone());
        tokio::spawn(async move { manager.inspect(&notebook, "", expressions).await })
    };
    tokio::time::sleep(Duration::from_millis(500)).await;
    let started = std::time::Instant::now();
    let (result, outputs) =
        tokio::time::timeout(Duration::from_secs(15), run(&manager, &notebook, &python, "kept + 1")).await.unwrap();
    assert_eq!(result.unwrap().status, "ok", "the run waits for the read, not fails");
    assert!(outputs.iter().any(|o| o.kind == "execute_result" && o.content["data"]["text/plain"] == "2"));
    assert!(started.elapsed() < Duration::from_secs(10));
    assert_eq!(inspecting.await.unwrap().unwrap_err().kind, ErrorKind::Cancelled);
    manager.shutdown().await;
}

#[tokio::test]
#[ignore = "requires OPENIDEA_TEST_PYTHON with real ipykernel"]
async fn interrupt_stops_a_stuck_inspection_and_keeps_state() {
    let root = tempfile::tempdir().unwrap();
    let notebook = root.path().join("stuck.ipynb");
    let python = python();
    let manager = manager(root.path());
    let (result, _) = run(
        &manager,
        &notebook,
        &python,
        "import time\nclass Stuck:\n    def __repr__(self):\n        time.sleep(600)\nstuck = Stuck()\nkept = 1",
    )
    .await;
    assert_eq!(result.unwrap().status, "ok");
    let expressions = std::collections::HashMap::from([("v".to_owned(), "repr(stuck)".to_owned())]);
    let inspecting = {
        let (manager, notebook) = (manager.clone(), notebook.clone());
        tokio::spawn(async move { manager.inspect(&notebook, "", expressions).await })
    };
    tokio::time::sleep(Duration::from_millis(500)).await;
    tokio::time::timeout(Duration::from_secs(10), manager.interrupt(&notebook)).await.unwrap().unwrap();
    let inspected = tokio::time::timeout(Duration::from_secs(10), inspecting).await.unwrap().unwrap();
    assert_eq!(inspected.unwrap_err().kind, ErrorKind::Cancelled);
    let (result, _) = run(&manager, &notebook, &python, "kept").await;
    assert_eq!(result.unwrap().status, "ok", "the kernel and its state survive");
    manager.shutdown().await;
}

#[tokio::test]
#[ignore = "requires OPENIDEA_TEST_JUPYTER_URL (and OPENIDEA_TEST_JUPYTER_TOKEN) of a running Jupyter server"]
async fn remote_kernel_runs_interrupts_restarts_and_is_deleted() {
    let (server, token, target) = remote(None).await;
    let before = server_kernels(&server, &token).await;
    let root = tempfile::tempdir().unwrap();
    let notebook = root.path().join("remote.ipynb");
    let manager = manager(root.path());
    let run = |code: &'static str| {
        let (manager, notebook, target) = (manager.clone(), notebook.clone(), target.clone());
        async move {
            let outputs: Outputs = Arc::new(Mutex::new(Vec::new()));
            let sink = outputs.clone();
            let result = manager
                .execute(
                    &notebook,
                    target,
                    code,
                    CancellationToken::new(),
                    Arc::new(move |o| sink.lock().unwrap().push(o)),
                )
                .await;
            let outputs = std::mem::take(&mut *outputs.lock().unwrap());
            (result, outputs)
        }
    };
    let (result, outputs) = run("answer = 6 * 7\nanswer").await;
    assert_eq!(result.unwrap().status, "ok");
    assert!(outputs.iter().any(|o| o.kind == "execute_result" && o.content["data"]["text/plain"] == "42"));
    let sleeping = tokio::spawn(run("import time\ntime.sleep(30)"));
    tokio::time::sleep(Duration::from_secs(2)).await;
    manager.interrupt(&notebook).await.unwrap();
    let (result, _) = tokio::time::timeout(Duration::from_secs(10), sleeping).await.unwrap().unwrap();
    assert!(result.is_err() || result.unwrap().status == "error", "the interrupted run must not succeed");
    let (result, _) = run("answer").await;
    assert_eq!(result.unwrap().status, "ok", "state survives an interrupt");
    manager.restart(&notebook).await.unwrap();
    let (result, outputs) = run("answer").await;
    assert_eq!(result.unwrap().status, "error");
    assert!(outputs.iter().any(|o| o.kind == "error" && o.content["ename"] == "NameError"));
    manager.shutdown_kernel(&notebook).await.unwrap();
    assert_eq!(server_kernels(&server, &token).await, before, "closing the notebook deletes its kernel on the server");
}

/// The test server from `OPENIDEA_TEST_JUPYTER_URL` / `OPENIDEA_TEST_JUPYTER_TOKEN`, with `base`
/// in place of its URL when given (a forwarder in front of it).
async fn remote(base: Option<String>) -> (String, String, ide_notebook::kernel::KernelTarget) {
    use ide_notebook::kernel::{KernelTarget, RemoteKernel, kernel_specs, normalize_server_url};
    let (server, in_url) = normalize_server_url(&std::env::var("OPENIDEA_TEST_JUPYTER_URL").unwrap()).unwrap();
    let token = std::env::var("OPENIDEA_TEST_JUPYTER_TOKEN").ok().or(in_url).unwrap_or_default();
    let spec = kernel_specs(&server, &token).await.unwrap().remove(0).name;
    let base = base.unwrap_or(server.clone());
    (server.clone(), token.clone(), KernelTarget::Remote(RemoteKernel { base, token, spec }))
}

/// The ids of the server's kernels.
async fn server_kernels(server: &str, token: &str) -> std::collections::HashSet<String> {
    let client = ide_http::client::shared_without_redirects().unwrap();
    let reply = client.get(format!("{server}api/kernels")).header("Authorization", format!("token {token}"));
    let kernels: Vec<Value> = serde_json::from_slice(&reply.send().await.unwrap().bytes().await.unwrap()).unwrap();
    kernels.iter().map(|kernel| kernel["id"].as_str().unwrap().to_owned()).collect()
}

#[tokio::test]
#[ignore = "requires OPENIDEA_TEST_JUPYTER_URL (and OPENIDEA_TEST_JUPYTER_TOKEN) of a running Jupyter server"]
async fn closing_a_notebook_while_its_remote_kernel_starts_deletes_the_kernel() {
    let (server, token, target) = remote(None).await;
    let before = server_kernels(&server, &token).await;
    let root = tempfile::tempdir().unwrap();
    let notebook = root.path().join("closed.ipynb");
    let manager = manager(root.path());
    let starting = {
        let (manager, notebook) = (manager.clone(), notebook.clone());
        tokio::spawn(async move { run(&manager, &notebook, target, "1").await })
    };
    // Closed once the server has the kernel, before it answers.
    while server_kernels(&server, &token).await == before {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    manager.shutdown_kernel(&notebook).await.unwrap();
    assert!(starting.await.unwrap().0.is_err());
    for _ in 0..50 {
        if server_kernels(&server, &token).await == before {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("the kernel was left on the server");
}

#[tokio::test]
#[ignore = "requires OPENIDEA_TEST_JUPYTER_URL (and OPENIDEA_TEST_JUPYTER_TOKEN) of a running Jupyter server"]
async fn a_dropped_connection_to_the_server_reconnects_and_keeps_the_kernel() {
    // A forwarder in front of the server whose connections can be cut.
    let (server, token, _) = remote(None).await;
    let upstream = reqwest::Url::parse(&server).unwrap();
    let upstream = format!("{}:{}", upstream.host_str().unwrap(), upstream.port_or_known_default().unwrap());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/", listener.local_addr().unwrap());
    let links: Arc<Mutex<Vec<tokio::task::JoinHandle<()>>>> = Arc::default();
    let accepting = {
        let links = links.clone();
        tokio::spawn(async move {
            while let Ok((mut client, _)) = listener.accept().await {
                let upstream = upstream.clone();
                links.lock().unwrap().push(tokio::spawn(async move {
                    let mut server = tokio::net::TcpStream::connect(upstream).await.unwrap();
                    let _ = tokio::io::copy_bidirectional(&mut client, &mut server).await;
                }));
            }
        })
    };
    let (_, _, target) = remote(Some(base)).await;
    let before = server_kernels(&server, &token).await;
    let root = tempfile::tempdir().unwrap();
    let notebook = root.path().join("dropped.ipynb");
    let manager = manager(root.path());
    let (result, _) = run(&manager, &notebook, target.clone(), "kept = 5").await;
    assert_eq!(result.unwrap().status, "ok");
    links.lock().unwrap().drain(..).for_each(|link| link.abort());
    tokio::time::sleep(Duration::from_millis(300)).await;
    let (result, outputs) = run(&manager, &notebook, target, "kept").await;
    assert_eq!(result.unwrap().status, "ok", "the run goes to the same kernel after reconnecting");
    assert!(outputs.iter().any(|o| o.kind == "execute_result" && o.content["data"]["text/plain"] == "5"));
    manager.shutdown_kernel(&notebook).await.unwrap();
    accepting.abort();
    assert_eq!(server_kernels(&server, &token).await, before, "closing the notebook deletes its one kernel");
}

/// Sends DAP request `command` on `debugger` and waits for its response, keeping the events.
async fn dap(
    debugger: &mut ide_notebook::kernel::KernelDebugger,
    seq: &mut i64,
    events: &mut Vec<Value>,
    command: &str,
    arguments: Value,
) -> Value {
    *seq += 1;
    let request = serde_json::json!({"type": "request", "seq": *seq, "command": command, "arguments": arguments});
    debugger.send(request).await.unwrap();
    loop {
        let message = tokio::time::timeout(Duration::from_secs(20), debugger.receive()).await.unwrap().unwrap();
        if message["type"] == "response" && message["request_seq"] == *seq {
            assert_eq!(message["success"], true, "{command}: {message}");
            return message;
        }
        events.push(message);
    }
}

/// Runs a cell under the kernel's debugger: stops at a breakpoint in another cell's function,
/// shows its locals, continues, and the kernel keeps its state after the session.
async fn debug_a_cell(manager: Arc<KernelManager>, notebook: PathBuf, target: ide_notebook::kernel::KernelTarget) {
    let helper = "def double(x):\n    y = x * 2\n    return y\n";
    let (result, _) = run(&manager, &notebook, target.clone(), helper).await;
    assert_eq!(result.unwrap().status, "ok");
    let mut debugger = manager.debugger(&notebook).unwrap();
    assert!(manager.debugger(&notebook).is_err(), "one debug session at a time");
    let (mut seq, mut events) = (0, Vec::new());
    dap(
        &mut debugger,
        &mut seq,
        &mut events,
        "initialize",
        serde_json::json!({"adapterID": "python", "pathFormat": "path", "linesStartAt1": true}),
    )
    .await;
    dap(&mut debugger, &mut seq, &mut events, "attach", serde_json::json!({})).await;
    let dumped = dap(&mut debugger, &mut seq, &mut events, "dumpCell", serde_json::json!({"code": helper})).await;
    let path = dumped["body"]["sourcePath"].as_str().unwrap().to_owned();
    let set = dap(
        &mut debugger,
        &mut seq,
        &mut events,
        "setBreakpoints",
        serde_json::json!({"source": {"path": path}, "breakpoints": [{"line": 3}]}),
    )
    .await;
    assert_eq!(set["body"]["breakpoints"][0]["verified"], true);
    dap(&mut debugger, &mut seq, &mut events, "configurationDone", serde_json::json!({})).await;
    let running = {
        let (manager, notebook, target) = (manager.clone(), notebook.clone(), target.clone());
        tokio::spawn(async move { run(&manager, &notebook, target, "b = double(21)").await })
    };
    let stopped = loop {
        if let Some(stopped) = events.iter().find(|e| e["event"] == "stopped") {
            break stopped.clone();
        }
        events.push(tokio::time::timeout(Duration::from_secs(20), debugger.receive()).await.unwrap().unwrap());
    };
    let thread = stopped["body"]["threadId"].clone();
    let frames = dap(&mut debugger, &mut seq, &mut events, "stackTrace", serde_json::json!({"threadId": thread})).await;
    let top = &frames["body"]["stackFrames"][0];
    assert_eq!(
        (top["name"].as_str(), top["source"]["path"].as_str(), top["line"].as_i64()),
        (Some("double"), Some(path.as_str()), Some(3))
    );
    let scopes = dap(&mut debugger, &mut seq, &mut events, "scopes", serde_json::json!({"frameId": top["id"]})).await;
    let reference = scopes["body"]["scopes"][0]["variablesReference"].clone();
    let locals =
        dap(&mut debugger, &mut seq, &mut events, "variables", serde_json::json!({"variablesReference": reference}))
            .await;
    assert!(locals["body"]["variables"].as_array().unwrap().iter().any(|v| v["name"] == "y" && v["value"] == "42"));
    dap(&mut debugger, &mut seq, &mut events, "continue", serde_json::json!({"threadId": thread})).await;
    let (result, _) = tokio::time::timeout(Duration::from_secs(20), running).await.unwrap().unwrap();
    assert_eq!(result.unwrap().status, "ok");
    dap(
        &mut debugger,
        &mut seq,
        &mut events,
        "disconnect",
        serde_json::json!({"restart": false, "terminateDebuggee": false}),
    )
    .await;
    drop(debugger);
    let (result, outputs) = run(&manager, &notebook, target, "b").await;
    assert_eq!(result.unwrap().status, "ok");
    assert!(outputs.iter().any(|o| o.kind == "execute_result" && o.content["data"]["text/plain"] == "42"));
    assert!(manager.debugger(&notebook).is_ok(), "a new session can open once the last one is dropped");
}

#[tokio::test]
#[ignore = "requires OPENIDEA_TEST_PYTHON with real ipykernel (and debugpy)"]
async fn a_cell_runs_under_the_kernels_debugger() {
    let root = tempfile::tempdir().unwrap();
    let manager = manager(root.path());
    let notebook = root.path().join("debug.ipynb");
    debug_a_cell(manager.clone(), notebook, ide_notebook::kernel::KernelTarget::Local(python())).await;
    manager.shutdown().await;
}

#[tokio::test]
#[ignore = "requires OPENIDEA_TEST_JUPYTER_URL (and OPENIDEA_TEST_JUPYTER_TOKEN) of a running Jupyter server"]
async fn a_cell_runs_under_a_remote_kernels_debugger() {
    let (_, _, target) = remote(None).await;
    let root = tempfile::tempdir().unwrap();
    let manager = manager(root.path());
    let notebook = root.path().join("debug-remote.ipynb");
    debug_a_cell(manager.clone(), notebook.clone(), target).await;
    manager.shutdown_kernel(&notebook).await.unwrap();
}

/// One DAP message from `read` (Content-Length framing).
async fn dap_read(read: &mut (impl tokio::io::AsyncBufReadExt + Unpin)) -> Value {
    use tokio::io::AsyncReadExt;
    let mut length = 0;
    loop {
        let mut line = String::new();
        read.read_line(&mut line).await.unwrap();
        let line = line.trim_end();
        if line.is_empty() {
            break;
        }
        length = line.split_once(':').unwrap().1.trim().parse().unwrap();
    }
    let mut body = vec![0; length];
    read.read_exact(&mut body).await.unwrap();
    serde_json::from_slice(&body).unwrap()
}

#[tokio::test]
#[ignore = "requires OPENIDEA_TEST_PYTHON with real ipykernel (and debugpy)"]
async fn the_dap_bridge_speaks_in_cell_uris_and_disconnects_when_closed() {
    use tokio::io::AsyncWriteExt;
    let root = tempfile::tempdir().unwrap();
    let manager = manager(root.path());
    let notebook = root.path().join("bridge.ipynb");
    let python = python();
    let helper = "def double(x):\n    y = x * 2\n    return y\n";
    let (helper_uri, cell_uri) =
        ("vscode-notebook-cell:/p/bridge.ipynb#helper", "vscode-notebook-cell:/p/bridge.ipynb#call");
    assert_eq!(run(&manager, &notebook, &python, helper).await.0.unwrap().status, "ok");
    let cells = vec![(helper_uri.to_owned(), helper.to_owned()), (cell_uri.to_owned(), "b = double(21)\n".to_owned())];
    let stream = ide_notebook::kernel::debug::dap_stream(manager.debugger(&notebook).unwrap(), move || cells.clone());
    let (read, mut write) = tokio::io::split(stream);
    let mut read = tokio::io::BufReader::new(read);
    let mut seq = 0;
    let mut request = async |write: &mut tokio::io::WriteHalf<_>, command: &str, arguments: Value| {
        seq += 1;
        let body =
            serde_json::json!({"type": "request", "seq": seq, "command": command, "arguments": arguments}).to_string();
        write.write_all(format!("Content-Length: {}\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
        seq
    };
    async fn until(read: &mut (impl tokio::io::AsyncBufReadExt + Unpin), found: impl Fn(&Value) -> bool) -> Value {
        loop {
            let message = tokio::time::timeout(Duration::from_secs(20), dap_read(read)).await.unwrap();
            if found(&message) {
                return message;
            }
        }
    }
    let n = request(&mut write, "initialize", serde_json::json!({"adapterID": "python", "pathFormat": "path"})).await;
    until(&mut read, |m| m["request_seq"] == n).await;
    request(&mut write, "attach", serde_json::json!({"justMyCode": true})).await;
    until(&mut read, |m| m["event"] == "initialized").await;
    let n = request(
        &mut write,
        "setBreakpoints",
        serde_json::json!({"source": {"path": helper_uri}, "breakpoints": [{"line": 3}]}),
    )
    .await;
    let set = until(&mut read, |m| m["request_seq"] == n).await;
    assert_eq!(set["body"]["breakpoints"][0]["verified"], true, "{set}");
    let n = request(&mut write, "configurationDone", serde_json::json!({})).await;
    until(&mut read, |m| m["request_seq"] == n).await;
    let running = {
        let (manager, notebook, python) = (manager.clone(), notebook.clone(), python.clone());
        tokio::spawn(async move { run(&manager, &notebook, &python, "b = double(21)\n").await })
    };
    let stopped = until(&mut read, |m| m["event"] == "stopped").await;
    let n = request(&mut write, "stackTrace", serde_json::json!({"threadId": stopped["body"]["threadId"]})).await;
    let frames = until(&mut read, |m| m["request_seq"] == n).await;
    let paths: Vec<_> =
        frames["body"]["stackFrames"].as_array().unwrap().iter().map(|f| f["source"]["path"].clone()).collect();
    assert_eq!(paths[..2], [serde_json::json!(helper_uri), serde_json::json!(cell_uri)], "{frames}");
    let n = request(&mut write, "continue", serde_json::json!({"threadId": stopped["body"]["threadId"]})).await;
    until(&mut read, |m| m["request_seq"] == n).await;
    assert_eq!(running.await.unwrap().0.unwrap().status, "ok");
    // Closed without a disconnect: the bridge sends one, so the breakpoint no longer stops runs.
    drop((read, write));
    tokio::time::sleep(Duration::from_millis(500)).await;
    let (result, outputs) = run(&manager, &notebook, &python, "double(5)").await;
    assert_eq!(result.unwrap().status, "ok");
    assert!(outputs.iter().any(|o| o.kind == "execute_result" && o.content["data"]["text/plain"] == "10"));
    manager.shutdown().await;
}

#[tokio::test]
#[ignore = "requires OPENIDEA_TEST_PYTHON and OPENIDEA_TEST_JUPYTER_URL"]
async fn a_debugger_opened_after_switching_kernels_survives_the_run() {
    let root = tempfile::tempdir().unwrap();
    let manager = manager(root.path());
    let notebook = root.path().join("switch.ipynb");
    assert_eq!(run(&manager, &notebook, &python(), "x = 1").await.0.unwrap().status, "ok");
    // The drop-down now names a kernel on a server; Debug Cell starts it before attaching.
    let (_, _, remote) = remote(None).await;
    manager.start(&notebook, remote.clone()).await.unwrap();
    let mut debugger = manager.debugger(&notebook).unwrap();
    let (mut seq, mut events) = (0, Vec::new());
    assert_eq!(run(&manager, &notebook, remote, "y = 2").await.0.unwrap().status, "ok");
    dap(&mut debugger, &mut seq, &mut events, "initialize", serde_json::json!({"adapterID": "python"})).await;
    drop(debugger);
    manager.shutdown_kernel(&notebook).await.unwrap();
}

#[tokio::test]
#[ignore = "requires OPENIDEA_TEST_PYTHON with real ipykernel (and debugpy)"]
async fn interrupting_a_run_paused_at_a_breakpoint_keeps_the_kernel() {
    let root = tempfile::tempdir().unwrap();
    let manager = manager(root.path());
    let notebook = root.path().join("paused.ipynb");
    let python = python();
    let helper = "def double(x):\n    y = x * 2\n    return y\n";
    assert_eq!(run(&manager, &notebook, &python, &format!("{helper}kept = 7")).await.0.unwrap().status, "ok");
    let mut debugger = manager.debugger(&notebook).unwrap();
    let (mut seq, mut events) = (0, Vec::new());
    dap(&mut debugger, &mut seq, &mut events, "initialize", serde_json::json!({"adapterID": "python"})).await;
    dap(&mut debugger, &mut seq, &mut events, "attach", serde_json::json!({})).await;
    let path =
        dap(&mut debugger, &mut seq, &mut events, "dumpCell", serde_json::json!({"code": format!("{helper}kept = 7")}))
            .await;
    let path = path["body"]["sourcePath"].as_str().unwrap().to_owned();
    dap(
        &mut debugger,
        &mut seq,
        &mut events,
        "setBreakpoints",
        serde_json::json!({"source": {"path": path}, "breakpoints": [{"line": 3}]}),
    )
    .await;
    dap(&mut debugger, &mut seq, &mut events, "configurationDone", serde_json::json!({})).await;
    let running = {
        let (manager, notebook, python) = (manager.clone(), notebook.clone(), python.clone());
        tokio::spawn(async move { run(&manager, &notebook, &python, "double(1)").await })
    };
    while !events.iter().any(|e| e["event"] == "stopped") {
        events.push(tokio::time::timeout(Duration::from_secs(20), debugger.receive()).await.unwrap().unwrap());
    }
    // The notebook's own Interrupt, not the debug session's Stop.
    tokio::time::timeout(Duration::from_secs(20), manager.interrupt(&notebook)).await.unwrap().unwrap();
    let _ = tokio::time::timeout(Duration::from_secs(20), running).await.unwrap();
    drop(debugger);
    let (result, outputs) = run(&manager, &notebook, &python, "kept").await;
    assert_eq!(result.unwrap().status, "ok", "the kernel and its state survive");
    assert!(outputs.iter().any(|o| o.kind == "execute_result" && o.content["data"]["text/plain"] == "7"));
    manager.shutdown().await;
}
