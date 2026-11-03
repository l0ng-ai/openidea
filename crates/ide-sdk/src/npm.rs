//! Node-based language servers installed with npm: the package behind a command.

use std::collections::BTreeMap;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// `command` as given (a path) or found on `path`, npm shims included.
pub(crate) fn find_command(command: &str, path: &OsStr) -> Option<PathBuf> {
    let p = Path::new(command);
    if p.is_absolute() {
        return p.is_file().then(|| p.to_path_buf());
    }
    ide_core::process::find_executable(command, path)
}

/// The npm package an executable comes from: next to a `node_modules/.bin` shim
/// (the IDE's tools dir, a project), a Windows global shim (`%APPDATA%\npm`), a
/// Unix global `<prefix>/bin`, a symlink into the package, Volta's package image
/// or the package a shim script runs (pnpm).
pub(crate) fn package_dir(bin: &Path, package: &str) -> Option<PathBuf> {
    let dir = bin.parent()?;
    let mut candidates = vec![dir.join("node_modules").join(package)];
    if dir.file_name() == Some(OsStr::new(".bin"))
        && let Some(node_modules) = dir.parent()
    {
        candidates.push(node_modules.join(package));
    }
    if let Ok(real) = dunce::canonicalize(bin) {
        candidates.extend(real.ancestors().filter(|a| a.ends_with(package)).map(Path::to_path_buf));
    }
    if let Some(prefix) = dir.parent() {
        candidates.push(prefix.join("lib").join("node_modules").join(package));
        // Volta: `<home>/bin/<command>` runs `<home>/tools/image/packages/<package>`.
        let image = prefix.join("tools").join("image").join("packages").join(package);
        candidates.push(image.join("lib").join("node_modules").join(package));
        candidates.push(image.join("node_modules").join(package));
    }
    let installed = |c: &PathBuf| c.join("package.json").is_file();
    candidates.into_iter().find(installed).or_else(|| script_targets(bin, package).into_iter().find(installed))
}

/// How shim scripts name their own directory: sh and PowerShell `$basedir` (pnpm
/// 11's sh shims also `$basedir_abs` and `$basedir_win`), cmd `%~dp0` (pnpm's
/// `%dp0%` is set from it).
const SCRIPT_DIR: [&str; 8] =
    ["${basedir}", "$basedir", "${basedir_abs}", "$basedir_abs", "${basedir_win}", "$basedir_win", "%~dp0", "%dp0%"];

/// `path` after the [`SCRIPT_DIR`] it starts with. sh reads `$basedir_abs` as one
/// name, not as `$basedir` followed by `_abs`.
fn after_script_dir(path: &str) -> Option<&str> {
    SCRIPT_DIR.iter().find_map(|d| {
        let rest = path.strip_prefix(d)?;
        let longer_name = d.starts_with('$')
            && !d.ends_with('}')
            && rest.starts_with(|c: char| c == '_' || c.is_ascii_alphanumeric());
        (!longer_name).then_some(rest)
    })
}

