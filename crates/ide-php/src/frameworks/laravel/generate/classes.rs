//! The class generators of the Laravel › Generate menu other than New
//! Model: one dialog (a name, the module, and the options the generator
//! lists) per generator, placed and named the way the `php artisan make:*`
//! commands do it.
//!
//! - **Classes:** controller, resource controller, middleware, Form Request,
//!   JSON resource and resource collection, factory, seeder, migration
//!   (create or update a table), pivot table migration, event, listener,
//!   job, mail, notification, observer, policy, validation rule, exception,
//!   HTTP exception, service provider, console command, Blade component (class and
//!   anonymous), view, view composer, broadcasting channel and enum.
//! - **Livewire:** a Livewire component (class below `Livewire\`, or
//!   `Http\Livewire\` with Livewire 2, view below `livewire/`, as
//!   `php artisan make:livewire` lays them out), listed only when Livewire
//!   is installed ([`LIVEWIRE_GENERATOR`]).
//! - **Registration** ([`super::register`]): an observer is added to its
//!   model's `#[ObservedBy]`, a listener to the `$listen` array of the
//!   event service provider (when the project has one), a service provider
//!   to `bootstrap/providers.php` or its module's `module.json`.
//! - **Tests:** feature and unit tests, in Pest's syntax when the project
//!   has a `tests/Pest.php`; unit tests extend PHPUnit's `TestCase`, as
//!   Laravel's do.

use std::collections::BTreeMap;
use std::path::PathBuf;

use ide_core::settings::LaravelCodeGeneration;
use ide_core::{FileEdit, Range, TextEdit, WorkspaceEdit};
use serde::{Deserialize, Serialize};

use super::model::fake_value;
use super::register;
use super::template::{self, TemplateSet, Vars};
use super::{GeneratedFile, Imports, ModelField, Target, camel, creation_edit, is_identifier, short_name};
use crate::engine::PhpEngine;
use crate::syntax::LineIndex;
use crate::types::provider::laravel::{snake, studly};

/// What a generator's dialog asks for besides the name and the module.
/// Each generator reads the options it lists ([`ClassGenerator::options`]).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NewClass {
    /// The generator's id (`controller`, `migration`).
    pub generator: String,
    /// The class name (`Post`, `Admin/PostController`), the view name
    /// (`posts.index`) or the migration name (`add_votes_to_users_table`).
    pub name: String,
    /// The module; `None` = the one of the settings, empty = the
    /// application.
    pub module: Option<String>,
    /// `model`: the model (FQN, or a short name of the models namespace).
    pub model: String,
    /// `related`: the other model of a pivot table.
    pub related: String,
    /// `table`: the table of a migration; empty = guessed from the name.
    pub table: String,
    /// `create`: the migration creates the table.
    pub create: bool,
    /// `event`: the event a listener handles (FQN, or a short name of the
    /// events namespace).
    pub event: String,
    /// `queued`: a queued job or listener.
    pub queued: bool,
    /// `api`: an API resource controller (no `create`/`edit`).
    pub api: bool,
    /// `backing`: an enum's backing type, `string`, `int` or empty.
    pub backing: String,
    /// `status`: the HTTP status of an HTTP exception; 0 = 500.
    pub status: u16,
    /// The values of an `ide.json` code generation's input fields, by
    /// field id ([`super::GeneratorField::id`]).
    pub inputs: BTreeMap<String, String>,
}

impl Default for NewClass {
    fn default() -> Self {
        Self {
            generator: String::new(),
            name: String::new(),
            module: None,
            model: String::new(),
            related: String::new(),
            table: String::new(),
            create: false,
            event: String::new(),
            queued: true,
            api: false,
            backing: String::new(),
            status: 0,
            inputs: BTreeMap::new(),
        }
    }
}

/// A class generator.
#[derive(Clone, Copy, Debug)]
pub struct ClassGenerator {
    pub id: &'static str,
    pub title: &'static str,
    pub description: &'static str,
    pub templates: &'static [&'static str],
    /// The [`NewClass`] fields it reads (`model`, `queued`).
    pub options: &'static [&'static str],
}

macro_rules! generator {
    ($id:literal, $title:literal, $description:literal, [$($template:expr),*], [$($option:literal),*]) => {
        ClassGenerator {
            id: $id,
            title: $title,
            description: $description,
            templates: &[$($template),*],
            options: &[$($option),*],
        }
    };
}

