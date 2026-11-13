//! On-demand sources resolution using the project's Maven launcher and repositories.

use super::MavenProject;
use crate::process;
use ide_core::{CancellationToken, IdeError, IdeResult};
use std::path::{Component, Path, PathBuf};

#[derive(Debug, PartialEq, Eq)]
pub struct Artifact {
    pub group: String,
    pub name: String,
    pub version: String,
    pub sources: PathBuf,
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
    let valid = |s: &str| {
        !s.is_empty() && s != "." && s != ".." && s.chars().all(|c| c.is_ascii_alphanumeric() || "_.-".contains(c))
    };
    if !parts[..n - 1].iter().all(|s| valid(s)) || file != format!("{name}-{version}.jar") {
        return None;
    }
    Some(Artifact {
        group: parts[..n - 3].join("."),
        name: name.into(),
        version: version.into(),
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
    if cancel.is_cancelled() {
        return Err(IdeError::cancelled());
    }
    if artifact.sources.is_file() {
        return Ok(Some(artifact.sources.clone()));
    }
    let mut args = vec!["-B".into(), "-N".into(), "-Dstyle.color=never".into()];
    args.extend(project.options.clone());
    args.extend([
        format!("-Dmaven.repo.local={}", repository.display()),
        "org.apache.maven.plugins:maven-dependency-plugin:3.8.1:get".into(),
        format!("-Dartifact={}:{}:{}:jar:sources", artifact.group, artifact.name, artifact.version),
        "-Dtransitive=false".into(),
    ]);
    let output = process::run(&project.command, &args, &root.join(&project.dir), &project.env, cancel, |_, _| {})?;
    if cancel.is_cancelled() {
        return Err(IdeError::cancelled());
    }
    if artifact.sources.is_file() {
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
}
