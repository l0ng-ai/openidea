//! Remote work over SSH: SFTP deployment ([`deploy`], [`mapping`]) and run
//! configurations on run targets ([`target`]; Docker and Compose ones in [`docker`]).

pub mod deploy;
pub mod devcontainer;
pub mod docker;
pub mod import;
pub mod mapping;
pub mod service;
pub mod target;

pub use deploy::{
    Deployment, DeploymentCoverage, SyncAction, SyncEntry, SyncStatus, SyncStep, TransferReport, coverage,
};
pub use mapping::{Excludes, Mappings, ResolvedMapping};
pub use service::{DeployedPath, DeploymentRoot, RemoteService};
pub use target::{RemoteRuns, RemoteStart};
