//! `openidea-plugin`: scaffolds, builds, checks and links OpenIDEA plugins.
//!
//! ```text
//! openidea-plugin new <dir> [--template command|theme|icon-theme|language] [--id ID] [--name NAME] [--sdk PATH]
//! openidea-plugin build [dir] [--debug]   # cargo → dist/plugin.wasm, then `check`
//! openidea-plugin check [dir|package]     # validate the package as the IDE would install it
//! openidea-plugin link [dir]              # load the folder in the IDE without installing it
//! openidea-plugin unlink [dir]
//! openidea-plugin links                   # list linked folders
//! openidea-plugin keygen <key-file>       # a publisher's Ed25519 key
//! openidea-plugin endorse <new-public-key> --key OLD --publisher ID   # vouch for a new key
//! openidea-plugin pack [dir] [--key F --publisher ID] [--out FILE]   # <id>-<version>.oiplugin
//! openidea-plugin index <dir> [--publisher ID --name NAME --key F [--previous-key F]]   # marketplace index.json
//! openidea-plugin merge <index> <other-index> --keep ID               # list another index's publishers
//! ```
//!
//! `link` writes `links.json` in the IDE's plugins directory
//! (`$OPENIDEA_PLUGINS_DIR`, or the app data directory); the IDE picks the
//! change up when Settings › Plugins is opened or refreshed. Linked plugins
//! are re-read from the folder, so `build` + refresh is the edit loop.

mod templates;

use ide_extension::{Manifest, validate_plugin_id};
use ide_host::plugins::{PluginHost, read_market_url, resolve_market_href};
use ide_plugin::{Limits, PluginEngine};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};
use std::sync::Arc;

const USAGE: &str = "\
usage: openidea-plugin <command> [options]

commands:
  new <dir> [--template T] [--id ID] [--name NAME] [--sdk PATH]
        create a plugin; T = command (default), theme, icon-theme, language
  build [dir] [--debug]   compile a Rust plugin to dist/plugin.wasm and check it
  check [dir|package]     validate the package (folder or .oiplugin) as the IDE would install it
  link [dir]              load the folder in the IDE without installing it
  unlink [dir]            stop loading a linked folder
  links                   list linked folders
  keygen <key-file>       create a publisher signing key (keep the file secret)
  endorse <new-public-key> --key F --publisher ID
                          print an earlier key's endorsement of a new one (JSON), for an
                          index the publisher doesn't write with `index --previous-key`
  pack [dir] [--key F --publisher ID] [--out FILE]
                          write <id>-<version>.oiplugin, signed with the key
  index <dir> [--publisher ID --name NAME --key F [--previous-key F]] [--out FILE]
        [--download-base URL]
                          write the marketplace index.json for the packages in dir: with a
                          key, register it and list that publisher's plugins (earlier
                          versions stay for older IDEs); without, list only these packages,
                          each checked against the index's publishers. A new key replacing
                          an earlier one is endorsed with --previous-key, so installed
                          plugins update to it without asking
  merge <index> <other-index> --keep ID [--out FILE]
                          replace every publisher but ID in index with those of other-index
                          (a path or URL), their plugins and revocations

environment:
  OPENIDEA_PLUGINS_DIR    the IDE's plugins directory (default: the app data directory)";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.first().map(String::as_str) {
        Some("new") => cmd_new(&args[1..]),
        Some("build") => cmd_build(&args[1..]),
        Some("check") => dir_arg(&args[1..]).and_then(|d| check_path(&d)),
        Some("link") => dir_arg(&args[1..]).and_then(|d| link(&d, true)),
        Some("unlink") => dir_arg(&args[1..]).and_then(|d| link(&d, false)),
        Some("links") => list_links(),
        Some("keygen") => cmd_keygen(&args[1..]),
        Some("endorse") => cmd_endorse(&args[1..]),
        Some("pack") => cmd_pack(&args[1..]),
        Some("index") => cmd_index(&args[1..]),
        Some("merge") => cmd_merge(&args[1..]),
        Some("--version" | "-V") => {
            println!("openidea-plugin {} (plugin API {})", env!("CARGO_PKG_VERSION"), ide_extension::ENGINE_VERSION);
            Ok(())
        }
        Some("help" | "--help" | "-h") | None => {
            println!("{USAGE}");
            Ok(())
        }
        Some(other) => Err(format!("unknown command {other:?}\n\n{USAGE}")),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("error: {e}");
            ExitCode::FAILURE
        }
    }
}

/// Splits `args` into positionals and `--flag value` / `--switch` options.
struct Args {
    positional: Vec<String>,
    options: Vec<(String, Option<String>)>,
}

impl Args {
    fn parse(args: &[String], switches: &[&str], valued: &[&str]) -> Result<Self, String> {
        let mut out = Args { positional: Vec::new(), options: Vec::new() };
        let mut it = args.iter();
        while let Some(a) = it.next() {
            if let Some(name) = a.strip_prefix("--") {
                let (name, inline) = match name.split_once('=') {
                    Some((n, v)) => (n, Some(v.to_owned())),
                    None => (name, None),
                };
                if switches.contains(&name) && inline.is_none() {
                    out.options.push((name.into(), None));
                } else if valued.contains(&name) {
                    let v = inline.or_else(|| it.next().cloned()).ok_or_else(|| format!("--{name} needs a value"))?;
                    out.options.push((name.into(), Some(v)));
                } else {
                    return Err(format!("unknown option --{name}"));
                }
            } else {
                out.positional.push(a.clone());
            }
        }
        Ok(out)
    }

