//! The service providers of a Laravel project and what the providers of
//! packages register (roadmap phase 8.23).
//!
//! - **Providers** ([`discover`]): the ones the application registers
//!   (`bootstrap/providers.php` of Laravel 11, the `providers` of
//!   `config/app.php` before), the module providers of `konekt/concord`
//!   (the `modules` of `config/concord.php`), the ones packages list under
//!   `extra.laravel.providers` in `vendor/composer/installed.json` (package
//!   discovery), and every provider those register in turn with
//!   `$this->app->register(Foo::class)`. Classes are found through the
//!   PSR-4 and PSR-0 autoload rules of the project and its packages.
//! - **Concord modules:** each module provider of `config/concord.php` is a
//!   module ([`ModuleKind::Concord`]) whose folder holds its `Providers`
//!   folder (`packages/Webkul/Shop/src`) and whose name is the namespace
//!   segment before it (`Shop`).
//! - **Registrations** ([`PackageRegistrations`], one part per provider):
//!   `loadTranslationsFrom(path, 'ns')` (no namespace: more folders of the
//!   application's translations), `loadJsonTranslationsFrom(path)`,
//!   `loadMigrationsFrom(path)` and `publishes([from => to], 'group')`. The
//!   views (`loadViewsFrom`), configuration (`mergeConfigFrom`), routes
//!   (`loadRoutesFrom`, `Route::…->group(path)`) and middleware
//!   (`aliasMiddleware`, `middlewareGroup`) providers register are read by
//!   their own parts of the model.
//!
//! Only Laravel's documentation and source (MIT) and konekt/concord's
//! documentation (MIT) are design inputs.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use mago_span::HasSpan;
use mago_syntax::cst::{
    Access, Argument, ArrayElement, Call, ClassLikeConstantSelector, ClassLikeMemberSelector, Expression, Literal,
};
use mago_syntax::walker::Walker;

use super::LaravelProject;
use super::parts::PartReader;
use super::project::{Module, ModuleKind};
use super::views::{call_arguments, path_expression, provider_files, string_literal};
use crate::names::{FileNames, NameKind, Resolution};
use crate::project::composer::{RootManifest, installed_packages};
use crate::project::normalize;
use crate::project::{AutoloadMap, AutoloadStandard, NamespaceRoot};
use crate::syntax::ParsedFile;

/// The most provider files followed, against runaway registrations.
const MAX_PROVIDERS: usize = 4000;

/// What [`discover`] finds.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Discovery {
    /// The provider files, in registration order, without the ones of
    /// `app/Providers` and of the modules' provider folders.
    pub providers: Vec<PathBuf>,
    /// The modules of `konekt/concord`.
    pub concord: Vec<Module>,
}

/// The service providers of the project at `root` and its Concord modules;
/// `local` are the providers already known (`app/Providers`, the modules'),
/// whose registrations are followed too.
pub(crate) fn discover(root: &Path, vendor: &Path, manifest: Option<&RootManifest>, local: &[PathBuf]) -> Discovery {
    let classes = ClassFiles::new(root, vendor, manifest);
    let read = |path: &Path| std::fs::read_to_string(path).ok().map(|text| ParsedFile::parse("providers.php", text));
    let mut registered: Vec<String> = Vec::new();
    if let Some(parsed) = read(&root.join("bootstrap").join("providers.php")) {
        registered.extend(class_constants(&parsed, None));
    }
    let config = root.join("config");
    if let Some(parsed) = read(&config.join("app.php")) {
        registered.extend(class_constants(&parsed, Some("providers")));
    }
    let mut concord = Vec::new();
    if let Some(parsed) = read(&config.join("concord.php")) {
        for class in class_constants(&parsed, Some("modules")) {
            if let Some(file) = classes.file(&class) {
                concord.extend(concord_module(&class, &file));
                registered.push(class);
            }
        }
    }
    registered.extend(discovered_providers(vendor));

    let mut out = Discovery { providers: Vec::new(), concord };
    let mut seen: Vec<PathBuf> = local.to_vec();
    let mut queue: Vec<PathBuf> = local.to_vec();
    for class in registered {
        if let Some(file) = classes.file(&class)
            && !seen.contains(&file)
        {
            seen.push(file.clone());
            queue.push(file.clone());
            out.providers.push(file);
        }
    }
    // `$this->app->register(Other::class)`, breadth first.
    let mut next = 0;
    while next < queue.len() && seen.len() < MAX_PROVIDERS {
        let Some(parsed) = read(&queue[next]) else {
            next += 1;
            continue;
        };
        next += 1;
        for class in registered_by(&parsed) {
            if let Some(file) = classes.file(&class)
                && !seen.contains(&file)
            {
                seen.push(file.clone());
                queue.push(file.clone());
                out.providers.push(file);
            }
        }
    }
    out.concord.sort_by(|a, b| a.path.cmp(&b.path));
    out.concord.dedup_by(|later, earlier| later.path == earlier.path);
    out
}

