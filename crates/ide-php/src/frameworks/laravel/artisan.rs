//! Artisan commands of a Laravel project ([`ArtisanCommands`]), for the
//! `artisanCommand` reference kind, the "Run Artisan command…" dialog and the
//! Artisan run configuration:
//!
//! - the console command classes of the project and of its packages
//!   (subclasses of `Illuminate\Console\Command`): the name, arguments and
//!   options of their `$signature`, else their `$name` or the name of their
//!   `#[AsCommand]` attribute, and their `$description`;
//! - the closure commands of `routes/console.php` (also a module's):
//!   `Artisan::command('inspire', fn …)->purpose('…')`;
//! - Laravel's own commands ([`FRAMEWORK`]), for projects without a
//!   `vendor/` (a vendor class of the same name wins).
//!
//! Signatures are read as Laravel's `Illuminate\Console\Parser` (MIT) reads
//! them ([`parse_signature`]): `name {arg} {arg?} {arg*} {arg=default}
//! {--flag} {--option=} {--option=*} {--option=default} {--S|option}`, each
//! with an optional ` : description`.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use ide_core::Range;

use super::project::LaravelProject;
use super::views::{call_arguments, string_literal};
use crate::engine::PhpEngine;
use crate::summary::{ClassKind, FileSummary};
use crate::syntax::LineIndex;
use crate::types::model::{ClassModel, ModelProperty};

/// The base class of console commands.
pub const CONSOLE_COMMAND: &str = "Illuminate\\Console\\Command";

/// An argument of a command.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ArtisanArgument {
    pub name: String,
    pub description: String,
    pub required: bool,
    /// Takes several values (`{user*}`).
    pub array: bool,
    pub default: Option<String>,
}

/// An option of a command (without the leading `--`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ArtisanOption {
    pub name: String,
    pub shortcut: Option<String>,
    pub description: String,
    /// Takes a value (`--queue=`), as opposed to a flag (`--force`).
    pub accepts_value: bool,
    /// Can be given several times (`--id=*`).
    pub array: bool,
    pub default: Option<String>,
}

/// Where a command comes from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CommandSource {
    /// A command class of the project.
    Class,
    /// A closure command of a `console.php` route file.
    Closure,
    /// A command class of a package (`vendor/`).
    Package,
    /// Laravel's own command, from the built-in table.
    Framework,
}

/// One Artisan command.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ArtisanCommand {
    /// `posts:publish`.
    pub name: String,
    pub description: String,
    pub arguments: Vec<ArtisanArgument>,
    pub options: Vec<ArtisanOption>,
    pub source: CommandSource,
    /// The command class (FQN without the leading `\`).
    pub class: Option<String>,
    /// The file declaring it.
    pub path: Option<PathBuf>,
    /// The name in its signature, `$name` or attribute string, else the
    /// class name.
    pub range: Option<Range>,
    /// The byte range of [`Self::range`] in the file.
    pub bytes: Option<(u32, u32)>,
    /// The class name (where the run gutter icon goes).
    pub class_range: Option<Range>,
}

impl ArtisanCommand {
    /// `posts:publish [--dry-run] <post> [<tags>...]`.
    pub fn synopsis(&self) -> String {
        let mut out = self.name.clone();
        for option in &self.options {
            let value =
                if option.accepts_value { format!("={}", option.name.to_ascii_uppercase()) } else { String::new() };
            out.push_str(&format!(" [--{}{value}]", option.name));
        }
        for argument in &self.arguments {
            let many = if argument.array { "..." } else { "" };
            if argument.required {
                out.push_str(&format!(" <{}>{many}", argument.name));
            } else {
                out.push_str(&format!(" [<{}>{many}]", argument.name));
            }
        }
        out
    }

    /// The option named `name` (without `--`) or with shortcut `name`.
    pub fn option(&self, name: &str) -> Option<&ArtisanOption> {
        self.options.iter().find(|option| option.name == name || option.shortcut.as_deref() == Some(name))
    }
}

/// The commands of a project, sorted by name; see the module documentation.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ArtisanCommands {
    pub commands: Vec<ArtisanCommand>,
}

impl ArtisanCommands {
    /// The commands of `project`.
    pub fn read(engine: &PhpEngine, project: &LaravelProject) -> Self {
        let mut project_commands = Vec::new();
        let mut packages = Vec::new();
        for model in command_classes(engine) {
            let Some(command) = class_command(engine, &model) else { continue };
            if command.source == CommandSource::Package {
                packages.push(command);
            } else {
                project_commands.push(command);
            }
        }
        let mut console_files = vec![project.paths.routes.join("console.php")];
        for module in project.modules.iter().filter(|module| module.enabled) {
            console_files.push(module.path.join("routes").join("console.php"));
        }
        let mut closures = Vec::new();
        for path in console_files {
            if let Some(text) = engine.text_of(&path) {
                closures.extend(closure_commands(&path, &text));
            }
        }
        let framework = FRAMEWORK.iter().filter_map(|(signature, description)| {
            let (name, arguments, options) = parse_signature(signature)?;
            Some(ArtisanCommand {
                name,
                description: (*description).to_owned(),
                arguments,
                options,
                source: CommandSource::Framework,
                class: None,
                path: None,
                range: None,
                bytes: None,
                class_range: None,
            })
        });
        Self::merge(project_commands.into_iter().chain(closures).chain(packages).chain(framework))
    }

