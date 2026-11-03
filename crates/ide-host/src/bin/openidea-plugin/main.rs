//! `openidea-plugin`: scaffolds, builds, checks and links OpenIDEA plugins.
//!
//! ```text
//! openidea-plugin new <dir> [--template command|theme|icon-theme|language] [--id ID] [--name NAME] [--sdk PATH]
//! openidea-plugin build [dir] [--debug]   # cargo → dist/plugin.wasm, then `check`
//! openidea-plugin check [dir]             # validate the package as the IDE would install it
//! openidea-plugin link [dir]              # load the folder in the IDE without installing it
//! openidea-plugin unlink [dir]
//! openidea-plugin links                   # list linked folders
//! openidea-plugin keygen <key-file>       # a publisher's Ed25519 key
//! openidea-plugin pack [dir] [--key F --publisher ID] [--out FILE]   # <id>-<version>.oiplugin
//! openidea-plugin index <dir> --publisher ID --name NAME --key F     # marketplace index.json
//! ```
//!
//! `link` writes `links.json` in the IDE's plugins directory
//! (`$OPENIDEA_PLUGINS_DIR`, or the app data directory); the IDE picks the
//! change up when Settings › Plugins is opened or refreshed. Linked plugins
//! are re-read from the folder, so `build` + refresh is the edit loop.

mod templates;

use ide_extension::{Manifest, validate_plugin_id};
use ide_host::plugins::PluginHost;
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
  check [dir]             validate the package as the IDE would install it
  link [dir]              load the folder in the IDE without installing it
  unlink [dir]            stop loading a linked folder
  links                   list linked folders
  keygen <key-file>       create a publisher signing key (keep the file secret)
  pack [dir] [--key F --publisher ID] [--out FILE]
                          write <id>-<version>.oiplugin, signed with the key
  index <dir> --publisher ID --name NAME --key F [--out FILE]
                          write the marketplace index.json for the packages in dir

environment:
  OPENIDEA_PLUGINS_DIR    the IDE's plugins directory (default: the app data directory)";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.first().map(String::as_str) {
        Some("new") => cmd_new(&args[1..]),
        Some("build") => cmd_build(&args[1..]),
        Some("check") => dir_arg(&args[1..]).and_then(|d| check(&d)),
        Some("link") => dir_arg(&args[1..]).and_then(|d| link(&d, true)),
        Some("unlink") => dir_arg(&args[1..]).and_then(|d| link(&d, false)),
        Some("links") => list_links(),
        Some("keygen") => cmd_keygen(&args[1..]),
        Some("pack") => cmd_pack(&args[1..]),
        Some("index") => cmd_index(&args[1..]),
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
fn check(dir: &Path) -> Result<(), String> {
    let dir = canonical(dir)?;
    let scratch = std::env::temp_dir().join(format!("openidea-plugin-check-{}", std::process::id()));
    let result = (|| {
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
    })();
    let _ = std::fs::remove_dir_all(&scratch);
    result
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

/// A scratch host to list a package's files as the IDE would.
fn with_scratch_host<T>(f: impl FnOnce(&PluginHost) -> Result<T, String>) -> Result<T, String> {
    let scratch = std::env::temp_dir().join(format!("openidea-plugin-pack-{}", std::process::id()));
    let result = PluginHost::new(scratch.clone(), Arc::new(|_: Option<&str>, _| {}), Limits::default())
        .map_err(|e| e.to_string())
        .and_then(|h| f(&h));
    let _ = std::fs::remove_dir_all(&scratch);
    result
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
    let a = Args::parse(args, &[], &["publisher", "name", "key", "out"])?;
    let dir = canonical(&a.dir()?)?;
    let publisher = a.value("publisher").ok_or("--publisher is required")?;
    let name = a.value("name").unwrap_or(publisher);
    let key = read_key(a.value("key").ok_or("--key is required")?)?;
    let out = a.value("out").map(PathBuf::from).unwrap_or_else(|| dir.join("index.json"));
    // Revocations and other publishers of an existing index are kept.
    let mut index = match std::fs::read_to_string(&out) {
        Ok(text) => Index::parse(&text)?,
        Err(_) => Index { format: package::INDEX_FORMAT, ..Index::default() },
    };
    // Earlier keys of the publisher stay listed (packages they signed remain valid until revoked).
    let current = key.public_base64();
    let earlier: Vec<KeyEntry> = index
        .publishers
        .iter()
        .filter(|p| p.id == publisher)
        .flat_map(|p| p.keys.iter().filter(|k| k.key != current).cloned())
        .collect();
    index.publishers.retain(|p| p.id != publisher);
    let keys: Vec<KeyEntry> = std::iter::once(KeyEntry { key: current, revoked: false }).chain(earlier).collect();
    index.publishers.push(package::Publisher { id: publisher.into(), name: name.into(), keys });
    index.plugins.clear();
    let mut packages: Vec<PathBuf> = std::fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|e| e == package::PACKAGE_EXTENSION))
        .collect();
    packages.sort();
    for path in packages {
        let scratch = std::env::temp_dir().join(format!("openidea-plugin-index-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&scratch);
        let unpacked = package::unpack(&path, &scratch)?;
        let entry = (|| {
            let m = Manifest::load(&scratch)?;
            let files = with_scratch_host(|h| h.package_files_of(&scratch).map_err(|e| e.to_string()))?;
            let digest = package::package_digest(&scratch, &files).map_err(|e| e.to_string())?;
            let sig = unpacked.signature.as_ref().ok_or_else(|| format!("{}: not signed", path.display()))?;
            sig.check(&m.id, &m.version, &digest).map_err(|e| format!("{}: {e}", path.display()))?;
            Ok::<_, String>(IndexEntry {
                id: m.id.clone(),
                name: m.name.clone(),
                version: m.version.clone(),
                description: m.description.clone(),
                authors: m.authors.clone(),
                publisher: sig.publisher.clone(),
                download: path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
                digest,
                capabilities: m.capabilities.all().map(|c| c.to_string()).collect(),
            })
        })();
        let _ = std::fs::remove_dir_all(&scratch);
        let entry = entry?;
        println!("  {} {}", entry.id, entry.version);
        index.plugins.push(entry);
    }
    let json = serde_json::to_string_pretty(&index).map_err(|e| e.to_string())?;
    std::fs::write(&out, json).map_err(|e| format!("{}: {e}", out.display()))?;
    println!("-> {} ({} plugins)", out.display(), index.plugins.len());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

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
