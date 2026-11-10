//! The New Model dialog's generator: an Eloquent model with its fields,
//! relations and indexes, and the classes ticked in the dialog: a
//! migration creating its table, a factory, a seeder, a controller (plain,
//! resource or API), Store/Update Form Requests, a JSON resource and a
//! policy; with the migration, the pivot table of each `belongsToMany`
//! relation the project lacks. The way `php artisan make:model --all` names and places them.

use serde::{Deserialize, Serialize};

use super::template::{self, TemplateSet, Vars};
use super::{GeneratedFile, Imports, camel, creation_edit, is_identifier, short_name, table_name};
use crate::engine::PhpEngine;
use crate::types::provider::laravel::{plural, snake, studly};
use ide_core::WorkspaceEdit;

/// A field of the new model: a column of its table.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ModelField {
    pub name: String,
    /// The `Blueprint` method making the column (`string`, `boolean`).
    pub ty: String,
    pub nullable: bool,
    pub unique: bool,
    /// An index on this column alone.
    pub index: bool,
    /// The default value as PHP (`0`, `true`, `'draft'`); a bare word is
    /// quoted. Empty = none.
    pub default: String,
}

/// The kinds of relations the dialog adds.
pub const RELATION_KINDS: &[&str] = &["belongsTo", "hasOne", "hasMany", "belongsToMany", "morphMany", "morphTo"];

/// A relation of the new model.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ModelRelation {
    /// One of [`RELATION_KINDS`].
    pub kind: String,
    /// The related model: its FQN, or a short name of the target's models
    /// namespace. Unused by `morphTo`.
    pub model: String,
    /// The method name; empty = from the related model (`author` for
    /// `belongsTo(User)` is typed; `user` is the default).
    pub name: String,
}

/// An index over several columns.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ModelIndex {
    pub columns: Vec<String>,
    pub unique: bool,
}

/// The controller to generate along with the model.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ControllerKind {
    #[default]
    None,
    Plain,
    Resource,
    Api,
}

/// What the New Model dialog asks for.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NewModel {
    /// The class name (`Post`, or `Blog/Post` and `Blog\Post` for a
    /// sub-namespace of the models).
    pub name: String,
    /// The module; `None` = the one of the settings, empty = the
    /// application.
    pub module: Option<String>,
    pub fields: Vec<ModelField>,
    pub relations: Vec<ModelRelation>,
    pub indexes: Vec<ModelIndex>,
    pub timestamps: bool,
    pub soft_deletes: bool,
    pub migration: bool,
    pub factory: bool,
    pub seeder: bool,
    pub controller: ControllerKind,
    pub form_requests: bool,
    pub resource: bool,
    pub policy: bool,
}

impl Default for NewModel {
    fn default() -> Self {
        Self {
            name: String::new(),
            module: None,
            fields: Vec::new(),
            relations: Vec::new(),
            indexes: Vec::new(),
            timestamps: true,
            soft_deletes: false,
            migration: true,
            factory: false,
            seeder: false,
            controller: ControllerKind::None,
            form_requests: false,
            resource: false,
            policy: false,
        }
    }
}

/// A relation with everything resolved.
struct Relation {
    kind: String,
    /// The related model's FQN (empty for `morphTo`).
    model: String,
    method: String,
}

impl Relation {
    /// The foreign key column a `belongsTo` adds (`user_id`).
    fn foreign_key(&self) -> Option<String> {
        (self.kind == "belongsTo").then(|| format!("{}_id", snake(&self.method)))
    }

    /// The `{name}_id`/`{name}_type` columns a `morphTo` adds.
    fn morphs(&self) -> Option<String> {
        (self.kind == "morphTo").then(|| snake(&self.method))
    }
}

/// The pivot table of models `first` and `second` (short names), the way
/// Eloquent names it (`post_tag`), and its two keys in that order.
pub(super) fn pivot_table(first: &str, second: &str) -> (String, [String; 2]) {
    let mut models = [snake(first), snake(second)];
    models.sort();
    let keys = models.clone().map(|model| format!("{model}_id"));
    (format!("{}_{}", models[0], models[1]), keys)
}

