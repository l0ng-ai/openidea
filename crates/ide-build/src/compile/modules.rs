//! Module-scoped Maven menu builds (`Build Project` on a multi-module reactor, #4078).
//!
//! A project build used to run every linked reactor from end to end; only the
//! all-or-nothing up-to-date check could skip it, so one edited file anywhere
//! paid a full reactor build. This module narrows the scope: per-module input
//! fingerprints recorded after the last successful build tell which modules'
//! sources, resources, POM chain or outputs changed, the module dependency graph
//! spreads that to the modules depending on them, and the reactor runs
//! `mvn -pl <modules> -am` over just that set. Maven still decides what
//! recompiles inside the selected modules; `-am` keeps the upstream modules a
//! changed module was built against. Reactors without a usable record, and any
//! analysis that cannot resolve its inputs, build everything as before.

use super::up_to_date::restamp;
use super::*;
use std::fs;

/// The per-module input fingerprints of one reactor's last successful build.
#[derive(serde::Serialize, serde::Deserialize)]
struct ReactorRecord {
    /// Module directory (project-relative, `/`-separated) → its record.
    modules: BTreeMap<String, ModuleRecord>,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct ModuleRecord {
    fingerprint: LaunchFingerprint,
    /// Output folders of the module that existed after the build, relative to the
    /// project. Deleting one outside the IDE (`mvn clean` in a terminal) leaves every
    /// input unchanged, so the module is rebuilt only while they are gone.
    outputs: Vec<PathBuf>,
}

fn record_path(cache: &Path, top_dir: &str) -> PathBuf {
    let base = cache.join("menu-build").join("modules");
    if top_dir.is_empty() { base.join("root.json") } else { base.join(format!("{top_dir}.json")) }
}

fn load_record(cache: &Path, top_dir: &str) -> Option<ReactorRecord> {
    let bytes = fs::read(record_path(cache, top_dir)).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Projects of `reactor` that (transitively) depend on one of `changed`, through
/// dependencies whose version matches the provider. The reverse of the launch
/// upstream walk: a changed module's new classes force its consumers to recompile,
/// `test`-scoped ones included, since the project build compiles every module's tests.
fn affected_projects(reactor: &[&maven::MavenProject], changed: &HashSet<String>) -> HashSet<String> {
    let mut affected = changed.clone();
    let mut pending: Vec<&str> = changed.iter().map(String::as_str).collect();
    while let Some(dir) = pending.pop() {
        let Some(upstream) = reactor.iter().find(|p| p.dir == dir) else { continue };
        for consumer in reactor {
            if affected.contains(&consumer.dir) {
                continue;
            }
            let depends = consumer.dependencies.iter().any(|d| {
                d.resolved()
                    && upstream.group_id == d.group_id
                    && upstream.artifact_id == d.artifact_id
                    && d.version.as_ref().is_none_or(|v| *v == upstream.version)
            });
            if depends {
                affected.insert(consumer.dir.clone());
                pending.push(consumer.dir.as_str());
            }
        }
    }
    affected
}

/// `-pl` entries of the affected modules, relative to the reactor root the step
/// runs in, sorted so the command line does not depend on the model's project
/// order (Maven reorders the selection into its own reactor order anyway).
fn selection(reactor: &[&maven::MavenProject], top_dir: &str, affected: &HashSet<String>) -> String {
    let mut entries: Vec<String> = reactor
        .iter()
        .filter(|p| affected.contains(&p.dir))
        .map(|p| {
            Path::new(&p.dir).strip_prefix(top_dir).unwrap_or(Path::new(&p.dir)).to_string_lossy().replace('\\', "/")
        })
        .collect();
    entries.sort();
    entries.join(",")
}

/// Narrowed `Build Project` steps: per reactor, one full step when the reactor
/// or most of it is affected, one `-pl <modules> -am` step for the affected
/// subset, or no step at all when nothing changed since the last successful
/// build. `None` = some module's inputs cannot be fingerprinted, so the caller
/// falls back to the unscoped build. The `step` closure builds a reactor step
/// with the caller's goals and options.
pub(super) fn narrowed_maven_steps(
    cache: &Path,
    root: &Path,
    m: &maven::MavenModel,
    step: &impl Fn(&maven::MavenProject, &[String]) -> BuildStep,
    cancel: &CancellationToken,
) -> IdeResult<Option<Vec<BuildStep>>> {
    let mut steps = Vec::new();
    for top in m.projects.iter().filter(|p| !p.aggregated) {
        let Some(record) = load_record(cache, &top.dir) else {
            steps.push(step(top, &[]));
            continue;
        };
        let reactor = reactor_projects(m, top);
        let mut changed = HashSet::new();
        let mut lying: Vec<PathBuf> = Vec::new();
        for project in &reactor {
            let Some(current) = fingerprint::module_fingerprint(root, project, cancel)? else {
                return Ok(None);
            };
            let Some(recorded) = record.modules.get(&project.dir) else {
                changed.insert(project.dir.clone());
                continue;
            };
            if recorded.fingerprint != current {
                changed.insert(project.dir.clone());
                lying.extend(recorded.fingerprint.mtime_preserved_edits(&current));
            }
            if !recorded.outputs.iter().all(|out| root.join(out).is_dir()) {
                changed.insert(project.dir.clone());
            }
        }
        if changed.is_empty() {
            continue;
        }
        let affected = affected_projects(&reactor, &changed);
        restamp(root, &lying);
        if affected.len() >= reactor.len() || affected.contains(&top.dir) {
            steps.push(step(top, &[]));
        } else {
            let pl = selection(&reactor, &top.dir, &affected);
            steps.push(step(top, &["-pl".into(), pl, "-am".into()]));
        }
    }
    Ok(Some(steps))
}

/// Records the per-module inputs of every linked reactor as the baseline of the
/// next narrowed build. Failures are swallowed: a missing record only costs one
/// unscoped Maven run. Called after a successful project build.
pub fn record_module_build(cache: &Path, root: &Path, model: &BuildModel, cancel: &CancellationToken) {
    let Some(m) = &model.maven else { return };
    for top in m.projects.iter().filter(|p| !p.aggregated) {
        let mut modules = BTreeMap::new();
        for project in reactor_projects(m, top) {
            let Ok(Some(fingerprint)) = fingerprint::module_fingerprint(root, project, cancel) else { continue };
            let outputs = ["target/classes", "target/test-classes"]
                .iter()
                .map(|out| Path::new(&project.dir).join(out))
                .filter(|rel| root.join(rel).is_dir())
                .collect();
            modules.insert(project.dir.clone(), ModuleRecord { fingerprint, outputs });
        }
        let path = record_path(cache, &top.dir);
        if path.parent().is_some_and(|p| fs::create_dir_all(p).is_err()) {
            continue;
        }
        let Ok(bytes) = serde_json::to_vec(&ReactorRecord { modules }) else { continue };
        let _ = fs::write(&path, bytes);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(root: &Path, rel: &str, value: &str) {
        let path = root.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, value).unwrap();
    }

    /// `other` ← nothing, `app` ← `mid` ← `lib`, all under one reactor root.
    fn fixture(root: &Path) -> BuildModel {
        write(
            root,
            "pom.xml",
            r#"<project><modelVersion>4.0.0</modelVersion><groupId>t</groupId><artifactId>root</artifactId><version>1</version><packaging>pom</packaging><modules><module>lib</module><module>mid</module><module>app</module><module>other</module></modules></project>"#,
        );
        for (dir, class, deps) in [
            ("lib", "L", ""),
            (
                "mid",
                "M",
                "<dependencies><dependency><groupId>t</groupId><artifactId>lib</artifactId><version>1</version></dependency></dependencies>",
            ),
            (
                "app",
                "A",
                "<dependencies><dependency><groupId>t</groupId><artifactId>mid</artifactId><version>1</version></dependency></dependencies>",
            ),
            ("other", "O", ""),
        ] {
            write(
                root,
                &format!("{dir}/pom.xml"),
                &format!(
                    r#"<project><modelVersion>4.0.0</modelVersion><parent><groupId>t</groupId><artifactId>root</artifactId><version>1</version></parent><artifactId>{dir}</artifactId>{deps}</project>"#
                ),
            );
            write(
                root,
                &format!("{dir}/src/main/java/t/{class}.java"),
                &format!("package t; public class {class} {{}}"),
            );
        }
        BuildModel { maven: Some(maven::load(root)), ..Default::default() }
    }

    fn steps(cache: &Path, root: &Path, model: &BuildModel) -> Option<Vec<BuildStep>> {
        narrowed_maven_steps(
            cache,
            root,
            model.maven.as_ref().unwrap(),
            &|p, extra| {
                let mut s = BuildStep::new(&p.command, &["-B"], &subdir(root, &p.dir), Format::Maven);
                s.args.extend(extra.iter().cloned());
                s.args.push("test-compile".into());
                s
            },
            &CancellationToken::new(),
        )
        .unwrap()
    }

    fn pl_arg(step: &BuildStep) -> String {
        let i = step.args.iter().position(|a| a == "-pl").unwrap();
        step.args[i + 1].clone()
    }

    #[test]
    fn changed_module_selects_itself_and_transitive_dependents() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let model = fixture(root);
        let cache = root.join("cache");
        record_module_build(&cache, root, &model, &CancellationToken::new());
        write(root, "lib/src/main/java/t/L.java", "package t; public class L { int x; }");
        let steps = steps(&cache, root, &model).unwrap();
        assert_eq!(steps.len(), 1);
        assert_eq!(pl_arg(&steps[0]), "app,lib,mid");
        assert!(steps[0].args.contains(&"-am".into()));
    }

    #[test]
    fn unchanged_reactor_runs_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let model = fixture(root);
        let cache = root.join("cache");
        record_module_build(&cache, root, &model, &CancellationToken::new());
        assert!(steps(&cache, root, &model).unwrap().is_empty());
    }

