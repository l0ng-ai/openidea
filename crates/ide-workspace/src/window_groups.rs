//! Window grouping is independent of a window's project or workspace.
use ide_core::{IdeError, IdeResult};
use serde::{Deserialize, Serialize};

/// Platform adapters supply the system's tab preference and active project state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TabbingPreference {
    Always,
    InFullScreen,
    Manually,
}

pub fn should_group_new_project(
    preference: TabbingPreference,
    fullscreen: bool,
    active_project: bool,
    light_edit: bool,
) -> bool {
    active_project
        && !light_edit
        && match preference {
            TabbingPreference::Always => true,
            TabbingPreference::InFullScreen => fullscreen,
            TabbingPreference::Manually => false,
        }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WindowGroup {
    pub members: Vec<String>,
    pub selected: String,
}

#[derive(Debug, Default)]
pub struct WindowGroups {
    groups: Vec<WindowGroup>,
}

impl WindowGroups {
    pub fn group(&self, member: &str) -> Option<&WindowGroup> {
        self.groups.iter().find(|g| g.members.iter().any(|m| m == member))
    }

    pub fn groups(&self) -> &[WindowGroup] {
        &self.groups
    }

    pub fn merge(&mut self, members: Vec<String>, selected: &str) -> IdeResult<()> {
        let mut unique = Vec::new();
        for member in members {
            if !unique.contains(&member) {
                unique.push(member);
            }
        }
        if unique.len() < 2 || !unique.iter().any(|m| m == selected) {
            return Err(IdeError::invalid("Open at least two project windows to create a window group"));
        }
        for member in &unique {
            self.detach(member);
        }
        self.groups.push(WindowGroup { members: unique, selected: selected.to_owned() });
        Ok(())
    }

    /// Adds a window to the anchor's group without merging unrelated groups.
    pub fn join(&mut self, anchor: &str, member: &str) -> IdeResult<()> {
        let mut members = self.group(anchor).map(|g| g.members.clone()).unwrap_or_else(|| vec![anchor.to_owned()]);
        members.push(member.to_owned());
        self.merge(members, anchor)
    }

    pub fn select(&mut self, caller: &str, target: &str) -> IdeResult<WindowGroup> {
        let group = self
            .groups
            .iter_mut()
            .find(|g| g.members.iter().any(|m| m == caller))
            .ok_or_else(|| IdeError::not_found("This window is not grouped"))?;
        if !group.members.iter().any(|m| m == target) {
            return Err(IdeError::invalid("The window is not in this group"));
        }
        let before = group.clone();
        group.selected = target.to_owned();
        Ok(before)
    }

    /// Returns the remaining active member, including when the last pair dissolves.
    pub fn detach(&mut self, member: &str) -> Option<String> {
        let i = self.groups.iter().position(|g| g.members.iter().any(|m| m == member))?;
        let group = &mut self.groups[i];
        let index = group.members.iter().position(|m| m == member).unwrap();
        group.members.remove(index);
        if group.selected == member {
            group.selected = group.members[index.min(group.members.len() - 1)].clone();
        }
        let selected = group.selected.clone();
        if group.members.len() < 2 {
            self.groups.remove(i);
        }
        Some(selected)
    }

    pub fn reorder(&mut self, caller: &str, members: Vec<String>) -> IdeResult<()> {
        let group = self
            .groups
            .iter_mut()
            .find(|g| g.members.iter().any(|m| m == caller))
            .ok_or_else(|| IdeError::not_found("This window is not grouped"))?;
        let mut expected = group.members.clone();
        let mut actual = members.clone();
        expected.sort();
        actual.sort();
        if expected != actual {
            return Err(IdeError::invalid("Reordering must preserve every window exactly once"));
        }
        group.members = members;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn members(values: &[&str]) -> Vec<String> {
        values.iter().map(|s| (*s).into()).collect()
    }

    #[test]
    fn new_project_grouping_follows_system_preference_and_excludes_light_edit() {
        for preference in [TabbingPreference::Always, TabbingPreference::InFullScreen, TabbingPreference::Manually] {
            for fullscreen in [false, true] {
                for active_project in [false, true] {
                    for light_edit in [false, true] {
                        let expected = matches!(
                            (preference, fullscreen, active_project, light_edit),
                            (TabbingPreference::Always, _, true, false)
                                | (TabbingPreference::InFullScreen, true, true, false)
                        );
                        assert_eq!(
                            should_group_new_project(preference, fullscreen, active_project, light_edit),
                            expected,
                            "{preference:?}, fullscreen={fullscreen}, active={active_project}, light={light_edit}"
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn joining_new_windows_preserves_the_active_group_and_other_groups() {
        let mut groups = WindowGroups::default();
        groups.merge(members(&["other-a", "other-b"]), "other-b").unwrap();
        groups.join("a", "b").unwrap();
        assert_eq!(groups.group("a").unwrap().members, members(&["a", "b"]));
        let before = groups.select("a", "b").unwrap();
        assert_eq!(before.selected, "a");
        groups.join("b", "c").unwrap();
        let before = groups.select("b", "c").unwrap();
        assert_eq!(before.selected, "b");
        assert_eq!(groups.group("c").unwrap().members, members(&["a", "b", "c"]));
        assert_eq!(groups.group("c").unwrap().selected, "c");
        assert_eq!(groups.group("other-a").unwrap().members, members(&["other-a", "other-b"]));
        assert_eq!(groups.group("other-a").unwrap().selected, "other-b");
    }

    #[test]
    fn selecting_and_detaching_preserve_the_other_sessions() {
        let mut groups = WindowGroups::default();
        groups.merge(members(&["a", "b", "c"]), "b").unwrap();
        assert!(groups.select("a", "unrelated").is_err());
        groups.select("a", "c").unwrap();
        assert_eq!(groups.detach("c"), Some("b".into()));
        assert_eq!(groups.group("a").unwrap().members, members(&["a", "b"]));
        assert_eq!(groups.detach("b"), Some("a".into()));
        assert!(groups.group("a").is_none());
    }

    #[test]
    fn merging_groups_and_reordering_keep_unique_members() {
        let mut groups = WindowGroups::default();
        groups.merge(members(&["a", "b"]), "a").unwrap();
        groups.merge(members(&["c", "d"]), "c").unwrap();
        groups.merge(members(&["a", "b", "c", "d", "a"]), "a").unwrap();
        assert_eq!(groups.groups().len(), 1);
        assert!(groups.reorder("a", members(&["a", "a", "c", "d"])).is_err());
        groups.reorder("a", members(&["d", "c", "b", "a"])).unwrap();
        assert_eq!(groups.group("a").unwrap().members[0], "d");
    }
}
