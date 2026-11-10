//! Database ownership stays on the project host; credentials never pass back to guests.
use super::api::PluginApi;
use super::{PluginHost, WindowRequest};
use ide_core::{CancellationToken, IdeError, IdeEvent, IdeResult};
use ide_db::{DataSource, DbDriver, DbProperty};
use ide_plugin::{HostError, PluginDataSource};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

#[derive(serde::Serialize, serde::Deserialize)]
struct OwnedProject {
    root: PathBuf,
    sources: std::collections::BTreeSet<String>,
}

pub(super) fn settings(source: PluginDataSource) -> Result<DataSource, HostError> {
    let bad = || HostError::Invalid("invalid non-secret database source settings".into());
    if source.id.is_empty()
        || source.id.len() > 128
        || source.name.trim().is_empty()
        || source.name.len() > 256
        || source.id.chars().chain(source.name.chars()).any(char::is_control)
        || source.options.len() > 128
        || [&source.host, &source.database, &source.user, &source.url]
            .into_iter()
            .flatten()
            .any(|v| v.len() > 16_384 || v.contains('\0'))
    {
        return Err(bad());
    }
    let driver = match source.driver.as_str() {
        "sqlite" => DbDriver::Sqlite,
        "postgres" => DbDriver::Postgres,
        "mysql" => DbDriver::Mysql,
        "sqlServer" => DbDriver::SqlServer,
        "clickhouse" => DbDriver::Clickhouse,
        "oracle" => DbDriver::Oracle,
        _ => return Err(bad()),
    };
    let secret = |key: &str| {
        let key = key.to_ascii_lowercase();
        ["password", "passwd", "pwd", "token", "secret", "credential"].iter().any(|s| key.contains(s))
    };
    if source.options.iter().any(|(k, v)| {
        k.is_empty() || k.len() > 256 || v.len() > 16_384 || k.contains('\0') || v.contains('\0') || secret(k)
    }) {
        return Err(bad());
    }
    let mut out = DataSource {
        name: source.name,
        driver,
        host: source.host.unwrap_or_else(|| "localhost".into()),
        port: source.port,
        database: source.database.unwrap_or_default(),
        user: source.user.unwrap_or_default(),
        save_password: true,
        properties: source.options.into_iter().map(|(name, value)| DbProperty { name, value }).collect(),
        ..Default::default()
    };
    if driver == DbDriver::Sqlite {
        out.file = Some(out.database.clone().into());
    }
    if let Some(url) = source.url.filter(|u| !u.is_empty()) {
        if url.contains(';') {
            return Err(bad());
        }
        let parsed = ide_db::source::parse_url(&url).map_err(|_| bad())?;
        if parsed.password.is_some() || parsed.params.iter().any(|(k, _)| secret(k)) {
            return Err(bad());
        }
        // Case-insensitive URL credential keys must not bypass the parser's lowercase password key.
        if let Some((_, query)) = url.split_once('?') {
            for part in query.split('&') {
                let key = part.split('=').next().unwrap_or_default();
                // Parsing a synthetic URL decodes percent-encoded parameter names as well.
                let probe = ide_db::source::parse_url(&format!("postgres://host/db?{key}=x")).map_err(|_| bad())?;
                if probe.password.is_some() || probe.params.iter().any(|(k, _)| secret(k)) {
                    return Err(bad());
                }
            }
        }
        out.url_only = true;
        out.url = url;
        out.resolved().map_err(|_| bad())?;
    }
    Ok(out)
}

