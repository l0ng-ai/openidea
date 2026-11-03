//! Versioned installs with automatic rollback, signed packages from
//! a static marketplace index, and revocation.

use ide_extension::package::{self, Index, IndexEntry, KeyEntry, Publisher, PublisherKey, Revocation};
use ide_host::plugins::*;
use ide_plugin::{Invocation, Limits};
use parking_lot::Mutex;
use std::path::{Path, PathBuf};
use std::sync::Arc;

type Events = Arc<Mutex<Vec<PluginEvent>>>;

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for entry in std::fs::read_dir(from).unwrap().flatten() {
        let (src, dst) = (entry.path(), to.join(entry.file_name()));
        if entry.file_name() == "target" {
            continue;
        }
        if src.is_dir() { copy_dir(&src, &dst) } else { std::fs::copy(&src, &dst).map(|_| ()).unwrap() }
    }
}

/// A copy of `from` (under `dir/name`) whose manifest is rewritten by `f`.
fn variant(from: &Path, dir: &Path, name: &str, f: impl Fn(&str) -> String) -> PathBuf {
    let pkg = dir.join(name);
    copy_dir(from, &pkg);
    let manifest = pkg.join("plugin.toml");
    std::fs::write(&manifest, f(&std::fs::read_to_string(&manifest).unwrap())).unwrap();
    pkg
}

struct Fixture {
    host: PluginHost,
    plugins_dir: PathBuf,
    events: Events,
    _tmp: tempfile::TempDir,
    work: PathBuf,
}

fn fixture() -> Fixture {
    let tmp = tempfile::tempdir().unwrap();
    let plugins_dir = tmp.path().join("plugins");
    let events: Events = Arc::default();
    let sink = {
        let events = events.clone();
        move |_: Option<&str>, e: PluginEvent| events.lock().push(e)
    };
    let host = PluginHost::new(plugins_dir.clone(), Arc::new(sink), Limits::default()).unwrap();
    host.load_all();
    let work = tmp.path().join("work");
    std::fs::create_dir_all(&work).unwrap();
    Fixture { host, plugins_dir, events, work, _tmp: tmp }
}

fn inv() -> Invocation {
    Invocation { client: Some("main".into()), workspace_root: None, editor: None }
}

fn misbehave() -> PathBuf {
    repo().join("crates/ide-plugin/tests/fixtures/misbehave")
}

/// P8 acceptance: an update that fails to start rolls back to the version it replaced.
#[test]
fn a_failing_update_rolls_back_automatically() {
    let f = fixture();
    let v1 = variant(&misbehave(), &f.work, "v1", |t| t.replace("version = \"0.0.2\"", "version = \"1.0.0\""));
    f.host.install_from_dir(&v1, &Consent::all()).unwrap();
    assert_eq!(f.host.run_command("misbehave", "echo", Some("hi"), inv()).unwrap().as_deref(), Some("hi"));

    let broken =
        variant(&misbehave(), &f.work, "v2", |t| t.replace("version = \"0.0.2\"", "version = \"2.0.0-broken\""));
    let info = f.host.install_from_dir(&broken, &Consent::all()).unwrap();
    assert_eq!((info.version.as_str(), info.previous_version.as_deref()), ("2.0.0-broken", Some("1.0.0")));
    let root = f.plugins_dir.join("misbehave");
    assert!(root.join("2.0.0-broken").is_dir() && root.join("1.0.0").is_dir(), "versions side by side");

    // Its first start fails: back to 1.0.0, without the user doing anything.
    f.events.lock().clear();
    let err = f.host.run_command("misbehave", "echo", Some("x"), inv()).unwrap_err();
    assert!(err.message.contains("version 1.0.0 was restored"), "{}", err.message);
    let info = f.host.info_of("misbehave").unwrap();
    assert_eq!((info.version.as_str(), info.status), ("1.0.0", PluginStatus::Inactive));
    assert!(!root.join("2.0.0-broken").exists(), "the failed version is removed");
    assert!(
        f.events
            .lock()
            .iter()
            .any(|e| matches!(e, PluginEvent::Notification { title, .. } if title.contains("rolled back")))
    );
    assert_eq!(f.host.run_command("misbehave", "echo", Some("ok"), inv()).unwrap().as_deref(), Some("ok"));

    // A working update is confirmed by its first start; the user can still roll it back.
    let v3 = variant(&misbehave(), &f.work, "v3", |t| t.replace("version = \"0.0.2\"", "version = \"3.0.0\""));
    f.host.install_from_dir(&v3, &Consent::all()).unwrap();
    f.host.run_command("misbehave", "echo", None, inv()).unwrap();
    assert_eq!(f.host.info_of("misbehave").unwrap().version, "3.0.0");
    let info = f.host.roll_back_update("misbehave").unwrap();
    assert_eq!((info.version.as_str(), info.previous_version.as_deref()), ("1.0.0", None));
    assert!(f.host.roll_back_update("misbehave").is_err(), "nothing older to go back to");

    // A restart loads the active version.
    let again = PluginHost::new(f.plugins_dir.clone(), Arc::new(|_: Option<&str>, _| {}), Limits::default()).unwrap();
    again.load_all();
    assert_eq!(again.info_of("misbehave").unwrap().version, "1.0.0");
    f.host.uninstall("misbehave").unwrap();
    assert!(!root.exists(), "every version goes");
}

