use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use ide_core::{CancellationToken, DocId, IdeEvent, Pos, SharedSink};

use super::views::{ViewPaths, ViewRef, goto_view, view_ref_at};
use super::*;
use crate::engine::{CACHE_SUBDIR, EngineConfig, PhpEngine};
use crate::project::LayoutConfig;
use crate::stubs::StubFilter;

const CARET: &str = "/*|*/";

/// The text without the caret marker, and the caret's position.
fn caret(source: &str) -> (String, Pos) {
    let at = source.find(CARET).expect("a /*|*/ caret");
    let text = format!("{}{}", &source[..at], &source[at + CARET.len()..]);
    let pos = LineIndex::new(&text).pos(at as u32);
    (text, pos)
}

/// `(kind, text of the span, text of the code)` of each node.
fn nodes(text: &str) -> Vec<(String, &str, Option<&str>)> {
    parse(text)
        .into_iter()
        .map(|node| {
            let kind = match node.kind {
                NodeKind::Comment => "comment".to_owned(),
                NodeKind::Echo { raw: false } => "echo".to_owned(),
                NodeKind::Echo { raw: true } => "raw".to_owned(),
                NodeKind::Php => "php".to_owned(),
                NodeKind::Directive { name } => format!("@{name}"),
            };
            let span = &text[node.span.start as usize..node.span.end as usize];
            (kind, span, node.code.map(|code| &text[code.start as usize..code.end as usize]))
        })
        .collect()
}

#[test]
fn parse_finds_echoes_comments_and_php() {
    let text = "<p>{{ $a }} {!! $b !!} {{-- {{ $no }} --}} @{{ $escaped }} <?php $c = 1; ?><?= $d ?></p>";
    assert_eq!(
        nodes(text),
        [
            ("echo".to_owned(), "{{ $a }}", Some(" $a ")),
            ("raw".to_owned(), "{!! $b !!}", Some(" $b ")),
            ("comment".to_owned(), "{{-- {{ $no }} --}}", None),
            ("php".to_owned(), "<?php $c = 1; ?>", Some(" $c = 1; ")),
            ("raw".to_owned(), "<?= $d ?>", Some(" $d ")),
        ]
    );
}

#[test]
fn parse_finds_directives_with_balanced_arguments() {
    let text = "@if (count($a) > 1 && $b === ')')\n@foreach($items as $item)@endforeach\n@endif @csrf";
    assert_eq!(
        nodes(text),
        [
            ("@if".to_owned(), "@if (count($a) > 1 && $b === ')')", Some("count($a) > 1 && $b === ')'")),
            ("@foreach".to_owned(), "@foreach($items as $item)", Some("$items as $item")),
            ("@endforeach".to_owned(), "@endforeach", None),
            ("@endif".to_owned(), "@endif", None),
            ("@csrf".to_owned(), "@csrf", None),
        ]
    );
}

#[test]
fn parse_skips_what_is_not_a_directive() {
    // An e-mail, CSS, Alpine, an escaped directive, verbatim text.
    let text = "a@b.com @media (x) <a @click=\"go\"> @@if($x) @verbatim {{ $v }} @if($v) @endverbatim @json($j)";
    assert_eq!(nodes(text), [("@json".to_owned(), "@json($j)", Some("$j"))]);
}

#[test]
fn parse_takes_php_blocks_and_unclosed_constructs() {
    let text = "@php\n$x = 1;\n@endphp @php($y = 2)";
    assert_eq!(
        nodes(text),
        [
            ("php".to_owned(), "@php\n$x = 1;\n@endphp", Some("\n$x = 1;\n")),
            ("@php".to_owned(), "@php($y = 2)", Some("$y = 2")),
        ]
    );
    // While typing: an echo runs to the end, directive arguments to the end of the line.
    assert_eq!(nodes("{{ $user->"), [("echo".to_owned(), "{{ $user->", Some(" $user->"))]);
    assert_eq!(nodes("@if($a->\n<p>"), [("@if".to_owned(), "@if($a->", Some("$a->"))]);
}

