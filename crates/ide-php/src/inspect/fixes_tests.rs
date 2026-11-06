//! Tests of the quick-fixes and the context actions: the text before and
//! after each.

use std::path::Path;

use super::*;
use crate::stubs::PhpVersion;

const BOOK: &str = "<?php\nnamespace App\\Model;\n\nclass Book\n{\n    public string $title = '';\n\n    public function title(): string\n    {\n        return $this->title;\n    }\n}\n";

fn project() -> Project {
    let p = Project::with_files(&[
        ("composer.json", r#"{"autoload": {"psr-4": {"App\\": "src/"}}}"#),
        ("src/Model/Book.php", BOOK),
    ]);
    p.engine.set_inspections(Inspections::builtin());
    p
}

fn fix<'a>(found: &'a Inspected, title: &str) -> &'a QuickFix {
    let all: Vec<&QuickFix> = found.problems.iter().flat_map(|p| &p.fixes).collect();
    all.iter()
        .copied()
        .find(|f| f.title == title)
        .unwrap_or_else(|| panic!("no fix {title:?} in {:?}", all.iter().map(|f| &f.title).collect::<Vec<_>>()))
}

fn has_fix(found: &Inspected, title: &str) -> bool {
    found.problems.iter().flat_map(|p| &p.fixes).any(|f| f.title == title)
}

/// `text` (the file at `path`) after the edit's changes to it.
fn edited(edit: &WorkspaceEdit, path: &Path, text: &str) -> String {
    let edits = edit
        .files
        .iter()
        .find_map(|f| match f {
            FileEdit::Edit { path: p, edits, .. } if &**p == path => Some(edits.clone()),
            _ => None,
        })
        .unwrap_or_else(|| panic!("no edit of {}: {edit:?}", path.display()));
    let mut document = ide_text::Document::new(text);
    document.apply_edits(&edits).unwrap();
    document.text().to_string()
}

#[test]
fn import_a_class() {
    let mut p = project();
    let (text, pos) = caret("<?php\nnamespace Other;\n\nnew Bo/*|*/ok();\n");
    let doc = p.open("src/other.php", &text);
    let actions = p.engine.code_actions(doc, Range::new(pos, pos), &[]).unwrap();
    let import = actions.iter().find(|a| a.title == "Import class 'App\\Model\\Book'").expect("import");
    assert_eq!(applied(&text, &import.edit), "<?php\nnamespace Other;\n\nuse App\\Model\\Book;\n\nnew Book();\n");
    // No autoload root covers `Other`: nothing to create.
    assert!(!actions.iter().any(|a| a.title.starts_with("Create class")));
}

#[test]
fn create_members_in_another_file() {
    let mut p = project();
    let text = r#"<?php
namespace App;

use App\Model\Book;

function f(Book $b, int $n): void
{
    $b->save($b, $n, 'x', flag: true);
    echo $b->pages;
    echo Book::LIMIT;
}
"#;
    let found = p.inspect(text);
    let book = p.root.join("src/Model/Book.php");
    let method = fix(&found, "Create method 'save' in 'Book'");
    assert_eq!(
        edited(&method.edit, &book, BOOK),
        "<?php\nnamespace App\\Model;\n\nclass Book\n{\n    public string $title = '';\n\n    public function title(): string\n    {\n        return $this->title;\n    }\n\n    public function save(Book $b, int $n, string $arg3, bool $flag)\n    {\n    }\n}\n"
    );
    let property = fix(&found, "Create property '$pages' in 'Book'");
    assert_eq!(
        edited(&property.edit, &book, BOOK),
        "<?php\nnamespace App\\Model;\n\nclass Book\n{\n    public string $title = '';\n    public $pages;\n\n    public function title(): string\n    {\n        return $this->title;\n    }\n}\n"
    );
    let constant = fix(&found, "Create constant 'LIMIT' in 'Book'");
    assert_eq!(
        edited(&constant.edit, &book, BOOK),
        "<?php\nnamespace App\\Model;\n\nclass Book\n{\n    public const LIMIT = null;\n\n    public string $title = '';\n\n    public function title(): string\n    {\n        return $this->title;\n    }\n}\n"
    );
}

#[test]
fn create_members_in_the_same_file() {
    let mut p = project();
    let text = r#"<?php
namespace App;

class Shelf {}

class Box
{
    public function run(): void
    {
        $this->helper();
        self::make();
        echo (new Shelf())->count;
    }
}
"#;
    let found = p.inspect(text);
    assert_eq!(
        applied(text, &fix(&found, "Create method 'helper' in 'Box'").edit),
        text.replace(
            "        echo (new Shelf())->count;\n    }\n}\n",
            "        echo (new Shelf())->count;\n    }\n\n    private function helper()\n    {\n    }\n}\n"
        )
    );
    assert!(
        applied(text, &fix(&found, "Create method 'make' in 'Box'").edit)
            .contains("    }\n\n    private static function make()\n    {\n    }\n}\n")
    );
    assert_eq!(
        applied(text, &fix(&found, "Create property '$count' in 'Shelf'").edit),
        text.replace("class Shelf {}", "class Shelf {\n    public $count;\n}")
    );
}

