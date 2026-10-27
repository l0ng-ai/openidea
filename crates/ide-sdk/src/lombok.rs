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
/// options) wins, then `managed` (the IDE-installed jar, always attached: it is inert
/// without Lombok on the classpath), then, for a project using Lombok, the build caches
/// (`maven_repo`, the configured Maven local repository, else the default one).
pub fn lombok_agent(
    root: &Path,
    own: Option<PathBuf>,
    managed: Option<PathBuf>,
    maven_repo: Option<PathBuf>,
) -> LombokAgent {
    if let Some(jar) = own {
        let version = jar
            .file_stem()
            .and_then(|s| s.to_str()?.strip_prefix("lombok-"))
            .filter(|v| parse_version(v).is_some())
            .map(str::to_owned);
        return LombokAgent::Found { jar, version };
    }
    if let Some(jar) = managed {
        return LombokAgent::Found { jar, version: None };
    }
    let home = home_dir();
    let maven_repo = maven_repo.or_else(|| maven_repository(home.as_deref()));
    if !uses_lombok(root, maven_repo.as_deref()) {
        return LombokAgent::Unused;
    }
    let mut dirs = Vec::new();
    if let Some(repo) = maven_repo {
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

/// Whether the project at `root` uses Lombok. It often arrives through inheritance the
/// project's own build files don't show (a parent POM up the tree or only in the local
/// repository `maven_repo`, an enclosing Gradle build, a convention plugin), so besides
/// those this follows Maven `<parent>` chains, checks an enclosing Gradle build and, last,
/// looks for Java sources importing Lombok, a signal independent of the build.
pub fn uses_lombok(root: &Path, maven_repo: Option<&Path>) -> bool {
    let mut poms = Vec::new();
    build_files_mention_lombok(root, &mut poms)
        || root.ancestors().skip(1).any(|d| d.join("lombok.config").is_file())
        || parents_mention_lombok(&poms, maven_repo)
        || enclosing_gradle_build_mentions_lombok(root)
        || sources_import_lombok(root)
}

const BUILD_FILES: [&str; 4] = ["pom.xml", "build.gradle", "build.gradle.kts", "libs.versions.toml"];
const OUTPUT_DIRS: [&str; 6] = ["target", "build", "node_modules", "out", "bin", ".gradle"];

fn mentions_lombok(file: &Path) -> bool {
    std::fs::read_to_string(file).is_ok_and(|t| t.contains("lombok"))
}

/// Build files under `root` (a few levels, for multi-module builds) mentioning Lombok;
/// the POMs seen go to `poms`.
fn build_files_mention_lombok(root: &Path, poms: &mut Vec<PathBuf>) -> bool {
    fn walk(dir: &Path, depth: usize, poms: &mut Vec<PathBuf>) -> bool {
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
                if depth > 0 && !name.starts_with('.') && name != "src" && !OUTPUT_DIRS.contains(&name.as_ref()) {
                    subdirs.push(e.path());
                }
            } else if BUILD_FILES.contains(&name.as_ref()) {
                if mentions_lombok(&e.path()) {
                    return true;
                }
                if name == "pom.xml" {
                    poms.push(e.path());
                }
            }
        }
        subdirs.iter().any(|d| walk(d, depth - 1, poms))
    }
    // `gradle/libs.versions.toml` sits one level down, modules usually no deeper than three.
    walk(root, 3, poms)
}

/// Maven inherits dependencies along `<parent>`: whether an ancestor POM of `poms`
/// mentions Lombok.
fn parents_mention_lombok(poms: &[PathBuf], maven_repo: Option<&Path>) -> bool {
    const MAX_HOPS: usize = 8;
    let mut seen = std::collections::HashSet::new();
    for pom in poms {
        let Ok(mut text) = std::fs::read_to_string(pom) else { continue };
        let mut current = pom.clone();
        for _ in 0..MAX_HOPS {
            let Some(parent) = parent_pom(&current, &text, maven_repo) else { break };
            if !seen.insert(parent.clone()) {
                break;
            }
            let Ok(parent_text) = std::fs::read_to_string(&parent) else { break };
            if parent_text.contains("lombok") {
                return true;
            }
            (current, text) = (parent, parent_text);
        }
    }
    false
}

