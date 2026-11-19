//! `openidea-server`: the IDE backend for remote development, either serving one
//! desktop client over stdin / stdout (`--stdio`) or running as a persistent
//! per-project daemon (`--attach <project>` / `--daemon <socket>`).

use ide_host::catalogue::TrustClass;
use ide_host::plugins::remote::{RemotePluginLanguages, SYNC_COMMAND};
use ide_host::plugins::remote_host::RemotePlugins;
use ide_host::rpc::{self, Dispatcher};
use ide_host::{Host, HostConfig};
use ide_language::LanguageRegistry;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

enum Mode {
    Stdio,
    #[cfg(unix)]
    Daemon(PathBuf),
}

fn main() {
    let raw_args: Vec<String> = std::env::args().collect();
    if let Some(project) = ide_mcp::stdio_request(&raw_args) {
        let base = server_home();
        std::process::exit(ide_mcp::stdio::run(&ide_mcp::discovery_path(&base.join("data")), project));
    }
    let args: Vec<String> = raw_args.into_iter().skip(1).collect();
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
    let base = server_home();
    #[cfg(unix)]
    if args.first().is_some_and(|a| a == "--attach") {
        let Some(project_path) = args.get(1).filter(|p| !p.is_empty()) else {
            eprintln!("usage: openidea-server --attach <project-path>");
            std::process::exit(2);
        };
        let home = dirs::home_dir().unwrap_or_default();
        let code =
            match ide_host::daemon::attach(&base, &home, project_path, std::io::stdin(), std::io::stdout().lock()) {
                Ok(()) => 0,
                Err(e) => {
                    eprintln!("{e}");
                    1
                }
            };
        std::process::exit(code);
    }
    let mode = match args.as_slice() {
        #[cfg(unix)]
        [flag, sock] if flag == "--daemon" => Mode::Daemon(PathBuf::from(sock)),
        #[cfg(not(unix))]
        [flag, _] if flag == "--attach" => Mode::Stdio,
        _ if args.iter().any(|a| a == "--stdio") => Mode::Stdio,
        _ => {
            eprintln!(
                "usage: openidea-server --stdio | --attach <project-path> | --mcp-stdio [--project <path>] | --connect <host> <port> | --version"
            );
            std::process::exit(2);
        }
    };
    // stdout carries the protocol: logs go to stderr.
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_env("OPENIDEA_LOG").unwrap_or_else(|_| "info".into()))
        .init();
    // An SSH exec channel gets a minimal environment: take the login shell's, read
    // afresh on every start, plus the IDE-managed tools. Before any other thread starts.
    ide_host::shell_env::inherit_login_shell_env("openidea-server");
    let data_dir = base.join("data");
    ide_tools::extend_process_path(&data_dir);
    ide_dap::adapter::set_tools_root(ide_tools::tools_dir(&data_dir));
    ide_sdk::java::add_jdk_root(&ide_tools::jdk::jdks_dir(&data_dir));
    let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build().expect("tokio runtime");
    let code = runtime.block_on(run(base, mode));
    std::process::exit(code);
}

fn server_home() -> PathBuf {
    let home = dirs::home_dir().unwrap_or_default();
    std::env::var_os("OPENIDEA_SERVER_HOME").map(PathBuf::from).unwrap_or_else(|| home.join(".openidea"))
}

async fn run(base: PathBuf, mode: Mode) -> i32 {
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
    match mode {
        Mode::Stdio => {
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
            start_mcp(&host, &base);
            let plugins = start_plugins(&plugins_data, &host, peer.clone());
            inherit_trust(&host);
            tracing::info!("openidea-server {} ready", env!("CARGO_PKG_VERSION"));
            let dispatcher = build_dispatcher(&plugins, plugin_languages);
            rpc::serve(host.clone(), dispatcher, peer, tokio::io::stdin(), tokio::io::stdout()).await;
            shutdown_all(&host, plugins.as_ref()).await;
            0
        }
        #[cfg(unix)]
        Mode::Daemon(socket) => {
            let peer = Arc::new(rpc::PeerSlot::default());
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
            start_mcp(&host, &base);
            let plugins = start_plugins(&plugins_data, &host, peer.clone());
            inherit_trust(&host);
            tracing::info!("openidea-server {} daemon ready at {}", env!("CARGO_PKG_VERSION"), socket.display());
            let dispatcher = build_dispatcher(&plugins, plugin_languages);
            let result = ide_host::daemon::serve(&socket, host.clone(), dispatcher, peer).await;
            shutdown_all(&host, plugins.as_ref()).await;
            match result {
                Ok(()) => 0,
                Err(e) => {
                    eprintln!("daemon error: {e}");
                    1
                }
            }
        }
    }
}

fn start_mcp(host: &Arc<Host>, base: &std::path::Path) {
    host.mcp.set_stdio_link(base.join("bin").join("openidea-server"));
    host.mcp_background.serve_none();
    host.mcp.apply(host);
}

fn start_plugins<P: rpc::PeerHandle>(
    plugins_data: &std::path::Path,
    host: &Arc<Host>,
    peer: Arc<P>,
) -> Option<Arc<RemotePlugins>> {
    match RemotePlugins::start(plugins_data, host, peer) {
        Ok(p) => Some(p),
        Err(e) => {
            tracing::warn!("plugins are unavailable: {e}");
            None
        }
    }
}

fn inherit_trust(host: &Host) {
    if let Some(root) = std::env::var_os(ide_host::trust::TRUSTED_ROOT_ENV)
        && let Err(e) = host.trust.inherit(std::path::Path::new(&root))
    {
        tracing::warn!("cannot trust {}: {e}", root.to_string_lossy());
    }
}

fn build_dispatcher(plugins: &Option<Arc<RemotePlugins>>, plugin_languages: Arc<RemotePluginLanguages>) -> Dispatcher {
    let mut dispatcher = Dispatcher::standard();
    if let Some(plugins) = plugins {
        plugins.register(&mut dispatcher);
    }
    dispatcher.add(SYNC_COMMAND, TrustClass::Trusted, move |c| {
        let remote = plugin_languages.clone();
        async move {
            let report = remote.sync(c.arg("languages")?);
            c.host.plugin_languages_changed();
            Ok(report)
        }
    });
    dispatcher
}

async fn shutdown_all(host: &Host, plugins: Option<&Arc<RemotePlugins>>) {
    host.mcp.stop(host);
    if let Some(plugins) = plugins {
        plugins.host().shutdown();
    }
    // `process::exit` skips destructors: nothing started for the client may outlive it.
    if tokio::time::timeout(std::time::Duration::from_secs(10), host.shutdown()).await.is_err() {
        tracing::warn!("language servers did not shut down in time");
    }
}
