//! The introspected catalog of a data source, kept on disk: the schemas, tables and views of
//! its databases, so completion knows them from the start of the next run without reading the
//! server again. Names only — no data, no credentials. One file per project and data source in
//! the app data directory.

use crate::TableInfo;
use ide_core::{IdeError, IdeResult};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::{Path, PathBuf};

/// A schema of a database and its tables and views.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
#[serde(rename = "DbCatalogSchema")]
pub struct CatalogSchema {
    pub name: String,
    pub tables: Vec<TableInfo>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
#[serde(rename = "DbCatalogDatabase")]
pub struct CatalogDatabase {
    pub name: String,
    /// When this database was read, in milliseconds since the Unix epoch.
    pub read_at: f64,
    pub schemas: Vec<CatalogSchema>,
}

/// What introspection has read of a data source.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", default)]
#[serde(rename = "DbSourceCatalog")]
pub struct SourceCatalog {
    pub databases: Vec<CatalogDatabase>,
}

pub(crate) struct CatalogStore {
    dir: PathBuf,
    project: String,
    /// One writer at a time: an update reads the file, changes a database and writes it back.
    writing: tokio::sync::Mutex<()>,
}

fn now_ms() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0.0, |d| d.as_millis() as f64)
}

impl CatalogStore {
    pub(crate) fn new(dir: PathBuf, root: &Path) -> Self {
        Self { dir, project: root.to_string_lossy().into_owned(), writing: tokio::sync::Mutex::new(()) }
    }

    fn file(&self, id: &str) -> PathBuf {
        let name = blake3::hash(format!("{}\0{id}", self.project).as_bytes()).to_hex();
        self.dir.join(format!("{}.json", &name.as_str()[..32]))
    }

    fn read(file: &Path) -> SourceCatalog {
        std::fs::read(file).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default()
    }

    fn write(file: &Path, catalog: &SourceCatalog) -> IdeResult<()> {
        if let Some(dir) = file.parent() {
            std::fs::create_dir_all(dir)?;
        }
        // Written beside the file and moved over it, so a crash leaves the old catalog whole.
        let partial = file.with_extension("json.part");
        let bytes = serde_json::to_vec(catalog).map_err(|e| IdeError::internal(e.to_string()))?;
        std::fs::write(&partial, bytes)?;
        std::fs::rename(&partial, file)?;
        Ok(())
    }

