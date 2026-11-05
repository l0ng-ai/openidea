//! Settings schema versioning, migrations and layering diagnostics (spec 14).
//!
//! `settings.toml` may carry a top-level `schemaVersion` integer. A file with no
//! such key is a legacy `v0` document. Migrations are deterministic, idempotent
//! transformations of the TOML text: running one twice yields the same bytes,
//! and a corrupt file is *never* rewritten (so user data is never lost).
//!
//! The version key lives in the document, not in the typed [`Settings`] struct:
//! it is stripped before a layer is merged, so it never leaks into IPC types or
//! breaks validation of unknown-but-harmless keys.

use ide_core::IdeResult;
use serde::Serialize;
use specta::Type;
use toml_edit::{DocumentMut, Item, Table};

/// Top-level key holding the schema version. Not part of `Settings`.
pub const SCHEMA_KEY: &str = "schemaVersion";
/// Current schema version. Every migration step below must land here.
pub const SCHEMA_VERSION: u32 = 1;

/// Where the effective value of a setting came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum SettingsOrigin {
    /// No layer overrode it; the built-in default is in effect.
    Default,
    /// `<app-config>/settings.toml`.
    Global,
    /// `<project>/.openidea/settings.toml`.
    Project,
}

/// Reads the declared schema version of a TOML document; `0` when absent or the
/// text is not parseable (a corrupt file is left alone, not treated as v1).
pub fn declared_version(text: &str) -> u32 {
    text.parse::<DocumentMut>()
        .ok()
        .and_then(|doc| doc.get(SCHEMA_KEY).and_then(Item::as_integer))
        .map(|v| u32::try_from(v).unwrap_or(0))
        .unwrap_or(0)
}

/// Removes the schema key from a parsed layer so it never reaches `Settings`.
pub fn strip_schema_key(value: &mut serde_json::Value) {
    if let Some(obj) = value.as_object_mut() {
        obj.remove(SCHEMA_KEY);
    }
}

/// Migrates a settings document to [`SCHEMA_VERSION`].
///
/// Returns `(migrated_text, from_version)`. `from_version == SCHEMA_VERSION`
/// means the text was already current and is returned unchanged. Migration is
/// idempotent: applying the result a second time returns it verbatim with
/// `from_version == SCHEMA_VERSION`.
///
/// A corrupt document fails with `InvalidInput` and is never rewritten.
pub fn migrate(text: &str) -> IdeResult<(String, u32)> {
    let from = declared_version(text);
    if from == SCHEMA_VERSION {
        return Ok((text.to_owned(), from));
    }
    if from > SCHEMA_VERSION {
        return Err(ide_core::IdeError::invalid(format!(
            "settings schema v{from} is newer than this build (v{SCHEMA_VERSION})"
        )));
    }
    let mut doc: DocumentMut = text
        .parse()
        .map_err(|e| ide_core::IdeError::invalid(format!("cannot migrate invalid settings TOML: {e}")))?;

    // v0 → v1: legacy documents used `appearance.colorScheme` for what is now
    // `appearance.theme`. Normalise it only when the typed key is absent, so an
    // explicit `theme` always wins. No other keys change in v1.
    if from == 0 {
        let legacy = doc
            .get("appearance")
            .and_then(Item::as_table_like)
            .and_then(|t| t.get("colorScheme"))
            .and_then(Item::as_value)
            .cloned();
        if let (Some(value), Some(table)) = (
            legacy,
            doc.get_mut("appearance").and_then(Item::as_table_like_mut),
        ) {
            if table.get("theme").is_none() {
                table.insert("theme", Item::Value(value));
            }
            if let Some(t) = doc.get_mut("appearance").and_then(Item::as_table_mut) {
                t.remove("colorScheme");
            }
        }
        doc[SCHEMA_KEY] = toml_edit::value(i64::from(SCHEMA_VERSION));
    }

    Ok((doc.to_string(), from))
}

