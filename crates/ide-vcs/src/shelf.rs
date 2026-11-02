//! The shelf: named patches of local changes kept outside git, like IDEA's
//! `.idea/shelf`. Each shelved change list is `<shelf>/<id>/shelved.patch` plus
//! `<shelf>/<id>/shelf.json` with its name, date and files.

use crate::cli::{run_env, run_paths};
use crate::{ApplyOutcome, ChangeKind, Repo, ShelvedChangeList};
use ide_core::{IdeError, IdeResult};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const PATCH: &str = "shelved.patch";
const INFO: &str = "shelf.json";

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Info {
    name: String,
    time_ms: f64,
    #[serde(default)]
    branch: Option<String>,
    files: Vec<crate::ChangedFile>,
}

fn now_ms() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0)
}

fn slug(name: &str) -> String {
    let mut s: String = name
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '_' })
        .collect::<String>()
        .split('_')
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join("_");
    s.truncate(s.char_indices().nth(60).map(|(i, _)| i).unwrap_or(s.len()));
    if s.is_empty() { "shelf".to_string() } else { s }
}

fn entry_dir(shelf: &Path, id: &str) -> IdeResult<PathBuf> {
    if id.is_empty() || id.contains(['/', '\\']) || id.starts_with('.') {
        return Err(IdeError::invalid(format!("invalid shelf id '{id}'")));
    }
    let dir = shelf.join(id);
    if !dir.join(PATCH).is_file() {
        return Err(IdeError::not_found(format!("shelved changes '{id}' not found")));
    }
    Ok(dir)
}

fn read_info(dir: &Path) -> Option<Info> {
    serde_json::from_slice(&std::fs::read(dir.join(INFO)).ok()?).ok()
}

/// Shelved change lists, newest first.
pub fn list(shelf: &Path) -> IdeResult<Vec<ShelvedChangeList>> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(shelf) else { return Ok(out) };
    for e in entries.flatten() {
        let dir = e.path();
        if !dir.join(PATCH).is_file() {
            continue;
        }
        let id = e.file_name().to_string_lossy().into_owned();
        let info = read_info(&dir).unwrap_or_else(|| Info {
            name: id.clone(),
            time_ms: 0.0,
            branch: None,
            files: std::fs::read_to_string(dir.join(PATCH))
                .map(|p| {
                    crate::patch::parse_patch(&p)
                        .into_iter()
                        .map(|f| crate::ChangedFile { path: f.path, kind: f.kind, old_path: f.old_path })
                        .collect()
                })
                .unwrap_or_default(),
        });
        out.push(ShelvedChangeList {
            id,
            name: info.name,
            time_ms: info.time_ms,
            branch: info.branch,
            files: crate::patch::parse_patch(&std::fs::read_to_string(dir.join(PATCH))?)
                .into_iter()
                .map(|f| crate::ChangedFile { path: f.path, kind: f.kind, old_path: f.old_path })
                .collect(),
        });
    }
    out.sort_by(|a, b| b.time_ms.total_cmp(&a.time_ms).then_with(|| a.name.cmp(&b.name)));
    Ok(out)
}

/// The patch text of a shelved change list.
pub fn patch_of(shelf: &Path, id: &str) -> IdeResult<String> {
    Ok(std::fs::read_to_string(entry_dir(shelf, id)?.join(PATCH))?)
}

pub fn delete(shelf: &Path, id: &str) -> IdeResult<()> {
    std::fs::remove_dir_all(entry_dir(shelf, id)?)?;
    Ok(())
}

pub fn rename(shelf: &Path, id: &str, name: &str) -> IdeResult<()> {
    let name = name.trim();
    if name.is_empty() {
        return Err(IdeError::invalid("name must not be empty"));
    }
    let dir = entry_dir(shelf, id)?;
    let mut info =
        read_info(&dir).unwrap_or(Info { name: String::new(), time_ms: now_ms(), branch: None, files: vec![] });
    info.name = name.to_string();
    std::fs::write(dir.join(INFO), serde_json::to_vec_pretty(&info).map_err(|e| IdeError::internal(e.to_string()))?)?;
    Ok(())
}

