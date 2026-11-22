//! Import updates for moved Python modules and packages, which basedpyright leaves to the
//! client (no `workspace/willRenameFiles`). Works on dotted module names; the caller maps
//! files to them from the project's roots.

use super::lines::LineIndex;
use crate::{LanguageId, Syntax};
use ide_core::TextEdit;
use tree_sitter::{Node, Tree};

impl Syntax {
    /// Edits that keep the imports of a Python `text` resolving after `moves` (old → new
    /// dotted names; a package covers its submodules). `package` is the package relative
    /// imports start from (`a.b` for `a/b/c.py` and `a/b/__init__.py`), `new_package` the
    /// same after the move.
    pub fn python_import_edits(
        &self,
        text: &str,
        package: &str,
        new_package: &str,
        moves: &[(String, String)],
    ) -> Vec<TextEdit> {
        self.analyze(&LanguageId::new("python"), text, |_, tree, text| {
            Some(Rewrite { text, idx: LineIndex::new(text), package, new_package, moves, edits: Vec::new() }.run(tree))
        })
        .unwrap_or_default()
    }
}

struct Rewrite<'a> {
    text: &'a str,
    idx: LineIndex<'a>,
    package: &'a str,
    new_package: &'a str,
    moves: &'a [(String, String)],
    edits: Vec<TextEdit>,
}

