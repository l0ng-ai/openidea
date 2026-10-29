//! Installed JDKs and the jdtls launch configuration that depends on them.

use crate::apply::merge_init_options;
use crate::home_dir;
use ide_language::LanguageServerConfig;
use serde_json::json;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// A JDK home and its feature version (8, 11, 17, 21…).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Jdk {
    pub major: u32,
    pub home: PathBuf,
}

/// `JAVA_VERSION="21.0.3"` (or `"1.8.0_372"`) from a JDK's `release` file.
pub fn parse_release(release: &str) -> Option<u32> {
    let line = release.lines().find_map(|l| l.trim().strip_prefix("JAVA_VERSION="))?;
    let v = line.trim().trim_matches('"');
    let mut parts = v.split(['.', '_', '-', '+']);
    let first: u32 = parts.next()?.parse().ok()?;
    if first == 1 { parts.next()?.parse().ok() } else { Some(first) }
}

/// The JDK at `home`, if it is one (a `release` file and `bin/java`).
pub fn jdk_at(home: &Path) -> Option<Jdk> {
    let release = std::fs::read_to_string(home.join("release")).ok()?;
    if !home.join("bin").join(crate::exe("java")).is_file() {
        return None;
    }
    Some(Jdk {
        major: parse_release(&release)?,
        home: dunce::canonicalize(home).unwrap_or_else(|_| home.to_path_buf()),
    })
}

fn children(dir: &Path) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> =
        std::fs::read_dir(dir).map(|rd| rd.flatten().map(|e| e.path()).collect()).unwrap_or_default();
    out.sort();
    out
}

/// Vendor directories JDK installers use on Windows, under `Program Files`
/// and (per-user installs) `%LOCALAPPDATA%\Programs`.
const WINDOWS_VENDORS: &[&str] =
    &["Java", "Eclipse Adoptium", "Microsoft", "Zulu", "Amazon Corretto", "BellSoft", "Semeru", "OpenJDK"];

/// Folders the IDE downloads JDKs into ([`add_jdk_root`]).
static EXTRA_ROOTS: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());

/// Scans the JDKs in `dir` (one per subfolder) too, e.g. where Download JDK puts them.
pub fn add_jdk_root(dir: &Path) {
    let mut roots = EXTRA_ROOTS.lock().unwrap_or_else(|e| e.into_inner());
    if !roots.iter().any(|r| r == dir) {
        roots.push(dir.to_path_buf());
    }
}

/// Whether `home` lies in a folder registered with [`add_jdk_root`].
pub fn is_downloaded(home: &Path) -> bool {
    let roots = EXTRA_ROOTS.lock().unwrap_or_else(|e| e.into_inner());
    roots.iter().any(|r| home.starts_with(r) || dunce::canonicalize(r).is_ok_and(|r| home.starts_with(r)))
}

/// JDK homes in the usual install locations (macOS `JavaVirtualMachines`,
/// `/usr/lib/jvm`, SDKMAN, mise, asdf, IDEA's `~/.jdks`, Homebrew, Windows vendor
/// directories, the IDE's downloads), `JAVA_HOME` first, then the `java` on `PATH`.
fn scan() -> Vec<Jdk> {
    let mut homes: Vec<PathBuf> = Vec::new();
    if let Some(h) = std::env::var_os("JAVA_HOME") {
        homes.push(PathBuf::from(h));
    }
    let path = std::env::var_os("PATH").unwrap_or_default();
    if let Some(java) = std::env::split_paths(&path).map(|d| d.join(crate::exe("java"))).find(|j| j.is_file()) {
        // Through symlinks (`/usr/bin/java`, Homebrew, SDKMAN `current`) to `<home>/bin/java`.
        if let Some(home) = dunce::canonicalize(java).ok().and_then(|j| j.parent()?.parent().map(Path::to_path_buf)) {
            homes.push(home);
        }
    }
    let home = home_dir();
    let mut roots: Vec<PathBuf> = vec![
        PathBuf::from("/Library/Java/JavaVirtualMachines"),
        PathBuf::from("/usr/lib/jvm"),
        PathBuf::from("/opt/homebrew/opt"),
        PathBuf::from("/usr/local/opt"),
    ];
    if let Some(h) = &home {
        roots.extend([h.join("Library/Java/JavaVirtualMachines"), h.join(".jdks"), h.join(".sdkman/candidates/java")]);
    }
    roots.extend(EXTRA_ROOTS.lock().unwrap_or_else(|e| e.into_inner()).iter().cloned());
    if cfg!(windows) {
        let bases = ["ProgramFiles", "ProgramW6432", "LOCALAPPDATA"].into_iter().filter_map(|v| {
            let dir = PathBuf::from(std::env::var_os(v)?);
            Some(if v == "LOCALAPPDATA" { dir.join("Programs") } else { dir })
        });
        for base in bases {
            roots.extend(WINDOWS_VENDORS.iter().map(|v| base.join(v)));
        }
    }
    for (i, root) in roots.iter().enumerate() {
        // `ProgramFiles` and `ProgramW6432` are usually the same directory.
        if roots[..i].contains(root) {
            continue;
        }
        for dir in children(root) {
            homes.extend([dir.join("Contents/Home"), dir.join("libexec/openjdk.jdk/Contents/Home"), dir]);
        }
    }
    // mise keeps a macOS JDK as its bundle (`<version>/Contents/Home`), asdf flattens it.
    for (dir, _) in ide_core::version_managers::installs(ide_core::version_managers::Tool::Java) {
        homes.extend([dir.join("Contents/Home"), dir]);
    }
    let mut out: Vec<Jdk> = Vec::new();
    for h in homes {
        if let Some(jdk) = jdk_at(&h)
            && !out.iter().any(|j| j.home == jdk.home)
        {
            out.push(jdk);
        }
    }
    out
}