/// The parent of `pom` (content `text`) as Maven resolves it: the POM at `<relativePath>`
/// (default `../pom.xml`, none when empty) if it is that parent, else
/// `<groupId>/<artifactId>/<version>/<artifactId>-<version>.pom` in the local repository.
fn parent_pom(pom: &Path, text: &str, maven_repo: Option<&Path>) -> Option<PathBuf> {
    let text = strip_xml_comments(text);
    let (block, _) = split_parent(&text)?;
    let coord = |tag| crate::java::xml_value(block, tag).filter(|v| !v.is_empty());
    let (group, artifact) = (coord("groupId")?, coord("artifactId")?);
    let relative = if block.contains("<relativePath/>") || block.contains("<relativePath />") {
        String::new()
    } else {
        crate::java::xml_value(block, "relativePath").unwrap_or_else(|| "../pom.xml".to_owned())
    };
    if !relative.is_empty() {
        let mut local = pom.parent()?.join(relative.replace('\\', "/"));
        if local.is_dir() {
            local = local.join("pom.xml");
        }
        let is_parent = std::fs::read_to_string(&local)
            .is_ok_and(|t| own_artifact_id(&strip_xml_comments(&t)).as_deref() == Some(artifact.as_str()));
        if is_parent {
            return Some(dunce::canonicalize(&local).unwrap_or(local));
        }
    }
    let version = coord("version").filter(|v| !v.contains("${"))?;
    let dir = group.split('.').fold(maven_repo?.to_path_buf(), |d, part| d.join(part));
    let file = dir.join(&artifact).join(&version).join(format!("{artifact}-{version}.pom"));
    file.is_file().then_some(file)
}

/// A POM's `<parent>…</parent>` element and the text without it.
fn split_parent(text: &str) -> Option<(&str, String)> {
    let start = text.find("<parent>")?;
    let end = start + text[start..].find("</parent>")? + "</parent>".len();
    Some((&text[start..end], format!("{}{}", &text[..start], &text[end..])))
}

/// A POM's own `<artifactId>`, not its parent's.
fn own_artifact_id(text: &str) -> Option<String> {
    match split_parent(text) {
        Some((_, rest)) => crate::java::xml_value(&rest, "artifactId"),
        None => crate::java::xml_value(text, "artifactId"),
    }
}

/// A Gradle subproject opened on its own: the enclosing build (the nearest ancestor with
/// `settings.gradle[.kts]`) may apply Lombok from its root build file or version catalog.
fn enclosing_gradle_build_mentions_lombok(root: &Path) -> bool {
    const MAX_LEVELS: usize = 4;
    let settings = |d: &Path| d.join("settings.gradle").is_file() || d.join("settings.gradle.kts").is_file();
    root.ancestors().skip(1).take(MAX_LEVELS).find(|d| settings(d)).is_some_and(|build| {
        ["build.gradle", "build.gradle.kts", "gradle/libs.versions.toml"]
            .iter()
            .any(|f| mentions_lombok(&build.join(f)))
    })
}

