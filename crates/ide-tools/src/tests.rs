use super::*;
use std::fs;

fn langs() -> Vec<LanguageConfig> {
    ide_language::LanguageRegistry::load(None).unwrap().all()
}

struct Env {
    _tmp: tempfile::TempDir,
    root: PathBuf,
    sys: PathBuf,
}

impl Env {
    fn new() -> Self {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("app-data/tools");
        let sys = tmp.path().join("sysbin");
        fs::create_dir_all(&sys).unwrap();
        Self { _tmp: tmp, root, sys }
    }

    /// Tools with only `sys` (plus our own dirs, which must be ignored for system detection) on the path.
    fn tools(&self) -> Tools {
        let mut dirs = vec![self.sys.clone()];
        dirs.extend(bin_dirs_in(&self.root, Platform::current()));
        Tools::with_paths(self.root.clone(), std::env::join_paths(dirs).unwrap(), Platform::current())
    }

    #[cfg(unix)]
    fn script(&self, dir: &Path, name: &str, body: &str) {
        fs::create_dir_all(dir).unwrap();
        let p = dir.join(name);
        fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
        archive::make_executable(&p).unwrap();
    }
}

fn find<'a>(list: &'a [ToolInfo], name: &str) -> &'a ToolInfo {
    list.iter().find(|t| t.name == name).unwrap_or_else(|| panic!("{name} not listed"))
}

#[test]
fn version_parsing() {
    assert_eq!(parse_version("rust-analyzer 1.85.0 (4d91de4e 2025-02-17)").as_deref(), Some("1.85.0"));
    assert_eq!(
        parse_version("golang.org/x/tools/gopls v0.16.1\n    golang.org/x/tools/gopls@v0.16.1").as_deref(),
        Some("0.16.1")
    );
    assert_eq!(parse_version("Delve Debugger\nVersion: 1.23.0\nBuild: $Id: abc $").as_deref(), Some("1.23.0"));
    assert_eq!(parse_version("Homebrew clangd version 19.1.2").as_deref(), Some("19.1.2"));
    assert_eq!(parse_version("basedpyright 1.31.0\nbased on pyright 1.1.403").as_deref(), Some("1.31.0"));
    assert_eq!(parse_version("2024-12-18").as_deref(), Some("2024-12-18"));
    assert_eq!(parse_version("no version here"), None);
    assert_eq!(parse_version("x 3"), None);
}

#[test]
fn everything_missing_on_an_empty_system() {
    let env = Env::new();
    let list = env.tools().list(&langs());
    let ra = find(&list, "rust-analyzer");
    assert_eq!(ra.status, ToolStatus::Missing);
    assert_eq!(ra.languages, vec!["Rust".to_string()]);
    assert!(!ra.can_install, "rustup is not on the fake PATH");
    assert!(ra.unavailable_reason.as_deref().unwrap().contains("rustup"));
    let vtsls = find(&list, "vtsls");
    assert!(vtsls.languages.iter().any(|l| l == "TypeScript"));
    assert!(vtsls.unavailable_reason.as_deref().unwrap().contains("npm"));
    let ty = find(&list, "ty");
    assert_eq!(ty.status, ToolStatus::Missing);
    assert_eq!(ty.command, "ty");
    assert_eq!(ty.install_method.as_deref(), Some("pip (virtualenv)"));
    assert!(ty.languages.iter().any(|language| language == "Python"));
    let angular = find(&list, "angular-language-server");
    assert_eq!(angular.command, "ngserver");
    assert_eq!(angular.install_method.as_deref(), Some("npm"));
    assert_eq!(angular.languages, ["HTML", "TypeScript"]);
    // Servers without an installer are listed with their manual hint.
    let hls = find(&list, "haskell-language-server");
    assert_eq!(hls.install_method, None);
    assert!(!hls.can_install);
    assert_eq!(hls.status, ToolStatus::Missing);
    // Gem tools need Ruby.
    assert!(find(&list, "solargraph").unavailable_reason.as_deref().unwrap().contains("Ruby"));
    // Shared npm package: each server is its own row.
    assert_eq!(find(&list, "vscode-css-language-server").install_method.as_deref(), Some("npm"));
    assert!(find(&list, "delve").kind == ToolKind::Debugger);
}

