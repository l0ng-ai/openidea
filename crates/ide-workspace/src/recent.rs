use ide_core::{IdeError, IdeResult};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RecentProject {
    pub path: ide_core::IpcPath,
    pub name: String,
    pub opened_at_ms: f64,
    /// Git branch shown on the welcome screen. Persisted as of last open; [`RecentProjects::list_live`]
    /// refreshes it from `.git/HEAD` when the list is shown.
    pub branch: Option<String>,
}

pub const MAX_RECENT_PROJECTS: usize = 30;

/// A named group of recent projects on the welcome screen (New Project Group…, Move to Group).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RecentProjectGroup {
    pub name: String,
    /// Its projects, in the order they were added.
    pub paths: Vec<ide_core::IpcPath>,
    #[serde(default = "expanded")]
    pub expanded: bool,
}

fn expanded() -> bool {
    true
}

/// Persisted at `<app-config>/recent.json`, newest first; groups at `<app-config>/recent-groups.json`.
pub struct RecentProjects {
    file: PathBuf,
    items: Mutex<Vec<RecentProject>>,
    groups_file: PathBuf,
    groups: Mutex<Vec<RecentProjectGroup>>,
}

fn read_json<T: serde::de::DeserializeOwned>(file: &Path) -> Option<T> {
    match std::fs::read(file) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|e| tracing::warn!("{} is invalid, ignoring: {e}", file.display()))
            .ok(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => {
            tracing::warn!("cannot read {}: {e}", file.display());
            None
        }
    }
}

fn write_json<T: Serialize + ?Sized>(file: &Path, value: &T) -> IdeResult<()> {
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let json = serde_json::to_vec_pretty(value).map_err(|e| IdeError::internal(e.to_string()))?;
    ide_vfs::write_atomic(file, &json)?;
    Ok(())
}

/// Each path in one group at most (the first keeps it), group names trimmed and unique.
fn normalize(groups: Vec<RecentProjectGroup>) -> Vec<RecentProjectGroup> {
    let mut paths = std::collections::HashSet::new();
    let mut names = std::collections::HashSet::new();
    groups
        .into_iter()
        .filter_map(|mut g| {
            g.name = g.name.trim().to_owned();
            if g.name.is_empty() || !names.insert(g.name.clone()) {
                return None;
            }
            g.paths.retain(|p| paths.insert(p.clone()));
            Some(g)
        })
        .collect()
}

/// Keeps the newest [`MAX_RECENT_PROJECTS`] projects outside groups; grouped ones stay.
fn cap(items: &mut Vec<RecentProject>, groups: &[RecentProjectGroup]) {
    let mut ungrouped = 0;
    items.retain(|p| {
        if groups.iter().any(|g| g.paths.contains(&p.path)) {
            return true;
        }
        ungrouped += 1;
        ungrouped <= MAX_RECENT_PROJECTS
    });
}

fn now_ms() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs_f64() * 1000.0).unwrap_or(0.0)
}

/// The git directory for `project`: `.git/` or the path in a worktree's `.git` file (`gitdir: …`).
fn git_dir(project: &Path) -> Option<PathBuf> {
    let dot = project.join(".git");
    let meta = std::fs::symlink_metadata(&dot).ok()?;
    if meta.file_type().is_dir() {
        return Some(dot);
    }
    if !meta.file_type().is_file() {
        return None;
    }
    let text = std::fs::read_to_string(&dot).ok()?;
    let raw = text.lines().find_map(|line| line.strip_prefix("gitdir:"))?.trim();
    if raw.is_empty() {
        return None;
    }
    let path = PathBuf::from(raw);
    Some(if path.is_absolute() { path } else { project.join(path) })
}

/// Branch name, or a short commit when detached. `Err` when HEAD cannot be read (keep the stored value).
fn read_head_branch(project: &Path) -> Result<Option<String>, ()> {
    let head = std::fs::read_to_string(git_dir(project).ok_or(())?.join("HEAD")).map_err(|_| ())?;
    let head = head.trim();
    if head.is_empty() {
        return Ok(None);
    }
    if let Some(reference) = head.strip_prefix("ref:") {
        let reference = reference.trim();
        if let Some(branch) = reference.strip_prefix("refs/heads/") {
            return Ok(if branch.is_empty() { None } else { Some(branch.to_owned()) });
        }
        // Other symbolic refs (rare for HEAD) are not a branch name.
        return Ok(None);
    }
    // Detached HEAD: object id — show a short commit, never the previous branch.
    let short = head.get(..7).unwrap_or(head);
    Ok(if short.is_empty() { None } else { Some(short.to_owned()) })
}

