//! `PhpUndefinedController` and its quick-fixes on the fixture app
//! (`fixtures/laravel-app` with `fixtures/laravel-stubs` as its `vendor/`):
//! the problems of route actions naming a missing controller class or
//! method, the created controllers (snapshots) and the rewritten routes.

use super::*;

/// The routes of the probe route file, written over `routes/web.php`.
const HEADER: &str =
    "<?php\n\nuse App\\Http\\Controllers\\PostController;\nuse Illuminate\\Support\\Facades\\Route;\n\n";

/// The fixture app with `routes/web.php` holding `body` (after
/// [`HEADER`]), the file opened; the caret is dropped.
fn routes(body: &str) -> (Project, DocId, String) {
    let text = format!("{HEADER}{body}\n");
    let mut project = Project::app_with(&[("routes/web.php", &text)]);
    let (doc, _) = project.open("routes/web.php", &format!("{text}/*|*/"));
    (project, doc, text)
}

/// The `PhpUndefinedController` problems of the open file: line and message.
fn problems(project: &Project, doc: DocId) -> Vec<(u32, String)> {
    let inspected = project.engine.inspect(doc, &CancellationToken::new()).unwrap();
    inspected
        .diagnostics
        .iter()
        .filter(|diagnostic| diagnostic.code.as_deref() == Some("PhpUndefinedController"))
        .map(|diagnostic| (diagnostic.range.start.line, diagnostic.message.clone()))
        .collect()
}

/// The code actions at the first `needle` of `text` (inside it).
fn actions_at(project: &Project, doc: DocId, text: &str, needle: &str) -> Vec<crate::imports::ImportAction> {
    let at = text.find(needle).unwrap() + 2;
    let pos = LineIndex::new(text).pos(at as u32);
    project.engine.code_actions(doc, Range::new(pos, pos), &[]).unwrap()
}

/// `text` with the edits of `edit` for `path` applied.
fn applied(text: &str, edit: &ide_core::WorkspaceEdit, path: &Path) -> String {
    let lines = LineIndex::new(text);
    let mut edits: Vec<(usize, usize, String)> = Vec::new();
    for file in &edit.files {
        if let FileEdit::Edit { path: edited, edits: list, .. } = file
            && edited.clone() == path
        {
            for one in list {
                let start = lines.byte(one.range.start) as usize;
                let end = lines.byte(one.range.end) as usize;
                edits.push((start, end, one.new_text.clone()));
            }
        }
    }
    edits.sort_by_key(|(start, end, _)| std::cmp::Reverse((*start, *end)));
    let mut out = text.to_owned();
    for (start, end, new_text) in edits {
        out.replace_range(start..end, &new_text);
    }
    out
}

/// The file `edit` creates, and its text.
fn created(edit: &ide_core::WorkspaceEdit) -> (PathBuf, String) {
    let path = edit
        .files
        .iter()
        .find_map(|file| match file {
            FileEdit::Create { path, overwrite: false } => Some(PathBuf::from(path.clone())),
            _ => None,
        })
        .expect("a created file");
    (path.clone(), applied("", edit, &path))
}

#[test]
fn reports_missing_controller_classes_and_methods() {
    let (project, doc, _) = routes(
        "Route::get('123', 'dream')->name('dream.come.true');\n\
         Route::get('/a', 'Ghost@show');\n\
         Route::get('/b', [PostController::class, 'missing']);\n\
         Route::get('/c', 'PostController@gone');\n\
         Route::get('/d', [PostController::class, 'index']);\n\
         Route::get('/e', 'App\\\\Http\\\\Controllers\\\\HomeController');\n\
         Route::get('/f', [Nowhere::class, 'index']);\n\
         Route::get('/g', 'PostController');\n\
         Route::controller(PostController::class)->group(function () {\n    Route::get('/h', 'index');\n    Route::get('/i', 'absent');\n});",
    );
    assert_eq!(
        problems(&project, doc),
        [
            (5, "Controller class 'dream' does not exist".to_owned()),
            (6, "Controller class 'Ghost' does not exist".to_owned()),
            (7, "Method 'missing' does not exist in controller 'PostController'".to_owned()),
            (8, "Method 'gone' does not exist in controller 'PostController'".to_owned()),
            // `Nowhere::class` is `PhpUndefinedClass`'s; a string with escapes isn't read.
            (12, "Method '__invoke' does not exist in controller 'PostController'".to_owned()),
            (15, "Method 'absent' does not exist in controller 'PostController'".to_owned()),
        ]
    );
}

