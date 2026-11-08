//! The Laravel project model ([`LaravelProject`]): the facts every Laravel
//! feature reads.
//!
//! - **Detection and version:** a project is a Laravel project when its
//!   `composer.json` requires `laravel/framework` (or `composer.lock` /
//!   `vendor/composer/installed.json` lists it), or when `artisan` exists at
//!   its root. The version is the locked one (`composer.lock`, else
//!   `installed.json`), without the `v`.
//! - **Paths and app namespace:** Laravel's defaults (`app`, `bootstrap`,
//!   `config`, `database`, `lang` — `resources/lang` before Laravel 9 —,
//!   `public`, `resources`, `resources/views`, `routes`, `storage`) and the
//!   PSR-4 prefix of `composer.json` that maps to `app/`, the way
//!   `Application::getNamespace()` finds it (else `App\`).
//! - **Route files:** the [`RouteRegistration`]s of the file summaries
//!   (`withRouting(…)` in `bootstrap/app.php`, `Route::…->group(path)` in a
//!   `RouteServiceProvider`, `loadRoutesFrom`) with their prefixes, name
//!   prefixes, middleware and controller namespaces, resolved to files. With
//!   none, `routes/web.php` and `routes/api.php` as Laravel registers them.
//! - **Modules:** `nwidart/laravel-modules` modules (`Modules/<Name>/module.json`,
//!   the modules folder and namespace from `config/modules.php`, enabled
//!   per `modules_statuses.json`), and directory modules: the folders below
//!   `modules/`, `app-modules/`, `app/Modules/` or `src/Modules/` that look
//!   like a module (routes, resources, providers or their own `composer.json`).
//!
//! [`LaravelProject::load`] reads the files that aren't PHP;
//! [`LaravelProject::with_routes`] adds what the PHP summaries in the index
//! say. The engine keeps both ([`crate::engine::PhpEngine::laravel`]).

use std::path::{Path, PathBuf};

use ide_core::Range;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::project::composer::RootManifest;
use crate::project::normalize;
use crate::summary::{LaravelFacts, RouteFileKind, RoutePath, RouteRegistration};

/// See the module documentation. Paths are normalized.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LaravelProject {
    pub root: PathBuf,
    /// The installed `laravel/framework` version (`11.31.0`), when locked.
    pub version: Option<String>,
    /// The application's namespace, with a trailing `\` (`App\`).
    pub app_namespace: String,
    pub paths: LaravelPaths,
    /// In registration order (the registering files in path order).
    pub route_files: Vec<RouteFile>,
    /// In path order.
    pub modules: Vec<Module>,
}

/// Laravel's base paths.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LaravelPaths {
    pub base: PathBuf,
    pub app: PathBuf,
    pub bootstrap: PathBuf,
    pub config: PathBuf,
    pub database: PathBuf,
    pub lang: PathBuf,
    pub public: PathBuf,
    pub resources: PathBuf,
    pub views: PathBuf,
    pub routes: PathBuf,
    pub storage: PathBuf,
}

impl LaravelPaths {
    fn new(root: &Path) -> Self {
        let lang = if !root.join("lang").is_dir() && root.join("resources").join("lang").is_dir() {
            root.join("resources").join("lang")
        } else {
            root.join("lang")
        };
        Self {
            base: root.to_path_buf(),
            app: root.join("app"),
            bootstrap: root.join("bootstrap"),
            config: root.join("config"),
            database: root.join("database"),
            lang,
            public: root.join("public"),
            resources: root.join("resources"),
            views: root.join("resources").join("views"),
            routes: root.join("routes"),
            storage: root.join("storage"),
        }
    }
}

/// A route file and the group it is loaded in.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RouteFile {
    pub path: PathBuf,
    pub kind: RouteFileKind,
    /// The URI prefix, without surrounding `/` (`api`, or empty).
    pub prefix: String,
    /// The route-name prefix (`admin.`, or empty).
    pub name_prefix: String,
    pub middleware: Vec<String>,
    /// The controller namespace string actions are relative to.
    pub namespace: Option<String>,
    pub domain: Option<String>,
    /// The file registering it, and the range of the path argument there;
    /// `None` for the default files of a project that registers none.
    pub registered_at: Option<(PathBuf, Range)>,
    /// The module ([`Module::name`]) the file belongs to.
    pub module: Option<String>,
}