#[cfg(unix)]
#[test]
fn detects_tools_on_path_with_versions() {
    let env = Env::new();
    env.script(&env.sys, "gopls", "echo 'golang.org/x/tools/gopls v0.16.1'");
    env.script(&env.sys, "solargraph", "exit 0");
    env.script(&env.sys, "curl", "exit 1");
    let list = env.tools().list(&langs());
    let gopls = find(&list, "gopls");
    assert_eq!(gopls.status, ToolStatus::OnPath);
    assert_eq!(gopls.version.as_deref(), Some("0.16.1"));
    assert_eq!(gopls.path.as_deref(), Some(env.sys.join("gopls").as_path()));
    assert!(!gopls.can_uninstall);
    assert_eq!(find(&list, "solargraph").status, ToolStatus::OnPath);
    // curl present → release tools are installable (on platforms with a build).
    let marksman = find(&list, "marksman");
    assert!(marksman.can_install, "{:?}", marksman.unavailable_reason);
}

#[cfg(unix)]
#[test]
fn rustup_proxy_without_component_is_missing() {
    let env = Env::new();
    env.script(&env.sys, "rust-analyzer", "echo \"error: Unknown binary 'rust-analyzer'\" >&2; exit 1");
    env.script(&env.sys, "rustup", "exit 0");
    let tools = env.tools();
    let info = tools.info("rust-analyzer", &langs()).unwrap();
    assert_eq!(info.status, ToolStatus::Missing);
    assert!(info.can_install);
    env.script(&env.sys, "rust-analyzer", "echo 'rust-analyzer 1.85.0 (4d91de4e 2025-02-17)'");
    let info = tools.info("rust-analyzer", &langs()).unwrap();
    assert_eq!(info.status, ToolStatus::Installed);
    assert_eq!(info.version.as_deref(), Some("1.85.0"));
}

