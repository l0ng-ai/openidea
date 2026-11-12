//! Plugin languages of a remote project: `Workspace` contributions take effect where the project is, so the
//! desktop pushes its plugins' language definitions to `openidea-server`
//! (`plugin_sync_languages`) together with the `process:` programs the user
//! granted. The server resolves each granted program on its own `PATH`, pins
//! the file (path + hash, kept in `plugin-pins.json`) the first time and
//! starts only that file afterwards; a program missing from a sync is revoked.
//! Revoking and granting again on the desktop re-pins a replaced program.

use ide_extension::Capability;
use ide_extension::ledger::{self, BinaryGrant};
use ide_language::plugin_point::{PluginLanguages, validate_definition};
use ide_language::{LanguageConfig, ProgramPin};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;

pub const PINS_FILE: &str = "plugin-pins.json";
/// The server command the desktop calls.
pub const SYNC_COMMAND: &str = "plugin_sync_languages";

/// One plugin language as the desktop sends it.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteLanguage {
    pub plugin: String,
    pub language: LanguageConfig,
    /// Program names of the plugin's granted `process:` capabilities.
    #[serde(default)]
    pub granted: Vec<String>,
}

/// What the server made of a sync.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub languages: usize,
    /// `plugin: program` → the file it starts.
    pub pinned: BTreeMap<String, PathBuf>,
    /// Granted programs not found on this machine's `PATH`.
    pub unresolved: Vec<String>,
    /// Definitions that failed validation (not applied).
    pub rejected: Vec<String>,
}

#[derive(Default, Serialize, Deserialize)]
struct PinsFile {
    /// `plugin\nprocess:program` → the approved file.
    #[serde(default)]
    pins: BTreeMap<String, BinaryGrant>,
}

type PathVar = Arc<dyn Fn() -> Option<std::ffi::OsString> + Send + Sync>;

/// The server's side: an overlay for its language registry, filled by syncs.
pub struct RemotePluginLanguages {
    store: Arc<PluginLanguages>,
    pins: Arc<Mutex<BTreeMap<String, BinaryGrant>>>,
    file: Option<PathBuf>,
    applied: Mutex<Vec<ide_extension::Disposable>>,
    path_var: PathVar,
}

fn key(plugin: &str, cap: &Capability) -> String {
    format!("{plugin}\n{cap}")
}

impl RemotePluginLanguages {
    /// Pins persist in `data_dir` (none: in memory, for tests).
    pub fn new(data_dir: Option<&std::path::Path>) -> Arc<Self> {
        Self::with_path(data_dir, Arc::new(|| std::env::var_os("PATH")))
    }

    pub fn with_path(data_dir: Option<&std::path::Path>, path_var: PathVar) -> Arc<Self> {
        let file = data_dir.map(|d| d.join(PINS_FILE));
        let saved: PinsFile = file
            .as_ref()
            .and_then(|f| std::fs::read_to_string(f).ok())
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        let pins = Arc::new(Mutex::new(saved.pins));
        let store = PluginLanguages::new();
        let policy_pins = pins.clone();
        store.set_process_policy(Arc::new(move |plugin, cap| {
            policy_pins.lock().get(&key(plugin, cap)).map(|b| ProgramPin { path: b.path.clone(), hash: b.hash.clone() })
        }));
        Arc::new(Self { store, pins, file, applied: Mutex::default(), path_var })
    }

    /// For [`ide_language::LanguageRegistry::attach_plugins`].
    pub fn store(&self) -> &Arc<PluginLanguages> {
        &self.store
    }

