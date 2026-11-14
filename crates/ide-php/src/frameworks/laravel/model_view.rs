//! The Eloquent model view: the engine queries behind the panel of a model
//! class (opened from the code lens on the class's name).
//!
//! - [`PhpEngine::laravel_model_lenses`]: a lens on each model class of an
//!   open document, running [`MODEL_VIEW_COMMAND`] with the class's name.
//! - [`PhpEngine::laravel_model_view`]: what the panel shows: the table, the
//!   primary key, the columns with their types and where each comes from
//!   (a migration or the live database), the relations, local scopes and
//!   accessors, and the related factories, resources, policies, observers
//!   and migrations, each with its location (the panel navigates, finds
//!   usages or renames there).
//! - [`PhpEngine::laravel_add_columns`]: the **Add columns** button: a new
//!   migration adding the columns to the model's table, and the columns
//!   added to the model's `$fillable`.
//!
//! The related classes are found by Laravel's naming conventions (`Post` →
//! `PostFactory`, `PostResource`/`PostCollection`, `PostPolicy`,
//! `PostObserver`), as `php artisan make:model --all` names them (Laravel's
//! MIT source and documentation).

use std::path::{Path, PathBuf};

use ide_core::{DocId, FileEdit, Range, TextEdit, WorkspaceEdit};
use serde::{Deserialize, Serialize};

use crate::engine::PhpEngine;
use crate::summary::{ClassKind, FileSummary};
use crate::syntax::LineIndex;
use crate::types::provider::laravel::{accessor_name, is_scope_attributed, scope_name, snake};
use crate::types::provider::{AttributeOrigin, LaravelProvider, MagicTarget};
use crate::types::{ClassModel, Context, Type};

/// The command a model lens runs; its one argument is the model's class
/// (FQN).
pub const MODEL_VIEW_COMMAND: &str = "laravel.modelView";

const MODEL: &str = "Illuminate\\Database\\Eloquent\\Model";
const FACTORY: &str = "Illuminate\\Database\\Eloquent\\Factories\\Factory";
const JSON_RESOURCE: &str = "Illuminate\\Http\\Resources\\Json\\JsonResource";

/// A place in a file.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelLocation {
    pub path: PathBuf,
    /// The name of the declaration (a class, method or column).
    pub range: Range,
}

/// See the module documentation.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelView {
    /// The model's class (FQN).
    pub class: String,
    /// Its short name.
    pub name: String,
    pub location: Option<ModelLocation>,
    pub table: String,
    /// `$primaryKey` (`id`).
    pub primary_key: String,
    /// `$keyType` (`int`).
    pub key_type: String,
    /// `$incrementing`.
    pub incrementing: bool,
    /// Whether the columns are known for certain (see
    /// [`LaravelFacts::schema_certain`](crate::summary::LaravelFacts::schema_certain)).
    pub schema_certain: bool,
    pub columns: Vec<ModelColumn>,
    pub relations: Vec<ModelRelationItem>,
    pub scopes: Vec<ModelMember>,
    pub accessors: Vec<ModelMember>,
    pub related: Vec<RelatedClass>,
}

/// Where a column is known from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ColumnSource {
    Migration,
    Database,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelColumn {
    pub name: String,
    /// The PHP type reading the column gives (before casts): `string`, `int`.
    pub ty: String,
    pub nullable: bool,
    /// The model's cast of it, as written (a class with a leading `\`).
    pub cast: Option<String>,
    pub source: ColumnSource,
    /// The data source's name, for [`ColumnSource::Database`].
    pub database: Option<String>,
    /// In `$fillable`.
    pub fillable: bool,
    /// In `$hidden`.
    pub hidden: bool,
    /// The column in its migration, when one makes it.
    pub location: Option<ModelLocation>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelRelationItem {
    /// The method's name.
    pub name: String,
    /// The relation class's short name (`HasMany`).
    pub kind: String,
    /// The related model (FQN).
    pub related: Option<String>,
    pub many: bool,
    pub location: Option<ModelLocation>,
}

/// A local scope (`published`, from `scopePublished`) or an accessor
/// (`excerpt`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelMember {
    /// The name it is used by.
    pub name: String,
    /// The declaring method.
    pub method: String,
    /// An accessor's type.
    pub ty: Option<String>,
    pub location: Option<ModelLocation>,
}

