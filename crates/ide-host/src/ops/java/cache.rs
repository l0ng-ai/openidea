//! Immutable Maven outputs retained in the project cache, including across close/reopen.
use ide_build::compile::{self, LaunchFingerprint};
use ide_core::{CancellationToken, IdeError, IdeResult};
use ide_run::BuildPolicy;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

#[derive(Debug, Serialize, Deserialize)]
pub(super) struct Outputs {
    fingerprint: Option<LaunchFingerprint>,
    pub snapshot: PathBuf,
    pub originals: Vec<PathBuf>,
    #[serde(skip)]
    pub failure: Option<String>,
    /// Whether this result replaces jdtls diagnostics with a clean Maven build or a
    /// verified snapshot. It is runtime-only because reuse is determined per launch.
    #[serde(skip)]
    pub authoritative: bool,
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
    /// A JDT error makes a cache miss rebuild, but it must not prevent an unchanged
    /// snapshot from being reused on the next launch.
    pub rebuild_on_jdt_errors: bool,
    /// Other launches of the same reactor waiting for their build (configurations started
    /// together, #3971): their modules join this Maven run, and their launches then reuse
    /// the snapshots recorded here instead of running Maven again.
    pub members: Vec<Member>,
}

/// A launch module joining another launch's build; see [`BuildOptions::members`].
#[derive(Debug)]
pub(super) struct Member {
    pub module: PathBuf,
    pub rebuild_on_jdt_errors: bool,
}

/// Java launches from their start until their build: one launch's Maven run also builds
/// the modules of launches still waiting (configurations started together, #3971).
#[derive(Default)]
pub(crate) struct Waiting(Arc<Mutex<Vec<Arc<WaitingLaunch>>>>);

#[derive(Debug)]
pub(super) struct WaitingLaunch {
    pub module: PathBuf,
    pub test: bool,
    pub policy: BuildPolicy,
}

/// Leaves [`Waiting`] when dropped.
pub(super) struct WaitingGuard {
    all: Arc<Mutex<Vec<Arc<WaitingLaunch>>>>,
    launch: Arc<WaitingLaunch>,
}

impl Waiting {
    pub(super) fn add(&self, module: PathBuf, test: bool, policy: BuildPolicy) -> WaitingGuard {
        let launch = Arc::new(WaitingLaunch { module, test, policy });
        self.0.lock().push(launch.clone());
        WaitingGuard { all: self.0.clone(), launch }
    }
}

impl WaitingGuard {
    /// The other launches still waiting, in the order they started.
    pub(super) fn others(&self) -> Vec<Arc<WaitingLaunch>> {
        self.all.lock().iter().filter(|l| !Arc::ptr_eq(l, &self.launch)).cloned().collect()
    }
}

impl Drop for WaitingGuard {
    fn drop(&mut self) {
        self.all.lock().retain(|l| !Arc::ptr_eq(l, &self.launch));
    }
}

/// A module whose launch snapshot can't be reused, ready to build.
struct Pending {
    module: PathBuf,
    record: PathBuf,
    before: Option<LaunchFingerprint>,
    previous: Option<Outputs>,
}

/// Owned by Project: running JVMs may still load superseded outputs until it drops.
pub(crate) struct Session {
    cache: PathBuf,
    initialized: bool,
    unreferenced: Vec<PathBuf>,
    /// A shared build that failed for a member, by (module, test): the member's own launch
    /// reports it instead of running the same failing build again while its inputs are unchanged.
    failed: HashMap<(PathBuf, bool), (LaunchFingerprint, String)>,
}

