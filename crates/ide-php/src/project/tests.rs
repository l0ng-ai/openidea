use super::*;
use serde_json::json;

/// Writes `files` (path, content) below `root`, creating folders.
fn write(root: &Path, files: &[(&str, &str)]) {
    for (path, content) in files {
        let path = root.join(path);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, content).unwrap();
    }
}

fn layout(root: &Path, include_paths: &[PathBuf], excludes: &[&str]) -> ProjectLayout {
    ProjectLayout::load(&LayoutConfig {
        root: root.to_path_buf(),
        include_paths: include_paths.to_vec(),
        excludes: excludes.iter().map(|s| s.to_string()).collect(),
    })
}

/// The walked files as `/`-separated paths relative to `base`, with their origins.
fn files(layout: &ProjectLayout, base: &Path) -> Vec<(String, Origin)> {
    let base = normalize(base);
    layout
        .files(&CancellationToken::new())
        .unwrap()
        .into_iter()
        .map(|(path, origin)| {
            let rel =
                path.strip_prefix(&base).unwrap_or_else(|_| panic!("{} outside {}", path.display(), base.display()));
            (rel.to_string_lossy().replace('\\', "/"), origin)
        })
        .collect()
}

fn project(paths: &[&str]) -> Vec<(String, Origin)> {
    paths.iter().map(|p| (p.to_string(), Origin::Project)).collect()
}

/// `origin_of` agrees with the walk for every walked file.
fn assert_origins_agree(layout: &ProjectLayout) {
    for (path, origin) in layout.files(&CancellationToken::new()).unwrap() {
        assert_eq!(layout.origin_of(&path), Some(origin), "{}", path.display());
    }
}

const PHP: &str = "<?php\n";

#[test]
fn whole_project_folder_without_composer() {
    let tmp = tempfile::tempdir().unwrap();
    write(
        tmp.path(),
        &[
            ("index.php", PHP),
            ("lib/a.PHP", PHP),
            ("views/page.phtml", "<p></p>"),
            ("readme.md", ""),
            ("assets/app.js", ""),
            ("vendor/x/y.php", PHP),
        ],
    );
    let layout = layout(tmp.path(), &[], &[]);
    assert!(!layout.has_composer());
    assert!(layout.autoload().is_empty());
    // Without installed.json nothing in the vendor directory is the project's.
    assert_eq!(files(&layout, tmp.path()), project(&["index.php", "lib/a.PHP", "views/page.phtml"]));
    assert_origins_agree(&layout);
    assert_eq!(layout.origin_of(&tmp.path().join("readme.md")), None);
    assert_eq!(layout.origin_of(&tmp.path().join("vendor/x/y.php")), None);
}

