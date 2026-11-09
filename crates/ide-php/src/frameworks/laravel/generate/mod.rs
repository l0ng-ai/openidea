//! Laravel code generation: the framework the generators of the Laravel ›
//! Generate menu share, and the generators.
//!
//! A generator renders file templates ([`template`]) with variables it
//! computes, and returns the new files as a [`WorkspaceEdit`]. Where a class
//! goes follows Settings › PHP › Laravel › Code generation
//! ([`LaravelCodeGeneration`]): the application's namespace (or the one of a
//! module), the class suffixes, constructor promotion ([`constructor`]) and
//! return types ([`template::strip_return_types`]). Its file is where the
//! autoload map puts the class, else the module's or Laravel's folder for it.
//!
//! - [`model`]: the New Model dialog (a model with its migration, factory,
//!   seeder, controller, Form Requests, JSON resource and policy).

pub mod model;
pub mod template;

#[cfg(test)]
mod tests;

use std::path::{Path, PathBuf};

use ide_core::settings::LaravelCodeGeneration;
use ide_core::{FileEdit, Range, TextEdit, WorkspaceEdit};
use serde::{Deserialize, Serialize};

use crate::engine::PhpEngine;
use crate::frameworks::laravel::LaravelProject;
use crate::summary::ClassKind;
use crate::types::provider::laravel::{plural, snake, studly};

pub use model::{ControllerKind, ModelField, ModelIndex, ModelRelation, NewModel};
pub use template::{BUILTIN_TEMPLATES, TemplateSet, Vars};

const ELOQUENT_MODEL: &str = "Illuminate\\Database\\Eloquent\\Model";

/// A generator of the Laravel › Generate menu.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratorInfo {
    /// `model`.
    pub id: String,
    pub title: String,
    pub description: String,
    /// The templates it renders.
    pub templates: Vec<String>,
}

/// The generators, in menu order.
pub fn generators() -> Vec<GeneratorInfo> {
    vec![GeneratorInfo {
        id: "model".to_owned(),
        title: "Model".to_owned(),
        description: "An Eloquent model with its fields and relations, and optionally its migration, factory, seeder, controller, Form Requests, JSON resource and policy".to_owned(),
        templates: [
            template::MODEL,
            template::MIGRATION,
            template::FACTORY,
            template::SEEDER,
            template::CONTROLLER,
            template::RESOURCE_CONTROLLER,
            template::API_CONTROLLER,
            template::FORM_REQUEST,
            template::JSON_RESOURCE,
            template::POLICY,
        ]
        .map(str::to_owned)
        .to_vec(),
    }]
}

/// What the generator dialogs offer: the namespace, the modules and the
/// models of the project.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerationContext {
    /// The application's namespace, with a trailing `\`.
    pub namespace: String,
    /// The module names.
    pub modules: Vec<String>,
    /// The module of Settings › PHP › Laravel › Code generation, if it exists.
    pub default_module: Option<String>,
    /// The project's Eloquent models (FQNs, sorted).
    pub models: Vec<String>,
    pub generators: Vec<GeneratorInfo>,
}

/// `FirstName` → `firstName`.
pub fn camel(name: &str) -> String {
    let studly = studly(name);
    let mut chars = studly.chars();
    chars.next().map(|first| first.to_lowercase().chain(chars).collect()).unwrap_or_default()
}

/// The table of model `class` (`BlogPost` → `blog_posts`), as Eloquent
/// names it.
pub fn table_name(class: &str) -> String {
    plural(&snake(class))
}