#[test]
fn installs_from_before_versioning_keep_working_and_move_on_update() {
    let f = fixture();
    // The flat layout of earlier releases.
    copy_dir(&misbehave(), &f.plugins_dir.join("misbehave"));
    let again = PluginHost::new(f.plugins_dir.clone(), Arc::new(|_: Option<&str>, _| {}), Limits::default()).unwrap();
    again.load_all();
    assert_eq!(again.info_of("misbehave").unwrap().version, "0.0.2");
    let v1 = variant(&misbehave(), &f.work, "v1", |t| t.replace("version = \"0.0.2\"", "version = \"1.0.0\""));
    let info = again.install_from_dir(&v1, &Consent::all()).unwrap();
    assert_eq!((info.version.as_str(), info.previous_version.as_deref()), ("1.0.0", Some("0.0.2")));
    assert!(f.plugins_dir.join("misbehave/0.0.2/plugin.toml").is_file());
    assert!(f.plugins_dir.join("misbehave/1.0.0/plugin.toml").is_file());
}

// ---- marketplace ------------------------------------------------------------------

/// `hello` as `acme.hello` at `version`, packed and signed with `key`.
fn signed_hello(dir: &Path, version: &str, key: &PublisherKey, host: &PluginHost) -> (PathBuf, IndexEntry) {
    let src = variant(&repo().join("plugins/hello"), dir, &format!("src-{version}"), |t| {
        t.replace("id = \"hello\"", "id = \"acme.hello\"")
            .replace("version = \"0.3.0\"", &format!("version = \"{version}\""))
    });
    let files = host.package_files_of(&src).unwrap();
    let digest = package::package_digest(&src, &files).unwrap();
    let sig = key.sign("acme", "acme.hello", version, &digest);
    let out = dir.join(format!("acme.hello-{version}.oiplugin"));
    package::pack(&src, &files, &out, Some(&sig)).unwrap();
    let entry = IndexEntry {
        id: "acme.hello".into(),
        name: "Hello".into(),
        version: version.into(),
        description: String::new(),
        authors: vec![],
        publisher: "acme".into(),
        download: out.file_name().unwrap().to_string_lossy().into_owned(),
        digest,
        capabilities: vec![],
    };
    (out, entry)
}

fn write_index(
    dir: &Path,
    key: &PublisherKey,
    plugins: Vec<IndexEntry>,
    revoked: Vec<Revocation>,
    key_revoked: bool,
) -> String {
    let index = Index {
        format: package::INDEX_FORMAT,
        publishers: vec![Publisher {
            id: "acme".into(),
            name: "ACME".into(),
            keys: vec![KeyEntry { key: key.public_base64(), revoked: key_revoked }],
        }],
        plugins,
        revoked,
    };
    let path = dir.join("index.json");
    std::fs::write(&path, serde_json::to_string(&index).unwrap()).unwrap();
    path.to_string_lossy().into_owned()
}

