use std::path::PathBuf;

use ide_core::{Pos, SymbolKind};

use super::*;
use crate::syntax::LineIndex;

const CARET: &str = "/*|*/";

/// The text without its caret marker, and the caret's position.
fn caret(src: &str) -> (String, Pos) {
    let at = src.find(CARET).expect("caret marker");
    let text = format!("{}{}", &src[..at], &src[at + CARET.len()..]);
    let pos = LineIndex::new(&text).pos(at as u32);
    (text, pos)
}

fn labels(src: &str) -> Vec<String> {
    let (text, pos) = caret(src);
    completions(&text, pos, false, &TemplatePaths::default()).into_iter().map(|c| c.label).collect()
}

fn kinds(src: &str) -> Vec<(String, TwigCompletionKind)> {
    let (text, pos) = caret(src);
    completions(&text, pos, false, &TemplatePaths::default()).into_iter().map(|c| (c.label, c.kind)).collect()
}

fn has(labels: &[String], label: &str) -> bool {
    labels.iter().any(|l| l == label)
}

// --- Outline -----------------------------------------------------------------

#[test]
fn outline_lists_parent_blocks_macros_and_sets() {
    let text = "{% extends 'base.html.twig' %}\n\
                {% import 'forms.html.twig' as forms %}\n\
                {% from 'macros.twig' import input as field, label %}\n\
                {% set title = 'Home' %}\n\
                {% block body %}\n  {% block content %}x{% endblock %}\n  {% if a %}{% block side %}{% endblock %}{% endif %}\n{% endblock %}\n\
                {% block head 'short' %}\n\
                {% macro button(label, type = 'submit') %}<b>{{ label }}</b>{% endmacro %}\n";
    let items = outline(text);
    let summary: Vec<(String, SymbolKind, Option<String>)> =
        items.iter().map(|i| (i.name.clone(), i.kind, i.detail.clone())).collect();
    assert_eq!(
        summary,
        vec![
            ("base.html.twig".into(), SymbolKind::File, Some("extends".into())),
            ("forms".into(), SymbolKind::Namespace, Some("forms.html.twig".into())),
            ("field".into(), SymbolKind::Function, Some("macros.twig".into())),
            ("label".into(), SymbolKind::Function, Some("macros.twig".into())),
            ("title".into(), SymbolKind::Variable, None),
            ("body".into(), SymbolKind::Module, None),
            ("head".into(), SymbolKind::Module, None),
            ("button".into(), SymbolKind::Function, Some("(label, type)".into())),
        ]
    );
    let body = &items[5];
    let children: Vec<&str> = body.children.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(children, ["content", "side"]);
    // The selection is the block's name.
    assert_eq!(body.selection_range.start, Pos { line: 4, col: 9 });
    assert_eq!(body.range.start, Pos { line: 4, col: 0 });
    assert_eq!(body.range.end.line, 7);
}

#[test]
fn outline_of_an_embed_holds_its_blocks() {
    let items = outline("{% embed 'card.twig' with {a: 1} %}{% block title %}T{% endblock %}{% endembed %}");
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].name, "card.twig");
    assert_eq!(items[0].detail.as_deref(), Some("embed"));
    assert_eq!(items[0].children[0].name, "title");
}

#[test]
fn outline_survives_broken_templates() {
    let items = outline("{% block a %}ok{% endblock %}\n{% if %}\n{{ 'é' ");
    assert_eq!(items.first().map(|i| i.name.as_str()), Some("a"));
    assert!(outline("").is_empty());
}

// --- Template references and goto ---------------------------------------------

