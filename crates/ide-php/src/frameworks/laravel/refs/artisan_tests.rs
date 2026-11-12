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
        // An option key is an `artisanOption`.
        ("Artisan::call('x', ['--y/*|*/' => 1]);", Some("artisanOption")),
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

impl Project {
    /// The `(line, message)` of the diagnostics with code `code` in the
    /// file `rel` holding `source` (without a caret).
    fn problems_in(&mut self, rel: &str, source: &str, code: &str) -> Vec<(u32, String)> {
        let (doc, _) = self.open(rel, &format!("{source}/*|*/"));
        let inspected = self.engine.inspect(doc, &ide_core::CancellationToken::new()).unwrap();
        self.engine.document_closed(doc);
        inspected
            .diagnostics
            .iter()
            .filter(|d| d.code.as_deref() == Some(code))
            .map(|d| (d.range.start.line, d.message.clone()))
            .collect()
    }
}

const UNKNOWN: &str = "PhpUnknownArtisanCommand";

#[test]
fn reports_unknown_commands_only_with_vendor() {
    let mut project = Project::app();
    assert!(project.engine.laravel_artisan().unwrap().vendor);
    let body = [
        "Artisan::call('posts:publish --dry-run');",
        "Artisan::call('migrate');",
        "Artisan::call('inspire');",
        "Artisan::call('posts:nowhere --force');",
        "Schedule::command('nowhere')->daily();",
        "Artisan::call(\"posts:{$x}\");",
    ]
    .join("\n    ");
    assert_eq!(
        project.problems_in("app/Http/Probe.php", &probe(&body), UNKNOWN),
        [
            (12, "Artisan command 'posts:nowhere' is not defined".to_owned()),
            (13, "Artisan command 'nowhere' is not defined".to_owned()),
        ]
    );
    // In a command class, for `$this->call`.
    let found =
        project.problems_in("app/Console/Commands/Probe.php", &command_class("$this->call('nowhere');"), UNKNOWN);
    assert_eq!(found.len(), 1, "{found:?}");

    // Without `vendor/` the packages' commands aren't known: nothing is reported.
    let mut bare = Project::new(&[
        ("composer.json", r#"{"require": {"laravel/framework": "^11.0"}, "autoload": {"psr-4": {"App\\": "app/"}}}"#),
        ("artisan", "#!/usr/bin/env php\n"),
    ]);
    assert!(!bare.engine.laravel_artisan().unwrap().vendor);
    assert!(bare.problems_in("app/Http/Probe.php", &probe("Artisan::call('nowhere');"), UNKNOWN).is_empty());
}

#[test]
fn symfony_commands_are_commands() {
    let base = "<?php\n\nnamespace Symfony\\Component\\Console\\Command;\n\nclass Command\n{\n    protected static $defaultName;\n}\n";
    let legacy = "<?php\n\nnamespace App\\Console;\n\nuse Symfony\\Component\\Console\\Attribute\\AsCommand;\nuse Symfony\\Component\\Console\\Command\\Command;\n\nclass Legacy extends Command\n{\n    protected static $defaultName = 'legacy:run';\n}\n\n#[AsCommand(name: 'legacy:attribute')]\nclass Attributed extends Command\n{\n}\n";
    let mut project = Project::app_with(&[("app/SymfonyCommand.php", base), ("app/Console/Legacy.php", legacy)]);
    let commands = project.engine.laravel_artisan().unwrap();
    for name in ["legacy:run", "legacy:attribute"] {
        let command = commands.get(name).unwrap_or_else(|| panic!("{name}"));
        assert_eq!(command.source, CommandSource::Class);
    }
    let body = "Artisan::call('legacy:run');\n    Artisan::call('legacy:attribute');";
    assert!(project.problems_in("app/Http/Probe.php", &probe(body), UNKNOWN).is_empty());
}

#[test]
fn option_keys_are_artisan_options() {
    let mut project = Project::app();
    let table: &[(&str, Option<&str>)] = &[
        ("Artisan::queue('x', ['/*|*/y' => 1]);", Some("artisanOption")),
        ("Schedule::command('x', ['--y/*|*/' => 1])->daily();", Some("artisanOption")),
        // Values aren't keys.
        ("Artisan::call('x', ['--y' => '/*|*/z']);", None),
        ("Schedule::command('x', ['--y/*|*/'])->daily();", None),
    ];
    for (body, expected) in table {
        assert_eq!(project.artisan_kind_at("app/Http/Probe.php", &probe(body)), *expected, "{body}");
    }
    let source = command_class("$this->call('x', ['/*|*/' => 1]);");
    assert_eq!(project.artisan_kind_at("app/Console/Commands/Probe.php", &source), Some("artisanOption"));
}

#[test]
fn completes_option_keys_of_the_command() {
    let mut project = Project::app();
    let complete = |project: &mut Project, body: &str| project.complete_in("app/Http/Probe.php", &probe(body));
    assert_eq!(complete(&mut project, "Artisan::call('posts:prune-drafts', ['/*|*/' => 1]);"), ["--force", "days"]);
    assert_eq!(complete(&mut project, "Artisan::call('posts:publish', ['--/*|*/' => 1]);"), ["--dry-run"]);
    // The command by class, and with options written after its name.
    let by_class = "Artisan::call(\\App\\Console\\Commands\\PublishScheduledPosts::class, ['/*|*/' => 1]);";
    assert_eq!(complete(&mut project, by_class), ["--dry-run"]);
    assert_eq!(complete(&mut project, "Artisan::call('migrate --seed', ['--for/*|*/' => 1]);"), ["--force"]);
    // An unknown command has none.
    assert!(complete(&mut project, "Artisan::call('nowhere', ['/*|*/' => 1]);").is_empty());
}

#[test]
fn option_keys_go_to_the_signature_and_hover() {
    let mut project = Project::app();
    let goto = |project: &mut Project, body: &str| project.definition_in("app/Http/Probe.php", &probe(body));
    assert_eq!(
        goto(&mut project, "Artisan::call('posts:publish', ['--dry/*|*/-run' => true]);"),
        [(PUBLISH.to_owned(), 15, "dry-run".to_owned())]
    );
    assert_eq!(
        goto(&mut project, "Artisan::call('posts:prune-drafts', ['da/*|*/ys' => 7]);"),
        [(PRUNE.to_owned(), 10, "days".to_owned())]
    );
    assert!(goto(&mut project, "Artisan::call('posts:publish', ['--no/*|*/where' => 1]);").is_empty());
    let hover = project.artisan_hover("Artisan::call('posts:prune-drafts', ['--fo/*|*/rce' => true]);").unwrap();
    assert!(hover.contains("**artisan** `posts:prune-drafts` `--force`"), "{hover}");
    assert!(hover.contains("Delete without asking"), "{hover}");
}

#[test]
fn finds_usages_of_an_option_key_of_the_same_command() {
    let mut project = Project::app();
    let source = probe(
        "Artisan::call('posts:publish', ['--dry/*|*/-run' => true]);\n    Artisan::call('posts:prune-drafts', ['--force' => true, '--dry-run' => 1]);",
    );
    let found: Vec<(String, u32, String)> = project
        .references("app/Http/Probe.php", &source)
        .into_iter()
        .map(|(path, line, text, _)| (path, line, text))
        .collect();
    assert!(found.contains(&("app/Http/Probe.php".to_owned(), 9, "--dry-run".to_owned())), "{found:?}");
    // `PruneDrafts` calls `posts:publish` with it.
    assert!(found.contains(&(PRUNE.to_owned(), 16, "--dry-run".to_owned())), "{found:?}");
    // Not the key given to another command.
    assert!(!found.iter().any(|(path, line, _)| path == "app/Http/Probe.php" && *line == 10), "{found:?}");
}

/// A parameters key that is none of the command's options or arguments is
/// reported; the options every command takes, unknown commands and
/// projects without `vendor/` aren't.
#[test]
fn reports_unknown_option_keys() {
    const OPTION: &str = "PhpUnknownArtisanOption";
    let mut project = Project::app();
    let body = [
        "Artisan::call('posts:publish', ['--dry-run' => true]);",
        "Artisan::call('posts:publish', ['--dryrun' => true]);",
        "Artisan::call('posts:publish', ['--verbose' => true, '-q' => true, '--no-interaction' => true]);",
        "Artisan::call('posts:publish', ['post' => 1]);",
        "Artisan::call('nowhere', ['--force' => true]);",
    ]
    .join("\n    ");
    assert_eq!(
        project.problems_in("app/Http/Probe.php", &probe(&body), OPTION),
        [
            (10, "'--dryrun' is not an option of Artisan command 'posts:publish'".to_owned()),
            (12, "'post' is not an argument of Artisan command 'posts:publish'".to_owned()),
        ]
    );
    let mut bare = Project::new(&[
        ("composer.json", r#"{"require": {"laravel/framework": "^11.0"}, "autoload": {"psr-4": {"App\\": "app/"}}}"#),
        ("artisan", "#!/usr/bin/env php\n"),
    ]);
    assert!(bare.problems_in("app/Http/Probe.php", &probe("Artisan::call('x', ['--y' => 1]);"), OPTION).is_empty());
}