#[test]
fn root_autoload_maps_namespaces_and_reaches_outside_the_project() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("app");
    let composer = json!({
        "autoload": {
            "psr-4": { "App\\": "src/", "App\\Shared\\": ["../shared/src", "lib/shared"], "": "fallback/" },
            "psr-0": { "Legacy_": "old/", "Acme\\": "acme/" },
            "classmap": ["../shared/classes", "../shared/one.php"],
            "files": ["helpers.inc", "../shared/functions.php"]
        },
        "autoload-dev": { "psr-4": { "App\\Tests\\": "tests/" } }
    });
    write(
        &root,
        &[
            ("composer.json", &composer.to_string()),
            ("src/Model/User.php", PHP),
            ("bin/console.php", PHP),
            ("helpers.inc", PHP),
            ("tests/UserTest.php", PHP),
        ],
    );
    write(
        tmp.path(),
        &[
            ("shared/src/Clock.php", PHP),
            ("shared/classes/Map.php", PHP),
            ("shared/classes/notes.txt", ""),
            ("shared/one.php", PHP),
            ("shared/functions.php", PHP),
            ("shared/other.php", PHP),
        ],
    );
    let layout = layout(&root, &[], &[]);
    assert!(layout.has_composer());
    assert_eq!(
        files(&layout, tmp.path()),
        project(&[
            "app/bin/console.php",
            "app/helpers.inc",
            "app/src/Model/User.php",
            "app/tests/UserTest.php",
            "shared/classes/Map.php",
            "shared/functions.php",
            "shared/one.php",
            "shared/src/Clock.php",
        ])
    );
    assert_origins_agree(&layout);
    assert_eq!(layout.origin_of(&tmp.path().join("shared/other.php")), None);

    let map = layout.autoload();
    let root = normalize(&root);
    let shared = normalize(&tmp.path().join("shared"));
    assert_eq!(map.namespace_dirs("App\\Model"), [root.join("src").join("Model"), root.join("fallback/App/Model")]);
    assert_eq!(
        map.namespace_dirs("\\app\\shared\\"),
        [shared.join("src"), root.join("lib/shared"), root.join("src/shared"), root.join("fallback/app/shared")]
    );
    assert_eq!(
        map.namespace_dirs("App\\Tests"),
        [root.join("tests"), root.join("src/Tests"), root.join("fallback/App/Tests")]
    );
    assert_eq!(map.class_files("\\App\\Shared\\Clock")[0], shared.join("src/Clock.php"));
    assert_eq!(
        map.class_files("Legacy_Db_Row"),
        [root.join("old/Legacy/Db/Row.php"), root.join("fallback/Legacy_Db_Row.php")]
    );
    assert_eq!(map.class_files("Acme\\Util\\Str_Pad")[0], root.join("acme/Acme/Util/Str/Pad.php"));
    assert_eq!(map.namespace_dirs("Acme\\Util")[0], root.join("acme/Acme/Util"));
    assert_eq!(map.namespace_dirs("")[..], [root.join("old"), root.join("fallback")]);

    assert_eq!(map.namespace_of_dir(&root.join("src/Model/Admin")).as_deref(), Some("App\\Model\\Admin"));
    assert_eq!(map.namespace_of_dir(&root.join("src")).as_deref(), Some("App"));
    assert_eq!(map.namespace_of_dir(&shared.join("src/Time")).as_deref(), Some("App\\Shared\\Time"));
    assert_eq!(map.namespace_of_dir(&root.join("tests/Unit")).as_deref(), Some("App\\Tests\\Unit"));
    assert_eq!(map.namespace_of_dir(&root.join("acme/Acme/Util")).as_deref(), Some("Acme\\Util"));
    assert_eq!(map.namespace_of_dir(&root.join("fallback/Foo")).as_deref(), Some("Foo"));
    assert_eq!(map.namespace_of_dir(&root.join("src/./x/../Model")).as_deref(), Some("App\\Model"));
    assert_eq!(map.namespace_of_dir(&root.join("src/not-a-name")), None);
    assert_eq!(map.namespace_of_dir(&root.join("bin")), None);

    let dev: Vec<_> = map.roots().iter().filter(|r| r.dev).map(|r| r.prefix.as_str()).collect();
    assert_eq!(dev, ["App\\Tests\\"]);
}

