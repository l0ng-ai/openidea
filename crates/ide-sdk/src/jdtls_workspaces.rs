//! jdtls workspaces (`<local data>/lsp/jdtls/<key>`) that no project uses any more.
//!
//! A workspace is keyed by the project folder and by the settings that need a clean import
//! (source paths, output folder, libraries, linked Gradle projects, unlinked Maven poms), so
//! each change of those, and each moved or deleted project, leaves the previous workspace
//! behind: 50–200 MB of imported model and indexes. Like a cache, one unused for a month is
//! removed at start-up; a project that comes back imports again.

use ide_language::LanguageServerConfig;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// Touched each time jdtls starts on a workspace.
const USED_MARKER: &str = ".openidea-last-used";
/// Workspaces being removed (renamed first, so a server never starts on a half-deleted one).
const TRASH_PREFIX: &str = ".removed-";
/// How long a workspace may go unused before start-up removes it.
pub const UNUSED_FOR: Duration = Duration::from_secs(30 * 24 * 60 * 60);

fn root(data_dir: &Path) -> PathBuf {
    data_dir.join("lsp").join("jdtls")
}

/// jdtls' temporary folder, inside its workspace.
const TEMP_DIR: &str = ".tmp";

fn workspace(cfg: &LanguageServerConfig) -> Option<&Path> {
    cfg.args.iter().position(|a| a == "-data").and_then(|i| cfg.args.get(i + 1)).map(Path::new)
}

/// jdtls' temporary folder for `workspace`: `<workspace>/.tmp`, or a folder of its own in the
/// system temporary folder when the workspace path has whitespace (macOS's `Application Support`).
/// Buildship writes its Gradle init script there and later splits the stored arguments at spaces,
/// so a path with a space reaches Gradle cut off and every Gradle import fails.
fn temp_dir(workspace: &Path) -> PathBuf {
    let own = workspace.join(TEMP_DIR);
    if !has_whitespace(&own) {
        return own;
    }
    // FNV-1a: stable across builds, so a workspace keeps its folder from one start to the next.
    let hash = workspace
        .to_string_lossy()
        .bytes()
        .fold(0xcbf2_9ce4_8422_2325_u64, |h, b| (h ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3));
    let shared = std::env::temp_dir().join(format!("openidea-jdtls-{hash:016x}"));
    if has_whitespace(&shared) { own } else { shared }
}

fn has_whitespace(path: &Path) -> bool {
    path.to_string_lossy().chars().any(char::is_whitespace)
}

fn temp_arg(workspace: &Path) -> String {
    format!("-Djava.io.tmpdir={}", temp_dir(workspace).to_string_lossy())
}

/// Gives jdtls a temporary folder of a workspace of ours ([`temp_dir`]) unless the
/// user's JVM arguments choose one. JDT APT copies a project's annotation processor jars into a
/// new `jdt-apt-*` folder for each processor class loader and deletes it only when the JVM exits
/// normally — never on Windows, where the jars are still open then — so in the system temp
/// folder they pile up with every start; [`mark_used`] empties this one before each start.
pub fn use_own_temp(cfg: &mut LanguageServerConfig, data_dir: &Path) {
    if cfg.name != "jdtls" || cfg.args.iter().any(|a| a.contains("-Djava.io.tmpdir=")) {
        return;
    }
    let Some(arg) = workspace(cfg).filter(|w| w.starts_with(root(data_dir))).map(temp_arg) else { return };
    // Launched directly, JVM options go before `-jar`; through the script, as `--jvm-arg=`.
    match cfg.args.iter().position(|a| a == "-jar") {
        Some(jar) => cfg.args.insert(jar, arg),
        None => cfg.args.push(format!("--jvm-arg={arg}")),
    }
}

/// Empties the temporary folder [`use_own_temp`] gave the workspace. Best effort: files a server
/// still has open on Windows stay until a later start.
fn clear_temp(cfg: &LanguageServerConfig, workspace: &Path) {
    let arg = temp_arg(workspace);
    if !cfg.args.iter().any(|a| a.strip_prefix("--jvm-arg=").unwrap_or(a) == arg) {
        return;
    }
    let temp = temp_dir(workspace);
    let legacy = workspace.join(TEMP_DIR);
    if temp != legacy {
        // Earlier versions kept the temporary files in the workspace whatever its path, and a
        // workspace in use is never removed as unused, so that folder would stay forever.
        match std::fs::remove_dir_all(&legacy) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
                tracing::debug!("jdtls: cannot remove the old temporary {}: {e}", legacy.display());
            }
            _ => {}
        }
    }
    for entry in std::fs::read_dir(&temp).into_iter().flatten().flatten() {
        let path = entry.path();
        let removed = if entry.file_type().is_ok_and(|t| t.is_dir()) {
            std::fs::remove_dir_all(&path)
        } else {
            std::fs::remove_file(&path)
        };
        if let Err(e) = removed {
            tracing::debug!("jdtls: cannot remove temporary {}: {e}", path.display());
        }
    }
    if let Err(e) = std::fs::create_dir_all(&temp) {
        tracing::warn!("jdtls: cannot create its temporary folder {}: {e}", temp.display());
    }
}

