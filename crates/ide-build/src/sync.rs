//! Reading the effective build from Maven / Gradle itself ("Reload" in the tool
//! windows): `mvn help:effective-pom dependency:tree -Dverbose` and `gradle tasks --all`,
//! run in the background with progress and cancellation. Results are cached
//! per project (`maven.json`, `gradle.json` in the cache directory) and merged
//! into the static model by [`crate::load`]; a changed build file marks them stale.

use crate::gradle::{self, GradleModel, GradleTask};
use crate::maven::{self, MavenDependency, MavenModel, MavenPlugin};
use crate::process::{self, Output};
use ide_core::{CancellationToken, IdeError, IdeResult};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use specta::Type;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncProgress {
    pub message: String,
    /// 0..1, or `None` when indeterminate.
    pub fraction: Option<f32>,
}

#[derive(Clone, Debug, Default)]
pub struct SyncOptions {
    pub maven_settings: ide_core::settings::MavenSettings,
    /// `-o` / `--offline`.
    pub offline: bool,
    /// Maven profiles (`-P`), `!id` deactivates.
    pub profiles: Vec<String>,
    /// Extra environment (`JAVA_HOME`).
    pub env: BTreeMap<String, String>,
    /// Maven launcher replacing the project's `mvnw` / `mvn` (Settings › Maven home).
    pub maven_command: Option<String>,
    /// Resolved Gradle launcher from Settings.
    pub gradle_command: Option<String>,
    /// Maven options before the goals (`-s`, `-Dmaven.repo.local=`).
    pub maven_options: Vec<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct CachedMavenProject {
    key: String,
    plugins: Vec<MavenPlugin>,
    /// Effective direct dependencies, with transitive ones when `dependency:tree` ran.
    dependencies: Vec<MavenDependency>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct MavenCache {
    hash: String,
    at_ms: f64,
    error: Option<String>,
    projects: Vec<CachedMavenProject>,
    /// The trees list omitted occurrences (`-Dverbose`); older caches are reloaded.
    #[serde(default)]
    verbose: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct GradleCache {
    hash: String,
    at_ms: f64,
    error: Option<String>,
    tasks: Vec<(String, GradleTask)>,
}

const MAVEN_CACHE: &str = "maven.json";

/// `dependency:tree` of a plugin version whose `-Dverbose` lists the occurrences Maven
/// omitted (conflicts, duplicates): verbose output was dropped in 3.0 and is back since 3.2.
/// Offline, the project's own plugin version is used instead, since this one may not be cached.
const DEPENDENCY_TREE: &str = "org.apache.maven.plugins:maven-dependency-plugin:3.8.1:tree";

/// The goals that read the effective POM into `effective` and the verbose dependency trees.
fn maven_sync_goals(effective: &Path, offline: bool) -> Vec<String> {
    vec![
        "help:effective-pom".into(),
        format!("-Doutput={}", effective.to_string_lossy()),
        if offline { "dependency:tree".into() } else { DEPENDENCY_TREE.into() },
        "-Dverbose".into(),
    ]
}
const GRADLE_CACHE: &str = "gradle.json";

fn read_cache<T: DeserializeOwned>(dir: &Path, name: &str) -> Option<T> {
    serde_json::from_slice(&std::fs::read(dir.join(name)).ok()?).ok()
}

fn write_cache<T: Serialize>(dir: &Path, name: &str, value: &T) -> IdeResult<()> {
    std::fs::create_dir_all(dir)?;
    let json = serde_json::to_vec(value).map_err(|e| IdeError::internal(e.to_string()))?;
    let tmp = dir.join(format!("{name}.tmp"));
    std::fs::write(&tmp, json)?;
    std::fs::rename(&tmp, dir.join(name))?;
    Ok(())
}

/// FNV-1a over the paths and contents of `files` (missing files count as empty).
fn hash_files(files: &[PathBuf]) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    let mut feed = |bytes: &[u8]| {
        for b in bytes {
            h ^= u64::from(*b);
            h = h.wrapping_mul(0x100000001b3);
        }
    };
    for f in files {
        feed(f.to_string_lossy().as_bytes());
        feed(&[0]);
        feed(&std::fs::read(f).unwrap_or_default());
        feed(&[0]);
    }
    format!("{h:016x}")
}

fn now_ms() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0.0, |d| d.as_millis() as f64)
}