    #[test]
    fn missing_or_corrupt_record_builds_everything() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let model = fixture(root);
        let cache = root.join("cache");
        assert_eq!(steps(&cache, root, &model).unwrap().len(), 1);
        record_module_build(&cache, root, &model, &CancellationToken::new());
        fs::create_dir_all(cache.join("menu-build").join("modules")).unwrap();
        fs::write(cache.join("menu-build").join("modules").join("root.json"), b"{not json").unwrap();
        assert_eq!(steps(&cache, root, &model).unwrap().len(), 1);
    }

    #[test]
    fn deleted_output_rebuilds_the_module_without_spreading() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let model = fixture(root);
        let cache = root.join("cache");
        for out in ["mid/target/classes/t", "other/target/classes"] {
            fs::create_dir_all(root.join(out)).unwrap();
        }
        record_module_build(&cache, root, &model, &CancellationToken::new());
        fs::remove_dir_all(root.join("mid/target")).unwrap();
        let steps = steps(&cache, root, &model).unwrap();
        assert_eq!(pl_arg(&steps[0]), "app,mid");
    }

    #[test]
    fn mtime_preserved_edit_is_restamped_before_the_build() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let model = fixture(root);
        let cache = root.join("cache");
        let rel = "lib/src/main/java/t/L.java";
        write(root, rel, "package t; public class L { int x; }");
        let mtime = fs::metadata(root.join(rel)).unwrap().modified().unwrap();
        record_module_build(&cache, root, &model, &CancellationToken::new());
        write(root, rel, "package t; public class L { int z; }");
        fs::File::options().write(true).open(root.join(rel)).unwrap().set_modified(mtime).unwrap();
        assert!(!steps(&cache, root, &model).unwrap().is_empty());
        assert!(fs::metadata(root.join(rel)).unwrap().modified().unwrap() > mtime);
    }

    #[test]
    fn test_scoped_consumers_are_rebuilt_and_version_mismatch_does_not_spread() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write(
            root,
            "pom.xml",
            r#"<project><modelVersion>4.0.0</modelVersion><groupId>t</groupId><artifactId>root</artifactId><version>1</version><packaging>pom</packaging><modules><module>lib</module><module>tester</module><module>v2</module></modules></project>"#,
        );
        write(
            root,
            "lib/pom.xml",
            r#"<project><modelVersion>4.0.0</modelVersion><parent><groupId>t</groupId><artifactId>root</artifactId><version>1</version></parent><artifactId>lib</artifactId></project>"#,
        );
        write(
            root,
            "tester/pom.xml",
            r#"<project><modelVersion>4.0.0</modelVersion><parent><groupId>t</groupId><artifactId>root</artifactId><version>1</version></parent><artifactId>tester</artifactId><dependencies><dependency><groupId>t</groupId><artifactId>lib</artifactId><version>1</version><scope>test</scope></dependency></dependencies></project>"#,
        );
        write(
            root,
            "v2/pom.xml",
            r#"<project><modelVersion>4.0.0</modelVersion><parent><groupId>t</groupId><artifactId>root</artifactId><version>1</version></parent><artifactId>v2</artifactId><dependencies><dependency><groupId>t</groupId><artifactId>lib</artifactId><version>2</version></dependency></dependencies></project>"#,
        );
        for module in ["lib", "tester", "v2"] {
            write(root, &format!("{module}/src/main/java/t/{module}.java"), "package t;");
        }
        let model = BuildModel { maven: Some(maven::load(root)), ..Default::default() };
        let cache = root.join("cache");
        record_module_build(&cache, root, &model, &CancellationToken::new());
        write(root, "lib/src/main/java/t/L.java", "package t; public class L {}");
        let steps = steps(&cache, root, &model).unwrap();
        // `tester`'s tests compile against `lib`.
        assert_eq!(pl_arg(&steps[0]), "lib,tester");
    }

    #[test]
    fn root_pom_change_selects_the_whole_reactor() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let model = fixture(root);
        let cache = root.join("cache");
        record_module_build(&cache, root, &model, &CancellationToken::new());
        write(
            root,
            "pom.xml",
            fs::read_to_string(root.join("pom.xml")).unwrap().replace("<modules>", "<!-- x --><modules>").as_str(),
        );
        let steps = steps(&cache, root, &model).unwrap();
        assert_eq!(steps.len(), 1);
        assert!(!steps[0].args.contains(&"-pl".into()));
    }

    /// A folder of two sibling reactors: `chain` (lib ← mid ← app) and `solo`.
    fn two_reactors(root: &Path) -> BuildModel {
        write(
            root,
            "chain/pom.xml",
            r#"<project><modelVersion>4.0.0</modelVersion><groupId>t</groupId><artifactId>chain</artifactId><version>1</version><packaging>pom</packaging><modules><module>lib</module><module>mid</module><module>app</module></modules></project>"#,
        );
        for (dir, class, deps) in [
            ("lib", "L", ""),
            (
                "mid",
                "M",
                "<dependencies><dependency><groupId>t</groupId><artifactId>lib</artifactId><version>1</version></dependency></dependencies>",
            ),
            (
                "app",
                "A",
                "<dependencies><dependency><groupId>t</groupId><artifactId>mid</artifactId><version>1</version></dependency></dependencies>",
            ),
        ] {
            write(
                root,
                &format!("chain/{dir}/pom.xml"),
                &format!(
                    r#"<project><modelVersion>4.0.0</modelVersion><parent><groupId>t</groupId><artifactId>chain</artifactId><version>1</version></parent><artifactId>{dir}</artifactId>{deps}</project>"#
                ),
            );
            write(
                root,
                &format!("chain/{dir}/src/main/java/t/{class}.java"),
                &format!("package t; public class {class} {{}}"),
            );
        }
        write(
            root,
            "solo/pom.xml",
            r#"<project><modelVersion>4.0.0</modelVersion><groupId>t</groupId><artifactId>solo</artifactId><version>1</version></project>"#,
        );
        write(root, "solo/src/main/java/t/S.java", "package t;");
        BuildModel { maven: Some(maven::load(root)), ..Default::default() }
    }

    #[test]
    fn unrelated_reactors_are_judged_separately() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let model = two_reactors(root);
        let cache = root.join("cache");
        record_module_build(&cache, root, &model, &CancellationToken::new());
        write(root, "solo/src/main/java/t/S.java", "package t; public class S {}");
        let steps = steps(&cache, root, &model).unwrap();
        assert_eq!(steps.len(), 1);
        assert_eq!(steps[0].cwd, subdir(root, "solo"));
    }
}
