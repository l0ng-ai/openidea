//! Filesystem operations for assets under a Unity project's Assets directory.
//! Metadata moves with the asset; duplication gets new GUIDs before publication.

use crate::{file_moves::FileMove, file_ops::execute_moves};
use ide_core::{IdeError, IdeResult, error::ErrorKind};
use std::{
    collections::HashMap,
    fs,
    path::{Component, Path, PathBuf},
};

mod duplicate;
mod workspace_edit;
pub(crate) use workspace_edit::{expand_workspace_edit, validate_workspace_edit_paths};
#[cfg(test)]
mod tests;

pub fn meta_path(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(".meta");
    name.into()
}

/// Includes Assets itself so callers can protect the asset root.
pub fn project_root(path: &Path) -> Option<PathBuf> {
    path.ancestors().find_map(|p| {
        (p.file_name().is_some_and(|n| if cfg!(windows) { n.eq_ignore_ascii_case("Assets") } else { n == "Assets" })
            && p.parent().is_some_and(super::is_project))
        .then(|| p.parent().unwrap().to_path_buf())
    })
}

fn exists(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok()
}

fn is_meta(path: &Path) -> bool {
    path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("meta"))
}

fn validate_asset(path: &Path) -> IdeResult<()> {
    if let Some(root) = project_root(path) {
        if key(path) == key(&root.join("Assets")) {
            return Err(IdeError::invalid("The Unity Assets root cannot be moved, copied or deleted"));
        }
        if is_meta(path) && exists(&path.with_extension("")) {
            return Err(IdeError::invalid(
                "Select the Unity asset instead of its .meta file; metadata is handled together",
            ));
        }
    }
    no_links(path)
}

