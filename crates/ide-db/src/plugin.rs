//! Ownership checks and surgical updates of plugin-created project sources.
use crate::{DataSource, DbManager, source};
use ide_core::{IdeError, IdeResult, project_dir};
use std::path::Path;

// All DbManagers of the same root share this file. Never hold this across an await.
pub(crate) static EDIT: parking_lot::Mutex<()> = parking_lot::Mutex::new(());

/// Host-owned connection id, unambiguous and safe for console paths.
pub fn source_id(plugin: &str, id: &str) -> String {
    format!("plugin-{}", blake3::hash(format!("{plugin}\0{id}").as_bytes()).to_hex())
}

fn owned(source: &DataSource, plugin: &str, id: &str) -> bool {
    source.id == source_id(plugin, id)
        && source.plugin_owner.as_deref() == Some(plugin)
        && source.plugin_source_id.as_deref() == Some(id)
        && !source.global
}

/// Edits just matching array tables, retaining unrelated entries, comments and formatting.
fn update(root: &Path, remove: impl Fn(&DataSource) -> bool, add: Option<&DataSource>) -> IdeResult<Vec<DataSource>> {
    let path = project_dir::path(root, "data-sources.toml");
    if let Some(ancestor) = path.ancestors().find(|p| p.exists())
        && root.exists()
        && !dunce::canonicalize(ancestor)?.starts_with(dunce::canonicalize(root)?)
    {
        return Err(IdeError::invalid("data sources file is outside the project"));
    }
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(e.into()),
    };
    let old = source::load(root)?;
    let doc = toml_edit::Document::parse(text.as_str()).map_err(|e| IdeError::invalid(format!("data sources: {e}")))?;
    let removed: Vec<_> = old.iter().filter(|s| remove(s)).cloned().collect();
    fn line_span(text: &str, span: std::ops::Range<usize>, out: &mut Vec<std::ops::Range<usize>>) {
        let start = text[..span.start].rfind('\n').map_or(0, |n| n + 1);
        let mut end = text[span.end..].find('\n').map_or(text.len(), |n| span.end + n + 1);
        while end < text.len() {
            let next = text[end..].find('\n').map_or(text.len(), |n| end + n + 1);
            if !text[end..next].trim().is_empty() {
                break;
            }
            end = next;
        }
        out.push(start..end);
    }
    fn spans(table: &toml_edit::Table, text: &str, out: &mut Vec<std::ops::Range<usize>>) {
        if !table.is_implicit()
            && let Some(span) = table.span()
        {
            line_span(text, span, out);
        }
        for (_, item) in table.iter() {
            if let Some(span) = item.as_value().and_then(toml_edit::Value::span) {
                line_span(text, span, out);
            }
            if let Some(table) = item.as_table() {
                spans(table, text, out);
            }
            if let Some(tables) = item.as_array_of_tables() {
                for table in tables.iter() {
                    spans(table, text, out);
                }
            }
        }
    }
    if doc.get("data-source").is_some_and(|i| i.as_array_of_tables().is_none()) {
        return Err(IdeError::invalid("plugin sources require [[data-source]] tables"));
    }
    let mut ranges = vec![];
    if let Some(tables) = doc.get("data-source").and_then(toml_edit::Item::as_array_of_tables) {
        for (table, source) in tables.iter().zip(&old) {
            if remove(source) {
                spans(table, &text, &mut ranges);
            }
        }
    }
    ranges.sort_by_key(|r| r.start);
    let mut merged: Vec<std::ops::Range<usize>> = vec![];
    for range in ranges {
        if let Some(last) = merged.last_mut()
            && range.start <= last.end
        {
            last.end = last.end.max(range.end);
            continue;
        }
        merged.push(range);
    }
    let mut output = text.clone();
    for range in merged.into_iter().rev() {
        output.replace_range(range, "");
    }
    if let Some(add) = add {
        let mut value = toml::Value::try_from(add).map_err(|e| IdeError::internal(e.to_string()))?;
        value.as_table_mut().unwrap().remove("global");
        let value =
            toml::Value::Table(toml::Table::from_iter([("data-source".into(), toml::Value::Array(vec![value]))]));
        if !output.is_empty() && !output.ends_with('\n') {
            output.push('\n');
        }
        output.push_str(&toml::to_string_pretty(&value).map_err(|e| IdeError::internal(e.to_string()))?);
    }
    if !removed.is_empty() || add.is_some() {
        let dir = path.parent().unwrap();
        std::fs::create_dir_all(dir)?;
        let tmp = dir.join(format!(".data-sources-{}.tmp", uuid::Uuid::new_v4()));
        std::fs::write(&tmp, output)?;
        if let Err(e) = std::fs::rename(&tmp, &path) {
            let _ = std::fs::remove_file(&tmp);
            return Err(e.into());
        }
    }
    Ok(removed)
}

