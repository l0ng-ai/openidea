//! Remote work over SSH: SFTP deployment ([`deploy`], [`mapping`]) and run
//! configurations on run targets ([`target`]).

pub mod deploy;
pub mod mapping;
pub mod service;
pub mod target;

pub use deploy::{Deployment, SyncAction, SyncEntry, SyncStatus, SyncStep, TransferReport};
pub use mapping::{Excludes, Mappings};
pub use service::{DeployedPath, RemoteService};
pub use target::{RemoteRuns, RemoteStart};