/// Migration prefix `timestamp` (`2024_05_01_120000`) `seconds` later;
/// unchanged when it isn't one or the day would roll over.
pub(super) fn later_timestamp(timestamp: &str, seconds: u32) -> String {
    let Some((day, time)) = timestamp.rsplit_once('_') else { return timestamp.to_owned() };
    if time.len() != 6 || !time.bytes().all(|b| b.is_ascii_digit()) {
        return timestamp.to_owned();
    }
    let n = |range: std::ops::Range<usize>| time[range].parse::<u32>().unwrap_or(0);
    let total = n(0..2) * 3600 + n(2..4) * 60 + n(4..6) + seconds;
    if total >= 86_400 {
        return timestamp.to_owned();
    }
    format!("{day}_{:02}{:02}{:02}", total / 3600, total / 60 % 60, total % 60)
}

/// The PHP literal of a default value: kept when it is one already, else
/// quoted.
fn php_literal(value: &str) -> String {
    let value = value.trim();
    let is_literal = value.parse::<f64>().is_ok()
        || ["true", "false", "null"].contains(&value.to_ascii_lowercase().as_str())
        || (value.len() >= 2
            && (value.starts_with('\'') && value.ends_with('\'') || value.starts_with('"') && value.ends_with('"')));
    if is_literal { value.to_owned() } else { format!("'{}'", value.replace('\\', "\\\\").replace('\'', "\\'")) }
}

/// The `Blueprint` call making `field`.
fn column_line(field: &ModelField) -> String {
    let mut line = format!("$table->{}('{}')", field.ty, field.name);
    if field.ty == "decimal" {
        line = format!("$table->decimal('{}', 8, 2)", field.name);
    }
    if field.nullable {
        line.push_str("->nullable()");
    }
    if !field.default.trim().is_empty() {
        line.push_str(&format!("->default({})", php_literal(&field.default)));
    }
    if field.unique {
        line.push_str("->unique()");
    } else if field.index {
        line.push_str("->index()");
    }
    if field.ty == "foreignId" {
        line.push_str("->constrained()");
    }
    line.push(';');
    line
}

/// The cast of a column type, if Eloquent should cast it.
fn cast_of(ty: &str) -> Option<&'static str> {
    Some(match ty {
        "boolean" => "boolean",
        "date" => "date",
        "dateTime" | "dateTimeTz" | "timestamp" | "timestampTz" => "datetime",
        "json" | "jsonb" => "array",
        "decimal" => "decimal:2",
        "float" | "double" => "float",
        _ => return None,
    })
}

/// A factory value for `field`, by name, then type.
pub(super) fn fake_value(field: &ModelField) -> String {
    let name = field.name.to_ascii_lowercase();
    let by_name = match name.as_str() {
        "email" | "email_address" => Some("fake()->unique()->safeEmail()"),
        "name" | "full_name" => Some("fake()->name()"),
        "first_name" => Some("fake()->firstName()"),
        "last_name" => Some("fake()->lastName()"),
        "title" | "subject" => Some("fake()->sentence()"),
        "slug" => Some("fake()->unique()->slug()"),
        "phone" | "phone_number" => Some("fake()->phoneNumber()"),
        "address" => Some("fake()->address()"),
        "city" => Some("fake()->city()"),
        "country" => Some("fake()->country()"),
        "url" | "website" => Some("fake()->url()"),
        "description" | "body" | "content" => Some("fake()->paragraph()"),
        _ => None,
    };
    if let Some(value) = by_name
        && matches!(field.ty.as_str(), "string" | "text" | "mediumText" | "longText" | "char")
    {
        return value.to_owned();
    }
    match field.ty.as_str() {
        "string" | "char" => "fake()->word()",
        "text" | "mediumText" | "longText" => "fake()->paragraph()",
        "integer"
        | "bigInteger"
        | "smallInteger"
        | "tinyInteger"
        | "unsignedInteger"
        | "unsignedBigInteger"
        | "unsignedSmallInteger"
        | "unsignedTinyInteger"
        | "foreignId" => "fake()->numberBetween(1, 1000)",
        "boolean" => "fake()->boolean()",
        "decimal" | "float" | "double" => "fake()->randomFloat(2, 0, 1000)",
        "date" => "fake()->date()",
        "dateTime" | "dateTimeTz" | "timestamp" | "timestampTz" => "fake()->dateTime()",
        "time" => "fake()->time()",
        "year" => "fake()->year()",
        "json" | "jsonb" => "[]",
        "uuid" => "fake()->uuid()",
        "ulid" => "(string) \\Illuminate\\Support\\Str::ulid()",
        "ipAddress" => "fake()->ipv4()",
        "macAddress" => "fake()->macAddress()",
        _ => "null",
    }
    .to_owned()
}

