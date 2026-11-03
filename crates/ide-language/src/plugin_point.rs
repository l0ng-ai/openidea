//! The `languages` extension point: language definitions contributed by
//! plugins, in the same format as `languages/<id>.toml`.
//!
//! ```toml
//! [[contributes.languages]]
//! path = "languages/solidity.toml"
//! ```
//!
//! A definition that starts programs (`language-servers.command`,
//! `debugger.command`) needs `process:<program>` for each: a declaration is a
//! capability too, or registering languages would bypass the sandbox.
//! Committed definitions live in [`PluginLanguages`], an overlay over the
//! built-in registry (built-in definitions win on id clashes): see
//! [`crate::LanguageRegistry::attach_plugins`]. A server or debugger whose
//! program is not granted is left out; the language itself still works.

use crate::{LanguageConfig, ProgramPin};
use ide_extension::{Capability, Disposable, ExtensionPoint, Package, Placement, Prepared, decode};
use parking_lot::RwLock;
use serde::Deserialize;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

pub const POINT_ID: &str = "languages";

/// Decides whether a plugin may start a program: the approved file for a
/// granted `process:` capability, or `None`.
pub type ProcessPolicy = dyn Fn(&str, &Capability) -> Option<ProgramPin> + Send + Sync;

/// Languages of enabled plugins, in commit order.
#[derive(Default)]
pub struct PluginLanguages {
    items: RwLock<Vec<(u64, String, LanguageConfig)>>,
    seq: AtomicU64,
    revision: AtomicU64,
    policy: RwLock<Option<Arc<ProcessPolicy>>>,
}

impl PluginLanguages {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn all(&self) -> Vec<LanguageConfig> {
        self.items.read().iter().map(|(_, _, c)| c.clone()).collect()
    }

    /// `(plugin id, definition)` pairs.
    pub fn with_owners(&self) -> Vec<(String, LanguageConfig)> {
        self.items.read().iter().map(|(_, p, c)| (p.clone(), c.clone())).collect()
    }

    /// The plugin that contributes language `id`.
    pub fn owner_of(&self, id: &ide_core::LanguageId) -> Option<String> {
        self.items.read().iter().find(|(_, _, c)| &c.id == id).map(|(_, p, _)| p.clone())
    }

    /// Changes whenever [`effective`](Self::effective) may give something else.
    pub fn revision(&self) -> u64 {
        self.revision.load(Ordering::Acquire)
    }

    /// Who may start what. Without a policy no plugin program starts.
    pub fn set_process_policy(&self, policy: Arc<ProcessPolicy>) {
        *self.policy.write() = Some(policy);
        self.invalidate();
    }

    /// Grants changed: registries recompute [`effective`](Self::effective).
    pub fn invalidate(&self) {
        self.revision.fetch_add(1, Ordering::Release);
    }

    /// The definitions as they take effect: servers and the debugger whose
    /// program is granted are pinned to the approved file, the others are
    /// left out.
    pub fn effective(&self) -> Vec<LanguageConfig> {
        let policy = self.policy.read().clone();
        let pin = |plugin: &str, program: &str| {
            policy.as_ref().and_then(|p| p(plugin, &Capability::Process(program.to_owned())))
        };
        self.items
            .read()
            .iter()
            .map(|(_, plugin, cfg)| {
                let mut cfg = cfg.clone();
                cfg.language_servers.retain_mut(|s| {
                    s.pinned = pin(plugin, &s.command);
                    s.pinned.is_some()
                });
                let debugger_pin = cfg.debugger.as_ref().and_then(|d| pin(plugin, &d.command));
                match (&mut cfg.debugger, debugger_pin) {
                    (Some(d), Some(p)) => d.pinned = Some(p),
                    (debugger, _) => *debugger = None,
                }
                cfg
            })
            .collect()
    }

    /// Adds a definition until the returned handle is dropped.
    pub fn add(self: &Arc<Self>, plugin: String, cfg: LanguageConfig) -> Disposable {
        let seq = self.seq.fetch_add(1, Ordering::Relaxed);
        self.items.write().push((seq, plugin, cfg));
        self.revision.fetch_add(1, Ordering::Release);
        let weak = Arc::downgrade(self);
        Disposable::new(move || {
            if let Some(this) = weak.upgrade() {
                this.items.write().retain(|(s, _, _)| *s != seq);
                this.revision.fetch_add(1, Ordering::Release);
            }
        })
    }
}