#[cfg(unix)]
#[test]
fn managed_tools_win_over_path_and_report_manifest_versions() {
    let env = Env::new();
    env.script(&env.sys, "marksman", "echo 1.0.0");
    env.script(&env.root.join("marksman/bin"), "marksman", "echo 2.0.0");
    fs::write(env.root.join("marksman").join(MANIFEST), r#"{"version":"2024-12-18","source":"x"}"#).unwrap();
    env.script(&env.root.join("node_modules/.bin"), "vtsls", "exit 0");
    fs::create_dir_all(env.root.join("node_modules/@vtsls/language-server")).unwrap();
    fs::write(env.root.join("node_modules/@vtsls/language-server/package.json"), r#"{"version":"0.2.9"}"#).unwrap();

    let list = env.tools().list(&langs());
    let m = find(&list, "marksman");
    assert_eq!(m.status, ToolStatus::Installed);
    assert_eq!(m.version.as_deref(), Some("2024-12-18"));
    assert!(m.can_uninstall);
    let v = find(&list, "vtsls");
    assert_eq!(v.status, ToolStatus::Installed);
    assert_eq!(v.version.as_deref(), Some("0.2.9"));

    let info = env.tools().uninstall("marksman", &langs()).unwrap();
    assert_eq!(info.status, ToolStatus::OnPath);
    assert!(!env.root.join("marksman").exists());
}

#[test]
fn bin_dirs_cover_every_managed_layout() {
    let root = Path::new("/data/tools");
    let dirs = bin_dirs_in(root, Platform { os: Os::Mac, arch: platform::Arch::Arm64 });
    assert_eq!(dirs[0], root.join("node_modules/.bin"));
    assert!(dirs.contains(&root.join("clangd/bin")));
    assert!(dirs.contains(&root.join("gopls/bin")));
    assert!(dirs.contains(&root.join("basedpyright/venv/bin")));
    assert_eq!(dirs.iter().filter(|d| **d == root.join("node_modules/.bin")).count(), 1);
    let win = bin_dirs_in(root, Platform { os: Os::Windows, arch: platform::Arch::X64 });
    assert!(win.contains(&root.join("basedpyright/venv/Scripts")));
    assert_eq!(tools_bin_dirs(Path::new("/data"))[0], root.join("node_modules/.bin"));
}

#[test]
fn unknown_or_manual_tools_cannot_be_installed() {
    let env = Env::new();
    let tools = env.tools();
    let err = tools.install("haskell-language-server", &langs(), &CancellationToken::new(), &|_| {}).unwrap_err();
    assert_eq!(err.kind, ErrorKind::Unavailable);
    assert!(err.message.contains("cannot be installed automatically"));
    assert_eq!(tools.info("nope", &langs()).unwrap_err().kind, ErrorKind::NotFound);
}

#[test]
fn concurrent_installs_of_one_tool_are_rejected() {
    let a = InstallGuard::acquire("x-tool").unwrap();
    assert_eq!(InstallGuard::acquire("x-tool").err().unwrap().kind, ErrorKind::AlreadyExists);
    drop(a);
    assert!(InstallGuard::acquire("x-tool").is_ok());
}

/// Full release install through a fake `curl` that serves a local release JSON and archive.
#[cfg(unix)]
#[test]
fn release_install_end_to_end_without_network() {
    let env = Env::new();
    let fixtures = env.root.parent().unwrap().join("fixtures");
    fs::create_dir_all(&fixtures).unwrap();
    let archive = fixtures.join("lls.tar.gz");
    {
        let gz = flate2::write::GzEncoder::new(fs::File::create(&archive).unwrap(), flate2::Compression::fast());
        let mut b = tar::Builder::new(gz);
        let body = b"#!/bin/sh\necho 3.13.5\n";
        let mut h = tar::Header::new_gnu();
        h.set_size(body.len() as u64);
        h.set_mode(0o755);
        h.set_cksum();
        b.append_data(&mut h, "bin/lua-language-server", &body[..]).unwrap();
        b.into_inner().unwrap().finish().unwrap();
    }
    let digest = sources::sha256_file(&archive).unwrap();
    let assets: Vec<String> = ["darwin-arm64.tar.gz", "darwin-x64.tar.gz", "linux-x64.tar.gz", "linux-arm64.tar.gz"]
        .iter()
        .map(|s| {
            format!(
                r#"{{"name":"lua-language-server-3.13.5-{s}","browser_download_url":"https://example.invalid/{s}","size":{},"digest":"sha256:{digest}"}}"#,
                fs::metadata(&archive).unwrap().len()
            )
        })
        .collect();
    let json = fixtures.join("release.json");
    fs::write(&json, format!(r#"{{"tag_name":"3.13.5","assets":[{}]}}"#, assets.join(","))).unwrap();
    env.script(
        &env.sys,
        "curl",
        &format!(
            r#"out=""; url=""
while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2;; -A|-H|--retry|--connect-timeout) shift 2;; -*) shift;; *) url="$1"; shift;; esac; done
case "$url" in
  https://api.github.com/*) /bin/cat '{json}';;
  *) /bin/cp '{archive}' "$out";;
esac"#,
            json = json.display(),
            archive = archive.display()
        ),
    );
    let events = Mutex::new(Vec::new());
    let emit = |e: InstallEvent| events.lock().push(e);
    let info = env.tools().install("lua-language-server", &langs(), &CancellationToken::new(), &emit).unwrap();
    assert_eq!(info.status, ToolStatus::Installed);
    assert_eq!(info.version.as_deref(), Some("3.13.5"));
    let exe = env.root.join("lua-language-server/bin/lua-language-server");
    assert_eq!(info.path.as_deref(), Some(exe.as_path()));
    let out = Command::new(&exe).output().unwrap();
    assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "3.13.5");
    assert!(!env.root.join(".staging-lua-language-server").exists());
    let lines: Vec<String> = events
        .into_inner()
        .into_iter()
        .filter_map(|e| match e {
            InstallEvent::Line { text } => Some(text),
            _ => None,
        })
        .collect();
    assert!(lines.iter().any(|l| l.contains("Checksum verified")), "{lines:?}");

    // A corrupted download is rejected and leaves the previous install alone.
    fs::write(&archive, b"garbage").unwrap();
    let err = env.tools().install("lua-language-server", &langs(), &CancellationToken::new(), &|_| {}).unwrap_err();
    assert!(err.message.contains("checksum mismatch"), "{}", err.message);
    assert!(exe.exists());
}

