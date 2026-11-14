//! The namespace ⇄ directory mapping from the PSR-4 and PSR-0 autoload rules.
//!
//! Later phases need it both ways: where a class or namespace lives (moving a
//! class, creating one, checking that a file is where its namespace says) and
//! which namespace a directory stands for (the namespace of a new file).
//! Namespaces compare ASCII case-insensitively, as PHP's do; paths are built
//! from the name as written.

use std::path::{Path, PathBuf};

/// Which autoload standard a [`NamespaceRoot`] follows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AutoloadStandard {
    /// The prefix is cut off: `App\` → `src/` puts `App\Model\User` in `src/Model/User.php`.
    Psr4,
    /// The whole name is a path below the directory: `Acme\` → `lib/` puts
    /// `Acme\Util` in `lib/Acme/Util.php`, and `_` in a class name is a `/` too.
    Psr0,
}

/// One namespace prefix mapped to one directory.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NamespaceRoot {
    /// `App\` (always ending in `\`), or empty for the fallback directory.
    /// PSR-0 prefixes may also be a class-name prefix such as `Twig_`.
    pub prefix: String,
    /// Absolute and lexically normalized.
    pub dir: PathBuf,
    pub standard: AutoloadStandard,
    /// From `autoload-dev` of the root package, or a dev-only package.
    pub dev: bool,
    /// The installed package it comes from; `None` for the project itself.
    pub package: Option<String>,
}

/// All [`NamespaceRoot`]s of the project and its installed packages.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AutoloadMap {
    roots: Vec<NamespaceRoot>,
}

impl AutoloadMap {
    pub(crate) fn push(&mut self, mut root: NamespaceRoot) {
        if root.standard == AutoloadStandard::Psr4 && !root.prefix.is_empty() && !root.prefix.ends_with('\\') {
            root.prefix.push('\\');
        }
        if !self.roots.contains(&root) {
            self.roots.push(root);
        }
    }

    /// In the order the manifests list them: the project first, then packages.
    pub fn roots(&self) -> &[NamespaceRoot] {
        &self.roots
    }

    pub fn is_empty(&self) -> bool {
        self.roots.is_empty()
    }

    /// The directories namespace `namespace` (`App\Model`, with or without a
    /// leading `\`; empty for the global one) maps to, most specific first:
    /// longer prefixes, then the project's own roots, then non-dev roots.
    /// The directories need not exist yet.
    pub fn namespace_dirs(&self, namespace: &str) -> Vec<PathBuf> {
        let namespace = namespace.trim_matches('\\');
        let mut found: Vec<(&NamespaceRoot, PathBuf)> = self
            .roots
            .iter()
            .filter_map(|root| {
                let dir = match root.standard {
                    AutoloadStandard::Psr4 => {
                        let rest = strip_namespace_prefix(namespace, &root.prefix)?;
                        join_namespace(&root.dir, rest)
                    }
                    AutoloadStandard::Psr0 => {
                        let with_sep = format!("{namespace}\\");
                        // A PSR-0 prefix either covers this namespace, or is a
                        // class-name prefix (`Twig_`) inside it.
                        let covers = starts_with_ignore_case(&with_sep, &root.prefix)
                            || (!root.prefix.ends_with('\\')
                                && !root.prefix.is_empty()
                                && parent_namespace(&root.prefix).eq_ignore_ascii_case(namespace));
                        if !covers {
                            return None;
                        }
                        join_namespace(&root.dir, namespace)
                    }
                };
                Some((root, dir))
            })
            .collect();
        found.sort_by_key(|(root, _)| specificity(root));
        let mut dirs: Vec<PathBuf> = Vec::new();
        for (_, dir) in found {
            if !dirs.contains(&dir) {
                dirs.push(dir);
            }
        }
        dirs
    }

