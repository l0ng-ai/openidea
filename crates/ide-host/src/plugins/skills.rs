//! The `skills` extension point (API 1.15): declarative `SKILL.md` folders inside a
//! plugin package (`[[contributes.skills]]`), discovered directly from live plugins'
//! package directories and staged into agent sessions through [`ide_agent::skills`].
//!
//! ```toml
//! [[contributes.skills]]
//! path = "skills/release-notes/SKILL.md"
//! ```
//!
//! Invalid entries emit a plugin load warning (`Prepared::skipped`) rather than failing
//! the whole plugin; `engines.openidea` compatibility (`^1.15`) remains a manifest check.

use super::PluginHost;
use ide_extension::{Disposable, ExtensionPoint, Package, Placement, Prepared, decode};
use parking_lot::RwLock;
use serde::Deserialize;
use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

pub const POINT_ID: &str = "skills";
/// Maximum total size of all files inside one contributed skill folder (2 MiB).
pub const MAX_SKILL_DIR_BYTES: u64 = 2 << 20;
const MAX_SKILL_FILES: usize = 256;
const MAX_SKILL_DEPTH: usize = 16;

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Decl {
    path: PathBuf,
}

#[derive(Clone, Debug)]
struct ContributedSkill {
    plugin_id: String,
    name: String,
    /// Package-relative directory holding `SKILL.md` (e.g. `skills/release-notes`).
    rel_dir: PathBuf,
}

/// Contributed skills of loaded plugins.
#[derive(Default)]
pub struct PluginSkills {
    items: RwLock<Vec<(u64, ContributedSkill)>>,
    seq: AtomicU64,
    revision: AtomicU64,
}

impl PluginSkills {
    pub fn revision(&self) -> u64 {
        self.revision.load(Ordering::Acquire)
    }

    fn add(self: &Arc<Self>, item: ContributedSkill) -> Disposable {
        let seq = self.seq.fetch_add(1, Ordering::Relaxed);
        self.items.write().push((seq, item));
        self.revision.fetch_add(1, Ordering::AcqRel);
        let weak = Arc::downgrade(self);
        Disposable::new(move || {
            if let Some(this) = weak.upgrade() {
                this.items.write().retain(|(s, _)| *s != seq);
                this.revision.fetch_add(1, Ordering::AcqRel);
            }
        })
    }
}

pub struct SkillsPoint {
    store: Arc<PluginSkills>,
}

impl SkillsPoint {
    pub fn new(store: Arc<PluginSkills>) -> Self {
        Self { store }
    }
}

impl ExtensionPoint for SkillsPoint {
    fn id(&self) -> &'static str {
        POINT_ID
    }

    fn placement(&self) -> Placement {
        Placement::Workspace
    }

    fn prepare(&self, pkg: &Package, decl: toml::Value) -> Result<Prepared, String> {
        pkg.manifest.needs_api("contributes.skills", 15)?;
        match self.prepare_entry(pkg, decl) {
            Ok(prepared) => Ok(prepared),
            Err(warning) => Ok(Prepared::skipped(warning)),
        }
    }
}

impl SkillsPoint {
    fn prepare_entry(&self, pkg: &Package, decl: toml::Value) -> Result<Prepared, String> {
        let d: Decl = decode(POINT_ID, decl)?;
        if d.path.as_os_str().is_empty() || !d.path.components().all(|c| matches!(c, Component::Normal(_))) {
            return Err(format!("{}: `path` must be a relative path inside the plugin", d.path.display()));
        }
        if d.path.file_name().and_then(|n| n.to_str()) != Some("SKILL.md") {
            return Err(format!("{}: must point to `<dir>/SKILL.md`", d.path.display()));
        }
        let Some(rel_dir) = d.path.parent().filter(|p| !p.as_os_str().is_empty()) else {
            return Err(format!("{}: must live inside a `<name>/SKILL.md` folder", d.path.display()));
        };
        let Some(folder) = rel_dir.file_name().and_then(|n| n.to_str()) else {
            return Err(format!("{}: invalid skill folder name", d.path.display()));
        };

        // Reject duplicate skill folder names across distinct paths in the same plugin.
        for other in pkg.manifest.declarations(POINT_ID) {
            let Some(other_path) = other.get("path").and_then(|v| v.as_str()).map(Path::new) else { continue };
            if other_path == d.path {
                break;
            }
            if other_path.file_name().and_then(|n| n.to_str()) == Some("SKILL.md")
                && other_path.parent().and_then(|p| p.file_name()).and_then(|n| n.to_str()) == Some(folder)
            {
                return Err(format!("duplicate skill `{folder}` in plugin"));
            }
        }

        let pkg_root = pkg.dir.canonicalize().map_err(|e| format!("plugin directory: {e}"))?;
        let abs_dir = pkg.resolve(rel_dir)?;
        if !abs_dir.is_dir() {
            return Err(format!("{}: not a directory", rel_dir.display()));
        }
        let _ = pkg.resolve(&d.path)?;

        let mut files = Vec::new();
        let mut total_bytes = 0u64;
        let mut visited_dirs = HashSet::new();
        visited_dirs.insert(abs_dir.clone());
        collect_skill_files(
            &pkg_root,
            &pkg.dir.join(rel_dir),
            rel_dir,
            0,
            &mut visited_dirs,
            &mut files,
            &mut total_bytes,
            folder,
        )?;
        files.sort();

        let text = pkg.read_text(&d.path)?;
        ide_agent::skills::validate_plugin_skill(&abs_dir, folder, &text)
            .map_err(|e| format!("{}: {e}", d.path.display()))?;

        let label = format!("/{folder}");
        let key = folder.to_owned();
        let item = ContributedSkill {
            plugin_id: pkg.id().to_owned(),
            name: folder.to_owned(),
            rel_dir: rel_dir.to_path_buf(),
        };
        let store = self.store.clone();
        let mut prepared = Prepared::new(label, move || Ok(store.add(item))).key(key);
        prepared.files = files;
        Ok(prepared)
    }
}

