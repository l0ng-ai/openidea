//! Gates, policies, guards and password brokers (`gate`, `authGuard`,
//! `passwordBroker`, and the `can:`/`auth:` middleware parameters): caret
//! fixtures on the fixture app (`fixtures/laravel-app` with
//! `fixtures/laravel-stubs` as its `vendor/`).

use ide_core::Severity;

use super::*;
use crate::blade::BladeDocument;
use crate::frameworks::laravel::refs::middleware::{Parameter, parameter_at};

/// A PHP file of the app around `body`, a statement of a function with a
/// post, a tag and a user.
fn probe(body: &str) -> String {
    format!(
        "<?php\n\nnamespace App\\Http;\n\nuse App\\Models\\Post;\nuse App\\Models\\Tag;\nuse App\\Models\\User;\nuse Illuminate\\Support\\Facades\\Auth;\nuse Illuminate\\Support\\Facades\\Gate;\nuse Illuminate\\Support\\Facades\\Password;\nuse Illuminate\\Support\\Facades\\Route;\n\nfunction probe(Post $post, Tag $tag, User $user)\n{{\n    {body}\n}}\n"
    )
}

impl Project {
    fn auth_kind_at(&mut self, body: &str) -> Option<&'static str> {
        let (doc, pos) = self.open("app/Http/Probe.php", &probe(body));
        let parsed = self.engine.parsed_document(doc).unwrap();
        let resolver = self.engine.resolver();
        let offset = parsed.line_index().byte(pos);
        let kind = site_at(&parsed, &resolver, offset).and_then(|site| kind_of(&site, &resolver)).map(|kind| kind.id());
        self.engine.document_closed(doc);
        kind
    }

    fn auth_complete(&mut self, body: &str) -> Vec<String> {
        let mut found = self.complete_in("app/Http/Probe.php", &probe(body));
        found.sort();
        found
    }

    fn auth_goto(&mut self, body: &str) -> Vec<(String, u32, String)> {
        self.definition_in("app/Http/Probe.php", &probe(body))
    }

    fn auth_hover(&mut self, body: &str) -> Option<String> {
        let (doc, pos) = self.open("app/Http/Probe.php", &probe(body));
        let found = self.engine.hover(doc, pos).map(|hover| hover.markdown);
        self.engine.document_closed(doc);
        found
    }

    /// The unknown-ability problems of `body`: `(line, message, severity)`.
    fn ability_problems(&mut self, body: &str) -> Vec<(u32, String, Severity)> {
        let (doc, _) = self.open("app/Http/Probe.php", &format!("{}/*|*/", probe(body)));
        let inspected = self.engine.inspect(doc, &CancellationToken::new()).unwrap();
        self.engine.document_closed(doc);
        inspected
            .diagnostics
            .iter()
            .filter(|d| d.code.as_deref() == Some("PhpUnknownAbility"))
            .map(|d| (d.range.start.line, d.message.clone(), d.severity))
            .collect()
    }

    /// A file of the app with `from` replaced by `to` (holding the caret).
    fn app_file_with(&self, rel: &str, from: &str, to: &str) -> String {
        let text = std::fs::read_to_string(self.root.join(rel)).unwrap().replace("\r\n", "\n");
        assert!(text.contains(from), "{from}");
        text.replacen(from, to, 1)
    }

    fn template_completion(&self, source: &str) -> Vec<String> {
        let (text, pos) = caret(source);
        let path = self.root.join("resources/views/probe.blade.php");
        let blade = BladeDocument { doc: DocId(93), path: &path, version: 1, text: &text };
        let found = self.engine.blade_completion(&blade, pos, None, &CancellationToken::new());
        self.engine.document_closed(DocId(93));
        found.map(|found| found.items.into_iter().map(|item| item.label).collect()).unwrap_or_default()
    }
}

const PROVIDER: &str = "app/Providers/AppServiceProvider.php";
const POLICY: &str = "app/Policies/PostPolicy.php";

#[test]
fn the_fixture_apps_gates_and_policies() {
    let project = Project::app();
    let facts = project.engine.laravel_auth().unwrap();
    let gates: Vec<(&str, u32)> = facts.gates.iter().map(|gate| (gate.name.as_str(), gate.range.start.line)).collect();
    assert_eq!(gates, [("publish-posts", 26), ("edit-post", 27)]);
    assert_eq!(facts.policy_classes, ["App\\Policies\\PostPolicy"]);
    assert!(facts.policies.is_empty());
    let cx = project.engine.ref_context().unwrap();
    assert_eq!(gate::policy_for(&cx, &facts, "App\\Models\\Post").as_deref(), Some("App\\Policies\\PostPolicy"));
    assert_eq!(gate::policy_for(&cx, &facts, "App\\Models\\Tag"), None);
    assert_eq!(
        gate::models_of(&cx, &["post".to_owned(), "App\\Models\\Tag".to_owned()]),
        ["App\\Models\\Post", "App\\Models\\Tag"]
    );
    // Guards and brokers of `config/auth.php`.
    let guards: Vec<(String, Option<String>)> =
        gate::guard_entries(&cx).into_iter().map(|entry| (entry.name, entry.detail)).collect();
    assert_eq!(
        guards,
        [("admin".to_owned(), Some("session".to_owned())), ("web".to_owned(), Some("session".to_owned()))]
    );
}

