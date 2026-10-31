// Ported from JetBrains intellij-community plugins/mcp-server
// (mcpserver.vcs/src/com/intellij/mcpserver/toolsets/vcs/ChangeListToolset.kt), Apache-2.0.
//! Change lists: the Commit tool window's named groups of local changes, kept in
//! `.openidea/changelists.json`. The rules are the UI's (`features/vcs/changelists.ts`):
//! every changed file belongs to one list (unassigned files to the active one, and files
//! are pinned to the active list as they change), the active list cannot be deleted, a
//! deleted list's files move to the active one, and names are unique ignoring case.

use crate::tool::{Call, Output, Param, ParamType, Tool};
use ide_core::mcp::McpToolKind;
use ide_core::{IdeError, IdeResult};
use ide_vcs::{ChangeKind, Changelist, ChangelistState, FileStatus};
use serde_json::{Value, json};
use std::collections::HashSet;
use std::sync::LazyLock;

pub fn tools() -> Vec<Tool> {
    vec![
        get_changelists(),
        create_changelist(),
        set_active_changelist(),
        move_changes_to_changelist(),
        delete_changelist(),
    ]
}

/// Serializes the load-change-save of concurrent calls.
static WRITE: LazyLock<tokio::sync::Mutex<()>> = LazyLock::new(|| tokio::sync::Mutex::new(()));

#[derive(Clone, Copy, PartialEq, Eq)]
enum Group {
    Changes,
    Conflicts,
}

/// The Commit tool window's group of a file (`groupOf` / `effectiveKind` of the UI);
/// `None` for unversioned and ignored files and for a file added then deleted.
fn group_of(f: &FileStatus) -> Option<Group> {
    use ChangeKind::*;
    if f.staged == Some(Conflicted) || f.unstaged == Some(Conflicted) {
        return Some(Group::Conflicts);
    }
    match (f.staged, f.unstaged) {
        (None, Some(Untracked)) | (_, Some(Ignored)) | (None, None) => None,
        (Some(Added), Some(Deleted)) => None,
        _ => Some(Group::Changes),
    }
}

/// The lists, the changed files (project-relative, `/`) with their group, and whether
/// pinning new changes to the active list changed the state.
struct Lists {
    state: ChangelistState,
    files: Vec<(String, Group)>,
    dirty: bool,
}

impl Lists {
    async fn load(call: &Call) -> IdeResult<Self> {
        let host = call.host();
        let mut state = ide_host::ops::vcs::vcs_changelists_load(&host, call.window())?;
        let has_repos = !ide_host::ops::vcs::vcs_roots(&host, call.window())?.is_empty();
        let status = if has_repos { ide_host::ops::vcs::status(&host, call.window()).await? } else { Vec::new() };
        let files: Vec<(String, Group)> = status
            .iter()
            .filter_map(|f| {
                let rel = f.path.strip_prefix(call.root()).ok()?.to_string_lossy().replace('\\', "/");
                Some((rel.trim_end_matches('/').to_owned(), group_of(f)?))
            })
            .collect();
        // `syncAssignments`: forget files no longer changed, pin new changes to the active list.
        let changed: HashSet<&str> = files.iter().filter(|f| f.1 == Group::Changes).map(|f| f.0.as_str()).collect();
        let before = state.files.clone();
        let ids: HashSet<String> = state.lists.iter().map(|l| l.id.clone()).collect();
        state.files.retain(|rel, id| changed.contains(rel.as_str()) && ids.contains(id));
        for rel in &changed {
            state.files.entry((*rel).to_owned()).or_insert_with(|| state.active.clone());
        }
        let dirty = state.files != before;
        Ok(Self { state, files, dirty })
    }

    /// Writes the state and tells the UI to reload it.
    fn save(self, call: &Call) -> IdeResult<()> {
        ide_host::ops::vcs::vcs_changelists_save(&call.host(), call.window(), self.state)?;
        call.project().sink.emit(ide_core::IdeEvent::VcsChanged { root: call.root().to_path_buf().into() });
        Ok(())
    }

    /// The list of a changed file (`listOf`).
    fn list_of<'a>(&'a self, rel: &str) -> &'a str {
        match self.state.files.get(rel) {
            Some(id) if self.state.lists.iter().any(|l| l.id == *id) => id,
            _ => &self.state.active,
        }
    }

    /// The list named `name`: exactly, else ignoring case (the UI keeps names unique so).
    fn find(&self, name: &str) -> Option<Changelist> {
        let lists = &self.state.lists;
        lists
            .iter()
            .find(|l| l.name == name)
            .or_else(|| lists.iter().find(|l| l.name.eq_ignore_ascii_case(name)))
            .cloned()
    }

    fn active_name(&self) -> String {
        self.state.lists.iter().find(|l| l.id == self.state.active).map(|l| l.name.clone()).unwrap_or_default()
    }

    fn add(&mut self, name: &str, comment: Option<String>) -> Changelist {
        let millis =
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64);
        let id = loop {
            let random = uuid::Uuid::new_v4().simple().to_string();
            let id = format!("cl-{}-{}", base36(millis), &random[..5]);
            if !self.state.lists.iter().any(|l| l.id == id) {
                break id;
            }
        };
        let list = Changelist { id, name: name.to_owned(), comment: comment.unwrap_or_default() };
        self.state.lists.push(list.clone());
        list
    }
}