#[test]
fn template_refs_cover_every_loading_construct() {
    let text = "{% extends ['a.twig', 'b.twig'] %}{% use 'blocks.twig' %}\n\
                {% include 'inc.twig' with {x: 'not-a-template'} %}{% embed \"emb.twig\" %}{% endembed %}\n\
                {% import 'm.twig' as m %}{% from 'f.twig' import x %}\n\
                {{ include('fn.twig', {y: 'nope'}) }}{{ source(name: 'src.twig') }}{{ include(cond ? 'c1.twig' : 'c2.twig') }}\n\
                {{ other('no.twig') }}";
    let names: Vec<String> = template_refs(text).into_iter().map(|r| r.name).collect();
    assert_eq!(
        names,
        [
            "a.twig",
            "b.twig",
            "blocks.twig",
            "inc.twig",
            "emb.twig",
            "m.twig",
            "f.twig",
            "fn.twig",
            "src.twig",
            "c1.twig",
            "c2.twig"
        ]
    );
}

#[test]
fn template_ref_range_is_the_string_content() {
    let (text, pos) = caret("{% extends 'layout/ba/*|*/se.html.twig' %}");
    let found = template_at(&text, pos).unwrap();
    assert_eq!(found.name, "layout/base.html.twig");
    assert_eq!(found.range.start, Pos { line: 0, col: 12 });
    assert_eq!(found.range.end, Pos { line: 0, col: 33 });
    let (text, pos) = caret("{% extends 'base.twig' %}{{ ti/*|*/tle }}");
    assert_eq!(template_at(&text, pos), None);
}

fn fixture_project() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    for file in [
        "templates/base.html.twig",
        "templates/admin/list.html.twig",
        "templates/admin/notes.txt",
        "lib/emails/welcome.twig",
        "resources/views/legacy.twig",
    ] {
        let path = root.join(file);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "{{ x }}").unwrap();
    }
    std::fs::create_dir_all(root.join("config/packages")).unwrap();
    std::fs::write(
        root.join("config/packages/twig.yaml"),
        "twig:\n    default_path: '%kernel.project_dir%/templates'\n    paths:\n        'lib/emails': Email\n",
    )
    .unwrap();
    dir
}

#[test]
fn template_paths_resolve_plain_and_namespaced_names() {
    let dir = fixture_project();
    let root = dir.path();
    let paths = TemplatePaths::discover(root);
    assert_eq!(paths.resolve("base.html.twig"), Some(root.join("templates").join("base.html.twig")));
    assert_eq!(paths.resolve("admin/list.html.twig"), Some(root.join("templates/admin").join("list.html.twig")));
    assert_eq!(paths.resolve("@Email/welcome.twig"), Some(root.join("lib/emails").join("welcome.twig")));
    assert_eq!(paths.resolve("legacy.twig"), Some(root.join("resources/views").join("legacy.twig")));
    assert_eq!(paths.resolve("welcome.twig"), None);
    assert_eq!(paths.resolve("../config/packages/twig.yaml"), None);
    assert_eq!(paths.resolve("missing.twig"), None);
    assert_eq!(paths.names(), ["@Email/welcome.twig", "admin/list.html.twig", "base.html.twig", "legacy.twig"]);
}

#[test]
fn goto_template_opens_the_file() {
    let dir = fixture_project();
    let paths = TemplatePaths::discover(dir.path());
    let (text, pos) = caret("{% extends 'base/*|*/.html.twig' %}");
    let (file, origin) = goto_template(&text, pos, &paths).unwrap();
    assert_eq!(file, dir.path().join("templates").join("base.html.twig"));
    assert_eq!(origin.start.col, 12);
    let (text, pos) = caret("{{ include('@Email/wel/*|*/come.twig') }}");
    assert_eq!(goto_template(&text, pos, &paths).unwrap().0, dir.path().join("lib/emails").join("welcome.twig"));
    let (text, pos) = caret("{% include 'nowhere/*|*/.twig' %}");
    assert_eq!(goto_template(&text, pos, &paths), None);
}

// --- Completion ---------------------------------------------------------------