impl PluginApi {
    pub(super) fn database_host(&self, root: &Path) -> Result<(Arc<crate::Host>, Arc<ide_db::DbManager>), HostError> {
        let workspace = self.shared.workspace().ok_or(HostError::Cancelled)?;
        if !workspace.projects().iter().any(|r| r == root) {
            return Err(HostError::NotFound("project is not open".into()));
        }
        if !workspace.trusted(root) {
            return Err(HostError::Denied("project is not trusted".into()));
        }
        ide_plugin::resolve_new_in_root(root, ".openidea/data-sources.toml").map_err(HostError::Invalid)?;
        let host = workspace
            .database_host()
            .ok_or_else(|| HostError::Invalid("Database subsystem is unavailable on this host".into()))?;
        let db = host.projects().into_iter().find(|p| p.root == root).ok_or(HostError::Cancelled)?.db.clone();
        Ok((host, db))
    }
    pub(super) fn remember_database_project(&self, root: &Path, id: &str) -> Result<(), HostError> {
        let file = self.shared.data_dir.join(".database-projects").join(format!("{}.json", self.pkg.id()));
        let mut projects: Vec<OwnedProject> = match std::fs::read(&file) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| HostError::Failed(e.to_string()))?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => vec![],
            Err(e) => return Err(HostError::Failed(e.to_string())),
        };
        if !projects.iter().any(|p| p.root == root) {
            projects.push(OwnedProject { root: root.into(), sources: Default::default() });
        }
        let project = projects.iter_mut().find(|p| p.root == root).unwrap();
        if project.sources.insert(id.into()) {
            std::fs::create_dir_all(file.parent().unwrap()).map_err(|e| HostError::Failed(e.to_string()))?;
            ide_vfs::write_atomic(&file, &serde_json::to_vec(&projects).unwrap()).map_err(error)?;
        }
        Ok(())
    }
    pub(super) fn connect_database(
        &self,
        root: &Path,
        client: &str,
        id: &str,
        cancel: &CancellationToken,
        timeout: Duration,
    ) -> Result<(), HostError> {
        let (_, db) = self.database_host(root)?;
        if self.shared.project_of(client).as_deref() != Some(root) {
            return Err(HostError::Invalid("requires this project's invoking window".into()));
        }
        let source = db.plugin_source(self.pkg.id(), id).map_err(error)?;
        self.window_request(client, WindowRequest::DatabaseConnect { id: source.id }, cancel, timeout).map(|_| ())
    }
}

pub(super) fn changed(host: &crate::Host, root: &Path) {
    for project in host.projects().into_iter().filter(|p| p.root == root) {
        project.sink.emit(IdeEvent::DbSourcesChanged);
    }
}
impl PluginHost {
    pub(super) fn remove_database_sources(&self, plugin: &str) -> IdeResult<()> {
        let file = self.shared.data_dir.join(".database-projects").join(format!("{plugin}.json"));
        let projects: Vec<OwnedProject> = match std::fs::read(&file) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| IdeError::invalid(e.to_string()))?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(e.into()),
        };
        let host = self
            .shared
            .workspace()
            .and_then(|w| w.database_host())
            .ok_or_else(|| IdeError::unavailable("Database subsystem is unavailable on this host"))?;
        for project in projects {
            let root = project.root;
            let removed = ide_db::plugin::remove_all(&root, plugin)?;
            let store = ide_db::secrets::SecretStore::new(host.data_dir.join("db-passwords.json"), &root);
            let ids: std::collections::BTreeSet<_> = project
                .sources
                .iter()
                .map(|id| ide_db::plugin::source_id(plugin, id))
                .chain(removed.into_iter().map(|source| source.id))
                .collect();
            for id in ids {
                store.delete(&id);
                store.delete(&ide_db::secrets::ssh_key(&id));
                for project in host.projects().into_iter().filter(|p| p.root == root) {
                    host.runtime.block_on(project.db.forget_plugin_source(&id));
                }
            }
            changed(&host, &root);
        }
        std::fs::remove_file(file)?;
        Ok(())
    }
}

pub(super) fn error(e: IdeError) -> HostError {
    use ide_core::error::ErrorKind;
    match e.kind {
        ErrorKind::NotFound => HostError::NotFound(e.message),
        ErrorKind::InvalidInput => HostError::Invalid(e.message),
        ErrorKind::PermissionDenied => HostError::Denied(e.message),
        _ => HostError::Failed(e.message),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn source() -> PluginDataSource {
        PluginDataSource { id: "local".into(), name: "Local".into(), driver: "postgres".into(), ..Default::default() }
    }
    #[test]
    fn rejects_secrets_without_echoing_them_and_documents_every_driver_id() {
        for driver in ["sqlite", "postgres", "mysql", "sqlServer", "clickhouse", "oracle"] {
            assert!(settings(PluginDataSource { driver: driver.into(), ..source() }).is_ok(), "{driver}");
        }
        for url in [
            "postgres://user:top-secret@host/db",
            "postgres://host/db?password=top-secret",
            "postgres://host/db?PASSWORD=top-secret",
            "postgres://host/db?to%6ben=top-secret",
        ] {
            let error = settings(PluginDataSource { url: Some(url.into()), ..source() }).unwrap_err();
            assert!(!error.to_string().contains("top-secret"));
        }
        for key in ["password", "accessToken", "client_secret", "PWD"] {
            assert!(
                settings(PluginDataSource { options: vec![(key.into(), "top-secret".into())], ..source() }).is_err()
            );
        }
        let source = settings(PluginDataSource {
            url: Some("postgres://reader@host:5433/db?sslmode=require".into()),
            options: vec![("application_name".into(), "Example".into())],
            ..source()
        })
        .unwrap();
        assert_eq!(source.resolved().unwrap().host, "host");
    }
}
