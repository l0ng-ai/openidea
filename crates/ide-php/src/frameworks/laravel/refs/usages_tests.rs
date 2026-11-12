//! Find usages and rename starting from declarations and other files
//! (phase 8.24): translation keys renamed in every locale file and caller,
//! `.env` lines, and the undefined-view check in Blade templates; caret
//! fixtures on the fixture app (`fixtures/laravel-app`).

use super::*;
use crate::frameworks::laravel::refs::files::env_key_at;

const PROBE: &str = "app/Http/Probe.php";

#[test]
fn renames_a_group_translation_key_in_every_locale_and_caller() {
    let mut project = Project::app();
    let edits = project.rename(PROBE, "<?php\nreturn __('messages.slug_t/*|*/aken');\n", "slug_used");
    assert_eq!(
        edits,
        [
            ("app/Http/Probe.php".to_owned(), 1, "slug_taken".to_owned()),
            ("app/Http/Requests/StorePostRequest.php".to_owned(), 32, "slug_taken".to_owned()),
            ("lang/en/messages.php".to_owned(), 6, "slug_taken".to_owned()),
            ("lang/fr/messages.php".to_owned(), 6, "slug_taken".to_owned()),
        ]
    );
    // From the declaration in a locale file.
    let source = std::fs::read_to_string(project.root.join("lang/fr/messages.php"))
        .unwrap()
        .replace("'slug_taken'", "'slug_/*|*/taken'");
    let edits = project.rename("lang/fr/messages.php", &source, "slug_used");
    assert_eq!(edits.len(), 3, "{edits:?}");
    // An array's key: the keys below it follow; the caller's segment only.
    let edits = project.rename(PROBE, "<?php\nreturn __('messages.sta/*|*/tus.draft');\n", "state");
    assert_eq!(
        edits,
        [
            ("app/Http/Probe.php".to_owned(), 1, "status".to_owned()),
            ("lang/en/messages.php".to_owned(), 8, "status".to_owned()),
            ("lang/fr/messages.php".to_owned(), 8, "status".to_owned()),
        ]
    );
    // Not a group (the file's name), nor with a dot in a segment.
    let (doc, pos) = project.open(PROBE, "<?php\nreturn __('messa/*|*/ges.welcome');\n");
    assert_eq!(project.engine.prepare_rename(doc, pos), Some(None));
    let (doc, pos) = project.open(PROBE, "<?php\nreturn __('messages.wel/*|*/come');\n");
    assert!(project.engine.rename(doc, pos, "a.b", &CancellationToken::new()).unwrap().is_err());
}

#[test]
fn renames_a_json_translation_key_in_closed_templates() {
    let mut project = Project::app();
    let edits = project.rename(PROBE, "<?php\nreturn __('Read m/*|*/ore');\n", "Continue reading");
    assert_eq!(
        edits,
        [
            ("app/Http/Probe.php".to_owned(), 1, "Read more".to_owned()),
            ("lang/en.json".to_owned(), 1, "Read more".to_owned()),
            ("lang/fr.json".to_owned(), 1, "Read more".to_owned()),
            ("resources/views/posts/_card.blade.php".to_owned(), 4, "Read more".to_owned()),
        ]
    );
}