    fn value(&self, name: &str) -> Option<&str> {
        self.options.iter().rev().find(|(n, _)| n == name).and_then(|(_, v)| v.as_deref())
    }

    fn has(&self, name: &str) -> bool {
        self.options.iter().any(|(n, _)| n == name)
    }

    fn dir(&self) -> Result<PathBuf, String> {
        match self.positional.as_slice() {
            [] => Ok(PathBuf::from(".")),
            [d] => Ok(PathBuf::from(d)),
            _ => Err("expected at most one directory".into()),
        }
    }
}

fn dir_arg(args: &[String]) -> Result<PathBuf, String> {
    Args::parse(args, &[], &[])?.dir()
}

fn canonical(dir: &Path) -> Result<PathBuf, String> {
    dunce::canonicalize(dir).map_err(|e| format!("{}: {e}", dir.display()))
}

// ---------------------------------------------------------------- new

fn cmd_new(args: &[String]) -> Result<(), String> {
    let a = Args::parse(args, &[], &["template", "id", "name", "sdk"])?;
    let [dir] = a.positional.as_slice() else {
        return Err("usage: openidea-plugin new <dir> [--template T] [--id ID] [--name NAME]".into());
    };
    let dir = PathBuf::from(dir);
    let template = templates::Template::parse(a.value("template").unwrap_or("command"))?;
    let base = dir.file_name().and_then(|n| n.to_str()).ok_or("the directory needs a name")?;
    let id = match a.value("id") {
        Some(id) => id.to_owned(),
        None => slugify(base),
    };
    validate_plugin_id(&id)?;
    let name = match a.value("name") {
        Some(n) => n.to_owned(),
        None => title_case(id.rsplit('.').next().unwrap_or(&id)),
    };
    if name.trim().is_empty() || name.contains(['"', '\\', '\n']) {
        return Err("--name must not be empty or contain quotes, backslashes or newlines".into());
    }
    if dir.exists() && std::fs::read_dir(&dir).map_err(|e| e.to_string())?.next().is_some() {
        return Err(format!("{} already exists and is not empty", dir.display()));
    }
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let dir = canonical(&dir)?;
    let sdk = match template {
        templates::Template::Command => Some(sdk_path(a.value("sdk"), &dir)?),
        _ => None,
    };
    let vars = templates::Vars { id: &id, name: &name, sdk: sdk.as_deref() };
    let files = templates::render(template, &vars);
    for (rel, content) in &files {
        let path = dir.join(rel);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
        }
        std::fs::write(&path, content).map_err(|e| format!("{}: {e}", path.display()))?;
    }
    // Generated packages must be valid as written.
    Manifest::load(&dir).map_err(|e| format!("internal error: the template is invalid: {e}"))?;
    println!("created {} ({id}) in {}", template.label(), dir.display());
    let shown = std::env::current_dir().ok().and_then(|cwd| dir.strip_prefix(cwd).ok().map(Path::to_path_buf));
    let shown = shown.as_deref().unwrap_or(&dir).display().to_string();
    println!();
    println!("next:");
    if template == templates::Template::Command {
        println!("  cargo test --manifest-path {shown}/Cargo.toml   # unit tests against the mock host");
        println!("  openidea-plugin build {shown}");
    } else {
        println!("  openidea-plugin check {shown}");
    }
    println!("  openidea-plugin link {shown}                  # then Settings › Plugins");
    Ok(())
}

/// `My Cool_Plugin` → `my-cool-plugin`.
fn slugify(s: &str) -> String {
    let mut out = String::new();
    for c in s.chars() {
        match c {
            'a'..='z' | '0'..='9' | '.' => out.push(c),
            'A'..='Z' => out.push(c.to_ascii_lowercase()),
            _ if !out.ends_with('-') && !out.is_empty() => out.push('-'),
            _ => {}
        }
    }
    out.trim_matches(['-', '.']).to_owned()
}