fn base36(mut n: u64) -> String {
    let mut digits = Vec::new();
    loop {
        digits.push(char::from_digit((n % 36) as u32, 36).unwrap_or('0'));
        n /= 36;
        if n == 0 {
            break;
        }
    }
    digits.iter().rev().collect()
}

fn list_name(call: &Call, param: &str) -> IdeResult<String> {
    let name = call.str(param)?.trim().to_owned();
    if name.is_empty() {
        return Err(IdeError::invalid("Changelist name must not be blank"));
    }
    Ok(name)
}

fn comment(call: &Call) -> IdeResult<Option<String>> {
    Ok(call.opt_str("comment")?.filter(|c| !c.trim().is_empty()))
}

fn get_changelists() -> Tool {
    Tool::new(
        "get_changelists",
        McpToolKind::Read,
        "Retrieves the changelists of the project.
A changelist is a named group of pending (not yet committed) changes; every new modification is placed into the active changelist.
Use this tool to see how pending changes are grouped and which changelist is active.",
        |call| async move {
            let include_files = call.flag("includeFiles", false)?;
            let max_files = call.opt_i64("maxFilesPerChangelist")?.unwrap_or(100);
            if max_files <= 0 {
                return Err(IdeError::invalid("maxFilesPerChangelist must be > 0"));
            }
            let lists = Lists::load(&call).await?;
            let result: Vec<Value> = lists
                .state
                .lists
                .iter()
                .map(|l| {
                    let files: Vec<&str> =
                        lists.files.iter().map(|f| f.0.as_str()).filter(|f| lists.list_of(f) == l.id).collect();
                    let mut v = json!({
                        "name": l.name,
                        "id": l.id,
                        "isActive": l.id == lists.state.active,
                        "isReadOnly": false,
                        "changesCount": files.len(),
                    });
                    if !l.comment.trim().is_empty() {
                        v["comment"] = l.comment.clone().into();
                    }
                    if include_files {
                        v["files"] = files.iter().take(max_files as usize).copied().collect::<Vec<_>>().into();
                        if files.len() > max_files as usize {
                            v["hasMoreFiles"] = true.into();
                        }
                    }
                    v
                })
                .collect();
            Output::json(json!({ "changeLists": result }))
        },
    )
    .param(Param::optional(
        "includeFiles",
        ParamType::Boolean,
        "Whether to include project-relative paths of the changed files of each changelist",
    ))
    .param(Param::optional(
        "maxFilesPerChangelist",
        ParamType::Integer,
        "Maximum number of file paths returned per changelist when `includeFiles` is true",
    ))
}

fn create_changelist() -> Tool {
    Tool::new(
        "create_changelist",
        McpToolKind::Edit,
        "Creates a changelist with the given name, or returns the existing one if a changelist with this name already exists.
Pass `activate=true` to make it the active changelist, so that all subsequent file modifications are placed into it.
Use this tool to separate the changes of the current task from other pending changes in the project.
Note: activation affects only future modifications; to group changes that already exist, use `move_changes_to_changelist`.
When activation switches the active changelist, the result includes `previousActiveChangeList`;
pass it to `set_active_changelist` later to restore the user's active changelist.",
        |call| async move {
            let name = list_name(&call, "name")?;
            let comment = comment(&call)?;
            let activate = call.flag("activate", false)?;
            let _guard = WRITE.lock().await;
            let mut lists = Lists::load(&call).await?;
            let previous = lists.active_name();
            let existing = lists.find(&name);
            let created = existing.is_none();
            let list = match existing {
                Some(list) => list,
                None => lists.add(&name, comment),
            };
            if activate {
                lists.state.active = list.id.clone();
            }
            let is_active = lists.state.active == list.id;
            if created || activate || lists.dirty {
                lists.save(&call)?;
            }
            let mut result = json!({ "name": list.name, "id": list.id, "created": created, "isActive": is_active });
            if activate && previous != list.name {
                result["previousActiveChangeList"] = previous.into();
            }
            Output::json(result)
        },
    )
    .param(Param::required("name", ParamType::String, "Name of the changelist"))
    .param(Param::optional("comment", ParamType::String, "Optional description of the changelist"))
    .param(Param::optional(
        "activate",
        ParamType::Boolean,
        "Whether to make the changelist active, so that new changes are placed into it",
    ))
}

