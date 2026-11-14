//! IDEA-style file masks (`*.kt, *.java, !*Test.kt`).

use globset::{GlobBuilder, GlobSet, GlobSetBuilder};
use ide_core::{IdeError, IdeResult};

/// Masks without a `/` match the file name; masks with one match the path
/// relative to the project root (`src/**/*.ts`).
#[derive(Debug)]
pub struct FileMask {
    include_name: GlobSet,
    include_path: GlobSet,
    exclude_name: GlobSet,
    exclude_path: GlobSet,
    has_include: bool,
    exclude_dirs: GlobSet,
}

impl FileMask {
    /// Every entry may hold several comma-separated masks; a leading `!`
    /// moves a mask to the opposite list.
    pub fn new(include: &[String], exclude: &[String]) -> IdeResult<Self> {
        let mut inc = Lists::default();
        let mut exc = Lists::default();
        let mut dirs = Lists::default();
        for (entries, is_include_list) in [(include, true), (exclude, false)] {
            for mask in entries.iter().flat_map(|e| e.split(',')) {
                let mask = mask.trim();
                let (negated, mask) = match mask.strip_prefix('!') {
                    Some(rest) => (true, rest.trim()),
                    None => (false, mask),
                };
                if mask.is_empty() {
                    continue;
                }
                let target = if is_include_list != negated { &mut inc } else { &mut exc };
                target.push(mask)?;
                // Only a trailing /** guarantees that every descendant is excluded.
                // File masks and inclusion masks cannot safely prune a directory.
                if is_include_list == negated
                    && !mask.contains('\\')
                    && let Some(prefix) = mask.strip_suffix("/**")
                    && !prefix.is_empty()
                {
                    dirs.push(&format!("{prefix}/"))?;
                }
            }
        }
        Ok(Self {
            has_include: inc.count > 0,
            exclude_dirs: dirs.path.build().map_err(glob_error)?,
            include_name: inc.name.build().map_err(glob_error)?,
            include_path: inc.path.build().map_err(glob_error)?,
            exclude_name: exc.name.build().map_err(glob_error)?,
            exclude_path: exc.path.build().map_err(glob_error)?,
        })
    }

    pub(crate) fn has_directory_exclusions(&self) -> bool {
        !self.exclude_dirs.is_empty()
    }

    /// Whether an exclusion covers every file below this directory. This is
    /// deliberately conservative; ordinary masks still filter individual files.
    pub(crate) fn excludes_dir(&self, rel_path: &str) -> bool {
        if self.exclude_dirs.is_empty() {
            return false;
        }
        let path = format!("{rel_path}/");
        path.match_indices('/').any(|(i, _)| self.exclude_dirs.is_match(&path[..=i]))
    }

    /// `rel_path` uses `/` separators.
    pub fn matches(&self, rel_path: &str) -> bool {
        let name = rel_path.rsplit('/').next().unwrap_or(rel_path);
        if self.has_include && !self.include_name.is_match(name) && !self.include_path.is_match(rel_path) {
            return false;
        }
        !(self.exclude_name.is_match(name) || self.exclude_path.is_match(rel_path))
    }
}

struct Lists {
    name: GlobSetBuilder,
    path: GlobSetBuilder,
    count: usize,
}

impl Default for Lists {
    fn default() -> Self {
        Self { name: GlobSetBuilder::new(), path: GlobSetBuilder::new(), count: 0 }
    }
}

impl Lists {
    fn push(&mut self, mask: &str) -> IdeResult<()> {
        let mask = mask.trim_start_matches("./");
        let (set, mask) =
            if mask.contains('/') { (&mut self.path, mask.trim_start_matches('/')) } else { (&mut self.name, mask) };
        let glob = GlobBuilder::new(mask)
            .literal_separator(true)
            .backslash_escape(true)
            .case_insensitive(cfg!(any(target_os = "macos", target_os = "windows")))
            .build()
            .map_err(|e| IdeError::invalid(format!("Invalid file mask `{mask}`: {}", e.kind())))?;
        set.add(glob);
        self.count += 1;
        Ok(())
    }
}