    /// `commands` once per name (the first wins, its missing description and
    /// definition taken from a later one), sorted.
    pub fn merge(commands: impl IntoIterator<Item = ArtisanCommand>) -> Self {
        let mut out: Vec<ArtisanCommand> = Vec::new();
        for command in commands {
            match out.iter_mut().find(|known| known.name == command.name) {
                Some(known) => {
                    if known.description.is_empty() {
                        known.description = command.description;
                    }
                    if known.arguments.is_empty() && known.options.is_empty() {
                        known.arguments = command.arguments;
                        known.options = command.options;
                    }
                }
                None => out.push(command),
            }
        }
        out.sort_by(|a, b| a.name.cmp(&b.name));
        Self { commands: out }
    }

    /// The command named `name`.
    pub fn get(&self, name: &str) -> Option<&ArtisanCommand> {
        self.commands.iter().find(|command| command.name == name)
    }

    /// The commands declared in `path`.
    pub fn in_file<'s>(&'s self, path: &'s Path) -> impl Iterator<Item = &'s ArtisanCommand> + 's {
        self.commands.iter().filter(move |command| command.path.as_deref() == Some(path))
    }
}

/// The classes extending [`CONSOLE_COMMAND`], directly or not.
fn command_classes(engine: &PhpEngine) -> Vec<std::sync::Arc<ClassModel>> {
    let Some(index) = engine.index() else { return Vec::new() };
    let resolver = engine.resolver();
    let mut seen: HashSet<String> = HashSet::new();
    let mut queue = vec![CONSOLE_COMMAND.to_owned()];
    let mut out = Vec::new();
    while let Some(parent) = queue.pop() {
        for decl in index.direct_subclasses(&parent).unwrap_or_default() {
            if !seen.insert(decl.fqn.to_ascii_lowercase()) {
                continue;
            }
            queue.push(decl.fqn.clone());
            if let Some(model) = resolver.class_model(&decl.fqn)
                && model.kind() == ClassKind::Class
                && !model.class.modifiers.is_abstract
            {
                out.push(model);
            }
        }
    }
    out
}

/// The string default of property `name` declared by the class itself or a
/// parent below [`CONSOLE_COMMAND`]: its value and the declaring class.
fn string_property<'m>(model: &'m ClassModel, name: &str) -> Option<(String, &'m ModelProperty)> {
    let property = model.property(name)?;
    if property.declaring.fqn.trim_start_matches('\\').eq_ignore_ascii_case(CONSOLE_COMMAND) {
        return None;
    }
    let value = string_literal(property.declared()?.default.as_deref()?)?;
    Some((value, property))
}

/// The command a class declares.
fn class_command(engine: &PhpEngine, model: &ClassModel) -> Option<ArtisanCommand> {
    let class = &model.class;
    let path = engine.class_path(class, Path::new(""), &FileSummary::default())?;
    let text = engine.text_of(&path).unwrap_or_default();
    let lines = LineIndex::new(&text);
    let in_vendor = path.components().any(|part| part.as_os_str() == "vendor");
    let attribute = as_command(&text, class.loc.start as usize, class.name_loc.start as usize);

    let mut name_at: Option<(u32, u32)> = None;
    let (name, arguments, options) = if let Some((signature, property)) = string_property(model, "signature") {
        let parsed = parse_signature(&signature)?;
        if property.declaring.fqn == class.fqn {
            name_at = property
                .declared()
                .and_then(|declared| name_in(&text, declared.loc.start, declared.loc.end, &parsed.0));
        }
        parsed
    } else if let Some((name, property)) = string_property(model, "name") {
        if property.declaring.fqn == class.fqn {
            name_at =
                property.declared().and_then(|declared| name_in(&text, declared.loc.start, declared.loc.end, &name));
        }
        (name, Vec::new(), Vec::new())
    } else {
        let (name, at, _) = attribute.clone()?;
        name_at = Some(at);
        (name, Vec::new(), Vec::new())
    };
    if name.is_empty() {
        return None;
    }
    if name_at.is_none()
        && let Some((attribute_name, at, _)) = &attribute
        && *attribute_name == name
    {
        name_at = Some(*at);
    }
    let description = string_property(model, "description")
        .map(|(description, _)| description)
        .or_else(|| attribute.and_then(|(_, _, description)| description))
        .unwrap_or_default();
    let name_bytes = name_at.unwrap_or((class.name_loc.start, class.name_loc.end));
    Some(ArtisanCommand {
        name,
        description,
        arguments,
        options,
        source: if in_vendor { CommandSource::Package } else { CommandSource::Class },
        class: Some(class.fqn.trim_start_matches('\\').to_owned()),
        range: Some(lines.range(name_bytes.0, name_bytes.1)),
        bytes: Some(name_bytes),
        class_range: Some(class.name_loc.range),
        path: Some(path),
    })
}

