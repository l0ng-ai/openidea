//! What a Symfony project's configuration says, for the Symfony type
//! provider ([`crate::types::provider::SymfonyProvider`]):
//!
//! - **Services** from `config/services.yaml`, `config/services_*.yaml` and
//!   the files their `imports` name (relative paths, folders and `*`
//!   globs; `when@env` sections too): `id: { class: … }`, `id: '@other'`
//!   and `id: { alias: other }` aliases, `parent:` definitions, and
//!   `App\Foo: ~` class ids. Resource-loaded namespaces (`App\: { resource:
//!   … }`) aren't listed: their classes are their ids, which the provider
//!   types without the configuration.
//! - **Routes** from `config/routes.yaml`, `config/routes_*.yaml` and the
//!   YAML files below `config/routes/`: every top-level key with a `path`
//!   (or an `alias`), `when@env` sections included. Entries with a
//!   `resource` import other routes (often the `#[Route]` attributes, which
//!   summaries record: [`crate::summary::SymfonyFacts`]) and aren't routes.
//!
//! The format is Symfony's documented YAML configuration (Service
//! Container, Routing); the files are read with the small reader in
//! [`yaml`]. [`SymfonyConfig::load`] reads them from disk; the engine
//! caches the result until a watcher batch touches a YAML file.

pub mod yaml;

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use ide_core::Range;

use crate::summary::{RepositoryEntity, SymfonyFacts};
use yaml::Node;

/// How many configuration files one load reads at most.
const MAX_FILES: usize = 256;

/// A service the configuration defines.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ServiceDef {
    pub id: String,
    /// The class it makes (`class:`, or the id itself for `App\Foo: ~`).
    pub class: Option<String>,
    /// The service it is an alias of (`'@other'`, `alias: other`).
    pub alias: Option<String>,
    /// The definition it inherits its class from (`parent: other`).
    pub parent: Option<String>,
    pub file: PathBuf,
    /// The id's key.
    pub range: Range,
}

/// A named route.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RouteDef {
    pub name: String,
    /// Its path (`/blog/{slug}`), when it has one.
    pub path: Option<String>,
    /// Where the name is written: a configuration file, or the PHP file of
    /// a `#[Route]` attribute (when known).
    pub file: Option<PathBuf>,
    pub range: Range,
}

/// The configuration files' services and routes.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SymfonyConfig {
    pub services: Vec<ServiceDef>,
    pub routes: Vec<RouteDef>,
}

impl SymfonyConfig {
    /// Reads the configuration of the project at `root` (nothing when it
    /// has no `config` folder).
    pub fn load(root: &Path) -> Self {
        let mut out = Self::default();
        let config = root.join("config");
        if !config.is_dir() {
            return out;
        }
        let mut queue = existing(&[config.join("services.yaml"), config.join("services.yml")]);
        queue.extend(prefixed(&config, "services_"));
        let mut seen: HashSet<PathBuf> = HashSet::new();
        while !queue.is_empty() {
            let file = queue.remove(0);
            if seen.len() >= MAX_FILES || !seen.insert(file.clone()) {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&file) else { continue };
            let imports = out.add_services(&file, &text);
            queue.extend(imports);
        }
        let mut routes = existing(&[config.join("routes.yaml"), config.join("routes.yml")]);
        routes.extend(prefixed(&config, "routes_"));
        routes.extend(yaml_files_below(&config.join("routes")));
        for file in routes.into_iter().take(MAX_FILES) {
            if let Ok(text) = std::fs::read_to_string(&file) {
                out.add_routes(&file, &text);
            }
        }
        out
    }