/// Merges a settings document from a bundle into the user's existing document.
///
/// The user's explicit values win (import must never clobber local settings);
/// only keys absent locally are added. Tables are merged recursively so a bundle
/// can contribute one key under `[editor]` without replacing the whole table.
pub fn merge_documents(existing: &mut DocumentMut, incoming: &DocumentMut) {
    merge_tables(existing.as_table_mut(), incoming.as_table());
}

fn merge_tables(dst: &mut Table, src: &Table) {
    for (key, src_item) in src.iter() {
        match (dst.get_mut(key), src_item) {
            // Both sides hold a table: recurse so either side can win per key.
            (Some(dst_item), Item::Table(src_table)) => {
                if let Some(dst_table) = dst_item.as_table_mut() {
                    merge_tables(dst_table, src_table);
                }
            }
            // Missing locally: take it from the bundle.
            (None, _) => {
                dst.insert(key, src_item.clone());
            }
            // Present locally: the user's value (scalar, array, inline table,
            // or a differently-shaped item) wins.
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migration_is_idempotent_and_marks_the_version() {
        let legacy = "# my settings\n[editor]\nfontSize = 15\n";
        let (once, from) = migrate(legacy).unwrap();
        assert_eq!(from, 0);
        assert_eq!(declared_version(&once), SCHEMA_VERSION);
        assert!(once.contains("[editor]") && once.contains("fontSize = 15"));

        let (twice, from2) = migrate(&once).unwrap();
        assert_eq!(from2, SCHEMA_VERSION);
        assert_eq!(twice, once, "a second migration changes nothing");
    }

    #[test]
    fn legacy_alias_is_normalised_only_when_theme_is_absent() {
        let (migrated, _) = migrate("[appearance]\ncolorScheme = \"Forest\"\n").unwrap();
        assert!(migrated.contains("theme = \"Forest\""), "{migrated}");
        assert!(!migrated.contains("colorScheme"));

        // An explicit `theme` wins over the legacy alias.
        let (kept, _) = migrate("[appearance]\ncolorScheme = \"Forest\"\ntheme = \"dark\"\n").unwrap();
        assert!(kept.contains("theme = \"dark\""), "{kept}");
        assert!(!kept.contains("Forest"));
    }

    #[test]
    fn a_newer_schema_is_rejected_not_downgraded() {
        let err = migrate("schemaVersion = 99\n[editor]\nfontSize = 15\n").unwrap_err();
        assert_eq!(err.kind, ide_core::error::ErrorKind::InvalidInput);
    }

    #[test]
    fn corrupt_documents_fail_without_being_rewritten() {
        let corrupt = "[editor\nfontSize = 15\n";
        assert_eq!(declared_version(corrupt), 0);
        assert!(migrate(corrupt).is_err());
    }

    #[test]
    fn import_merge_keeps_local_values_and_adds_missing_ones() {
        let mut local: DocumentMut = "[editor]\nfontSize = 20\nlineHeight = 1.4\n".parse().unwrap();
        let bundle: DocumentMut = "schemaVersion = 1\n[editor]\nfontSize = 12\ntabSize = 4\n[appearance]\ntheme = \"dark\"\n".parse().unwrap();
        merge_documents(&mut local, &bundle);
        let out = local.to_string();
        assert!(out.contains("fontSize = 20"), "local value must win: {out}");
        assert!(out.contains("lineHeight = 1.4"), "local key must survive: {out}");
        assert!(out.contains("tabSize = 4"), "missing key must be added: {out}");
        assert!(out.contains("theme = \"dark\""), "missing table must be added: {out}");
        assert_eq!(declared_version(&out), SCHEMA_VERSION);
    }

    #[test]
    fn strip_schema_key_removes_only_the_version() {
        let mut v = serde_json::json!({"schemaVersion": 1, "editor": {"fontSize": 14}});
        strip_schema_key(&mut v);
        assert_eq!(v, serde_json::json!({"editor": {"fontSize": 14}}));
    }
}