/// The bytes of `name` in the first string literal of `text[start..end]`.
fn name_in(text: &str, start: u32, end: u32, name: &str) -> Option<(u32, u32)> {
    let statement = text.get(start as usize..end as usize)?;
    let quote = statement.find(['\'', '"'])?;
    let content = &statement[quote + 1..];
    let skipped = content.len() - content.trim_start().len();
    content.trim_start().starts_with(name).then(|| {
        let from = start + (quote + 1 + skipped) as u32;
        (from, from + name.len() as u32)
    })
}

/// The name (and its bytes) and description of an `#[AsCommand(…)]`
/// attribute between `start` and `end` (the class's attributes).
fn as_command(text: &str, start: usize, end: usize) -> Option<(String, (u32, u32), Option<String>)> {
    let head = text.get(start..end)?;
    let at = head.find("AsCommand(")?;
    let open = start + at + "AsCommand".len();
    let arguments = call_arguments(text, open)?;
    let mut name = None;
    let mut description = None;
    let mut positional = 0;
    for argument in &arguments {
        let (key, value) = match argument.split_once(':') {
            Some((key, value))
                if key.trim().bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_') && !key.trim().is_empty() =>
            {
                (key.trim().to_owned(), value.trim())
            }
            _ => {
                positional += 1;
                (
                    if positional == 1 {
                        "name"
                    } else if positional == 2 {
                        "description"
                    } else {
                        ""
                    }
                    .to_owned(),
                    argument.trim(),
                )
            }
        };
        match key.as_str() {
            "name" => name = Some(value.to_owned()),
            "description" => description = string_literal(value),
            _ => {}
        }
    }
    let written = name?;
    let value = string_literal(&written)?;
    // Laravel's `name: 'a|b'` gives aliases after the first name.
    let first = value.split('|').next().unwrap_or_default().to_owned();
    let found = text[open..].find(written.as_str())? + open + 1;
    Some((first.clone(), (found as u32, (found + first.len()) as u32), description))
}

/// The closure commands of a `console.php` route file.
pub fn closure_commands(path: &Path, text: &str) -> Vec<ArtisanCommand> {
    let lines = LineIndex::new(text);
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(at) = text[from..].find("Artisan::command(") {
        let open = from + at + "Artisan::command".len();
        from = open + 1;
        let Some((signature, start)) = first_string(text, open) else { continue };
        let Some((name, arguments, options)) = parse_signature(&signature) else { continue };
        let skipped = signature.len() - signature.trim_start().len();
        let name_start = (start + skipped) as u32;
        let name_bytes = (name_start, name_start + name.len() as u32);
        // `->purpose('…')` / `->describe('…')` up to the end of the statement.
        let close = matching_paren(text, open).unwrap_or(open);
        let statement_end = text[close..].find(';').map_or(text.len(), |end| close + end);
        let chain = &text[close..statement_end];
        let description = ["->purpose(", "->describe("]
            .iter()
            .find_map(|call| chain.find(call).map(|found| close + found + call.len() - 1))
            .and_then(|paren| first_string(text, paren))
            .map(|(description, _)| description)
            .unwrap_or_default();
        out.push(ArtisanCommand {
            name,
            description,
            arguments,
            options,
            source: CommandSource::Closure,
            class: None,
            path: Some(path.to_path_buf()),
            range: Some(lines.range(name_bytes.0, name_bytes.1)),
            bytes: Some(name_bytes),
            class_range: None,
        });
    }
    out
}

/// The first argument of the call whose `(` is at `open` when it is a plain
/// string: its content and the byte its content starts at.
fn first_string(text: &str, open: usize) -> Option<(String, usize)> {
    let rest = text.get(open + 1..)?;
    let start = open + 1 + (rest.len() - rest.trim_start().len());
    let quote = text[start..].chars().next().filter(|c| *c == '\'' || *c == '"')?;
    let len = text[start + 1..].find(quote)?;
    let content = &text[start + 1..start + 1 + len];
    (!content.trim().is_empty() && !(quote == '"' && content.contains('$'))).then(|| (content.to_owned(), start + 1))
}