impl Rewrite<'_> {
    fn run(mut self, tree: &Tree) -> Vec<TextEdit> {
        let mut imports = Vec::new();
        let mut chains = Vec::new();
        collect(tree.root_node(), &mut |n| match n.kind() {
            "import_statement" | "import_from_statement" => imports.push(n),
            "attribute" if !inside_import(n) => chains.push(n),
            _ => {}
        });
        let mut renamed: Vec<(String, String)> = Vec::new();
        for node in imports {
            if node.kind() == "import_statement" {
                self.import(node, &mut renamed);
            } else {
                self.import_from(node);
            }
        }
        // `import a.b` is used as `a.b.x`: those chains follow the import.
        for node in chains {
            let t = self.src(node);
            if let Some((_, new)) = renamed.iter().find(|(old, _)| *old == t) {
                self.edit(node, new.clone());
            }
        }
        self.edits.sort_by_key(|e| (e.range.start.line, e.range.start.col));
        self.edits
    }

    fn src(&self, n: Node) -> &str {
        self.text.get(n.byte_range()).unwrap_or_default()
    }

    fn edit(&mut self, n: Node, new_text: String) {
        self.edits.push(TextEdit { range: self.idx.range(n.start_byte(), n.end_byte()), new_text });
    }

    /// `import a.b`, `import a.b as c`.
    fn import(&mut self, node: Node, renamed: &mut Vec<(String, String)>) {
        let mut cursor = node.walk();
        for item in node.children_by_field_name("name", &mut cursor) {
            let (name, aliased) = match item.kind() {
                "aliased_import" => match item.child_by_field_name("name") {
                    Some(n) => (n, true),
                    None => continue,
                },
                _ => (item, false),
            };
            let old = self.src(name).to_owned();
            let Some(new) = map_module(&old, self.moves) else { continue };
            if aliased {
                self.edit(name, new);
            } else if old.contains('.') {
                renamed.push((old, new.clone()));
                self.edit(name, new);
            } else {
                // The bound name stays, so the rest of the file needs no change.
                self.edit(name, format!("{new} as {old}"));
            }
        }
    }

    /// `from m import x`, `from .m import x as y`, `from . import m`.
    fn import_from(&mut self, node: Node) {
        let Some(module) = node.child_by_field_name("module_name") else { return };
        let relative = (module.kind() == "relative_import").then(|| {
            let mut cursor = module.walk();
            let dots = module
                .children(&mut cursor)
                .find(|c| c.kind() == "import_prefix")
                .map_or(0, |p| self.src(p).matches('.').count());
            let rest = module.child(1).filter(|c| c.kind() == "dotted_name").map_or("", |c| self.src(c));
            (dots, rest.to_owned())
        });
        let source = match &relative {
            Some((dots, rest)) => match resolve(*dots, rest, self.package) {
                Some(s) => s,
                None => return,
            },
            None => self.src(module).to_owned(),
        };
        let target = map_module(&source, self.moves).unwrap_or_else(|| source.clone());

        // Imported submodules that moved on their own (`from pkg import models`).
        let mut cursor = node.walk();
        let names: Vec<Node> = node.children_by_field_name("name", &mut cursor).collect();
        let mut moved: Vec<(Node, String, String, String)> = Vec::new(); // (item, parent, name, bound)
        for &item in &names {
            let (name, alias) = match item.kind() {
                "aliased_import" => (item.child_by_field_name("name"), item.child_by_field_name("alias")),
                _ => (Some(item), None),
            };
            let Some(name) = name else { continue };
            let n = self.src(name).to_owned();
            let full = join(&source, &n);
            let Some(new) = map_module(&full, self.moves) else { continue };
            if new == join(&target, &n) {
                continue;
            }
            let (parent, last) =
                new.rsplit_once('.').map_or((String::new(), new.clone()), |(p, l)| (p.into(), l.into()));
            let bound = alias.map_or(n, |a| self.src(a).to_owned());
            moved.push((item, parent, last, bound));
        }
        let as_name =
            |last: &str, bound: &str| if last == bound { last.to_owned() } else { format!("{last} as {bound}") };
        // Renamed inside the same package: only the name changes.
        let in_place: Vec<(Node, String)> =
            moved.iter().filter(|m| m.1 == target).map(|m| (m.0, as_name(&m.2, &m.3))).collect();
        moved.retain(|m| m.1 != target);
        let render = |module: &str, rw: &Self| match &relative {
            Some((dots, rest)) if resolve(*dots, rest, rw.new_package).as_deref() == Some(module) => None,
            Some(_) => Some(relative_to(module, rw.new_package).unwrap_or_else(|| module.to_owned())),
            None => Some(module.to_owned()),
        };

        let all_one_parent = !moved.is_empty()
            && moved.len() == names.len()
            && moved.iter().all(|m| m.1 == moved[0].1 && !m.1.is_empty());
        if all_one_parent {
            let parent = moved[0].1.clone();
            if let Some(m) = render(&parent, self).filter(|m| m != self.src(module)) {
                self.edit(module, m);
            }
            for (item, _, last, bound) in moved {
                let new = as_name(&last, &bound);
                if new != self.src(item) {
                    self.edit(item, new);
                }
            }
            return;
        }
        if moved.is_empty() {
            if let Some(m) = render(&target, self).filter(|m| m != self.src(module)) {
                self.edit(module, m);
            }
            for (item, text) in in_place {
                self.edit(item, text);
            }
            return;
        }
        // ponytail: a split statement loses a multi-line names list's layout; fine for the rare
        // "some names of one `from` moved elsewhere" case.
        let indent = line_indent(self.text, node.start_byte());
        let mut parents: Vec<&str> = Vec::new();
        for m in &moved {
            if !parents.contains(&m.1.as_str()) {
                parents.push(&m.1);
            }
        }
        let mut added: Vec<String> = Vec::new();
        for parent in parents {
            let items: Vec<String> = moved.iter().filter(|m| m.1 == parent).map(|m| as_name(&m.2, &m.3)).collect();
            added.push(if parent.is_empty() {
                format!("import {}", items.join(", "))
            } else {
                let from = render(parent, self).unwrap_or_else(|| self.src(module).to_owned());
                format!("from {from} import {}", items.join(", "))
            });
        }
        let kept: Vec<String> = names
            .iter()
            .filter(|n| !moved.iter().any(|m| m.0 == **n))
            .map(|n| in_place.iter().find(|(i, _)| i == n).map_or_else(|| self.src(*n).to_owned(), |(_, t)| t.clone()))
            .collect();
        let sep = format!("\n{indent}");
        if kept.is_empty() {
            self.edit(node, added.join(&sep));
            return;
        }
        if let Some(m) = render(&target, self).filter(|m| m != self.src(module)) {
            self.edit(module, m);
        }
        let (first, last) = (names[0], names[names.len() - 1]);
        let range = self.idx.range(first.start_byte(), last.end_byte());
        self.edits.push(TextEdit { range, new_text: kept.join(", ") });
        let end = self.idx.pos(node.end_byte());
        self.edits.push(TextEdit {
            range: ide_core::Range { start: end, end },
            new_text: format!("{sep}{}", added.join(&sep)),
        });
    }
}

