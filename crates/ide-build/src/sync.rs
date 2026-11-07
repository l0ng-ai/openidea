//! Reading the effective build from Maven / Gradle itself ("Reload" in the tool
//! windows): `mvn help:effective-pom dependency:tree -Dverbose` and `gradle tasks --all`,
//! run in the background with progress and cancellation. Results are cached
//! per project (`maven.json`, `gradle.json` in the cache directory) and merged
//! into the static model by [`crate::load`]; a changed build file marks them stale.

use crate::gradle::{self, GradleModel, GradleTask, ReportedProject, parse_reported_projects};
use crate::maven::{self, MavenDependency, MavenModel, MavenPlugin};
use crate::process::{self, Output};
use ide_core::{CancellationToken, IdeError, IdeResult};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use specta::Type;
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::SystemTime;

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
    /// Bumped whenever what the cache holds stops matching what the model would be
    /// built as now (plugin goals read from a descriptor, say): an older cache is
    /// dropped instead of shadowing the model.
    #[serde(default)]
    version: u32,
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
    /// The projects as Gradle evaluated them; empty in caches from before they were read.
    #[serde(default)]
    projects: Vec<ReportedProject>,
}

/// Init script printing every project, its source sets and Java version once configured.
const MODEL_INIT_SCRIPT: &str = include_str!("gradle-model.gradle");

const MAVEN_CACHE: &str = "maven.json";
const MAVEN_CACHE_VERSION: u32 = 1;

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

/// The settings' Maven options for the sync runs: the thread count (`-T`, also
/// `--threads`) is left out, because the sync pins its own `-T1` — its console
/// output is parsed as one stream, which a parallel build interleaves.
fn sync_maven_options(options: &[String]) -> Vec<String> {
    let mut out = Vec::with_capacity(options.len());
    let mut args = options.iter();
    while let Some(arg) = args.next() {
        if arg == "-T" || arg == "--threads" {
            args.next(); // the count itself
        } else if (arg.starts_with("-T") && arg.len() > 2) || arg.starts_with("--threads=") {
            // `--threads=4` / `-T4`: the count is part of the argument.
        } else {
            out.push(arg.clone());
        }
    }
    out
}
const GRADLE_CACHE: &str = "gradle.json";
const MAVEN_PROFILES: &str = "maven-profiles.json";

/// The Maven profiles (`-P` entries, `!id` deactivates) the project was last synced
/// with: what the IDE resolves it with besides `mvn` (the Java language server, Build Project).
pub fn maven_profiles(cache_dir: &Path) -> Vec<String> {
    read_cache(cache_dir, MAVEN_PROFILES).unwrap_or_default()
}

/// Records the profiles of a sync for [`maven_profiles`]; `true` when they changed.
pub fn save_maven_profiles(cache_dir: &Path, profiles: &[String]) -> IdeResult<bool> {
    if maven_profiles(cache_dir) == profiles {
        return Ok(false);
    }
    std::fs::create_dir_all(cache_dir)?;
    let json = serde_json::to_vec(profiles).map_err(|e| IdeError::internal(e.to_string()))?;
    std::fs::write(cache_dir.join(MAVEN_PROFILES), json)?;
    Ok(true)
}

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
    hash_contents(files, |f| std::fs::read(f).unwrap_or_default())
}

/// Like IDEA's auto-import CRC: editing a comment or reformatting a build script
/// does not make the last sync stale.
fn hash_gradle_files(files: &[PathBuf]) -> String {
    hash_contents(files, |f| {
        let text = std::fs::read_to_string(f).unwrap_or_default();
        let script = f.extension().is_some_and(|e| e == "gradle" || e == "kts");
        if script { gradle::script_fingerprint(&text) } else { text }.into_bytes()
    })
}

