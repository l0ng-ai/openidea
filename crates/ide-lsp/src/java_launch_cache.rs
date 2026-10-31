//! Content fingerprints read on a blocking worker; stable JAR digests use change-time guards.
use ide_core::{CancellationToken, IdeError, IdeResult};
use std::collections::{BTreeMap, HashMap, hash_map::DefaultHasher};
use std::hash::Hasher;
use std::io::Read;
use std::path::{Path, PathBuf};

use crate::jdtls::JavaLaunchInfo;

#[derive(Default)]
pub(crate) struct LaunchCache {
    pub entries: HashMap<(PathBuf, bool), Entry>,
}

pub(crate) struct Entry {
    pub server: ide_core::ServerId,
    pub generation: u64,
    pub epoch: (u64, u64),
    pub inputs: Snapshot,
    pub artifacts: Snapshot,
    pub info: JavaLaunchInfo,
    pub external_inputs: Vec<PathBuf>,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct Snapshot(pub BTreeMap<PathBuf, u64>, BTreeMap<PathBuf, JarStamp>);

impl PartialEq for Snapshot {
    fn eq(&self, other: &Self) -> bool {
        self.0 == other.0
    }
}
impl Eq for Snapshot {}

#[derive(Clone, Debug, PartialEq, Eq)]
struct JarStamp {
    length: u64,
    modified: (i64, i64),
    changed: (i64, i64),
    device: u64,
    inode: u64,
}

fn stable_jar_stamp(path: &Path, metadata: &std::fs::Metadata) -> Option<JarStamp> {
    if path.extension().is_none_or(|e| e != "jar") {
        return None;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).ok()?.as_secs();
        // Hash recent files even on filesystems with coarse timestamps. An edit in
        // the same timestamp tick must never reuse a previous digest.
        if metadata.mtime() < 0
            || metadata.ctime() < 0
            || now.saturating_sub(metadata.mtime() as u64) < 5
            || now.saturating_sub(metadata.ctime() as u64) < 5
        {
            return None;
        }
        Some(JarStamp {
            length: metadata.len(),
            modified: (metadata.mtime(), metadata.mtime_nsec()),
            changed: (metadata.ctime(), metadata.ctime_nsec()),
            device: metadata.dev(),
            inode: metadata.ino(),
        })
    }
    #[cfg(not(unix))]
    {
        let _ = metadata;
        None
    }
}

fn io_error(e: impl std::fmt::Display) -> IdeError {
    IdeError::internal(format!("Java launch fingerprint: {e}"))
}

impl Snapshot {
    #[cfg(test)]
    pub fn capture(roots: &[PathBuf], inputs: bool, cancel: &CancellationToken) -> IdeResult<Self> {
        Self::capture_with_previous(roots, inputs, cancel, None)
    }

    pub fn capture_with_previous(
        roots: &[PathBuf],
        inputs: bool,
        cancel: &CancellationToken,
        previous: Option<&Self>,
    ) -> IdeResult<Self> {
        let mut files = BTreeMap::new();
        let mut stamps = BTreeMap::new();
        for root in roots {
            if !root.exists() {
                files.insert(root.clone(), 0);
                continue;
            }
            let walker = ignore::WalkBuilder::new(root)
                .hidden(false)
                .ignore(false)
                .git_ignore(false)
                .git_global(false)
                .git_exclude(false)
                .follow_links(true)
                .filter_entry(move |entry| {
                    entry.depth() == 0
                        || !entry.file_type().is_some_and(|t| t.is_dir())
                        || !matches!(
                            entry.file_name().to_str(),
                            Some(".git" | ".metadata" | ".openidea" | ".idea" | "node_modules")
                        ) && (!inputs || !output_directory(entry.path()))
                })
                .build();
            for entry in walker {
                if cancel.is_cancelled() {
                    return Err(IdeError::cancelled());
                }
                let entry = entry.map_err(io_error)?;
                let path = entry.path();
                if entry.file_type().is_some_and(|t| t.is_file()) {
                    let mut file = std::fs::File::open(path).map_err(io_error)?;
                    let stamp = stable_jar_stamp(path, &file.metadata().map_err(io_error)?);
                    if let Some(stamp) = &stamp {
                        stamps.insert(path.to_owned(), stamp.clone());
                        if let Some(previous) = previous
                            && previous.1.get(path) == Some(stamp)
                            && let Some(digest) = previous.0.get(path)
                        {
                            files.insert(path.to_owned(), *digest);
                            continue;
                        }
                    }
                    let mut hash = DefaultHasher::new();
                    let mut buffer = [0u8; 64 * 1024];
                    loop {
                        if cancel.is_cancelled() {
                            return Err(IdeError::cancelled());
                        }
                        let n = file.read(&mut buffer).map_err(io_error)?;
                        if n == 0 {
                            break;
                        }
                        hash.write(&buffer[..n]);
                    }
                    files.insert(path.to_owned(), hash.finish());
                } else {
                    // Include empty directories, so removing an empty output directory invalidates too.
                    files.insert(path.to_owned(), 1);
                }
            }
        }
        if inputs {
            let generated: Vec<PathBuf> = files
                .keys()
                .filter(|p| is_build_file(p))
                .filter_map(|p| p.parent())
                .flat_map(|p| [p.join("target/generated-sources"), p.join("target/generated-test-sources")])
                .collect();
            files.extend(Self::capture_with_previous(&generated, false, cancel, None)?.0);
        }
        Ok(Self(files, stamps))
    }

