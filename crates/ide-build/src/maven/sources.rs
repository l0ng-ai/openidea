//! On-demand sources resolution using the project's Maven launcher and repositories.

use super::MavenProject;
use crate::process;
use ide_core::{CancellationToken, IdeError, IdeResult};
use std::collections::HashSet;
use std::fs::{self, File};
use std::path::{Component, Path, PathBuf};
use std::time::SystemTime;

const DEPENDENCY_PLUGIN: &str = "org.apache.maven.plugins:maven-dependency-plugin:3.8.1";
const SOURCE_REFRESH_WORKERS: usize = 4;

#[derive(Debug, PartialEq, Eq)]
pub struct Artifact {
    pub group: String,
    pub name: String,
    pub version: String,
    pub sources: PathBuf,
    binary: PathBuf,
}

fn valid_part(part: &str) -> bool {
    !part.is_empty()
        && part != "."
        && part != ".."
        && part.chars().all(|c| c.is_ascii_alphanumeric() || "_.-".contains(c))
}

fn modified_file(path: &Path) -> Option<SystemTime> {
    let metadata = fs::metadata(path).ok()?;
    if metadata.is_file() { metadata.modified().ok() } else { None }
}

impl Artifact {
    fn stale_binary(&self) -> Option<SystemTime> {
        if !self.version.ends_with("-SNAPSHOT") {
            return None;
        }
        let binary = modified_file(&self.binary)?;
        (modified_file(&self.sources)? < binary).then_some(binary)
    }
}

/// Resolve only jars inside the selected local repository, including custom repositories.
pub fn artifact(jar: &Path, repository: &Path) -> Option<Artifact> {
    let relative = jar.strip_prefix(repository).ok()?;
    let parts: Vec<&str> = relative
        .components()
        .map(|c| match c {
            Component::Normal(s) => s.to_str(),
            _ => None,
        })
        .collect::<Option<_>>()?;
    if parts.len() < 4 {
        return None;
    }
    let n = parts.len();
    let (name, version, file) = (parts[n - 3], parts[n - 2], parts[n - 1]);
    if !parts[..n - 1].iter().all(|s| valid_part(s)) || file != format!("{name}-{version}.jar") {
        return None;
    }
    Some(Artifact {
        group: parts[..n - 3].join("."),
        name: name.into(),
        version: version.into(),
        binary: jar.to_owned(),
        sources: jar.with_file_name(format!("{name}-{version}-sources.jar")),
    })
}

pub fn download(
    root: &Path,
    project: &MavenProject,
    artifact: &Artifact,
    repository: &Path,
    cancel: &CancellationToken,
) -> IdeResult<Option<PathBuf>> {
    resolve(root, project, artifact, repository, &[], artifact.stale_binary(), cancel)
}

fn resolve(
    root: &Path,
    project: &MavenProject,
    artifact: &Artifact,
    repository: &Path,
    profile_args: &[String],
    stale: Option<SystemTime>,
    cancel: &CancellationToken,
) -> IdeResult<Option<PathBuf>> {
    if cancel.is_cancelled() {
        return Err(IdeError::cancelled());
    }
    if stale.is_none() && artifact.sources.is_file() {
        return Ok(Some(artifact.sources.clone()));
    }
    let mut args = vec!["-B".into(), "-N".into(), "-Dstyle.color=never".into()];
    args.extend(project.options.iter().cloned());
    args.extend(profile_args.iter().cloned());
    args.push(format!("-Dmaven.repo.local={}", repository.display()));
    let coordinate = format!("-Dartifact={}:{}:{}:jar:sources", artifact.group, artifact.name, artifact.version);
    let stage = if let Some(binary) = stale {
        // Keep the existing attachment readable while Maven resolves the timestamped snapshot.
        // Disable Resolver's in-place copy to the base -SNAPSHOT filename.
        let stage =
            tempfile::Builder::new().prefix(".openidea-sources-").tempdir_in(artifact.sources.parent().unwrap())?;
        args.extend([
            "-U".into(),
            "-Daether.artifactResolver.snapshotNormalization=false".into(),
            format!("{DEPENDENCY_PLUGIN}:copy"),
            coordinate,
            "-Dmdep.useBaseVersion=true".into(),
            format!("-DoutputDirectory={}", stage.path().display()),
        ]);
        Some((stage, binary))
    } else {
        args.extend([format!("{DEPENDENCY_PLUGIN}:get"), coordinate, "-Dtransitive=false".into()]);
        None
    };
    let output = process::run(&project.command, &args, &root.join(&project.dir), &project.env, cancel, |_, _| {})?;
    if cancel.is_cancelled() {
        return Err(IdeError::cancelled());
    }
    if let Some((stage, binary)) = stage {
        let resolved = stage.path().join(artifact.sources.file_name().unwrap());
        if output.success && resolved.is_file() {
            return replace_stale_sources(artifact, &resolved, binary, cancel);
        }
    } else if artifact.sources.is_file() {
        return Ok(Some(artifact.sources.clone()));
    }
    let coordinate = format!("{}:{}:jar:sources:{}", artifact.group, artifact.name, artifact.version);
    if output.success
        || output.text.lines().any(|line| {
            line.contains(&coordinate) && (line.contains("Could not find artifact") || line.contains("was not found"))
        })
    {
        return Ok(None);
    }
    Err(IdeError::unavailable(
        output.text.lines().rev().take(20).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n"),
    ))
}