#[test]
fn creates_an_invokable_controller_for_a_plain_action() {
    let (project, doc, text) = routes("Route::get('123', 'dream')->name('dream.come.true');");
    let actions = actions_at(&project, doc, &text, "'dream'");
    let create = actions.iter().find(|action| action.title.starts_with("Create invokable")).expect("the fix");
    assert_eq!(create.title, "Create invokable controller 'DreamController'");
    assert!(create.preferred);
    let (path, controller) = created(&create.edit);
    assert_eq!(path, project.root.join("app/Http/Controllers/DreamController.php"));
    insta::assert_snapshot!("invokable_controller", controller);
    let route = applied(&text, &create.edit, &project.root.join("routes/web.php"));
    assert!(route.contains("Route::get('123', DreamController::class)->name('dream.come.true');"), "{route}");
    assert!(route.contains("use App\\Http\\Controllers\\DreamController;\n"), "{route}");
}

#[test]
fn creates_a_controller_with_the_method_and_its_route_parameters() {
    let (project, doc, text) = routes("Route::get('/posts/{post}/{page?}', 'Foo@bar');");
    let actions = actions_at(&project, doc, &text, "'Foo@bar'");
    let create = actions.iter().find(|action| action.title.starts_with("Create controller")).expect("the fix");
    assert_eq!(create.title, "Create controller 'FooController' with method 'bar'");
    let (path, controller) = created(&create.edit);
    assert_eq!(path, project.root.join("app/Http/Controllers/FooController.php"));
    insta::assert_snapshot!("controller_with_method", controller);
    // Without a group namespace Laravel would look for a global `Foo`.
    let route = applied(&text, &create.edit, &project.root.join("routes/web.php"));
    assert!(route.contains("Route::get('/posts/{post}/{page?}', [FooController::class, 'bar']);"), "{route}");
}

#[test]
fn keeps_the_string_form_in_a_namespace_group() {
    let (project, doc, text) = routes(
        "Route::namespace('App\\Http\\Controllers\\Admin')->group(function () {\n    Route::get('/x', 'Report@show');\n});",
    );
    let actions = actions_at(&project, doc, &text, "'Report@show'");
    let create = actions.iter().find(|action| action.title.starts_with("Create controller")).expect("the fix");
    let (path, controller) = created(&create.edit);
    assert_eq!(path, project.root.join("app/Http/Controllers/Admin/ReportController.php"));
    assert!(controller.contains("namespace App\\Http\\Controllers\\Admin;"), "{controller}");
    assert!(controller.contains("use App\\Http\\Controllers\\Controller;"), "{controller}");
    let route = applied(&text, &create.edit, &project.root.join("routes/web.php"));
    assert!(route.contains("Route::get('/x', 'ReportController@show');"), "{route}");
}

#[test]
fn follows_the_edited_controller_template() {
    let (project, doc, text) = routes("Route::get('/a', 'Ghost@show');");
    let edited =
        "<?php\n\nnamespace $NAMESPACE$;\n\n$IMPORTS$\n\n/** Mine. */\nfinal class $CLASS$ extends Controller\n{\n}\n";
    project.engine.set_laravel_templates(crate::frameworks::laravel::generate::TemplateSet::new([(
        crate::frameworks::laravel::generate::template::CONTROLLER.to_owned(),
        edited.to_owned(),
    )]));
    let actions = actions_at(&project, doc, &text, "'Ghost@show'");
    let create = actions.iter().find(|action| action.title.starts_with("Create controller")).expect("the fix");
    let (_, controller) = created(&create.edit);
    insta::assert_snapshot!("controller_from_edited_template", controller);
}

#[test]
fn adds_a_missing_method_to_the_controller() {
    let (project, doc, text) = routes("Route::get('/posts/{id}/archive', [PostController::class, 'archive']);");
    let actions = actions_at(&project, doc, &text, "'archive'");
    let add = actions.iter().find(|action| action.title.starts_with("Add method")).expect("the fix");
    assert_eq!(add.title, "Add method 'archive' to PostController");
    let path = project.root.join("app/Http/Controllers/PostController.php");
    let before = std::fs::read_to_string(&path).unwrap();
    let after = applied(&before, &add.edit, &path);
    assert!(after.contains("use Illuminate\\Http\\Request;\n"), "{after}");
    assert!(
        after.trim_end().ends_with("    public function archive(Request $request, $id)\n    {\n        //\n    }\n}"),
        "{after}"
    );
}

#[test]
fn string_actions_of_existing_classes_offer_the_array_callable() {
    let (project, doc, text) = routes("Route::get('/c', 'PostController@gone');");
    let titles: Vec<String> =
        actions_at(&project, doc, &text, "'PostController@gone'").into_iter().map(|action| action.title).collect();
    assert!(titles.contains(&"Add method 'gone' to PostController".to_owned()), "{titles:?}");
    assert!(titles.contains(&"Convert controller string to array callable".to_owned()), "{titles:?}");
}

#[test]
fn the_fixture_routes_have_no_undefined_controllers() {
    let mut project = Project::app();
    for file in ["routes/web.php", "routes/api.php", "routes/admin.php"] {
        let path = project.root.join(file);
        let text = std::fs::read_to_string(&path).unwrap();
        let (doc, _) = project.open(file, &format!("{text}/*|*/"));
        assert_eq!(problems(&project, doc), [], "{file}");
    }
}
