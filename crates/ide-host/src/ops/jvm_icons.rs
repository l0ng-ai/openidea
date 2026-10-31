//! Bounded, read-only JVM presentation for visible files, also served remotely.
use crate::Host;
use ide_core::{CancellationToken, IdeError, IdeResult, LanguageId};
use ide_syntax::{JvmPresentation, Snapshot};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::{
    collections::HashMap,
    fs::File,
    io::Read,
    path::PathBuf,
    sync::{Mutex, OnceLock},
    time::SystemTime,
};

pub const PREFIX_BYTES: u64 = 64 * 1024;
const MAX_BATCH: usize = 64;
const MAX_CACHE: usize = 4096;

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct JvmFilePresentation {
    pub path: PathBuf,
    pub presentation: JvmPresentation,
}

#[derive(Clone)]
struct Cached {
    modified: SystemTime,
    size: u64,
    presentation: JvmPresentation,
}

fn prefix(path: &PathBuf) -> std::io::Result<String> {
    let mut bytes = Vec::new();
    File::open(path)?.take(PREFIX_BYTES).read_to_end(&mut bytes)?;
    // A truncated final UTF-8 character must not invalidate the entire prefix.
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

pub async fn jvm_file_presentations(
    host: &Host,
    window: &str,
    paths: Vec<PathBuf>,
) -> IdeResult<Vec<JvmFilePresentation>> {
    if paths.len() > MAX_BATCH {
        return Err(IdeError::invalid("at most 64 JVM files per batch"));
    }
    let project = host.project(window)?;
    host.blocking(move || {
        static CACHE: OnceLock<Mutex<HashMap<PathBuf, Cached>>> = OnceLock::new();
        let cache = CACHE.get_or_init(Default::default);
        let mut results = Vec::new();
        for path in paths {
            let language = match path.extension().and_then(|e| e.to_str()) {
                Some("java") => LanguageId::new("java"),
                Some("kt") => LanguageId::new("kotlin"),
                _ => continue,
            };
            let Ok(meta) = path.metadata() else { continue };
            if !meta.is_file() {
                continue;
            }
            let Ok(modified) = meta.modified() else { continue };
            let hit =
                cache.lock().unwrap().get(&path).filter(|c| c.modified == modified && c.size == meta.len()).cloned();
            let presentation = if let Some(hit) = hit {
                hit.presentation
            } else {
                let Ok(source) = prefix(&path) else { continue };
                let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or_default();
                let presentation = project.structure.jvm_presentation(
                    &Snapshot::text(&language, &source),
                    stem,
                    &CancellationToken::new(),
                )?;
                let mut cache = cache.lock().unwrap();
                if cache.len() >= MAX_CACHE {
                    cache.clear();
                }
                cache.insert(path.clone(), Cached { modified, size: meta.len(), presentation: presentation.clone() });
                presentation
            };
            results.push(JvmFilePresentation { path, presentation });
        }
        Ok(results)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn huge_files_read_only_a_prefix() {
        let path = std::env::temp_dir().join(format!("openidea-icon-prefix-{}.java", std::process::id()));
        let file = File::create(&path).unwrap();
        file.set_len(100 * 1024 * 1024).unwrap();
        assert_eq!(prefix(&path).unwrap().len(), PREFIX_BYTES as usize);
        std::fs::remove_file(path).unwrap();
    }
}