#[test]
fn composer2_installed_packages_contribute_their_autoload_only() {
    let tmp = tempfile::tempdir().unwrap();
    let installed = json!({
        "packages": [
            {
                "name": "acme/http",
                "install-path": "../acme/http",
                "autoload": {
                    "psr-4": { "Acme\\Http\\": "src/" },
                    "files": ["src/functions.php"],
                    "exclude-from-classmap": ["/src/Tests/", "src/**/Fixtures/"]
                }
            },
            { "name": "acme/meta", "install-path": null },
            {
                "name": "phpunit/phpunit",
                "install-path": "../phpunit/phpunit",
                "autoload": { "classmap": ["src/"] }
            },
            { "name": "broken/autoload", "autoload": "nonsense" }
        ],
        "dev": true,
        "dev-package-names": ["phpunit/phpunit"]
    });
    write(
        tmp.path(),
        &[
            ("composer.json", r#"{"autoload": {"psr-4": {"App\\": "src/"}}}"#),
            (".gitignore", "/vendor/\n"),
            ("src/Kernel.php", PHP),
            ("vendor/composer/installed.json", &installed.to_string()),
            ("vendor/autoload.php", PHP),
            ("vendor/acme/http/src/Client.php", PHP),
            ("vendor/acme/http/src/functions.php", PHP),
            ("vendor/acme/http/src/Tests/ClientTest.php", PHP),
            ("vendor/acme/http/src/Deep/Fixtures/f.php", PHP),
            ("vendor/acme/http/tests/Other.php", PHP),
            ("vendor/acme/http/.gitignore", "src/\n"),
            ("vendor/phpunit/phpunit/src/TestCase.php", PHP),
            ("vendor/phpunit/phpunit/src/.git/x.php", PHP),
        ],
    );
    let layout = layout(tmp.path(), &[], &[]);
    let http = Origin::Package("acme/http".into());
    let phpunit = Origin::Package("phpunit/phpunit".into());
    assert_eq!(
        files(&layout, tmp.path()),
        [
            ("src/Kernel.php".to_string(), Origin::Project),
            ("vendor/acme/http/src/Client.php".to_string(), http.clone()),
            ("vendor/acme/http/src/functions.php".to_string(), http.clone()),
            ("vendor/phpunit/phpunit/src/TestCase.php".to_string(), phpunit.clone()),
        ]
    );
    assert_origins_agree(&layout);
    for outside in
        ["vendor/autoload.php", "vendor/acme/http/src/Tests/ClientTest.php", "vendor/acme/http/tests/Other.php"]
    {
        assert_eq!(layout.origin_of(&tmp.path().join(outside)), None, "{outside}");
    }
    let vendor = normalize(&tmp.path().join("vendor"));
    assert_eq!(layout.vendor_dir(), vendor);
    assert_eq!(layout.autoload().class_files("Acme\\Http\\Client"), [vendor.join("acme/http/src/Client.php")]);
    let http_root = &layout.autoload().roots()[1];
    assert_eq!((http_root.package.as_deref(), http_root.dev), (Some("acme/http"), false));
    assert!(layout.is_manifest(&tmp.path().join("composer.json")));
    assert!(layout.is_manifest(&tmp.path().join("vendor/composer/../composer/installed.json")));
    assert!(!layout.is_manifest(&tmp.path().join("vendor/acme/http/composer.json")));
}

#[test]
fn composer1_installed_json_and_a_custom_vendor_dir() {
    let tmp = tempfile::tempdir().unwrap();
    let installed = json!([
        { "name": "old/lib", "autoload": { "psr-0": { "Old_": "lib/" } } }
    ]);
    write(
        tmp.path(),
        &[
            ("composer.json", r#"{"config": {"vendor-dir": "deps/"}}"#),
            ("index.php", PHP),
            ("deps/composer/installed.json", &installed.to_string()),
            ("deps/old/lib/lib/Old/Thing.php", PHP),
            ("deps/old/lib/bin/tool.php", PHP),
            ("vendor/stray.php", PHP),
        ],
    );
    let layout = layout(tmp.path(), &[], &[]);
    let old = Origin::Package("old/lib".into());
    assert_eq!(
        files(&layout, tmp.path()),
        [
            ("deps/old/lib/lib/Old/Thing.php".to_string(), old),
            ("index.php".to_string(), Origin::Project),
            // `vendor` is an ordinary folder once the vendor directory moved.
            ("vendor/stray.php".to_string(), Origin::Project),
        ]
    );
    assert_origins_agree(&layout);
    assert_eq!(
        layout.autoload().class_files("Old_Thing"),
        [normalize(&tmp.path().join("deps/old/lib/lib/Old/Thing.php"))]
    );
}

#[test]
fn include_paths_and_excluded_folders() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("app");
    let installed = json!({ "packages": [
        { "name": "a/b", "install-path": "../a/b", "autoload": { "psr-4": { "A\\": "src/" } } }
    ]});
    write(
        &root,
        &[
            ("composer.json", r#"{"autoload": {"psr-4": {"App\\": "src/"}}}"#),
            ("src/Ok.php", PHP),
            ("src/Generated/Proxy.php", PHP),
            ("var/cache/container.php", PHP),
            ("templates/a.tpl.php", PHP),
            ("vendor/composer/installed.json", &installed.to_string()),
            ("vendor/a/b/src/Keep.php", PHP),
            ("vendor/a/b/src/Internal/Skip.php", PHP),
            ("lib/inside.php", PHP),
        ],
    );
    write(tmp.path(), &[("stubs/wp.php", PHP), ("stubs/sub/more.php", PHP), ("stubs/readme.txt", "")]);
    let include = [tmp.path().join("stubs"), root.join("lib")];
    let excludes = ["/var", "src/Generated", "*.tpl.php", "/vendor/a/b/src/Internal"];
    let layout = layout(&root, &include, &excludes);
    assert_eq!(
        files(&layout, tmp.path()),
        [
            ("app/lib/inside.php".to_string(), Origin::Project),
            ("app/src/Ok.php".to_string(), Origin::Project),
            ("app/vendor/a/b/src/Keep.php".to_string(), Origin::Package("a/b".into())),
            ("stubs/sub/more.php".to_string(), Origin::IncludePath),
            ("stubs/wp.php".to_string(), Origin::IncludePath),
        ]
    );
    assert_origins_agree(&layout);
    for excluded in [
        "var/cache/container.php",
        "src/Generated/Proxy.php",
        "templates/a.tpl.php",
        "vendor/a/b/src/Internal/Skip.php",
    ] {
        assert_eq!(layout.origin_of(&root.join(excluded)), None, "{excluded}");
    }

    // Excluding the whole vendor directory drops every package.
    let layout = self::layout(&root, &[], &["/vendor"]);
    assert!(files(&layout, tmp.path()).iter().all(|(_, origin)| *origin == Origin::Project));
    assert_eq!(layout.origin_of(&root.join("vendor/a/b/src/Keep.php")), None);
}

#[test]
fn from_settings_reads_include_paths_and_exclusions() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("app");
    write(&root, &[("a.php", PHP), ("build/gen.php", PHP), ("node_modules/x.php", PHP)]);
    write(tmp.path(), &[("platform/core.php", PHP)]);
    let mut settings = Settings::default();
    settings.languages.php.include_paths = vec!["../platform".into()];
    settings.project_structure.excluded = vec!["build".into()];
    let layout = ProjectLayout::from_settings(&root, &settings);
    assert_eq!(
        files(&layout, tmp.path()),
        [("app/a.php".to_string(), Origin::Project), ("platform/core.php".to_string(), Origin::IncludePath)]
    );
}

#[test]
fn broken_manifests_fall_back_to_the_project_folder() {
    for composer in ["{ not json", "[1, 2]", "\"text\""] {
        let tmp = tempfile::tempdir().unwrap();
        write(
            tmp.path(),
            &[
                ("composer.json", composer),
                ("a.php", PHP),
                ("vendor/composer/installed.json", "{ broken"),
                ("vendor/p/q.php", PHP),
            ],
        );
        let layout = layout(tmp.path(), &[], &[]);
        assert!(!layout.has_composer(), "{composer}");
        assert_eq!(files(&layout, tmp.path()), project(&["a.php"]), "{composer}");
    }
    // A readable composer.json with a broken installed.json keeps the root rules.
    let tmp = tempfile::tempdir().unwrap();
    write(
        tmp.path(),
        &[
            ("composer.json", r#"{"autoload": {"psr-4": {"App\\": ["src/", 3]}, "classmap": 7}}"#),
            ("src/A.php", PHP),
            ("vendor/composer/installed.json", "{ broken"),
        ],
    );
    let layout = layout(tmp.path(), &[], &[]);
    assert_eq!(layout.autoload().roots().len(), 1);
    assert_eq!(files(&layout, tmp.path()), project(&["src/A.php"]));
}

#[test]
fn cancelled_walk_reports_cancelled() {
    let tmp = tempfile::tempdir().unwrap();
    write(tmp.path(), &[("a.php", PHP)]);
    let cancel = CancellationToken::new();
    cancel.cancel();
    let err = layout(tmp.path(), &[], &[]).files(&cancel).unwrap_err();
    assert_eq!(err.kind, ide_core::error::ErrorKind::Cancelled);
}

#[test]
fn exclude_from_classmap_patterns() {
    let cases = [
        ("Tests/", "Tests/A.php", true),
        ("Tests/", "src/Tests/A.php", false),
        ("**/Tests/", "src/Deep/Tests/A.php", true),
        ("src/*/Fixtures", "src/Http/Fixtures/a.php", true),
        ("src/*/Fixtures", "src/Http/Deep/Fixtures/a.php", false),
        ("src/Legacy.php", "src/Legacy.php", true),
        ("src/Legacy", "src/LegacyThing.php", true),
        ("src/Legacy.php", "src/Other.php", false),
    ];
    for (pattern, path, expected) in cases {
        assert_eq!(prefix_glob(pattern.as_bytes(), path.as_bytes()), expected, "{pattern} on {path}");
    }
}

#[test]
fn php_app_fixture() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/php-app");
    let layout = layout(&root, &[], &[]);
    let root = normalize(&root);
    let map = layout.autoload();
    assert_eq!(map.namespace_dirs("App"), [root.join("src")]);
    assert_eq!(map.namespace_dirs("Tests"), [root.join("tests")]);
    assert_eq!(map.namespace_of_dir(&root.join("src/Model")).as_deref(), Some("App\\Model"));
    assert!(map.roots().iter().any(|r| r.prefix == "Tests\\" && r.dev && r.package.is_none()));
    let all = files(&layout, &root);
    assert!(all.iter().all(|(_, origin)| *origin == Origin::Project));
    for expected in ["bin/library.php", "src/functions.php", "src/constants.php"] {
        assert!(all.iter().any(|(path, _)| path == expected), "{expected} in {all:?}");
    }
    assert_origins_agree(&layout);
}
