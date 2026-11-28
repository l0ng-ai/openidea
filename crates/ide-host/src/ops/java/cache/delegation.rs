//! Build ownership is independent of whether a launch snapshot can be reused.
use super::{record_path, write_record};
use ide_build::{BuildModel, compile};
use ide_core::IdeResult;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize)]
struct State {
    /// External outputs may contain classes that JDT cannot remove after the final
    /// Kotlin/Groovy/Scala source is deleted. Only a successful clean clears this.
    needs_cleanup: bool,
}

fn state_path(root: &Path, cache: &Path, module: &Path, test: bool) -> Option<PathBuf> {
    Some(cache.join("java-launch/delegation").join(module.strip_prefix(root).ok()?).join(if test {
        "test.json"
    } else {
        "main.json"
    }))
}

/// A test launch also uses main outputs; a main launch does not use test outputs.
pub(super) fn required(root: &Path, cache: &Path, model: &BuildModel, module: &Path, test: bool) -> bool {
    mode_required(root, cache, model, module, false) || (test && mode_required(root, cache, model, module, true))
}

fn mode_required(root: &Path, cache: &Path, model: &BuildModel, module: &Path, test: bool) -> bool {
    let Some(state) = state_path(root, cache, module, test) else { return false };
    match fs::read(&state) {
        Ok(bytes) => {
            // A damaged ownership marker must not silently abandon pending cleanup.
            return serde_json::from_slice::<State>(&bytes).map_or(true, |state| state.needs_cleanup);
        }
        Err(e) if e.kind() == ErrorKind::NotFound => {}
        Err(_) => return true,
    }
    let Some(record) = record_path(root, cache, module, test).filter(|p| p.is_file()) else { return false };
    let Some(maven) = &model.maven else { return false };
    // Old records (including `null`) did not record why Maven owned the outputs.
    // If outputs remain, clean once rather than guessing that they are all Java.
    // Persist even a negative migration: subsequent JDT output must not turn an
    // already ignored legacy record back into a reason to delegate.
    let needs_cleanup = compile::maven_launch_output_dirs(root, maven, module, test).iter().any(|dir| dir.is_dir());
    let publish = || -> std::io::Result<()> {
        fs::create_dir_all(state.parent().unwrap())?;
        let mut file = tempfile::NamedTempFile::new_in(state.parent().unwrap())?;
        serde_json::to_writer(file.as_file_mut(), &State { needs_cleanup })?;
        // Another launch may already have migrated or started building this mode.
        file.persist_noclobber(&state).map_err(|e| e.error)?;
        Ok(())
    };
    match publish() {
        Ok(()) => needs_cleanup,
        Err(e) if e.kind() == ErrorKind::AlreadyExists => mode_required(root, cache, model, module, test),
        Err(error) => {
            tracing::warn!(%error, path = %record.display(), "Cannot migrate Java launch delegation state");
            needs_cleanup
        }
    }
}

/// Called before invalidating a snapshot or running an external build. A plain
/// Java failure records `false`; it must not override a later delegateBuild=false.
pub(super) fn remember(root: &Path, cache: &Path, module: &Path, test: bool, needs_cleanup: bool) -> IdeResult<()> {
    if let Some(path) = state_path(root, cache, module, test) {
        write_record(&path, &State { needs_cleanup })?;
    }
    Ok(())
}

pub(super) fn cleaned(root: &Path, cache: &Path, module: &Path, test: bool, mixed: bool) -> IdeResult<()> {
    remember(root, cache, module, test, mixed)?;
    if test && !mixed {
        // A clean test build includes the main outputs and their reactor dependencies.
        remember(root, cache, module, false, false)?;
    }
    Ok(())
}