#[test]
fn completes_tags_at_the_start_of_a_statement() {
    let found = kinds("{% fo/*|*/ %}");
    assert!(found.contains(&("for".into(), TwigCompletionKind::Tag)));
    assert!(found.contains(&("extends".into(), TwigCompletionKind::Tag)));
    assert!(!found.iter().any(|(_, kind)| *kind != TwigCompletionKind::Tag));
    assert!(has(&labels("{%- /*|*/"), "block"));
    // Not a tag position: the expression after the tag name.
    assert!(!has(&labels("{% if fo/*|*/ %}"), "for"));
}

#[test]
fn completes_filters_after_a_pipe_and_in_apply() {
    let found = kinds("{% set name = 'x' %}{{ name|up/*|*/ }}");
    assert!(found.contains(&("upper".into(), TwigCompletionKind::Filter)));
    assert!(found.iter().all(|(_, kind)| *kind == TwigCompletionKind::Filter));
    assert!(has(&labels("{{ name | /*|*/"), "date"));
    assert!(has(&labels("{{ items|map(i => i)|/*|*/ }}"), "join"));
    assert!(has(&labels("{% apply /*|*/ %}x{% endapply %}"), "lower"));
    assert!(has(&labels("{% apply lower|/*|*/ %}x{% endapply %}"), "escape"));
}

#[test]
fn completes_tests_after_is() {
    assert!(has(&labels("{% if x is /*|*/ %}{% endif %}"), "defined"));
    assert!(has(&labels("{% if x is not em/*|*/ %}{% endif %}"), "empty"));
    assert!(has(&labels("{{ (x is /*|*/) }}"), "divisible by"));
    assert!(!has(&labels("{% if this /*|*/ %}{% endif %}"), "defined"));
}

#[test]
fn completes_variables_in_scope() {
    let src = "{% import 'forms.twig' as forms %}{% from 'm.twig' import field %}\n\
               {% set title = 'Home' %}\n\
               {% for item in items %}\n  {{ /*|*/ }}\n{% endfor %}\n\
               {% macro row(cells, sep = ',') %}{% set inner = 1 %}{% endmacro %}";
    let found = kinds(src);
    for (label, kind) in [
        ("title", TwigCompletionKind::Variable),
        ("item", TwigCompletionKind::Variable),
        ("loop", TwigCompletionKind::Variable),
        ("forms", TwigCompletionKind::Variable),
        ("field", TwigCompletionKind::Macro),
        ("row", TwigCompletionKind::Macro),
        ("_self", TwigCompletionKind::Variable),
        ("range", TwigCompletionKind::Function),
    ] {
        assert!(found.contains(&(label.into(), kind)), "{label} missing from {found:?}");
    }
    // Macro arguments and sets stay inside the macro.
    let labels: Vec<String> = found.into_iter().map(|(l, _)| l).collect();
    for absent in ["cells", "sep", "inner", "path"] {
        assert!(!has(&labels, absent), "{absent} shouldn't be in scope");
    }
}

#[test]
fn loop_variables_stay_in_the_loop() {
    let src = "{% for user in users %}{{ user }}{% else %}{{ /*|*/ }}{% endfor %}";
    let found = labels(src);
    assert!(!has(&found, "user") && !has(&found, "loop"));
    let src = "{% for k, v in map %}{% endfor %}{{ /*|*/ }}";
    let found = labels(src);
    assert!(!has(&found, "k") && !has(&found, "v"));
    let src = "{% for k, v in map %}{% if k %}{{ v.na }}{{ /*|*/ }}{% endif %}{% endfor %}";
    let found = labels(src);
    assert!(has(&found, "k") && has(&found, "v") && has(&found, "loop"));
    let src = "{% macro m(a, b) %}{{ /*|*/ }}{% endmacro %}";
    let found = labels(src);
    assert!(has(&found, "a") && has(&found, "b"));
}

#[test]
fn half_written_tags_keep_the_scope() {
    // The tag being typed doesn't parse; the loop around it still counts.
    let found = labels("{% for row in rows %}\n{{ row| }}{% if ro/*|*/\n{% endfor %}");
    assert!(has(&found, "row"), "{found:?}");
    let found = labels("{% set total = 3 %}{% for row in rows %}{{ to/*|*/ {% endfor %}");
    assert!(has(&found, "total") && has(&found, "row"), "{found:?}");
}