#[test]
fn place_patterns_match_abilities_guards_and_brokers() {
    let mut project = Project::app();
    let table: &[(&str, Option<&str>)] = &[
        ("Gate::allows('x/*|*/');", Some("gate")),
        ("Gate::denies('x/*|*/', $post);", Some("gate")),
        ("Gate::authorize('x/*|*/', $post);", Some("gate")),
        ("Gate::any(['a', 'b/*|*/'], $post);", Some("gate")),
        ("Gate::check('a/*|*/');", Some("gate")),
        ("$user->can('x/*|*/', $post);", Some("gate")),
        ("$user->cannot(['x/*|*/']);", Some("gate")),
        ("Route::get('/', fn () => 1)->can('x/*|*/', 'post');", Some("gate")),
        ("auth('w/*|*/');", Some("authGuard")),
        ("Auth::guard('w/*|*/');", Some("authGuard")),
        ("auth()->guard('w/*|*/');", Some("authGuard")),
        ("Password::broker('u/*|*/');", Some("passwordBroker")),
        // Not abilities: the gate's definition, a second argument.
        ("Gate::define('x/*|*/', fn () => true);", None),
        ("Gate::allows('x', 'y/*|*/');", None),
    ];
    for (body, expected) in table {
        assert_eq!(project.auth_kind_at(body), *expected, "{body}");
    }
    // A controller using `AuthorizesRequests`.
    let source = "<?php\nnamespace App\\Http\\Controllers;\n\nuse App\\Models\\Post;\nuse Illuminate\\Foundation\\Auth\\Access\\AuthorizesRequests;\n\nclass ProbeController extends Controller\n{\n    use AuthorizesRequests;\n\n    public function show(Post $post)\n    {\n        $this->authorize('up/*|*/', $post);\n    }\n}\n";
    let found = project.complete_in("app/Http/Controllers/ProbeController.php", source);
    assert!(found.contains(&"update".to_owned()), "{found:?}");
}

#[test]
fn completes_gates_and_the_models_policy_methods() {
    let mut project = Project::app();
    let all = ["create", "delete", "edit-post", "publish-posts", "update"];
    assert_eq!(project.auth_complete("Gate::allows('/*|*/', $post);"), all);
    assert_eq!(project.auth_complete("Gate::allows('/*|*/', Post::class);"), all);
    assert_eq!(project.auth_complete("$user->can('/*|*/', [$post]);"), all);
    // Without a model: every policy's methods.
    assert_eq!(project.auth_complete("Gate::allows('/*|*/');"), all);
    // A model without a policy: the gates alone.
    assert_eq!(project.auth_complete("Gate::allows('/*|*/', $tag);"), ["edit-post", "publish-posts"]);
    // A route's `can()`, with a route parameter.
    assert_eq!(project.auth_complete("Route::get('/', fn () => 1)->can('/*|*/', 'post');"), all);
    // The `can:` middleware: the ability, then the model's route parameter.
    let found = project.auth_complete("Route::get('/', fn () => 1)->middleware('can:/*|*/,post');");
    assert_eq!(found, all);
    let found = project.auth_complete("Route::get('/', fn () => 1)->middleware(['auth:/*|*/']);");
    assert_eq!(found, ["admin", "web"]);
}

#[test]
fn goes_to_the_gate_or_the_policy_method() {
    let mut project = Project::app();
    let update = (POLICY.to_owned(), 14, "update".to_owned());
    assert_eq!(project.auth_goto("Gate::allows('upd/*|*/ate', $post);"), std::slice::from_ref(&update));
    assert_eq!(project.auth_goto("$user->can('upd/*|*/ate', Post::class);"), std::slice::from_ref(&update));
    assert_eq!(
        project.auth_goto("Gate::allows('edit-p/*|*/ost');"),
        [(PROVIDER.to_owned(), 27, "edit-post".to_owned())]
    );
    let found = project.auth_goto("Route::get('/', fn () => 1)->middleware('can:upd/*|*/ate,post');");
    assert_eq!(found, [update]);
    // The middleware's own name still goes to the middleware.
    assert!(project.auth_goto("Route::get('/', fn () => 1)->middleware('ca/*|*/n:update,post');").is_empty());
}

#[test]
fn hovers_an_ability() {
    let mut project = Project::app();
    let hover = project.auth_hover("Gate::allows('upd/*|*/ate', $post);").unwrap();
    assert_eq!(hover, "**ability** `update`\n\n`PostPolicy::update()`");
    let hover = project.auth_hover("Gate::allows('publish/*|*/-posts');").unwrap();
    assert_eq!(hover, "**ability** `publish-posts`\n\nGate · AppServiceProvider");
    let hover = project.auth_hover("Route::get('/', fn () => 1)->middleware('can:delete,po/*|*/st');").unwrap();
    assert_eq!(hover, "**ability** `delete`\n\n`PostPolicy::delete()`");
}

