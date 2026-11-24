//! A connection target owns its pool and keeps its data source's forwarding route alive.
//! Concurrent opens of sibling databases share a helper, but unrelated sources never wait on it.
use super::*;
use external_tunnel::ExternalTunnel;
use std::sync::Weak;
use tokio::sync::OnceCell;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum RouteUse {
    Connect,
    Test,
    ReviewedExternalTest,
}

pub(super) enum Route {
    Ssh(Tunnel),
    External(ExternalTunnel),
}

impl Route {
    fn port(&self) -> u16 {
        match self {
            Self::Ssh(t) => t.port(),
            Self::External(t) => t.port(),
        }
    }

    fn is_closed(&self) -> bool {
        match self {
            Self::Ssh(t) => t.is_closed(),
            Self::External(t) => t.is_closed(),
        }
    }
}

type RouteSlot = Arc<OnceCell<Route>>;
// The file watcher may observe a source edit after a new caller already read it.
pub(super) struct CachedRoute {
    host: String,
    port: u16,
    ssh: Option<DbSsh>,
    helper: Option<DbExternalTunnel>,
    slot: Weak<OnceCell<Route>>,
}

impl CachedRoute {
    fn matches(&self, source: &DataSource) -> bool {
        let (host, port) = tunnel_target(source);
        self.host == host && self.port == port && self.ssh == source.ssh && self.helper == source.external_tunnel
    }
}

pub(super) type Routes = Mutex<HashMap<String, CachedRoute>>;

#[derive(Clone)]
pub(super) struct Connection {
    pub(super) pool: Arc<Pool>,
    route: Option<RouteSlot>,
}

impl Connection {
    pub(super) fn target(&self, source: &DataSource) -> DataSource {
        routed_target(source, self.route.as_ref())
    }

    fn is_closed(&self) -> bool {
        self.pool.is_closed() || self.route.as_ref().and_then(|s| s.get()).is_some_and(Route::is_closed)
    }
}

#[derive(Default)]
pub(super) struct ConnectionSlot {
    pub(super) value: OnceCell<Connection>,
    pub(super) cancel: CancellationToken,
}

fn routed_target(source: &DataSource, slot: Option<&RouteSlot>) -> DataSource {
    match slot.and_then(|s| s.get()) {
        Some(route) => DataSource { host: "127.0.0.1".into(), port: Some(route.port()), ..source.clone() },
        None => source.clone(),
    }
}

impl DbManager {
    pub(super) async fn endpoint(
        &self,
        source: &DataSource,
        ssh_secret: Option<String>,
        purpose: RouteUse,
    ) -> IdeResult<(DataSource, Option<RouteSlot>)> {
        let external = source.external_tunnel.as_ref();
        let ssh = source.ssh.as_ref().filter(|ssh| ssh.enabled && tunneled(source.driver));
        if external.is_none() && ssh.is_none() {
            return Ok((source.clone(), None));
        }
        if external.is_some() {
            match purpose {
                RouteUse::Connect => self.check_external_approval(source).await?,
                RouteUse::ReviewedExternalTest => {
                    self.external_config(source)?;
                }
                RouteUse::Test => {
                    return Err(IdeError::invalid("Review the external tunnel in the local Test Connection dialog"));
                }
            }
        }
        let slot = if purpose == RouteUse::Connect {
            let mut routes = self.routes.lock();
            if let Some(slot) = routes.get(&source.id).filter(|r| r.matches(source)).and_then(|r| r.slot.upgrade())
                && !slot.get().is_some_and(Route::is_closed)
            {
                slot
            } else {
                routes.retain(|_, r| r.slot.strong_count() > 0);
                let slot = Arc::new(OnceCell::new());
                let (host, port) = tunnel_target(source);
                routes.insert(
                    source.id.clone(),
                    CachedRoute {
                        host: host.to_owned(),
                        port,
                        ssh: source.ssh.clone(),
                        helper: source.external_tunnel.clone(),
                        slot: Arc::downgrade(&slot),
                    },
                );
                slot
            }
        } else {
            Arc::new(OnceCell::new())
        };
        slot.get_or_try_init(|| async {
            if let Some(config) = external {
                ExternalTunnel::open(config, tunnel_target(source)).await.map(Route::External)
            } else {
                let ssh = ssh.expect("enabled SSH transport");
                let session = self.ssh_session(source, ssh, ssh_secret).await?;
                let (host, port) = tunnel_target(source);
                Tunnel::open(session, host, port).await.map(Route::Ssh)
            }
        })
        .await?;
        Ok((routed_target(source, Some(&slot)), Some(slot)))
    }