/// `my-cool_plugin` → `My Cool Plugin`.
fn title_case(s: &str) -> String {
    s.split(['-', '_'])
        .filter(|w| !w.is_empty())
        .map(|w| {
            let mut c = w.chars();
            c.next().map(|f| f.to_uppercase().chain(c).collect::<String>()).unwrap_or_default()
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// The SDK dependency path written into a new plugin's Cargo.toml: `--sdk`,
/// or the SDK of the source tree this tool was built from.
fn sdk_path(explicit: Option<&str>, plugin_dir: &Path) -> Result<String, String> {
    let sdk = match explicit {
        Some(p) => PathBuf::from(p),
        None => PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../../sdk/rust/openidea-plugin")),
    };
    let sdk = dunce::canonicalize(&sdk).map_err(|_| {
        format!("the plugin SDK was not found at {}; pass --sdk <path to sdk/rust/openidea-plugin>", sdk.display())
    })?;
    if !sdk.join("Cargo.toml").is_file() {
        return Err(format!("{} is not the openidea-plugin SDK (no Cargo.toml)", sdk.display()));
    }
    let path = relative(plugin_dir, &sdk).unwrap_or(sdk);
    Ok(path.to_string_lossy().replace('\\', "/"))
}

/// `to` relative to `from` when they share a root (keeps packages in a repo movable).
fn relative(from: &Path, to: &Path) -> Option<PathBuf> {
    let (f, t): (Vec<_>, Vec<_>) = (from.components().collect(), to.components().collect());
    let common = f.iter().zip(&t).take_while(|(a, b)| a == b).count();
    if common <= 1 {
        return None;
    }
    let mut out = PathBuf::new();
    for _ in common..f.len() {
        out.push("..");
    }
    for c in &t[common..] {
        out.push(c);
    }
    Some(out)
}

// ---------------------------------------------------------------- build / check

fn cmd_build(args: &[String]) -> Result<(), String> {
    let a = Args::parse(args, &["debug"], &[])?;
    let dir = canonical(&a.dir()?)?;
    let manifest = Manifest::load(&dir)?;
    let cargo_toml = dir.join("Cargo.toml");
    if !cargo_toml.is_file() {
        if manifest.wasm.is_some() {
            return Err(format!(
                "{} has no Cargo.toml: build the component with your toolchain, then run `check`",
                dir.display()
            ));
        }
        println!("{} has no code to build", manifest.id);
        return check(&dir);
    }
    let wasm_rel = manifest.wasm.clone().ok_or("plugin.toml has no `wasm = \"dist/plugin.wasm\"`")?;
    let crate_name = crate_name(&cargo_toml)?;
    ensure_wasm_target();
    let release = !a.has("debug");
    let target_dir = std::env::var_os("CARGO_TARGET_DIR").map(PathBuf::from).unwrap_or_else(|| dir.join("target"));
    let mut cmd = Command::new(std::env::var_os("CARGO").unwrap_or_else(|| "cargo".into()));
    cmd.arg("build").arg("--manifest-path").arg(&cargo_toml).args(["--target", "wasm32-wasip2"]);
    if release {
        cmd.arg("--release");
    }
    cmd.env("CARGO_TARGET_DIR", &target_dir);
    println!("building {crate_name} for wasm32-wasip2 ({})", if release { "release" } else { "debug" });
    let status = cmd.status().map_err(|e| format!("cannot run cargo: {e}"))?;
    if !status.success() {
        return Err("cargo build failed".into());
    }
    let built = target_dir
        .join("wasm32-wasip2")
        .join(if release { "release" } else { "debug" })
        .join(format!("{}.wasm", crate_name.replace('-', "_")));
    if !built.is_file() {
        return Err(format!("{} was not produced: is `crate-type = [\"cdylib\"]` set in Cargo.toml?", built.display()));
    }
    let out = dir.join(&wasm_rel);
    if let Some(parent) = out.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    }
    std::fs::copy(&built, &out).map_err(|e| format!("{}: {e}", out.display()))?;
    let size = std::fs::metadata(&out).map(|m| m.len()).unwrap_or(0);
    println!("  -> {} ({})", wasm_rel.display(), human_size(size));
    check(&dir)
}

fn crate_name(cargo_toml: &Path) -> Result<String, String> {
    let src = std::fs::read_to_string(cargo_toml).map_err(|e| format!("{}: {e}", cargo_toml.display()))?;
    let doc: toml::Table = src.parse().map_err(|e| format!("{}: {e}", cargo_toml.display()))?;
    let package = doc.get("package").and_then(|p| p.as_table());
    let lib_name = doc.get("lib").and_then(|l| l.get("name")).and_then(|n| n.as_str());
    lib_name
        .or_else(|| package.and_then(|p| p.get("name")).and_then(|n| n.as_str()))
        .map(str::to_owned)
        .ok_or_else(|| format!("{}: no [package] name", cargo_toml.display()))
}

/// Installs the target through rustup when it is missing (no-op without rustup).
fn ensure_wasm_target() {
    let Ok(out) = Command::new("rustup").args(["target", "list", "--installed"]).output() else { return };
    if String::from_utf8_lossy(&out.stdout).lines().any(|l| l.trim() == "wasm32-wasip2") {
        return;
    }
    println!("installing the wasm32-wasip2 target");
    let _ = Command::new("rustup").args(["target", "add", "wasm32-wasip2"]).status();
}

/// Validates `dir` exactly as Install from Disk would, and checks the
/// component imports only the plugin API.
/// [`check`] of a folder, or of a package file unpacked as installing would.
fn check_path(path: &Path) -> Result<(), String> {
    if !path.is_file() {
        return check(path);
    }
    let tmp = scratch_dir("unpack")?;
    let dir = tmp.path().join("package");
    package::unpack(path, &dir).and_then(|_| check(&dir))
}

fn check(dir: &Path) -> Result<(), String> {
    let dir = canonical(dir)?;
    let tmp = scratch_dir("check")?;
    let scratch = tmp.path().join("host");
    (|| {
        let host = PluginHost::new(scratch.clone(), Arc::new(|_: Option<&str>, _| {}), Limits::default())
            .map_err(|e| e.to_string())?;
        let preview = host.preview_install(&dir).map_err(|e| e.to_string())?;
        let manifest = Manifest::load(&dir)?;
        println!("{} {} — {}", preview.id, preview.version, preview.name);
        if manifest.legacy {
            println!("  note: plugin.toml uses the 0.1 format (`openidea-api`); see plugins/README.md to move to 0.2");
        }
        if let Some(wasm) = &manifest.wasm {
            let engine = PluginEngine::new()?;
            let component = engine.compile(&dir.join(wasm))?;
            let built_for = engine.check_component(&component)?;
            let size = std::fs::metadata(dir.join(wasm)).map(|m| m.len()).unwrap_or(0);
            let api = built_for.map(|v| format!(", plugin API {}.{}", v.major, v.minor)).unwrap_or_default();
            println!("  code: {} ({}{api})", wasm.display(), human_size(size));
        } else {
            println!("  code: none (contributions only)");
        }
        println!("  categories: {}", manifest.categories().join(", "));
        for c in manifest.unknown_categories() {
            println!("  warning: unknown category {c:?} (ignored); use {}", ide_extension::CATEGORIES.join(", "));
        }
        if manifest.declared_categories.len() > ide_extension::MAX_CATEGORIES {
            println!(
                "  warning: only the first {} known categories are used; {} are declared",
                ide_extension::MAX_CATEGORIES,
                manifest.declared_categories.len()
            );
        }
        if !manifest.activation.is_empty() {
            let events: Vec<String> = manifest.activation.iter().map(ToString::to_string).collect();
            println!("  activation: {}", events.join(", "));
        }
        for c in &preview.contributions {
            println!("  contributes {} × {}", c.count, c.point);
        }
        for c in &preview.capabilities {
            let kind = if c.optional { "optional" } else { "required" };
            println!("  capability {} ({kind}, {:?} risk): {}", c.id, c.risk, c.description);
        }
        for w in &preview.warnings {
            println!("  warning: {w}");
        }
        println!("ok");
        Ok(())
    })()
}

fn human_size(bytes: u64) -> String {
    match bytes {
        b if b >= 1 << 20 => format!("{:.1} MiB", b as f64 / (1 << 20) as f64),
        b if b >= 1 << 10 => format!("{:.1} KiB", b as f64 / 1024.0),
        b => format!("{b} B"),
    }
}

// ---------------------------------------------------------------- link

fn plugins_dir() -> Result<PathBuf, String> {
    if let Some(dir) = std::env::var_os("OPENIDEA_PLUGINS_DIR") {
        return Ok(PathBuf::from(dir));
    }
    dirs::data_dir()
        .map(|d| d.join("ai.l0ng.openidea").join("plugins"))
        .ok_or_else(|| "cannot find the app data directory; set OPENIDEA_PLUGINS_DIR".into())
}

#[derive(Default, serde::Serialize, serde::Deserialize)]
struct Links {
    #[serde(default)]
    paths: Vec<PathBuf>,
}

fn read_links(file: &Path) -> Result<Links, String> {
    match std::fs::read_to_string(file) {
        Ok(s) => serde_json::from_str(&s).map_err(|e| format!("{}: {e}", file.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Links::default()),
        Err(e) => Err(format!("{}: {e}", file.display())),
    }
}

fn link(dir: &Path, add: bool) -> Result<(), String> {
    let plugins = plugins_dir()?;
    let file = plugins.join("links.json");
    let mut links = read_links(&file)?;
    let dir = if add {
        let dir = canonical(dir)?;
        let m = Manifest::load(&dir)?;
        if let Some(wasm) = &m.wasm
            && !dir.join(wasm).is_file()
        {
            println!("note: {} does not exist yet; run `openidea-plugin build` first", wasm.display());
        }
        if links.paths.contains(&dir) {
            println!("{} is already linked", dir.display());
            return Ok(());
        }
        println!("linked {} ({})", m.id, dir.display());
        links.paths.push(dir.clone());
        dir
    } else {
        let dir = dunce::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
        let before = links.paths.len();
        links.paths.retain(|p| p != &dir);
        if links.paths.len() == before {
            return Err(format!("{} is not linked", dir.display()));
        }
        println!("unlinked {}", dir.display());
        dir
    };
    let _ = dir;
    std::fs::create_dir_all(&plugins).map_err(|e| format!("{}: {e}", plugins.display()))?;
    let json = serde_json::to_string_pretty(&links).map_err(|e| e.to_string())?;
    let tmp = file.with_extension("json.tmp");
    std::fs::write(&tmp, json)
        .and_then(|()| std::fs::rename(&tmp, &file))
        .map_err(|e| format!("{}: {e}", file.display()))?;
    println!("open Settings › Plugins in OpenIDEA to load the change");
    Ok(())
}

fn list_links() -> Result<(), String> {
    let links = read_links(&plugins_dir()?.join("links.json"))?;
    if links.paths.is_empty() {
        println!("no linked plugins");
    }
    for p in links.paths {
        let id = Manifest::load(&p).map(|m| m.id).unwrap_or_else(|e| format!("invalid: {e}"));
        println!("{id}\t{}", p.display());
    }
    Ok(())
}

// ---------------------------------------------------------------- distribution

use ide_extension::package::{self, Index, IndexEntry, KeyEntry, PublisherKey};

fn read_key(path: &str) -> Result<PublisherKey, String> {
    PublisherKey::from_base64(&std::fs::read_to_string(path).map_err(|e| format!("{path}: {e}"))?)
}

fn cmd_keygen(args: &[String]) -> Result<(), String> {
    let a = Args::parse(args, &[], &[])?;
    let [file] = a.positional.as_slice() else { return Err("usage: openidea-plugin keygen <key-file>".into()) };
    if Path::new(file).exists() {
        return Err(format!("{file} exists; not overwriting a key"));
    }
    let mut seed = [0u8; 32];
    getrandom::fill(&mut seed).map_err(|e| format!("random: {e}"))?;
    let key = PublisherKey::from_seed(seed);
    std::fs::write(file, key.seed_base64()).map_err(|e| format!("{file}: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(file, std::fs::Permissions::from_mode(0o600));
    }
    println!("public key: {}", key.public_base64());
    println!("register it with your publisher id in the marketplace index; keep {file} secret");
    Ok(())
}

fn cmd_endorse(args: &[String]) -> Result<(), String> {
    let a = Args::parse(args, &[], &["key", "publisher"])?;
    let usage = "usage: openidea-plugin endorse <new-public-key> --key <earlier-key-file> --publisher ID";
    let ([new], Some(key), Some(publisher)) = (a.positional.as_slice(), a.value("key"), a.value("publisher")) else {
        return Err(usage.into());
    };
    if !package::publisher_id_ok(publisher) {
        return Err(format!("invalid publisher id {publisher:?}"));
    }
    let endorsement = read_key(key)?.endorse(publisher, new.trim());
    println!("{}", serde_json::to_string_pretty(&endorsement).map_err(|e| e.to_string())?);
    Ok(())
}

/// A fresh scratch directory, removed when dropped.
fn scratch_dir(what: &str) -> Result<tempfile::TempDir, String> {
    tempfile::Builder::new().prefix(&format!("openidea-plugin-{what}-")).tempdir().map_err(|e| e.to_string())
}

/// A scratch host to list a package's files as the IDE would.
fn with_scratch_host<T>(f: impl FnOnce(&PluginHost) -> Result<T, String>) -> Result<T, String> {
    let tmp = scratch_dir("host")?;
    PluginHost::new(tmp.path().join("host"), Arc::new(|_: Option<&str>, _| {}), Limits::default())
        .map_err(|e| e.to_string())
        .and_then(|h| f(&h))
}

fn cmd_pack(args: &[String]) -> Result<(), String> {
    let a = Args::parse(args, &[], &["key", "publisher", "out"])?;
    let dir = canonical(&a.dir()?)?;
    check(&dir)?;
    let manifest = Manifest::load(&dir)?;
    let mut files = with_scratch_host(|h| h.package_files_of(&dir).map_err(|e| e.to_string()))?;
    let digest = package::package_digest(&dir, &files).map_err(|e| e.to_string())?;
    let signature = match (a.value("key"), a.value("publisher")) {
        (Some(key), Some(publisher)) => {
            if !manifest.id.starts_with(&format!("{publisher}.")) {
                return Err(format!("publisher {publisher:?} may only sign plugins named {publisher}.*"));
            }
            Some(read_key(key)?.sign(publisher, &manifest.id, &manifest.version, &digest))
        }
        (None, None) => None,
        _ => return Err("--key and --publisher go together".into()),
    };
    for lic in ["LICENSE", "LICENSE.md", "LICENSE.txt", "NOTICE", "NOTICE.md", "COPYING", "README.md"] {
        if dir.join(lic).is_file() {
            files.push(PathBuf::from(lic));
        }
    }
    let out = a.value("out").map(PathBuf::from).unwrap_or_else(|| {
        PathBuf::from(format!("{}-{}.{}", manifest.id, manifest.version, package::PACKAGE_EXTENSION))
    });
    package::pack(&dir, &files, &out, signature.as_ref())?;
    let size = std::fs::metadata(&out).map(|m| m.len()).unwrap_or(0);
    let signed = signature.as_ref().map_or("unsigned".to_owned(), |s| format!("signed by {}", s.publisher));
    println!("-> {} ({}, {signed})", out.display(), human_size(size));
    Ok(())
}

fn cmd_index(args: &[String]) -> Result<(), String> {
    let a = Args::parse(args, &[], &["publisher", "name", "key", "previous-key", "out", "download-base"])?;
    let dir = canonical(&a.dir()?)?;
    let out = a.value("out").map(PathBuf::from).unwrap_or_else(|| dir.join("index.json"));
    let base = a.value("download-base").map(|b| b.trim_end_matches('/'));
    // Revocations and other publishers of an existing index are kept.
    let mut index = match std::fs::read_to_string(&out) {
        Ok(text) => current_format(Index::parse(&text)?, &out.to_string_lossy())?,
        Err(_) => Index { format: package::INDEX_FORMAT, ..Index::default() },
    };
    let publisher = match (a.value("publisher"), a.value("key")) {
        (Some(publisher), Some(key)) => {
            let key = read_key(key)?;
            let name = a.value("name").unwrap_or(publisher);
            let previous = a.value("previous-key").map(read_key).transpose()?;
            index.publishers =
                register_key(std::mem::take(&mut index.publishers), publisher, name, &key, previous.as_ref())?;
            Some(publisher)
        }
        (None, None) if a.has("previous-key") => return Err("--previous-key goes with --publisher and --key".into()),
        (None, None) => None,
        _ => return Err("--publisher and --key go together".into()),
    };
    let mut packages: Vec<PathBuf> = std::fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|e| e == package::PACKAGE_EXTENSION))
        .collect();
    packages.sort();
    let engine = PluginEngine::new()?;
    let mut added: Vec<IndexEntry> = Vec::new();
    for path in packages {
        let tmp = scratch_dir("index")?;
        let scratch = tmp.path().join("package");
        let entry = (|| {
            let unpacked = package::unpack(&path, &scratch)?;
            let m = Manifest::load(&scratch)?;
            let files = with_scratch_host(|h| h.package_files_of(&scratch).map_err(|e| e.to_string()))?;
            let digest = package::package_digest(&scratch, &files).map_err(|e| e.to_string())?;
            let sig = unpacked.signature.as_ref().ok_or("not signed")?;
            let signer = index.verify(sig, &m.id, &m.version, &digest)?;
            if publisher.is_some_and(|p| p != signer) {
                return Err(format!("signed by {signer}, not {}", publisher.unwrap_or_default()));
            }
            if added.iter().any(|e| (&e.id, &e.version) == (&m.id, &m.version)) {
                return Err(format!("another package of {} {} is in the folder", m.id, m.version));
            }
            if m.legacy {
                return Err("plugin.toml uses the 0.1 format; see plugins/README.md".into());
            }
            let built_for = match &m.wasm {
                Some(wasm) => engine.check_component(&engine.compile(&scratch.join(wasm))?)?,
                None => None,
            };
            let file = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            Ok::<_, String>(IndexEntry {
                id: m.id.clone(),
                name: m.name.clone(),
                version: m.version.clone(),
                description: m.description.clone(),
                authors: m.authors.clone(),
                publisher: signer,
                download: base.map_or_else(|| file.clone(), |b| format!("{b}/{file}")),
                digest,
                capabilities: m.capabilities.all().map(|c| c.to_string()).collect(),
                engine: package::engine_requirement(&m.engine, built_for.as_ref()),
                categories: m.categories(),
            })
        })();
        let entry = entry.map_err(|e| format!("{}: {e}", path.display()))?;
        println!("  {} {} (plugin API {})", entry.id, entry.version, entry.engine);
        added.push(entry);
    }
    // A publisher's earlier versions of these plugins stay for IDEs that can't load the new
    // ones (pruned below); plugins no longer in the folder go.
    index.plugins.retain(|e| match publisher {
        Some(p) => {
            e.publisher != p
                || (added.iter().any(|n| n.id == e.id)
                    && !added.iter().any(|n| (&n.id, &n.version) == (&e.id, &e.version)))
        }
        None => false,
    });
    index.plugins.extend(added);
    index.prune_versions();
    write_index(&index, &out)
}

/// `publishers` with `key` as `publisher`'s current key. Earlier keys stay listed
/// (packages they signed remain valid until revoked); a key new to the
/// publisher is endorsed by `previous`, one of them, so installed plugins
/// signed with it update without asking.
fn register_key(
    mut publishers: Vec<package::Publisher>,
    publisher: &str,
    name: &str,
    key: &PublisherKey,
    previous: Option<&PublisherKey>,
) -> Result<Vec<package::Publisher>, String> {
    let current = key.public_base64();
    let earlier: Vec<KeyEntry> = publishers.iter().filter(|p| p.id == publisher).flat_map(|p| p.keys.clone()).collect();
    let entry = match earlier.iter().find(|k| k.key == current) {
        Some(listed) => listed.clone(),
        None => {
            let endorsement = match previous {
                Some(prev) => {
                    let prev_key = prev.public_base64();
                    if !earlier.iter().any(|k| k.key == prev_key && !k.revoked) {
                        return Err(format!("--previous-key is not one of {publisher}'s valid keys in the index"));
                    }
                    Some(prev.endorse(publisher, &current))
                }
                None => {
                    if earlier.iter().any(|k| !k.revoked) {
                        println!(
                            "  warning: {publisher}'s new key is not endorsed (--previous-key): users who installed \
                             its plugins will be asked to confirm the change when they update"
                        );
                    }
                    None
                }
            };
            KeyEntry { endorsement, ..KeyEntry::new(current.clone()) }
        }
    };
    let keys = std::iter::once(entry).chain(earlier.into_iter().filter(|k| k.key != current)).collect();
    publishers.retain(|p| p.id != publisher);
    publishers.push(package::Publisher { id: publisher.into(), name: name.into(), keys });
    Ok(publishers)
}

/// `index`, unless a newer `openidea-plugin` wrote it (rewriting it would drop what this one can't read).
fn current_format(index: Index, file: &str) -> Result<Index, String> {
    if index.is_newer() {
        return Err(format!(
            "{file}: index format {} is newer than this tool writes; update openidea-plugin",
            index.format
        ));
    }
    Ok(index)
}

fn cmd_merge(args: &[String]) -> Result<(), String> {
    let a = Args::parse(args, &[], &["keep", "out"])?;
    let [base, other] = a.positional.as_slice() else {
        return Err("usage: openidea-plugin merge <index> <other-index> --keep ID [--out FILE]".into());
    };
    let keep = a.value("keep").ok_or("--keep is required")?;
    let out = a.value("out").unwrap_or(base);
    let mut index =
        current_format(Index::parse(&std::fs::read_to_string(base).map_err(|e| format!("{base}: {e}"))?)?, base)?;
    let bytes = read_market_url(other, 16 << 20)?;
    let theirs = Index::parse(&String::from_utf8(bytes).map_err(|_| format!("{other}: not UTF-8"))?)?;
    let mut theirs = current_format(theirs, other)?;
    // Their downloads are relative to their index, not to ours.
    for e in &mut theirs.plugins {
        e.download = resolve_market_href(other, &e.download);
    }
    let count = theirs.plugins.len();
    index.include(theirs, &[keep]).map_err(|e| format!("{other}: {e}"))?;
    println!("  {count} plugins from {other}");
    write_index(&index, Path::new(out))
}

fn write_index(index: &Index, out: &Path) -> Result<(), String> {
    let json = serde_json::to_string_pretty(index).map_err(|e| e.to_string())?;
    std::fs::write(out, json).map_err(|e| format!("{}: {e}", out.display()))?;
    println!("-> {} ({} plugins)", out.display(), index.plugins.len());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_new_key_is_endorsed_by_the_previous_one() {
        let (k1, k2, k3) =
            (PublisherKey::from_seed([1; 32]), PublisherKey::from_seed([2; 32]), PublisherKey::from_seed([3; 32]));
        let first = register_key(Vec::new(), "acme", "ACME", &k1, None).unwrap();
        let rotated = register_key(first.clone(), "acme", "ACME", &k2, Some(&k1)).unwrap();
        let index = Index { format: package::INDEX_FORMAT, publishers: rotated.clone(), ..Index::default() };
        assert!(index.succeeds("acme", &k1.public_base64(), &k2.public_base64()));
        assert_eq!(rotated[0].keys.len(), 2, "the earlier key stays listed");
        // Registering the current key again keeps its endorsement.
        let again = register_key(rotated.clone(), "acme", "ACME", &k2, None).unwrap();
        assert_eq!(again, rotated);
        // Only a key the publisher has can endorse.
        assert!(register_key(first.clone(), "acme", "ACME", &k2, Some(&k3)).unwrap_err().contains("--previous-key"));
        // Without one the new key is listed unendorsed.
        let unendorsed = register_key(first, "acme", "ACME", &k3, None).unwrap();
        assert!(unendorsed[0].keys[0].endorsement.is_none());
    }

    #[test]
    fn names() {
        assert_eq!(slugify("My Cool_Plugin"), "my-cool-plugin");
        assert_eq!(slugify("acme.Tools"), "acme.tools");
        assert_eq!(title_case("material-icons"), "Material Icons");
        assert_eq!(
            relative(Path::new("/a/b/plugins/x"), Path::new("/a/b/sdk/rust/p")).unwrap(),
            PathBuf::from("../../sdk/rust/p")
        );
        assert_eq!(relative(Path::new("/x/y"), Path::new("/z")), None);
    }

    /// A theme package `id` signed by `publisher` with `key`, packed into `out`.
    fn signed_theme(tmp: &Path, id: &str, publisher: &str, key: &str, out: &Path) {
        signed_theme_version(tmp, id, "0.1.0", "^1.0", publisher, key, out);
    }

    fn signed_theme_version(tmp: &Path, id: &str, version: &str, engine: &str, publisher: &str, key: &str, out: &Path) {
        let src = tmp.join("src").join(format!("{id}-{version}"));
        let vars = templates::Vars { id, name: id, sdk: None };
        for (rel, content) in templates::render(templates::Template::Theme, &vars) {
            let path = src.join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            let content = content
                .replace("version = \"0.1.0\"", &format!("version = \"{version}\""))
                .replace("engines.openidea = \"^1.0\"", &format!("engines.openidea = \"{engine}\""));
            std::fs::write(path, content).unwrap();
        }
        std::fs::create_dir_all(out).unwrap();
        let args = [src.to_str().unwrap(), "--key", key, "--publisher", publisher, "--out"]
            .into_iter()
            .map(String::from)
            .chain([out.join(format!("{id}-{version}.oiplugin")).to_string_lossy().into_owned()])
            .collect::<Vec<_>>();
        cmd_pack(&args).unwrap();
    }

    #[test]
    fn a_release_keeps_the_versions_older_ides_need() {
        let tmp = tempfile::tempdir().unwrap();
        let t = tmp.path();
        let key = t.join("acme.key");
        std::fs::write(&key, PublisherKey::from_seed([5; 32]).seed_base64()).unwrap();
        let key = key.to_string_lossy().into_owned();
        let index_file = t.join("index.json");
        let release = |n: usize, packages: &[(&str, &str, &str)]| {
            let dir = t.join(format!("release-{n}"));
            for (id, version, engine) in packages {
                signed_theme_version(t, id, version, engine, "acme", &key, &dir);
            }
            let base = format!("https://example.com/download/v{n}");
            let args = [dir.to_str().unwrap(), "--publisher", "acme", "--key", &key, "--download-base", &base];
            cmd_index(&strings(&[&args[..], &["--out", index_file.to_str().unwrap()]].concat())).unwrap();
            let index = Index::parse(&std::fs::read_to_string(&index_file).unwrap()).unwrap();
            index.plugins.iter().map(|e| format!("{} {} {}", e.id, e.version, e.download)).collect::<Vec<_>>()
        };
        release(1, &[("acme.a", "1.0.0", "^1.0"), ("acme.b", "1.0.0", "^1.0")]);
        // Same requirement: the newer version replaces it; acme.b is gone from the release.
        assert_eq!(
            release(2, &[("acme.a", "1.1.0", "^1.0")]),
            ["acme.a 1.1.0 https://example.com/download/v2/acme.a-1.1.0.oiplugin"]
        );
        // Another API requirement: the last version for the earlier one stays, where it was published.
        assert_eq!(
            release(3, &[("acme.a", "2.0.0", ">=1.0, <2")]),
            [
                "acme.a 1.1.0 https://example.com/download/v2/acme.a-1.1.0.oiplugin",
                "acme.a 2.0.0 https://example.com/download/v3/acme.a-2.0.0.oiplugin",
            ]
        );
        let index = Index::parse(&std::fs::read_to_string(&index_file).unwrap()).unwrap();
        assert_eq!(index.offered()[0].0.version, "2.0.0", "the newest this IDE can load");
    }

    fn strings(args: &[&str]) -> Vec<String> {
        args.iter().map(|a| a.to_string()).collect()
    }

    #[test]
    fn official_and_community_indexes_merge() {
        let tmp = tempfile::tempdir().unwrap();
        let t = tmp.path();
        let mut keys = Vec::new();
        for (name, seed) in [("openidea", 1), ("alice", 2), ("carol", 3)] {
            let file = t.join(format!("{name}.key"));
            let key = PublisherKey::from_seed([seed; 32]);
            std::fs::write(&file, key.seed_base64()).unwrap();
            keys.push((file.to_string_lossy().into_owned(), key.public_base64()));
        }
        let (official, community) = (t.join("official"), t.join("community"));
        signed_theme(t, "openidea.night", "openidea", &keys[0].0, &official);
        signed_theme(t, "alice.dawn", "alice", &keys[1].0, &community);
        let official_index = official.join("index.json");
        let community_index = community.join("index.json");
        let release = strings(&[official.to_str().unwrap(), "--publisher", "openidea", "--key", &keys[0].0]);
        cmd_index(&release).unwrap();

        // The community index lists its publishers; `index` without a key checks packages against them.
        let skeleton = Index {
            format: package::INDEX_FORMAT,
            publishers: vec![package::Publisher {
                id: "alice".into(),
                name: "Alice".into(),
                keys: vec![KeyEntry::new(keys[1].1.clone())],
            }],
            ..Index::default()
        };
        write_index(&skeleton, &community_index).unwrap();
        cmd_index(&strings(&[community.to_str().unwrap()])).unwrap();

        cmd_merge(&strings(&[
            official_index.to_str().unwrap(),
            community_index.to_str().unwrap(),
            "--keep",
            "openidea",
        ]))
        .unwrap();
        // A release rebuilds the official plugins and keeps the community's.
        cmd_index(&release).unwrap();
        let index = Index::parse(&std::fs::read_to_string(&official_index).unwrap()).unwrap();
        let listed: Vec<_> = index.plugins.iter().map(|e| (e.id.as_str(), e.publisher.as_str())).collect();
        assert_eq!(listed, [("alice.dawn", "alice"), ("openidea.night", "openidea")]);
        assert_eq!(index.plugins[1].categories, ["themes"], "implied by the theme");
        assert_eq!(index.plugins[1].download, "openidea.night-0.1.0.oiplugin");
        assert!(Path::new(&index.plugins[0].download).is_absolute(), "{}", index.plugins[0].download);

        // A package by a publisher the index doesn't know is refused.
        signed_theme(t, "carol.noon", "carol", &keys[2].0, &community);
        let err = cmd_index(&strings(&[community.to_str().unwrap()])).unwrap_err();
        assert!(err.contains("unknown publisher"), "{err}");
    }

    #[test]
    fn every_template_is_a_valid_package() {
        for t in templates::Template::ALL {
            let dir =
                std::env::temp_dir().join(format!("openidea-plugin-template-{}-{}", t.label(), std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            let vars = templates::Vars { id: "acme.sample", name: "Sample", sdk: Some("../sdk") };
            for (rel, content) in templates::render(t, &vars) {
                let path = dir.join(rel);
                std::fs::create_dir_all(path.parent().unwrap()).unwrap();
                std::fs::write(path, content).unwrap();
            }
            let m = Manifest::load(&dir).unwrap_or_else(|e| panic!("{}: {e}", t.label()));
            assert_eq!(m.id, "acme.sample");
            if m.wasm.is_none() {
                check(&dir).unwrap_or_else(|e| panic!("{}: {e}", t.label()));
            }
            std::fs::remove_dir_all(&dir).unwrap();
        }
    }
}