/// The files of classes, through the autoload rules of the project and of
/// its installed packages.
struct ClassFiles {
    map: AutoloadMap,
}

impl ClassFiles {
    fn new(root: &Path, vendor: &Path, manifest: Option<&RootManifest>) -> Self {
        let mut map = AutoloadMap::default();
        let mut add =
            |base: &Path, autoload: &crate::project::composer::Autoload, dev: bool, package: Option<String>| {
                for (standard, rules) in
                    [(AutoloadStandard::Psr4, &autoload.psr4), (AutoloadStandard::Psr0, &autoload.psr0)]
                {
                    for (prefix, dirs) in rules {
                        for dir in dirs {
                            map.push(NamespaceRoot {
                                prefix: prefix.clone(),
                                dir: normalize(&base.join(dir)),
                                standard,
                                dev,
                                package: package.clone(),
                            });
                        }
                    }
                }
            };
        if let Some(manifest) = manifest {
            add(root, &manifest.autoload, false, None);
            add(root, &manifest.autoload_dev, true, None);
        }
        for package in installed_packages(vendor) {
            add(&normalize(&package.dir), &package.autoload, package.dev, Some(package.name));
        }
        Self { map }
    }

    /// The existing file of class `fqn`.
    fn file(&self, fqn: &str) -> Option<PathBuf> {
        self.map.class_files(fqn).into_iter().find(|file| file.is_file()).map(|file| normalize(&file))
    }
}

/// The providers packages list under `extra.laravel.providers` in
/// `installed.json`.
fn discovered_providers(vendor: &Path) -> Vec<String> {
    let Ok(text) = std::fs::read_to_string(vendor.join("composer").join("installed.json")) else { return Vec::new() };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) else { return Vec::new() };
    let packages = json.get("packages").unwrap_or(&json).as_array().cloned().unwrap_or_default();
    packages
        .iter()
        .filter_map(|package| package.pointer("/extra/laravel/providers").and_then(|p| p.as_array()))
        .flatten()
        .filter_map(|provider| provider.as_str())
        .map(|provider| provider.trim_start_matches('\\').to_owned())
        .collect()
}

