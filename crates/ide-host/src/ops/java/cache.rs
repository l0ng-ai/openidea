//! Immutable Maven outputs retained in the project cache, including across close/reopen.
use ide_build::compile::{self, LaunchFingerprint};
use ide_core::{CancellationToken, IdeError, IdeResult};
use ide_run::BuildPolicy;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Serialize, Deserialize)]
pub(super) struct Outputs {
    fingerprint: Option<LaunchFingerprint>,
    pub snapshot: PathBuf,
    pub originals: Vec<PathBuf>,
    #[serde(skip)]
    pub failure: Option<String>,
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

#[derive(Default)]
pub(super) struct BuildOptions {
    pub test: bool,
    pub policy: BuildPolicy,
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
        options: BuildOptions,
        local_repo: Option<PathBuf>,
        cancel: &CancellationToken,
    ) -> IdeResult<Outputs> {
        self.initialize();
        let BuildOptions { test, policy } = options;
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
        let mut before = fingerprint()?;
        let previous = fs::read(&record).ok().and_then(|bytes| serde_json::from_slice::<Outputs>(&bytes).ok());
        // Timestamp-incremental builders (Maven, the Kotlin plugin) skip sources whose
        // mtime did not advance. An external edit that preserves both length and mtime
        // invalidates the fingerprint but would still compile to nothing below, and the
        // stale outputs would be re-recorded as fresh. Re-stamp those sources first so
        // the rebuild sees them; then re-scan so the record written afterwards matches.
        let restamp: Vec<PathBuf> = match (before.as_ref(), previous.as_ref().and_then(|o| o.fingerprint.as_ref())) {
            (Some(current), Some(recorded)) => recorded.mtime_preserved_edits(current),
            _ => Vec::new(),
        };
        if !restamp.is_empty() {
            let now = std::time::SystemTime::now();
            for rel in &restamp {
                let path = root.join(rel);
                if let Err(error) = fs::File::options().write(true).open(&path).and_then(|file| file.set_modified(now))
                {
                    tracing::debug!(path = %path.display(), %error, "Cannot re-stamp externally edited source");
                }
            }
            before = fingerprint()?;
        }
        if let Some(outputs) = previous.as_ref()
            && policy != BuildPolicy::Rebuild
            && outputs.reusable(&before, &snapshots)
        {
            tracing::info!(module = %module.display(), test, "Reusing Maven launch snapshot");
            return Ok(previous.unwrap());
        }
        // Retain a non-reusable record even on failure, so removing the final mixed
        // source still delegates to Maven to clean its old classes on the next launch.
        fs::create_dir_all(record.parent().unwrap())?;
        fs::write(&record, b"null")?;
        if let Some(previous) = &previous {
            self.unreferenced.push(previous.snapshot.clone());
        }
        let kind = if policy == BuildPolicy::Rebuild { compile::BuildKind::Rebuild } else { compile::BuildKind::Build };
        let built = compile::build_for_launch(root, model, module, test, kind, cancel)?;
        if let Some(failure) = &built.failure {
            if policy != BuildPolicy::MakeAndContinueOnErrors {
                return Err(IdeError::internal(failure.clone()));
            }
            if let Some(mut previous) =
                previous.filter(|p| (0..p.originals.len()).all(|i| p.snapshot.join(i.to_string()).is_dir()))
            {
                previous.fingerprint = None;
                previous.failure = built.failure;
                let mut file = tempfile::NamedTempFile::new_in(record.parent().unwrap())?;
                serde_json::to_writer(file.as_file_mut(), &previous).map_err(|e| IdeError::internal(e.to_string()))?;
                file.persist(&record).map_err(|e| IdeError::from(e.error))?;
                return Ok(previous);
            }
        }
        let originals = built.class_dirs;
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
        let mut outputs = Outputs { fingerprint: None, snapshot, originals, failure: built.failure };
        if outputs.failure.is_none() && before.is_some() && before == after {
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
        fs::write(&script, "#!/bin/sh\necho build \"$@\" >> calls\nif [ -f src/main/kotlin/broken ]; then exit 1; fi\nmkdir -p target/classes\ncp src/main/kotlin/Main.kt target/classes/Main.class\n").unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
        fs::create_dir_all(root.join("src/main/kotlin")).unwrap();
        fs::write(root.join("src/main/kotlin/Main.kt"), "first").unwrap();
        ide_build::load(root, &root.join("cache"), None)
    }

    /// Like [`fixture`], but the build script skips sources whose mtime did not advance,
    /// mirroring Maven's (and the Kotlin plugin's) timestamp-incremental compilation.
    fn fixture_timestamp_incremental(root: &Path) -> ide_build::BuildModel {
        fs::write(
            root.join("pom.xml"),
            r#"<project><groupId>demo</groupId><artifactId>app</artifactId><version>1</version></project>"#,
        )
        .unwrap();
        let script = root.join("mvnw");
        fs::write(&script, "#!/bin/sh\necho build \"$@\" >> calls\nif [ -f src/main/kotlin/broken ]; then exit 1; fi\nmkdir -p target/classes\nif [ ! -f target/classes/Main.class ] || [ src/main/kotlin/Main.kt -nt target/classes/Main.class ]; then\ncp src/main/kotlin/Main.kt target/classes/Main.class\nfi\n").unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
        fs::create_dir_all(root.join("src/main/kotlin")).unwrap();
        fs::write(root.join("src/main/kotlin/Main.kt"), "first").unwrap();
        ide_build::load(root, &root.join("cache"), None)
    }

    #[test]
    fn rebuild_bypasses_snapshots_and_error_continuation_retains_previous_classes() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let model = fixture(root);
        let cancel = CancellationToken::new();
        let mut session = Session::new(root.join("cache"));
        let first = session.build(root, &model, root, BuildOptions::default(), None, &cancel).unwrap();
        let rebuilt = session
            .build(
                root,
                &model,
                root,
                BuildOptions { policy: BuildPolicy::Rebuild, ..Default::default() },
                None,
                &cancel,
            )
            .unwrap();
        assert_ne!(first.snapshot, rebuilt.snapshot);
        assert_eq!(fs::read_to_string(root.join("calls")).unwrap().lines().count(), 2);
        assert!(fs::read_to_string(root.join("calls")).unwrap().lines().last().unwrap().contains("clean"));
        fs::write(root.join("src/main/kotlin/broken"), "broken").unwrap();
        let continued = session
            .build(
                root,
                &model,
                root,
                BuildOptions { policy: BuildPolicy::MakeAndContinueOnErrors, ..Default::default() },
                None,
                &cancel,
            )
            .unwrap();
        assert_eq!(continued.snapshot, rebuilt.snapshot);
        assert!(continued.failure.unwrap().contains("Build failed"));
        assert_eq!(fs::read_to_string(continued.snapshot.join("0/Main.class")).unwrap(), "first");
        let again = session
            .build(
                root,
                &model,
                root,
                BuildOptions { policy: BuildPolicy::MakeAndContinueOnErrors, ..Default::default() },
                None,
                &cancel,
            )
            .unwrap();
        assert_eq!(again.snapshot, rebuilt.snapshot);
        assert!(again.failure.is_some());
        cancel.cancel();
        assert_eq!(
            session
                .build(
                    root,
                    &model,
                    root,
                    BuildOptions { policy: BuildPolicy::MakeAndContinueOnErrors, ..Default::default() },
                    None,
                    &cancel
                )
                .unwrap_err()
                .kind,
            ide_core::error::ErrorKind::Cancelled
        );
    }

