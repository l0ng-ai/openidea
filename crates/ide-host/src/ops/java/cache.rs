//! Immutable Maven outputs retained in the project cache, including across close/reopen.
use ide_build::compile::{self, LaunchFingerprint};
use ide_core::{CancellationToken, IdeError, IdeResult};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Serialize, Deserialize)]
pub(super) struct Outputs {
    fingerprint: Option<LaunchFingerprint>,
    pub snapshot: PathBuf,
    pub originals: Vec<PathBuf>,
}

impl Outputs {
    fn reusable(&self, fingerprint: &Option<LaunchFingerprint>, snapshots: &Path) -> bool {
        fingerprint.is_some()
            && self.fingerprint == *fingerprint
            && self.snapshot.parent() == Some(snapshots)
            && !self.originals.is_empty()
            && (0..self.originals.len()).all(|i| self.snapshot.join(i.to_string()).is_dir())
    }
}

fn record_path(root: &Path, cache: &Path, module: &Path, test: bool) -> Option<PathBuf> {
    Some(cache.join("java-launch/records").join(module.strip_prefix(root).ok()?).join(if test {
        "test.json"
    } else {
        "main.json"
    }))
}

pub(super) fn has_record(root: &Path, cache: &Path, module: &Path) -> bool {
    [false, true].into_iter().any(|test| record_path(root, cache, module, test).is_some_and(|record| record.is_file()))
}

/// Owned by Project: running JVMs may still load superseded outputs until it drops.
pub(crate) struct Session {
    cache: PathBuf,
    initialized: bool,
    unreferenced: Vec<PathBuf>,
}

impl Session {
    pub(crate) fn new(cache: PathBuf) -> Self {
        Self { cache, initialized: false, unreferenced: Vec::new() }
    }

    pub(super) fn initialize(&mut self) {
        if !self.initialized {
            self.initialized = true;
            if let Err(error) = sweep(&self.cache) {
                tracing::warn!(%error, "Cannot clean previous Java launch snapshots");
            }
        }
    }

    pub(super) fn build(
        &mut self,
        root: &Path,
        model: &ide_build::BuildModel,
        module: &Path,
        test: bool,
        local_repo: Option<PathBuf>,
        cancel: &CancellationToken,
    ) -> IdeResult<Outputs> {
        self.initialize();
        let cache = &self.cache;
        let record =
            record_path(root, cache, module, test).ok_or_else(|| IdeError::internal("launch outside project"))?;
        let snapshots = cache.join("java-launch/snapshots");
        let fingerprint = || match compile::launch_fingerprint(root, model, module, test, local_repo.clone(), cancel) {
            Ok(value) => Ok(value),
            Err(e) if cancel.is_cancelled() => Err(e),
            Err(e) => {
                tracing::debug!(error = %e, "Cannot fingerprint Maven launch; rebuilding");
                Ok(None)
            }
        };
        let before = fingerprint()?;
        let previous = fs::read(&record).ok().and_then(|bytes| serde_json::from_slice::<Outputs>(&bytes).ok());
        if let Some(outputs) = previous.as_ref()
            && outputs.reusable(&before, &snapshots)
        {
            tracing::info!(module = %module.display(), test, "Reusing Maven launch snapshot");
            return Ok(previous.unwrap());
        }
        // Retain a non-reusable record even on failure, so removing the final mixed
        // source still delegates to Maven to clean its old classes on the next launch.
        fs::create_dir_all(record.parent().unwrap())?;
        fs::write(&record, b"null")?;
        if let Some(previous) = previous {
            self.unreferenced.push(previous.snapshot);
        }
        let originals = compile::build_for_launch(root, model, module, test, cancel)?;
        fs::create_dir_all(&snapshots)?;
        let snapshot = tempfile::Builder::new().prefix("launch-").tempdir_in(&snapshots)?.keep();
        // Retain every new snapshot even if copying or publishing its record fails.
        self.unreferenced.push(snapshot.clone());
        for (i, source) in originals.iter().enumerate() {
            if cancel.is_cancelled() {
                return Err(IdeError::cancelled());
            }
            ide_vfs::copy(source, &snapshot.join(i.to_string()))?;
        }
        let after = fingerprint()?;
        if cancel.is_cancelled() {
            return Err(IdeError::cancelled());
        }
        let mut outputs = Outputs { fingerprint: None, snapshot, originals };
        if before.is_some() && before == after {
            outputs.fingerprint = before;
            fs::create_dir_all(record.parent().unwrap())?;
            let mut file = tempfile::NamedTempFile::new_in(record.parent().unwrap())?;
            serde_json::to_writer(file.as_file_mut(), &outputs).map_err(|e| IdeError::internal(e.to_string()))?;
            file.persist(&record).map_err(|e| IdeError::from(e.error))?;
            self.unreferenced.retain(|path| path != &outputs.snapshot);
        }
        Ok(outputs)
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        // Recheck all records: another module or launch mode may reference a path.
        if let Ok(referenced) = referenced_snapshots(&self.cache) {
            let snapshots = self.cache.join("java-launch/snapshots");
            for path in &self.unreferenced {
                remove_unreferenced(path, &snapshots, &referenced);
            }
        }
    }
}