#[test]
fn finds_usages_of_and_renames_env_keys_from_env_files() {
    let project = Project::app();
    let example = project.root.join(".env.example");
    let text = std::fs::read_to_string(&example).unwrap();
    let cancel = CancellationToken::new();
    let engine = &project.engine;

    assert_eq!(env_key_at("  export APP_ENV=local\n", Pos::new(0, 12)).map(|(key, _)| key).as_deref(), Some("APP_ENV"));
    assert_eq!(env_key_at("APP_ENV=local\n", Pos::new(0, 10)), None);
    assert_eq!(env_key_at("# APP_ENV=local\n", Pos::new(0, 3)), None);

    let found = engine.laravel_env_references(&example, &text, Pos::new(0, 3), true, &cancel).unwrap().unwrap();
    let found: Vec<(String, u32, String, UsageKind)> = found
        .iter()
        .map(|usage| {
            let (path, line, text) = project.describe(&usage.path, usage.range);
            (path, line, text, usage.kind)
        })
        .collect();
    assert_eq!(
        found,
        [
            (".env.example".to_owned(), 0, "APP_NAME".to_owned(), UsageKind::Declaration),
            ("config/app.php".to_owned(), 10, "APP_NAME".to_owned(), UsageKind::String),
        ]
    );
    assert_eq!(
        engine.laravel_env_prepare_rename(&example, &text, Pos::new(0, 3)),
        Some(Range::new(Pos::new(0, 0), Pos::new(0, 8)))
    );
    // On the value, or in another file: nothing.
    assert_eq!(engine.laravel_env_prepare_rename(&example, &text, Pos::new(0, 12)), None);
    let other = project.root.join("config/.env.example");
    assert!(engine.laravel_env_references(&other, &text, Pos::new(0, 3), true, &cancel).is_none());

    let edit =
        engine.laravel_env_rename(&example, &text, Pos::new(0, 3), "APPLICATION_NAME", &cancel).unwrap().unwrap();
    let mut edits: Vec<(String, u32, String)> = Vec::new();
    for file in &edit.files {
        let FileEdit::Edit { path, edits: list, .. } = file else { panic!("{file:?}") };
        for one in list {
            assert_eq!(one.new_text, "APPLICATION_NAME");
            edits.push(project.describe(&PathBuf::from(path.clone()), one.range));
        }
    }
    edits.sort();
    assert_eq!(
        edits,
        [
            (".env.example".to_owned(), 0, "APP_NAME".to_owned()),
            ("config/app.php".to_owned(), 10, "APP_NAME".to_owned()),
        ]
    );
    assert!(engine.laravel_env_rename(&example, &text, Pos::new(0, 3), "1APP", &cancel).unwrap().is_err());
}

#[test]
fn reports_undefined_views_in_blade_templates() {
    let project = Project::app();
    let problems = project.engine.blade_problems("@include('posts.missing')\n@extends('layouts.app')\n");
    let views: Vec<(u32, &str)> = problems
        .iter()
        .filter(|problem| problem.code.as_deref() == Some("PhpUndefinedView"))
        .map(|problem| (problem.range.start.line, problem.message.as_str()))
        .collect();
    assert_eq!(views, [(0, "View 'posts.missing' is not defined")]);
}

/// The usages of a model method include the names Laravel calls it by: a
/// local scope without its prefix, a relation read as a property; a
/// factory's method or a column of the same name isn't one of them.
#[test]
fn finds_scopes_and_relations_by_the_names_laravel_uses() {
    let mut project = Project::app();
    let post = std::fs::read_to_string(project.root.join("app/Models/Post.php")).unwrap();
    let code = |found: Vec<(String, u32, String, UsageKind)>| -> Vec<(String, String)> {
        found.into_iter().filter(|u| u.3 == UsageKind::Code).map(|u| (u.0, u.2)).collect()
    };

    let found = code(project.references("app/Models/Post.php", &post.replace("scopePublished", "scopePub/*|*/lished")));
    let files: Vec<&str> = found.iter().map(|(file, _)| file.as_str()).collect();
    assert_eq!(
        files,
        [
            "app/Http/Controllers/Api/PostController.php",
            "app/Http/Controllers/HomeController.php",
            "app/Http/Controllers/PostController.php",
            "app/Services/FeedBuilder.php",
        ],
        "{found:?}"
    );
    assert!(found.iter().all(|(_, text)| text == "published"), "{found:?}");

    let found =
        code(project.references("app/Models/Post.php", &post.replace("function author()", "function aut/*|*/hor()")));
    assert_eq!(found, [("resources/views/posts/show.blade.php".to_owned(), "author".to_owned())]);
}