/// Saves the changes of `rel_paths` to the shelf and reverts them in the working tree.
pub(crate) fn shelve(r: &Repo, shelf: &Path, name: &str, rel_paths: &[String]) -> IdeResult<ShelvedChangeList> {
    let name = name.trim();
    if name.is_empty() {
        return Err(IdeError::invalid("name must not be empty"));
    }
    let (patch, files) = crate::patch::working_patch(r, rel_paths, false, false)?;
    if files.is_empty() || patch.trim().is_empty() {
        return Err(IdeError::invalid("no changes to shelve"));
    }
    std::fs::create_dir_all(shelf)?;
    let base = slug(name);
    let mut id = base.clone();
    let mut n = 1;
    while shelf.join(&id).exists() {
        n += 1;
        id = format!("{base}_{n}");
    }
    let dir = shelf.join(&id);
    std::fs::create_dir_all(&dir)?;
    let info = Info { name: name.to_string(), time_ms: now_ms(), branch: r.branch_info()?.head, files: files.clone() };
    let write = || -> IdeResult<()> {
        std::fs::write(dir.join(PATCH), patch.as_bytes())?;
        std::fs::write(
            dir.join(INFO),
            serde_json::to_vec_pretty(&info).map_err(|e| IdeError::internal(e.to_string()))?,
        )?;
        Ok(())
    };
    if let Err(e) = write() {
        let _ = std::fs::remove_dir_all(&dir);
        return Err(e);
    }
    revert_files(r, &files)?;
    Ok(ShelvedChangeList { id, name: info.name, time_ms: info.time_ms, branch: info.branch, files })
}

/// Restores `files` to HEAD in both index and working tree; files absent from HEAD are removed.
fn revert_files(r: &Repo, files: &[crate::ChangedFile]) -> IdeResult<()> {
    let has_head = r.has_head()?;
    let (in_head, new): (Vec<_>, Vec<_>) = files.iter().partition(|f| has_head && f.kind != ChangeKind::Added);
    let paths = |files: &[&crate::ChangedFile]| -> Vec<String> { files.iter().map(|f| f.path.clone()).collect() };
    if !in_head.is_empty() {
        let args = ["--literal-pathspecs", "restore", "--source=HEAD", "--staged", "--worktree", "--"];
        run_paths(r.root(), &args, &paths(&in_head))?;
    }
    if !new.is_empty() {
        let args = ["--literal-pathspecs", "rm", "--cached", "-q", "-r", "--ignore-unmatch", "--"];
        run_paths(r.root(), &args, &paths(&new))?;
        for f in new {
            let abs = r.abs_path(&f.path);
            if abs.is_file() || abs.is_symlink() {
                std::fs::remove_file(&abs)?;
            }
        }
    }
    Ok(())
}

/// Applies a shelved change list; with `remove`, deletes it from the shelf once it
/// applied without conflicts (conflicts are left for the merge UI and the entry is kept).
pub(crate) fn unshelve(r: &Repo, shelf: &Path, id: &str, remove: bool) -> IdeResult<ApplyOutcome> {
    unshelve_path(r, shelf, id, remove, None)
}

pub fn unshelve_path(r: &Repo, shelf: &Path, id: &str, remove: bool, path: Option<&str>) -> IdeResult<ApplyOutcome> {
    let patch = selected_patch(shelf, id, path)?;
    let outcome = crate::patch::apply(r, &patch)?;
    if remove && outcome.conflicts.is_empty() {
        delete_path(shelf, id, path)?;
    }
    Ok(outcome)
}

#[derive(Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ShelfDiffFile {
    pub path: String,
    pub patch: String,
    pub before: Option<String>,
    pub after: Option<String>,
}

fn sections(patch: &str) -> Vec<(&str, crate::PatchFile)> {
    let mut starts: Vec<_> = patch
        .match_indices("diff --git ")
        .filter(|(i, _)| *i == 0 || patch.as_bytes()[i - 1] == b'\n')
        .map(|(i, _)| i)
        .collect();
    if starts.is_empty() {
        let (mut old, mut new) = (0u32, 0u32);
        let mut offset = 0;
        let mut lines = patch.split_inclusive('\n').peekable();
        while let Some(line) = lines.next() {
            if old > 0 || new > 0 {
                match line.as_bytes().first() {
                    Some(b'-') => old = old.saturating_sub(1),
                    Some(b'+') => new = new.saturating_sub(1),
                    Some(b' ') => {
                        old = old.saturating_sub(1);
                        new = new.saturating_sub(1);
                    }
                    _ => {}
                }
            } else if line.starts_with("--- ") && lines.peek().is_some_and(|l| l.starts_with("+++ ")) {
                starts.push(offset);
            }
            if let Some(range) = line.strip_prefix("@@ ") {
                let mut parts = range.split_whitespace();
                let count = |s: &str| s.split_once(',').map_or(1, |(_, n)| n.parse().unwrap_or(0));
                old = parts.next().map(count).unwrap_or(0);
                new = parts.next().map(count).unwrap_or(0);
            }
            offset += line.len();
        }
    }
    starts
        .iter()
        .enumerate()
        .filter_map(|(n, &start)| {
            let section = &patch[start..starts.get(n + 1).copied().unwrap_or(patch.len())];
            crate::patch::parse_patch(section).into_iter().next().map(|file| (section, file))
        })
        .collect()
}