/// Records that jdtls is starting on the workspace of `cfg` (its `-data` folder), and empties
/// the workspace's temporary folder.
pub fn mark_used(cfg: &LanguageServerConfig) {
    let Some(dir) = workspace(cfg) else { return };
    clear_temp(cfg, dir);
    if let Err(e) = std::fs::create_dir_all(dir).and_then(|()| {
        let marker = std::fs::File::create(dir.join(USED_MARKER))?;
        marker.set_modified(SystemTime::now())
    }) {
        tracing::debug!("jdtls: cannot mark {} as used: {e}", dir.display());
    }
}

/// When a workspace was last used: the latest of our marker (written when jdtls starts) and what
/// jdtls itself touches while it runs and when it saves on exit (a server can run for weeks).
fn last_used(dir: &Path) -> Option<SystemTime> {
    let metadata = dir.join(".metadata");
    [
        dir.join(USED_MARKER),
        metadata.join(".log"),
        metadata.join(".plugins").join("org.eclipse.core.resources"),
        metadata,
    ]
    .into_iter()
    .filter_map(|p| std::fs::metadata(p).and_then(|m| m.modified()).ok())
    .max()
}

/// Moves the workspaces unused for longer than `max_age` aside, before any server starts, and
/// returns what [`remove`] deletes. Quick: only renames.
pub fn take_unused(data_dir: &Path, max_age: Duration) -> Vec<PathBuf> {
    let root = root(data_dir);
    let Ok(entries) = std::fs::read_dir(&root) else { return Vec::new() };
    let now = SystemTime::now();
    let mut taken = Vec::new();
    for entry in entries.flatten() {
        if !entry.file_type().is_ok_and(|t| t.is_dir()) {
            continue;
        }
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with(TRASH_PREFIX) {
            // Left by a start-up that quit before deleting it.
            taken.push(path);
            continue;
        }
        let unused = last_used(&path).and_then(|t| now.duration_since(t).ok()).is_some_and(|age| age > max_age);
        if !unused {
            continue;
        }
        let trash = root.join(format!("{TRASH_PREFIX}{name}"));
        match std::fs::rename(&path, &trash) {
            Ok(()) => taken.push(trash),
            Err(e) => tracing::debug!("jdtls: cannot move unused workspace {}: {e}", path.display()),
        }
    }
    taken
}