    pub(super) fn connection_error(&self, error: IdeError, source: &DataSource) -> IdeError {
        if source.external_tunnel.is_some() && error.kind == ErrorKind::Io {
            return IdeError::new(error.kind, format!("{} through the external database tunnel", error.message));
        }
        let via = source.ssh.as_ref().filter(|s| s.enabled && tunneled(source.driver)).map(|ssh| self.ssh_label(ssh));
        through_tunnel(error, source, via.as_deref())
    }

    pub fn is_connected(&self, id: &str) -> bool {
        self.pools.lock().get(id).and_then(|slot| slot.value.get()).is_some_and(|c| !c.is_closed())
    }

    pub fn connected(&self) -> Vec<String> {
        self.pools
            .lock()
            .iter()
            .filter(|(_, s)| s.value.get().is_some_and(|c| !c.is_closed()))
            .map(|(id, _)| id.clone())
            .collect()
    }

    pub async fn pool(&self, id: &str) -> IdeResult<Arc<Pool>> {
        Ok(self.connection(id).await?.pool)
    }

    pub(super) async fn connection(&self, id: &str) -> IdeResult<Connection> {
        let (slot, stale) = {
            let mut pools = self.pools.lock();
            let stale = if pools.get(id).and_then(|s| s.value.get()).is_some_and(Connection::is_closed) {
                pools.remove(id)
            } else {
                None
            };
            (pools.entry(id.into()).or_default().clone(), stale)
        };
        if let Some(stale) = stale {
            self.close_target(id, stale).await;
        }
        let result = tokio::select! {
            biased;
            _ = slot.cancel.cancelled() => Err(IdeError::cancelled()),
            result = slot.value.get_or_try_init(|| self.open_connection(id)) => result.cloned(),
        };
        if result.is_err() {
            let mut pools = self.pools.lock();
            if Arc::strong_count(&slot) == 2 && pools.get(id).is_some_and(|s| Arc::ptr_eq(s, &slot)) {
                pools.remove(id);
            }
        }
        result
    }

    async fn open_connection(&self, id: &str) -> IdeResult<Connection> {
        let (source_id, database) = split_target(id);
        let mut source = self.source(source_id)?;
        let password = self.password(&source).await;
        // The approval belongs to the configured source, including its login database.
        // Sibling database selection changes only the driver's target after routing.
        let (mut target, route) = self.endpoint(&source, None, RouteUse::Connect).await?;
        target.select_database(database);
        source.select_database(database);
        self.restore_sso(&source).await;
        let result = self.open_pool(&target, password.as_deref(), false).await;
        self.keep_sso(&source).await;
        let pool = Arc::new(result.map_err(|e| self.connection_error(e, &source))?);
        if let Some(secs) = source.options.keep_alive_secs.filter(|s| *s > 0) {
            keep_alive(&pool, Duration::from_secs(secs.into()));
        }
        Ok(Connection { pool, route })
    }

    async fn close_target(&self, id: &str, slot: Arc<ConnectionSlot>) {
        slot.cancel.cancel();
        // A held transaction or result cursor keeps the pool from closing.
        let session = self.sessions.lock().get(id).cloned();
        if let Some(s) = session {
            end_session(&s).await;
        }
        self.cursors.release_target(id);
        if let Some(c) = slot.value.get() {
            c.pool.close().await;
        }
    }

    pub async fn disconnect(&self, id: &str) {
        let slot = self.pools.lock().remove(id);
        if let Some(slot) = slot {
            self.close_target(id, slot).await;
        }
    }

    pub async fn disconnect_source(&self, id: &str) {
        let closing: Vec<_> = {
            let mut pools = self.pools.lock();
            let mut routes = self.routes.lock();
            routes.remove(id);
            pools.extract_if(|key, _| split_target(key).0 == id).collect()
        };
        for (_, slot) in &closing {
            slot.cancel.cancel();
        }
        for (target, slot) in closing {
            self.close_target(&target, slot).await;
        }
    }
}