/// What a related class or file is.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RelatedKind {
    Factory,
    Resource,
    Policy,
    Observer,
    Migration,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelatedClass {
    pub kind: RelatedKind,
    /// A class's FQN, or a migration's file name without `.php`.
    pub name: String,
    pub location: ModelLocation,
}

/// The lens on a model class.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelLens {
    /// The class's name.
    pub range: Range,
    /// `posts · 9 columns · 3 relations`.
    pub title: String,
    pub class: String,
}

/// A column the **Add columns** button adds.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewColumn {
    pub name: String,
    /// The `Blueprint` method making it (`string`, `foreignId`).
    pub ty: String,
    pub nullable: bool,
}

/// `[A-Za-z_][A-Za-z0-9_]*`.
fn is_identifier(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// The strings of an array property's default (`['title', 'body']`).
fn string_list(model: &ClassModel, property: &str) -> Option<Vec<String>> {
    let value = model.property(property)?.declared()?.default.clone()?;
    Some(
        value
            .split(',')
            .map(|item| {
                item.trim().trim_matches(['[', ']', ' ', '\n', '\r', '\t']).trim_matches(['\'', '"']).to_owned()
            })
            .filter(|item| !item.is_empty())
            .collect(),
    )
}

/// A scalar property default without quotes (`'uuid'` → `uuid`).
fn scalar(model: &ClassModel, property: &str) -> Option<String> {
    let value = model.property(property)?.declared()?.default.clone()?;
    let value = value.trim().trim_matches(['\'', '"']).to_owned();
    (!value.is_empty()).then_some(value)
}

/// The migration's file name: `add_subtitle_to_posts_table`,
/// `add_subtitle_and_views_to_posts_table`, `add_columns_to_posts_table`.
pub fn migration_name(table: &str, columns: &[NewColumn]) -> String {
    let what = match columns {
        [one] => one.name.to_ascii_lowercase(),
        [a, b] => format!("{}_and_{}", a.name.to_ascii_lowercase(), b.name.to_ascii_lowercase()),
        _ => "columns".to_owned(),
    };
    format!("add_{what}_to_{table}_table")
}

/// The migration adding `columns` to `table` (`Schema::table`), and dropping
/// them again in `down()`.
pub fn migration_source(table: &str, columns: &[NewColumn]) -> String {
    let unit = "    ";
    let body = format!("{unit}{unit}{unit}");
    let mut up = String::new();
    let mut dropped = Vec::new();
    let mut down = String::new();
    for column in columns {
        let mut line = format!("{body}$table->{}('{}')", column.ty, column.name);
        if column.nullable {
            line.push_str("->nullable()");
        }
        if column.ty == "foreignId" {
            line.push_str("->constrained()");
            down.push_str(&format!("{body}$table->dropConstrainedForeignId('{}');\n", column.name));
        } else {
            dropped.push(format!("'{}'", column.name));
        }
        up.push_str(&line);
        up.push_str(";\n");
    }
    if !dropped.is_empty() {
        down.push_str(&format!("{body}$table->dropColumn([{}]);\n", dropped.join(", ")));
    }
    format!(
        "<?php\n\nuse Illuminate\\Database\\Migrations\\Migration;\nuse Illuminate\\Database\\Schema\\Blueprint;\nuse Illuminate\\Support\\Facades\\Schema;\n\nreturn new class extends Migration\n{{\n{unit}public function up(): void\n{unit}{{\n{unit}{unit}Schema::table('{table}', function (Blueprint $table) {{\n{up}{unit}{unit}}});\n{unit}}}\n\n{unit}public function down(): void\n{unit}{{\n{unit}{unit}Schema::table('{table}', function (Blueprint $table) {{\n{down}{unit}{unit}}});\n{unit}}}\n}};\n"
    )
}

/// The text to insert into the array literal `text[open..=close]` so that
/// it ends with `items` (quoted), keeping its layout: one per line in a
/// multi-line array, a trailing comma when it has one. `(at, text)`.
pub fn append_to_array(text: &str, open: usize, close: usize, items: &[String]) -> (usize, String) {
    let quoted: Vec<String> = items.iter().map(|item| format!("'{item}'")).collect();
    let inner = &text[open + 1..close];
    let content = inner.trim_end();
    let at = open + 1 + content.len();
    if content.trim().is_empty() {
        return (open + 1, quoted.join(", "));
    }
    let trailing = content.ends_with(',');
    if inner.contains('\n') {
        let line_start = text[..at].rfind('\n').map_or(0, |i| i + 1);
        let indent: String = text[line_start..].chars().take_while(|c| *c == ' ' || *c == '\t').collect();
        let lines: Vec<String> = quoted.iter().map(|item| format!("\n{indent}{item}")).collect();
        let mut out = if trailing { String::new() } else { ",".to_owned() };
        out.push_str(&lines.join(","));
        if trailing {
            out.push(',');
        }
        (at, out)
    } else {
        let mut out = if trailing { " ".to_owned() } else { ", ".to_owned() };
        out.push_str(&quoted.join(", "));
        if trailing {
            out.push(',');
        }
        (at, out)
    }
}

impl PhpEngine {
    /// The model class `class` (a subclass of Eloquent's `Model`).
    pub(crate) fn eloquent_model(&self, class: &str) -> Option<std::sync::Arc<ClassModel>> {
        let model = self.resolver().class_model(class.trim_start_matches('\\'))?;
        (model.kind() == ClassKind::Class && model.fqn() != MODEL && model.is_subclass_of(MODEL)).then_some(model)
    }

    /// Where class `model` is declared.
    pub(crate) fn class_location(&self, model: &ClassModel) -> Option<ModelLocation> {
        let path = self.class_path(&model.class, Path::new(""), &FileSummary::default())?;
        Some(ModelLocation { path, range: model.class.name_loc.range })
    }

    /// Where method `name` of `model` is declared.
    fn method_location(&self, model: &ClassModel, name: &str) -> Option<ModelLocation> {
        let method = model.method(name)?;
        let declared = method.declared()?;
        let path = self.class_path(&method.declaring, Path::new(""), &FileSummary::default())?;
        Some(ModelLocation { path, range: declared.name_loc.range })
    }

    /// For each Eloquent model class of the open document `doc`, a lens
    /// opening its model view. `None` outside Laravel projects.
    pub fn laravel_model_lenses(&self, doc: DocId) -> Option<Vec<ModelLens>> {
        self.laravel()?;
        let parsed = self.parsed_document(doc)?;
        let here = FileSummary::extract(&parsed);
        let resolver = self.resolver();
        let facts = resolver.laravel();
        let mut out = Vec::new();
        for class in here.class_likes.iter().filter(|class| class.kind == ClassKind::Class) {
            let Some(model) = self.eloquent_model(&class.fqn) else { continue };
            let table = LaravelProvider::model_table(&resolver, model.fqn()).unwrap_or_default();
            let columns = facts.columns(&table).len();
            let relations = LaravelProvider::model_relations(&resolver, model.fqn()).len();
            let plural = |n: usize, one: &str, many: &str| format!("{n} {}", if n == 1 { one } else { many });
            let title = format!(
                "{table} · {} · {}",
                plural(columns, "column", "columns"),
                plural(relations, "relation", "relations")
            );
            out.push(ModelLens { range: class.name_loc.range, title, class: model.fqn().to_owned() });
        }
        Some(out)
    }

    /// The model view of Eloquent model `class` (see the module
    /// documentation). `None` outside Laravel projects and for other
    /// classes.
    pub fn laravel_model_view(&self, class: &str) -> Option<ModelView> {
        self.laravel()?;
        let model = self.eloquent_model(class)?;
        let resolver = self.resolver();
        let facts = resolver.laravel();
        let fqn = model.fqn().to_owned();
        let short = fqn.rsplit('\\').next().unwrap_or(&fqn).to_owned();
        let table = LaravelProvider::model_table(&resolver, &fqn)?;

        let fillable = string_list(&model, "fillable").unwrap_or_default();
        let hidden = string_list(&model, "hidden").unwrap_or_default();
        let casts = LaravelProvider::casts_of(&facts, &model);
        let columns = facts
            .columns(&table)
            .into_iter()
            .map(|(migration, column)| ModelColumn {
                name: column.name.clone(),
                ty: column.ty.0.trim_start_matches('\\').to_owned(),
                nullable: column.nullable,
                cast: casts
                    .and_then(|casts| casts.casts.iter().find(|cast| cast.attribute == column.name))
                    .map(|cast| cast.cast.clone()),
                source: if migration.database.is_some() { ColumnSource::Database } else { ColumnSource::Migration },
                database: migration.database.clone(),
                fillable: fillable.contains(&column.name),
                hidden: hidden.contains(&column.name),
                location: migration.file.clone().map(|path| ModelLocation { path, range: column.loc.range }),
            })
            .collect();

        let relations = LaravelProvider::model_relations(&resolver, &fqn)
            .into_iter()
            .map(|relation| ModelRelationItem {
                location: self.method_location(&model, &relation.name),
                name: relation.name,
                kind: relation.kind,
                related: relation.related,
                many: relation.many,
            })
            .collect();

        let mut scopes = Vec::new();
        let mut accessors = Vec::new();
        for method in model.methods.iter() {
            if method.is_static || method.declaring.fqn.starts_with("Illuminate\\") {
                continue;
            }
            let scope = scope_name(&method.name)
                .or_else(|| method.declared().is_some_and(is_scope_attributed).then_some(method.name.as_str()));
            if let Some(rest) = scope {
                let mut chars = rest.chars();
                let name = chars.next().map(|c| c.to_lowercase().chain(chars).collect()).unwrap_or_default();
                scopes.push(ModelMember {
                    name,
                    method: method.name.clone(),
                    ty: None,
                    location: self.method_location(&model, &method.name),
                });
            } else if let Some(rest) = accessor_name(&method.name) {
                accessors.push(ModelMember {
                    name: snake(rest),
                    method: method.name.clone(),
                    ty: None,
                    location: self.method_location(&model, &method.name),
                });
            }
        }
        // Accessors returning `Attribute`, and the types of all of them.
        let members = resolver.providers().magic_members(&Type::named(&fqn), &resolver, &Context::default());
        for member in &members {
            let MagicTarget::Attribute { ty, origin: AttributeOrigin::Accessor { method }, .. } = &member.target else {
                continue;
            };
            match accessors.iter_mut().find(|known| known.method == *method) {
                Some(known) => known.ty = Some(ty.to_string()),
                None => accessors.push(ModelMember {
                    name: member.name.clone(),
                    method: method.clone(),
                    ty: Some(ty.to_string()),
                    location: self.method_location(&model, method),
                }),
            }
        }

        let mut related = self.related_classes(&short);
        let mut seen: Vec<PathBuf> = Vec::new();
        for migration in facts.tables.iter().filter(|t| t.name.eq_ignore_ascii_case(&table)) {
            let Some(path) = migration.file.clone() else { continue };
            if seen.contains(&path) {
                continue;
            }
            seen.push(path.clone());
            let name = path.file_stem().map(|stem| stem.to_string_lossy().into_owned()).unwrap_or_default();
            let range = migration.columns.first().map(|column| column.loc.range).unwrap_or_default();
            related.push(RelatedClass { kind: RelatedKind::Migration, name, location: ModelLocation { path, range } });
        }

        Some(ModelView {
            location: self.class_location(&model),
            primary_key: scalar(&model, "primaryKey").unwrap_or_else(|| "id".to_owned()),
            key_type: scalar(&model, "keyType").unwrap_or_else(|| "int".to_owned()),
            incrementing: scalar(&model, "incrementing").is_none_or(|value| !value.eq_ignore_ascii_case("false")),
            schema_certain: facts.schema_certain(&table),
            class: fqn,
            name: short,
            table,
            columns,
            relations,
            scopes,
            accessors,
            related,
        })
    }

    /// The factories, resources, policies and observers of the model named
    /// `short`, by Laravel's naming conventions.
    fn related_classes(&self, short: &str) -> Vec<RelatedClass> {
        let Some(index) = self.index() else { return Vec::new() };
        let resolver = self.resolver();
        let kinds: [(RelatedKind, &str); 5] = [
            (RelatedKind::Factory, "Factory"),
            (RelatedKind::Resource, "Resource"),
            (RelatedKind::Resource, "Collection"),
            (RelatedKind::Policy, "Policy"),
            (RelatedKind::Observer, "Observer"),
        ];
        let mut out = Vec::new();
        for (kind, suffix) in kinds {
            let wanted = format!("{short}{suffix}");
            let mut decls = index.by_short_name(&wanted).unwrap_or_default();
            decls.sort();
            for decl in decls {
                if !decl.short_name().eq_ignore_ascii_case(&wanted)
                    || out.iter().any(|r: &RelatedClass| r.name == decl.fqn)
                {
                    continue;
                }
                let Some(class) = resolver.class_model(&decl.fqn) else { continue };
                if class.kind() != ClassKind::Class {
                    continue;
                }
                let fits = match kind {
                    RelatedKind::Factory => class.is_subclass_of(FACTORY),
                    RelatedKind::Resource => class.is_subclass_of(JSON_RESOURCE) || decl.fqn.contains("\\Resources\\"),
                    _ => true,
                };
                if !fits {
                    continue;
                }
                if let Some(location) = self.class_location(&class) {
                    out.push(RelatedClass { kind, name: class.fqn().to_owned(), location });
                }
            }
        }
        out
    }

    /// The **Add columns** edit: a new migration
    /// (`database/migrations/<timestamp>_add_…_to_<table>_table.php`) adding
    /// `columns` to the table of model `class`, and the columns added to
    /// the model's `$fillable` when `fillable` (a `$fillable` property is
    /// declared when the model has neither it nor `$guarded`).
    /// `timestamp` is the migration's prefix (`2024_05_01_120000`). Fails
    /// with a message for invalid or existing column names.
    pub fn laravel_add_columns(
        &self,
        class: &str,
        columns: &[NewColumn],
        fillable: bool,
        timestamp: &str,
    ) -> Result<WorkspaceEdit, String> {
        let project = self.laravel().ok_or("Not a Laravel project")?;
        let model = self.eloquent_model(class).ok_or_else(|| format!("'{class}' is not an Eloquent model"))?;
        let resolver = self.resolver();
        let table = LaravelProvider::model_table(&resolver, model.fqn()).ok_or("The model has no table")?;
        if columns.is_empty() {
            return Err("Add at least one column".to_owned());
        }
        let existing = resolver.laravel().columns(&table).into_iter().map(|(_, c)| c.name.clone()).collect::<Vec<_>>();
        let mut names: Vec<&str> = Vec::new();
        for column in columns {
            if !is_identifier(&column.name) {
                return Err(format!("'{}' is not a valid column name", column.name));
            }
            if !is_identifier(&column.ty) {
                return Err(format!("'{}' is not a column type", column.ty));
            }
            if existing.iter().any(|known| known.eq_ignore_ascii_case(&column.name))
                || names.iter().any(|known| known.eq_ignore_ascii_case(&column.name))
            {
                return Err(format!("The table '{table}' has a column '{}' already", column.name));
            }
            names.push(&column.name);
        }

        let file = project
            .paths
            .database
            .join("migrations")
            .join(format!("{timestamp}_{}.php", migration_name(&table, columns)));
        if file.exists() || self.open_document(&file).is_some() {
            return Err(format!("{} exists already", file.display()));
        }
        let mut edit = WorkspaceEdit {
            files: vec![
                FileEdit::Create { path: file.clone().into(), overwrite: false },
                FileEdit::Edit {
                    path: file.into(),
                    edits: vec![TextEdit { range: Range::default(), new_text: migration_source(&table, columns) }],
                    version: None,
                },
            ],
            preconditions: Vec::new(),
        };
        if fillable && let Some(fillable_edit) = self.fillable_edit(&model, &names) {
            edit.files.push(fillable_edit);
        }
        Ok(edit)
    }

    /// The edit adding `names` to `$fillable` of `model` (its own
    /// declaration), or declaring the property when the model has neither
    /// it nor `$guarded`.
    pub(crate) fn fillable_edit(&self, model: &ClassModel, names: &[&str]) -> Option<FileEdit> {
        let location = self.class_location(model)?;
        let text = self.text_of(&location.path)?;
        let lines = LineIndex::new(&text);
        let items: Vec<String> = names.iter().map(|name| (*name).to_owned()).collect();
        let own = model
            .property("fillable")
            .filter(|property| property.declaring.fqn.eq_ignore_ascii_case(model.fqn()))
            .and_then(|property| property.declared().map(|declared| declared.loc));
        let (at, insert) = match own {
            Some(loc) => {
                let statement = text.get(loc.start as usize..loc.end as usize)?;
                let open = loc.start as usize + statement.find('[')?;
                let close = loc.start as usize + statement.rfind(']')?;
                let known = string_list(model, "fillable").unwrap_or_default();
                let fresh: Vec<String> = items.into_iter().filter(|item| !known.contains(item)).collect();
                if fresh.is_empty() {
                    return None;
                }
                append_to_array(&text, open, close, &fresh)
            }
            // The framework's `Model` declares both; an application class
            // (a parent model) declaring either keeps it.
            None if ["fillable", "guarded"].iter().any(|name| {
                model.property(name).is_some_and(|property| !property.declaring.fqn.starts_with("Illuminate\\"))
            }) =>
            {
                return None;
            }
            None => {
                // The first line of the class body.
                let class = &model.class;
                let body =
                    class.loc.start as usize + text.get(class.loc.start as usize..class.loc.end as usize)?.find('{')?;
                let nl = if text.contains("\r\n") { "\r\n" } else { "\n" };
                let quoted: Vec<String> = items.iter().map(|item| format!("'{item}'")).collect();
                (body + 1, format!("{nl}    protected $fillable = [{}];{nl}", quoted.join(", ")))
            }
        };
        let pos = lines.pos(at as u32);
        Some(FileEdit::Edit {
            path: location.path.into(),
            edits: vec![TextEdit { range: Range { start: pos, end: pos }, new_text: insert }],
            version: None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn column(name: &str, ty: &str, nullable: bool) -> NewColumn {
        NewColumn { name: name.to_owned(), ty: ty.to_owned(), nullable }
    }

    #[test]
    fn migration_names() {
        assert_eq!(migration_name("posts", &[column("subtitle", "string", false)]), "add_subtitle_to_posts_table");
        assert_eq!(
            migration_name("posts", &[column("subtitle", "string", false), column("Views", "integer", false)]),
            "add_subtitle_and_views_to_posts_table"
        );
        let three = [column("a", "string", false), column("b", "string", false), column("c", "string", false)];
        assert_eq!(migration_name("posts", &three), "add_columns_to_posts_table");
    }

    #[test]
    fn migration_sources() {
        let source =
            migration_source("posts", &[column("subtitle", "string", true), column("editor_id", "foreignId", false)]);
        assert!(source.contains("Schema::table('posts', function (Blueprint $table) {\n            $table->string('subtitle')->nullable();\n            $table->foreignId('editor_id')->constrained();\n        });"), "{source}");
        assert!(source.contains("            $table->dropConstrainedForeignId('editor_id');\n            $table->dropColumn(['subtitle']);\n"), "{source}");
        assert!(source.starts_with("<?php\n\nuse Illuminate\\Database\\Migrations\\Migration;"));
        assert!(source.ends_with("};\n"));
    }

    #[test]
    fn appends_to_arrays() {
        let apply = |text: &str, items: &[&str]| {
            let open = text.find('[').unwrap();
            let close = text.rfind(']').unwrap();
            let items: Vec<String> = items.iter().map(|item| (*item).to_owned()).collect();
            let (at, insert) = append_to_array(text, open, close, &items);
            format!("{}{insert}{}", &text[..at], &text[at..])
        };
        assert_eq!(apply("$f = ['a', 'b'];", &["c", "d"]), "$f = ['a', 'b', 'c', 'd'];");
        assert_eq!(apply("$f = [];", &["c"]), "$f = ['c'];");
        assert_eq!(apply("$f = ['a',];", &["c"]), "$f = ['a', 'c',];");
        assert_eq!(apply("$f = [\n    'a',\n    'b',\n];", &["c"]), "$f = [\n    'a',\n    'b',\n    'c',\n];");
        assert_eq!(apply("$f = [\n    'a'\n];", &["c", "d"]), "$f = [\n    'a',\n    'c',\n    'd'\n];");
    }

    #[test]
    fn identifiers() {
        assert!(is_identifier("subtitle_2"));
        assert!(is_identifier("_x"));
        assert!(!is_identifier("2x"));
        assert!(!is_identifier("a-b"));
        assert!(!is_identifier(""));
        assert!(!is_identifier("x'); drop"));
    }
}