#[allow(clippy::too_many_arguments)]
fn collect_skill_files(
    pkg_root: &Path,
    abs_dir: &Path,
    rel_dir: &Path,
    depth: usize,
    visited_dirs: &mut HashSet<PathBuf>,
    files: &mut Vec<PathBuf>,
    total_bytes: &mut u64,
    skill_name: &str,
) -> Result<(), String> {
    if depth > MAX_SKILL_DEPTH {
        return Err(format!("{}: directory nesting exceeds {MAX_SKILL_DEPTH} levels", rel_dir.display()));
    }
    let entries = std::fs::read_dir(abs_dir).map_err(|e| format!("{}: {e}", rel_dir.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("{}: {e}", rel_dir.display()))?;
        let name = entry.file_name();
        let entry_abs = entry.path();
        let entry_rel = rel_dir.join(&name);
        let sym_meta = std::fs::symlink_metadata(&entry_abs).map_err(|e| format!("{}: {e}", entry_rel.display()))?;
        let canon = entry_abs
            .canonicalize()
            .map_err(|_| format!("{}: broken symlink or unreadable entry", entry_rel.display()))?;
        if !canon.starts_with(pkg_root) {
            return Err(format!("{}: points outside the plugin", entry_rel.display()));
        }
        let meta = if sym_meta.file_type().is_symlink() {
            std::fs::metadata(&entry_abs).map_err(|e| format!("{}: {e}", entry_rel.display()))?
        } else {
            sym_meta
        };
        if meta.is_dir() {
            if !visited_dirs.insert(canon.clone()) {
                return Err(format!("{}: cyclic directory link", entry_rel.display()));
            }
            collect_skill_files(
                pkg_root,
                &entry_abs,
                &entry_rel,
                depth + 1,
                visited_dirs,
                files,
                total_bytes,
                skill_name,
            )?;
            visited_dirs.remove(&canon);
        } else if meta.is_file() {
            if files.len() >= MAX_SKILL_FILES {
                return Err(format!("skill `{skill_name}` exceeds {MAX_SKILL_FILES} files"));
            }
            *total_bytes = total_bytes.saturating_add(meta.len());
            if *total_bytes > MAX_SKILL_DIR_BYTES {
                return Err(format!("skill `{skill_name}` exceeds {} MiB", MAX_SKILL_DIR_BYTES >> 20));
            }
            files.push(entry_rel);
        } else {
            return Err(format!("{}: unsupported file type in skill folder", entry_rel.display()));
        }
    }
    Ok(())
}

impl PluginHost {
    /// Skill directories (`<plugin_dir>/<rel_dir>`) contributed by live plugins for `root`.
    /// Project-local `.openidea/plugins/` packages only apply to their own trusted project.
    pub fn skill_dirs(&self, root: Option<&Path>, workspace_trusted: bool) -> Vec<PathBuf> {
        let mut entries: Vec<(String, String, PathBuf)> = Vec::new();
        for (_, item) in self.skills.items.read().iter() {
            let Ok(plugin) = self.get(&item.plugin_id) else { continue };
            if !plugin.status().is_live() {
                continue;
            }
            if let Some(dev_root) = plugin.dev_root.as_deref()
                && (!workspace_trusted || root != Some(dev_root))
            {
                continue;
            }
            entries.push((item.plugin_id.clone(), item.name.clone(), plugin.dir().join(&item.rel_dir)));
        }
        entries.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
        entries.into_iter().map(|(_, _, path)| path).collect()
    }
}
