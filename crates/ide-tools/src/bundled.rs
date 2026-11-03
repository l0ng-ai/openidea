//! Versioned app-owned plugin jars, shared by tool detection and language-server launches.

use crate::{Method, ToolSpec};
use std::path::{Path, PathBuf};

pub(crate) fn install(root: &Path, spec: &ToolSpec) -> std::io::Result<PathBuf> {
    let Method::Bundled { filename, bytes, .. } = spec.method else { unreachable!("bundled tool") };
    let dir = root.join(spec.name).join("bin");
    // The agent path participates in the JDT LS workspace key: upgrades must
    // discard incremental state compiled with the previous agent.
    let path = dir.join(filename);
    if std::fs::read(&path).is_ok_and(|old| old == bytes) {
        return Ok(path);
    }
    std::fs::create_dir_all(&dir)?;
    let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos();
    let temporary = dir.join(format!(".{filename}-{}-{nonce}.tmp", std::process::id()));
    let result = std::fs::write(&temporary, bytes).and_then(|_| std::fs::rename(&temporary, &path));
    if let Err(error) = result {
        let _ = std::fs::remove_file(&temporary);
        // Another window may have installed the same bytes concurrently.
        if !std::fs::read(&path).is_ok_and(|old| old == bytes) {
            tracing::warn!(tool = spec.name, %error, "Bundled plugin unavailable");
            return Err(error);
        }
    }
    Ok(path)
}