/// The class generators, in menu order.
pub const CLASS_GENERATORS: &[ClassGenerator] = &[
    generator!("controller", "Controller", "An empty controller", [template::CONTROLLER], []),
    generator!(
        "resource-controller",
        "Resource Controller",
        "A controller with the resource actions, for a model",
        [template::RESOURCE_CONTROLLER, template::API_CONTROLLER],
        ["model", "api"]
    ),
    generator!("middleware", "Middleware", "An HTTP middleware", [template::MIDDLEWARE], []),
    generator!("request", "Form Request", "A Form Request validating a request", [template::FORM_REQUEST], []),
    generator!(
        "resource",
        "JSON Resource",
        "A JSON resource, with the fields of a model",
        [template::JSON_RESOURCE],
        ["model"]
    ),
    generator!(
        "resource-collection",
        "Resource Collection",
        "A JSON resource collection",
        [template::RESOURCE_COLLECTION],
        []
    ),
    generator!(
        "factory",
        "Factory",
        "A model factory, with fake values for its fields",
        [template::FACTORY],
        ["model"]
    ),
    generator!("seeder", "Seeder", "A database seeder", [template::SEEDER], ["model"]),
    generator!(
        "migration",
        "Migration",
        "A migration creating or updating a table",
        [template::MIGRATION, template::UPDATE_MIGRATION],
        ["table", "create"]
    ),
    generator!(
        "pivot-migration",
        "Pivot Table Migration",
        "A migration creating the pivot table of two models",
        [template::MIGRATION],
        ["model", "related"]
    ),
    generator!("event", "Event", "An event", [template::EVENT], []),
    generator!("listener", "Listener", "An event listener", [template::LISTENER], ["event", "queued"]),
    generator!("job", "Job", "A job", [template::JOB], ["queued"]),
    generator!("mail", "Mail", "A mailable", [template::MAIL], []),
    generator!("notification", "Notification", "A notification", [template::NOTIFICATION], []),
    generator!("observer", "Observer", "A model observer", [template::OBSERVER], ["model"]),
    generator!("policy", "Policy", "An authorization policy", [template::POLICY, template::PLAIN_POLICY], ["model"]),
    generator!("rule", "Validation Rule", "A validation rule object", [template::RULE], []),
    generator!("exception", "Exception", "An exception with report and render methods", [template::EXCEPTION], []),
    generator!(
        "http-exception",
        "HTTP Exception",
        "An exception with an HTTP status",
        [template::HTTP_EXCEPTION],
        ["status"]
    ),
    generator!(
        "provider",
        "Service Provider",
        "A service provider, registered in bootstrap/providers.php",
        [template::PROVIDER],
        []
    ),
    generator!("command", "Console Command", "An Artisan command", [template::COMMAND], []),
    generator!(
        "component",
        "Blade Component",
        "A Blade component class and its view",
        [template::COMPONENT, template::COMPONENT_VIEW],
        []
    ),
    generator!(
        "anonymous-component",
        "Anonymous Blade Component",
        "A Blade component view without a class",
        [template::COMPONENT_VIEW],
        []
    ),
    generator!("view", "View", "A Blade view", [template::VIEW], []),
    generator!("view-composer", "View Composer", "A view composer", [template::VIEW_COMPOSER], []),
    generator!("channel", "Broadcasting Channel", "A broadcasting channel class", [template::CHANNEL], []),
    generator!("enum", "Enum", "An enum, backed or pure", [template::ENUM], ["backing"]),
    generator!(
        "feature-test",
        "Feature Test",
        "A feature test (PHPUnit or Pest)",
        [template::TEST, template::PEST_TEST],
        []
    ),
    generator!("unit-test", "Unit Test", "A unit test (PHPUnit or Pest)", [template::TEST, template::PEST_TEST], []),
    generator!(
        "livewire",
        "Livewire Component",
        "A Livewire component class and its view",
        [template::LIVEWIRE, template::LIVEWIRE_VIEW],
        []
    ),
];

/// The generator listed only when Livewire is installed.
pub const LIVEWIRE_GENERATOR: &str = "livewire";

/// A Livewire component name (`posts.create-post`, `Posts/CreatePost`) as
/// a class name of the Livewire namespace (`Posts\CreatePost`), the way
/// `make:livewire` reads it.
fn livewire_class_name(name: &str) -> String {
    let name = name.trim().trim_end_matches(".php");
    name.split(['.', '/', '\\']).map(studly).collect::<Vec<_>>().join("\\")
}

/// The generator `id`.
pub fn class_generator(id: &str) -> Option<&'static ClassGenerator> {
    CLASS_GENERATORS.iter().find(|generator| generator.id == id)
}

/// `OrderShipped` → `order-shipped`; `order-shipped` stays.
pub fn kebab(name: &str) -> String {
    if name.chars().any(|c| c.is_ascii_uppercase()) { snake(name).replace('_', "-") } else { name.replace('_', "-") }
}

/// `OrderShipped` → `Order Shipped`.
pub fn headline(name: &str) -> String {
    snake(name).split('_').filter(|word| !word.is_empty()).map(studly).collect::<Vec<_>>().join(" ")
}

/// The sub-namespace parts and the class name of `name` (`Admin/Post`),
/// with `suffix` added unless it ends with it already.
pub(super) fn class_parts(name: &str, suffix: &str) -> Result<(Vec<String>, String), String> {
    let cleaned = name.trim().trim_end_matches(".php").replace('/', "\\");
    let cleaned = cleaned.trim_matches('\\');
    let parts: Vec<&str> = cleaned.split('\\').collect();
    if parts.iter().any(|part| !is_identifier(part)) {
        return Err(format!("'{}' is not a valid class name", name.trim()));
    }
    let mut class = studly(parts[parts.len() - 1]);
    if !suffix.is_empty() && !class.ends_with(suffix) {
        class.push_str(suffix);
    }
    let sub = parts[..parts.len() - 1].iter().map(|part| studly(part)).collect();
    Ok((sub, class))
}

/// The segments of a view name (`posts.index`, `posts/index.blade.php`).
fn view_segments(name: &str) -> Result<Vec<String>, String> {
    let cleaned = name.trim().trim_end_matches(".blade.php").trim_end_matches(".php").replace(['/', '\\'], ".");
    let segments: Vec<String> = cleaned.split('.').map(str::to_owned).collect();
    let valid = |segment: &String| {
        !segment.is_empty() && segment.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    };
    if !segments.iter().all(valid) {
        return Err(format!("'{}' is not a valid view name", name.trim()));
    }
    Ok(segments)
}

/// The table a migration named `name` creates (`create_flights_table`) or
/// changes (`add_votes_to_users_table`), the way Laravel's `TableGuesser`
/// reads it: `(table, creates)`.
pub fn guess_table(name: &str) -> Option<(String, bool)> {
    let trimmed = name.strip_suffix("_table").unwrap_or(name);
    if let Some(table) = trimmed.strip_prefix("create_").filter(|table| !table.is_empty()) {
        return Some((table.to_owned(), true));
    }
    for marker in ["_to_", "_from_", "_in_"] {
        if let Some(at) = trimmed.rfind(marker) {
            let table = &trimmed[at + marker.len()..];
            if !table.is_empty() {
                return Some((table.to_owned(), false));
            }
        }
    }
    None
}