/// npm installs go to `<tools>/node_modules` with `--prefix`.
#[cfg(unix)]
#[test]
fn npm_install_uses_tools_prefix() {
    let env = Env::new();
    let log = env.root.parent().unwrap().join("npm-args.txt");
    env.script(
        &env.sys,
        "npm",
        &format!(
            r#"echo "$@" > '{log}'
prefix=""; while [ $# -gt 0 ]; do [ "$1" = "--prefix" ] && prefix="$2"; shift; done
/bin/mkdir -p "$prefix/node_modules/.bin" "$prefix/node_modules/bash-language-server"
printf '#!/bin/sh\necho 5.4.0\n' > "$prefix/node_modules/.bin/bash-language-server"
/bin/chmod +x "$prefix/node_modules/.bin/bash-language-server"
echo '{{"version":"5.4.0"}}' > "$prefix/node_modules/bash-language-server/package.json"
echo "added 1 package""#,
            log = log.display()
        ),
    );
    let info = env.tools().install("bash-language-server", &langs(), &CancellationToken::new(), &|_| {}).unwrap();
    assert_eq!(info.status, ToolStatus::Installed);
    assert_eq!(info.version.as_deref(), Some("5.4.0"));
    let args = fs::read_to_string(&log).unwrap();
    assert!(args.contains("install") && args.contains("bash-language-server@latest"), "{args}");
    assert!(args.contains(&env.root.display().to_string()), "{args}");
    assert!(env.root.join("package.json").exists());
}

/// Servers that load TypeScript as a library get one with its JS API: `@latest`
/// is TypeScript 7 (native, no `ts.server`), which crashed vue-language-server (#25).
/// Uninstalling one keeps the TypeScript another installed server still uses.
#[cfg(unix)]
#[test]
fn npm_typescript_is_pinned_and_shared() {
    let env = Env::new();
    let log = env.root.parent().unwrap().join("npm-args.txt");
    env.script(
        &env.sys,
        "npm",
        &format!(
            r#"echo "$@" >> '{log}'
prefix=""; for a in "$@"; do [ "$prev" = "--prefix" ] && prefix="$a"; prev="$a"; done
[ "$1" = "install" ] || exit 0
/bin/mkdir -p "$prefix/node_modules/.bin"
for a in "$@"; do case "$a" in
  typescript-language-server@latest) n=typescript-language-server;;
  @vue/language-server@latest) n=vue-language-server; d=@vue/language-server;;
  *) continue;;
esac
d="${{d:-$n}}"; /bin/mkdir -p "$prefix/node_modules/$d"
echo '{{"version":"1.0.0"}}' > "$prefix/node_modules/$d/package.json"
printf '#!/bin/sh\necho 1.0.0\n' > "$prefix/node_modules/.bin/$n"; /bin/chmod +x "$prefix/node_modules/.bin/$n"; d=""
done"#,
            log = log.display()
        ),
    );
    let tools = env.tools();
    for name in ["vue-language-server", "typescript-language-server"] {
        assert_eq!(
            tools.install(name, &langs(), &CancellationToken::new(), &|_| {}).unwrap().status,
            ToolStatus::Installed
        );
    }
    let installs = fs::read_to_string(&log).unwrap();
    for line in installs.lines() {
        assert!(line.contains("typescript@<7") && !line.contains("typescript@latest"), "{line}");
    }
    assert!(installs.contains("@vue/language-server@latest"), "{installs}");

    fs::write(&log, "").unwrap();
    tools.uninstall("vue-language-server", &langs()).unwrap();
    let uninstall = fs::read_to_string(&log).unwrap();
    assert!(uninstall.contains("uninstall") && uninstall.contains("@vue/language-server"), "{uninstall}");
    assert!(!uninstall.contains("typescript"), "typescript-language-server still needs it: {uninstall}");
}

#[test]
fn installed_bundle_is_detected_and_resolvable() {
    let env = Env::new();
    let tools = env.tools();
    assert_eq!(tools.info("java-debug", &langs()).unwrap().status, ToolStatus::Missing);
    let bin = env.root.join("java-debug/bin");
    fs::create_dir_all(&bin).unwrap();
    fs::write(bin.join("com.microsoft.java.debug.plugin.jar"), b"PK").unwrap();
    let info = tools.info("java-debug", &langs()).unwrap();
    assert_eq!(info.status, ToolStatus::Installed);
    assert_eq!(info.kind, ToolKind::Debugger);
    assert_eq!(info.languages, ["Java"]);
    let app_data = env.root.parent().unwrap();
    assert_eq!(managed_bundle(app_data, "java-debug"), Some(bin.join("com.microsoft.java.debug.plugin.jar")));
    assert_eq!(managed_bundle(app_data, "jdtls"), None, "not a bundle");
}