/// Java sources under `root` importing Lombok. Bounded (the heads of the first files),
/// honouring ignore files and skipping build output.
fn sources_import_lombok(root: &Path) -> bool {
    use std::io::Read;
    const MAX_ENTRIES: usize = 50_000;
    const MAX_FILES: usize = 2000;
    // Imports precede the first type, after at most a license header.
    const HEAD: u64 = 8 * 1024;
    let mut walker = ignore::WalkBuilder::new(root);
    walker.require_git(false).follow_links(false).filter_entry(|e| {
        e.depth() == 0
            || !e.file_type().is_some_and(|t| t.is_dir())
            || !OUTPUT_DIRS.contains(&e.file_name().to_string_lossy().as_ref())
    });
    let imports_lombok = |path: &Path| {
        let mut head = Vec::new();
        let read = std::fs::File::open(path).and_then(|f| f.take(HEAD).read_to_end(&mut head));
        let head = String::from_utf8_lossy(&head);
        read.is_ok()
            && (head.contains("@lombok.")
                || head.lines().any(|l| l.trim_start().starts_with("import ") && l.contains(" lombok.")))
    };
    walker
        .build()
        .take(MAX_ENTRIES)
        .flatten()
        .filter(|e| e.file_type().is_some_and(|t| t.is_file()) && e.path().extension().is_some_and(|x| x == "java"))
        .take(MAX_FILES)
        .any(|e| imports_lombok(e.path()))
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

pub(crate) fn strip_xml_comments(text: &str) -> String {
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
        assert!(!uses_lombok(root, None));
        fs::create_dir_all(root.join("api/src/main")).unwrap();
        fs::write(root.join("api/src/main/pom.xml"), "<artifactId>lombok</artifactId>").unwrap();
        assert!(!uses_lombok(root, None), "build files under src are not scanned");
        fs::write(root.join("api/pom.xml"), "<artifactId>lombok</artifactId>").unwrap();
        assert!(uses_lombok(root, None));

        let gradle = tempfile::tempdir().unwrap();
        fs::create_dir_all(gradle.path().join("gradle")).unwrap();
        fs::write(gradle.path().join("gradle/libs.versions.toml"), "lombok = \"org.projectlombok:lombok:1.18.30\"")
            .unwrap();
        assert!(uses_lombok(gradle.path(), None));
    }

    const LOMBOK_DEP: &str = "<dependencies><dependency><groupId>org.projectlombok</groupId><artifactId>lombok</artifactId></dependency></dependencies>";

    fn pom(own: &str, parent: &str) -> String {
        format!("<project><modelVersion>4.0.0</modelVersion>{parent}<artifactId>{own}</artifactId></project>")
    }

    fn parent(artifact: &str, extra: &str) -> String {
        format!(
            "<parent><groupId>com.acme</groupId><artifactId>{artifact}</artifactId><version>1.0</version>{extra}</parent>"
        )
    }

    #[test]
    fn parent_pom_only_in_the_local_repository() {
        // #33: the module's parent was `mvn install`ed, its directory isn't on disk.
        let tmp = tempfile::tempdir().unwrap();
        let (module, repo) = (tmp.path().join("module-a"), tmp.path().join("m2"));
        fs::create_dir_all(&module).unwrap();
        fs::write(module.join("pom.xml"), pom("module-a", &parent("acme-parent", ""))).unwrap();
        assert!(!uses_lombok(&module, Some(&repo)));
        let dir = repo.join("com/acme/acme-parent/1.0");
        fs::create_dir_all(&dir).unwrap();
        // The dependency comes from the grandparent.
        fs::write(dir.join("acme-parent-1.0.pom"), pom("acme-parent", &parent("acme-root", ""))).unwrap();
        assert!(!uses_lombok(&module, Some(&repo)));
        let root = repo.join("com/acme/acme-root/1.0");
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join("acme-root-1.0.pom"),
            format!("<project><artifactId>acme-root</artifactId>{LOMBOK_DEP}</project>"),
        )
        .unwrap();
        assert!(uses_lombok(&module, Some(&repo)));
        assert!(!uses_lombok(&module, None), "no repository, no parent");
        let agent = lombok_agent(&module, None, None, Some(repo.clone()));
        assert_ne!(agent, LombokAgent::Unused, "missing, or a jar from the Gradle cache");
    }

    #[test]
    fn parent_pom_via_relative_path_outside_the_root() {
        let tmp = tempfile::tempdir().unwrap();
        let project = tmp.path().join("project");
        let module = project.join("modules/api");
        fs::create_dir_all(&module).unwrap();
        fs::create_dir_all(tmp.path().join("platform")).unwrap();
        fs::write(
            module.join("pom.xml"),
            pom("api", &parent("platform", "<relativePath>../../../platform</relativePath>")),
        )
        .unwrap();
        fs::write(
            tmp.path().join("platform/pom.xml"),
            format!("<project><artifactId>platform</artifactId>{LOMBOK_DEP}</project>"),
        )
        .unwrap();
        assert!(uses_lombok(&module, None));
        assert!(uses_lombok(&project, None), "modules' parents are followed too");

        // The default `../pom.xml`, but it is another project's POM: not the parent.
        let other = tempfile::tempdir().unwrap();
        let child = other.path().join("child");
        fs::create_dir_all(&child).unwrap();
        fs::write(child.join("pom.xml"), pom("child", &parent("acme-parent", ""))).unwrap();
        fs::write(
            other.path().join("pom.xml"),
            format!("<project><artifactId>unrelated</artifactId>{LOMBOK_DEP}</project>"),
        )
        .unwrap();
        assert!(!uses_lombok(&child, None));
        fs::write(
            other.path().join("pom.xml"),
            format!("<project><artifactId>acme-parent</artifactId>{LOMBOK_DEP}</project>"),
        )
        .unwrap();
        assert!(uses_lombok(&child, None));
        // An empty relativePath means: from the repository only.
        fs::write(child.join("pom.xml"), pom("child", &parent("acme-parent", "<relativePath/>"))).unwrap();
        assert!(!uses_lombok(&child, None));
    }

    #[test]
    fn parent_cycles_terminate() {
        let tmp = tempfile::tempdir().unwrap();
        let a = tmp.path().join("a");
        fs::create_dir_all(&a).unwrap();
        fs::write(a.join("pom.xml"), pom("a", &parent("root", ""))).unwrap();
        fs::write(tmp.path().join("pom.xml"), pom("root", &parent("root", "<relativePath>pom.xml</relativePath>")))
            .unwrap();
        assert!(!uses_lombok(&a, None));
    }

    #[test]
    fn enclosing_gradle_build() {
        let tmp = tempfile::tempdir().unwrap();
        let sub = tmp.path().join("services/billing");
        fs::create_dir_all(&sub).unwrap();
        fs::write(sub.join("build.gradle.kts"), "plugins { java }").unwrap();
        fs::write(tmp.path().join("settings.gradle.kts"), "include(\"services:billing\")").unwrap();
        assert!(!uses_lombok(&sub, None));
        fs::write(
            tmp.path().join("build.gradle.kts"),
            "subprojects { dependencies { \"compileOnly\"(\"org.projectlombok:lombok:1.18.36\") } }",
        )
        .unwrap();
        assert!(uses_lombok(&sub, None));
    }

    #[test]
    fn sources_importing_lombok() {
        // E.g. a Gradle convention plugin in buildSrc/src or an included build adds it.
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let pkg = root.join("app/src/main/java/com/acme");
        fs::create_dir_all(&pkg).unwrap();
        fs::write(root.join("build.gradle"), "plugins { id 'acme.java-conventions' }").unwrap();
        fs::write(pkg.join("Plain.java"), "package com.acme;\n\nimport java.util.List;\n\nclass Plain {}\n").unwrap();
        assert!(!uses_lombok(root, None));
        // Build output and ignored files don't count.
        fs::create_dir_all(root.join("app/build/generated")).unwrap();
        fs::write(root.join("app/build/generated/G.java"), "import lombok.Data;\n").unwrap();
        fs::write(root.join(".ignore"), "vendor/\n").unwrap();
        fs::create_dir_all(root.join("vendor")).unwrap();
        fs::write(root.join("vendor/V.java"), "import lombok.Value;\n").unwrap();
        assert!(!uses_lombok(root, None));
        fs::write(
            pkg.join("User.java"),
            "/* License */\npackage com.acme;\n\nimport lombok.Data;\n\n@Data\nclass User {}\n",
        )
        .unwrap();
        assert!(uses_lombok(root, None));
        fs::write(pkg.join("User.java"), "package com.acme;\n\n@lombok.Getter\nclass User {}\n").unwrap();
        assert!(uses_lombok(root, None));
        fs::write(pkg.join("User.java"), "package com.acme;\nimport static lombok.AccessLevel.PRIVATE;\n").unwrap();
        assert!(uses_lombok(root, None));
    }

    #[test]
    fn the_installed_agent_applies_without_detection() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("m2");
        assert_eq!(lombok_agent(tmp.path(), None, None, Some(repo.clone())), LombokAgent::Unused);
        let managed = lombok_agent(tmp.path(), None, Some("/managed/lombok.jar".into()), Some(repo));
        assert_eq!(managed.jar(), Some(Path::new("/managed/lombok.jar")));
        assert_eq!(managed.problem(), None);
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
        let agent = lombok_agent(tmp.path(), own, Some("/managed/lombok.jar".into()), None);
        assert_eq!(agent.jar(), Some(Path::new("/opt/lombok-1.18.26.jar")));
        assert!(agent.outdated(), "its version is read from the file name");
        let plain = lombok_agent(tmp.path(), agent_in_args(["-javaagent:/opt/lombok.jar"]), None, None);
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
