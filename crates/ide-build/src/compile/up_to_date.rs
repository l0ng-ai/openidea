//! Up-to-date checks for menu builds (`Build Project` / `Build Module`, #2476).
//!
//! Menu builds have no fingerprint record on the launch path, so a second
//! click always pays a full offline Maven run. This module stores one JSON
//! record per scope (project, or one module file's build) after a successful
//! build and compares it before the next build; on a match the build is
//! skipped entirely. Like launch reuse, timestamp-preserving external edits
//! are re-stamped first so Maven actually recompiles them on the next run.

use super::*;
use std::fs;

/// Record of the last successful menu build of one scope.
#[derive(serde::Serialize, serde::Deserialize)]
struct Record {
    fingerprint: LaunchFingerprint,
}

fn record_path(cache: &Path, root: &Path, file: Option<&Path>) -> PathBuf {
    let base = cache.join("menu-build").join("records");
    match file {
        Some(f) => base.join(f.strip_prefix(root).unwrap_or(f)).with_extension("json"),
        None => base.join("project.json"),
    }
}

/// Re-stamps files whose content changed without advancing mtime (git
/// checkout, external sync): timestamp-incremental Maven would otherwise skip
/// them as "unchanged" and the rebuild would compile nothing.
fn restamp(root: &Path, edits: &[PathBuf]) {
    let now = std::time::SystemTime::now();
    for rel in edits {
        let path = root.join(rel);
        let _ = fs::File::options().write(true).open(&path).and_then(|f| f.set_modified(now)).or_else(|_| {
            fs::OpenOptions::new()
                .create(true)
                .truncate(false)
                .write(true)
                .open(&path)
                .and_then(|f| f.set_modified(now))
        });
    }
}

/// Whether the last successful menu build of this scope is still fresh: its
/// record exists and the fingerprint matches. On a mismatch caused by
/// timestamp-preserving external edits the files are re-stamped first, so the
/// rebuild Maven runs actually recompiles them.
pub fn menu_up_to_date(
    cache: &Path,
    root: &Path,
    model: &BuildModel,
    file: Option<&Path>,
    cancel: &CancellationToken,
) -> bool {
    let current = match menu_fingerprint(root, model, file, cancel) {
        Ok(Some(current)) => current,
        _ => return false,
    };
    let bytes = match fs::read(record_path(cache, root, file)) {
        Ok(bytes) => bytes,
        _ => return false,
    };
    let record: Record = match serde_json::from_slice(&bytes) {
        Ok(record) => record,
        _ => return false,
    };
    if record.fingerprint != current {
        restamp(root, &record.fingerprint.mtime_preserved_edits(&current));
        return false;
    }
    true
}