/// A model of the target: its FQN (a known class, or one of the target's
/// namespace), or a name (`Post`, `Blog/Post`) in the models namespace.
fn model_fqn(engine: &PhpEngine, target: &Target<'_>, model: &str) -> Result<String, String> {
    let model = model.trim().trim_start_matches('\\').replace('/', "\\");
    if model.is_empty() || !model.split('\\').all(is_identifier) {
        return Err(format!("'{model}' is not a class name"));
    }
    let qualified = model.contains('\\')
        && (engine.resolver().class_model(&model).is_some()
            || model.to_ascii_lowercase().starts_with(&target.namespace.to_ascii_lowercase()));
    Ok(if qualified { model } else { format!("{}\\{model}", target.class_namespace("Models")) })
}

/// The event a listener handles (`event`: an FQN, or a name of the events
/// namespace); `None` when not given.
fn event_fqn(target: &Target<'_>, event: &str) -> Result<Option<String>, String> {
    let event = event.trim().trim_start_matches('\\').replace('/', "\\");
    if event.is_empty() {
        return Ok(None);
    }
    if !event.split('\\').all(is_identifier) {
        return Err(format!("'{event}' is not a class name"));
    }
    Ok(Some(if event.contains('\\') { event } else { format!("{}\\{event}", target.class_namespace("Events")) }))
}

/// The FQN of the class of the first generated file (its `namespace` and
/// `class` lines).
fn generated_fqn(files: &[GeneratedFile]) -> Option<String> {
    let text = &files.first()?.text;
    let namespace = text.lines().find_map(|line| line.strip_prefix("namespace "))?.trim_end_matches(';');
    let class = text
        .lines()
        .find_map(|line| line.strip_prefix("class ").or_else(|| line.strip_prefix("final class ")))?
        .split_whitespace()
        .next()?;
    Some(format!("{namespace}\\{class}"))
}

/// The `bootstrap/providers.php` edit registering provider `fqn`, when
/// the file lists providers and lacks it.
fn provider_registration(text: &str, path: &std::path::Path, fqn: &str) -> Option<FileEdit> {
    if text.contains(&format!("{fqn}::class")) {
        return None;
    }
    let close = text.rfind("];")?;
    let open = text[..close].rfind('[')?;
    let nl = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let inner = &text[open + 1..close];
    let indent = inner
        .lines()
        .find(|line| !line.trim().is_empty())
        .map(|line| &line[..line.len() - line.trim_start().len()])
        .unwrap_or("    ");
    // After the last entry (adding its comma), or right after the `[`.
    let (at, insert) = match inner.trim_end().len() {
        0 => (open + 1, format!("{nl}{indent}{fqn}::class,{nl}")),
        len => {
            let end = open + 1 + len;
            let comma = if text[..end].ends_with(',') { "" } else { "," };
            (end, format!("{comma}{nl}{indent}{fqn}::class,"))
        }
    };
    let pos = LineIndex::new(text).pos(at as u32);
    Some(FileEdit::Edit {
        path: path.to_path_buf().into(),
        edits: vec![TextEdit { range: Range { start: pos, end: pos }, new_text: insert }],
        version: None,
    })
}

/// A factory value for a column of an existing model: its PHP type `ty`
/// and cast give the `Blueprint` type [`fake_value`] reads.
pub(super) fn fake_for_column(name: &str, ty: &str, cast: Option<&str>, imports: &mut Imports) -> String {
    let lower = name.to_ascii_lowercase();
    if lower == "password" {
        return "bcrypt('password')".to_owned();
    }
    if lower == "remember_token" {
        return format!("{}::random(10)", imports.add("Illuminate\\Support\\Str"));
    }
    if lower.ends_with("_verified_at") {
        return "now()".to_owned();
    }
    let cast = cast.map(|cast| cast.trim_start_matches('\\'));
    if let Some(class) = cast.filter(|cast| cast.contains('\\') && !cast.contains(':')) {
        let class = class.trim_end_matches("::class");
        if !class.starts_with("Illuminate\\") {
            return format!("fake()->randomElement({}::cases())", imports.add(class));
        }
    }
    let blueprint = match cast.map(|cast| cast.split(':').next().unwrap_or(cast).to_ascii_lowercase()) {
        Some(cast) if matches!(cast.as_str(), "bool" | "boolean") => "boolean",
        Some(cast) if matches!(cast.as_str(), "int" | "integer") => "integer",
        Some(cast) if matches!(cast.as_str(), "real" | "float" | "double" | "decimal") => "float",
        Some(cast) if matches!(cast.as_str(), "date" | "immutable_date") => "date",
        Some(cast) if matches!(cast.as_str(), "datetime" | "immutable_datetime" | "timestamp") => "dateTime",
        Some(cast) if matches!(cast.as_str(), "array" | "json" | "collection" | "object") => "json",
        _ => match ty.trim_start_matches('?').trim_start_matches('\\') {
            "int" => "integer",
            "float" => "float",
            "bool" => "boolean",
            "string" if matches!(lower.as_str(), "body" | "content" | "description") => "text",
            "string" => "string",
            "array" => "json",
            other if other.ends_with("Carbon") || other.ends_with("CarbonImmutable") => "dateTime",
            _ => "",
        },
    };
    fake_value(&ModelField { name: name.to_owned(), ty: blueprint.to_owned(), ..ModelField::default() })
}

/// The columns generated code from a model leaves out.
pub(super) const SKIPPED_COLUMNS: &[&str] = &["id", "created_at", "updated_at", "deleted_at"];

impl PhpEngine {
    /// The `definition()` lines of a factory of model `fqn`, from its
    /// columns (empty when the model isn't known): a related model's
    /// factory for the key of a `belongsTo` relation, else a fake value by
    /// the column's name and type.
    pub(super) fn factory_definition(&self, fqn: &str, imports: &mut Imports) -> Vec<String> {
        let Some(view) = self.laravel_model_view(fqn) else { return Vec::new() };
        let mut lines = Vec::new();
        for column in &view.columns {
            if SKIPPED_COLUMNS.contains(&column.name.as_str()) || column.name == view.primary_key {
                continue;
            }
            let related = column.name.strip_suffix("_id").and_then(|prefix| {
                view.relations.iter().find(|relation| {
                    relation.kind.eq_ignore_ascii_case("belongsTo")
                        && (snake(&relation.name) == prefix
                            || relation.related.as_deref().is_some_and(|related| snake(short_name(related)) == prefix))
                })
            });
            let value = match related.and_then(|relation| relation.related.as_deref()) {
                Some(related) => format!("{}::factory()", imports.add(related)),
                None => fake_for_column(&column.name, &column.ty, column.cast.as_deref(), imports),
            };
            lines.push(format!("'{}' => {value},", column.name));
        }
        lines
    }