pub fn selected_patch(shelf: &Path, id: &str, path: Option<&str>) -> IdeResult<String> {
    let patch = patch_of(shelf, id)?;
    let Some(path) = path else { return Ok(patch) };
    let selected: String = sections(&patch).into_iter().filter(|(_, f)| f.path == path).map(|(p, _)| p).collect();
    if selected.is_empty() {
        return Err(IdeError::not_found("shelved file not found"));
    }
    Ok(selected)
}

pub fn delete_path(shelf: &Path, id: &str, path: Option<&str>) -> IdeResult<()> {
    let Some(path) = path else { return delete(shelf, id) };
    selected_patch(shelf, id, Some(path))?;
    let patch = patch_of(shelf, id)?;
    let remaining: String = sections(&patch).into_iter().filter(|(_, f)| f.path != path).map(|(p, _)| p).collect();
    if remaining.is_empty() {
        return delete(shelf, id);
    }
    let dir = entry_dir(shelf, id)?;
    let mut info = read_info(&dir).ok_or_else(|| IdeError::invalid("shelf metadata is missing"))?;
    info.files = crate::patch::parse_patch(&remaining)
        .into_iter()
        .map(|f| crate::ChangedFile { path: f.path, kind: f.kind, old_path: f.old_path })
        .collect();
    std::fs::write(dir.join(PATCH), remaining)?;
    std::fs::write(dir.join(INFO), serde_json::to_vec_pretty(&info).map_err(|e| IdeError::internal(e.to_string()))?)?;
    Ok(())
}

/// Reconstruct each side in a throwaway index; neither HEAD nor the working files are used.
pub fn diff_files(r: &Repo, shelf: &Path, id: &str) -> IdeResult<Vec<ShelfDiffFile>> {
    let patch = patch_of(shelf, id)?;
    let mut out = Vec::new();
    for (section, file) in sections(&patch) {
        let mut item = ShelfDiffFile { path: file.path.clone(), patch: section.to_string(), before: None, after: None };
        if !file.binary {
            let reconstruct = || -> IdeResult<(String, String)> {
                let temp = tempfile::tempdir()?;
                let index = temp.path().join("index");
                let env = [("GIT_INDEX_FILE", index.as_os_str())];
                run_env(
                    r.root(),
                    &["apply", &format!("--build-fake-ancestor={}", index.display()), "-"],
                    Some(section.as_bytes()),
                    &env,
                )?;
                let read = |path: &str| -> IdeResult<String> {
                    let bytes = run_env(r.root(), &["show", &format!(":{path}")], None, &env)?.stdout;
                    if bytes.contains(&0) {
                        return Err(IdeError::invalid("binary file"));
                    }
                    String::from_utf8(bytes).map_err(|_| IdeError::invalid("non-UTF-8 file"))
                };
                let before = if file.kind == ChangeKind::Added {
                    String::new()
                } else {
                    read(file.old_path.as_deref().unwrap_or(&file.path))?
                };
                run_env(
                    r.root(),
                    &["apply", "--cached", "--binary", "--whitespace=nowarn", "-"],
                    Some(section.as_bytes()),
                    &env,
                )?;
                let after = if file.kind == ChangeKind::Deleted { String::new() } else { read(&file.path)? };
                Ok((before, after))
            };
            if let Ok((before, after)) = reconstruct() {
                item.before = Some(before);
                item.after = Some(after);
            }
        }
        out.push(item);
    }
    Ok(out)
}

/// Import into the shelf without applying to the working tree.
pub fn import_patch(shelf: &Path, name: &str, patch: &str) -> IdeResult<()> {
    let files = crate::patch::parse_patch(patch);
    if files.is_empty() || sections(patch).len() != files.len() {
        return Err(IdeError::invalid("no file changes found in the patch"));
    }
    std::fs::create_dir_all(shelf)?;
    let mut id = slug(name);
    while shelf.join(&id).exists() {
        id.push('_');
    }
    let dir = shelf.join(id);
    std::fs::create_dir(&dir)?;
    let info = Info {
        name: name.to_string(),
        time_ms: now_ms(),
        branch: None,
        files: files
            .into_iter()
            .map(|f| crate::ChangedFile { path: f.path, kind: f.kind, old_path: f.old_path })
            .collect(),
    };
    std::fs::write(dir.join(PATCH), patch)?;
    std::fs::write(dir.join(INFO), serde_json::to_vec_pretty(&info).map_err(|e| IdeError::internal(e.to_string()))?)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::slug;

    #[test]
    fn slugs() {
        assert_eq!(
            slug("Uncommitted changes before Update at 1/2/24, 10:00"),
            "Uncommitted_changes_before_Update_at_1_2_24_10_00"
        );
        assert_eq!(slug("  ../  "), "shelf");
        assert_eq!(slug("Фикс"), "Фикс");
    }
}
