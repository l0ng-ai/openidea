//! `openidea-server --stdio`: the IDE backend for remote development, serving
//! one desktop client over stdin / stdout (started by the client over SSH).

use ide_host::plugins::remote::{RemotePluginLanguages, SYNC_COMMAND};
use ide_host::plugins::remote_host::RemotePlugins;
use ide_host::rpc::{self, Dispatcher};
use ide_host::{Host, HostConfig};
use ide_language::LanguageRegistry;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "--version") {
        println!("openidea-server {} (protocol {})", env!("CARGO_PKG_VERSION"), rpc::PROTOCOL_VERSION);
        return;
    }
    if args.first().is_some_and(|a| a == "--connect") {
        // One forwarded connection (see `ide_host::relay`): stdout carries its bytes.
        let code = match ide_host::relay::parse_args(&args[1..]).and_then(|(host, port)| {
            ide_host::relay::relay(&host, port, std::io::stdin(), std::io::stdout().lock())
                .map_err(|e| format!("cannot connect to {host}:{port}: {e}"))
        }) {
            Ok(()) => 0,
            Err(e) => {
                eprintln!("{e}");
                1
            }
        };
        std::process::exit(code);
    }
    let listen = args.iter().position(|a| a == "--listen").and_then(|i| args.get(i + 1)).map(|s| s.to_string());
    if listen.is_none() && !args.iter().any(|a| a == "--stdio") {
        eprintln!("usage: openidea-server --stdio | --listen <addr> | --connect <host> <port> | --version");
        std::process::exit(2);
    }
    if let Some(addr) = &listen {
        // TCP gives the socket's client the whole host API — files, processes,
        // terminals. The per-launch secret (`OPENIDEA_LISTEN_SECRET` or the one
        // generated and printed to stderr) is the only thing between a connecting
        // client and remote code execution, so non-loopback binds need a warning.
        let parsed = addr.parse::<std::net::SocketAddr>().ok().or_else(|| {
            addr.rsplit_once(':').and_then(|(host, port)| {
                let ip: std::net::IpAddr = host.parse().ok()?;
                Some(std::net::SocketAddr::new(ip, port.parse().ok()?))
            })
        });
        match parsed {
            Some(a) if a.ip().is_loopback() => {}
            Some(a) => eprintln!(
                "warning: --listen {a} accepts connections from other machines; \
                 keep it behind an authenticated tunnel (SSH) — the protocol is plaintext"
            ),
            None => eprintln!("warning: cannot tell whether --listen {addr} is loopback; plaintext protocol"),
        }
    }
    // stdout carries the protocol: logs go to stderr.
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_env("OPENIDEA_LOG").unwrap_or_else(|_| "info".into()))
        .init();
    let home = dirs::home_dir().unwrap_or_default();
    let base = std::env::var_os("OPENIDEA_SERVER_HOME").map(PathBuf::from).unwrap_or_else(|| home.join(".openidea"));
    // An SSH exec channel gets a minimal environment: take the login shell's, read
    // afresh on every start, plus the IDE-managed tools. Before any other thread starts.
    ide_host::shell_env::inherit_login_shell_env("openidea-server");
    let data_dir = base.join("data");
    ide_tools::extend_process_path(&data_dir);
    ide_dap::adapter::set_tools_root(ide_tools::tools_dir(&data_dir));
    ide_sdk::java::add_jdk_root(&ide_tools::jdk::jdks_dir(&data_dir));
    let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build().expect("tokio runtime");
    let code = runtime.block_on(async move {
        match listen {
            Some(addr) => run_listen(base, addr).await,
            None => run(base).await,
        }
    });
    std::process::exit(code);
}

async fn run(base: PathBuf) -> i32 {
    let (config_dir, data_dir) = (base.join("config"), base.join("data"));
    for dir in [&config_dir, &data_dir] {
        if let Err(e) = std::fs::create_dir_all(dir) {
            eprintln!("cannot create {}: {e}", dir.display());
            return 1;
        }
    }
    let languages = match LanguageRegistry::load(Some(&config_dir.join("languages"))) {
        Ok(l) => Arc::new(l),
        Err(e) => {
            eprintln!("language definitions: {e}");
            return 1;
        }
    };
    // The desktop's plugin languages (`plugin_sync_languages`); programs pinned on this machine.
    let plugin_languages = RemotePluginLanguages::new(Some(&data_dir));
    languages.attach_plugins(plugin_languages.store().clone());
    let peer = Arc::new(OnceLock::new());
    let sink_peer = peer.clone();
    let plugins_data = data_dir.clone();
    let host = Arc::new(Host::new(HostConfig {
        config_dir,
        local_data_dir: data_dir.clone(),
        data_dir,
        languages,
        syntax: Arc::default(),
        sink_for: Box::new(move |window| rpc::event_sink(sink_peer.clone(), Some(window.to_owned()))),
        owner: |w| w,
        runtime: tokio::runtime::Handle::current(),
        project_environment: true,
    }));
    // The desktop's code plugins run here, next to the project (`plugin_sync_packages`).
    let plugins = match RemotePlugins::start(&plugins_data, &host, peer.clone()) {
        Ok(p) => Some(p),
        Err(e) => {
            tracing::warn!("plugins are unavailable: {e}");
            None
        }
    };
    if let Some(root) = std::env::var_os(ide_host::trust::TRUSTED_ROOT_ENV)
        && let Err(e) = host.trust.inherit(std::path::Path::new(&root))
    {
        tracing::warn!("cannot trust {}: {e}", root.to_string_lossy());
    }
    tracing::info!("openidea-server {} ready", env!("CARGO_PKG_VERSION"));
    let mut dispatcher = Dispatcher::standard();
    if let Some(plugins) = &plugins {
        plugins.register(&mut dispatcher);
    }
    dispatcher.add(SYNC_COMMAND, move |c| {
        let remote = plugin_languages.clone();
        async move {
            let report = remote.sync(c.arg("languages")?);
            c.host.plugin_languages_changed();
            Ok(report)
        }
    });
    rpc::serve(host.clone(), dispatcher, peer, tokio::io::stdin(), tokio::io::stdout()).await;
    if let Some(plugins) = &plugins {
        plugins.host().shutdown();
    }
    // `process::exit` skips destructors: nothing started for the client may outlive it.
    if tokio::time::timeout(std::time::Duration::from_secs(10), host.shutdown()).await.is_err() {
        tracing::warn!("language servers did not shut down in time");
    }
    0
}