fn referenced_snapshots(cache: &Path) -> std::io::Result<HashSet<PathBuf>> {
    let mut referenced = HashSet::new();
    let records = cache.join("java-launch/records");
    if !records.try_exists()? {
        return Ok(referenced);
    }
    let mut pending = vec![records];
    while let Some(dir) = pending.pop() {
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            let kind = entry.file_type()?;
            if kind.is_dir() {
                pending.push(entry.path());
            } else if kind.is_file() && entry.path().extension().is_some_and(|ext| ext == "json") {
                let outputs: Option<Outputs> = serde_json::from_slice(&fs::read(entry.path())?)?;
                if let Some(outputs) = outputs
                    && let Ok(path) = fs::canonicalize(outputs.snapshot)
                {
                    referenced.insert(path);
                }
            }
        }
    }
    Ok(referenced)
}

fn remove_unreferenced(path: &Path, snapshots: &Path, referenced: &HashSet<PathBuf>) {
    // Only real launch-* directories directly inside snapshots, never symlinks.
    if path.parent() != Some(snapshots)
        || !path.file_name().is_some_and(|name| name.to_string_lossy().starts_with("launch-"))
        || !fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_dir())
    {
        return;
    }
    if let (Ok(path), Ok(snapshots)) = (fs::canonicalize(path), fs::canonicalize(snapshots))
        && path.parent() == Some(snapshots.as_path())
        && !referenced.contains(&path)
        && let Err(error) = fs::remove_dir_all(&path)
    {
        tracing::warn!(%error, path = %path.display(), "Cannot remove Java launch snapshot");
    }
}