/// The validation rules of `field` (`'required', 'string', 'max:255'`).
fn rules_of(field: &ModelField, table: &str) -> Vec<String> {
    let mut rules = vec![if field.nullable { "nullable" } else { "required" }.to_owned()];
    let typed = match field.ty.as_str() {
        "string" | "char" => vec!["string", "max:255"],
        "text" | "mediumText" | "longText" => vec!["string"],
        "integer" | "bigInteger" | "smallInteger" | "tinyInteger" | "foreignId" => vec!["integer"],
        "unsignedInteger" | "unsignedBigInteger" | "unsignedSmallInteger" | "unsignedTinyInteger" => {
            vec!["integer", "min:0"]
        }
        "boolean" => vec!["boolean"],
        "decimal" | "float" | "double" => vec!["numeric"],
        "date" | "dateTime" | "dateTimeTz" | "timestamp" | "timestampTz" => vec!["date"],
        "json" | "jsonb" => vec!["array"],
        "uuid" => vec!["uuid"],
        "ulid" => vec!["ulid"],
        "ipAddress" => vec!["ip"],
        _ => Vec::new(),
    };
    rules.extend(typed.into_iter().map(str::to_owned));
    if field.name.to_ascii_lowercase().contains("email") && field.ty == "string" {
        rules.insert(2, "email".to_owned());
    }
    if field.unique {
        rules.push(format!("unique:{table},{}", field.name));
    }
    rules
}

/// `'a', 'b'` as a rules array entry line: `'name' => ['a', 'b'],`.
fn rule_line(name: &str, rules: &[String]) -> String {
    let quoted: Vec<String> = rules.iter().map(|rule| format!("'{rule}'")).collect();
    format!("'{name}' => [{}],", quoted.join(", "))
}

impl PhpEngine {
    /// The files of the New Model dialog, as an edit creating them.
    /// `templates` are the user's edited templates; `timestamp` is the
    /// migration's prefix (`2024_05_01_120000`). Fails with a message for an
    /// invalid request, and when a file exists already.
    pub fn laravel_new_model(
        &self,
        spec: &NewModel,
        templates: &TemplateSet,
        timestamp: &str,
    ) -> Result<WorkspaceEdit, String> {
        let files = self.laravel_new_model_files(spec, templates, timestamp)?;
        Ok(creation_edit(files))
    }

