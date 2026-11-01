//! Ruby interpreters: the ones a version manager installed (rbenv, rvm, chruby,
//! mise, asdf), Homebrew's, and the ones on `PATH`; the project's `.ruby-version`;
//! and the interpreter's standard library and Bundler gems for External Libraries.

use crate::discover::{par_map, subdirs};
use crate::exec::{executables_in, query, query_in, search_path};
use crate::{Sdk, exe, home_dir, pinned};
use ide_core::version_managers::{self, Tool};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

const VERSION_TIMEOUT: Duration = Duration::from_secs(4);
const QUERY_TIMEOUT: Duration = Duration::from_secs(20);

fn var_path(key: &str) -> Option<PathBuf> {
    ide_core::process::host_var_os(key).filter(|v| !v.is_empty()).map(PathBuf::from)
}

/// Where version managers keep one directory per Ruby, with the manager's name.
fn manager_roots() -> Vec<(PathBuf, &'static str)> {
    let mut out = Vec::new();
    let Some(home) = home_dir() else { return out };
    out.push((var_path("RBENV_ROOT").unwrap_or_else(|| home.join(".rbenv")).join("versions"), "rbenv"));
    out.push((var_path("rvm_path").unwrap_or_else(|| home.join(".rvm")).join("rubies"), "rvm"));
    out.push((PathBuf::from("/usr/local/rvm/rubies"), "rvm"));
    out.push((home.join(".rubies"), "chruby"));
    out.push((PathBuf::from("/opt/rubies"), "chruby"));
    out
}

/// `bin/ruby` of a Ruby install directory.
pub(crate) fn ruby_in_install(dir: &Path) -> Option<PathBuf> {
    let p = dir.join("bin").join(exe("ruby"));
    p.is_file().then_some(p)
}