#[test]
fn compile_writes_php_structures() {
    let text = "@use('App\\Models\\User', 'Account')\n@extends('layouts.app')\n@foreach($users as $user)\n{{ $user->name }}\n@if($loop->first) a @elseif($x) b @else c @endif\n@endforeach\n@forelse($a as $b) @empty none @endforelse\n@switch($s) @case(1) @break @default x @endswitch\n@error('email') {{ $message }} @enderror\n@inject('metrics', 'App\\Services\\Metrics')\n@php($n = 1)";
    let compiled = compile(text, false);
    let expected = "<?php
use App\\Models\\User as Account;
/** @var \\Illuminate\\Support\\ViewErrorBag $errors */
$errors = null;
__blade_extends('layouts.app');
foreach ($users as $user) {
/** @var \\stdClass $loop */
$loop = null;
echo  $user->name ;
if ($loop->first) {
} elseif ($x) {
} else {
}
}
foreach ($a as $b) {
/** @var \\stdClass $loop */
$loop = null;
} {
}
switch ($s) {
case 1:
break;
default:
}
['email'];
if (true) {
/** @var string $message */
$message = null;
echo  $message ;
}
/** @var \\App\\Services\\Metrics $metrics */
$metrics = null;
$n = 1;
";
    assert_eq!(compiled.php, expected);
    // The compiled PHP parses.
    let parsed = crate::syntax::ParsedFile::parse("view.blade.php", compiled.php.as_str());
    assert!(parsed.errors().is_empty(), "{:?}", parsed.errors());
}

#[test]
fn compile_balances_blocks() {
    // Unclosed blocks are closed, stray ends and middles don't break the PHP.
    for text in [
        "@if($a) @foreach($b as $c)",
        "@endif @endforeach x",
        "@else @elseif($a) @empty",
        "@case(1) @break",
        "@if($a) @else @elseif($b) @endif",
    ] {
        let compiled = compile(text, false);
        let parsed = crate::syntax::ParsedFile::parse("view.blade.php", compiled.php.as_str());
        assert!(parsed.errors().is_empty(), "{text}: {}\n{:?}", compiled.php, parsed.errors());
    }
    let components = compile("{{ $attributes }}", true);
    assert!(components.php.contains("$attributes = null;") && components.php.contains("$slot = null;"));
}

#[test]
fn positions_map_both_ways() {
    let text = "<h1>\n  {{ $title }}</h1>\n@if ($ok)";
    let compiled = compile(text, false);
    let title = Pos::new(1, 5);
    let php = compiled.to_php(title).expect("in the echo");
    let php_text = &compiled.php;
    let offset = LineIndex::new(php_text).byte(php) as usize;
    assert!(php_text[offset..].starts_with("$title"));
    assert_eq!(compiled.to_blade(php), Some(title));
    // The end of a piece of code maps too; HTML and delimiters don't.
    assert!(compiled.to_php(Pos::new(2, 8)).is_some());
    assert_eq!(compiled.to_php(Pos::new(0, 1)), None);
    assert_eq!(compiled.to_php(Pos::new(1, 2)), None);
    assert_eq!(compiled.to_blade(Pos::new(0, 2)), None);
}

#[test]
fn directive_prefix_only_outside_php() {
    let (text, pos) = caret("<p>\n@for/*|*/each");
    let (prefix, range) = directive_prefix(&text, pos).expect("a directive");
    assert_eq!(prefix, "for");
    assert_eq!(range, Range::new(Pos::new(1, 1), Pos::new(1, 8)));
    for source in ["a@b/*|*/", "{{ '@x/*|*/' }}", "@if('@x/*|*/')", "@php @x/*|*/ @endphp", "x/*|*/"] {
        let (text, pos) = caret(source);
        assert_eq!(directive_prefix(&text, pos), None, "{source}");
    }
}

fn write(root: &Path, files: &[(&str, &str)]) {
    for (rel, text) in files {
        let path = root.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }
}

