//! `workspace/didChangeWatchedFiles` registrations: which changes on disk a
//! server asked to hear of (its globs, relative patterns and change kinds).

use crate::uri;
use globset::{GlobBuilder, GlobMatcher};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// `FileChangeType`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Change {
    Created = 1,
    Changed = 2,
    Deleted = 3,
}

impl Change {
    /// The `WatchKind` bit.
    fn kind_bit(self) -> u64 {
        match self {
            Self::Created => 1,
            Self::Changed => 2,
            Self::Deleted => 4,
        }
    }
}

struct Watcher {
    /// Relative pattern's base; `None` for a plain glob, matched below the server's root.
    base: Option<PathBuf>,
    /// A plain glob that is an absolute path pattern.
    absolute: bool,
    glob: GlobMatcher,
    kind: u64,
}

/// A server's registrations, by registration id.
#[derive(Default)]
pub struct FileWatchers(BTreeMap<String, Vec<Watcher>>);

impl FileWatchers {
    pub fn register(&mut self, id: &str, options: Option<&Value>) {
        let watchers = options
            .and_then(|o| o.get("watchers"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(parse)
            .collect();
        self.0.insert(id.to_owned(), watchers);
    }

    pub fn unregister(&mut self, id: &str) {
        self.0.remove(id);
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// Whether a server rooted at `root` wants to hear of `change` to `path`.
    pub fn wants(&self, root: &Path, path: &Path, change: Change) -> bool {
        self.0.values().flatten().any(|w| {
            if w.kind & change.kind_bit() == 0 {
                return false;
            }
            match &w.base {
                Some(base) => path.strip_prefix(base).is_ok_and(|rel| w.glob.is_match(rel)),
                None if w.absolute => w.glob.is_match(path),
                None => path.strip_prefix(root).is_ok_and(|rel| w.glob.is_match(rel)),
            }
        })
    }

    /// Bases of relative patterns, which may lie outside the project (a virtualenv's
    /// `site-packages`, a path dependency): the client watches them for the server.
    pub fn bases(&self) -> impl Iterator<Item = &Path> {
        self.0.values().flatten().filter_map(|w| w.base.as_deref())
    }
}

fn parse(watcher: &Value) -> Option<Watcher> {
    let kind = watcher.get("kind").and_then(Value::as_u64).unwrap_or(7);
    let (base, pattern) = match watcher.get("globPattern")? {
        Value::String(p) => (None, p.as_str()),
        relative => {
            let base = relative.get("baseUri")?;
            // A `WorkspaceFolder` or a URI.
            let base = base.get("uri").unwrap_or(base).as_str()?;
            let base = uri::uri_to_path(base)?;
            // Changes are reported for canonical paths (`/tmp` is `/private/tmp` on macOS).
            (Some(dunce::canonicalize(&base).unwrap_or(base)), relative.get("pattern")?.as_str()?)
        }
    };
    let glob = GlobBuilder::new(pattern).literal_separator(true).build().ok()?.compile_matcher();
    let absolute = base.is_none() && Path::new(pattern).is_absolute();
    Some(Watcher { base, absolute, glob, kind })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn watchers(list: Value) -> FileWatchers {
        let mut w = FileWatchers::default();
        w.register("1", Some(&json!({ "watchers": list })));
        w
    }

    #[test]
    fn matches_globs_relative_patterns_and_kinds() {
        let root = Path::new("/p");
        let venv = uri::path_to_uri(Path::new("/opt/venv/lib/site-packages"));
        let w = watchers(json!([
            { "globPattern": "**/*.{go,mod,sum}" },
            { "globPattern": "**/pyrightconfig.json", "kind": 2 },
            { "globPattern": { "baseUri": venv, "pattern": "**" } },
            { "globPattern": { "baseUri": { "uri": uri::path_to_uri(Path::new("/shared")), "name": "s" }, "pattern": "*.toml" } },
        ]));
        let cases = [
            ("/p/go.mod", Change::Changed, true),
            ("/p/sub/main.go", Change::Created, true),
            ("/elsewhere/main.go", Change::Created, false),
            ("/p/pyrightconfig.json", Change::Changed, true),
            ("/p/pyrightconfig.json", Change::Created, false),
            ("/opt/venv/lib/site-packages/idna/__init__.py", Change::Created, true),
            ("/opt/venv/lib/site-packages", Change::Deleted, true),
            ("/shared/Cargo.toml", Change::Changed, true),
            ("/shared/nested/Cargo.toml", Change::Changed, false),
            ("/p/readme.md", Change::Changed, false),
        ];
        for (path, change, expected) in cases {
            assert_eq!(w.wants(root, Path::new(path), change), expected, "{path} {change:?}");
        }
        let mut bases: Vec<_> = w.bases().collect();
        bases.sort();
        assert_eq!(bases, [Path::new("/opt/venv/lib/site-packages"), Path::new("/shared")]);
    }

    #[test]
    fn unregistering_drops_the_watchers() {
        let mut w = watchers(json!([{ "globPattern": "**" }]));
        assert!(w.wants(Path::new("/p"), Path::new("/p/a"), Change::Created));
        w.unregister("1");
        assert!(w.is_empty());
        assert!(!w.wants(Path::new("/p"), Path::new("/p/a"), Change::Created));
    }
}