    /// The files of [`PhpEngine::laravel_new_model`].
    pub fn laravel_new_model_files(
        &self,
        spec: &NewModel,
        templates: &TemplateSet,
        timestamp: &str,
    ) -> Result<Vec<GeneratedFile>, String> {
        let project = self.laravel().ok_or("Not a Laravel project")?;
        let settings = self.laravel_settings().generation;
        let target = self.generation_target(&project, &settings, spec.module.as_deref())?;

        // The class and its namespace.
        let name = spec.name.trim().trim_end_matches(".php").replace('/', "\\");
        let name = name.trim_matches('\\');
        let parts: Vec<&str> = name.split('\\').collect();
        if parts.iter().any(|part| !is_identifier(part)) {
            return Err(format!("'{}' is not a valid class name", spec.name.trim()));
        }
        let class = studly(parts[parts.len() - 1]);
        let sub = parts[..parts.len() - 1].iter().map(|part| studly(part)).collect::<Vec<_>>();
        let models_namespace = target.class_namespace("Models");
        let model_namespace =
            if sub.is_empty() { models_namespace.clone() } else { format!("{models_namespace}\\{}", sub.join("\\")) };
        let model_fqn = format!("{model_namespace}\\{class}");
        if self.resolver().class_model(&model_fqn).is_some() {
            return Err(format!("The class '{model_fqn}' exists already"));
        }
        let table = table_name(&class);
        let variable = camel(&class);

        // The relations.
        let mut relations: Vec<Relation> = Vec::new();
        for relation in &spec.relations {
            if !super::model::RELATION_KINDS.contains(&relation.kind.as_str()) {
                return Err(format!("'{}' is not a relation kind", relation.kind));
            }
            let model = if relation.kind == "morphTo" {
                String::new()
            } else {
                let model = relation.model.trim().trim_start_matches('\\').replace('/', "\\");
                if model.is_empty() || !model.split('\\').all(is_identifier) {
                    return Err(format!("'{}' is not a model class", relation.model.trim()));
                }
                if model.contains('\\') { model } else { format!("{models_namespace}\\{model}") }
            };
            let related = short_name(&model);
            let method = match relation.name.trim() {
                "" if relation.kind == "morphTo" => return Err("Name the morphTo relation (`commentable`)".to_owned()),
                "" if matches!(relation.kind.as_str(), "hasMany" | "belongsToMany" | "morphMany") => {
                    camel(&plural(&snake(related)))
                }
                "" => camel(related),
                name if is_identifier(name) => name.to_owned(),
                name => return Err(format!("'{name}' is not a valid relation name")),
            };
            if relations.iter().any(|known| known.method.eq_ignore_ascii_case(&method)) {
                return Err(format!("Two relations are named '{method}'"));
            }
            relations.push(Relation { kind: relation.kind.clone(), model, method });
        }

        // The fields, and the columns relations add.
        let mut fields: Vec<ModelField> = Vec::new();
        for field in &spec.fields {
            let field =
                ModelField { name: field.name.trim().to_owned(), ty: field.ty.trim().to_owned(), ..field.clone() };
            if !is_identifier(&field.name) {
                return Err(format!("'{}' is not a valid column name", field.name));
            }
            if !is_identifier(&field.ty) {
                return Err(format!("'{}' is not a column type", field.ty));
            }
            let reserved = ["id"]
                .into_iter()
                .chain(spec.timestamps.then_some(["created_at", "updated_at"]).into_iter().flatten())
                .chain(spec.soft_deletes.then_some("deleted_at"));
            if reserved.into_iter().any(|name| name.eq_ignore_ascii_case(&field.name))
                || fields.iter().any(|known| known.name.eq_ignore_ascii_case(&field.name))
            {
                return Err(format!("The column '{}' is there twice", field.name));
            }
            fields.push(field);
        }
        let mut columns: Vec<String> = fields.iter().map(|field| field.name.clone()).collect();
        for relation in &relations {
            if let Some(key) = relation.foreign_key()
                && !columns.iter().any(|known| known.eq_ignore_ascii_case(&key))
            {
                columns.push(key);
            }
            if let Some(morph) = relation.morphs() {
                columns.push(format!("{morph}_type"));
                columns.push(format!("{morph}_id"));
            }
        }
        for index in &spec.indexes {
            if index.columns.is_empty() {
                return Err("An index needs at least one column".to_owned());
            }
            for column in &index.columns {
                if !columns.iter().any(|known| known == column)
                    && !["created_at", "updated_at", "deleted_at"].contains(&column.as_str())
                {
                    return Err(format!("The index names an unknown column '{column}'"));
                }
            }
        }

        let type_hints = settings.type_hints;
        let mut files: Vec<GeneratedFile> = Vec::new();
        let push = |files: &mut Vec<GeneratedFile>, path: std::path::PathBuf, text: String| -> Result<(), String> {
            if self.file_taken(&path) || files.iter().any(|file| file.path == path) {
                return Err(format!("{} exists already", path.display()));
            }
            let text = if type_hints { text } else { template::strip_return_types(&text) };
            files.push(GeneratedFile { path, text });
            Ok(())
        };

        // Names of the companion classes.
        let factory_fqn = format!("{}\\{class}Factory", target.database_namespace("Factories"));
        let requests_namespace = target.class_namespace("Http\\Requests");
        let store_request = format!("{requests_namespace}\\Store{class}{}", settings.request_suffix);
        let update_request = format!("{requests_namespace}\\Update{class}{}", settings.request_suffix);
        let user_fqn = format!("{}Models\\User", project.app_namespace);

        // The model.
        let mut imports = Imports::new(&model_namespace, &class);
        imports.add("Illuminate\\Database\\Eloquent\\Model");
        let mut traits: Vec<String> = Vec::new();
        if spec.factory {
            let factory = imports.add(&factory_fqn);
            let has_factory = imports.add("Illuminate\\Database\\Eloquent\\Factories\\HasFactory");
            traits.push(format!("/** @use {has_factory}<{factory}> */\nuse {has_factory};"));
        }
        if spec.soft_deletes {
            traits.push(format!("use {};", imports.add("Illuminate\\Database\\Eloquent\\SoftDeletes")));
        }
        let fillable: Vec<String> = columns.iter().map(|column| format!("'{column}',")).collect();
        let casts: Vec<String> = fields
            .iter()
            .filter_map(|field| cast_of(&field.ty).map(|cast| format!("'{}' => '{cast}',", field.name)))
            .collect();
        let mut methods: Vec<String> = Vec::new();
        for relation in &relations {
            let class_name = |imports: &mut Imports| imports.add(&relation.model);
            let returns =
                imports.add(&format!("Illuminate\\Database\\Eloquent\\Relations\\{}", studly(&relation.kind)));
            let body = match relation.kind.as_str() {
                "morphTo" => "return $this->morphTo();".to_owned(),
                "morphMany" => {
                    let related = class_name(&mut imports);
                    format!("return $this->morphMany({related}::class, '{}able');", snake(short_name(&relation.model)))
                }
                kind => {
                    let related = class_name(&mut imports);
                    let key = relation
                        .foreign_key()
                        .filter(|key| *key != format!("{}_id", snake(short_name(&relation.model))));
                    match key {
                        Some(key) => format!("return $this->{kind}({related}::class, '{key}');"),
                        None => format!("return $this->{kind}({related}::class);"),
                    }
                }
            };
            let generic = if relation.kind == "morphTo" {
                format!("{returns}<Model, $this>")
            } else {
                format!("{returns}<{}, $this>", imports.add(&relation.model))
            };
            methods.push(format!(
                "/**\n * @return {generic}\n */\npublic function {}(): {returns}\n{{\n    {body}\n}}",
                relation.method
            ));
        }
        if spec.factory && target.module.is_some() {
            let factory = imports.add(&factory_fqn);
            methods.push(format!(
                "/**\n * Create a new factory instance for the model.\n */\nprotected static function newFactory(): {factory}\n{{\n    return {factory}::new();\n}}"
            ));
        }
        let mut vars = Vars::new();
        vars.set("NAMESPACE", &model_namespace)
            .set("CLASS", &class)
            .set("MODEL", &class)
            .set("MODEL_VARIABLE", &variable)
            .set("TABLE", &table)
            .flag("TIMESTAMPS", spec.timestamps)
            .set("TRAITS", traits.join("\n"))
            .set("FILLABLE", fillable.join("\n"))
            .set("CASTS", casts.join("\n"))
            .set("METHODS", methods.join("\n\n"))
            .set("IMPORTS", imports.lines());
        let model_file = self.generated_class_file(&target, &model_fqn);
        push(&mut files, model_file, templates.render(template::MODEL, &vars)?)?;

        // The migration.
        if spec.migration {
            let mut lines = vec!["$table->id();".to_owned()];
            for field in &fields {
                lines.push(column_line(field));
            }
            for relation in &relations {
                if let Some(key) = relation.foreign_key()
                    && !fields.iter().any(|field| field.name.eq_ignore_ascii_case(&key))
                {
                    let related_table = table_name(short_name(&relation.model));
                    let default_key = format!("{}_id", snake(short_name(&relation.model)));
                    let constrained = if key == default_key {
                        "constrained()".to_owned()
                    } else {
                        format!("constrained('{related_table}')")
                    };
                    lines.push(format!("$table->foreignId('{key}')->{constrained}->cascadeOnDelete();"));
                }
                if let Some(morph) = relation.morphs() {
                    lines.push(format!("$table->morphs('{morph}');"));
                }
            }
            for index in &spec.indexes {
                let quoted: Vec<String> = index.columns.iter().map(|column| format!("'{column}'")).collect();
                let method = if index.unique { "unique" } else { "index" };
                lines.push(format!("$table->{method}([{}]);", quoted.join(", ")));
            }
            if spec.timestamps {
                lines.push("$table->timestamps();".to_owned());
            }
            if spec.soft_deletes {
                lines.push("$table->softDeletes();".to_owned());
            }
            let mut vars = Vars::new();
            vars.set("TABLE", &table).set("MODEL", &class).set("COLUMNS", lines.join("\n"));
            let path = target.database_dir("migrations").join(format!("{timestamp}_create_{table}_table.php"));
            push(&mut files, path, templates.render(template::MIGRATION, &vars)?)?;

            // The pivot table of each `belongsToMany` relation, unless a
            // migration or the database has it, one second later so that
            // it runs after the model's table.
            let known_tables: Vec<String> =
                self.resolver().laravel().tables.iter().map(|known| known.name.to_ascii_lowercase()).collect();
            let mut pivots = 0;
            for relation in relations.iter().filter(|relation| relation.kind == "belongsToMany") {
                let (pivot, keys) = pivot_table(&class, short_name(&relation.model));
                if known_tables.contains(&pivot) || files.iter().any(|file| file.text.contains(&format!("'{pivot}'"))) {
                    continue;
                }
                pivots += 1;
                let mut lines: Vec<String> = keys
                    .iter()
                    .map(|key| format!("$table->foreignId('{key}')->constrained()->cascadeOnDelete();"))
                    .collect();
                lines.push(format!("$table->primary(['{}', '{}']);", keys[0], keys[1]));
                let mut vars = Vars::new();
                vars.set("TABLE", &pivot).set("COLUMNS", lines.join("\n"));
                let later = later_timestamp(timestamp, pivots);
                let path = target.database_dir("migrations").join(format!("{later}_create_{pivot}_table.php"));
                push(&mut files, path, templates.render(template::MIGRATION, &vars)?)?;
            }
        }

        // The factory.
        if spec.factory {
            let namespace = target.database_namespace("Factories");
            let short = format!("{class}Factory");
            let mut imports = Imports::new(&namespace, &short);
            imports.add("Illuminate\\Database\\Eloquent\\Factories\\Factory");
            let model = imports.add(&model_fqn);
            let mut lines: Vec<String> = fields
                .iter()
                .filter(|field| {
                    field.ty != "foreignId"
                        || !relations.iter().any(|r| r.foreign_key().as_deref() == Some(&field.name))
                })
                .map(|field| format!("'{}' => {},", field.name, fake_value(field)))
                .collect();
            for relation in &relations {
                if let Some(key) = relation.foreign_key() {
                    let related = imports.add(&relation.model);
                    lines.push(format!("'{key}' => {related}::factory(),"));
                }
            }
            let mut vars = Vars::new();
            vars.set("NAMESPACE", &namespace)
                .set("CLASS", &short)
                .set("MODEL", &model)
                .set("MODEL_VARIABLE", &variable)
                .set("DEFINITION", lines.join("\n"))
                .set("IMPORTS", imports.lines());
            let path = self.generated_database_file(&target, &factory_fqn, "factories");
            push(&mut files, path, templates.render(template::FACTORY, &vars)?)?;
        }

        // The seeder.
        if spec.seeder {
            let namespace = target.database_namespace("Seeders");
            let short = format!("{class}{}", settings.seeder_suffix);
            let fqn = format!("{namespace}\\{short}");
            let mut imports = Imports::new(&namespace, &short);
            imports.add("Illuminate\\Database\\Seeder");
            let model = imports.add(&model_fqn);
            let mut vars = Vars::new();
            vars.set("NAMESPACE", &namespace)
                .set("CLASS", &short)
                .set("MODEL", &model)
                .set("MODEL_VARIABLE", &variable)
                .flag("FACTORY", spec.factory)
                .set("IMPORTS", imports.lines());
            let path = self.generated_database_file(&target, &fqn, "seeders");
            push(&mut files, path, templates.render(template::SEEDER, &vars)?)?;
        }

        // The Form Requests.
        if spec.form_requests {
            let mut lines: Vec<String> =
                fields.iter().map(|field| rule_line(&field.name, &rules_of(field, &table))).collect();
            for relation in &relations {
                if let Some(key) = relation.foreign_key()
                    && !fields.iter().any(|field| field.name.eq_ignore_ascii_case(&key))
                {
                    let related_table = table_name(short_name(&relation.model));
                    lines.push(rule_line(
                        &key,
                        &["required".to_owned(), "integer".to_owned(), format!("exists:{related_table},id")],
                    ));
                }
            }
            for fqn in [&store_request, &update_request] {
                let short = short_name(fqn);
                let mut imports = Imports::new(&requests_namespace, short);
                imports.add("Illuminate\\Foundation\\Http\\FormRequest");
                let mut vars = Vars::new();
                vars.set("NAMESPACE", &requests_namespace)
                    .set("CLASS", short)
                    .set("MODEL", &class)
                    .set("MODEL_VARIABLE", &variable)
                    .set("TABLE", &table)
                    .set("RULES", lines.join("\n"))
                    .set("IMPORTS", imports.lines());
                let path = self.generated_class_file(&target, fqn);
                push(&mut files, path, templates.render(template::FORM_REQUEST, &vars)?)?;
            }
        }

        // The controller.
        if spec.controller != ControllerKind::None {
            let namespace = target.class_namespace("Http\\Controllers");
            let short = format!("{class}{}", settings.controller_suffix);
            let fqn = format!("{namespace}\\{short}");
            let mut imports = Imports::new(&namespace, &short);
            imports.add(&format!("{}Http\\Controllers\\Controller", project.app_namespace));
            let mut vars = Vars::new();
            vars.set("NAMESPACE", &namespace)
                .set("CLASS", &short)
                .set("MODEL_VARIABLE", &variable)
                .set("TABLE", &table);
            let name = match spec.controller {
                ControllerKind::Plain => template::CONTROLLER,
                ControllerKind::Resource => template::RESOURCE_CONTROLLER,
                _ => template::API_CONTROLLER,
            };
            if spec.controller != ControllerKind::Plain {
                vars.set("MODEL", imports.add(&model_fqn));
                let (store, update) = if spec.form_requests {
                    (imports.add(&store_request), imports.add(&update_request))
                } else {
                    let request = imports.add("Illuminate\\Http\\Request");
                    (request.clone(), request)
                };
                vars.set("STORE_REQUEST", store).set("UPDATE_REQUEST", update);
            } else {
                vars.set("MODEL", &class);
            }
            vars.set("IMPORTS", imports.lines());
            let path = self.generated_class_file(&target, &fqn);
            push(&mut files, path, templates.render(name, &vars)?)?;
        }

        // The JSON resource.
        if spec.resource {
            let namespace = target.class_namespace("Http\\Resources");
            let short = format!("{class}{}", settings.resource_suffix);
            let fqn = format!("{namespace}\\{short}");
            let mut imports = Imports::new(&namespace, &short);
            imports.add("Illuminate\\Http\\Request");
            imports.add("Illuminate\\Http\\Resources\\Json\\JsonResource");
            let mut vars = Vars::new();
            vars.set("NAMESPACE", &namespace)
                .set("CLASS", &short)
                .set("MODEL", &class)
                .set("MODEL_VARIABLE", &variable)
                .set("IMPORTS", imports.lines());
            let path = self.generated_class_file(&target, &fqn);
            push(&mut files, path, templates.render(template::JSON_RESOURCE, &vars)?)?;
        }

        // The policy.
        if spec.policy {
            let namespace = target.class_namespace("Policies");
            let short = format!("{class}{}", settings.policy_suffix);
            let fqn = format!("{namespace}\\{short}");
            let mut imports = Imports::new(&namespace, &short);
            let model = imports.add(&model_fqn);
            let user = if model_fqn.eq_ignore_ascii_case(&user_fqn) { model.clone() } else { imports.add(&user_fqn) };
            let mut vars = Vars::new();
            vars.set("NAMESPACE", &namespace)
                .set("CLASS", &short)
                .set("MODEL", &model)
                .set("USER", &user)
                .set("MODEL_VARIABLE", if model == user { "model".to_owned() } else { variable.clone() })
                .set("IMPORTS", imports.lines());
            let path = self.generated_class_file(&target, &fqn);
            push(&mut files, path, templates.render(template::POLICY, &vars)?)?;
        }

        Ok(files)
    }
}

