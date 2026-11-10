//! Reading `ide.json` files ([`super`]): rule mapping, places, arguments,
//! the other sections and loading order.

use serde_json::json;

use super::*;

fn read(json: Value) -> IdeJson {
    let mut out = IdeJson::default();
    out.add(Path::new("/project/ide.json"), &json);
    out
}

#[test]
fn maps_complete_types_onto_reference_kinds() {
    let table = [
        ("routeName", Some("routeName")),
        ("routeAction", Some("controllerAction")),
        ("routeMiddleware", Some("middleware")),
        ("configKey", Some("configKey")),
        ("viewName", Some("viewName")),
        ("translationKey", Some("translationKey")),
        ("validationRule", Some("validationRule")),
        ("validationRules", Some("validationRule")),
        ("staticStrings", Some("staticStrings")),
        ("directoryFiles", Some("directoryFiles")),
        ("gate", Some("gate")),
        ("artisanCommandName", Some("artisanCommand")),
        ("environmentVariable", Some("envKey")),
        ("eloquentFields", Some("eloquentField")),
        ("viteAsset", Some("viteAsset")),
        ("livewireComponent", Some("livewireComponent")),
        ("inertiaPage", Some("inertiaPage")),
        ("nonsense", None),
    ];
    for (complete, kind) in table {
        assert_eq!(completion_kind(complete), kind, "{complete}");
        // Every kind named exists.
        if let Some(kind) = kind {
            assert!(crate::frameworks::laravel::refs::kind_by_id(kind).is_some(), "{kind}");
        }
    }
}

#[test]
fn reads_rules_and_their_conditions() {
    let ide = read(json!({
        "$schema": "https://example.com/schema.json",
        "completions": [
            {
                "complete": "routeName",
                "condition": [
                    { "functionFqn": ["\\App\\link"], "parameters": [2, 3] },
                    { "methodNames": ["to"], "classParentFqn": ["\\App\\Links"], "parameterNames": ["route"] },
                    { "newClassFqn": ["App\\Link"], "place": "arrayValueWithKey", "keys": ["route"] },
                    { "place": "parameter" },
                    { "functionNames": ["x"], "place": "sideways" }
                ],
                "transformers": ["lower"]
            },
            {
                "complete": "staticStrings",
                "condition": { "functionNames": ["size"] },
                "options": { "strings": ["s", "m"], "stringsWithLocation": { "l": "sizes.php:3" }, "dataFile": "x" }
            },
            {
                "complete": "directoryFiles",
                "condition": [{ "functionNames": ["icon"] }],
                "options": { "directories": ["resources/icons"], "recursive": true, "suffixToClear": ".svg" }
            },
            { "complete": "bladeIcon", "condition": [{ "functionNames": ["svg"] }] },
            { "complete": "viewName", "condition": [{ "place": "parameter" }] }
        ],
        "auth": {}
    }));
    assert_eq!(ide.completions.len(), 3);
    let route = &ide.completions[0];
    assert_eq!(route.file, Path::new("/project/ide.json"));
    assert_eq!(route.conditions.len(), 3, "the last two can't match: {:?}", route.conditions);
    assert_eq!(route.conditions[0].function_fqns, ["App\\link"]);
    // 1-based in the file.
    assert_eq!(route.conditions[0].parameters, [1, 2]);
    assert_eq!(route.conditions[0].call_names(), ["link"]);
    assert_eq!(route.conditions[1].class_parents, ["App\\Links"]);
    assert_eq!(route.conditions[1].call_names(), ["to"]);
    assert!(route.conditions[2].is_new());
    assert_eq!(route.conditions[2].place, Place::ArrayValueWithKey);
    assert_eq!(route.conditions[2].call_names(), ["__construct"]);

    let strings = &ide.completions[1];
    assert_eq!(
        strings.options.strings,
        [("s".to_owned(), None), ("m".to_owned(), None), ("l".to_owned(), Some("sizes.php:3".to_owned()))]
    );
    let files = &ide.completions[2];
    assert_eq!(files.options.directories, [normalize(Path::new("/project/resources/icons"))]);
    assert!(files.options.recursive);
    assert_eq!(files.options.suffix_to_clear, ".svg");

    let ignored = ide.ignored.join("\n");
    for expected in [
        "completions[0].transformers: 'lower' is not a transformer",
        "completions[0].condition[3]: names no function",
        "completions[0].condition[4].place: 'sideways' is not a place",
        "completions[1].options.dataFile: cannot read",
        "completions[3].complete: 'bladeIcon' is not supported",
        "completions[4]: no usable condition",
        "auth: not supported",
    ] {
        assert!(ignored.contains(expected), "{expected} in\n{ignored}");
    }
    assert!(!ignored.contains("$schema"), "{ignored}");
}