/// Records a successful menu build as the baseline for future up-to-date
/// checks. Failures are swallowed: a missing record only costs one Maven run.
pub fn record_menu_build(
    cache: &Path,
    root: &Path,
    model: &BuildModel,
    file: Option<&Path>,
    cancel: &CancellationToken,
) {
    let current = match menu_fingerprint(root, model, file, cancel) {
        Ok(Some(current)) => current,
        _ => return,
    };
    // A torn write fails to parse later and is treated as "no record", so a
    // plain write is enough.
    let path = record_path(cache, root, file);
    if path.parent().is_some_and(|p| fs::create_dir_all(p).is_err()) {
        return;
    }
    let bytes = match serde_json::to_vec(&Record { fingerprint: current }) {
        Ok(bytes) => bytes,
        _ => return,
    };
    let _ = fs::write(&path, bytes);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(root: &Path, rel: &str, value: &str) {
        let path = root.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, value).unwrap();
    }

    fn fixture(root: &Path) -> BuildModel {
        maven_two_module(root, "int x;");
        BuildModel { maven: Some(maven::load(root)), ..Default::default() }
    }

    fn maven_two_module(root: &Path, extra_app: &str) {
        write(
            root,
            "pom.xml",
            r#"<project><modelVersion>4.0.0</modelVersion><groupId>t</groupId><artifactId>root</artifactId><version>1</version><packaging>pom</packaging><modules><module>app</module><module>lib</module></modules></project>"#,
        );
        write(
            root,
            "app/pom.xml",
            r#"<project><modelVersion>4.0.0</modelVersion><parent><groupId>t</groupId><artifactId>root</artifactId><version>1</version></parent><artifactId>app</artifactId><dependencies><dependency><groupId>t</groupId><artifactId>lib</artifactId><version>1</version></dependency></dependencies></project>"#,
        );
        write(
            root,
            "lib/pom.xml",
            r#"<project><modelVersion>4.0.0</modelVersion><parent><groupId>t</groupId><artifactId>root</artifactId><version>1</version></parent><artifactId>lib</artifactId></project>"#,
        );
        write(root, "app/src/main/java/t/A.java", &format!("package t; public class A {{ {extra_app} }}"));
        write(root, "lib/src/main/java/t/L.java", "package t; public class L {}");
    }

    #[test]
    fn record_then_skip_without_changes() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let model = fixture(root);
        let cache = root.join("cache");
        let file = root.join("app/src/main/java/t/A.java");
        let cancel = CancellationToken::new();

        assert!(!menu_up_to_date(&cache, root, &model, Some(&file), &cancel));
        record_menu_build(&cache, root, &model, Some(&file), &cancel);
        assert!(menu_up_to_date(&cache, root, &model, Some(&file), &cancel));
        // The project scope is independent of the module scope.
        assert!(!menu_up_to_date(&cache, root, &model, None, &cancel));
        record_menu_build(&cache, root, &model, None, &cancel);
        assert!(menu_up_to_date(&cache, root, &model, None, &cancel));
    }

    #[test]
    fn edit_invalidates_and_rerecord_restores_skip() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let model = fixture(root);
        let cache = root.join("cache");
        let file = root.join("app/src/main/java/t/A.java");
        let cancel = CancellationToken::new();

        record_menu_build(&cache, root, &model, Some(&file), &cancel);
        assert!(menu_up_to_date(&cache, root, &model, Some(&file), &cancel));
        write(root, "app/src/main/java/t/A.java", "package t; public class A { int y; }");
        assert!(!menu_up_to_date(&cache, root, &model, Some(&file), &cancel));
        record_menu_build(&cache, root, &model, Some(&file), &cancel);
        assert!(menu_up_to_date(&cache, root, &model, Some(&file), &cancel));
    }

    #[test]
    fn mtime_preserved_edit_forces_rebuild_and_restamps() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let model = fixture(root);
        let cache = root.join("cache");
        let rel = "app/src/main/java/t/A.java";
        let file = root.join(rel);
        let cancel = CancellationToken::new();

        record_menu_build(&cache, root, &model, Some(&file), &cancel);
        let before = fs::metadata(&file).unwrap().modified().unwrap();
        // Same length, same mtime, different content: an external edit that
        // preserved the timestamp.
        write(root, rel, "package t; public class A { int z; }");
        fs::File::options().write(true).open(&file).and_then(|f| f.set_modified(before)).unwrap();
        assert!(!menu_up_to_date(&cache, root, &model, Some(&file), &cancel));
        assert!(fs::metadata(&file).unwrap().modified().unwrap() > before);
    }

    #[test]
    fn corrupt_record_never_skips() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let model = fixture(root);
        let cache = root.join("cache");
        let file = root.join("app/src/main/java/t/A.java");
        let cancel = CancellationToken::new();

        fs::create_dir_all(cache.join("menu-build").join("records").join("app/src/main/java/t")).unwrap();
        fs::write(cache.join("menu-build").join("records").join("app/src/main/java/t/A.json"), b"{not json").unwrap();
        assert!(!menu_up_to_date(&cache, root, &model, Some(&file), &cancel));
    }

    #[test]
    fn unsupported_builds_never_skip() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let model = fixture(root);
        write(root, "other/Main.java", "public class Main {}");
        let cache = root.join("cache");
        let cancel = CancellationToken::new();

        // A file outside any non-aggregator module has no fingerprint.
        let stray = root.join("other/Main.java");
        record_menu_build(&cache, root, &model, Some(&stray), &cancel);
        assert!(!menu_up_to_date(&cache, root, &model, Some(&stray), &cancel));
    }
}