#[test]
fn views_and_components_resolve_to_files() {
    let dir = tempfile::tempdir().unwrap();
    let root = dunce::canonicalize(dir.path()).unwrap();
    write(
        &root,
        &[
            ("resources/views/layouts/app.blade.php", ""),
            ("resources/views/partials/nav.php", ""),
            ("resources/views/components/alert.blade.php", ""),
            ("app/View/Components/Alert.php", ""),
            ("resources/views/components/forms/input-group/index.blade.php", ""),
            ("app/View/Components/Forms/InputGroup.php", ""),
            ("resources/views/components/card/card.blade.php", ""),
        ],
    );
    let paths = ViewPaths::new(&root);
    let views = root.join("resources/views");
    assert_eq!(paths.view("layouts.app"), Some(views.join("layouts/app.blade.php")));
    assert_eq!(paths.view("partials.nav"), Some(views.join("partials/nav.php")));
    assert_eq!(paths.view("missing"), None);
    assert_eq!(paths.view("../secret"), None);
    assert_eq!(paths.view("mail::message"), None);
    assert_eq!(
        paths.component("alert"),
        [root.join("app/View/Components/Alert.php"), views.join("components/alert.blade.php")]
    );
    assert_eq!(
        paths.component("forms.input-group"),
        [
            root.join("app/View/Components/Forms/InputGroup.php"),
            views.join("components/forms/input-group/index.blade.php")
        ]
    );
    assert_eq!(paths.component("card"), [views.join("components/card/card.blade.php")]);
    assert!(paths.is_component_view(&views.join("components/alert.blade.php")));
    assert!(!paths.is_component_view(&views.join("layouts/app.blade.php")));

    let goto = |source: &str| {
        let (text, pos) = caret(source);
        goto_view(&text, pos, &paths)
    };
    assert_eq!(goto("@extends('layouts./*|*/app')"), [views.join("layouts/app.blade.php")]);
    assert_eq!(goto("@includeWhen($x, 'partials/*|*/.nav', [])"), [views.join("partials/nav.php")]);
    assert_eq!(goto("<x-al/*|*/ert type=\"error\" />").len(), 2);
    assert_eq!(goto("<x-alert></x-al/*|*/ert>").len(), 2);
    assert_eq!(goto("<x-forms.input-gr/*|*/oup />").len(), 2);
    assert!(goto("<x-slot:ti/*|*/tle>").is_empty());
    assert!(goto("@yield('con/*|*/tent')").is_empty());
}

#[test]
fn view_refs_report_their_range() {
    let (text, pos) = caret("@include('a.b/*|*/')");
    let (found, range) = view_ref_at(&text, pos).unwrap();
    assert_eq!(found, ViewRef::View("a.b".into()));
    assert_eq!(range, Range::new(Pos::new(0, 10), Pos::new(0, 13)));
    let (text, pos) = caret("<x-a/*|*/lert/>");
    assert_eq!(view_ref_at(&text, pos).unwrap().0, ViewRef::Component("alert".into()));
}

// ------------------------------------------------------------ the engine

const MODELS: &str = "<?php
namespace App\\Models;

class User
{
    public string $name = '';

    /** The posts the user wrote. */
    public function posts(int $limit): array { return []; }
}

class Post
{
    public string $title = '';
}
";

const HELPERS: &str = "<?php
function format_money(int $cents, string $currency): string { return ''; }
";

struct Project {
    _tmp: tempfile::TempDir,
    root: PathBuf,
    engine: Arc<PhpEngine>,
}

impl Project {
    fn new() -> Self {
        let tmp = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(tmp.path()).unwrap();
        let root = base.join("project");
        write(&root, &[("app/Models/User.php", MODELS), ("app/helpers.php", HELPERS)]);
        let sink: SharedSink = Arc::new(|_: IdeEvent| {});
        let config = EngineConfig {
            cache_dir: base.join("cache").join(CACHE_SUBDIR),
            layout: LayoutConfig { root: root.clone(), ..LayoutConfig::default() },
            stubs: StubFilter::default(),
        };
        let engine = PhpEngine::open(config, sink).unwrap();
        assert!(engine.wait_idle(Duration::from_secs(60)));
        Self { _tmp: tmp, root, engine }
    }

    fn view(&self) -> PathBuf {
        self.root.join("resources/views/page.blade.php")
    }

    fn with<T>(&self, source: &str, f: impl FnOnce(&PhpEngine, &BladeDocument, Pos) -> T) -> T {
        let (text, pos) = caret(source);
        let path = self.view();
        let blade = BladeDocument { doc: DocId(7), path: &path, version: 1, text: &text };
        let found = f(&self.engine, &blade, pos);
        self.engine.document_closed(DocId(7));
        found
    }

    fn labels(&self, source: &str) -> Vec<String> {
        self.with(source, |engine, blade, pos| {
            let found = engine.blade_completion(blade, pos, None, &CancellationToken::new()).expect("in PHP");
            found.items.into_iter().map(|item| item.label).collect()
        })
    }
}

const PRELUDE: &str = "@use('App\\Models\\User')\n@php\n/** @var User $user */\n$user = new User();\n@endphp\n";

