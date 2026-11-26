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

#[test]
fn the_plugins_configuration_completes_only_the_argument_under_the_caret() {
    let tmp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(tmp.path()).unwrap();
    let (root, other) = (base.join("project"), base.join("other"));
    std::fs::create_dir_all(&root).unwrap();
    std::fs::create_dir_all(&other).unwrap();
    std::fs::write(root.join("Taskfile.yml"), "version: '3'\n").unwrap();
    let p = plugins(&base);
    let config = "plugin:test.run-anything:tasks";
    // Not provided until its program is approved.
    assert!(p.run_configuration_complete("main", &root, config, "arguments", "b", 1).is_err());
    p.choose_program(ID, "process:task", Some(&root), Some(Path::new("/bin/echo"))).unwrap();
    assert!(p.run_detection().detect(&root).iter().any(|c| c.id == config));
    let complete = |text: &str, caret: u32| -> Vec<(String, String, u32, u32)> {
        p.run_configuration_complete("main", &root, config, "arguments", text, caret)
            .unwrap()
            .into_iter()
            .map(|c| (c.label, c.insert, c.replace_start, c.replace_end))
            .collect()
    };
    // Options, quoted values and the task's own arguments after `--` stay outside the range.
    let text = "--dry 'a b' d -- x";
    assert_eq!(complete(text, 13), [("docs:serve".into(), "docs:serve".into(), 12, 13)]);
    assert!(complete(text, 18).is_empty(), "after `--` the arguments are the task's");
    assert!(complete(text, 3).is_empty(), "an option is not a task");
    // UTF-16 offsets.
    assert_eq!(complete("é b", 3), [("build".into(), "build".into(), 2, 3)]);
    assert_eq!(complete("", 0).len(), 3);
    assert!(p.run_configuration_complete("main", &root, config, "env", "b", 1).unwrap().is_empty());
    // Out-of-range carets, other configurations and projects without it are refused.
    assert!(p.run_configuration_complete("main", &root, config, "arguments", "b", 2).is_err());
    assert!(
        p.run_configuration_complete("main", &root, "plugin:test.run-anything:other", "arguments", "b", 1).is_err()
    );
    assert!(p.run_configuration_complete("main", &root, "npm:dev", "arguments", "b", 1).is_err());
    assert!(p.run_configuration_complete("main", &other, config, "arguments", "b", 1).is_err());
    // Revoking the program withdraws the configuration, and with it the completion.
    p.set_capability(ID, "process:task", false).unwrap();
    assert!(p.run_configuration_complete("main", &root, config, "arguments", "b", 1).is_err());
}