/// How long a scan that found no JDK able to run jdtls is reused before
/// [`jdtls_jdks`] scans again.
const RESCAN_AFTER: Duration = Duration::from_secs(10);

struct Scan {
    at: Instant,
    jdks: Arc<[Jdk]>,
}

static JDKS: Mutex<Option<Scan>> = Mutex::new(None);

fn rescan(slot: &mut Option<Scan>) -> Arc<[Jdk]> {
    slot.insert(Scan { at: Instant::now(), jdks: scan().into() }).jdks.clone()
}

/// Scans for installed JDKs again (Settings › Detect again).
pub fn rescan_jdks() -> Arc<[Jdk]> {
    rescan(&mut JDKS.lock().unwrap_or_else(|e| e.into_inner()))
}

/// Installed JDKs (scanned on first use; [`jdtls_jdks`] may refresh them).
pub fn installed_jdks() -> Arc<[Jdk]> {
    let mut slot = JDKS.lock().unwrap_or_else(|e| e.into_inner());
    match &*slot {
        Some(s) => s.jdks.clone(),
        None => rescan(&mut slot),
    }
}

/// Like [`installed_jdks`], but while none can run jdtls (on Java `min_java`)
/// the list is rescanned (at most every [`RESCAN_AFTER`]), so a JDK installed
/// after startup is picked up when the server is restarted.
pub fn jdtls_jdks(min_java: u32) -> Arc<[Jdk]> {
    let mut slot = JDKS.lock().unwrap_or_else(|e| e.into_inner());
    match &*slot {
        Some(s) if jdtls_runtime(&s.jdks, min_java).is_some() || s.at.elapsed() < RESCAN_AFTER => s.jdks.clone(),
        _ => rescan(&mut slot),
    }
}

/// For a server with `max-java`: when the `JAVA_HOME` it would get (its env,
/// else the IDE's) is a newer JDK, points it at the newest of `jdks` that fits.
pub fn cap_java_home(cfg: &mut LanguageServerConfig, jdks: &[Jdk]) {
    let Some(max) = cfg.max_java else { return };
    let current = cfg.env.get("JAVA_HOME").cloned().or_else(|| std::env::var("JAVA_HOME").ok());
    if current.as_deref().and_then(|h| jdk_at(Path::new(h))).is_some_and(|j| j.major <= max) {
        return;
    }
    if let Some(jdk) = jdks.iter().filter(|j| j.major <= max).max_by_key(|j| j.major) {
        cfg.env.insert("JAVA_HOME".into(), jdk.home.to_string_lossy().into_owned());
    }
}

/// Oldest Java version jdtls runs on when its install can't tell (its launcher's check).
pub const JDTLS_MIN_JAVA: u32 = 21;

/// The JDK to run jdtls with: the first found that is new enough (`JAVA_HOME` wins).
pub fn jdtls_runtime(jdks: &[Jdk], min_java: u32) -> Option<&Jdk> {
    jdks.iter().find(|j| j.major >= min_java)
}

/// The Java version the jdtls that `cfg` launches needs: the highest any of its
/// bundles requires, never below [`JDTLS_MIN_JAVA`]. Its launcher only checks
/// for 21, but the Eclipse platform it ships moves on (1.63 needs 25), and on
/// an older JDK the server dies resolving its bundles.
pub fn jdtls_min_java(cfg: &LanguageServerConfig) -> u32 {
    let search = cfg.env.get("PATH").map(std::ffi::OsString::from).or_else(|| std::env::var_os("PATH"));
    let required = search
        .and_then(|s| ide_run::which::find_executable(&cfg.command, &s))
        .and_then(|exe| dunce::canonicalize(exe).ok())
        .and_then(|exe| Some(exe.parent()?.parent()?.to_path_buf()))
        .and_then(|home| bundles_min_java(&home));
    required.map_or(JDTLS_MIN_JAVA, |v| v.max(JDTLS_MIN_JAVA))
}

/// Per install: (plugins directory mtime, its requirement).
static BUNDLE_JAVA: Mutex<BTreeMap<PathBuf, (std::time::SystemTime, Option<u32>)>> = Mutex::new(BTreeMap::new());

