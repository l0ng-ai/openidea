use super::icon_patterns::validate_pattern;
use ide_extension::validate_item_id;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

const MAX_GROUPS: usize = 64;
const MAX_CHOICES: usize = 16;
const MAX_CHOICE_OPTIONS: usize = 16;
const MAX_NAME_LEN: usize = 255;
pub(super) const DARK_SUFFIX: &str = "_dark";

#[derive(Deserialize)]
#[serde(untagged)]
pub(super) enum IconDefinition {
    Path(PathBuf),
    Variants(IconVariants),
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct IconVariants {
    light: PathBuf,
    #[serde(default)]
    dark: Option<PathBuf>,
}

impl IconDefinition {
    pub(super) fn light(&self) -> &PathBuf {
        match self {
            IconDefinition::Path(p) => p,
            IconDefinition::Variants(v) => &v.light,
        }
    }

    pub(super) fn dark(&self) -> Option<&PathBuf> {
        match self {
            IconDefinition::Path(_) => None,
            IconDefinition::Variants(v) => v.dark.as_ref(),
        }
    }
}

#[derive(Clone, Copy, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum Target {
    #[default]
    File,
    Folder,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Pattern {
    pattern: String,
    icon: String,
    #[serde(default)]
    target: Target,
    #[serde(default)]
    path: bool,
    #[serde(default)]
    ignore_case: bool,
    #[serde(default)]
    group: Option<String>,
    #[serde(default)]
    open_icon: Option<String>,
}

fn enabled_by_default() -> bool {
    true
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Group {
    pub(super) id: String,
    name: String,
    #[serde(default = "enabled_by_default")]
    enabled: bool,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ChoiceOption {
    pub(super) id: String,
    pub(super) name: String,
    #[serde(default)]
    overrides: BTreeMap<String, String>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Choice {
    pub(super) id: String,
    pub(super) name: String,
    pub(super) default: String,
    pub(super) options: Vec<ChoiceOption>,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Extensions {
    #[serde(default)]
    pub(super) patterns: Vec<Pattern>,
    #[serde(default)]
    pub(super) overrides: BTreeMap<String, String>,
    #[serde(default)]
    pub(super) groups: Vec<Group>,
    #[serde(default)]
    pub(super) choices: Vec<Choice>,
    #[serde(default)]
    pub(super) accent: bool,
}

pub(super) fn check_icon_id(id: &str) -> Result<(), String> {
    validate_item_id(id, "icon id")?;
    if id.ends_with(DARK_SUFFIX) {
        return Err(format!("icon id {id:?}: the {DARK_SUFFIX:?} suffix is reserved for dark variants"));
    }
    Ok(())
}

fn check_named(id: &str, name: &str, what: &str) -> Result<(), String> {
    validate_item_id(id, what)?;
    if name.trim().is_empty() || name.len() > MAX_NAME_LEN {
        return Err(format!("{what} {id:?}: name must have 1 to {MAX_NAME_LEN} characters"));
    }
    Ok(())
}

fn check_unique<'a>(ids: impl Iterator<Item = &'a String>, what: &str) -> Result<(), String> {
    let mut seen = BTreeSet::new();
    match ids.into_iter().find(|id| !seen.insert(*id)) {
        Some(id) => Err(format!("duplicate {what} {id:?}")),
        None => Ok(()),
    }
}

impl Extensions {
    pub(super) fn mappings(&self) -> usize {
        let chosen: usize = self.choices.iter().flat_map(|c| &c.options).map(|o| o.overrides.len()).sum();
        self.patterns.len() + self.overrides.len() + chosen
    }

    pub(super) fn validate(&self, check_ref: &dyn Fn(&str, &str) -> Result<(), String>) -> Result<(), String> {
        self.validate_groups()?;
        for p in &self.patterns {
            validate_pattern(&p.pattern)?;
            check_ref(&p.icon, "patterns")?;
            if let Some(group) = &p.group
                && !self.groups.iter().any(|g| &g.id == group)
            {
                return Err(format!("pattern {:?}: unknown group {group:?}", p.pattern));
            }
            if let Some(open) = &p.open_icon {
                if p.target != Target::Folder {
                    return Err(format!("pattern {:?}: openIcon is only for folder patterns", p.pattern));
                }
                check_ref(open, "patterns")?;
            }
        }
        check_overrides(&self.overrides, check_ref, "overrides")?;
        for choice in &self.choices {
            for option in &choice.options {
                check_overrides(&option.overrides, check_ref, "choices")?;
            }
        }
        Ok(())
    }

    fn validate_groups(&self) -> Result<(), String> {
        if self.groups.len() > MAX_GROUPS || self.choices.len() > MAX_CHOICES {
            return Err(format!("too many groups or choices (max {MAX_GROUPS} and {MAX_CHOICES})"));
        }
        for g in &self.groups {
            check_named(&g.id, &g.name, "group")?;
        }
        check_unique(self.groups.iter().map(|g| &g.id), "group")?;
        check_unique(self.choices.iter().map(|c| &c.id), "choice")?;
        for choice in &self.choices {
            check_named(&choice.id, &choice.name, "choice")?;
            if choice.options.is_empty() || choice.options.len() > MAX_CHOICE_OPTIONS {
                return Err(format!("choice {:?}: expected 1 to {MAX_CHOICE_OPTIONS} options", choice.id));
            }
            for option in &choice.options {
                check_named(&option.id, &option.name, "choice option")?;
            }
            check_unique(choice.options.iter().map(|o| &o.id), "choice option")?;
            if !choice.options.iter().any(|o| o.id == choice.default) {
                return Err(format!("choice {:?}: default {:?} is not one of its options", choice.id, choice.default));
            }
        }
        Ok(())
    }
}

fn check_overrides(
    overrides: &BTreeMap<String, String>,
    check_ref: &dyn Fn(&str, &str) -> Result<(), String>,
    what: &str,
) -> Result<(), String> {
    for (name, icon) in overrides {
        validate_item_id(name, "overridden icon name")?;
        check_ref(icon, what)?;
    }
    Ok(())
}