#[test]
fn completion_replaces_the_word_at_the_caret() {
    let (text, pos) = caret("{{ name|lo/*|*/wer }}");
    let item =
        completions(&text, pos, false, &TemplatePaths::default()).into_iter().find(|c| c.label == "lower").unwrap();
    assert_eq!(item.replace.start.col, 8);
    assert_eq!(item.replace.end.col, 13);
    assert_eq!(item.documentation.as_deref(), Some("Lowercases a string."));
    assert_eq!(item.detail, None);
    let (text, pos) = caret("{{ x|date/*|*/ }}");
    let item =
        completions(&text, pos, false, &TemplatePaths::default()).into_iter().find(|c| c.label == "date").unwrap();
    assert_eq!(item.detail.as_deref(), Some("(format = null, timezone = null)"));
}

#[test]
fn nothing_outside_tags_in_comments_or_after_a_dot() {
    assert!(labels("<p>fo/*|*/</p>").is_empty());
    assert!(labels("{{ x }} te/*|*/xt").is_empty());
    assert!(labels("{# a comment /*|*/ #}").is_empty());
    assert!(labels("{{ user./*|*/ }}").is_empty());
    assert!(labels("{{ 'just a str/*|*/ing' }}").is_empty());
    // Right after the delimiter, before a whitespace modifier.
    assert!(has(&labels("{{/*|*/- x }}"), "range"));
    assert!(has(&labels("{%/*|*/- if x %}{% endif %}"), "if"));
}

#[test]
fn symfony_adds_its_filters_functions_and_globals() {
    let (text, pos) = caret("{{ /*|*/ }}");
    let plain: Vec<String> =
        completions(&text, pos, false, &TemplatePaths::default()).into_iter().map(|c| c.label).collect();
    assert!(!has(&plain, "path") && !has(&plain, "app"));
    let symfony: Vec<TwigCompletion> = completions(&text, pos, true, &TemplatePaths::default());
    let path = symfony.iter().find(|c| c.label == "path").unwrap();
    assert_eq!(path.kind, TwigCompletionKind::Function);
    assert!(symfony.iter().any(|c| c.label == "app"));
    let (text, pos) = caret("{{ 'key'|/*|*/ }}");
    assert!(completions(&text, pos, true, &TemplatePaths::default()).iter().any(|c| c.label == "trans"));
}

#[test]
fn completes_template_names_in_template_strings() {
    let dir = fixture_project();
    let paths = TemplatePaths::discover(dir.path());
    let complete = |src: &str| {
        let (text, pos) = caret(src);
        completions(&text, pos, false, &paths)
    };
    let found = complete("{% extends 'ba/*|*/' %}");
    let names: Vec<&str> = found.iter().map(|c| c.label.as_str()).collect();
    assert_eq!(names, ["@Email/welcome.twig", "admin/list.html.twig", "base.html.twig", "legacy.twig"]);
    assert!(found.iter().all(|c| c.kind == TwigCompletionKind::Template));
    // The whole name up to the closing quote is replaced.
    assert_eq!(found[0].replace.start.col, 12);
    assert_eq!(found[0].replace.end.col, 14);
    assert_eq!(complete("{{ include(\"/*|*/\") }}").len(), 4);
    assert_eq!(complete("{% include 'a' with {k: '/*|*/'} %}").len(), 0);
    assert_eq!(complete("{{ dump('/*|*/') }}").len(), 0);
}

#[test]
fn template_paths_without_config() {
    let dir = tempfile::tempdir().unwrap();
    assert_eq!(TemplatePaths::discover(dir.path()), TemplatePaths::default());
    let paths = TemplatePaths::from_dirs(vec![(None, PathBuf::from("/nowhere"))]);
    assert!(paths.names().is_empty());
}
