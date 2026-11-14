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

// ------------------------------------------------- configuration and routes

const SERVICES_YAML: &str = "services:\n    _defaults:\n        autowire: true\n    mailer.default:\n        class: App\\Service\\Mailer\n    mailer: '@mailer.default'\n";
const ROUTES_YAML: &str = "home:\n    path: /\nabout: { path: /about }\n";
const CONTROLLER: &str = "src/Controller/HomeController.php";

/// The Symfony stubs with `config/services.yaml` and `config/routes.yaml`.
fn configured() -> Project {
    Project::new(&[
        ("lib/libraries.php", LIBRARIES),
        ("lib/app.php", APP),
        ("lib/bundle.php", FRAMEWORK_BUNDLE),
        ("config/services.yaml", SERVICES_YAML),
        ("config/routes.yaml", ROUTES_YAML),
    ])
}

/// A controller whose `index()` runs `body`.
fn controller(body: &str) -> String {
    format!(
        "<?php\nnamespace App\\Controller;\n\nuse Symfony\\Bundle\\FrameworkBundle\\Controller\\AbstractController;\nuse Symfony\\Component\\Routing\\Generator\\UrlGeneratorInterface;\nuse Psr\\Container\\ContainerInterface;\n\nclass HomeController extends AbstractController\n{{\n    public function index(UrlGeneratorInterface $urls, ContainerInterface $c)\n    {{\n        {body}\n    }}\n}}\n"
    )
}

impl Project {
    fn complete_in_controller(&mut self, body: &str) -> Completions {
        let (text, pos) = caret(&controller(body));
        let doc = self.open(CONTROLLER, &text);
        let found = self.engine.completion(doc, pos, None, &CancellationToken::new()).expect("handled");
        self.engine.document_closed(doc);
        found
    }

    fn type_in_controller(&mut self, body: &str) -> String {
        let (text, pos) = caret(&controller(body));
        let doc = self.open(CONTROLLER, &text);
        let ty = self.engine.type_at(doc, pos).map(|ty| ty.to_string());
        self.engine.document_closed(doc);
        ty.unwrap_or_else(|| "<none>".to_owned())
    }
}

#[test]
fn route_names_complete_where_a_route_is_expected() {
    let mut project = configured();
    let found = project.complete_in_controller("return $this->redirectToRoute('/*|*/');");
    for label in ["home", "about", "blog_show"] {
        assert!(has(&found, label), "{label}");
    }
    let about = found.items.iter().find(|item| item.label == "about").unwrap();
    assert_eq!(about.insert_text, "about");
    assert_eq!(about.detail.as_deref(), Some("/about"));
    let show = found.items.iter().find(|item| item.label == "blog_show").unwrap();
    assert_eq!(show.detail.as_deref(), Some("/blog/{slug}"), "from the #[Route] attribute");

    let found = project.complete_in_controller("return $urls->generate('ab/*|*/');");
    assert!(has(&found, "about"));
    // Outside quotes the name is inserted quoted.
    let found = project.complete_in_controller("return path(/*|*/);");
    let home = found.items.iter().find(|item| item.label == "home").expect("home");
    assert_eq!(home.insert_text, "'home'");
    // Not where something else is expected.
    let found = project.complete_in_controller("return strlen('/*|*/');");
    assert!(!has(&found, "home"));
}

#[test]
fn undefined_route_names_are_reported() {
    let mut project = configured();
    let body = "$this->generateUrl('home');\n        $this->redirectToRoute('nope');\n        $urls->generate('blog_show');\n        path('missing');\n        $urls->generate($dynamic ?? 'x');";
    let doc = project.open(CONTROLLER, &controller(body));
    let inspected = project.engine.inspect(doc, &CancellationToken::new()).expect("inspected");
    let routes: Vec<&str> = inspected
        .problems
        .iter()
        .filter(|problem| problem.inspection == "PhpUndefinedRoute")
        .map(|problem| problem.message.as_str())
        .collect();
    assert_eq!(routes, ["Route 'nope' is not defined", "Route 'missing' is not defined"]);
    let nope = inspected.problems.iter().find(|problem| problem.message.contains("nope")).unwrap();
    let text = controller(body);
    assert_eq!(&text[nope.start as usize..nope.end as usize], "nope");
    project.engine.document_closed(doc);

    // Without any route nothing is reported.
    let mut bare = Project::new(&[("lib/libraries.php", LIBRARIES), ("lib/bundle.php", FRAMEWORK_BUNDLE)]);
    let doc = bare.open(CONTROLLER, &controller("$this->redirectToRoute('nope');"));
    let inspected = bare.engine.inspect(doc, &CancellationToken::new()).expect("inspected");
    assert!(!inspected.problems.iter().any(|problem| problem.inspection == "PhpUndefinedRoute"));
}

#[test]
fn configured_service_ids_are_typed_until_the_yaml_changes() {
    let mut project = configured();
    assert_eq!(project.type_in_controller("$c->get('mailer')/*|*/;"), "App\\Service\\Mailer");
    assert_eq!(project.type_in_controller("$c->get('mailer.default')/*|*/;"), "App\\Service\\Mailer");

    let yaml = project.root.join("config/services.yaml");
    std::fs::write(&yaml, "services:\n    mailer: { class: App\\Entity\\Product }\n").unwrap();
    project.engine.files_changed(std::slice::from_ref(&yaml), &[]);
    assert!(project.engine.wait_idle(WAIT));
    assert_eq!(project.type_in_controller("$c->get('mailer')/*|*/;"), "App\\Entity\\Product");
    assert_eq!(project.type_in_controller("$c->get('mailer.default')/*|*/;"), "mixed");
}
