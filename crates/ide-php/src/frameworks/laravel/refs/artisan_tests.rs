//! Artisan commands (the command table and the `artisanCommand` kind):
//! caret fixtures on the fixture app (`fixtures/laravel-app` with
//! `fixtures/laravel-stubs` as its `vendor/`).

use super::*;
use crate::frameworks::laravel::artisan::CommandSource;

/// A PHP file of the app around `body`, a statement of a function.
fn probe(body: &str) -> String {
    format!(
        "<?php\n\nnamespace App\\Http;\n\nuse Illuminate\\Support\\Facades\\Artisan;\nuse Illuminate\\Support\\Facades\\Schedule;\n\nfunction probe()\n{{\n    {body}\n}}\n"
    )
}

/// A command class of the app with `body` in `handle()`.
fn command_class(body: &str) -> String {
    format!(
        "<?php\n\nnamespace App\\Console\\Commands;\n\nuse Illuminate\\Console\\Command;\n\nclass Probe extends Command\n{{\n    protected $signature = 'probe';\n\n    public function handle(): void\n    {{\n        {body}\n    }}\n}}\n"
    )
}

const PUBLISH: &str = "app/Console/Commands/PublishScheduledPosts.php";
const PRUNE: &str = "app/Console/Commands/PruneDrafts.php";

impl Project {
    fn artisan_kind_at(&mut self, rel: &str, source: &str) -> Option<&'static str> {
        let (doc, pos) = self.open(rel, source);
        let parsed = self.engine.parsed_document(doc).unwrap();
        let resolver = self.engine.resolver();
        let offset = parsed.line_index().byte(pos);
        let kind = site_at(&parsed, &resolver, offset).and_then(|site| kind_of(&site, &resolver)).map(|kind| kind.id());
        self.engine.document_closed(doc);
        kind
    }

    fn artisan_hover(&mut self, body: &str) -> Option<String> {
        let (doc, pos) = self.open("app/Http/Probe.php", &probe(body));
        let found = self.engine.hover(doc, pos).map(|hover| hover.markdown);
        self.engine.document_closed(doc);
        found
    }
}

#[test]
fn the_fixture_apps_commands() {
    let project = Project::app();
    let commands = project.engine.laravel_artisan().unwrap();
    let publish = commands.get("posts:publish").unwrap();
    assert_eq!(publish.source, CommandSource::Class);
    assert_eq!(publish.class.as_deref(), Some("App\\Console\\Commands\\PublishScheduledPosts"));
    assert_eq!(publish.description, "Publish the scheduled posts whose time has come");
    assert_eq!(publish.options.len(), 1);
    assert_eq!(
        (publish.options[0].name.as_str(), publish.options[0].description.as_str(), publish.options[0].accepts_value),
        ("dry-run", "List the posts without publishing them", false)
    );
    let path = publish.path.clone().unwrap();
    assert_eq!(project.describe(&path, publish.range.unwrap()), (PUBLISH.to_owned(), 15, "posts:publish".to_owned()));
    assert_eq!(publish.class_range.unwrap().start.line, 8);
    assert_eq!(commands.in_file(&path).count(), 1);

    // `#[AsCommand]` gives the description, the signature the rest.
    let prune = commands.get("posts:prune-drafts").unwrap();
    assert_eq!(prune.description, "Delete the drafts nobody touched for a while");
    let argument = &prune.arguments[0];
    assert_eq!((argument.name.as_str(), argument.required, argument.default.as_deref()), ("days", false, Some("30")));
    assert_eq!(prune.options[0].name, "force");
    assert_eq!(prune.range.unwrap().start.line, 10);
    assert_eq!(prune.synopsis(), "posts:prune-drafts [--force] [<days>]");

    // The closure command of `routes/console.php`, and Laravel's own.
    let inspire = commands.get("inspire").unwrap();
    assert_eq!((inspire.source, inspire.description.as_str()), (CommandSource::Closure, "Display an inspiring quote"));
    let inspire_path = inspire.path.clone().unwrap();
    assert_eq!(
        project.describe(&inspire_path, inspire.range.unwrap()),
        ("routes/console.php".to_owned(), 6, "inspire".to_owned())
    );
    let migrate = commands.get("migrate").unwrap();
    assert_eq!(migrate.source, CommandSource::Framework);
    assert!(migrate.option("force").is_some());
    // The stubs' `ClosureCommand` has no name: not a command.
    assert!(commands.commands.iter().all(|command| !command.name.is_empty()));
    let names: Vec<&str> = commands.commands.iter().map(|command| command.name.as_str()).collect();
    let mut sorted = names.clone();
    sorted.sort();
    assert_eq!(names, sorted);
}