/// Merges the cached effective build into `model`.
pub fn apply_maven_cache(root: &Path, cache_dir: &Path, model: &mut MavenModel) {
    let Some(cache) = read_cache::<MavenCache>(cache_dir, MAVEN_CACHE) else { return };
    model.synced_at = Some(cache.at_ms);
    model.sync_error = cache.error;
    let changed = cache.hash != hash_files(&maven::build_files(root, model));
    model.stale = !cache.verbose || changed;
    // A cache older than the current build files: its effective-POM plugins and
    // resolved dependencies would hide what the POMs declare now (a just added
    // dependency never appears). The static parse stays until Reload.
    if changed {
        return;
    }
    for p in &mut model.projects {
        if let Some(c) = cache.projects.iter().find(|c| c.key == p.key()) {
            if !c.plugins.is_empty() {
                p.plugins = c.plugins.clone();
            }
            p.dependencies = c.dependencies.clone();
        }
    }
}

/// Merges the cached task list into `model`.
pub fn apply_gradle_cache(root: &Path, cache_dir: &Path, model: &mut GradleModel) {
    let Some(cache) = read_cache::<GradleCache>(cache_dir, GRADLE_CACHE) else { return };
    if !cache.tasks.is_empty() {
        for p in &mut model.projects {
            let tasks: Vec<GradleTask> =
                cache.tasks.iter().filter(|(path, _)| *path == p.path).map(|(_, t)| t.clone()).collect();
            if !tasks.is_empty() {
                p.tasks = tasks;
            }
        }
    }
    model.synced_at = Some(cache.at_ms);
    model.sync_error = cache.error;
    model.stale = cache.hash != hash_files(&gradle::build_files(root, model));
}

// ---------------------------------------------------------------- processes

fn run(
    program: &str,
    args: &[String],
    cwd: &Path,
    env: &BTreeMap<String, String>,
    cancel: &CancellationToken,
    mut on_line: impl FnMut(&str),
) -> IdeResult<Output> {
    process::run(program, args, cwd, env, cancel, |_, line| on_line(line))
}

/// The first error lines of a failed build, for the tool window.
pub(crate) fn error_summary(text: &str) -> String {
    let lines: Vec<&str> = text
        .lines()
        .filter(|l| {
            l.starts_with("[ERROR]")
                || l.starts_with("FAILURE:")
                || l.starts_with("* What went wrong")
                || l.starts_with("> ")
        })
        .map(|l| l.trim_start_matches("[ERROR]").trim())
        .filter(|l| !l.is_empty() && !l.starts_with("Re-run Maven") && !l.starts_with("To see the full stack trace"))
        .take(4)
        .collect();
    if lines.is_empty() {
        text.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("the build failed").trim().to_owned()
    } else {
        lines.join("\n")
    }
}

/// `[INFO] Building core 1.0-SNAPSHOT   [2/3]` → ("core 1.0-SNAPSHOT", 2, 3).
pub(crate) fn maven_building(line: &str) -> Option<(String, u32, u32)> {
    let body = line.strip_prefix("[INFO] Building ")?;
    let open = body.rfind('[')?;
    let (n, m) = body[open + 1..].trim_end_matches(']').split_once('/')?;
    Some((body[..open].trim().to_owned(), n.trim().parse().ok()?, m.trim().parse().ok()?))
}

