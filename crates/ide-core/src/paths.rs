//! Import-specifier resolution for the project semantic index (see
//! `docs/vue-ts-semantic-index.md`): a relative specifier is completed
//! against the file system, a tsconfig path alias against its `paths`
//! mapping; bare specifiers (`vue`, `lodash`) name packages and stay
//! unresolved — node_modules is the language servers' territory.

use std::path::{Path, PathBuf};

/// The `compilerOptions.paths` + `baseUrl` of a tsconfig, as one map:
/// `@/*` → `src/*` pairs.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AliasMap {
    pub base_url: PathBuf,
    pub paths: Vec<(String, Vec<String>)>,
}

impl AliasMap {
    /// The alias targets of `spec` (`@/components/Foo.vue` → the `src/…`
    /// candidates of the `@/*` pattern), longest matching pattern first
    /// (TypeScript's rule).
    fn targets(&self, spec: &str) -> Vec<PathBuf> {
        let mut matches: Vec<(usize, PathBuf)> = Vec::new();
        for (pattern, targets) in &self.paths {
            let Some((prefix, suffix)) = pattern.split_once('*') else { continue };
            if spec.starts_with(prefix) && spec.ends_with(suffix) {
                let replaced = &spec[prefix.len()..spec.len() - suffix.len()];
                for t in targets {
                    matches.push((prefix.len(), self.base_url.join(t.replace('*', replaced))));
                }
            }
        }
        matches.sort_by_key(|(len, _)| std::cmp::Reverse(*len));
        matches.into_iter().map(|(_, path)| path).collect()
    }
}

/// The extensions an extensionless specifier tries, in TypeScript's order
/// (`d.ts` last: a declaration never wins over the implementation).
pub const SCRIPT_EXTENSIONS: &[&str] = &["ts", "tsx", "js", "jsx", "mts", "cts", "mjs", "cjs", "vue", "d.ts"];

/// Resolves `spec` (written in `from`) to a workspace file: as-is when it
/// already has an extension, then with each script extension, then as a
/// directory's index. `exists` decides what is a file; `None` for bare
/// specifiers and misses.
pub fn resolve_spec(from: &Path, spec: &str, aliases: &AliasMap, exists: &dyn Fn(&Path) -> bool) -> Option<PathBuf> {
    if !spec.starts_with('.') && !spec.starts_with('/') {
        // An alias (`@/x`) or a bare package name (`vue`): only aliases resolve.
        for base in aliases.targets(spec) {
            if let Some(found) = complete(&base, exists) {
                return Some(found);
            }
        }
        return None;
    }
    let base = if spec.starts_with('/') { PathBuf::from(spec) } else { from.parent()?.join(spec) };
    complete(&base, exists)
}

/// A specifier base with its extension candidates: the base as-is when it
/// already ends in one (TypeScript does not re-complete it), then each
/// script extension, then `index.*` files.
fn complete(base: &Path, exists: &dyn Fn(&Path) -> bool) -> Option<PathBuf> {
    if base.extension().is_some() {
        return exists(base).then(|| simplified(base));
    }
    let name = base.file_name()?.to_str()?;
    for ext in SCRIPT_EXTENSIONS {
        let candidate = base.with_file_name(format!("{name}.{ext}"));
        if exists(&candidate) {
            return Some(simplified(&candidate));
        }
    }
    for ext in SCRIPT_EXTENSIONS {
        let index = base.join(format!("index.{ext}"));
        if exists(&index) {
            return Some(simplified(&index));
        }
    }
    None
}

/// Lexically drops `.` components a `./x`-style alias target may carry, so
/// resolved paths equal the index's own (no filesystem access).
fn simplified(path: &Path) -> PathBuf {
    PathBuf::from(dunce::simplified(path))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn files(paths: &[&str]) -> HashSet<PathBuf> {
        paths.iter().map(PathBuf::from).collect()
    }

    #[test]
    fn relative_specifiers_complete_extensions_and_index_files() {
        let set = files(&["/p/src/a.ts", "/p/src/b/index.ts", "/p/src/c.vue", "/p/src/d.ts.txt"]);
        let exists = |p: &Path| set.contains(p);
        let from = Path::new("/p/src/main.ts");
        let aliases = AliasMap::default();
        let resolve = |spec: &str| resolve_spec(from, spec, &aliases, &exists);
        assert_eq!(resolve("./a"), Some(PathBuf::from("/p/src/a.ts")));
        assert_eq!(resolve("./b"), Some(PathBuf::from("/p/src/b/index.ts")));
        assert_eq!(resolve("./c"), Some(PathBuf::from("/p/src/c.vue")));
        // An explicit extension is tried as-is, never re-completed.
        assert_eq!(resolve("./a.ts"), Some(PathBuf::from("/p/src/a.ts")));
        assert_eq!(resolve("./a.js"), None);
        assert_eq!(resolve("./missing"), None);
        // `d.ts.txt` has extension `txt`: not a script candidate for `./d`.
        assert_eq!(resolve("./d"), None);
    }

    #[test]
    fn declaration_files_complete_last() {
        // `x.d.ts` is a candidate for `./x` (a declaration for a JS module).
        let set = files(&["/p/x.d.ts"]);
        let exists = |p: &Path| set.contains(p);
        assert_eq!(
            resolve_spec(Path::new("/p/a.ts"), "./x", &AliasMap::default(), &exists),
            Some(PathBuf::from("/p/x.d.ts"))
        );
    }

    #[test]
    fn alias_specifiers_resolve_through_paths() {
        let aliases =
            AliasMap { base_url: PathBuf::from("/p"), paths: vec![("@/*".to_string(), vec!["src/*".to_string()])] };
        let set = files(&["/p/src/components/Foo.vue", "/p/src/api.ts"]);
        let exists = |p: &Path| set.contains(p);
        let from = Path::new("/p/src/views/Home.vue");
        assert_eq!(
            resolve_spec(from, "@/components/Foo.vue", &aliases, &exists),
            Some(PathBuf::from("/p/src/components/Foo.vue"))
        );
        assert_eq!(resolve_spec(from, "@/api", &aliases, &exists), Some(PathBuf::from("/p/src/api.ts")));
    }

    #[test]
    fn bare_specifiers_stay_unresolved() {
        let exists = |_: &Path| true;
        let aliases = AliasMap::default();
        assert_eq!(resolve_spec(Path::new("/p/a.ts"), "vue", &aliases, &exists), None);
        assert_eq!(resolve_spec(Path::new("/p/a.ts"), "lodash/merge", &aliases, &exists), None);
    }

    #[test]
    fn longest_alias_pattern_wins() {
        // Both patterns match `@c/Btn.vue`; the longer prefix (`@c/`) must win
        // even though the shorter one is listed first.
        let aliases = AliasMap {
            base_url: PathBuf::from("/p"),
            paths: vec![
                ("@*".to_string(), vec!["short/*".to_string()]),
                ("@c/*".to_string(), vec!["long/*".to_string()]),
            ],
        };
        let set = files(&["/p/short/Btn.vue", "/p/long/Btn.vue"]);
        let exists = |p: &Path| set.contains(p);
        assert_eq!(
            resolve_spec(Path::new("/p/x.ts"), "@c/Btn.vue", &aliases, &exists),
            Some(PathBuf::from("/p/long/Btn.vue"))
        );
    }
}