    /// The files class-like `fqn` should be in, most specific first.
    pub fn class_files(&self, fqn: &str) -> Vec<PathBuf> {
        let fqn = fqn.trim_start_matches('\\');
        let (namespace, short) = match fqn.rfind('\\') {
            Some(i) => (&fqn[..i], &fqn[i + 1..]),
            None => ("", fqn),
        };
        let mut found: Vec<(&NamespaceRoot, PathBuf)> = self
            .roots
            .iter()
            .filter_map(|root| {
                let file = match root.standard {
                    AutoloadStandard::Psr4 => {
                        let rest = strip_namespace_prefix(namespace, &root.prefix)?;
                        join_namespace(&root.dir, rest).join(format!("{short}.php"))
                    }
                    AutoloadStandard::Psr0 => {
                        if !starts_with_ignore_case(fqn, &root.prefix) {
                            return None;
                        }
                        join_namespace(&root.dir, namespace).join(format!("{}.php", short.replace('_', "/")))
                    }
                };
                Some((root, file))
            })
            .collect();
        found.sort_by_key(|(root, _)| specificity(root));
        let mut files: Vec<PathBuf> = Vec::new();
        for (_, file) in found {
            if !files.contains(&file) {
                files.push(file);
            }
        }
        files
    }

    /// The namespace directory `dir` stands for (without a leading or trailing
    /// `\`; empty for the global namespace), from the root whose directory is
    /// the closest ancestor of `dir` (ties: the project before packages).
    /// `None` when no root contains `dir`, or the path below the root isn't
    /// made of valid namespace segments.
    pub fn namespace_of_dir(&self, dir: &Path) -> Option<String> {
        let dir = super::normalize(dir);
        let mut best: Option<(&NamespaceRoot, &Path)> = None;
        for root in &self.roots {
            let Ok(rel) = dir.strip_prefix(&root.dir) else {
                continue;
            };
            let better = match best {
                None => true,
                Some((current, current_rel)) => {
                    let (depth, current_depth) = (rel.components().count(), current_rel.components().count());
                    depth < current_depth
                        || (depth == current_depth && current.package.is_some() && root.package.is_none())
                }
            };
            if better {
                best = Some((root, rel));
            }
        }
        let (root, rel) = best?;
        let mut segments: Vec<String> = Vec::new();
        for component in rel.components() {
            let segment = component.as_os_str().to_str()?;
            if !is_identifier(segment) {
                return None;
            }
            segments.push(segment.to_owned());
        }
        let rest = segments.join("\\");
        Some(match root.standard {
            AutoloadStandard::Psr4 => {
                let prefix = root.prefix.trim_end_matches('\\');
                match (prefix.is_empty(), rest.is_empty()) {
                    (true, _) => rest,
                    (false, true) => prefix.to_owned(),
                    (false, false) => format!("{prefix}\\{rest}"),
                }
            }
            AutoloadStandard::Psr0 => rest,
        })
    }
}

/// Sort key: longer prefixes first, then the project's roots, then non-dev ones.
fn specificity(root: &NamespaceRoot) -> (std::cmp::Reverse<usize>, bool, bool) {
    (std::cmp::Reverse(root.prefix.len()), root.package.is_some(), root.dev)
}

/// The rest of `namespace` after PSR-4 `prefix` (`App\`), if it starts with it.
fn strip_namespace_prefix<'a>(namespace: &'a str, prefix: &str) -> Option<&'a str> {
    if prefix.is_empty() {
        return Some(namespace);
    }
    let bare = prefix.trim_end_matches('\\');
    if namespace.eq_ignore_ascii_case(bare) {
        return Some("");
    }
    starts_with_ignore_case(namespace, prefix).then(|| &namespace[prefix.len()..])
}

fn starts_with_ignore_case(s: &str, prefix: &str) -> bool {
    s.len() >= prefix.len() && s.as_bytes()[..prefix.len()].eq_ignore_ascii_case(prefix.as_bytes())
}

fn parent_namespace(name: &str) -> &str {
    name.rfind('\\').map_or("", |i| &name[..i])
}

fn join_namespace(dir: &Path, namespace: &str) -> PathBuf {
    let mut out = dir.to_path_buf();
    for segment in namespace.split('\\').filter(|s| !s.is_empty()) {
        out.push(segment);
    }
    out
}

/// A PHP name segment: a letter, `_` or a byte ≥ 0x80 first, then also digits.
fn is_identifier(s: &str) -> bool {
    let mut bytes = s.bytes();
    matches!(bytes.next(), Some(b) if b.is_ascii_alphabetic() || b == b'_' || b >= 0x80)
        && bytes.all(|b| b.is_ascii_alphanumeric() || b == b'_' || b >= 0x80)
}