#[test]
fn place_patterns_match_command_names() {
    let mut project = Project::app();
    let probe_rel = "app/Http/Probe.php";
    let table: &[(&str, Option<&str>)] = &[
        ("Artisan::call('x/*|*/');", Some("artisanCommand")),
        ("Artisan::call('x/*|*/', ['--force' => true]);", Some("artisanCommand")),
        ("Artisan::queue('x/*|*/');", Some("artisanCommand")),
        ("Schedule::command('x/*|*/')->daily();", Some("artisanCommand")),
        ("app(\\Illuminate\\Console\\Scheduling\\Schedule::class)->command('x/*|*/');", Some("artisanCommand")),
        // A closure command's own signature isn't a usage.
        ("Artisan::command('x/*|*/', fn () => 1);", None),
        ("Artisan::call('x', ['--y/*|*/' => 1]);", None),
    ];
    for (body, expected) in table {
        assert_eq!(project.artisan_kind_at(probe_rel, &probe(body)), *expected, "{body}");
    }
    let rel = "app/Console/Commands/Probe.php";
    for body in ["$this->call('x/*|*/');", "$this->callSilent('x/*|*/');", "$this->callSilently('x/*|*/');"] {
        assert_eq!(project.artisan_kind_at(rel, &command_class(body)), Some("artisanCommand"), "{body}");
    }
}

#[test]
fn completes_command_names_then_their_options() {
    let mut project = Project::app();
    let names = project.complete_in("app/Http/Probe.php", &probe("Artisan::call('/*|*/');"));
    for name in ["posts:publish", "posts:prune-drafts", "inspire", "migrate", "make:model"] {
        assert!(names.iter().any(|found| found == name), "{name}: {names:?}");
    }
    // What was typed narrows them.
    let names = project.complete_in("app/Http/Probe.php", &probe("Artisan::call('posts:/*|*/');"));
    assert_eq!(names, ["posts:prune-drafts", "posts:publish"]);
    let options = project.complete_in("app/Http/Probe.php", &probe("Artisan::call('posts:publish --/*|*/');"));
    assert_eq!(options, ["--dry-run"]);
    // An option already given isn't offered again.
    let options =
        project.complete_in("app/Http/Probe.php", &probe("Artisan::call('posts:prune-drafts --force /*|*/');"));
    assert!(options.is_empty(), "{options:?}");
    let options = project.complete_in("app/Http/Probe.php", &probe("Artisan::call('migrate --/*|*/');"));
    assert!(options.contains(&"--force".to_owned()) && options.contains(&"--seed".to_owned()), "{options:?}");
    // In a command, for `$this->call`.
    let names = project.complete_in("app/Console/Commands/Probe.php", &command_class("$this->call('/*|*/');"));
    assert!(names.contains(&"posts:publish".to_owned()), "{names:?}");
}

#[test]
fn goto_opens_the_signature_or_the_closure() {
    let mut project = Project::app();
    assert_eq!(
        project.definition_in("app/Http/Probe.php", &probe("Artisan::call('posts:pub/*|*/lish --dry-run');")),
        [(PUBLISH.to_owned(), 15, "posts:publish".to_owned())]
    );
    assert_eq!(
        project.definition_in("app/Http/Probe.php", &probe("Schedule::command('insp/*|*/ire');")),
        [("routes/console.php".to_owned(), 6, "inspire".to_owned())]
    );
    // Laravel's own commands have no source without `vendor/` classes.
    assert!(project.definition_in("app/Http/Probe.php", &probe("Artisan::call('mig/*|*/rate');")).is_empty());
}

#[test]
fn hover_shows_the_description_and_synopsis() {
    let mut project = Project::app();
    let hover = project.artisan_hover("Artisan::call('posts:prune/*|*/-drafts');").unwrap();
    assert!(hover.contains("**artisan** `posts:prune-drafts`"), "{hover}");
    assert!(hover.contains("Delete the drafts nobody touched for a while"), "{hover}");
    assert!(hover.contains("`posts:prune-drafts [--force] [<days>]`"), "{hover}");
    assert!(hover.contains("`days` — Age of the drafts in days"), "{hover}");
    assert!(hover.contains("App\\Console\\Commands\\PruneDrafts"), "{hover}");
}

#[test]
fn finds_usages_from_the_signature() {
    let mut project = Project::app();
    let text = std::fs::read_to_string(project.root.join(PUBLISH)).unwrap().replace("\r\n", "\n");
    let source = text.replacen("'posts:publish {", "'posts:pub/*|*/lish {", 1);
    let found: Vec<(String, u32, String)> =
        project.references(PUBLISH, &source).into_iter().map(|(path, line, text, _)| (path, line, text)).collect();
    for expected in [
        (PUBLISH.to_owned(), 15, "posts:publish".to_owned()),
        (PRUNE.to_owned(), 16, "posts:publish".to_owned()),
        ("routes/console.php".to_owned(), 10, "posts:publish".to_owned()),
    ] {
        assert!(found.contains(&expected), "{expected:?} in {found:?}");
    }
}
