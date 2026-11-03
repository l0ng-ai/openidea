//! Real Editor smoke test, opt-in. Creates its own disposable project and Editor;
//! never attaches to a user's already running Editor.
//! OPENIDEA_UNITY_EDITOR=<Unity.exe> OPENIDEA_UNITY_ADAPTER=<UnityDebug.exe>
//! cargo test -p ide-dap --test unity -- --ignored --nocapture

use ide_core::{IdeEvent, SharedSink, event::DebugEvent};
use ide_dap::{Breakpoint, DebugManager, LaunchConfig, SessionOwner, StepKind};
use ide_language::LanguageRegistry;
use parking_lot::Mutex;
use std::{collections::BTreeMap, path::PathBuf, sync::Arc, time::Duration};

const SCRIPT: &str = r#"using System.IO;
using UnityEditor;
using UnityEngine;
[InitializeOnLoad]
public static class OpenIdeaAttachProbe
{
    static readonly string Root = Directory.GetParent(Application.dataPath).FullName;
    static OpenIdeaAttachProbe()
    {
        EditorApplication.update += Tick;
    }
    static void Tick()
    {
        if (EditorApplication.isCompiling || EditorApplication.isUpdating) return;
        if (!File.Exists(Path.Combine(Root, "ready")))
            File.WriteAllText(Path.Combine(Root, "ready"), System.Diagnostics.Process.GetCurrentProcess().Id.ToString());
        if (File.Exists(Path.Combine(Root, "exit"))) { EditorApplication.Exit(0); return; }
        if (!File.Exists(Path.Combine(Root, "go"))) return;
        File.Delete(Path.Combine(Root, "go"));
        int result = Hit(41);
        File.WriteAllText(Path.Combine(Root, "done"), result.ToString());
    }
    static int Hit(int seed)
    {
        int answer = seed + 1;
        return answer;
    }
}
"#;

