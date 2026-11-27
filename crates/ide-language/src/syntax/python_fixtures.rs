//! pytest fixtures in one Python module: the fixtures it defines (`@pytest.fixture`), the
//! places it names one (a test's or fixture's parameters, `usefixtures("x")`,
//! `getfixturevalue("x")`) and the plugin modules it loads (`pytest_plugins`). From the
//! syntax tree only; [`resolve_fixture`] then picks the definition pytest uses, given the
//! modules a test sees, nearest first.

use super::lines::LineIndex;
use crate::{LanguageId, Syntax};
use ide_core::{Pos, Range};
use tree_sitter::{Node, Tree};

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PytestModule {
    pub fixtures: Vec<PytestFixture>,
    pub uses: Vec<PytestFixtureUse>,
    /// Where a fixture name may be typed: completion offers the visible fixtures there.
    pub slots: Vec<PytestFixtureSlot>,
    /// Modules named by a module-level `pytest_plugins`, as written (`pkg.fixtures`).
    pub plugins: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PytestFixture {
    /// The name tests ask for: the `name=` argument, else the function's name.
    pub name: String,
    /// That name in the source: the function name, or the `name=` string's content.
    pub selection: Range,
    /// The class whose method it is; only that class's tests see it.
    pub class: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PytestFixtureUseKind {
    Parameter,
    UseFixtures,
    GetFixtureValue,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PytestFixtureUse {
    pub name: String,
    pub range: Range,
    pub kind: PytestFixtureUseKind,
    pub class: Option<String>,
    /// The fixture whose parameter this is: `def tasks(tasks)` asks for the next `tasks` outward.
    pub in_fixture: Option<String>,
    /// For a parameter: the names in the function's body that read it (attribute names and
    /// keyword argument names left out), which a rename of the fixture renames too.
    pub body: Vec<Range>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PytestFixtureSlot {
    /// A test's or fixture's parameter list, or the content of a `usefixtures` /
    /// `getfixturevalue` string (empty strings included).
    pub range: Range,
    pub class: Option<String>,
}

impl PytestModule {
    /// The use whose name covers `pos` (its end included, where a caret after the name sits).
    pub fn use_at(&self, pos: Pos) -> Option<&PytestFixtureUse> {
        self.uses.iter().find(|u| u.range.start <= pos && pos <= u.range.end)
    }

    /// The fixture whose name (function name or `name=` string) covers `pos`.
    pub fn definition_at(&self, pos: Pos) -> Option<usize> {
        self.fixtures.iter().position(|f| f.selection.start <= pos && pos <= f.selection.end)
    }

    /// The slot holding `pos`.
    pub fn slot_at(&self, pos: Pos) -> Option<&PytestFixtureSlot> {
        self.slots.iter().filter(|s| s.range.start <= pos && pos <= s.range.end).min_by_key(|s| s.range.end)
    }
}

impl Syntax {
    /// The pytest fixtures a Python `text` defines and names; empty for other languages.
    pub fn pytest_module(&self, lang: &LanguageId, text: &str) -> PytestModule {
        self.analyze(lang, text, |g, tree, text| (g.spec.name == "python").then(|| extract(tree, text)))
            .unwrap_or_default()
    }
}

/// The fixture pytest uses for a name asked in `layers[0]` (the module), `class` being the
/// asking test's class, the later layers being the `conftest.py` files from the module's
/// folder upward, then plugins and pytest's own modules. `overriding`: the asker is a fixture
/// of that same name, which gets the next definition outward. Returns (layer, fixture) indexes.
pub fn resolve_fixture(
    layers: &[&PytestModule],
    name: &str,
    class: Option<&str>,
    overriding: bool,
) -> Option<(usize, usize)> {
    visible(layers, class).filter(|&(l, f)| layers[l].fixtures[f].name == name).nth(usize::from(overriding))
}

/// The fixtures a test of `class` in `layers[0]` sees, nearest first, one per name.
pub fn visible_fixtures(layers: &[&PytestModule], class: Option<&str>) -> Vec<(usize, usize)> {
    let mut seen = std::collections::HashSet::new();
    visible(layers, class).filter(|&(l, f)| seen.insert(layers[l].fixtures[f].name.as_str())).collect()
}

/// Every fixture visible from `class` in `layers[0]`, nearest first: the class's own, then
/// the module's, then each later layer's module-level ones. Within one scope the last
/// definition of a name wins, as Python rebinds it.
fn visible<'a>(layers: &'a [&'a PytestModule], class: Option<&'a str>) -> impl Iterator<Item = (usize, usize)> + 'a {
    let scopes = layers.iter().enumerate().flat_map(move |(l, m)| {
        let own = (l == 0).then_some(class).flatten().map(|c| (l, m, Some(c)));
        own.into_iter().chain(std::iter::once((l, m, None)))
    });
    scopes.flat_map(|(l, m, scope)| {
        let mut picked: Vec<(usize, usize)> = Vec::new();
        for (f, fixture) in m.fixtures.iter().enumerate().rev() {
            if fixture.class.as_deref() == scope && !picked.iter().any(|&(_, p)| m.fixtures[p].name == fixture.name) {
                picked.push((l, f));
            }
        }
        picked.reverse();
        picked
    })
}

fn extract(tree: &Tree, text: &str) -> PytestModule {
    let idx = LineIndex::new(text);
    let mut out = PytestModule::default();
    let root = tree.root_node();
    let mut cursor = root.walk();
    for node in root.named_children(&mut cursor) {
        statement(node, None, text, &idx, &mut out);
    }
    // `usefixtures` / `getfixturevalue` calls wherever they are.
    let mut walker = root.walk();
    visit(&mut walker, &mut |node| {
        if node.kind() == "call" {
            fixture_call(node, text, &idx, &mut out);
        }
    });
    out
}

/// A top-level statement, or one in a class body (`class` set).
fn statement(node: Node, class: Option<&str>, text: &str, idx: &LineIndex, out: &mut PytestModule) {
    let (definition, decorators) = match node.kind() {
        "decorated_definition" => {
            let mut c = node.walk();
            let decorators: Vec<Node> = node.children(&mut c).filter(|n| n.kind() == "decorator").collect();
            let Some(definition) = node.child_by_field_name("definition") else { return };
            (definition, decorators)
        }
        _ => (node, Vec::new()),
    };
    match definition.kind() {
        "function_definition" => function(definition, &decorators, class, &[], text, idx, out),
        "class_definition" if class.is_none() => {
            let Some(name) = definition.child_by_field_name("name") else { return };
            let name = text_of(name, text);
            let Some(body) = definition.child_by_field_name("body") else { return };
            // `@pytest.mark.parametrize` on the class names arguments of every test in it.
            let class_args = parametrized(&decorators, text, idx);
            let mut c = body.walk();
            for child in body.named_children(&mut c) {
                let (def, decs) = match child.kind() {
                    "decorated_definition" => {
                        let mut c2 = child.walk();
                        let decs: Vec<Node> = child.children(&mut c2).filter(|n| n.kind() == "decorator").collect();
                        match child.child_by_field_name("definition") {
                            Some(d) => (d, decs),
                            None => continue,
                        }
                    }
                    _ => (child, Vec::new()),
                };
                if def.kind() == "function_definition" {
                    function(def, &decs, Some(&name), &class_args, text, idx, out);
                }
            }
        }
        "expression_statement" if class.is_none() => plugins(definition, text, idx, &mut out.plugins),
        _ => {}
    }
}

fn function(
    def: Node,
    decorators: &[Node],
    class: Option<&str>,
    class_args: &[String],
    text: &str,
    idx: &LineIndex,
    out: &mut PytestModule,
) {
    let Some(name_node) = def.child_by_field_name("name") else { return };
    let name = text_of(name_node, text);
    let fixture = decorators.iter().find_map(|d| fixture_decorator(*d, text, idx));
    let is_test = name.starts_with("test") && class.is_none_or(|c| c.starts_with("Test"));
    if fixture.is_none() && !is_test {
        return;
    }
    let fixture_name = fixture.as_ref().and_then(|f| f.as_ref().map(|(n, _)| n.clone())).unwrap_or(name.clone());
    if let Some(f) = &fixture {
        let selection = match f {
            Some((_, string)) => *string,
            None => idx.range(name_node.start_byte(), name_node.end_byte()),
        };
        out.fixtures.push(PytestFixture { name: fixture_name.clone(), selection, class: class.map(str::to_owned) });
    }
    let Some(params) = def.child_by_field_name("parameters") else { return };
    out.slots.push(PytestFixtureSlot {
        range: idx.range(params.start_byte(), params.end_byte()),
        class: class.map(str::to_owned),
    });
    // Arguments `parametrize` supplies are no fixtures (unless indirect).
    let mut skip: Vec<String> = parametrized(decorators, text, idx);
    skip.extend_from_slice(class_args);
    let mut c = params.walk();
    for (i, param) in params.named_children(&mut c).enumerate() {
        let ident = match param.kind() {
            "identifier" => param,
            "typed_parameter" => match param.named_child(0) {
                Some(n) if n.kind() == "identifier" => n,
                _ => continue,
            },
            // Defaulted parameters, `*args`, `**kwargs`: no fixtures.
            _ => continue,
        };
        let param_name = text_of(ident, text);
        if (i == 0 && class.is_some() && (param_name == "self" || param_name == "cls")) || skip.contains(&param_name) {
            continue;
        }
        let body = def.child_by_field_name("body").map(|b| reads_of(b, &param_name, text, idx)).unwrap_or_default();
        out.uses.push(PytestFixtureUse {
            name: param_name,
            range: idx.range(ident.start_byte(), ident.end_byte()),
            kind: PytestFixtureUseKind::Parameter,
            class: class.map(str::to_owned),
            in_fixture: fixture.is_some().then(|| fixture_name.clone()),
            body,
        });
    }
}

/// The identifiers `name` in `body`, except attribute names (`x.name`) and keyword argument
/// names (`f(name=…)`). A nested function that rebinds the name is not told apart.
fn reads_of(body: Node, name: &str, text: &str, idx: &LineIndex) -> Vec<Range> {
    let mut out = Vec::new();
    let mut cursor = body.walk();
    visit(&mut cursor, &mut |n| {
        if n.kind() != "identifier" || text.get(n.byte_range()) != Some(name) {
            return;
        }
        let field_of = |parent: Node, field: &str| parent.child_by_field_name(field).is_some_and(|c| c.id() == n.id());
        if let Some(parent) = n.parent()
            && ((parent.kind() == "attribute" && field_of(parent, "attribute"))
                || (parent.kind() == "keyword_argument" && field_of(parent, "name")))
        {
            return;
        }
        out.push(idx.range(n.start_byte(), n.end_byte()));
    });
    out
}

/// `Some(None)` for `@pytest.fixture` / `@fixture(...)`, `Some(Some((name, range)))` with a
/// `name="…"` argument, `None` for any other decorator.
fn fixture_decorator(decorator: Node, text: &str, idx: &LineIndex) -> Option<Option<(String, Range)>> {
    let expr = decorator.named_child(0)?;
    let (callee, args) = match expr.kind() {
        "call" => (expr.child_by_field_name("function")?, expr.child_by_field_name("arguments")),
        _ => (expr, None),
    };
    let callee = text_of(callee, text);
    if callee != "fixture" && !callee.ends_with(".fixture") {
        return None;
    }
    let named = args.and_then(|args| {
        let mut c = args.walk();
        args.named_children(&mut c).find_map(|a| {
            if a.kind() != "keyword_argument" || a.child_by_field_name("name").map(|n| text_of(n, text))? != "name" {
                return None;
            }
            string_content(a.child_by_field_name("value")?, text, idx)
        })
    });
    Some(named)
}

/// The argument names of `@pytest.mark.parametrize("a, b", …)` decorators that are passed
/// directly (no `indirect=`).
fn parametrized(decorators: &[Node], text: &str, idx: &LineIndex) -> Vec<String> {
    let mut out = Vec::new();
    for d in decorators {
        let Some(call) = d.named_child(0).filter(|n| n.kind() == "call") else { continue };
        let Some(callee) = call.child_by_field_name("function") else { continue };
        if !text_of(callee, text).ends_with("parametrize") {
            continue;
        }
        let Some(args) = call.child_by_field_name("arguments") else { continue };
        let mut c = args.walk();
        let all: Vec<Node> = args.named_children(&mut c).collect();
        let indirect = all.iter().any(|a| {
            a.kind() == "keyword_argument"
                && a.child_by_field_name("name").is_some_and(|n| text_of(n, text) == "indirect")
                && a.child_by_field_name("value").is_some_and(|v| text_of(v, text) != "False")
        });
        if indirect {
            continue;
        }
        let first = all.iter().find(|a| a.kind() != "keyword_argument");
        let names: Vec<String> = match first {
            Some(n) if n.kind() == "string" => string_content(*n, text, idx)
                .map(|(s, _)| s.split(',').map(|p| p.trim().to_owned()).collect())
                .unwrap_or_default(),
            Some(n) if matches!(n.kind(), "list" | "tuple") => {
                let mut c = n.walk();
                n.named_children(&mut c).filter_map(|e| string_content(e, text, idx).map(|(s, _)| s)).collect()
            }
            _ => Vec::new(),
        };
        out.extend(names.into_iter().filter(|n| !n.is_empty()));
    }
    out
}

/// `usefixtures("a", "b")` and `request.getfixturevalue("a")`.
fn fixture_call(call: Node, text: &str, idx: &LineIndex, out: &mut PytestModule) {
    let Some(callee) = call.child_by_field_name("function") else { return };
    let callee_text = text_of(callee, text);
    let kind = if callee_text == "usefixtures" || callee_text.ends_with(".usefixtures") {
        PytestFixtureUseKind::UseFixtures
    } else if callee.kind() == "attribute"
        && callee.child_by_field_name("attribute").is_some_and(|a| text_of(a, text) == "getfixturevalue")
    {
        PytestFixtureUseKind::GetFixtureValue
    } else {
        return;
    };
    let Some(args) = call.child_by_field_name("arguments") else { return };
    let class = enclosing_class(call, text);
    let mut c = args.walk();
    for (i, arg) in args.named_children(&mut c).enumerate() {
        if kind == PytestFixtureUseKind::GetFixtureValue && i > 0 {
            break;
        }
        let Some((name, range)) = string_content(arg, text, idx) else { continue };
        out.slots.push(PytestFixtureSlot { range, class: class.clone() });
        if !name.is_empty() {
            out.uses.push(PytestFixtureUse {
                name,
                range,
                kind,
                class: class.clone(),
                in_fixture: None,
                body: Vec::new(),
            });
        }
    }
}

/// The top-level class a node is in, if any.
fn enclosing_class(node: Node, text: &str) -> Option<String> {
    let mut at = node.parent();
    let mut class = None;
    while let Some(n) = at {
        if n.kind() == "class_definition" {
            class = n.child_by_field_name("name").map(|c| text_of(c, text));
        }
        at = n.parent();
    }
    class
}

/// `pytest_plugins = "a"`, `= ["a", "b"]` or `= ("a",)`.
fn plugins(statement: Node, text: &str, idx: &LineIndex, out: &mut Vec<String>) {
    let Some(assign) = statement.named_child(0).filter(|n| n.kind() == "assignment") else { return };
    if assign.child_by_field_name("left").map(|l| text_of(l, text)).as_deref() != Some("pytest_plugins") {
        return;
    }
    let Some(right) = assign.child_by_field_name("right") else { return };
    match right.kind() {
        "string" => out.extend(string_content(right, text, idx).map(|(s, _)| s)),
        "list" | "tuple" => {
            let mut c = right.walk();
            out.extend(right.named_children(&mut c).filter_map(|e| string_content(e, text, idx).map(|(s, _)| s)));
        }
        _ => {}
    }
}

/// The content of a plain string literal and its range (between the quotes); none for
/// f-strings, byte strings and concatenations.
fn string_content(node: Node, text: &str, idx: &LineIndex) -> Option<(String, Range)> {
    if node.kind() != "string" {
        return None;
    }
    let mut c = node.walk();
    let parts: Vec<Node> = node.children(&mut c).collect();
    let start = parts.iter().find(|p| p.kind() == "string_start")?;
    let end = parts.iter().find(|p| p.kind() == "string_end")?;
    if text_of(*start, text).chars().any(|ch| matches!(ch, 'f' | 'F' | 'b' | 'B')) {
        return None;
    }
    if parts.iter().any(|p| p.kind() == "interpolation" || p.kind() == "escape_sequence") {
        return None;
    }
    let (from, to) = (start.end_byte(), end.start_byte());
    Some((text.get(from..to)?.to_owned(), idx.range(from, to)))
}

fn text_of(node: Node, text: &str) -> String {
    text.get(node.byte_range()).unwrap_or_default().to_owned()
}

fn visit(cursor: &mut tree_sitter::TreeCursor, f: &mut impl FnMut(Node)) {
    loop {
        f(cursor.node());
        if cursor.goto_first_child() {
            continue;
        }
        loop {
            if cursor.goto_next_sibling() {
                break;
            }
            if !cursor.goto_parent() {
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn module(src: &str) -> PytestModule {
        static S: std::sync::OnceLock<Syntax> = std::sync::OnceLock::new();
        S.get_or_init(Syntax::new).pytest_module(&LanguageId::new("python"), src)
    }

    fn names(m: &PytestModule) -> Vec<String> {
        m.fixtures
            .iter()
            .map(|f| format!("{}{}", f.class.as_deref().map(|c| format!("{c}.")).unwrap_or_default(), f.name))
            .collect()
    }

    fn uses(m: &PytestModule) -> Vec<String> {
        m.uses.iter().map(|u| format!("{:?} {}", u.kind, u.name)).collect()
    }

    const TEST_MODULE: &str = r#"import pytest
from pytest import fixture

pytest_plugins = ["pkg.fixtures", "other"]
pytestmark = pytest.mark.usefixtures("db")


@pytest.fixture
def tasks(tmp_path):
    return []


@fixture(scope="module", name="client")
def make_client(tasks, request):
    return request.getfixturevalue("server")


@pytest.mark.parametrize("title, expected", [("a", "a")])
def test_add(tasks, title, expected, monkeypatch, flag=False, *args):
    pass


def helper(tasks):
    pass


@pytest.mark.usefixtures("client", "")
class TestTasks:
    @pytest.fixture
    def tasks(self, tasks):
        return tasks

    def test_one(self, tasks: list, capsys):
        pass
"#;

    #[test]
    fn reads_definitions_uses_and_plugins() {
        let m = module(TEST_MODULE);
        assert_eq!(names(&m), ["tasks", "client", "TestTasks.tasks"]);
        assert_eq!(m.plugins, ["pkg.fixtures", "other"]);
        assert_eq!(
            uses(&m),
            [
                "Parameter tmp_path",
                "Parameter tasks",
                "Parameter request",
                "Parameter tasks",
                "Parameter monkeypatch",
                "Parameter tasks",
                "Parameter tasks",
                "Parameter capsys",
                "UseFixtures db",
                "GetFixtureValue server",
                "UseFixtures client",
            ]
        );
        // `name=` is found by its string; the overriding class fixture knows it overrides.
        let client = &m.fixtures[1];
        assert_eq!((client.selection.start.line, client.selection.start.col), (12, 31));
        let own = m.uses.iter().find(|u| u.class.as_deref() == Some("TestTasks") && u.in_fixture.is_some()).unwrap();
        assert_eq!(own.in_fixture.as_deref(), Some("tasks"));
        // The empty `usefixtures` string is still a place to complete.
        assert!(m.slots.iter().any(|s| s.range.start == s.range.end));
    }

    #[test]
    fn resolves_nearest_first_and_overrides_outward() {
        let m = module(TEST_MODULE);
        let conftest = module(
            "import pytest\n\n@pytest.fixture\ndef tasks():\n    return [1]\n\n@pytest.fixture\ndef db():\n    pass\n",
        );
        let builtins = module("from _pytest.fixtures import fixture\n\n@fixture\ndef tmp_path():\n    pass\n");
        let layers = [&m, &conftest, &builtins];
        // In the class: its own `tasks`; at module level: the module's.
        assert_eq!(resolve_fixture(&layers, "tasks", Some("TestTasks"), false), Some((0, 2)));
        assert_eq!(resolve_fixture(&layers, "tasks", None, false), Some((0, 0)));
        // The class fixture's `tasks` parameter: the module's; the module's own: conftest's.
        assert_eq!(resolve_fixture(&layers, "tasks", Some("TestTasks"), true), Some((0, 0)));
        assert_eq!(resolve_fixture(&layers, "tasks", None, true), Some((1, 0)));
        assert_eq!(resolve_fixture(&layers, "db", None, false), Some((1, 1)));
        assert_eq!(resolve_fixture(&layers, "tmp_path", None, false), Some((2, 0)));
        assert_eq!(resolve_fixture(&layers, "missing", None, false), None);
        // Completion: one entry per name, nearest first; another class's fixtures are hidden.
        let visible: Vec<&str> =
            visible_fixtures(&layers, None).iter().map(|&(l, f)| layers[l].fixtures[f].name.as_str()).collect();
        assert_eq!(visible, ["tasks", "client", "db", "tmp_path"]);
    }

    #[test]
    fn a_parameter_knows_its_reads_in_the_body() {
        let m = module("def test_a(tasks):\n    tasks.add(tasks=tasks)\n    other.tasks = len(tasks)\n");
        let u = &m.uses[0];
        let reads: Vec<(u32, u32)> = u.body.iter().map(|r| (r.start.line, r.start.col)).collect();
        assert_eq!(reads, [(1, 4), (1, 20), (2, 22)]);
        assert_eq!(m.definition_at(Pos::new(0, 6)), None);
    }

    #[test]
    fn a_later_definition_replaces_an_earlier_one() {
        let m = module("import pytest\n\n@pytest.fixture\ndef a():\n    pass\n\n@pytest.fixture\ndef a():\n    pass\n");
        assert_eq!(resolve_fixture(&[&m], "a", None, false), Some((0, 1)));
    }

    #[test]
    fn finds_the_use_and_slot_at_a_position() {
        let m = module(TEST_MODULE);
        // `def test_add(tasks, …` is on line 18; the caret right after `tasks`.
        let at = m.use_at(Pos::new(18, 18)).unwrap();
        assert_eq!(at.name, "tasks");
        assert!(m.slot_at(Pos::new(18, 13)).is_some());
        assert!(m.use_at(Pos::new(22, 11)).is_none(), "a plain function's parameters are no fixtures");
    }
}