/// The `)` closing the `(` at `open`, outside strings.
fn matching_paren(text: &str, open: usize) -> Option<usize> {
    let bytes = text.as_bytes();
    let mut depth = 0usize;
    let mut i = open;
    while i < bytes.len() {
        match bytes[i] {
            quote @ (b'\'' | b'"') => {
                i += 1;
                while i < bytes.len() && bytes[i] != quote {
                    if bytes[i] == b'\\' {
                        i += 1;
                    }
                    i += 1;
                }
            }
            b'(' => depth += 1,
            b')' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i);
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

// -------------------------------------------------------------- signature

/// The name, arguments and options of a command signature; `None` without a
/// name.
pub fn parse_signature(signature: &str) -> Option<(String, Vec<ArtisanArgument>, Vec<ArtisanOption>)> {
    let name = signature.split_whitespace().next()?.to_owned();
    if name.starts_with('{') {
        return None;
    }
    let mut arguments = Vec::new();
    let mut options = Vec::new();
    let mut rest = signature;
    while let Some(open) = rest.find('{') {
        let Some(close) = rest[open..].find('}') else { break };
        let token = rest[open + 1..open + close].trim();
        rest = &rest[open + close + 1..];
        if token.is_empty() {
            continue;
        }
        let (token, description) = split_description(token);
        match token.strip_prefix("--") {
            Some(option) => options.push(parse_option(option, description)),
            None => arguments.push(parse_argument(token, description)),
        }
    }
    Some((name, arguments, options))
}

/// `name : description` → (`name`, `description`).
fn split_description(token: &str) -> (&str, String) {
    let bytes = token.as_bytes();
    for (i, b) in bytes.iter().enumerate() {
        if *b == b':'
            && i > 0
            && bytes[i - 1].is_ascii_whitespace()
            && bytes.get(i + 1).is_some_and(|next| next.is_ascii_whitespace())
        {
            return (token[..i].trim(), token[i + 1..].trim().to_owned());
        }
    }
    (token.trim(), String::new())
}

fn parse_argument(token: &str, description: String) -> ArtisanArgument {
    let argument = |name: &str, required: bool, array: bool, default: Option<String>| ArtisanArgument {
        name: name.trim().to_owned(),
        description: description.clone(),
        required,
        array,
        default,
    };
    if let Some(name) = token.strip_suffix("?*") {
        argument(name, false, true, None)
    } else if let Some(name) = token.strip_suffix('*') {
        argument(name, true, true, None)
    } else if let Some(name) = token.strip_suffix('?') {
        argument(name, false, false, None)
    } else if let Some((name, default)) = token.split_once("=*") {
        argument(name, false, true, Some(default.trim().to_owned()))
    } else if let Some((name, default)) = token.split_once('=') {
        argument(name, false, false, Some(default.trim().to_owned()))
    } else {
        argument(token, true, false, None)
    }
}

fn parse_option(token: &str, description: String) -> ArtisanOption {
    let (shortcut, token) = match token.split_once('|') {
        Some((shortcut, name)) => (Some(shortcut.trim().trim_start_matches('-').to_owned()), name.trim()),
        None => (None, token),
    };
    let option = |name: &str, accepts_value: bool, array: bool, default: Option<String>| ArtisanOption {
        name: name.trim().to_owned(),
        shortcut: shortcut.clone(),
        description: description.clone(),
        accepts_value,
        array,
        default,
    };
    if let Some(name) = token.strip_suffix("=*") {
        option(name, true, true, None)
    } else if let Some(name) = token.strip_suffix('=') {
        option(name, true, false, None)
    } else if let Some((name, default)) = token.split_once("=*") {
        option(name, true, true, Some(default.trim().to_owned()))
    } else if let Some((name, default)) = token.split_once('=') {
        option(name, true, false, Some(default.trim().to_owned()))
    } else {
        option(token, false, false, None)
    }
}

// -------------------------------------------------------------- framework

/// Laravel's own commands as signatures, with their descriptions (the ones
/// `php artisan list` shows on a new application; Laravel is MIT).
pub const FRAMEWORK: &[(&str, &str)] = &[
    (
        "about {--only= : The section to display} {--json : Output the information as JSON}",
        "Display basic information about your application",
    ),
    (
        "cache:clear {store? : The name of the store to clear} {--tags= : The cache tags to clear}",
        "Flush the application cache",
    ),
    (
        "cache:forget {key : The key to remove} {store? : The store to remove the key from}",
        "Remove an item from the cache",
    ),
    ("config:cache", "Create a cache file for faster configuration loading"),
    ("config:clear", "Remove the configuration cache file"),
    (
        "config:show {config : The configuration file or key to show}",
        "Display all of the values for a given configuration file or key",
    ),
    (
        "db {connection? : The database connection that should be used} {--read : Connect to the read connection} {--write : Connect to the write connection}",
        "Start a new database CLI session",
    ),
    (
        "db:seed {class? : The class name of the root seeder} {--class= : The class name of the root seeder} {--database= : The database connection to seed} {--force : Force the operation to run when in production}",
        "Seed the database with records",
    ),
    (
        "db:show {--database= : The database connection} {--json : Output the database information as JSON} {--counts : Show the table row count} {--views : Show the database views}",
        "Display information about the given database",
    ),
    (
        "db:table {table? : The name of the table} {--database= : The database connection} {--json : Output the table information as JSON}",
        "Display information about the given database table",
    ),
    (
        "db:wipe {--database= : The database connection to use} {--drop-views : Drop all tables and views} {--drop-types : Drop all tables and types (Postgres only)} {--force : Force the operation to run when in production}",
        "Drop all tables, views, and types",
    ),
    (
        "down {--redirect= : The path that users should be redirected to} {--render= : The view that should be prerendered for display during maintenance mode} {--retry= : The number of seconds after which the request may be retried} {--refresh= : The number of seconds after which the browser may refresh} {--secret= : The secret phrase that may be used to bypass maintenance mode} {--with-secret : Generate a random secret phrase that may be used to bypass maintenance mode} {--status=503 : The status code that should be used when returning the maintenance mode response}",
        "Put the application into maintenance / demo mode",
    ),
    ("up", "Bring the application out of maintenance mode"),
    ("env", "Display the current framework environment"),
    ("event:cache", "Discover and cache the application's events and listeners"),
    ("event:clear", "Clear all cached events and listeners"),
    ("event:list {--event= : Filter the events by name}", "List the application's events and listeners"),
    (
        "key:generate {--show : Display the key instead of modifying files} {--force : Force the operation to run when in production}",
        "Set the application key",
    ),
    (
        "list {namespace? : The namespace name} {--raw : To output raw command list} {--format=txt : The output format (txt, xml, json, or md)}",
        "List commands",
    ),
    (
        "help {command_name=help : The command name} {--format=txt : The output format (txt, xml, json, or md)} {--raw : To output raw command help}",
        "Display help for a command",
    ),
    (
        "make:cast {name : The name of the cast} {--inbound : Generate an inbound cast class} {--force : Create the class even if the cast already exists}",
        "Create a new custom Eloquent cast class",
    ),
    (
        "make:channel {name : The name of the channel} {--force : Create the class even if the channel already exists}",
        "Create a new channel class",
    ),
    (
        "make:class {name : The name of the class} {--invokable : Generate a single method, invokable class} {--force : Create the class even if the class already exists}",
        "Create a new class",
    ),
    (
        "make:command {name : The name of the command} {--command= : The terminal command that will be used to invoke the class} {--test : Generate an accompanying Test test for the Artisan command} {--pest : Generate an accompanying Pest test for the Artisan command} {--force : Create the class even if the console command already exists}",
        "Create a new Artisan command",
    ),
    (
        "make:component {name : The name of the component} {--inline : Create a component that renders an inline view} {--view : Create an anonymous component with only a view} {--path= : The location where the component view should be created} {--force : Create the class even if the component already exists}",
        "Create a new view component class",
    ),
    (
        "make:controller {name : The name of the controller} {--api : Exclude the create and edit methods from the controller} {--type= : Manually specify the controller stub file to use} {--force : Create the class even if the controller already exists} {--i|invokable : Generate a single method, invokable controller class} {--m|model= : Generate a resource controller for the given model} {--p|parent= : Generate a nested resource controller class} {--r|resource : Generate a resource controller class} {--R|requests : Generate FormRequest classes for store and update} {--singleton : Generate a singleton resource controller class} {--test : Generate an accompanying PHPUnit test for the Controller} {--pest : Generate an accompanying Pest test for the Controller}",
        "Create a new controller class",
    ),
    (
        "make:enum {name : The name of the enum} {--string : Generate a string backed enum} {--int : Generate an integer backed enum} {--force : Create the enum even if the enum already exists}",
        "Create a new enum",
    ),
    (
        "make:event {name : The name of the event} {--force : Create the class even if the event already exists}",
        "Create a new event class",
    ),
    (
        "make:exception {name : The name of the exception} {--render : Create the exception with an empty render method} {--report : Create the exception with an empty report method} {--force : Create the class even if the exception already exists}",
        "Create a new custom exception class",
    ),
    (
        "make:factory {name : The name of the factory} {--m|model= : The name of the model} {--force : Create the class even if the factory already exists}",
        "Create a new model factory",
    ),
    (
        "make:interface {name : The name of the interface} {--force : Create the interface even if the interface already exists}",
        "Create a new interface",
    ),
    (
        "make:job {name : The name of the job} {--sync : Indicates that job should be synchronous} {--test : Generate an accompanying PHPUnit test for the Job} {--pest : Generate an accompanying Pest test for the Job} {--force : Create the class even if the job already exists}",
        "Create a new job class",
    ),
    (
        "make:listener {name : The name of the listener} {--e|event= : The event class being listened for} {--queued : Indicates the event listener should be queued} {--force : Create the class even if the listener already exists}",
        "Create a new event listener class",
    ),
    (
        "make:mail {name : The name of the mailable} {--m|markdown= : Create a new Markdown template for the mailable} {--view= : Create a new Blade template for the mailable} {--test : Generate an accompanying PHPUnit test for the Mailable} {--force : Create the class even if the mailable already exists}",
        "Create a new email class",
    ),
    (
        "make:middleware {name : The name of the middleware} {--test : Generate an accompanying PHPUnit test for the Middleware} {--pest : Generate an accompanying Pest test for the Middleware}",
        "Create a new HTTP middleware class",
    ),
    (
        "make:migration {name : The name of the migration} {--create= : The table to be created} {--table= : The table to migrate} {--path= : The location where the migration file should be created} {--realpath : Indicate any provided migration file paths are pre-resolved absolute paths} {--fullpath : Output the full path of the migration}",
        "Create a new migration file",
    ),
    (
        "make:model {name : The name of the model} {--a|all : Generate a migration, seeder, factory, policy, resource controller, and form request classes for the model} {--c|controller : Create a new controller for the model} {--f|factory : Create a new factory for the model} {--force : Create the class even if the model already exists} {--m|migration : Create a new migration file for the model} {--morph-pivot : Indicates if the generated model should be a custom polymorphic intermediate table model} {--policy : Create a new policy for the model} {--s|seed : Create a new seeder for the model} {--p|pivot : Indicates if the generated model should be a custom intermediate table model} {--r|resource : Indicates if the generated controller should be a resource controller} {--api : Indicates if the generated controller should be an API resource controller} {--R|requests : Create new form request classes and use them in the resource controller} {--test : Generate an accompanying PHPUnit test for the Model} {--pest : Generate an accompanying Pest test for the Model}",
        "Create a new Eloquent model class",
    ),
    (
        "make:notification {name : The name of the notification} {--m|markdown= : Create a new Markdown template for the notification} {--force : Create the class even if the notification already exists}",
        "Create a new notification class",
    ),
    (
        "make:observer {name : The name of the observer} {--m|model= : The model that the observer applies to} {--force : Create the class even if the observer already exists}",
        "Create a new observer class",
    ),
    (
        "make:policy {name : The name of the policy} {--m|model= : The model that the policy applies to} {--g|guard= : The guard that the policy relies on} {--force : Create the class even if the policy already exists}",
        "Create a new policy class",
    ),
    (
        "make:provider {name : The name of the provider} {--force : Create the class even if the provider already exists}",
        "Create a new service provider class",
    ),
    (
        "make:request {name : The name of the request} {--force : Create the class even if the request already exists}",
        "Create a new form request class",
    ),
    (
        "make:resource {name : The name of the resource} {--c|collection : Create a resource collection} {--force : Create the class even if the resource already exists}",
        "Create a new resource",
    ),
    (
        "make:rule {name : The name of the rule} {--i|implicit : Generate an implicit rule} {--force : Create the class even if the rule already exists}",
        "Create a new validation rule",
    ),
    (
        "make:scope {name : The name of the scope} {--force : Create the class even if the scope already exists}",
        "Create a new scope class",
    ),
    ("make:seeder {name : The name of the seeder}", "Create a new seeder class"),
    (
        "make:test {name : The name of the test} {--u|unit : Create a unit test} {--pest : Create a Pest test} {--phpunit : Create a PHPUnit test} {--f|force : Create the test even if the test already exists}",
        "Create a new test class",
    ),
    (
        "make:trait {name : The name of the trait} {--force : Create the trait even if the trait already exists}",
        "Create a new trait",
    ),
    (
        "make:view {name : The name of the view} {--extension=.blade.php : The extension of the generated view} {--test : Generate an accompanying PHPUnit test for the View} {--pest : Generate an accompanying Pest test for the View} {--force : Create the view even if the view already exists}",
        "Create a new view",
    ),
    (
        "migrate {--database= : The database connection to use} {--force : Force the operation to run when in production} {--path=* : The path(s) to the migrations files to be executed} {--realpath : Indicate any provided migration file paths are pre-resolved absolute paths} {--schema-path= : The path to a schema dump file} {--pretend : Dump the SQL queries that would be run} {--seed : Indicates if the seed task should be re-run} {--seeder= : The class name of the root seeder} {--step : Force the migrations to be run so they can be rolled back individually} {--graceful : Return a successful exit code even if an error occurs}",
        "Run the database migrations",
    ),
    (
        "migrate:fresh {--database= : The database connection to use} {--drop-views : Drop all tables and views} {--drop-types : Drop all tables and types (Postgres only)} {--force : Force the operation to run when in production} {--path=* : The path(s) to the migrations files to be executed} {--realpath : Indicate any provided migration file paths are pre-resolved absolute paths} {--schema-path= : The path to a schema dump file} {--seed : Indicates if the seed task should be re-run} {--seeder= : The class name of the root seeder} {--step : Force the migrations to be run so they can be rolled back individually}",
        "Drop all tables and re-run all migrations",
    ),
    ("migrate:install {--database= : The database connection to use}", "Create the migration repository"),
    (
        "migrate:refresh {--database= : The database connection to use} {--force : Force the operation to run when in production} {--path=* : The path(s) to the migrations files to be executed} {--realpath : Indicate any provided migration file paths are pre-resolved absolute paths} {--seed : Indicates if the seed task should be re-run} {--seeder= : The class name of the root seeder} {--step= : The number of migrations to be reverted & re-run}",
        "Reset and re-run all migrations",
    ),
    (
        "migrate:reset {--database= : The database connection to use} {--force : Force the operation to run when in production} {--path=* : The path(s) to the migrations files to be executed} {--realpath : Indicate any provided migration file paths are pre-resolved absolute paths} {--pretend : Dump the SQL queries that would be run}",
        "Rollback all database migrations",
    ),
    (
        "migrate:rollback {--database= : The database connection to use} {--force : Force the operation to run when in production} {--path=* : The path(s) to the migrations files to be executed} {--realpath : Indicate any provided migration file paths are pre-resolved absolute paths} {--pretend : Dump the SQL queries that would be run} {--step= : The number of migrations to be reverted} {--batch= : The batch of migrations (identified by their batch number) to be reverted}",
        "Rollback the last database migration",
    ),
    (
        "migrate:status {--database= : The database connection to use} {--pending : Only list pending migrations} {--path=* : The path(s) to the migrations files to use} {--realpath : Indicate any provided migration file paths are pre-resolved absolute paths}",
        "Show the status of each migration",
    ),
    (
        "model:prune {--model=* : Class names of the models to be pruned} {--except=* : Class names of the models to be excluded from pruning} {--chunk=1000 : The number of models to retrieve per chunk of models to be deleted} {--pretend : Display the number of prunable records found instead of deleting them}",
        "Prune models that are no longer needed",
    ),
    (
        "model:show {model : The model to show} {--database= : The database connection to use} {--json : Output the model as JSON}",
        "Show information about an Eloquent model",
    ),
    ("optimize", "Cache framework bootstrap, configuration, and metadata to increase performance"),
    ("optimize:clear", "Remove the cached bootstrap files"),
    ("package:discover", "Rebuild the cached package manifest"),
    (
        "queue:clear {connection? : The name of the queue connection to clear} {--queue= : The name of the queue to clear} {--force : Force the operation to run when in production}",
        "Delete all of the jobs from the specified queue",
    ),
    ("queue:failed", "List all of the failed queue jobs"),
    ("queue:flush {--hours= : The number of hours to retain failed job data}", "Flush all of the failed queue jobs"),
    ("queue:forget {id : The ID of the failed job}", "Delete a failed queue job"),
    (
        "queue:listen {connection? : The name of connection} {--name=default : The name of the worker} {--delay=0 : The number of seconds to delay failed jobs} {--force : Force the worker to run even in maintenance mode} {--memory=128 : The memory limit in megabytes} {--queue= : The queue to listen on} {--sleep=3 : Number of seconds to sleep when no job is available} {--rest=0 : Number of seconds to rest between jobs} {--timeout=60 : The number of seconds a child process can run} {--tries=1 : Number of times to attempt a job before logging it failed}",
        "Listen to a given queue",
    ),
    ("queue:restart", "Restart queue worker daemons after their current job"),
    (
        "queue:retry {id?* : The ID of the failed job or \"all\" to retry all jobs} {--queue= : Retry all of the failed jobs for the specified queue} {--range=* : Range of job IDs (numeric) to be retried}",
        "Retry a failed queue job",
    ),
    (
        "queue:work {connection? : The name of the queue connection to work} {--name=default : The name of the worker} {--queue= : The names of the queues to work} {--daemon : Run the worker in daemon mode (Deprecated)} {--once : Only process the next job on the queue} {--stop-when-empty : Stop when the queue is empty} {--delay=0 : The number of seconds to delay failed jobs} {--backoff=0 : The number of seconds to wait before retrying a job that encountered an uncaught exception} {--max-jobs=0 : The number of jobs to process before stopping} {--max-time=0 : The maximum number of seconds the worker should run} {--force : Force the worker to run even in maintenance mode} {--memory=128 : The memory limit in megabytes} {--sleep=3 : Number of seconds to sleep when no job is available} {--rest=0 : Number of seconds to rest between jobs} {--timeout=60 : The number of seconds a child process can run} {--tries=1 : Number of times to attempt a job before logging it failed}",
        "Start processing jobs on the queue as a daemon",
    ),
    ("route:cache", "Create a route cache file for faster route registration"),
    ("route:clear", "Remove the route cache file"),
    (
        "route:list {--json : Output the route list as JSON} {--method= : Filter the routes by method} {--action= : Filter the routes by action} {--name= : Filter the routes by name} {--domain= : Filter the routes by domain} {--middleware= : Filter the routes by middleware} {--path= : Only show routes matching the given path pattern} {--except-path= : Do not display the routes matching the given path pattern} {--r|reverse : Reverse the ordering of the routes} {--sort=uri : The column (domain, method, uri, name, action, middleware) to sort by} {--except-vendor : Do not display routes defined by vendor packages} {--only-vendor : Only display routes defined by vendor packages}",
        "List all registered routes",
    ),
    (
        "schedule:list {--timezone= : The timezone that times should be displayed in} {--next : Sort the listed tasks by their next due date}",
        "List all scheduled tasks",
    ),
    ("schedule:run", "Run the scheduled commands"),
    ("schedule:test {--name= : The name of the scheduled command to run}", "Run a scheduled command"),
    ("schedule:work {--run-output-file= : The file to direct schedule:run output to}", "Start the schedule worker"),
    (
        "serve {--host=127.0.0.1 : The host address to serve the application on} {--port= : The port to serve the application on} {--tries=10 : The max number of ports to attempt to serve from} {--no-reload : Do not reload the development server on .env file changes}",
        "Serve the application on the PHP development server",
    ),
    (
        "storage:link {--relative : Create the symbolic link using relative paths} {--force : Recreate existing symbolic links}",
        "Create the symbolic links configured for the application",
    ),
    (
        "stub:publish {--existing : Publish and overwrite only the files that have already been published} {--force : Overwrite any existing files}",
        "Publish all stubs that are available for customization",
    ),
    (
        "test {--without-tty : Disable output to TTY} {--compact : Indicates whether the compact printer should be used} {--coverage : Indicates whether code coverage information should be collected} {--min= : Indicates the minimum threshold enforcement for code coverage} {--p|parallel : Indicates if the tests should run in parallel} {--profile : Lists top 10 slowest tests} {--recreate-databases : Indicates if the test databases should be re-created}",
        "Run the application tests",
    ),
    (
        "tinker {include?* : Include file(s) before starting tinker} {--execute= : Execute the given code using Tinker}",
        "Interact with your application",
    ),
    (
        "vendor:publish {--existing : Publish and overwrite only the files that have already been published} {--force : Overwrite any existing files} {--all : Publish assets for all service providers without prompt} {--provider= : The service provider that has assets you want to publish} {--tag=* : One or many tags that have assets you want to publish}",
        "Publish any publishable assets from vendor packages",
    ),
    ("view:cache", "Compile all of the application's Blade templates"),
    ("view:clear", "Clear all compiled view files"),
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_signatures_like_laravel() {
        let (name, arguments, options) = parse_signature(
            "mail:send {user : The ID of the user} {tags?*} {queue=default} {ids*} {--Q|queue= : Whether the job should be queued} {--force} {--id=*} {--mode=fast}",
        )
        .unwrap();
        assert_eq!(name, "mail:send");
        let args: Vec<(&str, bool, bool, Option<&str>, &str)> = arguments
            .iter()
            .map(|a| (a.name.as_str(), a.required, a.array, a.default.as_deref(), a.description.as_str()))
            .collect();
        assert_eq!(
            args,
            [
                ("user", true, false, None, "The ID of the user"),
                ("tags", false, true, None, ""),
                ("queue", false, false, Some("default"), ""),
                ("ids", true, true, None, ""),
            ]
        );
        /// Name, shortcut, takes a value, array, default.
        type Opt<'a> = (&'a str, Option<&'a str>, bool, bool, Option<&'a str>);
        let opts: Vec<Opt<'_>> = options
            .iter()
            .map(|o| (o.name.as_str(), o.shortcut.as_deref(), o.accepts_value, o.array, o.default.as_deref()))
            .collect();
        assert_eq!(
            opts,
            [
                ("queue", Some("Q"), true, false, None),
                ("force", None, false, false, None),
                ("id", None, true, true, None),
                ("mode", None, true, false, Some("fast")),
            ]
        );
        assert_eq!(options[0].description, "Whether the job should be queued");
        assert!(parse_signature("  ").is_none());
        assert!(parse_signature("{--force}").is_none());
        let (name, arguments, options) = parse_signature("inspire").unwrap();
        assert_eq!((name.as_str(), arguments.len(), options.len()), ("inspire", 0, 0));
        // Multi-line signatures.
        let (name, _, options) = parse_signature("posts:publish\n        {--dry-run : List them}\n").unwrap();
        assert_eq!((name.as_str(), options[0].name.as_str()), ("posts:publish", "dry-run"));
    }

    #[test]
    fn every_framework_signature_parses() {
        let mut names = HashSet::new();
        for (signature, description) in FRAMEWORK {
            let (name, _, _) = parse_signature(signature).unwrap_or_else(|| panic!("{signature}"));
            assert!(!description.is_empty());
            assert!(names.insert(name.clone()), "{name} twice");
        }
    }

    #[test]
    fn synopsis_lists_options_then_arguments() {
        let (name, arguments, options) = parse_signature("x {post} {tags?*} {--force} {--queue=}").unwrap();
        let command = ArtisanCommand {
            name,
            description: String::new(),
            arguments,
            options,
            source: CommandSource::Framework,
            class: None,
            path: None,
            range: None,
            bytes: None,
            class_range: None,
        };
        assert_eq!(command.synopsis(), "x [--force] [--queue=QUEUE] <post> [<tags>...]");
        assert_eq!(command.option("queue").unwrap().name, "queue");
    }

    #[test]
    fn reads_closure_commands_and_their_purpose() {
        let text = "<?php\n\nArtisan::command('inspire', function () {\n    $this->comment(Inspiring::quote());\n})->purpose('Display an inspiring quote')->hourly();\n\nArtisan::command('mail:send {user}', function (string $user) {\n    $this->info(\"Sending {$user}\");\n});\nArtisan::command($dynamic, fn () => 1);\n";
        let commands = closure_commands(Path::new("console.php"), text);
        let found: Vec<(&str, &str, u32, usize)> = commands
            .iter()
            .map(|c| (c.name.as_str(), c.description.as_str(), c.range.unwrap().start.line, c.arguments.len()))
            .collect();
        assert_eq!(found, [("inspire", "Display an inspiring quote", 2, 0), ("mail:send", "", 6, 1)]);
        let (start, end) = commands[1].bytes.unwrap();
        assert_eq!(&text[start as usize..end as usize], "mail:send");
    }

    #[test]
    fn merge_keeps_the_first_and_fills_what_it_lacks() {
        let command = |name: &str, description: &str, source: CommandSource, signature: &str| {
            let (_, arguments, options) = parse_signature(signature).unwrap();
            ArtisanCommand {
                name: name.to_owned(),
                description: description.to_owned(),
                arguments,
                options,
                source,
                class: None,
                path: None,
                range: None,
                bytes: None,
                class_range: None,
            }
        };
        let merged = ArtisanCommands::merge([
            command("migrate", "", CommandSource::Package, "migrate"),
            command("about", "About", CommandSource::Framework, "about"),
            command("migrate", "Run the migrations", CommandSource::Framework, "migrate {--force}"),
        ]);
        let names: Vec<&str> = merged.commands.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["about", "migrate"]);
        let migrate = merged.get("migrate").unwrap();
        assert_eq!((migrate.source, migrate.description.as_str()), (CommandSource::Package, "Run the migrations"));
        assert_eq!(migrate.options[0].name, "force");
    }
}
