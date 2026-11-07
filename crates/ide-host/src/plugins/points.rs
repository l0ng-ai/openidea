//! First-party extension points registered by the host, plus
//! [`register_builtin_points`], the one place that lists them. Feature crates
//! own their points (`ide_language::plugin_point`); adding a contribution type
//! means adding a point here or in its crate, and a `defineUiPoint` projection
//! on the client for `Ui` points — nothing else.

use ide_extension::{ExtensionRegistry, Package, UiDecl, UiPoint, UiStore, decode, validate_item_id, validate_when};
use ide_language::plugin_point::{LanguagesPoint, PluginLanguages};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

pub const COMMANDS: &str = "commands";
const MAX_TITLE: usize = 256;

/// `[[contributes.commands]]`: an action `plugin.<plugin-id>.<id>` in Search
/// Everywhere and the keymap editor; shown before the plugin's code runs.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommandDecl {
    pub id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    /// Enablement, evaluated by the client against context keys (`editorLang == rust`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub when: Option<String>,
}

fn command(_pkg: &Package, decl: toml::Value) -> Result<UiDecl, String> {
    let c: CommandDecl = decode(COMMANDS, decl)?;
    validate_item_id(&c.id, "command id")?;
    if c.title.trim().is_empty() {
        return Err(format!("command {:?} has an empty title", c.id));
    }
    if c.title.len() > MAX_TITLE || c.category.as_ref().is_some_and(|x| x.len() > MAX_TITLE) {
        return Err(format!("command {:?}: title or category longer than {MAX_TITLE} bytes", c.id));
    }
    if let Some(when) = &c.when {
        validate_when(when).map_err(|e| format!("command {:?}: {e}", c.id))?;
    }
    let c = CommandDecl { category: c.category.filter(|x| !x.trim().is_empty()), ..c };
    let json = serde_json::to_value(&c).map_err(|e| e.to_string())?;
    Ok(UiDecl::new(c.id.clone(), c.title, json))
}

/// Registers every first-party extension point.
pub fn register_builtin_points(
    registry: &ExtensionRegistry,
    ui: &Arc<UiStore>,
    languages: &Arc<PluginLanguages>,
    run_detectors: &Arc<super::run_detectors::RunDetectors>,
    providers: &Arc<super::providers::Providers>,
) -> Result<(), String> {
    registry.register(Arc::new(UiPoint::new(COMMANDS, ui.clone(), command)))?;
    registry.register(Arc::new(super::theme::ThemesPoint::new(ui.clone())))?;
    registry.register(Arc::new(LanguagesPoint::new(languages.clone())))?;
    registry.register(Arc::new(UiPoint::new(super::icons::POINT_ID, ui.clone(), super::icons::icon_theme)))?;
    registry.register(Arc::new(super::run_detectors::RunDetectorsPoint::new(run_detectors.clone())))?;
    registry.register(Arc::new(super::navigation::IndexersPoint))?;
    registry.register(Arc::new(super::providers::ProvidersPoint::new(providers.clone())))?;
    registry.register(Arc::new(UiPoint::new(super::providers::SECRETS_POINT, ui.clone(), super::providers::secret)))?;
    use super::ui_points as p;
    registry.register(Arc::new(UiPoint::new(p::MENUS, ui.clone(), p::menu)))?;
    registry.register(Arc::new(UiPoint::new(p::KEYMAPS, ui.clone(), p::keymap)))?;
    registry.register(Arc::new(UiPoint::new(p::STATUS_BAR, ui.clone(), p::status_item)))?;
    registry.register(Arc::new(UiPoint::new(p::SETTINGS, ui.clone(), p::settings)))?;
    registry.register(Arc::new(UiPoint::new(p::VIEWS, ui.clone(), p::view)))?;
    registry.register(Arc::new(UiPoint::new(p::CUSTOM_EDITORS, ui.clone(), p::custom_editor)))?;
    registry.register(Arc::new(UiPoint::new(p::FILE_ICONS, ui.clone(), p::file_icon)))?;
    registry.register(Arc::new(UiPoint::new(p::FILE_TEMPLATES, ui.clone(), p::file_template)))?;
    registry.register(Arc::new(UiPoint::new(p::COMMIT_CHECKS, ui.clone(), p::commit_check)))?;
    Ok(())
}