    /// The `toArray()` entries of a JSON resource of model `fqn`: its
    /// visible columns, then its relations when loaded (through their own
    /// resource when the project has one, `resources_namespace\<Model>Resource`).
    pub(super) fn resource_fields(&self, fqn: &str, resources_namespace: &str, imports: &mut Imports) -> Vec<String> {
        let Some(view) = self.laravel_model_view(fqn) else { return Vec::new() };
        let resolver = self.resolver();
        let suffix = self.laravel_settings().generation.resource_suffix;
        let mut lines: Vec<String> =
            view.columns.iter().filter(|c| !c.hidden).map(|c| format!("'{0}' => $this->{0},", c.name)).collect();
        for relation in &view.relations {
            let loaded = format!("$this->whenLoaded('{}')", relation.name);
            let resource = relation
                .related
                .as_deref()
                .map(|related| format!("{resources_namespace}\\{}{suffix}", short_name(related)))
                .filter(|resource| resolver.class_model(resource).is_some());
            let value = match resource {
                Some(resource) if relation.many => format!("{}::collection({loaded})", imports.add(&resource)),
                Some(resource) => format!("new {}({loaded})", imports.add(&resource)),
                None => loaded,
            };
            lines.push(format!("'{}' => {value},", relation.name));
        }
        lines
    }

    /// The files of generator `spec.generator`, and the edits of existing
    /// files it makes (a provider's registration), as one edit.
    /// `templates` are the user's edited templates; `timestamp` is a
    /// migration's prefix (`2024_05_01_120000`). Fails with a message for an
    /// invalid request, and when a class or file exists already.
    pub fn laravel_generate_class(
        &self,
        spec: &NewClass,
        templates: &TemplateSet,
        timestamp: &str,
    ) -> Result<WorkspaceEdit, String> {
        let files = self.laravel_generate_class_files(spec, templates, timestamp)?;
        let mut edit = creation_edit(files.clone());
        // What the new class needs registered ([`super::register`]).
        let registration = match spec.generator.as_str() {
            "provider" => self.provider_registration_edit(spec, &files),
            "observer" => self.observer_registration_edit(spec, &files),
            "listener" => self.listener_registration_edit(spec, &files),
            _ => None,
        };
        edit.files.extend(registration);
        Ok(edit)
    }

    /// Registers the provider of `files`: an application's in
    /// `bootstrap/providers.php`, a `nwidart/laravel-modules` module's in
    /// its `module.json`.
    fn provider_registration_edit(&self, spec: &NewClass, files: &[GeneratedFile]) -> Option<FileEdit> {
        let project = self.laravel()?;
        let settings = self.laravel_settings().generation;
        let target = self.generation_target(&project, &settings, spec.module.as_deref()).ok()?;
        let fqn = generated_fqn(files)?;
        match target.module {
            Some(module) if module.kind == crate::frameworks::laravel::ModuleKind::Nwidart => {
                let path = module.path.join("module.json");
                let current = self.text_of(&path)?;
                register::module_provider_registration(&current, &path, &fqn)
            }
            Some(_) => None,
            None => {
                let path = project.paths.bootstrap.join("providers.php");
                let current = self.text_of(&path)?;
                provider_registration(&current, &path, &fqn)
            }
        }
    }

    /// Adds the observer of `files` to its model's `#[ObservedBy]`.
    fn observer_registration_edit(&self, spec: &NewClass, files: &[GeneratedFile]) -> Option<FileEdit> {
        let project = self.laravel()?;
        let settings = self.laravel_settings().generation;
        let target = self.generation_target(&project, &settings, spec.module.as_deref()).ok()?;
        let observer = generated_fqn(files)?;
        let templates = TemplateSet::default();
        let job = Generation { engine: self, target: &target, settings: &settings, templates: &templates, spec };
        let model = job.model(&spec.model, short_name(&observer), "Observer").ok()??;
        let model = self.eloquent_model(&model)?;
        let location = self.class_location(&model)?;
        if location.path.to_string_lossy().replace('\\', "/").contains("/vendor/") {
            return None;
        }
        let current = self.text_of(&location.path)?;
        register::observer_registration(&current, &location.path, model.fqn(), &observer)
    }

    /// Adds the listener of `files` under its event in the `$listen` array
    /// of the target's event service provider, when it has one.
    fn listener_registration_edit(&self, spec: &NewClass, files: &[GeneratedFile]) -> Option<FileEdit> {
        let project = self.laravel()?;
        let settings = self.laravel_settings().generation;
        let target = self.generation_target(&project, &settings, spec.module.as_deref()).ok()?;
        let event = event_fqn(&target, &spec.event).ok()??;
        let listener = generated_fqn(files)?;
        let root = target.module.map_or(&project.paths.app, |module| &module.path);
        let mut candidates: Vec<PathBuf> =
            project.providers.iter().filter(|path| path.starts_with(root)).cloned().collect();
        candidates.push(project.paths.app.join("Providers").join("EventServiceProvider.php"));
        candidates.into_iter().find_map(|path| {
            let text = self.text_of(&path)?;
            if !text.contains("$listen") {
                return None;
            }
            register::listener_registration(&text, &path, &event, &listener)
        })
    }