/// A module of a modular application.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Module {
    pub name: String,
    pub path: PathBuf,
    /// Its namespace with a trailing `\` (`Modules\Blog\`), when known.
    pub namespace: Option<String>,
    pub kind: ModuleKind,
    pub enabled: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ModuleKind {
    /// A `nwidart/laravel-modules` module (has a `module.json`).
    Nwidart,
    /// A folder of a modules directory.
    Directory,
}

/// The folders whose subfolders can be directory modules.
const MODULE_ROOTS: &[&str] = &["modules", "Modules", "app-modules", "app/Modules", "src/Modules"];

impl LaravelProject {
    /// The project at `root` without its route files, or `None` when it
    /// isn't a Laravel project.
    pub fn load(root: &Path) -> Option<Self> {
        let root = normalize(root);
        let composer = read_json(&root.join("composer.json"));
        let lock = read_json(&root.join("composer.lock"));
        let manifest = RootManifest::read(&root);
        let vendor = root.join(manifest.as_ref().map_or("vendor", |m| m.vendor_dir.as_str()));
        let installed = read_json(&vendor.join("composer").join("installed.json"));
        let required = |name: &str| {
            composer.as_ref().is_some_and(|json| {
                ["require", "require-dev"].iter().any(|section| json.get(section).and_then(|s| s.get(name)).is_some())
            })
        };
        let locked = |name: &str| {
            lock.as_ref()
                .and_then(|lock| locked_version(lock, name))
                .or_else(|| installed.as_ref().and_then(|installed| locked_version(installed, name)))
        };
        let version = locked("laravel/framework");
        if !required("laravel/framework") && version.is_none() && !root.join("artisan").is_file() {
            return None;
        }
        let paths = LaravelPaths::new(&root);
        let app_namespace = manifest
            .as_ref()
            .and_then(|manifest| {
                manifest.autoload.psr4.iter().find_map(|(prefix, dirs)| {
                    dirs.iter().any(|dir| normalize(&root.join(dir)) == paths.app).then(|| prefix.clone())
                })
            })
            .filter(|prefix| !prefix.is_empty())
            .unwrap_or_else(|| "App\\".to_owned());
        let nwidart = required("nwidart/laravel-modules")
            || locked("nwidart/laravel-modules").is_some()
            || root.join("modules_statuses.json").is_file();
        let mut project =
            Self { root: root.clone(), version, app_namespace, paths, route_files: Vec::new(), modules: Vec::new() };
        if nwidart {
            project.modules.extend(nwidart_modules(&root));
        }
        project.directory_modules(manifest.as_ref());
        project.modules.sort_by(|a, b| a.path.cmp(&b.path));
        Some(project)
    }

    /// This project with the route files `facts` register (merged with
    /// their files, [`LaravelFacts::merge_located`]).
    pub fn with_routes(&self, facts: &LaravelFacts) -> Self {
        let mut project = self.clone();
        project.route_files.clear();
        for registration in &facts.routes {
            let Some(file) = project.route_file(registration) else { continue };
            let known = project.route_files.iter().any(|known| {
                known.path == file.path && known.prefix == file.prefix && known.name_prefix == file.name_prefix
            });
            if !known {
                project.route_files.push(file);
            }
        }
        if project.route_files.is_empty() {
            project.default_route_files();
        }
        project
    }

    /// The module holding `path`.
    pub fn module_of(&self, path: &Path) -> Option<&Module> {
        self.modules.iter().filter(|module| path.starts_with(&module.path)).max_by_key(|m| m.path.as_os_str().len())
    }

    /// The module named `name` (any case).
    pub fn module(&self, name: &str) -> Option<&Module> {
        self.modules.iter().find(|module| module.name.eq_ignore_ascii_case(name))
    }

    /// The route files loaded in the `web` or `api` groups (or any other
    /// group): the ones holding HTTP routes, console and channel files aside.
    pub fn http_route_files(&self) -> impl Iterator<Item = &RouteFile> {
        self.route_files.iter().filter(|file| !matches!(file.kind, RouteFileKind::Console | RouteFileKind::Channels))
    }

