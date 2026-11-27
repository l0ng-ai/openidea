//! Explicit workspaces reference project folders without changing them.
//! Attaching folders writes only the primary project's `.openidea/` directory.
use ide_core::{IdeError, IdeResult};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::io::Write;
use std::path::{Path, PathBuf};

pub const FILE: &str = ".openidea/workspace.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub version: u32,
    pub name: String,
    #[serde(serialize_with = "serialize_projects")]
    #[specta(type = Vec<String>)]
    pub projects: Vec<PathBuf>,
}

fn serialize_projects<S: serde::Serializer>(projects: &[PathBuf], serializer: S) -> Result<S::Ok, S::Error> {
    projects.iter().map(|path| ide_core::ipc_path::to_ipc(path)).collect::<Vec<_>>().serialize(serializer)
}

impl Workspace {
    pub fn is_container(&self, root: &Path) -> bool {
        self.projects.first().is_none_or(|p| p != root)
    }

    pub fn display_name(&self, root: &Path, primary: &str) -> String {
        if self.is_container(root) {
            return self.name.clone();
        }
        match self.projects.get(1) {
            Some(other) => format!(
                "{primary}, {}{}",
                other.file_name().unwrap_or_default().to_string_lossy(),
                if self.projects.len() > 2 { "..." } else { "" }
            ),
            None => primary.to_owned(),
        }
    }

    pub fn load(root: &Path) -> IdeResult<Option<Self>> {
        let bytes = match std::fs::read(root.join(FILE)) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e.into()),
        };
        let mut workspace: Self =
            serde_json::from_slice(&bytes).map_err(|e| IdeError::invalid(format!("Invalid workspace: {e}")))?;
        if workspace.version != 1 {
            return Err(IdeError::invalid("Unsupported workspace version"));
        }
        workspace.name = valid_name(&workspace.name)?;
        workspace.projects = normalize_projects(root, workspace.projects)?;
        Ok(Some(workspace))
    }

    pub fn save(root: &Path, name: &str, projects: Vec<PathBuf>, create: bool) -> IdeResult<Self> {
        Self::write(root, name, projects, create, false)
    }

    /// Creates private attachment metadata in an existing primary project.
    pub fn attach(root: &Path, name: &str, projects: Vec<PathBuf>) -> IdeResult<Self> {
        Self::write(root, name, projects, true, true)
    }

    fn write(root: &Path, name: &str, projects: Vec<PathBuf>, create: bool, attach: bool) -> IdeResult<Self> {
        let name = valid_name(name)?;
        let root = destination(root)?;
        let previous = Self::load(&root)?;
        if create && previous.is_some() {
            return Err(IdeError::invalid("This folder already contains a workspace"));
        }
        if !create && previous.is_none() {
            return Err(IdeError::invalid("This folder is not a workspace"));
        }
        let projects = normalize_projects(&root, projects)?;
        if !attach
            && previous.as_ref().is_none_or(|w| w.is_container(&root))
            && projects.iter().any(|p| root.starts_with(p))
        {
            return Err(IdeError::invalid("Store the workspace outside its linked project folders"));
        }
        if attach && projects.first() != Some(&root) {
            return Err(IdeError::invalid("The primary project must be the first attached folder"));
        }
        for path in &projects {
            if !path.is_dir() && !previous.as_ref().is_some_and(|w| w.projects.contains(path)) {
                return Err(IdeError::invalid(format!("Project folder does not exist: {}", path.display())));
            }
        }
        if previous.as_ref().is_some_and(|w| !w.is_container(&root)) && projects.first() != Some(&root) {
            return Err(IdeError::invalid("The primary project cannot be detached"));
        }
        std::fs::create_dir_all(&root)?;
        let workspace = Self { version: 1, name, projects };
        let bytes = serde_json::to_vec_pretty(&workspace).map_err(|e| IdeError::internal(e.to_string()))?;
        let file = root.join(FILE);
        std::fs::create_dir_all(file.parent().expect("workspace metadata directory"))?;
        if create {
            std::fs::OpenOptions::new().write(true).create_new(true).open(file)?.write_all(&bytes)?;
        } else {
            ide_vfs::write_atomic(&file, &bytes)?;
        }
        Ok(workspace)
    }
}

fn destination(path: &Path) -> IdeResult<PathBuf> {
    if !path.is_absolute() {
        return Err(IdeError::invalid("Choose an absolute workspace location"));
    }
    if path.exists() {
        return Ok(dunce::canonicalize(path)?);
    }
    let parent = path.parent().ok_or_else(|| IdeError::invalid("Invalid workspace location"))?;
    let name = path.file_name().ok_or_else(|| IdeError::invalid("Invalid workspace location"))?;
    Ok(destination(parent)?.join(name))
}