#[cfg(unix)]
#[test]
fn custom_paths_win_and_report_their_version() {
    let env = Env::new();
    env.script(&env.sys, "gopls", "echo 'golang.org/x/tools/gopls v0.16.1'");
    let elsewhere = env.sys.parent().unwrap().join("opt/go/bin");
    env.script(&elsewhere, "my-gopls", "echo 'golang.org/x/tools/gopls v0.17.0'");
    let custom =
        BTreeMap::from([("gopls".to_string(), elsewhere.join("my-gopls")), ("zls".to_string(), elsewhere.join("zls"))]);
    let list = env.tools().with_custom_paths(custom).list(&langs());
    let gopls = find(&list, "gopls");
    assert_eq!(gopls.status, ToolStatus::Custom);
    assert_eq!(gopls.path.as_deref(), Some(elsewhere.join("my-gopls").as_path()));
    assert_eq!(gopls.version.as_deref(), Some("0.17.0"));
    assert_eq!(gopls.custom_error, None);
    // A path that does not exist is reported, not silently replaced by detection.
    let zls = find(&list, "zls");
    assert_eq!(zls.status, ToolStatus::Missing);
    assert!(zls.custom_error.as_deref().unwrap().contains("does not exist"));
}

#[test]
fn a_debugger_named_like_its_server_is_listed_by_its_command() {
    let list = Env::new().tools().list(&langs());
    let server = find(&list, "elixir-ls");
    assert_eq!((server.kind, server.command.as_str()), (ToolKind::LanguageServer, "elixir-ls"));
    let debugger = find(&list, "elixir-ls-debugger");
    assert_eq!((debugger.kind, debugger.command.as_str()), (ToolKind::Debugger, "elixir-ls-debugger"));
    assert_eq!(debugger.languages, vec!["Elixir".to_string()]);
}

#[cfg(unix)]
#[test]
fn elixir_ls_needs_elixir_and_lists_its_debugger() {
    let env = Env::new();
    env.script(&env.sys, "curl", "exit 0");
    let list = env.tools().list(&langs());
    let server = find(&list, "elixir-ls");
    assert_eq!(server.install_method.as_deref(), Some("GitHub release"));
    assert!(!server.can_install);
    assert!(server.unavailable_reason.as_deref().unwrap().contains("Elixir is required"));
    let debugger = find(&list, "elixir-ls-debugger");
    assert_eq!((debugger.kind, debugger.languages.as_slice()), (ToolKind::Debugger, ["Elixir".to_string()].as_slice()));

    env.script(&env.sys, "elixir", "exit 0");
    let list = env.tools().list(&langs());
    assert!(find(&list, "elixir-ls").can_install);
    assert!(find(&list, "elixir-ls-debugger").can_install);
}

#[cfg(unix)]
#[test]
fn gem_install_wraps_stubs_with_gem_home() {
    let env = Env::new();
    // `gem install --no-document --install-dir <home> --bindir <bin> solargraph`
    env.script(
        &env.sys,
        "gem",
        r#"home="$4"; bin="$6"; /bin/mkdir -p "$home/gems/solargraph-0.50.0" "$bin"
printf '#!/bin/sh\necho "$GEM_HOME"\n' > "$bin/solargraph"; /bin/chmod +x "$bin/solargraph""#,
    );
    let tools = env.tools();
    let info = tools.install("solargraph", &langs(), &CancellationToken::new(), &|_| {}).unwrap();
    assert_eq!(info.status, ToolStatus::Installed);
    assert_eq!(info.version.as_deref(), Some("0.50.0"));
    let wrapper = env.root.join("solargraph/bin/solargraph");
    assert_eq!(info.path.as_deref(), Some(wrapper.as_path()));
    let out = std::process::Command::new(&wrapper).output().unwrap();
    assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), env.root.join("solargraph/gems").to_string_lossy());
}

#[cfg(unix)]
#[test]
fn dotnet_tool_install_into_tool_path() {
    let env = Env::new();
    env.script(
        &env.sys,
        "dotnet",
        r#"case "$2" in
install) /bin/mkdir -p "$5"; printf '#!/bin/sh\necho "$DOTNET_ROOT"\n' > "$5/csharp-ls"; /bin/chmod +x "$5/csharp-ls" ;;
list) printf 'Package Id      Version      Commands\n----\ncsharp-ls       0.15.0       csharp-ls\n' ;;
esac
[ "$1" = --list-runtimes ] && echo 'Microsoft.NETCore.App 9.0.1 [/opt/dotnet/shared/Microsoft.NETCore.App]'
exit 0"#,
    );
    let info = env.tools().install("csharp-ls", &langs(), &CancellationToken::new(), &|_| {}).unwrap();
    assert_eq!(info.status, ToolStatus::Installed);
    assert_eq!(info.version.as_deref(), Some("0.15.0"));
    let wrapper = env.root.join("csharp-ls/bin/csharp-ls");
    assert_eq!(info.path.as_deref(), Some(wrapper.as_path()));
    let out = std::process::Command::new(&wrapper).output().unwrap();
    assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "/opt/dotnet");
}