fn collect<'t>(node: Node<'t>, f: &mut impl FnMut(Node<'t>)) {
    f(node);
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        collect(child, f);
    }
}

fn inside_import(mut n: Node) -> bool {
    while let Some(p) = n.parent() {
        if matches!(p.kind(), "import_statement" | "import_from_statement" | "future_import_statement") {
            return true;
        }
        n = p;
    }
    false
}

fn line_indent(text: &str, byte: usize) -> &str {
    let start = text[..byte].rfind('\n').map_or(0, |i| i + 1);
    &text[start..byte]
}

fn join(a: &str, b: &str) -> String {
    match (a.is_empty(), b.is_empty()) {
        (true, _) => b.to_owned(),
        (_, true) => a.to_owned(),
        _ => format!("{a}.{b}"),
    }
}

/// `name` after `moves` (the longest moved prefix wins), if it changed.
fn map_module(name: &str, moves: &[(String, String)]) -> Option<String> {
    moves
        .iter()
        .filter(|(from, _)| name == from || name.strip_prefix(from.as_str()).is_some_and(|r| r.starts_with('.')))
        .max_by_key(|(from, _)| from.len())
        .map(|(from, to)| format!("{to}{}", &name[from.len()..]))
        .filter(|new| new != name)
}

/// The absolute module `from <dots><rest> import` names inside `package`.
fn resolve(dots: usize, rest: &str, package: &str) -> Option<String> {
    let segs: Vec<&str> = package.split('.').filter(|s| !s.is_empty()).collect();
    let keep = segs.len().checked_sub(dots.checked_sub(1)?)?;
    if keep == 0 {
        return None;
    }
    Some(join(&segs[..keep].join("."), rest))
}