    /// The files of [`PhpEngine::laravel_generate_class`].
    pub fn laravel_generate_class_files(
        &self,
        spec: &NewClass,
        templates: &TemplateSet,
        timestamp: &str,
    ) -> Result<Vec<GeneratedFile>, String> {
        let project = self.laravel().ok_or("Not a Laravel project")?;
        let settings = self.laravel_settings().generation;
        let target = self.generation_target(&project, &settings, spec.module.as_deref())?;
        let mut files: Vec<GeneratedFile> = Vec::new();
        let type_hints = settings.type_hints;
        let mut push = |path: PathBuf, text: String| -> Result<(), String> {
            if self.file_taken(&path) || files.iter().any(|file| file.path == path) {
                return Err(format!("{} exists already", path.display()));
            }
            let php =
                path.extension().is_some_and(|ext| ext == "php") && !path.to_string_lossy().ends_with(".blade.php");
            let text = if type_hints || !php { text } else { template::strip_return_types(&text) };
            files.push(GeneratedFile { path, text });
            Ok(())
        };
        if spec.generator.starts_with(super::custom::PREFIX) {
            let generation = super::custom::code_generations(&project.ide_json)
                .into_iter()
                .find(|generation| generation.id == spec.generator)
                .ok_or_else(|| format!("There is no generator '{}'", spec.generator))?;
            for (path, text) in self.code_generation_files(&generation, &target, templates, spec)? {
                push(path, text)?;
            }
            return Ok(files);
        }
        let generator =
            class_generator(&spec.generator).ok_or_else(|| format!("There is no generator '{}'", spec.generator))?;
        let job = Generation { engine: self, target: &target, settings: &settings, templates, spec };
        match generator.id {
            "migration" => {
                let (path, text) = job.migration(timestamp)?;
                push(path, text)?;
            }
            "pivot-migration" => {
                let (path, text) = job.pivot_migration(timestamp)?;
                push(path, text)?;
            }
            "view" | "anonymous-component" => {
                let mut segments = view_segments(&spec.name)?;
                if generator.id == "anonymous-component" {
                    segments = segments.iter().map(|segment| kebab(segment)).collect();
                    segments.insert(0, "components".to_owned());
                }
                let mut vars = Vars::new();
                vars.set("NAME", segments.join("."));
                let name = if generator.id == "view" { template::VIEW } else { template::COMPONENT_VIEW };
                push(job.view_file(&segments), templates.render(name, &vars)?)?;
            }
            "feature-test" | "unit-test" => {
                let (path, text) = job.test(generator.id == "feature-test")?;
                push(path, text)?;
            }
            _ => {
                for (path, text) in job.class(generator.id)? {
                    push(path, text)?;
                }
            }
        }
        Ok(files)
    }
}

/// One generator request with what it needs.
struct Generation<'a> {
    engine: &'a PhpEngine,
    target: &'a Target<'a>,
    settings: &'a LaravelCodeGeneration,
    templates: &'a TemplateSet,
    spec: &'a NewClass,
}