#[test]
fn create_a_class_where_the_autoloader_looks() {
    let mut p = project();
    let text = "<?php\ndeclare(strict_types=1);\nnamespace App\\Service;\n\nnew Mailer();\nclass Job implements Queued {}\nnew \\Other\\Thing();\n";
    let found = p.inspect(text);
    let create = fix(&found, "Create class 'Mailer'");
    let file = p.root.join("src").join("Service").join("Mailer.php");
    let [FileEdit::Create { path, overwrite: false }, FileEdit::Edit { path: edited_path, edits, .. }] =
        create.edit.files.as_slice()
    else {
        panic!("{:?}", create.edit)
    };
    assert_eq!((&**path, &**edited_path), (file.as_path(), file.as_path()));
    assert_eq!(
        edits[0].new_text,
        "<?php\n\ndeclare(strict_types=1);\n\nnamespace App\\Service;\n\nclass Mailer\n{\n}\n"
    );
    assert!(has_fix(&found, "Create interface 'Queued'"));
    assert!(!has_fix(&found, "Create class 'Thing'"), "no autoload root for `Other`");
    // Not when the file exists.
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(&file, "<?php\n").unwrap();
    assert!(!has_fix(&p.inspect(text), "Create class 'Mailer'"));
}

#[test]
fn initialize_and_remove_variables() {
    let mut p = project();
    let text = r#"<?php
namespace App;

function f(bool $flag): int
{
    if ($flag) {
        $a = 1;
    }
    echo $missing;
    $unused = 5;
    $called = strlen('x');
    return $a;
}
"#;
    let found = p.inspect(text);
    assert_eq!(
        applied(text, &fix(&found, "Initialize variable '$missing'").edit),
        text.replace("{\n    if ($flag)", "{\n    $missing = null;\n    if ($flag)")
    );
    assert_eq!(
        applied(text, &fix(&found, "Initialize variable '$a'").edit),
        text.replace("{\n    if ($flag)", "{\n    $a = null;\n    if ($flag)")
    );
    let unused = found.problems.iter().find(|p| p.message.contains("'$unused'")).unwrap();
    assert_eq!(applied(text, &unused.fixes[0].edit), text.replace("    $unused = 5;\n", ""));
    let called = found.problems.iter().find(|p| p.message.contains("'$called'")).unwrap();
    assert_eq!(called.fixes[0].title, "Remove unused variable '$called'");
    assert_eq!(applied(text, &called.fixes[0].edit), text.replace("$called = strlen", "strlen"));
}

const REPO: &str = r#"<?php
namespace App;

use App\Model\Book;

class Repo
{
    /** @param int $limit */
    public function fi/*find*/nd($li/*limit*/mit, $na/*name*/me = 'x', $book = null)
    {
        if ($limit > 1) {
            return new Book();
        }
        return null;
    }

    public function a/*all*/ll(array $filter)
    {
        return $filter;
    }
}

function to/*total*/tal($a = 0) { return 1; }
"#;

const MARKERS: [&str; 5] = ["find", "limit", "name", "all", "total"];

/// The text with the caret at the marker `/*name*/` (the other markers
/// dropped), and the caret.
fn marked(name: &str) -> (String, Pos) {
    let mut text = REPO.to_owned();
    for marker in MARKERS {
        let with = if marker == name { "/*|*/" } else { "" };
        text = text.replace(&format!("/*{marker}*/"), with);
    }
    if !text.contains("/*|*/") {
        text = text.replacen("return $filter", "/*|*/return $filter", 1);
    }
    caret(&text)
}

/// The context actions at the caret marked `name`, at PHP `version`.
fn rewrites(p: &mut Project, name: &str) -> (String, Vec<ImportAction>) {
    let (text, pos) = marked(name);
    let doc = p.open("src/Repo.php", &text);
    let actions = p.engine.code_actions(doc, Range::new(pos, pos), &[REWRITE.to_owned()]).unwrap();
    p.engine.document_closed(doc);
    assert!(actions.iter().all(|a| a.kind == REWRITE));
    (text, actions)
}

fn titles(actions: &[ImportAction]) -> Vec<&str> {
    actions.iter().map(|a| a.title.as_str()).collect()
}