async fn stopped(events: &Mutex<Vec<IdeEvent>>, expected_reason: &str) -> i64 {
    for _ in 0..600 {
        if let Some(thread) = events.lock().iter().find_map(|e| match e {
            IdeEvent::Debug { event: DebugEvent::Stopped { thread_id, reason, .. }, .. }
                if reason == expected_reason =>
            {
                Some(*thread_id)
            }
            _ => None,
        }) {
            return thread;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("No breakpoint/step event: {:?}", events.lock());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "needs a licensed Unity Editor and the Unity DAP adapter"]
async fn real_editor_attach_breakpoint_step_variables_and_detach() {
    let editor = std::env::var("OPENIDEA_UNITY_EDITOR").expect("OPENIDEA_UNITY_EDITOR");
    let adapter = std::env::var("OPENIDEA_UNITY_ADAPTER").expect("OPENIDEA_UNITY_ADAPTER");
    let target = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target").canonicalize().unwrap();
    // Retain the test project's log for failures, as for other build artifacts.
    let root = tempfile::Builder::new().prefix("unity-dap-smoke-").tempdir_in(target).unwrap().keep();
    let root = root.to_string_lossy().trim_start_matches(r"\\?\").replace('\\', "/");
    let root = PathBuf::from(root);
    std::fs::create_dir_all(root.join("Assets/Editor")).unwrap();
    std::fs::create_dir(root.join("ProjectSettings")).unwrap();
    std::fs::create_dir(root.join("Packages")).unwrap();
    std::fs::write(root.join("ProjectSettings/ProjectVersion.txt"), "m_EditorVersion: 2022.3.40f1c1\n").unwrap();
    std::fs::write(root.join("Packages/manifest.json"), r#"{"dependencies":{}}"#).unwrap();
    let source = root.join("Assets/Editor/OpenIdeaAttachProbe.cs");
    std::fs::write(&source, SCRIPT).unwrap();
    let mut command = tokio::process::Command::new(&editor);
    ide_core::process::prepare(command.as_std_mut());
    // The probe has no packages; keep startup independent of package registries.
    command
        .args(["-batchmode", "-nographics", "-noUpm", "-debugCodeOptimization", "-projectPath"])
        .arg(&root)
        .arg("-logFile")
        .arg(root.join("Editor.log"))
        .current_dir(&root)
        .kill_on_drop(true);
    let mut child = command.spawn().unwrap();
    let pid = child.id().unwrap();
    eprintln!("Isolated Unity pid {pid}, project {}", root.display());
    for _ in 0..1200 {
        if root.join("ready").exists() {
            break;
        }
        assert!(child.try_wait().unwrap().is_none(), "Unity exited; inspect {}/Editor.log", root.display());
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(root.join("ready").exists(), "Editor failed to load the test script");
    let rows = ide_dap::unity::editors(Some(adapter.clone()), root.clone()).await.unwrap();
    assert!(rows.iter().any(|p| p.pid == pid), "test Editor absent: {rows:?}");
    let events: Arc<Mutex<Vec<IdeEvent>>> = Arc::default();
    let saved = events.clone();
    let sink: SharedSink = Arc::new(move |event| saved.lock().push(event));
    let manager = DebugManager::new(Arc::new(LanguageRegistry::from_configs(Vec::new())));
    let line = SCRIPT.lines().position(|l| l.contains("int answer =")).unwrap() as u32;
    manager
        .set_breakpoints(
            source.clone(),
            vec![Breakpoint { line, condition: None, hit_condition: None, log_message: None, enabled: true }],
        )
        .await
        .unwrap();
    let session = manager
        .start_with(
            LaunchConfig {
                name: format!("Unity Editor ({pid})"),
                adapter: "unity".into(),
                request: "attach".into(),
                program: None,
                args: vec![],
                cwd: Some(root.clone().into()),
                env: BTreeMap::new(),
                extra_json: Some(
                    serde_json::json!({ "name": format!("Unity Editor ({pid})"), "__exceptionOptions": [] })
                        .to_string(),
                ),
            },
            SessionOwner::new("smoke", sink),
            |_| Some(adapter),
        )
        .await
        .unwrap();
    eprintln!("Attached; breakpoint states: {:?}", manager.breakpoint_states(&source));
    // start_with must wait for Mono before the caller can trigger execution.
    assert!(!manager.threads(session).await.unwrap().is_empty());
    std::fs::write(root.join("go"), "").unwrap();
    let thread = stopped(&events, "breakpoint").await;
    let frames = manager.stack_trace(session, thread).await.unwrap();
    assert!(!frames.is_empty(), "Empty breakpoint stack: {:?}", events.lock());
    assert_eq!(frames[0].line, line);
    let scopes = manager.scopes(session, frames[0].id).await.unwrap();
    let variables = manager.variables(session, scopes[0].variables_reference).await.unwrap();
    assert!(variables.iter().any(|v| v.name == "seed" && v.value == "41"), "{variables:?}");
    assert_eq!(manager.evaluate(session, Some(frames[0].id), "seed + 1".into()).await.unwrap().value, "42");
    events.lock().clear();
    manager.step(session, thread, StepKind::Over).await.unwrap();
    let thread = stopped(&events, "step").await;
    let frames = manager.stack_trace(session, thread).await.unwrap();
    assert!(!frames.is_empty(), "Empty step stack: {:?}", events.lock());
    assert!(frames[0].line > line);
    // Disconnect while paused must resume the Editor rather than terminate it.
    manager.stop(session).await.unwrap();
    for _ in 0..100 {
        if root.join("done").exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_eq!(std::fs::read_to_string(root.join("done")).unwrap(), "42");
    assert!(child.try_wait().unwrap().is_none(), "disconnect terminated the Unity Editor");
    std::fs::write(root.join("exit"), "").unwrap();
    assert!(tokio::time::timeout(Duration::from_secs(30), child.wait()).await.unwrap().unwrap().success());
    eprintln!("Verified discovery, attachment, breakpoint, locals, evaluation, step and detach");
}
