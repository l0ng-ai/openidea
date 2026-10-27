//! Drives Godot's debug adapter (inside the Godot editor) with the GDScript
//! language definition: a headless editor is started for the project, the main
//! scene is played, a breakpoint hits, stack / variables / stepping work, and the
//! game and the editor end with the session.
//!
//! Ignored by default (needs Godot 4). Run with
//! `GODOT_BIN=<godot executable> cargo test -p ide-dap --test godot -- --ignored --nocapture`.

use ide_core::event::DebugEvent;
use ide_core::{IdeEvent, SharedSink};
use ide_dap::*;
use ide_language::{LanguageConfig, LanguageRegistry};
use parking_lot::Mutex;
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

const SCRIPT: &str = "extends Node

var health: int = 3

func _ready() -> void:
\tvar total := add(2, 3)
\tprint(\"total = \", total)
\thealth -= 1
\tget_tree().quit()

func add(a: int, b: int) -> int:
\treturn a + b
";
/// 0-based line of `return a + b`.
const BREAK_LINE: u32 = 11;

fn project(dir: &Path) {
    std::fs::write(
        dir.join("project.godot"),
        "config_version=5\n\n[application]\nconfig/name=\"Probe\"\nrun/main_scene=\"res://main.tscn\"\n",
    )
    .unwrap();
    std::fs::write(
        dir.join("main.tscn"),
        "[gd_scene load_steps=2 format=3]\n\n[ext_resource type=\"Script\" path=\"res://player.gd\" id=\"1\"]\n\n[node name=\"Main\" type=\"Node\"]\nscript = ExtResource(\"1\")\n",
    )
    .unwrap();
    std::fs::write(dir.join("player.gd"), SCRIPT).unwrap();
}

/// The built-in GDScript definition, with the editor's usual port moved aside so an
/// open editor can't answer instead of the one this test starts.
fn registry() -> Arc<LanguageRegistry> {
    let builtin = LanguageRegistry::load(None).unwrap();
    let mut gd: LanguageConfig = builtin.get(&ide_core::LanguageId::new("gdscript")).unwrap();
    let dbg = gd.debugger.as_mut().unwrap();
    let unused = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap().local_addr().unwrap().port();
    dbg.connect = Some(format!("127.0.0.1:{unused}"));
    Arc::new(LanguageRegistry::from_configs(vec![gd]))
}

async fn wait_for(events: &Mutex<Vec<IdeEvent>>, timeout: Duration, pred: impl Fn(&DebugEvent) -> bool) -> DebugEvent {
    let start = Instant::now();
    loop {
        if let Some(e) = events.lock().iter().find_map(|e| match e {
            IdeEvent::Debug { event, .. } if pred(event) => Some(event.clone()),
            _ => None,
        }) {
            return e;
        }
        assert!(start.elapsed() < timeout, "timed out; events: {:#?}", events.lock());
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

fn godot_processes(project: &Path) -> usize {
    let out = std::process::Command::new("pgrep").args(["-f", &project.to_string_lossy()]).output().unwrap();
    String::from_utf8_lossy(&out.stdout).lines().count()
}

#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn breakpoints_stepping_and_variables_in_a_real_godot() {
    let Ok(godot) = std::env::var("GODOT_BIN") else {
        eprintln!("GODOT_BIN not set; skipping");
        return;
    };
    let dir = std::env::temp_dir().join(format!("openidea-godot-dap-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let root = std::fs::canonicalize(&dir).unwrap();
    project(&root);
    let manager = DebugManager::new(registry());
    let events: Arc<Mutex<Vec<IdeEvent>>> = Arc::default();
    let sink: SharedSink = {
        let events = events.clone();
        Arc::new(move |e: IdeEvent| events.lock().push(e))
    };
    let script_as_opened = dir.join("player.gd");
    manager
        .set_breakpoints(
            script_as_opened.clone(),
            vec![Breakpoint {
                line: BREAK_LINE,
                condition: None,
                hit_condition: None,
                log_message: None,
                enabled: true,
            }],
        )
        .await
        .unwrap();
    // As the UI builds it for "Godot Project" (`godot --path .`).
    let config = LaunchConfig {
        name: "Godot Project".into(),
        adapter: "godot".into(),
        request: "launch".into(),
        program: None,
        args: vec![],
        // The project as opened, through a symlink on macOS (`/var` → `/private/var`).
        cwd: Some(dir.clone().into()),
        env: BTreeMap::new(),
        extra_json: Some(serde_json::json!({ "project": dir, "scene": "main" }).to_string()),
    };
    let id = manager
        .start_with(config, SessionOwner::new("main", sink), |_| Some(godot.clone()))
        .await
        .unwrap_or_else(|e| panic!("start: {e:?}"));

    let stopped = wait_for(&events, Duration::from_secs(120), |e| matches!(e, DebugEvent::Stopped { .. })).await;
    let DebugEvent::Stopped { thread_id, .. } = stopped else { unreachable!() };
    let frames = manager.stack_trace(id, thread_id).await.unwrap();
    assert_eq!(frames[0].name, "add");
    assert_eq!(frames[0].line, BREAK_LINE);
    // Frames name the file as the IDE opened it, not Godot's resolved path.
    assert_eq!(frames[0].path.as_deref().map(Path::new), Some(script_as_opened.as_path()));
    assert_eq!(frames[1].name, "_ready");
    let scopes = manager.scopes(id, frames[0].id).await.unwrap();
    let locals = scopes.iter().find(|s| s.name == "Locals").expect("Locals scope");
    let vars = manager.variables(id, locals.variables_reference).await.unwrap();
    let value = |n: &str| vars.iter().find(|v| v.name == n).map(|v| v.value.clone());
    assert_eq!((value("a").as_deref(), value("b").as_deref()), (Some("2"), Some("3")), "{vars:?}");

    events.lock().clear();
    manager.step(id, thread_id, StepKind::Over).await.unwrap();
    wait_for(&events, Duration::from_secs(30), |e| matches!(e, DebugEvent::Stopped { .. })).await;
    let frames = manager.stack_trace(id, thread_id).await.unwrap();
    assert_eq!((frames[0].name.as_str(), frames[0].line), ("_ready", 6), "stepped back into `_ready`, at the print");
    manager.resume(id, thread_id).await.unwrap();
    // (The game's last output is not always forwarded when it quits right away.)
    wait_for(&events, Duration::from_secs(30), |e| matches!(e, DebugEvent::Terminated)).await;
    let _ = manager.stop(id).await;
    // The headless editor started for the session ends with it, the game too.
    let start = Instant::now();
    while godot_processes(&root) > 0 {
        assert!(start.elapsed() < Duration::from_secs(10), "Godot still running for {}", root.display());
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    std::fs::remove_dir_all(&root).ok();
}