fn sweep(cache: &Path) -> std::io::Result<()> {
    let referenced = referenced_snapshots(cache)?;
    let snapshots = cache.join("java-launch/snapshots");
    if snapshots.try_exists()? {
        for entry in fs::read_dir(&snapshots)? {
            remove_unreferenced(&entry?.path(), &snapshots, &referenced);
        }
    }
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn fixture(root: &Path) -> ide_build::BuildModel {
        fs::write(
            root.join("pom.xml"),
            r#"<project><groupId>demo</groupId><artifactId>app</artifactId><version>1</version></project>"#,
        )
        .unwrap();
        let script = root.join("mvnw");
        fs::write(&script, "#!/bin/sh\necho build >> calls\nif [ -f src/main/kotlin/broken ]; then exit 1; fi\nmkdir -p target/classes\ncp src/main/kotlin/Main.kt target/classes/Main.class\n").unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
        fs::create_dir_all(root.join("src/main/kotlin")).unwrap();
        fs::write(root.join("src/main/kotlin/Main.kt"), "first").unwrap();
        ide_build::load(root, &root.join("cache"), None)
    }

    #[test]
    fn successful_snapshots_reuse_across_close_and_rebuild_for_changes_missing_outputs_or_failure() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let model = fixture(root);
        let cache = root.join("cache");
        let cancel = CancellationToken::new();
        let mut session = Session::new(cache.clone());
        let mut build = || session.build(root, &model, root, false, None, &cancel);
        let first = build().unwrap();
        let snapshot = first.snapshot.clone();
        drop(first);
        // Dropping an Outputs value leaves the persisted snapshot reusable.
        let second = build().unwrap();
        assert_eq!(snapshot, second.snapshot);
        assert_eq!(fs::read_to_string(root.join("calls")).unwrap().lines().count(), 1);
        fs::write(root.join("target/classes/Main.class"), "JDT stub").unwrap();
        assert_eq!(snapshot, build().unwrap().snapshot);
        assert_eq!(fs::read_to_string(snapshot.join("0/Main.class")).unwrap(), "first");
        fs::write(root.join("src/main/kotlin/Main.kt"), "updated").unwrap();
        let updated = build().unwrap();
        assert_ne!(snapshot, updated.snapshot);
        assert_eq!(fs::read_to_string(updated.snapshot.join("0/Main.class")).unwrap(), "updated");
        assert!(snapshot.join("0/Main.class").is_file(), "previous JVMs may still load it");
        fs::remove_dir_all(updated.snapshot.join("0")).unwrap();
        let rebuilt = build().unwrap();
        assert_ne!(rebuilt.snapshot, updated.snapshot);
        fs::write(root.join("src/main/kotlin/broken"), "broken").unwrap();
        assert!(build().is_err());
        assert_eq!(fs::read(cache.join("java-launch/records/main.json")).unwrap(), b"null");
        fs::remove_file(root.join("src/main/kotlin/broken")).unwrap();
        assert_ne!(rebuilt.snapshot, build().unwrap().snapshot, "a failed build invalidates success");
        cancel.cancel();
        assert!(build().is_err());
        assert_eq!(fs::read_to_string(root.join("calls")).unwrap().lines().count(), 5);
    }
    #[test]
    fn session_drop_removes_superseded_snapshots_and_preserves_records_across_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let model = fixture(root);
        let cache = root.join("cache");
        let cancel = CancellationToken::new();
        let mut session = Session::new(cache.clone());
        let first = session.build(root, &model, root, false, None, &cancel).unwrap();
        fs::write(root.join("src/main/kotlin/Main.kt"), "updated").unwrap();
        let second = session.build(root, &model, root, false, None, &cancel).unwrap();
        assert!(first.snapshot.is_dir());
        assert!(second.snapshot.is_dir());
        // Another mode can keep a superseded snapshot alive.
        let test_record = cache.join("java-launch/records/nested/test.json");
        fs::create_dir_all(test_record.parent().unwrap()).unwrap();
        fs::write(&test_record, serde_json::to_vec(&first).unwrap()).unwrap();
        drop(session);
        assert!(first.snapshot.is_dir());
        assert!(second.snapshot.is_dir());
        let mut session = Session::new(cache.clone());
        let reused = session.build(root, &model, root, false, None, &cancel).unwrap();
        assert_eq!(reused.snapshot, second.snapshot);
        fs::write(root.join("src/main/kotlin/Main.kt"), "third version").unwrap();
        let third = session.build(root, &model, root, false, None, &cancel).unwrap();
        assert!(second.snapshot.is_dir());
        drop(session);
        assert!(!second.snapshot.exists());
        assert!(first.snapshot.is_dir());
        assert!(third.snapshot.is_dir());
        assert_eq!(fs::read_to_string(root.join("calls")).unwrap().lines().count(), 3);
    }

    #[test]
    fn initial_sweep_only_removes_unreferenced_direct_snapshot_directories() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("cache");
        let snapshots = cache.join("java-launch/snapshots");
        let retained = snapshots.join("launch-retained");
        let orphan = snapshots.join("launch-orphan");
        let other = snapshots.join("other");
        let nested = other.join("launch-nested");
        let outside = dir.path().join("launch-outside");
        for path in [&retained, &orphan, &nested, &outside] {
            fs::create_dir_all(path).unwrap();
        }
        fs::write(outside.join("classes"), "keep").unwrap();
        std::os::unix::fs::symlink(&outside, snapshots.join("launch-link")).unwrap();
        fs::write(snapshots.join("launch-file"), "keep").unwrap();
        let record = cache.join("java-launch/records/deep/module/test.json");
        fs::create_dir_all(record.parent().unwrap()).unwrap();
        let outputs = Outputs { fingerprint: None, snapshot: retained.clone(), originals: Vec::new() };
        fs::write(record, serde_json::to_vec(&outputs).unwrap()).unwrap();
        let mut session = Session::new(cache);
        session.initialize();
        assert!(!orphan.exists());
        assert!(retained.is_dir());
        assert!(nested.is_dir());
        assert!(outside.join("classes").is_file());
        assert!(snapshots.join("launch-link").is_symlink());
        assert!(snapshots.join("launch-file").is_file());
        // Initialization must not sweep snapshots still in use by this session.
        fs::create_dir_all(&orphan).unwrap();
        session.initialize();
        assert!(orphan.is_dir());
        session.unreferenced.extend([outside.clone(), snapshots.join("../../launch-outside"), nested]);
        drop(session);
        assert!(outside.join("classes").is_file());
        assert!(other.join("launch-nested").is_dir());
    }

    #[test]
    fn failed_record_publish_retains_snapshot_until_session_drop() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let model = fixture(root);
        let script = root.join("mvnw");
        let mut text = fs::read_to_string(&script).unwrap();
        text.push_str("rm cache/java-launch/records/main.json\nmkdir cache/java-launch/records/main.json\n");
        fs::write(script, text).unwrap();
        let cache = root.join("cache");
        let mut session = Session::new(cache.clone());
        assert!(session.build(root, &model, root, false, None, &CancellationToken::new()).is_err());
        assert_eq!(session.unreferenced.len(), 1);
        let snapshot = session.unreferenced[0].clone();
        assert!(snapshot.join("0/Main.class").is_file());
        drop(session);
        assert!(!snapshot.exists());
    }

    #[test]
    fn edits_during_build_do_not_publish_a_success_record() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let model = fixture(root);
        let script = root.join("mvnw");
        let mut text = fs::read_to_string(&script).unwrap();
        text.push_str("echo edited-during-build >> src/main/kotlin/Main.kt\n");
        fs::write(script, text).unwrap();
        let cache = root.join("cache");
        let mut session = Session::new(cache.clone());
        let outputs = session.build(root, &model, root, false, None, &CancellationToken::new()).unwrap();
        assert!(outputs.fingerprint.is_none());
        assert_eq!(fs::read(cache.join("java-launch/records/main.json")).unwrap(), b"null");
        assert!(outputs.snapshot.join("0/Main.class").is_file());
        drop(session);
        assert!(!outputs.snapshot.exists());
    }
    #[test]
    fn deleting_the_last_mixed_source_keeps_maven_delegation_after_failure() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let model = fixture(root);
        let cache = root.join("cache");
        let cancel = CancellationToken::new();
        let mut session = Session::new(cache.clone());
        let first = session.build(root, &model, root, false, None, &cancel).unwrap();
        fs::remove_file(root.join("src/main/kotlin/Main.kt")).unwrap();
        assert!(!compile::launch_has_non_java_sources(root, &model, root, false));
        assert!(has_record(root, &cache, root));
        assert!(session.build(root, &model, root, false, None, &cancel).is_err());
        assert!(has_record(root, &cache, root));
        fs::write(root.join("src/main/kotlin/Main.kt"), "restored").unwrap();
        let restored = session.build(root, &model, root, false, None, &cancel).unwrap();
        assert_ne!(first.snapshot, restored.snapshot);
    }
}