/// The `package` directories a shim script runs from: relative to the script's
/// directory, e.g. pnpm's `"$basedir/../global/v11/<hash>/node_modules/<package>/bin/<command>"`
/// or `"%~dp0\..\global\..."`, or absolute.
fn script_targets(bin: &Path, package: &str) -> Vec<PathBuf> {
    const MAX_SCRIPT: u64 = 64 * 1024;
    if std::fs::metadata(bin).map_or(true, |m| m.len() > MAX_SCRIPT) {
        return Vec::new();
    }
    let Ok(bytes) = std::fs::read(bin) else { return Vec::new() };
    let text = String::from_utf8_lossy(&bytes).replace('\\', "/");
    let bases: Vec<PathBuf> = [
        bin.parent().map(Path::to_path_buf),
        dunce::canonicalize(bin).ok().and_then(|r| r.parent().map(Path::to_path_buf)),
    ]
    .into_iter()
    .flatten()
    .collect();
    let needle = format!("node_modules/{package}");
    // What sh and cmd split words on; a folder name may contain a no-break space.
    let separator = |c: char| c == '"' || c == '\'' || c.is_ascii_whitespace();
    let mut targets = Vec::new();
    for (at, _) in text.match_indices(&needle) {
        let end = at + needle.len();
        if !text[end..].chars().next().is_none_or(|c| c == '/' || separator(c)) {
            continue;
        }
        // Within quotes the path starts at the opening one and may contain spaces.
        let line = text[..at].rfind('\n').map_or(0, |i| i + 1);
        let start = match ['"', '\''].into_iter().find(|q| text[line..at].matches(*q).count() % 2 == 1) {
            Some(quote) => text[..at].rfind(quote),
            None => text[..at].rfind(separator),
        }
        .map_or(0, |i| i + 1);
        let path = &text[start..end];
        // `"$basedir"/../...`: the directory quoted on its own.
        let after_dir = text[..start]
            .strip_suffix(['"', '\''])
            .is_some_and(|before| SCRIPT_DIR.iter().any(|d| before.ends_with(d)));
        match after_script_dir(path).or(after_dir.then_some(path)) {
            Some(rest) => targets.extend(bases.iter().map(|b| b.join(rest.trim_start_matches('/')))),
            None if Path::new(path).is_absolute() => targets.push(PathBuf::from(path)),
            // `$HOME/...`, `%APPDATA%\...` or relative to wherever the script runs.
            None => {}
        }
    }
    targets.into_iter().map(|t| dunce::canonicalize(&t).unwrap_or(t)).collect()
}

