//! Change lists (IDE-side grouping of local changes), persisted per project in
//! `.openidea/changelists.json` like IDEA's `workspace.xml`. Which list a file belongs
//! to is decided by the UI; this module only loads and saves the state.

use crate::{Changelist, ChangelistState};
use ide_core::IdeResult;
use std::path::Path;

pub const DEFAULT_ID: &str = "default";
pub const DEFAULT_NAME: &str = "Changes";

impl ChangelistState {
    /// The default "Changes" list, active, with no file assignments.
    pub fn initial() -> Self {
        ChangelistState {
            lists: vec![Changelist {
                id: DEFAULT_ID.into(),
                name: DEFAULT_NAME.into(),
                comment: String::new(),
                applied_commit: None,
            }],
            active: DEFAULT_ID.into(),
            files: Default::default(),
        }
    }

    /// Repairs hand-edited or stale state: at least one list, a valid active list,
    /// unique ids, assignments only to existing lists.
    fn normalized(mut self) -> Self {
        let mut seen = std::collections::HashSet::new();
        self.lists.retain(|l| !l.id.is_empty() && seen.insert(l.id.clone()));
        if self.lists.is_empty() {
            return ChangelistState { files: Default::default(), ..Self::initial() };
        }
        if !self.lists.iter().any(|l| l.id == self.active) {
            self.active = self.lists[0].id.clone();
        }
        let ids: std::collections::HashSet<String> = self.lists.iter().map(|l| l.id.clone()).collect();
        self.files.retain(|_, id| ids.contains(id));
        self
    }
}

pub fn load(file: &Path) -> ChangelistState {
    std::fs::read(file)
        .ok()
        .and_then(|b| decode(&b).ok())
        .map(ChangelistState::normalized)
        .unwrap_or_else(ChangelistState::initial)
}

fn decode(bytes: &[u8]) -> serde_json::Result<ChangelistState> {
    let mut value: serde_json::Value = serde_json::from_slice(bytes)?;
    if let Some(lists) = value.get_mut("lists").and_then(serde_json::Value::as_array_mut) {
        for list in lists.iter_mut().filter_map(serde_json::Value::as_object_mut) {
            if let Some(source) = list.remove("cherryPick") {
                list.entry("appliedCommit").or_insert(source);
            }
        }
    }
    serde_json::from_value(value)
}

pub fn save(file: &Path, state: &ChangelistState) -> IdeResult<()> {
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let state = state.clone().normalized();
    let json = serde_json::to_vec_pretty(&state).map_err(|e| ide_core::IdeError::internal(e.to_string()))?;
    let tmp = file.with_extension("json.tmp");
    std::fs::write(&tmp, json)?;
    std::fs::rename(&tmp, file)?;
    Ok(())
}

/// Adds `entries` (e.g. `/shelf/`) to `<dir>/.gitignore` unless already listed, so
/// per-user state in the project folder stays out of version control (IDEA writes
/// `.idea/.gitignore` the same way).
pub fn ensure_ignored(dir: &Path, entries: &[&str]) -> IdeResult<()> {
    let file = dir.join(".gitignore");
    let current = std::fs::read_to_string(&file).unwrap_or_default();
    let missing: Vec<&str> = entries.iter().copied().filter(|e| !current.lines().any(|l| l.trim() == *e)).collect();
    if missing.is_empty() {
        return Ok(());
    }
    std::fs::create_dir_all(dir)?;
    let mut text = current;
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    if text.is_empty() {
        text.push_str("# Per-user IDE state\n");
    }
    for e in missing {
        text.push_str(e);
        text.push('\n');
    }
    std::fs::write(file, text)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_and_repair() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join(".openidea/changelists.json");
        assert_eq!(load(&file).lists[0].name, "Changes");

        let mut st = ChangelistState::initial();
        st.lists.push(Changelist {
            id: "f".into(),
            name: "Feature".into(),
            comment: String::new(),
            applied_commit: None,
        });
        st.active = "f".into();
        st.files.insert("src/a.rs".into(), "f".into());
        st.files.insert("b.rs".into(), "missing".into());
        save(&file, &st).unwrap();
        let back = load(&file);
        assert_eq!(back.active, "f");
        assert_eq!(back.files.get("src/a.rs").map(String::as_str), Some("f"));
        assert!(!back.files.contains_key("b.rs"));

        std::fs::write(&file, r#"{"lists":[],"active":"x","files":{}}"#).unwrap();
        assert_eq!(load(&file).active, DEFAULT_ID);
    }

    #[test]
    fn gitignore_entries_are_added_once() {
        let tmp = tempfile::tempdir().unwrap();
        ensure_ignored(tmp.path(), &["/shelf/"]).unwrap();
        ensure_ignored(tmp.path(), &["/shelf/", "/changelists.json"]).unwrap();
        let text = std::fs::read_to_string(tmp.path().join(".gitignore")).unwrap();
        assert_eq!(text.matches("/shelf/").count(), 1);
        assert!(text.contains("/changelists.json\n"));
    }

    #[test]
    fn restores_earlier_cherry_pick_lists() {
        let state = decode(
            br#"{
                "lists": [{
                    "id": "pick",
                    "name": "Incoming change",
                    "cherryPick": {
                        "repo": "/repo",
                        "commit": "source",
                        "base": "head",
                        "author": "Author <author@example.invalid>",
                        "authorDate": "2022-06-04T13:20:21+05:30"
                    }
                }],
                "active": "pick",
                "files": {"a.txt": "pick"}
            }"#,
        )
        .unwrap();
        let list = &state.lists[0];
        let source = list.applied_commit.as_ref().unwrap();
        assert_eq!(source.kind, crate::CommitApplyKind::CherryPick);
        assert_eq!(source.author_date.as_deref(), Some("2022-06-04T13:20:21+05:30"));
        let saved = serde_json::to_value(list).unwrap();
        assert_eq!(saved["appliedCommit"]["kind"], "cherry-pick");
        assert_eq!(saved["appliedCommit"]["author"], "Author <author@example.invalid>");
    }
}