/// Highest Java version required by the bundles in `home`'s `plugins` (or Homebrew's
/// `libexec/plugins`); `None` when there are none to read.
fn bundles_min_java(home: &Path) -> Option<u32> {
    let plugins = [home.join("plugins"), home.join("libexec").join("plugins")].into_iter().find(|p| p.is_dir())?;
    let modified = std::fs::metadata(&plugins).and_then(|m| m.modified()).ok()?;
    let mut cache = BUNDLE_JAVA.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((at, v)) = cache.get(&plugins)
        && *at == modified
    {
        return *v;
    }
    let required = std::fs::read_dir(&plugins)
        .ok()?
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "jar"))
        .filter_map(|jar| jar_manifest(&jar))
        .filter_map(|manifest| manifest_min_java(&manifest))
        .max();
    cache.insert(plugins, (modified, required));
    required
}

fn jar_manifest(jar: &Path) -> Option<String> {
    use std::io::Read;
    let mut zip = zip::ZipArchive::new(std::fs::File::open(jar).ok()?).ok()?;
    let mut entry = zip.by_name("META-INF/MANIFEST.MF").ok()?;
    let mut text = String::new();
    entry.read_to_string(&mut text).ok()?;
    Some(text)
}

/// The Java version an OSGi bundle manifest requires: its `osgi.ee` capability
/// (`version=25`), else the oldest of its `Bundle-RequiredExecutionEnvironment`s.
fn manifest_min_java(manifest: &str) -> Option<u32> {
    // Long headers continue on lines starting with a space.
    let mut headers: Vec<String> = Vec::new();
    for line in manifest.lines() {
        match (line.strip_prefix(' '), headers.last_mut()) {
            (Some(rest), Some(last)) => last.push_str(rest),
            _ => headers.push(line.to_owned()),
        }
    }
    let header = |name: &str| headers.iter().find_map(|h| h.strip_prefix(name)?.strip_prefix(':')).map(str::trim);
    if let Some(caps) = header("Require-Capability") {
        let ee = caps.split(',').filter(|c| c.trim_start().starts_with("osgi.ee")).find_map(|c| {
            let v = c.split("version=").nth(1)?;
            let digits: String = v.chars().take_while(char::is_ascii_digit).collect();
            digits.parse::<u32>().ok()
        });
        if ee.is_some() {
            return ee;
        }
    }
    header("Bundle-RequiredExecutionEnvironment")?
        .split(',')
        .filter_map(|ee| ee.trim().strip_prefix("JavaSE-"))
        .filter_map(|v| if v == "1.8" { Some(8) } else { v.parse().ok() })
        .min()
}

/// jdtls `java.configuration.runtimes`: one JDK per Java version (the first
/// found, i.e. `JAVA_HOME` wins), named after its execution environment, so a
/// project targeting Java 21 compiles against a JDK 21 rather than the JDK
/// jdtls itself runs on.
pub fn runtimes(jdks: &[Jdk]) -> Vec<serde_json::Value> {
    let mut by_major: BTreeMap<u32, &Jdk> = BTreeMap::new();
    for j in jdks {
        by_major.entry(j.major).or_insert(j);
    }
    by_major
        .into_iter()
        .filter(|(major, _)| *major >= 8)
        .map(|(major, j)| {
            let name = if major == 8 { "JavaSE-1.8".to_owned() } else { format!("JavaSE-{major}") };
            json!({ "name": name, "path": j.home.to_string_lossy() })
        })
        .collect()
}

/// Stable FNV-1a hash of a path, for per-workspace directories.
fn path_key(p: &Path) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in p.to_string_lossy().as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}")
}

const METADATA_PROPERTY: &str = "java.import.generatesMetadataFilesAtProjectRoot";