fn hash_contents(files: &[PathBuf], read: impl Fn(&Path) -> Vec<u8>) -> String {
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
        feed(&read(f));
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
    if cache.version != MAVEN_CACHE_VERSION {
        return; // built by an older IDE: what it holds no longer matches the model
    }
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

/// The projects of the last successful Gradle sync.
/// Parsed once per change of the cache file (modification time and size): content and source
/// roots are read on hot paths (every references search, Find in Files, repository scans).
pub fn reported_gradle_projects(cache_dir: &Path) -> Arc<Vec<ReportedProject>> {
    type Memo = HashMap<PathBuf, (Option<SystemTime>, u64, Arc<Vec<ReportedProject>>)>;
    static MEMO: LazyLock<Mutex<Memo>> = LazyLock::new(Default::default);
    let path = cache_dir.join(GRADLE_CACHE);
    let Ok(meta) = std::fs::metadata(&path) else {
        MEMO.lock().unwrap_or_else(|e| e.into_inner()).remove(&path);
        return Arc::default();
    };
    let stamp = (meta.modified().ok(), meta.len());
    let mut memo = MEMO.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((modified, len, projects)) = memo.get(&path)
        && (*modified, *len) == stamp
    {
        return projects.clone();
    }
    let projects = Arc::new(read_cache::<GradleCache>(cache_dir, GRADLE_CACHE).map(|c| c.projects).unwrap_or_default());
    memo.insert(path, (stamp.0, stamp.1, projects.clone()));
    projects
}

/// Merges the cached task list into `model`.
pub fn apply_gradle_cache(root: &Path, cache_dir: &Path, model: &mut GradleModel) {
    let Some(cache) = read_cache::<GradleCache>(cache_dir, GRADLE_CACHE) else { return };
    gradle::merge_reported_projects(root, model, &cache.projects);
    if !cache.tasks.is_empty() {
        for p in &mut model.projects {
            let tasks: Vec<GradleTask> =
                cache.tasks.iter().filter(|(path, _)| *path == p.path).map(|(_, t)| t.clone()).collect();
            if !tasks.is_empty() {
                p.tasks = tasks;
            }
        }
    }
    // A successful sync from before projects were cached has not seen computed includes.
    let without_projects = cache.error.is_none() && cache.projects.is_empty();
    model.synced_at = Some(cache.at_ms);
    model.sync_error = cache.error;
    model.stale = without_projects || cache.hash != hash_gradle_files(&gradle::build_files(root, model));
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
    let mut model = maven::load_with_linked(
        root,
        maven::default_local_repo(),
        &options.profiles,
        &options.maven_settings.linked_projects,
    );
    maven::UnlinkedProjects::from_model(&model, &options.maven_settings).filter(&mut model);
    std::fs::create_dir_all(cache_dir)?;
    let mut cache = MavenCache {
        version: MAVEN_CACHE_VERSION,
        hash: hash_files(&maven::build_files(root, &model)),
        verbose: true,
        ..MavenCache::default()
    };
    // Where the build resolves its jars, and therefore where the plugin goals are read
    // from: `-Dmaven.repo.local=` first, then `<localRepository>` of the `-s` settings,
    // then the user's default repository (which `plugin()` resolves itself).
    let local_repo: Option<PathBuf> =
        options.maven_options.iter().find_map(|a| a.strip_prefix("-Dmaven.repo.local=")).map(PathBuf::from).or_else(
            || {
                let mut args = options.maven_options.iter();
                while let Some(arg) = args.next() {
                    let path = match arg.as_str() {
                        "-s" | "--settings" => args.next().map(String::as_str),
                        _ => arg.strip_prefix("-s=").or_else(|| arg.strip_prefix("--settings=")),
                    };
                    if let Some(path) = path {
                        return maven::local_repository_of(Path::new(path));
                    }
                }
                None
            },
        );
    let mut errors: Vec<String> = Vec::new();
    for (n, top) in model.projects.iter().filter(|p| !p.aggregated).enumerate() {
        let effective = cache_dir.join(format!("effective-pom-{n}.xml"));
        let _ = std::fs::remove_file(&effective);
        // `-T1` keeps mvnd serial: its default parallel build interleaves the
        // `dependency:tree` output of concurrent modules, which the sync parses
        // as one stream. mvn is serial anyway, so this only pins the daemon.
        let mut args: Vec<String> = vec!["-B".into(), "-fae".into(), "-Dstyle.color=never".into(), "-T1".into()];
        args.extend(sync_maven_options(&options.maven_options));
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
        let effective_projects = std::fs::read_to_string(&effective)
            .map(|t| maven::parse_effective_pom_in(&t, local_repo.as_deref()))
            .unwrap_or_default();
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
    sync_gradle_model(root, cache_dir, &model, options, cancel, progress)
}

/// Syncs this exact linked build; another build's task paths and cache cannot interfere.
pub fn sync_gradle_model(
    root: &Path,
    cache_dir: &Path,
    model: &GradleModel,
    options: &SyncOptions,
    cancel: &CancellationToken,
    progress: &dyn Fn(SyncProgress),
) -> IdeResult<()> {
    if cancel.is_cancelled() {
        return Err(IdeError::cancelled());
    }
    let mut model = model.clone();
    let cache_dir = gradle::cache_dir(cache_dir, &model.dir);
    std::fs::create_dir_all(&cache_dir)?;
    let init_script = cache_dir.join("openidea-model.gradle");
    std::fs::write(&init_script, MODEL_INIT_SCRIPT)?;
    let mut args: Vec<String> = vec![
        "--console=plain".into(),
        "-q".into(),
        "--init-script".into(),
        init_script.to_string_lossy().into_owned(),
        "tasks".into(),
        "--all".into(),
    ];
    if options.offline {
        args.push("--offline".into());
    }
    progress(SyncProgress { message: "Loading Gradle tasks".into(), fraction: None });
    let out = match run(
        options.gradle_command.as_deref().unwrap_or(&model.command),
        &args,
        &root.join(&model.dir),
        &options.env,
        cancel,
        |_| {},
    ) {
        Ok(out) => out,
        Err(_) if cancel.is_cancelled() => return Err(IdeError::cancelled()),
        Err(error) if error.kind == ide_core::error::ErrorKind::Unavailable => {
            Output { success: false, text: error.message }
        }
        Err(error) => return Err(error),
    };
    if cancel.is_cancelled() {
        return Err(IdeError::cancelled());
    }
    let projects = if out.success { parse_reported_projects(&out.text) } else { Vec::new() };
    // Hash the build files of the reported projects, or the model is stale right after the sync.
    gradle::merge_reported_projects(root, &mut model, &projects);
    let cache = GradleCache {
        hash: hash_gradle_files(&gradle::build_files(root, &model)),
        at_ms: now_ms(),
        error: (!out.success).then(|| error_summary(&out.text)),
        tasks: if out.success { gradle::parse_tasks(&out.text) } else { Vec::new() },
        projects,
    };
    write_cache(&cache_dir, GRADLE_CACHE, &cache)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn unavailable_gradle_launchers_are_cached_without_stopping_other_builds() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        for dir in ["a", "b"] {
            std::fs::create_dir(root.join(dir)).unwrap();
            std::fs::write(root.join(dir).join("build.gradle"), "").unwrap();
        }
        let wrapper = root.join("b/gradlew");
        std::fs::write(&wrapper, "#!/bin/sh\nprintf '%s\\n' 'Build tasks' '-----------' 'healthy - ok'\n").unwrap();
        std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o755)).unwrap();
        let settings = ide_core::settings::GradleSettings {
            linked_projects: Some(vec!["a".into(), "b".into()]),
            ..Default::default()
        };
        let mut models = gradle::load_linked(root, &settings);
        models[0].command = root.join("a/missing-gradlew").to_string_lossy().into_owned();
        let cache = root.join("cache");
        let run = |model: &GradleModel| {
            sync_gradle_model(root, &cache, model, &SyncOptions::default(), &CancellationToken::new(), &|_| {})
        };
        for model in &models {
            run(model).unwrap();
        }
        let loaded = crate::load_linked(root, &cache, None, &Default::default(), &settings);
        assert!(loaded.gradle[0].sync_error.as_deref().unwrap().contains("cannot start"));
        assert!(loaded.gradle[1].sync_error.is_none());
        assert_eq!(loaded.gradle[1].projects[0].tasks[0].name, "healthy");
        let bad_wrapper = root.join("a/gradlew");
        std::fs::write(&bad_wrapper, "#!/bin/sh\nexit 0\n").unwrap();
        std::fs::set_permissions(&bad_wrapper, std::fs::Permissions::from_mode(0o644)).unwrap();
        models[0].command = bad_wrapper.to_string_lossy().into_owned();
        run(&models[0]).unwrap();
        let loaded = crate::load_linked(root, &cache, None, &Default::default(), &settings);
        assert!(loaded.gradle[0].sync_error.as_deref().unwrap().contains("cannot start"));
        assert!(loaded.gradle[1].sync_error.is_none());
        let blocked_cache = root.join("blocked-cache");
        std::fs::write(&blocked_cache, "a file cannot contain sync caches").unwrap();
        assert!(
            sync_gradle_model(
                root,
                &blocked_cache,
                &models[0],
                &SyncOptions::default(),
                &CancellationToken::new(),
                &|_| {}
            )
            .is_err()
        );
    }

    #[cfg(unix)]
    #[test]
    fn independent_syncs_do_not_share_tasks_launchers_environments_or_failures() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        for dir in ["a", "b"] {
            let build = root.join(dir);
            std::fs::create_dir_all(build.join("app")).unwrap();
            std::fs::write(build.join("settings.gradle"), "include 'app'").unwrap();
            std::fs::write(build.join("app/build.gradle"), "").unwrap();
            let report = serde_json::json!({"path": ":app", "dir": build.join("app")});
            let launcher = build.join("gradlew");
            std::fs::write(
                &launcher,
                format!("#!/bin/sh\npwd > actual-cwd\nprintf '%s' \"$JAVA_HOME\" > actual-env\nprintf '%s\\n' '@openidea-model\t{report}' 'Build tasks' '-----------' 'app:custom{dir} - custom task'\n"),
            ).unwrap();
            std::fs::set_permissions(launcher, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let settings = ide_core::settings::GradleSettings {
            linked_projects: Some(vec!["a".into(), "b".into()]),
            ..Default::default()
        };
        let cache = root.join("cache");
        let models = gradle::load_linked(root, &settings);
        for model in &models {
            let options = SyncOptions {
                env: BTreeMap::from([("JAVA_HOME".into(), format!("/jdk-{}", model.dir))]),
                ..Default::default()
            };
            sync_gradle_model(root, &cache, model, &options, &CancellationToken::new(), &|_| {}).unwrap();
            assert_eq!(
                std::fs::read_to_string(root.join(&model.dir).join("actual-env")).unwrap(),
                format!("/jdk-{}", model.dir)
            );
            assert_eq!(
                std::fs::read_to_string(root.join(&model.dir).join("actual-cwd")).unwrap().trim(),
                root.join(&model.dir).canonicalize().unwrap().to_string_lossy()
            );
        }
        let load = || crate::load_linked(root, &cache, None, &Default::default(), &settings);
        let model = load();
        assert_eq!(model.gradle[0].projects[0].tasks[0].name, "customa");
        assert_eq!(model.gradle[1].projects[0].tasks[0].name, "customb");
        assert_ne!(gradle::cache_dir(&cache, "a"), gradle::cache_dir(&cache, "b"));
        let before = std::fs::read(gradle::cache_dir(&cache, "a").join(GRADLE_CACHE)).unwrap();
        std::fs::write(root.join("b/gradlew"), "#!/bin/sh\nprintf 'FAILURE: broken b\\n'\nexit 1\n").unwrap();
        sync_gradle_model(root, &cache, &models[1], &SyncOptions::default(), &CancellationToken::new(), &|_| {})
            .unwrap();
        let model = load();
        assert!(model.gradle[0].sync_error.is_none());
        assert!(model.gradle[1].sync_error.is_some());
        assert_eq!(std::fs::read(gradle::cache_dir(&cache, "a").join(GRADLE_CACHE)).unwrap(), before);
        let cancel = CancellationToken::new();
        cancel.cancel();
        assert!(sync_gradle_model(root, &cache, &models[0], &SyncOptions::default(), &cancel, &|_| {}).is_err());
        assert_eq!(std::fs::read(gradle::cache_dir(&cache, "a").join(GRADLE_CACHE)).unwrap(), before);
        let unlinked = ide_core::settings::GradleSettings { linked_projects: Some(vec![]), ..Default::default() };
        assert!(crate::load_linked(root, &cache, None, &Default::default(), &unlinked).gradle.is_empty());
        assert!(crate::gradle_source_roots(root, &cache, &unlinked).is_empty());
    }

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
            version: MAVEN_CACHE_VERSION,
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
                    None,
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
    fn a_cache_from_an_older_ide_is_ignored() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("p");
        let cache_dir = tmp.path().join("cache");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("pom.xml"), "<project><groupId>g</groupId><artifactId>a</artifactId></project>")
            .unwrap();
        let mut model = maven::load_with_repo(&root, None);
        let cache = MavenCache {
            // What an older build wrote: no plugin descriptors were read back then, so
            // its goal lists would shadow the ones the model now knows.
            version: 0,
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
                    None,
                )],
                dependencies: vec![MavenDependency { artifact_id: "cached".into(), ..MavenDependency::default() }],
            }],
        };
        write_cache(&cache_dir, MAVEN_CACHE, &cache).unwrap();
        apply_maven_cache(&root, &cache_dir, &mut model);
        assert!(model.synced_at.is_none(), "the cache is dropped, the model stays unsynced");
        assert!(model.projects[0].dependencies.iter().all(|d| d.artifact_id != "cached"));
    }

    #[test]
    fn gradle_reported_projects_replace_static_ones() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = dunce::canonicalize(tmp.path()).unwrap();
        let root = ws.join("app");
        let billing = ws.join("billing");
        std::fs::create_dir_all(root.join("shared")).unwrap();
        std::fs::create_dir_all(billing.join("modules/core")).unwrap();
        // Computed includes: nothing a static reading can see.
        std::fs::write(root.join("settings.gradle"), "rootProject.name = 'Shop'\n['billing'].each { includeFlat it }")
            .unwrap();
        std::fs::write(billing.join("modules/core/build.gradle"), "apply plugin: 'java'").unwrap();
        // Built with serde: a Windows path holds backslashes, which raw JSON text would leave unescaped.
        let line = |p: ReportedProject| format!("@openidea-model\t{}\n", serde_json::to_string(&p).unwrap());
        let (r, b) = (root.display().to_string(), billing.display().to_string());
        let core_src = |p: &str| format!("{b}/modules/core/src/{p}");
        let set = |name: &str, test: bool, src: &[&str], res: &[&str]| gradle::ReportedSourceSet {
            name: name.into(),
            test,
            src: src.iter().map(|p| core_src(p)).collect(),
            res: res.iter().map(|p| core_src(p)).collect(),
        };
        // A settings script's own println comes first; task listing lines follow.
        let out = format!(
            "configuring billing\n{}{}{}@openidea-model\t{{broken\n\nOther tasks\n-----------\nbilling:core:jar\n",
            line(ReportedProject { path: ":".into(), dir: r.clone(), ..ReportedProject::default() }),
            line(ReportedProject {
                path: ":billing".into(),
                dir: b.clone(),
                java: Some(17),
                ..ReportedProject::default()
            }),
            line(ReportedProject {
                path: ":billing:core".into(),
                dir: format!("{b}/modules/core"),
                java: Some(21),
                source_sets: vec![
                    set("main", false, &["main/java"], &["main/resources"]),
                    set("test", true, &["main/java", "test/java"], &[]),
                ],
                ..ReportedProject::default()
            }),
        );
        let projects = parse_reported_projects(&out);
        assert_eq!(projects.len(), 3, "the malformed line is skipped");
        let src = |p: &str| PathBuf::from(core_src(p));
        assert_eq!(
            gradle::reported_source_roots(&projects),
            [
                (src("main/java"), gradle::ReportedRoot::Source),
                (src("main/resources"), gradle::ReportedRoot::Resources),
                (src("test/java"), gradle::ReportedRoot::Test),
            ]
        );
        let mut model = gradle::load(&root).unwrap();
        assert_eq!(model.projects.len(), 1);
        gradle::merge_reported_projects(&root, &mut model, &projects);
        let paths: Vec<_> = model.projects.iter().map(|p| (p.path.as_str(), p.name.as_str())).collect();
        assert_eq!(paths, [(":", "Shop"), (":billing", "billing"), (":billing:core", "core")]);
        assert_eq!(model.projects[0].dir, "");
        assert!(root.join(model.projects[2].build_file.as_ref().unwrap()).is_file());
        assert_eq!(
            gradle::external_roots(&root, model.projects.iter().map(|p| p.dir.as_str())),
            std::slice::from_ref(&billing)
        );
        assert_eq!(model.java_version, Some(21), "the newest version any module needs");
        assert_eq!(
            gradle::parse_tasks(&out),
            [(":billing:core".into(), GradleTask { name: "jar".into(), group: "other".into(), description: None })]
        );

        // The cached projects are parsed once per change of the cache file.
        let cache_dir = ws.join("cache");
        let write = |projects: &[ReportedProject]| {
            let cache = GradleCache { projects: projects.to_vec(), ..GradleCache::default() };
            write_cache(&cache_dir, GRADLE_CACHE, &cache).unwrap();
        };
        write(&projects);
        let first = reported_gradle_projects(&cache_dir);
        assert!(Arc::ptr_eq(&first, &reported_gradle_projects(&cache_dir)), "unchanged: not parsed again");
        assert_eq!(crate::gradle_external_roots(&root, &cache_dir, &Default::default()), [billing]);
        write(&projects[..1]);
        assert_eq!(reported_gradle_projects(&cache_dir).len(), 1, "a new sync is read");
        std::fs::remove_file(cache_dir.join(GRADLE_CACHE)).unwrap();
        assert!(reported_gradle_projects(&cache_dir).is_empty());
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
            hash: hash_gradle_files(&gradle::build_files(&root, &model)),
            at_ms: 1.0,
            error: None,
            tasks: vec![(":app".into(), GradleTask { name: "hello".into(), group: "demo".into(), description: None })],
            projects: [":", ":app"]
                .iter()
                .zip([root.clone(), root.join("app")])
                .map(|(path, dir)| ReportedProject {
                    path: (*path).into(),
                    dir: dir.to_string_lossy().into_owned(),
                    ..Default::default()
                })
                .collect(),
        };
        write_cache(&cache_dir, GRADLE_CACHE, &cache).unwrap();
        apply_gradle_cache(&root, &cache_dir, &mut model);
        assert_eq!(model.projects[1].tasks.len(), 1);
        assert!(model.projects[0].tasks.iter().any(|t| t.name == "wrapper"), "root keeps its defaults");
        assert!(!model.stale);

        let stale_after = |script: &str| {
            std::fs::write(root.join("app/build.gradle"), script).unwrap();
            let mut m = gradle::load(&root).unwrap();
            apply_gradle_cache(&root, &cache_dir, &mut m);
            m.stale
        };
        assert!(!stale_after("// a note\napply   plugin: 'java'\n"), "comments and spacing don't count");
        assert!(stale_after("apply plugin: 'groovy'"));
        std::fs::write(root.join("app/build.gradle"), "apply plugin: 'java'").unwrap();
        std::fs::write(root.join("gradle.properties"), "org.gradle.jvmargs=-Xmx2g").unwrap();
        let mut m = gradle::load(&root).unwrap();
        apply_gradle_cache(&root, &cache_dir, &mut m);
        assert!(m.stale, "gradle.properties is watched");
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

    #[test]
    fn maven_sync_leaves_out_the_settings_thread_count() {
        // The sync pins its own `-T1`; the user's `-T` (Settings › Maven) would win
        // over it on the mvnd command line and interleave the parsed output.
        let options = ["-s".to_owned(), "settings.xml".to_owned(), "-T".to_owned(), "4".to_owned()];
        assert_eq!(sync_maven_options(&options), ["-s", "settings.xml"]);
        let options = ["--threads".to_owned(), "2C".to_owned(), "-Dmaven.repo.local=/m2".to_owned()];
        assert_eq!(sync_maven_options(&options), ["-Dmaven.repo.local=/m2"]);
        assert_eq!(sync_maven_options(&["-T4".to_owned()]), Vec::<String>::new());
        assert_eq!(sync_maven_options(&["--threads=4".to_owned()]), Vec::<String>::new());
        assert!(sync_maven_options(&[]).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn maven_sync_runs_the_daemon_command_serially() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("p");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("pom.xml"), "<project><groupId>g</groupId><artifactId>a</artifactId></project>")
            .unwrap();
        let launcher = tmp.path().join("fake-mvnd");
        std::fs::write(&launcher, "#!/bin/sh\nprintf '%s\\n' \"$@\" > mvnd-args\n").unwrap();
        std::fs::set_permissions(&launcher, std::fs::Permissions::from_mode(0o755)).unwrap();
        let options =
            SyncOptions { maven_command: Some(launcher.to_string_lossy().into_owned()), ..Default::default() };
        sync_maven(&root, &tmp.path().join("cache"), &options, &CancellationToken::new(), &|_| {}).unwrap();
        let args = std::fs::read_to_string(root.join("mvnd-args")).unwrap();
        // `-T1` pins the daemon serial so the dependency trees stay parseable.
        assert!(args.contains("-T1"), "args: {args}");
        assert!(args.contains("help:effective-pom"), "args: {args}");
    }
}