    /// The services of one services file; returns the files its `imports`
    /// name that exist.
    pub fn add_services(&mut self, file: &Path, text: &str) -> Vec<PathBuf> {
        let root = yaml::parse(text);
        let mut imports = Vec::new();
        for section in sections(&root) {
            for import in section.get("imports").map(Node::items).unwrap_or_default() {
                let resource = import.as_str().or_else(|| import.get("resource").and_then(Node::as_str));
                if let Some(resource) = resource {
                    imports.extend(resolve_import(file, resource));
                }
            }
            for entry in section.get("services").map(Node::entries).unwrap_or_default() {
                if entry.key.starts_with('_') {
                    continue;
                }
                if let Some(service) = service(&entry.key, &entry.value, file, entry.range) {
                    self.services.push(service);
                }
            }
        }
        imports
    }

    /// The routes of one routes file.
    pub fn add_routes(&mut self, file: &Path, text: &str) {
        let root = yaml::parse(text);
        for section in sections(&root) {
            for entry in section.entries() {
                if entry.key.starts_with("when@") {
                    continue;
                }
                let path = match entry.value.get("path") {
                    Some(Node::Scalar(path)) => Some(path.clone()),
                    // Localized paths: the first.
                    Some(Node::Map(paths)) => paths.first().and_then(|first| first.value.as_str()).map(str::to_owned),
                    _ => None,
                };
                if path.is_none() && entry.value.get("alias").is_none() {
                    continue;
                }
                self.routes.push(RouteDef {
                    name: entry.key.clone(),
                    path,
                    file: Some(file.to_path_buf()),
                    range: entry.range,
                });
            }
        }
    }

    /// The service with this id (the last definition wins, as in Symfony).
    pub fn service(&self, id: &str) -> Option<&ServiceDef> {
        self.services.iter().rev().find(|service| service.id == id)
    }

    /// The class the service `id` makes, following aliases and parents.
    pub fn service_class(&self, id: &str) -> Option<String> {
        let mut id = id.to_owned();
        for _ in 0..16 {
            let Some(service) = self.service(&id) else {
                return is_class_id(&id).then_some(id);
            };
            if let Some(class) = &service.class {
                return Some(class.clone());
            }
            id = service.alias.as_ref().or(service.parent.as_ref())?.clone();
        }
        None
    }
}

/// The Symfony facts of the whole project: the configuration and what the
/// PHP files say ([`SymfonyFacts`]).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SymfonyProject {
    pub config: SymfonyConfig,
    /// The configuration's routes, then the `#[Route]` attributes'.
    pub routes: Vec<RouteDef>,
    pub repositories: Vec<RepositoryEntity>,
}

impl SymfonyProject {
    /// `config` with the facts of the PHP files (each with its file, when
    /// known).
    pub fn new<'a>(
        config: SymfonyConfig,
        facts: impl IntoIterator<Item = (Option<&'a Path>, &'a SymfonyFacts)>,
    ) -> Self {
        let mut routes = config.routes.clone();
        let mut repositories = Vec::new();
        for (file, facts) in facts {
            routes.extend(facts.routes.iter().map(|route| RouteDef {
                name: route.name.clone(),
                path: route.path.clone(),
                file: file.map(Path::to_path_buf),
                range: route.loc.range,
            }));
            repositories.extend(facts.repositories.iter().cloned());
        }
        Self { config, routes, repositories }
    }

    /// The route named `name`.
    pub fn route(&self, name: &str) -> Option<&RouteDef> {
        self.routes.iter().find(|route| route.name == name)
    }

    /// The entity whose repository is `repository` (FQN, any case).
    pub fn entity_of(&self, repository: &str) -> Option<&str> {
        let repository = repository.trim_start_matches('\\');
        self.repositories
            .iter()
            .find(|known| known.repository.eq_ignore_ascii_case(repository))
            .map(|known| known.entity.as_str())
    }
}

/// The document and its `when@env` sections.
fn sections(root: &Node) -> Vec<&Node> {
    let mut out = vec![root];
    out.extend(root.entries().iter().filter(|entry| entry.key.starts_with("when@")).map(|entry| &entry.value));
    out
}