#[test]
fn add_types_and_phpdoc() {
    let mut p = project();
    let (text, actions) = rewrites(&mut p, "find");
    assert_eq!(titles(&actions), ["Add return type '?Book'", "Update PHPDoc"]);
    assert!(applied(&text, &actions[0].edit).contains("$book = null): ?Book\n"));
    assert!(
        applied(&text, &actions[1].edit).contains(
            "    /**\n     * @param int $limit\n     * @param string $name\n     * @param mixed $book\n     */\n    public function find("
        ),
        "{}",
        applied(&text, &actions[1].edit)
    );

    let (text, actions) = rewrites(&mut p, "limit");
    assert_eq!(titles(&actions), ["Add return type '?Book'", "Add type 'int' to parameter '$limit'", "Update PHPDoc"]);
    assert!(applied(&text, &actions[1].edit).contains("find(int $limit, $name"));
    let (text, actions) = rewrites(&mut p, "name");
    assert_eq!(actions[1].title, "Add type 'string' to parameter '$name'");
    assert!(applied(&text, &actions[1].edit).contains(", string $name = 'x',"));

    let (text, actions) = rewrites(&mut p, "all");
    assert_eq!(titles(&actions), ["Add return type 'array'", "Add PHPDoc"]);
    assert!(applied(&text, &actions[0].edit).contains("all(array $filter): array\n"));
    assert!(applied(&text, &actions[1].edit).contains(
        "    }\n\n    /**\n     * @param array $filter\n     * @return array\n     */\n    public function all("
    ));

    let (text, actions) = rewrites(&mut p, "total");
    assert_eq!(titles(&actions), ["Add return type 'int'", "Add PHPDoc"]);
    assert!(applied(&text, &actions[1].edit).contains("/**\n * @param int $a\n * @return int\n */\nfunction total("));

    // Nothing away from the declarations; nothing for other kinds.
    let (text, pos) = marked("none");
    let doc = p.open("src/Repo.php", &text);
    let body = Range::new(pos, pos);
    assert!(p.engine.code_actions(doc, body, &[REWRITE.to_owned()]).unwrap().is_empty());
    let (_, at) = marked("find");
    assert!(
        p.engine
            .code_actions(doc, Range::new(at, at), &[QUICKFIX.to_owned()])
            .unwrap()
            .iter()
            .all(|a| a.kind == QUICKFIX)
    );
}

#[test]
fn types_follow_the_language_level() {
    let mut p = project();
    p.engine.set_stub_filter(StubFilter::all_extensions(PhpVersion::new(7, 0)));
    let (_, actions) = rewrites(&mut p, "find");
    assert_eq!(titles(&actions), ["Update PHPDoc"], "`?Book` needs PHP 7.1");
    let (_, actions) = rewrites(&mut p, "total");
    assert_eq!(titles(&actions)[0], "Add return type 'int'");
}

#[test]
fn native_types() {
    use crate::names::NameScope;
    use crate::types::Type;
    let mut scope = NameScope::for_namespace("App");
    scope.add_import(crate::names::NameKind::ClassLike, "App\\Model\\Book", None);
    let at = |major, minor| PhpVersion::new(major, minor);
    let native = |ty: Type, level| fixes::native_type(&ty, &scope, level);
    let book = Type::named("App\\Model\\Book");
    let other = Type::named("Lib\\Thing");
    assert_eq!(native(book.clone(), at(8, 3)).as_deref(), Some("Book"));
    assert_eq!(native(other.clone(), at(8, 3)).as_deref(), Some("\\Lib\\Thing"));
    assert_eq!(native(book.clone().nullable(), at(7, 1)).as_deref(), Some("?Book"));
    assert_eq!(native(book.clone().nullable(), at(7, 0)), None);
    assert_eq!(native(Type::union([Type::Int, Type::string()]), at(8, 0)).as_deref(), Some("int|string"));
    assert_eq!(native(Type::union([Type::Int, Type::string()]), at(7, 4)), None);
    assert_eq!(
        native(Type::union([Type::Int, Type::string(), Type::Null]), at(8, 0)).as_deref(),
        Some("int|string|null")
    );
    assert_eq!(native(Type::list_of(Type::Int), at(7, 0)).as_deref(), Some("array"));
    assert_eq!(native(Type::LiteralInt(3), at(7, 0)).as_deref(), Some("int"));
    assert_eq!(native(Type::Mixed, at(7, 4)), None);
    assert_eq!(native(Type::Void, at(7, 1)).as_deref(), Some("void"));
    assert_eq!(native(Type::Template("T".into()), at(8, 3)), None);
    assert_eq!(native(Type::intersection([book, other]), at(8, 1)).as_deref(), Some("Book&\\Lib\\Thing"));
}