/// `[A-Za-z_][A-Za-z0-9_]*`.
pub fn is_identifier(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// `App\Models\Post` → `Post`.
pub fn short_name(fqn: &str) -> &str {
    fqn.rsplit('\\').next().unwrap_or(fqn)
}

/// The `use` lines of a generated class: the imported classes, sorted,
/// leaving out the ones of its own namespace and duplicates. A class whose
/// short name is the generated class's, or another import's, is imported
/// under an alias (`use App\Models\Post as PostModel;`); [`Imports::name`]
/// answers the name to write.
#[derive(Clone, Debug, Default)]
pub struct Imports {
    namespace: String,
    own: String,
    /// `(fqn, alias)`.
    classes: Vec<(String, Option<String>)>,
}

impl Imports {
    /// The imports of class `own` (short) of `namespace`.
    pub fn new(namespace: &str, own: &str) -> Self {
        Self { namespace: namespace.trim_matches('\\').to_owned(), own: own.to_owned(), classes: Vec::new() }
    }

    /// Imports `fqn` and answers the name to write for it.
    pub fn add(&mut self, fqn: &str) -> String {
        let fqn = fqn.trim_start_matches('\\');
        if let Some((_, alias)) = self.classes.iter().find(|(known, _)| known.eq_ignore_ascii_case(fqn)) {
            return alias.clone().unwrap_or_else(|| short_name(fqn).to_owned());
        }
        let short = short_name(fqn);
        let namespace = fqn.rsplit_once('\\').map_or("", |(namespace, _)| namespace);
        let same_namespace = namespace.eq_ignore_ascii_case(&self.namespace);
        let taken = |name: &str| {
            name.eq_ignore_ascii_case(&self.own)
                || self.classes.iter().any(|(other, alias)| {
                    alias.as_deref().unwrap_or_else(|| short_name(other)).eq_ignore_ascii_case(name)
                })
        };
        // A class of its own namespace (or the class itself) needs no import.
        if same_namespace {
            self.classes.push((fqn.to_owned(), None));
            return short.to_owned();
        }
        let alias = if taken(short) {
            let parent = namespace.rsplit('\\').next().unwrap_or("Base");
            let mut alias = format!("{short}{}", studly(parent).trim_end_matches('s'));
            while taken(&alias) {
                alias.push('_');
            }
            Some(alias)
        } else {
            None
        };
        let name = alias.clone().unwrap_or_else(|| short.to_owned());
        self.classes.push((fqn.to_owned(), alias));
        name
    }

    /// The `use …;` lines.
    pub fn lines(&self) -> String {
        let mut lines: Vec<String> = self
            .classes
            .iter()
            .filter(|(fqn, alias)| {
                alias.is_some()
                    || !fqn.rsplit_once('\\').is_some_and(|(ns, _)| ns.eq_ignore_ascii_case(&self.namespace))
            })
            .map(|(fqn, alias)| match alias {
                Some(alias) => format!("use {fqn} as {alias};"),
                None => format!("use {fqn};"),
            })
            .collect();
        lines.sort_by_key(|line| line.to_ascii_lowercase());
        lines.join("\n")
    }
}

/// A constructor parameter becoming a property.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConstructorParam {
    /// The type as written (`Mailer`, `?string`).
    pub ty: String,
    /// Without the `$`.
    pub name: String,
    /// `private`, `protected` or `public`.
    pub visibility: String,
    pub readonly: bool,
}

/// A constructor storing `params` in properties (unindented, for a lone
/// template variable in a class body): promoted parameters with
/// `promotion`, else declared properties assigned in the body. Empty
/// without parameters. The generators of classes taking dependencies (jobs,
/// mail, listeners) put it in their `$CONSTRUCTOR$`.
pub fn constructor(params: &[ConstructorParam], promotion: bool) -> String {
    if params.is_empty() {
        return String::new();
    }
    let modifiers =
        |p: &ConstructorParam| if p.readonly { format!("{} readonly", p.visibility) } else { p.visibility.clone() };
    if promotion {
        let mut out = String::from("public function __construct(\n");
        for p in params {
            out.push_str(&format!("    {} {} ${},\n", modifiers(p), p.ty, p.name));
        }
        out.push_str(") {}");
        return out;
    }
    let mut out = String::new();
    for p in params {
        out.push_str(&format!("{} {} ${};\n", modifiers(p), p.ty, p.name));
    }
    out.push('\n');
    let list: Vec<String> = params.iter().map(|p| format!("{} ${}", p.ty, p.name)).collect();
    out.push_str(&format!("public function __construct({})\n{{\n", list.join(", ")));
    for p in params {
        out.push_str(&format!("    $this->{0} = ${0};\n", p.name));
    }
    out.push('}');
    out
}

/// Where generated classes of one target (the application or a module) go.
#[derive(Clone, Debug)]
pub struct Target<'a> {
    pub project: &'a LaravelProject,
    /// With a trailing `\` (`App\`, `Modules\Blog\`).
    pub namespace: String,
    pub module: Option<&'a crate::frameworks::laravel::Module>,
    pub settings: &'a LaravelCodeGeneration,
}

impl Target<'_> {
    /// The namespace of the application or module's classes of kind
    /// `relative` (`Models`, `Http\Controllers`).
    pub fn class_namespace(&self, relative: &str) -> String {
        format!("{}{relative}", self.namespace)
    }

    /// The namespace of database classes (`Database\Factories`): the
    /// module's own (`Modules\Blog\Database\Factories`) in a module.
    pub fn database_namespace(&self, relative: &str) -> String {
        match self.module {
            Some(_) => format!("{}Database\\{relative}", self.namespace),
            None => format!("Database\\{relative}"),
        }
    }

    /// The folder of database files (`database/migrations`).
    pub fn database_dir(&self, relative: &str) -> PathBuf {
        match self.module {
            Some(module) => module.path.join("database").join(relative),
            None => self.project.paths.database.join(relative),
        }
    }
}