/// Overlay each entry's `branch` from `.git/HEAD` when readable; otherwise keep the stored value.
pub fn with_live_branches(mut items: Vec<RecentProject>) -> Vec<RecentProject> {
    for item in &mut items {
        if let Ok(branch) = read_head_branch(item.path.as_ref()) {
            item.branch = branch;
        }
    }
    items
}

impl RecentProjects {
    pub fn load(config_dir: &Path) -> Self {
        let file = config_dir.join("recent.json");
        let groups_file = config_dir.join("recent-groups.json");
        let mut items: Vec<RecentProject> = read_json(&file).unwrap_or_default();
        let mut groups = normalize(read_json(&groups_file).unwrap_or_default());
        items.sort_by(|a, b| b.opened_at_ms.total_cmp(&a.opened_at_ms));
        let mut seen = std::collections::HashSet::new();
        items.retain(|p| seen.insert(p.path.clone()));
        cap(&mut items, &groups);
        // A group lists only projects that are still recent.
        for g in &mut groups {
            g.paths.retain(|p| items.iter().any(|i| i.path == *p));
        }
        Self { file, items: Mutex::new(items), groups_file, groups: Mutex::new(groups) }
    }

    pub fn list(&self) -> Vec<RecentProject> {
        self.items.lock().clone()
    }

    /// Like [`list`], but each `branch` is refreshed from that project's `.git/HEAD` when readable.
    pub fn list_live(&self) -> Vec<RecentProject> {
        with_live_branches(self.list())
    }

    pub fn groups(&self) -> Vec<RecentProjectGroup> {
        self.groups.lock().clone()
    }

    /// Replaces the groups (paths that are not recent projects are dropped).
    pub fn set_groups(&self, groups: Vec<RecentProjectGroup>) -> IdeResult<Vec<RecentProjectGroup>> {
        let items = self.items.lock();
        let mut groups = normalize(groups);
        for g in &mut groups {
            g.paths.retain(|p| items.iter().any(|i| i.path == *p));
        }
        write_json(&self.groups_file, &groups)?;
        *self.groups.lock() = groups.clone();
        Ok(groups)
    }

