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

fn jdk_at(home: &Path) -> Option<Jdk> {
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

/// JDK homes in the usual install locations (macOS `JavaVirtualMachines`,
/// `/usr/lib/jvm`, SDKMAN, IDEA's `~/.jdks`, Homebrew, Windows vendor
/// directories), `JAVA_HOME` first, then the `java` on `PATH`.
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

/// Installed JDKs (scanned on first use; [`jdtls_jdks`] may refresh them).
pub fn installed_jdks() -> Arc<[Jdk]> {
    let mut slot = JDKS.lock().unwrap_or_else(|e| e.into_inner());
    match &*slot {
        Some(s) => s.jdks.clone(),
        None => rescan(&mut slot),
    }
}

/// Like [`installed_jdks`], but while none can run jdtls the list is rescanned
/// (at most every [`RESCAN_AFTER`]), so a JDK installed after startup is picked
/// up when the server is restarted.
pub fn jdtls_jdks() -> Arc<[Jdk]> {
    let mut slot = JDKS.lock().unwrap_or_else(|e| e.into_inner());
    match &*slot {
        Some(s) if jdtls_runtime(&s.jdks).is_some() || s.at.elapsed() < RESCAN_AFTER => s.jdks.clone(),
        _ => rescan(&mut slot),
    }
}

/// Oldest Java version jdtls itself runs on (projects may target older ones).
pub const JDTLS_MIN_JAVA: u32 = 21;

/// The JDK to run jdtls with: the first found that is new enough (`JAVA_HOME` wins).
pub fn jdtls_runtime(jdks: &[Jdk]) -> Option<&Jdk> {
    jdks.iter().find(|j| j.major >= JDTLS_MIN_JAVA)
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
/// the project; it runs on a JDK 21+ (via `JAVA_HOME`, which its launcher
/// reads), installed JDKs are registered as runtimes and `bundles` (e.g. the
/// java-debug plugin jar) are loaded into the server.
pub fn configure_jdtls(
    cfg: &mut LanguageServerConfig,
    server_root: &Path,
    data_dir: &Path,
    jdks: &[Jdk],
    bundles: &[PathBuf],
) {
    if cfg.name != "jdtls" {
        return;
    }
    if !cfg.args.iter().any(|a| a == "-data") {
        let dir = data_dir.join("lsp").join("jdtls").join(path_key(server_root));
        cfg.args.extend(["-data".to_owned(), dir.to_string_lossy().into_owned()]);
    }
    // jdtls reads this one as a system property (its file-system bundle
    // relocates .project / .classpath / .settings into the workspace).
    if !cfg.args.iter().any(|a| a.contains(METADATA_PROPERTY)) {
        cfg.args.push(format!("--jvm-arg=-D{METADATA_PROPERTY}=false"));
    }
    if !cfg.env.contains_key("JAVA_HOME") {
        match jdtls_runtime(jdks) {
            Some(jdk) => {
                cfg.env.insert("JAVA_HOME".to_owned(), jdk.home.to_string_lossy().into_owned());
            }
            None => cfg.launch_error = Some(missing_runtime_message(jdks)),
        }
    }
    let runtimes = runtimes(jdks);
    if !runtimes.is_empty() {
        merge_init_options(cfg, json!({ "settings": { "java": { "configuration": { "runtimes": runtimes } } } }));
    }
    if !bundles.is_empty() {
        let bundles: Vec<String> = bundles.iter().map(|b| b.to_string_lossy().into_owned()).collect();
        merge_init_options(cfg, json!({ "bundles": bundles }));
    }
}

fn missing_runtime_message(jdks: &[Jdk]) -> String {
    let mut found: Vec<u32> = jdks.iter().map(|j| j.major).collect();
    found.sort_unstable();
    found.dedup();
    let found = if found.is_empty() {
        "no JDK was found".to_owned()
    } else {
        let list: Vec<String> = found.iter().map(u32::to_string).collect();
        format!("found JDK {}", list.join(", "))
    };
    format!(
        "jdtls needs JDK {JDTLS_MIN_JAVA} or newer to run ({found}). Install one (or point JAVA_HOME at it) and \
         restart the server; the project can still target an older Java version."
    )
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

fn xml_value(text: &str, tag: &str) -> Option<String> {
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
        configure_jdtls(&mut cfg, Path::new("/p/demo"), Path::new("/data"), &jdks, &bundles);
        assert_eq!(cfg.args[0], "-data");
        assert!(cfg.args[1].starts_with("/data/lsp/jdtls/"), "{}", cfg.args[1]);
        assert_eq!(cfg.args[2], "--jvm-arg=-Djava.import.generatesMetadataFilesAtProjectRoot=false");
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
        configure_jdtls(&mut cfg, Path::new("/p/demo"), Path::new("/data"), &jdks, &bundles);
        assert_eq!(cfg, before);

        let mut other: LanguageServerConfig = toml::from_str("name = \"pyright\"\ncommand = \"x\"").unwrap();
        configure_jdtls(&mut other, Path::new("/p"), Path::new("/data"), &jdks, &bundles);
        assert!(other.args.is_empty() && other.initialization_options.is_none());
    }

    #[test]
    fn jdtls_needs_a_jdk_21_to_run() {
        let jdtls = || -> LanguageServerConfig { toml::from_str("name = \"jdtls\"\ncommand = \"jdtls\"").unwrap() };
        let old = [Jdk { major: 17, home: PathBuf::from("/jdk17") }, Jdk { major: 8, home: PathBuf::from("/jdk8") }];
        let mut cfg = jdtls();
        configure_jdtls(&mut cfg, Path::new("/p"), Path::new("/data"), &old, &[]);
        assert!(!cfg.env.contains_key("JAVA_HOME"));
        let err = cfg.launch_error.unwrap();
        assert!(err.contains("JDK 21 or newer") && err.contains("found JDK 8, 17"), "{err}");

        let mut cfg = jdtls();
        configure_jdtls(&mut cfg, Path::new("/p"), Path::new("/data"), &[], &[]);
        assert!(cfg.launch_error.unwrap().contains("no JDK was found"));

        // An explicit JAVA_HOME is the user's call.
        let mut cfg = jdtls();
        cfg.env.insert("JAVA_HOME".into(), "/custom".into());
        configure_jdtls(&mut cfg, Path::new("/p"), Path::new("/data"), &old, &[]);
        assert_eq!((cfg.env["JAVA_HOME"].as_str(), cfg.launch_error), ("/custom", None));

        let mixed = [old[0].clone(), Jdk { major: 21, home: PathBuf::from("/jdk21") }];
        assert_eq!(jdtls_runtime(&mixed).unwrap().major, 21);
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