/// Removes only this plugin's sources, including when their project is closed at uninstall.
pub fn remove_all(root: &Path, plugin: &str) -> IdeResult<Vec<DataSource>> {
    let _guard = EDIT.lock();
    update(root, |s| s.plugin_owner.as_deref() == Some(plugin), None)
}

impl DbManager {
    /// Lists private source ids without exposing any connection settings.
    pub fn plugin_sources(&self, plugin: &str) -> IdeResult<Vec<String>> {
        Ok(source::load(&self.root)?
            .into_iter()
            .filter(|s| s.plugin_owner.as_deref() == Some(plugin))
            .filter_map(|s| s.plugin_source_id)
            .collect())
    }
    /// Checks the stored owner, even if a user-created source uses the host's id format.
    pub fn plugin_source(&self, plugin: &str, id: &str) -> IdeResult<DataSource> {
        source::load(&self.root)?
            .into_iter()
            .find(|s| owned(s, plugin, id))
            .ok_or_else(|| IdeError::not_found("no owned data source with this id"))
    }
    /// Replaces only an owned source and disconnects its old pools.
    pub async fn upsert_plugin_source(&self, plugin: &str, id: &str, mut source: DataSource) -> IdeResult<()> {
        source.id = source_id(plugin, id);
        source.plugin_owner = Some(plugin.into());
        source.plugin_source_id = Some(id.into());
        source.global = false;
        {
            let _guard = EDIT.lock();
            let all = self.sources()?;
            if all.iter().any(|s| s.id == source.id && !owned(s, plugin, id)) {
                return Err(IdeError::not_found("no owned data source with this id"));
            }
            if !all.iter().any(|s| owned(s, plugin, id)) && self.plugin_sources(plugin)?.len() >= 64 {
                return Err(IdeError::invalid("at most 64 sources per plugin and project"));
            }
            update(&self.root, |s| owned(s, plugin, id), Some(&source))?;
        }
        self.disconnect_source(&source.id).await;
        Ok(())
    }
    /// Deletes an owned source and all its saved/session credentials.
    pub async fn remove_plugin_source(&self, plugin: &str, id: &str) -> IdeResult<()> {
        let source = {
            let _guard = EDIT.lock();
            let source = self.plugin_source(plugin, id)?;
            update(&self.root, |s| owned(s, plugin, id), None)?;
            source
        };
        self.forget_plugin_source(&source.id).await;
        Ok(())
    }
    /// Completes cleanup after removal from the file.
    pub async fn forget_plugin_source(&self, id: &str) {
        for key in [id.to_owned(), crate::secrets::ssh_key(id)] {
            self.session_passwords.lock().remove(&key);
            self.saved_passwords.delete(&key);
        }
        self.disconnect_source(id).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{DbDriver, secrets::SecretStore};
    #[tokio::test]
    async fn ownership_preserves_unrelated_bytes_and_cleans_credentials() {
        ide_ssh::secrets::testing::use_memory_store();
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("project");
        std::fs::create_dir_all(root.join(".openidea")).unwrap();
        let original = "# user comment\n[[data-source]] # keep\nid = 'user'\nname='Mine'\ndriver='postgres'\n\n[data-source.options]\ntimeZone = 'UTC' # retain\n";
        let file = root.join(".openidea/data-sources.toml");
        std::fs::write(&file, original).unwrap();
        let secrets = tmp.path().join("passwords.json");
        let db = DbManager::new(
            root.clone(),
            secrets.clone(),
            tmp.path().join("history.json"),
            std::sync::Arc::new(ide_ssh::SshManager::new(tmp.path().join("ssh.json"))),
        );
        let settings =
            DataSource { name: "Plugin".into(), driver: DbDriver::Postgres, save_password: true, ..Default::default() };
        db.upsert_plugin_source("a", "local", settings.clone()).await.unwrap();
        assert!(std::fs::read_to_string(&file).unwrap().starts_with(original));
        db.upsert_plugin_source("b", "local", settings.clone()).await.unwrap();
        assert_eq!(db.plugin_sources("a").unwrap(), ["local"]);
        assert!(db.plugin_source("a", "user").is_err());
        assert!(db.remove_plugin_source("a", "user").await.is_err());
        let source = db.plugin_source("a", "local").unwrap();
        db.set_password(&source.id, Some("top-secret".into()), true).await.unwrap();
        let store = SecretStore::new(secrets, &root);
        assert_eq!(store.get(&source.id).as_deref(), Some("top-secret"));
        db.upsert_plugin_source("a", "local", DataSource { name: "Updated".into(), ..settings }).await.unwrap();
        assert_eq!(store.get(&source.id).as_deref(), Some("top-secret"));
        db.remove_plugin_source("a", "local").await.unwrap();
        assert!(store.get(&source.id).is_none());
        assert_eq!(db.plugin_sources("b").unwrap(), ["local"]);
        remove_all(&root, "b").unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), original);
    }
    #[tokio::test]
    async fn project_owned_credentials_do_not_replace_a_shadowed_global_sources_password() {
        ide_ssh::secrets::testing::use_memory_store();
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("project");
        let global = tmp.path().join("global");
        let passwords = tmp.path().join("passwords.json");
        let db = DbManager::new(
            root.clone(),
            passwords.clone(),
            tmp.path().join("history.json"),
            std::sync::Arc::new(ide_ssh::SshManager::new(tmp.path().join("ssh.json"))),
        )
        .with_global_sources(global.clone());
        db.upsert_plugin_source(
            "plugin",
            "local",
            DataSource { name: "Owned".into(), save_password: true, ..Default::default() },
        )
        .await
        .unwrap();
        let owned = db.plugin_source("plugin", "local").unwrap();
        source::save_global(
            &global,
            &[DataSource { id: owned.id.clone(), name: "Global user source".into(), ..Default::default() }],
        )
        .unwrap();
        let global_store = SecretStore::new(passwords.clone(), &global);
        global_store.set(&owned.id, "user-secret").unwrap();
        db.set_password(&owned.id, Some("plugin-secret".into()), true).await.unwrap();
        assert_eq!(SecretStore::new(passwords, &root).get(&owned.id).as_deref(), Some("plugin-secret"));
        assert_eq!(global_store.get(&owned.id).as_deref(), Some("user-secret"));
        db.remove_plugin_source("plugin", "local").await.unwrap();
        assert_eq!(global_store.get(&owned.id).as_deref(), Some("user-secret"));
    }
    #[tokio::test]
    async fn a_user_source_cannot_be_claimed_by_predicting_its_id() {
        let tmp = tempfile::tempdir().unwrap();
        let db = DbManager::new(
            tmp.path().join("project"),
            tmp.path().join("passwords.json"),
            tmp.path().join("history.json"),
            std::sync::Arc::new(ide_ssh::SshManager::new(tmp.path().join("ssh.json"))),
        );
        let source = DataSource { id: source_id("plugin", "x"), name: "User".into(), ..Default::default() };
        db.save_sources(vec![source.clone()]).await.unwrap();
        assert!(db.upsert_plugin_source("plugin", "x", source.clone()).await.is_err());
        assert_eq!(db.sources().unwrap(), [source]);
    }
}