/// For a version manager's shim (`~/.asdf/shims`, mise's `shims`), which names
/// only the command: `package` in the global `node_modules` of the manager's
/// npm shim, run as the server is (in `cwd`, with its `env` and `path`), so the
/// manager picks the same Node. The shims go first on `path`, as the manager's
/// shell setup puts them: npm (`#!/usr/bin/env node`) then runs on the manager's
/// Node, not on a system one earlier on `path` that has another global root.
pub(crate) fn shim_package(
    bin: &Path,
    package: &str,
    path: &OsStr,
    cwd: &Path,
    env: &BTreeMap<String, String>,
) -> Option<PathBuf> {
    let shims = bin.parent()?;
    if shims.file_name() != Some(OsStr::new("shims")) {
        return None;
    }
    // Only the npm shim next to it: any other npm may be another installation's.
    let exts: &[&str] = if cfg!(windows) { &[".cmd", ".exe"] } else { &[""] };
    let npm = exts.iter().map(|e| shims.join(format!("npm{e}"))).find(|p| p.is_file())?;
    let path = std::env::join_paths(std::iter::once(shims.to_path_buf()).chain(std::env::split_paths(path))).ok()?;
    // The login shell's variables (`ASDF_DATA_DIR`, `MISE_ENV`...) under the server's own.
    let shell_env: Vec<_> = ide_core::process::shell_env().collect();
    let mut env: Vec<(&str, &str)> = shell_env
        .iter()
        .filter_map(|(k, v)| Some((k.to_str()?, v.to_str()?)))
        .chain(env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
        .collect();
    env.push(("PATH", path.to_str()?));
    let root = crate::exec::query_in(&npm, &["root", "-g"], Some(cwd), &env, Duration::from_secs(10))?;
    let dir = PathBuf::from(root.lines().last()?.trim()).join(package);
    dir.join("package.json").is_file().then_some(dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    const PACKAGE: &str = "@angular/language-server";

    /// `<dir>/bin/ngserver` running `script`.
    fn shim(dir: &Path, script: &str) -> PathBuf {
        std::fs::create_dir_all(dir.join("bin")).unwrap();
        let shim = dir.join("bin/ngserver");
        std::fs::write(&shim, script).unwrap();
        shim
    }

    /// The package installed in `<dir>/node_modules`.
    fn install(dir: &Path) -> PathBuf {
        let package = dir.join("node_modules").join(PACKAGE);
        std::fs::create_dir_all(&package).unwrap();
        std::fs::write(package.join("package.json"), "{}").unwrap();
        dunce::canonicalize(package).unwrap()
    }

    #[test]
    fn shim_scripts_name_the_package_relative_to_their_directory() {
        let tmp = tempfile::tempdir().unwrap();
        let package = install(&tmp.path().join("global/v11/abc"));
        for script in [
            "#!/bin/sh\nexec node \"$basedir/../global/v11/abc/node_modules/@angular/language-server/bin/ngserver\" \"$@\"\n",
            "#!/bin/sh\nexec node \"${basedir}/../global/v11/abc/node_modules/@angular/language-server/bin/ngserver\" \"$@\"\n",
            "#!/bin/sh\nexec node \"$basedir\"/../global/v11/abc/node_modules/@angular/language-server/bin/ngserver \"$@\"\n",
            // pnpm 11.
            "#!/bin/sh\nexec \"$basedir/node\"  \"$basedir_abs/../global/v11/abc/node_modules/@angular/language-server/bin/ngserver\" \"$@\"\n",
            "#!/bin/sh\nexec node \"${basedir_abs}/../global/v11/abc/node_modules/@angular/language-server/bin/ngserver\" \"$@\"\n",
            "#!/bin/sh\nexec node.exe \"$basedir_win/../global/v11/abc/node_modules/@angular/language-server/bin/ngserver\" \"$@\"\n",
            "@\"%~dp0\\..\\global\\v11\\abc\\node_modules\\@angular\\language-server\\bin\\ngserver\" %*\r\n",
            "@\"%~dp0..\\global\\v11\\abc\\node_modules\\@angular\\language-server\\bin\\ngserver\" %*\r\n",
            "@SET dp0=%~dp0\r\n\"%dp0%\\..\\global\\v11\\abc\\node_modules\\@angular\\language-server\\bin\\ngserver\" %*\r\n",
        ] {
            assert_eq!(package_dir(&shim(tmp.path(), script), PACKAGE), Some(package.clone()), "{script}");
        }
    }

    #[test]
    fn quoted_shim_targets_keep_their_spaces() {
        let tmp = tempfile::tempdir().unwrap();
        let package = install(&tmp.path().join("Global Packages/abc"));
        let absolute = package.display().to_string();
        for script in [
            "#!/bin/sh\nexec node \"$basedir/../Global Packages/abc/node_modules/@angular/language-server/bin/ngserver\" \"$@\"\n"
                .to_owned(),
            "@\"%~dp0\\..\\Global Packages\\abc\\node_modules\\@angular\\language-server\\bin\\ngserver\" %*\r\n".to_owned(),
            format!("#!/bin/sh\nexec node \"{absolute}/bin/ngserver\" \"$@\"\n"),
            format!("#!/bin/sh\nexec node '{absolute}/bin/ngserver' \"$@\"\n"),
        ] {
            assert_eq!(package_dir(&shim(tmp.path(), &script), PACKAGE), Some(package.clone()), "{script}");
        }
    }

    #[test]
    fn shim_scripts_with_an_absolute_path_and_non_ascii_spaces() {
        let tmp = tempfile::tempdir().unwrap();
        let package = install(&tmp.path().join("山田\u{3000}太郎\u{a0}x"));
        let script = format!("#!/bin/sh\nexec node \"{}/bin/ngserver\" \"$@\"\n", package.display());
        assert_eq!(package_dir(&shim(tmp.path(), &script), PACKAGE), Some(package));
    }

    #[test]
    fn shim_scripts_skip_other_packages_and_other_directories() {
        let tmp = tempfile::tempdir().unwrap();
        install(&tmp.path().join("home"));
        for script in [
            "exec node \"$basedir/../home/node_modules/@angular/language-server-next/bin/ngserver\"\n",
            "exec node \"$HOME/node_modules/@angular/language-server/bin/ngserver\"\n",
            "exec node \"$basedirx/../home/node_modules/@angular/language-server/bin/ngserver\"\n",
            "exec node ../home/node_modules/@angular/language-server/bin/ngserver\n",
        ] {
            assert_eq!(script_targets(&shim(tmp.path(), script), PACKAGE), Vec::<PathBuf>::new(), "{script}");
        }
        let large = format!(
            "{}\n\"$basedir/../home/node_modules/@angular/language-server/bin/ngserver\"\n",
            "#".repeat(64 * 1024)
        );
        assert_eq!(script_targets(&shim(tmp.path(), &large), PACKAGE), Vec::<PathBuf>::new());
    }
}