fn replace_stale_sources(
    artifact: &Artifact,
    resolved: &Path,
    binary: SystemTime,
    cancel: &CancellationToken,
) -> IdeResult<Option<PathBuf>> {
    // Maven can fall back to a locally installed snapshot. Keep its timestamp if it returned
    // the same bytes so a later reload can retry when newer sources are available.
    let hash = |path| -> std::io::Result<_> { Ok(blake3::Hasher::new().update_reader(File::open(path)?)?.finalize()) };
    if hash(resolved)? == hash(&artifact.sources)? {
        return Ok(None);
    }
    if cancel.is_cancelled() {
        return Err(IdeError::cancelled());
    }
    match artifact.stale_binary() {
        Some(current) if current == binary => {
            File::options().write(true).open(resolved)?.set_modified(SystemTime::now().max(binary))?;
            fs::rename(resolved, &artifact.sources)?;
            Ok(Some(artifact.sources.clone()))
        }
        None if artifact.sources.is_file() => Ok(Some(artifact.sources.clone())),
        _ => Ok(None),
    }
}

/// Resolved Maven dependencies with an existing attachment. Binaries may still be
/// updating during import, so freshness is checked when the refresh runs.
pub fn cached_snapshots<'a>(
    repository: &Path,
    projects: impl Iterator<Item = (usize, &'a MavenProject)>,
) -> Vec<(usize, Artifact)> {
    let mut seen = HashSet::new();
    let mut candidates = Vec::new();
    for (owner, project) in projects {
        let mut dependencies: Vec<_> = project.dependencies.iter().collect();
        while let Some(dep) = dependencies.pop() {
            if !dep.resolved() {
                continue;
            }
            dependencies.extend(&dep.children);
            let Some(version) = dep.version.as_deref().filter(|v| v.ends_with("-SNAPSHOT") && valid_part(v)) else {
                continue;
            };
            if dep.scope == "system"
                || dep.classifier.is_some()
                || !matches!(dep.kind.as_str(), "jar" | "bundle" | "maven-plugin" | "ejb")
                || !valid_part(&dep.artifact_id)
                || !dep.group_id.split('.').all(valid_part)
            {
                continue;
            }
            let name = &dep.artifact_id;
            let jar = repository
                .join(dep.group_id.replace('.', "/"))
                .join(name)
                .join(version)
                .join(format!("{name}-{version}.jar"));
            if let Some(artifact) = artifact(&jar, repository)
                && artifact.sources.is_file()
                && seen.insert(jar)
            {
                candidates.push((owner, artifact));
            }
        }
    }
    candidates
}