impl PhpEngine {
    /// The application or module `module` (by name; `None` = the one of
    /// the settings, empty = the application).
    pub(crate) fn generation_target<'a>(
        &self,
        project: &'a LaravelProject,
        settings: &'a LaravelCodeGeneration,
        module: Option<&str>,
    ) -> Result<Target<'a>, String> {
        let wanted = module.unwrap_or(&settings.module).trim();
        if wanted.is_empty() {
            let namespace = match settings.namespace.trim().trim_matches('\\') {
                "" => project.app_namespace.clone(),
                namespace => format!("{namespace}\\"),
            };
            return Ok(Target { project, namespace, module: None, settings });
        }
        let module = project.module(wanted).ok_or_else(|| format!("There is no module '{wanted}'"))?;
        let namespace = module.namespace.clone().unwrap_or_else(|| format!("Modules\\{}\\", module.name));
        Ok(Target { project, namespace, module: Some(module), settings })
    }

    /// The file of new class `fqn` of `target`: where the autoload map puts
    /// it, else below the module's folder (its `app/` when it has one), else
    /// below `app/`.
    pub(crate) fn generated_class_file(&self, target: &Target<'_>, fqn: &str) -> PathBuf {
        let fqn = fqn.trim_start_matches('\\');
        if let Some(file) = self.layout().and_then(|layout| layout.autoload().class_files(fqn).into_iter().next()) {
            return file;
        }
        let rest = fqn
            .get(target.namespace.len()..)
            .filter(|_| fqn.to_ascii_lowercase().starts_with(&target.namespace.to_ascii_lowercase()))
            .unwrap_or(fqn);
        let base = match target.module {
            Some(module) if module.path.join("app").is_dir() => module.path.join("app"),
            Some(module) => module.path.clone(),
            None => target.project.paths.app.clone(),
        };
        let mut path = base;
        let parts: Vec<&str> = rest.split('\\').collect();
        for part in &parts[..parts.len() - 1] {
            path.push(part);
        }
        path.join(format!("{}.php", parts[parts.len() - 1]))
    }

    /// The file of new database class `fqn` (a factory or seeder) of
    /// `target`: in the module's `database/<folder>`, else where the
    /// autoload map puts it, else in `database/<folder>`.
    pub(crate) fn generated_database_file(&self, target: &Target<'_>, fqn: &str, folder: &str) -> PathBuf {
        let short = short_name(fqn);
        if target.module.is_none()
            && let Some(file) = self.layout().and_then(|layout| layout.autoload().class_files(fqn).into_iter().next())
        {
            return file;
        }
        target.database_dir(folder).join(format!("{short}.php"))
    }

    /// Whether `path` exists on disk or as an open document.
    pub(crate) fn file_taken(&self, path: &Path) -> bool {
        path.exists() || self.open_document(path).is_some()
    }

    /// The project's Eloquent models outside `vendor/`, sorted.
    pub fn laravel_models(&self) -> Vec<String> {
        let Some(index) = self.index() else { return Vec::new() };
        let resolver = self.resolver();
        let mut seen: Vec<String> = Vec::new();
        let mut queue = vec![ELOQUENT_MODEL.to_owned()];
        let mut models = Vec::new();
        while let Some(parent) = queue.pop() {
            for decl in index.direct_subclasses(&parent).unwrap_or_default() {
                if seen.iter().any(|known| known.eq_ignore_ascii_case(&decl.fqn)) {
                    continue;
                }
                seen.push(decl.fqn.clone());
                queue.push(decl.fqn.clone());
                let in_vendor = decl.file.replace('\\', "/").contains("/vendor/");
                let is_class = resolver.class_model(&decl.fqn).is_some_and(|model| model.kind() == ClassKind::Class);
                if !in_vendor && is_class {
                    models.push(decl.fqn);
                }
            }
        }
        models.sort_by_key(|fqn| fqn.to_ascii_lowercase());
        models
    }

    /// What the generator dialogs offer. `None` outside Laravel projects.
    pub fn laravel_generation_context(&self) -> Option<GenerationContext> {
        let project = self.laravel()?;
        let settings = self.laravel_settings().generation;
        let namespace = match settings.namespace.trim().trim_matches('\\') {
            "" => project.app_namespace.clone(),
            namespace => format!("{namespace}\\"),
        };
        let modules: Vec<String> = project.modules.iter().map(|module| module.name.clone()).collect();
        let default_module = Some(settings.module.trim().to_owned())
            .filter(|name| !name.is_empty() && modules.iter().any(|known| known == name));
        Some(GenerationContext {
            namespace,
            modules,
            default_module,
            models: self.laravel_models(),
            generators: generators(),
        })
    }
}

/// One generated file.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GeneratedFile {
    pub path: PathBuf,
    pub text: String,
}

/// The edit creating `files`.
pub fn creation_edit(files: Vec<GeneratedFile>) -> WorkspaceEdit {
    let mut edit = WorkspaceEdit { files: Vec::new(), preconditions: Vec::new() };
    for file in files {
        edit.files.push(FileEdit::Create { path: file.path.clone().into(), overwrite: false });
        edit.files.push(FileEdit::Edit {
            path: file.path.into(),
            edits: vec![TextEdit { range: Range::default(), new_text: file.text }],
            version: None,
        });
    }
    edit
}
