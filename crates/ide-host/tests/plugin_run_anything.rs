//! API 1.18 `[[contributes.runAnything]]`: lines starting with a plugin's prefix are
//! suggested and run by its `run-anything-provider` export; other lines are refused.
use ide_host::plugins::{Consent, PluginHost};
use ide_plugin::{Invocation, Limits};
use std::{path::Path, sync::Arc};

const ID: &str = "test.run-anything";

fn plugins(base: &Path) -> Arc<PluginHost> {
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("../ide-plugin/tests/fixtures/run-anything");
    let p =
        Arc::new(PluginHost::new(base.join("plugins"), Arc::new(|_: Option<&str>, _| {}), Limits::default()).unwrap());
    p.install_from_dir(&fixture, &Consent::all()).unwrap();
    p
}

#[test]
fn the_plugin_suggests_and_claims_lines_of_its_prefix() {
    let tmp = tempfile::tempdir().unwrap();
    let p = plugins(tmp.path());
    let root = Some(tmp.path().to_path_buf());
    let labels = |text: &str| -> Vec<String> {
        p.run_anything_suggest(ID, "main", root.clone(), "task", text).unwrap().into_iter().map(|i| i.label).collect()
    };
    assert_eq!(labels("ta"), ["task build", "task test", "task docs:serve"]);
    assert_eq!(labels("task d"), ["task docs:serve"]);
    assert!(labels("task x").is_empty());
    // Only text for the declared prefix reaches the plugin.
    assert!(p.run_anything_suggest(ID, "main", root.clone(), "make", "make").is_err());
    assert!(p.run_anything_suggest(ID, "main", root.clone(), "task", "echo task").is_err());

    assert!(p.run_anything_run(ID, "main", root.clone(), "task", "task build").unwrap());
    assert!(p.run_anything_run(ID, "main", root.clone(), "task", "task  docs:serve ").unwrap());
    // Left to the shell by the plugin.
    assert!(!p.run_anything_run(ID, "main", root.clone(), "task", "task deploy").unwrap());
    assert!(p.run_anything_run(ID, "main", root.clone(), "task", "tasks build").is_err());

    let invocation = Invocation { workspace_root: root, ..Default::default() };
    let ran = p.run_command(ID, "ran", None, invocation).unwrap();
    assert_eq!(ran.as_deref(), Some("build\ndocs:serve"));
}
