use super::icon_extensions::Extensions;
use serde::{Deserialize, Serialize};

const MAX_SECTIONS: usize = 16;
const MAX_ITEMS: usize = 32;
const MAX_TEXT_LEN: usize = 255;
const MAX_HINT_LEN: usize = 512;
const MAX_COLUMNS: u8 = 4;

#[derive(Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum SettingOption {
    HideFiles,
    HideFolders,
    HideUiIcons,
    HidePsiIcons,
    HollowFolders,
    Groups,
    Choice,
    Accent,
    Monochrome,
    Saturation,
    Opacity,
    IconSize,
    RowHeight,
}

#[derive(Deserialize, Serialize)]
#[serde(untagged)]
pub(super) enum SettingDefault {
    Number(u8),
    Color(String),
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct SettingItem {
    option: SettingOption,
    #[serde(default)]
    label: Option<String>,
    #[serde(default)]
    hint: Option<String>,
    #[serde(default)]
    invert: bool,
    #[serde(default)]
    choice: Option<String>,
    #[serde(default)]
    columns: Option<u8>,
    #[serde(default)]
    default: Option<SettingDefault>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct SettingsSection {
    title: String,
    items: Vec<SettingItem>,
}

#[derive(Serialize)]
struct ChoiceSummary<'a> {
    id: &'a str,
    name: &'a str,
    default: &'a str,
    options: Vec<OptionSummary<'a>>,
}

#[derive(Serialize)]
struct OptionSummary<'a> {
    id: &'a str,
    name: &'a str,
}

fn check_text(text: &str, max: usize, what: &str) -> Result<(), String> {
    if text.trim().is_empty() || text.len() > max {
        return Err(format!("settings: {what} must have 1 to {max} characters"));
    }
    Ok(())
}

fn range(option: SettingOption) -> Option<(u8, u8)> {
    match option {
        SettingOption::Saturation => Some((0, 20)),
        SettingOption::Opacity => Some((10, 100)),
        SettingOption::IconSize => Some((12, 32)),
        SettingOption::RowHeight => Some((16, 48)),
        _ => None,
    }
}

fn is_color(text: &str) -> bool {
    text.len() == 7 && text.starts_with('#') && text[1..].chars().all(|c| c.is_ascii_hexdigit())
}

fn is_flag(option: SettingOption) -> bool {
    matches!(
        option,
        SettingOption::HideFiles
            | SettingOption::HideFolders
            | SettingOption::HideUiIcons
            | SettingOption::HidePsiIcons
            | SettingOption::HollowFolders
    )
}

impl SettingItem {
    fn validate(&self, ext: &Extensions) -> Result<(), String> {
        let named = !matches!(self.option, SettingOption::Groups | SettingOption::Choice);
        match &self.label {
            Some(label) => check_text(label, MAX_TEXT_LEN, "label")?,
            None if named => return Err("settings: label is required".into()),
            None => {}
        }
        if let Some(hint) = &self.hint {
            check_text(hint, MAX_HINT_LEN, "hint")?;
        }
        if self.invert && !is_flag(self.option) {
            return Err("settings: invert is only for on/off options".into());
        }
        if self.columns.is_some_and(|c| c == 0 || c > MAX_COLUMNS)
            || (self.columns.is_some() && self.option != SettingOption::Groups)
        {
            return Err(format!("settings: columns are 1 to {MAX_COLUMNS}, for groups only"));
        }
        match (self.option, &self.choice) {
            (SettingOption::Choice, Some(id)) if !ext.choices.iter().any(|c| &c.id == id) => {
                return Err(format!("settings: unknown choice {id:?}"));
            }
            (SettingOption::Choice, None) => return Err("settings: choice items name their choice".into()),
            (SettingOption::Choice, Some(_)) | (_, None) => {}
            (_, Some(_)) => return Err("settings: only choice items name a choice".into()),
        }
        if self.option == SettingOption::Accent && !ext.accent {
            return Err("settings: the accent option needs \"accent\": true".into());
        }
        self.validate_default()
    }

    fn validate_default(&self) -> Result<(), String> {
        let colored = matches!(self.option, SettingOption::Accent | SettingOption::Monochrome);
        match (range(self.option), &self.default) {
            (Some((min, max)), Some(SettingDefault::Number(n))) if (min..=max).contains(n) => Ok(()),
            (Some((min, max)), _) => Err(format!("settings: a default from {min} to {max} is required")),
            (None, Some(SettingDefault::Color(c))) if colored && is_color(c) => Ok(()),
            (None, _) if colored => Err("settings: a #rrggbb default is required".into()),
            (None, None) => Ok(()),
            (None, Some(_)) => Err("settings: this option takes no default".into()),
        }
    }
}

pub(super) fn validate(sections: &[SettingsSection], ext: &Extensions) -> Result<(), String> {
    if sections.len() > MAX_SECTIONS {
        return Err(format!("settings: more than {MAX_SECTIONS} sections"));
    }
    for section in sections {
        check_text(&section.title, MAX_TEXT_LEN, "title")?;
        if section.items.len() > MAX_ITEMS {
            return Err(format!("settings: more than {MAX_ITEMS} items in {:?}", section.title));
        }
        for item in &section.items {
            item.validate(ext)?;
        }
    }
    Ok(())
}

pub(super) fn summary(sections: &[SettingsSection], ext: &Extensions) -> serde_json::Value {
    let choices: Vec<ChoiceSummary> = ext
        .choices
        .iter()
        .map(|c| ChoiceSummary {
            id: &c.id,
            name: &c.name,
            default: &c.default,
            options: c.options.iter().map(|o| OptionSummary { id: &o.id, name: &o.name }).collect(),
        })
        .collect();
    serde_json::json!({
        "groups": ext.groups,
        "choices": choices,
        "accent": ext.accent,
        "settings": sections,
    })
}