pub struct LanguagesPoint {
    store: Arc<PluginLanguages>,
}

impl LanguagesPoint {
    pub fn new(store: Arc<PluginLanguages>) -> Self {
        Self { store }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Decl {
    /// A `languages/<id>.toml`-style file in the package.
    path: Option<PathBuf>,
    /// The same, inline (runtime `register-language`).
    definition: Option<String>,
}

/// Parses and checks one language definition.
pub fn parse_definition(src: &str) -> Result<LanguageConfig, String> {
    let cfg: LanguageConfig = toml::from_str(src).map_err(|e| format!("invalid language definition: {e}"))?;
    validate_definition(&cfg)?;
    Ok(cfg)
}

/// Checks a definition that did not come from a package file (a remote sync).
pub fn validate_definition(cfg: &LanguageConfig) -> Result<(), String> {
    let id = cfg.id.as_str();
    if id.is_empty() || cfg.name.trim().is_empty() {
        return Err("language `id` and `name` must not be empty".into());
    }
    if !id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '+')) || id.len() > 64 {
        return Err(format!("invalid language id {id:?}"));
    }
    if let Some(first) = &cfg.first_line {
        regex_lite::Regex::new(first).map_err(|e| format!("invalid first-line pattern: {e}"))?;
    }
    Ok(())
}

/// The programs a definition starts, as `process:` capabilities.
pub fn required_capabilities(cfg: &LanguageConfig) -> Vec<Capability> {
    let mut caps: Vec<Capability> = Vec::new();
    let servers = cfg.language_servers.iter().map(|s| s.command.as_str());
    for program in servers.chain(cfg.debugger.iter().map(|d| d.command.as_str())) {
        let cap = Capability::Process(program.to_owned());
        if !program.trim().is_empty() && !caps.contains(&cap) {
            caps.push(cap);
        }
    }
    caps
}

