//! Lombok for jdtls: ECJ only generates Lombok members when the language
//! server's JVM runs `-javaagent:lombok.jar`, so a project using Lombok gets the
//! newest jar available, managed (installed by the IDE) or in the Maven / Gradle caches.

use crate::home_dir;
use std::path::{Path, PathBuf};

/// Oldest Lombok whose ECJ handlers work in current jdtls builds (Eclipse 2024-06 support);
/// older ones throw `NoSuchMethodError` and drop every annotation of the compilation unit.
pub const LOMBOK_MIN: [u32; 3] = [1, 18, 34];

/// What a jdtls instance gets for Lombok.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LombokAgent {
    /// The project doesn't use Lombok.
    Unused,
    /// The project uses Lombok but no jar was found.
    Missing,
    Found {
        jar: PathBuf,
        /// `None` for the managed jar (the latest release when installed).
        version: Option<String>,
    },
}

impl LombokAgent {
    pub fn jar(&self) -> Option<&Path> {
        match self {
            Self::Found { jar, .. } => Some(jar),
            _ => None,
        }
    }

    /// Too old for current jdtls.
    pub fn outdated(&self) -> bool {
        matches!(self, Self::Found { version: Some(v), .. } if parse_version(v).is_some_and(|v| v < LOMBOK_MIN))
    }

    /// Why Lombok-generated members may be missing, if they may be.
    pub fn problem(&self) -> Option<String> {
        const INSTALL: &str =
            "Install Lombok in Settings › Languages & Frameworks › Language Servers (jdtls restarts with it)";
        match self {
            Self::Missing => Some(format!(
                "The project uses Lombok, but no lombok.jar was found for the Java language server, so Lombok-generated \
                 members are missing. {INSTALL}."
            )),
            Self::Found { version: Some(v), .. } if self.outdated() => Some(format!(
                "Lombok {v} is too old for the Java language server (needs {}.{}.{} or newer): classes using it may \
                 miss generated members. {INSTALL}.",
                LOMBOK_MIN[0], LOMBOK_MIN[1], LOMBOK_MIN[2]
            )),
            _ => None,
        }
    }
}

/// The Lombok jar of a `-javaagent:` among JVM arguments (bare or as `--jvm-arg=`).
pub fn agent_in_args<'a>(args: impl IntoIterator<Item = &'a str>) -> Option<PathBuf> {
    args.into_iter().find_map(|a| {
        let jar = a.split_once("-javaagent:")?.1;
        jar.to_ascii_lowercase().contains("lombok").then(|| PathBuf::from(jar))
    })
}

/// The Lombok agent for the project at `root`: the user's own (`own`, from the JVM
/// options) wins, then `managed` (the IDE-installed jar), then the build caches.
pub fn lombok_agent(root: &Path, own: Option<PathBuf>, managed: Option<PathBuf>) -> LombokAgent {
    if let Some(jar) = own {
        let version = jar
            .file_stem()
            .and_then(|s| s.to_str()?.strip_prefix("lombok-"))
            .filter(|v| parse_version(v).is_some())
            .map(str::to_owned);
        return LombokAgent::Found { jar, version };
    }
    if !uses_lombok(root) {
        return LombokAgent::Unused;
    }
    if let Some(jar) = managed {
        return LombokAgent::Found { jar, version: None };
    }
    let home = home_dir();
    let mut dirs = Vec::new();
    if let Some(repo) = maven_repository(home.as_deref()) {
        dirs.push(repo.join("org").join("projectlombok").join("lombok"));
    }
    if let Some(gradle) =
        std::env::var_os("GRADLE_USER_HOME").map(PathBuf::from).or_else(|| home.map(|h| h.join(".gradle")))
    {
        dirs.push(gradle.join("caches").join("modules-2").join("files-2.1").join("org.projectlombok").join("lombok"));
    }
    match newest_cached(&dirs) {
        Some((version, jar)) => LombokAgent::Found { jar, version: Some(version) },
        None => LombokAgent::Missing,
    }
}

