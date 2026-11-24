//! `openidea-server`: the headless IDE backend.
//!
//! * `--stdio`: JSON-RPC over stdin/stdout for SSH / remote development clients.
//! * `--web`: HTTP + WebSocket server exposing the full OpenIDEA web interface on a configurable port.
//! * `--mcp-stdio`: MCP stdio bridge.
//! * `--connect <host> <port>`: TCP relay over stdin/stdout.

use ide_host::catalogue::TrustClass;
use ide_host::plugins::remote::{RemotePluginLanguages, SYNC_COMMAND};
use ide_host::plugins::remote_host::RemotePlugins;
use ide_host::rpc::{self, Dispatcher};
use ide_host::web_server::{self, WebServerConfig};
use ide_host::{Host, HostConfig};
use ide_language::LanguageRegistry;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

fn print_usage() {
    eprintln!(
        "\
usage:
  openidea-server --web [options] [<project>]
  openidea-server --stdio
  openidea-server --mcp-stdio [--project <path>]
  openidea-server --connect <host> <port>
  openidea-server --version

web mode options:
  --host <addr>           Bind address (default: $OPENIDEA_HOST or 127.0.0.1)
  --port <port>           Listen port (default: $OPENIDEA_PORT or 8080)
  --base-path <prefix>    Optional reverse-proxy URL prefix (default: $OPENIDEA_BASE_PATH)
  --web-dir <dir>         Built frontend directory (default: $OPENIDEA_WEB_DIR or auto-detected dist/)
  --project <path>        Workspace directory to open on startup (default: $OPENIDEA_WORKSPACE_DIR)
  --home <dir>            Persistent config/data directory (default: $OPENIDEA_SERVER_HOME or ~/.openidea)
  --token <secret|auto>   Access token ($OPENIDEA_WEB_TOKEN; default: auto-generated random token)
  --no-auth               Disable token auth ($OPENIDEA_WEB_NO_AUTH=1; use only behind an authenticating proxy)
  --no-trust-project      Prompt before trusting --project instead of trusting it automatically"
    );
}

struct ParsedWebArgs {
    config: WebServerConfig,
    home_override: Option<PathBuf>,
}