#[test]
fn signed_marketplace_plugins_install_and_revocations_disable_them() {
    let f = fixture();
    let market = f.work.join("market");
    std::fs::create_dir_all(&market).unwrap();
    let key = PublisherKey::from_seed([3; 32]);
    let (_, entry) = signed_hello(&market, "1.0.0", &key, &f.host);
    let url = write_index(&market, &key, vec![entry.clone()], vec![], false);

    assert!(f.host.refresh_market().is_err(), "no marketplace configured yet");
    f.host.set_market_url(Some(url.clone()));
    let listed = f.host.refresh_market().unwrap();
    assert_eq!((listed[0].entry.id.as_str(), listed[0].installed.as_deref()), ("acme.hello", None));

    let dir = f.host.download_market_plugin("acme.hello").unwrap();
    let preview = f.host.preview_install(&dir).unwrap();
    assert_eq!((preview.unsigned, preview.publisher.as_deref()), (false, Some("acme")));
    let info = f.host.install_from_dir(&dir, &Consent::all()).unwrap();
    assert_eq!(info.publisher.as_deref(), Some("acme"));
    assert_eq!(f.host.market_plugins()[0].installed.as_deref(), Some("1.0.0"));

    // A changed file breaks the signature: refused.
    let tampered = f.host.download_market_plugin("acme.hello").unwrap();
    let manifest = std::fs::read_to_string(tampered.join("plugin.toml")).unwrap();
    std::fs::write(tampered.join("plugin.toml"), manifest.replace("Sample plugin", "Totally safe plugin")).unwrap();
    let err = f.host.preview_install(&tampered).unwrap_err();
    assert!(err.message.contains("changed after signing"), "{}", err.message);

    // Someone else's key, or another publisher's prefix: not trusted.
    let stranger = PublisherKey::from_seed([4; 32]);
    let (foreign, _) = signed_hello(&f.work, "1.0.1", &stranger, &f.host);
    let unpacked = f.host.unpack_package(&foreign).unwrap();
    assert!(f.host.preview_install(&unpacked).unwrap_err().message.contains("not one of"));

    // The index revokes the installed version: disabled, the user told.
    f.events.lock().clear();
    let revoked =
        vec![Revocation { id: "acme.hello".into(), versions: vec!["1.0.0".into()], reason: "steals tokens".into() }];
    write_index(&market, &key, vec![entry.clone()], revoked, false);
    f.host.refresh_market().unwrap();
    let info = f.host.info_of("acme.hello").unwrap();
    assert_eq!((info.status, info.error.as_deref()), (PluginStatus::Failed, Some("revoked: steals tokens")));
    assert!(
        f.events
            .lock()
            .iter()
            .any(|e| matches!(e, PluginEvent::Notification { body, .. } if body.contains("steals tokens")))
    );
    assert!(f.host.market_plugins().is_empty(), "revoked versions are not offered");
    assert!(f.host.install_from_dir(&dir, &Consent::all()).is_err(), "nor installable");
    f.host.set_enabled("acme.hello", true).unwrap();
    assert_eq!(f.host.info_of("acme.hello").unwrap().status, PluginStatus::Failed, "enabling doesn't bring it back");

    // Revocations hold across restarts (the index is kept).
    let again = PluginHost::new(f.plugins_dir.clone(), Arc::new(|_: Option<&str>, _| {}), Limits::default()).unwrap();
    again.load_all();
    assert_eq!(again.info_of("acme.hello").unwrap().status, PluginStatus::Failed);

    // A revoked signing key disables what it signed.
    write_index(&market, &key, vec![entry.clone()], vec![], true);
    f.host.refresh_market().unwrap();
    let info = f.host.info_of("acme.hello").unwrap();
    assert!(info.error.as_deref().unwrap_or("").contains("signing key was revoked"), "{:?}", info.error);

    // Lifted: it runs again.
    write_index(&market, &key, vec![entry], vec![], false);
    f.host.refresh_market().unwrap();
    let info = f.host.info_of("acme.hello").unwrap();
    assert_eq!((info.status, info.error), (PluginStatus::Inactive, None));
}

#[test]
fn package_files_install_from_disk_unsigned() {
    let f = fixture();
    let src = variant(&misbehave(), &f.work, "pkg", |t| t.to_owned());
    let files = f.host.package_files_of(&src).unwrap();
    let out = f.work.join("misbehave-0.0.2.oiplugin");
    package::pack(&src, &files, &out, None).unwrap();
    let dir = f.host.unpack_package(&out).unwrap();
    let preview = f.host.preview_install(&dir).unwrap();
    assert_eq!((preview.unsigned, preview.publisher), (true, None));
    let info = f.host.install_from_dir(&dir, &Consent::all()).unwrap();
    assert_eq!((info.status, info.publisher), (PluginStatus::Inactive, None));
}