/// jdtls: its Eclipse workspace (`-data`) lives under the IDE's data
/// directory, one per server root, and no Eclipse metadata is written into
/// the project; it runs on a JDK `min_java`+ (via `JAVA_HOME`, which its
/// launcher reads), installed JDKs are registered as runtimes and `bundles`
/// (e.g. the java-debug plugin jar) are loaded into the server. The project
/// JDK, when set, is the default runtime and preferred for running the server;
/// `server_jdk` (the user's choice for the server alone) overrides that.
#[allow(clippy::too_many_arguments)]
pub fn configure_jdtls(
    cfg: &mut LanguageServerConfig,
    server_root: &Path,
    data_dir: &Path,
    jdks: &[Jdk],
    project_jdk: Option<&Jdk>,
    server_jdk: Option<&Jdk>,
    min_java: u32,
    bundles: &[PathBuf],
    lombok: Option<&Path>,
) {
    if cfg.name != "jdtls" {
        return;
    }
    // A Lombok agent from the user's JVM arguments wins.
    let own_agent = crate::lombok::agent_in_args(cfg.args.iter().map(String::as_str));
    let agent = own_agent.as_deref().or(lombok);
    if !cfg.args.iter().any(|a| a == "-data") {
        // ECJ builds incrementally: classes compiled without (or with another) Lombok
        // agent would be kept, so each agent gets its own workspace and a full build.
        let key = match agent {
            Some(jar) => format!("{}-{}", path_key(server_root), path_key(jar)),
            None => path_key(server_root),
        };
        let dir = data_dir.join("lsp").join("jdtls").join(key);
        cfg.args.extend(["-data".to_owned(), dir.to_string_lossy().into_owned()]);
    }
    // jdtls reads this one as a system property (its file-system bundle
    // relocates .project / .classpath / .settings into the workspace).
    if !cfg.args.iter().any(|a| a.contains(METADATA_PROPERTY)) {
        cfg.args.push(format!("--jvm-arg=-D{METADATA_PROPERTY}=false"));
    }
    if own_agent.is_none()
        && let Some(jar) = lombok
    {
        cfg.args.push(format!("--jvm-arg=-javaagent:{}", jar.to_string_lossy()));
    }
    crate::jdtls::add_default_vm_args(&mut cfg.args);
    let mut all: Vec<Jdk> = Vec::new();
    for j in project_jdk.into_iter().chain(jdks).chain(server_jdk) {
        if !all.contains(j) {
            all.push(j.clone());
        }
    }
    let jdks = all.as_slice();
    if !cfg.env.contains_key("JAVA_HOME") {
        let runtime = match server_jdk {
            Some(jdk) if jdk.major < min_java => Err(server_jdk_too_old_message(jdk, min_java)),
            Some(jdk) => Ok(jdk),
            None => jdtls_runtime(jdks, min_java).ok_or_else(|| missing_runtime_message(jdks, min_java)),
        };
        match runtime {
            Ok(jdk) => {
                cfg.env.insert("JAVA_HOME".to_owned(), jdk.home.to_string_lossy().into_owned());
            }
            Err(e) => cfg.launch_error = Some(e),
        }
    }
    let mut runtimes = runtimes(jdks);
    if let Some(project) = project_jdk {
        let home = project.home.to_string_lossy();
        for r in &mut runtimes {
            if r["path"] == *home {
                r["default"] = json!(true);
            }
        }
    }
    if !runtimes.is_empty() {
        merge_init_options(cfg, json!({ "settings": { "java": { "configuration": { "runtimes": runtimes } } } }));
    }
    if !bundles.is_empty() {
        let bundles: Vec<String> = bundles.iter().map(|b| b.to_string_lossy().into_owned()).collect();
        merge_init_options(cfg, json!({ "bundles": bundles }));
    }
}

/// Where the JDK that runs jdtls is chosen, named as the settings dialog shows it.
const SERVER_JDK_SETTING: &str = "Settings › Languages & Frameworks › Java › Language Server › JDK";

/// `found JDK 8, 17` / `no JDK was found`.
fn found_jdks(jdks: &[Jdk]) -> String {
    let mut found: Vec<u32> = jdks.iter().map(|j| j.major).collect();
    found.sort_unstable();
    found.dedup();
    if found.is_empty() {
        "no JDK was found".to_owned()
    } else {
        let list: Vec<String> = found.iter().map(u32::to_string).collect();
        format!("found JDK {}", list.join(", "))
    }
}

// The UI offers "Download JDK N" for messages saying "needs JDK N or newer".
fn missing_runtime_message(jdks: &[Jdk], min_java: u32) -> String {
    format!(
        "jdtls needs JDK {min_java} or newer to run ({}). Download JDK {min_java}, or pick an installed one in \
         {SERVER_JDK_SETTING} (it restarts automatically); the project can still target an older Java version.",
        found_jdks(jdks)
    )
}

fn server_jdk_too_old_message(jdk: &Jdk, min_java: u32) -> String {
    format!(
        "The language server JDK ({}, JDK {}) is too old: jdtls needs JDK {min_java} or newer. Download JDK \
         {min_java}, choose another one in {SERVER_JDK_SETTING}, or set it to Auto.",
        jdk.home.display(),
        jdk.major
    )
}

/// Why a module targeting Java `release` can't be built or run with the installed
/// JDKs (none is that new), or `None` when one is (or the release is unknown).
pub fn missing_jdk_message(jdks: &[Jdk], release: Option<u32>) -> Option<String> {
    let release = release?;
    if jdks.iter().any(|j| j.major >= release) {
        return None;
    }
    Some(format!(
        "This project targets Java {release}: it needs JDK {release} or newer ({}). Download JDK {release}, or \
         choose a Project JDK in Settings › Languages & Frameworks › Java.",
        found_jdks(jdks)
    ))
}

/// The `java` launcher of a JDK home.
pub fn java_executable(home: &Path) -> PathBuf {
    home.join("bin").join(crate::exe("java"))
}

/// The JDK to run a project targeting Java `release` with: that exact version,
/// else the oldest newer one, else the newest installed (`None`: any, newest).
pub fn pick_jdk(jdks: &[Jdk], release: Option<u32>) -> Option<&Jdk> {
    let newest = jdks.iter().max_by_key(|j| j.major);
    let Some(release) = release else { return newest };
    jdks.iter()
        .find(|j| j.major == release)
        .or_else(|| jdks.iter().filter(|j| j.major > release).min_by_key(|j| j.major))
        .or(newest)
}