impl ExtensionPoint for LanguagesPoint {
    fn id(&self) -> &'static str {
        POINT_ID
    }

    fn placement(&self) -> Placement {
        Placement::Workspace
    }

    fn prepare(&self, pkg: &Package, decl: toml::Value) -> Result<Prepared, String> {
        let decl: Decl = decode(POINT_ID, decl)?;
        let (src, file) = match (decl.path, decl.definition) {
            (Some(path), None) => {
                let src = pkg.read_text(&path)?;
                (src, Some(path))
            }
            (None, Some(def)) => (def, None),
            _ => return Err("give either `path` or `definition`".into()),
        };
        let cfg = parse_definition(&src).map_err(|e| match &file {
            Some(f) => format!("{}: {e}", f.display()),
            None => e,
        })?;
        let caps = required_capabilities(&cfg);
        let (store, plugin, key, label) = (
            self.store.clone(),
            pkg.id().to_owned(),
            cfg.id.to_string(),
            format!("{} (.{})", cfg.name, cfg.extensions.join(", .")),
        );
        let mut prepared = Prepared::new(label, move || Ok(store.add(plugin, cfg))).key(key);
        if let Some(f) = file {
            prepared = prepared.file(f);
        }
        for cap in caps {
            prepared = prepared.capability(cap);
        }
        Ok(prepared)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ide_extension::{ExtensionRegistry, Manifest, Scope};

    #[test]
    fn languages_point_registers_and_requires_process_capabilities() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir(tmp.path().join("l")).unwrap();
        std::fs::write(
            tmp.path().join("l/sol.toml"),
            "id = \"solidity\"\nname = \"Solidity\"\nextensions = [\"sol\"]\n\
             [[language-servers]]\nname = \"solc\"\ncommand = \"solc\"\nargs = [\"--lsp\"]\n",
        )
        .unwrap();
        let src = "id = \"p\"\nname = \"P\"\nversion = \"1.0.0\"\nengines.openidea = \"^1.0\"\n\
                   [[contributes.languages]]\npath = \"l/sol.toml\"";
        let pkg = Package::new(Manifest::parse(src).unwrap(), tmp.path().to_path_buf());
        let store = PluginLanguages::new();
        let reg = ExtensionRegistry::new();
        reg.register(Arc::new(LanguagesPoint::new(store.clone()))).unwrap();
        let set = reg.prepare(&pkg).unwrap();
        assert_eq!(set.capabilities, [Capability::Process("solc".into())]);
        assert_eq!(set.files, [PathBuf::from("l/sol.toml")]);
        reg.commit(set, Scope::Static).unwrap();
        assert_eq!(store.all()[0].id.as_str(), "solidity");
        reg.dispose_plugin("p");
        assert!(store.all().is_empty());

        let bad = |def: &str| {
            let mut t = toml::Table::new();
            t.insert("definition".into(), def.into());
            reg.contribute(&pkg, POINT_ID, toml::Value::Table(t)).unwrap_err()
        };
        assert!(bad("not toml [").contains("invalid language"));
        assert!(bad("id = \"\"\nname = \"x\"").contains("must not be empty"));
        assert!(bad("id = \"a b\"\nname = \"x\"").contains("invalid language id"));
    }

    #[test]
    fn registry_overlay_follows_the_store_and_the_grants() {
        use crate::LanguageRegistry;
        use ide_core::LanguageId;
        use std::path::Path;

        let base = LanguageRegistry::load(None).unwrap();
        let store = PluginLanguages::new();
        base.attach_plugins(store.clone());
        // Projects fork before plugins load: the fork follows the store anyway.
        let project = base.fork();
        assert_eq!(project.detect(Path::new("a.sol"), None), LanguageId::plain_text());

        let sol = parse_definition(
            "id = \"solidity\"\nname = \"Solidity\"\nextensions = [\"sol\"]\n\
             [[language-servers]]\nname = \"solc\"\ncommand = \"solc\"\n\
             [debugger]\nadapter = \"soldbg\"\ncommand = \"soldbg\"\n",
        )
        .unwrap();
        let rust_clash = parse_definition("id = \"rust\"\nname = \"Evil Rust\"\nextensions = [\"rs\"]").unwrap();
        let ext_clash = parse_definition(
            "id = \"rusty\"\nname = \"Rusty\"\nextensions = [\"rs\", \"rsy\"]\nfilenames = [\"Cargo.lock\"]",
        )
        .unwrap();
        let _sol = store.add("acme.sol".into(), sol);
        let _clash = store.add("acme.evil".into(), rust_clash);
        let _ext = store.add("acme.evil".into(), ext_clash);

        assert_eq!(project.detect(Path::new("a.sol"), None).as_str(), "solidity");
        let rust = project.get(&LanguageId::new("rust")).unwrap();
        assert_eq!(rust.name, "Rust", "built-in definitions win on id clashes");
        assert_eq!(project.detect(Path::new("main.rs"), None).as_str(), "rust", "and keep their extensions");
        assert_ne!(project.detect(Path::new("Cargo.lock"), None).as_str(), "rusty", "and file names");
        assert_eq!(project.detect(Path::new("x.rsy"), None).as_str(), "rusty");
        // No policy: the language works, its programs do not start.
        let cfg = project.get(&LanguageId::new("solidity")).unwrap();
        assert!(cfg.language_servers.is_empty() && cfg.debugger.is_none());

        let pin = ProgramPin { path: "/opt/solc".into(), hash: "h".into() };
        let granted = pin.clone();
        store.set_process_policy(Arc::new(move |plugin, cap| {
            (plugin == "acme.sol" && *cap == Capability::Process("solc".into())).then(|| granted.clone())
        }));
        let cfg = project.get(&LanguageId::new("solidity")).unwrap();
        assert_eq!(cfg.language_servers[0].pinned.as_ref(), Some(&pin));
        assert!(cfg.debugger.is_none(), "soldbg was not granted");

        drop(_sol);
        assert_eq!(project.detect(Path::new("a.sol"), None), LanguageId::plain_text());
        assert!(base.get(&LanguageId::new("solidity")).is_none());
    }

    #[test]
    fn program_pins_check_the_file() {
        let tmp = tempfile::tempdir().unwrap();
        let bin = tmp.path().join("tool");
        std::fs::write(&bin, "v1").unwrap();
        let pin = ProgramPin { path: bin.clone(), hash: ide_extension::ledger::file_hash(&bin).unwrap() };
        assert_eq!(pin.verify().unwrap(), bin);
        std::fs::write(&bin, "v2").unwrap();
        assert!(pin.verify().unwrap_err().contains("changed since it was approved"));
    }
}