impl Session {
    pub(crate) fn new(cache: PathBuf) -> Self {
        Self { cache, initialized: false, unreferenced: Vec::new(), failed: HashMap::new() }
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
        let BuildOptions { test, policy, rebuild_on_jdt_errors, members } = options;
        let mut lead = match self.prepare(root, model, module, test, policy, &local_repo, cancel)? {
            Ok(outputs) => return Ok(outputs),
            Err(pending) => pending,
        };
        if let Some((fingerprint, failure)) = self.failed.remove(&(module.to_path_buf(), test))
            && lead.before.as_ref() == Some(&fingerprint)
            && matches!(policy, BuildPolicy::Automatic | BuildPolicy::Make)
        {
            tracing::info!(module = %module.display(), "The shared Maven launch build failed for these inputs");
            return Err(IdeError::internal(failure));
        }
        // JDT can report errors from its own classpath while the last Maven snapshot is
        // still valid. Reuse that snapshot first; only a cache miss needs the expensive
        // clean rebuild that replaces JDT's error-stub classes.
        let policy = if rebuild_on_jdt_errors { BuildPolicy::Rebuild } else { policy };
        let mut joined = Vec::new();
        let mut rebuild = policy == BuildPolicy::Rebuild;
        for member in members {
            if let Err(pending) =
                self.prepare(root, model, &member.module, test, BuildPolicy::Make, &local_repo, cancel)?
            {
                rebuild |= member.rebuild_on_jdt_errors;
                joined.push(pending);
            }
        }
        let modules: Vec<PathBuf> =
            std::iter::once(&lead).chain(&joined).map(|pending| pending.module.clone()).collect();
        if modules.len() > 1 {
            tracing::info!(?modules, "Building the launch modules in one Maven run");
        }
        let kind = if rebuild { compile::BuildKind::Rebuild } else { compile::BuildKind::Build };
        let mut built = compile::build_for_launches(root, model, &modules, test, kind, cancel)?.into_iter();
        let lead_built = built.next().unwrap();
        for (pending, built) in joined.into_iter().zip(built) {
            match built.failure {
                Some(failure) => {
                    if let Some(before) = pending.before {
                        self.failed.insert((pending.module, test), (before, failure));
                    }
                }
                None => {
                    self.finish(root, model, pending, test, built.class_dirs, None, rebuild, &local_repo, cancel)?;
                }
            }
        }
        if let Some(failure) = &lead_built.failure {
            if policy != BuildPolicy::MakeAndContinueOnErrors {
                return Err(IdeError::internal(failure.clone()));
            }
            if let Some(mut previous) =
                lead.previous.take().filter(|p| (0..p.originals.len()).all(|i| p.snapshot.join(i.to_string()).is_dir()))
            {
                previous.fingerprint = None;
                previous.failure = lead_built.failure;
                write_record(&lead.record, &previous)?;
                return Ok(previous);
            }
        }
        self.finish(root, model, lead, test, lead_built.class_dirs, lead_built.failure, rebuild, &local_repo, cancel)
    }

    /// The reusable snapshot of `module` (`Ok`), else the module marked for a build (`Err`).
    #[allow(clippy::too_many_arguments)]
    fn prepare(
        &mut self,
        root: &Path,
        model: &ide_build::BuildModel,
        module: &Path,
        test: bool,
        policy: BuildPolicy,
        local_repo: &Option<PathBuf>,
        cancel: &CancellationToken,
    ) -> IdeResult<Result<Outputs, Pending>> {
        let record =
            record_path(root, &self.cache, module, test).ok_or_else(|| IdeError::internal("launch outside project"))?;
        let snapshots = self.cache.join("java-launch/snapshots");
        let mut before = fingerprint(root, model, module, test, local_repo, cancel)?;
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
            before = fingerprint(root, model, module, test, local_repo, cancel)?;
        }
        if let Some(outputs) = previous.as_ref()
            && policy != BuildPolicy::Rebuild
            && outputs.reusable(&before, &snapshots)
        {
            tracing::info!(module = %module.display(), test, "Reusing Maven launch snapshot");
            let mut outputs = previous.unwrap();
            outputs.authoritative = true;
            return Ok(Ok(outputs));
        }
        // Retain a non-reusable record even on failure, so removing the final mixed
        // source still delegates to Maven to clean its old classes on the next launch.
        fs::create_dir_all(record.parent().unwrap())?;
        fs::write(&record, b"null")?;
        if let Some(previous) = &previous {
            self.unreferenced.push(previous.snapshot.clone());
        }
        Ok(Err(Pending { module: module.to_path_buf(), record, before, previous }))
    }

    /// Copies the built outputs of a prepared module into a new snapshot and records it
    /// when the build succeeded on inputs that did not change meanwhile.
    #[allow(clippy::too_many_arguments)]
    fn finish(
        &mut self,
        root: &Path,
        model: &ide_build::BuildModel,
        pending: Pending,
        test: bool,
        originals: Vec<PathBuf>,
        failure: Option<String>,
        authoritative: bool,
        local_repo: &Option<PathBuf>,
        cancel: &CancellationToken,
    ) -> IdeResult<Outputs> {
        let snapshots = self.cache.join("java-launch/snapshots");
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
        let after = fingerprint(root, model, &pending.module, test, local_repo, cancel)?;
        if cancel.is_cancelled() {
            return Err(IdeError::cancelled());
        }
        let mut outputs = Outputs { fingerprint: None, snapshot, originals, failure, authoritative };
        if outputs.failure.is_none() && pending.before.is_some() && pending.before == after {
            outputs.fingerprint = pending.before;
            write_record(&pending.record, &outputs)?;
            self.unreferenced.retain(|path| path != &outputs.snapshot);
        }
        Ok(outputs)
    }
}