/// Java version a Maven / Gradle module targets: `<java.version>`,
/// `<maven.compiler.release|source|target>` / `<release>`, Gradle toolchains
/// (`JavaLanguageVersion.of(21)`) or `sourceCompatibility`.
pub fn project_java_version(module_dir: &Path) -> Option<u32> {
    let read = |name: &str| std::fs::read_to_string(module_dir.join(name)).ok();
    if let Some(pom) = read("pom.xml") {
        for tag in
            ["java.version", "maven.compiler.release", "release", "maven.compiler.source", "maven.compiler.target"]
        {
            if let Some(v) = xml_value(&pom, tag).and_then(|v| parse_java_version(&v)) {
                return Some(v);
            }
        }
    }
    for name in ["build.gradle.kts", "build.gradle"] {
        let Some(text) = read(name) else { continue };
        if let Some(i) = text.find("JavaLanguageVersion.of(") {
            let rest = &text[i + "JavaLanguageVersion.of(".len()..];
            if let Some(v) = parse_java_version(rest.split(')').next().unwrap_or_default()) {
                return Some(v);
            }
        }
        for key in ["sourceCompatibility", "targetCompatibility"] {
            if let Some(i) = text.find(key) {
                let rest = text[i + key.len()..].trim_start_matches([' ', '=', '\t']);
                let token: String = rest
                    .chars()
                    .take_while(|c| !c.is_whitespace() && *c != '\n')
                    .collect::<String>()
                    .trim_matches(['\'', '"'])
                    .replace("JavaVersion.VERSION_", "");
                if let Some(v) = parse_java_version(&token.replace('_', ".")) {
                    return Some(v);
                }
            }
        }
    }
    None
}

pub(crate) fn xml_value(text: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}>");
    let start = text.find(&open)? + open.len();
    let end = text[start..].find('<')?;
    Some(text[start..start + end].trim().to_owned())
}

