//! Only an explicit desktop action can trust a helper. The project file is portable;
//! the authorization belongs to this machine and to the reviewed destination.
use crate::{DataSource, DbDriver, DbExternalTunnel, DbManager, DbSslMode, local_settings::persist_local};
use ide_core::{IdeError, IdeResult};
use std::path::{Path, PathBuf};

impl DbManager {
    pub fn with_local_external_tunnels(mut self, enabled: bool) -> Self {
        self.local_external_tunnels = enabled;
        self
    }

    pub(super) fn external_config<'a>(&self, source: &'a DataSource) -> IdeResult<&'a DbExternalTunnel> {
        if !self.local_external_tunnels {
            return Err(IdeError::invalid("External database tunnels require a local desktop project"));
        }
        if source.driver != DbDriver::Postgres || source.plugin_owner.is_some() || source.url_only {
            return Err(IdeError::invalid(
                "Use a user-managed PostgreSQL source with host and port for an external tunnel",
            ));
        }
        if source.ssh.as_ref().is_some_and(|ssh| ssh.enabled) {
            return Err(IdeError::invalid("Choose either SSH or an external tunnel"));
        }
        if source.ssl == DbSslMode::VerifyFull {
            return Err(IdeError::invalid(
                "Verify Full needs the remote TLS hostname, which this tunnel transport cannot supply",
            ));
        }
        let config =
            source.external_tunnel.as_ref().ok_or_else(|| IdeError::invalid("Choose an external tunnel helper"))?;
        crate::external_tunnel::ExternalTunnel::validate(config, crate::tunnel_target(source))?;
        Ok(config)
    }

    fn external_approval(&self, source: &DataSource) -> IdeResult<(PathBuf, String)> {
        let config = self.external_config(source)?;
        let dir = &self.global.as_ref().ok_or_else(|| IdeError::invalid("Local database settings unavailable"))?.0;
        let key = serde_json::to_vec(&((!source.global).then_some(&self.root), &source.id))
            .map_err(|e| IdeError::internal(e.to_string()))?;
        let settings = serde_json::to_vec(&(
            config,
            crate::tunnel_target(source),
            &source.user,
            &source.database,
            &source.ssl,
            &source.ssl_ca_file,
            &source.ssl_cert_file,
            &source.ssl_key_file,
            source.read_only,
            &source.properties,
            &source.options,
        ))
        .map_err(|e| IdeError::internal(e.to_string()))?;
        Ok((
            dir.join("database-tunnel-approvals").join(blake3::hash(&key).to_hex().as_str()),
            blake3::hash(&settings).to_string(),
        ))
    }

    /// Called only after the local connection dialog shows the executable, arguments and destination.
    pub async fn approve_external_tunnel(&self, source: &DataSource) -> IdeResult<()> {
        let (path, settings) = self.external_approval(source)?;
        let program = self.external_config(source)?.executable.clone();
        tokio::task::spawn_blocking(move || {
            let identity = executable_identity(Path::new(&program))?;
            persist_local(&path, format!("{settings}\n{identity}").as_bytes())
        })
        .await
        .map_err(|e| IdeError::internal(e.to_string()))?
    }

    pub(super) async fn check_external_approval(&self, source: &DataSource) -> IdeResult<()> {
        let (path, settings) = self.external_approval(source)?;
        let program = self.external_config(source)?.executable.clone();
        tokio::task::spawn_blocking(move || {
            let review = || {
                IdeError::invalid("Review the external tunnel in SSH/SSL and save the data source before connecting")
            };
            let approval = std::fs::read_to_string(path).map_err(|_| review())?;
            let (saved, identity) = approval.split_once('\n').ok_or_else(review)?;
            // Avoid touching a program named by an unapproved project file.
            if saved != settings || identity != executable_identity(Path::new(&program))? {
                return Err(review());
            }
            Ok(())
        })
        .await
        .map_err(|e| IdeError::internal(e.to_string()))?
    }
}

fn executable_identity(program: &Path) -> IdeResult<String> {
    let path = std::fs::canonicalize(program)?;
    if !path.is_file() {
        return Err(IdeError::invalid("The external tunnel helper must be an executable file"));
    }
    let mut hash = blake3::Hasher::new();
    hash.update(path.as_os_str().as_encoded_bytes());
    hash.update(&[0]);
    hash.update_reader(std::fs::File::open(path)?)?;
    Ok(hash.finalize().to_string())
}