fn set_active_changelist() -> Tool {
    Tool::new(
        "set_active_changelist",
        McpToolKind::Edit,
        "Makes the changelist with the given name active: all new modifications will be placed into it.
Fails when the changelist does not exist; use `create_changelist` to create and activate a changelist in one call.
Use this tool to restore the previously active changelist when the current task is finished.",
        |call| async move {
            let name = list_name(&call, "name")?;
            let _guard = WRITE.lock().await;
            let mut lists = Lists::load(&call).await?;
            let list =
                lists.find(&name).ok_or_else(|| IdeError::not_found(format!("Changelist '{name}' not found")))?;
            let previous = lists.active_name();
            let switched = lists.state.active != list.id;
            lists.state.active = list.id.clone();
            if switched || lists.dirty {
                lists.save(&call)?;
            }
            let mut result = json!({ "name": list.name });
            if switched {
                result["previousActiveChangeList"] = previous.into();
            }
            Output::json(result)
        },
    )
    .param(Param::required("name", ParamType::String, "Name of the changelist to make active"))
}

fn move_changes_to_changelist() -> Tool {
    Tool::new(
        "move_changes_to_changelist",
        McpToolKind::Edit,
        "Moves the pending changes of the specified files to the given changelist.
Use this tool to group changes that were already made (for example, by the current task) into a dedicated changelist;
it works regardless of which changelist was active while the files were modified, and does not change the active changelist.
By default the target changelist is created when it does not exist.
Files that have no pending change are reported in `filesWithoutPendingChanges`; the call fails when no changes were moved at all.",
        |call| async move {
            let target = list_name(&call, "changeListName")?;
            let mut files = call.str_list("files")?;
            if files.is_empty() {
                return Err(IdeError::invalid("`files` must not be empty"));
            }
            let mut seen = HashSet::new();
            files.retain(|f| seen.insert(f.clone()));
            let create = call.flag("createIfMissing", true)?;
            let comment = comment(&call)?;
            let _guard = WRITE.lock().await;
            let mut lists = Lists::load(&call).await?;
            let existing = lists.find(&target);
            if existing.is_none() && !create {
                return Err(IdeError::not_found(format!(
                    "Changelist '{target}' not found. Pass createIfMissing=true to create it"
                )));
            }
            let mut moved = Vec::new();
            let mut without = Vec::new();
            for file in files {
                let path = call.resolve_inside(&file)?;
                let rel = path.strip_prefix(call.root()).unwrap_or(&path).to_string_lossy().replace('\\', "/");
                // Conflicted files stay where they are until resolved, as in the UI.
                if lists.files.iter().any(|f| f.0 == rel && f.1 == Group::Changes) {
                    moved.push((file, rel));
                } else {
                    without.push(file);
                }
            }
            if moved.is_empty() {
                return Err(IdeError::not_found(format!("No pending changes found for: {}", without.join(", "))));
            }
            let created = existing.is_none();
            let list = match existing {
                Some(list) => list,
                None => lists.add(&target, comment),
            };
            for (_, rel) in &moved {
                lists.state.files.insert(rel.clone(), list.id.clone());
            }
            lists.save(&call)?;
            let mut result = json!({
                "changeListName": list.name,
                "createdChangeList": created,
                "movedFiles": moved.into_iter().map(|m| m.0).collect::<Vec<_>>(),
            });
            if !without.is_empty() {
                result["filesWithoutPendingChanges"] = without.into();
            }
            Output::json(result)
        },
    )
    .param(Param::required("files", ParamType::StringList, "Project-relative paths of the changed files to move"))
    .param(Param::required("changeListName", ParamType::String, "Name of the target changelist"))
    .param(Param::optional(
        "createIfMissing",
        ParamType::Boolean,
        "Whether to create the target changelist when it does not exist",
    ))
    .param(Param::optional(
        "comment",
        ParamType::String,
        "Optional description applied when the target changelist is created by this call",
    ))
}

fn delete_changelist() -> Tool {
    Tool::new(
        "delete_changelist",
        McpToolKind::Edit,
        "Deletes the changelist with the given name.
Pending changes of the deleted changelist are moved to the active changelist.
The active changelist cannot be deleted: make another changelist active first (see `create_changelist`).",
        |call| async move {
            let name = list_name(&call, "name")?;
            let _guard = WRITE.lock().await;
            let mut lists = Lists::load(&call).await?;
            let list =
                lists.find(&name).ok_or_else(|| IdeError::not_found(format!("Changelist '{name}' not found")))?;
            if list.id == lists.state.active {
                return Err(IdeError::invalid(format!(
                    "Cannot delete the active changelist '{name}'. Make another changelist active first"
                )));
            }
            let moved = lists.files.iter().filter(|f| lists.list_of(&f.0) == list.id).count();
            // `removeList`: the list's files go to the active list.
            let active = lists.state.active.clone();
            lists.state.lists.retain(|l| l.id != list.id);
            for id in lists.state.files.values_mut().filter(|id| **id == list.id) {
                *id = active.clone();
            }
            let moved_to = lists.active_name();
            lists.save(&call)?;
            let mut result = json!({ "name": list.name, "movedChangesCount": moved });
            if moved > 0 {
                result["movedTo"] = moved_to.into();
            }
            Output::json(result)
        },
    )
    .param(Param::required("name", ParamType::String, "Name of the changelist to delete"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_look_like_the_ui_ones() {
        assert_eq!(base36(0), "0");
        assert_eq!(base36(36 * 36 + 35), "10z");
    }
}