/// The per-launch secret a TCP client must send in `initialize` before any other
/// request: `OPENIDEA_LISTEN_SECRET` when the launcher chose one, else a random
/// token printed to stderr (the launcher's channel back).
fn listen_secret() -> String {
    if let Ok(secret) = std::env::var("OPENIDEA_LISTEN_SECRET")
        && !secret.is_empty()
    {
        return secret;
    }
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).expect("system randomness");
    let secret = bytes.iter().map(|b| format!("{b:02x}")).collect::<String>();
    eprintln!("OPENIDEA_LISTEN_SECRET={secret}");
    secret
}

async fn run_listen(base: PathBuf, addr: String) -> i32 {
    let secret = listen_secret();
    let (config_dir, data_dir) = (base.join("config"), base.join("data"));
    for dir in [&config_dir, &data_dir] {
        if let Err(e) = std::fs::create_dir_all(dir) {
            eprintln!("cannot create {}: {e}", dir.display());
            return 1;
        }
    }
    let languages = match LanguageRegistry::load(Some(&config_dir.join("languages"))) {
        Ok(l) => Arc::new(l),
        Err(e) => {
            eprintln!("language definitions: {e}");
            return 1;
        }
    };
    let plugin_languages = RemotePluginLanguages::new(Some(&data_dir));
    languages.attach_plugins(plugin_languages.store().clone());
    // Every accepted connection gets its own `Peer`; events from all windows
    // broadcast to every connected client.
    let peers: Arc<parking_lot::Mutex<Vec<ide_jsonrpc::Peer>>> = Arc::new(parking_lot::Mutex::new(Vec::new()));
    let sink_peers = peers.clone();
    let plugins_data = data_dir.clone();
    let host = Arc::new(Host::new(HostConfig {
        config_dir,
        local_data_dir: data_dir.clone(),
        data_dir,
        languages,
        syntax: Arc::default(),
        sink_for: Box::new(move |window| {
            let peers = sink_peers.clone();
            let window = window.to_owned();
            Arc::new(BroadcastSink { peers, window }) as ide_core::SharedSink
        }),
        owner: |w| w,
        runtime: tokio::runtime::Handle::current(),
        project_environment: true,
    }));
    let plugins = match RemotePlugins::start(&plugins_data, &host, Arc::new(OnceLock::new())) {
        Ok(p) => Some(p),
        Err(e) => {
            tracing::warn!("plugins are unavailable: {e}");
            None
        }
    };
    if let Some(root) = std::env::var_os(ide_host::trust::TRUSTED_ROOT_ENV)
        && let Err(e) = host.trust.inherit(std::path::Path::new(&root))
    {
        tracing::warn!("cannot trust {}: {e}", root.to_string_lossy());
    }
    let listener = match tokio::net::TcpListener::bind(&addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("cannot listen on {addr}: {e}");
            return 1;
        }
    };
    let bound = listener.local_addr().map(|a| a.to_string()).unwrap_or_else(|_| addr.clone());
    tracing::info!("openidea-server {} listening on {bound}", env!("CARGO_PKG_VERSION"));
    let mut dispatcher = Dispatcher::standard();
    if let Some(plugins) = &plugins {
        plugins.register(&mut dispatcher);
    }
    dispatcher.add(SYNC_COMMAND, move |c| {
        let remote = plugin_languages.clone();
        async move {
            let report = remote.sync(c.arg("languages")?);
            c.host.plugin_languages_changed();
            Ok(report)
        }
    });
    loop {
        let (stream, client_addr) = match listener.accept().await {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!("accept: {e}");
                continue;
            }
        };
        tracing::info!("client connected from {client_addr}");
        let host = host.clone();
        let dispatcher = dispatcher.clone();
        let peers = peers.clone();
        let secret = secret.clone();
        tokio::spawn(async move {
            let (reader, writer) = tokio::io::split(stream);
            let peer = Arc::new(OnceLock::new());
            let p = rpc::serve_listen(host, dispatcher, peer.clone(), reader, writer, secret).await;
            peers.lock().push(p.clone());
            p.closed().await;
            peers.lock().retain(|other| !std::ptr::eq(other, &p));
            tracing::info!("client {client_addr} disconnected");
        });
    }
}

/// Broadcasts window events to every connected client.
struct BroadcastSink {
    peers: Arc<parking_lot::Mutex<Vec<ide_jsonrpc::Peer>>>,
    window: String,
}

impl ide_core::EventSink for BroadcastSink {
    fn emit(&self, event: ide_core::IdeEvent) {
        let msg = rpc::EventMessage { window: Some(self.window.clone()), event };
        let peers = self.peers.lock();
        for peer in peers.iter() {
            let _ = peer.notify("event", msg.clone());
        }
    }
}
