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
        let mut idents = Vec::new();
        collect(tree.root_node(), &mut |n| match n.kind() {
            "import_statement" | "import_from_statement" => imports.push(n),
            "identifier" if !inside_import(n) => idents.push(n),
            _ => {}
        });
        // Unaliased `import a.b` that change: (name node, old, new). They bind `a`, used as `a.b.x`.
        let mut dotted: Vec<(Node, String, String)> = Vec::new();
        let mut kept: Vec<String> = Vec::new();
        for node in imports {
            if node.kind() == "import_statement" {
                self.import(node, &mut dotted, &mut kept);
            } else {
                self.import_from(node);
            }
        }
        if dotted.is_empty() {
            return self.finish();
        }
        let root_of = |s: &str| s.split('.').next().unwrap_or_default().to_owned();
        let mut needed: Vec<(usize, String)> = Vec::new();
        for id in idents {
            let name = self.src(id);
            if !dotted.iter().any(|(_, old, _)| root_of(old) == name) || is_attribute_field(id) {
                continue;
            }
            // `a`, `a.b`, `a.b.x`: one edit per expression, on the longest prefix that moved.
            let mut spine = vec![id];
            while let Some(p) = spine
                .last()
                .and_then(|n| n.parent())
                .filter(|p| p.kind() == "attribute" && p.child_by_field_name("object") == spine.last().copied())
            {
                spine.push(p);
            }
            let key = |n: Node| self.src(n).chars().filter(|c| !c.is_whitespace()).collect::<String>();
            // ponytail: a bare `pkg` (no attribute) is never rewritten, it may be a parameter or a
            // local of the same name.
            if let Some((node, new)) =
                spine.iter().skip(1).rev().find_map(|&n| Some((n, map_module(&key(n), self.moves)?)))
            {
                self.edit(node, new);
                continue;
            }
            // A use the rewritten imports no longer bind (`pkg.helper()` after `import pkg.models` moved).
            if spine.len() < 2 {
                continue;
            }
            let used = key(*spine.last().unwrap_or(&id));
            for (i, (_, old, new)) in dotted.iter().enumerate() {
                let common: Vec<&str> = old
                    .split('.')
                    .zip(used.split('.'))
                    .take(old.split('.').count() - 1)
                    .take_while(|(a, b)| a == b)
                    .map(|(a, _)| a)
                    .collect();
                if common.is_empty() {
                    continue;
                }
                let prefix = common.join(".");
                let covered = |m: &String| *m == prefix || m.starts_with(&format!("{prefix}."));
                let gone = map_module(&prefix, self.moves).is_some();
                if !gone && !covered(new) && !kept.iter().any(covered) && !needed.contains(&(i, prefix.clone())) {
                    needed.push((i, prefix));
                }
            }
        }
        for (i, (node, _, new)) in dotted.iter().enumerate() {
            let extra: String = needed.iter().filter(|(j, _)| *j == i).map(|(_, p)| format!(", {p}")).collect();
            self.edits.push(TextEdit {
                range: self.idx.range(node.start_byte(), node.end_byte()),
                new_text: format!("{new}{extra}"),
            });
        }
        self.finish()
    }

    fn finish(mut self) -> Vec<TextEdit> {
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
    fn import<'t>(&mut self, node: Node<'t>, dotted: &mut Vec<(Node<'t>, String, String)>, kept: &mut Vec<String>) {
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
            let Some(new) = map_module(&old, self.moves) else {
                if !aliased {
                    kept.push(old);
                }
                continue;
            };
            if aliased {
                self.edit(name, new);
            } else if old.contains('.') {
                dotted.push((name, old, new));
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
        for (item, text) in &in_place {
            self.edit(*item, text.clone());
        }
        if moved.is_empty() {
            if let Some(m) = render(&target, self).filter(|m| m != self.src(module)) {
                self.edit(module, m);
            }
            return;
        }
        // Names imported from elsewhere now go to statements of their own, after this one (or
        // after `;` when the statement shares its line: `try: from a import b, c`).
        let line_start = self.text[..node.start_byte()].rfind('\n').map_or(0, |i| i + 1);
        let before = &self.text[line_start..node.start_byte()];
        let sep = if before.trim().is_empty() { format!("\n{before}") } else { "; ".to_owned() };
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
        let is_moved = |n: &Node| moved.iter().any(|m| m.0 == *n);
        let Some(last_kept) = names.iter().rposition(|n| !is_moved(n)) else {
            self.edit(node, added.join(&sep));
            return;
        };
        if let Some(m) = render(&target, self).filter(|m| m != self.src(module)) {
            self.edit(module, m);
        }
        let mut trailing_done = false;
        for (i, item) in names.iter().enumerate().filter(|(_, n)| is_moved(n)) {
            let (start, end) = if let Some(line) = self.own_lines(*item) {
                line
            } else if i < last_kept {
                (item.start_byte(), names[i + 1].start_byte())
            } else if !trailing_done {
                trailing_done = true;
                (names[last_kept].end_byte(), names[names.len() - 1].end_byte())
            } else {
                continue;
            };
            self.edits.push(TextEdit { range: self.idx.range(start, end), new_text: String::new() });
        }
        let end = self.idx.pos(node.end_byte());
        self.edits.push(TextEdit {
            range: ide_core::Range { start: end, end },
            new_text: format!("{sep}{}", added.join(&sep)),
        });
    }

    /// The whole lines of an import list item that has them to itself (`    models,  # noqa`).
    fn own_lines(&self, item: Node) -> Option<(usize, usize)> {
        let start = self.text[..item.start_byte()].rfind('\n').map_or(0, |i| i + 1);
        if !self.text[start..item.start_byte()].trim().is_empty() {
            return None;
        }
        let end = self.text[item.end_byte()..].find('\n').map_or(self.text.len(), |i| item.end_byte() + i + 1);
        let rest = self.text[item.end_byte()..end].trim_start();
        let rest = rest.strip_prefix(',').unwrap_or(rest).trim();
        (rest.is_empty() || rest.starts_with('#')).then_some((start, end))
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

/// `x` in `obj.x`.
fn is_attribute_field(n: Node) -> bool {
    n.parent().is_some_and(|p| p.kind() == "attribute" && p.child_by_field_name("attribute") == Some(n))
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
        // Like `ide-text`, which rejects a set of overlapping edits.
        for w in edits.windows(2) {
            let (later, earlier) = (&w[0].range, &w[1].range);
            assert!((earlier.end.line, earlier.end.col) <= (later.start.line, later.start.col), "overlap: {edits:?}");
        }
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
    fn nested_chains_get_one_edit() {
        let src = "import pkg.models\nimport pkg.models.sub\npkg.models.sub.f()\npkg.models.g()\n";
        assert_eq!(
            apply(src, "", "", &[("pkg", "lib.pkg")]),
            "import lib.pkg.models\nimport lib.pkg.models.sub\nlib.pkg.models.sub.f()\nlib.pkg.models.g()\n"
        );
    }

    #[test]
    fn other_uses_of_the_old_prefix_keep_their_binding() {
        let moves = &[("pkg.models", "core.models")];
        assert_eq!(
            apply("import pkg.models\n\npkg.models.Task()\npkg.helper()\n", "", "", moves),
            "import core.models, pkg\n\ncore.models.Task()\npkg.helper()\n"
        );
        let moves = &[("a.b.c", "a.x.c")];
        assert_eq!(
            apply("import a.b.c\na.b.c.f()\na.b.g()\n", "", "", moves),
            "import a.x.c, a.b\na.x.c.f()\na.b.g()\n"
        );
        // Inside a moved package the other uses follow it.
        assert_eq!(
            apply("import pkg.models\npkg.helper()\n", "", "", &[("pkg", "lib.pkg")]),
            "import lib.pkg.models\nlib.pkg.helper()\n"
        );
    }

    #[test]
    fn bare_names_are_left_alone() {
        let src = "import pkg.models\ndef f(pkg):\n    return pkg.models.x\n";
        assert_eq!(
            apply(src, "", "", &[("pkg", "lib.pkg")]),
            "import lib.pkg.models\ndef f(pkg):\n    return lib.pkg.models.x\n"
        );
    }

    #[test]
    fn split_statements_stay_valid() {
        let moves = &[("pkg.models", "core.models")];
        assert_eq!(
            apply("try: from pkg import cli, models\nexcept ImportError: pass\n", "", "", moves),
            "try: from pkg import cli; from core import models\nexcept ImportError: pass\n"
        );
        assert_eq!(
            apply("import os; from pkg import cli, models\n", "", "", moves),
            "import os; from pkg import cli; from core import models\n"
        );
        assert_eq!(
            apply("from pkg import (\n    models,  # noqa: F401\n    cli,  # used below\n)\n", "", "", moves),
            "from pkg import (\n    cli,  # used below\n)\nfrom core import models\n"
        );
        assert_eq!(
            apply("from pkg import (\n    cli,  # used below\n    models,\n)\n", "", "", moves),
            "from pkg import (\n    cli,  # used below\n)\nfrom core import models\n"
        );
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