/// The global class aliases of a Laravel application, `(alias, class)`:
/// Laravel's defaults (`Facade::defaultAliases()`, which before Laravel 11
/// sat in `config/app.php`), the `aliases` packages list under
/// `extra.laravel` in `installed.json`, then the `aliases` of
/// `config/app.php`. Later entries win.
pub(crate) fn class_aliases(root: &Path, vendor: &Path) -> Vec<(String, String)> {
    let mut aliases: Vec<(String, String)> = super::refs::intentions::ALIASES
        .iter()
        .map(|(alias, class)| ((*alias).to_owned(), (*class).to_owned()))
        .collect();
    if let Ok(text) = std::fs::read_to_string(vendor.join("composer").join("installed.json"))
        && let Ok(json) = serde_json::from_str::<serde_json::Value>(&text)
    {
        let packages = json.get("packages").unwrap_or(&json).as_array().cloned().unwrap_or_default();
        for package in &packages {
            let Some(listed) = package.pointer("/extra/laravel/aliases").and_then(|a| a.as_object()) else { continue };
            for (alias, class) in listed {
                if let Some(class) = class.as_str() {
                    aliases.push((alias.clone(), class.trim_start_matches('\\').to_owned()));
                }
            }
        }
    }
    if let Ok(text) = std::fs::read_to_string(root.join("config").join("app.php")) {
        let parsed = ParsedFile::parse("app.php", text);
        if let Some(within) = KeyFinder::find(&parsed, "aliases") {
            let mut collect = Aliases { names: FileNames::resolve(&parsed), within, aliases: Vec::new() };
            AliasWalker.walk_program(parsed.program(), &mut collect);
            aliases.extend(collect.aliases);
        }
    }
    let mut out: Vec<(String, String)> = Vec::new();
    for (alias, class) in aliases.into_iter().rev() {
        if !alias.contains('\\') && !out.iter().any(|(known, _)| known.eq_ignore_ascii_case(&alias)) {
            out.push((alias, class));
        }
    }
    out.reverse();
    out
}

struct Aliases {
    names: FileNames,
    within: (u32, u32),
    aliases: Vec<(String, String)>,
}

struct AliasWalker;

impl<'a> Walker<'a, 'a, Aliases> for AliasWalker {
    fn walk_in_expression(&self, expr: &'a Expression<'a>, cx: &mut Aliases) {
        let span = expr.span();
        if span.start.offset < cx.within.0 || span.end.offset > cx.within.1 {
            return;
        }
        let elements: Vec<&ArrayElement<'_>> = match expr {
            Expression::Array(array) => array.elements.iter().collect(),
            Expression::LegacyArray(array) => array.elements.iter().collect(),
            _ => return,
        };
        for element in elements {
            let ArrayElement::KeyValue(element) = element else { continue };
            let Expression::Literal(Literal::String(key)) = element.key else { continue };
            let Some(alias) = key.value.map(lossy) else { continue };
            let class = resolve(&cx.names, element.value).or_else(|| match element.value {
                Expression::Literal(Literal::String(string)) => {
                    string.value.map(|value| lossy(value).trim_start_matches('\\').to_owned())
                }
                _ => None,
            });
            if let Some(class) = class {
                cx.aliases.push((alias, class));
            }
        }
    }
}

/// The Concord module whose module provider is `class` in `file`
/// (`Webkul\Shop\Providers\ModuleServiceProvider`).
fn concord_module(class: &str, file: &Path) -> Option<Module> {
    let namespace = class.rsplit_once('\\')?.0;
    let (module_namespace, last) = namespace.rsplit_once('\\').unwrap_or(("", namespace));
    let (module_namespace, path) = if last.eq_ignore_ascii_case("Providers") {
        (module_namespace, file.parent()?.parent()?)
    } else {
        (namespace, file.parent()?)
    };
    let name = module_namespace.rsplit('\\').next().filter(|name| !name.is_empty())?.to_owned();
    Some(Module {
        name,
        path: normalize(path),
        namespace: Some(format!("{module_namespace}\\")),
        kind: ModuleKind::Concord,
        enabled: true,
    })
}

