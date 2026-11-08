//! Laravel commands of the native PHP engine that the editor runs itself:
//! the "Create translation key…" dialog writes the texts it asked for with
//! [`php_laravel_create_translation`].

use crate::Host;
use ide_core::{IdeError, IdeResult, WorkspaceEdit};
use serde::{Deserialize, Serialize};
use specta::Type;

/// One locale's text for a new translation key.
#[derive(Clone, Debug, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TranslationText {
    pub locale: String,
    pub text: String,
}

/// The edit adding translation `key` with each locale's text to that
/// locale's files (a group file's nested arrays, or the JSON file; locales
/// that have the key are left as they are). Fails while the native PHP
/// engine isn't running, outside Laravel projects, and when the key can't
/// be added.
pub async fn php_laravel_create_translation(
    host: &Host,
    window: &str,
    key: String,
    texts: Vec<TranslationText>,
) -> IdeResult<WorkspaceEdit> {
    let project = host.project(window)?;
    let Some(engine) = project.php.engine() else {
        return Err(IdeError::unavailable("The native PHP engine isn't running"));
    };
    host.blocking(move || {
        let texts: Vec<(String, String)> = texts.into_iter().map(|t| (t.locale, t.text)).collect();
        engine
            .laravel_create_translation(&key, &texts)
            .ok_or_else(|| IdeError::invalid(format!("The translation key '{key}' can't be added")))
    })
    .await
}

pub(crate) fn register(d: &mut crate::rpc::Dispatcher) {
    d.add("php_laravel_create_translation", |c| async move {
        php_laravel_create_translation(&c.host, &c.window, c.arg("key")?, c.arg("texts")?).await
    });
}