    pub fn changes(&self, previous: &Self) -> Vec<serde_json::Value> {
        self.0
            .keys()
            .chain(previous.0.keys())
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .filter(|p| self.0.get(*p) != previous.0.get(*p))
            .map(|path| {
                serde_json::json!({
                    "uri": crate::uri::path_to_uri_string(path),
                    "type": if !self.0.contains_key(path) { 3 } else if !previous.0.contains_key(path) { 1 } else { 2 }
                })
            })
            .collect()
    }
}

fn output_directory(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else { return false };
    if name == ".gradle" {
        return true;
    }
    matches!(name, "target" | "build")
        && path
            .parent()
            .is_some_and(|p| ["pom.xml", "build.gradle", "build.gradle.kts"].iter().any(|f| p.join(f).is_file()))
}

pub(crate) fn is_build_file(path: &Path) -> bool {
    matches!(
        path.file_name().and_then(|n| n.to_str()),
        Some(
            "pom.xml"
                | "build.gradle"
                | "build.gradle.kts"
                | "settings.gradle"
                | "settings.gradle.kts"
                | "gradle.properties"
                | ".classpath"
                | ".project"
        )
    )
}

pub(crate) fn artifact_roots(info: &JavaLaunchInfo) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = info.class_paths.iter().chain(&info.module_paths).map(PathBuf::from).collect();
    roots.extend(dependency_poms(roots.clone().into_iter()));
    roots.sort();
    roots.dedup();
    roots
}

/// Includes the main artifact POM for classified Maven JARs as well as loose JAR sidecars.
pub(crate) fn dependency_poms(paths: impl Iterator<Item = PathBuf>) -> Vec<PathBuf> {
    let mut poms = Vec::new();
    for path in paths.filter(|p| p.extension().is_some_and(|e| e == "jar")) {
        poms.push(path.with_extension("pom"));
        if let Some(version_dir) = path.parent()
            && let Some(version) = version_dir.file_name()
            && let Some(artifact) = version_dir.parent().and_then(Path::file_name)
        {
            poms.push(version_dir.join(format!("{}-{}.pom", artifact.to_string_lossy(), version.to_string_lossy())));
        }
    }
    poms.sort();
    poms.dedup();
    poms
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invalidates_for_reactor_inputs_and_artifacts() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        for (p, data) in [
            ("pom.xml", "pom1"),
            ("app/pom.xml", "pom1"),
            ("domain/src/Message.java", "v1"),
            ("app/src/main/resources/app.properties", "a=1"),
            ("app/target/classes/Main.class", "bytecode"),
            ("repo/lib.jar", "jar1"),
        ] {
            let p = root.join(p);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, data).unwrap();
        }
        let cancel = CancellationToken::new();
        let inputs = || Snapshot::capture(&[root.to_owned()], true, &cancel).unwrap();
        let baseline = inputs();
        assert_eq!(inputs(), baseline);
        for file in ["pom.xml", "domain/src/Message.java", "app/src/main/resources/app.properties", "repo/lib.jar"] {
            let path = root.join(file);
            let original = std::fs::read(&path).unwrap();
            std::fs::write(&path, vec![b'x'; original.len()]).unwrap();
            assert_ne!(inputs(), baseline, "same-size edit of {file}");
            std::fs::write(&path, original).unwrap();
        }
        let output = root.join("app/target/classes");
        let compiled = Snapshot::capture(std::slice::from_ref(&output), false, &cancel).unwrap();
        std::fs::remove_dir_all(&output).unwrap();
        assert_ne!(Snapshot::capture(&[output], false, &cancel).unwrap(), compiled);
        assert_eq!(inputs(), baseline, "outputs are checked independently");
        std::fs::write(root.join("domain/src/New.java"), "new").unwrap();
        assert_ne!(inputs(), baseline);
        std::fs::remove_file(root.join("domain/src/Message.java")).unwrap();
        assert!(inputs().changes(&baseline).iter().any(|v| v["type"] == 3));
    }

    #[test]
    #[cfg(unix)]
    fn replacing_a_stable_jar_cannot_reuse_its_digest() {
        let dir = tempfile::tempdir().unwrap();
        let jar = dir.path().join("library.jar");
        std::fs::write(&jar, "jar1").unwrap();
        let modified = std::fs::metadata(&jar).unwrap().modified().unwrap();
        std::thread::sleep(std::time::Duration::from_secs(5));
        let roots = [jar.clone()];
        let cancel = CancellationToken::new();
        let original = Snapshot::capture(&roots, false, &cancel).unwrap();
        assert_eq!(original.1.len(), 1, "old JARs may reuse their content digest");
        assert_eq!(Snapshot::capture_with_previous(&roots, false, &cancel, Some(&original)).unwrap(), original);
        std::fs::write(&jar, "jar2").unwrap();
        std::fs::File::options().write(true).open(&jar).unwrap().set_modified(modified).unwrap();
        assert_ne!(
            Snapshot::capture_with_previous(&roots, false, &cancel, Some(&original)).unwrap(),
            original,
            "same length and restored mtime still invalidate via change time"
        );
    }

    #[test]
    fn cancellation_never_produces_a_cache_entry() {
        let dir = tempfile::tempdir().unwrap();
        let cancel = CancellationToken::new();
        cancel.cancel();
        assert!(Snapshot::capture(&[dir.path().to_owned()], true, &cancel).is_err());
    }
}