fn lossy(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

/// The classes `Foo::class` names, and class-name strings, inside the
/// value of the array key `key` (the whole file when `None`), in order.
fn class_constants(parsed: &ParsedFile, key: Option<&str>) -> Vec<String> {
    let mut collect = Collect { names: FileNames::resolve(parsed), within: None, classes: Vec::new() };
    if let Some(key) = key {
        collect.within = KeyFinder::find(parsed, key);
        if collect.within.is_none() {
            return Vec::new();
        }
    }
    ClassWalker.walk_program(parsed.program(), &mut collect);
    collect.classes
}

/// The classes a provider registers: `->register(Foo::class)`.
fn registered_by(parsed: &ParsedFile) -> Vec<String> {
    let mut collect = Registered { names: FileNames::resolve(parsed), classes: Vec::new() };
    RegisterWalker.walk_program(parsed.program(), &mut collect);
    collect.classes
}

fn resolve(names: &FileNames, expr: &Expression<'_>) -> Option<String> {
    let Expression::Access(Access::ClassConstant(access)) = expr else { return None };
    let ClassLikeConstantSelector::Identifier(constant) = &access.constant else { return None };
    if !constant.value.eq_ignore_ascii_case(b"class") {
        return None;
    }
    let Expression::Identifier(identifier) = access.class else { return None };
    let scope = names.scope_at(identifier.span().start.offset);
    match scope.resolve(NameKind::ClassLike, &lossy(identifier.value())).resolution {
        Resolution::Fqn(fqn) | Resolution::Fallback { namespaced: fqn, .. } => {
            Some(fqn.trim_start_matches('\\').to_owned())
        }
        Resolution::Relative(_) => None,
    }
}

struct Collect {
    names: FileNames,
    /// The byte range of the key's value.
    within: Option<(u32, u32)>,
    classes: Vec<String>,
}

struct ClassWalker;

impl<'a> Walker<'a, 'a, Collect> for ClassWalker {
    fn walk_in_expression(&self, expr: &'a Expression<'a>, cx: &mut Collect) {
        let span = expr.span();
        if let Some((start, end)) = cx.within
            && (span.start.offset < start || span.end.offset > end)
        {
            return;
        }
        if let Some(class) = resolve(&cx.names, expr) {
            cx.classes.push(class);
        } else if let Expression::Literal(Literal::String(string)) = expr
            && let Some(value) = string.value
            && value.contains(&b'\\')
            && !value.contains(&b' ')
        {
            cx.classes.push(lossy(value).trim_start_matches('\\').to_owned());
        }
    }
}

/// The value of the first array element keyed `key`.
struct KeyFinder<'k> {
    key: &'k str,
    found: Option<(u32, u32)>,
}

impl KeyFinder<'_> {
    fn find(parsed: &ParsedFile, key: &str) -> Option<(u32, u32)> {
        let mut finder = KeyFinder { key, found: None };
        KeyWalker.walk_program(parsed.program(), &mut finder);
        finder.found
    }
}

struct KeyWalker;

impl<'a> Walker<'a, 'a, KeyFinder<'_>> for KeyWalker {
    fn walk_in_expression(&self, expr: &'a Expression<'a>, cx: &mut KeyFinder<'_>) {
        if cx.found.is_some() {
            return;
        }
        let elements: Vec<&ArrayElement<'_>> = match expr {
            Expression::Array(array) => array.elements.iter().collect(),
            Expression::LegacyArray(array) => array.elements.iter().collect(),
            _ => return,
        };
        for element in elements {
            let ArrayElement::KeyValue(element) = element else { continue };
            let Expression::Literal(Literal::String(key)) = element.key else { continue };
            if key.value.is_some_and(|value| value == cx.key.as_bytes()) {
                let span = element.value.span();
                cx.found = Some((span.start.offset, span.end.offset));
                return;
            }
        }
    }
}

struct Registered {
    names: FileNames,
    classes: Vec<String>,
}

struct RegisterWalker;