impl Generation<'_> {
    /// A model of the request (`model` or `related`), or the one the class
    /// name points to when it exists (`PostObserver` → `Post`).
    fn model(&self, option: &str, class: &str, suffix: &str) -> Result<Option<String>, String> {
        if !option.trim().is_empty() {
            return model_fqn(self.engine, self.target, option).map(Some);
        }
        let base = class.strip_suffix(suffix).filter(|base| !base.is_empty()).unwrap_or(class);
        let fqn = format!("{}\\{base}", self.target.class_namespace("Models"));
        Ok(self.engine.eloquent_model(&fqn).map(|model| model.fqn().to_owned()))
    }

    /// The migration (`create` or update) named `spec.name`.
    fn migration(&self, timestamp: &str) -> Result<(PathBuf, String), String> {
        let name = snake(&self.spec.name.trim().trim_end_matches(".php").replace([' ', '-'], "_"));
        let name = name.trim_matches('_').to_owned();
        if name.is_empty() || !name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_') {
            return Err(format!("'{}' is not a valid migration name", self.spec.name.trim()));
        }
        let guessed = guess_table(&name);
        let (table, create) = match self.spec.table.trim() {
            "" => guessed.ok_or("Name the table, or name the migration like create_flights_table")?,
            table if is_identifier(table) => (table.to_owned(), self.spec.create),
            table => return Err(format!("'{table}' is not a valid table name")),
        };
        let mut vars = Vars::new();
        vars.set("TABLE", &table).set("COLUMNS", "$table->id();\n$table->timestamps();");
        let template = if create { template::MIGRATION } else { template::UPDATE_MIGRATION };
        let path = self.target.database_dir("migrations").join(format!("{timestamp}_{name}.php"));
        Ok((path, self.templates.render(template, &vars)?))
    }

    /// The pivot table of `model` and `related` (`post_tag`).
    fn pivot_migration(&self, timestamp: &str) -> Result<(PathBuf, String), String> {
        if self.spec.model.trim().is_empty() || self.spec.related.trim().is_empty() {
            return Err("Pick the two models of the pivot table".to_owned());
        }
        let first = model_fqn(self.engine, self.target, &self.spec.model)?;
        let second = model_fqn(self.engine, self.target, &self.spec.related)?;
        let mut models = [short_name(&first).to_owned(), short_name(&second).to_owned()];
        if models[0].eq_ignore_ascii_case(&models[1]) {
            return Err("Pick two different models".to_owned());
        }
        models.sort_by_key(|model| snake(model));
        let keys = models.clone().map(|model| format!("{}_id", snake(&model)));
        let table = format!("{}_{}", snake(&models[0]), snake(&models[1]));
        let mut lines = Vec::new();
        for key in &keys {
            lines.push(format!("$table->foreignId('{key}')->constrained()->cascadeOnDelete();"));
        }
        lines.push(format!("$table->primary(['{}', '{}']);", keys[0], keys[1]));
        let mut vars = Vars::new();
        vars.set("TABLE", &table).set("COLUMNS", lines.join("\n"));
        let path = self.target.database_dir("migrations").join(format!("{timestamp}_create_{table}_table.php"));
        Ok((path, self.templates.render(template::MIGRATION, &vars)?))
    }

    /// The views folder of the target.
    fn views_dir(&self) -> PathBuf {
        match self.target.module {
            Some(module) => module.path.join("resources").join("views"),
            None => self.target.project.paths.views.clone(),
        }
    }

    fn view_file(&self, segments: &[String]) -> PathBuf {
        let mut path = self.views_dir();
        for segment in &segments[..segments.len() - 1] {
            path.push(segment);
        }
        path.join(format!("{}.blade.php", segments[segments.len() - 1]))
    }

    /// The name a view of the target is rendered by (`components.alert`,
    /// `billing::components.alert` in a module).
    fn view_name(&self, segments: &[String]) -> String {
        match self.target.module {
            Some(module) => format!("{}::{}", module.name.to_ascii_lowercase(), segments.join(".")),
            None => segments.join("."),
        }
    }

    /// A feature or unit test.
    fn test(&self, feature: bool) -> Result<(PathBuf, String), String> {
        let (sub, class) = class_parts(&self.spec.name, "Test")?;
        let folder = if feature { "Feature" } else { "Unit" };
        let (base, namespace) = match self.target.module {
            Some(module) => (module.path.join("tests"), format!("{}Tests\\{folder}", self.target.namespace)),
            None => (self.target.project.paths.base.join("tests"), format!("Tests\\{folder}")),
        };
        let namespace = if sub.is_empty() { namespace } else { format!("{namespace}\\{}", sub.join("\\")) };
        let mut path = base.join(folder);
        for part in &sub {
            path.push(part);
        }
        let path = path.join(format!("{class}.php"));
        let pest = self.target.project.paths.base.join("tests").join("Pest.php").exists();
        let mut imports = Imports::new(&namespace, &class);
        // Laravel's unit tests don't boot the application.
        imports.add(if feature { "Tests\\TestCase" } else { "PHPUnit\\Framework\\TestCase" });
        if feature {
            imports.add("Illuminate\\Foundation\\Testing\\RefreshDatabase");
        }
        let mut vars = Vars::new();
        vars.set("NAMESPACE", &namespace).set("CLASS", &class).flag("FEATURE", feature).set("IMPORTS", imports.lines());
        let template = if pest { template::PEST_TEST } else { template::TEST };
        Ok((path, self.templates.render(template, &vars)?))
    }

    /// The files of a class generator.
    fn class(&self, id: &str) -> Result<Vec<(PathBuf, String)>, String> {
        let settings = self.settings;
        let (relative, suffix, database): (&str, &str, bool) = match id {
            "controller" | "resource-controller" => ("Http\\Controllers", &settings.controller_suffix, false),
            "middleware" => ("Http\\Middleware", "", false),
            "request" => ("Http\\Requests", &settings.request_suffix, false),
            "resource" => ("Http\\Resources", &settings.resource_suffix, false),
            "resource-collection" => ("Http\\Resources", "Collection", false),
            "factory" => ("Factories", "Factory", true),
            "seeder" => ("Seeders", &settings.seeder_suffix, true),
            "event" => ("Events", "", false),
            "listener" => ("Listeners", "", false),
            "job" => ("Jobs", "", false),
            "mail" => ("Mail", "", false),
            "notification" => ("Notifications", "", false),
            "observer" => ("Observers", "Observer", false),
            "policy" => ("Policies", &settings.policy_suffix, false),
            "rule" => ("Rules", "", false),
            "exception" | "http-exception" => ("Exceptions", "", false),
            "provider" => ("Providers", "", false),
            "command" => ("Console\\Commands", "", false),
            "component" => ("View\\Components", "", false),
            "view-composer" => ("View\\Composers", "Composer", false),
            "channel" => ("Broadcasting", "Channel", false),
            "enum" => ("Enums", "", false),
            // Livewire 2 kept components below `Http\Livewire`.
            "livewire" if self.target.project.livewire_major.is_some_and(|major| major < 3) => {
                ("Http\\Livewire", "", false)
            }
            "livewire" => ("Livewire", "", false),
            other => return Err(format!("There is no generator '{other}'")),
        };
        let name = if id == "livewire" { livewire_class_name(&self.spec.name) } else { self.spec.name.clone() };
        let (sub, class) = class_parts(&name, suffix)?;
        let base_namespace =
            if database { self.target.database_namespace(relative) } else { self.target.class_namespace(relative) };
        let namespace = if sub.is_empty() { base_namespace } else { format!("{base_namespace}\\{}", sub.join("\\")) };
        let fqn = format!("{namespace}\\{class}");
        if self.engine.resolver().class_model(&fqn).is_some() {
            return Err(format!("The class '{fqn}' exists already"));
        }
        let path = if database {
            let folder = if id == "factory" { "factories" } else { "seeders" };
            let mut dir = match self.target.module {
                Some(_) => self.target.database_dir(folder),
                None => self
                    .engine
                    .layout()
                    .and_then(|layout| layout.autoload().class_files(&fqn).into_iter().next())
                    .and_then(|file| file.parent().map(PathBuf::from))
                    .unwrap_or_else(|| {
                        let mut dir = self.target.database_dir(folder);
                        for part in &sub {
                            dir.push(part);
                        }
                        dir
                    }),
            };
            if self.target.module.is_some() {
                for part in &sub {
                    dir.push(part);
                }
            }
            dir.join(format!("{class}.php"))
        } else {
            self.engine.generated_class_file(self.target, &fqn)
        };

        let mut imports = Imports::new(&namespace, &class);
        let mut vars = Vars::new();
        vars.set("NAMESPACE", &namespace).set("CLASS", &class);
        let project = self.target.project;
        let user_fqn = format!("{}Models\\User", project.app_namespace);
        let mut extra: Vec<(PathBuf, String)> = Vec::new();
        let template = match id {
            "controller" => {
                imports.add(&format!("{}Http\\Controllers\\Controller", project.app_namespace));
                template::CONTROLLER
            }
            "resource-controller" => {
                imports.add(&format!("{}Http\\Controllers\\Controller", project.app_namespace));
                let request = imports.add("Illuminate\\Http\\Request");
                vars.set("STORE_REQUEST", &request).set("UPDATE_REQUEST", &request);
                match self.model(&self.spec.model, &class, suffix)? {
                    Some(model) => {
                        vars.set("MODEL", imports.add(&model)).set("MODEL_VARIABLE", camel(short_name(&model)));
                    }
                    None => {
                        vars.set("MODEL", "string").set("MODEL_VARIABLE", "id");
                    }
                }
                if self.spec.api { template::API_CONTROLLER } else { template::RESOURCE_CONTROLLER }
            }
            "middleware" => {
                imports.add("Closure");
                imports.add("Illuminate\\Http\\Request");
                imports.add("Symfony\\Component\\HttpFoundation\\Response");
                template::MIDDLEWARE
            }
            "request" => {
                imports.add("Illuminate\\Foundation\\Http\\FormRequest");
                vars.set("RULES", "//");
                template::FORM_REQUEST
            }
            "resource" => {
                imports.add("Illuminate\\Http\\Request");
                imports.add("Illuminate\\Http\\Resources\\Json\\JsonResource");
                if let Some(model) = self.model(&self.spec.model, &class, suffix)? {
                    let fields = self.engine.resource_fields(&model, &namespace, &mut imports);
                    vars.set("FIELDS", fields.join("\n"));
                }
                template::JSON_RESOURCE
            }
            "resource-collection" => {
                imports.add("Illuminate\\Http\\Request");
                imports.add("Illuminate\\Http\\Resources\\Json\\ResourceCollection");
                template::RESOURCE_COLLECTION
            }
            "factory" => {
                imports.add("Illuminate\\Database\\Eloquent\\Factories\\Factory");
                let base = class.strip_suffix("Factory").filter(|base| !base.is_empty()).unwrap_or(&class);
                let model = match self.spec.model.trim() {
                    "" => format!("{}\\{base}", self.target.class_namespace("Models")),
                    model => model_fqn(self.engine, self.target, model)?,
                };
                let definition = self.engine.factory_definition(&model, &mut imports);
                vars.set("MODEL", imports.add(&model))
                    .set("MODEL_VARIABLE", camel(short_name(&model)))
                    .set("DEFINITION", if definition.is_empty() { "//".to_owned() } else { definition.join("\n") });
                template::FACTORY
            }
            "seeder" => {
                imports.add("Illuminate\\Database\\Seeder");
                if !self.spec.model.trim().is_empty() {
                    let model = model_fqn(self.engine, self.target, &self.spec.model)?;
                    vars.set("MODEL", imports.add(&model)).flag("FACTORY", true);
                }
                template::SEEDER
            }
            "event" => {
                for fqn in [
                    "Illuminate\\Broadcasting\\InteractsWithSockets",
                    "Illuminate\\Broadcasting\\PrivateChannel",
                    "Illuminate\\Foundation\\Events\\Dispatchable",
                    "Illuminate\\Queue\\SerializesModels",
                ] {
                    imports.add(fqn);
                }
                template::EVENT
            }
            "listener" => {
                if self.spec.queued {
                    imports.add("Illuminate\\Contracts\\Queue\\ShouldQueue");
                    imports.add("Illuminate\\Queue\\InteractsWithQueue");
                }
                if let Some(fqn) = event_fqn(self.target, &self.spec.event)? {
                    vars.set("EVENT", imports.add(&fqn));
                }
                vars.flag("QUEUED", self.spec.queued);
                template::LISTENER
            }
            "job" => {
                if self.spec.queued {
                    imports.add("Illuminate\\Contracts\\Queue\\ShouldQueue");
                    imports.add("Illuminate\\Foundation\\Queue\\Queueable");
                } else {
                    imports.add("Illuminate\\Foundation\\Bus\\Dispatchable");
                }
                vars.flag("QUEUED", self.spec.queued);
                template::JOB
            }
            "mail" => {
                for fqn in [
                    "Illuminate\\Bus\\Queueable",
                    "Illuminate\\Mail\\Mailable",
                    "Illuminate\\Mail\\Mailables\\Content",
                    "Illuminate\\Mail\\Mailables\\Envelope",
                    "Illuminate\\Queue\\SerializesModels",
                ] {
                    imports.add(fqn);
                }
                vars.set("SUBJECT", headline(&class)).set("VIEW", format!("mail.{}", kebab(&class)));
                template::MAIL
            }
            "notification" => {
                imports.add("Illuminate\\Bus\\Queueable");
                imports.add("Illuminate\\Notifications\\Messages\\MailMessage");
                imports.add("Illuminate\\Notifications\\Notification");
                template::NOTIFICATION
            }
            "observer" => {
                if let Some(model) = self.model(&self.spec.model, &class, suffix)? {
                    vars.set("MODEL", imports.add(&model)).set("MODEL_VARIABLE", camel(short_name(&model)));
                }
                template::OBSERVER
            }
            "policy" => match self.model(&self.spec.model, &class, suffix)? {
                Some(model) => {
                    let name = imports.add(&model);
                    let user =
                        if model.eq_ignore_ascii_case(&user_fqn) { name.clone() } else { imports.add(&user_fqn) };
                    let variable = if name == user { "model".to_owned() } else { camel(short_name(&model)) };
                    vars.set("MODEL", &name).set("USER", user).set("MODEL_VARIABLE", variable);
                    template::POLICY
                }
                None => template::PLAIN_POLICY,
            },
            "rule" => {
                imports.add("Closure");
                imports.add("Illuminate\\Contracts\\Validation\\ValidationRule");
                template::RULE
            }
            "exception" => {
                imports.add("Exception");
                imports.add("Illuminate\\Http\\Request");
                imports.add("Illuminate\\Http\\Response");
                template::EXCEPTION
            }
            "http-exception" => {
                imports.add("Symfony\\Component\\HttpKernel\\Exception\\HttpException");
                imports.add("Throwable");
                let status = if self.spec.status == 0 { 500 } else { self.spec.status };
                if !(100..=599).contains(&status) {
                    return Err(format!("{status} is not an HTTP status"));
                }
                vars.set("STATUS", status.to_string());
                template::HTTP_EXCEPTION
            }
            "provider" => {
                imports.add("Illuminate\\Support\\ServiceProvider");
                template::PROVIDER
            }
            "command" => {
                imports.add("Illuminate\\Console\\Command");
                let base = class.strip_suffix("Command").filter(|base| !base.is_empty()).unwrap_or(&class);
                vars.set("SIGNATURE", format!("app:{}", kebab(base)));
                template::COMMAND
            }
            "component" => {
                imports.add("Closure");
                imports.add("Illuminate\\Contracts\\View\\View");
                imports.add("Illuminate\\View\\Component");
                let mut segments: Vec<String> = sub.iter().map(|part| kebab(part)).collect();
                segments.push(kebab(&class));
                segments.insert(0, "components".to_owned());
                vars.set("VIEW", self.view_name(&segments));
                let mut view = Vars::new();
                view.set("NAME", segments.join("."));
                extra.push((self.view_file(&segments), self.templates.render(template::COMPONENT_VIEW, &view)?));
                template::COMPONENT
            }
            "livewire" => {
                imports.add("Livewire\\Component");
                let mut segments: Vec<String> = sub.iter().map(|part| kebab(part)).collect();
                segments.push(kebab(&class));
                segments.insert(0, "livewire".to_owned());
                vars.set("VIEW", self.view_name(&segments));
                let mut view = Vars::new();
                view.set("NAME", segments[1..].join("."));
                extra.push((self.view_file(&segments), self.templates.render(template::LIVEWIRE_VIEW, &view)?));
                template::LIVEWIRE
            }
            "view-composer" => {
                imports.add("Illuminate\\View\\View");
                template::VIEW_COMPOSER
            }
            "channel" => {
                vars.set("USER", imports.add(&user_fqn));
                template::CHANNEL
            }
            "enum" => {
                let backing = match self.spec.backing.trim() {
                    "" => "",
                    "string" => "string",
                    "int" => "int",
                    other => return Err(format!("An enum is backed by string or int, not '{other}'")),
                };
                vars.set("BACKING", backing);
                template::ENUM
            }
            other => return Err(format!("There is no generator '{other}'")),
        };
        vars.set("IMPORTS", imports.lines());
        let mut out = vec![(path, self.templates.render(template, &vars)?)];
        out.extend(extra);
        Ok(out)
    }
}