/// Build files under `root` (a few levels, for multi-module builds) mentioning Lombok.
pub fn uses_lombok(root: &Path) -> bool {
    const FILES: [&str; 4] = ["pom.xml", "build.gradle", "build.gradle.kts", "libs.versions.toml"];
    const SKIP: [&str; 7] = ["target", "build", "node_modules", "out", "bin", "src", ".gradle"];
    fn walk(dir: &Path, depth: usize) -> bool {
        if dir.join("lombok.config").is_file() {
            return true;
        }
        let Ok(entries) = std::fs::read_dir(dir) else { return false };
        let mut subdirs = Vec::new();
        for e in entries.flatten() {
            let name = e.file_name();
            let name = name.to_string_lossy();
            let Ok(ty) = e.file_type() else { continue };
            if ty.is_dir() {
                if depth > 0 && !name.starts_with('.') && !SKIP.contains(&name.as_ref()) {
                    subdirs.push(e.path());
                }
            } else if FILES.contains(&name.as_ref())
                && std::fs::read_to_string(e.path()).is_ok_and(|t| t.contains("lombok"))
            {
                return true;
            }
        }
        subdirs.iter().any(|d| walk(d, depth - 1))
    }
    // `gradle/libs.versions.toml` sits one level down, modules usually no deeper than three.
    walk(root, 3)
}

/// `<localRepository>` of `~/.m2/settings.xml`, else `~/.m2/repository`.
fn maven_repository(home: Option<&Path>) -> Option<PathBuf> {
    let m2 = home?.join(".m2");
    let custom = std::fs::read_to_string(m2.join("settings.xml"))
        .ok()
        .and_then(|s| crate::java::xml_value(&strip_xml_comments(&s), "localRepository"))
        .filter(|v| !v.is_empty() && !v.contains("${"))
        .map(PathBuf::from);
    Some(custom.unwrap_or_else(|| m2.join("repository")))
}

fn strip_xml_comments(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(i) = rest.find("<!--") {
        out.push_str(&rest[..i]);
        rest = rest[i..].find("-->").map_or("", |j| &rest[i + j + 3..]);
    }
    out.push_str(rest);
    out
}

/// Highest release `<dir>/<version>/…/lombok-<version>.jar` (Maven: directly in
/// the version directory; Gradle: one hash directory below it).
fn newest_cached(dirs: &[PathBuf]) -> Option<(String, PathBuf)> {
    let mut best: Option<([u32; 3], String, PathBuf)> = None;
    for dir in dirs {
        let Ok(entries) = std::fs::read_dir(dir) else { continue };
        for e in entries.flatten() {
            let version = e.file_name().to_string_lossy().into_owned();
            let Some(parsed) = parse_version(&version) else { continue };
            if best.as_ref().is_some_and(|(b, ..)| *b >= parsed) {
                continue;
            }
            let name = format!("lombok-{version}.jar");
            let direct = e.path().join(&name);
            let jar = if direct.is_file() {
                Some(direct)
            } else {
                std::fs::read_dir(e.path())
                    .into_iter()
                    .flatten()
                    .flatten()
                    .map(|h| h.path().join(&name))
                    .find(|p| p.is_file())
            };
            if let Some(jar) = jar {
                best = Some((parsed, version, jar));
            }
        }
    }
    best.map(|(_, v, jar)| (v, jar))
}