impl<'a> Walker<'a, 'a, Registered> for RegisterWalker {
    fn walk_in_expression(&self, expr: &'a Expression<'a>, cx: &mut Registered) {
        let (method, list) = match expr {
            Expression::Call(Call::Method(call)) => (&call.method, &call.argument_list),
            Expression::Call(Call::NullSafeMethod(call)) => (&call.method, &call.argument_list),
            Expression::Call(Call::StaticMethod(call)) => (&call.method, &call.argument_list),
            _ => return,
        };
        let ClassLikeMemberSelector::Identifier(name) = method else { return };
        if !name.value.eq_ignore_ascii_case(b"register") {
            return;
        }
        let first = match list.arguments.first() {
            Some(Argument::Positional(argument)) => argument.value,
            Some(Argument::Named(argument)) => argument.value,
            None => return,
        };
        if let Some(class) = resolve(&cx.names, first) {
            cx.classes.push(class);
        }
    }
}

// ------------------------------------------------------- registrations

/// What one service provider registers besides views, configuration,
/// routes and middleware; see the module documentation.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PackageRegistrations {
    /// `loadTranslationsFrom(path, 'ns')`: the namespace (`None` without
    /// one) and the folder.
    pub translations: Vec<(Option<String>, PathBuf)>,
    /// `loadJsonTranslationsFrom(path)`.
    pub json_translations: Vec<PathBuf>,
    /// `loadMigrationsFrom(path)` (a folder, or one file).
    pub migrations: Vec<PathBuf>,
    /// `publishes([from => to], 'group')`.
    pub publishes: Vec<Published>,
}

/// One file or folder a provider publishes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Published {
    pub from: PathBuf,
    pub to: PathBuf,
    /// The tag (`config`, `views`, `shop-assets`).
    pub group: Option<String>,
}

impl PackageRegistrations {
    /// What the provider `path` (text `text`) of `project` registers.
    pub fn read(project: &LaravelProject, path: &Path, text: &str) -> Self {
        let mut out = Self::default();
        for (open, name) in calls(text, &["loadTranslationsFrom", "loadJsonTranslationsFrom", "loadMigrationsFrom"]) {
            let Some(args) = call_arguments(text, open) else { continue };
            let paths = |arg: &String| -> Vec<PathBuf> {
                if arg.starts_with('[') {
                    // `loadMigrationsFrom([a, b])`.
                    call_arguments(arg, 0)
                        .unwrap_or_default()
                        .iter()
                        .filter_map(|one| path_expression(project, path, one))
                        .collect()
                } else {
                    path_expression(project, path, arg).into_iter().collect()
                }
            };
            let Some(first) = args.first() else { continue };
            match name {
                "loadTranslationsFrom" => {
                    let namespace = args.get(1).and_then(|ns| string_literal(ns));
                    out.translations.extend(paths(first).into_iter().map(|dir| (namespace.clone(), dir)));
                }
                "loadJsonTranslationsFrom" => out.json_translations.extend(paths(first)),
                _ => out.migrations.extend(paths(first)),
            }
        }
        for (open, _) in calls(text, &["publishes"]) {
            let Some(args) = call_arguments(text, open) else { continue };
            let Some(pairs) = args.first().filter(|first| first.starts_with('[')) else { continue };
            let group = args.get(1).and_then(|group| string_literal(group));
            for pair in call_arguments(pairs, 0).unwrap_or_default() {
                let Some((from, to)) = split_arrow(&pair) else { continue };
                let (Some(from), Some(to)) = (path_expression(project, path, from), path_expression(project, path, to))
                else {
                    continue;
                };
                out.publishes.push(Published { from, to, group: group.clone() });
            }
        }
        out
    }

    pub fn is_empty(&self) -> bool {
        *self == Self::default()
    }
}

/// What each service provider of `project` ([`provider_files`]) registers,
/// from `parts`, in provider order.
pub fn package_registrations(
    project: &LaravelProject,
    parts: &impl PartReader,
) -> Vec<(PathBuf, Arc<PackageRegistrations>)> {
    // The folders a provider names are relative to the project's.
    let context = format!("{:?}", project.paths);
    provider_files(project)
        .into_iter()
        .filter_map(|provider| {
            let part = parts.part("provider-registrations", &provider, &context, &|text| {
                PackageRegistrations::read(project, &provider, text)
            })?;
            Some((provider, part))
        })
        .collect()
}

