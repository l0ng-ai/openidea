//! Resources a Gradle build changes while copying them (filters, `expand`, renames, extra
//! sources). The Java language server copies them as they are into Buildship's
//! `bin/<source set>` folders, which launches run from; IntelliJ IDEA runs Gradle's copy.
//! Before a launch, Gradle processes them and its output replaces those plain copies, so
//! each resource is on the classpath once, as the build produces it.
use super::{BuildPlan, BuildStep, BuildSystem, Format, run, subdir};
use crate::BuildModel;
use crate::gradle::{self, GradleModel, ReportedProject};
use ide_core::{CancellationToken, IdeError, IdeResult, Severity};
use std::fs;
use std::path::{Path, PathBuf};

/// A source set whose resources Gradle processes, with the folder the launch reads them from.
#[derive(Debug, PartialEq)]
struct Target {
    /// Task path from the root build (`:app:processResources`).
    task: String,
    /// Where the task writes the resources.
    output: PathBuf,
    /// The Java language server's output folder of the source set, on the launch classpath.
    jdtls: PathBuf,
}

fn targets(reported: &[ReportedProject], class_paths: &[String]) -> Vec<Target> {
    // buildSrc is built before the build, never addressable as `:buildSrc:<task>`.
    let addressable = |p: &&ReportedProject| !p.build.as_deref().is_some_and(|b| b.ends_with(":buildSrc"));
    let sets: Vec<_> = reported
        .iter()
        .filter(addressable)
        .flat_map(|p| p.source_sets.iter().filter_map(move |s| Some((p, s, s.processed.as_ref()?))))
        .collect();
    if sets.is_empty() {
        return Vec::new();
    }
    // Canonical, as Gradle reports its folders: jdtls may spell them differently.
    let entries: Vec<PathBuf> = class_paths.iter().filter_map(|p| dunce::canonicalize(p).ok()).collect();
    sets.into_iter()
        .filter_map(|(p, set, resources)| {
            // Buildship's output folder of the source set.
            let jdtls = dunce::canonicalize(Path::new(&p.dir).join("bin").join(&set.name)).ok()?;
            let project = if p.path == ":" { "" } else { p.path.as_str() };
            entries.contains(&jdtls).then(|| Target {
                task: format!("{project}:{}", resources.task),
                output: PathBuf::from(&resources.dir),
                jdtls,
            })
        })
        .collect()
}

/// Before a JVM launch from the Java language server's output folders on `class_paths`:
/// runs the Gradle tasks that process resources of those folders' source sets (see the
/// module docs) and copies their output over the plain copies. `cache_dir` holds the
/// linked builds' last syncs. Returns the tasks run, none for builds that copy their
/// resources as they are.
pub fn process_launch_resources(
    root: &Path,
    model: &BuildModel,
    cache_dir: &Path,
    class_paths: &[String],
    cancel: &CancellationToken,
) -> IdeResult<Vec<String>> {
    // A composite also reports the builds it includes: the deepest build owning a folder runs its task.
    let mut builds: Vec<&GradleModel> = model.gradle.iter().collect();
    builds.sort_by_key(|g| std::cmp::Reverse(subdir(root, &g.dir).components().count()));
    let mut done: Vec<PathBuf> = Vec::new();
    let mut tasks = Vec::new();
    for g in builds {
        let reported = crate::sync::reported_gradle_projects(&gradle::cache_dir(cache_dir, &g.dir));
        let targets: Vec<Target> =
            targets(&reported, class_paths).into_iter().filter(|t| !done.contains(&t.jdtls)).collect();
        if targets.is_empty() {
            continue;
        }
        let mut step = BuildStep::new(&g.command, &["--console=plain"], &subdir(root, &g.dir), Format::Gradle);
        step.args.extend(targets.iter().map(|t| t.task.clone()));
        step.env = g.env.clone();
        let plan = BuildPlan { system: BuildSystem::Gradle, title: "Process resources".into(), steps: vec![step] };
        let result = run(root, &plan, cancel, &|_| {})?;
        if !result.success {
            let errors: Vec<&str> = result
                .messages
                .iter()
                .filter(|m| m.severity == Severity::Error)
                .take(5)
                .map(|m| m.text.as_str())
                .collect();
            return Err(IdeError::internal(errors.join("\n")));
        }
        for t in targets {
            if cancel.is_cancelled() {
                return Err(IdeError::cancelled());
            }
            overlay(&t.output, &t.output, &t.jdtls)?;
            done.push(t.jdtls);
            tasks.push(t.task);
        }
    }
    Ok(tasks)
}

/// Copies the files under `dir` to the same place under `to` (relative to `base`) where
/// they differ, so unchanged resources are not rewritten on every launch.
fn overlay(base: &Path, dir: &Path, to: &Path) -> IdeResult<()> {
    let entries = match fs::read_dir(dir) {
        // No resources: the task had nothing to copy.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        entries => entries?,
    };
    for entry in entries {
        let entry = entry?;
        let path = entry.path();
        let kind = entry.file_type()?;
        if kind.is_dir() {
            overlay(base, &path, to)?;
        } else if kind.is_file() {
            let dest = to.join(path.strip_prefix(base).map_err(|e| IdeError::internal(e.to_string()))?);
            if !same_content(&path, &dest) {
                if let Some(parent) = dest.parent() {
                    fs::create_dir_all(parent)?;
                }
                fs::copy(&path, &dest)?;
            }
        }
    }
    Ok(())
}