    /// Whether `path` is one of the route files.
    pub fn is_route_file(&self, path: &Path) -> bool {
        let path = normalize(path);
        self.route_files.iter().any(|file| file.path == path)
    }

    fn route_file(&self, registration: &RouteRegistration) -> Option<RouteFile> {
        let from = registration.file.as_deref()?;
        let relative = |base: &Path, rest: &str| normalize(&base.join(rest.trim_start_matches(['/', '\\'])));
        let path = match &registration.path {
            RoutePath::Dir { up, rest } => {
                let mut dir = from.parent()?;
                for _ in 0..*up {
                    dir = dir.parent()?;
                }
                relative(dir, rest)
            }
            RoutePath::Base(rest) => relative(&self.root, rest),
            RoutePath::App(rest) => relative(&self.paths.app, rest),
            RoutePath::Module { name, rest } => {
                let module = match name {
                    Some(name) => self.module(name),
                    None => self.module_of(from),
                }?;
                relative(&module.path, rest)
            }
        };
        let module = self.module_of(&path).map(|module| module.name.clone());
        Some(RouteFile {
            kind: registration.kind,
            prefix: registration.prefix.trim_matches('/').to_owned(),
            name_prefix: registration.name_prefix.clone(),
            middleware: registration.middleware.clone(),
            namespace: registration.namespace.clone(),
            domain: registration.domain.clone(),
            registered_at: Some((from.to_path_buf(), registration.loc.range)),
            module,
            path,
        })
    }

    /// `routes/web.php` and `routes/api.php`, loaded the way Laravel's
    /// skeleton does, when nothing registers route files.
    fn default_route_files(&mut self) {
        let defaults = [("web.php", RouteFileKind::Web, "", "web"), ("api.php", RouteFileKind::Api, "api", "api")];
        for (file, kind, prefix, middleware) in defaults {
            let path = self.paths.routes.join(file);
            if path.is_file() {
                self.route_files.push(RouteFile {
                    path,
                    kind,
                    prefix: prefix.to_owned(),
                    name_prefix: String::new(),
                    middleware: vec![middleware.to_owned()],
                    namespace: None,
                    domain: None,
                    registered_at: None,
                    module: None,
                });
            }
        }
    }

    /// The folders of [`MODULE_ROOTS`] that look like modules and aren't
    /// nwidart modules already.
    fn directory_modules(&mut self, manifest: Option<&RootManifest>) {
        let mut seen: Vec<PathBuf> = self.modules.iter().map(|module| module.path.clone()).collect();
        for root in MODULE_ROOTS {
            let dir = self.root.join(root);
            for path in subfolders(&dir) {
                let duplicate = seen.iter().any(|known| same_path(known, &path));
                if duplicate || path.join("module.json").is_file() || !looks_like_module(&path) {
                    continue;
                }
                seen.push(path.clone());
                let Some(name) = path.file_name().map(|name| name.to_string_lossy().into_owned()) else { continue };
                let namespace =
                    own_namespace(&path).or_else(|| manifest.and_then(|manifest| self.psr4_namespace(manifest, &path)));
                self.modules.push(Module { name, path, namespace, kind: ModuleKind::Directory, enabled: true });
            }
        }
    }

    /// The namespace the root `composer.json`'s PSR-4 mapping gives `dir`.
    fn psr4_namespace(&self, manifest: &RootManifest, dir: &Path) -> Option<String> {
        manifest.autoload.psr4.iter().find_map(|(prefix, dirs)| {
            dirs.iter().find_map(|base| {
                let base = normalize(&self.root.join(base));
                let rest = dir.strip_prefix(&base).ok()?;
                let mut namespace = prefix.clone();
                for part in rest.components() {
                    namespace.push_str(&part.as_os_str().to_string_lossy());
                    namespace.push('\\');
                }
                Some(namespace)
            })
        })
    }
}