#[cfg(test)]
mod unit_tests {
    use super::*;

    #[test]
    fn names_and_tables() {
        assert_eq!(kebab("OrderShipped"), "order-shipped");
        assert_eq!(kebab("order_shipped"), "order-shipped");
        assert_eq!(headline("OrderShipped"), "Order Shipped");
        assert_eq!(
            class_parts("Admin/Post", "Controller").unwrap(),
            (vec!["Admin".to_owned()], "PostController".to_owned())
        );
        assert_eq!(class_parts("PostController", "Controller").unwrap().1, "PostController");
        assert_eq!(livewire_class_name("posts.create-post"), "Posts\\CreatePost");
        assert_eq!(livewire_class_name("Admin/ShowUsers"), "Admin\\ShowUsers");
        assert_eq!(livewire_class_name("counter"), "Counter");
        assert!(class_parts("1Post", "").is_err());
        assert_eq!(view_segments("posts/index.blade.php").unwrap(), ["posts", "index"]);
        assert!(view_segments("posts..index").is_err());
        assert_eq!(guess_table("create_flights_table"), Some(("flights".to_owned(), true)));
        assert_eq!(guess_table("add_votes_to_users_table"), Some(("users".to_owned(), false)));
        assert_eq!(guess_table("remove_votes_from_users"), Some(("users".to_owned(), false)));
        assert_eq!(guess_table("tidy_up"), None);
    }