fn env_truthy(name: &str) -> bool {
    std::env::var(name).ok().is_some_and(|v| matches!(v.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes"))
}

fn parse_web_args(args: &[String]) -> Result<ParsedWebArgs, String> {
    let mut host = std::env::var("OPENIDEA_HOST").unwrap_or_else(|_| "127.0.0.1".into());
    let mut port: u16 = match std::env::var("OPENIDEA_PORT") {
        Ok(raw) if !raw.trim().is_empty() => {
            raw.trim().parse::<u16>().map_err(|_| format!("invalid OPENIDEA_PORT value: {raw}"))?
        }
        _ => 8080,
    };
    let mut base_path = std::env::var("OPENIDEA_BASE_PATH").ok().filter(|s| !s.trim().is_empty());
    let mut web_dir = web_server::default_web_dir();
    let mut project = std::env::var_os("OPENIDEA_WORKSPACE_DIR")
        .or_else(|| std::env::var_os("OPENIDEA_PROJECT"))
        .filter(|s| !s.is_empty())
        .map(PathBuf::from);
    let mut trust_project = true;
    let mut no_auth = env_truthy("OPENIDEA_WEB_NO_AUTH");
    let mut auth_token = std::env::var("OPENIDEA_WEB_TOKEN").ok().filter(|s| !s.trim().is_empty());
    let mut home_override: Option<PathBuf> = None;

    let mut i = 0;
    while i < args.len() {
        let arg = args[i].as_str();
        let next_val = |i: &mut usize, flag: &str| -> Result<String, String> {
            *i += 1;
            args.get(*i).cloned().ok_or_else(|| format!("missing value for {flag}"))
        };
        if arg == "--web" {
            i += 1;
            continue;
        } else if arg == "--host" {
            host = next_val(&mut i, "--host")?;
        } else if let Some(v) = arg.strip_prefix("--host=") {
            host = v.to_owned();
        } else if arg == "--port" || arg == "-p" {
            let v = next_val(&mut i, arg)?;
            port = v.parse::<u16>().map_err(|_| format!("invalid port: {v}"))?;
        } else if let Some(v) = arg.strip_prefix("--port=") {
            port = v.parse::<u16>().map_err(|_| format!("invalid port: {v}"))?;
        } else if arg == "--base-path" {
            base_path = Some(next_val(&mut i, "--base-path")?);
        } else if let Some(v) = arg.strip_prefix("--base-path=") {
            base_path = Some(v.to_owned());
        } else if arg == "--web-dir" {
            web_dir = PathBuf::from(next_val(&mut i, "--web-dir")?);
        } else if let Some(v) = arg.strip_prefix("--web-dir=") {
            web_dir = PathBuf::from(v);
        } else if arg == "--project" || arg == "--workspace" {
            project = Some(PathBuf::from(next_val(&mut i, arg)?));
        } else if let Some(v) = arg.strip_prefix("--project=").or_else(|| arg.strip_prefix("--workspace=")) {
            project = Some(PathBuf::from(v));
        } else if arg == "--home" {
            home_override = Some(PathBuf::from(next_val(&mut i, "--home")?));
        } else if let Some(v) = arg.strip_prefix("--home=") {
            home_override = Some(PathBuf::from(v));
        } else if arg == "--token" {
            auth_token = Some(next_val(&mut i, "--token")?);
            no_auth = false;
        } else if let Some(v) = arg.strip_prefix("--token=") {
            auth_token = Some(v.to_owned());
            no_auth = false;
        } else if arg == "--no-auth" {
            auth_token = None;
            no_auth = true;
        } else if arg == "--no-trust-project" {
            trust_project = false;
        } else if arg.starts_with('-') {
            return Err(format!("unknown option: {arg}"));
        } else if project.is_none() {
            project = Some(PathBuf::from(arg));
        } else {
            return Err(format!("unexpected positional argument: {arg}"));
        }
        i += 1;
    }

    if no_auth {
        auth_token = None;
    } else if auth_token.is_none() || auth_token.as_deref() == Some("auto") {
        auth_token = Some(web_server::generate_token());
    }

    Ok(ParsedWebArgs {
        config: WebServerConfig { host, port, base_path, web_dir, project, trust_project, auth_token },
        home_override,
    })
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
    if args.iter().any(|a| a == "--help" || a == "-h") {
        print_usage();
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

    let web_mode = args.iter().any(|a| a == "--web");
    let stdio_mode = args.iter().any(|a| a == "--stdio");
    if !web_mode && !stdio_mode {
        print_usage();
        std::process::exit(2);
    }

    // stdout carries the protocol in --stdio mode: logs always go to stderr.
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_env("OPENIDEA_LOG").unwrap_or_else(|_| "info".into()))
        .init();

    if web_mode {
        let parsed = match parse_web_args(&args) {
            Ok(p) => p,
            Err(e) => {
                eprintln!("error: {e}");
                print_usage();
                std::process::exit(2);
            }
        };
        let base = parsed.home_override.unwrap_or_else(server_home);
        init_process_env(&base);
        let worker_threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(2).clamp(2, 8);
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(worker_threads)
            .max_blocking_threads(32)
            .enable_all()
            .build()
            .expect("tokio runtime");
        let code = runtime.block_on(web_server::run(parsed.config, base));
        std::process::exit(code);
    }

    let base = server_home();
    init_process_env(&base);
    let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build().expect("tokio runtime");
    let code = runtime.block_on(run_stdio(base));
    std::process::exit(code);
}

fn init_process_env(base: &std::path::Path) {
    // An SSH exec channel or container entrypoint gets a minimal environment: inherit login shell
    // env plus IDE-managed tools before any other thread starts.
    ide_host::shell_env::inherit_login_shell_env("openidea-server");
    let data_dir = base.join("data");
    ide_tools::extend_process_path(&data_dir);
    ide_dap::adapter::set_tools_root(ide_tools::tools_dir(&data_dir));
    ide_sdk::java::add_jdk_root(&ide_tools::jdk::jdks_dir(&data_dir));
}

fn server_home() -> PathBuf {
    let home = dirs::home_dir().unwrap_or_default();
    std::env::var_os("OPENIDEA_SERVER_HOME").map(PathBuf::from).unwrap_or_else(|| home.join(".openidea"))
}

async fn run_stdio(base: PathBuf) -> i32 {
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
    // A stable path for `--mcp-stdio` client configurations across server upgrades.
    host.mcp.set_stdio_link(base.join("bin").join("openidea-server"));
    host.mcp_background.serve_none();
    host.mcp.apply(&host);
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
    dispatcher.add(SYNC_COMMAND, TrustClass::Trusted, move |c| {
        let remote = plugin_languages.clone();
        async move {
            let report = remote.sync(c.arg("languages")?);
            c.host.plugin_languages_changed();
            Ok(report)
        }
    });
    rpc::serve(host.clone(), dispatcher, peer, tokio::io::stdin(), tokio::io::stdout()).await;
    host.mcp.stop(&host);
    if let Some(plugins) = &plugins {
        plugins.host().shutdown();
    }
    // `process::exit` skips destructors: nothing started for the client may outlive it.
    if tokio::time::timeout(std::time::Duration::from_secs(10), host.shutdown()).await.is_err() {
        tracing::warn!("language servers did not shut down in time");
    }
    0
}