fn glob_error(e: globset::Error) -> IdeError {
    IdeError::invalid(format!("Invalid file mask: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mask(include: &[&str], exclude: &[&str]) -> FileMask {
        let s = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        FileMask::new(&s(include), &s(exclude)).unwrap()
    }

    #[test]
    fn empty_matches_everything() {
        assert!(mask(&[], &[]).matches("a/b.rs"));
    }

    #[test]
    fn name_masks() {
        let m = mask(&["*.kt, *.java, !*Test.kt"], &[]);
        assert!(m.matches("src/Main.kt"));
        assert!(m.matches("Main.java"));
        assert!(!m.matches("src/MainTest.kt"));
        assert!(!m.matches("src/main.rs"));
    }

    #[test]
    fn path_masks() {
        let m = mask(&["src/**/*.ts"], &["src/gen/**"]);
        assert!(m.matches("src/a.ts"));
        assert!(m.matches("src/x/y/a.ts"));
        assert!(!m.matches("lib/a.ts"));
        assert!(!m.matches("src/gen/a.ts"));
    }

    #[test]
    fn negation_in_exclude_list_includes() {
        let m = mask(&[], &["*.md", "!*.rs"]);
        assert!(m.matches("a.rs"));
        assert!(!m.matches("a.md"));
        assert!(!m.matches("a.txt"));
    }

    #[test]
    fn only_negated_includes() {
        let m = mask(&["!*.lock"], &[]);
        assert!(m.matches("a.rs"));
        assert!(!m.matches("Cargo.lock"));
    }

    #[test]
    fn only_complete_subtree_exclusions_prune_directories() {
        let m = mask(&["*.go"], &["**/node_modules/**", "edge/device/build/**"]);
        for dir in [
            "node_modules",
            "edge/node_modules",
            "edge/device/build",
            "edge/device/build/deep",
            "edge/node_modules/pkg/lib",
        ] {
            assert!(m.excludes_dir(dir), "{dir}");
        }
        for dir in ["edge", "edge/device", "internal/build", "src.go"] {
            assert!(!m.excludes_dir(dir), "{dir}");
        }
        for pattern in ["*.go", "build", "build/*", "build/", "build/**/*.go"] {
            assert!(!mask(&[], &[pattern]).excludes_dir("build"), "{pattern}");
        }
    }

    #[test]
    fn directory_pruning_preserves_mask_negation_semantics() {
        assert!(mask(&["!vendor/**"], &[]).excludes_dir("vendor"));
        assert!(!mask(&[], &["!vendor/**"]).excludes_dir("vendor"));
        // Exclusions already win over inclusions in FileMask, irrespective of order.
        let m = mask(&["vendor/keep.go"], &["vendor/**"]);
        assert!(m.excludes_dir("vendor"));
        assert!(!m.matches("vendor/keep.go"));
        assert!(mask(&[], &["./vendor/**, **/node_modules/**"]).excludes_dir("vendor"));
    }

    #[test]
    fn directory_pruning_uses_the_same_case_rules_as_files() {
        let m = mask(&[], &["Vendor/**"]);
        let case_insensitive = cfg!(any(target_os = "macos", target_os = "windows"));
        assert_eq!(m.excludes_dir("vendor"), case_insensitive);
        assert_eq!(m.matches("vendor/a.go"), !case_insensitive);
    }

    #[test]
    fn pruned_directory_descendants_are_already_excluded() {
        for pattern in ["vendor/**", "**/build/**", "modules/*/build/**", "[ab]/**", "**/**"] {
            let m = mask(&[], &[pattern]);
            for dir in ["vendor", "vendor/deep", "build", "a", "modules/a/build", "modules/a/src", "x/build/y"] {
                if m.excludes_dir(dir) {
                    for file in ["main.go", "deep/lib.go", ".hidden/config", "node_modules/a.js"] {
                        assert!(!m.matches(&format!("{dir}/{file}")), "{pattern}: {dir}/{file}");
                    }
                }
            }
        }
        assert!(!mask(&[], &[r"escaped\*/**"]).excludes_dir("escaped*"));
    }

    #[test]
    fn invalid_glob() {
        let err = FileMask::new(&["a[".into()], &[]).unwrap_err();
        assert_eq!(err.kind, ide_core::error::ErrorKind::InvalidInput);
    }
}