/// The `(` of each call of a method in `names` (as `name(`), with its name.
fn calls<'n>(text: &str, names: &[&'n str]) -> Vec<(usize, &'n str)> {
    let mut out = Vec::new();
    for name in names {
        let needle = format!("{name}(");
        let mut from = 0;
        while let Some(at) = text[from..].find(&needle) {
            let start = from + at;
            from = start + needle.len();
            // A whole name: `->loadMigrationsFrom(`, not `fooloadMigrationsFrom(`.
            let before = text[..start].chars().next_back();
            if before.is_some_and(|c| c.is_alphanumeric() || c == '_') {
                continue;
            }
            out.push((start + name.len(), *name));
        }
    }
    out.sort_by_key(|(open, _)| *open);
    out
}

/// `from => to` at its top-level arrow.
pub(super) fn split_arrow(pair: &str) -> Option<(&str, &str)> {
    let b = pair.as_bytes();
    let mut depth = 0usize;
    let mut i = 0;
    while i + 1 < b.len() {
        match b[i] {
            b'(' | b'[' => depth += 1,
            b')' | b']' => depth = depth.saturating_sub(1),
            quote @ (b'\'' | b'"') => {
                i += 1;
                while i < b.len() && b[i] != quote {
                    if b[i] == b'\\' {
                        i += 1;
                    }
                    i += 1;
                }
            }
            b'=' if depth == 0 && b[i + 1] == b'>' => return Some((pair[..i].trim(), pair[i + 2..].trim())),
            _ => {}
        }
        i += 1;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arrows_and_calls() {
        assert_eq!(split_arrow("__DIR__.'/a' => config_path('a.php')"), Some(("__DIR__.'/a'", "config_path('a.php')")));
        assert_eq!(split_arrow("'a=>b'"), None);
        let text = "$this->loadMigrationsFrom(x); fooloadMigrationsFrom(y); $this->publishes([]);";
        let found: Vec<&str> = calls(text, &["loadMigrationsFrom", "publishes"]).into_iter().map(|(_, n)| n).collect();
        assert_eq!(found, ["loadMigrationsFrom", "publishes"]);
    }

    #[test]
    fn concord_modules_are_named_after_their_namespace() {
        let file = Path::new("/app/packages/Webkul/Shop/src/Providers/ModuleServiceProvider.php");
        let module = concord_module("Webkul\\Shop\\Providers\\ModuleServiceProvider", file).unwrap();
        assert_eq!(module.name, "Shop");
        assert_eq!(module.path, normalize(Path::new("/app/packages/Webkul/Shop/src")));
        assert_eq!(module.namespace.as_deref(), Some("Webkul\\Shop\\"));
        assert_eq!(module.kind, ModuleKind::Concord);
    }

    #[test]
    fn class_constants_of_a_key() {
        let parsed = ParsedFile::parse(
            "app.php",
            "<?php\nuse App\\Providers\\AppServiceProvider;\nreturn ['name' => Foo::class, 'providers' => \
             ServiceProvider::defaultProviders()->merge([AppServiceProvider::class, 'Vendor\\\\Pkg\\\\PkgProvider'])->toArray()];"
                .to_owned(),
        );
        assert_eq!(
            class_constants(&parsed, Some("providers")),
            ["App\\Providers\\AppServiceProvider", "Vendor\\Pkg\\PkgProvider"]
        );
        assert_eq!(class_constants(&parsed, Some("missing")), Vec::<String>::new());
        let provider = ParsedFile::parse(
            "p.php",
            "<?php\nnamespace A;\nclass P { function boot() { $this->app->register(EventServiceProvider::class); } }"
                .to_owned(),
        );
        assert_eq!(registered_by(&provider), ["A\\EventServiceProvider"]);
    }
}