fn fingerprint(
    root: &Path,
    model: &ide_build::BuildModel,
    module: &Path,
    test: bool,
    local_repo: &Option<PathBuf>,
    cancel: &CancellationToken,
) -> IdeResult<Option<LaunchFingerprint>> {
    match compile::launch_fingerprint(root, model, module, test, local_repo.clone(), cancel) {
        Ok(value) => Ok(value),
        Err(e) if cancel.is_cancelled() => Err(e),
        Err(e) => {
            tracing::debug!(error = %e, "Cannot fingerprint Maven launch; rebuilding");
            Ok(None)
        }
    }
}

fn write_record(record: &Path, outputs: &Outputs) -> IdeResult<()> {
    fs::create_dir_all(record.parent().unwrap())?;
    let mut file = tempfile::NamedTempFile::new_in(record.parent().unwrap())?;
    serde_json::to_writer(file.as_file_mut(), outputs).map_err(|e| IdeError::internal(e.to_string()))?;
    file.persist(record).map_err(|e| IdeError::from(e.error))?;
    Ok(())
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

    /// A reactor of `lib` and the applications `a` and `b` depending on it; the build script
    /// compiles every module and logs its arguments.
    fn reactor_fixture(root: &Path) -> ide_build::BuildModel {
        let pom = |artifact: &str, extra: &str| {
            format!(
                "<project><groupId>demo</groupId><artifactId>{artifact}</artifactId><version>1</version>{extra}</project>"
            )
        };
        fs::write(
            root.join("pom.xml"),
            pom(
                "root",
                "<packaging>pom</packaging><modules><module>lib</module><module>a</module><module>b</module></modules>",
            ),
        )
        .unwrap();
        let lib = "<dependencies><dependency><groupId>demo</groupId><artifactId>lib</artifactId><version>1</version></dependency></dependencies>";
        for (module, extra) in [("lib", ""), ("a", lib), ("b", lib), ("other", "")] {
            fs::create_dir_all(root.join(module).join("src/main/java")).unwrap();
            fs::write(root.join(module).join("pom.xml"), pom(module, extra)).unwrap();
            fs::write(root.join(module).join("src/main/java/Main.java"), module).unwrap();
        }
        let script = root.join("mvnw");
        fs::write(&script, "#!/bin/sh\necho build \"$@\" >> calls\nif [ -f broken ]; then exit 1; fi\nfor m in lib a b; do mkdir -p $m/target/classes; cp $m/src/main/java/Main.java $m/target/classes/Main.class; done\n").unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
        ide_build::load(root, &root.join("cache"), None)
    }

    fn calls(root: &Path) -> Vec<String> {
        fs::read_to_string(root.join("calls")).unwrap_or_default().lines().map(str::to_owned).collect()
    }

    #[test]
    fn waiting_launches_of_one_reactor_share_one_maven_build() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let model = reactor_fixture(root);
        let cancel = CancellationToken::new();
        let mut session = Session::new(root.join("cache"));
        let (a, b) = (root.join("a"), root.join("b"));
        let with = |rebuild_on_jdt_errors: bool| BuildOptions {
            members: vec![Member { module: b.clone(), rebuild_on_jdt_errors }],
            ..Default::default()
        };
        let lead = session.build(root, &model, &a, with(false), None, &cancel).unwrap();
        assert_eq!(fs::read_to_string(lead.snapshot.join("0/Main.class")).unwrap(), "a");
        assert_eq!(fs::read_to_string(lead.snapshot.join("1/Main.class")).unwrap(), "lib");
        // b's own launch runs from the snapshot the shared build recorded for it.
        let member = session.build(root, &model, &b, BuildOptions::default(), None, &cancel).unwrap();
        assert!(member.authoritative);
        assert_eq!(fs::read_to_string(member.snapshot.join("0/Main.class")).unwrap(), "b");
        assert_eq!(calls(root).len(), 1);
        assert!(calls(root)[0].contains("-pl a,b -am") && calls(root)[0].ends_with(" compile"), "{:?}", calls(root));
        // A member whose JDT errors call for a clean build makes the shared build a rebuild.
        fs::write(root.join("lib/src/main/java/Main.java"), "lib 2").unwrap();
        session.build(root, &model, &a, with(true), None, &cancel).unwrap();
        assert!(calls(root)[1].contains("-pl a,b -am clean compile"), "{:?}", calls(root));
        let member = session.build(root, &model, &b, BuildOptions::default(), None, &cancel).unwrap();
        assert_eq!(fs::read_to_string(member.snapshot.join("1/Main.class")).unwrap(), "lib 2");
        assert_eq!(calls(root).len(), 2);
        // A failed shared build fails the member's launch without running Maven again,
        // once: unchanged inputs built on their own afterwards fail in their own build.
        fs::write(root.join("lib/src/main/java/Main.java"), "lib 3").unwrap();
        fs::write(root.join("broken"), "").unwrap();
        assert!(session.build(root, &model, &a, with(false), None, &cancel).is_err());
        let failure = session.build(root, &model, &b, BuildOptions::default(), None, &cancel).unwrap_err();
        assert!(failure.message.contains("Build failed"), "{failure:?}");
        assert_eq!(calls(root).len(), 3);
        assert!(session.build(root, &model, &b, BuildOptions::default(), None, &cancel).is_err());
        assert_eq!(calls(root).len(), 4);
        assert!(calls(root)[3].contains("-pl b -am"));
        // With nothing waiting, a launch builds just its own module, as before.
        fs::remove_file(root.join("broken")).unwrap();
        session.build(root, &model, &a, BuildOptions::default(), None, &cancel).unwrap();
        assert!(calls(root)[4].contains("-pl a -am compile"), "{:?}", calls(root));
    }

    #[test]
    fn only_incremental_launches_of_the_same_reactor_and_scope_join_a_build() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let model = reactor_fixture(root);
        let waiting = Waiting::default();
        let lead = waiting.add(root.join("a"), false, BuildPolicy::Automatic);
        let _guards = [
            waiting.add(root.join("b"), false, BuildPolicy::Make),
            waiting.add(root.join("lib"), false, BuildPolicy::Automatic),
            waiting.add(root.join("b"), false, BuildPolicy::Automatic),
            waiting.add(root.join("a"), false, BuildPolicy::Automatic),
            waiting.add(root.join("lib"), true, BuildPolicy::Automatic),
            waiting.add(root.join("lib"), false, BuildPolicy::Rebuild),
            waiting.add(root.join("lib"), false, BuildPolicy::MakeAndContinueOnErrors),
            waiting.add(root.join("lib"), false, BuildPolicy::NoBuild),
            waiting.add(root.join("other"), false, BuildPolicy::Automatic),
        ];
        let join = |prefer_maven| {
            super::super::joining_launches(
                root,
                &root.join("cache"),
                &model,
                &root.join("a"),
                false,
                lead.others(),
                prefer_maven,
            )
            .into_iter()
            .map(|l| l.module.strip_prefix(root).unwrap().to_path_buf())
            .collect::<Vec<_>>()
        };
        assert_eq!(join(true), [PathBuf::from("b"), PathBuf::from("lib")]);
        // Without "Delegate to Maven", these Java-only modules build with the language server.
        assert!(join(false).is_empty());
        drop(_guards);
        assert!(lead.others().is_empty());
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
    fn jdt_errors_reuse_an_unchanged_snapshot_and_rebuild_only_on_a_cache_miss() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let model = fixture(root);
        let cancel = CancellationToken::new();
        let mut session = Session::new(root.join("cache"));
        let first = session.build(root, &model, root, BuildOptions::default(), None, &cancel).unwrap();
        assert!(!first.authoritative);

        let reused = session
            .build(
                root,
                &model,
                root,
                BuildOptions { rebuild_on_jdt_errors: true, ..Default::default() },
                None,
                &cancel,
            )
            .unwrap();
        assert_eq!(reused.snapshot, first.snapshot);
        assert!(reused.authoritative);
        assert_eq!(fs::read_to_string(root.join("calls")).unwrap().lines().count(), 1);

        fs::write(root.join("src/main/kotlin/Main.kt"), "updated").unwrap();
        let rebuilt = session
            .build(
                root,
                &model,
                root,
                BuildOptions { rebuild_on_jdt_errors: true, ..Default::default() },
                None,
                &cancel,
            )
            .unwrap();
        assert_ne!(rebuilt.snapshot, first.snapshot);
        assert!(rebuilt.authoritative);
        let calls = fs::read_to_string(root.join("calls")).unwrap();
        assert_eq!(calls.lines().count(), 2);
        assert!(calls.lines().last().unwrap().contains("clean"));
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
        let outputs = Outputs {
            fingerprint: None,
            snapshot: retained.clone(),
            originals: Vec::new(),
            failure: None,
            authoritative: false,
        };
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