    /// Replaces every plugin language with `languages`.
    pub fn sync(&self, languages: Vec<RemoteLanguage>) -> SyncReport {
        let mut report = SyncReport::default();
        let mut wanted: BTreeMap<String, (String, Capability)> = BTreeMap::new();
        let mut accepted = Vec::new();
        for l in languages {
            if let Err(e) = validate_definition(&l.language) {
                report.rejected.push(format!("{} ({}): {e}", l.language.id, l.plugin));
                continue;
            }
            for program in &l.granted {
                let cap = Capability::Process(program.clone());
                // Only programs the definition starts: a grant is not a licence for anything else.
                if ide_language::plugin_point::required_capabilities(&l.language).contains(&cap) {
                    wanted.insert(key(&l.plugin, &cap), (program.clone(), cap));
                }
            }
            accepted.push(l);
        }
        {
            let mut pins = self.pins.lock();
            pins.retain(|k, _| wanted.contains_key(k));
            for (k, (program, _)) in &wanted {
                if pins.contains_key(k) {
                    continue;
                }
                let resolved = ledger::resolve_program(program, (self.path_var)().as_deref()).and_then(|path| {
                    ledger::file_hash(&path).map(|hash| BinaryGrant { path, hash }).map_err(|e| e.to_string())
                });
                match resolved {
                    Ok(bin) => {
                        pins.insert(k.clone(), bin);
                    }
                    Err(e) => {
                        tracing::info!("process:{program}: {e}");
                        report.unresolved.push(program.clone());
                    }
                }
            }
            for (k, bin) in pins.iter() {
                report.pinned.insert(k.replace("\nprocess:", ": "), bin.path.clone());
            }
            self.save(&pins);
        }
        let mut applied = self.applied.lock();
        applied.clear(); // disposes the previous sync's languages
        for l in accepted {
            applied.push(self.store.add(l.plugin, l.language));
        }
        report.languages = applied.len();
        self.store.invalidate();
        report
    }

    fn save(&self, pins: &BTreeMap<String, BinaryGrant>) {
        let Some(file) = &self.file else { return };
        let json = serde_json::to_string_pretty(&PinsFile { pins: pins.clone() }).unwrap_or_default();
        let tmp = file.with_extension("json.tmp");
        if let Err(e) = std::fs::write(&tmp, json).and_then(|()| std::fs::rename(&tmp, file)) {
            tracing::warn!("saving {}: {e}", file.display());
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use ide_core::LanguageId;
    use ide_language::LanguageRegistry;
    use std::os::unix::fs::PermissionsExt;

    fn toy(granted: &[&str]) -> RemoteLanguage {
        let language = ide_language::plugin_point::parse_definition(
            "id = \"toy\"\nname = \"Toy\"\nextensions = [\"toy\"]\n\
             [[language-servers]]\nname = \"toylsp\"\ncommand = \"toylsp\"\n",
        )
        .unwrap();
        RemoteLanguage {
            plugin: "acme.toy".into(),
            language,
            granted: granted.iter().map(|s| (*s).to_owned()).collect(),
        }
    }

    #[test]
    fn syncs_languages_and_pins_granted_programs_on_this_machine() {
        let tmp = tempfile::tempdir().unwrap();
        let bin = tmp.path().join("bin");
        std::fs::create_dir(&bin).unwrap();
        std::fs::write(bin.join("toylsp"), "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(bin.join("toylsp"), std::fs::Permissions::from_mode(0o755)).unwrap();
        let path = bin.clone().into_os_string();
        let remote = RemotePluginLanguages::with_path(Some(tmp.path()), Arc::new(move || Some(path.clone())));
        let registry = LanguageRegistry::load(None).unwrap();
        registry.attach_plugins(remote.store().clone());
        let project = registry.fork();
        let id = LanguageId::new("toy");

        // Not granted: the language, no server.
        let report = remote.sync(vec![toy(&[])]);
        assert_eq!(report.languages, 1);
        assert_eq!(project.detect(std::path::Path::new("/r/a.toy"), None), id);
        assert!(project.get(&id).unwrap().language_servers.is_empty());

        // Granted: resolved here and pinned; persisted.
        let report = remote.sync(vec![toy(&["toylsp", "rm"])]);
        assert_eq!(report.pinned.len(), 1, "only programs the definition starts: {report:?}");
        let pin = project.get(&id).unwrap().language_servers[0].pinned.clone().unwrap();
        assert!(pin.verify().is_ok());
        assert!(tmp.path().join(PINS_FILE).is_file());

        // Replaced: refused at start until revoked and granted again.
        std::fs::write(bin.join("toylsp"), "#!/bin/sh\necho x\n").unwrap();
        remote.sync(vec![toy(&["toylsp"])]);
        assert!(project.get(&id).unwrap().language_servers[0].pinned.as_ref().unwrap().verify().is_err());
        remote.sync(vec![toy(&[])]);
        remote.sync(vec![toy(&["toylsp"])]);
        assert!(project.get(&id).unwrap().language_servers[0].pinned.as_ref().unwrap().verify().is_ok());

        // Missing programs are reported; invalid definitions rejected; empty sync removes all.
        let mut bad = toy(&[]);
        bad.language.id = LanguageId::new("a b");
        let report = remote.sync(vec![bad]);
        assert_eq!(report.rejected.len(), 1);
        assert_eq!(project.detect(std::path::Path::new("/r/a.toy"), None), LanguageId::plain_text());
    }
}