    /// Moves (or adds) `path` to the top of the list.
    pub fn touch(&self, path: &Path, branch: Option<String>) -> IdeResult<()> {
        let mut items = self.items.lock();
        items.retain(|p| p.path != path);
        let name =
            path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.display().to_string());
        items.insert(0, RecentProject { path: path.into(), name, opened_at_ms: now_ms(), branch });
        cap(&mut items, &self.groups.lock());
        self.persist(&items)
    }

    /// Shows `path` as `name` (File › Rename Project…); `None` restores its folder name.
    pub fn rename(&self, path: &Path, name: Option<&str>) -> IdeResult<()> {
        let mut items = self.items.lock();
        let Some(item) = items.iter_mut().find(|p| p.path == path) else { return Ok(()) };
        let name = name.map(str::to_owned).unwrap_or_else(|| {
            path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.display().to_string())
        });
        if item.name == name {
            return Ok(());
        }
        item.name = name;
        self.persist(&items)
    }

    pub fn remove(&self, path: &Path) -> IdeResult<()> {
        let mut items = self.items.lock();
        let before = items.len();
        items.retain(|p| p.path != path);
        if items.len() == before {
            return Ok(());
        }
        self.persist(&items)?;
        let mut groups = self.groups.lock();
        if groups.iter().any(|g| g.paths.iter().any(|p| p == path)) {
            for g in groups.iter_mut() {
                g.paths.retain(|p| p != path);
            }
            write_json(&self.groups_file, &*groups)?;
        }
        Ok(())
    }

    pub fn paths(&self) -> Vec<PathBuf> {
        self.list().into_iter().map(|p| p.path.into_path_buf()).collect()
    }

    fn persist(&self, items: &[RecentProject]) -> IdeResult<()> {
        write_json(&self.file, items)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn newest_first_capped_and_persisted() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg = tmp.path().join("config");
        let recent = RecentProjects::load(&cfg);
        assert!(recent.list().is_empty());
        for i in 0..35 {
            recent.touch(&PathBuf::from(format!("/p/proj{i}")), None).unwrap();
        }
        recent.touch(Path::new("/p/proj3"), Some("main".into())).unwrap();
        let list = recent.list();
        assert_eq!(list.len(), MAX_RECENT_PROJECTS);
        assert_eq!(list[0].path, PathBuf::from("/p/proj3"));
        assert_eq!(list[0].name, "proj3");
        assert_eq!(list[0].branch.as_deref(), Some("main"));
        assert_eq!(list[1].path, PathBuf::from("/p/proj34"));

        recent.remove(Path::new("/p/proj34")).unwrap();
        let reloaded = RecentProjects::load(&cfg);
        assert_eq!(reloaded.paths(), recent.paths());
        assert_eq!(reloaded.list().len(), MAX_RECENT_PROJECTS - 1);
        assert!(!reloaded.paths().contains(&PathBuf::from("/p/proj34")));

        std::fs::write(cfg.join("recent.json"), "not json").unwrap();
        assert!(RecentProjects::load(&cfg).list().is_empty());
    }

    #[test]
    fn groups_keep_their_projects_and_survive_a_reload() {
        let tmp = tempfile::tempdir().unwrap();
        let recent = RecentProjects::load(tmp.path());
        for i in 0..3 {
            recent.touch(&PathBuf::from(format!("/p/proj{i}")), None).unwrap();
        }
        let group = |name: &str, paths: &[&str]| RecentProjectGroup {
            name: name.into(),
            paths: paths.iter().map(|p| PathBuf::from(p).into()).collect(),
            expanded: true,
        };
        let saved = recent
            .set_groups(vec![
                group(" Work ", &["/p/proj0", "/p/gone"]),
                group("Work", &["/p/proj1"]),
                group("Oss", &["/p/proj0", "/p/proj2"]),
                group("  ", &[]),
            ])
            .unwrap();
        // Trimmed, unique names; each project in one group; only recent projects.
        assert_eq!(saved, vec![group("Work", &["/p/proj0"]), group("Oss", &["/p/proj2"])]);
        assert_eq!(RecentProjects::load(tmp.path()).groups(), saved);

        // A grouped project outlives the cap; removing it from recent projects ungroups it.
        for i in 3..40 {
            recent.touch(&PathBuf::from(format!("/p/proj{i}")), None).unwrap();
        }
        let paths = recent.paths();
        assert_eq!(paths.len(), MAX_RECENT_PROJECTS + 2);
        assert!(paths.contains(&PathBuf::from("/p/proj0")) && paths.contains(&PathBuf::from("/p/proj2")));
        recent.remove(Path::new("/p/proj2")).unwrap();
        assert_eq!(RecentProjects::load(tmp.path()).groups(), vec![group("Work", &["/p/proj0"]), group("Oss", &[])]);
    }

    #[test]
    fn rename_shows_a_custom_name_until_reset() {
        let tmp = tempfile::tempdir().unwrap();
        let recent = RecentProjects::load(tmp.path());
        recent.touch(Path::new("/p/app"), None).unwrap();
        recent.rename(Path::new("/p/app"), Some("Shop Backend")).unwrap();
        recent.rename(Path::new("/p/unknown"), Some("x")).unwrap();
        assert_eq!(RecentProjects::load(tmp.path()).list()[0].name, "Shop Backend");
        recent.rename(Path::new("/p/app"), None).unwrap();
        assert_eq!(recent.list()[0].name, "app");
        assert_eq!(recent.list().len(), 1);
    }

    fn write_head(git_dir: &Path, contents: &str) {
        std::fs::create_dir_all(git_dir).unwrap();
        std::fs::write(git_dir.join("HEAD"), contents).unwrap();
    }

    #[test]
    fn list_live_reads_branch_from_head_and_keeps_stored_when_unreadable() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("repo");
        write_head(&repo.join(".git"), "ref: refs/heads/feature/list-live\n");
        let plain = tmp.path().join("plain");
        std::fs::create_dir_all(&plain).unwrap();

        let recent = RecentProjects::load(tmp.path().join("config").as_path());
        recent.touch(&repo, Some("stale".into())).unwrap();
        recent.touch(&plain, Some("kept".into())).unwrap();

        let live = recent.list_live();
        let by_path = |p: &Path| live.iter().find(|i| i.path.as_ref() == p).unwrap();
        assert_eq!(by_path(&repo).branch.as_deref(), Some("feature/list-live"));
        assert_eq!(by_path(&plain).branch.as_deref(), Some("kept"));
        assert_eq!(recent.list().iter().find(|i| i.path.as_ref() == repo).unwrap().branch.as_deref(), Some("stale"));
    }

    #[test]
    fn list_live_follows_worktree_gitdir_and_shows_short_detached_head() {
        let tmp = tempfile::tempdir().unwrap();
        let main = tmp.path().join("main");
        let wt = tmp.path().join("wt");
        std::fs::create_dir_all(&wt).unwrap();
        let wt_git = main.join(".git/worktrees/wt");
        write_head(&wt_git, "abcdefghijklmnopqrstuvwxyz0123456789abcd\n");
        std::fs::write(wt.join(".git"), "gitdir: ../main/.git/worktrees/wt\n").unwrap();

        assert_eq!(read_head_branch(&wt).unwrap().as_deref(), Some("abcdefg"));

        let recent = RecentProjects::load(tmp.path().join("config").as_path());
        recent.touch(&wt, Some("old-branch".into())).unwrap();
        assert_eq!(recent.list_live()[0].branch.as_deref(), Some("abcdefg"));
    }
}