/// Runs Maven on every top-level project and caches effective plugins and dependency trees.
pub fn sync_maven(
    root: &Path,
    cache_dir: &Path,
    options: &SyncOptions,
    cancel: &CancellationToken,
    progress: &dyn Fn(SyncProgress),
) -> IdeResult<()> {
    let mut model = maven::load(root);
    maven::UnlinkedProjects::from_model(&model, &options.maven_settings).filter(&mut model);
    std::fs::create_dir_all(cache_dir)?;
    let mut cache =
        MavenCache { hash: hash_files(&maven::build_files(root, &model)), verbose: true, ..MavenCache::default() };
    let mut errors: Vec<String> = Vec::new();
    for (n, top) in model.projects.iter().filter(|p| !p.aggregated).enumerate() {
        let effective = cache_dir.join(format!("effective-pom-{n}.xml"));
        let _ = std::fs::remove_file(&effective);
        let mut args: Vec<String> = vec!["-B".into(), "-fae".into(), "-Dstyle.color=never".into()];
        args.extend(options.maven_options.iter().cloned());
        if options.offline {
            args.push("-o".into());
        }
        if !options.profiles.is_empty() {
            args.push(format!("-P{}", options.profiles.join(",")));
        }
        args.extend(maven_sync_goals(&effective, options.offline));
        progress(SyncProgress { message: format!("Reading {}", top.display_name), fraction: None });
        let command = options.maven_command.as_deref().unwrap_or(&top.command);
        let out = run(command, &args, &root.join(&top.dir), &options.env, cancel, |line| {
            if let Some((name, i, total)) = maven_building(line) {
                let fraction = (i.saturating_sub(1) as f32 / total.max(1) as f32).min(1.0);
                progress(SyncProgress { message: format!("Building model of {name}"), fraction: Some(fraction) });
            } else if let Some(url) =
                line.strip_prefix("Downloading from ").and_then(|l| l.split_once(": ")).map(|(_, u)| u)
            {
                progress(SyncProgress {
                    message: format!("Downloading {}", url.rsplit('/').next().unwrap_or(url)),
                    fraction: None,
                });
            }
        })?;
        let effective_projects =
            std::fs::read_to_string(&effective).map(|t| maven::parse_effective_pom(&t)).unwrap_or_default();
        let trees = maven::parse_dependency_tree(&out.text);
        for (key, plugins, deps) in effective_projects {
            let dependencies = trees.iter().find(|(k, _)| *k == key).map(|(_, t)| t.clone()).unwrap_or(deps);
            cache.projects.push(CachedMavenProject { key, plugins, dependencies });
        }
        // Modules whose effective POM could not be written still get their tree.
        for (key, tree) in trees {
            if !cache.projects.iter().any(|c| c.key == key) {
                cache.projects.push(CachedMavenProject { key, plugins: Vec::new(), dependencies: tree });
            }
        }
        if !out.success {
            errors.push(error_summary(&out.text));
        }
    }
    cache.at_ms = now_ms();
    cache.error = (!errors.is_empty()).then(|| errors.join("\n"));
    write_cache(cache_dir, MAVEN_CACHE, &cache)
}