#[test]
fn places_match_the_steps_to_the_string() {
    use Step::{Key, Value as V};
    let condition = |place: Place| Condition { place, keys: vec!["k".to_owned()], ..Condition::default() };
    let table: &[(Place, &[Step<'_>], bool)] = &[
        (Place::Parameter, &[], true),
        (Place::Parameter, &[V(None)], false),
        (Place::ArrayKey, &[Key], true),
        (Place::ArrayKey, &[V(None)], false),
        (Place::ArrayOnlyKey, &[V(None)], true),
        (Place::ArrayOnlyKey, &[V(Some("a"))], false),
        (Place::ArrayValue, &[V(Some("a"))], true),
        (Place::ArrayValue, &[V(None)], true),
        (Place::ArrayValue, &[V(None), V(None)], false),
        (Place::ArrayValueWithKey, &[V(Some("k"))], true),
        (Place::ArrayValueWithKey, &[V(Some("other"))], false),
        (Place::ArrayValueWithKey, &[V(None)], false),
        (Place::ArrayValueWithKeyArray, &[V(Some("k")), V(None)], true),
        (Place::ArrayValueWithKeyArray, &[V(Some("k"))], false),
        (Place::ArrayInArrayKey, &[V(None), Key], true),
        (Place::ArrayInArrayOnlyKey, &[V(Some("a")), V(None)], true),
        (Place::ArrayInArrayValue, &[V(None), V(Some("a"))], true),
        (Place::ReturnString, &[], true),
        (Place::ReturnArrayKey, &[Key], true),
        (Place::ReturnArrayValueWithKey, &[V(Some("k"))], true),
        (Place::ReturnInArrayValueWithKey, &[V(None), V(Some("k"))], true),
        (Place::ReturnInArrayValueWithKey, &[V(Some("k"))], false),
    ];
    for (place, steps, expected) in table {
        assert_eq!(condition(*place).place_matches(steps), *expected, "{place:?} {steps:?}");
    }
    // Without `keys`, any key.
    let any = Condition { place: Place::ArrayValueWithKey, ..Condition::default() };
    assert!(any.place_matches(&[V(Some("whatever"))]));
}

#[test]
fn arguments_by_position_or_name() {
    let first = Condition::default();
    assert!(first.argument_matches(Some(0), None));
    assert!(!first.argument_matches(Some(1), None));
    assert!(!first.argument_matches(None, Some("name")));
    let second = Condition { parameters: vec![1], parameter_names: vec!["name".to_owned()], ..Condition::default() };
    assert!(second.argument_matches(Some(1), None));
    assert!(!second.argument_matches(Some(0), None));
    assert!(second.argument_matches(None, Some("name")));
    let returned = Condition { place: Place::ReturnString, ..Condition::default() };
    assert!(returned.argument_matches(Some(0), None));
}

#[test]
fn reads_views_blade_and_packages() {
    let ide = read(json!({
        "view": { "paths": [{ "path": "views", "namespace": "pkg" }, { "path": "/more" }, { "namespace": "x" }] },
        "blade": {
            "components": {
                "viewPaths": [{ "path": "components", "prefix": "ui" }],
                "list": [{ "name": "chart", "namespace": "ui", "className": "\\Ui\\Chart" }, { "name": "plain" }],
                "fromConfig": true
            },
            "directives": [{ "name": "@money", "prefix": "<?php echo ", "suffix": "; ?>" }, { "name": "bad name" }],
            "ifDirectives": [{ "name": "feature", "prefix": "", "suffix": "" }],
            "scriptDirectives": [{ "name": "js" }]
        },
        "packages": {
            "enabledPackages": { "livewire/livewire": true },
            "disabledPackages": ["inertiajs/inertia-laravel"],
            "livewire": {
                "namespaces": [
                    { "tagPrefix": "admin", "classNamespace": "\\App\\Admin\\", "viewPath": "admin" },
                    { "tagPrefix": "x" }
                ]
            },
            "inertia": { "pagePaths": [{ "path": "resources/js/Pages", "suffix": ".vue" }] },
            "passport": { "scopes": { "read": "Read things" } }
        },
        "codeGenerations": [{ "id": "dto", "name": "DTO" }]
    }));
    let base = |rel: &str| normalize(&Path::new("/project").join(rel));
    assert_eq!(
        ide.view_paths,
        [
            ViewPath { path: base("views"), namespace: Some("pkg".to_owned()) },
            ViewPath { path: base("more"), namespace: None },
        ]
    );
    assert_eq!(
        ide.component_paths,
        [ComponentPath { path: base("components"), prefix: Some("ui".to_owned()), namespace: None }]
    );
    let components: Vec<(&str, Option<&str>)> =
        ide.components.iter().map(|c| (c.tag.as_str(), c.class.as_deref())).collect();
    assert_eq!(components, [("ui::chart", Some("Ui\\Chart")), ("plain", None)]);
    let directives: Vec<(&str, bool, &str)> =
        ide.directives.iter().map(|d| (d.name.as_str(), d.condition, d.prefix.as_str())).collect();
    assert_eq!(directives, [("money", false, "<?php echo "), ("feature", true, "")]);
    assert_eq!(ide.packages.enabled, ["livewire/livewire"]);
    assert_eq!(ide.packages.disabled, ["inertiajs/inertia-laravel"]);
    assert_eq!(ide.packages.livewire, [("admin".to_owned(), Some("App\\Admin".to_owned()), Some(base("admin")))]);
    assert_eq!(ide.packages.inertia_pages, [(base("resources/js/Pages"), String::new(), ".vue".to_owned())]);
    assert_eq!(ide.packages.passport_scopes, [("read".to_owned(), "Read things".to_owned())]);
    assert_eq!(ide.code_generations.len(), 1);
    let ignored = ide.ignored.join("\n");
    for expected in ["view.paths[2]: no path", "blade.components.fromConfig", "blade.scriptDirectives", "'bad name'"] {
        assert!(ignored.contains(expected), "{expected} in\n{ignored}");
    }
}

#[test]
fn loads_the_project_file_then_the_packages() {
    let tmp = tempfile::tempdir().unwrap();
    let root = dunce::canonicalize(tmp.path()).unwrap();
    let write = |rel: &str, text: &str| {
        let path = root.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    };
    write("ide.json", r#"{"blade": {"directives": [{"name": "own"}]}}"#);
    write("vendor/b/pkg/ide.json", r#"{"blade": {"directives": [{"name": "second"}]}}"#);
    write("vendor/a/pkg/ide.json", r#"{"blade": {"directives": [{"name": "first"}]}}"#);
    write("vendor/a/broken/ide.json", "{ not json");
    let ide = IdeJson::load(&root, &root.join("vendor"));
    let names: Vec<&str> = ide.directives.iter().map(|d| d.name.as_str()).collect();
    assert_eq!(names, ["own", "first", "second"]);
    assert_eq!(ide.files.len(), 3);
    assert!(ide.ignored.iter().any(|line| line.contains("broken")), "{:?}", ide.ignored);
}

#[test]
fn the_bundled_schema_describes_what_is_read() {
    let schema: Value = serde_json::from_str(IDE_JSON_SCHEMA).unwrap();
    for key in ["completions", "view", "blade", "codeGenerations", "packages"] {
        assert!(schema["properties"].get(key).is_some(), "{key}");
    }
    let completes = schema["definitions"]["completion"]["properties"]["complete"]["enum"].as_array().unwrap();
    for complete in completes {
        assert!(completion_kind(complete.as_str().unwrap()).is_some(), "{complete}");
    }
    let places = schema["definitions"]["condition"]["properties"]["place"]["enum"].as_array().unwrap();
    for place in places {
        assert!(Place::parse(place.as_str().unwrap()).is_some(), "{place}");
    }
}

#[test]
fn transformers_and_data_files() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("sizes.txt"), "ExtraLarge\n\n  small \n").unwrap();
    std::fs::write(dir.path().join("colors.json"), r#"["DarkRed", "light_blue"]"#).unwrap();
    std::fs::write(dir.path().join("places.json"), r#"{"home": "routes/web.php:3", "away": 1}"#).unwrap();
    let mut ide = IdeJson::default();
    ide.add(
        &dir.path().join("ide.json"),
        &json!({
            "completions": [
                {
                    "complete": "staticStrings",
                    "condition": [{ "functionNames": ["size"] }],
                    "options": { "dataFile": "sizes.txt", "strings": ["Medium"] },
                    "transformers": ["snakeCase", "shout"]
                },
                {
                    "complete": "staticStrings",
                    "condition": [{ "functionNames": ["color"] }],
                    "options": { "dataFile": "colors.json" },
                    "transformers": ["kebabCase"]
                },
                {
                    "complete": "staticStrings",
                    "condition": [{ "functionNames": ["place"] }],
                    "options": { "dataFile": "places.json" }
                },
                {
                    "complete": "directoryFiles",
                    "condition": [{ "functionNames": ["icon"] }],
                    "options": { "directories": ["icons"] },
                    "transformers": ["upperCase"]
                },
                {
                    "complete": "routeName",
                    "condition": [{ "functionNames": ["link"] }],
                    "transformers": ["lowerCase"]
                }
            ]
        }),
    );
    let strings = |i: usize| ide.completions[i].options.strings.iter().map(|(s, _)| s.clone()).collect::<Vec<_>>();
    assert_eq!(strings(0), ["extra_large", "small", "medium"]);
    assert_eq!(strings(1), ["dark-red", "light-blue"]);
    assert_eq!(
        ide.completions[2].options.strings,
        [("home".to_owned(), Some("routes/web.php:3".to_owned())), ("away".to_owned(), None)]
    );
    assert_eq!(ide.completions[3].options.transformers, ["upperCase"]);
    assert_eq!(super::transform("arrow-left", &ide.completions[3].options.transformers), "ARROW-LEFT");
    let ignored = ide.ignored.join("\n");
    assert!(ignored.contains("completions[0].transformers: 'shout' is not a transformer"), "{ignored}");
    assert!(ignored.contains("completions[4].transformers: not supported for routeName"), "{ignored}");
}