/// The shortest relative form of `module` from `package`, if they share a top-level package.
fn relative_to(module: &str, package: &str) -> Option<String> {
    let segs: Vec<&str> = package.split('.').filter(|s| !s.is_empty()).collect();
    (1..=segs.len()).find_map(|dots| {
        let base = segs[..segs.len() + 1 - dots].join(".");
        let rest = if module == base { "" } else { module.strip_prefix(&base)?.strip_prefix('.')? };
        Some(format!("{}{rest}", ".".repeat(dots)))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::syntax::lines::byte_at;

    fn apply(text: &str, package: &str, new_package: &str, moves: &[(&str, &str)]) -> String {
        let moves: Vec<(String, String)> = moves.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect();
        let mut edits = Syntax::new().python_import_edits(text, package, new_package, &moves);
        edits.sort_by_key(|e| std::cmp::Reverse((e.range.start.line, e.range.start.col)));
        let mut out = text.to_owned();
        for e in edits {
            let (s, t) = (byte_at(&out, e.range.start).unwrap(), byte_at(&out, e.range.end).unwrap());
            out.replace_range(s..t, &e.new_text);
        }
        out
    }

    const RENAME: &[(&str, &str)] = &[("pkg.models", "pkg.domain")];

    #[test]
    fn absolute_imports() {
        let src = "import pkg.models\nimport pkg.models as m\nfrom pkg.models import Task, Priority\nimport pkg.modelsx\n\nx = pkg.models.Task()\ny = m.Task\n";
        assert_eq!(
            apply(src, "app", "app", RENAME),
            "import pkg.domain\nimport pkg.domain as m\nfrom pkg.domain import Task, Priority\nimport pkg.modelsx\n\nx = pkg.domain.Task()\ny = m.Task\n"
        );
    }

    #[test]
    fn bound_names_keep_their_alias() {
        let src = "from pkg import models\nfrom pkg import models as mo, cli\nimport models\n";
        let moves = &[("pkg.models", "pkg.domain"), ("models", "domain")];
        assert_eq!(
            apply(src, "app", "app", moves),
            "from pkg import domain as models\nfrom pkg import domain as mo, cli\nimport domain as models\n"
        );
    }

    #[test]
    fn relative_imports() {
        let src = "from .models import Task\nfrom . import models\nfrom . import cli\n";
        assert_eq!(
            apply(src, "pkg", "pkg", RENAME),
            "from .domain import Task\nfrom . import domain as models\nfrom . import cli\n"
        );
        let src = "from ..models import Task\nfrom .. import models, cli\n";
        assert_eq!(
            apply(src, "pkg.sub", "pkg.sub", RENAME),
            "from ..domain import Task\nfrom .. import domain as models, cli\n"
        );
    }

    #[test]
    fn module_moved_to_another_package() {
        let moves = &[("pkg.models", "core.models")];
        assert_eq!(apply("from .models import Task\n", "pkg", "pkg", moves), "from core.models import Task\n");
        assert_eq!(apply("from pkg import models\n", "app", "app", moves), "from core import models\n");
        assert_eq!(
            apply("def f():\n    from pkg import cli, models\n", "app", "app", moves),
            "def f():\n    from pkg import cli\n    from core import models\n"
        );
        let moves = &[("pkg.models", "core.models"), ("pkg.cli", "pkg.main"), ("pkg.util", "util")];
        assert_eq!(
            apply("from pkg import cli, models, util, other\n", "app", "app", moves),
            "from pkg import main as cli, other\nfrom core import models\nimport util\n"
        );
        assert_eq!(
            apply("from . import models\n", "pkg.sub", "pkg.sub", &[("pkg.sub.models", "pkg.models")]),
            "from .. import models\n"
        );
    }

    #[test]
    fn the_moved_file_keeps_its_relative_imports_resolving() {
        // pkg/cli.py → other/cli.py: `.models` (pkg.models) did not move.
        let moves = &[("pkg.cli", "other.cli")];
        assert_eq!(apply("from .models import Task\n", "pkg", "other", moves), "from pkg.models import Task\n");
        // pkg/sub/cli.py → pkg/cli.py
        let moves = &[("pkg.sub.cli", "pkg.cli")];
        assert_eq!(apply("from ..models import Task\n", "pkg.sub", "pkg", moves), "from .models import Task\n");
    }

    #[test]
    fn package_moves() {
        let moves = &[("pkg", "lib.pkg")];
        let src =
            "import pkg\nimport pkg.models\nfrom pkg.models import Task\nfrom pkg import models\n\npkg.models.Task()\n";
        assert_eq!(
            apply(src, "", "", moves),
            "import lib.pkg as pkg\nimport lib.pkg.models\nfrom lib.pkg.models import Task\nfrom lib.pkg import models\n\nlib.pkg.models.Task()\n"
        );
        // Inside the moved package, relative imports still resolve.
        assert_eq!(
            apply("from .models import Task\nfrom . import cli\n", "pkg", "lib.pkg", moves),
            "from .models import Task\nfrom . import cli\n"
        );
        // Absolute self-imports follow it.
        assert_eq!(
            apply("from pkg.models import Task\n", "pkg", "lib.pkg", moves),
            "from lib.pkg.models import Task\n"
        );
    }

    #[test]
    fn unrelated_imports_are_untouched() {
        let src = "from __future__ import annotations\nimport os\nfrom datetime import date\nfrom pkgx import models\nfrom . import *\n";
        assert_eq!(apply(src, "pkg", "pkg", RENAME), src);
    }

    #[test]
    fn helpers() {
        assert_eq!(resolve(1, "m", "a.b").as_deref(), Some("a.b.m"));
        assert_eq!(resolve(2, "", "a.b").as_deref(), Some("a"));
        assert_eq!(resolve(3, "m", "a.b"), None);
        assert_eq!(relative_to("a.b.m", "a.b").as_deref(), Some(".m"));
        assert_eq!(relative_to("a.c", "a.b").as_deref(), Some("..c"));
        assert_eq!(relative_to("x.c", "a.b"), None);
        assert_eq!(map_module("pkg.models.sub", RENAME_OWNED.as_slice()).as_deref(), Some("pkg.domain.sub"));
    }

    static RENAME_OWNED: std::sync::LazyLock<Vec<(String, String)>> =
        std::sync::LazyLock::new(|| vec![("pkg.models".into(), "pkg.domain".into())]);
}