    #[test]
    fn successful_snapshots_reuse_across_close_and_rebuild_for_changes_missing_outputs_or_failure() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let model = fixture(root);
        let cache = root.join("cache");
        let cancel = CancellationToken::new();
        let mut session = Session::new(cache.clone());
        let mut build = || session.build(root, &model, root, BuildOptions::default(), None, &cancel);
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
    /// An external tool (e.g. an AI code editor) rewrites a source file with the same byte
    /// length and preserves its mtime. The `(length, mtime)` fingerprint reads that as
    /// "unchanged" and would reuse the stale snapshot; the content hash must catch it.
    #[test]
    fn external_edit_preserving_length_and_mtime_rebuilds_the_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let model = fixture(root);
        let cache = root.join("cache");
        let cancel = CancellationToken::new();
        let mut session = Session::new(cache.clone());
        let first = session.build(root, &model, root, BuildOptions::default(), None, &cancel).unwrap();
        assert_eq!(fs::read_to_string(first.snapshot.join("0/Main.class")).unwrap(), "first");

        let source = root.join("src/main/kotlin/Main.kt");
        let mtime = fs::metadata(&source).unwrap().modified().unwrap();
        fs::write(&source, "other").unwrap(); // 5 bytes, same length as "first"
        fs::File::options().write(true).open(&source).unwrap().set_modified(mtime).unwrap();
        let rebuilt = session.build(root, &model, root, BuildOptions::default(), None, &cancel).unwrap();
        assert_ne!(rebuilt.snapshot, first.snapshot, "a same-length, same-mtime content change must rebuild");
        assert_eq!(fs::read_to_string(rebuilt.snapshot.join("0/Main.class")).unwrap(), "other");
    }

    #[test]
    fn restart_after_mtime_preserving_external_edit_actually_recompiles() {
        // The content hash triggers a rebuild for a same-length, same-mtime external
        // edit, but a timestamp-incremental builder (real Maven) would still compile
        // nothing and the stale snapshot would be re-recorded as fresh. Dropping the
        // session simulates the IDE restart from the report.
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let model = fixture_timestamp_incremental(root);
        let cache = root.join("cache");
        let cancel = CancellationToken::new();
        let mut session = Session::new(cache.clone());
        let first = session.build(root, &model, root, BuildOptions::default(), None, &cancel).unwrap();
        assert_eq!(fs::read_to_string(first.snapshot.join("0/Main.class")).unwrap(), "first");
        // Pin the old output's mtime so the `-nt` check below is deterministic even on
        // coarse-granularity filesystems.
        fs::File::options()
            .write(true)
            .open(root.join("target/classes/Main.class"))
            .unwrap()
            .set_modified(std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(42))
            .unwrap();
        drop(session);

        let source = root.join("src/main/kotlin/Main.kt");
        let mtime = fs::metadata(&source).unwrap().modified().unwrap();
        fs::write(&source, "other").unwrap(); // 5 bytes, same length as "first"
        fs::File::options().write(true).open(&source).unwrap().set_modified(mtime).unwrap();

        let mut session = Session::new(cache.clone());
        let rebuilt = session.build(root, &model, root, BuildOptions::default(), None, &cancel).unwrap();
        assert_ne!(rebuilt.snapshot, first.snapshot);
        assert_eq!(
            fs::read_to_string(rebuilt.snapshot.join("0/Main.class")).unwrap(),
            "other",
            "the re-stamped source must actually recompile instead of re-recording stale outputs"
        );
    }

    #[test]
    fn session_drop_removes_superseded_snapshots_and_preserves_records_across_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let model = fixture(root);
        let cache = root.join("cache");
        let cancel = CancellationToken::new();
        let mut session = Session::new(cache.clone());
        let first = session.build(root, &model, root, BuildOptions::default(), None, &cancel).unwrap();
        fs::write(root.join("src/main/kotlin/Main.kt"), "updated").unwrap();
        let second = session.build(root, &model, root, BuildOptions::default(), None, &cancel).unwrap();
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
        let reused = session.build(root, &model, root, BuildOptions::default(), None, &cancel).unwrap();
        assert_eq!(reused.snapshot, second.snapshot);
        fs::write(root.join("src/main/kotlin/Main.kt"), "third version").unwrap();
        let third = session.build(root, &model, root, BuildOptions::default(), None, &cancel).unwrap();
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
        let outputs = Outputs { fingerprint: None, snapshot: retained.clone(), originals: Vec::new(), failure: None };
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
        assert!(session.build(root, &model, root, BuildOptions::default(), None, &CancellationToken::new()).is_err());
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
        let outputs =
            session.build(root, &model, root, BuildOptions::default(), None, &CancellationToken::new()).unwrap();
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
        let first = session.build(root, &model, root, BuildOptions::default(), None, &cancel).unwrap();
        fs::remove_file(root.join("src/main/kotlin/Main.kt")).unwrap();
        assert!(!compile::launch_has_non_java_sources(root, &model, root, false));
        assert!(has_record(root, &cache, root));
        assert!(session.build(root, &model, root, BuildOptions::default(), None, &cancel).is_err());
        assert!(has_record(root, &cache, root));
        fs::write(root.join("src/main/kotlin/Main.kt"), "restored").unwrap();
        let restored = session.build(root, &model, root, BuildOptions::default(), None, &cancel).unwrap();
        assert_ne!(first.snapshot, restored.snapshot);
    }
}