#[cfg(test)]
mod unit_tests {
    use super::*;

    fn field(name: &str, ty: &str) -> ModelField {
        ModelField { name: name.to_owned(), ty: ty.to_owned(), ..ModelField::default() }
    }

    #[test]
    fn pivot_tables_and_later_migrations() {
        assert_eq!(pivot_table("Tag", "Post"), ("post_tag".to_owned(), ["post_id".to_owned(), "tag_id".to_owned()]));
        assert_eq!(pivot_table("BlogPost", "Category").0, "blog_post_category");
        assert_eq!(later_timestamp("2024_05_01_120059", 1), "2024_05_01_120100");
        assert_eq!(later_timestamp("2024_05_01_235959", 1), "2024_05_01_235959");
        assert_eq!(later_timestamp("x", 1), "x");
    }

    #[test]
    fn columns_casts_fakes_and_rules() {
        let mut title = field("title", "string");
        assert_eq!(column_line(&title), "$table->string('title');");
        title.nullable = true;
        title.default = "Untitled".to_owned();
        title.unique = true;
        assert_eq!(column_line(&title), "$table->string('title')->nullable()->default('Untitled')->unique();");
        let mut views = field("views", "unsignedInteger");
        views.default = "0".to_owned();
        views.index = true;
        assert_eq!(column_line(&views), "$table->unsignedInteger('views')->default(0)->index();");
        assert_eq!(column_line(&field("price", "decimal")), "$table->decimal('price', 8, 2);");
        assert_eq!(php_literal("'it''s'"), "'it''s'");
        assert_eq!(php_literal("it's"), "'it\\'s'");
        assert_eq!(php_literal("TRUE"), "TRUE");

        assert_eq!(cast_of("boolean"), Some("boolean"));
        assert_eq!(cast_of("timestamp"), Some("datetime"));
        assert_eq!(cast_of("string"), None);

        assert_eq!(fake_value(&field("email", "string")), "fake()->unique()->safeEmail()");
        assert_eq!(fake_value(&field("title", "string")), "fake()->sentence()");
        assert_eq!(fake_value(&field("title", "integer")), "fake()->numberBetween(1, 1000)");
        assert_eq!(fake_value(&field("data", "json")), "[]");

        assert_eq!(rules_of(&field("email", "string"), "users"), ["required", "string", "email", "max:255"]);
        assert_eq!(rules_of(&title, "posts"), ["nullable", "string", "max:255", "unique:posts,title"]);
        assert_eq!(rule_line("views", &rules_of(&views, "posts")), "'views' => ['required', 'integer', 'min:0'],");
    }
}
