//! Completion, hover and goto for Doctrine's magic repository finders, on
//! the stubs of the Symfony provider's tests.

use super::*;
use crate::complete::{CompletionKind, Completions};
use crate::types::provider::symfony::tests::{APP, FRAMEWORK_BUNDLE, LIBRARIES};

const MAIN: &str = "bin/main.php";

/// `bin/main.php` importing the stubs' classes, then `body`.
fn main(body: &str) -> String {
    format!(
        "<?php\nnamespace Main;\n\nuse App\\Repository\\ProductRepository;\nuse Doctrine\\ORM\\EntityManagerInterface;\nuse App\\Entity\\Product;\n\n{body}\n"
    )
}

fn symfony(installed: bool) -> Project {
    let mut files = vec![("lib/libraries.php", LIBRARIES), ("lib/app.php", APP)];
    if installed {
        files.push(("lib/bundle.php", FRAMEWORK_BUNDLE));
    }
    Project::new(&files)
}

fn line_of(text: &str, needle: &str) -> u32 {
    text.lines().position(|line| line.contains(needle)).unwrap_or_else(|| panic!("{needle}")) as u32
}

impl Project {
    fn complete_symfony(&mut self, body: &str) -> Completions {
        let (text, pos) = caret(&main(body));
        let doc = self.open(MAIN, &text);
        let found = self.engine.completion(doc, pos, None, &CancellationToken::new()).expect("handled");
        self.engine.document_closed(doc);
        found
    }

    fn hover_symfony(&mut self, body: &str) -> String {
        let (text, pos) = caret(&main(body));
        let doc = self.open(MAIN, &text);
        let hover = self.engine.hover(doc, pos);
        self.engine.document_closed(doc);
        hover.unwrap_or_else(|| panic!("a hover in {body}")).markdown
    }
}

fn has(found: &Completions, label: &str) -> bool {
    found.items.iter().any(|item| item.label == label)
}

#[test]
fn completion_lists_magic_finders_of_the_entity_fields() {
    let mut project = symfony(true);
    let found = project.complete_symfony("function f(ProductRepository $r) { $r->/*|*/ }");
    for label in ["findOneByName", "findById", "countByName", "cheapest", "findOneBy"] {
        assert!(has(&found, label), "{label}");
    }
    let finder = found.items.iter().find(|item| item.label == "findOneByName").expect("findOneByName");
    assert_eq!(finder.kind, CompletionKind::Method);

    // Through getRepository().
    let found = project
        .complete_symfony("function f(EntityManagerInterface $em) { $em->getRepository(Product::class)->/*|*/ }");
    assert!(has(&found, "findOneByName"));

    // Off without symfony/framework-bundle.
    let mut project = symfony(false);
    let found = project.complete_symfony("function f(ProductRepository $r) { $r->/*|*/ }");
    assert!(!has(&found, "findOneByName"));
    assert!(has(&found, "cheapest"));
}

#[test]
fn hover_and_goto_on_a_magic_finder() {
    let mut project = symfony(true);
    let text = project.hover_symfony("function f(ProductRepository $r) { $r->findOne/*|*/ByName('a'); }");
    assert!(text.contains("findOneBy"), "{text}");

    let body = "function f(ProductRepository $r) { $r->findOne/*|*/ByName('a'); }";
    let found = project.definition(MAIN, &main(body)).expect("handled");
    // `EntityRepository::findOneBy()`, where `__call` ends up.
    let line = line_of(LIBRARIES, "public function findOneBy(array $criteria) { return null; }");
    assert_eq!(found, [target("lib/libraries.php", line, "findOneBy")]);
}
