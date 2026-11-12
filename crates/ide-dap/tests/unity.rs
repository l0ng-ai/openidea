//! Unity 编辑器实机测试。使用独立的临时项目和编辑器实例。
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
    let events = events.lock();
    panic!("No breakpoint/step event: {:?}", &events[events.len().saturating_sub(16)..]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "needs a licensed Unity Editor and the Unity DAP adapter"]
async fn real_editor_attach_breakpoint_step_variables_and_detach() {
    let editor = std::env::var("OPENIDEA_UNITY_EDITOR").expect("OPENIDEA_UNITY_EDITOR");
    let adapter = std::env::var("OPENIDEA_UNITY_ADAPTER").expect("OPENIDEA_UNITY_ADAPTER");
    let target = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target").canonicalize().unwrap();
    // 保留编辑器日志，供失败时排查。
    let root = tempfile::Builder::new().prefix("unity-dap-smoke-").tempdir_in(target).unwrap().keep();
    let root = root.to_string_lossy().trim_start_matches(r"\\?\").replace('\\', "/");
    let root = PathBuf::from(root);
    std::fs::create_dir_all(root.join("Assets/Editor")).unwrap();
    std::fs::create_dir(root.join("ProjectSettings")).unwrap();
    std::fs::create_dir(root.join("Packages")).unwrap();
    std::fs::write(
        root.join("ProjectSettings/ProjectVersion.txt"),
        &format!(
            "m_EditorVersion: {}\n",
            PathBuf::from(&editor).ancestors().nth(2).and_then(|p| p.file_name()).unwrap().to_string_lossy()
        ),
    )
    .unwrap();
    std::fs::write(root.join("Packages/manifest.json"), r#"{"dependencies":{}}"#).unwrap();
    let source = root.join("Assets/Editor/OpenIdeaAttachProbe.cs");
    std::fs::write(&source, SCRIPT).unwrap();
    let mut command = tokio::process::Command::new(&editor);
    ide_core::process::prepare(command.as_std_mut());
    // 测试项目无包依赖，跳过包服务。
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
    let start = || {
        manager.start_with(
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
            SessionOwner::new("smoke", sink.clone()),
            |_| Some(adapter.clone()),
        )
    };
    let session = start().await.unwrap();
    eprintln!("Attached; breakpoint states: {:?}", manager.breakpoint_states(&source));
    // 启动返回时，Mono 应已准备好执行。
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
    // 在断点处断开后，编辑器应恢复运行。
    manager.stop(session).await.unwrap();
    verify_resumed(&root, &mut child).await;

    // 用同一编辑器重新附加，确认已有断点也能命中。
    std::fs::remove_file(root.join("done")).unwrap();
    events.lock().clear();
    let session = start().await.unwrap_or_else(|error| {
        let events = events.lock();
        panic!("Reattach failed: {error:?}, recent events: {:?}", &events[events.len().saturating_sub(12)..]);
    });
    std::fs::write(root.join("go"), "").unwrap();
    let thread = stopped(&events, "breakpoint").await;
    assert_eq!(manager.stack_trace(session, thread).await.unwrap()[0].line, line);
    manager.stop(session).await.unwrap();
    verify_resumed(&root, &mut child).await;
    std::fs::write(root.join("exit"), "").unwrap();
    assert!(tokio::time::timeout(Duration::from_secs(30), child.wait()).await.unwrap().unwrap().success());
    eprintln!("Verified discovery, attachment, breakpoint, locals, evaluation, step, detach and reattachment");
}

async fn verify_resumed(root: &std::path::Path, child: &mut tokio::process::Child) {
    let path = root.join("done");
    for _ in 0..100 {
        assert!(child.try_wait().unwrap().is_none(), "disconnect terminated the Unity Editor");
        if std::fs::read_to_string(&path).is_ok_and(|text| text == "42") {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("Unity did not complete the script after disconnect: {:?}", std::fs::read_to_string(path));
}