#[test]
fn completion_in_echoes_and_directives() {
    let project = Project::new();
    let labels = project.labels(&format!("{PRELUDE}<h1>{{{{ $user->/*|*/ }}}}</h1>"));
    assert!(labels.contains(&"name".to_owned()) && labels.contains(&"posts".to_owned()), "{labels:?}");
    let labels = project.labels(&format!("{PRELUDE}@if ($user->/*|*/)"));
    assert!(labels.contains(&"name".to_owned()), "{labels:?}");
    // Loop variables and `$loop`.
    let labels = project.labels("@foreach([1, 2] as $number)\n{{ $num/*|*/ }}\n@endforeach");
    assert!(labels.contains(&"$number".to_owned()), "{labels:?}");
    let labels = project.labels("@foreach([1] as $n) {{ $lo/*|*/ }} @endforeach");
    assert!(labels.contains(&"$loop".to_owned()), "{labels:?}");
    // Outside the PHP: not the engine's.
    project.with("<p>/*|*/</p>", |engine, blade, pos| {
        assert!(engine.blade_completion(blade, pos, None, &CancellationToken::new()).is_none());
    });
}

#[test]
fn completion_ranges_are_the_templates() {
    let project = Project::new();
    project.with(&format!("{PRELUDE}<h1>{{{{ $user->na/*|*/ }}}}</h1>"), |engine, blade, pos| {
        let found = engine.blade_completion(blade, pos, None, &CancellationToken::new()).unwrap();
        let name = found.items.iter().find(|item| item.label == "name").expect("name");
        assert_eq!(name.replace, Range::new(Pos::new(pos.line, pos.col - 2), pos));
    });
    // A class from elsewhere: its qualified name, no import.
    project.with("{{ new Pos/*|*/ }}", |engine, blade, pos| {
        let found = engine.blade_completion(blade, pos, None, &CancellationToken::new()).unwrap();
        let post = found.items.iter().find(|item| item.label == "Post").expect("Post");
        assert!(post.additional_edits.is_empty());
        assert!(post.insert_text.starts_with("\\App\\Models\\Post"), "{}", post.insert_text);
    });
}

#[test]
fn hover_and_signature_help_in_the_php() {
    let project = Project::new();
    project.with(&format!("{PRELUDE}{{{{ $user->po/*|*/sts(3) }}}}"), |engine, blade, pos| {
        let hover = engine.blade_hover(blade, pos).expect("a hover");
        assert!(hover.markdown.contains("posts(int $limit): array"), "{}", hover.markdown);
        assert!(hover.markdown.contains("The posts the user wrote."), "{}", hover.markdown);
        assert_eq!(hover.range, Range::new(Pos::new(pos.line, pos.col - 2), Pos::new(pos.line, pos.col + 3)));
    });
    project.with("@if (true) {!! format_money(10, /*|*/) !!} @endif", |engine, blade, pos| {
        let help = engine.blade_signature_help(blade, pos).expect("signature help");
        assert_eq!(help.signatures[0].label, "format_money(int $cents, string $currency): string");
        assert_eq!(help.active_parameter, 1);
    });
    project.with("@inject('people', 'App\\Models\\User')\n{{ $peo/*|*/ple }}", |engine, blade, pos| {
        let hover = engine.blade_hover(blade, pos).expect("a hover");
        assert!(hover.markdown.contains("User"), "{}", hover.markdown);
    });
    project.with("<p>/*|*/</p>", |engine, blade, pos| assert!(engine.blade_hover(blade, pos).is_none()));
}

#[test]
fn definition_from_the_php() {
    let project = Project::new();
    let models = project.root.join("app/Models/User.php");
    project.with(&format!("{PRELUDE}{{{{ $user->na/*|*/me }}}}"), |engine, blade, pos| {
        let targets = engine.blade_definition(blade, pos).expect("handled");
        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0].path, models);
        assert_eq!(targets[0].range.start.line, 5);
    });
    // A variable assigned in the template: mapped back into it.
    project.with("@php($total = 3)\n<b>{{ $to/*|*/tal }}</b>", |engine, blade, pos| {
        let targets = engine.blade_definition(blade, pos).expect("handled");
        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0].path, project.view());
        assert_eq!(targets[0].range, Range::new(Pos::new(0, 5), Pos::new(0, 11)));
    });
}

#[test]
fn embedded_documents_are_not_inspected() {
    let project = Project::new();
    project.with("{{ undefined_function() }}/*|*/", |engine, blade, _| {
        engine.blade_sync(blade);
        assert!(engine.is_open(blade.doc));
        assert!(engine.inspect(blade.doc, &CancellationToken::new()).is_none());
        // The editor's raw-text updates don't replace the compiled PHP.
        engine.document_changed(blade.doc, 2, "<?php nonsense(");
        let held = engine.open_document(blade.path).unwrap();
        assert!(held.embedded && held.text.contains("echo  undefined_function() ;"));
    });
}