/// Runs `gradle tasks --all` and caches the task list.
pub fn sync_gradle(
    root: &Path,
    cache_dir: &Path,
    options: &SyncOptions,
    cancel: &CancellationToken,
    progress: &dyn Fn(SyncProgress),
) -> IdeResult<()> {
    let model = gradle::load(root).ok_or_else(|| IdeError::not_found("no Gradle build in this project"))?;
    let mut args: Vec<String> = vec!["--console=plain".into(), "-q".into(), "tasks".into(), "--all".into()];
    if options.offline {
        args.push("--offline".into());
    }
    progress(SyncProgress { message: "Loading Gradle tasks".into(), fraction: None });
    let out = run(
        options.gradle_command.as_deref().unwrap_or(&model.command),
        &args,
        &root.join(&model.dir),
        &options.env,
        cancel,
        |_| {},
    )?;
    let cache = GradleCache {
        hash: hash_files(&gradle::build_files(root, &model)),
        at_ms: now_ms(),
        error: (!out.success).then(|| error_summary(&out.text)),
        tasks: if out.success { gradle::parse_tasks(&out.text) } else { Vec::new() },
    };
    write_cache(cache_dir, GRADLE_CACHE, &cache)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn gradle_sync_uses_resolved_command_and_environment() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::write(root.join("build.gradle"), "").unwrap();
        let launcher = root.join("configured-gradle");
        std::fs::write(&launcher, "#!/bin/sh\nprintf '%s\\n' \"$JAVA_HOME\" \"$GRADLE_USER_HOME\" > actual-env\n")
            .unwrap();
        std::fs::set_permissions(&launcher, std::fs::Permissions::from_mode(0o755)).unwrap();
        let options = SyncOptions {
            gradle_command: Some(launcher.to_string_lossy().into_owned()),
            env: BTreeMap::from([
                ("JAVA_HOME".into(), "/jdk21".into()),
                ("GRADLE_USER_HOME".into(), "/gradle-cache".into()),
            ]),
            ..Default::default()
        };
        sync_gradle(root, &root.join("cache"), &options, &CancellationToken::new(), &|_| {}).unwrap();
        assert_eq!(std::fs::read_to_string(root.join("actual-env")).unwrap(), "/jdk21\n/gradle-cache\n");
    }

    #[test]
    fn caches_merge_and_go_stale() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("p");
        let cache_dir = tmp.path().join("cache");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("pom.xml"), "<project><groupId>g</groupId><artifactId>a</artifactId></project>")
            .unwrap();
        let mut model = maven::load_with_repo(&root, None);
        assert!(model.synced_at.is_none());
        let cache = MavenCache {
            hash: hash_files(&maven::build_files(&root, &model)),
            at_ms: 5.0,
            error: None,
            verbose: true,
            projects: vec![CachedMavenProject {
                key: "g:a".into(),
                plugins: vec![maven::plugin(
                    "org.apache.maven.plugins",
                    "maven-clean-plugin",
                    Some("3.2.0".into()),
                    &[],
                )],
                dependencies: vec![MavenDependency { artifact_id: "dep".into(), ..MavenDependency::default() }],
            }],
        };
        write_cache(&cache_dir, MAVEN_CACHE, &cache).unwrap();
        apply_maven_cache(&root, &cache_dir, &mut model);
        assert_eq!(model.synced_at, Some(5.0));
        assert!(!model.stale);
        assert_eq!(model.projects[0].plugins.len(), 1);
        assert_eq!(model.projects[0].dependencies[0].artifact_id, "dep");

        std::fs::write(
            root.join("pom.xml"),
            "<project><groupId>g</groupId><artifactId>a</artifactId><version>2</version>\
             <dependencies><dependency><groupId>g</groupId><artifactId>fresh</artifactId><version>1</version></dependency></dependencies>\
             </project>",
        )
        .unwrap();
        let mut model = maven::load_with_repo(&root, None);
        apply_maven_cache(&root, &cache_dir, &mut model);
        assert!(model.stale);
        // The POM changed: the stale effective dependencies must not hide the new one (#249).
        assert_eq!(model.projects[0].dependencies[0].artifact_id, "fresh");
    }

    #[test]
    fn gradle_cache_replaces_tasks_per_project() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("p");
        let cache_dir = tmp.path().join("cache");
        std::fs::create_dir_all(root.join("app")).unwrap();
        std::fs::write(root.join("settings.gradle"), "include 'app'").unwrap();
        std::fs::write(root.join("app/build.gradle"), "apply plugin: 'java'").unwrap();
        let mut model = gradle::load(&root).unwrap();
        let cache = GradleCache {
            hash: hash_files(&gradle::build_files(&root, &model)),
            at_ms: 1.0,
            error: None,
            tasks: vec![(":app".into(), GradleTask { name: "hello".into(), group: "demo".into(), description: None })],
        };
        write_cache(&cache_dir, GRADLE_CACHE, &cache).unwrap();
        apply_gradle_cache(&root, &cache_dir, &mut model);
        assert_eq!(model.projects[1].tasks.len(), 1);
        assert!(model.projects[0].tasks.iter().any(|t| t.name == "wrapper"), "root keeps its defaults");
        assert!(!model.stale);
    }

    #[test]
    fn sync_reads_verbose_trees_with_a_pinned_plugin_unless_offline() {
        let online = maven_sync_goals(Path::new("e.xml"), false);
        assert_eq!(online, ["help:effective-pom", "-Doutput=e.xml", DEPENDENCY_TREE, "-Dverbose"]);
        let offline = maven_sync_goals(Path::new("e.xml"), true);
        assert_eq!(offline[2], "dependency:tree");
        assert!(offline.contains(&"-Dverbose".to_owned()));
    }

    #[test]
    fn cache_written_before_omissions_existed_still_loads() {
        let json = r#"{"hash":"x","at_ms":1.0,"error":null,"projects":[{"key":"g:a","plugins":[],
            "dependencies":[{"groupId":"g","artifactId":"d","version":"1","type":"jar","classifier":null,
            "scope":"compile","optional":false,"children":[]}]}]}"#;
        let cache: MavenCache = serde_json::from_str(json).unwrap();
        assert!(cache.projects[0].dependencies[0].resolved());
        assert!(!cache.verbose, "reloaded to read the omitted occurrences");
    }

    #[test]
    fn progress_and_error_lines() {
        assert_eq!(
            maven_building("[INFO] Building core 1.0-SNAPSHOT        [2/3]"),
            Some(("core 1.0-SNAPSHOT".into(), 2, 3))
        );
        assert_eq!(maven_building("[INFO] Building jar: x.jar"), None);
        let text = "[INFO] x\n[ERROR] Failed to execute goal\n[ERROR] \n[ERROR] Re-run Maven using -X\n";
        assert_eq!(error_summary(text), "Failed to execute goal");
        assert_eq!(error_summary("one\nlast line\n\n"), "last line");
    }
}