    #[test]
    fn providers_are_registered() {
        let path = std::path::Path::new("bootstrap/providers.php");
        let apply = |text: &str| {
            let Some(FileEdit::Edit { edits, .. }) = provider_registration(text, path, "App\\Providers\\X") else {
                return None;
            };
            let at = LineIndex::new(text).byte(edits[0].range.start) as usize;
            Some(format!("{}{}{}", &text[..at], edits[0].new_text, &text[at..]))
        };
        assert_eq!(
            apply("<?php\n\nreturn [\n    App\\Providers\\AppServiceProvider::class,\n];\n").unwrap(),
            "<?php\n\nreturn [\n    App\\Providers\\AppServiceProvider::class,\n    App\\Providers\\X::class,\n];\n"
        );
        assert_eq!(
            apply("<?php\n\nreturn [\n    A::class\n];\n").unwrap(),
            "<?php\n\nreturn [\n    A::class,\n    App\\Providers\\X::class,\n];\n"
        );
        assert_eq!(apply("<?php\n\nreturn [];\n").unwrap(), "<?php\n\nreturn [\n    App\\Providers\\X::class,\n];\n");
        assert!(apply("<?php\n\nreturn [\n    App\\Providers\\X::class,\n];\n").is_none());
    }

    #[test]
    fn fakes_for_existing_columns() {
        let mut imports = Imports::new("Database\\Factories", "PostFactory");
        assert_eq!(fake_for_column("title", "string", None, &mut imports), "fake()->sentence()");
        assert_eq!(fake_for_column("body", "string", None, &mut imports), "fake()->paragraph()");
        assert_eq!(fake_for_column("views", "int", None, &mut imports), "fake()->numberBetween(1, 1000)");
        assert_eq!(
            fake_for_column("published_at", "?Carbon\\Carbon", Some("datetime"), &mut imports),
            "fake()->dateTime()"
        );
        assert_eq!(
            fake_for_column("status", "string", Some("App\\Enums\\PostStatus"), &mut imports),
            "fake()->randomElement(PostStatus::cases())"
        );
        assert_eq!(fake_for_column("password", "string", None, &mut imports), "bcrypt('password')");
        assert_eq!(fake_for_column("options", "mixed", Some("array"), &mut imports), "[]");
        assert_eq!(imports.lines(), "use App\\Enums\\PostStatus;");
    }
}