fn valid_name(name: &str) -> IdeResult<String> {
    let name = name.trim();
    if name.is_empty() || name.contains(['\n', '\r']) {
        return Err(IdeError::invalid("Enter a workspace name"));
    }
    Ok(name.to_owned())
}

/// A workspace file can come with a cloned repository, and looking a folder up on a network
/// share signs in to that share's server: only local drives and the share `from` is on are
/// looked up.
fn reachable(path: &Path, from: &Path) -> IdeResult<()> {
    if ide_vfs::content_path_allowed(path, &[from]) {
        return Ok(());
    }
    Err(IdeError::invalid(format!(
        "Project folder is not on a local drive or the workspace's share: {}",
        path.display()
    )))
}

fn normalize_projects(root: &Path, projects: Vec<PathBuf>) -> IdeResult<Vec<PathBuf>> {
    let mut result = Vec::new();
    for path in projects {
        let path = if path.is_absolute() { path } else { root.join(path) };
        reachable(&path, root)?;
        let path = match dunce::canonicalize(&path) {
            Ok(path) if path.is_dir() => path,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => path,
            _ => return Err(IdeError::invalid(format!("Project folder does not exist: {}", path.display()))),
        };
        if path != root && path.join(FILE).exists() {
            let mut nested: Workspace = serde_json::from_slice(&std::fs::read(path.join(FILE))?)
                .map_err(|e| IdeError::invalid(format!("Invalid workspace: {e}")))?;
            let primary = nested.projects.first().map(|p| if p.is_absolute() { p.clone() } else { path.join(p) });
            if let Some(primary) = &primary {
                reachable(primary, &path)?;
            }
            if let Some(primary) = primary.and_then(|p| dunce::canonicalize(p).ok()) {
                nested.projects[0] = primary;
            }
            if nested.is_container(&path) {
                return Err(IdeError::invalid("Add project folders instead of nesting workspaces"));
            }
        }
        if !result.contains(&path) {
            result.push(path);
        }
    }
    if result.iter().enumerate().any(|(i, p)| (p == root && i != 0) || (p != root && root.starts_with(p))) {
        return Err(IdeError::invalid("Store the workspace outside its linked project folders"));
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn update_cannot_turn_a_container_into_an_attachment() {
        let tmp = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(tmp.path()).unwrap();
        Workspace::save(&root, "Container", vec![], true).unwrap();
        let before = std::fs::read(root.join(FILE)).unwrap();
        assert!(Workspace::save(&root, "Attached", vec![root.clone()], false).is_err());
        assert_eq!(std::fs::read(root.join(FILE)).unwrap(), before);
    }

    #[test]
    fn create_workspace_refuses_a_location_equal_to_any_member() {
        let tmp = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(tmp.path()).unwrap();
        let other = root.join("other");
        std::fs::create_dir(&other).unwrap();
        for projects in [vec![root.clone(), other.clone()], vec![other, root.clone()]] {
            let error = Workspace::save(&root, "Invalid", projects, true).unwrap_err();
            assert_eq!(error.message, "Store the workspace outside its linked project folders");
            assert!(!root.join(FILE).exists());
        }
    }

    #[test]
    fn attachments_keep_the_primary_and_allow_attached_folders() {
        let tmp = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(tmp.path()).unwrap();
        let a = root.join("a");
        let b = root.join("b");
        let c = root.join("c");
        for path in [&a, &b, &c] {
            std::fs::create_dir(path).unwrap();
        }
        let nested = Workspace::attach(&b, "B", vec![b.clone(), c.clone()]).unwrap();
        assert!(!nested.is_container(&b));
        let saved = Workspace::attach(&a, "A", vec![a.clone(), b.clone()]).unwrap();
        assert_eq!(Workspace::load(&a).unwrap(), Some(saved.clone()));
        assert_eq!(saved.display_name(&a, "Primary"), "Primary, b");
        assert!(Workspace::save(&a, "A", vec![b.clone()], false).is_err());
        let saved = Workspace::save(&a, "A", vec![a.clone(), b, c], false).unwrap();
        assert_eq!(saved.display_name(&a, "Primary"), "Primary, b...");
        let container = root.join("container");
        Workspace::save(&container, "Container", vec![], true).unwrap();
        assert!(Workspace::save(&a, "A", vec![a.clone(), container], false).is_err());
        assert!(Workspace::save(&a, "A", vec![root.clone()], false).is_err());
        assert!(Workspace::save(&root.join("other"), "Other", vec![a, root], true).is_err());
    }

    #[test]
    fn round_trip_deduplicates_projects_without_changing_them() {
        let tmp = tempfile::tempdir().unwrap();
        let project = tmp.path().join("project");
        std::fs::create_dir(&project).unwrap();
        let root = tmp.path().join("workspace");
        let saved = Workspace::save(&root, " Full stack ", vec![project.clone(), project.clone()], true).unwrap();
        assert_eq!(saved.projects.len(), 1);
        assert_eq!(Workspace::load(&root).unwrap(), Some(saved));
        assert!(!project.join(".openidea").exists());
        assert!(Workspace::save(&root, "Other", vec![], true).is_err());
        assert_eq!(Workspace::load(&root).unwrap().unwrap().name, "Full stack");
    }

    #[test]
    fn invalid_update_leaves_manifest_intact_and_missing_projects_can_reopen() {
        let tmp = tempfile::tempdir().unwrap();
        let project = tmp.path().join("project");
        std::fs::create_dir(&project).unwrap();
        let root = tmp.path().join("workspace");
        Workspace::save(&root, "Workspace", vec![project.clone()], true).unwrap();
        let before = std::fs::read(root.join(FILE)).unwrap();
        assert!(Workspace::save(&root, "Changed", vec![tmp.path().join("missing")], false).is_err());
        assert_eq!(std::fs::read(root.join(FILE)).unwrap(), before);
        std::fs::remove_dir(project).unwrap();
        assert_eq!(Workspace::load(&root).unwrap().unwrap().projects.len(), 1);
        let missing = Workspace::load(&root).unwrap().unwrap().projects;
        Workspace::save(&root, "Renamed", missing, false).unwrap();
    }

    /// A workspace file comes with a cloned repository, and its folders are looked up as soon
    /// as the project opens: on Windows, looking one up on a network share signs in to that
    /// share's server with the user's credentials.
    #[cfg(windows)]
    #[test]
    fn folders_on_a_share_the_workspace_is_not_on_are_not_looked_up() {
        const REFUSED: &str = "Project folder is not on a local drive or the workspace's share";
        let tmp = tempfile::tempdir().unwrap();
        let local = dunce::canonicalize(tmp.path()).unwrap();
        for dir in ["root/.openidea", "root/sub/.openidea", "member"] {
            std::fs::create_dir_all(local.join(dir)).unwrap();
        }
        // The same folders reached over SMB through the loopback admin share.
        let s = local.to_str().unwrap();
        let share = PathBuf::from(format!(r"\\127.0.0.1\{}${}", &s[..1], &s[2..]));
        assert!(share.join("member").is_dir(), "control: {} is not reachable over SMB", share.display());
        let write = |dir: &Path, projects: &[&Path]| {
            let projects = projects.iter().map(|p| p.to_path_buf()).collect();
            let workspace = Workspace { version: 1, name: "W".into(), projects };
            std::fs::write(dir.join(FILE), serde_json::to_vec(&workspace).unwrap()).unwrap();
        };
        let root = local.join("root");

        write(&root, &[&root, &local.join("member")]);
        assert_eq!(Workspace::load(&root).unwrap().unwrap().projects, [root.clone(), local.join("member")]);

        write(&root, &[&root, &share.join("member")]);
        let error = Workspace::load(&root).unwrap_err();
        assert!(error.message.starts_with(REFUSED), "{}", error.message);

        // A linked folder's own workspace file names its primary folder.
        write(&root.join("sub"), &[&share.join("member")]);
        write(&root, &[&root, Path::new("sub")]);
        let error = Workspace::load(&root).unwrap_err();
        assert!(error.message.starts_with(REFUSED), "{}", error.message);

        // A workspace that is on the share links that share's folders.
        std::fs::remove_file(root.join("sub").join(FILE)).unwrap();
        let root = dunce::canonicalize(share.join("root")).unwrap();
        write(&root, &[&root, &share.join("member")]);
        let projects = Workspace::load(&root).unwrap().unwrap().projects;
        assert_eq!(projects, [root, dunce::canonicalize(share.join("member")).unwrap()]);
    }

    #[test]
    fn invalid_location_does_not_create_a_folder_inside_a_project() {
        let tmp = tempfile::tempdir().unwrap();
        let project = dunce::canonicalize(tmp.path()).unwrap();
        let root = project.join("workspace");
        assert!(Workspace::save(&root, "Invalid", vec![project], true).is_err());
        assert!(!root.exists());
    }
}
