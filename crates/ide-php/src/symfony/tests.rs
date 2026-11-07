use std::path::Path;

use ide_core::{Pos, Range};

use super::*;
use crate::summary::{RouteAttribute, SymfonyFacts};

/// A project folder with these files.
fn project(files: &[(&str, &str)]) -> tempfile::TempDir {
    let tmp = tempfile::tempdir().unwrap();
    for (rel, text) in files {
        let path = tmp.path().join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }
    tmp
}

const SERVICES: &str = "\
imports:
    - { resource: 'packages/mailer.yaml' }
    - { resource: 'extra/*.yaml' }
    - resource: dir/

parameters:
    locale: en

services:
    _defaults:
        autowire: true
        autoconfigure: true

    App\\:
        resource: '../src/'
        exclude: '../src/{Entity,Kernel.php}'

    mailer.default:
        class: App\\Service\\Mailer
        arguments: ['@logger']

    mailer: '@mailer.default'
    mailer.alias: { alias: mailer }
    mailer.child:
        parent: mailer.default
    App\\Service\\Clock: ~
    App\\Contract\\ClockInterface: '@App\\Service\\Clock'
    'quoted.id': { class: '\\App\\Service\\Quoted' }
    factory.made:
        factory: ['@factory', 'make']

when@test:
    services:
        test.mailer: { class: App\\Tests\\FakeMailer }
";

#[test]
fn services_and_their_imports() {
    let tmp = project(&[
        ("config/services.yaml", SERVICES),
        ("config/services_test.yaml", "services:\n    from.suffixed: { class: App\\Suffixed }\n"),
        ("config/packages/mailer.yaml", "services:\n    imported.mailer: { class: App\\Imported }\n"),
        ("config/extra/a.yaml", "services:\n    glob.a: { class: App\\GlobA }\n"),
        ("config/extra/b.txt", "services:\n    not.yaml: { class: App\\No }\n"),
        ("config/dir/nested/c.yml", "services:\n    dir.c: { class: App\\DirC }\n"),
        ("config/routes.yaml", "home:\n    path: /\n"),
    ]);
    let config = SymfonyConfig::load(tmp.path());
    let ids: Vec<&str> = config.services.iter().map(|service| service.id.as_str()).collect();
    for id in ["mailer.default", "mailer", "App\\Service\\Clock", "test.mailer", "from.suffixed"] {
        assert!(ids.contains(&id), "{id} in {ids:?}");
    }
    for id in ["imported.mailer", "glob.a", "dir.c"] {
        assert!(ids.contains(&id), "imported {id} in {ids:?}");
    }
    assert!(!ids.contains(&"not.yaml") && !ids.contains(&"App\\") && !ids.contains(&"_defaults"), "{ids:?}");
    let class = |id: &str| config.service_class(id);
    assert_eq!(class("mailer.default").as_deref(), Some("App\\Service\\Mailer"));
    assert_eq!(class("mailer").as_deref(), Some("App\\Service\\Mailer"), "an alias");
    assert_eq!(class("mailer.alias").as_deref(), Some("App\\Service\\Mailer"), "an alias of an alias");
    assert_eq!(class("mailer.child").as_deref(), Some("App\\Service\\Mailer"), "a parent's class");
    assert_eq!(class("App\\Service\\Clock").as_deref(), Some("App\\Service\\Clock"));
    assert_eq!(class("App\\Contract\\ClockInterface").as_deref(), Some("App\\Service\\Clock"));
    assert_eq!(class("quoted.id").as_deref(), Some("App\\Service\\Quoted"));
    assert_eq!(class("test.mailer").as_deref(), Some("App\\Tests\\FakeMailer"));
    assert_eq!(class("factory.made"), None, "a factory's product isn't known");
    assert_eq!(class("unknown.id"), None);
    // Ids not in the configuration that name classes stay classes.
    assert_eq!(class("App\\Other").as_deref(), Some("App\\Other"));
    let mailer = config.service("mailer.default").unwrap();
    assert_eq!(mailer.file, tmp.path().join("config/services.yaml"));
    assert_eq!(mailer.range, Range::new(Pos::new(17, 4), Pos::new(17, 18)));
}

#[test]
fn alias_cycles_end() {
    let mut config = SymfonyConfig::default();
    config.add_services(Path::new("services.yaml"), "services:\n    a: '@b'\n    b: '@a'\n");
    assert_eq!(config.service_class("a"), None);
}

#[test]
fn routes_of_the_routes_files() {
    let tmp = project(&[
        (
            "config/routes.yaml",
            "\
controllers:
    resource: ../src/Controller/
    type: attribute

blog_list:
    path: /blog
    controller: App\\Controller\\BlogController::list

blog_show:
    path:
        en: /blog/{slug}
        fr: /blogue/{slug}

old_blog: { alias: blog_list }

when@dev:
    _profiler:
        path: /_profiler
",
        ),
        ("config/routes_extra.yaml", "extra_page:\n    path: /extra\n"),
        ("config/routes/admin/admin.yaml", "admin_home: { path: /admin }\n"),
        (
            "config/routes/framework.yaml",
            "when@dev:\n    _errors:\n        resource: '@FrameworkBundle/Resources/config/routing/errors.xml'\n",
        ),
    ]);
    let config = SymfonyConfig::load(tmp.path());
    let routes: Vec<(&str, Option<&str>)> =
        config.routes.iter().map(|route| (route.name.as_str(), route.path.as_deref())).collect();
    assert_eq!(
        routes,
        [
            ("blog_list", Some("/blog")),
            ("blog_show", Some("/blog/{slug}")),
            ("old_blog", None),
            ("_profiler", Some("/_profiler")),
            ("extra_page", Some("/extra")),
            ("admin_home", Some("/admin")),
        ]
    );
    let list = &config.routes[0];
    assert_eq!(list.file.as_deref(), Some(tmp.path().join("config/routes.yaml").as_path()));
    assert_eq!(list.range, Range::new(Pos::new(4, 0), Pos::new(4, 9)));
}

#[test]
fn no_config_folder_no_facts() {
    let tmp = project(&[("src/a.php", "<?php\n")]);
    assert_eq!(SymfonyConfig::load(tmp.path()), SymfonyConfig::default());
}

#[test]
fn the_project_merges_the_configuration_and_the_php_facts() {
    let mut config = SymfonyConfig::default();
    config.add_routes(Path::new("routes.yaml"), "home:\n    path: /\n");
    let facts = SymfonyFacts {
        routes: vec![RouteAttribute {
            name: "blog".to_owned(),
            path: Some("/blog".to_owned()),
            loc: Default::default(),
        }],
        repositories: vec![crate::summary::RepositoryEntity {
            repository: "App\\Repository\\PostRepository".to_owned(),
            entity: "App\\Entity\\Post".to_owned(),
        }],
    };
    let project = SymfonyProject::new(config, [(Some(Path::new("src/Blog.php")), &facts)]);
    let names: Vec<&str> = project.routes.iter().map(|route| route.name.as_str()).collect();
    assert_eq!(names, ["home", "blog"]);
    assert_eq!(project.route("blog").unwrap().file.as_deref(), Some(Path::new("src/Blog.php")));
    assert_eq!(project.entity_of("\\app\\repository\\postrepository"), Some("App\\Entity\\Post"));
    assert_eq!(project.entity_of("App\\Repository\\Other"), None);
}
