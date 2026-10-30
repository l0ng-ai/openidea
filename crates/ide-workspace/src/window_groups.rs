//! Window grouping is independent of a window's project or workspace.
use ide_core::{IdeError, IdeResult};
use serde::{Deserialize, Serialize};

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