    async fn blocking<T: Send + 'static>(task: impl FnOnce() -> T + Send + 'static) -> IdeResult<T> {
        tokio::task::spawn_blocking(task).await.map_err(|e| IdeError::internal(e.to_string()))
    }

    /// The saved catalog of data source `id` (`None`: never introspected).
    pub(crate) async fn load(&self, id: &str) -> IdeResult<Option<SourceCatalog>> {
        let file = self.file(id);
        Self::blocking(move || file.exists().then(|| Self::read(&file))).await
    }

    /// Saves what was just read of `database`, replacing what was known of it.
    pub(crate) async fn put(&self, id: &str, database: &str, schemas: Vec<CatalogSchema>) -> IdeResult<()> {
        let _writing = self.writing.lock().await;
        let (file, name) = (self.file(id), database.to_owned());
        Self::blocking(move || {
            let mut catalog = Self::read(&file);
            catalog.databases.retain(|d| d.name != name);
            catalog.databases.push(CatalogDatabase { name, read_at: now_ms(), schemas });
            catalog.databases.sort_by(|a, b| a.name.cmp(&b.name));
            Self::write(&file, &catalog)
        })
        .await?
    }

    /// Forgets the databases not in `keep` (dropped on the server, or no longer shown).
    pub(crate) async fn retain(&self, id: &str, keep: Vec<String>) -> IdeResult<()> {
        let _writing = self.writing.lock().await;
        let file = self.file(id);
        Self::blocking(move || {
            if !file.exists() {
                return Ok(());
            }
            let mut catalog = Self::read(&file);
            let before = catalog.databases.len();
            catalog.databases.retain(|d| keep.contains(&d.name));
            if catalog.databases.len() == before { Ok(()) } else { Self::write(&file, &catalog) }
        })
        .await?
    }

    /// Deletes the saved catalog of data source `id` (the data source was removed).
    pub(crate) fn forget(&self, id: &str) {
        let _ = std::fs::remove_file(self.file(id));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::DbTableKind;

    fn schema(name: &str, tables: &[&str]) -> CatalogSchema {
        CatalogSchema {
            name: name.into(),
            tables: tables.iter().map(|t| TableInfo { name: (*t).into(), kind: DbTableKind::Table }).collect(),
        }
    }

    #[tokio::test]
    async fn a_catalog_survives_a_restart_per_project_and_data_source() {
        let dir = tempfile::tempdir().unwrap();
        let store = CatalogStore::new(dir.path().join("db-catalogs"), Path::new("/projects/shop"));
        assert_eq!(store.load("sf").await.unwrap(), None);
        store.put("sf", "RAW", vec![schema("PUBLIC", &["EVENTS"])]).await.unwrap();
        store
            .put("sf", "ANALYTICS", vec![schema("PUBLIC", &["ORDERS", "USERS"]), schema("STAGING", &[])])
            .await
            .unwrap();

        // A new store over the same directory: what the next run of the app sees.
        let reopened = CatalogStore::new(dir.path().join("db-catalogs"), Path::new("/projects/shop"));
        let saved = reopened.load("sf").await.unwrap().unwrap();
        assert_eq!(saved.databases.iter().map(|d| d.name.as_str()).collect::<Vec<_>>(), ["ANALYTICS", "RAW"]);
        assert_eq!(saved.databases[0].schemas, vec![schema("PUBLIC", &["ORDERS", "USERS"]), schema("STAGING", &[])]);
        assert!(saved.databases.iter().all(|d| d.read_at > 0.0));

        // Another data source and another project keep their own.
        assert_eq!(reopened.load("other").await.unwrap(), None);
        let elsewhere = CatalogStore::new(dir.path().join("db-catalogs"), Path::new("/projects/blog"));
        assert_eq!(elsewhere.load("sf").await.unwrap(), None);
    }

    #[tokio::test]
    async fn rereading_replaces_a_database_and_dropped_ones_are_forgotten() {
        let dir = tempfile::tempdir().unwrap();
        let store = CatalogStore::new(dir.path().to_path_buf(), Path::new("/p"));
        store.put("sf", "RAW", vec![schema("PUBLIC", &["OLD"])]).await.unwrap();
        store.put("sf", "GONE", vec![schema("PUBLIC", &["T"])]).await.unwrap();
        store.put("sf", "RAW", vec![schema("PUBLIC", &["NEW"])]).await.unwrap();
        store.retain("sf", vec!["RAW".into()]).await.unwrap();
        let saved = store.load("sf").await.unwrap().unwrap();
        assert_eq!(saved.databases.len(), 1);
        assert_eq!(saved.databases[0].schemas, vec![schema("PUBLIC", &["NEW"])]);
        // Nothing half-written is left beside the file.
        let files: Vec<_> = std::fs::read_dir(dir.path()).unwrap().map(|f| f.unwrap().file_name()).collect();
        assert_eq!(files.len(), 1);

        store.forget("sf");
        assert_eq!(store.load("sf").await.unwrap(), None);
        store.retain("sf", vec![]).await.unwrap();
        assert_eq!(store.load("sf").await.unwrap(), None);
    }

    #[tokio::test]
    async fn a_damaged_file_reads_as_an_empty_catalog() {
        let dir = tempfile::tempdir().unwrap();
        let store = CatalogStore::new(dir.path().to_path_buf(), Path::new("/p"));
        std::fs::write(store.file("sf"), b"{ not json").unwrap();
        assert_eq!(store.load("sf").await.unwrap(), Some(SourceCatalog::default()));
        store.put("sf", "RAW", vec![schema("PUBLIC", &["T"])]).await.unwrap();
        assert_eq!(store.load("sf").await.unwrap().unwrap().databases.len(), 1);
    }
}