/// Installed Rubies: version-manager installs, Homebrew, then `PATH` (shims excluded).
pub(crate) fn detect(root: Option<&Path>) -> Vec<Sdk> {
    let mut found: Vec<(PathBuf, &'static str)> = Vec::new();
    for (dir, manager) in manager_roots() {
        found.extend(subdirs(&dir).into_iter().filter_map(|v| ruby_in_install(&v)).map(|p| (p, manager)));
    }
    for (dir, manager) in version_managers::installs(Tool::Ruby) {
        found.extend(ruby_in_install(&dir).map(|p| (p, manager)));
    }
    for brew in ["/opt/homebrew/opt/ruby", "/usr/local/opt/ruby", "/home/linuxbrew/.linuxbrew/opt/ruby"] {
        found.extend(ruby_in_install(Path::new(brew)).map(|p| (p, "homebrew")));
    }
    let dirs = std::env::split_paths(&search_path())
        .filter(|d| !is_shims_dir(d) && !version_managers::is_shims_dir(d))
        .collect::<Vec<_>>();
    found.extend(executables_in("ruby", dirs.into_iter()).into_iter().map(|p| (p, "system")));

    let mut seen = HashSet::new();
    let candidates: Vec<(PathBuf, &'static str)> = found
        .into_iter()
        .filter(|(p, _)| p.is_file() && seen.insert(p.canonicalize().unwrap_or_else(|_| p.clone())))
        .collect();
    let mut out = par_map(&candidates, |(path, source)| ruby_sdk(path, source));
    if let Some(root) = root
        && let Some(pinned) = pinned_ruby_version(root)
    {
        // The `.ruby-version` install first, like the project virtualenv for Python.
        if let Some(i) = out.iter().position(|s| version_matches(s.version.as_deref().unwrap_or(""), &pinned)) {
            let sdk = out.remove(i);
            out.insert(0, sdk);
        }
    }
    out
}

/// rbenv's and rvm's shim directories, which only forward to an install.
fn is_shims_dir(dir: &Path) -> bool {
    dir.ends_with(".rbenv/shims") || dir.ends_with(".rvm/bin")
}

/// `ruby 3.3.1 (2024-04-23 revision …) [arm64-darwin23]` → `3.3.1`.
pub(crate) fn parse_version(out: &str) -> Option<String> {
    out.strip_prefix("ruby ")?
        .split_whitespace()
        .next()
        .map(|v| v.trim_end_matches(|c: char| c.is_ascii_alphabetic() || c == '-').to_owned())
}

pub(crate) fn ruby_sdk(path: &Path, source: &str) -> Option<Sdk> {
    let version = query(path, &["--version"], VERSION_TIMEOUT).and_then(|v| parse_version(&v))?;
    let short = version.split('.').take(2).collect::<Vec<_>>().join(".");
    let name = match source {
        "system" => format!("Ruby {short}"),
        tool => format!("Ruby {short} ({tool})"),
    };
    Some(Sdk {
        path: path.into(),
        name,
        version: Some(version),
        source: source.to_owned(),
        home: path.parent().and_then(Path::parent).map(Path::to_path_buf).map(Into::into),
        extra: None,
    })
}

/// The version `.ruby-version` pins (rbenv / rvm / chruby read it; `ruby-3.3.1` → `3.3.1`),
/// from `root` up, else the mise / asdf pin.
pub fn pinned_ruby_version(root: &Path) -> Option<String> {
    let from_file = root.ancestors().find_map(|dir| {
        let text = std::fs::read_to_string(dir.join(".ruby-version")).ok()?;
        let v = text.lines().map(str::trim).find(|l| !l.is_empty() && !l.starts_with('#'))?;
        Some(v.strip_prefix("ruby-").unwrap_or(v).to_owned())
    });
    from_file.or_else(|| pinned::pinned_version(root, Tool::Ruby))
}

/// Whether `version` (`3.3.1`) satisfies a pin (`3.3.1`, `3.3`, `3`).
pub(crate) fn version_matches(version: &str, pin: &str) -> bool {
    version == pin || version.strip_prefix(pin).is_some_and(|rest| rest.starts_with('.'))
}

/// The Ruby for `root` without an explicit setting: the install matching
/// `.ruby-version` (version managers, then mise / asdf), else `ruby` on PATH.
pub fn project_ruby(root: &Path) -> Option<PathBuf> {
    if let Some(pin) = pinned_ruby_version(root) {
        let install = manager_roots()
            .into_iter()
            .flat_map(|(dir, _)| subdirs(&dir))
            .chain(version_managers::installs(Tool::Ruby).into_iter().map(|(d, _)| d))
            .find(|dir| {
                let name = dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                version_matches(name.strip_prefix("ruby-").unwrap_or(&name), &pin)
            });
        if let Some(ruby) = install.and_then(|d| ruby_in_install(&d)) {
            return Some(ruby);
        }
    }
    crate::exec::which("ruby")
}

/// `bin` directory of `ruby` and the gems it was installed with (`gem` and `bundle` next to it).
pub fn bin_dir_of(ruby: &Path) -> Option<PathBuf> {
    ruby.parent().map(Path::to_path_buf)
}

/// Standard-library / site directories (`ruby/3.3.0`) and the gems Bundler resolves
/// for `root` (`rails-7.1.3`), each as `(name, path)`.
pub fn library_roots(ruby: &Path, root: Option<&Path>) -> (Vec<(String, PathBuf)>, Vec<(String, PathBuf)>) {
    const PATHS: &str = "require 'rbconfig'; puts RbConfig::CONFIG['rubylibdir'], RbConfig::CONFIG['sitelibdir'], RbConfig::CONFIG['vendorlibdir']";
    let mut stdlib = Vec::new();
    let mut gems = Vec::new();
    let file_name = |p: &Path| p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    if let Some(text) = query(ruby, &["-e", PATHS], QUERY_TIMEOUT) {
        for line in text.lines().map(str::trim).filter(|l| !l.is_empty()) {
            let path = PathBuf::from(line);
            if path.is_dir() && !stdlib.iter().any(|(_, p)| *p == path) {
                let parent = path.parent().map(file_name).unwrap_or_default();
                stdlib.push((format!("{parent}/{}", file_name(&path)), path));
            }
        }
    }
    if let Some(root) = root.filter(|r| r.join("Gemfile").is_file()) {
        let bin = bin_dir_of(ruby);
        let bundle = bin.as_ref().map(|b| b.join(exe("bundle"))).filter(|b| b.is_file());
        let path = bin.as_ref().map(|b| crate::exec::path_with(&[b.as_path()])).unwrap_or_default();
        let env: &[(&str, &str)] = &[("PATH", &path)];
        let text = match &bundle {
            Some(b) => query_in(b, &["list", "--paths"], Some(root), env, QUERY_TIMEOUT),
            None => query_in(ruby, &["-S", "bundle", "list", "--paths"], Some(root), env, QUERY_TIMEOUT),
        };
        for line in text.unwrap_or_default().lines().map(str::trim).filter(|l| !l.is_empty()) {
            let path = PathBuf::from(line);
            if path.is_dir() && !path.starts_with(root) {
                gems.push((file_name(&path), path));
            }
        }
    }
    (stdlib, gems)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ruby_version_output() {
        assert_eq!(
            parse_version("ruby 3.3.1 (2024-04-23 revision c56cd86388) [arm64-darwin23]").as_deref(),
            Some("3.3.1")
        );
        assert_eq!(parse_version("ruby 3.4.0dev (2024-10-01) +PRISM [x86_64-linux]").as_deref(), Some("3.4.0"));
        assert_eq!(parse_version("jruby 9.4.5.0"), None);
    }

    #[test]
    fn version_pins_match_prefixes() {
        assert!(version_matches("3.3.1", "3.3.1"));
        assert!(version_matches("3.3.1", "3.3"));
        assert!(!version_matches("3.31.1", "3.3"));
        assert!(!version_matches("3.3.1", "3.3.10"));
    }

    #[test]
    fn ruby_version_file_wins_over_managers() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("app/sub");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(dir.path().join("app/.ruby-version"), "ruby-3.2.2\n").unwrap();
        assert_eq!(pinned_ruby_version(&project).as_deref(), Some("3.2.2"));
    }
}