fn no_links(path: &Path) -> IdeResult<()> {
    if path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(IdeError::invalid("Unity asset operations require paths without '..'"));
    }
    // Trust the opened project's location, including a linked root or parent
    // (macOS /var and /tmp). Check inside it, including Library staging paths.
    // The outermost root prevents a nested Unity project from hiding a link.
    let root = path.ancestors().filter(|p| super::is_project(p)).last();
    for p in path.ancestors().take_while(|p| Some(*p) != root) {
        match fs::symlink_metadata(p) {
            Ok(m) if is_link(&m) => {
                return Err(IdeError::invalid(format!("Unity asset operations do not follow links: {}", p.display())));
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
    }
    Ok(())
}

fn is_link(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        // Also reject directory junctions and other reparse points.
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

fn key(path: &Path) -> String {
    let s = path.to_string_lossy().replace('\\', "/");
    if cfg!(windows) { s.to_lowercase() } else { s }
}

fn vacant(from: &Path, to: &Path) -> IdeResult<()> {
    if exists(to) {
        if !exists(from) {
            return Err(IdeError::new(ErrorKind::AlreadyExists, format!("{} already exists", to.display())));
        }
        ide_vfs::validate_rename(from, to)?;
    }
    Ok(())
}

/// Expand before applying reference edits, so orphan metadata conflicts cannot
/// leave a partially refactored asset. Metadata goes first on publication.
pub fn expand_moves(moves: &[FileMove]) -> IdeResult<Vec<FileMove>> {
    let mut out = Vec::new();
    for m in moves {
        let unity = project_root(&m.from).is_some() || project_root(&m.to).is_some();
        if unity {
            // A caller may explicitly select both an asset and its metadata.
            if is_meta(&m.from)
                && moves
                    .iter()
                    .any(|a| meta_path(&a.from) == m.from.to_path_buf() && meta_path(&a.to) == m.to.to_path_buf())
            {
                continue;
            }
            validate_asset(&m.from)?;
            validate_asset(&m.to)?;
            let from = meta_path(&m.from);
            let to = meta_path(&m.to);
            no_links(&from)?;
            no_links(&to)?;
            vacant(&from, &to)?;
            if exists(&from) {
                out.push(FileMove { from: from.into(), to: to.into() });
            }
        }
        out.push(m.clone());
    }
    Ok(out)
}

pub(crate) fn move_one(from: &Path, to: &Path) -> IdeResult<()> {
    if project_root(from).is_some() || project_root(to).is_some() {
        no_links(from)?;
        no_links(to)?;
        if let Some(parent) = to.parent() {
            fs::create_dir_all(parent)?;
        }
        // A failed cross-volume copy/delete cannot be rolled back reliably.
        // Keep paired Unity moves atomic per entry and let rename report it.
        fs::rename(from, to)?;
        Ok(())
    } else {
        ide_vfs::rename(from, to)
    }
}

/// The paths Local History must snapshot before an asset deletion.
pub fn deletion_paths(path: &Path) -> IdeResult<Vec<PathBuf>> {
    validate_asset(path)?;
    let meta = meta_path(path);
    no_links(&meta)?;
    let mut paths = vec![path.to_path_buf()];
    if exists(&meta) {
        paths.push(meta);
    }
    Ok(paths)
}

fn staging(root: &Path) -> IdeResult<PathBuf> {
    let parent = root.join("Library/OpenIDEA/AssetOperations");
    no_links(&parent)?;
    fs::create_dir_all(&parent)?;
    let dir = parent.join(uuid::Uuid::new_v4().simple().to_string());
    fs::create_dir(&dir)?;
    Ok(dir)
}

pub fn delete(path: &Path) -> IdeResult<()> {
    delete_with(path, &ide_vfs::delete)
}

fn delete_with(path: &Path, remove: &dyn Fn(&Path) -> IdeResult<()>) -> IdeResult<()> {
    let paths = deletion_paths(path)?;
    let root = project_root(path).ok_or_else(|| IdeError::invalid("Expected a Unity asset path"))?;
    let stage = staging(&root)?;
    let payload = stage.join("files");
    fs::create_dir(&payload)?;
    let moves: Vec<_> = paths
        .iter()
        .map(|p| FileMove { from: p.clone().into(), to: payload.join(p.file_name().unwrap()).into() })
        .collect();
    // Recycle-bin restore returns the group to staging. Keep its destinations
    // with it so originals can also be recovered without the IDE's history.
    let manifest = stage.join("restore-paths.json");
    fs::write(&manifest, serde_json::to_vec_pretty(&paths).map_err(|e| IdeError::internal(e.to_string()))?)?;
    // Never automatically delete this staging directory on failure: it may
    // contain originals when rollback fails.
    if let Err(e) = execute_moves(&moves, &move_one) {
        if fs::remove_dir(&payload).is_ok() {
            let _ = fs::remove_file(&manifest);
            let _ = fs::remove_dir(&stage);
        }
        return Err(e);
    }
    if let Err(mut e) = remove(&stage) {
        let back: Vec<_> = moves.iter().rev().map(|m| FileMove { from: m.to.clone(), to: m.from.clone() }).collect();
        if let Err(rollback) = execute_moves(&back, &move_one) {
            e.message.push_str(&format!("; recovery files at {}: {rollback}", stage.display()));
        }
        if fs::remove_dir(&payload).is_ok() {
            let _ = fs::remove_file(&manifest);
            let _ = fs::remove_dir(&stage);
        }
        return Err(e);
    }
    Ok(())
}

pub fn copy(from: &Path, to: &Path) -> IdeResult<()> {
    let root = project_root(to)
        .or_else(|| project_root(from))
        .ok_or_else(|| IdeError::invalid("Expected a Unity asset path"))?;
    validate_asset(from)?;
    validate_asset(to)?;
    if key(from) == key(to) || key(to).starts_with(&(key(from) + "/")) {
        return Err(IdeError::invalid("Cannot copy an asset onto or into itself"));
    }
    if exists(to) {
        return Err(IdeError::new(ErrorKind::AlreadyExists, format!("{} already exists", to.display())));
    }
    let src_meta = meta_path(from);
    let dst_meta = meta_path(to);
    no_links(&src_meta)?;
    no_links(&dst_meta)?;
    // Copies never overwrite metadata, including orphan destination metadata.
    if exists(&dst_meta) {
        return Err(IdeError::new(ErrorKind::AlreadyExists, format!("{} already exists", dst_meta.display())));
    }
    let stage = staging(&root)?;
    let result = (|| {
        let asset = stage.join(from.file_name().ok_or_else(|| IdeError::invalid("Missing asset name"))?);
        duplicate::copy_tree(from, &asset)?;
        let meta = meta_path(&asset);
        if exists(&src_meta) {
            duplicate::copy_tree(&src_meta, &meta)?;
        }
        if project_root(to).is_some() {
            duplicate::regenerate(&stage)?;
        }
        let mut moves = Vec::new();
        if exists(&meta) {
            moves.push(FileMove { from: meta.into(), to: dst_meta.into() });
        }
        moves.push(FileMove { from: asset.into(), to: to.into() });
        execute_moves(&moves, &move_one)
    })();
    // Only disposable copies live here, never the source assets.
    let _ = fs::remove_dir_all(&stage);
    result
}