/// `21`, `"17"`, `1.8`, `'11'` → feature version.
fn parse_java_version(v: &str) -> Option<u32> {
    let v = v.trim().trim_matches(['"', '\'']);
    let mut parts = v.split('.');
    let first: u32 = parts.next()?.trim().parse().ok()?;
    if first == 1 { parts.next()?.trim().parse().ok() } else { Some(first) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn release_versions() {
        assert_eq!(parse_release("IMPLEMENTOR=\"x\"\nJAVA_VERSION=\"21.0.3\"\n"), Some(21));
        assert_eq!(parse_release("JAVA_VERSION=\"1.8.0_372\""), Some(8));
        assert_eq!(parse_release("JAVA_VERSION=\"25\""), Some(25));
        assert_eq!(parse_release("OTHER=1"), None);
    }

    #[test]
    fn jdtls_workspace_and_runtimes() {
        if cfg!(windows) {
            return; // Unix paths and shells
        }
        let mut cfg: LanguageServerConfig = toml::from_str("name = \"jdtls\"\ncommand = \"jdtls\"").unwrap();
        let jdks = [
            Jdk { major: 25, home: PathBuf::from("/jdk25") },
            Jdk { major: 21, home: PathBuf::from("/jdk21a") },
            Jdk { major: 21, home: PathBuf::from("/jdk21b") },
            Jdk { major: 8, home: PathBuf::from("/jdk8") },
        ];
        let bundles = [PathBuf::from("/tools/java-debug/bin/com.microsoft.java.debug.plugin.jar")];
        configure_jdtls(
            &mut cfg,
            Path::new("/p/demo"),
            Path::new("/data"),
            &jdks,
            None,
            None,
            JDTLS_MIN_JAVA,
            &bundles,
            None,
        );
        let defaults: Vec<String> = crate::jdtls::DEFAULT_VM_ARGS.iter().map(|a| format!("--jvm-arg={a}")).collect();
        let n = defaults.len();
        assert_eq!(cfg.args[..n], defaults, "our JVM options come first");
        assert_eq!(cfg.args[n], "-data");
        assert!(cfg.args[n + 1].starts_with("/data/lsp/jdtls/"), "{}", cfg.args[n + 1]);
        assert_eq!(cfg.args[n + 2], "--jvm-arg=-Djava.import.generatesMetadataFilesAtProjectRoot=false");
        let opts = serde_json::to_value(cfg.initialization_options.clone().unwrap()).unwrap();
        let rt = &opts["settings"]["java"]["configuration"]["runtimes"];
        assert_eq!(rt[0], json!({ "name": "JavaSE-1.8", "path": "/jdk8" }));
        assert_eq!(rt[1], json!({ "name": "JavaSE-21", "path": "/jdk21a" }));
        assert_eq!(rt[2], json!({ "name": "JavaSE-25", "path": "/jdk25" }));
        assert_eq!(opts["bundles"], json!(["/tools/java-debug/bin/com.microsoft.java.debug.plugin.jar"]));
        assert_eq!(cfg.env["JAVA_HOME"], "/jdk25", "first JDK new enough to run jdtls");
        assert_eq!(cfg.launch_error, None);

        // Deterministic (reconfigure compares configs) and idempotent.
        let before = cfg.clone();
        configure_jdtls(
            &mut cfg,
            Path::new("/p/demo"),
            Path::new("/data"),
            &jdks,
            None,
            None,
            JDTLS_MIN_JAVA,
            &bundles,
            None,
        );
        assert_eq!(cfg, before);

        // The project JDK is the default runtime, and runs the server when new enough.
        let project = Jdk { major: 21, home: PathBuf::from("/jdk21b") };
        let mut cfg: LanguageServerConfig = toml::from_str("name = \"jdtls\"\ncommand = \"jdtls\"").unwrap();
        configure_jdtls(
            &mut cfg,
            Path::new("/p"),
            Path::new("/data"),
            &jdks,
            Some(&project),
            None,
            JDTLS_MIN_JAVA,
            &[],
            None,
        );
        let opts = serde_json::to_value(cfg.initialization_options.clone().unwrap()).unwrap();
        let rt = &opts["settings"]["java"]["configuration"]["runtimes"];
        assert_eq!(rt[1], json!({ "name": "JavaSE-21", "path": "/jdk21b", "default": true }));
        assert_eq!(cfg.env["JAVA_HOME"], "/jdk21b");

        let mut other: LanguageServerConfig = toml::from_str("name = \"pyright\"\ncommand = \"x\"").unwrap();
        configure_jdtls(
            &mut other,
            Path::new("/p"),
            Path::new("/data"),
            &jdks,
            None,
            None,
            JDTLS_MIN_JAVA,
            &bundles,
            None,
        );
        assert!(other.args.is_empty() && other.initialization_options.is_none());
    }

    #[test]
    fn jdtls_lombok_agent() {
        let jdtls = || -> LanguageServerConfig { toml::from_str("name = \"jdtls\"\ncommand = \"jdtls\"").unwrap() };
        let jar = Path::new("/m2/lombok-1.18.48.jar");
        let mut cfg = jdtls();
        configure_jdtls(&mut cfg, Path::new("/p"), Path::new("/data"), &[], None, None, JDTLS_MIN_JAVA, &[], Some(jar));
        let agent = format!("--jvm-arg=-javaagent:{}", jar.to_string_lossy());
        assert!(cfg.args.contains(&agent), "{:?}", cfg.args);
        let mut plain = jdtls();
        configure_jdtls(&mut plain, Path::new("/p"), Path::new("/data"), &[], None, None, JDTLS_MIN_JAVA, &[], None);
        let data = |c: &LanguageServerConfig| c.args[c.args.iter().position(|a| a == "-data").unwrap() + 1].clone();
        assert_ne!(data(&cfg), data(&plain), "a separate workspace, so everything is rebuilt with the agent");
        let before = cfg.clone();
        configure_jdtls(&mut cfg, Path::new("/p"), Path::new("/data"), &[], None, None, JDTLS_MIN_JAVA, &[], Some(jar));
        assert_eq!(cfg, before, "idempotent");

        let mut cfg = jdtls();
        cfg.args.push("--jvm-arg=-javaagent:/own/lombok.jar".into());
        configure_jdtls(&mut cfg, Path::new("/p"), Path::new("/data"), &[], None, None, JDTLS_MIN_JAVA, &[], Some(jar));
        assert!(!cfg.args.contains(&agent), "the user's agent wins");
        let mut own = jdtls();
        own.args.push("--jvm-arg=-javaagent:/own/lombok.jar".into());
        configure_jdtls(&mut own, Path::new("/p"), Path::new("/data"), &[], None, None, JDTLS_MIN_JAVA, &[], None);
        assert_eq!(cfg.args, own.args, "its workspace follows the agent in use");
    }

    #[test]
    fn jdtls_needs_a_new_enough_jdk_to_run() {
        let jdtls = || -> LanguageServerConfig { toml::from_str("name = \"jdtls\"\ncommand = \"jdtls\"").unwrap() };
        let old = [Jdk { major: 17, home: PathBuf::from("/jdk17") }, Jdk { major: 8, home: PathBuf::from("/jdk8") }];
        let mut cfg = jdtls();
        configure_jdtls(&mut cfg, Path::new("/p"), Path::new("/data"), &old, None, None, JDTLS_MIN_JAVA, &[], None);
        assert!(!cfg.env.contains_key("JAVA_HOME"));
        let err = cfg.launch_error.unwrap();
        assert!(err.contains("JDK 21 or newer") && err.contains("found JDK 8, 17"), "{err}");
        // The user cannot be sent to JAVA_HOME alone: the language server JDK is a setting.
        assert!(err.contains(SERVER_JDK_SETTING) && !err.contains("point JAVA_HOME at it"), "{err}");

        let mut cfg = jdtls();
        configure_jdtls(&mut cfg, Path::new("/p"), Path::new("/data"), &[], None, None, JDTLS_MIN_JAVA, &[], None);
        assert!(cfg.launch_error.unwrap().contains("no JDK was found"));

        // An explicit JAVA_HOME is the user's call.
        let mut cfg = jdtls();
        cfg.env.insert("JAVA_HOME".into(), "/custom".into());
        configure_jdtls(&mut cfg, Path::new("/p"), Path::new("/data"), &old, None, None, JDTLS_MIN_JAVA, &[], None);
        assert_eq!((cfg.env["JAVA_HOME"].as_str(), cfg.launch_error), ("/custom", None));

        let mixed = [old[0].clone(), Jdk { major: 21, home: PathBuf::from("/jdk21") }];
        assert_eq!(jdtls_runtime(&mixed, 21).unwrap().major, 21);

        // A jdtls whose bundles need 25 doesn't start on 21, and says what it needs.
        let mut cfg = jdtls();
        configure_jdtls(&mut cfg, Path::new("/p"), Path::new("/data"), &mixed, None, None, 25, &[], None);
        let err = cfg.launch_error.unwrap();
        assert!(err.contains("JDK 25 or newer") && err.contains("found JDK 17, 21"), "{err}");
        assert!(err.contains("Download JDK 25"), "offers the download: {err}");
    }

    #[test]
    fn issue_49_jdtls_needs_25_with_8_17_21_installed() {
        let jdtls = || -> LanguageServerConfig { toml::from_str("name = \"jdtls\"\ncommand = \"jdtls\"").unwrap() };
        let installed = [
            Jdk { major: 21, home: PathBuf::from("/jdk21") },
            Jdk { major: 17, home: PathBuf::from("/jdk17") },
            Jdk { major: 8, home: PathBuf::from("/jdk8") },
        ];
        let mut cfg = jdtls();
        configure_jdtls(&mut cfg, Path::new("/p"), Path::new("/data"), &installed, None, None, 25, &[], None);
        let err = cfg.launch_error.unwrap();
        assert!(err.starts_with("jdtls needs JDK 25 or newer to run (found JDK 8, 17, 21)"), "{err}");
        assert!(err.contains("Download JDK 25"), "{err}");

        // Once a JDK 25 has been downloaded, Auto runs jdtls on it.
        let downloaded =
            [installed.as_slice(), &[Jdk { major: 25, home: PathBuf::from("/tools/jdks/temurin-25") }]].concat();
        let mut cfg = jdtls();
        configure_jdtls(&mut cfg, Path::new("/p"), Path::new("/data"), &downloaded, None, None, 25, &[], None);
        assert_eq!(cfg.launch_error, None);
        assert_eq!(cfg.env["JAVA_HOME"], Path::new("/tools/jdks/temurin-25").to_string_lossy());
    }

    #[test]
    fn missing_jdk_for_the_project_release() {
        let jdks = [Jdk { major: 17, home: PathBuf::from("/jdk17") }, Jdk { major: 8, home: PathBuf::from("/jdk8") }];
        assert_eq!(missing_jdk_message(&jdks, Some(17)), None);
        assert_eq!(missing_jdk_message(&jdks, Some(11)), None);
        assert_eq!(missing_jdk_message(&jdks, None), None);
        let msg = missing_jdk_message(&jdks, Some(21)).unwrap();
        assert!(msg.contains("needs JDK 21 or newer (found JDK 8, 17)") && msg.contains("Download JDK 21"), "{msg}");
        assert!(missing_jdk_message(&[], Some(8)).unwrap().contains("no JDK was found"));
    }

    #[test]
    fn downloaded_jdks_are_found() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("jdks/temurin-25.0.1");
        std::fs::create_dir_all(home.join("bin")).unwrap();
        std::fs::write(home.join("release"), "JAVA_VERSION=\"25.0.1\"\n").unwrap();
        std::fs::write(home.join("bin").join(crate::exe("java")), "").unwrap();
        // macOS bundles: <dir>/Contents/Home
        let bundle = tmp.path().join("jdks/temurin-21.0.5/Contents/Home");
        std::fs::create_dir_all(bundle.join("bin")).unwrap();
        std::fs::write(bundle.join("release"), "JAVA_VERSION=\"21.0.5\"\n").unwrap();
        std::fs::write(bundle.join("bin").join(crate::exe("java")), "").unwrap();
        add_jdk_root(&tmp.path().join("jdks"));
        let found = rescan_jdks();
        let home = dunce::canonicalize(&home).unwrap();
        let bundle = dunce::canonicalize(&bundle).unwrap();
        assert!(found.iter().any(|j| j.home == home && j.major == 25), "{found:?}");
        assert!(found.iter().any(|j| j.home == bundle && j.major == 21), "{found:?}");
        assert!(is_downloaded(&home) && !is_downloaded(Path::new("/elsewhere")));
    }

    #[test]
    fn jdtls_runs_on_the_chosen_server_jdk() {
        let jdtls = || -> LanguageServerConfig { toml::from_str("name = \"jdtls\"\ncommand = \"jdtls\"").unwrap() };
        let jdk = |major: u32, home: &str| Jdk { major, home: PathBuf::from(home) };
        let installed = [jdk(25, "/jdk25"), jdk(21, "/jdk21"), jdk(17, "/jdk17")];
        let project = jdk(17, "/jdk17");
        let run = |server: Option<&Jdk>, min_java: u32| {
            let mut cfg = jdtls();
            configure_jdtls(
                &mut cfg,
                Path::new("/p"),
                Path::new("/data"),
                &installed,
                Some(&project),
                server,
                min_java,
                &[],
                None,
            );
            cfg
        };

        // Project on JDK 17, server on the chosen 21: each keeps its own JDK.
        let cfg = run(Some(&jdk(21, "/jdk21")), JDTLS_MIN_JAVA);
        assert_eq!((cfg.env["JAVA_HOME"].as_str(), cfg.launch_error), ("/jdk21", None));
        let opts = serde_json::to_value(cfg.initialization_options.unwrap()).unwrap();
        let rt = &opts["settings"]["java"]["configuration"]["runtimes"];
        assert_eq!(rt[0], json!({ "name": "JavaSE-17", "path": "/jdk17", "default": true }), "still compiles on 17");

        // Not set: the first installed JDK new enough, as before.
        assert_eq!(run(None, JDTLS_MIN_JAVA).env["JAVA_HOME"], "/jdk25");

        // A chosen JDK outside the scanned locations.
        let own = jdk(25, "/opt/own-jdk");
        let cfg = run(Some(&own), 25);
        assert_eq!(cfg.env["JAVA_HOME"], "/opt/own-jdk");

        // Too old for this jdtls: the user's choice is not overridden, it is explained.
        let cfg = run(Some(&jdk(21, "/jdk21")), 25);
        assert!(!cfg.env.contains_key("JAVA_HOME"));
        let err = cfg.launch_error.unwrap();
        assert!(err.contains("/jdk21") && err.contains("JDK 25 or newer"), "{err}");
        assert!(err.contains(SERVER_JDK_SETTING), "both messages point at the same setting: {err}");
    }

    #[test]
    fn bundle_manifests_give_the_java_jdtls_needs() {
        let ee = |m: &str| manifest_min_java(m);
        assert_eq!(ee("Bundle-RequiredExecutionEnvironment: JavaSE-25\n"), Some(25));
        assert_eq!(ee("Bundle-RequiredExecutionEnvironment: JavaSE-17, JavaSE-1.8\n"), Some(8));
        // The capability wins, also when folded over continuation lines.
        let folded = "Require-Capability: osgi.service;filter:=\"(x=1)\",osgi.ee;filter:=\"(&(osgi.ee=Ja\r\n \
                      vaSE)(version=21))\"\r\nBundle-RequiredExecutionEnvironment: JavaSE-17\r\n";
        assert_eq!(ee(folded), Some(21));
        assert_eq!(ee("Bundle-Name: x\n"), None);

        let home = tempfile::tempdir().unwrap();
        let plugins = home.path().join("plugins");
        std::fs::create_dir(&plugins).unwrap();
        let jar = |name: &str, manifest: &str| {
            let mut zip = zip::ZipWriter::new(std::fs::File::create(plugins.join(name)).unwrap());
            let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
            zip.start_file("META-INF/MANIFEST.MF", opts).unwrap();
            std::io::Write::write_all(&mut zip, manifest.as_bytes()).unwrap();
            zip.finish().unwrap();
        };
        jar(
            "org.eclipse.jdt.ls.core_1.63.0.jar",
            "Require-Capability: osgi.ee;filter:=\"(&(osgi.ee=JavaSE)(version=21))\"\n",
        );
        jar("org.eclipse.core.filesystem_1.12.0.jar", "Bundle-RequiredExecutionEnvironment: JavaSE-25\n");
        jar("plain.jar", "Manifest-Version: 1.0\n");
        std::fs::write(plugins.join("notes.txt"), "not a jar").unwrap();
        assert_eq!(bundles_min_java(home.path()), Some(25));
        assert_eq!(bundles_min_java(&home.path().join("missing")), None);
    }

    #[test]
    fn picks_the_jdk_matching_the_project() {
        let jdks = [
            Jdk { major: 25, home: PathBuf::from("/jdk25") },
            Jdk { major: 21, home: PathBuf::from("/jdk21") },
            Jdk { major: 17, home: PathBuf::from("/jdk17") },
        ];
        assert_eq!(pick_jdk(&jdks, Some(21)).unwrap().major, 21);
        assert_eq!(pick_jdk(&jdks, Some(19)).unwrap().major, 21, "oldest newer one");
        assert_eq!(pick_jdk(&jdks, Some(26)).unwrap().major, 25, "newest as last resort");
        assert_eq!(pick_jdk(&jdks, None).unwrap().major, 25);
        assert!(pick_jdk(&[], Some(21)).is_none());
        assert_eq!(java_executable(Path::new("/jdk21")), Path::new("/jdk21/bin").join(crate::exe("java")));
    }

    #[test]
    fn project_java_versions() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        assert_eq!(project_java_version(dir), None);
        std::fs::write(dir.join("pom.xml"), "<properties>\n<java.version>21</java.version>\n</properties>").unwrap();
        assert_eq!(project_java_version(dir), Some(21));
        std::fs::write(dir.join("pom.xml"), "<maven.compiler.source>1.8</maven.compiler.source>").unwrap();
        assert_eq!(project_java_version(dir), Some(8));
        std::fs::remove_file(dir.join("pom.xml")).unwrap();
        std::fs::write(
            dir.join("build.gradle.kts"),
            "java {\n  toolchain {\n    languageVersion = JavaLanguageVersion.of(17)\n  }\n}",
        )
        .unwrap();
        assert_eq!(project_java_version(dir), Some(17));
        std::fs::write(dir.join("build.gradle.kts"), "java { sourceCompatibility = JavaVersion.VERSION_11 }").unwrap();
        assert_eq!(project_java_version(dir), Some(11));
        std::fs::write(dir.join("build.gradle.kts"), "sourceCompatibility = '1.8'").unwrap();
        assert_eq!(project_java_version(dir), Some(8));
    }
}
