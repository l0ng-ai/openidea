//! The Generate menu inside an Eloquent model class: context actions
//! whose titles start the way the editor's Generate menu lists them.
//!
//! - **Generate JSON resource from '<Model>'**: a `<Model>Resource` whose
//!   `toArray()` lists the model's visible columns and its relations when
//!   loaded (through their own resources when the project has them).
//! - **Generate factory from '<Model>'**: a `<Model>Factory` with a fake
//!   value per column, and the related model's factory for the key of a
//!   `belongsTo` relation.
//! - **Add all fields to $fillable**: the model's columns missing from its
//!   `$fillable` (leaving out the key and the timestamps), or a new
//!   `$fillable` when it has neither that nor `$guarded`.
//!
//! The new classes go to the module the model belongs to, else the
//! application, and use the user's edited templates the front end last
//! sent ([`PhpEngine::set_laravel_templates`]).

use std::path::Path;

use super::template::{self, TemplateSet, Vars};
use super::{GeneratedFile, Imports, Target, camel, creation_edit, short_name};
use crate::engine::PhpEngine;
use crate::frameworks::laravel::generate::classes::SKIPPED_COLUMNS;
use crate::imports::{ImportAction, REWRITE};
use crate::navigate::enclosing_class;
use crate::summary::FileSummary;
use crate::syntax::ParsedFile;

impl PhpEngine {
    /// The Generate actions of the model class around bytes `start..end`
    /// of `parsed` (see the module documentation).
    pub(crate) fn laravel_model_generate_actions(
        &self,
        parsed: &ParsedFile,
        path: &Path,
        start: u32,
        _end: u32,
    ) -> Vec<ImportAction> {
        let Some(project) = self.laravel() else { return Vec::new() };
        if path.to_string_lossy().replace('\\', "/").contains("/vendor/") {
            return Vec::new();
        }
        let summary = FileSummary::extract(parsed);
        let Some(class) = enclosing_class(&summary, start) else { return Vec::new() };
        let Some(model) = self.eloquent_model(&class.fqn) else { return Vec::new() };
        let fqn = model.fqn().to_owned();
        let short = short_name(&fqn).to_owned();
        let settings = self.laravel_settings().generation;
        // The model's module, else the application.
        let module = project
            .modules
            .iter()
            .find(|module| {
                let namespace = module.namespace.clone().unwrap_or_else(|| format!("Modules\\{}\\", module.name));
                fqn.to_ascii_lowercase().starts_with(&namespace.to_ascii_lowercase())
            })
            .map(|module| module.name.clone())
            .unwrap_or_default();
        let Ok(target) = self.generation_target(&project, &settings, Some(&module)) else { return Vec::new() };
        let templates = self.laravel_templates();
        let mut out = Vec::new();

        // The JSON resource.
        let namespace = target.class_namespace("Http\\Resources");
        let resource = format!("{short}{}", settings.resource_suffix);
        if let Some(file) = self.model_resource_file(&target, &templates, &fqn, &namespace, &resource) {
            out.push(ImportAction {
                title: format!("Generate JSON resource from '{short}'"),
                kind: REWRITE,
                preferred: false,
                edit: creation_edit(vec![file]),
            });
        }

        // The factory.
        if let Some(file) = self.model_factory_file(&target, &templates, &fqn) {
            out.push(ImportAction {
                title: format!("Generate factory from '{short}'"),
                kind: REWRITE,
                preferred: false,
                edit: creation_edit(vec![file]),
            });
        }

        // `$fillable`.
        if let Some(view) = self.laravel_model_view(&fqn) {
            let missing: Vec<&str> = view
                .columns
                .iter()
                .filter(|column| {
                    !column.fillable
                        && column.name != view.primary_key
                        && !SKIPPED_COLUMNS.contains(&column.name.as_str())
                        && column.name != "remember_token"
                })
                .map(|column| column.name.as_str())
                .collect();
            if !missing.is_empty()
                && let Some(edit) = self.fillable_edit(&model, &missing)
            {
                out.push(ImportAction {
                    title: "Add all fields to $fillable".to_owned(),
                    kind: REWRITE,
                    preferred: false,
                    edit: ide_core::WorkspaceEdit { files: vec![edit], preconditions: Vec::new() },
                });
            }
        }
        out
    }

    /// `namespace\class`, a JSON resource of model `fqn`, unless it exists.
    fn model_resource_file(
        &self,
        target: &Target<'_>,
        templates: &TemplateSet,
        fqn: &str,
        namespace: &str,
        class: &str,
    ) -> Option<GeneratedFile> {
        let resource = format!("{namespace}\\{class}");
        if self.resolver().class_model(&resource).is_some() {
            return None;
        }
        let path = self.generated_class_file(target, &resource);
        if self.file_taken(&path) {
            return None;
        }
        let mut imports = Imports::new(namespace, class);
        imports.add("Illuminate\\Http\\Request");
        imports.add("Illuminate\\Http\\Resources\\Json\\JsonResource");
        let fields = self.resource_fields(fqn, namespace, &mut imports);
        let mut vars = Vars::new();
        vars.set("NAMESPACE", namespace)
            .set("CLASS", class)
            .set("FIELDS", fields.join("\n"))
            .set("IMPORTS", imports.lines());
        let text = templates.render(template::JSON_RESOURCE, &vars).ok()?;
        Some(GeneratedFile { path, text: self.with_type_hints(text) })
    }

    /// `<Model>Factory` of model `fqn`, unless it exists.
    fn model_factory_file(&self, target: &Target<'_>, templates: &TemplateSet, fqn: &str) -> Option<GeneratedFile> {
        let short = short_name(fqn);
        let namespace = target.database_namespace("Factories");
        let class = format!("{short}Factory");
        let factory = format!("{namespace}\\{class}");
        if self.resolver().class_model(&factory).is_some() {
            return None;
        }
        let path = self.generated_database_file(target, &factory, "factories");
        if self.file_taken(&path) {
            return None;
        }
        let mut imports = Imports::new(&namespace, &class);
        imports.add("Illuminate\\Database\\Eloquent\\Factories\\Factory");
        let definition = self.factory_definition(fqn, &mut imports);
        let mut vars = Vars::new();
        vars.set("NAMESPACE", &namespace)
            .set("CLASS", &class)
            .set("MODEL", imports.add(fqn))
            .set("MODEL_VARIABLE", camel(short))
            .set("DEFINITION", if definition.is_empty() { "//".to_owned() } else { definition.join("\n") })
            .set("IMPORTS", imports.lines());
        let text = templates.render(template::FACTORY, &vars).ok()?;
        Some(GeneratedFile { path, text: self.with_type_hints(text) })
    }

    /// `text` without return types when the settings turn type hints off.
    fn with_type_hints(&self, text: String) -> String {
        if self.laravel_settings().generation.type_hints { text } else { template::strip_return_types(&text) }
    }
}
