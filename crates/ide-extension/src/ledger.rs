//! The grant ledger (plan 4.6): which capabilities the user granted to which
//! plugin, saved as `grants.json` next to the installed plugins.
//!
//! - Installed plugins are keyed by id and remember the version and package
//!   hash they were confirmed for. An update that needs no new capability is
//!   accepted silently; one that does must be confirmed again.
//! - Linked development plugins and project plugins (`.openidea/plugins/*`)
//!   are keyed by their directory, not by hash, so rebuilding does not ask
//!   again; new capabilities still do.
//! - `process:<program>` grants record the program's absolute path and file
//!   hash at grant time. Calls use that path, never a `PATH` lookup, and fail
//!   when the file changed (re-confirmation needed).

use crate::capability::{Capability, Risk};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::ffi::OsStr;
use std::path::{Path, PathBuf};

pub const LEDGER_FILE: &str = "grants.json";
const FORMAT: u32 = 1;

/// Whose grant an entry is.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "camelCase")]
pub enum Subject {
    /// Installed under the plugins directory, by plugin id.
    Installed(String),
    /// A linked development plugin or a project plugin, by package directory.
    Path(PathBuf),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BinaryGrant {
    pub path: PathBuf,
    /// blake3 of the file when granted.
    pub hash: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Grant {
    pub plugin_id: String,
    /// The version and package hash the user confirmed (installed plugins).
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub package_hash: String,
    /// The user confirmed the plugin (the install page or the project-plugin prompt).
    #[serde(default)]
    pub confirmed: bool,
    /// Granted capabilities (`project.read`, `net:x`, …).
    #[serde(default)]
    pub granted: BTreeSet<String>,
    /// Optional capabilities the user declined (not asked again until re-confirmed).
    #[serde(default)]
    pub declined: BTreeSet<String>,
    /// `process:<program>` → the program confirmed for it.
    #[serde(default)]
    pub binaries: BTreeMap<String, BinaryGrant>,
    /// Migrated from 0.1: capabilities not granted yet are asked for on first
    /// use instead of blocking the plugin from loading.
    #[serde(default)]
    pub ask_on_use: bool,
}

impl Grant {
    pub fn has(&self, cap: &Capability) -> bool {
        self.granted.iter().filter_map(|s| s.parse::<Capability>().ok()).any(|g| g.covers(cap))
    }
}

/// What a plugin (in its current form) needs, to compare with its grant.
#[derive(Clone, Debug)]
pub struct Request<'a> {
    pub subject: Subject,
    pub plugin_id: &'a str,
    pub version: &'a str,
    pub package_hash: &'a str,
    pub required: Vec<Capability>,
    pub optional: Vec<Capability>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Decision {
    /// Load with these capabilities. `pending` required ones are asked for when
    /// the plugin is first used (plugins migrated from 0.1 only).
    Allowed { granted: Vec<Capability>, pending: Vec<Capability> },
    /// Ask the user first. `new` lists what was never granted (all of it on first use).
    NeedsConfirmation { new: Vec<Capability>, first_time: bool },
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct File {
    #[serde(default)]
    format: u32,
    /// The one-time migration from 0.1 ("declared means granted") ran.
    #[serde(default)]
    migrated: bool,
    #[serde(default)]
    grants: Vec<(Subject, Grant)>,
}

/// The ledger, loaded into memory; [`Ledger::save`] writes it atomically.
#[derive(Debug, Default)]
pub struct Ledger {
    path: Option<PathBuf>,
    migrated: bool,
    grants: BTreeMap<Subject, Grant>,
}

impl Ledger {
    /// Loads `<dir>/grants.json`; a missing or unreadable file gives an empty
    /// ledger with `needs_migration()` true.
    pub fn load(dir: &Path) -> Self {
        let path = dir.join(LEDGER_FILE);
        let file: Option<File> = std::fs::read_to_string(&path).ok().and_then(|s| match serde_json::from_str(&s) {
            Ok(f) => Some(f),
            Err(e) => {
                tracing::warn!("{}: {e}; starting with an empty grant ledger", path.display());
                None
            }
        });
        let existed = file.is_some();
        let file = file.unwrap_or_default();
        Self { path: Some(path), migrated: file.migrated || existed, grants: file.grants.into_iter().collect() }
    }

    pub fn in_memory() -> Self {
        Self { path: None, migrated: true, grants: BTreeMap::new() }
    }

    pub fn save(&self) -> std::io::Result<()> {
        let Some(path) = &self.path else { return Ok(()) };
        let file = File {
            format: FORMAT,
            migrated: self.migrated,
            grants: self.grants.iter().map(|(s, g)| (s.clone(), g.clone())).collect(),
        };
        let json = serde_json::to_string_pretty(&file).map_err(std::io::Error::other)?;
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, json)?;
        std::fs::rename(&tmp, path)
    }

    pub fn get(&self, subject: &Subject) -> Option<&Grant> {
        self.grants.get(subject)
    }

    pub fn remove(&mut self, subject: &Subject) -> Option<Grant> {
        self.grants.remove(subject)
    }

    /// Puts back an earlier state of `subject`'s grant (`None`: none), e.g.
    /// after rolling back an update.
    pub fn restore(&mut self, subject: &Subject, grant: Option<Grant>) {
        match grant {
            Some(g) => {
                self.grants.insert(subject.clone(), g);
            }
            None => {
                self.grants.remove(subject);
            }
        }
    }

    /// The one-time migration of 0.1's "declared means granted" has not run yet.
    pub fn needs_migration(&self) -> bool {
        !self.migrated
    }

    /// Migrates plugins installed before the ledger existed: low-risk
    /// capabilities are granted, the rest are asked on first use.
    pub fn migrate(&mut self, installed: &[Request<'_>]) {
        for req in installed {
            let granted: BTreeSet<String> =
                req.required.iter().chain(&req.optional).filter(|c| c.auto_migrates()).map(|c| c.to_string()).collect();
            self.grants.entry(req.subject.clone()).or_insert_with(|| Grant {
                plugin_id: req.plugin_id.to_owned(),
                version: req.version.to_owned(),
                package_hash: req.package_hash.to_owned(),
                confirmed: true,
                granted,
                ask_on_use: true,
                ..Grant::default()
            });
        }
        self.migrated = true;
    }

    /// Compares what the plugin needs with what was granted.
    pub fn decide(&mut self, req: &Request<'_>) -> Decision {
        let Some(grant) = self.grants.get_mut(&req.subject) else {
            return Decision::NeedsConfirmation { new: req.required.clone(), first_time: true };
        };
        if !grant.confirmed {
            return Decision::NeedsConfirmation { new: req.required.clone(), first_time: true };
        }
        let new: Vec<Capability> = req.required.iter().filter(|c| !grant.has(c)).cloned().collect();
        if !new.is_empty() && !grant.ask_on_use {
            return Decision::NeedsConfirmation { new, first_time: false };
        }
        // Same or fewer needs: accept an update silently (plan 4.6).
        if grant.version != req.version || grant.package_hash != req.package_hash {
            grant.version = req.version.to_owned();
            grant.package_hash = req.package_hash.to_owned();
        }
        let granted = req.required.iter().chain(&req.optional).filter(|c| grant.has(c)).cloned().collect();
        Decision::Allowed { granted, pending: new }
    }

    /// Records the user's confirmation: `required` plus the accepted optional capabilities.
    pub fn confirm(
        &mut self,
        req: &Request<'_>,
        accepted_optional: &[Capability],
        binaries: BTreeMap<String, BinaryGrant>,
    ) {
        let grant = self.grants.entry(req.subject.clone()).or_default();
        grant.plugin_id = req.plugin_id.to_owned();
        grant.version = req.version.to_owned();
        grant.package_hash = req.package_hash.to_owned();
        grant.confirmed = true;
        grant.ask_on_use = false;
        for cap in req.required.iter().chain(accepted_optional) {
            grant.granted.insert(cap.to_string());
        }
        for cap in &req.optional {
            let s = cap.to_string();
            if accepted_optional.contains(cap) {
                grant.declined.remove(&s);
            } else if !grant.granted.contains(&s) {
                grant.declined.insert(s);
            }
        }
        grant.binaries.extend(binaries);
    }

    /// Grants or revokes one capability (Settings › Plugins › permissions).
    pub fn set(&mut self, subject: &Subject, cap: &Capability, granted: bool) -> bool {
        let Some(grant) = self.grants.get_mut(subject) else { return false };
        let s = cap.to_string();
        if granted {
            grant.declined.remove(&s);
            grant.granted.insert(s)
        } else {
            if let Capability::Process(_) = cap {
                grant.binaries.remove(&s);
            }
            grant.granted.remove(&s)
        }
    }

    /// Records the program approved for a `process:` grant.
    pub fn set_binary(&mut self, subject: &Subject, cap: &Capability, binary: BinaryGrant) {
        if let Some(grant) = self.grants.get_mut(subject) {
            grant.binaries.insert(cap.to_string(), binary);
        }
    }

    /// Checks a `process:` grant at call time: the program confirmed for it,
    /// unchanged since. Errors name what to do.
    pub fn check_binary(&self, subject: &Subject, cap: &Capability) -> Result<PathBuf, String> {
        let Capability::Process(name) = cap else { return Err(format!("{cap} is not a process capability")) };
        let grant = self.grants.get(subject).ok_or_else(|| format!("{cap} was not granted"))?;
        let key = cap.to_string();
        if !grant.granted.contains(&key) {
            return Err(format!("{cap} was not granted"));
        }
        let bin = grant.binaries.get(&key).ok_or_else(|| format!("{cap}: no program was confirmed for {name}"))?;
        match file_hash(&bin.path) {
            Ok(hash) if hash == bin.hash => Ok(bin.path.clone()),
            Ok(_) => Err(format!(
                "{} changed since it was approved for {cap}; confirm the plugin's permissions again",
                bin.path.display()
            )),
            Err(e) => Err(format!("{}: {e}; confirm the plugin's permissions again", bin.path.display())),
        }
    }

    /// The program approved for a granted `process:` capability, without
    /// checking the file: whoever starts it verifies the hash then
    /// ([`check_binary`](Self::check_binary) or the pin's own check).
    pub fn pinned_binary(&self, subject: &Subject, cap: &Capability) -> Option<BinaryGrant> {
        let grant = self.grants.get(subject)?;
        let key = cap.to_string();
        if !grant.granted.contains(&key) {
            return None;
        }
        grant.binaries.get(&key).cloned()
    }

    pub fn subjects(&self) -> impl Iterator<Item = (&Subject, &Grant)> {
        self.grants.iter()
    }
}

/// What a confirmation page shows: every capability with its risk, high risk first.
pub fn by_risk(caps: &[Capability]) -> Vec<(Risk, Vec<Capability>)> {
    let mut groups: BTreeMap<std::cmp::Reverse<Risk>, Vec<Capability>> = BTreeMap::new();
    for c in caps {
        groups.entry(std::cmp::Reverse(c.risk())).or_default().push(c.clone());
    }
    groups.into_iter().map(|(r, v)| (r.0, v)).collect()
}

/// Resolves a `process:` program to an absolute path once, at grant time:
/// absolute names are taken as is, others are looked up in `path_var`. The
/// found path is kept as found: version-manager shims such as rustup dispatch
/// on `argv[0]`, so dereferencing `cargo` to the `rustup` file it points at
/// makes the program run as rustup. The content hash still pins the bytes.
pub fn resolve_program(name: &str, path_var: Option<&OsStr>) -> Result<PathBuf, String> {
    let candidate = Path::new(name);
    if candidate.is_absolute() {
        return if candidate.is_file() { Ok(candidate.to_path_buf()) } else { Err(format!("{name}: no such program")) };
    }
    let exts: Vec<String> = if cfg!(windows) {
        std::env::var("PATHEXT").unwrap_or_else(|_| ".EXE;.CMD;.BAT".into()).split(';').map(str::to_owned).collect()
    } else {
        vec![String::new()]
    };
    for dir in std::env::split_paths(path_var.unwrap_or_default()) {
        if !dir.is_absolute() {
            continue; // `.` or relative entries could point into the project
        }
        for ext in &exts {
            let p = dir.join(format!("{name}{ext}"));
            if is_executable(&p) {
                return Ok(p);
            }
        }
    }
    Err(format!("{name} was not found on PATH"))
}

fn is_executable(p: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(p) else { return false };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    true
}

/// blake3 of a file, hex.
pub fn file_hash(path: &Path) -> std::io::Result<String> {
    let mut hasher = blake3::Hasher::new();
    hasher.update_reader(std::fs::File::open(path)?)?;
    Ok(hasher.finalize().to_hex().to_string())
}

/// blake3 over a package's files (sorted relative paths and contents).
pub fn package_hash(dir: &Path, files: &[PathBuf]) -> std::io::Result<String> {
    let mut sorted: Vec<&PathBuf> = files.iter().collect();
    sorted.sort();
    sorted.dedup();
    let mut hasher = blake3::Hasher::new();
    for rel in sorted {
        hasher.update(hashed_path(rel).as_bytes());
        hasher.update(&[0]);
        hasher.update_reader(std::fs::File::open(dir.join(rel))?)?;
        hasher.update(&[0]);
    }
    Ok(hasher.finalize().to_hex().to_string())
}

/// A package-relative path as hashed: `/`-separated on every OS, so a package has one digest
/// (a walked `web\index.html` on Windows is `web/index.html` everywhere else).
fn hashed_path(rel: &Path) -> String {
    rel.components().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn caps(list: &[&str]) -> Vec<Capability> {
        list.iter().map(|s| s.parse().unwrap()).collect()
    }

    fn req<'a>(version: &'a str, hash: &'a str, required: &[&str], optional: &[&str]) -> Request<'a> {
        Request {
            subject: Subject::Installed("p".into()),
            plugin_id: "p",
            version,
            package_hash: hash,
            required: caps(required),
            optional: caps(optional),
        }
    }

    #[test]
    fn confirmation_then_silent_update_then_reconfirm_on_new_capability() {
        let mut l = Ledger::in_memory();
        let r1 = req("1.0.0", "h1", &["project.read"], &["net:crates.io"]);
        assert_eq!(l.decide(&r1), Decision::NeedsConfirmation { new: caps(&["project.read"]), first_time: true });
        l.confirm(&r1, &[], BTreeMap::new());
        assert_eq!(
            l.decide(&r1),
            Decision::Allowed { granted: caps(&["project.read"]), pending: vec![] },
            "declined optional"
        );
        assert!(l.get(&r1.subject).unwrap().declined.contains("net:crates.io"));

        // Same needs, new version: silent.
        let r2 = req("1.1.0", "h2", &["project.read"], &["net:crates.io"]);
        assert!(matches!(l.decide(&r2), Decision::Allowed { .. }));
        assert_eq!(l.get(&r2.subject).unwrap().version, "1.1.0");

        // A new required capability: ask again, only for it.
        let r3 = req("1.2.0", "h3", &["project.read", "editor.write"], &[]);
        assert_eq!(l.decide(&r3), Decision::NeedsConfirmation { new: caps(&["editor.write"]), first_time: false });
        l.confirm(&r3, &[], BTreeMap::new());
        assert!(matches!(l.decide(&r3), Decision::Allowed { .. }));

        // Revoking a required capability blocks loading again.
        assert!(l.set(&r3.subject, &Capability::EditorWrite, false));
        assert!(matches!(l.decide(&r3), Decision::NeedsConfirmation { .. }));
    }

    #[test]
    fn migration_grants_low_risk_only() {
        let tmp = tempfile::tempdir().unwrap();
        let mut l = Ledger::load(tmp.path());
        assert!(l.needs_migration());
        let r = req("0.1.0", "h", &["project.read", "editor.write"], &[]);
        l.migrate(std::slice::from_ref(&r));
        // Loads with the low-risk part; the rest is asked for on first use.
        assert_eq!(
            l.decide(&r),
            Decision::Allowed { granted: caps(&["project.read"]), pending: caps(&["editor.write"]) }
        );
        l.confirm(&r, &[], BTreeMap::new());
        assert_eq!(
            l.decide(&r),
            Decision::Allowed { granted: caps(&["project.read", "editor.write"]), pending: vec![] }
        );
        l.save().unwrap();
        let again = Ledger::load(tmp.path());
        assert!(!again.needs_migration());
        assert!(again.get(&r.subject).unwrap().has(&Capability::ProjectRead));
    }

    #[cfg(unix)]
    #[test]
    fn binaries_are_pinned_by_path_and_hash() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let bin_dir = tmp.path().join("bin");
        std::fs::create_dir(&bin_dir).unwrap();
        let tool = bin_dir.join("tool");
        std::fs::write(&tool, "#!/bin/sh\necho v1\n").unwrap();
        std::fs::set_permissions(&tool, std::fs::Permissions::from_mode(0o755)).unwrap();
        let path_var = std::env::join_paths([PathBuf::from("relative"), bin_dir.clone()]).unwrap();
        let resolved = resolve_program("tool", Some(&path_var)).unwrap();
        assert!(resolved.is_absolute());
        assert!(resolve_program("missing", Some(&path_var)).is_err());

        let mut l = Ledger::in_memory();
        let r = req("1.0.0", "h", &["process:tool"], &[]);
        let cap: Capability = "process:tool".parse().unwrap();
        let bin = BinaryGrant { path: resolved.clone(), hash: file_hash(&resolved).unwrap() };
        l.confirm(&r, &[], [(cap.to_string(), bin)].into());
        assert_eq!(l.check_binary(&r.subject, &cap).unwrap(), resolved);
        std::fs::write(&tool, "#!/bin/sh\necho evil\n").unwrap();
        assert!(l.check_binary(&r.subject, &cap).unwrap_err().contains("changed"));
    }

    #[cfg(unix)]
    #[test]
    fn keeps_the_shim_name_when_resolving() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let bin_dir = tmp.path().join("bin");
        std::fs::create_dir(&bin_dir).unwrap();
        let rustup = bin_dir.join("rustup");
        std::fs::write(&rustup, "#!/bin/sh\nexit 0\n").unwrap();
        std::fs::set_permissions(&rustup, std::fs::Permissions::from_mode(0o755)).unwrap();
        let cargo = bin_dir.join("cargo");
        std::os::unix::fs::symlink(&rustup, &cargo).unwrap();
        let path_var = std::env::join_paths([bin_dir]).unwrap();
        // rustup picks the tool from argv[0]: resolving the shim to the rustup
        // file would run cargo's arguments as rustup's.
        assert_eq!(resolve_program("cargo", Some(&path_var)).unwrap(), cargo);
    }

    #[test]
    fn hashes_and_grouping() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("a"), "1").unwrap();
        std::fs::write(tmp.path().join("b"), "2").unwrap();
        let h1 = package_hash(tmp.path(), &["a".into(), "b".into()]).unwrap();
        assert_eq!(h1, package_hash(tmp.path(), &["b".into(), "a".into()]).unwrap());
        std::fs::write(tmp.path().join("b"), "3").unwrap();
        assert_ne!(h1, package_hash(tmp.path(), &["a".into(), "b".into()]).unwrap());
        let groups = by_risk(&caps(&["storage", "process:git", "net:x.io"]));
        assert_eq!(groups.iter().map(|g| g.0).collect::<Vec<_>>(), [Risk::High, Risk::Medium, Risk::Low]);
    }

    #[test]
    fn hashes_paths_with_forward_slashes_on_every_os() {
        assert_eq!(hashed_path(Path::new("web/index.html")), "web/index.html");
        assert_eq!(hashed_path(Path::new("plugin.wasm")), "plugin.wasm");
        #[cfg(windows)]
        assert_eq!(hashed_path(Path::new(r"web\index.html")), "web/index.html");
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir(tmp.path().join("web")).unwrap();
        std::fs::write(tmp.path().join("web").join("index.html"), "<p>").unwrap();
        // A walked path (native separators) hashes like the manifest's `/` spelling.
        assert_eq!(
            package_hash(tmp.path(), &[Path::new("web").join("index.html")]).unwrap(),
            package_hash(tmp.path(), &["web/index.html".into()]).unwrap()
        );
    }
}
