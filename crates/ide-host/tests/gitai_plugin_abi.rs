//! Opt-in compatibility test using a Git AI package built for this host, not a fixture.
//! All installations/storage are temporary. No GUI, production project, process or network access.
use ide_host::plugins::{Consent, PluginHost, PluginStatus, PluginWorkspace};
use ide_plugin::{HostError, Invocation, Limits};
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// No open projects means activate cannot post a bridge session event. An ungranted
/// server hostname makes the plugin's update check fail at the real capability gate.
struct OfflineWorkspace;
impl PluginWorkspace for OfflineWorkspace {
    fn projects(&self) -> Vec<PathBuf> {
        Vec::new()
    }
    fn buffer_text(&self, _: &Path) -> Option<String> {
        None
    }
    fn document(&self, _: &Path) -> Option<(u64, String)> {
        None
    }
    fn apply_edits(&self, _: &Path, _: u64, _: &[ide_core::TextEdit]) -> Result<u64, HostError> {
        Err(HostError::Denied("no project in ABI test".into()))
    }
    fn trusted(&self, _: &Path) -> bool {
        false
    }
    fn project_of(&self, _: &str) -> Option<PathBuf> {
        None
    }
    fn publish_diagnostics(&self, _: &str, _: &Path, _: Vec<ide_core::Diagnostic>) -> Result<(), HostError> {
        Err(HostError::Denied("no project in ABI test".into()))
    }
    fn plugin_settings(&self, _: &str, _: Option<&Path>) -> serde_json::Map<String, serde_json::Value> {
        serde_json::from_value(serde_json::json!({"serverUrl": "https://abi-test.invalid"})).unwrap()
    }
}

#[test]
#[ignore = "requires an existing Git AI package; run with GITAI_PLUGIN_PACKAGE set"]
fn released_gitai_instantiates_and_renders_in_reference_host() {
    let package = PathBuf::from(std::env::var_os("GITAI_PLUGIN_PACKAGE").expect("set GITAI_PLUGIN_PACKAGE"));
    let tmp = tempfile::tempdir().unwrap();
    let host =
        PluginHost::new(tmp.path().join("plugins"), Arc::new(|_: Option<&str>, _| {}), Limits::default()).unwrap();
    host.set_workspace(Some(Arc::new(OfflineWorkspace)));
    host.set_program_path(Arc::new(|| Some(std::ffi::OsString::new())));
    host.load_all();
    // Do not announce startup before installation: install/check alone is NOT instantiation proof.
    let info = host.install_from_dir(&package, &Consent::all()).expect("released WASM must link against this host");
    assert_eq!(info.id, "cvte.git-ai-enterprise");
    assert_eq!(info.status, PluginStatus::Inactive);
    let view = host
        .render_view(&info.id, "conversation", None, Invocation::default())
        .expect("released WASM must instantiate, activate and render through the real PluginHost");
    assert!(
        view.toolbar.iter().any(|button| button.id == "refresh"),
        "expected the existing conversation view: {view:?}"
    );
    assert_eq!(host.info_of(&info.id).unwrap().status, PluginStatus::Active);
    println!("GITAI_ABI_ACCEPTED: real PluginHost install + activate + render");
}
