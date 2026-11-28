//! Settings Sync between two machines through a local bare repository.

mod common;

use ide_host::Host;
use ide_host::ops::settings_sync::{SettingsSyncMode, SettingsSyncResult, sync_now};
use ide_ssh::secrets::testing::use_memory_store;
use std::collections::BTreeMap;
use std::path::Path;

type Storage = BTreeMap<String, BTreeMap<String, String>>;

fn machine(dir: &Path, remote: &Path, settings: &str) -> Host {
    std::fs::create_dir_all(dir.join("config")).unwrap();
    let repository = format!("[settingsSync]\nrepository = {:?}\n", remote.to_str().unwrap());
    std::fs::write(dir.join("config/settings.toml"), format!("{repository}{settings}")).unwrap();
    Host::new(common::host_config(dir))
}

fn storage(entries: &[(&str, &str, &str)]) -> Storage {
    let mut out = Storage::new();
    for (category, key, value) in entries {
        out.entry((*category).into()).or_default().insert((*key).into(), (*value).into());
    }
    out
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn two_machines_sync_through_a_bare_repository() {
    use_memory_store();
    let tmp = tempfile::tempdir().unwrap();
    let remote = tmp.path().join("settings.git");
    assert!(std::process::Command::new("git").args(["init", "--bare", "-q"]).arg(&remote).status().unwrap().success());

    let a = machine(
        &tmp.path().join("a"),
        &remote,
        "[general]\nconfirmExit = false\nlastRunVersion = \"a\"\n[editor]\nfontSize = 15\n\
         [languages.python]\ninterpreter = \"/a/bin/python\"\n[proxy]\npassword = \"p\"\n",
    );
    let b = machine(
        &tmp.path().join("b"),
        &remote,
        "[general]\nlastRunVersion = \"b\"\n[editor]\ntabSize = 2\n[languages.python]\ninterpreter = \"/b/bin/python\"\n",
    );
    let macros = storage(&[("macros", "openidea.macros.v1", "[\"a\"]")]);

    // A pushes first; B finds settings it never synced with and is asked.
    assert_eq!(sync_now(&a, &macros, None).unwrap(), SettingsSyncResult::default());
    assert!(sync_now(&b, &Storage::new(), None).unwrap().needs_choice);
    let merged = sync_now(&b, &Storage::new(), Some(SettingsSyncMode::Merge)).unwrap();
    assert!(merged.settings_changed);
    assert_eq!(merged.storage, macros);
    let settings = b.global_settings.effective();
    assert_eq!((settings.editor.font_size, settings.editor.tab_size), (15.0, 2));
    assert_eq!(settings.languages.python.interpreter, "/b/bin/python", "machine paths stay");
    assert_eq!((settings.general.confirm_exit, settings.general.last_run_version.as_str()), (false, "b"));

    // A picks up B's change; nothing secret or machine-specific reached the repository.
    assert!(sync_now(&a, &macros, None).unwrap().settings_changed);
    assert_eq!(a.global_settings.effective().editor.tab_size, 2);
    assert_eq!(a.global_settings.effective().languages.python.interpreter, "/a/bin/python");
    let log = std::process::Command::new("git").current_dir(&remote).args(["log", "-p", "main"]).output().unwrap();
    let log = String::from_utf8(log.stdout).unwrap();
    assert!(
        log.contains("\"fontSize\": 15")
            && !log.contains("python")
            && !log.contains("password")
            && !log.contains("lastRunVersion"),
        "{log}"
    );

    // Both change the font size: each machine's own value wins where it syncs, and is reported.
    a.global_settings.set(ide_workspace::settings::SettingsScope::Global, "editor.fontSize", 16.into()).unwrap();
    b.global_settings.set(ide_workspace::settings::SettingsScope::Global, "editor.fontSize", 17.into()).unwrap();
    sync_now(&a, &macros, None).unwrap();
    let late = sync_now(&b, &macros, None).unwrap();
    assert_eq!(late.overwritten, ["editor.fontSize"]);
    sync_now(&a, &macros, None).unwrap();
    assert_eq!(a.global_settings.effective().editor.font_size, 17.0);
}