/// `1.18.34` → `[1, 18, 34]`; snapshots and other qualifiers don't count as releases.
fn parse_version(v: &str) -> Option<[u32; 3]> {
    let mut parts = v.split('.').map(|p| p.parse::<u32>().ok());
    let out = [parts.next()??, parts.next()??, parts.next().unwrap_or(Some(0))?];
    parts.next().is_none().then_some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn detects_lombok_in_build_files() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        fs::write(root.join("pom.xml"), "<project><modules><module>api</module></modules></project>").unwrap();
        assert!(!uses_lombok(root));
        fs::create_dir_all(root.join("api/src/main")).unwrap();
        fs::write(root.join("api/src/main/pom.xml"), "<artifactId>lombok</artifactId>").unwrap();
        assert!(!uses_lombok(root), "sources are not scanned");
        fs::write(root.join("api/pom.xml"), "<artifactId>lombok</artifactId>").unwrap();
        assert!(uses_lombok(root));

        let gradle = tempfile::tempdir().unwrap();
        fs::create_dir_all(gradle.path().join("gradle")).unwrap();
        fs::write(gradle.path().join("gradle/libs.versions.toml"), "lombok = \"org.projectlombok:lombok:1.18.30\"")
            .unwrap();
        assert!(uses_lombok(gradle.path()));
    }

    #[test]
    fn picks_the_newest_cached_release() {
        let tmp = tempfile::tempdir().unwrap();
        let m2 = tmp.path().join("m2");
        let gradle = tmp.path().join("gradle");
        for v in ["1.18.26", "1.18.36", "1.18.99-SNAPSHOT"] {
            fs::create_dir_all(m2.join(v)).unwrap();
            fs::write(m2.join(v).join(format!("lombok-{v}.jar")), b"PK").unwrap();
        }
        fs::create_dir_all(m2.join("1.18.40")).unwrap(); // only a .pom: not usable
        fs::create_dir_all(gradle.join("1.18.38/abc123")).unwrap();
        fs::write(gradle.join("1.18.38/abc123/lombok-1.18.38.jar"), b"PK").unwrap();
        let (v, jar) = newest_cached(&[m2.clone(), gradle.clone()]).unwrap();
        assert_eq!(v, "1.18.38");
        assert_eq!(jar, gradle.join("1.18.38/abc123/lombok-1.18.38.jar"));
        assert_eq!(newest_cached(std::slice::from_ref(&m2)).unwrap().0, "1.18.36");
        assert_eq!(newest_cached(&[tmp.path().join("none")]), None);
    }

    #[test]
    fn old_versions_are_reported() {
        let found = |v: Option<&str>| LombokAgent::Found { jar: "/l.jar".into(), version: v.map(Into::into) };
        assert!(found(Some("1.18.26")).outdated());
        assert!(found(Some("1.18.26")).problem().unwrap().contains("1.18.26 is too old"));
        assert!(!found(Some("1.18.34")).outdated());
        assert_eq!(found(None).problem(), None);
        assert!(LombokAgent::Missing.problem().is_some());
        assert_eq!(LombokAgent::Unused.problem(), None);
        assert_eq!(parse_version("1.18"), Some([1, 18, 0]));
        assert_eq!(parse_version("edge-SNAPSHOT"), None);
    }

    #[test]
    fn the_users_agent_wins() {
        let tmp = tempfile::tempdir().unwrap();
        let own = agent_in_args(["--jvm-arg=-Xmx2g", "--jvm-arg=-javaagent:/opt/lombok-1.18.26.jar"]);
        assert_eq!(own.as_deref(), Some(Path::new("/opt/lombok-1.18.26.jar")));
        assert_eq!(agent_in_args(["-javaagent:/opt/other.jar"]), None);
        let agent = lombok_agent(tmp.path(), own, Some("/managed/lombok.jar".into()));
        assert_eq!(agent.jar(), Some(Path::new("/opt/lombok-1.18.26.jar")));
        assert!(agent.outdated(), "its version is read from the file name");
        let plain = lombok_agent(tmp.path(), agent_in_args(["-javaagent:/opt/lombok.jar"]), None);
        assert_eq!(plain.problem(), None, "a user agent is never reported missing");
    }

    #[test]
    fn maven_settings_local_repository() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();
        assert_eq!(maven_repository(Some(home)), Some(home.join(".m2/repository")));
        fs::create_dir_all(home.join(".m2")).unwrap();
        fs::write(
            home.join(".m2/settings.xml"),
            "<settings><!-- <localRepository>/old</localRepository> --><localRepository>/repo</localRepository></settings>",
        )
        .unwrap();
        assert_eq!(maven_repository(Some(home)), Some(PathBuf::from("/repo")));
    }
}