/// The modules of `nwidart/laravel-modules`: the folders with a
/// `module.json` in the modules folder.
fn nwidart_modules(root: &Path) -> Vec<Module> {
    let config = std::fs::read_to_string(root.join("config").join("modules.php")).unwrap_or_default();
    let folder = config_string(&config, "modules", Some("base_path(")).unwrap_or_else(|| "Modules".to_owned());
    let namespace = config_string(&config, "namespace", None).unwrap_or_else(|| "Modules".to_owned());
    let statuses = read_json(&root.join("modules_statuses.json"));
    subfolders(&root.join(folder.trim_matches(['/', '\\'])))
        .into_iter()
        .filter_map(|path| {
            let manifest = read_json(&path.join("module.json"))?;
            let folder = path.file_name()?.to_string_lossy().into_owned();
            let name = manifest.get("name").and_then(Value::as_str).unwrap_or(&folder).to_owned();
            let enabled = match &statuses {
                // A module missing from the statuses is disabled.
                Some(statuses) => statuses.get(&name).and_then(Value::as_bool).unwrap_or(false),
                None => true,
            };
            let namespace =
                own_namespace(&path).unwrap_or_else(|| format!("{}\\{folder}\\", namespace.trim_matches('\\')));
            Some(Module { name, path, namespace: Some(namespace), kind: ModuleKind::Nwidart, enabled })
        })
        .collect()
}

/// A string value in a PHP config array: `'key' => 'value'`, or
/// `'key' => base_path('value')` with `call` `base_path(`.
fn config_string(text: &str, key: &str, call: Option<&str>) -> Option<String> {
    for quote in ['\'', '"'] {
        let needle = format!("{quote}{key}{quote}");
        let mut rest = text;
        while let Some(at) = rest.find(&needle) {
            rest = &rest[at + needle.len()..];
            let Some(value) = rest.trim_start().strip_prefix("=>") else { continue };
            let mut value = value.trim_start();
            if let Some(call) = call {
                let Some(inner) = value.strip_prefix(call) else { continue };
                value = inner.trim_start();
            }
            let Some(open) = value.chars().next().filter(|c| *c == '\'' || *c == '"') else { continue };
            let body = &value[1..];
            if let Some(end) = body.find(open) {
                return Some(body[..end].to_owned());
            }
        }
    }
    None
}

/// The first PSR-4 prefix of the module's own `composer.json`.
fn own_namespace(dir: &Path) -> Option<String> {
    let manifest = RootManifest::read(dir)?;
    let (prefix, _) = manifest.autoload.psr4.into_iter().find(|(prefix, _)| !prefix.is_empty())?;
    Some(prefix)
}

/// A folder with routes, resources, a `composer.json`, or service providers.
fn looks_like_module(dir: &Path) -> bool {
    ["routes", "Routes", "resources", "Resources", "composer.json"].iter().any(|name| dir.join(name).exists())
        || ["Providers", "src/Providers", "app/Providers"].iter().any(|providers| {
            std::fs::read_dir(dir.join(providers)).is_ok_and(|mut entries| {
                entries.any(|entry| {
                    entry.is_ok_and(|entry| entry.file_name().to_string_lossy().ends_with("ServiceProvider.php"))
                })
            })
        })
}

/// The subfolders of `dir`, normalized and sorted.
fn subfolders(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut out: Vec<PathBuf> = entries
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .map(|entry| normalize(&entry.path()))
        .collect();
    out.sort();
    out
}

/// The same folder (`modules` and `Modules` on a case-insensitive disk).
fn same_path(a: &Path, b: &Path) -> bool {
    a == b || matches!((std::fs::canonicalize(a), std::fs::canonicalize(b)), (Ok(a), Ok(b)) if a == b)
}

fn read_json(path: &Path) -> Option<Value> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

/// The version of package `name` in a `composer.lock` (`packages`,
/// `packages-dev`) or an `installed.json` (either format), without `v`.
fn locked_version(json: &Value, name: &str) -> Option<String> {
    let lists: Vec<&Vec<Value>> = match json {
        Value::Array(packages) => vec![packages],
        Value::Object(map) => {
            ["packages", "packages-dev"].iter().filter_map(|key| map.get(*key).and_then(Value::as_array)).collect()
        }
        _ => Vec::new(),
    };
    lists.into_iter().flatten().find(|package| package.get("name").and_then(Value::as_str) == Some(name)).map(
        |package| {
            let version = package.get("version").and_then(Value::as_str).unwrap_or_default();
            version.strip_prefix('v').unwrap_or(version).to_owned()
        },
    )
}