/// Refresh only previously attached snapshots. Maven subprocesses are bounded
/// and share the build reload's cancellation token.
pub fn refresh_snapshots(
    root: &Path,
    projects: &[MavenProject],
    repository: &Path,
    candidates: &[(usize, Artifact)],
    profiles: &[String],
    cancel: &CancellationToken,
) -> Vec<PathBuf> {
    let profile_args = if profiles.is_empty() { vec![] } else { vec![format!("-P{}", profiles.join(","))] };
    let profile_args = &profile_args;
    let stale: Vec<_> = candidates.iter().filter(|(_, artifact)| artifact.stale_binary().is_some()).collect();
    let batch_size = stale.len().div_ceil(SOURCE_REFRESH_WORKERS).max(1);
    std::thread::scope(|scope| {
        let workers: Vec<_> = stale
            .chunks(batch_size)
            .map(|batch| {
                scope.spawn(move || {
                    let mut refreshed = Vec::new();
                    for (owner, artifact) in batch.iter().copied() {
                        if cancel.is_cancelled() {
                            break;
                        }
                        let Some(binary) = artifact.stale_binary() else { continue };
                        match resolve(root, &projects[*owner], artifact, repository, profile_args, Some(binary), cancel)
                        {
                            Ok(Some(_)) => refreshed.push(artifact.binary.clone()),
                            Ok(None) => {}
                            Err(e) => tracing::debug!(path = %artifact.sources.display(), "Maven sources refresh: {e}"),
                        }
                    }
                    refreshed
                })
            })
            .collect();
        workers.into_iter().flat_map(|worker| worker.join().expect("Maven sources worker")).collect()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_sources_coordinates_from_maven_layouts() {
        for repository in ["/home/me/.m2/repository", "/tmp/project repo", "C:/Users/me/.m2/repository"] {
            for (group, name, version) in [
                ("org/apache/commons", "commons-lang3", "3.17.0"),
                ("com/example", "example-lib", "1.0-SNAPSHOT"),
                ("single", "lib", "1.0.0-rc.1"),
            ] {
                let repository = Path::new(repository);
                let dir = repository.join(group).join(name).join(version);
                let found = artifact(&dir.join(format!("{name}-{version}.jar")), repository).unwrap();
                assert_eq!(found.group, group.replace('/', "."));
                assert_eq!(found.name, name);
                assert_eq!(found.version, version);
                assert_eq!(found.sources, dir.join(format!("{name}-{version}-sources.jar")));
            }
        }
    }

    #[test]
    fn rejects_non_artifacts_and_paths_outside_the_repository() {
        let repository = Path::new("/m2/repository");
        for path in [
            "/m2/repository-other/g/a/1/a-1.jar",
            "/m2/repository/g/a/1/a-1-sources.jar",
            "/m2/repository/g/a/1/other.jar",
            "/m2/repository/g/a/../a-1.jar",
            "/m2/repository/g/a/1/a-1.pom",
            "/m2/repository/g/a-1.jar",
            "/gradle/caches/modules-2/files-2.1/g/a/1/hash/a-1.jar",
        ] {
            assert_eq!(artifact(Path::new(path), repository), None, "{path}");
        }
    }

    #[test]
    fn selects_existing_snapshot_attachments_from_the_resolved_tree() {
        use crate::maven::{MavenDependency, Omission};

        let repo = tempfile::tempdir().unwrap();
        let dependency = |name: &str, version: &str, cached: bool| {
            if cached {
                let dir = repo.path().join("example").join(name).join(version);
                fs::create_dir_all(&dir).unwrap();
                fs::write(dir.join(format!("{name}-{version}-sources.jar")), b"cached").unwrap();
            }
            MavenDependency {
                group_id: "example".into(),
                artifact_id: name.into(),
                version: Some(version.into()),
                kind: "jar".into(),
                ..Default::default()
            }
        };
        let transitive = dependency("transitive", "1-SNAPSHOT", true);
        let direct = MavenDependency { children: vec![transitive.clone()], ..dependency("direct", "1-SNAPSHOT", true) };
        let omitted =
            MavenDependency { omitted: Some(Omission::Conflict), ..dependency("omitted", "1-SNAPSHOT", true) };
        let projects = [
            MavenProject {
                dependencies: vec![
                    direct,
                    omitted,
                    dependency("missing", "1-SNAPSHOT", false),
                    dependency("release", "1", true),
                ],
                ..Default::default()
            },
            MavenProject { dependencies: vec![transitive], ..Default::default() },
        ];
        let mut found: Vec<_> = cached_snapshots(repo.path(), projects.iter().enumerate())
            .into_iter()
            .map(|(owner, artifact)| (owner, artifact.name))
            .collect();
        found.sort();
        assert_eq!(found, [(0, "direct".into()), (0, "transitive".into())]);
    }

    #[cfg(unix)]
    #[test]
    fn downloads_sources_again_when_the_snapshot_binary_is_newer() {
        use std::fs::FileTimes;
        use std::os::unix::fs::PermissionsExt;
        use std::time::Duration;

        let dir = tempfile::tempdir().unwrap();
        let repository = dir.path().join("repository");
        let jar = repository.join("example/lib/1-SNAPSHOT/lib-1-SNAPSHOT.jar");
        fs::create_dir_all(jar.parent().unwrap()).unwrap();
        fs::write(&jar, b"new binary").unwrap();
        let artifact = artifact(&jar, &repository).unwrap();
        fs::write(&artifact.sources, b"old sources").unwrap();
        File::open(&artifact.sources)
            .unwrap()
            .set_times(FileTimes::new().set_modified(SystemTime::now() - Duration::from_secs(60)))
            .unwrap();
        let launcher = dir.path().join("mvn");
        fs::write(
            &launcher,
            "#!/bin/sh\nfor arg do\n  case \"$arg\" in\n    -DoutputDirectory=*) out=\"${arg#*=}\" ;;\n  esac\ndone\nprintf 'new sources' > \"$out/lib-1-SNAPSHOT-sources.jar\"\n",
        )
        .unwrap();
        fs::set_permissions(&launcher, fs::Permissions::from_mode(0o755)).unwrap();
        let cancel = CancellationToken::new();
        cancel.cancel();
        assert!(download(dir.path(), &MavenProject::default(), &artifact, &repository, &cancel).is_err());
        assert_eq!(fs::read(&artifact.sources).unwrap(), b"old sources");
        let project = MavenProject { command: launcher.to_string_lossy().into_owned(), ..Default::default() };
        let cancel = CancellationToken::new();
        let path = download(dir.path(), &project, &artifact, &repository, &cancel).unwrap().unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"new sources");
        assert_eq!(
            download(dir.path(), &MavenProject::default(), &artifact, &repository, &CancellationToken::new()).unwrap(),
            Some(path)
        );
    }
}