/// Deletes what [`take_unused`] moved aside; slow for large workspaces, so off the start-up path.
pub fn remove(taken: Vec<PathBuf>) {
    for dir in taken {
        match std::fs::remove_dir_all(&dir) {
            Ok(()) => tracing::info!("jdtls: removed unused workspace {}", dir.display()),
            Err(e) => tracing::warn!("jdtls: cannot remove unused workspace {}: {e}", dir.display()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn days_ago(days: u64) -> SystemTime {
        SystemTime::now() - Duration::from_secs(days * 24 * 60 * 60)
    }

    /// Back-dates a file, or (on Unix, where a folder opens as a file) a folder.
    fn age(path: &Path, days: u64) {
        let file =
            if path.is_dir() { std::fs::File::open(path) } else { std::fs::File::options().write(true).open(path) };
        file.unwrap().set_modified(days_ago(days)).unwrap();
    }

    fn cfg(data: &Path) -> LanguageServerConfig {
        let languages = ide_language::LanguageRegistry::load(None).unwrap();
        let mut cfg = languages.get(&ide_core::LanguageId::new("java")).unwrap().language_servers.remove(0);
        cfg.args = vec!["-data".into(), data.to_string_lossy().into_owned()];
        cfg
    }

    #[test]
    fn removes_workspaces_unused_for_longer_than_the_limit() {
        let tmp = tempfile::tempdir().unwrap();
        let root = root(tmp.path());
        let (old, recent) = (root.join("old"), root.join("recent"));
        mark_used(&cfg(&old));
        mark_used(&cfg(&recent));
        age(&old.join(USED_MARKER), 40);
        age(&recent.join(USED_MARKER), 5);
        std::fs::write(root.join("defaults.prefs"), "").unwrap();

        let taken = take_unused(tmp.path(), UNUSED_FOR);
        assert_eq!(taken.len(), 1, "{taken:?}");
        assert!(!old.exists() && recent.exists() && root.join("defaults.prefs").exists());
        remove(taken);
        let mut left: Vec<_> = std::fs::read_dir(&root).unwrap().map(|e| e.unwrap().file_name()).collect();
        left.sort();
        assert_eq!(left, ["defaults.prefs", "recent"]);
    }

    #[test]
    fn a_started_server_marks_its_workspace_again() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = root(tmp.path()).join("p");
        mark_used(&cfg(&ws));
        age(&ws.join(USED_MARKER), 40);
        mark_used(&cfg(&ws));
        assert!(take_unused(tmp.path(), UNUSED_FOR).is_empty());
        assert!(ws.exists());
    }

    #[test]
    fn jdtls_keeps_its_temporary_files_in_its_workspace_and_starts_with_none() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = root(tmp.path()).join("p");
        let temp = format!("-Djava.io.tmpdir={}", ws.join(TEMP_DIR).to_string_lossy());

        // Through the launcher script.
        let mut script = cfg(&ws);
        use_own_temp(&mut script, tmp.path());
        assert_eq!(script.args.last(), Some(&format!("--jvm-arg={temp}")));
        // Launched directly: a JVM option, before `-jar`.
        let mut direct = cfg(&ws);
        direct.args.splice(0..0, ["-Xmx2G".to_owned(), "-jar".to_owned(), "launcher.jar".to_owned()]);
        use_own_temp(&mut direct, tmp.path());
        assert_eq!(direct.args[..3], ["-Xmx2G".to_owned(), temp.clone(), "-jar".to_owned()]);

        let stale = ws.join(TEMP_DIR).join("jdt-apt-1");
        std::fs::create_dir_all(&stale).unwrap();
        std::fs::write(stale.join("0_processor.jar"), "").unwrap();
        std::fs::write(ws.join(TEMP_DIR).join("file.tmp"), "").unwrap();
        mark_used(&direct);
        assert!(ws.join(TEMP_DIR).is_dir());
        assert_eq!(std::fs::read_dir(ws.join(TEMP_DIR)).unwrap().count(), 0);

        // The user's own choice, and a workspace that is not ours, are left alone.
        let mut own = cfg(&ws);
        own.args.push("--jvm-arg=-Djava.io.tmpdir=/elsewhere".into());
        use_own_temp(&mut own, tmp.path());
        assert_eq!(own.args.iter().filter(|a| a.contains("java.io.tmpdir")).count(), 1);
        let mut theirs = cfg(&tmp.path().join("their-workspace"));
        use_own_temp(&mut theirs, tmp.path());
        assert!(!theirs.args.iter().any(|a| a.contains("java.io.tmpdir")));
        std::fs::create_dir_all(ws.join(TEMP_DIR).join("kept")).unwrap();
        mark_used(&cfg(&ws));
        assert!(ws.join(TEMP_DIR).join("kept").exists());
    }

    #[test]
    fn a_workspace_path_with_a_space_keeps_jdtls_temporary_files_out_of_it() {
        let tmp = tempfile::tempdir().unwrap();
        let data = tmp.path().join("Application Support");
        let ws = root(&data).join("p");
        let mut cfg = cfg(&ws);
        use_own_temp(&mut cfg, &data);
        let arg = cfg.args.last().unwrap().strip_prefix("--jvm-arg=-Djava.io.tmpdir=").unwrap().to_owned();
        assert!(!arg.contains(' '), "{arg}");
        assert!(Path::new(&arg).starts_with(std::env::temp_dir()));
        assert_eq!(temp_dir(&ws), temp_dir(&ws));
        assert_ne!(temp_dir(&ws), temp_dir(&root(&data).join("q")));

        std::fs::create_dir_all(Path::new(&arg).join("jdt-apt-1")).unwrap();
        // Left in the workspace by a version that kept the temporary files there.
        std::fs::create_dir_all(ws.join(TEMP_DIR).join("jdt-apt-0")).unwrap();
        std::fs::write(ws.join(TEMP_DIR).join("jdt-apt-0").join("0_processor.jar"), "").unwrap();
        mark_used(&cfg);
        assert_eq!(std::fs::read_dir(&arg).unwrap().count(), 0);
        assert!(!ws.join(TEMP_DIR).exists());
        std::fs::remove_dir_all(&arg).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_workspace_from_before_markers_is_judged_by_its_folders_and_log() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = root(tmp.path()).join("legacy");
        std::fs::create_dir_all(ws.join(".metadata")).unwrap();
        std::fs::write(ws.join(".metadata/.log"), "").unwrap();
        for p in [ws.join(".metadata/.log"), ws.join(".metadata")] {
            age(&p, 90);
        }
        assert_eq!(take_unused(tmp.path(), UNUSED_FOR).len(), 1);
        // The log alone being recent keeps it.
        let tmp = tempfile::tempdir().unwrap();
        let ws = root(tmp.path()).join("legacy");
        std::fs::create_dir_all(ws.join(".metadata")).unwrap();
        std::fs::write(ws.join(".metadata/.log"), "").unwrap();
        age(&ws.join(".metadata"), 90);
        assert!(take_unused(tmp.path(), UNUSED_FOR).is_empty());
    }

    #[test]
    fn leftovers_of_an_interrupted_removal_are_removed() {
        let tmp = tempfile::tempdir().unwrap();
        let trash = root(tmp.path()).join(format!("{TRASH_PREFIX}gone"));
        std::fs::create_dir_all(trash.join(".metadata")).unwrap();
        let taken = take_unused(tmp.path(), UNUSED_FOR);
        assert_eq!(taken, std::slice::from_ref(&trash));
        remove(taken);
        assert!(!trash.exists());
    }
}