#[test]
fn reports_unknown_abilities() {
    let mut project = Project::app();
    let body = "Gate::allows('update', $post);\n    Gate::allows('publish', $post);\n    Gate::allows('update', $tag);\n    Gate::allows('nothing');\n    Gate::allows('edit-post', $tag);\n    $user->can('delete', Post::class);\n    Gate::allows($dynamic);";
    let found = project.ability_problems(body);
    assert_eq!(
        found,
        [
            (
                15,
                "Unknown ability 'publish': no gate defines it and PostPolicy has no such method".to_owned(),
                Severity::Warning
            ),
            (16, "Unknown ability 'update': no gate defines it and Tag has no policy".to_owned(), Severity::Warning),
            (17, "Unknown ability 'nothing': no gate or policy defines it".to_owned(), Severity::Warning),
        ]
    );
    // Blade's `@can`.
    let problems = project.engine.blade_problems("@can('nope', $post)\n@endcan\n@can('edit-post')\n@endcan\n");
    let found: Vec<(u32, Option<&str>)> =
        problems.iter().map(|problem| (problem.range.start.line, problem.code.as_deref())).collect();
    assert_eq!(found, [(0, Some("PhpUnknownAbility"))]);
}

#[test]
fn completes_abilities_and_guards_in_blade() {
    let project = Project::app();
    let found = project.template_completion("@can('/*|*/')\n@endcan\n");
    for expected in ["edit-post", "publish-posts", "update"] {
        assert!(found.contains(&expected.to_owned()), "{expected} in {found:?}");
    }
    let found = project.template_completion("@auth('/*|*/')\n@endauth\n");
    assert!(found.contains(&"admin".to_owned()), "{found:?}");
}

#[test]
fn finds_and_renames_a_gate_from_its_definition() {
    let mut project = Project::app();
    let source = project.app_file_with(PROVIDER, "Gate::define('edit-post'", "Gate::define('edit-/*|*/post'");
    let found = project.references(PROVIDER, &source);
    let found: Vec<(String, u32, String)> = found.into_iter().map(|(path, line, text, _)| (path, line, text)).collect();
    assert_eq!(
        found,
        [
            (PROVIDER.to_owned(), 27, "edit-post".to_owned()),
            ("resources/views/posts/show.blade.php".to_owned(), 13, "edit-post".to_owned()),
        ]
    );
    let edits = project.rename(PROVIDER, &source, "modify-post");
    assert_eq!(
        edits,
        [
            (PROVIDER.to_owned(), 27, "edit-post".to_owned()),
            ("resources/views/posts/show.blade.php".to_owned(), 13, "edit-post".to_owned()),
        ]
    );
    // A policy method isn't renamed as a string.
    let (doc, pos) = project.open("app/Http/Probe.php", &probe("Gate::allows('upd/*|*/ate', $post);"));
    assert_eq!(project.engine.prepare_rename(doc, pos).flatten(), None);
}

#[test]
fn guards_and_brokers_come_from_the_auth_config() {
    let mut project = Project::app();
    assert_eq!(project.auth_complete("auth('/*|*/');"), ["admin", "web"]);
    assert_eq!(project.auth_complete("Auth::guard('/*|*/');"), ["admin", "web"]);
    assert_eq!(project.auth_complete("Password::broker('/*|*/');"), ["users"]);
    assert_eq!(project.auth_goto("auth('ad/*|*/min');"), [("config/auth.php".to_owned(), 15, "admin".to_owned())]);
    assert_eq!(
        project.auth_goto("Password::broker('us/*|*/ers');"),
        [("config/auth.php".to_owned(), 34, "users".to_owned())]
    );
    let hover = project.auth_hover("auth('w/*|*/eb');").unwrap();
    assert_eq!(hover, "**guard** `web`\n\ndriver: `session`");
}

#[test]
fn middleware_parameters() {
    let ability = |name, subjects: &[&str]| Parameter::Ability {
        name,
        subjects: subjects.iter().map(|subject| (*subject).to_owned()).collect(),
    };
    assert_eq!(parameter_at("can:update,post", 6), Some((ability("update", &["post"]), 4, 10)));
    assert_eq!(parameter_at("can:,post", 4), Some((ability("", &["post"]), 4, 4)));
    assert_eq!(parameter_at("can:update,post", 12), None);
    assert_eq!(parameter_at("can:update,post", 2), None);
    assert_eq!(parameter_at("auth:web,admin", 10), Some((Parameter::Guard("admin"), 9, 14)));
    assert_eq!(parameter_at("guest:web", 6), Some((Parameter::Guard("web"), 6, 9)));
    assert_eq!(parameter_at("throttle:60,1", 10), None);
    assert_eq!(parameter_at("auth", 2), None);
}