/// One entry of `services:`.
fn service(id: &str, value: &Node, file: &Path, range: Range) -> Option<ServiceDef> {
    let mut service =
        ServiceDef { id: id.to_owned(), class: None, alias: None, parent: None, file: file.to_path_buf(), range };
    match value {
        Node::Scalar(text) => match text.strip_prefix('@') {
            Some(target) => service.alias = Some(target.trim_start_matches('?').to_owned()),
            None => service.class = is_class_id(id).then(|| id.to_owned()),
        },
        Node::Map(_) => {
            if value.get("resource").is_some() {
                // `App\: { resource: '../src/' }`: classes are their ids.
                return None;
            }
            let text = |key: &str| value.get(key).and_then(Node::as_str).map(str::to_owned);
            service.class = text("class").map(|class| class.trim_start_matches('\\').to_owned());
            service.alias = text("alias").map(|alias| alias.trim_start_matches('@').to_owned());
            service.parent = text("parent").map(|parent| parent.trim_start_matches('@').to_owned());
            if service.class.is_none() && service.alias.is_none() && service.parent.is_none() && is_class_id(id) {
                service.class = Some(id.to_owned());
            }
        }
        Node::Null | Node::Seq(_) => service.class = is_class_id(id).then(|| id.to_owned()),
    }
    Some(service)
}

/// An id that is a class name (`App\Mailer`), as autowiring names them.
pub fn is_class_id(id: &str) -> bool {
    let id = id.trim_start_matches('\\');
    !id.is_empty()
        && !id.ends_with('\\')
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '\\')
        && (id.contains('\\') || id.starts_with(|c: char| c.is_ascii_uppercase()))
}

fn is_yaml(path: &Path) -> bool {
    matches!(path.extension().and_then(|e| e.to_str()), Some("yaml" | "yml"))
}

fn existing(paths: &[PathBuf]) -> Vec<PathBuf> {
    paths.iter().filter(|path| path.is_file()).cloned().collect()
}

/// The YAML files of `dir` whose names start with `prefix`, sorted.
fn prefixed(dir: &Path, prefix: &str) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            is_yaml(path)
                && path.is_file()
                && path.file_name().and_then(|n| n.to_str()).is_some_and(|name| name.starts_with(prefix))
        })
        .collect();
    out.sort();
    out
}

/// The YAML files below `dir`, sorted.
fn yaml_files_below(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut dirs = vec![dir.to_path_buf()];
    while let Some(dir) = dirs.pop() {
        for entry in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
            let path = entry.path();
            if path.is_dir() {
                dirs.push(path);
            } else if is_yaml(&path) {
                out.push(path);
            }
            if out.len() >= MAX_FILES {
                break;
            }
        }
    }
    out.sort();
    out
}

/// The files an `imports` resource names, relative to `from`'s folder: a
/// file, a folder (its YAML files) or a `*` glob in the file name.
fn resolve_import(from: &Path, resource: &str) -> Vec<PathBuf> {
    if resource.contains('%') || resource.contains("://") {
        return Vec::new();
    }
    let base = from.parent().unwrap_or(Path::new("."));
    let path = base.join(resource.trim_end_matches(['/', '\\']));
    if path.is_dir() {
        return yaml_files_below(&path);
    }
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or_default().to_owned();
    if let Some((before, after)) = name.split_once('*') {
        let dir = path.parent().unwrap_or(base);
        let mut out: Vec<PathBuf> = std::fs::read_dir(dir)
            .into_iter()
            .flatten()
            .flatten()
            .map(|entry| entry.path())
            .filter(|candidate| {
                is_yaml(candidate)
                    && candidate.file_name().and_then(|n| n.to_str()).is_some_and(|n| {
                        n.len() >= before.len() + after.len() && n.starts_with(before) && n.ends_with(after)
                    })
            })
            .collect();
        out.sort();
        return out;
    }
    if is_yaml(&path) && path.is_file() { vec![path] } else { Vec::new() }
}

#[cfg(test)]
mod tests;