/// Find usages of a PHP member reads Blade templates too (their compiled
/// PHP, typed by the variables their controllers pass), so a rename edits
/// the calls in templates.
#[test]
fn finds_and_renames_member_usages_in_templates() {
    let mut project = Project::app();
    let text = std::fs::read_to_string(project.root.join("app/Enums/PostStatus.php")).unwrap();
    let source = text.replace("function label", "function la/*|*/bel");
    let found: Vec<(String, u32, String)> = project
        .references("app/Enums/PostStatus.php", &source)
        .into_iter()
        .filter(|usage| usage.3 == UsageKind::Code)
        .map(|usage| (usage.0, usage.1, usage.2))
        .collect();
    // `badge.blade.php`'s `$status->label()` too: the anonymous component's
    // `$status` prop is typed from `_card.blade.php`'s `:status="$post->status"`.
    assert_eq!(
        found,
        [
            ("resources/views/components/badge.blade.php".to_owned(), 3, "label".to_owned()),
            ("resources/views/posts/show.blade.php".to_owned(), 10, "label".to_owned()),
        ]
    );
    let edits = project.rename("app/Enums/PostStatus.php", &source, "title");
    assert_eq!(
        edits,
        [
            ("app/Enums/PostStatus.php".to_owned(), 10, "label".to_owned()),
            ("resources/views/components/badge.blade.php".to_owned(), 3, "label".to_owned()),
            ("resources/views/posts/show.blade.php".to_owned(), 10, "label".to_owned()),
        ]
    );
}

/// Renaming a model method renames the names Laravel calls it by: a scope's
/// calls, a relation read as a property (in templates too). Renamed out of
/// its style (a scope to a name without the prefix), they are left alone.
#[test]
fn renaming_a_scope_or_relation_renames_the_names_laravel_uses() {
    let mut project = Project::app();
    let post = std::fs::read_to_string(project.root.join("app/Models/Post.php")).unwrap();
    let scope = post.replace("scopePublished", "scopePub/*|*/lished");
    let edits = project.rename_edits("app/Models/Post.php", &scope, "scopeLive");
    let files: Vec<(&str, &str, &str)> =
        edits.iter().map(|(file, _, old, new)| (file.as_str(), old.as_str(), new.as_str())).collect();
    assert_eq!(
        files,
        [
            ("app/Http/Controllers/Api/PostController.php", "published", "live"),
            ("app/Http/Controllers/HomeController.php", "published", "live"),
            ("app/Http/Controllers/PostController.php", "published", "live"),
            ("app/Models/Post.php", "scopePublished", "scopeLive"),
            ("app/Services/FeedBuilder.php", "published", "live"),
        ]
    );

    let relation = post.replace("function author()", "function aut/*|*/hor()");
    let edits = project.rename_edits("app/Models/Post.php", &relation, "writer");
    let files: Vec<(&str, &str, &str)> =
        edits.iter().map(|(file, _, old, new)| (file.as_str(), old.as_str(), new.as_str())).collect();
    assert_eq!(
        files,
        [("app/Models/Post.php", "author", "writer"), ("resources/views/posts/show.blade.php", "author", "writer")]
    );

    let edits = project.rename_edits("app/Models/Post.php", &scope, "live");
    assert_eq!(edits.len(), 1, "{edits:?}");
}

/// Change signature rewrites the calls in Blade templates too.
#[test]
fn change_signature_rewrites_calls_in_templates() {
    use crate::refactor::signature::SignatureParameter;
    let mut project = Project::app();
    let text = std::fs::read_to_string(project.root.join("app/Enums/PostStatus.php")).unwrap();
    let (doc, pos) = project.open("app/Enums/PostStatus.php", &text.replace("function label", "function la/*|*/bel"));
    let info = project.engine.change_signature_info(doc, ide_core::Range::new(pos, pos)).expect("offered");
    let mut signature = info.signature;
    signature.parameters.push(SignatureParameter {
        old_index: None,
        name: "locale".into(),
        ty: "string".into(),
        default_value: String::new(),
        call_value: "'en'".into(),
        by_ref: false,
        variadic: false,
        promoted: false,
    });
    let edit = project.engine.change_signature(doc, pos, &signature, &CancellationToken::new()).unwrap().unwrap();
    let show = project.root.join("resources/views/posts/show.blade.php");
    let template = edit
        .files
        .iter()
        .find_map(|file| match file {
            FileEdit::Edit { path, edits, .. } if **path == *show => Some(edits.clone()),
            _ => None,
        })
        .expect("the template's call is changed");
    let mut document = ide_text::Document::new(&std::fs::read_to_string(&show).unwrap());
    document.apply_edits(&template).unwrap();
    assert!(document.text().to_string().contains("{{ $post->status->label('en') }}"), "{}", document.text());
    project.engine.document_closed(doc);
}