fn same_content(a: &Path, b: &Path) -> bool {
    match (fs::metadata(a), fs::metadata(b)) {
        (Ok(m), Ok(n)) if m.len() == n.len() => matches!((fs::read(a), fs::read(b)), (Ok(x), Ok(y)) if x == y),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gradle::{ProcessedResources, ReportedSourceSet};

    fn write(path: &Path, text: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    fn set(name: &str, processed: Option<&Path>) -> ReportedSourceSet {
        ReportedSourceSet {
            name: name.into(),
            test: name == "test",
            processed: processed.map(|dir| ProcessedResources {
                task: if name == "main" { "processResources".into() } else { "processTestResources".into() },
                dir: dir.to_string_lossy().into_owned(),
            }),
            ..Default::default()
        }
    }

    fn project(path: &str, dir: &Path, sets: Vec<ReportedSourceSet>) -> ReportedProject {
        ReportedProject {
            path: path.into(),
            dir: dir.to_string_lossy().into_owned(),
            source_sets: sets,
            ..Default::default()
        }
    }

    /// Only processed source sets whose jdtls output is on the classpath: the launched
    /// module, upstream modules of the build, tests only for a test classpath; never buildSrc.
    #[test]
    fn targets_are_processed_sets_on_the_classpath() {
        let tmp = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(tmp.path()).unwrap();
        let (app, lib, plain, src) = (root.join("app"), root.join("lib"), root.join("plain"), root.join("buildSrc"));
        for dir in [&root, &app, &lib, &plain, &src] {
            for set in ["main", "test"] {
                fs::create_dir_all(dir.join("bin").join(set)).unwrap();
            }
        }
        let out = |dir: &Path, set: &str| dir.join("build/resources").join(set);
        let mut build_src = project(":buildSrc", &src, vec![set("main", Some(&out(&src, "main")))]);
        build_src.build = Some(":buildSrc".into());
        let reported = [
            project(":", &root, vec![set("main", Some(&out(&root, "main")))]),
            project(":app", &app, vec![set("main", Some(&out(&app, "main"))), set("test", Some(&out(&app, "test")))]),
            project(":lib", &lib, vec![set("main", Some(&out(&lib, "main")))]),
            project(":plain", &plain, vec![set("main", None)]),
            build_src,
        ];
        let entry = |dir: &Path, set: &str| dir.join("bin").join(set).to_string_lossy().into_owned();
        let runtime = [
            entry(&app, "main"),
            // Spelled differently from Gradle's canonical folders.
            format!("{}/", entry(&lib, "main")),
            entry(&plain, "main"),
            entry(&src, "main"),
            "/m2/spring-core.jar".into(),
        ];
        let tasks = |cp: &[String]| targets(&reported, cp).into_iter().map(|t| t.task).collect::<Vec<_>>();
        assert_eq!(tasks(&runtime), [":app:processResources", ":lib:processResources"]);
        let mut test = runtime.to_vec();
        test.insert(0, entry(&app, "test"));
        assert_eq!(tasks(&test), [":app:processResources", ":app:processTestResources", ":lib:processResources"]);
        assert_eq!(tasks(&[entry(&root, "main")]), [":processResources"], "the root project");
        let app_targets = targets(&reported, &runtime);
        let t = &app_targets[0];
        assert_eq!(
            (t.output.as_path(), t.jdtls.as_path()),
            (out(&app, "main").as_path(), app.join("bin/main").as_path())
        );

        let unprocessed = [project(":app", &app, vec![set("main", None)])];
        assert!(targets(&unprocessed, &runtime).is_empty());
    }

    /// The processed copy replaces jdtls's plain one (the reported `@version@` case), new
    /// files are added, identical ones are left alone and files Gradle doesn't produce stay.
    #[test]
    fn overlay_replaces_plain_copies_with_gradle_output() {
        let tmp = tempfile::tempdir().unwrap();
        let (output, jdtls) = (tmp.path().join("build/resources/main"), tmp.path().join("bin/main"));
        write(&output.join("application.yaml"), "spring:\n  application:\n    version: 0.0.1\n");
        write(&output.join("static/extra.txt"), "from an extra source");
        write(&output.join("migrations/V1__init.sql"), "create table t (id int);");
        write(&jdtls.join("application.yaml"), "spring:\n  application:\n    version: @version@\n");
        write(&jdtls.join("migrations/V1__init.sql"), "create table t (id int);");
        write(&jdtls.join("com/example/App.class"), "bytecode");
        let unchanged = fs::metadata(jdtls.join("migrations/V1__init.sql")).unwrap().modified().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));

        overlay(&output, &output, &jdtls).unwrap();
        let read = |rel: &str| fs::read_to_string(jdtls.join(rel)).unwrap();
        assert_eq!(read("application.yaml"), "spring:\n  application:\n    version: 0.0.1\n");
        assert_eq!(read("static/extra.txt"), "from an extra source");
        assert_eq!(read("com/example/App.class"), "bytecode");
        let modified = fs::metadata(jdtls.join("migrations/V1__init.sql")).unwrap().modified().unwrap();
        assert_eq!(modified, unchanged, "identical files are not rewritten");

        overlay(&tmp.path().join("missing"), &tmp.path().join("missing"), &jdtls).unwrap();
    }

    #[test]
    fn builds_without_processed_resources_run_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        // Running this command would fail the call.
        let missing = tmp.path().join("missing-gradle").to_string_lossy().into_owned();
        let model =
            BuildModel { gradle: vec![GradleModel { command: missing, ..Default::default() }], ..Default::default() };
        let class_paths = [tmp.path().join("bin/main").to_string_lossy().into_owned()];
        let tasks =
            process_launch_resources(tmp.path(), &model, tmp.path(), &class_paths, &CancellationToken::new()).unwrap();
        assert!(tasks.is_empty());
    }
}
